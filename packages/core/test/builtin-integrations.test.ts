import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStoreRegistry, McpStoreProvenanceError } from "@chimera/core/mcpstore";
import { browserEntry, desktopEntry, desktopSocket, layaCheckpointEnv, layaEntry } from "@chimera/core/computer-use";
import {
  BuiltInManifestSchema, builtInStatuses, findRuntimeRoot, layaPaths, loadBuiltInContext, reconcileBuiltIns,
  resolveBuiltIns, rollbackBuiltInMigration,
  type BuiltInContext, type BuiltInFs, type BuiltInManifest,
} from "@chimera/core/builtin-integrations";

// The packaged runtime ships a manifest of RELATIVE paths. Everything below runs against a fake file
// map (the BuiltInFs seam) so linux/win32 manifests are exercised without a native run, while the
// store and the migration backup use a real temp HOME so persistence/idempotency are real.

const SHA = "a".repeat(64);
const REVISION = "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851";
const MODEL_SHA = "891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c";
const CHECKPOINT = { repo: "convaiinnovations/laya", revision: REVISION, files: { "model.safetensors": MODEL_SHA } };
const ROOT = "/opt/Chimera App/runtime";
const WIN_ROOT = "C:\\Program Files\\Chimera\\runtime";

class FakeFs implements BuiltInFs {
  files = new Set<string>(); dirs = new Set<string>(); json = new Map<string, unknown>();
  isFile(p: string) { return this.files.has(p); }
  isDir(p: string) { return this.dirs.has(p); }
  readJson(p: string) { return this.json.get(p); }
}

function manifest(platform: "darwin" | "linux" | "win32" = "darwin", over: Partial<BuiltInManifest["integrations"]> = {}): BuiltInManifest {
  const exe = platform === "win32" ? ".exe" : "";
  return {
    schemaVersion: 1, platform, arch: "arm64",
    integrations: {
      "chimera-desktop": { state: "bundled", version: "0.33.3", driver: `cua/cua-driver${exe}`, license: "MIT", source: "https://example.test/cua" },
      "chimera-browser": {
        state: "bundled", version: "0.0.83", node: platform === "win32" ? "node/node.exe" : "node/bin/node",
        cli: "node_modules/@playwright/mcp/cli.js", executable: `browser/chrome-headless-shell${exe}`,
        browserVersion: "155.0.8059.12", browserSha256: SHA, browserSource: "https://example.test/cft", license: "Apache-2.0",
      },
      laya: {
        state: "managed-download", version: "0.3.27", python: platform === "win32" ? "python/python.exe" : "python/bin/python3",
        wheel: "integrations/laya/laya-0.3.27-py3-none-any.whl", wheelSha256: SHA, lock: "integrations/laya/requirements.lock", lockSha256: SHA,
        checkpoint: CHECKPOINT, source: "https://example.test/laya",
      },
      ...over,
    },
  };
}

const sep = (platform: string) => (platform === "win32" ? "\\" : "/");
function stage(m: BuiltInManifest, root = m.platform === "win32" ? WIN_ROOT : ROOT): { ctx: BuiltInContext; fs: FakeFs } {
  const fs = new FakeFs();
  const s = sep(m.platform);
  const abs = (rel: string) => `${root}${s}${rel.replace(/\//g, s)}`;
  const i = m.integrations;
  if (i["chimera-desktop"].state === "bundled") fs.files.add(abs(i["chimera-desktop"].driver));
  if (i["chimera-browser"].state === "bundled") for (const rel of [i["chimera-browser"].node, i["chimera-browser"].cli, i["chimera-browser"].executable]) fs.files.add(abs(rel));
  if (i.laya.state === "managed-download") for (const rel of [i.laya.python, i.laya.wheel, i.laya.lock]) fs.files.add(abs(rel));
  return { ctx: { root, manifest: m, pid: 4242 }, fs };
}

function markLayaInstalled(ctx: BuiltInContext, home: string, fs: FakeFs): void {
  const p = layaPaths(ctx, home);
  const l = ctx.manifest.integrations.laya;
  if (l.state !== "managed-download") throw new Error("fixture");
  fs.json.set(p.ready, { version: l.version, wheelSha256: l.wheelSha256, lockSha256: l.lockSha256, installedAt: "2026-10-05T00:00:00.000Z", checkpoint: l.checkpoint });
  fs.dirs.add(p.site);
  // The install step downloaded and hashed the weights into this snapshot; the offline entry reads it.
  for (const file of Object.keys(l.checkpoint.files)) fs.files.add(`${p.snapshot}${p.snapshot.includes("\\") ? "\\" : "/"}${file}`);
}

