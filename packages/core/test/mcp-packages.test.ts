import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpPackageInstaller, managedProcessEnv } from "@chimera/core/mcp-packages";
import { McpStoreRegistry } from "@chimera/core/mcpstore";
import { McpPackageInspectParams } from "@chimera/protocol";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const manifest = { name: "@test/mcp", version: "1.2.3", bin: { "test-mcp": "dist/main.js" }, dist: { integrity, tarball: "https://registry.npmjs.org/@test/mcp/-/mcp-1.2.3.tgz" } };
function fixture(options: { manifest?: unknown; lock?: (lock: any) => void; afterInstall?: (cwd: string) => void; fail?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "chimera-managed-mcp-")); homes.push(home);
  const registry = new McpStoreRegistry(home);
  const run = vi.fn(async (args: string[], cwd: string) => {
    if (options.fail) throw new Error("raw npm failure with confidential env");
    if (args[0] === "install") {
      const lock = { lockfileVersion: 3, packages: { "": {}, "node_modules/@test/mcp": { version: manifest.version, resolved: manifest.dist.tarball, integrity } } };
      options.lock?.(lock);
      writeFileSync(join(cwd, "package-lock.json"), JSON.stringify(lock));
    } else {
      const pkg = join(cwd, "node_modules/@test/mcp");
      mkdirSync(join(pkg, "dist"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));
      writeFileSync(join(pkg, "dist/main.js"), "// fixture; never executed\n");
      options.afterInstall?.(cwd);
    }
  });
  let now = Date.now();
  const installer = new McpPackageInstaller(registry, home, {
    manifest: async () => options.manifest ?? structuredClone(manifest), run,
    runtime: () => ({ node: process.execPath, cli: "fixture-npm-cli.js" }), now: () => now,
  });
  return { home, registry, installer, run, advance: () => { now += 600_001; } };
}
const query = { packageName: manifest.name, version: manifest.version };

