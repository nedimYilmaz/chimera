import { describe, it, expect } from "vitest";
import { treeOrder, type AgentRecordLite } from "@chimera/ui-state";

// INSPECTOR-PLACEMENT AUDIT (2026-08-20): a full survey of every way an agent
// record can come into existence, and where treeOrder() places its row. Root
// cause of the reported bug ("keen-okapi renders as a child of an unrelated
// conductor") lived in packages/core/src/engine.ts's resolveTaskOriginConductor
// -- it used to GUESS a conductor ("whichever teamless/projectless conductor is
// newest") whenever neither a real pusher-chain owner nor a project match
// existed, and treeOrder here trusts a present originConductorId UNCONDITIONALLY
// (see reducer.ts's "Queue/workflow ownership" splice). That guess is now `null`
// (see packages/core/test/queue-origin-conductor.test.ts for the producer-side
// fix); this file pins the CONSUMER side so a future reintroduction of guessing
// -- from ui-state's side, e.g. "fall back to some other conductor when
// originConductorId is absent" -- fails a test immediately.
//
// Expected-vs-actual table (fields as received on AgentRecordLite):
//
// | Spawn kind                          | parentId        | treeId           | depth | membership       | originConductorId                  | Renders as                                   |
// |--------------------------------------|-----------------|-------------------|-------|-------------------|--------------------------------------|-----------------------------------------------|
// | direct agent_spawn from a conductor  | conductor's id  | = conductor's own | 1     | none              | null (depth-1 direct spawn)          | child of the conductor (real parentId)        |
// | team queue drain (role worker)       | null            | own agentId       | 0     | {team, role}      | resolved owner, or null if none      | own tree, clustered under `team:<name>`; NEVER spliced elsewhere when null |
// | scheduled job {role,overrides}       | null            | own agentId       | 0     | none              | null (job spawn never sets it)       | own singleton tree, ordered by createdAt      |
// | scheduled job {team[,role]}          | null            | own agentId       | 0     | {team, role}      | resolved project owner, or null      | clustered under `team:<name>`; spliced ONLY when a real project conductor resolves |
// | workflow-bound task (task-<id>)      | inherited/null  | own or parent's   | varies| {team, role} (step)| inherited from the task chain        | same rules as team queue drain (spec.conductor forced true is membership-gated out of the conductor role, see P3-T2 tests) |
// | agent_resume of a terminal agent     | round-trips prior value verbatim (reattach.ts) | same | same | same | same | identical to whatever it had before resume -- resume never re-derives placement |
// | shadow agent (native sub-agent)      | REAL spawning parent | parent's treeId | parent.depth+1 | none (usually) | inherited from parent verbatim | direct child of its real parent, never the grandparent |
// | project/main conductor               | null            | own agentId       | 0     | none              | null                                  | its own tree/cluster, ordered by createdAt    |
// | a session                            | per spawn kind above | per spawn kind above | per spawn kind above | per spawn kind above | per spawn kind above | IDENTICAL placement rules -- `session` is an orthogonal presentation-layer flag (TUI's buildAgentRows partitions main/session AFTER treeOrder; it does not affect tree grouping) |

function rec(over: Partial<AgentRecordLite> & { agentId: string; createdAt: number }): AgentRecordLite {
  return { state: "running", accountName: "main", provider: "claude", costUsd: 0, ...over };
}

