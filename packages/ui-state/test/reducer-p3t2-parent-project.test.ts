import { describe, it, expect } from "vitest";
import {
  reduce,
  treeOrder,
  initialState,
  NO_PROJECT_CONDUCTOR_KEY,
  legacyMainConductorId,
  type AgentRecordLite,
} from "@chimera/ui-state";

// P3-T2 (PLAN-PROJECT-CONDUCTOR-ROUTING.md §9): treeOrder now prefers a REAL
// parentId (P3-T1) over the depth+createdAt heuristic, and agentRecords derives
// a per-project conductor map (conductorByProject) from the same snapshot.

function rec(over: Partial<AgentRecordLite> & { agentId: string; createdAt: number }): AgentRecordLite {
  return { state: "running", accountName: "main", provider: "claude", costUsd: 0, ...over };
}

describe("treeOrder: real parentId (P3-T2)", () => {
  it("nests a separately-rooted queue worker and its shadow under its persisted conductor owner", () => {
    const C = rec({ agentId: "C", treeId: "C", depth: 0, createdAt: 1, spec: { conductor: true } });
    const W = rec({ agentId: "W", treeId: "W", depth: 0, createdAt: 2, originConductorId: "C", membership: { team: "crew", role: "dev" } });
    const S = rec({ agentId: "S", treeId: "W", depth: 1, createdAt: 3, parentId: "W", originConductorId: "C", shadow: true });
    const other = rec({ agentId: "other", treeId: "other", depth: 0, createdAt: 4 });
    expect(treeOrder([C, other, W, S])).toEqual(["C", "W", "S", "other"]);
  });
  it("resolves the exact ambiguous case a depth+createdAt heuristic would mis-attribute: a sibling spawned BETWEEN a parent and its own child", () => {
    // R spawns C1 (parent), THEN R spawns C2 (a sibling), THEN C1 spawns G. The
    // old (depth,createdAt) heuristic would attribute G to "most recent node at
    // depth 1" = C2 (wrong -- G's real parent is C1). A real parentId fixes it.
    const R = rec({ agentId: "R", treeId: "R", depth: 0, createdAt: 1 });
    const C1 = rec({ agentId: "C1", treeId: "R", depth: 1, createdAt: 2, parentId: "R" });
    const C2 = rec({ agentId: "C2", treeId: "R", depth: 1, createdAt: 3, parentId: "R" });
    const G = rec({ agentId: "G", treeId: "R", depth: 2, createdAt: 4, parentId: "C1" });
    expect(treeOrder([R, C1, C2, G])).toEqual(["R", "C1", "G", "C2"]);
  });

  it("falls back to the depth+createdAt heuristic when parentId is absent (older daemon)", () => {
    const R = rec({ agentId: "R", treeId: "R", depth: 0, createdAt: 1 });
    const C1 = rec({ agentId: "C1", treeId: "R", depth: 1, createdAt: 2 });
    const C2 = rec({ agentId: "C2", treeId: "R", depth: 1, createdAt: 3 });
    const G = rec({ agentId: "G", treeId: "R", depth: 2, createdAt: 4 });
    // No parentId anywhere -> reproduces the OLD (documented) mis-attribution:
    // G lands under C2 (the most-recently-seen depth-1 node), not C1.
    expect(treeOrder([R, C1, C2, G])).toEqual(["R", "C1", "C2", "G"]);
  });

  it("falls back to the heuristic when parentId doesn't resolve within the same tree (unexpected wire shape, defensive)", () => {
    const R = rec({ agentId: "R", treeId: "R", depth: 0, createdAt: 1 });
    const C1 = rec({ agentId: "C1", treeId: "R", depth: 1, createdAt: 2, parentId: "ghost-not-in-snapshot" });
    expect(treeOrder([R, C1])).toEqual(["R", "C1"]);
  });

  it("a null parentId (a genuine root spawn) is treated exactly like an absent one -- heuristic decides", () => {
    const R = rec({ agentId: "R", treeId: "R", depth: 0, createdAt: 1 });
    const C1 = rec({ agentId: "C1", treeId: "R", depth: 1, createdAt: 2, parentId: null });
    expect(treeOrder([R, C1])).toEqual(["R", "C1"]);
  });
});

