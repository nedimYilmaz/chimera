import { describe, expect, it } from "vitest";
import { FrameScheduler } from "../src/memory-graph/scheduler";

// A manual rAF pump: wake() enqueues; pump() runs one queued frame.
function makePump() {
  let next = 1;
  const queue: { h: number; cb: (n: number) => void }[] = [];
  const raf = (cb: (n: number) => void): number => {
    const h = next++;
    queue.push({ h, cb });
    return h;
  };
  const caf = (h: number): void => {
    const i = queue.findIndex((q) => q.h === h);
    if (i >= 0) queue.splice(i, 1);
  };
  const pump = (t = 0): boolean => {
    const job = queue.shift();
    if (!job) return false;
    job.cb(t);
    return true;
  };
  return { raf, caf, pump, pending: () => queue.length };
}

describe("FrameScheduler — the zero-idle-rAF state machine", () => {
  it("wake schedules exactly one frame; a false tick stops the loop dead", () => {
    const { raf, caf, pump } = makePump();
    let ticks = 0;
    const s = new FrameScheduler(() => (++ticks < 3), raf, caf);
    expect(s.isScheduled()).toBe(false);
    s.wake();
    expect(s.isScheduled()).toBe(true);
    pump(); // tick 1 → true → reschedules
    expect(s.isScheduled()).toBe(true);
    pump(); // tick 2 → true → reschedules
    pump(); // tick 3 → false → STOP
    expect(ticks).toBe(3);
    expect(s.isScheduled()).toBe(false);
    // idle: nothing more to pump, no reschedule
    expect(pump()).toBe(false);
    expect(s.frameCount).toBe(3);
  });

  it("wake is idempotent (never double-schedules)", () => {
    const { raf, caf, pending } = makePump();
    const s = new FrameScheduler(() => true, raf, caf);
    s.wake();
    s.wake();
    s.wake();
    expect(pending()).toBe(1);
  });

  it("a wake() fired inside tick re-arms the loop", () => {
    const { raf, caf, pump } = makePump();
    let n = 0;
    let self: FrameScheduler;
    // tick returns false but wakes itself once — must reschedule
    self = new FrameScheduler(() => {
      n++;
      if (n === 1) self.wake();
      return false;
    }, raf, caf);
    self.wake();
    pump(); // n=1, false but self.wake() inside → rescheduled
    expect(self.isScheduled()).toBe(true);
    pump(); // n=2, false, no wake → stop
    expect(self.isScheduled()).toBe(false);
    expect(n).toBe(2);
  });

  it("stop() cancels a pending frame", () => {
    const { raf, caf, pending } = makePump();
    const s = new FrameScheduler(() => true, raf, caf);
    s.wake();
    expect(pending()).toBe(1);
    s.stop();
    expect(pending()).toBe(0);
    expect(s.isScheduled()).toBe(false);
  });
});
