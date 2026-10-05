import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpBuiltInIdSchema, type BuiltInStatus, type McpBuiltInId, type McpStoreEntry, type McpStoreServerSpec } from "@chimera/protocol";
import { browserEntry, desktopEntry, isBuiltInDesktopEntry, LayaCheckpointSchema, layaEntry, type LayaCheckpoint } from "./computer-use.js";
import { specJson, type McpStoreRegistry } from "./mcpstore.js";

// Chimera-managed computer-use integrations (laya, chimera-browser, chimera-desktop).
//
// The packaged runtime carries `integrations/manifest.json` with RELATIVE paths only -- the artifact
// must never embed a developer home or an install location. Absolute paths are derived from the
// runtime root at every daemon start and written into mcpstore.json, so moving or upgrading the app
// self-heals on the next launch. Provenance is the `builtIn` marker, which only reconcile (below) is
// allowed to stamp: McpStoreRegistry.add() rejects it, so a user/agent/import cannot forge it.

const Rel = z.string().min(1).refine(
  (rel) => !posix.isAbsolute(rel) && !win32.isAbsolute(rel) && !/^[a-zA-Z]:/.test(rel) && !rel.split(/[\\/]/).includes(".."),
  "must be a relative path without '..' segments",
);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Version = z.string().min(1).max(64);
const Unsupported = z.object({ state: z.literal("unsupported-platform"), reason: z.string().min(1).max(300) }).strict();

const DesktopManifest = z.discriminatedUnion("state", [
  z.object({ state: z.literal("bundled"), version: Version, driver: Rel, license: z.string().min(1), source: z.string().min(1), sha256: Sha256.optional() }).strict(),
  Unsupported,
]);
const BrowserManifest = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("bundled"), version: Version, node: Rel, cli: Rel, executable: Rel,
    browserVersion: Version, browserSha256: Sha256, browserSource: z.string().min(1), license: z.string().min(1),
  }).strict(),
  Unsupported,
]);
// Laya's PyTorch stack (~550 MB) and model weights are NOT in the installer: the python runtime,
// the hash-checked wheel and the hash lock ship, and the app downloads the rest on first use. The
// reviewed model checkpoint is part of the manifest and strict: a malformed or missing pin makes
// loadBuiltInContext throw, so no Laya entry is registered rather than one that tracks mutable Hub main.
const LayaManifest = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("managed-download"), version: Version, python: Rel, wheel: Rel, wheelSha256: Sha256,
    lock: Rel, lockSha256: Sha256, source: z.string().min(1), checkpoint: LayaCheckpointSchema,
  }).strict(),
  Unsupported,
]);

export const BuiltInManifestSchema = z.object({
  schemaVersion: z.literal(1),
  platform: z.enum(["darwin", "linux", "win32"]),
  arch: z.enum(["arm64", "x64"]),
  integrations: z.object({ "chimera-desktop": DesktopManifest, "chimera-browser": BrowserManifest, laya: LayaManifest }).strict(),
}).strict();
export type BuiltInManifest = z.infer<typeof BuiltInManifestSchema>;

export const BUILT_IN_IDS = McpBuiltInIdSchema.options;

// Seam so win32/linux manifests can be exercised on any host with fake file maps instead of claiming
// a native run that did not happen.
export type BuiltInFs = { isFile(path: string): boolean; isDir(path: string): boolean; readJson(path: string): unknown | undefined };
export const realFs: BuiltInFs = {
  isFile: (path) => { try { return statSync(path).isFile(); } catch { return false; } },
  isDir: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
  readJson: (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } },
};

export type BuiltInContext = { root: string; manifest: BuiltInManifest; pid?: number };

