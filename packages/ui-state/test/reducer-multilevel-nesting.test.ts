import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState, type AgentRecordLite, type NormalizedEvent } from "@chimera/ui-state";

// MULTI-LEVEL-NESTING (ui-tree-lineage): reproduces the LIVE-daemon shape that still
// misrendered after the reconcile-order (09dd93c) and status-originConductorId (03c955a)
// fixes: conductor 4b2451fa (d0) → direct agent_spawn c90272b1 (d1, parentId=conductor,
// originConductorId NULL) → 4 native Agent-tool shadows (d2, parentId=c90272b1). The daemon
// records were correct at every level, but the app rendered the d1 agent as a TOP-LEVEL
// sibling of the conductors and its shadows FLAT under the conductor. Two gaps composed:
// (1) agent_started never carried/folded treeId/depth/parentId, so a post-connect spawn
//     (the desktop app fetches agent.list exactly once at bootstrap) projected lineage-free
//     -- a treeId-less singleton at the top level;
// (2) treeOrder keyed each record by its OWN treeId, so the lineage-carrying shadows landed
//     in the CONDUCTOR's group where parentId=<the d1 agent> couldn't resolve, and the
//     depth-heuristic fallback flattened them under the conductor.

function rec(over: Partial<AgentRecordLite> & { agentId: string; createdAt: number }): AgentRecordLite {
  return { state: "running", accountName: "main", provider: "claude", costUsd: 0, ...over };
}
// projectEvent dedupes by seq (e.seq <= lastSeq -> ignored), so each event needs a strictly
// increasing seq to apply.
let SEQ = 0;
function ev(over: Partial<NormalizedEvent> & { agentId: string; kind: NormalizedEvent["kind"] }): { type: "event"; event: NormalizedEvent } {
  return { type: "event", event: { ts: SEQ, seq: (SEQ += 1), data: {}, ...over } as NormalizedEvent };
}

describe("multi-level parentId nesting: conductor -> direct spawn -> native shadows (event path)", () => {
  it("EVIDENCE SHAPE: a post-connect d1 direct spawn nests under its conductor, and its d2 shadows nest under IT", () => {
    // Connect snapshot has ONLY the conductor -- the d1 agent and its shadows spawn later and
    // arrive via the live stream alone (the app never re-polls agent.list).
    const connect = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "C", treeId: "C", depth: 0, createdAt: 1, spec: { conductor: true } })],
    });
    // agent_spawn from the conductor: supervisor enriches agent_started with the record's
    // lineage. originConductorId is NULL for a direct spawn, so (truthy-guard) it is OMITTED --
    // exactly the live c90272b1 event shape.
    const d1 = reduce(connect, ev({
      agentId: "W", kind: "agent_started",
      data: { sessionId: "sess-w", treeId: "C", depth: 1, parentId: "C", projectId: "chimera" },
    }));
    expect(d1.agents["W"]!.parentId).toBe("C");
    expect(d1.agents["W"]!.treeId).toBe("C");
    expect(d1.agents["W"]!.depth).toBe(1);
    expect(d1.agents["W"]!.displayDepth).toBe(1); // no owner bump: originConductorId null
    // The d1 agent nests under its conductor, NOT as a top-level sibling of it.
    expect(d1.agentOrder).toEqual(["C", "W"]);

    // The d1 agent runs two native Agent-tool sub-agents -> shadow rows, each announced by the
    // supervisor's shadow-directed agent_task re-emit (upsertShadow), which carries the REAL
    // lineage: parentId=W, treeId=C, depth=2, originConductorId null.
    const s1 = reduce(d1, ev({
      agentId: "shadow:W:t1", kind: "agent_task",
      data: { status: "running", subagentType: "general-purpose", parentId: "W", treeId: "C", depth: 2, originConductorId: null },
    }));
    const s2 = reduce(s1, ev({
      agentId: "shadow:W:t2", kind: "agent_task",
      data: { status: "running", subagentType: "general-purpose", parentId: "W", treeId: "C", depth: 2, originConductorId: null },
    }));

    // The rendered order IS the daemon's parentId hierarchy: C -> W -> W's shadows.
    expect(s2.agentOrder).toEqual(["C", "W", "shadow:W:t1", "shadow:W:t2"]);
    expect(s2.agents["shadow:W:t1"]!.parentId).toBe("W");
    expect(s2.agents["shadow:W:t1"]!.depth).toBe(2);
    expect(s2.agents["shadow:W:t1"]!.displayDepth).toBe(2);
    expect(s2.agents["shadow:W:t2"]!.parentId).toBe("W");
    // The bug's signature must NOT appear: shadows directly under C with W detached at the tail.
    expect(s2.agentOrder.indexOf("shadow:W:t1")).toBe(s2.agentOrder.indexOf("W") + 1);
  });

  it("BELT-AND-BRACES (partial lineage): shadows still nest under a d1 parent whose OWN event carried no lineage", () => {
    // An older daemon's agent_started has no treeId/depth/parentId -- the d1 agent projects
    // lineage-free. Its shadows DO carry the real treeId (C). Pre-fix, treeOrder keyed the
    // shadows into C's group (where parentId=W can't resolve -> flattened under C) while W sat
    // in its own singleton -- a SPLIT family. The parent-chain walk keys a child by its
    // resolvable parent's group, so the family stays together under W at any depth.
    const connect = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "C", treeId: "C", depth: 0, createdAt: 1, spec: { conductor: true } })],
    });
    const d1 = reduce(connect, ev({ agentId: "W", kind: "agent_started", data: { sessionId: "sess-w" } }));
    const s1 = reduce(d1, ev({
      agentId: "shadow:W:t1", kind: "agent_task",
      data: { status: "running", subagentType: "general-purpose", parentId: "W", treeId: "C", depth: 2, originConductorId: null },
    }));
    const s2 = reduce(s1, ev({
      agentId: "shadow:W:t2", kind: "agent_task",
      data: { status: "running", subagentType: "general-purpose", parentId: "W", treeId: "C", depth: 2, originConductorId: null },
    }));
    // W can't nest under C (its lineage never arrived), but its shadows MUST stay under W --
    // never flattened into C's tree.
    expect(s2.agentOrder).toEqual(["C", "W", "shadow:W:t1", "shadow:W:t2"]);
  });

  it("SNAPSHOT PATH: a d0->d1->d2->d3 parentId chain orders depth-first at every level", () => {
    const state = reduce(initialState, {
      type: "agentRecords",
      records: [
        rec({ agentId: "C", treeId: "C", depth: 0, createdAt: 1, spec: { conductor: true } }),
        rec({ agentId: "GG", treeId: "C", depth: 3, parentId: "G", createdAt: 5 }),   // arrival order is irrelevant
        rec({ agentId: "W", treeId: "C", depth: 1, parentId: "C", createdAt: 2 }),
        rec({ agentId: "W2", treeId: "C", depth: 1, parentId: "C", createdAt: 3 }),
        rec({ agentId: "G", treeId: "C", depth: 2, parentId: "W", createdAt: 4 }),
      ],
    });
    expect(state.agentOrder).toEqual(["C", "W", "G", "GG", "W2"]);
  });
});
