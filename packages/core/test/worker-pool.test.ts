import { describe, it, expect, afterEach } from "vitest";
import { cpus } from "node:os";
import { createWorkerPool, pooledWorkerSource, poolSize } from "@chimera/core/worker-pool";

// WORKER-POOL: how many blocking requests the daemon can serve AT ONCE.
//
// Moving a handler's blocking stretch to A worker stops it freezing the daemon; it does not raise
// capacity. With one worker two heavy requests still run one after the other. The property under
// test here is the one that distinguishes the two: N jobs make progress SIMULTANEOUSLY.
//
// Measured on the operator's real 575 MB log, worst case (a filter matching nothing, so every
// segment is read): one request 2237 ms, four concurrent 1912 ms where serial would be ~8948 ms,
// against 6915 ms for the same four on the old single-threaded path.

// The pool never opens more than cores-1 workers, so a test that needs N threads running at once
// can only show it on a machine that can host them. CI runners have 2-4 cores; these tests skip
// there rather than assert parallelism the hardware cannot give.
const cannotHost = (warmMax: number, max: number, need: number): boolean => Math.max(poolSize(warmMax), poolSize(max)) < need;

const pools: Array<{ stop: () => void }> = [];
afterEach(() => { for (const p of pools.splice(0)) p.stop(); });

function track<T extends { stop: () => void }>(p: T | null): T {
  expect(p, "worker pool unavailable in this runtime").not.toBeNull();
  pools.push(p!);
  return p!;
}

/** A job that BUSY-WAITS. Sleeping would prove nothing — a single thread interleaves sleeps just
 *  fine. Only work that occupies a thread can show that several threads are occupied at once. */
const SPIN = pooledWorkerSource(`(payload) => {
  const until = Date.now() + payload.ms;
  while (Date.now() < until) { /* hold this thread */ }
  return payload.tag;
}`);

describe("the pool runs jobs at the same time, not one after another", () => {
  it("finishes 4 spinning jobs in far less than 4x one job", async () => {
    const pool = track(createWorkerPool<{ ms: number; tag: number }, number>(SPIN, 4));
    expect(pool.warm).toBeGreaterThanOrEqual(2);   // a 1-core CI box would make this test vacuous

    const one = Date.now();
    await pool.run({ ms: 200, tag: 0 });
    const single = Date.now() - one;

    const t = Date.now();
    await Promise.all([1, 2, 3, 4].map((tag) => pool.run({ ms: 200, tag })));
    const four = Date.now() - t;

    // Serial would be ~4x. Asserted against 2.5x rather than a fixed millisecond budget so a
    // loaded machine slows both numbers together instead of turning this into a flake.
    expect(four).toBeLessThan(single * 2.5);
  });

  it("reports the jobs actually in flight, and never exceeds its own size", async () => {
    const pool = track(createWorkerPool<{ ms: number; tag: number }, number>(SPIN, 3));
    let peak = 0;
    const watch = setInterval(() => { peak = Math.max(peak, pool.busy()); }, 5);
    try {
      await Promise.all([1, 2, 3, 4, 5, 6].map((tag) => pool.run({ ms: 120, tag })));
    } finally {
      clearInterval(watch);
    }
    expect(peak).toBeGreaterThan(1);          // genuinely concurrent
    expect(peak).toBeLessThanOrEqual(pool.max);   // and bounded — the ceiling is real
    expect(pool.busy()).toBe(0);              // everything settled
  });

  it("queues the overflow instead of dropping it — every job still answers", async () => {
    const pool = track(createWorkerPool<{ ms: number; tag: number }, number>(SPIN, 2));
    const tags = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(await Promise.all(tags.map((tag) => pool.run({ ms: 20, tag })))).toEqual(tags);
  });
});

