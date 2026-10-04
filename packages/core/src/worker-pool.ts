// WORKER-POOL — how many blocking requests the daemon can serve AT ONCE.
//
// The daemon runs every RPC handler on one JS thread. Offloading a handler's blocking stretch to
// A worker stops it freezing everything else, but it does not raise CAPACITY: with one worker, two
// heavy requests still run one after the other, and the second waits for the first. Ten operators'
// transcripts open at once is ten queued reads.
//
// A pool is the difference between "nothing else is blocked" and "several are served at the same
// time". N workers means N heavy requests genuinely in parallel, on N cores, while the main thread
// stays free to answer the cheap ones.
//
// SHAPE: one queue PER KIND OF WORK, and every worker serves every queue. Kinds are separated so
// their urgency can differ — a transcript the operator is staring at is not an index pass nobody
// is watching — but workers are deliberately NOT partitioned across them, because a worker bound
// to a quiet queue sits idle while another queue backs up. So: many queues, one shared set of
// workers, and `priority` decides only which job a freeing worker takes NEXT.
//
// Strict priority taken literally starves the bottom: a steady stream of interactive work would
// mean the background index never runs at all, silently, for as long as the operator is busy.
// `starvationMs` bounds that — a job waiting past it goes ahead of priority — so a low class is
// SLOWED by a busy period rather than stopped by it.
//
// SIZING is deliberately modest, not one-per-core. The daemon shares this machine with the agent
// processes it supervises — twenty of them at a few hundred MB each — and with the embedder (see
// EMBEDDER-THREAD-CAP in memory-embed.ts, capped for exactly this reason). A pool sized to the
// machine would win its own benchmark and lose the operator's: the agents doing the actual work
// would be the ones descheduled. `size` is therefore a floor-divided fraction of the cores with a
// hard cap, and every pool in the process shares that budget by choosing its own small size.
//
// Workers are created from an INLINE source string ({ eval: true }) rather than a file path,
// because the daemon ships as a single `bun build --compile` binary (docs/RELEASE-BUNDLING.md) and
// a sibling .js does not exist inside it. Same reason and shape as chronicle-scan.ts.
//
// Every pool degrades to null rather than throwing: a runtime without worker_threads, or a worker
// that dies, leaves the caller to run its own inline path. Correctness never depends on the pool;
// only throughput does.

import { Worker } from "node:worker_threads";
import { cpus } from "node:os";

/** Workers to run, given how many the caller wants at most.
 *
 *  Never every core: the agents are the point of this machine, and a daemon that wins the CPU from
 *  them has optimised the wrong process. One core is always left for the main thread itself. */
export function poolSize(max: number): number {
  const cores = Math.max(1, cpus().length);
  return Math.max(1, Math.min(max, cores - 1));
}

type Pending<R> = { resolve: (r: R) => void; reject: (e: Error) => void };

/** One class of work, and how it competes with the others for a free worker.
 *
 *  Queues exist to separate KINDS, not to own workers: a transcript read and a background index
 *  pass are different jobs with different urgency, but binding either to its own workers would
 *  leave one idle while the other is backed up. Every worker serves every queue; `priority` only
 *  decides which job it takes NEXT when several are waiting. Higher wins. */
export type QueueSpec = {
  name: string;
  priority: number;
  /** Workers this class may NOT occupy, held free for higher-priority work.
   *
   *  Priority alone orders the QUEUE; it does not preempt a job already running. Measured: with
   *  every worker inside a multi-second background scan, an interactive request still waited 6.1 s
   *  for one to finish, because there was nothing to give it. A reservation is what makes the
   *  guarantee real — background may fill all but `reserve` workers, so an interactive job always
   *  finds one free. The cost is exactly that much throughput when only background work exists,
   *  which is the price of a click never queueing behind a batch nobody is watching. */
  reserve?: number;
};

/** The default when a caller names no queue — one class, so a single-kind pool needs no config. */
const DEFAULT_QUEUE = "default";

export type WorkerPool<T, R> = {
  /** Run one job on a free worker, GROWING the pool when every warm one is busy and the ceiling
   *  allows it, and queueing (in `queue`, by its configured priority) only once the ceiling is
   *  reached. An unknown or omitted queue name lands in the default class rather than throwing —
   *  a mis-typed name must not lose the job. */
  run(payload: T, queue?: string): Promise<R>;
  /** Jobs waiting per queue, for tests and metrics — what is backed up, and where. */
  depth(): Record<string, number>;
  /** Jobs running right now — the pool's live parallelism, for tests and metrics. */
  busy(): number;
  /** Workers alive right now. Rises under burst, falls back to `warm` when the burst passes. */
  live(): number;
  /** The always-on floor, and the ceiling a burst may grow to. */
  warm: number;
  max: number;
  stop(): void;
};

/** A fixed pool of identical workers over one job kind.
 *
 *  Returns null when workers are unavailable, so a caller can keep its inline path as the fallback
 *  rather than this module inventing one it cannot type. */
