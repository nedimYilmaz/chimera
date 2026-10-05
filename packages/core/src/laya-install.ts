import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { layaPaths, reconcileBuiltIns, type BuiltInContext, type BuiltInFs, type ReconcileReport } from "./builtin-integrations.js";
import { managedProcessEnv } from "./mcp-packages.js";
import type { McpStoreRegistry } from "./mcpstore.js";

// Laya's PyTorch stack (~550 MB) and model weights are too big for the installer, so the app does the
// download itself when the user installs Laya ("first use"). The python runtime, the wheel and a hash
// lock ship in the runtime; every pip download is pinned by sha256 (`--require-hashes`), so a
// compromised index or CDN cannot substitute a package. The model is fetched at the manifest's
// reviewed revision and its sha256 is checked HERE, before ready.json exists -- the registered entry
// then runs Laya offline, so first tool use can never reach for the Hub's mutable `main`.
// `ready.json` is written LAST: its presence is the only thing that makes builtin-integrations report
// "ready", so a crash at any earlier point can never register a half-installed Laya.

export type PipExec = (python: string, args: string[], opts: { env: Record<string, string>; timeoutMs: number }) => Promise<void>;

const defaultExec: PipExec = (python, args, { env, timeoutMs }) => new Promise((resolve, reject) => {
  execFile(python, args, { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
    if (!err) return resolve();
    const tail = String(stderr || err.message).trim().split("\n").slice(-6).join("\n");
    reject(new Error(tail.slice(-500) || "pip failed"));
  });
});

const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
// Model weights are ~840 MB: hash them as a stream instead of buffering the file.
const sha256Stream = (path: string) => new Promise<string>((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
});

// Same allow_patterns laya.Agent.__init__ passes to snapshot_download for the English checkpoint
// (empty subfolder prefix): fetching anything less would make the offline first-use load miss a file,
// and anything more would download checkpoints nobody reviewed.
const PREFETCH = [
  "import sys",
  "from huggingface_hub import snapshot_download",
  "snapshot_download(sys.argv[1], revision=sys.argv[2], allow_patterns=['rl_agent_config.json', 'model.safetensors', 'tokenizer/*', 'encoder/*'])",
].join("\n");

function writeAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export type LayaInstallOptions = {
  home: string; ctx: BuiltInContext; store: McpStoreRegistry;
  exec?: PipExec; fs?: BuiltInFs; now?: () => Date; timeoutMs?: number; osRelease?: string;
  // Called after the store changed so the engine can drop any live connection to the old spec.
  onReconciled?: (report: ReconcileReport | null) => void;
};

export class LayaInstallError extends Error {}

// Laya's torch/numpy wheels are tagged macosx_14_0 (Darwin 23); on anything older pip would only say
// "no matching distribution", so say the real reason up front instead.
const MIN_DARWIN_MAJOR = 23;

// Idempotent: a second call while one is running is a no-op. The state dir and the "installing"
// marker are written synchronously so a permissions problem reaches the caller as an RPC error
// instead of vanishing into a background promise nobody awaits.
const running = new Map<string, Promise<void>>();

export function installLaya(o: LayaInstallOptions): { started: boolean } {
  const p = layaPaths(o.ctx, o.home);
  if (running.has(p.dir)) return { started: false };
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  writeAtomic(p.status, { state: "installing", pid: o.ctx.pid ?? process.pid, at: (o.now ?? (() => new Date()))().toISOString() });
  const job = run(o, p).finally(() => running.delete(p.dir));
  running.set(p.dir, job);
  return { started: true };
}

export const layaInstallIdle = (o: Pick<LayaInstallOptions, "home" | "ctx">): Promise<void> =>
  running.get(layaPaths(o.ctx, o.home).dir) ?? Promise.resolve();

