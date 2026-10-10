import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { RPC_CONTRACT } from "@chimera/protocol/contract";
import {
  TopicSchema, TopicFilterSchema,
  AgentSpecSchema, ChimeraConfigSchema, NormalizedEventSchema,
  encodeFrame, decodeFrames, PROTOCOL_VERSION,
  parseAgentAddress, formatAgentAddress,
  EventKindSchema,
  QuestionAnswerSchema,
  QuestionOptionSchema,
  QuestionDefaultSchema,
  McpStoreCallParams,
  SliRollupParamsSchema,
  EventLogDurabilityConfigSchema,
  UsageRowSchema, SloThresholdSchema,
} from "@chimera/protocol";

describe("AgentSpecSchema", () => {
  it("applies spec defaults to a minimal spawn", () => {
    const spec = AgentSpecSchema.parse({ prompt: "do X", cwd: "/tmp/p" });
    expect(spec.account).toBe("auto");
    expect(spec.isolation).toBe("worktree");
    expect(spec.permissionProfile).toBe("acceptEdits");
    expect(spec.maxTurns).toBe(40);
    expect(spec.turnLimitPolicy).toBe("fail");
    expect(spec.orchestration).toEqual({ allow: false, maxDepth: 2 });
    expect(spec.on.permissionRequest).toBe("auto");
    expect(spec.deliverTo).toBeNull();
    expect(spec.crossProviderFailover).toBe(false);
    expect(spec.resume).toBeNull();
    expect(spec.autonomy).toBe("ask");
  });
  it("rejects an unknown permissionProfile", () => {
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", permissionProfile: "yolo" })).toThrow();
  });
  // AGENT-AUTONOMY: additive z.enum(["ask","full"]).default("ask") — an existing persisted
  // spec with no `autonomy` key must parse byte-identically (defaults to "ask", the pre-feature
  // behavior for every one of the three ask_* tools + AskUserQuestion).
  it("AGENT-AUTONOMY: defaults to \"ask\" (byte-identical parse for a pre-existing spec with no autonomy key), accepts \"full\", rejects an unknown value", () => {
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t" }).autonomy).toBe("ask");
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t", autonomy: "full" }).autonomy).toBe("full");
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", autonomy: "yolo" })).toThrow();
  });
  it("accepts an explicit soft turnLimitPolicy, and rejects an unknown one", () => {
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t", turnLimitPolicy: "soft" }).turnLimitPolicy).toBe("soft");
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", turnLimitPolicy: "retry" })).toThrow();
  });
  it("accepts an explicit resume sessionId (RS1)", () => {
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t", isolation: "none", resume: "sess-123" }).resume).toBe("sess-123");
  });
  it("defaults resumeOnly to false, and accepts an explicit true (CR1)", () => {
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t", isolation: "none" }).resumeOnly).toBe(false);
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t", isolation: "none", resumeOnly: true }).resumeOnly).toBe(true);
  });
  it("accepts a single engine-qualified deliverTo and still rejects deeper paths (Phase 5 widening)", () => {
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t", deliverTo: "engineB/a1" }).deliverTo).toBe("engineB/a1");
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", deliverTo: "a/b/c" })).toThrow();
  });
  it("keeps mcpToolAllowlist absent by default and accepts closed-world server grants", () => {
    const absent = AgentSpecSchema.parse({ prompt: "x", cwd: "/t" });
    expect("mcpToolAllowlist" in absent).toBe(false);
    expect(AgentSpecSchema.parse({
      prompt: "x", cwd: "/t",
      mcpToolAllowlist: { chimera: ["my_team", "memory_search"], external: [] },
    }).mcpToolAllowlist).toEqual({
      chimera: ["my_team", "memory_search"],
      external: [],
    });
  });
  it("rejects empty MCP server/tool names in mcpToolAllowlist", () => {
    expect(() => AgentSpecSchema.parse({
      prompt: "x", cwd: "/t", mcpToolAllowlist: { "": ["read"] },
    })).toThrow();
    expect(() => AgentSpecSchema.parse({
      prompt: "x", cwd: "/t", mcpToolAllowlist: { server: [""] },
    })).toThrow();
  });

  // LEAN-AGENT-MCPS: sparse-patch discipline (mirrors mcpToolAllowlist above) — optional with
  // NO default, so an existing persisted spec with no strictMcpConfig key parses byte-identically
  // and defers entirely to the daemon's leanAgentContext default (supervisor.ts).
  it("keeps strictMcpConfig absent by default, and accepts an explicit true/false independent of inherit.settingSources", () => {
    const absent = AgentSpecSchema.parse({ prompt: "x", cwd: "/t" });
    expect("strictMcpConfig" in absent).toBe(false);
    const spec = AgentSpecSchema.parse({
      prompt: "x", cwd: "/t", strictMcpConfig: true, inherit: { settingSources: ["project", "user"] },
    });
    expect(spec.strictMcpConfig).toBe(true);
    expect(spec.inherit.settingSources).toEqual(["project", "user"]);
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t", strictMcpConfig: false }).strictMcpConfig).toBe(false);
  });
  it("rejects a non-boolean strictMcpConfig", () => {
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", strictMcpConfig: "yes" })).toThrow();
  });

  // WS-E (native-CLI-parity: load plugins from spec)
  it("defaults plugins to an empty array on a minimal spawn", () => {
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t" }).plugins).toEqual([]);
  });
  it("accepts a well-formed plugins array (SdkPluginConfig shape) and passes skipMcpDiscovery through", () => {
    const parsed = AgentSpecSchema.parse({
      prompt: "x", cwd: "/t",
      plugins: [{ type: "local", path: "./my-plugin" }, { type: "local", path: "/abs/p", skipMcpDiscovery: true }],
    });
    expect(parsed.plugins).toEqual([
      { type: "local", path: "./my-plugin" },
      { type: "local", path: "/abs/p", skipMcpDiscovery: true },
    ]);
  });
  it("rejects a malformed plugin entry (unknown type, empty path, or an extra key)", () => {
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", plugins: [{ type: "git", path: "./p" }] })).toThrow();
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", plugins: [{ type: "local", path: "" }] })).toThrow();
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", plugins: [{ type: "local", path: "./p", oops: 1 }] })).toThrow();
  });
  it("no longer carries the dead inherit.plugins flag (WS-E decision: removed, stripped if passed)", () => {
    // inherit is a non-strict object, so an old caller passing plugins:true parses —
    // the field is simply dropped, and inherit resolves to settingSources only.
    const parsed = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", inherit: { plugins: true } });
    expect(parsed.inherit).toEqual({ settingSources: ["project", "user"] });
    expect("plugins" in parsed.inherit).toBe(false);
  });
});

