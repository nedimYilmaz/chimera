import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState, type AgentRecordLite, type NormalizedEvent } from "@chimera/ui-state";

// LINEAGE MISPARENTING (ui-tree-lineage): the daemon AgentRecords carry the CORRECT
// parentId/treeId/originConductorId, but the live EVENT path used to APPEND each newly-seen
// agent to agentOrder's tail while both UIs render the tree POSITIONALLY over agentOrder. So a
// child/shadow whose event arrived after its parent's later-spawned SIBLING collapsed under
// that sibling, and a queue worker appended far from its conductor rendered under a different
// one. The fix reconciles the event path through the SAME treeOrder the snapshot uses.

function rec(over: Partial<AgentRecordLite> & { agentId: string; createdAt: number }): AgentRecordLite {
  return { state: "running", accountName: "main", provider: "claude", costUsd: 0, ...over };
}
// projectEvent dedupes by seq (e.seq <= lastSeq -> ignored), so each event needs a strictly
// increasing seq to apply -- a monotonic counter keeps call sites from having to thread it.
let SEQ = 0;
function ev(over: Partial<NormalizedEvent> & { agentId: string; kind: NormalizedEvent["kind"] }): { type: "event"; event: NormalizedEvent } {
  return { type: "event", event: { ts: SEQ, seq: (SEQ += 1), data: {}, ...over } as NormalizedEvent };
}

describe("agent-tree lineage: sibling sub-agents keep their own parent (event path)", () => {
  it("SYMPTOM 1: two research agents' deep-research shadows each nest under their OWN parent, not both under the second", () => {
    // The desktop app has ONE snapshot at connect (C + the two research agents), then never
    // re-polls -- the deep-research shadows spawn LATER and arrive via agent_task events only.
    const connect = reduce(initialState, {
      type: "agentRecords",
      records: [
        rec({ agentId: "C", treeId: "C", depth: 0, createdAt: 1, spec: { conductor: true } }),
        rec({ agentId: "R1", treeId: "C", depth: 1, parentId: "C", createdAt: 2 }),
        rec({ agentId: "R2", treeId: "C", depth: 1, parentId: "C", createdAt: 3 }),
      ],
    });
    expect(connect.agentOrder).toEqual(["C", "R1", "R2"]);

    // Each research agent spawns a native deep-research sub-agent (shadow:<parent>:<taskId>).
    // Both agent_task events carry the correct parentId/treeId/depth (verified against the live
    // daemon). They arrive AFTER both research agents -- the exact tail-append race that used to
    // collapse both shadows under R2 (the LAST depth-1 row a positional depth-walk would attach to).
    const s1 = reduce(connect, ev({
      agentId: "shadow:R1:t1", kind: "agent_task",
      data: { status: "running", subagentType: "deep-research", parentId: "R1", treeId: "C", depth: 2, originConductorId: null },
    }));
    const s2 = reduce(s1, ev({
      agentId: "shadow:R2:t2", kind: "agent_task",
      data: { status: "running", subagentType: "deep-research", parentId: "R2", treeId: "C", depth: 2, originConductorId: null },
    }));

    // DFS pre-order by real parentId: each shadow sits DIRECTLY after its own research agent.
    expect(s2.agentOrder).toEqual(["C", "R1", "shadow:R1:t1", "R2", "shadow:R2:t2"]);
    // Lineage projected authoritatively from the event, so a positional depth-walk nests right.
    expect(s2.agents["shadow:R1:t1"]!.parentId).toBe("R1");
    expect(s2.agents["shadow:R2:t2"]!.parentId).toBe("R2");
    expect(s2.agents["shadow:R1:t1"]!.depth).toBe(2);
    // The bug's signature -- the two shadows adjacent at the tail under R2 -- must NOT appear.
    const i1 = s2.agentOrder.indexOf("shadow:R1:t1");
    const i2 = s2.agentOrder.indexOf("shadow:R2:t2");
    expect(s2.agentOrder[i1 - 1]).toBe("R1");
    expect(s2.agentOrder[i2 - 1]).toBe("R2");
  });

  it("order-independence: the SECOND research agent's shadow arriving FIRST still nests each under its own parent", () => {
    const connect = reduce(initialState, {
      type: "agentRecords",
      records: [
        rec({ agentId: "C", treeId: "C", depth: 0, createdAt: 1, spec: { conductor: true } }),
        rec({ agentId: "R1", treeId: "C", depth: 1, parentId: "C", createdAt: 2 }),
        rec({ agentId: "R2", treeId: "C", depth: 1, parentId: "C", createdAt: 3 }),
      ],
    });
    // R2's shadow event lands BEFORE R1's -- nesting keys on parentId, not arrival order.
    const first = reduce(connect, ev({
      agentId: "shadow:R2:t2", kind: "agent_task",
      data: { status: "running", subagentType: "deep-research", parentId: "R2", treeId: "C", depth: 2 },
    }));
    const both = reduce(first, ev({
      agentId: "shadow:R1:t1", kind: "agent_task",
      data: { status: "running", subagentType: "deep-research", parentId: "R1", treeId: "C", depth: 2 },
    }));
    expect(both.agentOrder).toEqual(["C", "R1", "shadow:R1:t1", "R2", "shadow:R2:t2"]);
  });
});

