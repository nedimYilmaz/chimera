import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSpecSchema, isAgentUnseen, type NormalizedEvent } from "@chimera/protocol";
import type { AgentRecord } from "@chimera/core/supervisor";
import { EventLog } from "@chimera/core/events";
import { replayAgentsAsOf, replayAgentsAsOfFromStateFile, type ReplaySnapshotSource } from "@chimera/core/replay";

function priorAgent(over: Partial<AgentRecord> & { agentId: string }): AgentRecord {
  const spec = AgentSpecSchema.parse({ prompt: "hello", cwd: "/tmp", isolation: "none" });
  return {
    spec, accountName: "main", provider: "claude", state: "running", depth: 0,
    treeId: over.agentId, createdAt: 1, principal: "local", attempts: [], costUsd: 0,
    parentId: null, projectId: null,
    ...over,
  };
}

describe("replayAgentsAsOf (R2: deterministic fold-from-log, bounded to any seq)", () => {
  it("restores an explicit live Codex risk grant from the snapshot gap", () => {
    const events = new EventLog(mkdtempSync(join(tmpdir(), "chimera-replay-risk-")));
    const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "codex-risk", provider: "codex" })], lastSeq: 0 };
    events.append({ agentId: "codex-risk", kind: "status", data: { permissionChanged: true, permissionProfile: "full", acknowledgeCodexFullAccessRisk: true } });
    expect(replayAgentsAsOf(baseline, events)[0]?.spec).toMatchObject({ permissionProfile: "full", acknowledgeCodexFullAccessRisk: true });
    expect(baseline.agents![0]?.spec.acknowledgeCodexFullAccessRisk).toBe(false);
  });

  it("recovers branch identity from the snapshot gap and ignores malformed lineage", () => {
    const events = new EventLog(mkdtempSync(join(tmpdir(), "chimera-replay-")));
    const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "child" })], lastSeq: 0 };
    const lineage = { forkedFrom: "parent", mode: "snapshot", atSeq: 17 };
    events.append({ agentId: "child", kind: "agent_started", data: { sessionId: "child-session", forkLineage: lineage } });
    events.append({ agentId: "child", kind: "status", data: { forkLineage: { ...lineage, atSeq: -1 } } });
    expect(replayAgentsAsOf(baseline, events)[0]?.forkLineage).toEqual(lineage);
    expect(baseline.agents![0]?.forkLineage).toBeUndefined();
    const later = { ...lineage, mode: "native", atSeq: 24 };
    events.append({ agentId: "child", kind: "status", data: { forkLineage: later } });
    expect(replayAgentsAsOf(baseline, events)[0]?.forkLineage).toEqual(later);
  });

  it("preserves restart counts through startup and interrupted turns, resetting only on completion", () => {
    const events = new EventLog(mkdtempSync(join(tmpdir(), "chimera-replay-")));
    const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "a1", crashCount: 3 })], lastSeq: 0 };
    events.append({ agentId: "a1", kind: "agent_started", data: { sessionId: "saved" } });
    events.append({ agentId: "a1", kind: "turn_complete", data: { interrupted: true } });
    expect(replayAgentsAsOf(baseline, events)[0]?.crashCount).toBe(3);
    events.append({ agentId: "a1", kind: "turn_complete", data: {} });
    expect(replayAgentsAsOf(baseline, events)[0]?.crashCount).toBe(0);
    events.append({ agentId: "a1", kind: "status", data: { crashCount: 2 } });
    events.append({ agentId: "a1", kind: "result", data: { text: "recovered" } });
    expect(replayAgentsAsOf(baseline, events)[0]?.crashCount).toBe(0);
  });

  it("no lastSeq on the baseline ⇒ returned unfolded (a fresh copy, not the caller's object)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-replay-"));
    const events = new EventLog(dir);
    events.append({ agentId: "a1", kind: "result", data: { text: "should never be folded in" } });
    const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "a1" })] };   // no lastSeq

    const result = replayAgentsAsOf(baseline, events);
    expect(result[0]?.state).toBe("running");   // untouched — no lastSeq means no fold at all
    expect(result[0]).not.toBe(baseline.agents![0]);   // independent copy
  });

  it("folds events strictly AFTER lastSeq up to the log's current tip when toSeq is omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-replay-"));
    const events = new EventLog(dir);
    events.append({ agentId: "a1", kind: "result", data: { text: "already reflected in the baseline" } });   // seq 1
    const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "a1" })], lastSeq: 1 };
    events.append({ agentId: "a1", kind: "status", data: { state: "paused", resumeScheduledAt: 555 } });   // seq 2, in the gap

    const result = replayAgentsAsOf(baseline, events);
    expect(result[0]?.state).toBe("paused");
    expect(result[0]?.resumeAt).toBe(555);
  });

  it("toSeq bounds the fold: an event past toSeq is excluded", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-replay-"));
    const events = new EventLog(dir);
    const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "a1" })], lastSeq: 0 };
    events.append({ agentId: "a1", kind: "status", data: { state: "paused", resumeScheduledAt: 100 } });   // seq 1
    events.append({ agentId: "a1", kind: "status", data: { state: "failed" } });                            // seq 2 — excluded below

    const asOf1 = replayAgentsAsOf(baseline, events, 1);
    expect(asOf1[0]?.state).toBe("paused");   // seq 2 not yet folded in

    const asOfLatest = replayAgentsAsOf(baseline, events);   // toSeq omitted ⇒ everything
    expect(asOfLatest[0]?.state).toBe("failed");
  });

  it("never mutates the caller's baseline object — repeated calls with different toSeq are independent", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-replay-"));
    const events = new EventLog(dir);
    const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "a1" })], lastSeq: 0 };
    events.append({ agentId: "a1", kind: "status", data: { state: "paused", resumeScheduledAt: 100 } });   // seq 1

    replayAgentsAsOf(baseline, events, 1);
    expect(baseline.agents![0]?.state).toBe("running");   // the ORIGINAL object is untouched

    const again = replayAgentsAsOf(baseline, events, 0);   // toSeq before the pause event
    expect(again[0]?.state).toBe("running");
  });

  it("an event for an agentId absent from the baseline is a no-op — no throw, no fabricated record", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-replay-"));
    const events = new EventLog(dir);
    const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "a1" })], lastSeq: 0 };
    events.append({ agentId: "never-snapshotted", kind: "result", data: {} });

    const result = replayAgentsAsOf(baseline, events);
    expect(result).toHaveLength(1);
    expect(result[0]?.agentId).toBe("a1");
  });
});

