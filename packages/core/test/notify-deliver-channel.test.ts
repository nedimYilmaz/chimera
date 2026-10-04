import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { EventLog } from "@chimera/core/events";
import { NotifyEvaluator } from "@chimera/core/notify";
import { makeEngineHome } from "./helpers.js";

// Coverage gap (HOOK-4): NotifyEvaluator.deliverChannel is the one-off delivery seam the
// HookEngine `channel` action calls. It's only exercised INDIRECTLY through the engine (whose
// tests stub channelDeliver to a no-op), so `deliver` is never actually asserted. These tests
// call deliverChannel directly with a synthetic sample and assert the real delivery machinery
// runs: it builds a throttleSec:0 rule and delivers IMMEDIATELY (no window/timer), producing the
// same notify/notify_error audit trail a config NotifyRule would.
function sample(kind: NormalizedEvent["kind"] = "budget_warning", agentId = "child"): NormalizedEvent {
  return { ts: 1, seq: 3, engineId: "local", agentId, kind, data: { pct: 80 } };
}

describe("NotifyEvaluator.deliverChannel (HOOK-4 one-off delivery)", () => {
  it("toast delivers immediately — a notify event, no throttle window/timer armed", () => {
    const events = new EventLog(makeEngineHome());
    const armed: unknown[] = [];
    const notifier = new NotifyEvaluator({
      events, send: async () => {}, resolveTreeAgent: () => null,
      setTimer: (fn, ms) => { armed.push({ fn, ms }); return armed.length; },
      clearTimer: () => {},
    });

    notifier.deliverChannel("toast", sample(), { name: "hook:r1" });

    expect(armed).toHaveLength(0);   // bypassed the window entirely — delivered inline
    const delivered = events.tail("notify", 10).filter((e) => e.kind === "notify");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.data).toMatchObject({ ruleId: "hook:r1", kind: "budget_warning", channel: "toast", agentId: "child", count: 1 });
  });

  it("a2a routes send() to the resolved tree agent, then emits notify", async () => {
    const events = new EventLog(makeEngineHome());
    const sent: Array<{ agentId: string; text: string }> = [];
    const notifier = new NotifyEvaluator({
      events, send: async (agentId, text) => { sent.push({ agentId, text }); },
      resolveTreeAgent: () => "root-agent",
    });

    notifier.deliverChannel("a2a", sample("permission_request"), { name: "hook:perm" });
    await Promise.resolve(); await Promise.resolve();   // let the send()/then chain settle

    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe("root-agent");
    expect(events.tail("notify", 10).some((e) => e.kind === "notify")).toBe(true);
  });

  it("webhook POSTs to the configured url and emits notify on a 2xx", async () => {
    const events = new EventLog(makeEngineHome());
    const calls: string[] = [];
    const notifier = new NotifyEvaluator({
      events, send: async () => {}, resolveTreeAgent: () => null,
      fetchFn: async (url) => { calls.push(url); return { ok: true, status: 200 }; },
    });

    notifier.deliverChannel("webhook", sample(), { name: "hook:wh", webhookUrl: "https://example.com/hook" });
    await Promise.resolve(); await Promise.resolve();

    expect(calls).toEqual(["https://example.com/hook"]);
    expect(events.tail("notify", 10).some((e) => e.kind === "notify")).toBe(true);
  });

  it("webhook with no url logs notify_error, never throws", () => {
    const events = new EventLog(makeEngineHome());
    const notifier = new NotifyEvaluator({ events, send: async () => {}, resolveTreeAgent: () => null });
    expect(() => notifier.deliverChannel("webhook", sample(), { name: "hook:wh" })).not.toThrow();
    const errs = events.tail("notify", 10).filter((e) => e.kind === "notify_error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.data).toMatchObject({ ruleId: "hook:wh", channel: "webhook" });
  });
});
