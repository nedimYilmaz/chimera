import { lstatSync, readFileSync, statSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { McpStoreEntrySchema, type McpBuiltIn, type McpStoreEntry, type McpStoreServerSpec } from "@chimera/protocol";

export type ComputerUseOptions = {
  home: string; node: string; layaPython: string; playwrightCli: string;
  browserExecutable?: string; desktopDriver?: string; platform?: NodeJS.Platform;
};
export function desktopSocket(home: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `\\\\.\\pipe\\chimera-computer-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`
    : join(home, "computer-use", "desktop.sock");
}

// A manifest or fixture for another OS must be validated with THAT OS's path rules, not the build
// host's: "C:\\x" is absolute on Windows and relative on POSIX, and a fixture test on macOS has to
// be able to prove the Windows/Linux shapes without running there.
const pathRules = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);
function assertAbsolute(platform: NodeJS.Platform, ...paths: (string | undefined)[]): void {
  for (const path of paths) {
    if (path !== undefined && !pathRules(platform).isAbsolute(path)) throw new Error(`Computer Use paths must be absolute: ${path}`);
  }
}

type EntryBase = { home: string; platform?: NodeJS.Platform; env?: Record<string, string>; builtIn?: McpBuiltIn };
const withBuiltIn = (entry: Record<string, unknown>, builtIn: McpBuiltIn | undefined): McpStoreEntry =>
  McpStoreEntrySchema.parse(builtIn ? { ...entry, builtIn } : entry);

// A reviewed model checkpoint. The wheel carries no weights, so without these env vars Laya fetches
// whatever the Hub's mutable `main` is at first use. `revision` is a full commit SHA (never the
// symbolic `reviewed`, which resolves from the installed package's own table and would silently move
// with a Laya upgrade) and `files` is Laya's FLAT digest shape, verified against each checkpoint's own
// directory after download and before any weight is parsed.
export const LayaCheckpointSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.record(z.string().regex(/^[\w.-]+$/).refine((name) => name !== "." && name !== "..", "must be a plain file name"), z.string().regex(/^[a-f0-9]{64}$/))
    .refine((files) => "model.safetensors" in files, "must pin model.safetensors"),
}).strict();
export type LayaCheckpoint = z.infer<typeof LayaCheckpointSchema>;

// The env that makes a pinned entry unable to reach anything but the reviewed English checkpoint:
//  - LAYA_REVISION + flat LAYA_SHA256_DIGESTS: the revision and bytes Laya will accept;
//  - HF_HUB_OFFLINE=1: nothing is fetched at first use. The install step downloaded and verified the
//    English checkpoint once; every other checkpoint Laya's router can pick (multilingual,
//    typed-decisions) was never evaluated and has no Chimera-reviewed digest, so it must fail to load
//    rather than be fetched from mutable main (a flat digest would also refuse it, but only AFTER a
//    ~680 MB download);
//  - LAYA_MODELS/LAYA_DEFAULT_MODEL: documentation of intent only -- LAYA_MODELS is a preload list,
//    not a routing restriction, so offline mode is the actual enforcement.
// These are applied AFTER the caller's env so no caller can weaken the pin.
export function layaCheckpointEnv(checkpoint: LayaCheckpoint): Record<string, string> {
  const pin = LayaCheckpointSchema.parse(checkpoint);
  return {
    LAYA_REVISION: pin.revision, LAYA_SHA256_DIGESTS: JSON.stringify(pin.files),
    HF_HUB_OFFLINE: "1", LAYA_MODELS: "english", LAYA_DEFAULT_MODEL: "english",
  };
}

