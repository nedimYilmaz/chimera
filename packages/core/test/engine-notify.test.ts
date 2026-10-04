import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { NormalizedEvent } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);

// Manual fake timer (same seam ConfigWatcher tests use) — lets the throttle window's delivery
// be driven deterministically instead of waiting on the real 60s default.
function fakeTimer() {
  let pending: Array<{ id: number; fn: () => void }> = [];
  let nextId = 1;
  const setTimer = (fn: () => void) => { const id = nextId++; pending.push({ id, fn }); return id; };
  const clearTimer = (h: unknown) => { pending = pending.filter((p) => p.id !== h); };
  const flushAll = () => { const batch = pending; pending = []; for (const p of batch) p.fn(); };
  return { setTimer, clearTimer, flushAll, pending: () => pending };
}

describe("Engine notify.* (D14/F18)", () => {
  it("ships the 5 default rules in a fresh config", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const cfg = await e.handle("config.get", {}) as { notify: Array<{ name: string; on: { kind: string } }> };
    expect(cfg.notify.map((r) => r.name).sort()).toEqual(
      ["budget-80", "job-failed", "peer-partitioned", "permission-pending", "question-pending"].sort(),
    );
    expect(cfg.notify.find((r) => r.name === "permission-pending")?.on.kind).toBe("permission_request");
  });

  it("notify.test fires a sample through the channel immediately", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    const result = await e.handle("notify.test", { rule: "permission-pending" });
    expect(result).toEqual({ ok: true });
    const notifyEvents = e.events.tail("notify", 10).filter((ev) => ev.kind === "notify");
    expect(notifyEvents).toHaveLength(1);
    expect(notifyEvents[0]!.data).toMatchObject({ ruleId: "permission-pending", channel: "toast" });
  });

  it("notify.test on an unknown rule rejects with a protocol error", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("notify.test", { rule: "ghost" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("config.patch({notify}) live-updates the rule set (D7 diff-apply) — a disabled rule stops matching", async () => {
    const timer = fakeTimer();
    const e = new Engine({
      home: makeEngineHome(), backends: backends(new FakeAgentBackend([])),
      notifySetTimer: timer.setTimer, notifyClearTimer: timer.clearTimer,
    });
    const cfg = await e.handle("config.get", {}) as { notify: Array<Record<string, unknown>> };
    const disabled = cfg.notify.map((r) => (r["name"] === "job-failed" ? { ...r, enabled: false } : r));
    const patched = await e.handle("config.patch", { patch: { notify: disabled } }) as { changed: string[] };
    expect(patched.changed).toContain("notify");

    e.events.append({ agentId: "job:x", kind: "job_run_finished", data: { job: "x", result: "failed" } });
    expect(timer.pending()).toHaveLength(0);   // job-failed is disabled — no window opened
  });

  it("a pending permission fires a notify event (via the shipped permission-pending default rule)", async () => {
    const timer = fakeTimer();
    const ASK_BASH: FakeStep[] = [{ askPermission: { toolName: "Bash" } }, { end: { resultText: "done" } }];
    const fake = new FakeAgentBackend([ASK_BASH]);
    const e = new Engine({
      home: makeEngineHome(), backends: backends(fake),
      notifySetTimer: timer.setTimer, notifyClearTimer: timer.clearTimer,
    });
    await e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", account: "main", isolation: "none", on: { permissionRequest: "poke:caller" } } });
    await new Promise((r) => setTimeout(r, 20));   // let the fake backend reach askPermission
    expect(e.events.tail(null, 50).some((ev: NormalizedEvent) => ev.kind === "permission_request")).toBe(true);
    expect(timer.pending().length).toBeGreaterThan(0);   // the default rule opened a throttle window

    timer.flushAll();
    const notifyEvents = e.events.tail("notify", 10).filter((ev) => ev.kind === "notify");
    expect(notifyEvents.some((ev) => ev.data["ruleId"] === "permission-pending")).toBe(true);
  });

  it("a failing webhook rule logs notify_error without throwing or blocking further events", async () => {
    const timer = fakeTimer();
    const e = new Engine({
      home: makeEngineHome(), backends: backends(new FakeAgentBackend([])),
      notifySetTimer: timer.setTimer, notifyClearTimer: timer.clearTimer,
      notifyFetch: async () => { throw new Error("ECONNREFUSED"); },
    });
    const cfg = await e.handle("config.get", {}) as { notify: Array<Record<string, unknown>> };
    const withWebhook = [...cfg.notify, { name: "wh", on: { kind: "status" }, channel: "webhook", webhookUrl: "https://example.com/hook", throttleSec: 60, enabled: true }];
    await e.handle("config.patch", { patch: { notify: withWebhook } });

    expect(() => e.events.append({ agentId: "a1", kind: "status", data: {} })).not.toThrow();
    timer.flushAll();
    for (let i = 0; i < 10 && timer.pending().length === 0; i++) await Promise.resolve();
    while (timer.pending().length > 0) { timer.flushAll(); await Promise.resolve(); await Promise.resolve(); }
    await Promise.resolve(); await Promise.resolve();

    // the event stream kept working — a subsequent event still appends/is observable
    e.events.append({ agentId: "a1", kind: "status", data: { after: true } });
    expect(e.events.tail(null, 50).some((ev) => ev.data["after"] === true)).toBe(true);
    expect(e.events.tail("notify", 20).some((ev) => ev.kind === "notify_error")).toBe(true);
  });
});
