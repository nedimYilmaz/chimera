import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStoreEntrySchema, type McpStoreEntry, type McpStoreServerSpec } from "@chimera/protocol";
import { browserEntry, computerUseEntries, desktopEntry, desktopHostGuidance, desktopSocket, isBuiltInDesktopEntry, layaEntry } from "../src/computer-use.js";

describe("Chimera Computer Use presets", () => {
  it("shares only Laya, isolates browsers and proxies desktop to the app-owned runtime", () => {
    const entries = computerUseEntries({ home: "/home/operator/.chimera", node: "/bin/node", layaPython: "/laya/bin/python", playwrightCli: "/playwright/cli.js", desktopDriver: "/desktop/driver" });
    expect(entries.map(e => [e.name, e.sessionMode])).toEqual([["laya", "shared"], ["chimera-browser", "agent"], ["chimera-desktop", "exclusive"]]);
    const desktop = entries[2]!;
    expect(desktop.type).toBe("stdio");
    if (desktop.type === "stdio") {
      expect(desktop.args).toEqual(["mcp", "--embedded", "--socket", "/home/operator/.chimera/computer-use/desktop.sock"]);
      expect(desktop.args).not.toContain("serve");
      expect(desktop.env.CUA_DRIVER_EMBEDDED).toBe("1");
    }
    expect(entries.every(e => e.enabled && !e.direct)).toBe(true);
  });
  it("supports browser-only setup without implicitly starting desktop control", () => {
    const entries = computerUseEntries({ home: "/h", node: "/n", layaPython: "/p", playwrightCli: "/pw" });
    expect(entries).toHaveLength(2);
    expect(() => computerUseEntries({ home: "/h", node: "node", layaPython: "/p", playwrightCli: "/pw" })).toThrow(/absolute/);
  });
  it.each(["layaPython", "playwrightCli", "desktopDriver", "home"] as const)("rejects a relative %s before building any entry", key => {
    const opts = { home: "/h", node: "/n", layaPython: "/p", playwrightCli: "/pw", desktopDriver: "/d", [key]: "relative/path" };
    expect(() => computerUseEntries(opts)).toThrow("Computer Use paths must be absolute: relative/path");
  });
  it("Windows endpoints are named pipes scoped to the Chimera home", () => {
    const a = desktopSocket("C:\\Users\\a\\.chimera", "win32");
    expect(a.startsWith("\\\\.\\pipe\\chimera-computer-")).toBe(true);
    expect(a).not.toBe(desktopSocket("C:\\Users\\b\\.chimera", "win32"));
  });
});

describe("built-in provenance on the entry builders", () => {
  const builtIn = { id: "chimera-browser", version: "0.0.83" } as const;

  it("stamps the marker only when asked and keeps the per-adapter session contract", () => {
    const home = "/h/.chimera";
    const plain = browserEntry({ home, node: "/n/node", cli: "/n/cli.js" });
    expect("builtIn" in plain).toBe(false);
    const stamped = browserEntry({ home, node: "/n/node", cli: "/n/cli.js", executable: "/b/chrome", builtIn });
    expect(stamped).toMatchObject({ sessionMode: "agent", builtIn });
    expect(stamped.type === "stdio" && stamped.args).toEqual(expect.arrayContaining(["--isolated", "--executable-path", "/b/chrome"]));
    expect(layaEntry({ home, python: "/p", builtIn: { id: "laya", version: "0.3.27" } })).toMatchObject({ sessionMode: "shared" });
    expect(desktopEntry({ home, driver: "/d", builtIn: { id: "chimera-desktop", version: "0.33.3" } })).toMatchObject({ sessionMode: "exclusive" });
  });

  it("validates paths against the TARGET platform so Windows/Linux manifests are provable on any host", () => {
    const win = desktopEntry({ home: "C:\\Users\\a\\.chimera", driver: "C:\\Program Files\\Chimera\\runtime\\cua\\cua-driver.exe", platform: "win32" });
    expect(win.type === "stdio" && win.args.at(-1)).toMatch(/^\\\\\.\\pipe\\chimera-computer-/);
    expect(() => desktopEntry({ home: "/h", driver: "C:\\x\\cua-driver.exe", platform: "linux" })).toThrow(/absolute/);
    expect(() => desktopEntry({ home: "C:\\h", driver: "cua-driver.exe", platform: "win32" })).toThrow(/absolute/);
  });

  it("lets a built-in carry extra env (telemetry off) without dropping the embedded flag", () => {
    const e = desktopEntry({ home: "/h", driver: "/d", env: { DO_NOT_TRACK: "1" } });
    expect(e.type === "stdio" && e.env).toEqual({ CUA_DRIVER_EMBEDDED: "1", DO_NOT_TRACK: "1" });
  });
});