describe("replayAgentsAsOfFromStateFile (R2: boot-glue-shaped standalone post-mortem read)", () => {
  it("missing state file ⇒ []", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-replay-"));
    const events = new EventLog(dir);
    const result = replayAgentsAsOfFromStateFile("/fake/missing.json", events, undefined, (() => "{}") as never, () => false);
    expect(result).toEqual([]);
  });

  it("torn/malformed JSON ⇒ [] (no throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-replay-"));
    const events = new EventLog(dir);
    const result = replayAgentsAsOfFromStateFile("/fake/torn.json", events, undefined, (() => "{bad") as never, () => true);
    expect(result).toEqual([]);
  });

  it("happy path: reads the baseline + folds the gap, exactly like replayAgentsAsOf", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-replay-"));
    const events = new EventLog(dir);
    events.append({ agentId: "a1", kind: "status", data: { state: "paused", resumeScheduledAt: 42 } });   // seq 1
    const state = { agents: [priorAgent({ agentId: "a1" })], lastSeq: 0 };
    const readFile = (() => JSON.stringify(state)) as unknown as typeof import("node:fs").readFileSync;

    const result = replayAgentsAsOfFromStateFile("/fake/state.json", events, undefined, readFile, () => true);
    expect(result[0]?.state).toBe("paused");
    expect(result[0]?.resumeAt).toBe(42);
  });
});

