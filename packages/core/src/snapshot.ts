import type { NormalizedEvent } from "@chimera/protocol";
import type { AgentRecord } from "./supervisor.js";
import { writeFileDurable, realDurableWriteDeps, type DurableWriteDeps } from "./durable-write.js";

// FEATURE-4 (snapshot durability + write-amp fix): replaces daemon/main.ts's old
// "rewrite state.json on every single event" subscriber. A durable snapshot (writeFileDurable)
// fires when ANY of:
//   - `maxEvents` events have landed since the last snapshot (bounds staleness by volume — this
//     IS the write-amp fix: the O(N)-in-agent-count write now happens once per N events, not
//     once per event);
//   - `maxIntervalMs` have elapsed since the last snapshot (bounds staleness by time — checked
//     reactively on the next event rather than via a real timer: every AgentRecord mutation
//     happens INSIDE an event-producing call in supervisor.ts's onEvent/onError, so "no event
//     fired" implies "nothing changed" implies nothing is lost by not flushing);
//   - a NEW record materialized (supervisor.spawnGeneration() advanced) — a brand-new
//     AgentRecord's founding fields (spec, accountName, treeId, createdAt, principal, parentId,
//     projectId, ...) are NEVER written to the event log (no event kind carries them), so the
//     snapshot is the only durable copy — it must capture a new record before more than its own
//     first burst of events can be lost to a crash. spawnGeneration() is a monotonic insertion
//     counter, not a live roster size: size can shrink (a failed launch's agents.delete) and
//     later grow back to the SAME number, which a size comparison would misread as "no growth"
//     and silently drop the refill's founding fields. O(1), like the size probe it replaced.
export type SnapshotEngine = {
  supervisor: { snapshotAgents(): AgentRecord[]; spawnGeneration(): number };
  events: { subscribe(fn: (e: NormalizedEvent) => void): () => void; currentSeq(): number };
};

export type SnapshotSchedulerOptions = {
  maxEvents?: number;
  maxIntervalMs?: number;
  now?: () => number;
  io?: DurableWriteDeps;
};

const DEFAULT_MAX_EVENTS = 50;
const DEFAULT_MAX_INTERVAL_MS = 2000;

export class SnapshotScheduler {
  private readonly maxEvents: number;
  private readonly maxIntervalMs: number;
  private readonly now: () => number;
  private readonly io: DurableWriteDeps;
  private unsubscribe: (() => void) | null = null;
  private pendingEvents = 0;
  private lastSnapshotAt = 0;
  private lastSpawnGeneration = 0;

  constructor(
    private readonly engine: SnapshotEngine,
    private readonly statePath: string,
    opts: SnapshotSchedulerOptions = {},
  ) {
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxIntervalMs = opts.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.io = opts.io ?? realDurableWriteDeps;
  }

  // Boot-time baseline flush (same as the old code's pre-subscribe snapshot()), then starts
  // observing events for the debounced cadence.
  start(): void {
    this.flush();
    this.unsubscribe = this.engine.events.subscribe(() => this.onEvent());
  }

  private onEvent(): void {
    this.pendingEvents++;
    const newRecord = this.engine.supervisor.spawnGeneration() > this.lastSpawnGeneration;
    const dueByCount = this.pendingEvents >= this.maxEvents;
    const dueByTime = this.now() - this.lastSnapshotAt >= this.maxIntervalMs;
    if (newRecord || dueByCount || dueByTime) this.flush();
  }

  // Immediate durable snapshot, bypassing cadence — used at start(), on a cadence trip, and by
  // the daemon's shutdown path (which must never lose the final state to debounce).
  flush(): void {
    const agents = this.engine.supervisor.snapshotAgents();
    const lastSeq = this.engine.events.currentSeq();
    writeFileDurable(this.statePath, JSON.stringify({ agents, lastSeq }), this.io);
    this.pendingEvents = 0;
    this.lastSnapshotAt = this.now();
    this.lastSpawnGeneration = this.engine.supervisor.spawnGeneration();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