// Never rejects: it runs detached from any caller, so a throw here would be an unhandled rejection
// in the daemon. Failures are persisted to status.json for the UI instead.
async function run(o: LayaInstallOptions, p: ReturnType<typeof layaPaths>): Promise<void> {
  const l = o.ctx.manifest.integrations.laya;
  if (l.state !== "managed-download") return;
  const now = o.now ?? (() => new Date());
  const siteTmp = `${p.site}.tmp-${process.pid}`;
  try {
    if (o.ctx.manifest.platform === "darwin" && Number.parseInt(o.osRelease ?? release(), 10) < MIN_DARWIN_MAJOR) {
      throw new LayaInstallError("Laya needs macOS 14 or newer: its PyTorch build does not support older macOS releases.");
    }
    if (sha256File(p.wheel) !== l.wheelSha256) throw new LayaInstallError("The bundled Laya wheel failed its checksum. Reinstall Chimera.");
    if (sha256File(p.lock) !== l.lockSha256) throw new LayaInstallError("The bundled Laya dependency lock failed its checksum. Reinstall Chimera.");
    rmSync(siteTmp, { recursive: true, force: true });
    rmSync(p.site, { recursive: true, force: true });
    const env = {
      ...managedProcessEnv(), PIP_CACHE_DIR: join(p.dir, "pip-cache"), PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_INPUT: "1", PYTHONNOUSERSITE: "1",
      // The bundled python lives inside the signed app: bytecode written there would break its seal.
      PYTHONDONTWRITEBYTECODE: "1",
    };
    const exec = o.exec ?? defaultExec;
    const timeoutMs = o.timeoutMs ?? 45 * 60_000;
    await exec(p.python, ["-m", "pip", "install", "--require-hashes", "--only-binary=:all:", "--no-deps", "--target", siteTmp, "-r", p.lock], { env, timeoutMs });
    await exec(p.python, ["-m", "pip", "install", "--no-deps", "--no-index", "--target", siteTmp, p.wheel], { env, timeoutMs });
    // The ONLY network use of the model: no HF_HUB_OFFLINE here, unlike the registered entry. HF_HOME is
    // the same cache the entry reads.
    await exec(p.python, ["-c", PREFETCH, l.checkpoint.repo, l.checkpoint.revision], {
      env: { ...env, PYTHONPATH: siteTmp, HF_HOME: p.hf, HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1" }, timeoutMs,
    });
    for (const [file, expected] of Object.entries(l.checkpoint.files)) {
      let actual: string;
      try { actual = await sha256Stream(join(p.snapshot, file)); }
      catch { throw new LayaInstallError(`The Laya model download did not produce ${file} at the reviewed revision. Install again.`); }
      if (actual !== expected) {
        // Drop the whole cache: a corrupt or substituted blob must not be reused by the retry.
        rmSync(p.hf, { recursive: true, force: true });
        throw new LayaInstallError(`The downloaded Laya model ${file} failed its checksum (expected ${expected}, got ${actual}). It was discarded; install again.`);
      }
    }
    renameSync(siteTmp, p.site);
    writeAtomic(p.ready, { version: l.version, wheelSha256: l.wheelSha256, lockSha256: l.lockSha256, installedAt: now().toISOString(), checkpoint: l.checkpoint });
    rmSync(p.status, { force: true });
    rmSync(join(p.dir, "pip-cache"), { recursive: true, force: true });
  } catch (err) {
    rmSync(siteTmp, { recursive: true, force: true });
    try { writeAtomic(p.status, { state: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 500), at: now().toISOString() }); }
    catch { /* nothing more can be persisted; the next status read reports not-installed */ }
    return;
  }
  // Installed on disk; a registration hiccup must not turn a good install into a "failed" one --
  // the next daemon start reconciles it anyway.
  try { o.onReconciled?.(reconcileBuiltIns(o.store, { home: o.home, ctx: o.ctx, fs: o.fs })); }
  catch (err) { console.warn(`chimerad: laya installed but registration failed: ${err instanceof Error ? err.message : String(err)}`); }
}