describe("agent addressing (federation pre-provision)", () => {
  it("splits on the FIRST '/' and treats unqualified ids as local", () => {
    expect(parseAgentAddress("a1")).toEqual({ engineId: null, localId: "a1" });
    expect(parseAgentAddress("engineB/a1")).toEqual({ engineId: "engineB", localId: "a1" });
    expect(formatAgentAddress("engineB", "a1")).toBe("engineB/a1");
    expect(formatAgentAddress(null, "a1")).toBe("a1");
  });
});

describe("ChimeraConfigSchema", () => {
  it("parses the spec §6 example config", () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        { name: "second", provider: "claude", auth: { type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN" } },
      ],
      autoOrder: ["main", "second"],
      failoverCooldownMinutes: 30,
      caps: { maxAgentsTotal: 12, perAccount: { main: 6 } },
    });
    expect(cfg.accounts[1]!.auth.type).toBe("keychain");
  });
  it("caps.subAgentModel is optional: absent ⇒ undefined, present ⇒ preserved (WS-OPT)", () => {
    const base = {
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
    };
    // absent (old configs) parse unchanged
    expect(ChimeraConfigSchema.parse(base).caps.subAgentModel).toBeUndefined();
    // present is preserved
    expect(ChimeraConfigSchema.parse({
      ...base, caps: { maxAgentsTotal: 12, perAccount: {}, subAgentModel: "claude-sonnet-5" },
    }).caps.subAgentModel).toBe("claude-sonnet-5");
    // present-but-empty is rejected (would silently no-op at the stamp site)
    expect(() => ChimeraConfigSchema.parse({
      ...base, caps: { maxAgentsTotal: 12, perAccount: {}, subAgentModel: "" },
    })).toThrow();
  });
  it("rejects an auth value field (secrets must never live in config)", () => {
    expect(() => ChimeraConfigSchema.parse({
      accounts: [{ name: "bad", provider: "claude", auth: { type: "env", var: "K", injectAs: "ANTHROPIC_API_KEY", value: "sk-live" } }],
      autoOrder: ["bad"],
    })).toThrow();
  });
  it("projectImportDir defaults to null and round-trips when set (IMPORT-DIR)", () => {
    const base = {
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
    };
    expect(ChimeraConfigSchema.parse(base).projectImportDir).toBeNull();
    expect(ChimeraConfigSchema.parse({
      ...base, projectImportDir: "/home/user/imports",
    }).projectImportDir).toBe("/home/user/imports");
    expect(ChimeraConfigSchema.parse({
      ...base, projectImportDir: null,
    }).projectImportDir).toBeNull();
  });

  // FEATURE-7 (OTel GenAI tracing + SLI rollup + redaction)
  it("otel defaults to a fully-disabled/offline-safe policy when omitted", () => {
    const base = {
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
    };
    const cfg = ChimeraConfigSchema.parse(base);
    expect(cfg.otel).toEqual({
      endpoint: null, serviceName: "chimera",
      redaction: { redactPrompts: true, redactToolIO: true, extraKeys: [] },
      maxFinishedSpans: 20000,
    });
  });
  it("otel.endpoint rejects a non-URL string and accepts a valid http(s) URL", () => {
    const base = {
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
    };
    expect(() => ChimeraConfigSchema.parse({ ...base, otel: { endpoint: "not-a-url" } })).toThrow();
    expect(ChimeraConfigSchema.parse({
      ...base, otel: { endpoint: "http://localhost:4318/v1/traces" },
    }).otel.endpoint).toBe("http://localhost:4318/v1/traces");
  });

  // R2-DURABLE-LOG (durable event log + corruption recovery)
  it("durability defaults to group-commit when omitted (old configs parse byte-identically)", () => {
    const base = {
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
    };
    expect(ChimeraConfigSchema.parse(base).durability).toEqual({
      mode: "group-commit", groupCommitMs: 25, groupCommitMaxBatch: 200,
    });
  });
  it("durability.mode accepts fsync-always and rejects an unknown mode", () => {
    const base = {
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
    };
    expect(ChimeraConfigSchema.parse({ ...base, durability: { mode: "fsync-always" } }).durability.mode).toBe("fsync-always");
    expect(() => ChimeraConfigSchema.parse({ ...base, durability: { mode: "sync-never" } })).toThrow();
  });
});