describe("reducer: agentRecords projects parentId/projectId onto AgentView (P3-T2)", () => {
  it("projects a real parentId and projectId authoritatively", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [
        rec({ agentId: "conductor", createdAt: 1, spec: { conductor: true }, projectId: "chimera" }),
        rec({ agentId: "child", createdAt: 2, parentId: "conductor", projectId: "chimera" }),
      ],
    });
    expect(st.agents["child"]!.parentId).toBe("conductor");
    expect(st.agents["child"]!.projectId).toBe("chimera");
    expect(st.agents["conductor"]!.parentId).toBeUndefined();
    expect(st.agents["conductor"]!.projectId).toBe("chimera");
  });

  it("an explicit null overwrites a prior value (a real 'no parent'/'no project' fact, not a missing field)", () => {
    const first = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "x", createdAt: 1, parentId: "p1", projectId: "proj" })],
    });
    expect(first.agents["x"]!.parentId).toBe("p1");
    const second = reduce(first, {
      type: "agentRecords",
      records: [rec({ agentId: "x", createdAt: 1, parentId: null, projectId: null })],
    });
    expect(second.agents["x"]!.parentId).toBeNull();
    expect(second.agents["x"]!.projectId).toBeNull();
  });

  it("an omitted field (older daemon) never clobbers a prior valid value", () => {
    const first = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "x", createdAt: 1, parentId: "p1", projectId: "proj" })],
    });
    const second = reduce(first, {
      type: "agentRecords",
      records: [rec({ agentId: "x", createdAt: 1 })],   // no parentId/projectId keys at all
    });
    expect(second.agents["x"]!.parentId).toBe("p1");
    expect(second.agents["x"]!.projectId).toBe("proj");
  });
});

describe("reducer: agentRecords derives conductorByProject (P3-T2)", () => {
  it("populates the per-project conductor map from spec.conductor records", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [
        rec({ agentId: "c-chimera", createdAt: 1, spec: { conductor: true }, projectId: "chimera" }),
        rec({ agentId: "c-widgets", createdAt: 2, spec: { conductor: true }, projectId: "widgets" }),
        rec({ agentId: "worker", createdAt: 3, projectId: "chimera" }),   // not a conductor -- ignored
      ],
    });
    expect(st.conductorByProject).toEqual({ chimera: "c-chimera", widgets: "c-widgets" });
  });

  it("the legacy no-project conductor (projectId null/absent) still adopts, under NO_PROJECT_CONDUCTOR_KEY", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "main", createdAt: 1, spec: { conductor: true } })],
    });
    expect(st.conductorByProject[NO_PROJECT_CONDUCTOR_KEY]).toBe("main");
    expect(legacyMainConductorId(st)).toBe("main");
  });

  it("a RUNNING conductor wins over a terminal one for the same project", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [
        rec({ agentId: "old", createdAt: 1, state: "killed", spec: { conductor: true }, projectId: "chimera" }),
        rec({ agentId: "new", createdAt: 2, state: "running", spec: { conductor: true }, projectId: "chimera" }),
      ],
    });
    expect(st.conductorByProject["chimera"]).toBe("new");
  });

  it("among two running (or two terminal) conductors for the same project, the latest createdAt wins", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [
        rec({ agentId: "later", createdAt: 20, state: "running", spec: { conductor: true }, projectId: "p" }),
        rec({ agentId: "earlier", createdAt: 10, state: "running", spec: { conductor: true }, projectId: "p" }),
      ],
    });
    expect(st.conductorByProject["p"]).toBe("later");
  });

  it("is rebuilt wholesale each snapshot -- a conductor missing from a later snapshot disappears from the map", () => {
    const first = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "c", createdAt: 1, spec: { conductor: true }, projectId: "p" })],
    });
    expect(first.conductorByProject["p"]).toBe("c");
    const second = reduce(first, { type: "agentRecords", records: [] });
    expect(second.conductorByProject).toEqual({});
  });

  // WORKFLOW-TASK-VIEW-2 (bug B): scheduler.ts forces spec.conductor:true on
  // every workflow-bound task spawn too (D12 session-liveness hack) — a
  // step agent must never be able to hijack a project's (or the legacy
  // no-project "main") conductor slot just because it happens to have a
  // later createdAt.
  it("a spec.conductor:true record carrying team membership is NOT a conductor candidate — never hijacks the slot even with a later createdAt", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [
        rec({ agentId: "main", createdAt: 1, spec: { conductor: true } }),
        rec({ agentId: "step-agent", createdAt: 2, spec: { conductor: true }, membership: { team: "team-chimera", role: "xp-glm" } }),
      ],
    });
    expect(st.conductorByProject[NO_PROJECT_CONDUCTOR_KEY]).toBe("main");
    expect(legacyMainConductorId(st)).toBe("main");
  });
});

describe("reducer: agentRecords gates AgentView.conductor on membership (WORKFLOW-TASK-VIEW-2, bug B)", () => {
  it("spec.conductor:true is projected to conductor:false when the record ALSO carries team membership", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a", createdAt: 1, spec: { conductor: true }, membership: { team: "team-chimera", role: "xp-glm" } })],
    });
    expect(st.agents["a"]!.conductor).toBe(false);
    expect(st.agents["a"]!.membership).toEqual({ team: "team-chimera", role: "xp-glm" });
  });

  it("spec.conductor:true with no membership still projects conductor:true (a real conductor)", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a", createdAt: 1, spec: { conductor: true } })],
    });
    expect(st.agents["a"]!.conductor).toBe(true);
  });
});
