import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { HealthMonitor, isReapableOrphanChimerad, isReapableAgentProcess, type HealthMonitorDeps } from "@chimera/core/health";
import type { AgentRecord } from "@chimera/core/supervisor";

// Lightweight fake stubs (no real Engine/EventLog needed) — mirrors reattach.test.ts's
// ReattachEngine stub style for the same reason: HealthMonitor's own dependency surface is
// narrow and structural, so a real EventLog/AgentSupervisor would be pure overhead here.
function makeDeps(agents: AgentRecord[], now: () => number, overrides: Partial<HealthMonitorDeps> = {}) {
  const listeners = new Set<(e: NormalizedEvent) => void>();
  const reported: Array<{ agentId: string; idleMs: number; thresholdMs: number }> = [];
  const appended: Array<{ agentId: string; kind: string; data: Record<string, unknown> }> = [];
  const deps: HealthMonitorDeps = {
    supervisor: {
      list: () => agents,
      reportUnresponsive: (agentId, idleMs, thresholdMs) => reported.push({ agentId, idleMs, thresholdMs }),
    },
    events: {
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      append: (e) => { appended.push(e); },
    },
    now,
    staleMs: 1000,
    intervalMs: 500,
    ...overrides,
  };
  return { deps, reported, appended, emit: (e: NormalizedEvent) => { for (const fn of listeners) fn(e); } };
}

function agent(over: Partial<AgentRecord> & { agentId: string }): AgentRecord {
  return {
    spec: { prompt: "x", cwd: "/tmp", isolation: "none" } as AgentRecord["spec"],
    accountName: "main", provider: "claude", state: "running", depth: 0,
    treeId: over.agentId, createdAt: 0, principal: "local", attempts: [], costUsd: 0,
    parentId: null, projectId: null,
    ...over,
  };
}

