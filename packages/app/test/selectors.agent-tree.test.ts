import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyAgent, initialState, reduce, type AgentView, type UiState } from "@chimera/ui-state";
import { ancestorIdsOf, buildAgentRows, type AgentRow } from "../src/state/selectors";
import { groupAgentListRowsByGroup } from "../src/state/selectors.groups";
import { groupAgentListRowsByTask, type AgentListRow } from "../src/state/selectors.workflows";
import { orderAgentList, listLocations } from "../src/state/agentListOrder";

// MAIN.agent-tree — the operator-reported bug: queue-spawned workers rendered as "└" children
// of a stranger conductor and were counted into that conductor's group box. The regression net
// is an INVARIANT, not a golden row list: every indented row must be indented under something it
// is actually descended from.
function lineageViolations(state: Pick<UiState, "agents">, rows: readonly AgentRow[]): string[] {
  const bad: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.depth === 0) continue;
    let j = i - 1;
    while (j >= 0 && rows[j]!.depth >= row.depth) j--;
    if (j < 0) {
      bad.push(`${row.agentId} is indented but nothing shallower precedes it`);
      continue;
    }
    const anchor = rows[j]!.agentId;
    const a = state.agents[row.agentId]!;
    const sameTree = (state.agents[anchor]?.treeId ?? anchor) === (a.treeId ?? row.agentId);
    const related = a.parentId === anchor || a.originConductorId === anchor || sameTree || ancestorIdsOf(state.agents, row.agentId).has(anchor);
    if (!related) bad.push(`${row.agentId} indented under stranger ${anchor}`);
  }
  return bad;
}

function agent(over: Partial<AgentView> & { agentId: string }): AgentView {
  return { ...emptyAgent(over.agentId), ...over };
}

/** The reported shape, minimised. `y0` (same project as conductor B) precedes the OTHER
 * conductor `A`, which is what used to pull B's cluster away from B's workers: pre-fix,
 * groupKey keyed the workers `owner:B` while B itself keyed `project:Y`, so buildDisplayOrder
 * emitted [y0, B] at y0's position, [A] next, then [w1,w2,w3] — the three workers landing,
 * indented, right under A. */
function threeConductorState(ownerOfWorkers: "A" | "B"): Pick<UiState, "agents" | "agentOrder" | "collapsed" | "teams" | "mainConductorId"> {
  const worker = (id: string): AgentView =>
    agent({ agentId: id, treeId: id, depth: 0, displayDepth: 1, parentId: null, originConductorId: ownerOfWorkers, projectId: "Y", state: "running" });
  const agents: Record<string, AgentView> = {
    y0: agent({ agentId: "y0", treeId: "y0", depth: 0, projectId: "Y", state: "running" }),
    A: agent({ agentId: "A", treeId: "A", depth: 0, projectId: "X", conductor: true, groups: ["i-170"], state: "running" }),
    B: agent({ agentId: "B", treeId: "B", depth: 0, projectId: "Y", conductor: true, state: "running" }),
    w1: worker("w1"),
    w2: worker("w2"),
    w3: worker("w3"),
  };
  return { agents, agentOrder: ["y0", "A", "B", "w1", "w2", "w3"], collapsed: new Set<string>(), teams: { items: [] }, mainConductorId: undefined };
}

