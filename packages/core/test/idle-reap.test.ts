import { describe, it, expect, vi } from "vitest";
import { HealthMonitor } from "@chimera/core/health";
import type { AgentRecord } from "@chimera/core/supervisor";
import type { NormalizedEvent } from "@chimera/protocol";

// IDLE-REAP: an agent that has sat idle BETWEEN TURNS for the configured window has its OS
// process released — the record and its session survive, so the next message (or mail landing in
// its box) resumes it exactly where it left off. On a large fleet this is what stops dormant
// sessions from holding CPU/RAM indefinitely.
//
// The load-bearing safety property, and the whole reason this is testable at all: `midTurn` is
// folded from the event stream for EVERY agent, and tool_call/tool_result are turn-OPENING
// kinds. So an agent sitting silent inside a long tool call reads as mid-turn and is NEVER
// reaped — "quiet" and "idle" are not the same thing, and only the second one gets reclaimed.

const IDLE_MS = 60 * 60_000;

function rig(records: AgentRecord[], opts: { idleReapMs?: number; liveDependants?: string[] } = {}) {
  let now = 1_000_000;
  const parked: Array<{ agentId: string; idleMs: number }> = [];
  const unresponsive: string[] = [];
  const remoteChecks: string[] = [];
  let emit: ((e: NormalizedEvent) => void) | null = null;
  const monitor = new HealthMonitor({
    supervisor: {
      list: () => records,
      maintainRemoteControl: async (id) => { remoteChecks.push(id); },
      reportUnresponsive: (agentId) => { unresponsive.push(agentId); },
      parkIdle: async (agentId, idleMs) => { parked.push({ agentId, idleMs }); },
      // PAUSED-CONDUCTOR: optional on the real supervisor too, so the other tests here keep the
      // pre-fix behaviour (stub absent -> reap as before).
      ...(opts.liveDependants ? { hasLiveDependants: (id: string) => opts.liveDependants!.includes(id) } : {}),
    },
    events: { subscribe: (fn) => { emit = fn; return () => {}; } },
    now: () => now,
    idleReapMs: opts.idleReapMs ?? IDLE_MS,
  });
  monitor.start();
  return {
    monitor, parked, unresponsive, remoteChecks,
    advance: (ms: number) => { now += ms; },
    event: (agentId: string, kind: NormalizedEvent["kind"]) =>
      emit?.({ ts: now, seq: now, agentId, kind, data: {} } as NormalizedEvent),
  };
}

function agent(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: "a1", state: "running", shadow: false,
    spec: { prompt: "x", cwd: "/tmp" },
    accountName: "main", provider: "claude", depth: 0, treeId: "a1",
    createdAt: 0, principal: "local", attempts: [], costUsd: 0,
    ...over,
  } as AgentRecord;
}

