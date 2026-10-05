import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BuiltInManifestSchema } from "@chimera/core/builtin-integrations";
import { LayaCheckpointSchema, layaCheckpointEnv } from "@chimera/core/computer-use";

// The release build (scripts/integration-stage.mjs) and the daemon (builtin-integrations.ts) are
// two programs joined only by manifest.json. These tests run the build side's pure pieces and feed
// the result through the daemon's real schema, so a field renamed on one side fails here rather
// than on a user's first launch.

const scripts = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts");
const stage = await import(join(scripts, "integration-stage.mjs"));
const pins = await import(join(scripts, "integration-pins.mjs"));

const bundled = {
  desktop: { state: "bundled", version: pins.CUA_DRIVER.version, driver: "integrations/cua-driver/cua-driver", license: "MIT", source: pins.CUA_DRIVER.source },
  browser: { executable: "integrations/browser/chrome-headless-shell-mac-arm64/chrome-headless-shell", sha256: "a".repeat(64) },
  laya: { wheel: "integrations/laya/laya.whl", wheelSha256: "b".repeat(64), lock: "integrations/laya/requirements.lock", lockSha256: "c".repeat(64) },
};

const entry = (platform: string, arch: string, over: Record<string, unknown> = {}) =>
  stage.buildManifest({ platform, arch, nodeRel: platform === "win32" ? "node/node.exe" : "node/bin/node", ...over });