describe("EventLogDurabilityConfigSchema (R2-DURABLE-LOG)", () => {
  it("rejects a non-positive groupCommitMs/groupCommitMaxBatch", () => {
    expect(() => EventLogDurabilityConfigSchema.parse({ groupCommitMs: 0 })).toThrow();
    expect(() => EventLogDurabilityConfigSchema.parse({ groupCommitMaxBatch: -1 })).toThrow();
  });
  it("rejects an unknown extra key (.strict())", () => {
    expect(() => EventLogDurabilityConfigSchema.parse({ mode: "fsync-always", bogus: true })).toThrow();
  });
});

describe("SliRollupParamsSchema (FEATURE-7)", () => {
  it("round-trips an all-optional empty request", () => {
    expect(SliRollupParamsSchema.parse({})).toEqual({});
  });
  it("round-trips a fully-populated request", () => {
    const req = { taskId: "t1", workflow: "w1", from: 100, to: 200 };
    expect(SliRollupParamsSchema.parse(req)).toEqual(req);
  });
  it("rejects an unknown extra key (.strict())", () => {
    expect(() => SliRollupParamsSchema.parse({ taskId: "t1", bogus: true })).toThrow();
  });
});

describe("Fleet SLO protocol", () => {
  it("accepts bounded rollup dimensions and defaults old usage rows to unknown provider", () => {
    expect(SliRollupParamsSchema.parse({ from: 1, to: 2, bucketMs: 1, groupBy: "provider" }).groupBy).toBe("provider");
    const row = UsageRowSchema.parse({
      ts: 1, agent: "a", team: null, job: null, account: "main", model: "m",
      billableUsage: { input: 1, output: 2 }, contextUsage: { input: 1, output: 2 }, costUsd: 0,
    });
    expect(row.provider).toBe("unknown");
  });
  it("validates persisted thresholds", () => {
    expect(SloThresholdSchema.parse({ id: "p95", metric: "p95_latency_ms", limit: 1000, window: "24h" }).enabled).toBe(true);
    expect(() => SloThresholdSchema.parse({ id: "bad", metric: "error_rate", limit: 0, window: "24h" })).toThrow();
  });
});

