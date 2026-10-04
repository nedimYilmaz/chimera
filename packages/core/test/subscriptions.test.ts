import { describe, it, expect, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { SubscriptionRegistry, SubscriptionCapError, SubscriptionFilterError } from "@chimera/core/subscriptions";
import { TOPIC_TABLE } from "@chimera/core/topics";
import { makeEngineHome } from "./helpers.js";

// Mirrors notify.test.ts's fakeTimer seam — a manual timer the test flushes explicitly instead
// of racing a real clock, for coalescing-window assertions.
function fakeTimer() {
  let pending: Array<{ id: number; fn: () => void }> = [];
  let nextId = 1;
  const setTimer = (fn: () => void) => { const id = nextId++; pending.push({ id, fn }); return id; };
  const clearTimer = (h: unknown) => { pending = pending.filter((p) => p.id !== h); };
  const flushAll = () => { const batch = pending; pending = []; for (const p of batch) p.fn(); };
  return { setTimer, clearTimer, flushAll, pending: () => pending };
}

type FakeAgent = { state: string; spec: { resume?: string } };

function makeRegistryAt(home: string, opts: { now?: () => number } = {}) {
  const events = new EventLog(home);
  const mailboxes = new MailboxStore(home);
  const agents = new Map<string, FakeAgent>();
  const wakeMailbox = vi.fn();
  const resumeForSignal = vi.fn();
  const timer = fakeTimer();
  const registry = new SubscriptionRegistry(home, {
    events, mailboxes,
    getAgent: (id) => agents.get(id),
    wakeMailbox, resumeForSignal,
    now: opts.now,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer,
  });
  return { registry, home, events, mailboxes, agents, wakeMailbox, resumeForSignal, timer };
}

function makeRegistry(opts: { now?: () => number } = {}) {
  return makeRegistryAt(makeEngineHome(), opts);
}

describe("SubscriptionRegistry (HOOK-2, PLAN-HOOKS.md §2)", () => {
  it("create() applies the conditional coalesceMs default (0 for once, 5000 for durable) and a 24h expiresAt for durable subs", () => {
    const { registry } = makeRegistry();
    const once = registry.create({ subscriberId: "a1", topic: "agent.settled", once: true, wake: "deliver" });
    expect(once.coalesceMs).toBe(0);
    expect(once.expiresAt).toBeUndefined();

    const durable = registry.create({ subscriberId: "a1", topic: "agent.settled", once: false, wake: "deliver" });
    expect(durable.coalesceMs).toBe(5000);
    expect(durable.expiresAt).toBeGreaterThan(Date.now());
    expect(durable.expiresAt!).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000 + 1000);
  });

  it("create() rejects a 33rd live subscription for the same subscriber (32 cap)", () => {
    const { registry } = makeRegistry();
    for (let i = 0; i < 32; i++) registry.create({ subscriberId: "busy", topic: "queue.drained", once: false, wake: "deliver" });
    expect(registry.list("busy")).toHaveLength(32);
    expect(() => registry.create({ subscriberId: "busy", topic: "queue.drained", once: false, wake: "deliver" }))
      .toThrow(SubscriptionCapError);
  });

  it("remove() only removes the CALLER's own subscription, never another subscriber's", () => {
    const { registry } = makeRegistry();
    const sub = registry.create({ subscriberId: "owner", topic: "queue.drained", once: false, wake: "deliver" });
    expect(registry.remove("someone-else", sub.id)).toBe(false);
    expect(registry.list("owner")).toHaveLength(1);
    expect(registry.remove("owner", sub.id)).toBe(true);
    expect(registry.list("owner")).toHaveLength(0);
  });

  it("agent.settled: a child's 'result' event delivers a signal to an idle subscriber and auto-removes the once:true sub", () => {
    const { registry, events, mailboxes, agents, wakeMailbox } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    registry.create({ subscriberId: "watcher", topic: "agent.settled", filter: { agentId: "child-1" }, once: true, wake: "deliver" });

    events.append({ agentId: "child-1", kind: "result", data: { text: "child result text", costUsd: 0.1 } });

    const msgs = mailboxes.pending("watcher");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.kind).toBe("signal");
    expect(msgs[0]?.text).toContain("[signal:agent.settled]");
    expect(msgs[0]?.meta).toMatchObject({ topic: "agent.settled" });
    expect(wakeMailbox).toHaveBeenCalledWith("watcher");   // idle subscriber wakes the same tick
    expect(events.tail("watcher", 10).some((e) => e.kind === "signal_delivered")).toBe(true);
    expect(registry.list("watcher")).toHaveLength(0);   // once:true auto-removed
  });

  it("a filter mismatch never delivers", () => {
    const { registry, events, mailboxes, agents } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    registry.create({ subscriberId: "watcher", topic: "agent.settled", filter: { agentId: "someone-else" }, once: true, wake: "deliver" });
    events.append({ agentId: "child-1", kind: "result", data: { text: "x", costUsd: 0 } });
    expect(mailboxes.pending("watcher")).toHaveLength(0);
  });

  it("wake:'resume' on an ALREADY-settled subscriber calls resumeForSignal exactly once", () => {
    const { registry, events, agents, resumeForSignal, wakeMailbox } = makeRegistry();
    agents.set("watcher", { state: "done", spec: {} });
    registry.create({ subscriberId: "watcher", topic: "agent.settled", filter: { agentId: "child-1" }, once: true, wake: "resume" });

    events.append({ agentId: "child-1", kind: "result", data: { text: "x", costUsd: 0 } });

    expect(resumeForSignal).toHaveBeenCalledTimes(1);
    expect(resumeForSignal).toHaveBeenCalledWith("watcher");
    expect(wakeMailbox).toHaveBeenCalledWith("watcher");   // still called (no-ops for a non-running agent anyway)
  });

  it("wake:'drop' on an ALREADY-settled subscriber discards the signal with an audit event, never touching the mailbox", () => {
    const { registry, events, mailboxes, agents, resumeForSignal } = makeRegistry();
    agents.set("watcher", { state: "failed", spec: {} });
    registry.create({ subscriberId: "watcher", topic: "agent.settled", filter: { agentId: "child-1" }, once: true, wake: "drop" });

    events.append({ agentId: "child-1", kind: "result", data: { text: "x", costUsd: 0 } });

    expect(mailboxes.pending("watcher")).toHaveLength(0);
    expect(resumeForSignal).not.toHaveBeenCalled();
    expect(events.tail("watcher", 10).some((e) => e.kind === "status" && e.data["signalDropped"] === true)).toBe(true);
  });

  it("wake:'deliver' (default) on an already-settled subscriber just holds the signal — no resume, no drop", () => {
    const { registry, events, mailboxes, agents, resumeForSignal } = makeRegistry();
    agents.set("watcher", { state: "done", spec: {} });
    registry.create({ subscriberId: "watcher", topic: "agent.settled", filter: { agentId: "child-1" }, once: true, wake: "deliver" });

    events.append({ agentId: "child-1", kind: "result", data: { text: "x", costUsd: 0 } });

    expect(mailboxes.pending("watcher")).toHaveLength(1);
    expect(resumeForSignal).not.toHaveBeenCalled();
  });

  it("coalescing: a durable sub batches rapid-fire matches within its window into ONE signal carrying ×count", () => {
    const { registry, events, mailboxes, agents, timer } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    registry.create({ subscriberId: "watcher", topic: "queue.drained", once: false, coalesceMs: 5000, wake: "deliver" });

    for (let i = 0; i < 5; i++) events.append({ agentId: `queue:q${i}`, kind: "queue_drained", data: { queue: `q${i}` } });
    expect(mailboxes.pending("watcher")).toHaveLength(0);   // still inside the window
    expect(timer.pending()).toHaveLength(1);                // only the FIRST match armed a timer

    timer.flushAll();
    const msgs = mailboxes.pending("watcher");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toContain("×5");
  });

  it("undelivered-signal storm insurance: beyond the 50-signal cap, further matches collapse into ONE coalesce notice instead of growing the mailbox", () => {
    const { registry, events, mailboxes, agents } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    registry.create({ subscriberId: "watcher", topic: "queue.drained", once: false, coalesceMs: 0, wake: "deliver" });

    for (let i = 0; i < 55; i++) events.append({ agentId: `queue:q${i}`, kind: "queue_drained", data: { queue: `q${i}` } });

    const msgs = mailboxes.pending("watcher");
    // 50 real signals + exactly ONE coalesce notice, never one notice per suppressed match.
    expect(msgs.filter((m) => m.meta?.["topic"] === "queue.drained")).toHaveLength(50);
    expect(msgs.filter((m) => m.meta?.["coalesced"] === true)).toHaveLength(1);
  });

  it("a once:true sub caught by the storm-suppression cap survives (never delivered, so never auto-removed) — it still fires once the mailbox drains", () => {
    const { registry, events, mailboxes, agents } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    // Fill the mailbox to the cap with a SEPARATE durable sub's matches.
    registry.create({ subscriberId: "watcher", topic: "queue.drained", once: false, coalesceMs: 0, wake: "deliver" });
    for (let i = 0; i < 50; i++) events.append({ agentId: `queue:q${i}`, kind: "queue_drained", data: { queue: `q${i}` } });
    expect(mailboxes.pending("watcher").filter((m) => m.kind === "signal")).toHaveLength(50);

    // The once:true sub's OWN match arrives while the mailbox is already at the cap.
    registry.create({ subscriberId: "watcher", topic: "agent.settled", filter: { agentId: "child-1" }, once: true, wake: "deliver" });
    events.append({ agentId: "child-1", kind: "result", data: { text: "x", costUsd: 0 } });

    // Suppressed (no new agent.settled signal), but the once:true sub must still be alive.
    expect(mailboxes.pending("watcher").filter((m) => m.meta?.["topic"] === "agent.settled")).toHaveLength(0);
    expect(registry.list("watcher").some((s) => s.topic === "agent.settled")).toBe(true);

    // Drain the mailbox (simulates the agent actually consuming its mail), then re-fire: NOW it delivers.
    mailboxes.drain("watcher");
    events.append({ agentId: "child-1", kind: "result", data: { text: "y", costUsd: 0 } });
    expect(mailboxes.pending("watcher").filter((m) => m.meta?.["topic"] === "agent.settled")).toHaveLength(1);
    expect(registry.list("watcher").some((s) => s.topic === "agent.settled")).toBe(false);   // now delivered + auto-removed
  });

  it("subscriber-terminal GC: a wake:'deliver'/'drop' sub is dropped the moment its OWN subscriber settles; a wake:'resume' one-shot survives", () => {
    const { registry, events, agents } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    registry.create({ subscriberId: "watcher", topic: "queue.drained", once: false, wake: "deliver" });
    registry.create({ subscriberId: "watcher", topic: "queue.drained", once: false, wake: "resume" });
    expect(registry.list("watcher")).toHaveLength(2);

    // Drive the subscriber's OWN settle through the SAME EventLog the registry listens on.
    events.append({ agentId: "watcher", kind: "status", data: { state: "failed" } });

    const remaining = registry.list("watcher");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.wake).toBe("resume");
  });

  it("expiry: a durable sub past its expiresAt is GC'd out of list() (never delivered again)", () => {
    let now = 1_000_000;
    const { registry, agents } = makeRegistry({ now: () => now });
    agents.set("watcher", { state: "running", spec: {} });
    registry.create({ subscriberId: "watcher", topic: "queue.drained", once: false, expiresAt: now + 1000, wake: "deliver" });
    expect(registry.list("watcher")).toHaveLength(1);

    now += 2000;   // advance past expiresAt
    expect(registry.list("watcher")).toHaveLength(0);
  });
});

