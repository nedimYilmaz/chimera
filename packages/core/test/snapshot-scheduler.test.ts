import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotScheduler, type SnapshotEngine } from "@chimera/core/snapshot";
import type { AgentRecord } from "@chimera/core/supervisor";

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "chimera-snapshot-scheduler-"));
  return join(dir, "state.json");
}

// A minimal fake engine: `emit()` drives the subscribed listener directly (no real EventLog
// needed — SnapshotScheduler only ever calls subscribe/currentSeq/snapshotAgents/spawnGeneration).
function fakeEngine(): SnapshotEngine & { emit: () => void; setSpawnGeneration: (n: number) => void; bumpSpawnGeneration: () => void; setSeq: (n: number) => void; agents: AgentRecord[] } {
  let listener: (() => void) | null = null;
  let spawnGeneration = 0;
  let seq = 0;
  const agents: AgentRecord[] = [];
  return {
    supervisor: {
      snapshotAgents: () => agents,
      spawnGeneration: () => spawnGeneration,
    },
    events: {
      subscribe: (fn) => { listener = fn as unknown as () => void; return () => { listener = null; }; },
      currentSeq: () => seq,
    },
    emit: () => listener?.(),
    setSpawnGeneration: (n: number) => { spawnGeneration = n; },
    bumpSpawnGeneration: () => { spawnGeneration++; },
    setSeq: (n: number) => { seq = n; },
    agents,
  };
}

describe("SnapshotScheduler", () => {
  it("start() flushes once immediately, before any event", () => {
    const engine = fakeEngine();
    const statePath = tmpStatePath();
    const scheduler = new SnapshotScheduler(engine, statePath);
    scheduler.start();
    const written = JSON.parse(readFileSync(statePath, "utf8"));
    expect(written).toEqual({ agents: [], lastSeq: 0 });
  });

  it("debounces by event count: maxEvents-1 events don't flush, the Nth does", () => {
    const engine = fakeEngine();
    const statePath = tmpStatePath();
    const scheduler = new SnapshotScheduler(engine, statePath, { maxEvents: 5, maxIntervalMs: 1_000_000 });
    scheduler.start();          // 1 flush (baseline)
    engine.setSeq(1);
    for (let i = 0; i < 4; i++) engine.emit();   // 4 events, below threshold of 5
    const afterFour = readFileSync(statePath, "utf8");
    expect(JSON.parse(afterFour).lastSeq).toBe(0);   // still the baseline flush — no new write yet
    engine.emit();               // 5th event trips maxEvents
    const afterFive = JSON.parse(readFileSync(statePath, "utf8"));
    expect(afterFive.lastSeq).toBe(1);
  });

  it("debounces by wall-clock: fewer than maxEvents events but now() has advanced past maxIntervalMs triggers a flush", () => {
    const engine = fakeEngine();
    const statePath = tmpStatePath();
    let clock = 0;
    const scheduler = new SnapshotScheduler(engine, statePath, { maxEvents: 1000, maxIntervalMs: 100, now: () => clock });
    scheduler.start();
    engine.setSeq(7);
    clock = 50;
    engine.emit();               // under both thresholds
    expect(JSON.parse(readFileSync(statePath, "utf8")).lastSeq).toBe(0);
    clock = 150;
    engine.emit();               // 150ms since baseline flush (at clock=0) > maxIntervalMs=100
    expect(JSON.parse(readFileSync(statePath, "utf8")).lastSeq).toBe(7);
  });

  it("forces an immediate flush when a new record appears, ahead of both other thresholds", () => {
    const engine = fakeEngine();
    const statePath = tmpStatePath();
    const scheduler = new SnapshotScheduler(engine, statePath, { maxEvents: 1000, maxIntervalMs: 1_000_000 });
    scheduler.start();           // baseline flush, spawnGeneration snapshot = 0
    engine.setSeq(3);
    engine.bumpSpawnGeneration(); // a new agent appeared
    engine.emit();
    expect(JSON.parse(readFileSync(statePath, "utf8")).lastSeq).toBe(3);
  });

  // Regression for the bug where growth-detection compared live roster SIZE against a
  // high-water mark: agents.delete() on a failed launch (supervisor.ts) can shrink the roster
  // back down, so a later same-size refill read as "no growth" and its founding fields (never
  // in the event log) were silently dropped from the snapshot until the next cadence flush.
  // spawnGeneration is a monotonic insertion counter instead, so a delete can't defeat it.
  it("still flushes a same-size refill after a delete shrank the roster back down (spawn-counter, not roster-size)", () => {
    const engine = fakeEngine();
    const statePath = tmpStatePath();
    const scheduler = new SnapshotScheduler(engine, statePath, { maxEvents: 1000, maxIntervalMs: 1_000_000 });
    scheduler.start();            // baseline flush, spawnGeneration snapshot = 0

    // Agent B spawns (roster size N -> N+1, generation 0 -> 1); an unrelated event during its
    // launch await trips a flush that records lastSpawnGeneration = 1.
    engine.bumpSpawnGeneration();
    engine.setSeq(1);
    engine.emit();
    expect(JSON.parse(readFileSync(statePath, "utf8")).lastSeq).toBe(1);

    // B's launch fails -> supervisor.agents.delete(B) -> roster size back to N. No generation
    // decrement (it's monotonic), and no event fires here in the real system either.

    // Agent C spawns next (roster size N -> N+1 again, generation 1 -> 2) and emits agent_started.
    engine.bumpSpawnGeneration();
    engine.setSeq(2);
    engine.emit();
    // A roster-size-high-water check would see N+1 > N+1 == false and MISS this flush,
    // stranding C's founding fields. spawnGeneration (2 > 1) catches it correctly.
    expect(JSON.parse(readFileSync(statePath, "utf8")).lastSeq).toBe(2);
  });

  it("stop() halts further flushes on subsequent events", () => {
    const engine = fakeEngine();
    const statePath = tmpStatePath();
    const scheduler = new SnapshotScheduler(engine, statePath, { maxEvents: 1, maxIntervalMs: 1_000_000 });
    scheduler.start();
    scheduler.stop();
    engine.setSeq(99);
    engine.emit();                // would have tripped maxEvents:1 if still subscribed
    expect(JSON.parse(readFileSync(statePath, "utf8")).lastSeq).toBe(0);
  });

  it("flush() writes the exact { agents, lastSeq } shape", () => {
    const engine = fakeEngine();
    const rec = { agentId: "a1" } as unknown as AgentRecord;
    engine.agents.push(rec);
    engine.setSeq(42);
    const statePath = tmpStatePath();
    const scheduler = new SnapshotScheduler(engine, statePath);
    scheduler.flush();
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ agents: [{ agentId: "a1" }], lastSeq: 42 });
  });
});