describe("isBuiltInDesktopEntry", () => {
  const home = "/h/.chimera";
  const spec = (over: Record<string, unknown> = {}) =>
    McpStoreEntrySchema.parse({ name: "chimera-desktop", command: "/d", args: ["mcp", "--embedded", "--socket", desktopSocket(home)], sessionMode: "exclusive", ...over });
  const asSpec = (e: McpStoreEntry): McpStoreServerSpec => { const { name: _n, ...rest } = e; return rest as McpStoreServerSpec; };

  it("trusts the daemon-stamped marker", () => {
    expect(isBuiltInDesktopEntry("chimera-desktop", asSpec(spec({ builtIn: { id: "chimera-desktop", version: "0.33.3" }, args: ["mcp"] })), home)).toBe(true);
  });
  it("recognises the pre-marker registration only when it points at THIS home's socket", () => {
    expect(isBuiltInDesktopEntry("chimera-desktop", asSpec(spec()), home)).toBe(true);
    expect(isBuiltInDesktopEntry("chimera-desktop", asSpec(spec()), "/other/home")).toBe(false);
  });
  it("never claims a custom entry that merely reuses the name or the wrong marker id", () => {
    expect(isBuiltInDesktopEntry("chimera-desktop", asSpec(spec({ args: ["mcp"], sessionMode: "shared" })), home)).toBe(false);
    expect(isBuiltInDesktopEntry("chimera-desktop", asSpec(spec({ args: ["x"], builtIn: { id: "laya", version: "1" } })), home)).toBe(false);
    expect(isBuiltInDesktopEntry("other", asSpec(spec()), home)).toBe(false);
  });
});

describe("desktopHostGuidance with a bundled driver", () => {
  const fresh = () => mkdtempSync(join(tmpdir(), "chimera-guidance-"));
  const cu = (home: string) => { mkdirSync(join(home, "computer-use"), { recursive: true }); return join(home, "computer-use"); };

  it("without a bundled driver, a missing desktop.json still means 'not set up'", () => {
    expect(desktopHostGuidance(fresh(), "darwin")).toMatch(/not set up/);
  });
  it("with a bundled driver, a missing desktop.json is normal and a missing driver says reinstall", () => {
    const home = fresh();
    expect(desktopHostGuidance(home, "darwin", join(home, "gone", "cua-driver"))).toMatch(/bundled with Chimera is missing.*Reinstall Chimera/);
  });
  it("with the bundled driver present, a missing socket means the app host is not running", () => {
    const home = fresh();
    const driver = join(home, "cua-driver");
    writeFileSync(driver, "");
    expect(desktopHostGuidance(home, "darwin", driver)).toMatch(/not running right now/);
  });
  it("honours the operator's off switch before blaming the socket", () => {
    const home = fresh();
    const driver = join(home, "cua-driver");
    writeFileSync(driver, "");
    writeFileSync(join(cu(home), "preferences.json"), JSON.stringify({ enabled: false }));
    expect(desktopHostGuidance(home, "darwin", driver)).toMatch(/turned off/);
  });
  it("an explicit desktop.json overrides the bundled driver (and its own missing driver is the old setup hint)", () => {
    const home = fresh();
    writeFileSync(join(cu(home), "desktop.json"), JSON.stringify({ driverPath: join(home, "custom-driver"), socketPath: "/x" }));
    expect(desktopHostGuidance(home, "darwin", join(home, "bundled"))).toMatch(/Run the Computer Use setup again/);
  });
  it("proves nothing (keeps the original error) when the driver exists, prefs are on and a socket is present", () => {
    const home = fresh();
    const driver = join(home, "cua-driver");
    writeFileSync(driver, "");
    // Place a real file at the socket path: lstat succeeds, so no cause is provable.
    writeFileSync(join(cu(home), "desktop.sock"), "");
    expect(desktopHostGuidance(home, "darwin", driver)).toBeUndefined();
  });
});
