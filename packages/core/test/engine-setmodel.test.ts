import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// Task MDL-a: agent.setModel RPC — routes to supervisor.setModel.

function engineWithScenarios(scenarios: FakeStep[][]): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]),
  });
}

describe("Engine.handle agent.setModel", () => {
  it("routes to supervisor.setModel and returns the respawned record", async () => {
    const e = engineWithScenarios([
      [{ emit: { kind: "agent_started", data: { sessionId: "sess-1" } } }, { awaitSend: true }],
      [{ awaitSend: true }],
    ]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none", model: "claude-sonner-5" } })) as { agentId: string };
    await new Promise((r) => setTimeout(r, 20));   // let the fake's fire-and-forget agent_started settle

    const updated = (await e.handle("agent.setModel", { agentId: rec.agentId, model: "claude-sonnet-5" })) as { agentId: string; spec: { model: string } };

    expect(updated.agentId).toBe(rec.agentId);
    expect(updated.spec.model).toBe("claude-sonnet-5");
  });

  it("rejects an unknown agentId with a protocol-coded error", async () => {
    const e = engineWithScenarios([]);
    await expect(e.handle("agent.setModel", { agentId: "ghost", model: "claude-sonnet-5" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects malformed params (missing model) with a protocol-coded error", async () => {
    const e = engineWithScenarios([[{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }]]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await expect(e.handle("agent.setModel", { agentId: rec.agentId }))
      .rejects.toMatchObject({ code: "protocol" });
  });
});