describe("HealthMonitor (R2 self-healing supervision: periodic liveness probe)", () => {
  it("tick() is a no-op under staleMs", () => {
    let t = 0;
    const { deps, reported } = makeDeps([agent({ agentId: "a1" })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 999;
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  it("tick() past staleMs reports the agent exactly once (not once per still-stale tick)", () => {
    let t = 0;
    const { deps, reported } = makeDeps([agent({ agentId: "a1" })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 1001;
    mon.tick();
    expect(reported).toEqual([{ agentId: "a1", idleMs: 1001, thresholdMs: 1000 }]);

    // still "running" in the fixture (reportUnresponsive is a fake here, doesn't mutate
    // state) — a naive implementation would re-fire every subsequent tick while stale;
    // the internal lastActivity bump inside tick() prevents that.
    t += 1;
    mon.tick();
    expect(reported).toHaveLength(1);
  });

  it("an event for the agent resets its idle clock — no report after activity", () => {
    let t = 0;
    const { deps, reported, emit } = makeDeps([agent({ agentId: "a1" })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 900;
    emit({ ts: t, seq: 1, agentId: "a1", kind: "message_delta", data: {}, engineId: "local" });
    t += 900;   // 1800 total, but only 900 since the last event
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  it("start() seeds lastActivity from 'now', not record.createdAt — a long-lived reattached record does not immediately misfire", () => {
    let t = 100_000;
    // createdAt is far in the past relative to `t` — if start() seeded from createdAt, the
    // very first tick would immediately misfire.
    const { deps, reported } = makeDeps([agent({ agentId: "old-1", createdAt: 0 })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 1;
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  it("a shadow row is never probed", () => {
    let t = 0;
    const { deps, reported } = makeDeps([agent({ agentId: "shadow:p:1", shadow: true })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 5000;
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  it("a non-running (e.g. paused/done) row is never probed", () => {
    let t = 0;
    const { deps, reported } = makeDeps([agent({ agentId: "p1", state: "paused" }), agent({ agentId: "d1", state: "done" })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 5000;
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  it("a worker idle mid-turn past staleMs is still reported unresponsive", () => {
    let t = 0;
    const { deps, reported, emit } = makeDeps([agent({ agentId: "w1" })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "w1", kind: "tool_call", data: {}, engineId: "local" });
    t += 1001;   // still stale past staleMs since the last (mid-turn) event
    mon.tick();
    expect(reported).toEqual([{ agentId: "w1", idleMs: 1001, thresholdMs: 1000 }]);
  });

  it("an agent whose last event was turn_complete idling past staleMs is NOT reported (idle between turns)", () => {
    let t = 0;
    const { deps, reported, emit } = makeDeps([agent({ agentId: "c1" })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "c1", kind: "turn_complete", data: {}, engineId: "local" });
    t += 5000;   // far past staleMs, but idle-by-design between turns
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  // ZOMBIE-TURN-COMPLETE (2026-08-22 incident backstop): the exemption above is bounded, not
  // permanent — see health.ts's turnCompleteGraceMs doc comment. Two production agents sat at
  // turn_complete for 7.5-8.6 hours with nothing further happening (scheduler.ts's
  // handleWorkflowTurn wedged awaiting evaluateGate); the OLD unconditional exemption hid that
  // forever. Past the grace window this must ALARM (a durable event a future operator/agent can
  // find), but deliberately must NOT call reportUnresponsive — see health.ts's comment on why an
  // in-flight step transition is too risky to auto-kill from outside the scheduler.
  it("ZOMBIE-TURN-COMPLETE: an agent idle past turnCompleteGraceMs since its last turn_complete is alarmed via an event, but NOT auto-killed", () => {
    let t = 0;
    const { deps, reported, appended, emit } = makeDeps([agent({ agentId: "c1" })], () => t, { turnCompleteGraceMs: 2000 });
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "c1", kind: "turn_complete", data: {}, engineId: "local" });
    t += 1000;   // still within the (shortened) grace window — silent
    mon.tick();
    expect(reported).toHaveLength(0);
    expect(appended).toHaveLength(0);

    t += 1500;   // now past turnCompleteGraceMs since the turn_complete
    mon.tick();
    expect(reported).toHaveLength(0);   // never auto-killed via reportUnresponsive
    expect(appended).toEqual([{
      agentId: "c1", kind: "status",
      data: { settleWedgeDetected: true, idleMs: 2500, lastEventKind: "turn_complete" },
    }]);
  });

  it("ZOMBIE-TURN-COMPLETE: the alarm fires exactly once (not once per still-stale tick)", () => {
    let t = 0;
    const { deps, appended, emit } = makeDeps([agent({ agentId: "c1" })], () => t, { turnCompleteGraceMs: 1000 });
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "c1", kind: "turn_complete", data: {}, engineId: "local" });
    t += 1001;
    mon.tick();
    expect(appended).toHaveLength(1);
    t += 1;
    mon.tick();
    expect(appended).toHaveLength(1);   // internal lastActivity bump prevents a re-fire every tick
  });

  it("a conductor starts a new turn after turn_complete, then goes silent mid-turn past staleMs — reported again", () => {
    let t = 0;
    const { deps, reported, emit } = makeDeps([agent({ agentId: "c1" })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "c1", kind: "turn_complete", data: {}, engineId: "local" });
    t += 5000;   // idle between turns — not reported yet
    mon.tick();
    expect(reported).toHaveLength(0);

    t += 100;
    emit({ ts: t, seq: 2, agentId: "c1", kind: "message_delta", data: {}, engineId: "local" });   // new turn starts, re-arms tracking
    t += 1001;   // now stale mid-turn since that event
    mon.tick();
    expect(reported).toEqual([{ agentId: "c1", idleMs: 1001, thresholdMs: 1000 }]);
  });

  it("a conductor spawned resumeOnly (agent_started only, no turn ever started) is NOT reported unresponsive past staleMs", () => {
    let t = 0;
    const spec = { prompt: "x", cwd: "/tmp", isolation: "none", conductor: true } as AgentRecord["spec"];
    const { deps, reported, emit } = makeDeps([agent({ agentId: "conductor-1", spec })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "conductor-1", kind: "agent_started", data: {}, engineId: "local" });
    t += 5000;   // far past staleMs, but no turn was ever opened
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  it("PROJECT-CONDUCTOR-VISIBILITY: a resumeOnly conductor whose ONLY event is the spawn-time registration marker (status/registered:true, no real agent_started ever) is NOT reported unresponsive past staleMs", () => {
    let t = 0;
    const spec = { prompt: "x", cwd: "/tmp", isolation: "none", conductor: true } as AgentRecord["spec"];
    const { deps, reported, emit } = makeDeps([agent({ agentId: "conductor-1", spec })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    // supervisor.spawn's registration event (this file's own health.ts fix folds this to the
    // same idle-exemption bucket as agent_started) — a resumeOnly conductor with resumeOnly
    // staying true forever (no send() yet) may NEVER get a real agent_started.
    emit({ ts: t, seq: 1, agentId: "conductor-1", kind: "status", data: { state: "running", registered: true, conductor: true }, engineId: "local" });
    t += 5000;   // far past staleMs, but no turn was ever opened
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  it("a reattached conductor with NO new events after start() is NOT reported unresponsive (daemon-restart reattach)", () => {
    let t = 0;
    const spec = { prompt: "x", cwd: "/tmp", isolation: "none", conductor: true } as AgentRecord["spec"];
    const { deps, reported } = makeDeps([agent({ agentId: "conductor-1", spec })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();   // reattach: no agent_started/turn_complete event ever arrives
    t += 5000;   // far past staleMs
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  it("a non-conductor agent wedged mid-turn (events but no turn_complete, then silence) IS still reported — regression guard", () => {
    let t = 0;
    const { deps, reported, emit } = makeDeps([agent({ agentId: "w1" })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "w1", kind: "agent_started", data: {}, engineId: "local" });
    t += 100;
    emit({ ts: t, seq: 2, agentId: "w1", kind: "tool_call", data: {}, engineId: "local" });
    t += 1001;   // still stale past staleMs since the last (mid-turn) event
    mon.tick();
    expect(reported).toEqual([{ agentId: "w1", idleMs: 1001, thresholdMs: 1000 }]);
  });

  // LIVENESS-IDLE-CONDUCTOR: the observed regression — an idling MAIN conductor was crash-looped
  // to a tripped circuit breaker because a trailing between-turn event (mailbox delivery, usage,
  // resume marker — all kind "status") overwrote the last-event heuristic and dropped its idle
  // exemption. The fix keys the exemption off a real turn-in-flight signal instead.
  it("an idle conductor with a trailing mailbox-delivery status AFTER turn_complete is NOT reported", () => {
    let t = 0;
    const spec = { prompt: "x", cwd: "/tmp", isolation: "none", conductor: true } as AgentRecord["spec"];
    const { deps, reported, emit } = makeDeps([agent({ agentId: "conductor-1", spec })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "conductor-1", kind: "turn_complete", data: {}, engineId: "local" });
    t += 100;
    // A message delivered to the idle conductor's mailbox (deliverBatch's kind:"status",
    // delivered:true) lands AFTER turn_complete without opening a new turn — the old last-event
    // heuristic would silently make the conductor stale-eligible here.
    emit({ ts: t, seq: 2, agentId: "conductor-1", kind: "status", data: { delivered: true, from: "user", text: "hi" }, engineId: "local" });
    t += 5000;   // far past staleMs, but still idle-by-design between turns
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  it("a conductor idle AFTER a post-crash-restart resume (status/resumed:true) is NOT reported — self-reinforcing crash loop killed", () => {
    let t = 0;
    const spec = { prompt: "x", cwd: "/tmp", isolation: "none", conductor: true } as AgentRecord["spec"];
    const { deps, reported, emit } = makeDeps([agent({ agentId: "conductor-1", spec })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    // resumePaused's marker (supervisor.ts): a fresh resumed session with no turn opened yet.
    emit({ ts: t, seq: 1, agentId: "conductor-1", kind: "status", data: { state: "running", resumed: true, account: "main" }, engineId: "local" });
    t += 5000;   // far past staleMs
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  it.each(["tool_call", "status"] as const)("a conductor wedged mid-turn after %s IS reported", (kind) => {
    let t = 0;
    const spec = { prompt: "x", cwd: "/tmp", isolation: "none", conductor: true } as AgentRecord["spec"];
    const { deps, reported, emit } = makeDeps([agent({ agentId: "conductor-1", spec })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "conductor-1", kind, data: kind === "status" ? { turnStarted: true } : {}, engineId: "local" });
    t += 1001;   // silent mid-turn past staleMs
    mon.tick();
    expect(reported).toEqual([{ agentId: "conductor-1", idleMs: 1001, thresholdMs: 1000 }]);
  });

  // Gap: TURN_CLOSING_KINDS must clear `midTurn` AFTER a turn was actually open. The other
  // conductor tests only ever START from a closed state (turn_complete first, or a turn that
  // stays open) — none open a turn and THEN close it, so a fold that flipped midTurn true on an
  // opening event but failed to clear it on the subsequent close would slip through. These drive
  // the open→close transition explicitly: open a turn, emit each closing kind, idle → NOT reported.
  it("an idle-capable agent that opens a turn then sees turn_complete clears midTurn — idle past staleMs is NOT reported", () => {
    let t = 0;
    const spec = { prompt: "x", cwd: "/tmp", isolation: "none", conductor: true } as AgentRecord["spec"];
    const { deps, reported, emit } = makeDeps([agent({ agentId: "conductor-1", spec })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "conductor-1", kind: "tool_call", data: {}, engineId: "local" });   // turn opens → midTurn true
    t += 100;
    emit({ ts: t, seq: 2, agentId: "conductor-1", kind: "turn_complete", data: {}, engineId: "local" });   // turn closes → midTurn cleared
    t += 5000;   // far past staleMs, but idle-by-design between turns again
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  it("an idle-capable agent that opens a turn then sees a `result` close clears midTurn — idle past staleMs is NOT reported", () => {
    let t = 0;
    const spec = { prompt: "x", cwd: "/tmp", isolation: "none", conductor: true } as AgentRecord["spec"];
    const { deps, reported, emit } = makeDeps([agent({ agentId: "conductor-1", spec })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "conductor-1", kind: "message_delta", data: {}, engineId: "local" });   // turn opens
    t += 100;
    emit({ ts: t, seq: 2, agentId: "conductor-1", kind: "result", data: {}, engineId: "local" });   // turn closes
    t += 5000;
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  it("an idle-capable agent that opens a turn then sees an `error` close clears midTurn — idle past staleMs is NOT reported", () => {
    let t = 0;
    const spec = { prompt: "x", cwd: "/tmp", isolation: "none", persistent: true } as AgentRecord["spec"];
    const { deps, reported, emit } = makeDeps([agent({ agentId: "pool-1", spec })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "pool-1", kind: "tool_call", data: {}, engineId: "local" });   // turn opens
    t += 100;
    emit({ ts: t, seq: 2, agentId: "pool-1", kind: "error", data: {}, engineId: "local" });   // turn closes
    t += 5000;
    mon.tick();
    expect(reported).toHaveLength(0);
  });

  it("a persistent role worker idle between turns (trailing status after turn_complete) is NOT reported, but IS reported when wedged mid-turn", () => {
    let t = 0;
    const spec = { prompt: "x", cwd: "/tmp", isolation: "none", persistent: true } as AgentRecord["spec"];
    const { deps, reported, emit } = makeDeps([agent({ agentId: "pool-1", spec })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "pool-1", kind: "turn_complete", data: {}, engineId: "local" });
    emit({ ts: t, seq: 2, agentId: "pool-1", kind: "usage", data: { usage: {} }, engineId: "local" });   // mid-turn snapshot arriving idle — but no new turn
    t += 5000;
    mon.tick();
    expect(reported).toHaveLength(0);

    // now a real new turn starts and then wedges
    t += 100;
    emit({ ts: t, seq: 3, agentId: "pool-1", kind: "message_delta", data: {}, engineId: "local" });
    t += 1001;
    mon.tick();
    expect(reported).toEqual([{ agentId: "pool-1", idleMs: 1001, thresholdMs: 1000 }]);
  });

  it("an ordinary worker idle past staleMs (last event NOT turn_complete) IS reported — behavior unchanged", () => {
    let t = 0;
    const { deps, reported, emit } = makeDeps([agent({ agentId: "w1" })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    t += 100;
    emit({ ts: t, seq: 1, agentId: "w1", kind: "tool_result", data: {}, engineId: "local" });
    t += 1001;
    mon.tick();
    expect(reported).toEqual([{ agentId: "w1", idleMs: 1001, thresholdMs: 1000 }]);
  });

  it("REGRESSION: six idle windows (delivery/resume between turns) never flag a persistent conductor — the circuit breaker cannot trip on idle", () => {
    let t = 0;
    const spec = { prompt: "x", cwd: "/tmp", isolation: "none", conductor: true, persistent: true } as AgentRecord["spec"];
    const { deps, reported, emit } = makeDeps([agent({ agentId: "MAIN", spec })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    emit({ ts: t, seq: 1, agentId: "MAIN", kind: "turn_complete", data: {}, engineId: "local" });
    // Simulate the observed ~15-min idle windows, each ending in a between-turns event: a
    // mailbox delivery, a usage snapshot, or a crash-restart resume marker — never a real turn.
    const trailers: NormalizedEvent[] = [
      { ts: 0, seq: 0, agentId: "MAIN", kind: "status", data: { delivered: true, from: "u", text: "?" }, engineId: "local" },
      { ts: 0, seq: 0, agentId: "MAIN", kind: "usage", data: { usage: {} }, engineId: "local" },
      { ts: 0, seq: 0, agentId: "MAIN", kind: "status", data: { resumed: true, account: "main" }, engineId: "local" },
      { ts: 0, seq: 0, agentId: "MAIN", kind: "status", data: { registered: true, conductor: true }, engineId: "local" },
      { ts: 0, seq: 0, agentId: "MAIN", kind: "status", data: { undeliveredMessage: true, reason: "x" }, engineId: "local" },
      { ts: 0, seq: 0, agentId: "MAIN", kind: "status", data: { delivered: true, from: "u", text: "??" }, engineId: "local" },
    ];
    for (const tr of trailers) {
      t += 900_000;   // ~15 min
      emit({ ...tr, ts: t, seq: t });
      mon.tick();     // probe fires within the window
    }
    expect(reported).toHaveLength(0);   // never flagged → scheduleCrashRestart never runs → circuit breaker never trips
  });

  it("stop() unsubscribes — a later event no longer resets the idle clock", () => {
    let t = 0;
    const { deps, reported, emit } = makeDeps([agent({ agentId: "a1" })], () => t);
    const mon = new HealthMonitor(deps);
    mon.start();
    mon.stop();
    t += 900;
    emit({ ts: t, seq: 1, agentId: "a1", kind: "message_delta", data: {}, engineId: "local" });   // ignored — unsubscribed
    t += 200;   // 1100 since start(), only 200 since the (ignored) emit
    mon.tick();
    expect(reported).toHaveLength(1);
  });

  // DAEMON-RUNS-FROM-DELETED-WORKTREE: this timer already runs unconditionally, so it doubles as
  // the cheap mid-run existence probe for the daemon's own code root instead of a new timer.
  describe("codeRoot existence probe (DAEMON-RUNS-FROM-DELETED-WORKTREE)", () => {
    it("warns exactly once when codeRoot stops existing, and stays silent when it exists", () => {
      let t = 0;
      const warnings: unknown[][] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => { warnings.push(args); };
      try {
        let exists = true;
        const { deps } = makeDeps([], () => t, { codeRoot: "/fake/root", existsSync: () => exists });
        const mon = new HealthMonitor(deps);
        mon.tick();
        expect(warnings).toHaveLength(0);   // still exists — silent
        exists = false;
        mon.tick();
        expect(warnings).toHaveLength(1);   // vanished — warns once
        mon.tick();
        mon.tick();
        expect(warnings).toHaveLength(1);   // edge-triggered — no repeat spam
      } finally {
        console.error = origError;
      }
    });

    it("with no codeRoot configured (existing callers, e.g. every other test in this file), tick() never probes and never warns", () => {
      let t = 0;
      const warnings: unknown[][] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => { warnings.push(args); };
      try {
        const { deps } = makeDeps([], () => t);
        const mon = new HealthMonitor(deps);
        mon.tick();
        mon.tick();
        expect(warnings).toHaveLength(0);
      } finally {
        console.error = origError;
      }
    });
  });

  // ORPHANED-DAEMON-LEAK: 49 worktree-rooted chimerad processes were found alive on the
  // operator's machine, all 7-9 days old, ppid 1 (reparented — whoever spawned them is gone).
  // Root cause (established via `ps eww <pid>` on the live orphans): every one carries a unique
  // per-test CHIMERA_HOME (mkdtempSync tmpdir) — they're daemons booted by test suites
  // (ChimeraClient.connect()'s autostart, or server.test.ts's raw spawn()) that outlived the test
  // process without ever receiving SIGTERM. This sweep is the periodic safety net: it reconciles
  // chimerad processes discovered on the OS process table against a live "owning parent" (ppid),
  // not against an AgentRecord — a leaked chimerad DAEMON has no AgentRecord at all, it is a
  // sibling process of this daemon's own agents, never one of them (confirmed live: only the
  // DAEMONS were leaking; agent processes — claude/codex/kimi — were not).
  describe("orphan chimerad sweep (ORPHANED-DAEMON-LEAK)", () => {
    const self = { pid: 100, home: "/Users/op/.chimera" };

    it("isReapableOrphanChimerad: reaps an unmanaged, foreign-home, ppid-1 (orphaned) process", () => {
      expect(isReapableOrphanChimerad({ pid: 999, ppid: 1, home: "/tmp/chimera-mhome-abc", managed: false }, self))
        .toBe(true);
    });

    it("isReapableOrphanChimerad: never the sweeping daemon itself", () => {
      expect(isReapableOrphanChimerad({ pid: 100, ppid: 1, home: "/tmp/chimera-mhome-abc", managed: false }, self))
        .toBe(false);
    });

    it("isReapableOrphanChimerad: never a launchd/systemd-managed daemon (the real daemon)", () => {
      expect(isReapableOrphanChimerad({ pid: 2883, ppid: 1, home: self.home, managed: true }, self))
        .toBe(false);
    });

    it("isReapableOrphanChimerad: never a peer sharing this daemon's own home", () => {
      expect(isReapableOrphanChimerad({ pid: 999, ppid: 1, home: self.home, managed: false }, self))
        .toBe(false);
    });

    it("isReapableOrphanChimerad: never a process with an unknown home (can't verify — never touch)", () => {
      expect(isReapableOrphanChimerad({ pid: 999, ppid: 1, home: null, managed: false }, self))
        .toBe(false);
    });

    it("isReapableOrphanChimerad: never a process that still has a live parent (ppid != 1 — has an owning record)", () => {
      expect(isReapableOrphanChimerad({ pid: 999, ppid: 4242, home: "/tmp/chimera-mhome-abc", managed: false }, self))
        .toBe(false);
    });

    it("tick(): reaps a real orphan, spares the real daemon, spares a live-parented process, spares itself", () => {
      let t = 0;
      const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const procs = [
        { pid: 100, ppid: 1, home: self.home, managed: false },              // self — never touch
        { pid: 2883, ppid: 1, home: self.home, managed: true },              // real daemon — never touch
        { pid: 500, ppid: 4242, home: "/tmp/chimera-mhome-xyz", managed: false }, // live parent — not an orphan
        { pid: 999, ppid: 1, home: "/tmp/chimera-mhome-abc", managed: false },    // ORPHAN — reap
      ];
      const { deps } = makeDeps([], () => t, {
        listChimeradProcesses: () => procs,
        killChimeradProcess: (pid, signal) => killed.push({ pid, signal }),
        selfPid: self.pid, selfHome: self.home,
      });
      const mon = new HealthMonitor(deps);
      mon.tick();
      expect(killed).toEqual([{ pid: 999, signal: "SIGTERM" }]);
    });

    it("tick(): with no listChimeradProcesses configured (existing callers), never scans and never kills", () => {
      let t = 0;
      const { deps } = makeDeps([], () => t);
      const mon = new HealthMonitor(deps);
      expect(() => mon.tick()).not.toThrow();
    });
  });

  // AGENT-PROCESS-NOT-REAPED: the operator's explicit ask — any agent NOT in running/idle or
  // running/busy must have its OS process closed, verified by a periodic reconciling system.
  // Distinct from the orphan chimerad sweep above: that reconciles OTHER chimerad DAEMON
  // processes (a different binary) against a live ppid; this reconciles this daemon's OWN
  // supervised agent backend processes (the `claude` CLI subprocess) against their AgentRecord's
  // state — the backstop for when backends/claude.ts's own kill()/finally-block termination
  // (the primary mechanism, driven by the in-memory AgentHandle) was bypassed entirely, e.g. a
  // daemon restart that drops every in-memory handle while the prior process generation's OS
  // processes live on with nothing left to ever kill them again.
  describe("terminal-agent process sweep (AGENT-PROCESS-NOT-REAPED)", () => {
    const self = { home: "/Users/op/.chimera" };

    it("isReapableAgentProcess: reaps a terminal agent's process (owning record state is done)", () => {
      expect(isReapableAgentProcess({ pid: 999, pgid: 999, agentId: "a1", home: self.home }, "done", self))
        .toBe(true);
    });

    it("isReapableAgentProcess: reaps a process with NO owning record at all (e.g. after a daemon restart)", () => {
      expect(isReapableAgentProcess({ pid: 999, pgid: 999, agentId: "a1", home: self.home }, undefined, self))
        .toBe(true);
    });

    it("isReapableAgentProcess: never a running agent's process", () => {
      expect(isReapableAgentProcess({ pid: 999, pgid: 999, agentId: "a1", home: self.home }, "running", self))
        .toBe(false);
    });

    it("isReapableAgentProcess: never a paused agent's process", () => {
      expect(isReapableAgentProcess({ pid: 999, pgid: 999, agentId: "a1", home: self.home }, "paused", self))
        .toBe(false);
    });

    it("isReapableAgentProcess: never a process whose agentId couldn't be determined (can't verify identity — never touch)", () => {
      expect(isReapableAgentProcess({ pid: 999, pgid: 999, agentId: null, home: self.home }, "done", self))
        .toBe(false);
    });

    it("isReapableAgentProcess: never a process serving a different chimera home", () => {
      expect(isReapableAgentProcess({ pid: 999, pgid: 999, agentId: "a1", home: "/tmp/other-home" }, "done", self))
        .toBe(false);
    });

    it("isReapableAgentProcess: never a process with an unknown home", () => {
      expect(isReapableAgentProcess({ pid: 999, pgid: 999, agentId: "a1", home: null }, "done", self))
        .toBe(false);
    });

    it("tick(): reaps a terminal agent's process and an ownerless one, spares running/paused and a foreign-home process", () => {
      let t = 0;
      const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const procs = [
        { pid: 100, pgid: 100, agentId: "running-1", home: self.home },       // running — never touch
        { pid: 200, pgid: 200, agentId: "paused-1", home: self.home },        // paused — never touch
        { pid: 300, pgid: 300, agentId: "foreign-1", home: "/tmp/other-home" }, // different chimera home — never touch
        { pid: 400, pgid: 400, agentId: "done-1", home: self.home },          // terminal — REAP
        { pid: 500, pgid: 500, agentId: "ghost-1", home: self.home },         // no owning record at all — REAP
      ];
      const agents = [
        agent({ agentId: "running-1", state: "running" }),
        agent({ agentId: "paused-1", state: "paused" }),
        agent({ agentId: "done-1", state: "done" }),
      ];
      const { deps } = makeDeps(agents, () => t, {
        listAgentProcesses: () => procs,
        killAgentProcess: (pid, signal) => killed.push({ pid, signal }),
        selfHome: self.home,
      });
      const mon = new HealthMonitor(deps);
      mon.tick();
      expect(killed).toEqual([
        { pid: -400, signal: "SIGTERM" },   // group leader (pgid===pid) → negative-pid signal
        { pid: -500, signal: "SIGTERM" },
      ]);
    });

    it("tick(): escalates to SIGKILL when the SAME (pid, agentId) is still reapable on the NEXT tick", () => {
      let t = 0;
      const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const procs = [{ pid: 400, pgid: 400, agentId: "done-1", home: self.home }];
      const agents = [agent({ agentId: "done-1", state: "done" })];
      const { deps } = makeDeps(agents, () => t, {
        listAgentProcesses: () => procs,
        killAgentProcess: (pid, signal) => killed.push({ pid, signal }),
        selfHome: self.home,
      });
      const mon = new HealthMonitor(deps);
      mon.tick();
      mon.tick();
      expect(killed).toEqual([
        { pid: -400, signal: "SIGTERM" },
        { pid: -400, signal: "SIGKILL" },
      ]);
    });

    it("tick(): PID-REUSE GUARD — a new process reusing the pid under a DIFFERENT agentId is never escalated to SIGKILL", () => {
      let t = 0;
      const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      let procs = [{ pid: 400, pgid: 400, agentId: "done-1", home: self.home }];
      const agents = [
        agent({ agentId: "done-1", state: "done" }),
        agent({ agentId: "running-2", state: "running" }),
      ];
      const { deps } = makeDeps(agents, () => t, {
        listAgentProcesses: () => procs,
        killAgentProcess: (pid, signal) => killed.push({ pid, signal }),
        selfHome: self.home,
      });
      const mon = new HealthMonitor(deps);
      mon.tick();   // SIGTERMs pid 400 as belonging to terminal agent done-1
      // pid 400 gets reused by an unrelated, currently-RUNNING agent's process before the next
      // tick — identity is re-verified fresh from the (fake) OS scan, never assumed from the
      // remembered pid alone, so this must NOT escalate onto the new occupant.
      procs = [{ pid: 400, pgid: 400, agentId: "running-2", home: self.home }];
      mon.tick();
      expect(killed).toEqual([{ pid: -400, signal: "SIGTERM" }]);
    });

    it("tick(): group-signals (-pid) a process-group leader, falls back to a plain pid signal for a non-leader", () => {
      let t = 0;
      const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const procs = [
        { pid: 400, pgid: 400, agentId: "leader-1", home: self.home },      // pgid === pid: group leader
        { pid: 401, pgid: 100, agentId: "nonleader-1", home: self.home },   // pgid !== pid: NOT a group leader
      ];
      const agents = [
        agent({ agentId: "leader-1", state: "done" }),
        agent({ agentId: "nonleader-1", state: "done" }),
      ];
      const { deps } = makeDeps(agents, () => t, {
        listAgentProcesses: () => procs,
        killAgentProcess: (pid, signal) => killed.push({ pid, signal }),
        selfHome: self.home,
      });
      const mon = new HealthMonitor(deps);
      mon.tick();
      expect(killed).toEqual([
        { pid: -400, signal: "SIGTERM" },
        { pid: 401, signal: "SIGTERM" },
      ]);
    });

    it("tick(): with no listAgentProcesses configured (existing callers), never scans and never kills", () => {
      let t = 0;
      const { deps } = makeDeps([], () => t);
      const mon = new HealthMonitor(deps);
      expect(() => mon.tick()).not.toThrow();
    });
  });

  // DYNAMIC-CONCURRENCY-CAP: HealthMonitor's tick() is the probe's only home (see
  // dynamic-cap.ts's own header) — these assert the wiring, not the cap math itself
  // (covered standalone in dynamic-cap.test.ts).
  describe("dynamic cap probe wiring", () => {
    it("with no dynamicCap/dynamicCapConfig configured, tick() never touches the tracker", () => {
      let t = 0;
      let sampleCalls = 0;
      const fakeTracker = { sample: () => { sampleCalls++; } };
      const { deps } = makeDeps([], () => t, { dynamicCap: fakeTracker as never });
      const mon = new HealthMonitor(deps);
      expect(() => mon.tick()).not.toThrow();
      expect(sampleCalls).toBe(0);   // dynamicCapConfig absent ⇒ the pair is opt-in together
    });

    it("with both configured, tick() samples the tracker with the freshly-read config every cycle", () => {
      let t = 0;
      const sampled: unknown[] = [];
      let cfg: unknown = { enabled: true, floor: 2 };
      const fakeTracker = { sample: (c: unknown) => sampled.push(c) };
      const { deps } = makeDeps([], () => t, {
        dynamicCap: fakeTracker as never,
        dynamicCapConfig: () => cfg as never,
      });
      const mon = new HealthMonitor(deps);
      mon.tick();
      cfg = { enabled: false };   // simulates a live config.patch between ticks
      mon.tick();
      expect(sampled).toEqual([{ enabled: true, floor: 2 }, { enabled: false }]);
    });
  });
});
