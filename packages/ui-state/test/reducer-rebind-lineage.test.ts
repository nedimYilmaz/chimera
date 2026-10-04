import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState, type AgentRecordLite, type NormalizedEvent } from "@chimera/ui-state";

// REBIND-LINEAGE (ui-tree-lineage, supersedes the incomplete 09dd93c note): a long-lived
// persistent pool worker gets REUSED across tasks/projects -- AgentSupervisor.setOriginConductor
// (supervisor.ts ~2067) rebinds it to a NEW task's conductor and appends `{ kind: "status", data:
// { originConductorId } }` -- the EXACT shape the daemon emits (no `registered` flag, since the
// worker row already exists client-side; scheduler.ts's idle-reuse binds at ~1657/~1921 call this
// on every reuse). The reducer's "status" case never read `originConductorId` at all, so a worker
// reused from project A's conductor to project B's kept rendering under project A's conductor
// FOREVER on the live path -- the daemon's own AgentRecord was already correctly rebound, but the
// desktop app never re-polls agent.list after connect (createStore.ts) to pick up the correction.
// This is the real live-event path a queue worker's rebind takes -- distinct from agent_started
// (case "agent_started") and from an agent.list snapshot merge, both already handled correctly.

function rec(over: Partial<AgentRecordLite> & { agentId: string; createdAt: number }): AgentRecordLite {
  return { state: "running", accountName: "main", provider: "claude", costUsd: 0, ...over };
}
let SEQ = 0;
function ev(over: Partial<NormalizedEvent> & { agentId: string; kind: NormalizedEvent["kind"] }): { type: "event"; event: NormalizedEvent } {
  return { type: "event", event: { ts: SEQ, seq: (SEQ += 1), data: {}, ...over } as NormalizedEvent };
}

describe("agent-tree lineage: a pool worker's live rebind moves it to its NEW owner", () => {
  it("REBIND: setOriginConductor's bare status event re-homes W from conductor A to conductor B", () => {
    // Two project conductors A (PROJ-10140-like) and B (chimera-like), and W: a persistent
    // queue worker currently owned by A -- its own tree root (parentId null), one level in.
    const seed = reduce(initialState, {
      type: "agentRecords",
      records: [
        rec({ agentId: "A", treeId: "A", depth: 0, createdAt: 1, spec: { conductor: true } }),
        rec({ agentId: "B", treeId: "B", depth: 0, createdAt: 2, spec: { conductor: true } }),
        rec({ agentId: "W", treeId: "W", depth: 0, createdAt: 3, parentId: null, originConductorId: "A" }),
      ],
    });
    expect(seed.agents["W"]!.originConductorId).toBe("A");
    expect(seed.agentOrder).toEqual(["A", "W", "B"]); // owner-splice: W sits under A

    // The scheduler released W back to its idle pool and reused it for a task owned by B --
    // the ONLY live signal of that is this bare status event (setOriginConductor's exact shape).
    const rebound = reduce(seed, ev({ agentId: "W", kind: "status", data: { originConductorId: "B" } }));

    expect(rebound.agents["W"]!.originConductorId).toBe("B");
    expect(rebound.agents["W"]!.displayDepth).toBe(1); // depth 0 + owner bump, unchanged
    // The bug's signature: W staying spliced under A (or merely losing its owner) must NOT occur --
    // it must move to sit directly after its NEW owner B, never a positionally-adjacent conductor.
    expect(rebound.agentOrder).toEqual(["A", "B", "W"]);
  });

  it("REBIND-TO-NULL: releasing a worker back to the pool (originConductorId: null) un-nests it live", () => {
    const seed = reduce(initialState, {
      type: "agentRecords",
      records: [
        rec({ agentId: "A", treeId: "A", depth: 0, createdAt: 1, spec: { conductor: true } }),
        rec({ agentId: "W", treeId: "W", depth: 0, createdAt: 2, parentId: null, originConductorId: "A" }),
      ],
    });
    expect(seed.agents["W"]!.displayDepth).toBe(1);

    const released = reduce(seed, ev({ agentId: "W", kind: "status", data: { originConductorId: null } }));
    expect(released.agents["W"]!.originConductorId).toBeNull();
    expect(released.agents["W"]!.displayDepth).toBe(0); // no owner bump once released
  });
});
