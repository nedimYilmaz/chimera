import { describe, it, expect } from "vitest";
import type { NotifyRule } from "@chimera/protocol";
import { EventLog } from "@chimera/core/events";
import { NotifyEvaluator, UnknownNotifyRuleError } from "@chimera/core/notify";
import { makeEngineHome } from "./helpers.js";

// A manual fake timer (mirrors ConfigWatcher's own test seam in config-d7.test.ts): setTimer
// pushes {id, fn}; the test flushes it explicitly instead of waiting on a real clock.
function fakeTimer() {
  let pending: Array<{ id: number; fn: () => void }> = [];
  let nextId = 1;
  const setTimer = (fn: () => void) => { const id = nextId++; pending.push({ id, fn }); return id; };
  const clearTimer = (h: unknown) => { pending = pending.filter((p) => p.id !== h); };
  const flushAll = () => { const batch = pending; pending = []; for (const p of batch) p.fn(); };
  return { setTimer, clearTimer, flushAll, pending: () => pending };
}

function rule(over: Partial<NotifyRule> = {}): NotifyRule {
  return { name: "r1", on: { kind: "permission_request" }, channel: "toast", throttleSec: 60, enabled: true, ...over };
}

describe("NotifyEvaluator (D14/F18)", () => {
  it("a matching event opens a throttle window; delivery (a `notify` event) only fires when the window's timer elapses", () => {
    const home = makeEngineHome();
    const events = new EventLog(home);
    const timer = fakeTimer();
    const notifier = new NotifyEvaluator({
      events, send: async () => {}, resolveTreeAgent: () => null,
      setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    });
    notifier.setRules([rule()]);

    const seen: string[] = [];
    events.subscribe((e) => seen.push(e.kind));
    events.append({ agentId: "a1", kind: "permission_request", data: { requestId: "x" } });
    expect(seen).not.toContain("notify");   // not delivered yet — still inside the window

    timer.flushAll();
    expect(seen.filter((k) => k === "notify")).toHaveLength(1);
    const notifyEvent = events.tail("notify", 10).find((e) => e.kind === "notify")!;
    expect(notifyEvent.data).toMatchObject({ ruleId: "r1", channel: "toast", count: 1 });
  });

  it("a burst of 10 matches within the window collapses into ONE delivery carrying ×10", () => {
    const home = makeEngineHome();
    const events = new EventLog(home);
    const timer = fakeTimer();
    const notifier = new NotifyEvaluator({
      events, send: async () => {}, resolveTreeAgent: () => null,
      setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    });
    notifier.setRules([rule({ on: { kind: "error" } })]);

    for (let i = 0; i < 10; i++) events.append({ agentId: "a1", kind: "error", data: { i } });
    expect(timer.pending()).toHaveLength(1);   // only the FIRST match armed a timer

    timer.flushAll();
    const delivered = events.tail("notify", 10).filter((e) => e.kind === "notify");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.data).toMatchObject({ count: 10 });
  });

  it("a disabled rule never matches", () => {
    const home = makeEngineHome();
    const events = new EventLog(home);
    const timer = fakeTimer();
    const notifier = new NotifyEvaluator({ events, send: async () => {}, resolveTreeAgent: () => null, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    notifier.setRules([rule({ enabled: false })]);
    events.append({ agentId: "a1", kind: "permission_request", data: {} });
    expect(timer.pending()).toHaveLength(0);
  });

  it("a rule's filter only matches events whose data matches every key (job-failed default shape)", () => {
    const home = makeEngineHome();
    const events = new EventLog(home);
    const timer = fakeTimer();
    const notifier = new NotifyEvaluator({ events, send: async () => {}, resolveTreeAgent: () => null, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    notifier.setRules([rule({ name: "job-failed", on: { kind: "job_run_finished", filter: { result: "failed" } } })]);

    events.append({ agentId: "job:x", kind: "job_run_finished", data: { job: "x", result: "ok" } });
    expect(timer.pending()).toHaveLength(0);   // result:"ok" doesn't match the filter

    events.append({ agentId: "job:x", kind: "job_run_finished", data: { job: "x", result: "failed" } });
    expect(timer.pending()).toHaveLength(1);
  });

  it("a2a delivers via send() to the resolved tree agent, then emits notify", async () => {
    const home = makeEngineHome();
    const events = new EventLog(home);
    const timer = fakeTimer();
    const sent: Array<{ agentId: string; text: string }> = [];
    const notifier = new NotifyEvaluator({
      events, send: async (agentId, text) => { sent.push({ agentId, text }); },
      resolveTreeAgent: () => "root-agent",
      setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    });
    notifier.setRules([rule({ channel: "a2a" })]);
    events.append({ agentId: "child", kind: "permission_request", data: {} });
    timer.flushAll();
    await Promise.resolve(); await Promise.resolve();   // let the send()/then chain settle

    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe("root-agent");
    expect(events.tail("notify", 10).some((e) => e.kind === "notify")).toBe(true);
  });

  it("a2a with no resolvable target logs notify_error, never throws", () => {
    const home = makeEngineHome();
    const events = new EventLog(home);
    const timer = fakeTimer();
    const notifier = new NotifyEvaluator({ events, send: async () => {}, resolveTreeAgent: () => null, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    notifier.setRules([rule({ channel: "a2a" })]);
    expect(() => {
      events.append({ agentId: "ghost", kind: "permission_request", data: {} });
      timer.flushAll();
    }).not.toThrow();
    expect(events.tail("notify", 10).some((e) => e.kind === "notify_error")).toBe(true);
  });

  it("a failing webhook retries 3 times then logs notify_error WITHOUT throwing or blocking the event stream", async () => {
    const home = makeEngineHome();
    const events = new EventLog(home);
    const timer = fakeTimer();
    let calls = 0;
    const notifier = new NotifyEvaluator({
      events, send: async () => {}, resolveTreeAgent: () => null,
      fetchFn: async () => { calls++; return { ok: false, status: 500 }; },
      setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    });
    notifier.setRules([rule({ channel: "webhook", webhookUrl: "https://example.com/hook" })]);

    events.append({ agentId: "a1", kind: "permission_request", data: {} });
    expect(() => timer.flushAll()).not.toThrow();   // window-close timer fires synchronously
    // deliverWebhook is async and uses the injected setTimer for its retry backoff too —
    // flush repeatedly until the retry chain (which schedules its OWN timers) drains.
    for (let i = 0; i < 5 && timer.pending().length === 0; i++) await Promise.resolve();
    while (timer.pending().length > 0) { timer.flushAll(); await Promise.resolve(); await Promise.resolve(); }
    await Promise.resolve(); await Promise.resolve();

    expect(calls).toBe(3);
    const errs = events.tail("notify", 10).filter((e) => e.kind === "notify_error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.data).toMatchObject({ attempts: 3 });
    expect(events.tail("notify", 10).some((e) => e.kind === "notify")).toBe(false);
  });

  it("a webhook that succeeds on the 2nd attempt delivers `notify`, not `notify_error`", async () => {
    const home = makeEngineHome();
    const events = new EventLog(home);
    const timer = fakeTimer();
    let calls = 0;
    const notifier = new NotifyEvaluator({
      events, send: async () => {}, resolveTreeAgent: () => null,
      fetchFn: async () => { calls++; return calls < 2 ? { ok: false, status: 500 } : { ok: true, status: 200 }; },
      setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    });
    notifier.setRules([rule({ channel: "webhook", webhookUrl: "https://example.com/hook" })]);

    events.append({ agentId: "a1", kind: "permission_request", data: {} });
    timer.flushAll();
    for (let i = 0; i < 5 && timer.pending().length === 0; i++) await Promise.resolve();
    while (timer.pending().length > 0) { timer.flushAll(); await Promise.resolve(); await Promise.resolve(); }
    await Promise.resolve(); await Promise.resolve();

    expect(calls).toBe(2);
    expect(events.tail("notify", 10).some((e) => e.kind === "notify")).toBe(true);
    expect(events.tail("notify", 10).some((e) => e.kind === "notify_error")).toBe(false);
  });

  it("test(name) fires a sample through the channel immediately, bypassing the throttle window", () => {
    const home = makeEngineHome();
    const events = new EventLog(home);
    const timer = fakeTimer();
    const notifier = new NotifyEvaluator({ events, send: async () => {}, resolveTreeAgent: () => null, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    notifier.setRules([rule()]);
    const result = notifier.test("r1");
    expect(result).toEqual({ ok: true });
    expect(timer.pending()).toHaveLength(0);   // no window was opened — delivered right away
    expect(events.tail("notify", 10).some((e) => e.kind === "notify")).toBe(true);
  });

  it("test() on an unknown rule name throws UnknownNotifyRuleError ({code:'protocol'})", () => {
    const home = makeEngineHome();
    const events = new EventLog(home);
    const notifier = new NotifyEvaluator({ events, send: async () => {}, resolveTreeAgent: () => null });
    notifier.setRules([rule()]);
    expect(() => notifier.test("ghost")).toThrow(UnknownNotifyRuleError);
  });

  it("notify/notify_error events never re-trigger the evaluator (no self-notification loop)", () => {
    const home = makeEngineHome();
    const events = new EventLog(home);
    const timer = fakeTimer();
    const notifier = new NotifyEvaluator({ events, send: async () => {}, resolveTreeAgent: () => null, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    notifier.setRules([rule({ on: { kind: "notify" } }), rule({ name: "r2", on: { kind: "notify_error" } })]);
    events.append({ agentId: "notify", kind: "notify", data: {} });
    events.append({ agentId: "notify", kind: "notify_error", data: {} });
    expect(timer.pending()).toHaveLength(0);
  });
});
