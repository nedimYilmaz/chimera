import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { CFG, MULTI_CFG, fakeExec } from "./helpers.js";

// WD Stage 2 (coverage B13): plugins.toggle enforcement at the SPAWN-RESOLUTION
// seam. The toggle contract is "applies to NEW spawns": launch() consults the
// pluginFilter dep fresh per launch and (a) drops disabled plugin directories from
// spec.plugins so the SDK options omit them, (b) merges Skill(<name>) deny rules
// into providerOptions.disallowedTools (which spreads LAST into SDK options in
// backends/claude.ts). FakeAgentBackend records every ResolvedAgentSpec it
// receives — the exact object the real SDK options are built from.

function makeSup(filter?: () => { disabledSkills: string[]; disabledPlugins: string[] }, cfg = CFG) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-plugsup-"));
  const fake = new FakeAgentBackend([]);
  const codex = new FakeAgentBackend([], "codex");
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(cfg),
    credentials: new CredentialResolver(fakeExec, { CODEX_KEY_SRC: "sk-codex" } as NodeJS.ProcessEnv),
    backends: new Map([["claude", fake], ["codex", codex]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    ...(filter ? { pluginFilter: filter } : {}),
  });
  return { sup, fake, codex };
}

const PLUGINS = [
  { type: "local" as const, path: "/opt/plugins/reviewer" },
  { type: "local" as const, path: "/opt/plugins/deployer/" },   // trailing slash: basename must still match
];

describe("plugin/skill spawn exclusion (coverage B13)", () => {
  it("a disabled plugin directory is dropped from spec.plugins; enabled ones survive", async () => {
    const { sup, fake } = makeSup(() => ({ disabledSkills: [], disabledPlugins: ["deployer"] }));
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none", plugins: PLUGINS });
    expect(fake.spawns[0]!.plugins).toEqual([{ type: "local", path: "/opt/plugins/reviewer" }]);
  });

  it("a disabled skill becomes a Skill(<name>) deny rule in providerOptions.disallowedTools", async () => {
    const { sup, fake } = makeSup(() => ({ disabledSkills: ["pdf", "docx"], disabledPlugins: [] }));
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    expect(fake.spawns[0]!.providerOptions["disallowedTools"]).toEqual(["Skill(pdf)", "Skill(docx)"]);
  });

  it("caller-supplied disallowedTools are PRESERVED — skill rules append, never clobber", async () => {
    const { sup, fake } = makeSup(() => ({ disabledSkills: ["pdf"], disabledPlugins: [] }));
    await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      providerOptions: { disallowedTools: ["WebSearch"], maxThinkingTokens: 1 },
    });
    expect(fake.spawns[0]!.providerOptions).toMatchObject({
      disallowedTools: ["WebSearch", "Skill(pdf)"], maxThinkingTokens: 1,
    });
  });

  it("no filter wired OR nothing disabled → the resolved spec is untouched (no disallowedTools key appears)", async () => {
    const untouched = async (filter?: () => { disabledSkills: string[]; disabledPlugins: string[] }) => {
      const { sup, fake } = makeSup(filter);
      await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none", plugins: PLUGINS });
      expect(fake.spawns[0]!.plugins).toEqual(PLUGINS);
      expect("disallowedTools" in fake.spawns[0]!.providerOptions).toBe(false);
    };
    await untouched();                                                        // seam absent
    await untouched(() => ({ disabledSkills: [], disabledPlugins: [] }));     // seam present, all enabled
  });

  it("the record keeps the caller's spec VERBATIM — exclusion applies only to the launched (resolved) spec", async () => {
    const { sup, fake } = makeSup(() => ({ disabledSkills: ["pdf"], disabledPlugins: ["deployer"] }));
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none", plugins: PLUGINS });
    expect(rec.spec.plugins).toEqual(PLUGINS);                                // record: untouched
    expect("disallowedTools" in rec.spec.providerOptions).toBe(false);
    expect(fake.spawns[0]!.plugins).toHaveLength(1);                          // launch: filtered
  });

  it("the filter is read FRESH per launch — a toggle lands on the NEXT spawn without replumbing", async () => {
    let disabled: string[] = [];
    const { sup, fake } = makeSup(() => ({ disabledSkills: [], disabledPlugins: disabled }));
    await sup.spawn({ prompt: "a", cwd: "/tmp", account: "main", isolation: "none", plugins: PLUGINS });
    disabled = ["reviewer"];                                                  // plugins.toggle happens "now"
    await sup.spawn({ prompt: "b", cwd: "/tmp", account: "second", isolation: "none", plugins: PLUGINS });
    expect(fake.spawns[0]!.plugins).toHaveLength(2);
    expect(fake.spawns[1]!.plugins.map((p) => p.path)).toEqual(["/opt/plugins/deployer/"]);
  });

  it("codex spawns are NEVER touched (no skills/plugins surface on that provider)", async () => {
    const { sup, codex } = makeSup(() => ({ disabledSkills: ["pdf"], disabledPlugins: [] }), MULTI_CFG);
    await sup.spawn({ prompt: "x", cwd: "/tmp", account: "cx-main", isolation: "none" });
    expect("disallowedTools" in codex.spawns[0]!.providerOptions).toBe(false);
  });
});
