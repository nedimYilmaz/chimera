import { describe, it, expect } from "vitest";
import { reduce, treeOrder } from "@chimera/ui-state";
import { initialState, type AgentRecordLite } from "@chimera/ui-state";

// Task STREE: pure treeOrder(records) — groups by treeId, root first, then
// descendants by (depth, createdAt); groups ordered by each root's createdAt;
// no-treeId records fall back to singleton groups (flat list unchanged).

function rec(over: Partial<AgentRecordLite> & { agentId: string; createdAt: number }): AgentRecordLite {
  return { state: "running", accountName: "main", provider: "claude", costUsd: 0, ...over };
}

describe("treeOrder (pure helper)", () => {
  it("brief test 1: root + child nest, standalone stays after — [R, C1, S]", () => {
    const R = rec({ agentId: "R", treeId: "R", depth: 0, createdAt: 1 });
    const C1 = rec({ agentId: "C1", treeId: "R", depth: 1, createdAt: 2 });
    const S = rec({ agentId: "S", treeId: "S", depth: 0, createdAt: 3 });
    expect(treeOrder([R, C1, S])).toEqual(["R", "C1", "S"]);
  });

  it("two children of the same root are BOTH placed after the root, ordered by (depth, createdAt)", () => {
    const R = rec({ agentId: "R", treeId: "R", depth: 0, createdAt: 1 });
    const C2 = rec({ agentId: "C2", treeId: "R", depth: 1, createdAt: 5 });
    const C1 = rec({ agentId: "C1", treeId: "R", depth: 1, createdAt: 2 });
    // fed out of createdAt order deliberately
    expect(treeOrder([C2, R, C1])).toEqual(["R", "C1", "C2"]);
  });

  it("TRUE-NESTING: a grandchild (depth 2) nests DIRECTLY under its depth-1 parent in DFS pre-order", () => {
    // createdAt is causal (a parent exists before its child), so the DFS walk
    // attributes GC to its real parent C (updated from the old flat (depth,
    // createdAt) sort, which happened to yield the same order here only because
    // the tree was a single chain).
    const R = rec({ agentId: "R", treeId: "R", depth: 0, createdAt: 1 });
    const C = rec({ agentId: "C", treeId: "R", depth: 1, createdAt: 2 });
    const GC = rec({ agentId: "GC", treeId: "R", depth: 2, createdAt: 3 });
    expect(treeOrder([R, GC, C])).toEqual(["R", "C", "GC"]);
  });

  it("TRUE-NESTING: a grandchild nests under ITS child, not a sibling of that child", () => {
    // R spawns C1; C1 spawns G; later R spawns C2. DFS pre-order must place G
    // right after C1 (its parent), NOT after C2 -- the exact bug the flat
    // (depth,createdAt) sort caused (G, a depth-2 node, landed after every
    // depth-1 node, i.e. as a sibling of its uncle C2).
    const R = rec({ agentId: "R", treeId: "R", depth: 0, createdAt: 1 });
    const C1 = rec({ agentId: "C1", treeId: "R", depth: 1, createdAt: 2 });
    const G = rec({ agentId: "G", treeId: "R", depth: 2, createdAt: 3 });
    const C2 = rec({ agentId: "C2", treeId: "R", depth: 1, createdAt: 4 });
    expect(treeOrder([R, C1, G, C2])).toEqual(["R", "C1", "G", "C2"]);
  });

  it("TRUE-NESTING: a root worker's two children both nest under it (the self-verify reviewer case)", () => {
    // A team worker is its own tree root (depth 0); the two reviewers it spawns
    // are depth-1 children of that root -> both directly after it.
    const W = rec({ agentId: "W", treeId: "W", depth: 0, createdAt: 1 });
    const V1 = rec({ agentId: "V1", treeId: "W", depth: 1, createdAt: 2 });
    const V2 = rec({ agentId: "V2", treeId: "W", depth: 1, createdAt: 3 });
    expect(treeOrder([W, V2, V1])).toEqual(["W", "V1", "V2"]);
  });

  it("brief test 2: flat/no-treeId records preserve input order (no tree data -> unchanged)", () => {
    const a = rec({ agentId: "a", createdAt: 1 });
    const b = rec({ agentId: "b", createdAt: 2 });
    const c = rec({ agentId: "c", createdAt: 3 });
    expect(treeOrder([a, b, c])).toEqual(["a", "b", "c"]);
  });

  it("brief test 2: a single agent orders to itself", () => {
    const a = rec({ agentId: "solo", createdAt: 1 });
    expect(treeOrder([a])).toEqual(["solo"]);
  });

  it("an empty records array returns an empty order", () => {
    expect(treeOrder([])).toEqual([]);
  });

  it("groups are ordered by each root's createdAt, not input array order", () => {
    const R1 = rec({ agentId: "R1", treeId: "R1", depth: 0, createdAt: 20 });
    const R2 = rec({ agentId: "R2", treeId: "R2", depth: 0, createdAt: 10 });
    expect(treeOrder([R1, R2])).toEqual(["R2", "R1"]);
  });

  it("no exact root in a tree (agentId never equals treeId) falls back to lowest-depth/earliest-createdAt as root", () => {
    // treeId "ghost" never appears as an agentId — both members are "children"
    const a = rec({ agentId: "a", treeId: "ghost", depth: 1, createdAt: 5 });
    const b = rec({ agentId: "b", treeId: "ghost", depth: 0, createdAt: 9 });
    // b has the lowest depth -> becomes root even though a is older
    expect(treeOrder([a, b])).toEqual(["b", "a"]);
  });

  it("no exact root + tied depth breaks the root pick by earliest createdAt", () => {
    const a = rec({ agentId: "a", treeId: "ghost", depth: 1, createdAt: 9 });
    const b = rec({ agentId: "b", treeId: "ghost", depth: 1, createdAt: 5 });
    expect(treeOrder([a, b])).toEqual(["b", "a"]);
  });

  it("a record missing depth is treated as depth 0 for both root-selection and descendant ordering", () => {
    const noDepth = rec({ agentId: "nd", treeId: "R", createdAt: 2 }); // depth omitted
    const R = rec({ agentId: "R", treeId: "R", depth: 0, createdAt: 1 });
    const deeper = rec({ agentId: "deep", treeId: "R", depth: 1, createdAt: 3 });
    expect(treeOrder([deeper, noDepth, R])).toEqual(["R", "nd", "deep"]);
  });

  it("mixed tree + standalone groups interleave correctly by root createdAt", () => {
    const R = rec({ agentId: "R", treeId: "R", depth: 0, createdAt: 10 });
    const C1 = rec({ agentId: "C1", treeId: "R", depth: 1, createdAt: 11 });
    const solo1 = rec({ agentId: "solo1", createdAt: 5 });   // no treeId -> singleton, sorts before R's group
    const solo2 = rec({ agentId: "solo2", createdAt: 20 });  // sorts after R's group
    expect(treeOrder([R, C1, solo1, solo2])).toEqual(["solo1", "R", "C1", "solo2"]);
  });

  it("ties in root createdAt across groups preserve first-seen (input) order — stable, no Math.random/Date.now", () => {
    const R1 = rec({ agentId: "R1", treeId: "R1", depth: 0, createdAt: 100 });
    const R2 = rec({ agentId: "R2", treeId: "R2", depth: 0, createdAt: 100 });
    expect(treeOrder([R1, R2])).toEqual(["R1", "R2"]);
    expect(treeOrder([R2, R1])).toEqual(["R2", "R1"]);
  });

  // Task TRUE-NESTING: team CLUSTERING -- a team's separately-rooted depth-0
  // workers, created interleaved in time with other trees, must render as ONE
  // contiguous run (so AgentList emits a single team header), not scattered by
  // per-root createdAt (which caused the duplicate "▸ team" headers the user saw).
  it("TEAM-CLUSTER: two same-team workers interleaved with a teamless tree still cluster contiguously", () => {
    const w1 = rec({ agentId: "w1", treeId: "w1", depth: 0, createdAt: 1, membership: { team: "crew", role: "staff" } });
    const solo = rec({ agentId: "solo", treeId: "solo", depth: 0, createdAt: 2 }); // teamless, created BETWEEN the two workers
    const w2 = rec({ agentId: "w2", treeId: "w2", depth: 0, createdAt: 3, membership: { team: "crew", role: "staff" } });
    // old per-root sort -> [w1, solo, w2] (scattered); clustering -> [w1, w2, solo].
    expect(treeOrder([w1, solo, w2])).toEqual(["w1", "w2", "solo"]);
  });

  it("TEAM-CLUSTER: a worker's own reviewer stays nested with its worker inside the cluster (DFS within the tree)", () => {
    const w1 = rec({ agentId: "w1", treeId: "w1", depth: 0, createdAt: 1, membership: { team: "crew", role: "staff" } });
    const w2 = rec({ agentId: "w2", treeId: "w2", depth: 0, createdAt: 3, membership: { team: "crew", role: "staff" } });
    // w1 spawns a reviewer LATER (t4) -- it shares w1's treeId at depth 1 and
    // rides the SAME cluster, staying directly after w1 (not after w2).
    const rev = rec({ agentId: "rev", treeId: "w1", depth: 1, createdAt: 4, membership: { team: "crew", role: "staff" } });
    expect(treeOrder([w1, w2, rev])).toEqual(["w1", "rev", "w2"]);
  });

  it("TEAM-CLUSTER: two DIFFERENT teams each cluster once, ordered by earliest root createdAt", () => {
    const a1 = rec({ agentId: "a1", treeId: "a1", depth: 0, createdAt: 1, membership: { team: "alpha", role: "r" } });
    const b1 = rec({ agentId: "b1", treeId: "b1", depth: 0, createdAt: 2, membership: { team: "beta", role: "r" } });
    const a2 = rec({ agentId: "a2", treeId: "a2", depth: 0, createdAt: 3, membership: { team: "alpha", role: "r" } });
    // alpha (earliest root t1) clusters before beta (t2); each team contiguous.
    expect(treeOrder([a1, b1, a2])).toEqual(["a1", "a2", "b1"]);
  });

  // INSPECTOR-WRONG-PARENT: a queue-spawned worker has parentId: null and its own
  // treeId, so it roots as a singleton. originConductorId is the durable owner --
  // treeOrder must splice its whole block right after that owner, not wherever it
  // happens to fall in input/positional order (the live bug: it rendered under
  // WHICHEVER conductor preceded it in agentOrder).
  it("OWNER-SPLICE: a parentId:null worker nests under its originConductorId owner, not an unrelated conductor that precedes it in input order", () => {
    const wrongConductor = rec({ agentId: "main-conductor", treeId: "main-conductor", depth: 0, createdAt: 1 });
    const worker = rec({
      agentId: "qa-worker", treeId: "qa-worker", depth: 0, createdAt: 2,
      parentId: null, originConductorId: "vonitor-conductor",
    });
    const rightConductor = rec({ agentId: "vonitor-conductor", treeId: "vonitor-conductor", depth: 0, createdAt: 3 });
    // Adversarial: wrongConductor sorts first by createdAt/input order, exactly as in the live bug.
    expect(treeOrder([wrongConductor, worker, rightConductor])).toEqual([
      "main-conductor", "vonitor-conductor", "qa-worker",
    ]);
  });

  it("OWNER-SPLICE: parentId wins over originConductorId when both resolve", () => {
    const parent = rec({ agentId: "real-parent", treeId: "real-parent", depth: 0, createdAt: 1 });
    const otherConductor = rec({ agentId: "other-conductor", treeId: "other-conductor", depth: 0, createdAt: 2 });
    const child = rec({
      agentId: "child", treeId: "real-parent", depth: 1, createdAt: 3,
      parentId: "real-parent", originConductorId: "other-conductor",
    });
    // real spawn parent wins: child nests under real-parent, not spliced to other-conductor.
    expect(treeOrder([parent, otherConductor, child])).toEqual(["real-parent", "child", "other-conductor"]);
  });

  it("OWNER-SPLICE: originConductorId pointing outside the record set keys as its own root, unchanged from today", () => {
    const worker = rec({
      agentId: "orphan-worker", treeId: "orphan-worker", depth: 0, createdAt: 1,
      parentId: null, originConductorId: "not-in-set",
    });
    const other = rec({ agentId: "other", treeId: "other", depth: 0, createdAt: 2 });
    expect(treeOrder([worker, other])).toEqual(["orphan-worker", "other"]);
  });

  it("OWNER-SPLICE: originConductorId: null keys as its own root, unchanged from today", () => {
    const worker = rec({
      agentId: "worker", treeId: "worker", depth: 0, createdAt: 1,
      parentId: null, originConductorId: null,
    });
    const other = rec({ agentId: "other", treeId: "other", depth: 0, createdAt: 2 });
    expect(treeOrder([worker, other])).toEqual(["worker", "other"]);
  });

  it("OWNER-SPLICE: a cyclic originConductorId pair terminates and does not hang", () => {
    const a = rec({ agentId: "a", treeId: "a", depth: 0, createdAt: 1, originConductorId: "b" });
    const b = rec({ agentId: "b", treeId: "b", depth: 0, createdAt: 2, originConductorId: "a" });
    const result = treeOrder([a, b]);
    expect(new Set(result)).toEqual(new Set(["a", "b"]));
    expect(result.length).toBe(2);
  });
});

