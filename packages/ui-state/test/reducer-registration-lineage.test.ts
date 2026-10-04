import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState, type AgentRecordLite, type NormalizedEvent } from "@chimera/ui-state";

// REGISTRATION-EVENT-MISSING-LINEAGE: the daemon's registration `status { registered: true }`
// event is the app's FIRST sight of a freshly-spawned agent — supervisor.ts now stamps it with
// the same originConductorId/parentId/treeId/depth agent_started carries, so a queue-spawned
// worker is placeable under its real conductor from the moment it appears on the live stream,
// instead of only 8+ events later when agent_started finally lands (or never, for a bare status
// rebind path). This drives the LIVE EVENT PATH directly — no agentRecords snapshot seed for the
// worker itself, matching how the app actually first learns of it.

function rec(over: Partial<AgentRecordLite> & { agentId: string; createdAt: number }): AgentRecordLite {
  return { state: "running", accountName: "main", provider: "claude", costUsd: 0, ...over };
}
let SEQ = 0;
function ev(over: Partial<NormalizedEvent> & { agentId: string; kind: NormalizedEvent["kind"] }): { type: "event"; event: NormalizedEvent } {
  return { type: "event", event: { ts: SEQ, seq: (SEQ += 1), data: {}, ...over } as NormalizedEvent };
}

describe("agent-tree lineage: a worker's registration event places it under its real owner live", () => {
  it("places a freshly-registered worker immediately after its originConductorId, even when a DIFFERENT conductor precedes it", () => {
    // Two project conductors, "vonitor" spawned before "main" -- reproduces the live failure
    // where the worker's true owner (vonitor) is NOT the one adjacent to it in spawn order.
    const seed = reduce(initialState, {
      type: "agentRecords",
      records: [
        rec({ agentId: "vonitor", treeId: "vonitor", depth: 0, createdAt: 1, spec: { conductor: true } }),
        rec({ agentId: "main", treeId: "main", depth: 0, createdAt: 2, spec: { conductor: true } }),
      ],
    });
    expect(seed.agentOrder).toEqual(["vonitor", "main"]);

    // The worker's registration event -- its first-ever appearance on the live stream -- names
    // vonitor as its true owner via originConductorId, exactly as supervisor.ts's spawn() now
    // stamps it.
    const withWorker = reduce(
      seed,
      ev({
        agentId: "worker-1",
        kind: "status",
        data: { registered: true, originConductorId: "vonitor", parentId: "vonitor", treeId: "worker-1", depth: 0 },
      }),
    );

    expect(withWorker.agents["worker-1"]!.originConductorId).toBe("vonitor");
    expect(withWorker.agents["worker-1"]!.depth).toBe(0);
    expect(withWorker.agents["worker-1"]!.displayDepth).toBe(1); // owner-bumped under vonitor
    // The bug's signature: the worker rendering under "main" (or detached at the tail) must NOT
    // occur -- it must be spliced immediately after its real owner, vonitor.
    expect(withWorker.agentOrder).toEqual(["vonitor", "worker-1", "main"]);
  });

  it("a registration event with no lineage at all (direct, unowned spawn) still appends with no owner bump", () => {
    const seed = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "main", treeId: "main", depth: 0, createdAt: 1, spec: { conductor: true } })],
    });

    const withWorker = reduce(
      seed,
      ev({ agentId: "solo-1", kind: "status", data: { registered: true, treeId: "solo-1", depth: 0 } }),
    );

    expect(withWorker.agents["solo-1"]!.originConductorId).toBeUndefined();
    expect(withWorker.agents["solo-1"]!.displayDepth).toBe(0);
    expect(withWorker.agentOrder).toEqual(["main", "solo-1"]);
  });
});

it("late registration reattaches an already observed direct child immediately", () => {
  let state = reduce(initialState, { type: "agentRecords", records: [
    rec({ agentId: "parent", treeId: "parent", depth: 0, createdAt: 1 }),
    rec({ agentId: "other", treeId: "other", depth: 0, createdAt: 2 }),
  ] });
  state = reduce(state, ev({ agentId: "child", kind: "status", data: {} }));
  expect(state.agentOrder).toEqual(["parent", "other", "child"]);
  state = reduce(state, ev({ agentId: "child", kind: "status", data: { registered: true, parentId: "parent", treeId: "parent", depth: 1 } }));
  expect(state.agentOrder).toEqual(["parent", "child", "other"]);
});