const tmpHome = () => mkdtempSync(join(tmpdir(), "chimera-builtin-"));
const stored = (home: string) => JSON.parse(readFileSync(join(home, "mcpstore.json"), "utf8")) as Record<string, any>;

describe("manifest schema", () => {
  it.each([["absolute posix", "/etc/cua-driver"], ["parent traversal", "cua/../../x"], ["drive letter", "C:\\cua\\driver.exe"], ["unc", "\\\\host\\share\\x"], ["drive-relative", "C:driver.exe"]])(
    "rejects a %s path: the artifact may not embed an install location or escape the runtime", (_label, rel) => {
      const m = manifest();
      const bad = { ...m, integrations: { ...m.integrations, "chimera-desktop": { ...(m.integrations["chimera-desktop"] as object), driver: rel } } };
      expect(() => BuiltInManifestSchema.parse(bad)).toThrow();
    });
  describe("laya checkpoint pin", () => {
    const withCheckpoint = (checkpoint: unknown) => {
      const m = manifest();
      return { ...m, integrations: { ...m.integrations, laya: { ...(m.integrations.laya as object), checkpoint } } };
    };
    it("is required: a managed-download manifest without it is refused rather than tracking mutable main", () => {
      const m = manifest();
      const { checkpoint: _c, ...bare } = m.integrations.laya as Record<string, unknown>;
      expect(() => BuiltInManifestSchema.parse({ ...m, integrations: { ...m.integrations, laya: bare } })).toThrow();
      expect(() => BuiltInManifestSchema.parse(withCheckpoint(CHECKPOINT))).not.toThrow();
    });
    it.each([
      ["a branch name instead of a commit", { ...CHECKPOINT, revision: "main" }],
      ["Laya's symbolic `reviewed` alias", { ...CHECKPOINT, revision: "reviewed" }],
      ["a short sha", { ...CHECKPOINT, revision: REVISION.slice(0, 7) }],
      ["an uppercase sha", { ...CHECKPOINT, revision: REVISION.toUpperCase() }],
      ["a non-hex digest", { ...CHECKPOINT, files: { "model.safetensors": "z".repeat(64) } }],
      ["a short digest", { ...CHECKPOINT, files: { "model.safetensors": "abc" } }],
      ["no model.safetensors digest", { ...CHECKPOINT, files: { "other.bin": MODEL_SHA } }],
      ["an empty files map", { ...CHECKPOINT, files: {} }],
      ["a path as a file name", { ...CHECKPOINT, files: { "model.safetensors": MODEL_SHA, "../escape": MODEL_SHA } }],
      ["a nested digest map (Laya would leave unnamed checkpoints unverified)", { ...CHECKPOINT, files: { english: { "model.safetensors": MODEL_SHA } } }],
      ["a malformed repo", { ...CHECKPOINT, repo: "not a repo" }],
      ["an unknown key", { ...CHECKPOINT, branch: "main" }],
    ])("fails closed on %s", (_label, checkpoint) => {
      expect(() => BuiltInManifestSchema.parse(withCheckpoint(checkpoint))).toThrow();
      expect(() => loadBuiltInContext("/rt", { platform: "darwin", arch: "arm64" }, (() => {
        const fs = new FakeFs();
        fs.json.set("/rt/integrations/manifest.json", withCheckpoint(checkpoint));
        fs.json.set("/rt/runtime.json", { platform: "darwin", arch: "arm64" });
        return fs;
      })())).toThrow();
    });
    it("layaCheckpointEnv re-validates, so a bad pin that bypassed the manifest still cannot produce an entry", () => {
      expect(layaCheckpointEnv(CHECKPOINT)).toEqual({
        LAYA_REVISION: REVISION, LAYA_SHA256_DIGESTS: JSON.stringify(CHECKPOINT.files), HF_HUB_OFFLINE: "1",
        LAYA_MODELS: "english", LAYA_DEFAULT_MODEL: "english",
      });
      expect(() => layaCheckpointEnv({ ...CHECKPOINT, revision: "main" })).toThrow();
      expect(() => layaCheckpointEnv({ ...CHECKPOINT, files: {} })).toThrow();
      expect(() => layaEntry({ home: "/h", python: "/h/py", platform: "linux", checkpoint: { ...CHECKPOINT, revision: "reviewed" } })).toThrow();
    });
    it("cannot be weakened by the caller's env: the pin is applied last", () => {
      const e = layaEntry({
        home: "/h", python: "/h/py", platform: "linux", checkpoint: CHECKPOINT,
        env: { HF_HUB_OFFLINE: "0", LAYA_REVISION: "main", LAYA_SHA256_DIGESTS: "{}", LAYA_THREADS: "2" },
      });
      expect(e.type === "stdio" && e.env).toMatchObject({ HF_HUB_OFFLINE: "1", LAYA_REVISION: REVISION, LAYA_SHA256_DIGESTS: JSON.stringify(CHECKPOINT.files), LAYA_THREADS: "2" });
    });
  });
  it("rejects unknown keys so a forged manifest cannot smuggle fields", () => {
    expect(() => BuiltInManifestSchema.parse({ ...manifest(), extra: true })).toThrow();
  });
  it("carries no developer path in the serialised manifest", () => {
    expect(JSON.stringify(manifest("darwin"))).not.toMatch(/\/Users\/|\/home\/|C:\\\\Users/);
  });
});

