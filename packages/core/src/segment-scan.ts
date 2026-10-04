// SEGMENT-SCAN — the sealed-segment read, moved off the event loop.
//
// The same argument chronicle-scan.ts makes for the cosine scan, applied to the place it actually
// bites hardest. `newestMatching` fills a request from the in-memory active window first and falls
// back to sealed segments only when that window is short. For a request that can never be
// satisfied — an agent whose events have rotated away — "short" means EVERY segment, read with
// readFileSync and JSON.parse, on the one thread that also answers every other RPC.
//
// Measured on an operator's machine: events.replay {agentId, limit:500} returning ZERO events,
// 2860 / 4886 / 13212 ms across three calls, reading 60 segments totalling 575 MB. That is a
// transcript click freezing the daemon for seconds — every other agent's events, every RPC, every
// timer, waiting. Node is single-threaded: no amount of transport-level concurrency, request
// queueing or prioritisation changes it. Only getting the work off the thread does.
//
// WHY THIS IS SAFE WITHOUT A LOCK: a sealed segment is immutable. events.ts writes the active file
// and then renameSync's it to `events.<start>-<end>.jsonl`; nothing ever appends to or rewrites a
// sealed one. The worker therefore reads files that cannot change under it, holds no shared
// mutable state, and needs no coordination with the main thread. The ACTIVE segment — the only
// mutable part — is never given to the worker; it is already in memory and is filtered inline.
//
// CAPACITY: a POOL, not one worker. Off-thread alone means nothing else is blocked; it does not
// mean two heavy reads run at once — with a single worker the second still waits for the first.
// The pool serves several in genuine parallel, which is the difference between "the daemon stays
// responsive" and "the daemon serves more requests at the same time". See worker-pool.ts.
//
// If workers cannot be created, or the pool fails mid-scan, the scan runs inline. Correctness
// never depends on the pool; only latency and throughput do.

import { readFileSync } from "node:fs";
import type { NormalizedEvent } from "@chimera/protocol";
import { createWorkerPool, pooledWorkerSource, type WorkerPool } from "./worker-pool.js";

/** One sealed segment to consider, newest-first in the order the caller wants them read. */
export type SegmentRef = { file: string; startSeq: number };

export type SegmentScanRequest = {
  /** Newest-first. The scan walks these in order and STOPS once it has `need` matches, so an
   *  ordinary transcript request reads one segment rather than sixty. */
  segments: readonly SegmentRef[];
  agentId: string | null;
  toSeq?: number | undefined;
  kind?: string | undefined;
  need: number;
  /** SEARCH-PREFILTER: when present, only events whose RAW LINE contains the phrase (or every
   *  token) come back.
   *
   *  Deliberately a coarse test on the serialized line rather than the real scoring, which stays
   *  on the main thread. The line is a SUPERSET of every field chronicleDocument would extract, so
   *  a line without the token cannot match — no false negatives — and the false positives it does
   *  let through are re-checked properly by the real scorer against a set small enough not to
   *  matter. That is what moves the 575 MB read off the thread without duplicating the ranking
   *  logic into a worker source string, where it would silently drift from the original. */
  match?: { phrase: string; tokens: readonly string[] } | undefined;
};

// The scan body, shared by the worker and the inline fallback below in INTENT but written twice on
// purpose: a worker's source is a standalone string, so anything it needs must be inlined. The two
// are held together by tests that run them against each other on every case that matters — a torn
// line, a missing file, a toSeq bound, and the no-match worst case.
const SCAN_BODY = `(msg) => {
  const { readFileSync } = require("node:fs");
  const { segments, agentId, toSeq, need, match, kind } = msg;
  const out = [];
  for (const seg of segments) {
    if (out.length >= need) break;
    if (toSeq !== undefined && toSeq !== null && seg.startSeq > toSeq) continue;
    let raw;
    try { raw = readFileSync(seg.file, "utf8"); } catch { continue; }
    const hits = [];
    for (const line of raw.split("\\n")) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (typeof e.seq !== "number" || !Number.isFinite(e.seq)) continue;
      if (toSeq !== undefined && toSeq !== null && e.seq > toSeq) continue;
      if (agentId && e.agentId !== agentId) continue;
      if (kind && e.kind !== kind) continue;
      if (match) {
        const hay = line.toLowerCase();
        if (!hay.includes(match.phrase) && !match.tokens.every((t) => hay.includes(t))) continue;
      }
      hits.push(e);
    }
    // Newest-first over segments, but each segment's own events stay in append order, so the older
    // segment's hits go IN FRONT — exactly what newestMatching's concat() did.
    out.unshift(...hits);
  }
  return out;
}`;

