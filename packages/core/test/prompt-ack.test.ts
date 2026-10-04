import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PromptStall } from "@chimera/protocol";
import { PromptAckWatch, PROMPT_ACK_WAIT_MS, PROMPT_STALL_MS } from "@chimera/core/prompt-ack";

// The watch owns its own clock seam (deps.now), so the fake timer drives the SCHEDULE and `clock`
// drives the MEASUREMENT — advance() moves both together, which is what the supervisor does with
// a real clock and a real event loop.
function rig() {
  const stalls: Array<{ agentId: string; stall: PromptStall }> = [];
  let clock = 1_000;
  const watch = new PromptAckWatch({ now: () => clock, onStall: (agentId, stall) => stalls.push({ agentId, stall }) });
  const advance = (ms: number) => { clock += ms; vi.advanceTimersByTime(ms); };
  const arm = (over: Partial<Parameters<PromptAckWatch["armed"]>[1]> = {}) =>
    watch.armed("a1", { deliveryId: "msg-1", messageIds: ["msg-1"], from: "conductor", messageCount: 1, midTurn: false, slash: false, lastSeq: 42, preSendSeq: 42, ...over });
  return { watch, stalls, advance, arm, at: () => clock };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("PromptAckWatch (F09: proving a delivered message actually started a turn)", () => {
  it("acknowledges a provider-confirmed turn start before slow compaction or first output", async () => {
    const { watch, advance, arm, stalls } = rig();
    arm();
    advance(200);
    watch.observe("a1", "status", 43, { turnStarted: true });
    await expect(watch.await("msg-1", PROMPT_ACK_WAIT_MS)).resolves.toEqual({ ack: "started", ackMs: 200 });
    advance(250_000);
    expect(stalls).toEqual([]);
    expect(watch.isMidTurn("a1")).toBe(true);
  });

  it("session startup and unrelated status remain insufficient evidence", () => {
    const { watch, advance, arm, stalls } = rig();
    arm();
    watch.observe("a1", "agent_started", 43, { sessionId: "thread-1" });
    watch.observe("a1", "status", 44, { delivered: true });
    watch.observe("a1", "status", 45, { turnStarted: false });
    advance(PROMPT_STALL_MS);
    expect(stalls).toHaveLength(1);
  });

  it("A1: a turn-opening event after an idle delivery resolves started with the measured ackMs", async () => {
    const { watch, advance, arm } = rig();
    arm();
    const ack = watch.await("msg-1", PROMPT_ACK_WAIT_MS);
    advance(120);
    watch.observe("a1", "message_delta", 43);
    await expect(ack).resolves.toEqual({ ack: "started", ackMs: 120 });
  });

  it("A1 negative: a status{delivered:true} event alone never satisfies the ack", async () => {
    const { watch, advance, arm, stalls } = rig();
    arm();
    const ack = watch.await("msg-1", PROMPT_ACK_WAIT_MS);
    advance(10);
    watch.observe("a1", "status", 43);          // the supervisor's own delivery append
    advance(PROMPT_ACK_WAIT_MS);
    await expect(ack).resolves.toEqual({ ack: "pending", ackMs: null });
    expect(stalls).toHaveLength(0);             // still armed, not yet stalled
    advance(PROMPT_STALL_MS);
    expect(stalls).toHaveLength(1);
  });

  it("A2: a mid-turn delivery answers mid_turn, arms no timer, and never stalls", async () => {
    const { watch, advance, arm, stalls } = rig();
    watch.observe("a1", "tool_call", 7);
    expect(watch.isMidTurn("a1")).toBe(true);
    arm({ midTurn: true });
    await expect(watch.await("msg-1", PROMPT_ACK_WAIT_MS)).resolves.toEqual({ ack: "mid_turn", ackMs: null });
    expect(vi.getTimerCount()).toBe(0);
    advance(PROMPT_STALL_MS * 10);
    expect(stalls).toHaveLength(0);
  });

  it("A2: the turn a mid-turn message joined is not counted as that message's ack", async () => {
    const { watch, advance, arm } = rig();
    watch.observe("a1", "tool_call", 7);
    arm({ midTurn: true });
    advance(50);
    watch.observe("a1", "message_delta", 8);
    await expect(watch.await("msg-1", PROMPT_ACK_WAIT_MS)).resolves.toEqual({ ack: "mid_turn", ackMs: null });
  });

  it("A3: a turn opening just after the ack wait resolves pending, with no stall ever", async () => {
    const { watch, advance, arm, stalls } = rig();
    arm();
    const ack = watch.await("msg-1", PROMPT_ACK_WAIT_MS);
    advance(PROMPT_ACK_WAIT_MS + 1);
    await expect(ack).resolves.toEqual({ ack: "pending", ackMs: null });
    expect(watch.observe("a1", "message_delta", 43)).toBeUndefined();   // nothing to clear: never fired
    advance(PROMPT_STALL_MS * 2);
    expect(stalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("A4/A5: a never-answered idle delivery fires exactly one stall carrying the full evidence", () => {
    const { watch, advance, arm, stalls } = rig();
    const armedAt = 1_000;
    arm();
    watch.observe("a1", "status", 44);          // the agent is parked here, not running
    advance(PROMPT_STALL_MS);
    expect(stalls).toEqual([{
      agentId: "a1",
      stall: { deliveryId: "msg-1", from: "conductor", sinceTs: armedAt, sinceMs: PROMPT_STALL_MS, lastSeq: 44, messageCount: 1 },
    }]);
    advance(PROMPT_STALL_MS * 3);
    expect(stalls).toHaveLength(1);             // once, never a repeat alarm
  });

  it("A6: the turn that finally opens reports the delivery to clear, but only if the stall fired", () => {
    const { watch, advance, arm } = rig();
    arm();
    advance(PROMPT_STALL_MS);
    advance(500);
    expect(watch.observe("a1", "message_delta", 45)).toEqual({ deliveryId: "msg-1", ackMs: PROMPT_STALL_MS + 500 });
  });

  it("A7: forget() and dispose() leave no live timer and settle every waiter", async () => {
    const { watch, arm } = rig();
    arm();
    const ack = watch.await("msg-1", PROMPT_ACK_WAIT_MS);
    watch.forget("a1");
    await expect(ack).resolves.toEqual({ ack: "pending", ackMs: null });
    expect(vi.getTimerCount()).toBe(0);

    const second = rig();
    second.arm({ deliveryId: "msg-2", messageIds: ["msg-2"] });
    const pending = second.watch.await("msg-2", PROMPT_ACK_WAIT_MS);
    second.watch.dispose();
    await expect(pending).resolves.toEqual({ ack: "pending", ackMs: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("R5: a second unacknowledged delivery accumulates onto the first watch, it does not reset the clock", () => {
    const { watch, advance, arm, stalls } = rig();
    arm();
    advance(PROMPT_STALL_MS - 1_000);
    arm({ deliveryId: "msg-2", messageIds: ["msg-2"], messageCount: 2, lastSeq: 60 });
    expect(vi.getTimerCount()).toBe(1);         // still exactly one timer per agent
    advance(1_000);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.stall).toMatchObject({ deliveryId: "msg-1", messageCount: 3, lastSeq: 60 });
  });

  it("settles an ack proven before the caller got to await it (the arm/await race)", async () => {
    const { watch, advance, arm } = rig();
    arm();
    advance(30);
    watch.observe("a1", "message_delta", 43);   // the agent answered before send() registered
    await expect(watch.await("msg-1", PROMPT_ACK_WAIT_MS)).resolves.toEqual({ ack: "started", ackMs: 30 });
  });

  it("A11: a turn that opened inside the send/arm window settles started at once and arms no stall", async () => {
    const stalls: Array<{ agentId: string; stall: PromptStall }> = [];
    let clock = 1_000;
    const watch = new PromptAckWatch({ now: () => clock, onStall: (a, stall) => stalls.push({ agentId: a, stall }), stallMs: 5 });
    // The backend emitted its first event while deliverBatch was still inside `await
    // handle.send(...)`, so observe() ran with no binding to settle. The seqs are EQUAL on
    // purpose: supervisor.onEvent observes with events.currentSeq() BEFORE appending that event,
    // so an opening inside the window carries exactly the pre-send seq.
    watch.observe("a1", "message_complete", 42);
    watch.observe("a1", "turn_complete", 42);        // ...and the whole turn closed, too
    watch.armed("a1", {
      deliveryId: "msg-1", messageIds: ["msg-1"], from: "conductor", messageCount: 1,
      midTurn: false, slash: false, lastSeq: 42, preSendSeq: 42,
    });
    expect(vi.getTimerCount()).toBe(0);              // no stall timer for a turn that already ran
    await expect(watch.await("msg-1", PROMPT_ACK_WAIT_MS)).resolves.toEqual({ ack: "started", ackMs: 0 });
    expect(clock).toBe(1_000);                       // answered from the settled cache, not after ackWaitMs
    clock += 5_000;
    vi.advanceTimersByTime(5_000);
    expect(stalls).toHaveLength(0);
  });

  it("A11 negative: an opening from BEFORE the delivery does not count as its ack", async () => {
    const { watch, advance, arm, stalls } = rig();
    watch.observe("a1", "message_complete", 40);     // a previous turn
    watch.observe("a1", "turn_complete", 41);        // which finished before this delivery
    arm({ preSendSeq: 42 });
    const ack = watch.await("msg-1", PROMPT_ACK_WAIT_MS);
    advance(PROMPT_ACK_WAIT_MS);
    await expect(ack).resolves.toEqual({ ack: "pending", ackMs: null });
    advance(PROMPT_STALL_MS);
    expect(stalls).toHaveLength(1);                  // the stall watch is still doing its job
  });

  // The public repository ships without maintainer docs, so this doc guard runs only where the doc exists.
  const MEASUREMENT = fileURLToPath(new URL("../../../docs/superpowers/measurements/2026-09-02-prompt-ack-latency.json", import.meta.url));
  it.skipIf(!existsSync(MEASUREMENT))("A9: the constants are the measurement artifact's recommended values, correctly ordered", () => {
    const artifact = JSON.parse(readFileSync(MEASUREMENT, "utf8")) as { recommended: { promptAckWaitMs: number; promptStallMs: number } };
    expect(PROMPT_ACK_WAIT_MS).toBe(artifact.recommended.promptAckWaitMs);
    expect(PROMPT_STALL_MS).toBe(artifact.recommended.promptStallMs);
    expect(PROMPT_ACK_WAIT_MS).toBeLessThan(PROMPT_STALL_MS);
  });

  it("A9: the doc comment names the artifact, n, and the percentiles the value was derived from", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/prompt-ack.ts", import.meta.url)), "utf8");
    for (const token of ["2026-09-02-prompt-ack-latency.json", "n=400", "p50", "p95", "p99"]) {
      expect(src).toContain(token);
    }
  });
});

// A10: the stall is a REPORT. The whole point of F09 is to make a silent delivery visible without
// changing delivery itself, so the fired path must not touch the mailbox in any way.
describe("A10 source guard: the stall path never re-delivers", () => {
  const SRC = readFileSync(fileURLToPath(new URL("../src/supervisor.ts", import.meta.url)), "utf8");
  const fenced = SRC.slice(SRC.indexOf("// F09-PROMPT-STALL-FIRE:BEGIN"), SRC.indexOf("// F09-PROMPT-STALL-FIRE:END"));

  it("the fence markers exist exactly once each", () => {
    expect(SRC.split("// F09-PROMPT-STALL-FIRE:BEGIN")).toHaveLength(2);
    expect(SRC.split("// F09-PROMPT-STALL-FIRE:END")).toHaveLength(2);
    expect(fenced.length).toBeGreaterThan(0);
  });

  it("firePromptStall calls no delivery machinery", () => {
    const code = fenced.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const forbidden of [/mailboxes\./, /deliverPending\(/, /deliverBatch\(/, /\.send\(/, /enqueue\(/]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});

// F09.QA — a slash command is not a prompt. See prompt-ack.ts's `if (d.slash)` branch.
describe("PromptAckWatch: slash deliveries (F09.QA)", () => {
  it("arms no stall timer for a slash delivery — /compact runs far longer than PROMPT_STALL_MS", async () => {
    const { watch, advance, arm, stalls } = rig();
    arm({ slash: true });
    expect(vi.getTimerCount()).toBe(0);
    advance(PROMPT_STALL_MS * 4);
    expect(stalls).toHaveLength(0);
  });

  it("answers a slash delivery pending immediately instead of blocking the RPC for the ack wait", async () => {
    const { watch, arm, at } = rig();
    arm({ slash: true });
    const started = at();
    await expect(watch.await("msg-1", PROMPT_ACK_WAIT_MS)).resolves.toEqual({ ack: "pending", ackMs: null });
    expect(at()).toBe(started);           // resolved from the settled cache, no timer waited out
  });

  it("a slash delivery does not suppress the stall watch of a real prompt that follows", async () => {
    const { watch, advance, arm, stalls } = rig();
    arm({ slash: true });
    arm({ deliveryId: "msg-2", messageIds: ["msg-2"] });
    advance(PROMPT_STALL_MS);
    expect(stalls.map((s) => s.stall.deliveryId)).toEqual(["msg-2"]);
  });
});
