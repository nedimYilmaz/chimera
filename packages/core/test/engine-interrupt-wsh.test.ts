import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// PARITY WS-H: the agent.interrupt RPC must travel the FULL round-trip — Id.parse (engine.ts)
// → supervisor.interrupt → handle.interrupt — and, mirroring agent.kill's shape, return
// {ok:true}. This crosses the seam the supervisor unit test only covers one side of.
function engineWithScenarios(scenarios: FakeStep[][]): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]),
  });
}
const spawnBody = () => ({ spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } });

describe("Engine.handle agent.interrupt — WS-H round-trip", () => {
  it("routes to the running agent's handle.interrupt() and returns {ok:true}", async () => {
    const e = engineWithScenarios([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };

    // Spy on the live handle through the (public) supervisor so we prove the RPC reached it.
    const spy = { count: 0 };
    const handles = (e.supervisor as unknown as { handles: Map<string, { interrupt(): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, { ...real, interrupt: async () => { spy.count++; } });

    const res = await e.handle("agent.interrupt", { agentId: rec.agentId });

    expect(res).toEqual({ ok: true });
    expect(spy.count).toBe(1);
    // Non-destructive: agent.kill would flip it to "killed"; interrupt leaves it running.
    expect(e.supervisor.status(rec.agentId).state).toBe("running");
  });

  it("surfaces an unknown-agent error (a ghost id never silently succeeds)", async () => {
    const e = engineWithScenarios([[{ end: { resultText: "-" } }]]);
    await expect(e.handle("agent.interrupt", { agentId: "ghost-0000" })).rejects.toMatchObject({ code: "protocol" });
  });
});
