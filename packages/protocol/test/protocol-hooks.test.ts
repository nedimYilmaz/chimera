import { describe, it, expect } from "vitest";
import {
  EventKindSchema,
  NormalizedEventSchema,
  TopicSchema,
  TopicFilterSchema,
  SubscriptionSchema,
  HookActionSchema,
  HookRuleSchema,
  MCP_TOOL_TABLE,
} from "@chimera/protocol";

// PLAN-HOOKS.md §5 (HOOK-1): the proactive-hooks protocol groundwork. This slice adds NO engine —
// it is pure schema + event-kind surface. These tests lock the 8 new push-based EventKinds and the
// 5 hook/subscription schemas (round-trip, defaults, .strict() rejection, discriminated-union
// bounds), matching the existing EventKindSchema/QuestionAnswerSchema conventions in protocol.test.ts.

// ---------- the 8 new EventKinds (PLAN-HOOKS.md §5) ----------
describe("EventKindSchema: PLAN-HOOKS.md §5 push-based event kinds (HOOK-1)", () => {
  const NEW_KINDS = [
    "task_state_changed", "queue_drained", "memory_added", "repo_head_moved",
    "hook_fired", "hook_error", "hook_suppressed", "signal_delivered",
  ] as const;

  for (const kind of NEW_KINDS) {
    it(`accepts '${kind}' as a valid EventKind`, () => {
      expect(EventKindSchema.parse(kind)).toBe(kind);
    });
  }

  it("round-trips a task_state_changed NormalizedEvent through the locked shape (loose data preserved)", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "task:t1", kind: "task_state_changed",
      data: { queue: "work", taskId: "t1", state: "done", prevState: "in_progress", resultPreview: "ok" },
    });
    expect(ev.kind).toBe("task_state_changed");
    expect(ev.data).toEqual({ queue: "work", taskId: "t1", state: "done", prevState: "in_progress", resultPreview: "ok" });
    expect(ev.engineId).toBe("local"); // federation default still applies
  });

  it("round-trips a task_state_changed with a null prevState (freshly pushed task)", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "task:t1", kind: "task_state_changed",
      data: { queue: "work", taskId: "t1", state: "pending", prevState: null },
    });
    expect(ev.data["prevState"]).toBeNull();
  });

  it("round-trips a queue_drained NormalizedEvent", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "queue:work", kind: "queue_drained", data: { queue: "work" },
    });
    expect(ev.kind).toBe("queue_drained");
    expect(ev.data).toEqual({ queue: "work" });
  });

  it("round-trips a memory_added NormalizedEvent", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "memory:m1", kind: "memory_added",
      data: { id: "m1", kind: "decision", tags: ["x"], author: "ag-1" },
    });
    expect(ev.kind).toBe("memory_added");
    expect(ev.data["author"]).toBe("ag-1");
  });

  it("round-trips a repo_head_moved NormalizedEvent (no emitter in this slice, but the kind is registered)", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "repo:main", kind: "repo_head_moved",
      data: { repo: "/r", branch: "main", from: "abc", to: "def" },
    });
    expect(ev.kind).toBe("repo_head_moved");
  });

  it("round-trips a hook_fired NormalizedEvent carrying its action audit trail", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "hooks", kind: "hook_fired",
      data: { rule: "r1", eventSeq: 10, chain: 1, actions: [{ type: "notify", ok: true, detail: "sent" }] },
    });
    expect(ev.kind).toBe("hook_fired");
  });

  it("round-trips a hook_error NormalizedEvent", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "hooks", kind: "hook_error", data: { rule: "r1", eventSeq: 10, error: "boom" },
    });
    expect(ev.kind).toBe("hook_error");
  });

  it("round-trips a hook_suppressed NormalizedEvent", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "hooks", kind: "hook_suppressed", data: { rule: "r1", reason: "rate-limit", eventSeq: 10 },
    });
    expect(ev.kind).toBe("hook_suppressed");
  });

  it("round-trips a signal_delivered NormalizedEvent", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "sub:s1", kind: "signal_delivered", data: { subscriptionId: "s1", eventSeq: 10, topic: "task.state" },
    });
    expect(ev.kind).toBe("signal_delivered");
  });

  it("rejects an EventKind string not in the enum (additive, no shape loosening)", () => {
    expect.assertions(1);
    expect(() => EventKindSchema.parse("task_state_changed_typo")).toThrow();
  });

  it("still accepts every pre-existing EventKind after the §5 additions (additive, no regression)", () => {
    for (const k of [
      "agent_started", "message_delta", "message_complete", "tool_call", "tool_result",
      "permission_request", "agent_question", "turn_complete", "result", "error", "failover", "status",
      "review_changed",
    ]) {
      expect(EventKindSchema.parse(k)).toBe(k);
    }
  });
});

