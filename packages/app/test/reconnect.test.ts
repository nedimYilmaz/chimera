import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { createReconnectRefetcher, createSnapshotLoader, isReconnectTransition, RECONNECT_REPLAY_LIMIT, SNAPSHOT_RETRY_DELAYS_MS } from "../src/state/reconnect";

// Final-acceptance MAJOR 4 — the reconnect refetch (coverage A6-1): pure
// transition rule + the guarded refetcher, against stub deps (this module is
// import-safe by design — no bridge/store).

const ev = (seq: number): NormalizedEvent =>
  ({ ts: seq, seq, agentId: "a", kind: "status", data: {} }) as NormalizedEvent;

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeDeps(overrides: { replay?: (p: { fromSeq: number; limit: number }) => Promise<NormalizedEvent[]> } = {}) {
  const calls = { replayParams: [] as Array<{ fromSeq: number; limit: number }>, dispatched: [] as number[], refetches: 0, errors: [] as unknown[] };
  let lastSeq = 41;
  const deps = {
    getLastSeq: () => lastSeq,
    setLastSeq: (n: number) => { lastSeq = n; },
    replay: overrides.replay ?? (async (p: { fromSeq: number; limit: number }) => {
      calls.replayParams.push(p);
      return [ev(42), ev(43)];
    }),
    dispatchEvent: (e: NormalizedEvent) => { calls.dispatched.push(e.seq); },
    refetch: async () => { calls.refetches++; },
    onError: (e: unknown) => { calls.errors.push(e); },
  };
  return { deps, calls };
}

describe("isReconnectTransition", () => {
  it("fires only on re-entry into connected from a down state", () => {
    expect(isReconnectTransition("reconnecting", "connected")).toBe(true);
    expect(isReconnectTransition("disconnected", "connected")).toBe(true);
  });
  it("the very first connected (attach snapshot, prev=null) is the boot — no refetch", () => {
    expect(isReconnectTransition(null, "connected")).toBe(false);
  });
  it("no refetch on connected→connected or on any transition into a down state", () => {
    expect(isReconnectTransition("connected", "connected")).toBe(false);
    expect(isReconnectTransition("connected", "reconnecting")).toBe(false);
    expect(isReconnectTransition("connected", "disconnected")).toBe(false);
    expect(isReconnectTransition(null, "disconnected")).toBe(false);
    expect(isReconnectTransition("reconnecting", "disconnected")).toBe(false);
  });
});

describe("createReconnectRefetcher", () => {
  it("boot-while-up: connected first → nothing runs; a later drop+return runs ONE pass", async () => {
    const { deps, calls } = makeDeps();
    const on = createReconnectRefetcher(deps);
    on("connected");
    await tick();
    expect(calls.refetches).toBe(0);
    on("reconnecting");
    on("connected");
    await tick();
    expect(calls.refetches).toBe(1);
    expect(calls.replayParams).toEqual([{ fromSeq: 42, limit: RECONNECT_REPLAY_LIMIT }]); // lastSeq(41)+1
    expect(calls.dispatched).toEqual([42, 43]); // gap-fill dispatched in seq order
  });

  it("boot-while-down: disconnected first, then connected → the pass runs (retries the failed initial load)", async () => {
    const { deps, calls } = makeDeps();
    const on = createReconnectRefetcher(deps);
    on("disconnected");
    on("connected");
    await tick();
    expect(calls.refetches).toBe(1);
  });

  it("re-entrancy: a second transition while a pass is in flight is dropped", async () => {
    let release: (() => void) | null = null;
    const { deps, calls } = makeDeps({
      replay: (p) => {
        calls.replayParams.push(p);
        return new Promise((r) => { release = () => r([]); });
      },
    });
    const on = createReconnectRefetcher(deps);
    on("disconnected");
    on("connected");
    await tick();
    on("reconnecting");
    on("connected"); // lands while the first replay is parked
    await tick();
    expect(calls.replayParams).toHaveLength(1);
    release!();
    await tick();
    expect(calls.refetches).toBe(1);
  });

  it("a failed pass surfaces via onError, releases the guard, and the next transition retries", async () => {
    let fail = true;
    const { deps, calls } = makeDeps({
      replay: async (p) => {
        calls.replayParams.push(p);
        if (fail) throw new Error("replay down");
        return [];
      },
    });
    const on = createReconnectRefetcher(deps);
    on("disconnected");
    on("connected");
    await tick();
    expect(calls.errors).toHaveLength(1);
    expect(calls.refetches).toBe(0);
    fail = false;
    on("disconnected");
    on("connected");
    await tick();
    expect(calls.refetches).toBe(1);
  });
});