describe("NDJSON frames", () => {
  it("round-trips frames split across chunk boundaries", () => {
    const ev = NormalizedEventSchema.parse({ ts: 1, seq: 1, agentId: "a1", kind: "result", data: { text: "ok" } });
    expect(ev.engineId).toBe("local");               // defaulted federation pre-provision; schema stays strict
    const wire = encodeFrame({ type: "event", event: ev }) + encodeFrame({ id: "1", type: "response", ok: true, result: {} });
    const cut = Math.floor(wire.length / 2);
    const p1 = decodeFrames(wire.slice(0, cut));
    const p2 = decodeFrames(p1.rest + wire.slice(cut));
    expect(p1.frames.length + p2.frames.length).toBe(2);
    expect(p2.rest).toBe("");
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("round-trips an error response's message (AUDIT-1: a raw Error's .message is non-enumerable and drops out of JSON.stringify)", () => {
    const wire = encodeFrame({ id: "1", type: "response", ok: false, error: { code: "protocol", message: "unknown queue \"ghost\"" } });
    const { frames } = decodeFrames(wire);
    expect(frames).toEqual([{ id: "1", type: "response", ok: false, error: { code: "protocol", message: "unknown queue \"ghost\"" } }]);
  });

  it("skips a torn/garbage complete line instead of throwing (a bad frame must never crash the socket 'data' handler)", () => {
    const good = encodeFrame({ id: "1", type: "response", ok: true, result: {} });
    const wire = "{not valid json\n" + good;
    const { frames, rest } = decodeFrames(wire);
    expect(frames).toEqual([{ id: "1", type: "response", ok: true, result: {} }]);
    expect(rest).toBe("");
  });

  it("silently drops the message if a raw Error instance is passed as the error body instead of a plain object", () => {
    // Guards the exact AUDIT-1 pitfall: JSON.stringify(new Error("x")) is "{}" because
    // Error.prototype.message is non-enumerable. Call sites MUST extract {code, message}
    // into a plain object (as server.ts's dispatch catch does) before calling encodeFrame.
    const rawError = Object.assign(new Error("unknown queue \"ghost\""), { code: "protocol" });
    const wire = encodeFrame({ id: "1", type: "response", ok: false, error: rawError as unknown as { code: string; message: string } });
    const { frames } = decodeFrames(wire);
    const decoded = frames[0] as { error: { code: string; message?: string } };
    expect(decoded.error.code).toBe("protocol");
    expect(decoded.error.message).toBeUndefined();
  });
});

describe("agent_question event kind (spec §17.2)", () => {
  it("accepts 'agent_question' as a valid EventKind", () => {
    expect(EventKindSchema.parse("agent_question")).toBe("agent_question");
  });

  it("places agent_question immediately after permission_request", () => {
    const kinds = EventKindSchema.options;
    expect(kinds[kinds.indexOf("permission_request") + 1]).toBe("agent_question");
  });

  it("still accepts an agent_question NormalizedEvent through the locked shape", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "a1", kind: "agent_question",
      data: { questionId: "q1", prompt: "proceed?", multiSelect: false, freeform: true, policy: "tui" },
    });
    expect(ev.kind).toBe("agent_question");
    expect(ev.engineId).toBe("local"); // federation default still applies
  });
});