// ---------- TopicSchema (§2.1/§3, the curated shared topic vocabulary) ----------
describe("TopicSchema (PLAN-HOOKS.md §2.2 curated topics)", () => {
  // Driven off the schema, never off a literal copy: this list WAS a hardcoded copy and silently
  // fell a member behind when "system.woke" (F02) was added, so the newest topic shipped with no
  // accept test at all. Iterating .options makes the next addition impossible to miss here.
  const TOPICS = TopicSchema.options;

  it("has a non-empty curated vocabulary (guards against .options going empty/undefined)", () => {
    expect(TOPICS.length).toBeGreaterThan(10);
    expect(TOPICS).toContain("system.woke");
  });

  // mcp-tools.ts deliberately RE-DECLARES the topic vocabulary as two literal zod enums
  // (HookTopicShape and subscribe's inputSchema.topic) so the MCP tool surface is self-describing.
  // Nothing made them stay in sync — a drift is a silent discoverability bug (an agent cannot
  // subscribe to a topic the daemon would happily accept). This is that guard.
  it("subscribe's re-declared topic enum in MCP_TOOL_TABLE matches TopicSchema exactly", () => {
    const subscribe = MCP_TOOL_TABLE.find((t) => t.name === "subscribe");
    expect(subscribe).toBeDefined();
    const topicField = (subscribe!.inputSchema as Record<string, { options?: readonly string[] }>)["topic"];
    expect(topicField?.options).toEqual([...TopicSchema.options]);
  });

  // The SECOND re-declaration in the same file: HookTopicShape, reached through hook_create's
  // rule shape. subscribe wakes an agent once; a hook rule fires forever — a topic missing here is
  // a topic no durable rule can ever be written against.
  it("hook_create's re-declared rule.on topic enum in MCP_TOOL_TABLE matches TopicSchema exactly", () => {
    const hookCreate = MCP_TOOL_TABLE.find((t) => t.name === "hook_create");
    expect(hookCreate).toBeDefined();
    const rule = (hookCreate!.inputSchema as Record<string, { shape?: Record<string, { options?: readonly string[] }> }>)["rule"];
    expect(rule?.shape?.["on"]?.options).toEqual([...TopicSchema.options]);
  });

  for (const topic of TOPICS) {
    it(`accepts the curated topic '${topic}'`, () => {
      expect(TopicSchema.parse(topic)).toBe(topic);
    });
  }

  // F36.FIX: the memory lifecycle was FEED-ONLY — an operator could watch notes leave the store in
  // the transcript but could neither hook nor subscribe on it. These two names are the fix; the
  // three mirror tests above (subscribe enum, hook_create enum, app HOOK_TOPICS) then pin them.
  it("carries the memory lifecycle topics (F36.FIX — pressure warns, evicted is the loss)", () => {
    expect(TOPICS).toContain("memory.pressure");
    expect(TOPICS).toContain("memory.evicted");
  });

  it("rejects a raw EventKind (raw kinds are never subscribable directly — only curated topics are)", () => {
    expect.assertions(1);
    expect(() => TopicSchema.parse("task_state_changed")).toThrow();
  });

  it("rejects an unknown topic", () => {
    expect.assertions(1);
    expect(() => TopicSchema.parse("not.a.topic")).toThrow();
  });
});

