import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { CONDUCTOR_PLAYBOOK } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

// PROMPT-CACHE-PREFIX: every conductor's instructions must START with the fixed
// CONDUCTOR_PLAYBOOK, with the session/project-specific line AFTER it. A provider's prefix
// cache only pays off while the leading tokens are identical across spawns — putting the
// project name first (as this code originally did) diverged the prefix on the very first
// tokens, so the entire playbook was re-billed for every project conductor and shared nothing
// with the main one. This test is the only thing that stops that ordering from drifting back.
const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ awaitSend: true }]])]]);

describe("conductor prompt cache prefix", () => {
  it("the MAIN conductor's instructions begin with the shared playbook", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const rec = await e.ensureMainConductor();
    const instructions = String((rec.spec as { instructions?: string }).instructions ?? "");
    expect(instructions.startsWith(CONDUCTOR_PLAYBOOK)).toBe(true);
    // ...and the session-specific line still survives, after it
    expect(instructions).toContain("MAIN session");
    expect(instructions.indexOf("MAIN session")).toBeGreaterThan(CONDUCTOR_PLAYBOOK.length - 1);
  });

  it("a PROJECT conductor's instructions begin with the same shared playbook", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("project.create", { name: "alpha", path: makeEngineHome() });
    const started = (await e.handle("project.conductor.start", { name: "alpha" })) as { agentId: string };
    const rec = e.supervisor.status(started.agentId);
    const instructions = String((rec.spec as { instructions?: string }).instructions ?? "");
    expect(instructions.startsWith(CONDUCTOR_PLAYBOOK)).toBe(true);
    expect(instructions).toContain('PROJECT "alpha"');
  });

  it("gets one shared discovery block through the actual spawn boundary", async () => {
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);
    const e = new Engine({ home: makeEngineHome(), backends: new Map([["claude", fake]]) });
    await e.handle("project.create", { name: "alpha", path: makeEngineHome() });
    await e.handle("project.conductor.start", { name: "alpha" });
    const instructions = fake.spawns[0]!.instructions!;
    expect(instructions.match(/mcp_store_tools/g)).toHaveLength(1);
    expect(instructions.match(/chimera_tools/g)).toHaveLength(1);
    expect(instructions).toContain("never access the daemon socket directly");
    expect(instructions).toContain('PROJECT "alpha"');
    expect(instructions.length).toBeLessThan(3_200);
    await e.supervisor.kill(fake.spawns[0]!.agentId);
  });
});