describe("SubscriptionRegistry persistence (§2.1 temp+rename snapshot, Pattern B)", () => {
  it("reload round-trip: a durable sub survives a fresh registry constructed over the SAME home", () => {
    const home = makeEngineHome();
    const first = makeRegistryAt(home);
    const created = first.registry.create({ subscriberId: "watcher", topic: "queue.drained", once: false, wake: "deliver", note: "keep me" });

    // A brand-new registry over the same home (daemon restart) reads subscriptions.json via load().
    const second = makeRegistryAt(home);
    const reloaded = second.registry.list("watcher");
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.id).toBe(created.id);
    expect(reloaded[0]?.note).toBe("keep me");
    expect(reloaded[0]?.topic).toBe("queue.drained");
  });

  it("a reloaded sub is fully live: it still matches and delivers on the new registry", () => {
    const home = makeEngineHome();
    makeRegistryAt(home).registry.create({ subscriberId: "watcher", topic: "queue.drained", once: true, coalesceMs: 0, wake: "deliver" });

    const second = makeRegistryAt(home);
    second.agents.set("watcher", { state: "running", spec: {} });
    second.events.append({ agentId: "queue:q1", kind: "queue_drained", data: { queue: "q1" } });

    const msgs = second.mailboxes.pending("watcher");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toContain("[signal:queue.drained]");
  });

  it("a removal is durable: the removed sub does not reappear after reload", () => {
    const home = makeEngineHome();
    const first = makeRegistryAt(home);
    const sub = first.registry.create({ subscriberId: "watcher", topic: "queue.drained", once: false, wake: "deliver" });
    expect(first.registry.remove("watcher", sub.id)).toBe(true);

    const second = makeRegistryAt(home);
    expect(second.registry.list("watcher")).toHaveLength(0);
  });

  it("corrupt snapshot degrades to empty (never crash-loops the daemon) and self-heals on the next persist", () => {
    const home = makeEngineHome();
    writeFileSync(join(home, "subscriptions.json"), "{ this is not valid json ]");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Construction must NOT throw despite the torn snapshot.
    const { registry } = makeRegistryAt(home);
    expect(registry.list("anyone")).toHaveLength(0);
    expect(warn).toHaveBeenCalled();

    // Self-heals: a subsequent create persists a valid snapshot a fresh registry can read back.
    const created = registry.create({ subscriberId: "watcher", topic: "queue.drained", once: false, wake: "deliver" });
    const reloaded = makeRegistryAt(home).registry.list("watcher");
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.id).toBe(created.id);
    warn.mockRestore();
  });
});