// ---------- TopicFilterSchema (§2.1/§3.1 shallow, field-specific match) ----------
describe("TopicFilterSchema (PLAN-HOOKS.md §2.1 shallow match)", () => {
  it("parses an empty filter (all fields optional)", () => {
    expect(TopicFilterSchema.parse({})).toEqual({});
  });

  it("accepts a scalar field value (exact-equality match)", () => {
    expect(TopicFilterSchema.parse({ agentId: "a1" })).toEqual({ agentId: "a1" });
  });

  it("accepts an array field value (includes-any match)", () => {
    expect(TopicFilterSchema.parse({ state: ["pending", "blocked"] })).toEqual({ state: ["pending", "blocked"] });
  });

  it("accepts tags as an array of strings", () => {
    expect(TopicFilterSchema.parse({ tags: ["urgent", "backend"] })).toEqual({ tags: ["urgent", "backend"] });
  });

  it("accepts the full documented field set together", () => {
    const filter = { agentId: "a1", treeId: ["t1"], taskId: "tk1", queue: "work", team: "core", state: "done", tags: ["x"], repo: "/r" };
    expect(TopicFilterSchema.parse(filter)).toEqual(filter);
  });

  it("rejects an unknown filter field (strict)", () => {
    expect.assertions(1);
    expect(() => TopicFilterSchema.parse({ bogus: "x" })).toThrow();
  });

  it("rejects a non-string element inside a union-array field", () => {
    expect.assertions(1);
    expect(() => TopicFilterSchema.parse({ agentId: ["a1", 42] })).toThrow();
  });
});

// ---------- SubscriptionSchema (§2.1 standing signal request) ----------
describe("SubscriptionSchema (PLAN-HOOKS.md §2.1 standing subscription)", () => {
  it("applies defaults to a minimal subscription (once true, wake 'deliver')", () => {
    const sub = SubscriptionSchema.parse({ id: "s1", subscriberId: "a1", topic: "task.state" });
    expect(sub.once).toBe(true);
    expect(sub.wake).toBe("deliver");
    expect(sub.filter).toBeUndefined();
  });

  it("round-trips a fully-specified subscription", () => {
    const input = {
      id: "s1", subscriberId: "a1", topic: "queue.drained" as const,
      filter: { queue: "work" }, once: false, expiresAt: 1234, coalesceMs: 5000,
      wake: "resume" as const, note: "wake me when work drains",
    };
    expect(SubscriptionSchema.parse(input)).toEqual(input);
  });

  it("accepts each wake mode", () => {
    for (const wake of ["deliver", "resume", "drop"] as const) {
      expect(SubscriptionSchema.parse({ id: "s", subscriberId: "a", topic: "task.state", wake }).wake).toBe(wake);
    }
  });

  it("rejects an unknown wake mode", () => {
    expect.assertions(1);
    expect(() => SubscriptionSchema.parse({ id: "s", subscriberId: "a", topic: "task.state", wake: "spin" })).toThrow();
  });

  it("rejects an empty id (min(1))", () => {
    expect.assertions(1);
    expect(() => SubscriptionSchema.parse({ id: "", subscriberId: "a1", topic: "task.state" })).toThrow();
  });

  it("rejects an empty subscriberId (min(1))", () => {
    expect.assertions(1);
    expect(() => SubscriptionSchema.parse({ id: "s1", subscriberId: "", topic: "task.state" })).toThrow();
  });

  it("rejects a topic outside the curated vocabulary", () => {
    expect.assertions(1);
    expect(() => SubscriptionSchema.parse({ id: "s1", subscriberId: "a1", topic: "task.state.typo" })).toThrow();
  });

  it("rejects a non-positive expiresAt (must be a positive int)", () => {
    expect.assertions(1);
    expect(() => SubscriptionSchema.parse({ id: "s1", subscriberId: "a1", topic: "task.state", expiresAt: 0 })).toThrow();
  });

  it("rejects a negative coalesceMs (must be a non-negative int)", () => {
    expect.assertions(1);
    expect(() => SubscriptionSchema.parse({ id: "s1", subscriberId: "a1", topic: "task.state", coalesceMs: -1 })).toThrow();
  });

  it("accepts a coalesceMs of 0 (non-negative boundary)", () => {
    expect(SubscriptionSchema.parse({ id: "s1", subscriberId: "a1", topic: "task.state", coalesceMs: 0 }).coalesceMs).toBe(0);
  });

  it("rejects a note longer than 200 chars", () => {
    expect.assertions(1);
    expect(() => SubscriptionSchema.parse({ id: "s1", subscriberId: "a1", topic: "task.state", note: "x".repeat(201) })).toThrow();
  });

  it("rejects an unknown field (strict)", () => {
    expect.assertions(1);
    expect(() => SubscriptionSchema.parse({ id: "s1", subscriberId: "a1", topic: "task.state", bogus: true })).toThrow();
  });
});