// One builder per adapter so the app-bundled registration (builtin-integrations.ts) and the legacy
// dev registrar compose the exact same entry shapes -- the session modes are the security contract
// (laya shared, browser per-agent, desktop exclusive) and must not be restated in two places.
export function layaEntry(o: EntryBase & { python: string; checkpoint?: LayaCheckpoint }): McpStoreEntry {
  assertAbsolute(o.platform ?? process.platform, o.home, o.python);
  const env = { LAYA_PRELOAD: "0", LAYA_THREADS: "4", ...o.env, ...(o.checkpoint ? layaCheckpointEnv(o.checkpoint) : {}) };
  return withBuiltIn({ name: "laya", command: o.python, args: ["-m", "laya.mcp.server"], env, sessionMode: "shared" }, o.builtIn);
}
export function browserEntry(o: EntryBase & { node: string; cli: string; executable?: string }): McpStoreEntry {
  assertAbsolute(o.platform ?? process.platform, o.home, o.node, o.cli, o.executable);
  return withBuiltIn({
    name: "chimera-browser", command: o.node,
    args: [o.cli, "--isolated", "--headless", "--caps", "vision", ...(o.executable ? ["--executable-path", o.executable] : [])],
    ...(o.env && Object.keys(o.env).length > 0 ? { env: o.env } : {}), sessionMode: "agent",
  }, o.builtIn);
}
export function desktopEntry(o: EntryBase & { driver: string }): McpStoreEntry {
  const platform = o.platform ?? process.platform;
  assertAbsolute(platform, o.home, o.driver);
  return withBuiltIn({
    name: "chimera-desktop", command: o.driver, args: ["mcp", "--embedded", "--socket", desktopSocket(o.home, platform)],
    env: { CUA_DRIVER_EMBEDDED: "1", ...o.env }, sessionMode: "exclusive",
  }, o.builtIn);
}

// These are tool adapters, not provider backends: both Claude and Codex discover the
// same installed tools through their existing Chimera MCP grant.
export function computerUseEntries(opts: ComputerUseOptions): McpStoreEntry[] {
  const base = { home: opts.home, platform: opts.platform };
  const entries = [
    layaEntry({ ...base, python: opts.layaPython }),
    browserEntry({ ...base, node: opts.node, cli: opts.playwrightCli, executable: opts.browserExecutable }),
  ];
  if (opts.desktopDriver) entries.push(desktopEntry({ ...base, driver: opts.desktopDriver }));
  return entries;
}

// The daemon only runs `cua-driver mcp --embedded --socket ...`, a stdio PROXY to a service the
// Chimera app owns (computer_use.rs: spawn, prefs, "Stop desktop control"). When that service is
// down the proxy exits during `initialize` and the SDK reports only "MCP error -32000: Connection
// closed". Recognise the built-in entry by its daemon-stamped provenance marker, or -- for an entry
// the legacy registrar wrote before the marker existed -- by identity (name + shape + the socket
// THIS home would have been registered with), so a custom `chimera-desktop` pointing elsewhere is
// never annotated.
export function isBuiltInDesktopEntry(name: string, spec: McpStoreServerSpec, home: string, platform: NodeJS.Platform = process.platform): boolean {
  if (name !== "chimera-desktop" || spec.type !== "stdio") return false;
  if (spec.builtIn?.id === "chimera-desktop") return true;
  if (spec.sessionMode !== "exclusive" || !spec.args.includes("--embedded")) return false;
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
//
// `bundledDriver` is the driver a built-in entry points at. The app derives the same path from the
// runtime manifest when desktop.json is absent (desktop.json is only an explicit override), so
// "no desktop.json" is then normal and the bundled driver is what must exist.
export function desktopHostGuidance(home: string, platform: NodeJS.Platform = process.platform, bundledDriver?: string): string | undefined {
  const dir = join(home, "computer-use");
  const setup = readJsonFile(join(dir, "desktop.json"));
  if (setup.kind === "denied") return undefined;
  let driverPath: unknown = setup.kind === "ok" && isRecord(setup.value) ? setup.value["driverPath"] : undefined;
  let bundled = false;
  if (setup.kind === "absent") {
    if (bundledDriver === undefined) {
      return `Chimera desktop control is not set up on this machine (no computer-use/desktop.json). Install the Computer Use integration in ${SETTINGS}, then retry.`;
    }
    driverPath = bundledDriver;
    bundled = true;
  }
  if (typeof driverPath !== "string" || !pathRules(platform).isAbsolute(driverPath)) {
    return `Chimera desktop control setup is invalid (computer-use/desktop.json). Run the Computer Use setup again in ${SETTINGS}, then retry.`;
  }
  try {
    if (!statSync(driverPath).isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    return bundled
      ? `The desktop control runtime bundled with Chimera is missing (${driverPath}). Reinstall Chimera to restore it, then retry.`
      : `The Chimera desktop control runtime is missing (${driverPath}). Run the Computer Use setup again in ${SETTINGS}, then retry.`;
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