describe("reducer: agentRecords projects treeId/depth and tree-orders agentOrder", () => {
  it("sets treeId/depth on each AgentView and nests the child after the parent in agentOrder", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [
        { agentId: "parent", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, treeId: "parent", depth: 0 },
        { agentId: "child", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 2, treeId: "parent", depth: 1 },
      ],
    });
    expect(st.agentOrder).toEqual(["parent", "child"]);
    expect(st.agents["parent"]!.treeId).toBe("parent");
    expect(st.agents["parent"]!.depth).toBe(0);
    expect(st.agents["child"]!.treeId).toBe("parent");
    expect(st.agents["child"]!.depth).toBe(1);
  });

  it("regression: a records list with no treeId/depth (older daemon shape) renders flat exactly as before (createdAt order)", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [
        { agentId: "b", state: "killed", accountName: "second", provider: "claude", costUsd: 0.5, createdAt: 20, spec: { conductor: true } },
        { agentId: "a", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 10 },
      ],
    });
    expect(st.agentOrder).toEqual(["a", "b"]);
    expect(st.agents["a"]!.treeId).toBeUndefined();
    expect(st.agents["a"]!.depth).toBeUndefined();
  });

  it("a non-string treeId or non-number depth on the wire is defensively ignored (falls back to prior/undefined, never crashes)", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      // @ts-expect-error -- deliberately malformed wire shape, exercised defensively
      records: [{ agentId: "x", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, treeId: 42, depth: "deep" }],
    });
    expect(st.agents["x"]!.treeId).toBeUndefined();
    expect(st.agents["x"]!.depth).toBeUndefined();
    expect(st.agentOrder).toEqual(["x"]);
  });

  it("a defensive treeId/depth update does not clobber a PRIOR valid value with a later malformed one", () => {
    const withTree = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "x", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, treeId: "x", depth: 0 }],
    });
    expect(withTree.agents["x"]!.treeId).toBe("x");
    const st = reduce(withTree, {
      type: "agentRecords",
      // @ts-expect-error -- malformed second snapshot
      records: [{ agentId: "x", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, treeId: 42, depth: "nope" }],
    });
    expect(st.agents["x"]!.treeId).toBe("x");  // prior valid value survives the defensive guard
    expect(st.agents["x"]!.depth).toBe(0);
  });

  // Task SHADOW-ACT: shadowInfo rides the same agentRecords snapshot.
  it("projects shadowInfo authoritative-when-present, and a later snapshot without it keeps the prior value", () => {
    const first = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "shadow:p:T1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, shadow: true, label: "rev", shadowInfo: { description: "review", lastToolName: "Read" } }],
    });
    expect(first.agents["shadow:p:T1"]!.shadow).toBe(true);
    expect(first.agents["shadow:p:T1"]!.shadowInfo).toEqual({ description: "review", lastToolName: "Read" });
    // A poll snapshot that omits shadowInfo (e.g. between rich agent_tasks) must not wipe it.
    const second = reduce(first, {
      type: "agentRecords",
      records: [{ agentId: "shadow:p:T1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, shadow: true, label: "rev" }],
    });
    expect(second.agents["shadow:p:T1"]!.shadowInfo).toEqual({ description: "review", lastToolName: "Read" });
  });
});