describe("capability_decision event kind + McpStoreCallParams.agentId (FEATURE-6)", () => {
  it("accepts 'capability_decision' as a valid EventKind", () => {
    expect(EventKindSchema.parse("capability_decision")).toBe("capability_decision");
  });

  it("a capability_decision NormalizedEvent round-trips through the locked shape", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "a1", kind: "capability_decision",
      data: { principal: "a1", action: "host_tool", resource: "kubectl:prod", decision: "deny", reason: "denied" },
    });
    expect(ev.kind).toBe("capability_decision");
  });

  it("McpStoreCallParams accepts an optional agentId and defaults args to {}", () => {
    expect(McpStoreCallParams.parse({ server: "s", tool: "t", agentId: "a1" }))
      .toEqual({ server: "s", tool: "t", args: {}, agentId: "a1" });
  });

  it("McpStoreCallParams stays valid (agentId absent) — byte-identical to before this feature", () => {
    expect(McpStoreCallParams.parse({ server: "s", tool: "t", args: { x: 1 } }))
      .toEqual({ server: "s", tool: "t", args: { x: 1 } });
  });

  it("McpStoreCallParams rejects unknown fields (strict)", () => {
    expect(() => McpStoreCallParams.parse({ server: "s", tool: "t", bogus: 1 })).toThrow();
  });
});

describe("QuestionAnswer / QuestionOption / QuestionDefault schemas (spec §17.3)", () => {
  it("parses an option-only answer", () => {
    expect(QuestionAnswerSchema.parse({ optionIds: ["yes"] })).toEqual({ optionIds: ["yes"] });
  });

  it("parses a free-text answer", () => {
    expect(QuestionAnswerSchema.parse({ text: "ship it" })).toEqual({ text: "ship it" });
  });

  it("parses an empty answer (timeout-with-no-default resolves to {})", () => {
    expect(QuestionAnswerSchema.parse({})).toEqual({});
  });

  it("rejects unknown keys on an answer (strict)", () => {
    expect(() => QuestionAnswerSchema.parse({ choice: "yes" })).toThrow();
  });

  it("parses a full option and a default", () => {
    expect(QuestionOptionSchema.parse({ id: "a", label: "Option A", description: "does A" }))
      .toEqual({ id: "a", label: "Option A", description: "does A" });
    expect(QuestionDefaultSchema.parse({ optionIds: ["a"], text: "or this" }))
      .toEqual({ optionIds: ["a"], text: "or this" });
  });
});

describe("agent_question / QuestionAnswer edge cases (beyond brief examples)", () => {
  it("rejects an EventKind string not in the enum", () => {
    expect.assertions(1);
    expect(() => EventKindSchema.parse("not_a_real_kind")).toThrow();
  });

  it("parses an answer with BOTH optionIds and text set (no precedence enforced at schema level)", () => {
    expect(QuestionAnswerSchema.parse({ optionIds: ["a", "b"], text: "also this" }))
      .toEqual({ optionIds: ["a", "b"], text: "also this" });
  });

  it("parses an answer with an empty optionIds array (n<=0 boundary)", () => {
    expect(QuestionAnswerSchema.parse({ optionIds: [] })).toEqual({ optionIds: [] });
  });

  it("parses an answer with an empty-string text (boundary, not undefined)", () => {
    expect(QuestionAnswerSchema.parse({ text: "" })).toEqual({ text: "" });
  });

  it("rejects an answer whose optionIds contains a non-string element", () => {
    expect.assertions(1);
    expect(() => QuestionAnswerSchema.parse({ optionIds: ["ok", 42] })).toThrow();
  });

  it("rejects an answer whose optionIds is not an array", () => {
    expect.assertions(1);
    expect(() => QuestionAnswerSchema.parse({ optionIds: "yes" })).toThrow();
  });

  it("rejects an answer whose text is not a string", () => {
    expect.assertions(1);
    expect(() => QuestionAnswerSchema.parse({ text: 123 })).toThrow();
  });

  it("rejects a QuestionOption missing the required id", () => {
    expect.assertions(1);
    expect(() => QuestionOptionSchema.parse({ label: "Option A" })).toThrow();
  });

  it("rejects a QuestionOption missing the required label", () => {
    expect.assertions(1);
    expect(() => QuestionOptionSchema.parse({ id: "a" })).toThrow();
  });

  it("parses a QuestionOption without the optional description", () => {
    expect(QuestionOptionSchema.parse({ id: "a", label: "Option A" }))
      .toEqual({ id: "a", label: "Option A" });
  });

  it("rejects a QuestionOption with an unknown key (strict)", () => {
    expect.assertions(1);
    expect(() => QuestionOptionSchema.parse({ id: "a", label: "Option A", extra: true })).toThrow();
  });

  it("parses an empty QuestionDefault (both fields optional)", () => {
    expect(QuestionDefaultSchema.parse({})).toEqual({});
  });

  it("parses a QuestionDefault with only optionIds", () => {
    expect(QuestionDefaultSchema.parse({ optionIds: ["a"] })).toEqual({ optionIds: ["a"] });
  });

  it("parses a QuestionDefault with only text", () => {
    expect(QuestionDefaultSchema.parse({ text: "or this" })).toEqual({ text: "or this" });
  });

  it("rejects a QuestionDefault with an unknown key (strict)", () => {
    expect.assertions(1);
    expect(() => QuestionDefaultSchema.parse({ optionIds: ["a"], bogus: 1 })).toThrow();
  });

  it("rejects a QuestionDefault whose optionIds contains a non-string element", () => {
    expect.assertions(1);
    expect(() => QuestionDefaultSchema.parse({ optionIds: [null] })).toThrow();
  });
});

