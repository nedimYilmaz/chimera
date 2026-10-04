import { describe, it, expect } from "vitest";
import { InterruptibleTurnLoop } from "@chimera/core/backend-kit";

describe("InterruptibleTurnLoop", () => {
  it("shift() returns a queued push() synchronously, in FIFO order, with no await needed", () => {
    const loop = new InterruptibleTurnLoop();
    loop.push("a");
    loop.push("b");
    expect(loop.shift()).toBe("a");
    expect(loop.shift()).toBe("b");
  });

  it("pending() is a non-destructive FIFO snapshot that later pushes and shifts do not mutate", () => {
    const loop = new InterruptibleTurnLoop();
    loop.push("a");
    loop.push("b");
    const snapshot = loop.pending();
    expect(snapshot).toEqual(["a", "b"]);
    expect(loop.shift()).toBe("a");
    loop.push("c");
    expect(snapshot).toEqual(["a", "b"]);
    expect(loop.pending()).toEqual(["b", "c"]);
  });

  it("shift() on an empty, unarmed queue returns undefined synchronously, no grace wait", () => {
    const loop = new InterruptibleTurnLoop({ graceMs: 60_000 });
    expect(loop.armed).toBe(false);
    expect(loop.shift()).toBeUndefined();
  });

  it("beginTurn() returns a fresh AbortController each call", () => {
    const loop = new InterruptibleTurnLoop();
    const a = loop.beginTurn();
    const b = loop.beginTurn();
    expect(a).not.toBe(b);
    expect(a.signal.aborted).toBe(false);
  });

  it("interrupt() aborts the current turn's controller", () => {
    const loop = new InterruptibleTurnLoop();
    const controller = loop.beginTurn();
    expect(controller.signal.aborted).toBe(false);
    loop.interrupt();
    expect(controller.signal.aborted).toBe(true);
  });

  it("consumeInterrupt() returns true exactly once per interrupt() and arms the grace window", async () => {
    const loop = new InterruptibleTurnLoop({ graceMs: 20 });
    loop.beginTurn();
    loop.interrupt();
    expect(loop.consumeInterrupt()).toBe(true);
    expect(loop.consumeInterrupt()).toBe(false);   // already consumed — not re-armed until another interrupt()
    expect(loop.armed).toBe(true);

    // armed + shift()-returned-undefined is when a caller should await waitForNext()
    expect(loop.shift()).toBeUndefined();
    const start = Date.now();
    const p = loop.waitForNext();
    await new Promise((r) => setTimeout(r, 5));
    loop.push("late");
    expect(await p).toBe("late");
    expect(Date.now() - start).toBeLessThan(20);   // push() woke it before the grace timer fired
  });

  it("waitForNext() gives up after graceMs when no follow-up push() arrives", async () => {
    const loop = new InterruptibleTurnLoop({ graceMs: 15 });
    loop.beginTurn();
    loop.interrupt();
    loop.consumeInterrupt();
    const start = Date.now();
    expect(await loop.waitForNext()).toBeUndefined();
    expect(Date.now() - start).toBeGreaterThanOrEqual(14);
    expect(loop.armed).toBe(false);   // cleared once the wait resolves, win or lose
  });

  it("waitForInput() holds an idle persistent loop until input arrives or close wakes it", async () => {
    const loop = new InterruptibleTurnLoop();
    const input = loop.waitForInput();
    loop.push("follow up");
    await expect(input).resolves.toBe("follow up");

    const closed = loop.waitForInput();
    loop.close();
    await expect(closed).resolves.toBeUndefined();
    expect(loop.closed).toBe(true);
  });

  it("consumeInterrupt() is false when the turn failed for a reason other than interrupt()", () => {
    const loop = new InterruptibleTurnLoop();
    loop.beginTurn();
    expect(loop.consumeInterrupt()).toBe(false);
  });

  it("kill() aborts the current controller, sets killed, and wakes a pending waitForNext()", async () => {
    const loop = new InterruptibleTurnLoop({ graceMs: 60_000 });
    loop.beginTurn();
    loop.interrupt();
    loop.consumeInterrupt();                 // arm the grace window
    const p = loop.waitForNext();
    expect(loop.killed).toBe(false);
    const start = Date.now();
    loop.kill();
    expect(loop.killed).toBe(true);
    await p;                                 // resolves promptly, not after the 60s grace timer
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("kill() is idempotent and safe with no turn ever begun", () => {
    const loop = new InterruptibleTurnLoop();
    expect(() => loop.kill()).not.toThrow();
    expect(() => loop.kill()).not.toThrow();
    expect(loop.killed).toBe(true);
  });

  it("ended starts false and becomes true only after end() is called", () => {
    const loop = new InterruptibleTurnLoop();
    expect(loop.ended).toBe(false);
    loop.end();
    expect(loop.ended).toBe(true);
  });

  it("graceMs defaults to 250, matching both migrated backends' prior hardcoded default", () => {
    expect(new InterruptibleTurnLoop().graceMs).toBe(250);
  });

  it("graceMs is injectable, matching CodexAgentBackend's interruptGraceMs test seam", () => {
    expect(new InterruptibleTurnLoop({ graceMs: 0 }).graceMs).toBe(0);
  });
});