// R2 (inline sub-agent/workflow surfacing): projectEvent's Id rule (a) treats any ':'-namespaced
// agentId as a Phase 2 coordination entity (team:/queue:/task:) and returns EARLY, before the
// per-agent switch that handles message_complete/tool_call/tool_result. A shadow's agentId
// (`shadow:<parent>:<taskId>`) also contains colons but IS a real (synthetic) agent — supervisor.ts
// now routes subagent-tagged transcript events under exactly this id (core's supervisor-shadow.test
// covers the daemon side), so the reducer must exempt it or the whole feature silently no-ops
// client-side despite correct daemon-side plumbing.
describe("reducer: a shadow-routed live event reaches the normal per-agent projection (R2)", () => {
  it("a message_complete for a 'shadow:' agentId lands in that agent's OWN transcript, not the coordination-entity branch", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "shadow:parent-1:T1", kind: "message_complete", data: { text: "sub-agent says hi" } },
    });
    expect(st.agents["shadow:parent-1:T1"]).toBeDefined();
    expect(st.agents["shadow:parent-1:T1"]!.transcript).toMatchObject([
      { role: "assistant", text: "sub-agent says hi", streaming: false },
    ]);
    // The normal per-agent path also adds the shadow to agentOrder and (nothing else selected)
    // auto-selects it — proving this really is the SAME switch every real agent goes through.
    expect(st.agentOrder).toContain("shadow:parent-1:T1");
  });

  it("a tool_call/tool_result pair for a 'shadow:' agentId projects into its tools/transcript exactly like a real agent", () => {
    const withCall = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "shadow:parent-1:T1", kind: "tool_call", data: { toolName: "Read", toolId: "tu_1" } },
    });
    expect(withCall.agents["shadow:parent-1:T1"]!.tools).toEqual([{ ts: 1, toolId: "tu_1", toolName: "Read", input: undefined, status: "called" }]);
    const withResult = reduce(withCall, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "shadow:parent-1:T1", kind: "tool_result", data: { toolId: "tu_1", result: "file contents" } },
    });
    expect(withResult.agents["shadow:parent-1:T1"]!.tools[0]!.status).toBe("done");
  });

  it("REGRESSION: a non-shadow ':'-namespaced agentId (team:/queue:/task:) still stays out of the agent list, exactly as before", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "team:crew", kind: "message_complete", data: { text: "should not become an agent" } },
    });
    expect(st.agents["team:crew"]).toBeUndefined();
    expect(st.agentOrder).not.toContain("team:crew");
    // Still logged in the global feed — the guard fix narrows to ONLY the shadow: prefix, it
    // doesn't widen the exemption or drop coverage for the coordination-entity path.
    expect(st.events.some((e) => e.agentId === "team:crew")).toBe(true);
  });
});