// ---------- agent_task event kind (native-CLI-parity Phase 1, Task N1) ----------
// data shape (documented here, NOT schema-enforced — data stays a loose z.record):
// { taskId, toolUseId?, parentToolUseId?, subagentType?, taskType?, workflowName?,
//   description?, status?, usage?, lastToolName?, summary?, error?, skipTranscript? }
// — all optional except taskId.
describe("agent_task event kind (native-CLI-parity Phase 1, Task N1)", () => {
  it("accepts 'agent_task' as a valid EventKind", () => {
    expect(EventKindSchema.parse("agent_task")).toBe("agent_task");
  });

  it("round-trips a NormalizedEvent with kind:'agent_task' through the locked shape (loose data preserved)", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "a1", kind: "agent_task",
      data: { taskId: "t1", toolUseId: "tu_1", subagentType: "qa", status: "running" },
    });
    expect(ev.kind).toBe("agent_task");
    expect(ev.data).toEqual({ taskId: "t1", toolUseId: "tu_1", subagentType: "qa", status: "running" });
    expect(ev.engineId).toBe("local"); // federation default still applies
  });

  it("rejects an EventKind string not in the enum (regression: unrelated to agent_task itself)", () => {
    expect.assertions(1);
    expect(() => EventKindSchema.parse("agent_task_typo")).toThrow();
  });

  it("still accepts every pre-existing EventKind after the addition (additive, no regression)", () => {
    for (const k of [
      "agent_started", "message_delta", "message_complete", "tool_call", "tool_result",
      "permission_request", "agent_question", "turn_complete", "result", "error", "failover", "status",
    ]) {
      expect(EventKindSchema.parse(k)).toBe(k);
    }
  });
});

describe("EventKindSchema: event_log_recovery (R2-DURABLE-LOG)", () => {
  it("accepts event_log_recovery", () => {
    expect(EventKindSchema.parse("event_log_recovery")).toBe("event_log_recovery");
  });
  it("round-trips a NormalizedEvent carrying it", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 1, agentId: "eventlog", kind: "event_log_recovery",
      data: { quarantined: [{ file: "events.1-5.jsonl", reason: "checksum mismatch" }], seqGaps: [] },
    });
    expect(ev.kind).toBe("event_log_recovery");
    expect(ev.agentId).toBe("eventlog");
  });
});

describe("EventKindSchema: turn_timeout (R2-TURN-LIFECYCLE)", () => {
  it("accepts turn_timeout", () => {
    expect(EventKindSchema.parse("turn_timeout")).toBe("turn_timeout");
  });
  it("round-trips a NormalizedEvent carrying it", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 1, agentId: "a1", kind: "turn_timeout",
      data: { reason: "idle", elapsedMs: 5000, idleTimeoutMs: 5000 },
    });
    expect(ev.kind).toBe("turn_timeout");
    expect(ev.data["reason"]).toBe("idle");
  });
});

