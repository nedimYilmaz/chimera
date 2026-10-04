import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginCatalogEntry } from "@chimera/protocol";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// WD Stage 2 (coverage B13): the plugins.list / plugins.toggle RPC surface on a
// real Engine, and the toggle→next-spawn enforcement loop through the engine's own
// pluginFilter seam (the same wiring the daemon runs).

function makeClaudeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chimera-eng-claude-"));
  mkdirSync(join(dir, "skills", "pdf"), { recursive: true });
  writeFileSync(join(dir, "skills", "pdf", "SKILL.md"), "# pdf");
  mkdirSync(join(dir, "plugins"), { recursive: true });
  writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2, plugins: { "superpowers@official": [{ installPath: "/x/superpowers/1.0" }] },
  }));
  return dir;
}

function engineOn(home: string, scenarios: FakeStep[][] = []) {
  const fake = new FakeAgentBackend(scenarios);
  const engine = new Engine({
    home, backends: new Map<string, AgentBackend>([["claude", fake]]), claudeDir: makeClaudeDir(),
  });
  return { engine, fake };
}

describe("plugins.list / plugins.toggle RPCs", () => {
  it("lists the global catalog; {cwd} adds that project's commands", async () => {
    const { engine } = engineOn(makeEngineHome());
    const global = (await engine.handle("plugins.list", {})) as PluginCatalogEntry[];
    expect(global.map((e) => e.id)).toEqual(["skill:pdf", "plugin:superpowers"]);
    expect(global.every((e) => e.enabled)).toBe(true);

    const cwd = mkdtempSync(join(tmpdir(), "chimera-cmd-cwd-"));
    mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "commands", "deploy.md"), "# deploy");
    const scoped = (await engine.handle("plugins.list", { cwd })) as PluginCatalogEntry[];
    expect(scoped.map((e) => e.id)).toContain("command:deploy");
  });

  it("toggle persists to $CHIMERA_HOME/plugins.json and survives an engine restart", async () => {
    const home = makeEngineHome();
    const { engine } = engineOn(home);
    expect(await engine.handle("plugins.toggle", { id: "skill:pdf", enabled: false })).toEqual({ id: "skill:pdf", enabled: false });
    // NOTE: catalog entries come from the claudeDir; the toggle map lives in `home`,
    // so a fresh engine (fresh claudeDir with the same skill name) still sees it off.
    const { engine: e2 } = engineOn(home);
    const listed = (await e2.handle("plugins.list", {})) as PluginCatalogEntry[];
    expect(listed.find((e) => e.id === "skill:pdf")?.enabled).toBe(false);
  });

  it("a toggle applies to the NEXT spawn via the engine's own pluginFilter seam", async () => {
    const home = makeEngineHome();
    const { engine, fake } = engineOn(home, [[{ end: { resultText: "a" } }], [{ end: { resultText: "b" } }]]);
    const spec = { prompt: "x", cwd: "/tmp", isolation: "none", plugins: [{ type: "local", path: "/x/superpowers/1.0/superpowers" }] };
    await engine.handle("agent.spawn", { spec });
    expect(fake.spawns[0]!.plugins).toHaveLength(1);                         // enabled → loads
    expect("disallowedTools" in fake.spawns[0]!.providerOptions).toBe(false);

    await engine.handle("plugins.toggle", { id: "plugin:superpowers", enabled: false });
    await engine.handle("plugins.toggle", { id: "skill:pdf", enabled: false });
    await engine.handle("agent.spawn", { spec });
    expect(fake.spawns[1]!.plugins).toEqual([]);                             // disabled plugin dir dropped
    expect(fake.spawns[1]!.providerOptions["disallowedTools"]).toEqual(["Skill(pdf)"]);   // disabled skill denied
  });

  it("toggle rejects a malformed id with a protocol error", async () => {
    const { engine } = engineOn(makeEngineHome());
    await expect(engine.handle("plugins.toggle", { id: "nonsense", enabled: false })).rejects.toMatchObject({ code: "protocol" });
  });
});