// F09/A6: the stall pair must survive a restart, or a daemon reboot would either lose an unanswered
// delivery or resurrect one the agent already answered.
describe("replayAgentsAsOf (F09: the prompt-stall advisory)", () => {
  it("folds agent_prompt_stalled into the full evidence on the record", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-replay-"));
    const events = new EventLog(dir);
    const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "a1" })], lastSeq: 0 };
    events.append({ agentId: "a1", kind: "agent_prompt_stalled", data: {
      deliveryId: "msg-1", from: "conductor", sinceTs: 1_000, sinceMs: 45_000, lastSeq: 42, messageCount: 2, thresholdMs: 45_000,
    } });

    expect(replayAgentsAsOf(baseline, events)[0]?.promptStall).toEqual({
      deliveryId: "msg-1", from: "conductor", sinceTs: 1_000, sinceMs: 45_000, lastSeq: 42, messageCount: 2,
    });
  });

  it("a following status{promptStallCleared} folds back to null", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-replay-"));
    const events = new EventLog(dir);
    const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "a1" })], lastSeq: 0 };
    events.append({ agentId: "a1", kind: "agent_prompt_stalled", data: { deliveryId: "msg-1", from: "conductor", sinceTs: 1_000, sinceMs: 45_000, lastSeq: 42, messageCount: 1 } });
    events.append({ agentId: "a1", kind: "status", data: { promptStallCleared: true, deliveryId: "msg-1", ackMs: 46_000 } });

    expect(replayAgentsAsOf(baseline, events)[0]?.promptStall).toBeNull();
  });
});

// F47.QA2: the F47 seen-state stamps live on AgentRecord, so the crash-gap fold owns them too.
// SnapshotScheduler is debounced (snapshot.ts: 50 events / 2000 ms), so a crash routinely leaves
// attention events unsnapshotted; if this reducer drops them the agent comes back reading as SEEN
// and NOTHING ever re-fires the event — the operator silently loses the attention row.
describe("F47 seen stamps survive the crash-gap fold", () => {
  function gap(seed: (log: EventLog) => void): { agent: AgentRecord; events: NormalizedEvent[] } {
    const dir = mkdtempSync(join(tmpdir(), "chimera-replay-seen-"));
    const events = new EventLog(dir);
    seed(events);
    const replayed = events.replay({ fromSeq: 1, limit: 100 });
    const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "a1" }), priorAgent({ agentId: "shadow:a1:1", shadow: true })], lastSeq: 0 };
    const agents = replayAgentsAsOf(baseline, events);
    return { agent: agents.find((a) => a.agentId === "a1")!, events: replayed };
  }

  for (const kind of ["result", "error", "turn_timeout", "permission_request", "agent_question"] as const) {
    it(`stamps attentionAt from a ${kind} that landed in the gap`, () => {
      const { agent, events } = gap((log) => { log.append({ agentId: "a1", kind, data: {} }); });
      expect(agent.attentionAt).toBe(events[0]!.ts);
      expect(isAgentUnseen(agent)).toBe(true);
    });
  }

  it("folds a markSeen status{reviewedAt} that landed in the gap", () => {
    const { agent } = gap((log) => {
      log.append({ agentId: "a1", kind: "result", data: {} });
      log.append({ agentId: "a1", kind: "status", data: { state: "done", reviewedAt: Date.now() + 60_000 } });
    });
    expect(typeof agent.reviewedAt).toBe("number");
    expect(isAgentUnseen(agent)).toBe(false);
  });

  it("never stamps a shadow row (mirrors supervisor.noteAttention)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-replay-seen-"));
    const events = new EventLog(dir);
    events.append({ agentId: "shadow:a1:1", kind: "result", data: {} });
    const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "shadow:a1:1", shadow: true })], lastSeq: 0 };
    expect(replayAgentsAsOf(baseline, events)[0]?.attentionAt).toBeUndefined();
  });

  it("leaves reviewedAt alone for a status that carries none", () => {
    const { agent } = gap((log) => {
      log.append({ agentId: "a1", kind: "status", data: { state: "running" } });
    });
    expect(agent.reviewedAt).toBeUndefined();
  });
});


