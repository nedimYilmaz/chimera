import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRuleSchema, type HookRule, type TaskRecord } from "@chimera/protocol";
import { EventLog } from "@chimera/core/events";
import { QueueStore } from "@chimera/core/queues";
import { HookEngine, type HookEngineDeps, type HookSpawnSpec } from "@chimera/core/hooks";
import { TOPIC_TABLE } from "@chimera/core/topics";

// HookEngine's action loop is `async` (actions like notify/spawn/run are genuinely
// asynchronous) — even a purely-synchronous firing (a `push` action) therefore appends its
// `hook_fired`/`hook_error` audit event one tick after the triggering call returns (calling an
// async function and awaiting its result always defers at least one microtask, even when the
// function's own body never actually suspends). The SIDE EFFECTS of a synchronous action
// (queues.push's new task, the self-cause reentrancy it can trigger) still happen synchronously,
// inline — only the audit trail is delayed. Tests that read the audit trail flush a macrotask
// first; tests that only read queue/task state don't need to.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function rig(overrides: Partial<HookEngineDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-hooks-"));
  const events = new EventLog(dir);
  const queues = new QueueStore(dir, events);
  const sent: Array<{ agentId: string; text: string }> = [];
  const deps: HookEngineDeps = {
    events,
    send: async (agentId, text) => { sent.push({ agentId, text }); },
    resolveTreeAgent: () => null,
    membersOf: () => [],
    pushTask: (queue, input) => queues.push(queue, input),
    getTaskCause: (taskId) => { try { return queues.getTask(taskId).cause; } catch { return null; } },
    getTaskAgentId: (taskId) => { try { return queues.getTask(taskId).agentId; } catch { return null; } },
    getAgentCause: () => null,
    spawnAgent: async () => ({ agentId: "spawned" }),
    channelDeliver: () => {},
    defaultCwd: () => "/tmp",
    ...overrides,
  };
  const engine = new HookEngine(deps);
  return { events, queues, engine, sent };
}

function rule(over: Partial<HookRule> = {}): HookRule {
  return {
    name: "r1", enabled: true, on: "task.state",
    actions: [{ type: "push", queue: "Q", prompt: "child" }],
    maxChainDepth: 3, maxFiresPerHour: 20,
    ...over,
  } as HookRule;
}

function firedEvents(events: EventLog) { return events.tail(null, 500).filter((e) => e.kind === "hook_fired"); }
function suppressedEvents(events: EventLog) { return events.tail(null, 500).filter((e) => e.kind === "hook_suppressed"); }

