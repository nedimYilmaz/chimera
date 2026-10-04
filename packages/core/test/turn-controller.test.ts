import { describe, it, expect, vi } from "vitest";
import { TurnController } from "@chimera/core/turn-controller";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TurnController", () => {
  it("fires onTimeout('idle') after idleTimeoutMs of no heartbeat()", async () => {
    const ctl = new TurnController({ idleTimeoutMs: 20 });
    const onTimeout = vi.fn();
    ctl.beginTurn(onTimeout);
    await wait(60);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith("idle");
  });

  it("heartbeat() postpones the idle timer — a fast enough stream never idles out", async () => {
    const ctl = new TurnController({ idleTimeoutMs: 30 });
    const onTimeout = vi.fn();
    ctl.beginTurn(onTimeout);
    for (let i = 0; i < 5; i++) {
      await wait(15);
      ctl.heartbeat();
    }
    expect(onTimeout).not.toHaveBeenCalled();
    ctl.endTurn();
  });

  it("fires onTimeout('max-duration') even under continuous heartbeats", async () => {
    const ctl = new TurnController({ idleTimeoutMs: 1000, maxDurationMs: 30 });
    const onTimeout = vi.fn();
    ctl.beginTurn(onTimeout);
    const beats = setInterval(() => ctl.heartbeat(), 5);
    await wait(60);
    clearInterval(beats);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith("max-duration");
  });

  it("first-writer-wins when idle and max-duration would fire around the same time", async () => {
    const ctl = new TurnController({ idleTimeoutMs: 15, maxDurationMs: 15 });
    const onTimeout = vi.fn();
    ctl.beginTurn(onTimeout);
    await wait(50);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("endTurn() clears pending timers — no late fire into a subsequent unrelated turn", async () => {
    const ctl = new TurnController({ idleTimeoutMs: 20 });
    const onTimeout = vi.fn();
    ctl.beginTurn(onTimeout);
    ctl.endTurn();
    await wait(50);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("consumeTimeout() is read-once", async () => {
    const ctl = new TurnController({ idleTimeoutMs: 10 });
    ctl.beginTurn(() => {});
    await wait(40);
    expect(ctl.consumeTimeout()).toBe("idle");
    expect(ctl.consumeTimeout()).toBeNull();
  });

  it("both options undefined ⇒ inert no-op, onTimeout never fires", async () => {
    const ctl = new TurnController({});
    const onTimeout = vi.fn();
    ctl.beginTurn(onTimeout);
    ctl.heartbeat();
    await wait(30);
    ctl.endTurn();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("beginTurn() called again without an intervening endTurn() discards the stale timers (no leaked early fire)", async () => {
    const ctl = new TurnController({ maxDurationMs: 20 });
    const onTimeout1 = vi.fn();
    ctl.beginTurn(onTimeout1);         // would fire at ~t=20 if left alone
    await wait(10);
    const onTimeout2 = vi.fn();
    ctl.beginTurn(onTimeout2);         // re-arm at t=10 -- fresh 20ms budget, old timer must be discarded
    await wait(15);                    // t=25: old timer's original deadline (t=20) has passed
    expect(onTimeout1).not.toHaveBeenCalled();
    expect(onTimeout2).not.toHaveBeenCalled();
    await wait(15);                    // t=40: new timer's deadline (t=10+20=30) has passed
    expect(onTimeout2).toHaveBeenCalledTimes(1);
    expect(onTimeout2).toHaveBeenCalledWith("max-duration");
  });

  it("elapsedMs tracks time since beginTurn()", async () => {
    const ctl = new TurnController({});
    ctl.beginTurn(() => {});
    await wait(30);
    expect(ctl.elapsedMs).toBeGreaterThanOrEqual(25);
    ctl.endTurn();
  });
});