// `<runtime>/packages/core/src/builtin-integrations.js` -> `<runtime>`. Deliberately NO env override:
// an attacker-controlled env var must not be able to point the daemon at a forged manifest, and the
// dev checkout / bun-compiled layouts simply have no packaged runtime (null).
export function findRuntimeRoot(startUrl: string = import.meta.url, fs: BuiltInFs = realFs): string | null {
  let root: string;
  try { root = resolve(dirname(fileURLToPath(startUrl)), "../../.."); } catch { return null; }
  return fs.isFile(join(root, "runtime.json")) && fs.isFile(join(root, "integrations", "manifest.json")) ? root : null;
}

const RuntimeInfo = z.object({ platform: z.string(), arch: z.string() }).passthrough();

export function loadBuiltInContext(
  root: string,
  host: { platform: string; arch: string } = { platform: process.platform, arch: process.arch },
  fs: BuiltInFs = realFs,
): BuiltInContext {
  const raw = fs.readJson(join(root, "integrations", "manifest.json"));
  if (raw === undefined) throw new Error("integrations/manifest.json is missing or unreadable");
  const manifest = BuiltInManifestSchema.parse(raw);
  const runtime = RuntimeInfo.safeParse(fs.readJson(join(root, "runtime.json")));
  if (!runtime.success) throw new Error("runtime.json is missing or unreadable");
  if (runtime.data.platform !== manifest.platform || runtime.data.arch !== manifest.arch) {
    throw new Error(`manifest targets ${manifest.platform}-${manifest.arch} but runtime.json says ${runtime.data.platform}-${runtime.data.arch}`);
  }
  if (manifest.platform !== host.platform || manifest.arch !== host.arch) {
    throw new Error(`runtime was built for ${manifest.platform}-${manifest.arch}, this host is ${host.platform}-${host.arch}`);
  }
  return { root, manifest };
}

const rulesFor = (ctx: BuiltInContext) => (ctx.manifest.platform === "win32" ? win32 : posix);

// ---------- laya first-use state ----------
const LayaReadyBase = z.object({ version: z.string(), wheelSha256: z.string(), lockSha256: z.string(), installedAt: z.string() });
// `checkpoint` is what the install step actually downloaded and verified; the entry is only registered
// while it still equals the manifest's pin. A ready.json from before checkpoint pinning has no such
// field, so it is deliberately NOT ready: its weights were never verified.
const LayaReady = LayaReadyBase.extend({ checkpoint: LayaCheckpointSchema }).strict();
const LayaReadyLegacy = LayaReadyBase.strict();
const checkpointKey = (c: LayaCheckpoint) => JSON.stringify([c.repo, c.revision, Object.entries(c.files).sort(([a], [b]) => (a < b ? -1 : 1))]);
const LayaStatusFile = z.discriminatedUnion("state", [
  z.object({ state: z.literal("installing"), pid: z.number().int(), at: z.string() }).strict(),
  z.object({ state: z.literal("failed"), error: z.string(), at: z.string() }).strict(),
]);
export type LayaStatusFileValue = z.infer<typeof LayaStatusFile>;

export function layaPaths(ctx: BuiltInContext, home: string) {
  const laya = ctx.manifest.integrations.laya;
  if (laya.state !== "managed-download") throw new Error("laya is not available on this platform");
  const r = rulesFor(ctx);
  const dir = r.join(home, "integrations", `laya-${laya.version}`);
  const hf = r.join(dir, "hf");
  return {
    dir, site: r.join(dir, "site"), hf,
    // huggingface_hub's cache layout for a commit-SHA revision: <HF_HOME>/hub/models--<org>--<name>/snapshots/<sha>.
    snapshot: r.join(hf, "hub", `models--${laya.checkpoint.repo.replace("/", "--")}`, "snapshots", laya.checkpoint.revision),
    ready: r.join(dir, "ready.json"), status: r.join(dir, "status.json"),
    python: r.join(ctx.root, laya.python), wheel: r.join(ctx.root, laya.wheel), lock: r.join(ctx.root, laya.lock),
  };
}

export type ResolvedBuiltIn = { status: BuiltInStatus; entry?: McpStoreEntry };