// BLANK-UI-AFTER-SLOW-FIRST-LOAD: the initial connectAndLoad() used to be a bare
// `void ... .catch(console.warn)`. Its only recovery path was createReconnectRefetcher, which
// fires ONLY on a transition INTO connected from a down state — so a load that failed while the
// socket stayed healthy (the daemon up but slow enough to hit the bridge's 30s call timeout,
// which is exactly what a boot that re-spawns every prior agent produces) left the app
// permanently empty, with no drop to recover from. An empty UI is never a correct resting state
// while the daemon is reachable.
describe("createSnapshotLoader (initial load retry)", () => {
  const rig = (results: Array<"ok" | "fail">) => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let attempts = 0;
    const loader = createSnapshotLoader({
      load: async () => {
        const outcome = results[attempts] ?? "ok";
        attempts++;
        if (outcome === "fail") throw new Error("rpc call timed out after 30s");
      },
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    });
    return { loader, timers, attempts: () => attempts };
  };

  it("a load that succeeds first time never schedules a retry", async () => {
    const { loader, timers, attempts } = rig(["ok"]);
    loader.run();
    await tick();
    expect(attempts()).toBe(1);
    expect(timers).toHaveLength(0);
  });

  it("a FAILED first load is retried — the case that used to leave the app blank forever", async () => {
    const { loader, timers, attempts } = rig(["fail", "ok"]);
    loader.run();
    await tick();
    expect(attempts()).toBe(1);
    expect(timers).toHaveLength(1);          // a retry was armed, not swallowed

    timers[0]!.fn();                          // fire it
    await tick();
    expect(attempts()).toBe(2);
    expect(timers).toHaveLength(1);           // succeeded — ladder stops
  });

  it("backs off along the ladder and then holds at its last delay, never giving up", async () => {
    const { loader, timers } = rig(Array(8).fill("fail"));
    loader.run();
    await tick();
    for (let i = 0; i < 7; i++) { timers[timers.length - 1]!.fn(); await tick(); }
    const delays = timers.map((t) => t.ms);
    expect(delays.slice(0, SNAPSHOT_RETRY_DELAYS_MS.length)).toEqual([...SNAPSHOT_RETRY_DELAYS_MS]);
    // past the end of the ladder it keeps retrying at the final delay rather than stopping
    expect(delays[delays.length - 1]).toBe(SNAPSHOT_RETRY_DELAYS_MS[SNAPSHOT_RETRY_DELAYS_MS.length - 1]);
  });

  it("overlapping run() calls collapse — a retry landing mid-load never doubles the work", async () => {
    let resolveLoad: (() => void) | null = null;
    let started = 0;
    const loader = createSnapshotLoader({
      load: () => { started++; return new Promise<void>((res) => { resolveLoad = res; }); },
      setTimer: (fn) => { void fn; return 0; },
    });
    loader.run();
    loader.run();
    loader.run();
    expect(started).toBe(1);
    resolveLoad!();
    await tick();
    expect(started).toBe(1);
  });

  it("a later success after many failures resets the ladder for the NEXT outage", async () => {
    const { loader, timers } = rig(["fail", "fail", "ok", "fail"]);
    loader.run(); await tick();
    timers[0]!.fn(); await tick();
    timers[1]!.fn(); await tick();            // succeeds
    const armedAfterSuccess = timers.length;
    loader.run(); await tick();               // fails again
    expect(timers).toHaveLength(armedAfterSuccess + 1);
    expect(timers[armedAfterSuccess]!.ms).toBe(SNAPSHOT_RETRY_DELAYS_MS[0]);
  });
});