describe("HookEngine (PLAN-HOOKS.md §3, HOOK-4)", () => {
  it("a task.failed -> push rule fires again at chain 2/3, is suppressed at chain 4 (maxChainDepth default)", async () => {
    const { events, queues, engine } = rig();
    queues.create({ name: "Q", retryLimit: 10 });
    engine.setRules([rule({
      name: "retry-on-fail", on: "task.state", filter: { state: "failed" },
      actions: [{ type: "push", queue: "Q", prompt: "retry" }],
      maxChainDepth: 3,
    })]);

    const known = new Set<string>();
    const newTaskId = (): string => {
      const next = queues.status("Q").tasks.find((t: TaskRecord) => !known.has(t.taskId))!;
      known.add(next.taskId);
      return next.taskId;
    };

    const seed = queues.push("Q", { prompt: "seed" });
    known.add(seed.taskId);
    queues.markFailed(seed.taskId, "boom");
    await flush();
    expect(firedEvents(events)).toHaveLength(1);
    expect(firedEvents(events)[0]!.data["chain"]).toBe(1);

    const child1 = newTaskId();
    queues.markFailed(child1, "boom again");
    await flush();
    expect(firedEvents(events)).toHaveLength(2);
    expect(firedEvents(events)[1]!.data["chain"]).toBe(2);

    const child2 = newTaskId();
    queues.markFailed(child2, "boom thrice");
    await flush();
    expect(firedEvents(events)).toHaveLength(3);
    expect(firedEvents(events)[2]!.data["chain"]).toBe(3);

    const child3 = newTaskId();
    queues.markFailed(child3, "boom four times");
    await flush();
    expect(firedEvents(events)).toHaveLength(3);   // no 4th real firing
    expect(suppressedEvents(events)).toHaveLength(1);
    expect(suppressedEvents(events)[0]!.data).toMatchObject({ rule: "retry-on-fail", reason: "chain-depth" });
  });

  it("a same-tick self-loop (rule's own push synchronously re-triggers itself) is suppressed at the first recurrence, not at the chain cap", async () => {
    const { events, queues, engine } = rig();
    queues.create({ name: "Q", retryLimit: 10 });
    // No filter — matches EVERY task.state change, including the "pending" event the rule's
    // own push() synchronously emits for the child it just created.
    engine.setRules([rule({ name: "self-loop", on: "task.state", actions: [{ type: "push", queue: "Q", prompt: "child" }], maxChainDepth: 5 })]);

    queues.push("Q", { prompt: "seed" });   // triggers the rule; its push action re-triggers it synchronously
    await flush();

    expect(firedEvents(events)).toHaveLength(1);
    expect(firedEvents(events)[0]!.data["chain"]).toBe(1);
    expect(suppressedEvents(events)).toHaveLength(1);
    expect(suppressedEvents(events)[0]!.data).toMatchObject({ rule: "self-loop", reason: "self-cause" });
    // exactly ONE extra task was created (the reentrant second push never happened) —
    // the guard, not just the audit trail, actually stopped the loop.
    expect(queues.status("Q").tasks).toHaveLength(2);
  });

  it("two independent events for the same rule while its async action (notify) is still in flight both fire — the reentrancy guard never spans the async tail", async () => {
    // Regression test (code review, pre-land): the self-cause guard must protect ONLY the
    // synchronous execution window. Before the fix, `currentlyFiring` stayed set for the whole
    // async tail, so task B's failure — a genuinely UNRELATED event, not a self-trigger —
    // would be misclassified as self-cause just because task A's notify hadn't resolved yet.
    const pendingSends: Array<() => void> = [];
    const { events, queues, engine, sent } = rig({
      send: async (agentId, text) => {
        await new Promise<void>((resolve) => { pendingSends.push(resolve); });
        sent.push({ agentId, text });
      },
    });
    queues.create({ name: "Q", retryLimit: 10 });
    engine.setRules([rule({
      name: "notify-on-fail", on: "task.state", filter: { state: "failed" },
      actions: [{ type: "notify", to: "somebody", text: "{{data.taskId}} failed" }],
    })]);

    const a = queues.push("Q", { prompt: "a" });
    queues.markFailed(a.taskId, "boom");   // starts firing "notify-on-fail"; its send() is now parked

    const b = queues.push("Q", { prompt: "b" });
    queues.markFailed(b.taskId, "boom too");   // an independent failure — must NOT be suppressed

    // Proof BEFORE releasing anything: B's notify actually ran (parked its own send call)
    // instead of being rejected as self-cause while A's send was still in flight.
    expect(pendingSends).toHaveLength(2);
    pendingSends.forEach((release) => release());
    await flush();

    expect(suppressedEvents(events)).toHaveLength(0);
    expect(firedEvents(events)).toHaveLength(2);
    expect(sent.map((s) => s.text).sort()).toEqual([`${a.taskId} failed`, `${b.taskId} failed`].sort());
  });

  it("maxFiresPerHour rate-limits a rule — the 3rd match within the window is suppressed", async () => {
    let nowValue = 1_000_000;
    const { events, queues, engine } = rig({ now: () => nowValue });
    queues.create({ name: "Q", retryLimit: 10 });
    engine.setRules([rule({
      name: "spammy", on: "task.state", filter: { state: "failed" },
      actions: [{ type: "push", queue: "Q", prompt: "child" }],
      maxChainDepth: 10, maxFiresPerHour: 2,
    })]);

    for (let i = 0; i < 3; i++) {
      const t = queues.push("Q", { prompt: `t${i}` });
      queues.markFailed(t.taskId, "boom");
      nowValue += 1000;
    }
    await flush();
    expect(firedEvents(events)).toHaveLength(2);
    expect(suppressedEvents(events)).toHaveLength(1);
    expect(suppressedEvents(events)[0]!.data).toMatchObject({ rule: "spammy", reason: "rate-limit" });
  });

  it("maxFiresPerHour is counted at fire-START, not completion — a synchronous burst against an async-action rule still rate-limits", async () => {
    // Regression test (code review, pre-land): recordFiring used to run only once a firing fully
    // completed. For a rule whose action needs the async tail (finishAsync), that completion is
    // deferred past the current synchronous stack — a synchronous burst of matching events (e.g.
    // a queue operation that fails many tasks inline) would all pass the rolling-window check
    // before any of them had recorded, blowing past maxFiresPerHour in one tick.
    const pendingSends: Array<() => void> = [];
    let nowValue = 2_000_000;
    const { events, queues, engine } = rig({
      now: () => nowValue,
      send: async () => { await new Promise<void>((resolve) => { pendingSends.push(resolve); }); },
    });
    queues.create({ name: "Q", retryLimit: 10 });
    engine.setRules([rule({
      name: "spammy-async", on: "task.state", filter: { state: "failed" },
      actions: [{ type: "notify", to: "somebody", text: "hi" }],
      maxChainDepth: 10, maxFiresPerHour: 2,
    })]);

    for (let i = 0; i < 3; i++) {
      const t = queues.push("Q", { prompt: `t${i}` });
      queues.markFailed(t.taskId, "boom");   // all 3 dispatched synchronously, back to back
    }
    // The 3rd is rate-limited at DISPATCH time, before any of the 2 admitted firings' notify()
    // has resolved — proving the count happened at fire-start, not completion.
    expect(suppressedEvents(events)).toHaveLength(1);
    expect(suppressedEvents(events)[0]!.data).toMatchObject({ rule: "spammy-async", reason: "rate-limit" });
    expect(pendingSends).toHaveLength(2);   // only the 2 admitted firings ever reached send()

    pendingSends.forEach((release) => release());
    await flush();
    expect(firedEvents(events)).toHaveLength(2);
  });

  it("a disabled rule never matches", async () => {
    const { events, queues, engine } = rig();
    queues.create({ name: "Q", retryLimit: 1 });
    engine.setRules([rule({ enabled: false })]);
    queues.push("Q", { prompt: "seed" });
    await flush();
    expect(firedEvents(events)).toHaveLength(0);
  });

  it("notify @conductor resolves via the task's assigned agent + resolveTreeAgent, and renders the template", async () => {
    const { events, queues, engine, sent } = rig({ resolveTreeAgent: (agentId) => `tree-of-${agentId}` });
    queues.create({ name: "Q", retryLimit: 1 });
    engine.setRules([rule({
      name: "notify-rule", on: "task.state", filter: { state: "done" },
      actions: [{ type: "notify", to: "@conductor", text: "task {{data.taskId}} -> {{data.state}}" }],
    })]);
    const t = queues.push("Q", { prompt: "seed" });
    queues.markInProgress(t.taskId, "worker-1");
    queues.markDone(t.taskId, "ok");
    await flush();

    expect(sent).toEqual([{ agentId: "tree-of-worker-1", text: `task ${t.taskId} -> done` }]);
    expect(firedEvents(events)).toHaveLength(1);
  });

  it("an unknown template key renders empty and is noted in the firing audit", async () => {
    const { events, queues, engine } = rig();
    queues.create({ name: "Q", retryLimit: 1 });
    engine.setRules([rule({
      name: "templ", on: "task.state",
      actions: [{ type: "push", queue: "Q", prompt: "hello {{data.nope}} world" }],
    })]);
    queues.push("Q", { prompt: "seed" });
    await flush();

    const fired = firedEvents(events);
    expect(fired).toHaveLength(1);
    const actions = fired[0]!.data["actions"] as Array<{ type: string; ok: boolean; detail: string }>;
    expect(actions[0]!.detail).toContain("unknown template key");
    const child = queues.status("Q").tasks.find((t: TaskRecord) => t.prompt === "hello  world");
    expect(child).toBeTruthy();   // the unknown key rendered to "" — not left as a literal {{...}}
  });

  it("a failing action logs hook_error without aborting the firing", async () => {
    const { events, queues, engine } = rig({
      send: async () => { throw new Error("mailbox unavailable"); },
    });
    queues.create({ name: "Q", retryLimit: 1 });
    engine.setRules([rule({
      name: "mixed", on: "task.state",
      actions: [
        { type: "notify", to: "somebody", text: "unknown: {{data.nope}}" },
        { type: "push", queue: "Q", prompt: "second action still runs" },
      ],
    })]);
    queues.push("Q", { prompt: "seed" });
    await flush();

    expect(events.tail(null, 500).filter((e) => e.kind === "hook_error")).toHaveLength(1);
    const fired = firedEvents(events);
    expect(fired).toHaveLength(1);
    const actions = fired[0]!.data["actions"] as Array<{ type: string; ok: boolean }>;
    expect(actions[0]).toMatchObject({ type: "notify", ok: false });
    expect(actions[1]).toMatchObject({ type: "push", ok: true });   // second action still ran
  });

  it("spawn action renders the spec prompt, forwards membership, and stamps cause", async () => {
    const spawned: Array<{ spec: HookSpawnSpec; membership?: { team: string; role: string } }> = [];
    const { events, queues, engine } = rig({
      spawnAgent: async (spec, membership) => { spawned.push({ spec, membership }); return { agentId: "born-1" }; },
    });
    queues.create({ name: "Q", retryLimit: 1 });
    engine.setRules([rule({
      name: "spawn-on-fail", on: "task.state", filter: { state: "failed" },
      actions: [{ type: "spawn", spec: { prompt: "investigate {{data.taskId}}", team: "crew", role: "dev" } }],
    })]);
    const t = queues.push("Q", { prompt: "seed" });
    queues.markFailed(t.taskId, "boom");
    await flush();

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.spec.prompt).toBe(`investigate ${t.taskId}`);
    expect(spawned[0]!.membership).toEqual({ team: "crew", role: "dev" });
    expect(spawned[0]!.spec.cause).toMatchObject({ rule: "spawn-on-fail", chain: 1 });
    const fired = firedEvents(events);
    expect((fired[0]!.data["actions"] as Array<Record<string, unknown>>)[0]).toMatchObject({ type: "spawn", ok: true });
  });

  it("run action splits the command, stamps CHIMERA_HOOK_* env, and surfaces a non-zero exit as hook_error", async () => {
    const calls: Array<{ program: string; args: string[]; env: Record<string, string> }> = [];
    const { events, queues, engine } = rig({
      gateExec: async (program, args, _cwd, env) => {
        calls.push({ program, args, env });
        return { ok: false, message: "boom" };
      },
    });
    queues.create({ name: "Q", retryLimit: 1 });
    engine.setRules([rule({
      name: "run-on-fail", on: "task.state", filter: { state: "failed" },
      actions: [{ type: "run", command: 'notify-send "task {{data.taskId}}"', cwd: "/w", timeoutSec: 5 }],
    })]);
    const t = queues.push("Q", { prompt: "seed" });
    queues.markFailed(t.taskId, "boom");
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.program).toBe("notify-send");
    expect(calls[0]!.args).toEqual([`task ${t.taskId}`]);   // quoted segment kept as one arg
    expect(calls[0]!.env).toMatchObject({ CHIMERA_HOOK_RULE: "run-on-fail", CHIMERA_HOOK_CHAIN: "1" });
    expect(events.tail(null, 500).filter((e) => e.kind === "hook_error")).toHaveLength(1);
  });

  it("channel action invokes channelDeliver with the channel + triggering event + rule name/webhookUrl, and records \"delivered via <channel>\"", async () => {
    // Rig's default channelDeliver is a no-op; override it to prove the sync channel branch of
    // runSyncAction actually calls it (rather than silently dropping the delivery) and forwards
    // the triggering event + { name, webhookUrl } opts verbatim.
    const delivered: Array<{ channel: string; sampleKind: string; opts: { name: string; webhookUrl?: string } }> = [];
    const { events, queues, engine } = rig({
      channelDeliver: (channel, sample, opts) => { delivered.push({ channel, sampleKind: sample.kind, opts }); },
    });
    queues.create({ name: "Q", retryLimit: 1 });
    engine.setRules([rule({
      name: "webhook-on-fail", on: "task.state", filter: { state: "failed" },
      actions: [{ type: "channel", channel: "webhook", webhookUrl: "https://hooks.example/x" }],
    })]);
    const t = queues.push("Q", { prompt: "seed" });
    queues.markFailed(t.taskId, "boom");
    await flush();

    // channelDeliver actually fired exactly once, with the channel, the triggering
    // task_state_changed event, and the rule name + webhookUrl opts.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.channel).toBe("webhook");
    expect(delivered[0]!.sampleKind).toBe("task_state_changed");
    expect(delivered[0]!.opts).toEqual({ name: "webhook-on-fail", webhookUrl: "https://hooks.example/x" });

    // the firing audit records the channel action as ok with the "delivered via <channel>" detail.
    const fired = firedEvents(events);
    expect(fired).toHaveLength(1);
    const actions = fired[0]!.data["actions"] as Array<{ type: string; ok: boolean; detail: string }>;
    expect(actions[0]).toMatchObject({ type: "channel", ok: true, detail: "delivered via webhook" });
  });

  it("notify @team:<team>/<role> fans out to every resolved member", async () => {
    const { queues, engine, sent } = rig({
      membersOf: (team, role) => (team === "crew" && role === "dev" ? [{ agentId: "a1" }, { agentId: "a2" }] : []),
    });
    queues.create({ name: "Q", retryLimit: 1 });
    engine.setRules([rule({
      name: "team-notify", on: "task.state", filter: { state: "failed" },
      actions: [{ type: "notify", to: "@team:crew/dev", text: "heads up" }],
    })]);
    const t = queues.push("Q", { prompt: "seed" });
    queues.markFailed(t.taskId, "boom");
    await flush();

    expect(sent.map((s) => s.agentId).sort()).toEqual(["a1", "a2"]);
  });

  it("notify with a bare agentId (no @conductor/@team prefix) sends directly to it", async () => {
    const { queues, engine, sent } = rig();
    queues.create({ name: "Q", retryLimit: 1 });
    engine.setRules([rule({
      name: "direct-notify", on: "task.state", filter: { state: "failed" },
      actions: [{ type: "notify", to: "some-agent-id", text: "direct" }],
    })]);
    const t = queues.push("Q", { prompt: "seed" });
    queues.markFailed(t.taskId, "boom");
    await flush();

    expect(sent).toEqual([{ agentId: "some-agent-id", text: "direct" }]);
  });
});