// BUG shadow-live-state: a CONDUCTOR's own native Agent/Task-tool sub-agent (or any shadow) must
// surface its real state/label from the LIVE event stream alone — the desktop app only re-fetches
// the agent.list snapshot on connect/reconnect (createStore.ts's connectAndLoad has no polling
// refresh, by design), so a shadow created mid-session previously sat at emptyAgent's default
// (state:"unknown", shadow:undefined -> displayName falls through to the hashed FNV name instead
// of the label) until/unless a snapshot happened to land. supervisor.ts's upsertShadow/
// terminateShadows now mirror the shadow's own agent_task event under its OWN agentId (in addition
// to the pre-existing parent-directed copy that feeds the parent's flowTree) — these tests drive
// ONLY that live event, with no "agentRecords" snapshot action at all, reproducing the app's real
// no-polling world end to end.
describe("reducer: a shadow row's state/label reflect the CORE record from live events alone, no agent.list snapshot needed (BUG shadow-live-state)", () => {
  it("FAILS BEFORE THE FIX: a shadow's first agent_task sighting sets shadow:true + its subagentType label, not the emptyAgent default", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "shadow:conductor-1:T1", kind: "agent_task", data: { taskId: "T1", subagentType: "Explore", status: "running" } },
    });
    const row = st.agents["shadow:conductor-1:T1"]!;
    expect(row.shadow).toBe(true);
    expect(row.label).toBe("Explore");
    expect(row.state).toBe("running");
  });

  it("FAILS BEFORE THE FIX: a terminal agent_task (parent finished, terminateShadows' forced flip) resolves state to 'done' and keeps the established label — never 'unknown' or a hashed name", () => {
    const started = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "shadow:conductor-1:T1", kind: "agent_task", data: { taskId: "T1", subagentType: "Explore", status: "running" } },
    });
    // terminateShadows' synthetic companion event carries no subagentType/workflowName/description
    // (see supervisor.ts) — state-only, must never clobber the already-established label.
    const done = reduce(started, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "shadow:conductor-1:T1", kind: "agent_task", data: { status: "completed" } },
    });
    const row = done.agents["shadow:conductor-1:T1"]!;
    expect(row.state).toBe("done");
    expect(row.label).toBe("Explore");
    expect(row.shadow).toBe(true);
  });

  it("a later description-only update never downgrades an established strong (subagentType/workflowName) label", () => {
    const started = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "shadow:conductor-1:T2", kind: "agent_task", data: { taskId: "T2", workflowName: "spec", status: "running" } },
    });
    const progressed = reduce(started, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "shadow:conductor-1:T2", kind: "agent_task", data: { description: "thinking...", status: "running" } },
    });
    expect(progressed.agents["shadow:conductor-1:T2"]!.label).toBe("spec");
  });
});

