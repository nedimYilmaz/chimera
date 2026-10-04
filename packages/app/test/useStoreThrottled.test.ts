import { describe, expect, it, vi, afterEach } from "vitest";
import { stableEqual } from "../src/state/useStore";

// RENDER-TREADMILL: the agent list re-derived and repainted every row on EVERY event.
//
// Measured with 370 agents mounted (378 row nodes, no virtualisation): one event dispatched on its
// own cost 7.7 ms — a fresh agentMeta over every agent, then three grouping passes over every row.
// At this machine's measured peak of 101 events/sec that is 778 ms of rendering per second, 78% of
// the main thread, before the operator has typed anything. Typing adds its own re-render chain and
// the window stops responding. Reported as the agent list freezing when you type in its search.
//
// Two changes: the fleet-scaling slice is SAMPLED rather than read on every dispatch, and the
// per-row store subscription added with the mark feature (one per mounted agent — 378 of them, all
// re-running per event, for a boolean the list already had) became a prop.
//
// The property that matters for correctness is that sampling drops PAINTS, never VALUES.

afterEach(() => vi.useRealTimers());

/** The throttle's scheduling, extracted as the hook implements it. Exercised directly rather than
 *  through a mounted component because react-test-renderer's act() flushes timers synchronously —
 *  it would report a coalescing window that never coalesces, which is worse than no test. */
function makeThrottle<T>(ms: number, onFlush: (v: T) => void) {
  let latest: T | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlush = 0;
  const flush = (): void => { timer = null; lastFlush = Date.now(); onFlush(latest as T); };
  return {
    push(next: T): void {
      if (latest !== undefined && stableEqual(latest, next)) return;
      latest = next;
      if (timer !== null) return;
      const wait = ms - (Date.now() - lastFlush);
      if (wait <= 0) flush(); else timer = setTimeout(flush, wait);
    },
  };
}

describe("sampling a fleet-scaling slice", () => {
  it("coalesces a burst into far fewer paints than events", () => {
    vi.useFakeTimers();
    const painted: number[] = [];
    const t = makeThrottle<number>(100, (v) => painted.push(v));
    // 100 events over one second — this machine's measured peak rate.
    for (let i = 1; i <= 100; i++) { t.push(i); vi.advanceTimersByTime(10); }
    expect(painted.length).toBeLessThan(15);   // ~10 at 100ms, not 100
  });

  it("ALWAYS paints the last value — sampling drops paints, never values", () => {
    // The property that makes this safe. A throttle that can lose the final update would leave the
    // list showing an agent state that has already changed, which is worse than a slow list.
    vi.useFakeTimers();
    const painted: number[] = [];
    const t = makeThrottle<number>(100, (v) => painted.push(v));
    for (let i = 1; i <= 50; i++) t.push(i);   // all within one window
    vi.advanceTimersByTime(200);
    expect(painted.at(-1)).toBe(50);
  });

  it("paints the FIRST change immediately — a quiet list stays responsive", () => {
    vi.useFakeTimers();
    const painted: number[] = [];
    const t = makeThrottle<number>(100, (v) => painted.push(v));
    t.push(7);
    expect(painted).toEqual([7]);   // no delay when nothing was pending
  });

  it("does not paint at all when the value is unchanged", () => {
    // `agents` is a fresh OBJECT on every event even when the part this reader cares about is the
    // same; stableEqual is what turns that into no work.
    vi.useFakeTimers();
    const painted: unknown[] = [];
    const t = makeThrottle<{ a: number }>(100, (v) => painted.push(v));
    t.push({ a: 1 });
    for (let i = 0; i < 20; i++) { t.push({ a: 1 }); vi.advanceTimersByTime(50); }
    expect(painted.length).toBe(1);
  });
});
