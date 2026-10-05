/**
 * Register already-installed runtimes without restarting Chimera or modifying provider configs.
 *
 * Source-checkout / development path only. An installed Chimera ships these three as built-in
 * integrations (packages/core/src/builtin-integrations.ts) and needs no setup; a name the built-in
 * already owns is therefore left alone here instead of being treated as a conflict.
 */
import { parseArgs } from "node:util";
import { access, mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ChimeraClient } from "../packages/client/src/client.js";
import { chimeraHome } from "../packages/core/src/paths.js";
import { computerUseEntries, desktopSocket } from "../packages/core/src/computer-use.js";

const { values } = parseArgs({ options: {
  "laya-python": { type: "string" }, "playwright-cli": { type: "string" },
  "browser-executable": { type: "string" }, "desktop-driver": { type: "string" },
  "write-config": { type: "boolean" },
} });
if (!values["laya-python"] || !values["playwright-cli"]) throw new Error("Usage: node --import tsx scripts/setup-computer-use.ts --laya-python /path/to/python --playwright-cli /path/to/cli.js [--browser-executable /path/to/chrome] [--desktop-driver /path/to/driver] [--write-config]");
const home = chimeraHome();
const entries = computerUseEntries({ home, node: process.execPath, layaPython: values["laya-python"], playwrightCli: values["playwright-cli"], browserExecutable: values["browser-executable"], desktopDriver: values["desktop-driver"] });
for (const file of [values["laya-python"], values["playwright-cli"], values["browser-executable"], values["desktop-driver"]]) if (file) await access(file, constants.R_OK);
const directory = join(home, "computer-use");
await mkdir(directory, { recursive: true, mode: 0o700 });
// --write-config prepares an inspectable integration manifest when the running daemon has
// not been upgraded yet. It neither registers tools nor changes the active desktop runtime.
const prepared = join(directory, "prepared.json");
await writeFile(prepared, JSON.stringify({ entries }, null, 2), { mode: 0o600 });
if (values["write-config"]) { console.log(`Prepared ${prepared}; run again without --write-config after updating Chimera.`); }
else {
  const client = await ChimeraClient.connect({ autostart: false });
  try {
    // Older daemons must refuse before ANY install. A valid but missing server is a
    // supported-method error, whereas unknown-method daemons cannot isolate browser sessions.
    try { await client.call("mcpstore.session", { server: "chimera-desktop", action: "status" }); }
    catch (error) { if (!String((error as Error).message).includes('mcp store server "chimera-desktop" is unavailable')) throw error; }
    const existing = await client.call("mcpstore.list", {}) as typeof entries;
    const builtIns = new Set(existing.filter(e => e.type === "stdio" && e.builtIn).map(e => e.name));
    for (const entry of entries) {
      const prior = existing.find(e => e.name === entry.name);
      if (builtIns.has(entry.name)) continue;
      if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) {
        const canonical = (value: unknown) => JSON.stringify(value, (key, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
        if (canonical(prior) !== canonical(entry)) throw new Error(`Existing ${entry.name} configuration differs; it was preserved.`);
      }
    }
    // Write only a new or byte-equivalent app-host config. Never take over an existing runtime.
    if (values["desktop-driver"]) {
      const file = join(directory, "desktop.json");
      const config = JSON.stringify({ driverPath: values["desktop-driver"], socketPath: desktopSocket(home) }, null, 2);
      const prior = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; return null; });
      if (prior !== null && prior !== config) throw new Error("Existing desktop host configuration differs; it was preserved.");
      if (prior === null) { const tmp = `${file}.${randomUUID()}`; await writeFile(tmp, config, { mode: 0o600, flag: "wx" }); await rename(tmp, file); }
    }
    for (const entry of entries) if (!existing.some(e => e.name === entry.name)) await client.call("mcpstore.add", entry);
    const skipped = entries.filter(e => builtIns.has(e.name)).map(e => e.name);
    if (skipped.length > 0) console.log(`Left ${skipped.join(", ")} alone: provided by Chimera's built-in integrations.`);
    console.log(`Registered ${entries.filter(e => !builtIns.has(e.name)).map(e => e.name).join(", ") || "nothing new"}. Open Chimera → Settings → MCP → Chimera Computer Use.`);
  } finally { client.close(); }
}
