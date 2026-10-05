import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStoreRegistry } from "@chimera/core/mcpstore";
import { layaPaths, resolveBuiltIns, type BuiltInContext, type BuiltInManifest, type ReconcileReport } from "@chimera/core/builtin-integrations";
import { installLaya, layaInstallIdle, type PipExec } from "@chimera/core/laya-install";

// The installer runs the bundled python's pip against a hash lock. These tests swap pip for a fake so
// nothing touches the network, but the checksum gates, the on-disk state machine and the "ready.json
// is written last" ordering all run for real against a temp runtime + a fresh HOME.

const sha = (b: string) => createHash("sha256").update(b).digest("hex");
const HOST = process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : "darwin";
const WHEEL = "wheel-bytes", LOCK = "numpy==2.0.0 --hash=sha256:abc\n", MODEL = "model-bytes";
const REVISION = "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851";
const checkpoint = (modelSha = sha(MODEL)) => ({ repo: "convaiinnovations/laya", revision: REVISION, files: { "model.safetensors": modelSha } });

function fixture(over: { wheelSha?: string; lockSha?: string; modelSha?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "chimera-laya-rt-"));
  const home = mkdtempSync(join(tmpdir(), "chimera-laya-home-"));
  mkdirSync(join(root, "integrations", "laya"), { recursive: true });
  mkdirSync(join(root, "python", "bin"), { recursive: true });
  writeFileSync(join(root, "integrations", "laya", "laya-0.3.27-py3-none-any.whl"), WHEEL);
  writeFileSync(join(root, "integrations", "laya", "requirements.lock"), LOCK);
  writeFileSync(join(root, "python", "bin", "python3"), "");
  const gone = (reason: string) => ({ state: "unsupported-platform" as const, reason });
  const manifest: BuiltInManifest = {
    schemaVersion: 1, platform: HOST, arch: "arm64",
    integrations: {
      "chimera-desktop": gone("fixture"), "chimera-browser": gone("fixture"),
      laya: {
        state: "managed-download", version: "0.3.27", python: "python/bin/python3",
        wheel: "integrations/laya/laya-0.3.27-py3-none-any.whl", wheelSha256: over.wheelSha ?? sha(WHEEL),
        lock: "integrations/laya/requirements.lock", lockSha256: over.lockSha ?? sha(LOCK), source: "https://example.test/laya",
        checkpoint: checkpoint(over.modelSha),
      },
    },
  };
  const ctx: BuiltInContext = { root, manifest, pid: process.pid };
  return { root, home, ctx, store: new McpStoreRegistry(home), paths: layaPaths(ctx, home) };
}

// Mimics `pip install --target <dir>`: materialises the target so the installer has something to rename.
const targetOf = (args: string[]) => args[args.indexOf("--target") + 1];
const isPrefetch = (args: string[]) => args[0] === "-c";
// Mimics the huggingface_hub prefetch: lands the weights where the cache layout puts a commit-SHA snapshot.
const writeModel = (f: ReturnType<typeof fixture>, bytes = MODEL) => {
  mkdirSync(f.paths.snapshot, { recursive: true });
  writeFileSync(join(f.paths.snapshot, "model.safetensors"), bytes);
};
const okExec = (f: ReturnType<typeof fixture>, calls: string[][] = [], model = MODEL): PipExec => async (_py, args) => {
  calls.push(args);
  if (isPrefetch(args)) { writeModel(f, model); return; }
  const t = targetOf(args);
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, `pkg${calls.length}.py`), "");
};
const pipCalls = (calls: string[][]) => calls.filter((a) => !isPrefetch(a));
const statusOf = (f: ReturnType<typeof fixture>) => resolveBuiltIns(f.ctx, f.home).laya.status;