describe("agent list lineage (MAIN.agent-tree)", () => {
  it("keeps queue-spawned workers with their OWN conductor, never indented under a stranger", () => {
    const state = threeConductorState("B");
    const rows = buildAgentRows(state);
    // owner-first: B's whole cluster (B + its workers) is emitted together; A is its own cluster
    expect(rows.map((r) => r.agentId)).toEqual(["y0", "B", "w1", "w2", "w3", "A"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 1, 1, 0]);
    expect(lineageViolations(state, rows)).toEqual([]);
  });

  it("the stranger conductor's group box no longer counts another owner's workers", () => {
    const state = threeConductorState("B");
    const rows: AgentListRow[] = buildAgentRows(state);
    const out = groupAgentListRowsByGroup(rows, state.agents, [{ id: "i-170", name: "i-170", createdAt: 0, order: 0 }]);
    const box = out.find((r) => r.kind === "group") as Extract<AgentListRow, { kind: "group" }>;
    expect(box.totalCount).toBe(1); // A alone — pre-fix this was 4 (A + B's three workers)
    expect(box.memberRows.map((r) => (r as Extract<AgentListRow, { kind: "agent" }>).agentId)).toEqual(["A"]);
  });

  it("a grouped conductor's OWN owned workers stay inside its box", () => {
    const state = threeConductorState("A");
    const rows: AgentListRow[] = buildAgentRows(state);
    const out = groupAgentListRowsByGroup(rows, state.agents, [{ id: "i-170", name: "i-170", createdAt: 0, order: 0 }]);
    const box = out.find((r) => r.kind === "group") as Extract<AgentListRow, { kind: "group" }>;
    expect(box.totalCount).toBe(4);
    expect(box.memberRows.map((r) => (r as Extract<AgentListRow, { kind: "agent" }>).agentId)).toEqual(["A", "w1", "w2", "w3"]);
  });

  it("a shadow nests under its own worker, not beside it, when only its owner link survives", () => {
    // The event-fold path (applyShadowLineage) can leave a shadow's parentId null while it
    // inherits the worker's originConductorId — its only declared lineage is then the CONDUCTOR,
    // two levels up. Anchoring on the same-tree row below it keeps the "└" one level deeper.
    const agents: Record<string, AgentView> = {
      B: agent({ agentId: "B", treeId: "B", depth: 0, projectId: "Y", conductor: true, state: "running" }),
      w: agent({ agentId: "w", treeId: "w", depth: 0, displayDepth: 1, parentId: null, originConductorId: "B", projectId: "Y", state: "running" }),
      s: agent({ agentId: "s", treeId: "w", depth: 1, displayDepth: 2, parentId: null, originConductorId: "B", projectId: "Y", state: "running" }),
    };
    const state = { agents, agentOrder: ["B", "w", "s"], collapsed: new Set<string>(), teams: { items: [] }, mainConductorId: undefined };
    const rows = buildAgentRows(state);
    expect(rows.map((r) => r.agentId)).toEqual(["B", "w", "s"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(lineageViolations(state, rows)).toEqual([]);
  });

  it("holds over a real agent.list snapshot (372 anonymised records), with and without done agents", () => {
    const records = JSON.parse(readFileSync(new URL("./fixtures/agent-list-live.json", import.meta.url), "utf8")) as unknown[];
    const state = reduce(initialState, { type: "agentRecords", records } as never) as UiState;
    expect(state.agentOrder.length).toBe(records.length);
    for (const showDone of [true, false]) {
      const rows = buildAgentRows(state, "", showDone);
      expect(rows.length).toBeGreaterThan(0);
      // pre-fix: 212 violations with showDone=true, 7 with showDone=false
      expect({ showDone, bad: lineageViolations(state, rows).slice(0, 5) }).toEqual({ showDone, bad: [] });
    }
  });
});

// LIVE-SPAWN-STABILITY — the operator-visible half of the same tree: rows must not move under
// the cursor when a live event lands. Driven through `reduce` (snapshot, then events) so the
// reducer's agentOrder reconcile and the app's row builder are exercised together, exactly as
// the desktop app runs them (one agent.list at connect, then events forever).
describe("live spawns insert, they never re-sort the visible tree", () => {
  const records = JSON.parse(readFileSync(new URL("./fixtures/agent-list-live.json", import.meta.url), "utf8")) as unknown[];
  const connected = (): UiState => reduce(initialState, { type: "agentRecords", records } as never) as UiState;
  let seq = 1_000_000;
  const ev = (agentId: string, kind: string, data: Record<string, unknown>) =>
    ({ type: "event", event: { agentId, kind, ts: seq, seq: (seq += 1), data } } as never);

  it("a lineage-neutral live event leaves all 372 rows exactly where they were", () => {
    const state = connected();
    const mid = state.agentOrder[120]!;
    const a = state.agents[mid]!;
    // Pre-fix this single event moved 116 of the 372 rows, because the reconcile re-derived
    // sibling/cluster order from each row's INDEX instead of its real createdAt.
    const after = reduce(state, ev(mid, "agent_started", {
      status: "running", parentId: a.parentId, treeId: a.treeId, depth: a.depth, createdAt: a.createdAt,
    })) as UiState;
    expect(after.agentOrder).toEqual(state.agentOrder);
  });

  it("a spawn mid-list lands under its parent and leaves every other row in place", () => {
    const state = connected();
    const parent = state.agentOrder[120]!;
    const p = state.agents[parent]!;
    const after = reduce(state, ev("NEW", "agent_started", {
      status: "running", parentId: parent, treeId: p.treeId, depth: (p.depth ?? 0) + 1, createdAt: Date.now(),
    })) as UiState;
    expect(after.agentOrder.filter((id) => id !== "NEW")).toEqual(state.agentOrder);
    expect(after.agentOrder[after.agentOrder.indexOf(parent) + 1]).toBe("NEW");
    const rows = buildAgentRows(after, "", true);
    expect(lineageViolations(after, rows)).toEqual([]);
  });

  it("a queue worker spawned live lands directly after its conductor, not at the tail", () => {
    const state = connected();
    const owner = state.agentOrder[200]!;
    const after = reduce(state, ev("NEW2", "agent_started", {
      status: "running", parentId: null, treeId: "NEW2", depth: 0, originConductorId: owner, createdAt: Date.now(),
    })) as UiState;
    expect(after.agentOrder.filter((id) => id !== "NEW2")).toEqual(state.agentOrder);
    expect(after.agentOrder[after.agentOrder.indexOf(owner) + 1]).toBe("NEW2");
    expect(lineageViolations(after, buildAgentRows(after, "", true))).toEqual([]);
  });

  it("selection and the hidden-done grouping both survive a live spawn", () => {
    const base = connected();
    const selected = base.agentOrder[150]!;
    const state = reduce(base, { type: "selectAgent", agentId: selected } as never) as UiState;
    const doneBefore = buildAgentRows(state, "", false).map((r) => r.agentId);
    const parent = state.agentOrder[120]!;
    const after = reduce(state, ev("NEW3", "agent_started", {
      status: "running", parentId: parent, treeId: state.agents[parent]!.treeId, depth: 2, createdAt: Date.now(),
    })) as UiState;
    expect(after.selectedAgentId).toBe(selected);
    // Terminal agents keep dropping out under hide-done. The only rows hide-done gains are the
    // new agent and the ancestors it hangs from -- a finished parent legitimately comes BACK
    // when it has a live descendant again (keepIdsWithAncestors). Everything else is untouched.
    const revived = new Set(["NEW3", ...ancestorIdsOf(after.agents, "NEW3")]);
    const hidden = buildAgentRows(after, "", false).map((r) => r.agentId);
    expect(hidden.filter((id) => !revived.has(id))).toEqual(doneBefore.filter((id) => !revived.has(id)));
    expect(hidden).toContain("NEW3");
  });
});

it("keeps direct and queue children inside their session parent's tree and fold", () => {
  const records = [
    { agentId: "session", createdAt: 1, treeId: "session", depth: 0, spec: { session: true } },
    { agentId: "other", createdAt: 2, treeId: "other", depth: 0 },
    { agentId: "direct", createdAt: 3, parentId: "session", treeId: "session", depth: 1 },
    { agentId: "worker", createdAt: 4, originConductorId: "session", treeId: "worker", depth: 0 },
    { agentId: "shadow", createdAt: 5, parentId: "worker", originConductorId: "session", treeId: "worker", depth: 1 },
  ].map(r => ({ state: "running", accountName: "main", provider: "claude", costUsd: 0, ...r }));
  const state = reduce(initialState, { type: "agentRecords", records } as never);
  const rows = buildAgentRows(state);
  expect(rows.map(r => [r.agentId, r.depth, r.section])).toEqual([
    ["other", 0, "main"], ["session", 0, "session"], ["worker", 1, "session"], ["shadow", 2, "session"], ["direct", 1, "session"],
  ]);
  expect(buildAgentRows({ ...state, collapsed: new Set(["session"]) }).map(r => r.agentId)).toEqual(["other", "session"]);
  expect(buildAgentRows(state, "shadow").map(r => r.agentId)).toEqual(["session", "worker", "shadow"]);
  const folded = reduce({ ...state, selectedAgentId: "shadow" }, { type: "collapse", agentId: "session" });
  expect(folded.selectedAgentId).toBe("session");
});


it("workflow rows retain their owner and group through the full inspector ordering pipeline", () => {
  const state = reduce(initialState, { type: "agentRecords", records: [
    { agentId: "owner", treeId: "owner", depth: 0, groups: ["work"] },
    { agentId: "stranger", treeId: "stranger", depth: 0 },
    { agentId: "worker", treeId: "worker", depth: 0, originConductorId: "owner" },
    { agentId: "child", treeId: "worker", depth: 1, parentId: "worker" },
  ].map((r, i) => ({ ...r, state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: i })) } as never);
  const taskRows = groupAgentListRowsByTask(buildAgentRows(state), [{ taskId: "task", agentId: "worker", workflow: { name: "flow", version: 1 } }], {}, [], state.agents);
  const grouped = groupAgentListRowsByGroup(taskRows, state.agents, [{ id: "work", name: "work", order: 0, createdAt: 0 }]);
  const sorted = orderAgentList(grouped, { root: ["agent:stranger", "group:work", "task:task"] });
  expect(sorted.map(r => r.kind)).toEqual(["agent", "group"]);
  const locations = listLocations(sorted);
  expect(locations.get("task:task")).toMatchObject({ group: "work", scope: "agent:owner" });
  expect(locations.get("agent:child")).toMatchObject({ group: "work", scope: "task:task" });
});
