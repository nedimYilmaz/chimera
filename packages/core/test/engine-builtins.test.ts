import { describe, it, expect, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { loadBuiltInContext } from "@chimera/core/builtin-integrations";
import { layaInstallIdle } from "@chimera/core/laya-install";
import { McpStoreRegistry } from "@chimera/core/mcpstore";
import { desktopEntry } from "@chimera/core/computer-use";
import { BuiltInsStatusResultSchema } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

// The built-in computer-use integrations through the real Engine: the daemon registers them from the
// installed runtime's manifest at construction, and the RPC surface must refuse everything that would
// let a caller forge or delete Chimera's own provenance. loadBuiltInContext reads the real filesystem
// for the HOST platform, so the runtime here is a genuine on-disk fixture (never a Windows/Linux claim).

vi.setConfig({ testTimeout: 15_000 });

const HOST_PLATFORM = process.platform as "darwin" | "linux" | "win32";
const HOST_ARCH = process.arch as "arm64" | "x64";
const SHA = "a".repeat(64);
const sha = (b: string) => createHash("sha256").update(b).digest("hex");
const canRunShim = process.platform !== "win32";

const WHEEL = "wheel", LOCK = "lock", MODEL = "model-bytes";
const CHECKPOINT = { repo: "convaiinnovations/laya", revision: "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851", files: { "model.safetensors": sha(MODEL) } };

function writeFile(path: string, body = "", mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  if (mode) chmodSync(path, mode);
}

// A python shim that only materialises `--target` (pip) or the pinned snapshot (the `-c` model prefetch:
// argv is `-c <code> <repo> <revision>`), so the real installLaya runs end to end offline.
const PYTHON_SHIM = `#!/bin/sh
if [ "$1" = "-c" ]; then
  dir="$HF_HOME/hub/models--$(printf %s "$3" | sed 's#/#--#')/snapshots/$4"
  mkdir -p "$dir" && printf %s '${MODEL}' > "$dir/model.safetensors"
  exit 0
fi
while [ $# -gt 0 ]; do
  if [ "$1" = "--target" ]; then mkdir -p "$2"; : > "$2/laya_stub.py"; fi
  shift
done
`;

function runtimeFixture(over: { laya?: "managed" | "unsupported"; bundledMissing?: boolean } = {}): string {
  const root = join(mkdtempSync(join(tmpdir(), "chimera runtime ")), "Chimera Runtime");
  const exe = HOST_PLATFORM === "win32" ? ".exe" : "";
  const files = {
    driver: `cua/cua-driver${exe}`, node: HOST_PLATFORM === "win32" ? "node/node.exe" : "node/bin/node",
    cli: "node_modules/@playwright/mcp/cli.js", browser: `browser/chrome-headless-shell${exe}`,
    python: HOST_PLATFORM === "win32" ? "python/python.exe" : "python/bin/python3",
    wheel: "integrations/laya/laya-0.3.27-py3-none-any.whl", lock: "integrations/laya/requirements.lock",
  };
  writeFile(join(root, "runtime.json"), JSON.stringify({ version: "test", platform: HOST_PLATFORM, arch: HOST_ARCH }));
  if (!over.bundledMissing) {
    writeFile(join(root, files.driver)); writeFile(join(root, files.node)); writeFile(join(root, files.cli)); writeFile(join(root, files.browser));
  }
  writeFile(join(root, files.python), PYTHON_SHIM, 0o755);
  writeFile(join(root, files.wheel), WHEEL); writeFile(join(root, files.lock), LOCK);
  const laya = over.laya === "unsupported"
    ? { state: "unsupported-platform", reason: "fixture" }
    : { state: "managed-download", version: "0.3.27", python: files.python, wheel: files.wheel, wheelSha256: sha(WHEEL), lock: files.lock, lockSha256: sha(LOCK), checkpoint: CHECKPOINT, source: "https://example.test/laya" };
  writeFile(join(root, "integrations", "manifest.json"), JSON.stringify({
    schemaVersion: 1, platform: HOST_PLATFORM, arch: HOST_ARCH,
    integrations: {
      "chimera-desktop": { state: "bundled", version: "0.33.3", driver: files.driver, license: "MIT", source: "https://example.test/cua" },
      "chimera-browser": {
        state: "bundled", version: "0.0.83", node: files.node, cli: files.cli, executable: files.browser,
        browserVersion: "155.0.8059.12", browserSha256: SHA, browserSource: "https://example.test/cft", license: "Apache-2.0",
      },
      laya,
    },
  }));
  return root;
}

function engineOn(home: string, runtimeRoot: string | null | undefined) {
  const backends = new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]);
  return new Engine({ home, backends, mcpStoreDetectAuth: async () => ({ oauth: false }), ...(runtimeRoot === undefined ? {} : { runtimeRoot }) });
}

