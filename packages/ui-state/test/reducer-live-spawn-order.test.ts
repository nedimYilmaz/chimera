import { describe, it, expect } from "vitest";
import { initialState, reduce, type AgentRecordLite, type NormalizedEvent, type UiState } from "@chimera/ui-state";

// LIVE-SPAWN-STABILITY (app agent tree: "live spawns reorder the tree under the cursor").
// agentOrder is DFS + team-cluster + owner-splice order -- deliberately NOT createdAt order.
// reconcileAgentOrder used to hand treeOrder each id's INDEX in agentOrder as a createdAt
// proxy, so the first live event after an agent.list snapshot re-derived sibling and cluster
// order from a key the snapshot never used and permuted rows under the operator's cursor.
// These tests pin: a live event never re-sorts rows already on screen; a spawn is an INSERT.

function rec(over: Partial<AgentRecordLite> & { agentId: string; createdAt: number }): AgentRecordLite {
  return { state: "running", accountName: "main", provider: "claude", costUsd: 0, ...over };
}
let SEQ = 0;
function ev(over: Partial<NormalizedEvent> & { agentId: string; kind: NormalizedEvent["kind"] }): { type: "event"; event: NormalizedEvent } {
  return { type: "event", event: { ts: SEQ, seq: (SEQ += 1), data: {}, ...over } as NormalizedEvent };
}

/** Two teams interleaved by createdAt so the CLUSTERED agentOrder differs from spawn order --
 * exactly the shape whose row indices are a lie about createdAt. */
function connected(): UiState {
  return reduce(initialState, {
    type: "agentRecords",
    records: [
      rec({ agentId: "A", treeId: "A", depth: 0, createdAt: 100, membership: { team: "alpha", role: "lead" } }),
      rec({ agentId: "B", treeId: "B", depth: 0, createdAt: 200, membership: { team: "beta", role: "lead" } }),
      rec({ agentId: "A1", treeId: "A", depth: 1, parentId: "A", createdAt: 300, membership: { team: "alpha", role: "w" } }),
      rec({ agentId: "A2", treeId: "A2", depth: 0, createdAt: 400, membership: { team: "alpha", role: "w" } }),
      rec({ agentId: "B1", treeId: "B", depth: 1, parentId: "B", createdAt: 500, membership: { team: "beta", role: "w" } }),
      rec({ agentId: "DONE", treeId: "A", depth: 1, parentId: "A", createdAt: 600, state: "done", membership: { team: "alpha", role: "w" } }),
    ],
  }) as UiState;
}

describe("live spawns insert instead of re-sorting the tree", () => {
  it("a lineage-neutral live event leaves agentOrder byte-identical", () => {
    const s = connected();
    const before = s.agentOrder;
    // Not a spawn at all -- a status ping on an agent already on screen. Pre-fix this alone
    // re-permuted the list, because the index proxy reordered the team clusters.
    const after = reduce(s, ev({ agentId: "A1", kind: "agent_started", data: { status: "running", parentId: "A", treeId: "A", depth: 1, createdAt: 300 } }));
    expect(after.agentOrder).toEqual(before);
  });

  it("(a) a spawn mid-list keeps every existing row's order and lands next to its parent", () => {
    const s = connected();
    const before = s.agentOrder;
    const after = reduce(s, ev({
      agentId: "A1a", kind: "agent_started",
      data: { status: "running", parentId: "A1", treeId: "A", depth: 2, createdAt: 700, membership: { team: "alpha", role: "w" } },
    }));
    // Existing rows: identical relative order, no re-sort.
    expect(after.agentOrder.filter((id) => id !== "A1a")).toEqual(before);
    // And the new row nests where it belongs: directly after its parent.
    expect(after.agentOrder[after.agentOrder.indexOf("A1") + 1]).toBe("A1a");
  });

  it("(b) the selected agent survives a spawn -- same id, same neighbours above it", () => {
    const s = reduce(connected(), { type: "selectAgent", agentId: "B1" }) as UiState;
    const beforeAbove = s.agentOrder.slice(0, s.agentOrder.indexOf("B1"));
    const after = reduce(s, ev({
      agentId: "A1a", kind: "agent_started",
      data: { status: "running", parentId: "A1", treeId: "A", depth: 2, createdAt: 700, membership: { team: "alpha", role: "w" } },
    }));
    expect(after.selectedAgentId).toBe("B1");
    // Everything the operator could see above the cursor keeps its exact order; the spawn is
    // the only new row (it may push B1 down by one, but never swaps two rows around it).
    expect(after.agentOrder.slice(0, after.agentOrder.indexOf("B1")).filter((id) => id !== "A1a")).toEqual(beforeAbove);
  });

  it("(c) a terminal agent stays in its own tree's group after a live spawn", () => {
    const s = connected();
    const posBefore = s.agentOrder.indexOf("DONE") - s.agentOrder.indexOf("A");
    const after = reduce(s, ev({
      agentId: "B2", kind: "agent_started",
      data: { status: "running", parentId: "B", treeId: "B", depth: 1, createdAt: 800, membership: { team: "beta", role: "w" } },
    }));
    expect(after.agents["DONE"]!.state).toBe("done");
    // DONE is still A's child, at the same offset inside A's tree -- terminal grouping unchanged.
    expect(after.agentOrder.indexOf("DONE") - after.agentOrder.indexOf("A")).toBe(posBefore);
    expect(after.agentOrder[after.agentOrder.indexOf("B") + 1]).toBe("B1");
  });

  it("degrades to first-seen order when no agent carries a createdAt yet (event-only client)", () => {
    let s: UiState = initialState;
    for (const id of ["C", "C1", "C2"]) {
      s = reduce(s, ev({ agentId: id, kind: "agent_started", data: { status: "running", ...(id === "C" ? {} : { parentId: "C", depth: 1, treeId: "C" }) } })) as UiState;
    }
    expect(s.agentOrder).toEqual(["C", "C1", "C2"]);
  });
});
