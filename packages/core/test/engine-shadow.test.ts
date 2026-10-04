import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// Task N-SHADOW: a native sub-agent/workflow "shadow" row is returned from
// supervisor.list() (so agent.list surfaces it to the TUI) but MUST NOT be
// counted as an independently-scheduled agent in daemon.status/peer.status. This
// exercises the engine-level `!a.shadow` filters (engine.ts) end-to-end — the
// supervisor's own map-separation tests can't reach them (the spawn guardrails
// iterate this.agents directly, which never contains shadows).

const tick = () => new Promise((r) => setTimeout(r, 20));

function engineWithScenarios(scenarios: FakeStep[][]): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]),
  });
}

describe("Engine: shadow rows are list-visible but not counted (Task N-SHADOW)", () => {
  it("agent.list includes the shadow, but daemon.status counts only the real parent", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "T1", subagentType: "code-reviewer" } },
      { awaitSend: true },                                  // park the parent so it (and its shadow) stay running
      { end: { resultText: "ok" } },
    ];
    const e = engineWithScenarios([scenario]);
    const parent = (await e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await tick();

    const list = (await e.handle("agent.list", {})) as Array<{ agentId: string; shadow?: boolean; depth?: number; treeId?: string }>;
    const shadow = list.find((a) => a.shadow);
    expect(shadow).toBeDefined();                          // the TUI CAN see the shadow row
    expect(shadow!.agentId).toBe(`shadow:${parent.agentId}:T1`);
    expect(shadow!.treeId).toBe(parent.agentId);           // parented under the caller's tree

    const st = (await e.handle("daemon.status", {})) as { agents: { running: number; done: number } };
    expect(st.agents.running).toBe(1);                     // ONLY the real parent — the shadow is filtered out of the count
    expect(st.agents.done).toBe(0);
  });

  it("agent.list serializes a shadow's shadowInfo verbatim (round-trips to the TUI)", async () => {
    // Task SHADOW-ACT: agent.list returns supervisor.list() with no field-stripping
    // schema, so the live activity fields must reach the TUI unchanged (JSON round-trip).
    const scenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: {} } },
      { task: { taskId: "T1", subagentType: "reviewer", description: "check auth", lastToolName: "Read", summary: "looks good", usage: { totalTokens: 500, toolUses: 4, durationMs: 3000 } } },
      { awaitSend: true }, { end: { resultText: "ok" } },
    ];
    const e = engineWithScenarios([scenario]);
    await e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", isolation: "none" } });
    await tick();

    // JSON.stringify/parse mimics the JSON-RPC hop to the client.
    const list = JSON.parse(JSON.stringify(await e.handle("agent.list", {}))) as Array<{ shadow?: boolean; shadowInfo?: Record<string, unknown> }>;
    const shadow = list.find((a) => a.shadow)!;
    expect(shadow.shadowInfo).toEqual({
      // R2: subagentType now rides shadowInfo too (see supervisor-shadow.test.ts).
      subagentType: "reviewer", description: "check auth", lastToolName: "Read", summary: "looks good",
      totalTokens: 500, toolUses: 4, durationMs: 3000,
    });
  });
});