describe("loadBuiltInContext / findRuntimeRoot", () => {
  const fsWith = (m: unknown, runtime: unknown) => {
    const fs = new FakeFs();
    fs.json.set("/rt/integrations/manifest.json", m);
    fs.json.set("/rt/runtime.json", runtime);
    return fs;
  };
  it("loads a manifest that matches runtime.json and the host", () => {
    const ctx = loadBuiltInContext("/rt", { platform: "darwin", arch: "arm64" }, fsWith(manifest(), { platform: "darwin", arch: "arm64" }));
    expect(ctx.root).toBe("/rt");
    expect(ctx.manifest.platform).toBe("darwin");
  });
  it("refuses a manifest that disagrees with runtime.json", () => {
    expect(() => loadBuiltInContext("/rt", { platform: "darwin", arch: "arm64" }, fsWith(manifest(), { platform: "linux", arch: "arm64" }))).toThrow(/runtime\.json/);
  });
  it("refuses a runtime built for another host", () => {
    expect(() => loadBuiltInContext("/rt", { platform: "linux", arch: "x64" }, fsWith(manifest(), { platform: "darwin", arch: "arm64" }))).toThrow(/this host/);
  });
  it("refuses a missing or invalid manifest", () => {
    expect(() => loadBuiltInContext("/rt", { platform: "darwin", arch: "arm64" }, new FakeFs())).toThrow(/manifest\.json/);
    expect(() => loadBuiltInContext("/rt", { platform: "darwin", arch: "arm64" }, fsWith({ schemaVersion: 2 }, { platform: "darwin", arch: "arm64" }))).toThrow();
  });
  it("finds the packaged runtime three levels above the module and returns null elsewhere", () => {
    const fs = new FakeFs();
    fs.files.add("/Applications/Chimera.app/runtime/runtime.json");
    fs.files.add("/Applications/Chimera.app/runtime/integrations/manifest.json");
    expect(findRuntimeRoot("file:///Applications/Chimera.app/runtime/packages/core/src/builtin-integrations.js", fs)).toBe("/Applications/Chimera.app/runtime");
    expect(findRuntimeRoot("file:///work/chimera/packages/core/src/builtin-integrations.ts", fs)).toBeNull();
  });
  it("is null for the real dev checkout (no packaged runtime beside the sources)", () => {
    expect(findRuntimeRoot()).toBeNull();
  });
});