// LINEAGE (shadow-live-state's remainder): the shadow-directed agent_task re-emit now also
// carries parentId/treeId/depth/projectId/membership (supervisor.ts's upsertShadow/
// terminateShadows) — without these an event-only shadow rendered detached at the top level
// (app selectors.ts's groupKey falls back to a singleton `tree:<ownId>` cluster when treeId is
// undefined). These tests drive the reducer with ONLY live events, no agentRecords snapshot.
describe("reducer: a shadow row's lineage (parentId/treeId/depth) is set from live events alone, no agent.list snapshot needed", () => {
  it("an agent_task carrying lineage fields sets parentId/treeId/depth/projectId/membership on the shadow", () => {
    const st = reduce(initialState, {
      type: "event",
      event: {
        ts: 1, seq: 1, agentId: "shadow:conductor-1:T1", kind: "agent_task",
        data: {
          taskId: "T1", subagentType: "Explore", status: "running",
          parentId: "conductor-1", treeId: "conductor-1", depth: 1, projectId: "proj-a",
          membership: { team: "crew", role: "worker" },
        },
      },
    });
    const row = st.agents["shadow:conductor-1:T1"]!;
    expect(row.parentId).toBe("conductor-1");
    expect(row.treeId).toBe("conductor-1");
    expect(row.depth).toBe(1);
    expect(row.projectId).toBe("proj-a");
    expect(row.membership).toEqual({ team: "crew", role: "worker" });
  });

  it("FALLBACK (older daemon, no lineage fields): parentId is derived from the shadow id itself, and treeId/depth are borrowed from the already-projected parent", () => {
    const withParent = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "conductor-1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, treeId: "conductor-1", depth: 0 }],
    });
    const st = reduce(withParent, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "shadow:conductor-1:T1", kind: "agent_task", data: { taskId: "T1", subagentType: "Explore", status: "running" } },
    });
    const row = st.agents["shadow:conductor-1:T1"]!;
    expect(row.parentId).toBe("conductor-1");
    expect(row.treeId).toBe("conductor-1");
    expect(row.depth).toBe(1);
  });

  it("FALLBACK: parentId is still derived from the shadow id even when the parent has no client-side projection yet (treeId/depth stay undefined, best-effort)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "shadow:unknown-parent:T1", kind: "agent_task", data: { taskId: "T1", subagentType: "Explore", status: "running" } },
    });
    const row = st.agents["shadow:unknown-parent:T1"]!;
    expect(row.parentId).toBe("unknown-parent");
    expect(row.treeId).toBeUndefined();
    expect(row.depth).toBeUndefined();
  });

  it("a later state-only event (terminateShadows' synthetic companion, no lineage fields) never clobbers an already-established parentId/treeId/depth", () => {
    const started = reduce(initialState, {
      type: "event",
      event: {
        ts: 1, seq: 1, agentId: "shadow:conductor-1:T1", kind: "agent_task",
        data: { taskId: "T1", subagentType: "Explore", status: "running", parentId: "conductor-1", treeId: "conductor-1", depth: 1 },
      },
    });
    const done = reduce(started, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "shadow:conductor-1:T1", kind: "agent_task", data: { status: "completed" } },
    });
    const row = done.agents["shadow:conductor-1:T1"]!;
    expect(row.state).toBe("done");
    expect(row.parentId).toBe("conductor-1");
    expect(row.treeId).toBe("conductor-1");
    expect(row.depth).toBe(1);
  });

  it("existing state/label folding stays byte-identical alongside the new lineage fold", () => {
    const st = reduce(initialState, {
      type: "event",
      event: {
        ts: 1, seq: 1, agentId: "shadow:conductor-1:T1", kind: "agent_task",
        data: { taskId: "T1", workflowName: "spec", status: "running", parentId: "conductor-1", treeId: "conductor-1", depth: 1 },
      },
    });
    const row = st.agents["shadow:conductor-1:T1"]!;
    expect(row.label).toBe("spec");
    expect(row.state).toBe("running");
    expect(row.shadow).toBe(true);
  });
});