describe("buildManifest", () => {
  it.each([["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["win32", "x64"]])("emits a schema-valid, path-relative manifest for %s-%s", (platform, arch) => {
    const manifest = entry(platform, arch, bundled);
    const parsed = BuiltInManifestSchema.parse(manifest);
    expect(parsed.integrations.laya.state).toBe("managed-download");
    // The reviewed build pin must reach the manifest the daemon enforces at first use, not stop at the build host.
    expect(parsed.integrations.laya).toMatchObject({ checkpoint: pins.LAYA.checkpoint });
    expect(JSON.stringify(parsed.integrations.laya)).not.toMatch(/\/Users\//);
    expect(JSON.stringify(manifest)).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\|\/private\/|\/tmp\//);
  });

  it("uses the platform's python layout", () => {
    expect(entry("darwin", "arm64", bundled).integrations.laya.python).toBe("python/bin/python3");
    expect(entry("win32", "x64", bundled).integrations.laya.python).toBe("python/python.exe");
  });

  it.each([["linux", "x64"], ["win32", "x64"], ["win32", "arm64"]])("reports desktop control unsupported on %s-%s instead of shipping a driver nothing can host", (platform, arch) => {
    const m = BuiltInManifestSchema.parse(entry(platform, arch, { ...bundled, desktop: undefined }));
    expect(m.integrations["chimera-desktop"]).toMatchObject({ state: "unsupported-platform", reason: expect.stringContaining("macOS") });
  });

  it("reports the browser and laya as unsupported when no pinned asset was staged", () => {
    const m = BuiltInManifestSchema.parse(entry("linux", "arm64", { desktop: undefined }));
    expect(m.integrations["chimera-browser"]).toMatchObject({ state: "unsupported-platform", reason: expect.stringContaining("linux-arm64") });
    expect(m.integrations.laya).toMatchObject({ state: "unsupported-platform", reason: expect.stringContaining("linux-arm64") });
  });
});

describe("pins", () => {
  const hex = /^[a-f0-9]{64}$/;
  it("covers exactly the platforms the build claims", () => {
    expect(Object.keys(pins.PYTHON.assets).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
    expect(Object.keys(pins.CHROME_HEADLESS_SHELL.assets).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]);
    expect(Object.keys(pins.CUA_DRIVER.assets)).toEqual(["darwin"]);
  });
  it("pins every download by sha256 over https", () => {
    const all = [...Object.values(pins.PYTHON.assets), ...Object.values(pins.CHROME_HEADLESS_SHELL.assets), pins.LAYA.wheel, ...Object.values(pins.CUA_DRIVER.assets)] as { sha256: string; url?: string }[];
    for (const a of all) { expect(a.sha256).toMatch(hex); if (a.url) expect(a.url).toMatch(/^https:\/\//); }
    expect(pins.CUA_DRIVER.base).toMatch(/^https:\/\//);
    expect(pins.PLAYWRIGHT_MCP.integrity).toMatch(/^sha512-/);
  });
  it("pins the whole browser npm closure by integrity, including @playwright/mcp itself", () => {
    expect(Object.keys(pins.PLAYWRIGHT_MCP.closure).sort()).toEqual(["node_modules/@playwright/mcp", "node_modules/playwright", "node_modules/playwright-core"]);
    for (const pin of Object.values(pins.PLAYWRIGHT_MCP.closure) as { version: string; integrity: string }[]) expect(pin.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(pins.PLAYWRIGHT_MCP.closure["node_modules/@playwright/mcp"].integrity).toBe(pins.PLAYWRIGHT_MCP.integrity);
  });
  it("pins the Laya checkpoint to a full commit and the model digest, never a moving ref", () => {
    expect(pins.LAYA.checkpoint.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(pins.LAYA.checkpoint.files["model.safetensors"]).toMatch(hex);
  });
  it.each([
    ["a branch name", (c: Record<string, unknown>) => ({ ...c, revision: "main" })],
    ["the symbolic `reviewed`, which would move with a Laya upgrade", (c: Record<string, unknown>) => ({ ...c, revision: "reviewed" })],
    ["a short SHA", (c: Record<string, unknown>) => ({ ...c, revision: "55cf4c4" })],
    ["no digests", (c: Record<string, unknown>) => ({ ...c, files: {} })],
    ["a digest for some other file only", (c: Record<string, unknown>) => ({ ...c, files: { "extra.bin": "a".repeat(64) } })],
    ["a missing checkpoint", () => undefined],
  ])("the daemon refuses a manifest whose laya checkpoint is %s", (_what, mutate) => {
    const m = JSON.parse(JSON.stringify(entry("darwin", "arm64", bundled)));
    m.integrations.laya.checkpoint = mutate(m.integrations.laya.checkpoint);
    expect(() => BuiltInManifestSchema.parse(m)).toThrow();
  });
  it("the build pin passes the daemon's strict checkpoint schema, so a malformed pin fails the build rather than a user's first use", () => {
    expect(() => LayaCheckpointSchema.parse(pins.LAYA.checkpoint)).not.toThrow();
    expect(layaCheckpointEnv(pins.LAYA.checkpoint)).toMatchObject({ LAYA_REVISION: pins.LAYA.checkpoint.revision, HF_HUB_OFFLINE: "1" });
  });
  it("stages only the cua-driver files `serve`/`mcp` use, never the competing CuaDriver.app identity", () => {
    expect(pins.CUA_DRIVER.keep).toEqual(["cua-driver", "cua-cursor-theme", "LICENSE", "THIRD_PARTY_NOTICES.md"]);
  });
});

describe("laya hash lock", () => {
  const item = (name: string, version: string, sha: string, requested = false) => ({ requested, metadata: { name, version }, download_info: { archive_info: { hashes: { sha256: sha } } } });
  const sha = (c: string) => c.repeat(64);

  it("pins every dependency to its archive hash and leaves laya itself to the bundled wheel", () => {
    const lock = stage.lockFromPipReport({ install: [item("laya", "0.3.27", sha("a"), true), item("torch", "2.14.1", sha("b")), item("Annotated_Types", "0.8.0", sha("c"))] });
    expect(lock).toBe(`Annotated_Types==0.8.0 --hash=sha256:${sha("c")}\ntorch==2.14.1 --hash=sha256:${sha("b")}\n`);
    expect(stage.validateLock(lock)).toBe(2);
  });
  it("is deterministic regardless of pip's report order", () => {
    const a = [item("b", "1", sha("1")), item("a", "1", sha("2"))];
    expect(stage.lockFromPipReport({ install: a })).toBe(stage.lockFromPipReport({ install: [...a].reverse() }));
  });
  it.each([
    ["a dependency without a sha256", { install: [{ metadata: { name: "x", version: "1" }, download_info: {} }] }, /without a sha256/],
    ["a duplicated distribution", { install: [item("x", "1", sha("a")), item("X", "2", sha("b"))] }, /twice/],
    ["an empty resolution", { install: [item("laya", "0.3.27", sha("a"), true)] }, /no dependencies/],
    ["a report with no install list", {}, /no install list/],
  ])("refuses %s", (_what, report, msg) => { expect(() => stage.lockFromPipReport(report)).toThrow(msg); });
  it.each([
    ["an unhashed line", "numpy==2.0.0\n"],
    ["a range instead of an exact pin", "numpy>=2 --hash=sha256:" + "a".repeat(64) + "\n"],
    ["laya itself", "laya==0.3.27 --hash=sha256:" + "a".repeat(64) + "\n"],
    ["an index override smuggled in", "--index-url https://evil.example/simple\nnumpy==2.0.0 --hash=sha256:" + "a".repeat(64) + "\n"],
    ["an empty lock", "# nothing\n"],
  ])("rejects %s", (_what, text) => { expect(() => stage.validateLock(text)).toThrow(); });

  describe("obtainLock", () => {
    const repo = () => { const r = mkdtempSync(join(tmpdir(), "chimera-lock-")); mkdirSync(join(r, "scripts", "integration-locks"), { recursive: true }); return r; };
    const good = `numpy==2.0.0 --hash=sha256:${"a".repeat(64)}\n`;
    const quiet = () => {};

    it("fails closed when no reviewed lock exists, without resolving anything", async () => {
      let resolved = false;
      await expect(stage.obtainLock({ repoRoot: repo(), key: "linux-x64", env: {}, log: quiet, resolve: async () => { resolved = true; return good; } })).rejects.toThrow(/No committed Laya dependency lock for linux-x64/);
      expect(resolved).toBe(false);
    });
    it("resolves live only on explicit opt-in, validates it and writes it into the repo for review", async () => {
      const r = repo();
      const lock = await stage.obtainLock({ repoRoot: r, key: "linux-x64", env: { CHIMERA_RESOLVE_LAYA_LOCK: "1" }, log: quiet, resolve: async () => good });
      expect(lock).toBe(good);
      const written = readFileSync(join(r, "scripts", "integration-locks", `laya-${pins.LAYA.version}-linux-x64.lock`), "utf8");
      expect(written).toContain("RESOLVED LIVE: review");
      expect(written).toContain(good);
    });
    it("never accepts a malformed live resolution", async () => {
      const r = repo();
      await expect(stage.obtainLock({ repoRoot: r, key: "linux-x64", env: { CHIMERA_RESOLVE_LAYA_LOCK: "1" }, log: quiet, resolve: async () => "numpy==2.0.0\n" })).rejects.toThrow(/Malformed/);
      expect(existsSync(join(r, "scripts", "integration-locks", `laya-${pins.LAYA.version}-linux-x64.lock`))).toBe(false);
    });
    it("prefers the committed lock and ignores the opt-in when one exists", async () => {
      const r = repo();
      writeFileSync(join(r, "scripts", "integration-locks", `laya-${pins.LAYA.version}-darwin-arm64.lock`), good);
      expect(await stage.obtainLock({ repoRoot: r, key: "darwin-arm64", env: { CHIMERA_RESOLVE_LAYA_LOCK: "1" }, log: quiet, resolve: async () => { throw new Error("must not resolve"); } })).toBe(good);
    });
  });

  it("the committed darwin-arm64 lock is well formed and excludes laya", () => {
    const lock = readFileSync(join(scripts, "integration-locks", `laya-${pins.LAYA.version}-darwin-arm64.lock`), "utf8");
    expect(stage.validateLock(lock)).toBeGreaterThan(40);
    expect(lock).toMatch(/^torch==/m);
    expect(lock).not.toMatch(/^laya==/m);
  });
});