function missing(fs: BuiltInFs, files: [string, string][]): string | undefined {
  return files.find(([abs]) => !fs.isFile(abs))?.[1];
}

export function resolveBuiltIns(ctx: BuiltInContext, home: string, fs: BuiltInFs = realFs): Record<McpBuiltInId, ResolvedBuiltIn> {
  const r = rulesFor(ctx);
  const platform = ctx.manifest.platform;
  const abs = (rel: string) => r.join(ctx.root, rel);
  const m = ctx.manifest.integrations;
  const out = {} as Record<McpBuiltInId, ResolvedBuiltIn>;

  const d = m["chimera-desktop"];
  if (d.state === "unsupported-platform") out["chimera-desktop"] = { status: { id: "chimera-desktop", state: "unsupported-platform", provisioning: "bundled", reason: d.reason } };
  else {
    const gone = missing(fs, [[abs(d.driver), d.driver]]);
    out["chimera-desktop"] = gone
      ? { status: { id: "chimera-desktop", state: "unavailable", provisioning: "bundled", version: d.version, reason: `Bundled file missing: ${gone}. Reinstall Chimera to restore it.` } }
      : {
        status: { id: "chimera-desktop", state: "ready", provisioning: "bundled", version: d.version },
        entry: desktopEntry({
          home, platform, driver: abs(d.driver), builtIn: { id: "chimera-desktop", version: d.version },
          env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", CUA_TELEMETRY_ENABLED: "0", DO_NOT_TRACK: "1" },
        }),
      };
  }

  const b = m["chimera-browser"];
  if (b.state === "unsupported-platform") out["chimera-browser"] = { status: { id: "chimera-browser", state: "unsupported-platform", provisioning: "bundled", reason: b.reason } };
  else {
    const gone = missing(fs, [[abs(b.node), b.node], [abs(b.cli), b.cli], [abs(b.executable), b.executable]]);
    out["chimera-browser"] = gone
      ? { status: { id: "chimera-browser", state: "unavailable", provisioning: "bundled", version: b.version, reason: `Bundled file missing: ${gone}. Reinstall Chimera to restore it.` } }
      : {
        status: { id: "chimera-browser", state: "ready", provisioning: "bundled", version: b.version },
        entry: browserEntry({ home, platform, node: abs(b.node), cli: abs(b.cli), executable: abs(b.executable), builtIn: { id: "chimera-browser", version: b.version } }),
      };
  }

  const l = m.laya;
  if (l.state === "unsupported-platform") out.laya = { status: { id: "laya", state: "unsupported-platform", provisioning: "managed-download", reason: l.reason } };
  else {
    const p = layaPaths(ctx, home);
    const base = { id: "laya", provisioning: "managed-download", version: l.version, modelAssets: "downloaded-on-first-use" } as const;
    const gone = missing(fs, [[p.python, l.python], [p.wheel, l.wheel], [p.lock, l.lock]]);
    if (gone) out.laya = { status: { ...base, state: "unavailable", reason: `Bundled file missing: ${gone}. Reinstall Chimera to restore it.` } };
    else {
      const raw = fs.readJson(p.ready);
      const pinnedReady = LayaReady.safeParse(raw);
      const built = pinnedReady.success ? pinnedReady.data : LayaReadyLegacy.safeParse(raw).data;
      const state = LayaStatusFile.safeParse(fs.readJson(p.status));
      const sameBuild = !!built && built.version === l.version && built.wheelSha256 === l.wheelSha256 && built.lockSha256 === l.lockSha256 && fs.isDir(p.site);
      // Registered only when the install step verified exactly the checkpoint this manifest pins and its
      // weights are still on disk; Laya re-checks the digest itself on every load.
      const verified = pinnedReady.success && checkpointKey(pinnedReady.data.checkpoint) === checkpointKey(l.checkpoint)
        && Object.keys(l.checkpoint.files).every((file) => fs.isFile(r.join(p.snapshot, file)));
      if (sameBuild && verified) {
        out.laya = {
          status: { ...base, state: "ready" },
          entry: layaEntry({
            home, platform, python: p.python, builtIn: { id: "laya", version: l.version }, checkpoint: l.checkpoint,
            env: { PYTHONPATH: p.site, HF_HOME: p.hf, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
          }),
        };
      } else if (state.success && state.data.state === "installing") {
        out.laya = state.data.pid === (ctx.pid ?? process.pid)
          ? { status: { ...base, state: "installing" } }
          : { status: { ...base, state: "failed", reason: "The previous installation was interrupted. Install again to retry." } };
      } else if (state.success && state.data.state === "failed") {
        out.laya = { status: { ...base, state: "failed", reason: state.data.error.slice(0, 500) } };
      } else if (sameBuild) {
        out.laya = { status: { ...base, state: "not-installed", reason: "Laya's model checkpoint is pinned to a reviewed revision and checksum, and this install has not verified it. Install again to download and check it." } };
      } else {
        out.laya = { status: { ...base, state: "not-installed", reason: "Laya's Python packages and models download on first use." } };
      }
    }
  }
  return out;
}

// ---------- reconcile: idempotent registration + legacy migration ----------
export type ReconcileOutcome = "registered" | "updated" | "unchanged" | "migrated" | "name-taken" | "removed" | "absent";
export type ReconcileReport = Record<McpBuiltInId, { outcome: ReconcileOutcome; state: BuiltInStatus["state"] }>;

const BackupFile = z.object({
  version: z.literal(1),
  originals: z.record(z.string(), z.unknown()),
  rolledBack: z.array(z.string()),
}).strict();
type Backup = z.infer<typeof BackupFile>;
const backupPath = (home: string) => join(home, "computer-use", "reconcile-backup.json");

// null = the file exists but is unreadable: migration is then refused entirely, because migrating
// without a trustworthy backup would make the rollback promise a lie.
function readBackup(home: string): Backup | null {
  let text: string;
  try { text = readFileSync(backupPath(home), "utf8"); }
  catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? { version: 1, originals: {}, rolledBack: [] } : null; }
  try { const parsed = BackupFile.safeParse(JSON.parse(text)); return parsed.success ? parsed.data : null; } catch { return null; }
}
function writeBackup(home: string, backup: Backup): void {
  const file = backupPath(home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(backup, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

const isStdio = (spec: McpStoreServerSpec | undefined): spec is Extract<McpStoreServerSpec, { type: "stdio" }> => spec?.type === "stdio";
const isOurs = (spec: McpStoreServerSpec | undefined, id: McpBuiltInId) => isStdio(spec) && spec.builtIn?.id === id;

function under(platform: NodeJS.Platform, dir: string, path: string): boolean {
  const r = platform === "win32" ? win32 : posix;
  if (!r.isAbsolute(path)) return false;
  const rel = r.relative(dir, path);
  return rel !== "" && !r.isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..";
}

// Only the exact shapes the legacy dev registrar (scripts/setup-computer-use.ts) wrote qualify: an
// unmarked entry with the same NAME but a different command/args is somebody's own server and must
// never be overwritten.
function isLegacyShape(id: McpBuiltInId, spec: McpStoreServerSpec | undefined, home: string, platform: NodeJS.Platform): boolean {
  if (!isStdio(spec) || spec.builtIn || spec.managed) return false;
  const integrations = (platform === "win32" ? win32 : posix).join(home, "integrations");
  if (id === "laya") return spec.args.length === 2 && spec.args[0] === "-m" && spec.args[1] === "laya.mcp.server" && under(platform, integrations, spec.command);
  if (id === "chimera-browser") return spec.args[0] !== undefined && under(platform, integrations, spec.args[0]) && spec.args.includes("--isolated");
  return isBuiltInDesktopEntry(id, spec, home, platform);
}

const userChoices = (spec: McpStoreServerSpec) => (isStdio(spec) ? { direct: spec.direct, enabled: spec.enabled, trust: spec.trust } : {});

export function reconcileBuiltIns(
  store: McpStoreRegistry,
  o: { home: string; ctx: BuiltInContext | null; fs?: BuiltInFs },
): ReconcileReport | null {
  if (!o.ctx) return null;
  const platform = o.ctx.manifest.platform;
  const resolved = resolveBuiltIns(o.ctx, o.home, o.fs);
  const backup = readBackup(o.home);

  const migrate = new Set<McpBuiltInId>();
  for (const id of BUILT_IN_IDS) {
    const existing = store.get(id);
    if (backup && resolved[id].entry && !backup.rolledBack.includes(id) && isLegacyShape(id, existing, o.home, platform)) migrate.add(id);
  }
  // The original goes to disk BEFORE the store is rewritten, and an earlier original is never
  // replaced, so a crash or a second run can't lose what the user had.
  if (backup && migrate.size > 0) {
    const originals = { ...backup.originals };
    for (const id of migrate) if (!(id in originals)) originals[id] = store.get(id);
    writeBackup(o.home, { ...backup, originals });
  }

  const report = {} as ReconcileReport;
  store.reconcile((draft) => {
    for (const id of BUILT_IN_IDS) {
      const { status, entry } = resolved[id];
      const existing = draft.get(id);
      const next = entry ? (({ name: _name, ...spec }) => spec)(entry) : undefined;
      let outcome: ReconcileOutcome;
      if (isOurs(existing, id)) {
        if (!next) { draft.delete(id); outcome = "removed"; }
        else {
          const merged = { ...next, ...userChoices(existing!) } as McpStoreServerSpec;
          draft.set(id, merged);
          outcome = specJson(merged) === specJson(existing!) ? "unchanged" : "updated";
        }
      } else if (existing === undefined) {
        if (next) { draft.set(id, next); outcome = "registered"; } else outcome = "absent";
      } else if (next && migrate.has(id)) {
        draft.set(id, { ...next, ...userChoices(existing) } as McpStoreServerSpec);
        outcome = "migrated";
      } else outcome = "name-taken";
      report[id] = { outcome, state: outcome === "name-taken" && status.state === "ready" ? "name-taken" : status.state };
    }
  });
  return report;
}

// Restores the pre-migration entries for names that are still the built-in registration, and
// remembers the choice (`rolledBack`) so the next reconcile does not quietly migrate them again.
export function rollbackBuiltInMigration(store: McpStoreRegistry, home: string): McpBuiltInId[] {
  const backup = readBackup(home);
  if (!backup) throw new Error("computer-use/reconcile-backup.json is unreadable; refusing to roll back");
  const names = BUILT_IN_IDS.filter((id) => id in backup.originals && isOurs(store.get(id), id));
  if (names.length === 0) return [];
  writeBackup(home, { ...backup, rolledBack: [...new Set([...backup.rolledBack, ...names])] });
  store.reconcile((draft) => { for (const id of names) draft.set(id, backup.originals[id] as McpStoreServerSpec); });
  const originals = { ...backup.originals };
  for (const id of names) delete originals[id];
  writeBackup(home, { ...backup, originals, rolledBack: [...new Set([...backup.rolledBack, ...names])] });
  return names;
}

// Operator-facing statuses: resolution plus the one fact only the store knows -- that a user's own
// same-named server is occupying the name, so the built-in is deliberately not registered.
export function builtInStatuses(store: McpStoreRegistry, ctx: BuiltInContext, home: string, fs?: BuiltInFs): BuiltInStatus[] {
  const resolved = resolveBuiltIns(ctx, home, fs);
  return BUILT_IN_IDS.map((id) => {
    const { status } = resolved[id];
    const existing = store.get(id);
    if (status.state === "ready" && existing !== undefined && !isOurs(existing, id)) {
      return { ...status, state: "name-taken", reason: `A custom MCP server named "${id}" already exists, so the built-in was not registered. Rename or remove it to use the built-in.` };
    }
    return status;
  });
}