describe("resolveBuiltIns", () => {
  it("resolves absolute entries under a relocated root with a space, no developer path", () => {
    const home = "/tmp/fresh home/.chimera";
    const { ctx, fs } = stage(manifest());
    const r = resolveBuiltIns(ctx, home, fs);
    const d = r["chimera-desktop"].entry!, b = r["chimera-browser"].entry!;
    expect(d.type === "stdio" && d.command).toBe(`${ROOT}/cua/cua-driver`);
    expect(d.type === "stdio" && d.builtIn).toEqual({ id: "chimera-desktop", version: "0.33.3" });
    expect(d.type === "stdio" && d.sessionMode).toBe("exclusive");
    expect(d.type === "stdio" && d.args).toContain(desktopSocket(home, "darwin"));
    expect(d.type === "stdio" && d.env).toMatchObject({ CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", CUA_TELEMETRY_ENABLED: "0", DO_NOT_TRACK: "1" });
    expect(b.type === "stdio" && b.sessionMode).toBe("agent");
    expect(b.type === "stdio" && b.args).toEqual([`${ROOT}/node_modules/@playwright/mcp/cli.js`, "--isolated", "--headless", "--caps", "vision", "--executable-path", `${ROOT}/browser/chrome-headless-shell`]);
    expect(JSON.stringify(r)).not.toMatch(/\/Users\/nedim/);
  });
  it("reports laya as a first-use download that is NOT registered until installed, and never claims assets are bundled", () => {
    const { ctx, fs } = stage(manifest());
    const laya = resolveBuiltIns(ctx, "/h", fs).laya;
    expect(laya.entry).toBeUndefined();
    expect(laya.status).toMatchObject({ id: "laya", state: "not-installed", provisioning: "managed-download", modelAssets: "downloaded-on-first-use", version: "0.3.27" });
  });
  it("registers laya only from ready.json written for THIS wheel/lock hash plus an existing site dir", () => {
    const { ctx, fs } = stage(manifest());
    markLayaInstalled(ctx, "/h", fs);
    const laya = resolveBuiltIns(ctx, "/h", fs).laya;
    expect(laya.status.state).toBe("ready");
    const e = laya.entry!;
    expect(e.type === "stdio" && e.command).toBe(`${ROOT}/python/bin/python3`);
    expect(e.type === "stdio" && e.env).toMatchObject({
      PYTHONPATH: "/h/integrations/laya-0.3.27/site", HF_HOME: "/h/integrations/laya-0.3.27/hf",
      PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", HF_HUB_DISABLE_TELEMETRY: "1",
    });
    // A ready marker for a different lock (e.g. left by another release) must not count.
    fs.json.set(layaPaths(ctx, "/h").ready, { version: "0.3.27", wheelSha256: SHA, lockSha256: "b".repeat(64), installedAt: "x", checkpoint: CHECKPOINT });
    expect(resolveBuiltIns(ctx, "/h", fs).laya.status.state).toBe("not-installed");
  });
  it("registers the built-in laya pinned to the reviewed revision + digest and offline, so first use cannot follow mutable main", () => {
    const { ctx, fs } = stage(manifest());
    markLayaInstalled(ctx, "/h", fs);
    const e = resolveBuiltIns(ctx, "/h", fs).laya.entry!;
    if (e.type !== "stdio") throw new Error("laya is a stdio entry");
    expect(e.env).toMatchObject({
      LAYA_REVISION: REVISION, LAYA_SHA256_DIGESTS: JSON.stringify({ "model.safetensors": MODEL_SHA }),
      HF_HUB_OFFLINE: "1", LAYA_PRELOAD: "0",
    });
    // Laya's own `reviewed` alias resolves from the installed package's table and would move with an upgrade.
    expect(e.env.LAYA_REVISION).toMatch(/^[a-f0-9]{40}$/);
    // Flat digest shape (a nested one leaves unnamed checkpoints unverified).
    expect(Object.values(JSON.parse(e.env.LAYA_SHA256_DIGESTS))).toEqual([MODEL_SHA]);
  });
  it("does not register laya when the install has not verified THIS checkpoint (legacy ready.json, other pin, missing weights)", () => {
    const { ctx, fs } = stage(manifest());
    const p = layaPaths(ctx, "/h");
    markLayaInstalled(ctx, "/h", fs);
    const ready = fs.json.get(p.ready) as Record<string, unknown>;
    const unverified = () => {
      const r = resolveBuiltIns(ctx, "/h", fs).laya;
      expect(r.entry).toBeUndefined();
      expect(r.status).toMatchObject({ state: "not-installed", reason: expect.stringMatching(/reviewed revision and checksum/) });
    };

    // A ready.json from before the pin existed: its weights came from mutable main and were never hashed.
    const { checkpoint: _legacy, ...legacy } = ready;
    fs.json.set(p.ready, legacy);
    unverified();

    // Installed under an older pin (a later release moved the revision, same wheel + lock).
    fs.json.set(p.ready, { ...ready, checkpoint: { ...CHECKPOINT, revision: "1".repeat(40) } });
    unverified();
    fs.json.set(p.ready, { ...ready, checkpoint: { ...CHECKPOINT, files: { "model.safetensors": "2".repeat(64) } } });
    expect(resolveBuiltIns(ctx, "/h", fs).laya.entry).toBeUndefined();

    // Marker is right but the verified weights are gone (cache wiped): offline first use would fail anyway.
    fs.json.set(p.ready, ready);
    fs.files.delete(`${p.snapshot}/model.safetensors`);
    unverified();

    // A malformed pin in the ready marker is rejected, never half-trusted.
    fs.json.set(p.ready, { ...ready, checkpoint: { ...CHECKPOINT, revision: "main" } });
    expect(resolveBuiltIns(ctx, "/h", fs).laya.entry).toBeUndefined();
  });
  it("a different laya build is still the plain first-use download, not the checkpoint message", () => {
    const { ctx, fs } = stage(manifest());
    const p = layaPaths(ctx, "/h");
    fs.json.set(p.ready, { version: "0.3.1", wheelSha256: SHA, lockSha256: SHA, installedAt: "x", checkpoint: CHECKPOINT });
    fs.dirs.add(p.site);
    expect(resolveBuiltIns(ctx, "/h", fs).laya.status).toMatchObject({ state: "not-installed", reason: "Laya's Python packages and models download on first use." });
  });
  it("distinguishes installing, interrupted and failed installs", () => {
    const { ctx, fs } = stage(manifest());
    const p = layaPaths(ctx, "/h");
    fs.json.set(p.status, { state: "installing", pid: 4242, at: "t" });
    expect(resolveBuiltIns(ctx, "/h", fs).laya.status.state).toBe("installing");
    fs.json.set(p.status, { state: "installing", pid: 1, at: "t" });
    expect(resolveBuiltIns(ctx, "/h", fs).laya.status).toMatchObject({ state: "failed", reason: expect.stringMatching(/interrupted/) });
    fs.json.set(p.status, { state: "failed", error: "pip exploded", at: "t" });
    expect(resolveBuiltIns(ctx, "/h", fs).laya.status).toMatchObject({ state: "failed", reason: "pip exploded" });
  });
  it("marks an integration unavailable (not ready) when a bundled file is missing", () => {
    const { ctx, fs } = stage(manifest());
    fs.files.delete(`${ROOT}/cua/cua-driver`);
    const r = resolveBuiltIns(ctx, "/h", fs);
    expect(r["chimera-desktop"].entry).toBeUndefined();
    expect(r["chimera-desktop"].status).toMatchObject({ state: "unavailable", reason: expect.stringContaining("cua/cua-driver") });
    expect(r["chimera-browser"].status.state).toBe("ready");
  });
  it("linux fixture resolves POSIX paths; native capability is NOT claimed beyond the manifest", () => {
    const { ctx, fs } = stage(manifest("linux"));
    const r = resolveBuiltIns(ctx, "/home/u/.chimera", fs);
    expect(r["chimera-desktop"].status.state).toBe("ready");
    expect(r["chimera-desktop"].entry).toBeDefined();
  });
  it("win32 fixture resolves backslash paths and a named-pipe socket", () => {
    const { ctx, fs } = stage(manifest("win32"));
    const home = "C:\\Users\\u\\.chimera";
    const r = resolveBuiltIns(ctx, home, fs);
    const d = r["chimera-desktop"].entry!;
    expect(d.type === "stdio" && d.command).toBe(`${WIN_ROOT}\\cua\\cua-driver.exe`);
    expect(d.type === "stdio" && d.args[d.args.indexOf("--socket") + 1]).toMatch(/^\\\\\.\\pipe\\chimera-computer-/);
    const b = r["chimera-browser"].entry!;
    expect(b.type === "stdio" && b.command).toBe(`${WIN_ROOT}\\node\\node.exe`);
    expect(layaPaths(ctx, home).site).toBe("C:\\Users\\u\\.chimera\\integrations\\laya-0.3.27\\site");
  });
  it("surfaces unsupported platforms with a reason and no entry", () => {
    const m = manifest("linux", {
      "chimera-browser": { state: "unsupported-platform", reason: "No pinned browser build for linux-arm64." },
      laya: { state: "unsupported-platform", reason: "No Python runtime for this platform." },
    });
    const { ctx, fs } = stage(m);
    const r = resolveBuiltIns(ctx, "/h", fs);
    expect(r["chimera-browser"]).toEqual({ status: { id: "chimera-browser", state: "unsupported-platform", provisioning: "bundled", reason: "No pinned browser build for linux-arm64." } });
    expect(r.laya.entry).toBeUndefined();
    expect(r.laya.status.state).toBe("unsupported-platform");
    expect(() => layaPaths(ctx, "/h")).toThrow(/not available/);
  });
});

describe("reconcileBuiltIns", () => {
  it("registers ready built-ins on a fresh home, leaves laya out, and writes no developer path", () => {
    const home = tmpHome();
    const store = new McpStoreRegistry(home);
    const { ctx, fs } = stage(manifest());
    const report = reconcileBuiltIns(store, { home, ctx, fs })!;
    expect(report["chimera-desktop"].outcome).toBe("registered");
    expect(report["chimera-browser"].outcome).toBe("registered");
    expect(report.laya).toEqual({ outcome: "absent", state: "not-installed" });
    const file = readFileSync(join(home, "mcpstore.json"), "utf8");
    expect(Object.keys(JSON.parse(file)).sort()).toEqual(["chimera-browser", "chimera-desktop"]);
    expect(file).not.toMatch(/\/Users\/nedim/);
    expect(file).toContain(ROOT);
  });
  it("is a no-op without a packaged runtime", () => {
    const home = tmpHome();
    expect(reconcileBuiltIns(new McpStoreRegistry(home), { home, ctx: null })).toBeNull();
    expect(existsSync(join(home, "mcpstore.json"))).toBe(false);
  });
  it("is idempotent: a second run (and a fresh process) leaves the file byte-identical", () => {
    const home = tmpHome();
    const { ctx, fs } = stage(manifest());
    reconcileBuiltIns(new McpStoreRegistry(home), { home, ctx, fs });
    const first = readFileSync(join(home, "mcpstore.json"), "utf8");
    const again = reconcileBuiltIns(new McpStoreRegistry(home), { home, ctx, fs })!;
    expect({ d: again["chimera-desktop"].outcome, b: again["chimera-browser"].outcome, l: again.laya.outcome }).toEqual({ d: "unchanged", b: "unchanged", l: "absent" });
    expect(readFileSync(join(home, "mcpstore.json"), "utf8")).toBe(first);
  });
  it("registers laya once the first-use install has completed", () => {
    const home = tmpHome();
    const store = new McpStoreRegistry(home);
    const { ctx, fs } = stage(manifest());
    reconcileBuiltIns(store, { home, ctx, fs });
    markLayaInstalled(ctx, home, fs);
    expect(reconcileBuiltIns(store, { home, ctx, fs })!.laya.outcome).toBe("registered");
    expect(stored(home).laya.builtIn).toEqual({ id: "laya", version: "0.3.27" });
    expect(stored(home).laya.sessionMode).toBe("shared");
  });
  it("rewrites a registered laya when the pin changes, and removes it until the new checkpoint is verified", () => {
    const home = tmpHome();
    const store = new McpStoreRegistry(home);
    const a = stage(manifest());
    markLayaInstalled(a.ctx, home, a.fs);
    expect(reconcileBuiltIns(store, { home, ctx: a.ctx, fs: a.fs })!.laya.outcome).toBe("registered");
    expect(stored(home).laya.env.LAYA_REVISION).toBe(REVISION);

    // Same wheel + lock, new reviewed revision: the old verification no longer covers the entry.
    const next = manifest();
    (next.integrations.laya as { checkpoint: typeof CHECKPOINT }).checkpoint = { ...CHECKPOINT, revision: "3".repeat(40) };
    const b = stage(next);
    b.fs.json = a.fs.json; b.fs.dirs = a.fs.dirs; b.fs.files = new Set([...b.fs.files, ...a.fs.files]);
    expect(reconcileBuiltIns(store, { home, ctx: b.ctx, fs: b.fs })!.laya.outcome).toBe("removed");
    expect(stored(home).laya).toBeUndefined();

    markLayaInstalled(b.ctx, home, b.fs);
    expect(reconcileBuiltIns(store, { home, ctx: b.ctx, fs: b.fs })!.laya.outcome).toBe("registered");
    expect(stored(home).laya.env.LAYA_REVISION).toBe("3".repeat(40));
  });
  it("self-heals a relocated app: the same built-in is rewritten to the new root", () => {
    const home = tmpHome();
    const store = new McpStoreRegistry(home);
    const a = stage(manifest(), "/Applications/Old/runtime");
    reconcileBuiltIns(store, { home, ctx: a.ctx, fs: a.fs });
    const b = stage(manifest(), "/Volumes/New Disk/Chimera/runtime");
    const report = reconcileBuiltIns(store, { home, ctx: b.ctx, fs: b.fs })!;
    expect(report["chimera-desktop"].outcome).toBe("updated");
    const file = readFileSync(join(home, "mcpstore.json"), "utf8");
    expect(file).toContain("/Volumes/New Disk/Chimera/runtime");
    expect(file).not.toContain("/Applications/Old");
  });
  it("preserves the user's enable/trust/direct choices across restarts and upgrades", () => {
    const home = tmpHome();
    const store = new McpStoreRegistry(home);
    const a = stage(manifest(), "/Applications/Old/runtime");
    reconcileBuiltIns(store, { home, ctx: a.ctx, fs: a.fs });
    store.setEnabled("chimera-browser", false);
    store.setDirect("chimera-desktop", true);
    const b = stage(manifest(), "/Applications/New/runtime");
    reconcileBuiltIns(store, { home, ctx: b.ctx, fs: b.fs });
    const after = new McpStoreRegistry(home);
    expect(after.get("chimera-browser")).toMatchObject({ enabled: false, builtIn: { id: "chimera-browser" } });
    expect(after.get("chimera-desktop")).toMatchObject({ direct: true });
    expect(JSON.stringify(after.get("chimera-browser"))).toContain("/Applications/New/runtime");
  });
  it("never overwrites a same-named custom entry (name-taken) and reports it", () => {
    const home = tmpHome();
    const store = new McpStoreRegistry(home);
    store.add({ name: "chimera-desktop", type: "stdio", command: "/usr/local/bin/my-own", args: ["--serve"], env: {}, enabled: true, direct: false, sessionMode: "shared" } as any);
    store.add({ name: "laya", type: "http", url: "https://example.test/mcp", enabled: true, direct: false } as any);
    const before = readFileSync(join(home, "mcpstore.json"), "utf8");
    const { ctx, fs } = stage(manifest());
    markLayaInstalled(ctx, home, fs);
    const report = reconcileBuiltIns(store, { home, ctx, fs })!;
    expect(report["chimera-desktop"]).toEqual({ outcome: "name-taken", state: "name-taken" });
    expect(report.laya.outcome).toBe("name-taken");
    expect(report["chimera-browser"].outcome).toBe("registered");
    const after = stored(home);
    expect(after["chimera-desktop"].command).toBe("/usr/local/bin/my-own");
    expect(after["chimera-desktop"].builtIn).toBeUndefined();
    expect(after.laya.url).toBe("https://example.test/mcp");
    expect(JSON.parse(before)["chimera-desktop"]).toEqual(after["chimera-desktop"]);
    expect(builtInStatuses(store, ctx, home, fs).find((s) => s.id === "chimera-desktop")).toMatchObject({ state: "name-taken" });
  });
  it("does not treat a lookalike as the legacy registration: right name, wrong command stays the user's", () => {
    const home = tmpHome();
    const store = new McpStoreRegistry(home);
    // Same shape as the legacy browser entry but NOT under <home>/integrations.
    store.add(browserEntry({ home, node: "/usr/bin/node", cli: "/opt/own/playwright/cli.js" }) as any);
    const { ctx, fs } = stage(manifest());
    const report = reconcileBuiltIns(store, { home, ctx, fs })!;
    expect(report["chimera-browser"].outcome).toBe("name-taken");
    expect(existsSync(join(home, "computer-use", "reconcile-backup.json"))).toBe(false);
  });

  describe("legacy migration + rollback", () => {
    const legacy = (home: string) => {
      const store = new McpStoreRegistry(home);
      store.add(layaEntry({ home, python: join(home, "integrations", "laya", "venv", "bin", "python") }) as any);
      store.add(browserEntry({ home, node: "/usr/local/bin/node", cli: join(home, "integrations", "playwright", "cli.js") }) as any);
      store.add(desktopEntry({ home, driver: join(home, "integrations", "cua", "cua-driver") }) as any);
      store.setEnabled("chimera-browser", false);
      return store;
    };
    it("migrates the dev registrar's entries, keeps the originals in a backup and preserves user toggles", () => {
      const home = tmpHome();
      const store = legacy(home);
      const { ctx, fs } = stage(manifest());
      markLayaInstalled(ctx, home, fs);
      const original = JSON.stringify(store.get("chimera-browser"));
      const report = reconcileBuiltIns(store, { home, ctx, fs })!;
      expect(Object.values(report).map((r) => r.outcome)).toEqual(["migrated", "migrated", "migrated"]);
      const now = stored(home);
      expect(now["chimera-browser"]).toMatchObject({ enabled: false, builtIn: { id: "chimera-browser" } });
      expect(JSON.stringify(now)).not.toContain(join(home, "integrations", "playwright"));
      const backup = JSON.parse(readFileSync(join(home, "computer-use", "reconcile-backup.json"), "utf8"));
      expect(Object.keys(backup.originals).sort()).toEqual(["chimera-browser", "chimera-desktop", "laya"]);
      expect(JSON.stringify(backup.originals["chimera-browser"])).toBe(original);
    });
    it("a second run does not re-migrate and keeps the first backup intact", () => {
      const home = tmpHome();
      const store = legacy(home);
      const { ctx, fs } = stage(manifest());
      reconcileBuiltIns(store, { home, ctx, fs });
      const backup = readFileSync(join(home, "computer-use", "reconcile-backup.json"), "utf8");
      const file = readFileSync(join(home, "mcpstore.json"), "utf8");
      const again = reconcileBuiltIns(store, { home, ctx, fs })!;
      expect(again["chimera-desktop"].outcome).toBe("unchanged");
      expect(readFileSync(join(home, "computer-use", "reconcile-backup.json"), "utf8")).toBe(backup);
      expect(readFileSync(join(home, "mcpstore.json"), "utf8")).toBe(file);
    });
    it("rolls back to the pre-migration entries and the choice is sticky across restarts", () => {
      const home = tmpHome();
      const store = legacy(home);
      const before = JSON.stringify(store.get("chimera-desktop"));
      const { ctx, fs } = stage(manifest());
      reconcileBuiltIns(store, { home, ctx, fs });
      expect(rollbackBuiltInMigration(store, home).sort()).toEqual(["chimera-browser", "chimera-desktop"]);
      expect(JSON.stringify(new McpStoreRegistry(home).get("chimera-desktop"))).toBe(before);
      expect(new McpStoreRegistry(home).get("chimera-desktop")).not.toHaveProperty("builtIn");
      // Restart: the rolled-back entries are legacy-shaped again but must not be migrated a second time.
      const restarted = reconcileBuiltIns(new McpStoreRegistry(home), { home, ctx, fs })!;
      expect(restarted["chimera-desktop"].outcome).toBe("name-taken");
      expect(restarted["chimera-browser"].outcome).toBe("name-taken");
      expect(rollbackBuiltInMigration(new McpStoreRegistry(home), home)).toEqual([]);
    });
    it("refuses to migrate (and to roll back) when the backup is unreadable", () => {
      const home = tmpHome();
      const store = legacy(home);
      mkdirpWrite(join(home, "computer-use", "reconcile-backup.json"), "{ not json");
      const { ctx, fs } = stage(manifest());
      const report = reconcileBuiltIns(store, { home, ctx, fs })!;
      expect(report["chimera-desktop"].outcome).toBe("name-taken");
      expect(JSON.stringify(stored(home))).toContain(join(home, "integrations", "cua"));
      expect(() => rollbackBuiltInMigration(store, home)).toThrow(/unreadable/);
    });
    it("leaves a legacy laya in place until the managed one is actually ready", () => {
      const home = tmpHome();
      const store = legacy(home);
      const { ctx, fs } = stage(manifest());
      const report = reconcileBuiltIns(store, { home, ctx, fs })!;
      expect(report.laya.outcome).toBe("name-taken");
      expect(JSON.stringify(stored(home).laya)).toContain(join(home, "integrations", "laya"));
    });
  });

  it("removes only OUR registration when a built-in stops being available, never a user entry", () => {
    const home = tmpHome();
    const store = new McpStoreRegistry(home);
    store.add({ name: "my-server", type: "stdio", command: "/bin/x", args: [], env: {}, enabled: true, direct: false, sessionMode: "shared" } as any);
    const { ctx, fs } = stage(manifest());
    reconcileBuiltIns(store, { home, ctx, fs });
    fs.files.delete(`${ROOT}/browser/chrome-headless-shell`);
    const report = reconcileBuiltIns(store, { home, ctx, fs })!;
    expect(report["chimera-browser"]).toEqual({ outcome: "removed", state: "unavailable" });
    expect(Object.keys(stored(home)).sort()).toEqual(["chimera-desktop", "my-server"]);
  });
});

describe("provenance cannot be forged through the registry", () => {
  it("add() rejects a stdio entry carrying builtIn, even with a built-in name", () => {
    const store = new McpStoreRegistry(tmpHome());
    const forged = { name: "chimera-desktop", type: "stdio", command: "/tmp/evil", args: [], env: {}, enabled: true, direct: false, sessionMode: "exclusive", builtIn: { id: "chimera-desktop", version: "9" } };
    expect(() => store.add(forged as any)).toThrow(McpStoreProvenanceError);
    expect(store.has("chimera-desktop")).toBe(false);
  });
  it("a persisted builtIn marker is only accepted shape-wise; add() is still the gate for new entries", () => {
    const home = tmpHome();
    const { ctx, fs } = stage(manifest());
    reconcileBuiltIns(new McpStoreRegistry(home), { home, ctx, fs });
    expect(new McpStoreRegistry(home).get("chimera-desktop")).toMatchObject({ builtIn: { id: "chimera-desktop" } });
  });
});

function mkdirpWrite(path: string, text: string): void {
  // computer-use/ does not exist on a fresh home until the first migration writes the backup.
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