it("replays desired permission changes and acknowledgments independently across snapshot gaps", () => {
  const events = new EventLog(mkdtempSync(join(tmpdir(), "chimera-permission-replay-")));
  const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "a1", provider: "codex", spec: AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", isolation: "none", permissionProfile: "full", acknowledgeCodexFullAccessRisk: true }) })], lastSeq: 0 };
  const application = { version: 2, requestedProfile: "readOnly", effectiveProfile: "full", profileStatus: "pending", requestedRouting: "tui", routingStatus: "bypassed", transport: "app-server", nativeApprovals: true };
  events.append({ agentId: "a1", kind: "status", data: { permissionChanged: true, permissionProfile: "readOnly", permissionRequest: "tui", permissionApplication: application } });
  events.append({ agentId: "a1", kind: "agent_started", data: { sessionId: "saved" } });
  events.append({ agentId: "a1", kind: "status", data: { permissionApplication: { ...application, version: 1, effectiveProfile: "readOnly", profileStatus: "applied" } } });
  let replay = replayAgentsAsOf(baseline, events)[0]!;
  expect(replay.spec.permissionProfile).toBe("readOnly"); expect(replay.spec.on.permissionRequest).toBe("tui");
  expect(replay.permissionApplication).toEqual(application);
  events.append({ agentId: "a1", kind: "status", data: { permissionApplication: { ...application, version: 3, effectiveProfile: "readOnly", profileStatus: "applied", routingStatus: "applied" } } });
  replay = replayAgentsAsOf(baseline, events)[0]!;
  expect(replay.permissionApplication?.profileStatus).toBe("applied");
  expect(baseline.agents![0].spec.permissionProfile).toBe("full");
});

it("replays submitted exec and stopped/new-launch unknown state without reviving prior policy", () => {
  const events = new EventLog(mkdtempSync(join(tmpdir(), "chimera-permission-replay-")));
  const old = { version: 1, requestedProfile: "full", effectiveProfile: "full", profileStatus: "applied", requestedRouting: "auto", routingStatus: "bypassed", transport: "exec", nativeApprovals: false } as const;
  const pending = { version: 2, requestedProfile: "readOnly", profileStatus: "pending", requestedRouting: "tui", routingStatus: "unsupported", transport: "exec", nativeApprovals: false } as const;
  const baseline: ReplaySnapshotSource = { agents: [priorAgent({ agentId: "a1", provider: "codex", permissionApplication: old })], lastSeq: 0 };
  events.append({ agentId: "a1", kind: "status", data: { permissionChanged: true, permissionProfile: "readOnly", permissionRequest: "tui", permissionApplication: pending } });
  events.append({ agentId: "a1", kind: "status", data: { permissionApplication: { ...pending, profileStatus: "unverified", submittedProfile: "readOnly", submittedVersion: 2 } } });
  expect(replayAgentsAsOf(baseline, events)[0]?.permissionApplication).toMatchObject({ profileStatus: "unverified", submittedVersion: 2 });
  events.append({ agentId: "a1", kind: "status", data: { permissionApplication: { ...pending, version: 3 } } });
  events.append({ agentId: "a1", kind: "agent_started", data: { sessionId: "new-process" } });
  events.append({ agentId: "a1", kind: "status", data: { permissionChanged: true, permissionProfile: "full", permissionRequest: "auto", permissionApplication: old } });
  const replay = replayAgentsAsOf(baseline, events)[0]!;
  expect(replay.permissionApplication).toEqual({ ...pending, version: 3 });
  expect(replay.spec.permissionProfile).toBe("readOnly");
  expect(replay.spec.on.permissionRequest).toBe("tui");
});
