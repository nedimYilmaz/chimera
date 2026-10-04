import { describe, it, expect } from "vitest";
import { treeOrder } from "@chimera/ui-state";
import type { AgentRecordLite } from "@chimera/ui-state";

// AGENT-GROUPS Phase 1, test #1 (the guard for the twice-burned placement complaint,
// 248dbc1a): treeOrder(records) must be BYTE-IDENTICAL with and without `groups` set on every
// record. Groups are a post-treeOrder, app-local reshape (mirrors how `session` is handled —
// see reducer-inspector-placement-audit.test.ts's own note that session is "an orthogonal
// presentation-layer flag") — treeOrder itself must never read AgentRecordLite.groups at all.

function rec(over: Partial<AgentRecordLite> & { agentId: string; createdAt: number }): AgentRecordLite {
  return { state: "running", accountName: "main", provider: "claude", costUsd: 0, ...over };
}

describe("AGENT-GROUPS placement invariant: treeOrder ignores groups entirely", () => {
  it("a root + child + standalone tree orders identically whether or not `groups` is set on every record", () => {
    const withoutGroups: AgentRecordLite[] = [
      rec({ agentId: "R", treeId: "R", depth: 0, createdAt: 1 }),
      rec({ agentId: "C1", treeId: "R", depth: 1, createdAt: 2, parentId: "R" }),
      rec({ agentId: "S", treeId: "S", depth: 0, createdAt: 3 }),
    ];
    const withGroups: AgentRecordLite[] = [
      rec({ agentId: "R", treeId: "R", depth: 0, createdAt: 1, groups: ["sprint"] }),
      rec({ agentId: "C1", treeId: "R", depth: 1, createdAt: 2, parentId: "R" }), // no group of its own — inherits via ui-state's effectiveGroupOf, not treeOrder
      rec({ agentId: "S", treeId: "S", depth: 0, createdAt: 3, groups: ["daily"] }),
    ];
    expect(treeOrder(withGroups)).toEqual(treeOrder(withoutGroups));
  });

  it("mixed/varied group assignments across a larger multi-tree set still produce byte-identical order to the groupless baseline", () => {
    const base: Array<Partial<AgentRecordLite> & { agentId: string; createdAt: number }> = [
      { agentId: "R1", treeId: "R1", depth: 0, createdAt: 1, membership: { team: "alpha", role: "worker" } },
      { agentId: "R1-C1", treeId: "R1", depth: 1, createdAt: 2, parentId: "R1" },
      { agentId: "R2", treeId: "R2", depth: 0, createdAt: 3, membership: { team: "alpha", role: "worker" } },
      { agentId: "R3", treeId: "R3", depth: 0, createdAt: 4 },
      { agentId: "R3-C1", treeId: "R3", depth: 1, createdAt: 5, parentId: "R3" },
      { agentId: "R3-C1-G1", treeId: "R3", depth: 2, createdAt: 6, parentId: "R3-C1" },
    ];
    const withoutGroups = base.map((o) => rec(o));
    const groupAssignments: Record<string, string[]> = {
      "R1": ["sprint"], "R2": ["sprint"], "R3-C1": ["daily"], "R3-C1-G1": ["daily"],
    };
    const withGroups = base.map((o) => rec({ ...o, ...(groupAssignments[o.agentId] ? { groups: groupAssignments[o.agentId] } : {}) }));
    expect(treeOrder(withGroups)).toEqual(treeOrder(withoutGroups));
  });
});