describe("agent.output content subscriptions (F46)", () => {
  const outputSub = (over: Record<string, unknown> = {}) => ({
    subscriberId: "watcher", topic: "agent.output", filter: { contains: "FAILED" },
    once: true, wake: "deliver", ...over,
  });

  it("delivers ONE signal for a matching message_complete and auto-removes the once:true sub", () => {
    const { registry, events, mailboxes, agents, wakeMailbox } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    registry.create(outputSub());

    events.append({ agentId: "child-1", kind: "message_complete", data: { text: "step 1 ok\nBuild FAILED on main\nstep 3" } });

    const msgs = mailboxes.pending("watcher");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toContain("[signal:agent.output]");
    expect(msgs[0]?.text).toContain("Build FAILED on main");
    expect(msgs[0]?.text).not.toContain("step 3");   // only the matched LINE travels
    expect(msgs[0]?.meta).toMatchObject({ topic: "agent.output" });
    expect(wakeMailbox).toHaveBeenCalledWith("watcher");
    expect(registry.list("watcher")).toHaveLength(0);
  });

  it("matches a tool_result's data.result and reports source:'tool'", () => {
    const { registry, events, mailboxes, agents } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    registry.create(outputSub());
    events.append({ agentId: "child-1", kind: "tool_result", data: { result: "npm ERR! build FAILED" } });
    expect(mailboxes.pending("watcher")[0]?.text).toContain('"source":"tool"');
  });

  it("ignores a message_delta carrying the needle, then delivers on the settled message_complete", () => {
    const { registry, events, mailboxes, agents } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    registry.create(outputSub());
    events.append({ agentId: "child-1", kind: "message_delta", data: { text: "Build FAILED" } });
    expect(mailboxes.pending("watcher")).toHaveLength(0);
    events.append({ agentId: "child-1", kind: "message_complete", data: { text: "Build FAILED" } });
    expect(mailboxes.pending("watcher")).toHaveLength(1);
  });

  it("delivers nothing when the needle is absent", () => {
    const { registry, events, mailboxes, agents } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    registry.create(outputSub());
    events.append({ agentId: "child-1", kind: "message_complete", data: { text: "everything is fine" } });
    expect(mailboxes.pending("watcher")).toHaveLength(0);
  });

  it("refuses the three illegal content shapes, each naming its reason", () => {
    const { registry } = makeRegistry();
    expect(() => registry.create(outputSub({ filter: undefined })))
      .toThrow(/requires filter\.contains/);
    expect(() => registry.create(outputSub({ once: false })))
      .toThrow(/requires once:true/);
    expect(() => registry.create({ subscriberId: "watcher", topic: "agent.settled", filter: { contains: "boom" }, once: true, wake: "deliver" }))
      .toThrow(/only supported on content topics/);
    expect(() => registry.create(outputSub({ filter: undefined }))).toThrow(SubscriptionFilterError);
  });

  it("refuses a contains shorter than 3 or longer than 64 chars (schema)", () => {
    const { registry } = makeRegistry();
    expect(() => registry.create(outputSub({ filter: { contains: "ab" } }))).toThrow();
    expect(() => registry.create(outputSub({ filter: { contains: "x".repeat(65) } }))).toThrow();
    expect(registry.create(outputSub({ filter: { contains: "abc" } })).filter?.contains).toBe("abc");
  });

  it("never wakes a subscriber on its OWN output", () => {
    const { registry, events, mailboxes, agents } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    registry.create(outputSub());
    events.append({ agentId: "watcher", kind: "message_complete", data: { text: "Build FAILED" } });
    expect(mailboxes.pending("watcher")).toHaveLength(0);
    events.append({ agentId: "child-1", kind: "message_complete", data: { text: "Build FAILED" } });
    expect(mailboxes.pending("watcher")).toHaveLength(1);
  });

  it("caps content subscriptions at 64 daemon-wide, across different subscribers", () => {
    const { registry } = makeRegistry();
    for (const who of ["s1", "s2"]) {
      for (let i = 0; i < 32; i++) registry.create(outputSub({ subscriberId: who }));
    }
    expect(() => registry.create(outputSub({ subscriberId: "s3" }))).toThrow(SubscriptionCapError);
    expect(() => registry.create(outputSub({ subscriberId: "s3" }))).toThrow(/capped at 64 daemon-wide/);
    // A LIFECYCLE sub is unaffected by the content cap.
    expect(registry.create({ subscriberId: "s3", topic: "queue.drained", once: true, wake: "deliver" }).id).toBeTruthy();
  });

  // F46/QA finding C: treeId/team are accepted by TopicFilterSchema but no projector ever
  // emits either (see packages/core/test/topics.test.ts's coverage guard) — a subscription
  // filtered on either would silently never fire. scopeFilterIssue rejects it at create time.
  it("refuses a filter on treeId/team (unsatisfiable — no projector ever emits either)", () => {
    const { registry } = makeRegistry();
    expect(() => registry.create({ subscriberId: "watcher", topic: "task.state", filter: { treeId: "t1" }, once: true, wake: "deliver" }))
      .toThrow(SubscriptionFilterError);
    expect(() => registry.create({ subscriberId: "watcher", topic: "task.state", filter: { team: "sre" }, once: true, wake: "deliver" }))
      .toThrow(SubscriptionFilterError);
  });

  it("coalesces five matches inside an explicit 1000ms window into one ×5 delivery", () => {
    const { registry, events, mailboxes, agents, timer } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    registry.create(outputSub({ coalesceMs: 1000 }));
    for (let i = 0; i < 5; i++) events.append({ agentId: "child-1", kind: "message_complete", data: { text: `run ${i}: FAILED` } });
    expect(mailboxes.pending("watcher")).toHaveLength(0);   // still buffered
    timer.flushAll();
    const msgs = mailboxes.pending("watcher");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toContain("×5");
    expect(registry.list("watcher")).toHaveLength(0);
  });

  it("removes an expired content sub at match time instead of delivering", () => {
    let now = 1_000_000;
    const { registry, events, mailboxes, agents } = makeRegistry({ now: () => now });
    agents.set("watcher", { state: "running", spec: {} });
    const sub = registry.create(outputSub({ expiresAt: now + 1000 }));
    expect(sub.expiresAt).toBe(now + 1000);   // an explicit TTL survives once:true

    now += 2000;
    events.append({ agentId: "child-1", kind: "message_complete", data: { text: "Build FAILED" } });
    expect(mailboxes.pending("watcher")).toHaveLength(0);
    expect(registry.list("watcher")).toHaveLength(0);
  });

  it("keeps the signal under 600 chars and carries only the matched line for a 500 KB tool_result", () => {
    const { registry, events, mailboxes, agents } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    registry.create(outputSub());
    events.append({ agentId: "child-1", kind: "tool_result", data: { output: "Build FAILED here" + "x".repeat(500_000) } });
    const msgs = mailboxes.pending("watcher");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text.length).toBeLessThanOrEqual(600);
    expect(msgs[0]?.text).toContain("Build FAILED here");
  });

  it("does not project agent.output at all while nobody is subscribed to it", () => {
    const { registry, events, agents } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    const spy = vi.spyOn(TOPIC_TABLE["agent.output"], "toPayload");
    try {
      events.append({ agentId: "child-1", kind: "message_complete", data: { text: "Build FAILED" } });
      expect(spy).not.toHaveBeenCalled();
      registry.create(outputSub());
      events.append({ agentId: "child-1", kind: "message_complete", data: { text: "Build FAILED" } });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a needle only present in the elided middle of a 500 KB output does not match", () => {
    const { registry, events, mailboxes, agents } = makeRegistry();
    agents.set("watcher", { state: "running", spec: {} });
    registry.create(outputSub());
    const buried = "h".repeat(100_000) + "Build FAILED" + "t".repeat(100_000);
    events.append({ agentId: "child-1", kind: "tool_result", data: { output: buried } });
    expect(mailboxes.pending("watcher")).toHaveLength(0);
  });
});
