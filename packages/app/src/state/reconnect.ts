// Final-acceptance MAJOR 4 — reconnect refetch (coverage A6-1 "Dönüşte:
// status+*.list yeniden çekilir, stream'e abone olunur"): the Rust bridge owns
// the socket reconnect + re-applies the event subscription itself, but the
// PROJECTION was left stale — nothing re-fetched the snapshots or the events
// missed during the outage. This module is the store-side other half: on every
// daemon://state transition INTO "connected" from reconnecting/disconnected,
// gap-fill the missed events via the WD events.replay RPC (dispatched as
// normal event actions — the reducer's seq watermark dedupes any overlap with
// the already-live stream), then re-run connectAndLoad (subscribe is
// idempotent; every snapshot action is a full replace).
//
// IMPORT-SAFE like commands.*.ts: no bridge/store imports — bootstrapAppStore
// hands the deps in, tests hand in stubs.
import type { NormalizedEvent } from "@chimera/protocol";
import type { ConnState } from "../rpc/bridge";

/** One replay page is plenty for an outage window; a longer gap is truncated
 * (the snapshots that follow are authoritative for current state anyway). */
export const RECONNECT_REPLAY_LIMIT = 5000;

/** The PURE transition rule: refetch only on re-entry into "connected" from a
 * down state. `prev === null` is the attach-time snapshot delivery — the very
 * first "connected" is the initial boot, which connectAndLoad already covers
 * (a boot-while-down first observes disconnected, so its later connected IS a
 * transition and correctly retries the failed initial load). */
export function isReconnectTransition(prev: ConnState | null, next: ConnState): boolean {
  return next === "connected" && (prev === "reconnecting" || prev === "disconnected");
}

export type ReconnectDeps = {
  /** Current seq watermark — the gap-fill starts at lastSeq+1. */
  getLastSeq(): number;
  /** The WD events.replay RPC (fromSeq/limit → seq-ordered window). */
  replay(params: { fromSeq: number; limit: number }): Promise<NormalizedEvent[]>;
  /** Dispatch one replayed event as a NORMAL event action (watermark dedupes). */
  dispatchEvent(e: NormalizedEvent): void;
  /** The store's snapshot bootstrap (full-replace actions, idempotent subscribe). */
  refetch(): Promise<void>;
  onError?(err: unknown): void;
};

/** Build the daemon://state observer. Re-entrancy guarded: a transition landing
 * while a refetch is still in flight is dropped (the in-flight pass fetches
 * full-replace snapshots at its own end, so it can only be at-least-as-new). */
export function createReconnectRefetcher(deps: ReconnectDeps): (s: ConnState) => void {
  let prev: ConnState | null = null;
  let inFlight = false;
  return (s: ConnState): void => {
    const shouldRun = isReconnectTransition(prev, s);
    prev = s;
    if (!shouldRun || inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        // Gap-fill FIRST: the watermark rejects anything at-or-below lastSeq,
        // so the missed window must land before newly-live events push it up.
        const fromSeq = deps.getLastSeq() + 1;
        const missed = await deps.replay({ fromSeq, limit: RECONNECT_REPLAY_LIMIT });
        for (const e of missed) deps.dispatchEvent(e);
        await deps.refetch();
      } catch (err) {
        deps.onError?.(err);
      } finally {
        inFlight = false;
      }
    })();
  };
}

// ---------------------------------------------------------------------------
// BLANK-UI-AFTER-SLOW-FIRST-LOAD
// ---------------------------------------------------------------------------
// The initial snapshot load used to be a bare `void connectAndLoad().catch(warn)`. Its ONLY
// recovery path was createReconnectRefetcher below, which by design fires only on a transition
// INTO "connected" from a down state. That covers "the daemon was down at launch" — but not the
// failure that actually happens: the daemon is UP and merely slow, the load hits the Rust
// bridge's 30s call timeout, and the socket never drops. No drop, no transition, no refetch —
// the app sits permanently empty with a healthy connection and no way back short of restarting
// it. (Reproduced live: a daemon boot that re-spawns every prior running agent is slow enough
// to do this on the very first agent.list.)
//
// An empty projection is never a correct resting state while the daemon is reachable, so the
// initial load gets its own bounded-backoff retry that never gives up. It is deliberately
// SEPARATE from the reconnect refetcher's guard: the two racing is harmless by construction
// (every snapshot action is a full replace, and events are deduped by the reducer's seq
// watermark — the same reasoning connectAndLoad's own subscribe-first ordering already relies on).
export const SNAPSHOT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export type SnapshotLoaderDeps = {
  /** The store's snapshot bootstrap — rejects if any of its RPCs fail. */
  load(): Promise<void>;
  onError?(err: unknown, attempt: number): void;
  /** Test seam (absent ⇒ real setTimeout), mirroring the injectable-timer convention. */
  setTimer?: (fn: () => void, ms: number) => unknown;
};

export function createSnapshotLoader(deps: SnapshotLoaderDeps): { run: () => void } {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let inFlight = false;
  let attempt = 0;
  const run = (): void => {
    // Collapse overlapping calls: a retry firing while a load is still in flight (or the
    // reconnect refetcher landing at the same moment) must not double the RPC traffic.
    if (inFlight) return;
    inFlight = true;
    void deps.load().then(
      () => { inFlight = false; attempt = 0; },   // reset so the NEXT outage starts at the bottom
      (err: unknown) => {
        inFlight = false;
        deps.onError?.(err, attempt + 1);
        // Past the end of the ladder we hold at its final delay rather than stopping —
        // giving up is what leaves the blank screen this exists to prevent.
        const delay = SNAPSHOT_RETRY_DELAYS_MS[Math.min(attempt, SNAPSHOT_RETRY_DELAYS_MS.length - 1)]!;
        attempt++;
        setTimer(run, delay);
      },
    );
  };
  return { run };
}