// ---------- HookActionSchema (§3.2 discriminated union) ----------
describe("HookActionSchema (PLAN-HOOKS.md §3.2 discriminated union)", () => {
  it("parses a 'notify' action", () => {
    expect(HookActionSchema.parse({ type: "notify", to: "@conductor", text: "task failed" }))
      .toEqual({ type: "notify", to: "@conductor", text: "task failed" });
  });

  it("parses a 'push' action with its optional fields", () => {
    const action = { type: "push" as const, queue: "work", prompt: "follow up", role: "reviewer", priority: 5, dependsOnCause: true };
    expect(HookActionSchema.parse(action)).toEqual(action);
  });

  it("parses a minimal 'push' action (only queue + prompt required)", () => {
    expect(HookActionSchema.parse({ type: "push", queue: "work", prompt: "go" }))
      .toEqual({ type: "push", queue: "work", prompt: "go" });
  });

  it("parses a 'spawn' action with a nested spec subset", () => {
    const action = { type: "spawn" as const, spec: { prompt: "investigate", role: "sre", permissionProfile: "readOnly" as const } };
    expect(HookActionSchema.parse(action)).toEqual(action);
  });

  it("parses a 'run' action", () => {
    expect(HookActionSchema.parse({ type: "run", command: "make lint", cwd: "/repo", timeoutSec: 60 }))
      .toEqual({ type: "run", command: "make lint", cwd: "/repo", timeoutSec: 60 });
  });

  it("parses a 'channel' action", () => {
    expect(HookActionSchema.parse({ type: "channel", channel: "webhook", webhookUrl: "https://example.test/hook" }))
      .toEqual({ type: "channel", channel: "webhook", webhookUrl: "https://example.test/hook" });
  });

  it("rejects an unknown discriminant type", () => {
    expect.assertions(1);
    expect(() => HookActionSchema.parse({ type: "explode", to: "a", text: "x" })).toThrow();
  });

  it("rejects a 'notify' action with an empty text (min(1))", () => {
    expect.assertions(1);
    expect(() => HookActionSchema.parse({ type: "notify", to: "@conductor", text: "" })).toThrow();
  });

  it("rejects a 'run' action whose timeoutSec exceeds the 600 max", () => {
    expect.assertions(1);
    expect(() => HookActionSchema.parse({ type: "run", command: "x", timeoutSec: 601 })).toThrow();
  });

  it("rejects a 'run' action missing timeoutSec (required)", () => {
    expect.assertions(1);
    expect(() => HookActionSchema.parse({ type: "run", command: "x" })).toThrow();
  });

  it("rejects an unknown key on a variant (strict)", () => {
    expect.assertions(1);
    expect(() => HookActionSchema.parse({ type: "notify", to: "a", text: "x", extra: 1 })).toThrow();
  });

  it("rejects an unknown key inside the 'spawn' nested spec (strict)", () => {
    expect.assertions(1);
    expect(() => HookActionSchema.parse({ type: "spawn", spec: { prompt: "x", bogus: true } })).toThrow();
  });
});