describe("managed MCP package installation", () => {
  it.each(["latest", "^1.2.3", "file:/tmp/foo", "1.2", "1.2.3;whoami"])("rejects non-exact version %s", (version) => {
    expect(McpPackageInspectParams.safeParse({ ...query, version }).success).toBe(false);
  });
  it.each(["https://host/pkg", "../pkg", "--registry", "x;whoami", "@scope/../x"])("rejects non-package spec %s", (packageName) => {
    expect(McpPackageInspectParams.safeParse({ ...query, packageName }).success).toBe(false);
  });
  it("inspection never installs or enables anything; scripts are visibly flagged", async () => {
    const f = fixture({ manifest: { ...manifest, scripts: { postinstall: "do-something" } } });
    const review = await f.installer.inspect(query);
    expect(review).toMatchObject({ packageName: manifest.name, version: "1.2.3", bins: ["test-mcp"], hasInstallScripts: true });
    expect(f.run).not.toHaveBeenCalled(); expect(f.registry.list()).toEqual([]);
  });
  it("pins integrity, skips scripts, commits a disabled shared entry and survives restart", async () => {
    const f = fixture(); const review = await f.installer.inspect(query);
    const entry = await f.installer.install({ reviewId: review.reviewId, name: "test", bin: "test-mcp", args: ["/chosen/path"] });
    expect(entry).toMatchObject({ type: "stdio", enabled: false, trust: "untrusted", direct: false, env: {}, managed: { ecosystem: "npm", packageName: manifest.name, integrity } });
    expect(f.run).toHaveBeenCalledTimes(2);
    for (const [args, cwd] of f.run.mock.calls) {
      expect(args).toContain("--ignore-scripts"); expect(args).toContain("--no-audit");
      expect(args).toContain("--userconfig"); expect(args).toContain("--globalconfig");
      expect(cwd.startsWith(join(f.home, "mcp-packages"))).toBe(true);
    }
    expect(new McpStoreRegistry(f.home).get("test")).toMatchObject({ enabled: false, managed: { version: "1.2.3" } });
    if (entry.type !== "stdio") throw new Error("stdio expected");
    expect(readFileSync(entry.args[0]!, "utf8")).toContain("never executed");
    expect(entry.args[1]).toBe("/chosen/path");
    await expect(f.installer.install({ reviewId: review.reviewId, name: "another", bin: "test-mcp" })).rejects.toThrow(/expired/);
  });
  it("refuses expired reviews and unknown binaries before invoking npm", async () => {
    const f = fixture(); const r = await f.installer.inspect(query);
    await expect(f.installer.install({ reviewId: r.reviewId, name: "test", bin: "other" })).rejects.toThrow(/executable/);
    f.advance();
    await expect(f.installer.install({ reviewId: r.reviewId, name: "test", bin: "test-mcp" })).rejects.toThrow(/expired/);
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each(["../escape.js", "/etc/test.js", "C:\\foo.js", "file:code.js"])("rejects executable traversal %s", async (bin) => {
    const f = fixture({ manifest: { ...manifest, bin: { test: bin } } });
    await expect(f.installer.inspect(query)).rejects.toThrow(/unsafe/);
  });
  it("rejects a changed reviewed integrity before downloading/installing", async () => {
    const f = fixture({ lock: (lock) => { lock.packages["node_modules/@test/mcp"].integrity = "changed"; } });
    const r = await f.installer.inspect(query);
    await expect(f.installer.install({ reviewId: r.reviewId, name: "test", bin: "test-mcp" })).rejects.toThrow(/integrity/);
    expect(f.run).toHaveBeenCalledTimes(1); expect(f.registry.list()).toEqual([]);
  });
  it.each(["file:/private/data", "git+https://host/repo", "https://elsewhere.test/pkg.tgz"])("rejects non-registry dependency %s", async (resolved) => {
    const f = fixture({ lock: (lock) => { lock.packages["node_modules/dep"] = { resolved, integrity }; } });
    const r = await f.installer.inspect(query);
    await expect(f.installer.install({ reviewId: r.reviewId, name: "test", bin: "test-mcp" })).rejects.toThrow(/public npm/);
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it("does not follow executable symlinks out of the package", async () => {
    const f = fixture({ afterInstall: (cwd) => {
      const bin = join(cwd, "node_modules/@test/mcp/dist/main.js");
      rmSync(bin); symlinkSync(join(cwd, "package.json"), bin);
    } });
    const r = await f.installer.inspect(query);
    await expect(f.installer.install({ reviewId: r.reviewId, name: "test", bin: "test-mcp" })).rejects.toThrow(/escapes/);
    expect(f.registry.list()).toEqual([]);
  });
  it("does not leak npm error text and retains failed files for recovery", async () => {
    const f = fixture({ fail: true }); const r = await f.installer.inspect(query);
    await expect(f.installer.install({ reviewId: r.reviewId, name: "test", bin: "test-mcp" })).rejects.toThrow(/No server was enabled/);
    expect(f.registry.list()).toEqual([]);
    expect(readdirSync(f.installer.root).some((n) => n.startsWith(".failed-"))).toBe(true);
  });
  it("rejects a duplicate name and simultaneous installs", async () => {
    const f = fixture(); const r = await f.installer.inspect(query);
    const first = f.installer.install({ reviewId: r.reviewId, name: "test", bin: "test-mcp" });
    await expect(f.installer.install({ reviewId: r.reviewId, name: "other", bin: "test-mcp" })).rejects.toThrow(/in progress/);
    await first;
    const next = await f.installer.inspect(query);
    await expect(f.installer.install({ reviewId: next.reviewId, name: "test", bin: "test-mcp" })).rejects.toThrow(/already uses/);
  });
  it("uninstall moves only its owned installation and is recoverable", async () => {
    const f = fixture(); const r = await f.installer.inspect(query);
    const entry = await f.installer.install({ reviewId: r.reviewId, name: "test", bin: "test-mcp" });
    writeFileSync(join(f.home, "unrelated.txt"), "keep");
    expect(() => f.installer.quarantine({ ...entry, name: "another-server" })).toThrow(/ownership/);
    f.installer.quarantine(entry);
    expect(readdirSync(f.installer.root).some((n) => n.startsWith(".removed-"))).toBe(true);
    expect(readFileSync(join(f.home, "unrelated.txt"), "utf8")).toBe("keep");
  });
  it("a failed registry persistence does not publish an in-memory server", () => {
    const f = fixture();
    mkdirSync(join(f.home, "mcpstore.json")); // force the final atomic rename to fail
    expect(() => f.registry.add({ name: "test", type: "stdio", command: "node", args: [], env: {}, enabled: true, direct: false, trust: "full" })).toThrow();
    expect(f.registry.has("test")).toBe(false);
  });
  it("never inherits provider tokens, npm settings or Node injection variables", () => {
    expect(managedProcessEnv({ PATH: "/bin", SystemRoot: "C:\\Windows", OPENAI_API_KEY: "secret", NODE_OPTIONS: "--require=bad", npm_config_registry: "bad", CHIMERA_AGENT_ID: "agent" }))
      .toEqual({ PATH: "/bin", SystemRoot: "C:\\Windows" });
  });
});