describe("idle reaping", () => {
  it("keeps remote sessions open and renews hourly until disabled", async () => {
    const rec = agent({ remoteControlIntent: { enabled: true } });
    const r = rig([rec]);
    r.event("a1", "turn_complete"); r.monitor.tick();
    r.advance(IDLE_MS - 1); r.monitor.tick(); await Promise.resolve();
    expect(r.remoteChecks).toEqual([]);
    r.advance(1); r.monitor.tick();
    await vi.waitFor(() => expect(r.remoteChecks).toEqual(["a1"]));
    r.monitor.tick(); expect(r.remoteChecks).toHaveLength(1);
    r.advance(IDLE_MS); r.monitor.tick();
    await vi.waitFor(() => expect(r.remoteChecks).toHaveLength(2));
    expect(r.parked).toEqual([]); expect(r.unresponsive).toEqual([]);
    delete rec.remoteControlIntent;
    r.monitor.tick();
    expect(r.parked).toHaveLength(1);
    r.advance(IDLE_MS); r.monitor.tick(); await Promise.resolve();
    expect(r.remoteChecks).toHaveLength(2);
    r.monitor.stop();
  });

  it("recovers an open remote after daemon restart without waiting an hour", async () => {
    const r = rig([agent({ state: "paused", pauseReason: "daemon-restart", remoteControlIntent: { enabled: true } })]);
    r.monitor.tick();
    await vi.waitFor(() => expect(r.remoteChecks).toEqual(["a1"]));
    r.monitor.tick(); expect(r.remoteChecks).toHaveLength(1); r.monitor.stop();
  });

  it("never renews paused, killed or shadow agents", async () => {
    const r = rig([
      agent({ agentId: "paused", state: "paused", pauseReason: "operator-hold", remoteControlIntent: { enabled: true } }),
      agent({ agentId: "killed", state: "killed", remoteControlIntent: { enabled: true } }),
      agent({ agentId: "shadow", shadow: true, remoteControlIntent: { enabled: true } }),
    ]);
    r.monitor.tick(); r.advance(IDLE_MS * 3); r.monitor.tick(); await Promise.resolve();
    expect(r.remoteChecks).toEqual([]); r.monitor.stop();
  });

  it("releases the process of an agent idle past the window", () => {
    const r = rig([agent()]);
    r.event("a1", "turn_complete");        // a turn ended — nothing in flight
    r.advance(IDLE_MS + 1);
    r.monitor.tick();
    expect(r.parked.map((p) => p.agentId)).toEqual(["a1"]);
  });

  it("does NOT reap before the window elapses", () => {
    const r = rig([agent()]);
    r.event("a1", "turn_complete");
    r.advance(IDLE_MS - 1);
    r.monitor.tick();
    expect(r.parked).toEqual([]);
  });

  it("NEVER reaps an agent that is quiet but mid-turn — the long-tool-call case", () => {
    const r = rig([agent()]);
    // a tool call opened the turn and then produced nothing for hours: silent, but working
    r.event("a1", "tool_call");
    r.advance(IDLE_MS * 5);
    r.monitor.tick();
    expect(r.parked).toEqual([]);
  });

  it("reaps once the long tool call finally closes its turn", () => {
    const r = rig([agent()]);
    r.event("a1", "tool_call");
    r.advance(IDLE_MS * 2);
    r.monitor.tick();
    expect(r.parked).toEqual([]);          // still working

    r.event("a1", "turn_complete");        // done — now it is genuinely idle
    r.advance(IDLE_MS + 1);
    r.monitor.tick();
    expect(r.parked.map((p) => p.agentId)).toEqual(["a1"]);
  });

  it("an in-flight permission request or question counts as mid-turn, not idle", () => {
    for (const kind of ["permission_request", "agent_question", "agent_dialog"] as const) {
      const r = rig([agent()]);
      r.event("a1", kind);
      r.advance(IDLE_MS * 3);
      r.monitor.tick();
      expect(r.parked, `${kind} must not be reaped`).toEqual([]);
    }
  });

  it("leaves shadows and already-terminal records alone", () => {
    const r = rig([
      agent({ agentId: "sh", shadow: true }),
      agent({ agentId: "done", state: "done" }),
    ]);
    r.advance(IDLE_MS * 3);
    r.monitor.tick();
    expect(r.parked).toEqual([]);
  });

  it("is disabled entirely when the window is 0 — the pre-feature behavior", () => {
    const r = rig([agent()], { idleReapMs: 0 });
    r.event("a1", "turn_complete");
    r.advance(IDLE_MS * 10);
    r.monitor.tick();
    expect(r.parked).toEqual([]);
  });

  it("does not re-flag the same agent every tick while parkIdle settles", () => {
    const r = rig([agent()]);
    r.event("a1", "turn_complete");
    r.advance(IDLE_MS + 1);
    r.monitor.tick();
    r.monitor.tick();                      // parkIdle is async; the record is still "running"
    expect(r.parked).toHaveLength(1);
  });
});

// PAUSED-CONDUCTOR (operator-reported): a conductor waiting on five workers looks exactly as idle
// as an abandoned one. Parking it strands every worker whose deliverTo / ask_agent points back at
// it, so an agent with live dependants is exempt from the reaper entirely.
describe("idle reaping: an agent with live sub-agents", () => {
  it("is not parked while a dependant is alive", () => {
    const r = rig([agent()], { liveDependants: ["a1"] });
    r.event("a1", "turn_complete");
    r.advance(IDLE_MS + 1);
    r.monitor.tick();
    expect(r.parked).toEqual([]);
  });

  it("keeps its REAL lastActivity while skipped, so it is reaped on the first tick after its last worker settles", () => {
    const deps = ["a1"];
    const r = rig([agent()], { liveDependants: deps });
    r.event("a1", "turn_complete");
    r.advance(IDLE_MS + 1);
    r.monitor.tick();                       // skipped, and must NOT reset lastActivity
    expect(r.parked).toEqual([]);

    deps.length = 0;                        // last worker settled
    r.monitor.tick();                       // no further advance: only a preserved lastActivity reaps here
    expect(r.parked.map((p) => p.agentId)).toEqual(["a1"]);
    expect(r.parked[0]!.idleMs).toBeGreaterThan(IDLE_MS);
  });

  it("still reaps an idle agent with no dependants when the predicate is present", () => {
    const r = rig([agent()], { liveDependants: ["someone-else"] });
    r.event("a1", "turn_complete");
    r.advance(IDLE_MS + 1);
    r.monitor.tick();
    expect(r.parked.map((p) => p.agentId)).toEqual(["a1"]);
  });
});