// ---------- HookRuleSchema (§3.1 declarative on -> actions rule) ----------
describe("HookRuleSchema (PLAN-HOOKS.md §3.1 lifecycle rule)", () => {
  it("applies defaults to a minimal rule (enabled true, maxChainDepth 3, maxFiresPerHour 20)", () => {
    const rule = HookRuleSchema.parse({ name: "on-fail", on: "task.state", actions: [{ type: "notify", to: "@conductor", text: "failed" }] });
    expect(rule.enabled).toBe(true);
    expect(rule.maxChainDepth).toBe(3);
    expect(rule.maxFiresPerHour).toBe(20);
    expect(rule.filter).toBeUndefined();
  });

  it("round-trips a fully-specified rule with a filter and multiple actions", () => {
    const input = {
      name: "escalate", enabled: false, on: "gate.verdict" as const,
      filter: { queue: "work", state: ["failed"] },
      actions: [
        { type: "notify" as const, to: "@team:sre", text: "gate failed" },
        { type: "push" as const, queue: "remediation", prompt: "fix the gate" },
      ],
      maxChainDepth: 5, maxFiresPerHour: 10,
    };
    expect(HookRuleSchema.parse(input)).toEqual(input);
  });

  it("rejects a rule with zero actions (actions min(1))", () => {
    expect.assertions(1);
    expect(() => HookRuleSchema.parse({ name: "r", on: "task.state", actions: [] })).toThrow();
  });

  it("rejects a rule with more than 4 actions (actions max(4))", () => {
    expect.assertions(1);
    const five = Array.from({ length: 5 }, () => ({ type: "notify" as const, to: "a", text: "x" }));
    expect(() => HookRuleSchema.parse({ name: "r", on: "task.state", actions: five })).toThrow();
  });

  it("accepts exactly 4 actions (max boundary)", () => {
    const four = Array.from({ length: 4 }, () => ({ type: "notify" as const, to: "a", text: "x" }));
    expect(HookRuleSchema.parse({ name: "r", on: "task.state", actions: four }).actions).toHaveLength(4);
  });

  it("rejects an empty name (min(1))", () => {
    expect.assertions(1);
    expect(() => HookRuleSchema.parse({ name: "", on: "task.state", actions: [{ type: "notify", to: "a", text: "x" }] })).toThrow();
  });

  it("rejects a non-curated 'on' topic", () => {
    expect.assertions(1);
    expect(() => HookRuleSchema.parse({ name: "r", on: "task_state_changed", actions: [{ type: "notify", to: "a", text: "x" }] })).toThrow();
  });

  it("rejects a non-positive maxChainDepth", () => {
    expect.assertions(1);
    expect(() => HookRuleSchema.parse({ name: "r", on: "task.state", actions: [{ type: "notify", to: "a", text: "x" }], maxChainDepth: 0 })).toThrow();
  });

  it("rejects an unknown key (strict)", () => {
    expect.assertions(1);
    expect(() => HookRuleSchema.parse({ name: "r", on: "task.state", actions: [{ type: "notify", to: "a", text: "x" }], bogus: 1 })).toThrow();
  });

  // F46/QA finding C: treeId/team are accepted by TopicFilterSchema but no projector ever
  // populates them (see UNSATISFIABLE_FILTER_KEYS, packages/core/test/topics.test.ts guard) — a
  // rule filtered on either would silently never fire. scopeFilterIssue rejects it at parse time.
  it("rejects a filter on treeId (unsatisfiable — no projector ever emits it)", () => {
    expect.assertions(1);
    expect(() =>
      HookRuleSchema.parse({ name: "r", on: "task.state", filter: { treeId: "t1" }, actions: [{ type: "notify", to: "a", text: "x" }] }),
    ).toThrow();
  });

  it("rejects a filter on team (unsatisfiable — no projector ever emits it)", () => {
    expect.assertions(1);
    expect(() =>
      HookRuleSchema.parse({ name: "r", on: "task.state", filter: { team: "sre" }, actions: [{ type: "notify", to: "a", text: "x" }] }),
    ).toThrow();
  });
});