// CAPACITY, not just non-blocking. One worker keeps a heavy read off the main thread but still
// serves those reads ONE AT A TIME: two operators opening two transcripts queue behind each other.
// Four warm workers run four in genuine parallel, and a burst grows to eight before anything
// queues — measured, a worker costs ~13 ms to start, against the seconds a job would otherwise
// spend waiting. Burst workers retire themselves once quiet. Both numbers stay under the machine's
// own ceiling because the agents this daemon supervises need it more than its log reads do.
const POOL_WARM = 4;
const POOL_BURST_MAX = 8;

// The classes of log read, and which one a freeing worker takes first. Same workers serve both —
// the split is about URGENCY, not about reserving capacity.
//
//   interactive — an operator is looking at this right now: the transcript they just opened, the
//                 tail of an agent they clicked. Latency is the whole product here.
//   background  — nobody is waiting: prefetch, projection rebuilds, anything speculative. It has
//                 all the time in the world, and must not be in front of the click.
//
// Priorities are a CONFIGURED property of the queue rather than a flag each call site sets, which
// is what stops everything from declaring itself urgent.
// `reserve: 1` is the half that makes the priority real. Ordering the queue does nothing when
// every worker is already inside a multi-second scan — measured, an interactive request still
// waited 6.1 s behind a full pool of background jobs. Holding one worker back costs one worker's
// throughput while only background work exists, and buys a click that never waits for a batch.
export const SCAN_QUEUES = [
  { name: "interactive", priority: 10 },
  { name: "background", priority: 0, reserve: 1 },
] as const;
/** The queue a caller with someone waiting on it should use. */
export const SCAN_INTERACTIVE = "interactive";
/** The queue for a scan nobody is blocked on — it may be large, and must yield to a click. */
export const SCAN_BACKGROUND = "background";
let pool: WorkerPool<SegmentScanRequest, NormalizedEvent[]> | null = null;
let poolBroken = false;

function ensurePool(): WorkerPool<SegmentScanRequest, NormalizedEvent[]> | null {
  if (pool || poolBroken) return pool;
  pool = createWorkerPool<SegmentScanRequest, NormalizedEvent[]>(pooledWorkerSource(SCAN_BODY), POOL_WARM, { max: POOL_BURST_MAX, queues: SCAN_QUEUES.map((q) => ({ ...q })) });
  if (!pool) poolBroken = true;   // no worker_threads — inline from here on
  return pool;
}

/** Release the pool. Tests call this so a suite doesn't leave workers behind. */
export function stopSegmentWorker(): void {
  const p = pool;
  pool = null;
  p?.stop();
}

/** The capacity this module provides, exposed so it can be asserted rather than assumed:
 *  `warm` always-on workers, growing to `max` under burst, `live` right now, `busy` in flight. */
export function segmentScanCapacity(): { warm: number; max: number; live: number; busy: number; depth: Record<string, number> } {
  const p = ensurePool();
  return p
    ? { warm: p.warm, max: p.max, live: p.live(), busy: p.busy(), depth: p.depth() }
    : { warm: 0, max: 0, live: 0, busy: 0, depth: {} };
}

/** Matching events from sealed segments, read off-thread when possible.
 *
 *  Returns them oldest-first across segments, which is the order newestMatching's caller expects
 *  to concat in front of the active window's own matches. */
export async function scanSegments(req: SegmentScanRequest, queue?: string): Promise<NormalizedEvent[]> {
  if (req.segments.length === 0 || req.need <= 0) return [];
  const p = ensurePool();
  if (p) {
    try {
      return await p.run(req, queue);
    } catch {
      // A pool that fails mid-scan must not fail the READ — fall through to inline.
      poolBroken = true;
      pool = null;
    }
  }
  return scanSegmentsInline(req);
}

/** The same scan, on this thread. The fallback, and the reference the worker is tested against. */
export function scanSegmentsInline(req: SegmentScanRequest): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const seg of req.segments) {
    if (out.length >= req.need) break;
    if (req.toSeq !== undefined && seg.startSeq > req.toSeq) continue;
    let raw: string;
    try { raw = readFileSync(seg.file, "utf8"); } catch { continue; }
    const hits: NormalizedEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let e: NormalizedEvent;
      try { e = JSON.parse(line) as NormalizedEvent; } catch { continue; }
      if (typeof e.seq !== "number" || !Number.isFinite(e.seq)) continue;
      if (req.toSeq !== undefined && e.seq > req.toSeq) continue;
      if (req.agentId && e.agentId !== req.agentId) continue;
      if (req.kind && e.kind !== req.kind) continue;
      if (req.match) {
        const hay = line.toLowerCase();
        if (!hay.includes(req.match.phrase) && !req.match.tokens.every((t) => hay.includes(t))) continue;
      }
      hits.push(e);
    }
    out.unshift(...hits);
  }
  return out;
}