describe("installLaya", () => {
  it("installs hash-pinned deps then the wheel, writes ready.json last, and registers laya", async () => {
    const f = fixture();
    const calls: string[][] = [];
    let readyDuringPip = true;
    const exec: PipExec = async (py, args, o) => {
      readyDuringPip = readyDuringPip && existsSync(f.paths.ready);
      expect(py).toBe(join(f.root, "python", "bin", "python3"));
      expect(o.env.PYTHONNOUSERSITE).toBe("1");
      expect(o.env.PYTHONDONTWRITEBYTECODE).toBe("1");
      expect(o.env.PIP_DISABLE_PIP_VERSION_CHECK).toBe("1");
      expect(o.env.PIP_CACHE_DIR).toBe(join(f.paths.dir, "pip-cache"));
      return okExec(f, calls)(py, args, o);
    };
    let reported: ReconcileReport | null | undefined;
    expect(installLaya({ home: f.home, ctx: f.ctx, store: f.store, exec, onReconciled: (r) => { reported = r; } })).toEqual({ started: true });
    // The "installing" marker is on disk synchronously, before any await.
    expect(JSON.parse(readFileSync(f.paths.status, "utf8"))).toMatchObject({ state: "installing", pid: process.pid });
    expect(statusOf(f).state).toBe("installing");
    await layaInstallIdle(f);

    expect(readyDuringPip).toBe(false);
    expect(pipCalls(calls)).toHaveLength(2);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(expect.arrayContaining(["-m", "pip", "install", "--require-hashes", "--only-binary=:all:", "--no-deps", "-r", f.paths.lock]));
    expect(calls[1]).toEqual(expect.arrayContaining(["--no-deps", "--no-index", f.paths.wheel]));
    expect(calls[0]).not.toContain("--no-index");
    expect(JSON.parse(readFileSync(f.paths.ready, "utf8"))).toMatchObject({ version: "0.3.27", wheelSha256: sha(WHEEL), lockSha256: sha(LOCK), checkpoint: checkpoint() });
    expect(existsSync(f.paths.site)).toBe(true);
    expect(existsSync(f.paths.status)).toBe(false);
    expect(existsSync(join(f.paths.dir, "pip-cache"))).toBe(false);
    expect(statusOf(f).state).toBe("ready");
    expect(reported?.laya.outcome).toBe("registered");
    const spec = f.store.get("laya");
    expect(spec).toMatchObject({ type: "stdio", builtIn: { id: "laya", version: "0.3.27" }, sessionMode: "shared" });
    expect(spec).toMatchObject({ command: f.paths.python, env: { HF_HOME: f.paths.hf } });
    // The registered entry enforces what the install just verified, and cannot fetch anything else.
    expect(spec).toMatchObject({ env: { LAYA_REVISION: REVISION, LAYA_SHA256_DIGESTS: JSON.stringify(checkpoint().files), HF_HUB_OFFLINE: "1" } });
  });

  it("downloads exactly the reviewed revision into the cache the entry reads, and is the only step allowed online", async () => {
    const f = fixture();
    const seen: { args: string[]; env: Record<string, string> }[] = [];
    const exec: PipExec = async (py, args, o) => { seen.push({ args, env: o.env }); await okExec(f)(py, args, o); };
    installLaya({ home: f.home, ctx: f.ctx, store: f.store, exec });
    await layaInstallIdle(f);
    const prefetch = seen.filter((c) => isPrefetch(c.args));
    expect(prefetch).toHaveLength(1);
    // repo and revision travel as argv (never interpolated into the python source), and the revision is the full pinned SHA.
    expect(prefetch[0].args.slice(2)).toEqual(["convaiinnovations/laya", REVISION]);
    expect(prefetch[0].args[1]).not.toContain(REVISION);
    expect(prefetch[0].env.HF_HOME).toBe(f.paths.hf);
    expect(prefetch[0].env.HF_HUB_OFFLINE).toBeUndefined();
    expect(prefetch[0].env.PYTHONPATH).toBe(`${f.paths.site}.tmp-${process.pid}`);
    expect(statusOf(f).state).toBe("ready");
  });

  it("refuses a model whose digest differs from the reviewed pin: no ready.json, cache discarded, laya not registered", async () => {
    const f = fixture({ modelSha: "0".repeat(64) });
    installLaya({ home: f.home, ctx: f.ctx, store: f.store, exec: okExec(f) });
    await layaInstallIdle(f);
    expect(existsSync(f.paths.ready)).toBe(false);
    expect(existsSync(f.paths.site)).toBe(false);
    expect(existsSync(f.paths.hf)).toBe(false);
    expect(statusOf(f)).toMatchObject({ state: "failed", reason: expect.stringMatching(/model\.safetensors failed its checksum.*discarded/) });
    expect(f.store.has("laya")).toBe(false);
  });

  it("refuses a model download that is not the reviewed bytes even when the pin itself is well-formed", async () => {
    const f = fixture();
    installLaya({ home: f.home, ctx: f.ctx, store: f.store, exec: okExec(f, [], "someone-elses-weights") });
    await layaInstallIdle(f);
    expect(existsSync(f.paths.ready)).toBe(false);
    expect(statusOf(f)).toMatchObject({ state: "failed", reason: expect.stringContaining("failed its checksum") });
    expect(f.store.has("laya")).toBe(false);
  });

  it("fails closed when the prefetch produces no weights or errors, leaving no ready.json and no site", async () => {
    const empty = fixture();
    installLaya({ home: empty.home, ctx: empty.ctx, store: empty.store, exec: async (_py, args) => { if (!isPrefetch(args)) mkdirSync(targetOf(args), { recursive: true }); } });
    await layaInstallIdle(empty);
    expect(existsSync(empty.paths.ready)).toBe(false);
    expect(existsSync(empty.paths.site)).toBe(false);
    expect(statusOf(empty)).toMatchObject({ state: "failed", reason: expect.stringContaining("did not produce model.safetensors") });

    const offline = fixture();
    installLaya({ home: offline.home, ctx: offline.ctx, store: offline.store, exec: async (py, args, o) => {
      if (isPrefetch(args)) throw new Error("LocalEntryNotFoundError: cannot reach the Hub");
      await okExec(offline)(py, args, o);
    } });
    await layaInstallIdle(offline);
    expect(existsSync(offline.paths.ready)).toBe(false);
    expect(existsSync(offline.paths.site)).toBe(false);
    expect(existsSync(`${offline.paths.site}.tmp-${process.pid}`)).toBe(false);
    expect(statusOf(offline)).toMatchObject({ state: "failed", reason: expect.stringContaining("cannot reach the Hub") });
    expect(offline.store.has("laya")).toBe(false);
  });

  it("is idempotent while running: a second call is a no-op and pip runs once", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const exec: PipExec = async (py, args, o) => { if (!isPrefetch(args)) n++; await gate; await okExec(f)(py, args, o); };
    expect(installLaya({ home: f.home, ctx: f.ctx, store: f.store, exec })).toEqual({ started: true });
    expect(installLaya({ home: f.home, ctx: f.ctx, store: f.store, exec })).toEqual({ started: false });
    release();
    await layaInstallIdle(f);
    expect(n).toBe(2);
    expect(statusOf(f).state).toBe("ready");
  });

  it.each([
    ["wheel", { wheelSha: "0".repeat(64) }, /wheel failed its checksum/],
    ["lock", { lockSha: "0".repeat(64) }, /lock failed its checksum/],
  ])("refuses a tampered %s before running pip and persists the failure", async (_what, over, msg) => {
    const f = fixture(over);
    let ran = false;
    installLaya({ home: f.home, ctx: f.ctx, store: f.store, exec: async () => { ran = true; } });
    await layaInstallIdle(f);
    expect(ran).toBe(false);
    expect(existsSync(f.paths.ready)).toBe(false);
    expect(statusOf(f)).toMatchObject({ state: "failed", reason: expect.stringMatching(msg) });
    expect(f.store.has("laya")).toBe(false);
  });

  it("records a pip failure, leaves no half-installed site, and a retry can succeed", async () => {
    const f = fixture();
    let calls = 0;
    const flaky: PipExec = async (py, args, o) => {
      if (!isPrefetch(args)) calls++;
      if (calls === 2 && !isPrefetch(args)) {
        mkdirSync(targetOf(args), { recursive: true });
        throw new Error("No matching distribution found for torch");
      }
      return okExec(f)(py, args, o);
    };
    installLaya({ home: f.home, ctx: f.ctx, store: f.store, exec: flaky });
    await layaInstallIdle(f);
    expect(existsSync(f.paths.ready)).toBe(false);
    expect(existsSync(f.paths.site)).toBe(false);
    expect(existsSync(`${f.paths.site}.tmp-${process.pid}`)).toBe(false);
    expect(statusOf(f)).toMatchObject({ state: "failed", reason: expect.stringContaining("No matching distribution") });
    expect(f.store.has("laya")).toBe(false);

    expect(installLaya({ home: f.home, ctx: f.ctx, store: f.store, exec: okExec(f) })).toEqual({ started: true });
    await layaInstallIdle(f);
    expect(statusOf(f).state).toBe("ready");
  });

  it("truncates a huge pip error so status.json stays small", async () => {
    const f = fixture();
    installLaya({ home: f.home, ctx: f.ctx, store: f.store, exec: async () => { throw new Error("x".repeat(5000)); } });
    await layaInstallIdle(f);
    expect(JSON.parse(readFileSync(f.paths.status, "utf8")).error).toHaveLength(500);
  });

  it("a registration hiccup after a good install does not turn it into a failure", async () => {
    const f = fixture();
    installLaya({ home: f.home, ctx: f.ctx, store: f.store, exec: okExec(f), onReconciled: () => { throw new Error("boom"); } });
    await layaInstallIdle(f);
    expect(statusOf(f).state).toBe("ready");
    expect(existsSync(f.paths.status)).toBe(false);
  });

  it("replaces a previous site on reinstall instead of layering onto it", async () => {
    const f = fixture();
    mkdirSync(f.paths.site, { recursive: true });
    writeFileSync(join(f.paths.site, "stale.py"), "");
    installLaya({ home: f.home, ctx: f.ctx, store: f.store, exec: okExec(f) });
    await layaInstallIdle(f);
    expect(existsSync(join(f.paths.site, "stale.py"))).toBe(false);
    expect(statusOf(f).state).toBe("ready");
  });

  it.each([
    ["macOS 13 (Darwin 22)", "22.6.0", false],
    ["macOS 14 (Darwin 23)", "23.0.0", true],
    ["macOS 26 (Darwin 25)", "25.6.0", true],
  ])("gates the first-use install on the macOS release: %s", async (_name, osRelease, allowed) => {
    const f = fixture();
    const ctx: BuiltInContext = { ...f.ctx, manifest: { ...f.ctx.manifest, platform: "darwin" } };
    let ran = false;
    installLaya({ home: f.home, ctx, store: f.store, osRelease, exec: async (py, args, o) => { ran = true; await okExec(f)(py, args, o); } });
    await layaInstallIdle(f);
    expect(ran).toBe(allowed);
    if (!allowed) expect(JSON.parse(readFileSync(f.paths.status, "utf8"))).toMatchObject({ state: "failed", error: expect.stringContaining("macOS 14") });
    else expect(existsSync(f.paths.ready)).toBe(true);
  });

  it("does not apply the macOS gate to other platforms", async () => {
    const f = fixture();
    const ctx: BuiltInContext = { ...f.ctx, manifest: { ...f.ctx.manifest, platform: "linux" } };
    installLaya({ home: f.home, ctx, store: f.store, osRelease: "1.0.0", exec: okExec(f) });
    await layaInstallIdle(f);
    expect(existsSync(f.paths.ready)).toBe(true);
  });

  it("throws (rather than silently no-oping) when laya is not a managed download on this platform", () => {
    const f = fixture();
    const ctx: BuiltInContext = { ...f.ctx, manifest: { ...f.ctx.manifest, integrations: { ...f.ctx.manifest.integrations, laya: { state: "unsupported-platform", reason: "no python" } } } };
    expect(() => installLaya({ home: f.home, ctx, store: f.store })).toThrow(/not available/);
  });
});