// SHADOW-NESTING-UI: the app's AgentList indents on `displayDepth` (raw depth + the conductor-
// owned +1 bump). A queue-spawned team worker carries originConductorId (=> its own displayDepth
// is bumped), so a shadow it spawns must ALSO carry originConductorId and a matching displayDepth
// bump, else the shadow renders one indent too shallow — a SIBLING of the worker directly under
// the conductor instead of nested one level deeper under the worker. These lock the event-fold
// path (no agent.list snapshot) to produce the SAME originConductorId/displayDepth the poll
// snapshot does.
describe("reducer: a shadow's originConductorId + displayDepth are set from live events alone (SHADOW-NESTING-UI)", () => {
  it("event-carried originConductorId is folded, and displayDepth = depth + owner bump (a queue-worker's shadow nests UNDER the worker, not beside it)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: {
        ts: 1, seq: 1, agentId: "shadow:worker-1:T1", kind: "agent_task",
        data: {
          taskId: "T1", subagentType: "Explore", status: "running",
          parentId: "worker-1", treeId: "worker-1", depth: 1, projectId: null,
          originConductorId: "cond-1", membership: { team: "crew", role: "worker" },
        },
      },
    });
    const row = st.agents["shadow:worker-1:T1"]!;
    expect(row.originConductorId).toBe("cond-1");
    // worker (depth 0, owned) => displayDepth 1; its shadow (depth 1, owned) => displayDepth 2.
    expect(row.displayDepth).toBe(2);
  });

  it("INHERIT (older daemon, no originConductorId on the wire): the shadow borrows its projected parent's owner and still bumps displayDepth", () => {
    const withWorker = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "worker-1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, treeId: "worker-1", depth: 0, originConductorId: "cond-1" }],
    });
    const st = reduce(withWorker, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "shadow:worker-1:T1", kind: "agent_task", data: { taskId: "T1", subagentType: "Explore", status: "running" } },
    });
    const row = st.agents["shadow:worker-1:T1"]!;
    expect(row.originConductorId).toBe("cond-1"); // inherited from the parent worker
    expect(row.depth).toBe(1);                     // borrowed parent.depth + 1
    expect(row.displayDepth).toBe(2);              // owner bump applied
  });

  it("a CONDUCTOR's own direct shadow keeps displayDepth = depth (owner null => no bump), so it nests under the conductor", () => {
    const withCond = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "cond-1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, treeId: "cond-1", depth: 0, originConductorId: null, spec: { conductor: true } }],
    });
    const st = reduce(withCond, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "shadow:cond-1:T1", kind: "agent_task", data: { taskId: "T1", subagentType: "Explore", status: "running", parentId: "cond-1", treeId: "cond-1", depth: 1, originConductorId: null } },
    });
    const row = st.agents["shadow:cond-1:T1"]!;
    expect(row.originConductorId).toBeNull();
    expect(row.displayDepth).toBe(1); // depth 1, no bump -> one under the conductor (displayDepth 0)
  });
});

it("inserts owned queue trees beside a nested owner before that owner's sibling", () => {
  const records = [
    { agentId: "root", treeId: "root", depth: 0 },
    { agentId: "owner", parentId: "root", treeId: "root", depth: 1 },
    { agentId: "sibling", parentId: "root", treeId: "root", depth: 1 },
    { agentId: "queue-worker", originConductorId: "owner", treeId: "queue-worker", depth: 0 },
    { agentId: "grandchild", parentId: "queue-worker", treeId: "queue-worker", depth: 1 },
  ].map((r, i) => rec({ ...r, createdAt: i }));
  expect(treeOrder(records)).toEqual(["root", "owner", "queue-worker", "grandchild", "sibling"]);
});