describe("AgentSpecSchema: idleTimeoutMs/maxTurnDurationMs (R2-TURN-LIFECYCLE)", () => {
  it("are undefined by default (no watchdog armed) — byte-identical to pre-existing specs", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/t" });
    expect(spec.idleTimeoutMs).toBeUndefined();
    expect(spec.maxTurnDurationMs).toBeUndefined();
  });
  it("accepts explicit positive-int overrides", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/t", idleTimeoutMs: 30_000, maxTurnDurationMs: 600_000 });
    expect(spec.idleTimeoutMs).toBe(30_000);
    expect(spec.maxTurnDurationMs).toBe(600_000);
  });
  it("rejects non-positive or non-integer values", () => {
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", idleTimeoutMs: 0 })).toThrow();
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", idleTimeoutMs: -1 })).toThrow();
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", maxTurnDurationMs: 1.5 })).toThrow();
  });
});

describe("AgentSpecSchema: effort (R2 EFFORT)", () => {
  it("is undefined by default — byte-identical to pre-existing specs with no effort key", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/t" });
    expect(spec.effort).toBeUndefined();
    expect("effort" in spec).toBe(false);
  });
  it("accepts each of the six valid effort levels", () => {
    for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/t", effort }).effort).toBe(effort);
    }
  });
  it("rejects a value outside the closed vocabulary", () => {
    expect(() => AgentSpecSchema.parse({ prompt: "x", cwd: "/t", effort: "ultra" })).toThrow();
  });
});

// F46 §3.4. agent.output is the FIRST content topic — every other member of the vocabulary is a
// lifecycle signal whose payload carries no text — so `contains` is the first filter key that is
// simultaneously REQUIRED on one topic and REFUSED on all the others. These tests pin that
// asymmetry at the schema and at the RPC boundary, where an MCP caller actually reaches it.
describe("F46: agent.output + filter.contains (protocol shapes)", () => {
  it("TopicSchema accepts agent.output", () => {
    expect(TopicSchema.parse("agent.output")).toBe("agent.output");
  });

  it("TopicFilterSchema accepts a 3-64 char contains and refuses anything outside that band", () => {
    expect(TopicFilterSchema.parse({ contains: "ERR" }).contains).toBe("ERR");
    expect(TopicFilterSchema.parse({ contains: "x".repeat(64) }).contains).toHaveLength(64);
    expect(TopicFilterSchema.parse({}).contains).toBeUndefined();
    // 1-2 chars matches essentially every line of output in the fleet; >64 is a paste, not a needle.
    expect(() => TopicFilterSchema.parse({ contains: "er" })).toThrow();
    expect(() => TopicFilterSchema.parse({ contains: "x".repeat(65) })).toThrow();
    expect(() => TopicFilterSchema.parse({ contains: 42 })).toThrow();
  });

  describe("sub.create's request schema (A9 — the refusal an agent actually hits)", () => {
    const { request } = RPC_CONTRACT["sub.create"];
    const base = { subscriberId: "a1", topic: "agent.output" as const };

    it("accepts agent.output with a contains needle", () => {
      const parsed = request.parse({ ...base, filter: { contains: "ERROR" } });
      expect(parsed).toMatchObject({ topic: "agent.output", filter: { contains: "ERROR" }, once: true });
    });

    it("refuses agent.output without filter.contains", () => {
      expect(() => request.parse(base)).toThrow();
      expect(() => request.parse({ ...base, filter: { agentId: "a2" } })).toThrow();
    });

    it("refuses agent.output with once:false (a standing content sub has no rate limit of its own)", () => {
      expect(() => request.parse({ ...base, filter: { contains: "ERROR" }, once: false })).toThrow();
    });

    it("refuses contains on a lifecycle topic, which carries no text to match", () => {
      expect(() => request.parse({ subscriberId: "a1", topic: "agent.settled", filter: { contains: "ERROR" } })).toThrow();
      expect(request.parse({ subscriberId: "a1", topic: "agent.settled", filter: { agentId: "a2" } }).topic).toBe("agent.settled");
    });
  });

  // A5. The verdict's binding OUT decision: `contains` is a literal substring needle, never a
  // pattern. A regex built from a subscriber-supplied value would run on every output event in
  // the fleet, so a catastrophically-backtracking needle is a fleet-wide stall. Source-text
  // assertion because it is the only kind that keeps a later refactor from quietly reversing it.
  it("constructs no RegExp anywhere in core's content-matching path", () => {
    for (const rel of ["../../core/src/topics.ts", "../../core/src/subscriptions.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(src).not.toContain("new RegExp");
      expect(src).not.toContain("RegExp(");
    }
  });
});
