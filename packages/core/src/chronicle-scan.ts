// CHRONICLE-SEMANTIC — the cosine scan, moved off the event loop.
//
// Measured on this machine (dim 384, int8 vectors): 12.5 ms at 50k docs, 59 ms at 150k, 169 ms at
// 400k. Node is single-threaded, so a synchronous scan of that length stalls EVERYTHING the daemon
// is doing — other agents' RPC responses, event streaming to the UI, timers. Concurrency at the
// transport layer cannot fix that; only getting the work off the thread can.
//
// The worker is created from an INLINE source string ({ eval: true }) rather than a file path,
// because the daemon ships as a single `bun build --compile` binary (docs/RELEASE-BUNDLING.md) and
// a sibling .js the worker would have to load does not exist inside it.
//
// Vectors live in SharedArrayBuffers so the worker reads the SAME memory — a 58 MB copy per query
// would cost more than the scan it is meant to accelerate.
//
// If a worker cannot be created for any reason, the scan runs inline. Correctness never depends on
// the worker; only latency does.

import { Worker } from "node:worker_threads";

export type ScanBlock = { vectors: Int8Array; count: number; base: number };
export type ScanResult = { id: number; score: number };

// Kept in sync with chronicle-index.ts's QUANT_SCALE only in the sense that both assume the doc
// side is int8 and the query side is float32 — the scan returns UNNORMALIZED dot products, which is
// all an ordering needs.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (msg) => {
  const { blocks, query, k, dim } = msg;
  const q = new Float32Array(query);
  // A bounded min-heap would be asymptotically better; at k<=1000 a sorted insert into a small
  // array wins on constants and stays obvious.
  const top = [];
  let worst = -Infinity;
  for (const b of blocks) {
    const v = new Int8Array(b.buf);
    for (let i = 0; i < b.count; i++) {
      const base = i * dim;
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += v[base + d] * q[d];
      if (dot <= 0) continue;
      if (top.length < k) {
        top.push({ id: b.base + i, score: dot });
        if (top.length === k) { top.sort((a, c) => c.score - a.score); worst = top[k - 1].score; }
      } else if (dot > worst) {
        top[k - 1] = { id: b.base + i, score: dot };
        top.sort((a, c) => c.score - a.score);
        worst = top[k - 1].score;
      }
    }
  }
  top.sort((a, c) => c.score - a.score);
  parentPort.postMessage(top);
});
`;

let worker: Worker | null = null;
let workerBroken = false;

function ensureWorker(): Worker | null {
  if (worker || workerBroken) return worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true });
    worker.unref();   // never hold the process open on account of the index
    worker.on("error", () => { workerBroken = true; worker = null; });
    worker.on("exit", () => { worker = null; });
    return worker;
  } catch {
    workerBroken = true;   // e.g. a runtime without worker_threads — inline from here on
    return null;
  }
}

/** Release the worker. Tests call this so a suite doesn't leave one behind. */
export function stopScanWorker(): void {
  const w = worker;
  worker = null;
  void w?.terminate();
}

/** Top-`k` blocks by dot product, computed off-thread when possible. `base` is the global id of a
 *  block's slot 0, so the caller gets stable ids back without a second mapping pass. */
export async function scanTopK(blocks: readonly ScanBlock[], query: Float32Array, k: number): Promise<ScanResult[]> {
  const live = blocks.filter((b) => b.count > 0);
  if (live.length === 0 || k <= 0) return [];
  const w = ensureWorker();
  if (w) {
    try {
      return await postScan(w, live, query, k);
    } catch {
      // A worker that fails mid-scan must not fail the SEARCH — fall through to inline.
      workerBroken = true;
      worker = null;
    }
  }
  return scanInline(live, query, k);
}

function postScan(w: Worker, blocks: readonly ScanBlock[], query: Float32Array, k: number): Promise<ScanResult[]> {
  return new Promise<ScanResult[]>((resolve, reject) => {
    const onMessage = (res: ScanResult[]): void => { cleanup(); resolve(res); };
    const onError = (err: Error): void => { cleanup(); reject(err); };
    const cleanup = (): void => { w.off("message", onMessage); w.off("error", onError); };
    w.once("message", onMessage);
    w.once("error", onError);
    // The query is small enough to copy; the vectors are not, which is why they are shared.
    w.postMessage({
      blocks: blocks.map((b) => ({ buf: b.vectors.buffer, count: b.count, base: b.base })),
      query: Float32Array.from(query),
      k, dim: query.length,
    });
  });
}

export function scanInline(blocks: readonly ScanBlock[], query: Float32Array, k: number): ScanResult[] {
  const dim = query.length;
  const scored: ScanResult[] = [];
  for (const b of blocks) {
    for (let i = 0; i < b.count; i++) {
      const base = i * dim;
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += b.vectors[base + d]! * query[d]!;
      // A zero vector (a doc appended but not yet embedded) scores 0 and drops out here rather than
      // landing anywhere in the order — absent, never wrong.
      if (dot > 0) scored.push({ id: b.base + i, score: dot });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