export function createWorkerPool<T, R>(
  source: string,
  warmMax: number,
  opts: { max?: number; idleMs?: number; queues?: readonly QueueSpec[]; starvationMs?: number } = {},
): WorkerPool<T, R> | null {
  const warm = poolSize(warmMax);
  // ELASTIC: the ceiling a BURST may reach. Measured, a worker costs ~13 ms to start and answer —
  // far cheaper than the seconds a job would otherwise spend queued behind a busy pool, so a burst
  // is worth paying for. Still bounded by the machine: poolSize never returns every core, because
  // the agents this daemon supervises need it more than its own log reads do.
  const max = Math.max(warm, poolSize(opts.max ?? warmMax * 2));
  const idleMs = opts.idleMs ?? 10_000;
  const workers: Worker[] = [];

  // Priority is a CONFIGURED property of the queue, not a property of the job: the operator
  // decides that transcripts outrank background indexing once, rather than every call site
  // asserting its own importance (which is how everything ends up "high").
  const priorities = new Map<string, number>((opts.queues ?? []).map((q) => [q.name, q.priority]));
  const reserves = new Map<string, number>((opts.queues ?? []).map((q) => [q.name, q.reserve ?? 0]));
  if (!priorities.has(DEFAULT_QUEUE)) { priorities.set(DEFAULT_QUEUE, 0); reserves.set(DEFAULT_QUEUE, 0); }
  const queueName = (name?: string): string => (name !== undefined && priorities.has(name) ? name : DEFAULT_QUEUE);

  // STARVATION GUARD. Strict priority is what "answer these first" means, and taken literally it
  // means a steady stream of high-priority work never lets a low-priority job run AT ALL — a
  // background index that silently stops making progress for as long as the operator is busy.
  // A job waiting longer than this is served ahead of priority, so lower classes are slowed by a
  // busy period rather than stopped by it. Deliberately generous: it is a floor on fairness, not
  // a second scheduler competing with the first.
  const starvationMs = opts.starvationMs ?? 5_000;

  // Job ids rather than one-shot listeners: a worker serves many jobs over its life, and matching
  // a reply to the request that asked for it is the only thing that makes a SHARED worker safe.
  const pending = new Map<number, Pending<R>>();
  const load = new Map<Worker, number>();
  const idleSince = new Map<Worker, number>();
  // A worker can die while siblings remain healthy. Track ownership so its caller is rejected
  // immediately instead of staying in `pending` forever waiting for a reply that cannot arrive.
  const assigned = new Map<Worker, Set<number>>();
  // One queue per class. Workers are NOT partitioned across them — see QueueSpec.
  const queues = new Map<string, Array<{ id: number; payload: T; queuedAt: number }>>(
    [...priorities.keys()].map((name) => [name, []]),
  );
  let nextId = 1;
  let dead = false;

  const settle = (id: number, fn: (p: Pending<R>) => void): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    fn(p);
  };

  /** Fail every in-flight job on this worker. A dead worker must not leave callers hanging — they
   *  get a rejection they can fall back from, which is the whole degradation contract. */
  const failAll = (err: Error): void => {
    dead = true;
    for (const id of [...pending.keys()]) settle(id, (p) => p.reject(err));
    for (const q of queues.values()) q.length = 0;
  };

  /** Add one worker. Returns false when the runtime cannot make one — the caller decides whether
   *  that is fatal (no warm workers at all) or merely a burst that will not be absorbed. */
  const spawn = (): boolean => {
    let w: Worker;
    try {
      w = new Worker(source, { eval: true });
    } catch {
      return false;
    }
    w.unref();   // never hold the process open on account of a background read
    load.set(w, 0);
    idleSince.set(w, Date.now());
    assigned.set(w, new Set());
    w.on("message", (msg: { id: number; ok: boolean; result?: R; error?: string }) => {
      assigned.get(w)?.delete(msg.id);
      const next = Math.max(0, (load.get(w) ?? 1) - 1);
      load.set(w, next);
      if (next === 0) idleSince.set(w, Date.now());
      settle(msg.id, (p) => (msg.ok ? p.resolve(msg.result as R) : p.reject(new Error(msg.error ?? "worker error"))));
      pump();
      reap();
    });
    // One worker dying is not the pool dying: drop it and let the rest carry on, as long as at
    // least one remains. Only losing them ALL is unrecoverable, and that is what fails callers.
    w.on("error", (err) => workerGone(w, err));
    w.on("exit", (code) => workerGone(w, new Error(`worker exited${code === 0 ? "" : ` with code ${code}`}`)));
    workers.push(w);
    return true;
  };

  const drop = (w: Worker): void => {
    const i = workers.indexOf(w);
    if (i >= 0) workers.splice(i, 1);
    load.delete(w);
    idleSince.delete(w);
    assigned.delete(w);
  };

  const workerGone = (w: Worker, err: Error): void => {
    // `error` is normally followed by `exit`; only the first notification owns cleanup.
    if (!load.has(w)) return;
    const lost = [...(assigned.get(w) ?? [])];
    for (const id of lost) settle(id, (p) => p.reject(err));
    drop(w);
    if (workers.length === 0 && pending.size > 0) failAll(err);
    else pump();
  };

  /** Retire BURST workers that have gone quiet, back down to the warm floor. The floor stays hot
   *  so the common case never pays startup; anything above it is temporary by construction. */
  const reap = (): void => {
    if (workers.length <= warm) return;
    const now = Date.now();
    for (const w of [...workers]) {
      if (workers.length <= warm) break;
      if ((load.get(w) ?? 0) === 0 && now - (idleSince.get(w) ?? now) >= idleMs) {
        drop(w);
        void w.terminate();
      }
    }
  };

  for (let i = 0; i < warm; i++) {
    if (!spawn()) {
      for (const w of workers) void w.terminate();
      return null;   // e.g. a runtime without worker_threads
    }
  }

  /** Hand queued jobs to the least-loaded worker. Least-loaded rather than round-robin because
   *  these jobs are wildly uneven — one transcript read touches one segment, another touches
   *  sixty — and round-robin would park a short job behind a long one on the same worker while
   *  another sat idle. */
  /** The next job any free worker should take: the longest-STARVED job if one has waited past the
   *  guard, else the head of the highest-priority non-empty queue. FIFO within a class. */
  const takeNext = (): { id: number; payload: T } | null => {
    const now = Date.now();
    const running = [...load.values()].reduce((a, b) => a + b, 0);
    // A class with a reservation may not take the last `reserve` workers — that headroom is what
    // a higher-priority job arriving later will find, instead of an all-busy pool.
    const mayRun = (name: string): boolean => running + (reserves.get(name) ?? 0) < workers.length;
    let starved: { name: string; queuedAt: number } | null = null;
    let bestName: string | null = null;
    let bestPriority = -Infinity;
    for (const [name, q] of queues) {
      const head = q[0];
      if (!head) continue;
      if (!mayRun(name)) continue;   // its reservation would be spent — leave it queued
      if (now - head.queuedAt >= starvationMs && (!starved || head.queuedAt < starved.queuedAt)) {
        starved = { name, queuedAt: head.queuedAt };
      }
      const pr = priorities.get(name) ?? 0;
      if (pr > bestPriority) { bestPriority = pr; bestName = name; }
    }
    const pick = starved?.name ?? bestName;
    return pick ? queues.get(pick)!.shift() ?? null : null;
  };

  const anyQueued = (): boolean => {
    for (const q of queues.values()) if (q.length > 0) return true;
    return false;
  };

  const pump = (): void => {
    while (anyQueued()) {
      let best: Worker | null = null;
      let bestLoad = Infinity;
      for (const w of workers) {
        const l = load.get(w) ?? 0;
        if (l < bestLoad) { bestLoad = l; best = w; }
      }
      // ELASTIC: everyone busy and room under the ceiling — grow rather than queue. A job that
      // would wait seconds behind a long scan instead pays ~13 ms for a worker of its own.
      if ((!best || bestLoad >= 1) && workers.length < max && spawn()) continue;
      if (!best || bestLoad >= 1) return;   // at the ceiling — the rest waits, by design
      const job = takeNext();
      if (!job) return;
      load.set(best, bestLoad + 1);
      idleSince.delete(best);
      assigned.get(best)!.add(job.id);
      best.postMessage({ id: job.id, payload: job.payload });
    }
  };

  // A job held back purely by priority has no event of its own to wake it — the starvation guard
  // only helps if something re-checks while nothing else is happening.
  const fairness = setInterval(() => { if (anyQueued()) pump(); }, Math.max(250, starvationMs / 4));
  fairness.unref?.();

  // Retire burst workers even when nothing else arrives to trigger a reap.
  const sweep = setInterval(reap, Math.max(1000, idleMs / 2));
  sweep.unref?.();

  return {
    warm, max,
    live: () => workers.length,
    depth: () => Object.fromEntries([...queues].map(([name, q]) => [name, q.length])),
    busy: () => [...load.values()].reduce((a, b) => a + b, 0),
    run(payload: T, queue?: string): Promise<R> {
      if (dead) return Promise.reject(new Error("worker pool is down"));
      const id = nextId++;
      const name = queueName(queue);
      return new Promise<R>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        queues.get(name)!.push({ id, payload, queuedAt: Date.now() });
        pump();
      });
    },
    stop(): void {
      dead = true;
      clearInterval(sweep);
      clearInterval(fairness);
      for (const w of workers) void w.terminate();
      workers.length = 0;
      for (const id of [...pending.keys()]) settle(id, (p) => p.reject(new Error("worker pool stopped")));
    },
  };
}

/** The message loop every pooled worker's source must implement, given a body that computes one
 *  result from one payload. Wrapping it here keeps the id/ok/error protocol in ONE place — a
 *  worker that hand-rolled it and got a field name wrong would hang its callers rather than fail. */
export function pooledWorkerSource(body: string): string {
  return `
const { parentPort } = require("node:worker_threads");
const run = ${body};
parentPort.on("message", (msg) => {
  try {
    parentPort.postMessage({ id: msg.id, ok: true, result: run(msg.payload) });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
});
`;
}
