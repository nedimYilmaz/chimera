import { describe, it, expect } from "vitest";
import { computerUseEntries, desktopSocket } from "../src/computer-use.js";

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