describe("INSPECTOR-PLACEMENT AUDIT: treeOrder per spawn kind", () => {
  it("direct agent_spawn from a conductor: real parentId nests the child directly under it", () => {
    const conductor = rec({ agentId: "conductor", treeId: "conductor", depth: 0, createdAt: 1, spec: { conductor: true } });
    const child = rec({ agentId: "child", treeId: "conductor", depth: 1, createdAt: 2, parentId: "conductor" });
    expect(treeOrder([conductor, child])).toEqual(["conductor", "child"]);
  });

  it("team queue drain: a role worker with NO resolvable owner (originConductorId null) is its OWN tree, never spliced under an unrelated present conductor", () => {
    const unrelated = rec({ agentId: "unrelated-conductor", treeId: "unrelated-conductor", depth: 0, createdAt: 1, spec: { conductor: true } });
    const worker = rec({ agentId: "keen-okapi", treeId: "keen-okapi", depth: 0, createdAt: 2, parentId: null, membership: { team: "evetle-platform", role: "reviewer" }, originConductorId: null });
    // No splice happens: order is by cluster createdAt (unrelated's tree first, keen-okapi's team-cluster second), NOT keen-okapi nested under unrelated-conductor.
    expect(treeOrder([unrelated, worker])).toEqual(["unrelated-conductor", "keen-okapi"]);
  });

  it("team queue drain: a role worker WITH a real resolved owner IS spliced directly after that conductor", () => {
    const owner = rec({ agentId: "team-owner-conductor", treeId: "team-owner-conductor", depth: 0, createdAt: 1, spec: { conductor: true } });
    const other = rec({ agentId: "other-tree", treeId: "other-tree", depth: 0, createdAt: 2 });
    const worker = rec({ agentId: "worker", treeId: "worker", depth: 0, createdAt: 3, parentId: null, membership: { team: "crew", role: "dev" }, originConductorId: "team-owner-conductor" });
    expect(treeOrder([owner, other, worker])).toEqual(["team-owner-conductor", "worker", "other-tree"]);
  });

  it("scheduled job {role,overrides} target: fresh spawn, no team, no origin conductor -> own singleton tree ordered by createdAt", () => {
    const before = rec({ agentId: "before", treeId: "before", depth: 0, createdAt: 1 });
    const jobRun = rec({ agentId: "job-run", treeId: "job-run", depth: 0, createdAt: 2, parentId: null, membership: undefined, originConductorId: null });
    expect(treeOrder([before, jobRun])).toEqual(["before", "job-run"]);
  });

  it("scheduled job {team[,role]} target: pushed with no resolvable owner -> clusters under its OWN team, not any unrelated conductor", () => {
    const unrelated = rec({ agentId: "unrelated-conductor", treeId: "unrelated-conductor", depth: 0, createdAt: 1, spec: { conductor: true } });
    const jobWorker1 = rec({ agentId: "job-w1", treeId: "job-w1", depth: 0, createdAt: 2, membership: { team: "reporting", role: "analyst" }, originConductorId: null });
    const jobWorker2 = rec({ agentId: "job-w2", treeId: "job-w2", depth: 0, createdAt: 3, membership: { team: "reporting", role: "analyst" }, originConductorId: null });
    // Both team members cluster together (contiguous), and neither nests under "unrelated-conductor".
    expect(treeOrder([unrelated, jobWorker1, jobWorker2])).toEqual(["unrelated-conductor", "job-w1", "job-w2"]);
  });

  it("agent_resume of a terminal agent: placement is whatever was persisted -- resume never re-derives it", () => {
    const conductor = rec({ agentId: "conductor", treeId: "conductor", depth: 0, createdAt: 1, spec: { conductor: true } });
    // Resumed record round-trips its ORIGINAL parentId/treeId/depth/originConductorId verbatim.
    const resumed = rec({ agentId: "resumed-agent", treeId: "conductor", depth: 1, createdAt: 2, parentId: "conductor", state: "running" });
    expect(treeOrder([conductor, resumed])).toEqual(["conductor", "resumed-agent"]);
  });

  it("shadow agent: nests under its REAL spawning parent, not the grandparent, even across a team-owned tree", () => {
    const owner = rec({ agentId: "owner-conductor", treeId: "owner-conductor", depth: 0, createdAt: 1, spec: { conductor: true } });
    const worker = rec({ agentId: "worker", treeId: "worker", depth: 0, createdAt: 2, membership: { team: "crew", role: "dev" }, originConductorId: "owner-conductor" });
    const shadow = rec({ agentId: "shadow", treeId: "worker", depth: 1, createdAt: 3, parentId: "worker", originConductorId: "owner-conductor", shadow: true });
    expect(treeOrder([owner, worker, shadow])).toEqual(["owner-conductor", "worker", "shadow"]);
  });

  it("project/main conductor: its own tree, no parent, no origin conductor", () => {
    const other = rec({ agentId: "other", treeId: "other", depth: 0, createdAt: 1 });
    const conductor = rec({ agentId: "main-conductor", treeId: "main-conductor", depth: 0, createdAt: 2, spec: { conductor: true }, originConductorId: null });
    expect(treeOrder([other, conductor])).toEqual(["other", "main-conductor"]);
  });

  it("a session: `session`-tier is orthogonal to tree placement -- a session record with no membership/parent orders exactly like any other root", () => {
    const before = rec({ agentId: "before", treeId: "before", depth: 0, createdAt: 1 });
    const session = rec({ agentId: "session-1", treeId: "session-1", depth: 0, createdAt: 2, parentId: null, membership: undefined, originConductorId: null });
    expect(treeOrder([before, session])).toEqual(["before", "session-1"]);
  });
});