// IDLE-REAP-PARENT: an agent that live work still reports INTO is waiting, not idle. Parking it
// costs a full session relaunch per child result and, worse, makes every ask_agent from a child
// fail hard until something else wakes it. Three edges make a dependent: parentId (direct
// spawn), originConductorId (a queue-dispatched worker — its parentId is null by design) and
// spec.deliverTo (result routing). A paused child counts only while its hold has a clock (resumeAt).
describe("idle reaping spares an agent with live dependents", () => {
  const idleBoth = (r: ReturnType<typeof rig>) => {
    r.event("parent", "turn_complete");
    r.advance(IDLE_MS + 1);
    r.monitor.tick();
  };

  it("does NOT reap a parent whose direct child is still running", () => {
    const r = rig([agent({ agentId: "parent" }), agent({ agentId: "kid", parentId: "parent", treeId: "parent", depth: 1 })]);
    r.event("kid", "tool_call");           // the child is mid-turn; the parent is genuinely idle
    idleBoth(r);
    expect(r.parked.map((p) => p.agentId)).toEqual([]);
  });

  it("does NOT reap a conductor whose queue-dispatched worker is still running (parentId is null there)", () => {
    const r = rig([agent({ agentId: "parent" }), agent({ agentId: "w1", parentId: null, originConductorId: "parent" })]);
    r.event("w1", "tool_call");
    idleBoth(r);
    expect(r.parked.map((p) => p.agentId)).toEqual([]);
  });

  it("does NOT reap an agent that a running agent will deliverTo", () => {
    const r = rig([agent({ agentId: "parent" }), agent({ agentId: "w2", spec: { prompt: "x", cwd: "/tmp", deliverTo: "parent" } as AgentRecord["spec"] })]);
    r.event("w2", "tool_call");
    idleBoth(r);
    expect(r.parked.map((p) => p.agentId)).toEqual([]);
  });

  it("a child on a CLOCKED hold (session-limit, resumeAt set) still counts — it is coming back on its own", () => {
    const r = rig([agent({ agentId: "parent" }), agent({ agentId: "kid", parentId: "parent", state: "paused", pauseReason: "session-limit", resumeAt: 2_000_000 })]);
    idleBoth(r);
    expect(r.parked.map((p) => p.agentId)).toEqual([]);
  });

  it("a child on a CLOCKLESS hold (idle-reaped / dormant) does NOT pin its parent — nobody is owed anything", () => {
    const r = rig([agent({ agentId: "parent" }), agent({ agentId: "kid", parentId: "parent", state: "paused", pauseReason: "idle-timeout" })]);
    idleBoth(r);
    expect(r.parked.map((p) => p.agentId)).toEqual(["parent"]);
  });

  it("reaps the parent once its last dependent has settled", () => {
    const kid = agent({ agentId: "kid", parentId: "parent" });
    const r = rig([agent({ agentId: "parent" }), kid]);
    r.event("kid", "tool_call");
    idleBoth(r);
    expect(r.parked).toEqual([]);

    kid.state = "done";                   // the child finished — nothing reports into the parent anymore
    r.advance(IDLE_MS + 1);
    r.monitor.tick();
    expect(r.parked.map((p) => p.agentId)).toEqual(["parent"]);
  });

  it("a settled or shadow dependent does not hold its parent", () => {
    const r = rig([
      agent({ agentId: "parent" }),
      agent({ agentId: "done-kid", parentId: "parent", state: "done" }),
      agent({ agentId: "sh", parentId: "parent", shadow: true }),
    ]);
    idleBoth(r);
    expect(r.parked.map((p) => p.agentId)).toEqual(["parent"]);
  });
});
