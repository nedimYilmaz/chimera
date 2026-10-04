import { lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { McpStoreEntrySchema, type McpStoreEntry, type McpStoreServerSpec } from "@chimera/protocol";

export type ComputerUseOptions = {
  home: string; node: string; layaPython: string; playwrightCli: string;
  browserExecutable?: string; desktopDriver?: string; platform?: NodeJS.Platform;
};
export function desktopSocket(home: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `\\\\.\\pipe\\chimera-computer-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`
    : join(home, "computer-use", "desktop.sock");
}

// These are tool adapters, not provider backends: both Claude and Codex discover the
// same installed tools through their existing Chimera MCP grant.
export function computerUseEntries(opts: ComputerUseOptions): McpStoreEntry[] {
  for (const path of [opts.home, opts.node, opts.layaPython, opts.playwrightCli, opts.browserExecutable, opts.desktopDriver]) {
    if (path !== undefined && !isAbsolute(path)) throw new Error(`Computer Use paths must be absolute: ${path}`);
  }
  const entries: unknown[] = [
    { name: "laya", command: opts.layaPython, args: ["-m", "laya.mcp.server"], env: { LAYA_PRELOAD: "0", LAYA_THREADS: "4" }, sessionMode: "shared" },
    { name: "chimera-browser", command: opts.node, args: [opts.playwrightCli, "--isolated", "--headless", "--caps", "vision", ...(opts.browserExecutable ? ["--executable-path", opts.browserExecutable] : [])], sessionMode: "agent" },
  ];
  if (opts.desktopDriver) entries.push({ name: "chimera-desktop", command: opts.desktopDriver,
    args: ["mcp", "--embedded", "--socket", desktopSocket(opts.home, opts.platform)],
    env: { CUA_DRIVER_EMBEDDED: "1" }, sessionMode: "exclusive" });
  return entries.map(entry => McpStoreEntrySchema.parse(entry));
}

// The daemon only runs `cua-driver mcp --embedded --socket ...`, a stdio PROXY to a service the
// Chimera app owns (computer_use.rs: spawn, prefs, "Stop desktop control"). When that service is
// down the proxy exits during `initialize` and the SDK reports only "MCP error -32000: Connection
// closed". Recognise the built-in entry by identity (name + shape + the socket THIS home would
// have been registered with) so a custom `chimera-desktop` pointing elsewhere is never annotated.
export function isBuiltInDesktopEntry(name: string, spec: McpStoreServerSpec, home: string, platform: NodeJS.Platform = process.platform): boolean {
  if (name !== "chimera-desktop" || spec.type !== "stdio" || spec.sessionMode !== "exclusive" || !spec.args.includes("--embedded")) return false;
  const at = spec.args.indexOf("--socket");
  return at >= 0 && spec.args[at + 1] === desktopSocket(home, platform);
}

type FileRead = { kind: "absent" | "denied" | "malformed" } | { kind: "ok"; value: unknown };
function readJsonFile(path: string): FileRead {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (err) { return { kind: (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "denied" }; }
  try { return { kind: "ok", value: JSON.parse(text) }; } catch { return { kind: "malformed" }; }
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const SETTINGS = "Chimera Settings > MCP > Chimera Computer Use";

// Read-only evidence about why the desktop service is unreachable, in the order an operator can
// act on it: missing setup -> operator-disabled -> service simply not running. It reads the same
// files the app writes (desktop.json / preferences.json) and stats the socket; it never opens the
// socket, never launches anything and never writes, so it cannot re-enable a service the operator
// stopped. Returns undefined whenever the files do not PROVE a cause (e.g. unreadable, or the
// socket exists and the preference is on) -- the caller then keeps the original error verbatim.
export function desktopHostGuidance(home: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const dir = join(home, "computer-use");
  const setup = readJsonFile(join(dir, "desktop.json"));
  if (setup.kind === "denied") return undefined;
  if (setup.kind === "absent") {
    return `Chimera desktop control is not set up on this machine (no computer-use/desktop.json). Install the Computer Use integration in ${SETTINGS}, then retry.`;
  }
  const driverPath = setup.kind === "ok" && isRecord(setup.value) ? setup.value["driverPath"] : undefined;
  if (typeof driverPath !== "string" || !isAbsolute(driverPath)) {
    return `Chimera desktop control setup is invalid (computer-use/desktop.json). Run the Computer Use setup again in ${SETTINGS}, then retry.`;
  }
  try {
    if (!statSync(driverPath).isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    return `The Chimera desktop control runtime is missing (${driverPath}). Run the Computer Use setup again in ${SETTINGS}, then retry.`;
  }

  const prefs = readJsonFile(join(dir, "preferences.json"));
  if (prefs.kind === "denied") return undefined;
  if (prefs.kind === "malformed" || (prefs.kind === "ok" && !(isRecord(prefs.value) && typeof prefs.value["enabled"] === "boolean"))) {
    return `Chimera desktop control's on/off preference (computer-use/preferences.json) is unreadable, so its state is unknown. Check "Start desktop control" in ${SETTINGS}, then retry.`;
  }
  if (prefs.kind === "ok" && (prefs.value as { enabled: boolean }).enabled === false) {
    return `Chimera desktop control is turned off (computer-use/preferences.json has enabled:false). Use "Start desktop control" in ${SETTINGS} to enable it, then retry.`;
  }
  // A Windows named pipe is not reliably stat-able, so "no socket" is only provable on Unix.
  if (platform === "win32") return undefined;
  try { lstatSync(desktopSocket(home, platform)); return undefined; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    return `The Chimera desktop service is not running right now (no computer-use/desktop.sock); it is hosted by the Chimera app, so it may be closed or still starting. Open Chimera and make sure "Start desktop control" is on in ${SETTINGS}, then retry.`;
  }
}
