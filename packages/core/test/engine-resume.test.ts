import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// AGENT-RESUME-TOOLS: agent.resume RPC — a thin ResumeParams parse + dispatch to
// supervisor.resume, mirroring the agent.setModel/agent.setEffort dispatch tests. The record
// lookup / effective-cwd derivation / terminal + missing-workdir refusals live in
// supervisor.resume (covered by supervisor-resume.test.ts); this pins the ENGINE routing.

function engineWithScenarios(scenarios: FakeStep[][]): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]),
  });
}

describe("Engine.handle agent.resume", () => {
  it("routes to supervisor.resume and returns a fresh record for a terminal agent", async () => {
    const e = engineWithScenarios([
      [{ emit: { kind: "agent_started", data: { sessionId: "sess-1" } } }, { awaitSend: true }],
      [{ awaitSend: true }],
    ]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await new Promise((r) => setTimeout(r, 20));   // let the fake's fire-and-forget agent_started settle
    await e.handle("agent.kill", { agentId: rec.agentId });

    const resumed = (await e.handle("agent.resume", { agentId: rec.agentId, prompt: "continue the work" })) as { agentId: string };

    // A FRESH spawn (new agentId), not a same-id respawn like setModel/setEffort.
    expect(resumed.agentId).not.toBe(rec.agentId);
  });

  it("rejects an unknown agentId with a protocol-coded error", async () => {
    const e = engineWithScenarios([]);
    await expect(e.handle("agent.resume", { agentId: "ghost", prompt: "go" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects malformed params (missing prompt) with a protocol-coded error", async () => {
    const e = engineWithScenarios([[{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }]]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await expect(e.handle("agent.resume", { agentId: rec.agentId }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("strictly rejects unknown extra param keys (ResumeParams is .strict())", async () => {
    const e = engineWithScenarios([]);
    await expect(e.handle("agent.resume", { agentId: "a1", prompt: "go", bogus: true }))
      .rejects.toMatchObject({ code: "protocol" });
  });
});