describe("hook rules on agent.output (F46)", () => {
  it("fires with the NARROWED one-line payload, never the scan window", async () => {
    const { events, engine, sent } = rig();
    engine.setRules([rule({
      name: "watch-failed", on: "agent.output", filter: { contains: "FAILED" },
      actions: [{ type: "notify", to: "ops", text: "{{data.match}} in {{data.agentId}}: {{data.text}}" }],
    })]);

    const big = "noise\n".repeat(50) + "make: *** [build] FAILED\n" + "more\n".repeat(50);
    events.append({ agentId: "child-1", kind: "message_complete", data: { text: big } });
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.agentId).toBe("ops");
    expect(sent[0]?.text).toBe("FAILED in child-1: make: *** [build] FAILED");
    expect(firedEvents(events)).toHaveLength(1);
  });

  it("does not fire when the needle is absent, nor on a message_delta", async () => {
    const { events, engine, sent } = rig();
    engine.setRules([rule({ name: "watch", on: "agent.output", filter: { contains: "FAILED" }, actions: [{ type: "notify", to: "ops", text: "x" }] })]);
    events.append({ agentId: "child-1", kind: "message_complete", data: { text: "all green" } });
    events.append({ agentId: "child-1", kind: "message_delta", data: { text: "FAILED" } });
    await flush();
    expect(sent).toHaveLength(0);
  });

  it("is an AGENT-subject topic, so the emitting agent's cause drives the chain guard", async () => {
    const cause = { rule: "watch", eventSeq: 1, chain: 3 };
    const { events, engine, sent } = rig({ getAgentCause: (id: string) => (id === "child-1" ? cause : null) });
    engine.setRules([rule({
      name: "watch", on: "agent.output", filter: { contains: "FAILED" },
      actions: [{ type: "notify", to: "ops", text: "x" }], maxChainDepth: 3,
    })]);

    events.append({ agentId: "child-1", kind: "message_complete", data: { text: "FAILED" } });
    await flush();
    expect(sent).toHaveLength(0);
    expect(suppressedEvents(events)[0]!.data["reason"]).toBe("chain-depth");

    // A different agent has no cause at all -> chain 1, fires normally.
    events.append({ agentId: "child-2", kind: "message_complete", data: { text: "FAILED" } });
    await flush();
    expect(sent).toHaveLength(1);
    expect(firedEvents(events)[0]!.data["chain"]).toBe(1);
  });

  it("HookRuleSchema refuses agent.output without contains, and contains on a lifecycle topic", () => {
    const base = { name: "r", enabled: true, actions: [{ type: "notify", to: "ops", text: "x" }], maxChainDepth: 3, maxFiresPerHour: 20 };
    expect(HookRuleSchema.safeParse({ ...base, on: "agent.output" }).success).toBe(false);
    expect(HookRuleSchema.safeParse({ ...base, on: "agent.settled", filter: { contains: "boom" } }).success).toBe(false);
    // A hook on a content topic MAY stand (maxFiresPerHour bounds it) — no once:true requirement.
    expect(HookRuleSchema.safeParse({ ...base, on: "agent.output", filter: { contains: "boom" } }).success).toBe(true);
  });

  // F46/QA finding F: onEvent used to call mapping.toPayload (a scanWindow slice + full
  // toLowerCase for a content topic) once PER RULE, so N rules sharing the same `on` topic cost
  // N projections for a single event — contradicting the "project once per event" invariant
  // topics.ts documents and SubscriptionRegistry.onEvent already honours. The fix caches the
  // projection per topic across the rule loop; this spies on the shared TOPIC_TABLE mapping to
  // prove the projection itself runs exactly once no matter how many rules watch the topic.
  it("projects a topic's payload exactly ONCE per event, even with several rules on that topic", async () => {
    const spy = vi.spyOn(TOPIC_TABLE["agent.output"], "toPayload");
    try {
      const { events, engine, sent } = rig();
      engine.setRules([
        rule({ name: "watch-a", on: "agent.output", filter: { contains: "FAILED" }, actions: [{ type: "notify", to: "ops", text: "a" }] }),
        rule({ name: "watch-b", on: "agent.output", filter: { contains: "ERROR" }, actions: [{ type: "notify", to: "ops", text: "b" }] }),
        rule({ name: "watch-c", on: "agent.output", filter: { contains: "FAILED" }, actions: [{ type: "notify", to: "ops", text: "c" }] }),
      ]);
      spy.mockClear();   // rig()/setRules do no projection themselves, but keep the count exact
      events.append({ agentId: "child-1", kind: "message_complete", data: { text: "Build FAILED" } });
      await flush();
      expect(spy).toHaveBeenCalledTimes(1);
      // sanity: the shared projection still let the two matching rules (a, c) both fire.
      expect(sent.map((s) => s.text).sort()).toEqual(["a", "c"]);
    } finally {
      spy.mockRestore();
    }
  });
});