const stdio = (e: any) => e as { type: "stdio"; command: string; args: string[]; env: Record<string, string>; enabled: boolean; builtIn?: { id: string; version: string } };

describe("Engine built-in integrations", () => {
  it("registers the bundled built-ins on startup with absolute paths under the (spaced) runtime root only", () => {
    const home = makeEngineHome(), root = runtimeFixture();
    const engine = engineOn(home, root);
    const names = engine.mcpStore.list().map((e) => e.name).sort();
    // laya is a first-use download: not registered until its install completes.
    expect(names).toEqual(["chimera-browser", "chimera-desktop"]);
    for (const e of engine.mcpStore.list()) expect(stdio(e).builtIn).toMatchObject({ version: expect.any(String) });
    const raw = readFileSync(join(home, "mcpstore.json"), "utf8");
    expect(raw).toContain(root);
    expect(raw).not.toMatch(/\/Users\/nedim/);
    expect(stdio(engine.mcpStore.get("chimera-browser")).args.join(" ")).toContain("--isolated");
  });

  it("is idempotent across restarts and self-heals when the runtime is relocated", () => {
    const home = makeEngineHome(), a = runtimeFixture(), b = runtimeFixture();
    engineOn(home, a);
    const first = readFileSync(join(home, "mcpstore.json"), "utf8");
    engineOn(home, a);
    expect(readFileSync(join(home, "mcpstore.json"), "utf8")).toBe(first);
    const moved = engineOn(home, b);
    expect(stdio(moved.mcpStore.get("chimera-desktop")).command).toContain(b);
    expect(readFileSync(join(home, "mcpstore.json"), "utf8")).not.toContain(a);
  });

  it("registers nothing and reports unmanaged when there is no packaged runtime (dev checkout)", async () => {
    const engine = engineOn(makeEngineHome(), null);
    expect(engine.mcpStore.list()).toEqual([]);
    expect(await engine.handle("computerUse.builtins.status", {})).toEqual({ managed: false, integrations: [] });
    await expect(engine.handle("computerUse.builtins.install", { id: "laya" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("default root detection finds no runtime in a source checkout", async () => {
    const engine = engineOn(makeEngineHome(), undefined);
    expect(await engine.handle("computerUse.builtins.status", {})).toEqual({ managed: false, integrations: [] });
  });

  it("survives a corrupt manifest: warns, registers nothing and still starts", async () => {
    const root = runtimeFixture();
    writeFileSync(join(root, "integrations", "manifest.json"), "{ not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = engineOn(makeEngineHome(), root);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("built-in integrations unavailable"));
    warn.mockRestore();
    expect(engine.mcpStore.list()).toEqual([]);
  });

  it("status RPC returns schema-valid per-integration state, with laya honestly not-installed", async () => {
    const engine = engineOn(makeEngineHome(), runtimeFixture());
    const status = BuiltInsStatusResultSchema.parse(await engine.handle("computerUse.builtins.status", {}));
    expect(status.managed).toBe(true);
    expect(status.integrations.map((i) => [i.id, i.state, i.provisioning])).toEqual([
      ["laya", "not-installed", "managed-download"],
      ["chimera-browser", "ready", "bundled"],
      ["chimera-desktop", "ready", "bundled"],
    ]);
    expect(status.integrations[0]).toMatchObject({ modelAssets: "downloaded-on-first-use" });
  });

  it("reports a missing bundled file as unavailable instead of registering a broken entry", async () => {
    const engine = engineOn(makeEngineHome(), runtimeFixture({ bundledMissing: true }));
    expect(engine.mcpStore.list()).toEqual([]);
    const status = BuiltInsStatusResultSchema.parse(await engine.handle("computerUse.builtins.status", {}));
    expect(status.integrations.filter((i) => i.provisioning === "bundled").map((i) => i.state)).toEqual(["unavailable", "unavailable"]);
  });

  describe("provenance", () => {
    it("rejects a caller-supplied builtIn marker over RPC (forgery) and registers nothing", async () => {
      const engine = engineOn(makeEngineHome(), null);
      await expect(engine.handle("mcpstore.add", {
        name: "evil", type: "stdio", command: "/bin/sh", builtIn: { id: "laya", version: "0.3.27" },
      })).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("cannot be added over RPC") });
      expect(engine.mcpStore.has("evil")).toBe(false);
    });

    it("refuses to take over a built-in name with a custom add (conflict, entry untouched)", async () => {
      const engine = engineOn(makeEngineHome(), runtimeFixture());
      const before = JSON.stringify(engine.mcpStore.get("chimera-browser"));
      await expect(engine.handle("mcpstore.add", { name: "chimera-browser", type: "stdio", command: "node", args: ["x.js"], env: {} }))
        .rejects.toMatchObject({ code: "conflict" });
      expect(JSON.stringify(engine.mcpStore.get("chimera-browser"))).toBe(before);
    });

    it("refuses to uninstall a built-in but lets the user disable it, and the choice survives restart", async () => {
      const home = makeEngineHome(), root = runtimeFixture();
      const engine = engineOn(home, root);
      await expect(engine.handle("mcpstore.remove", { name: "chimera-desktop" }))
        .rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("disable it instead") });
      expect(engine.mcpStore.has("chimera-desktop")).toBe(true);

      await engine.handle("mcpstore.setEnabled", { name: "chimera-desktop", enabled: false });
      const restarted = engineOn(home, root);
      expect(restarted.mcpStore.get("chimera-desktop")).toMatchObject({ enabled: false, builtIn: { id: "chimera-desktop" } });
    });

    it("never overwrites a user's same-named custom entry and reports it as name-taken", async () => {
      const home = makeEngineHome();
      const first = engineOn(home, null);
      await first.handle("mcpstore.add", { name: "laya", type: "stdio", command: "/opt/mine/python", args: ["-m", "my.server"], env: { MINE: "1" } });
      const engine = engineOn(home, runtimeFixture());
      expect(engine.mcpStore.get("laya")).toMatchObject({ command: "/opt/mine/python", env: { MINE: "1" } });
      expect(stdio(engine.mcpStore.get("laya")).builtIn).toBeUndefined();
      // Real built-ins still register next to it.
      expect(engine.mcpStore.has("chimera-browser")).toBe(true);
    });

    it("keeps other user MCP entries byte-identical while built-ins register", async () => {
      const home = makeEngineHome();
      const first = engineOn(home, null);
      await first.handle("mcpstore.add", { name: "my-tool", type: "stdio", command: "node", args: ["a.js"], env: { K: "v" } });
      const before = JSON.stringify(first.mcpStore.get("my-tool"));
      const engine = engineOn(home, runtimeFixture());
      expect(JSON.stringify(engine.mcpStore.get("my-tool"))).toBe(before);
    });
  });

  describe.skipIf(!canRunShim)("laya first-use install RPC", () => {
    it("runs the real installer against the bundled python, then registers laya and reports ready", async () => {
      const home = makeEngineHome(), root = runtimeFixture();
      const engine = engineOn(home, root);
      expect(engine.mcpStore.has("laya")).toBe(false);

      expect(await engine.handle("computerUse.builtins.install", { id: "laya" })).toEqual({ started: true });
      const installing = BuiltInsStatusResultSchema.parse(await engine.handle("computerUse.builtins.status", {}));
      expect(installing.integrations[0]).toMatchObject({ id: "laya", state: "installing" });

      await layaInstallIdle({ home, ctx: loadBuiltInContext(root) });
      const ready = BuiltInsStatusResultSchema.parse(await engine.handle("computerUse.builtins.status", {}));
      expect(ready.integrations[0]).toMatchObject({ id: "laya", state: "ready", version: "0.3.27" });
      const laya = stdio(engine.mcpStore.get("laya"));
      expect(laya.builtIn).toMatchObject({ id: "laya", version: "0.3.27" });
      expect(laya.env.PYTHONPATH).toContain(join(home, "integrations", "laya-0.3.27", "site"));
      expect(laya.env.PYTHONDONTWRITEBYTECODE).toBe("1");
      // The first-use load is pinned: the registered entry cannot follow mutable Hub main.
      expect(laya.env).toMatchObject({
        LAYA_REVISION: CHECKPOINT.revision, LAYA_SHA256_DIGESTS: JSON.stringify(CHECKPOINT.files), HF_HUB_OFFLINE: "1",
      });
      expect(JSON.parse(readFileSync(join(home, "integrations", "laya-0.3.27", "ready.json"), "utf8")).checkpoint).toEqual(CHECKPOINT);
      expect(readFileSync(join(home, "mcpstore.json"), "utf8")).not.toMatch(/\/Users\/nedim/);

      // A restart keeps it registered and byte-identical.
      const snapshot = readFileSync(join(home, "mcpstore.json"), "utf8");
      engineOn(home, root);
      expect(readFileSync(join(home, "mcpstore.json"), "utf8")).toBe(snapshot);
    });

    it("rejects invalid install params and an install where laya is unsupported", async () => {
      const engine = engineOn(makeEngineHome(), runtimeFixture());
      await expect(engine.handle("computerUse.builtins.install", { id: "chimera-browser" })).rejects.toMatchObject({ code: "protocol" });
      const noLaya = engineOn(makeEngineHome(), runtimeFixture({ laya: "unsupported" }));
      await expect(noLaya.handle("computerUse.builtins.install", { id: "laya" })).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("not available") });
    });
  });

  describe("legacy migration rollback RPC", () => {
    // What scripts/setup-computer-use.ts registered before built-ins existed: an unmarked entry whose
    // driver lives under the developer's own integrations dir.
    const legacy = (home: string) => {
      const { name, ...spec } = desktopEntry({ home, driver: join(home, "integrations", "cua", "cua-driver") });
      new McpStoreRegistry(home).add({ name, ...spec });
      return spec;
    };

    it("migrates a legacy registration, restores the user's original on rollback, and does not migrate it again", async () => {
      const home = makeEngineHome(), root = runtimeFixture();
      const original = legacy(home);
      const engine = engineOn(home, root);
      expect(stdio(engine.mcpStore.get("chimera-desktop")).builtIn).toMatchObject({ id: "chimera-desktop" });

      expect(await engine.handle("computerUse.builtins.rollback", {})).toEqual({ restored: ["chimera-desktop"] });
      expect(engine.mcpStore.get("chimera-desktop")).toMatchObject({ command: original.command, args: original.args });
      expect(stdio(engine.mcpStore.get("chimera-desktop")).builtIn).toBeUndefined();
      expect(await engine.handle("computerUse.builtins.rollback", {})).toEqual({ restored: [] });

      const restarted = engineOn(home, root);
      expect(stdio(restarted.mcpStore.get("chimera-desktop")).builtIn).toBeUndefined();
      expect(stdio(restarted.mcpStore.get("chimera-desktop")).command).toBe(original.command);
    });

    it("refuses without a packaged runtime and when the backup is unreadable", async () => {
      await expect(engineOn(makeEngineHome(), null).handle("computerUse.builtins.rollback", {})).rejects.toMatchObject({ code: "protocol" });
      const home = makeEngineHome(), root = runtimeFixture();
      legacy(home);
      const engine = engineOn(home, root);
      writeFileSync(join(home, "computer-use", "reconcile-backup.json"), "not json");
      await expect(engine.handle("computerUse.builtins.rollback", {})).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("unreadable") });
    });
  });
});