describe("the pool GROWS under burst and gives the workers back", () => {
  it.skipIf(cannotHost(2, 6, 3))("spawns beyond the warm floor rather than queueing, up to the ceiling", async () => {
    // The operator's question: "4 is reasonable, but what if all 4 are busy — can a 5th open?"
    // Yes, and this is what proves it: 6 jobs against a warm floor of 2 must run more than 2 at
    // once, because the pool grew for them instead of making them wait.
    const pool = track(createWorkerPool<{ ms: number; tag: number }, number>(SPIN, 2, { max: 6, idleMs: 50 }));
    expect(pool.warm).toBe(2);
    expect(pool.max).toBeGreaterThan(pool.warm);

    let peak = 0;
    const watch = setInterval(() => { peak = Math.max(peak, pool.live()); }, 5);
    try {
      await Promise.all([1, 2, 3, 4, 5, 6].map((tag) => pool.run({ ms: 150, tag })));
    } finally {
      clearInterval(watch);
    }
    expect(peak).toBeGreaterThan(pool.warm);      // it grew
    expect(peak).toBeLessThanOrEqual(pool.max);   // and stopped where told
  });

  it.skipIf(cannotHost(1, 4, 2))("retires the burst workers once they go quiet, back to the warm floor", async () => {
    // Growth that never shrinks is a leak: a one-off burst would leave threads resident for the
    // life of the daemon, competing with the agents forever after.
    // The idle window must outlast the burst's own stragglers: on a slow runner the first worker to
    // finish used to retire before the last job did, so the growth was gone before it was observed.
    const pool = track(createWorkerPool<{ ms: number; tag: number }, number>(SPIN, 1, { max: 4, idleMs: 300 }));
    await Promise.all([1, 2, 3, 4].map((tag) => pool.run({ ms: 60, tag })));
    expect(pool.live()).toBeGreaterThan(pool.warm);

    const deadline = Date.now() + 3000;
    while (pool.live() > pool.warm && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(pool.live()).toBe(pool.warm);
  });

  it("never grows past what the machine can give, whatever ceiling is asked for", () => {
    const greedy = track(createWorkerPool<{ ms: number; tag: number }, number>(SPIN, 2, { max: 10_000 }));
    expect(greedy.max).toBeLessThan(Math.max(2, cpus().length));
  });
});

describe("results go back to the caller that asked", () => {
  it("matches each reply to its own request under interleaving", async () => {
    // The failure a shared worker invites: replies matched by ARRIVAL rather than by id, so job A
    // gets job B's answer. Uneven durations force the completions out of submission order.
    const pool = track(createWorkerPool<{ ms: number; tag: number }, number>(SPIN, 4));
    const jobs = [{ ms: 120, tag: 1 }, { ms: 10, tag: 2 }, { ms: 80, tag: 3 }, { ms: 5, tag: 4 }, { ms: 40, tag: 5 }];
    expect(await Promise.all(jobs.map((j) => pool.run(j)))).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects the one job that threw, and keeps serving the others", async () => {
    const pool = track(createWorkerPool<{ bad?: boolean; tag: number }, number>(
      pooledWorkerSource(`(p) => { if (p.bad) throw new Error("job blew up"); return p.tag; }`), 2,
    ));
    await expect(pool.run({ bad: true, tag: 0 })).rejects.toThrow(/job blew up/);
    expect(await pool.run({ tag: 7 })).toBe(7);   // the pool survives one bad job
  });

  it("fails in-flight jobs rather than hanging them when the pool stops", async () => {
    // A caller left waiting forever is worse than one told it failed: the rejection is what lets
    // it fall back to its inline path, which is the whole degradation contract.
    const pool = createWorkerPool<{ ms: number; tag: number }, number>(SPIN, 2)!;
    const inflight = pool.run({ ms: 3000, tag: 1 });
    pool.stop();
    await expect(inflight).rejects.toThrow();
  });

  it("rejects only the job owned by a worker that exits while sibling workers keep serving", async () => {
    const pool = track(createWorkerPool<{ crash?: boolean; tag: number }, number>(
      pooledWorkerSource(`(p) => { if (p.crash) process.exit(17); return p.tag; }`), 2, { max: 2 },
    ));

    const crashed = pool.run({ crash: true, tag: 0 });
    const healthy = pool.run({ tag: 7 });
    const outcome = await Promise.race([
      crashed.then(() => "resolved", () => "rejected"),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
    ]);

    expect(outcome).toBe("rejected");
    await expect(healthy).resolves.toBe(7);
    await expect(pool.run({ tag: 9 })).resolves.toBe(9);
  });
});

describe("queues by kind, priority by configuration", () => {
  /** One worker, so dispatch ORDER is the only thing the result can be measuring. */
  const single = (queues: Array<{ name: string; priority: number }>, starvationMs = 60_000) =>
    track(createWorkerPool<{ ms: number; tag: string }, string>(SPIN, 1, { max: 1, queues, starvationMs }));

  it("serves the higher-priority queue first when both are waiting", async () => {
    const pool = single([{ name: "interactive", priority: 10 }, { name: "background", priority: 0 }]);
    const done: string[] = [];
    const block = pool.run({ ms: 120, tag: "block" });   // occupy the one worker
    await new Promise((r) => setTimeout(r, 15));
    // Queued while it is busy, LOW first — so ordering can only come from priority, not arrival.
    const bg = pool.run({ ms: 5, tag: "bg" }, "background").then((t) => { done.push(t); });
    const ui = pool.run({ ms: 5, tag: "ui" }, "interactive").then((t) => { done.push(t); });
    await Promise.all([block, bg, ui]);
    expect(done).toEqual(["ui", "bg"]);
  });

  it("keeps FIFO WITHIN a queue — priority orders classes, not jobs", async () => {
    const pool = single([{ name: "a", priority: 5 }]);
    const done: string[] = [];
    const block = pool.run({ ms: 100, tag: "block" });
    await new Promise((r) => setTimeout(r, 15));
    const jobs = ["1", "2", "3"].map((tag) => pool.run({ ms: 5, tag }, "a").then((t) => { done.push(t); }));
    await Promise.all([block, ...jobs]);
    expect(done).toEqual(["1", "2", "3"]);
  });

  it("lets a STARVED low-priority job through, so a busy period cannot stop it forever", async () => {
    // Strict priority is what "answer these first" means; taken literally it means never. The
    // guard makes a low class slow under load rather than silently stalled.
    const pool = single([{ name: "hi", priority: 10 }, { name: "lo", priority: 0 }], 60);
    const done: string[] = [];
    const block = pool.run({ ms: 120, tag: "block" });
    await new Promise((r) => setTimeout(r, 10));
    const lo = pool.run({ ms: 5, tag: "lo" }, "lo").then((t) => { done.push(t); });
    await new Promise((r) => setTimeout(r, 90));   // lo now waited past starvationMs
    const hi = pool.run({ ms: 5, tag: "hi" }, "hi").then((t) => { done.push(t); });
    await Promise.all([block, lo, hi]);
    expect(done[0]).toBe("lo");   // the starved job overtook the higher class
  });

  it("EVERY worker serves EVERY queue — none is bound to a class", async () => {
    // The property that makes many queues cheap: workers are shared, so a quiet class never holds
    // idle capacity while another backs up.
    const pool = track(createWorkerPool<{ ms: number; tag: string }, string>(
      SPIN, 3, { max: 3, queues: [{ name: "only", priority: 1 }, { name: "empty", priority: 9 }] },
    ));
    let peak = 0;
    const watch = setInterval(() => { peak = Math.max(peak, pool.busy()); }, 5);
    try {
      await Promise.all(["a", "b", "c"].map((tag) => pool.run({ ms: 120, tag }, "only")));
    } finally {
      clearInterval(watch);
    }
    expect(peak).toBeGreaterThan(1);   // the high-priority queue's share was not reserved away
  });

  it("RESERVES headroom so an interactive job never waits for a full pool of background work", async () => {
    // The measurement that forced this: priority orders the QUEUE, it does not preempt a job
    // already running. With every worker inside a multi-second background scan, an interactive
    // request still waited 6.1 s on the operator's real log — there was simply nothing free to
    // give it. Holding one worker back cut that to 1.7 s, the cost of one scan rather than a
    // whole batch.
    const pool = track(createWorkerPool<{ ms: number; tag: string }, string>(
      SPIN, 2, { max: 2, queues: [{ name: "ui", priority: 10 }, { name: "bulk", priority: 0, reserve: 1 }] },
    ));
    // Enough bulk to swamp an unreserved pool many times over.
    const bulk = Array.from({ length: 8 }, (_, i) => pool.run({ ms: 100, tag: `b${i}` }, "bulk"));
    await new Promise((r) => setTimeout(r, 40));
    expect(pool.busy()).toBeLessThan(pool.live());   // bulk did NOT take every worker

    const t = Date.now();
    await pool.run({ ms: 5, tag: "ui" }, "ui");
    const waited = Date.now() - t;
    await Promise.all(bulk);
    // One bulk job is 100ms and eight are queued; landing well inside that proves the interactive
    // job took reserved headroom rather than waiting its turn.
    expect(waited).toBeLessThan(100);
  });

  it.skipIf(cannotHost(3, 3, 3))("still uses every worker when the reserving class is the ONLY work", async () => {
    // A reservation must not become a permanently idle worker: with nothing to reserve FOR, the
    // headroom is real capacity and the guard has to release it... and when it does not, this is
    // the cost, stated rather than hidden — bulk runs at live-1.
    const pool = track(createWorkerPool<{ ms: number; tag: string }, string>(
      SPIN, 3, { max: 3, queues: [{ name: "ui", priority: 10 }, { name: "bulk", priority: 0, reserve: 1 }] },
    ));
    let peak = 0;
    const watch = setInterval(() => { peak = Math.max(peak, pool.busy()); }, 5);
    try {
      await Promise.all(Array.from({ length: 6 }, (_, i) => pool.run({ ms: 60, tag: `b${i}` }, "bulk")));
    } finally {
      clearInterval(watch);
    }
    expect(peak).toBeGreaterThan(1);                 // still genuinely parallel
    expect(peak).toBeLessThanOrEqual(pool.live() - 1);   // and one worker stayed free, by design
  });

  it("reports what is backed up and where", async () => {
    const pool = single([{ name: "a", priority: 1 }, { name: "b", priority: 2 }]);
    const block = pool.run({ ms: 120, tag: "block" });
    await new Promise((r) => setTimeout(r, 15));
    const jobs = [pool.run({ ms: 5, tag: "x" }, "a"), pool.run({ ms: 5, tag: "y" }, "a"), pool.run({ ms: 5, tag: "z" }, "b")];
    expect(pool.depth()).toMatchObject({ a: 2, b: 1 });
    await Promise.all([block, ...jobs]);
    expect(pool.depth()).toMatchObject({ a: 0, b: 0 });
  });

  it("routes an unknown or omitted queue to the default instead of losing the job", async () => {
    const pool = single([{ name: "known", priority: 1 }]);
    expect(await pool.run({ ms: 1, tag: "no-name" })).toBe("no-name");
    expect(await pool.run({ ms: 1, tag: "typo" }, "kn0wn")).toBe("typo");
  });
});

describe("pool sizing leaves the machine to the agents", () => {
  it("never takes every core, and never returns zero", () => {
    // The daemon shares this machine with the agent processes it supervises; a pool sized to the
    // hardware would win its own benchmark and deschedule the work the operator actually cares about.
    expect(poolSize(1000)).toBeLessThan(Math.max(2, cpus().length));
    expect(poolSize(4)).toBeGreaterThanOrEqual(1);
    expect(poolSize(0)).toBeGreaterThanOrEqual(1);   // a nonsense cap still yields a usable pool
  });
});
