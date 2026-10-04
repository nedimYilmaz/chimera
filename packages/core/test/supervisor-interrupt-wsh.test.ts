import { describe, it, expect } from "vitest";
import { makeSupervisor } from "./helpers.js";
import { UnknownAgentError } from "@chimera/core/supervisor";

// PARITY WS-H: the PUBLIC supervisor.interrupt(agentId) aborts the agent's in-flight
// turn by delegating to the SAME handle.interrupt() already driven internally for
// tree-pause/budget aborts. Unlike kill() it must NOT kill the agent — it stays running.
describe("AgentSupervisor.interrupt (WS-H esc-to-interrupt)", () => {
  // Intercept handle.interrupt so we can assert it was called (the fake's own is a no-op).
  function interceptInterrupt(sup: unknown, agentId: string): { count: number } {
    const spy = { count: 0 };
    const handles = (sup as { handles: Map<string, { interrupt(): Promise<void> }> }).handles;
    const real = handles.get(agentId)!;
    handles.set(agentId, { ...real, interrupt: async () => { spy.count++; } });
    return spy;
  }

  it("calls the running agent's handle.interrupt() exactly once", async () => {
    const { sup } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    const spy = interceptInterrupt(sup, rec.agentId);

    await sup.interrupt(rec.agentId);

    expect(spy.count).toBe(1);
    // Non-destructive: the agent is STILL running after an interrupt (contrast kill()).
    expect(sup.status(rec.agentId).state).toBe("running");
  });

  it("is non-destructive through the REAL handle (fake's interrupt is a no-op -> agent stays running)", async () => {
    // No spy here: exercise the actual handle path so we prove supervisor.interrupt itself
    // (status() + delegate) mutates no state — the fake's interrupt() genuinely runs.
    const { sup } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    await sup.interrupt(rec.agentId);

    expect(sup.status(rec.agentId).state).toBe("running");
  });

  it("is a silent no-op for a known but NOT-running agent (settled handle already gone)", async () => {
    const { sup } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);                   // let it finish -> handle removed
    expect(sup.status(rec.agentId).state).not.toBe("running");

    // Known id (not a ghost) with no live handle: must NOT throw and must change nothing.
    await expect(sup.interrupt(rec.agentId)).resolves.toBeUndefined();
    expect(sup.status(rec.agentId).state).not.toBe("running");
  });

  it("throws UnknownAgentError for a ghost id (never fabricates an interrupt)", async () => {
    const { sup } = makeSupervisor([[{ end: { resultText: "-" } }]]);
    await expect(sup.interrupt("nope-9999")).rejects.toBeInstanceOf(UnknownAgentError);
  });
});