describe("agent-tree lineage: authoritative owner corrects a prior wrong guess", () => {
  it("SYMPTOM 2: a snapshot with the CORRECT originConductorId overrides an earlier wrong owner and re-homes the worker", () => {
    // Two conductors A and B; W is a queue worker OWNED by A (originConductorId=A).
    const seed = reduce(initialState, {
      type: "agentRecords",
      records: [
        rec({ agentId: "A", treeId: "A", depth: 0, createdAt: 1, spec: { conductor: true } }),
        rec({ agentId: "B", treeId: "B", depth: 0, createdAt: 2, spec: { conductor: true } }),
      ],
    });
    // A racing/early event mis-attributes W to conductor B (the reported symptom).
    const wrong = reduce(seed, ev({ agentId: "W", kind: "agent_started", data: { treeId: "W", depth: 0, originConductorId: "B" } }));
    expect(wrong.agents["W"]!.originConductorId).toBe("B");
    expect(wrong.agents["W"]!.displayDepth).toBe(1); // depth 0 + owner bump
    // W's tree is spliced under its (wrong) owner B.
    expect(wrong.agentOrder).toEqual(["A", "B", "W"]);

    // The authoritative agent.list snapshot names A as the real owner -- it must WIN.
    const fixed = reduce(wrong, {
      type: "agentRecords",
      records: [
        rec({ agentId: "A", treeId: "A", depth: 0, createdAt: 1, spec: { conductor: true } }),
        rec({ agentId: "B", treeId: "B", depth: 0, createdAt: 2, spec: { conductor: true } }),
        rec({ agentId: "W", treeId: "W", depth: 0, createdAt: 3, originConductorId: "A" }),
      ],
    });
    expect(fixed.agents["W"]!.originConductorId).toBe("A");
    expect(fixed.agents["W"]!.displayDepth).toBe(1);
    // treeOrder's owner-splice now places W's tree directly after conductor A, not B.
    expect(fixed.agentOrder).toEqual(["A", "W", "B"]);
  });

  it("MERGE BUG: a later poll that OMITS originConductorId keeps both the owner AND its displayDepth bump", () => {
    // Regression for the inline displayDepth that bumped on the INCOMING r.originConductorId
    // instead of the MERGED value: a snapshot without the field kept prev owner but dropped the
    // indent, briefly un-nesting a conductor-owned worker.
    const owned = reduce(initialState, {
      type: "agentRecords",
      records: [
        rec({ agentId: "A", treeId: "A", depth: 0, createdAt: 1, spec: { conductor: true } }),
        rec({ agentId: "W", treeId: "W", depth: 0, createdAt: 2, originConductorId: "A" }),
      ],
    });
    expect(owned.agents["W"]!.displayDepth).toBe(1);
    // A cost/state-only poll that omits the (older-daemon / raced) originConductorId field.
    const poll = reduce(owned, {
      type: "agentRecords",
      records: [
        rec({ agentId: "A", treeId: "A", depth: 0, createdAt: 1, spec: { conductor: true } }),
        rec({ agentId: "W", treeId: "W", depth: 0, createdAt: 2 }),
      ],
    });
    expect(poll.agents["W"]!.originConductorId).toBe("A"); // owner preserved (authoritative-when-present)
    expect(poll.agents["W"]!.displayDepth).toBe(1);         // and its indent bump survives (the fix)
  });
});
