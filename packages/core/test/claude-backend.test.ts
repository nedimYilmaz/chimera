import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";
import { GuardrailError } from "@chimera/core/supervisor";
import { REPO_BACKED_CWD } from "./repo-backed-cwd.js";

// CORE-SUITE-BASELINE: this file's worktree-isolation tests shell out to real `git` —
// under this machine's concurrent-agent load a subprocess spawn can exceed vitest's
// 5000ms default; widened per existing precedent (supervisor-crash-loop.test.ts).
vi.setConfig({ testTimeout: 20_000 });

type Msg = Record<string, unknown>;
function fakeQuery(messages: Msg[]) {
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const fn = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    return {
      async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
      interrupt: vi.fn(async () => {}),
    };
  }) as never;
  return { fn, calls };
}
function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: REPO_BACKED_CWD, isolation: "none", ...over }),
    agentId: "ag-1", accountName: "second", resolvedProvider: "claude",
    env: { ANTHROPIC_AUTH_TOKEN: "tok-x", CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}
const SCRIPT: Msg[] = [
  { type: "system", subtype: "init", session_id: "s1", model: "m1" },
  { type: "assistant", message: { role: "assistant", content: [
    { type: "text", text: "thinking done" },
    { type: "tool_use", name: "Edit", input: { file: "a.ts" } },
  ] } },
  { type: "user", message: { role: "user", content: [] } },
  { type: "result", subtype: "success", result: "final answer", total_cost_usd: 0.42 },
];
const settle = () => new Promise((r) => setTimeout(r, 30));

// CR1: a queryFn whose returned stream never yields anything (parks forever, like a real
// resumed session waiting for the first send) — used to inspect the raw input queue directly
// without a scripted "result" message racing to auto-close it.
function parkedQuery() {
  const calls: Array<{ prompt: AsyncIterable<{ message: { content: Array<{ text?: string }> } }>; options: Record<string, unknown> }> = [];
  const fn = ((args: never) => {
    calls.push(args as never);
    return {
      async *[Symbol.asyncIterator]() { /* never yields */ },
      interrupt: async () => {},
    };
  }) as never;
  return { fn, calls };
}
// parkedQuery's generator body has no `yield` at all, so its FIRST next() resolves `done:true`
// immediately (no real park) — fine for a single synchronous send() before any await, but an
// `await`ed send() lets that resolution's microtask run, closing the input queue underneath a
// later send(). This helper truly never settles (awaits a promise that never resolves), for
// tests that need the queue to stay open across multiple awaited turns.
function foreverParkedQuery() {
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const fn = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    return {
      async *[Symbol.asyncIterator]() { await new Promise<never>(() => {}); },
      interrupt: async () => {},
    };
  }) as never;
  return { fn, calls };
}
// Races the next queue item against a short timeout so "yields nothing (yet)" is observable
// without hanging the test.
function nextOrTimeout(iter: AsyncIterator<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    iter.next().then((r) => (r.done ? "DONE" : r.value)),
    new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), ms)),
  ]);
}

describe("ClaudeAgentBackend", () => {
  it("validates slash commands against the live SDK catalog without queuing unknown prompts", async () => {
    let commands = [{ name: "compact" }, { name: "plugin:review" }];
    const queryFn = (() => ({
      async *[Symbol.asyncIterator]() { await new Promise<never>(() => {}); },
      supportedCommands: async () => commands,
      interrupt: async () => {},
    })) as never;
    const handle = new ClaudeAgentBackend({ queryFn }).spawn(spec({ resumeOnly: true, conductor: true }), () => {}, async () => true);
    try {
      await expect(handle.validateSlash!("/compact retain decisions")).resolves.toBeUndefined();
      await expect(handle.validateSlash!("/plugin:review diff")).resolves.toBeUndefined();
      await expect(handle.validateSlash!("/goal test")).rejects.toThrow("Nothing was sent as a prompt");
      commands = [{ name: "new-skill" }, { name: "goal" }];
      await expect(handle.validateSlash!("/goal test")).resolves.toBeUndefined();
      await expect(handle.validateSlash!("/new-skill")).resolves.toBeUndefined();
      await expect(handle.validateSlash!("/compact")).rejects.toThrow("not available");
    } finally { await handle.kill(); }
  });
  it("normalizes the SDK stream and reports cost", async () => {
    const { fn } = fakeQuery(SCRIPT);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual([
      "agent_started", "message_complete", "tool_call", "tool_result", "turn_complete", "result",
    ]);
    expect(evs.at(-1)!.data).toEqual({ text: "final answer", costUsd: 0.42, model: "m1" });
    // native-CLI-parity Phase 1 (Task N1): tool_call data is additively extended with
    // toolUseId/parentToolUseId; this SCRIPT's tool_use block carries neither an id nor a
    // parent, so toolUseId is undefined (dropped by toEqual) and parentToolUseId is null.
    expect(evs[2]!.data).toEqual({ toolName: "Edit", input: { file: "a.ts" }, parentToolUseId: null });
  });

  // R2: when the SDK NEVER reports total_cost_usd on any message (the key is absent
  // throughout, not merely 0), costUsd falls back to the pricing table computed from `usage` —
  // proving the fallback actually activates, distinct from every other test in this file (which
  // all have total_cost_usd present, even when 0, and must keep reporting the SDK's own number
  // unmodified — see the "carries forward" test below).
  it("falls back to the pricing table when the SDK never reports total_cost_usd", async () => {
    const NO_COST_SCRIPT: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-5" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      {
        type: "result", subtype: "success", result: "done",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    ];
    const { fn } = fakeQuery(NO_COST_SCRIPT);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    const result = evs.find((e) => e.kind === "result")!;
    // claude-sonnet-5's table rate is $3/$15 per MTok in/out (matches budget.ts's pre-existing
    // flat rate) — 1M in + 1M out = 3 + 15 = 18.
    expect(result.data["costUsd"]).toBeCloseTo(18, 10);
  });

  // W2-3 CACHE-WRITE-TTL WIRING: the pricing-table fallback (same code path as the test above)
  // now reads the raw payload's `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` split
  // (verified present on the pinned @anthropic-ai/sdk 0.110.0 BetaCacheCreation type) into
  // claudeCostUsage's cacheCreation5m/1h — this is what turns W2-2's computeCostUsd TTL-split
  // support from merely-possible into actually-fed. Distinguishes from the unresolved-TTL default
  // (which W2-2 pins to the 1h rate for any row that has one): billing the SAME total cacheCreation
  // tokens as a 400k/600k 5m/1h split costs LESS than billing all of it at the 1h default rate —
  // proving the split, not the default, drove this number.
  it("reads the cache_creation TTL split off the raw usage payload for the pricing-table fallback", async () => {
    const TTL_SPLIT_SCRIPT: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-5" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      {
        type: "result", subtype: "success", result: "done",
        usage: {
          input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
          cache_creation_input_tokens: 1_000_000,
          cache_creation: { ephemeral_5m_input_tokens: 400_000, ephemeral_1h_input_tokens: 600_000 },
        },
      },
    ];
    const { fn } = fakeQuery(TTL_SPLIT_SCRIPT);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    const result = evs.find((e) => e.kind === "result")!;
    // claude-sonnet-5: input $3 + output $15 + cacheRead 1M*$0.3 + cacheCreation5m 400k*$3.75
    // + cacheCreation1h 600k*$6 (all per MTok) = 3 + 15 + 0.3 + 1.5 + 3.6 = 23.4. The unresolved-TTL
    // default (all 1M cacheCreation tokens at the 1h rate) would instead give 3 + 15 + 0.3 + 6 = 24.3
    // — the two must differ, or this test isn't actually exercising the split.
    expect(result.data["costUsd"]).toBeCloseTo(23.4, 10);
  });

  it("maps options: env merge, permission modes, settingSources, model, maxTurns", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    const backend = new ClaudeAgentBackend({ queryFn: fn });
    backend.spawn(spec({ model: "claude-x", maxTurns: 7, inherit: { settingSources: ["project"] } }), () => {}, async () => true);
    backend.spawn(spec({ permissionProfile: "full" }), () => {}, async () => true);
    backend.spawn(spec({ permissionProfile: "readOnly" }), () => {}, async () => true);
    await settle();
    const o = calls[0]!.options;
    expect((o.env as Record<string, string>)["ANTHROPIC_AUTH_TOKEN"]).toBe("tok-x");
    expect(o.permissionMode).toBe("acceptEdits");
    expect(o.settingSources).toEqual(["project"]);
    expect(o.model).toBe("claude-x");
    expect(o.maxTurns).toBe(7);
    expect(o.cwd).toBe(REPO_BACKED_CWD);
    expect(calls[1]!.options.permissionMode).toBe("bypassPermissions");
    expect(calls[2]!.options.permissionMode).toBe("default");
  });

  // R2 EFFORT: direct passthrough — chimera's neutral enum is a literal subset of the SDK's
  // own EffortLevel, so options.effort mirrors spec.effort verbatim, alongside options.model.
  it("maps options.effort alongside options.model; omits the key entirely when unset", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    const backend = new ClaudeAgentBackend({ queryFn: fn });
    backend.spawn(spec({ effort: "xhigh" }), () => {}, async () => true);
    backend.spawn(spec(), () => {}, async () => true);   // no effort set
    await settle();
    expect(calls[0]!.options.effort).toBe("xhigh");
    expect("effort" in calls[1]!.options).toBe(false);   // byte-identical-when-unset, matches model's own contract
  });

  it("stamps spec.effort onto the agent_started event (spec-sourced, not SDK-echoed)", async () => {
    const { fn } = fakeQuery(SCRIPT);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ effort: "medium" }), (e) => evs.push(e), async () => true);
    await settle();
    const started = evs.find((e) => e.kind === "agent_started")!;
    expect(started.data["effort"]).toBe("medium");
  });

  // COMPACTION-THRESHOLD-CONFIG (the claude-SDK finding): Options.settings.autoCompactWindow
  // is the real, SDK-validated knob (sdk.mjs's own zod: min 1e5/max 1e6) — wired only when a
  // threshold is configured, and omitted entirely when unset (native/byte-identical).
  it("omits settings entirely when no compactionThreshold is configured (native default)", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
    await settle();
    expect("settings" in calls[0]!.options).toBe(false);
  });

  it("sets settings.autoCompactWindow/autoCompactEnabled from a configured threshold within the SDK's valid range", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn({ ...spec(), compactionThreshold: 150_000 }, () => {}, async () => true);
    await settle();
    expect(calls[0]!.options.settings).toEqual({ autoCompactEnabled: true, autoCompactWindow: 150_000 });
  });

  it("clamps a configured threshold below the SDK's 100k floor and emits a status event reporting the clamp", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn({ ...spec(), compactionThreshold: 20_000 }, (e) => evs.push(e), async () => true);
    await settle();
    expect(calls[0]!.options.settings).toEqual({ autoCompactEnabled: true, autoCompactWindow: 100_000 });
    const clampEvent = evs.find((e) => e.kind === "status" && "compactionThresholdClamped" in e.data);
    expect(clampEvent?.data).toEqual({ compactionThresholdClamped: { requested: 20_000, applied: 100_000, min: 100_000, max: 1_000_000 } });
  });

  // SOFT-TURN-LIMIT: two turns' worth of "result" messages (each is one turn
  // boundary in the SDK stream), so a maxTurns:2 spec sits exactly at the
  // boundary on the second one.
  const TWO_TURN_SCRIPT: Msg[] = [
    { type: "system", subtype: "init", session_id: "s1", model: "m1" },
    { type: "result", subtype: "success", result: "turn1", total_cost_usd: 0.1 },
    { type: "result", subtype: "success", result: "turn2", total_cost_usd: 0.2 },
    { type: "result", subtype: "success", result: "turn3", total_cost_usd: 0.3 },
  ];

  it("default turnLimitPolicy ('fail'): passes spec.maxTurns straight through, no budget status ever fires", async () => {
    const { fn, calls } = fakeQuery(TWO_TURN_SCRIPT);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ maxTurns: 2 }), (e) => evs.push(e), async () => true);
    await settle();
    expect(calls[0]!.options.maxTurns).toBe(2);   // byte-identical to pre-feature behavior
    expect(evs.some((e) => e.kind === "status" && e.data["turnBudgetExceeded"] === true)).toBe(false);
  });

  it("turnLimitPolicy:'soft' hands the SDK an effectively-unbounded maxTurns, not the nominal budget", async () => {
    const { fn, calls } = fakeQuery(TWO_TURN_SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ maxTurns: 2, turnLimitPolicy: "soft" }), () => {}, async () => true);
    await settle();
    expect(calls[0]!.options.maxTurns).toBeGreaterThan(2);
  });

  it("turnLimitPolicy:'soft' emits a turnBudgetExceeded status exactly once, at the boundary, and never fails/kills the agent", async () => {
    const { fn } = fakeQuery(TWO_TURN_SCRIPT);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ maxTurns: 2, turnLimitPolicy: "soft" }), (e) => evs.push(e), async () => true);
    await settle();
    const budgetEvents = evs.filter((e) => e.kind === "status" && e.data["turnBudgetExceeded"] === true);
    expect(budgetEvents).toHaveLength(1);                      // fires once, not once per turn past the boundary
    expect(budgetEvents[0]!.data).toEqual({ turnBudgetExceeded: true, turnsCompleted: 2, turnBudget: 2 });
    expect(evs.some((e) => e.kind === "error")).toBe(false);    // soft policy: crossing the budget is never a failure
    // The stream still runs to its natural (queue-empty) completion — a real "result" event
    // lands last, exactly as a "fail"-policy run under its cap would.
    expect(evs.at(-1)!.kind).toBe("result");
    expect(evs.at(-1)!.data).toEqual({ text: "turn3", costUsd: 0.3, model: "m1" });
  });

  it("forwards a non-null resume sessionId to the SDK options (RS1)", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ resume: "sess-123" }), () => {}, async () => true);
    await settle();
    expect(calls[0]!.options.resume).toBe("sess-123");
  });

  it("omits resume from SDK options when null (default) — no regression in spawn/stream", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(calls[0]!.options.resume).toBeUndefined();
    expect("resume" in calls[0]!.options).toBe(false);
    expect(evs.map((e) => e.kind)).toEqual([
      "agent_started", "message_complete", "tool_call", "tool_result", "turn_complete", "result",
    ]);
  });

  it("a non-resumeOnly spawn's input stream yields the prompt message first (no regression, CR1)", async () => {
    const { fn, calls } = parkedQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
    const iter = calls[0]!.prompt[Symbol.asyncIterator]();
    const first = await nextOrTimeout(iter, 30);
    expect(first).not.toBe("TIMEOUT");
    expect((first as { message: { content: Array<{ text?: string }> } }).message.content[0]?.text).toBe("task");
  });

  it("a resumeOnly:true spawn's input stream yields NOTHING initially, then the send() text (CR1)", async () => {
    const { fn, calls } = parkedQuery();
    const handle = new ClaudeAgentBackend({ queryFn: fn })
      .spawn(spec({ resumeOnly: true, resume: "sess-1" }), () => {}, async () => true);
    // Draining via a single iter.next() would leave a dangling waiter if it times out (the
    // eventual push resolves THAT promise, not a later one) — so assert emptiness on the queue
    // itself, per the brief's documented fallback, instead of racing a fresh iterator twice.
    const queue = calls[0]!.prompt as unknown as { isEmpty(): boolean };
    expect(queue.isEmpty()).toBe(true);                  // nothing pushed: resumed session idles, waiting for the first send
    await handle.send("hi");
    expect(queue.isEmpty()).toBe(false);
    const afterSend = await nextOrTimeout(calls[0]!.prompt[Symbol.asyncIterator](), 30);
    expect(afterSend).not.toBe("TIMEOUT");
    expect((afterSend as { message: { content: Array<{ text?: string }> } }).message.content[0]?.text).toBe("hi");
  });

  it("resumeOnly defaults false — a resume without resumeOnly still pushes the initial prompt (no regression, CR1)", async () => {
    const { fn, calls } = parkedQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ resume: "sess-1" }), () => {}, async () => true);
    const iter = calls[0]!.prompt[Symbol.asyncIterator]();
    const first = await nextOrTimeout(iter, 30);
    expect(first).not.toBe("TIMEOUT");
  });

  it("strips the parent's competing auth vars when spec.env injects a credential", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "parent-key");        // would OUTRANK the injected token in CLI auth precedence
    try {
      const { fn, calls } = fakeQuery(SCRIPT);
      new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
      await settle();
      const env = calls[0]!.options.env as Record<string, string | undefined>;
      expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("tok-x");  // injected per-account credential wins
      expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();   // parent auth var stripped, not inherited
      expect(env["PATH"]).toBe(process.env["PATH"]);      // non-auth env still inherited (Options.env replaces everything)
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("pins ToolSearch and strips env values that would disable schema deferral", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example.invalid");
    vi.stubEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "1");
    vi.stubEnv("ENABLE_TOOL_SEARCH", "0");
    try {
      const { fn, calls } = fakeQuery(SCRIPT);
      const base = spec();
      const poisoned = {
        ...base,
        env: {
          ...base.env,
          ANTHROPIC_BASE_URL: "https://spec-proxy.example.invalid",
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "true",
          ENABLE_TOOL_SEARCH: "0",
        },
      } as ResolvedAgentSpec;
      new ClaudeAgentBackend({ queryFn: fn }).spawn(poisoned, () => {}, async () => true);
      await settle();
      const env = calls[0]!.options.env as Record<string, string | undefined>;
      expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
      expect(env["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"]).toBeUndefined();
      expect(env["ENABLE_TOOL_SEARCH"]).toBe("1");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails before querying when providerOptions overrides the deferral env pin", () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    expect(() => new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({ providerOptions: { env: { ANTHROPIC_BASE_URL: "https://proxy.example.invalid" } } }),
      () => {},
      async () => true,
    )).toThrow(/Claude tool-schema deferral is inactive/);
    expect(calls).toHaveLength(0);
  });

  // OAUTH-TOKEN-ACCOUNTS: a keychain account classified oauthToken injects
  // CLAUDE_CODE_OAUTH_TOKEN (not ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY) —
  // CredentialResolver's envVar comes straight from auth.injectAs (credentials.ts),
  // and AUTH_VARS already lists CLAUDE_CODE_OAUTH_TOKEN, so the SAME strip-competing-
  // vars mechanism the test above exercises for ANTHROPIC_AUTH_TOKEN must also fire
  // for this env var with no separate code path.
  it("injects CLAUDE_CODE_OAUTH_TOKEN and strips competing auth vars for an oauth-token account", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "parent-key");         // would OUTRANK the injected oauth token in CLI auth precedence
    try {
      const { fn, calls } = fakeQuery(SCRIPT);
      const oauthSpec = {
        ...spec(),
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xyz", CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" },
      } as ResolvedAgentSpec;
      new ClaudeAgentBackend({ queryFn: fn }).spawn(oauthSpec, () => {}, async () => true);
      await settle();
      const env = calls[0]!.options.env as Record<string, string | undefined>;
      expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-ant-oat01-xyz");   // injected per-account credential wins
      expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();                 // parent auth var stripped, not inherited
      expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();               // no such var was ever set — regression guard
      expect(env["PATH"]).toBe(process.env["PATH"]);                    // non-auth env still inherited
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("inherits the parent's auth var when spec.env injects no credential (no isolation needed)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "parent-key");
    try {
      const { fn, calls } = fakeQuery(SCRIPT);
      // a spec whose env carries NO auth var (a subscription/main account) → the
      // AUTH_VARS.some(...) guard is false → the inherited parent auth var is NOT stripped.
      const noAuthSpec = { ...spec(), env: { CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" } } as ResolvedAgentSpec;
      new ClaudeAgentBackend({ queryFn: fn }).spawn(noAuthSpec, () => {}, async () => true);
      await settle();
      const env = calls[0]!.options.env as Record<string, string | undefined>;
      expect(env["ANTHROPIC_API_KEY"]).toBe("parent-key");   // nothing to isolate → parent auth survives
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("bridges canUseTool to the permission decider (non-bypass: default/acceptEdits keep canUseTool, no hook)", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    const decide = vi.fn(async ({ toolName }: { toolName: string }) => toolName === "Edit");
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, decide as never);
    await settle();
    const canUseTool = calls[0]!.options.canUseTool as (t: string, i: unknown) => Promise<{ behavior: string }>;
    expect((await canUseTool("Edit", {})).behavior).toBe("allow");
    expect((await canUseTool("Bash", {})).behavior).toBe("deny");
    expect(decide).toHaveBeenCalledTimes(2);
    // Non-bypass path must NOT wire a PreToolUse hook (that would double-gate a mode whose
    // canUseTool is consulted natively).
    expect("hooks" in calls[0]!.options).toBe(false);
    expect("allowDangerouslySkipPermissions" in calls[0]!.options).toBe(false);
  });

  // MCP-FOREIGN-POLICY: a foreign (non-chimera) MCP tool is bridged through decidePermission
  // like any other tool — claude.ts has NO local MCP short-circuit, so the allow/deny verdict is
  // whatever decidePermission (the toolPolicy gate) returns. This is what keeps the claude and
  // generic backends in lockstep: both defer the foreign-MCP decision entirely to the supervisor.
  it("foreign MCP tools route through decidePermission (no local gate) — allow/deny follow the decider verbatim", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    const decide = vi.fn(async ({ toolName }: { toolName: string }) => toolName === "mcp__ekb__search");
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ permissionProfile: "acceptEdits" }), () => {}, decide as never);
    await settle();
    const canUseTool = calls[0]!.options.canUseTool as (t: string, i: unknown) => Promise<{ behavior: string; message?: string }>;
    expect((await canUseTool("mcp__ekb__search", {})).behavior).toBe("allow");
    const denied = await canUseTool("mcp__plugin_atlassian_atlassian__getJiraIssue", {});
    expect(denied.behavior).toBe("deny");
    expect(denied.message).toBe("denied by chimera permission policy");
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ toolName: "mcp__ekb__search" }));
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ toolName: "mcp__plugin_atlassian_atlassian__getJiraIssue" }));
  });

  // CAN_USE_TOOL_SHADOWED / toolPolicy-shadow FIX: bypassPermissions (profile "full") SHADOWS
  // canUseTool, so the daemon's toolPolicy gate must run from a PreToolUse hook instead. This
  // asserts the hook gates IDENTICALLY to canUseTool (deny a policy-denied tool, allow others),
  // that canUseTool is NOT passed (killing the CLAUDE_SDK_CAN_USE_TOOL_SHADOWED trigger), and
  // that allowDangerouslySkipPermissions:true is set (the SDK requires it for bypass).
  it("full/bypass profile: gates via a PreToolUse hook, drops canUseTool, sets allowDangerouslySkipPermissions", async () => {
    const warnings: string[] = [];
    const onWarn = (w: Error & { code?: string }) => { if (w.code) warnings.push(w.code); };
    process.on("warning", onWarn);
    try {
      const { fn, calls } = fakeQuery(SCRIPT);
      const decide = vi.fn(async ({ toolName }: { toolName: string }) => toolName === "Edit");
      new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ permissionProfile: "full" }), () => {}, decide as never);
      await settle();
      const o = calls[0]!.options;
      expect(o.permissionMode).toBe("bypassPermissions");
      expect(o.allowDangerouslySkipPermissions).toBe(true);
      // canUseTool must be ABSENT — passing it under bypassPermissions is exactly what triggers
      // the CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning; dropping it is the fix.
      expect("canUseTool" in o).toBe(false);
      // The PreToolUse hook is the live gate. Its callback maps decidePermission onto the SDK's
      // SyncHookJSONOutput { hookSpecificOutput: { permissionDecision } }.
      const hooks = o.hooks as { PreToolUse: Array<{ hooks: Array<(i: unknown) => Promise<Record<string, unknown>>> }> };
      const gate = hooks.PreToolUse[0]!.hooks[0]!;
      const allowed = await gate({ tool_name: "Edit", tool_input: { file: "a.ts" }, tool_use_id: "tu-1" });
      const denied = await gate({ tool_name: "Bash", tool_input: { command: "rm -rf /" }, tool_use_id: "tu-2" });
      expect((allowed.hookSpecificOutput as { permissionDecision: string }).permissionDecision).toBe("allow");
      expect((allowed.hookSpecificOutput as { updatedInput?: unknown }).updatedInput).toEqual({ file: "a.ts" });
      expect((denied.hookSpecificOutput as { permissionDecision: string }).permissionDecision).toBe("deny");
      expect((denied.hookSpecificOutput as { permissionDecisionReason?: string }).permissionDecisionReason)
        .toBe("denied by chimera permission policy");
      // decidePermission ran for BOTH tools even though the profile is full/bypass — proving the
      // toolPolicy gate is no longer dead in bypass mode.
      expect(decide).toHaveBeenCalledTimes(2);
      expect(warnings).not.toContain("CLAUDE_SDK_CAN_USE_TOOL_SHADOWED");
    } finally {
      process.off("warning", onWarn);
    }
  });

  it("uses the SDK-supplied toolUseID as the permission requestId, falling back to a uuid", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    const seen: string[] = [];
    const decide = vi.fn(async ({ requestId }: { requestId: string }) => { seen.push(requestId); return true; });
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, decide as never);
    await settle();
    const canUseTool = calls[0]!.options.canUseTool as (t: string, i: unknown, o?: { toolUseID?: string }) => Promise<{ behavior: string }>;
    await canUseTool("Edit", {}, { toolUseID: "tu-42" });   // SDK-supplied id is threaded through as the requestId
    await canUseTool("Edit", {});                            // no toolUseID → a generated uuid, never empty
    expect(seen[0]).toBe("tu-42");
    expect(seen[1]).toBeTruthy();
    expect(seen[1]).not.toBe("tu-42");
  });

  it("injects the chimera MCP grant when orchestration is allowed", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({ orchestration: { allow: true, maxDepth: 3 } }), () => {}, async () => true);
    await settle();
    const servers = calls[0]!.options.mcpServers as Record<string, { env?: Record<string, string> }>;
    expect(servers["chimera"]).toBeDefined();
    expect(servers["chimera"]!.env?.["CHIMERA_DEPTH"]).toBe("0");
    expect(servers["chimera"]!.env?.["CHIMERA_MAX_DEPTH"]).toBe("3");    // the granting spec's own limit
    expect(servers["chimera"]!.env?.["CHIMERA_HOME"]).toBeTruthy();      // resolved, never empty string
    expect(servers["chimera"]!.env?.["CHIMERA_AGENT_ID"]).toBe("ag-1");  // spec §17.4: ask_human reads this to know who is asking
  });

  // WORKER-TEAM-CONTEXT: supervisor.launch() stamps CHIMERA_TEAM onto spec.env for a scheduler
  // team spawn — this block used to hand-copy only AGENT_ID/DEPTH/MAX_DEPTH/HOME/TREE_ID into
  // the chimera-mcp subprocess's OWN env, silently dropping CHIMERA_TEAM, so a team worker's
  // my_team always saw {team:null} no matter what the daemon's AgentRecord said.
  it("forwards CHIMERA_TEAM into the chimera MCP subprocess env for a team spawn", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    const teamSpec = spec({ orchestration: { allow: true, maxDepth: 3 } });
    teamSpec.env = { ...teamSpec.env, CHIMERA_TEAM: "crew" };
    new ClaudeAgentBackend({ queryFn: fn }).spawn(teamSpec, () => {}, async () => true);
    await settle();
    const servers = calls[0]!.options.mcpServers as Record<string, { env?: Record<string, string> }>;
    expect(servers["chimera"]!.env?.["CHIMERA_TEAM"]).toBe("crew");
  });

  it("creates a git worktree for isolation and rejects non-repos", async () => {
    const repo = mkdtempSync(join(tmpdir(), "chimera-repo-"));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ cwd: repo, isolation: "worktree" }), () => {}, async () => true);
    await settle();
    expect(String(calls[0]!.options.cwd)).toContain(join(repo, ".chimera", "worktrees"));

    const notRepo = mkdtempSync(join(tmpdir(), "chimera-norepo-"));
    expect(() => new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ cwd: notRepo, isolation: "worktree" }), () => {}, async () => true))
      .toThrow(GuardrailError);
  });

  it("reuses an existing worktree on a second spawn of the same agentId (failover retry safety)", async () => {
    // A rate-limit failover re-invokes spawn() with the SAME agentId; a second
    // `git worktree add` on the same path would throw and turn failover into a hard
    // "failed". ensureWorkdir must reuse the existing worktree, not re-add it.
    const repo = mkdtempSync(join(tmpdir(), "chimera-repo-reuse-"));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
    const { fn, calls } = fakeQuery(SCRIPT);
    const backend = new ClaudeAgentBackend({ queryFn: fn });
    const s = spec({ cwd: repo, isolation: "worktree" });
    backend.spawn(s, () => {}, async () => true);                                   // first attempt creates the worktree
    expect(() => backend.spawn(s, () => {}, async () => true)).not.toThrow();       // retry must NOT collide
    await settle();
    expect(String(calls[1]!.options.cwd)).toBe(String(calls[0]!.options.cwd));      // same worktree reused
  });

  // TOKEN-OPT-P4: the SDK's "result" message carries a `usage` object (input_tokens,
  // output_tokens, cache_read_input_tokens, cache_creation_input_tokens) — forwarded
  // verbatim on the final sink "result" event so usage.ts can extract the cache split.
  it("forwards the SDK result message's usage object verbatim on the final result event", async () => {
    const SCRIPT_WITH_USAGE: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      {
        type: "result", subtype: "success", result: "final answer", total_cost_usd: 0.42,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 9500, cache_creation_input_tokens: 300 },
      },
    ];
    const { fn } = fakeQuery(SCRIPT_WITH_USAGE);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    // TOKEN-OPT-P0-1: no stream_event message_start here, so liveUsage is never set and
    // contextUsage falls back to the same cumulative `usage` billableUsage carries — both
    // scopes agree numerically in this no-streaming scenario.
    const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 9500, cache_creation_input_tokens: 300 };
    expect(evs.at(-1)!.data).toEqual({
      text: "final answer", costUsd: 0.42, model: "m1",
      billableUsage: usage, contextUsage: usage,
    });
  });

  it("omits usage from the final result event when the SDK never sent one (no regression)", async () => {
    const { fn } = fakeQuery(SCRIPT);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect("billableUsage" in evs.at(-1)!.data).toBe(false);
    expect("contextUsage" in evs.at(-1)!.data).toBe(false);
  });

  // W2-1 STRUCTURED-RETURNS
  it("wires resultSchema to the SDK's outputFormat and surfaces structured_output on the result event", async () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
    const SCRIPT_STRUCTURED: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      { type: "result", subtype: "success", result: "final answer", total_cost_usd: 0.1, structured_output: { verdict: "ok" } },
    ];
    const { fn, calls } = fakeQuery(SCRIPT_STRUCTURED);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ resultSchema: schema }), (e) => evs.push(e), async () => true);
    await settle();
    expect(calls[0]!.options["outputFormat"]).toEqual({ type: "json_schema", schema });
    expect(evs.at(-1)).toMatchObject({
      kind: "result",
      data: { text: JSON.stringify({ verdict: "ok" }), structuredOutput: { verdict: "ok" } },
    });
  });

  it("omits outputFormat when resultSchema is unset (no regression)", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
    await settle();
    expect("outputFormat" in calls[0]!.options).toBe(false);
  });

  it("surfaces exhausted structured-output retries as a terminal error, not a result", async () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const SCRIPT_RETRY_EXHAUSTED: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      { type: "result", subtype: "error_max_structured_output_retries", total_cost_usd: 0.1 },
    ];
    const { fn } = fakeQuery(SCRIPT_RETRY_EXHAUSTED);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ resultSchema: schema }), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.at(-1)!.kind).toBe("error");
    expect(evs.some((e) => e.kind === "result")).toBe(false);
  });

  it("emits error on stream failure", async () => {
    const fn = (() => ({
      async *[Symbol.asyncIterator]() { throw new Error("HTTP 429"); },
      interrupt: async () => {},
    })) as never;
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs[0]).toMatchObject({ kind: "error", data: { message: "HTTP 429" } });
  });
});

// ---------- additional coverage: branches/edges the brief's 7 examples don't exercise ----------

describe("ClaudeAgentBackend: additional branch/edge coverage", () => {
  it("does not inject the chimera MCP grant when orchestration.allow is false (default)", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
    await settle();
    const servers = calls[0]!.options.mcpServers as Record<string, unknown>;
    expect(servers["chimera"]).toBeUndefined();
    expect(servers).toEqual({});
  });

  it("passes caller-provided mcpServers through untouched when orchestration is not allowed", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({ mcpServers: { foo: { type: "stdio", command: "x" } } }), () => {}, async () => true);
    await settle();
    const servers = calls[0]!.options.mcpServers as Record<string, unknown>;
    expect(servers["foo"]).toEqual({ type: "stdio", command: "x" });
    expect(servers["chimera"]).toBeUndefined();
  });

  // LEAN-AGENT-MCPS: the whole point of the first-class strictMcpConfig field is that it must
  // NOT touch settingSources — skills/CLAUDE.md inheritance and MCP loading are governed by two
  // independent SDK options, so a spec can carry BOTH "load project/user skills" AND "MCP-lean".
  it("settingSources (skills) and strictMcpConfig (MCP allowlist) apply independently — the decoupling this feature exists for", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({
        inherit: { settingSources: ["project", "user"] },
        strictMcpConfig: true,
        mcpServers: { foo: { type: "stdio", command: "x" } },
        orchestration: { allow: true, maxDepth: 2 },
      }),
      () => {}, async () => true,
    );
    await settle();
    const o = calls[0]!.options;
    // Skills/CLAUDE.md inheritance is untouched by strictMcpConfig.
    expect(o.settingSources).toEqual(["project", "user"]);
    // Only the strict MCP allowlist (the explicit mcpServers dict) reaches the SDK.
    expect(o.strictMcpConfig).toBe(true);
    expect(Object.keys(o.mcpServers as object).sort()).toEqual(["chimera", "foo"]);
  });

  // ACCEPTANCE CRITERION 2: the chimera MCP server (the agent's own orchestration tools) must
  // never be droppable by strictMcpConfig, even when the spec's own allowlist is empty — an
  // agent that can't reach ask_human/memory/etc. is broken, not "lean."
  it("chimera is never dropped by strictMcpConfig, even with an empty allowlist", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({ strictMcpConfig: true, mcpServers: {}, orchestration: { allow: true, maxDepth: 2 } }),
      () => {}, async () => true,
    );
    await settle();
    const o = calls[0]!.options;
    expect(o.strictMcpConfig).toBe(true);
    expect(Object.keys(o.mcpServers as object)).toEqual(["chimera"]);
  });

  it("omits strictMcpConfig from SDK options by default (byte-identical to before this field existed)", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
    await settle();
    expect("strictMcpConfig" in calls[0]!.options).toBe(false);
  });

  it("forwards an explicit strictMcpConfig:false the same way (not just true)", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ strictMcpConfig: false }), () => {}, async () => true);
    await settle();
    expect(calls[0]!.options.strictMcpConfig).toBe(false);
  });

  // providerOptions is documented as "the final SDK escape hatch" (spread last) — it must still
  // win over the new first-class field for a caller that (unusually) sets both.
  it("providerOptions.strictMcpConfig still overrides the first-class spec.strictMcpConfig field", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({ strictMcpConfig: true, providerOptions: { strictMcpConfig: false } }),
      () => {}, async () => true,
    );
    await settle();
    expect(calls[0]!.options.strictMcpConfig).toBe(false);
  });

  it("passes options.plugins verbatim when the spec declares plugins, and omits the key otherwise (WS-E)", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    const backend = new ClaudeAgentBackend({ queryFn: fn });
    backend.spawn(spec(), () => {}, async () => true);   // no plugins (default []) → key omitted
    backend.spawn(
      spec({ plugins: [{ type: "local", path: "./p" }, { type: "local", path: "/abs", skipMcpDiscovery: true }] }),
      () => {}, async () => true,
    );
    await settle();
    expect("plugins" in calls[0]!.options).toBe(false);   // empty → omitted, not an empty []
    expect(calls[1]!.options.plugins).toEqual([
      { type: "local", path: "./p" },
      { type: "local", path: "/abs", skipMcpDiscovery: true },
    ]);
  });

  it("builds the systemPrompt preset always (excludeDynamicSections, for cross-spawn cache sharing — SAFE-1), with append only when instructions is set", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    const backend = new ClaudeAgentBackend({ queryFn: fn });
    backend.spawn(spec(), () => {}, async () => true);                             // no instructions
    backend.spawn(spec({ instructions: "be nice" }), () => {}, async () => true);   // instructions set
    await settle();
    expect(calls[0]!.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", excludeDynamicSections: true });
    expect(calls[1]!.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", excludeDynamicSections: true, append: "be nice" });
  });

  // SAFE-1 CACHE-PREFIX: orientation moved OFF the cacheable systemPrompt.append and onto the
  // first user turn (see claude.ts's orientationForPrompt) — these two tests now assert on the
  // first pushed message's leading text block instead of the append string.
  it("TOKEN-EFF-1: prepends a precomputed ORIENTATION block to the first user turn for worktree isolation, with the real branch/baseSha/mainRepo", async () => {
    const repo = mkdtempSync(join(tmpdir(), "chimera-orient-"));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
    const { fn, calls } = parkedQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({ cwd: repo, isolation: "worktree", instructions: "be nice" }), () => {}, async () => true,
    );
    expect((calls[0]!.options.systemPrompt as { append?: string }).append).toBe("be nice");
    const first = await nextOrTimeout(calls[0]!.prompt[Symbol.asyncIterator](), 30);
    expect(first).not.toBe("TIMEOUT");
    const orientation = (first as { message: { content: Array<{ text?: string }> } }).message.content[0]!.text!;
    const wt = join(repo, ".chimera", "worktrees", "ag-1");
    expect(orientation.startsWith("WORKSPACE (already set up")).toBe(true);
    expect(orientation).toContain(`- <worktree>: ${wt}`);
    expect(orientation).toContain(`- <branch>: chimera/ag-1 (from main ${sha.slice(0, 12)})`);
    expect(orientation).toContain(`- <main> checkout: ${repo}`);
    expect(orientation).toContain("don't use EnterWorktree/ExitWorktree");
    // Each path appears once; the land-on-main commands refer to them by name.
    expect(orientation).toContain("`git -C <main> merge --no-ff <branch>`");
    expect(orientation).toContain("`git -C <main> worktree remove --force <worktree>`");
    expect(orientation).toContain("`git -C <main> branch -D <branch>`");
    expect(orientation.split(wt).length - 1).toBe(1);
  });

  it("WF-7: prepends a SHARED-workspace ORIENTATION block to the first user turn when workdirKey is set, with no unconditional land-on-main", async () => {
    const repo = mkdtempSync(join(tmpdir(), "chimera-orient-shared-"));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim();
    const { fn, calls } = parkedQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({ cwd: repo, isolation: "worktree", instructions: "be nice", workdirKey: "task-t1" }), () => {}, async () => true,
    );
    expect((calls[0]!.options.systemPrompt as { append?: string }).append).toBe("be nice");
    const first = await nextOrTimeout(calls[0]!.prompt[Symbol.asyncIterator](), 30);
    expect(first).not.toBe("TIMEOUT");
    const orientation = (first as { message: { content: Array<{ text?: string }> } }).message.content[0]!.text!;
    const wt = join(repo, ".chimera", "worktrees", "task-t1");
    expect(orientation.startsWith("WORKSPACE (shared by every agent on this task")).toBe(true);
    expect(orientation).toContain(`- <worktree>: ${wt}`);
    expect(orientation).toContain(`- <branch>: chimera/task-t1 (from main ${sha.slice(0, 12)})`);
    expect(orientation).toContain("never discard work you didn't create");
    expect(orientation).toContain("don't use EnterWorktree/ExitWorktree");
    expect(orientation).toContain("Don't merge to main or remove this worktree/branch unless your instructions say so");
    expect(orientation).not.toContain("merge --no-ff");
  });

  it("does not prepend an ORIENTATION block for non-worktree isolation, even with instructions set", async () => {
    const { fn, calls } = parkedQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ instructions: "be nice" }), () => {}, async () => true);
    expect(calls[0]!.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", excludeDynamicSections: true, append: "be nice" });
    const first = await nextOrTimeout(calls[0]!.prompt[Symbol.asyncIterator](), 30);
    expect(first).not.toBe("TIMEOUT");
    expect((first as { message: { content: Array<{ text?: string }> } }).message.content).toHaveLength(1);
    expect((first as { message: { content: Array<{ text?: string }> } }).message.content[0]!.text).not.toContain("WORKSPACE (");
  });

  // SAFE-1 CACHE-PREFIX acceptance test: the Claude system block must be BYTE-IDENTICAL across
  // spawns whose per-agent facts (agentId, worktree path/branch/baseSha, mainRepo) differ — that
  // per-spawn variance used to ride systemPrompt.append via `orientation`, making every single
  // worktree spawn write its own ~12K prompt-cache entry instead of N agents sharing one. Two
  // DISTINCT repos + agentIds here stand in for "two different agent specs".
  it("SAFE-1 CACHE-PREFIX: systemPrompt is byte-identical across two spawns with different agentId/worktree/branch/repo", async () => {
    const repoA = mkdtempSync(join(tmpdir(), "chimera-cacheprefix-a-"));
    execFileSync("git", ["-C", repoA, "init", "-q"]);
    execFileSync("git", ["-C", repoA, "commit", "-q", "--allow-empty", "-m", "init"]);
    const repoB = mkdtempSync(join(tmpdir(), "chimera-cacheprefix-b-"));
    execFileSync("git", ["-C", repoB, "init", "-q"]);
    execFileSync("git", ["-C", repoB, "commit", "-q", "--allow-empty", "-m", "init"]);
    const { fn, calls } = parkedQuery();
    const backend = new ClaudeAgentBackend({ queryFn: fn });
    backend.spawn(
      { ...spec({ cwd: repoA, isolation: "worktree", instructions: "static header text" }), agentId: "agent-one" },
      () => {}, async () => true,
    );
    backend.spawn(
      { ...spec({ cwd: repoB, isolation: "worktree", instructions: "static header text" }), agentId: "agent-two" },
      () => {}, async () => true,
    );
    expect(calls.length).toBe(2);
    expect(calls[0]!.options.systemPrompt).toEqual(calls[1]!.options.systemPrompt);
    // sanity: the two spawns really WERE different underneath (different worktree paths) —
    // this proves the byte-identity above isn't a vacuous "nothing varied" pass.
    const firstA = await nextOrTimeout(calls[0]!.prompt[Symbol.asyncIterator](), 30);
    const firstB = await nextOrTimeout(calls[1]!.prompt[Symbol.asyncIterator](), 30);
    const textA = (firstA as { message: { content: Array<{ text?: string }> } }).message.content[0]!.text!;
    const textB = (firstB as { message: { content: Array<{ text?: string }> } }).message.content[0]!.text!;
    expect(textA).not.toBe(textB);
    expect(textA).toContain(repoA);
    expect(textB).toContain(repoB);
  });

  // AGENT-AUTONOMY acceptance: the instruction line rides the cached systemPrompt.append (safe
  // because it's a fixed two-valued setting, not a per-instance-unique fact like orientation —
  // see claude.ts's autonomyLine comment), the chimera-mcp grant forwards CHIMERA_AUTONOMY, and
  // two DIFFERENT full-autonomy agents still share one cache-prefix variant (mirrors the SAFE-1
  // test above, just for the "full" branch).
  describe("AGENT-AUTONOMY", () => {
    it("autonomy:\"full\" appends the one-line brief to systemPrompt and forwards CHIMERA_AUTONOMY=full on the chimera-mcp grant", async () => {
      const { fn, calls } = fakeQuery(SCRIPT);
      new ClaudeAgentBackend({ queryFn: fn }).spawn(
        spec({ autonomy: "full", orchestration: { allow: true, maxDepth: 2 } }),
        () => {}, async () => true,
      );
      await settle();
      const o = calls[0]!.options;
      expect((o.systemPrompt as { append?: string }).append).toContain(
        "AUTONOMY: no human is available to ask",
      );
      const mcpServers = o.mcpServers as Record<string, { env?: Record<string, string> }>;
      expect(mcpServers["chimera"]!.env!["CHIMERA_AUTONOMY"]).toBe("full");
    });

    it("default autonomy \"ask\" adds no autonomy line and forwards CHIMERA_AUTONOMY=\"\" — byte-identical to before this feature", async () => {
      const { fn, calls } = fakeQuery(SCRIPT);
      new ClaudeAgentBackend({ queryFn: fn }).spawn(
        spec({ orchestration: { allow: true, maxDepth: 2 } }),
        () => {}, async () => true,
      );
      await settle();
      const o = calls[0]!.options;
      const append = (o.systemPrompt as { append?: string }).append;
      expect(append ?? "").not.toContain("AUTONOMY:");
      const mcpServers = o.mcpServers as Record<string, { env?: Record<string, string> }>;
      expect(mcpServers["chimera"]!.env!["CHIMERA_AUTONOMY"]).toBe("");
    });

    it("two DIFFERENT full-autonomy agents (different agentId/worktree/repo) still get a byte-identical systemPrompt — autonomy is a stable two-valued cache variant, not a per-instance cache-buster", async () => {
      const repoA = mkdtempSync(join(tmpdir(), "chimera-autonomy-cacheprefix-a-"));
      execFileSync("git", ["-C", repoA, "init", "-q"]);
      execFileSync("git", ["-C", repoA, "commit", "-q", "--allow-empty", "-m", "init"]);
      const repoB = mkdtempSync(join(tmpdir(), "chimera-autonomy-cacheprefix-b-"));
      execFileSync("git", ["-C", repoB, "init", "-q"]);
      execFileSync("git", ["-C", repoB, "commit", "-q", "--allow-empty", "-m", "init"]);
      const { fn, calls } = parkedQuery();
      const backend = new ClaudeAgentBackend({ queryFn: fn });
      backend.spawn(
        { ...spec({ cwd: repoA, isolation: "worktree", autonomy: "full" }), agentId: "agent-one" },
        () => {}, async () => true,
      );
      backend.spawn(
        { ...spec({ cwd: repoB, isolation: "worktree", autonomy: "full" }), agentId: "agent-two" },
        () => {}, async () => true,
      );
      expect(calls.length).toBe(2);
      expect(calls[0]!.options.systemPrompt).toEqual(calls[1]!.options.systemPrompt);
    });
  });

  it("spreads providerOptions LAST, letting it override any computed option including permissionMode and cwd", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({ permissionProfile: "full", providerOptions: { permissionMode: "default", cwd: "/override", customFlag: true } }),
      () => {}, async () => true,
    );
    await settle();
    const o = calls[0]!.options;
    expect(o.permissionMode).toBe("default");     // overridden from the computed "bypassPermissions"
    expect(o.cwd).toBe("/override");              // overridden from the computed worktree/spec.cwd
    expect(o.customFlag).toBe(true);              // arbitrary escape-hatch key passes through
  });

  it("carries forward the prior cost/text when a later SDK result omits total_cost_usd or isn't subtype:success", async () => {
    const MULTI_RESULT: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      { type: "result", subtype: "success", result: "first", total_cost_usd: 0.1 },
      { type: "result", subtype: "partial" },   // no total_cost_usd, not "success"
    ];
    const { fn } = fakeQuery(MULTI_RESULT);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "turn_complete", "turn_complete", "result"]);
    expect(evs.at(-1)!.data).toEqual({ text: "first", costUsd: 0.1, model: "m1" });   // carried over, not clobbered
  });

  it("iterates every block in one assistant message and emits nothing for an empty content array", async () => {
    const MULTI_BLOCKS: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      { type: "assistant", message: { role: "assistant", content: [] } },
      { type: "assistant", message: { role: "assistant", content: [
        { type: "text", text: "a" },
        { type: "tool_use", name: "Read", input: { file: "x" } },
        { type: "text", text: "b" },
        { type: "tool_use", name: "Write", input: { file: "y" } },
      ] } },
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0 },
    ];
    const { fn } = fakeQuery(MULTI_BLOCKS);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual([
      "agent_started", "message_complete", "tool_call", "message_complete", "tool_call", "turn_complete", "result",
    ]);
  });

  it("interrupt() calls the SDK stream's interrupt() when present, and tolerates a stream with none", async () => {
    let interruptCalls = 0;
    const fn = (() => ({
      async *[Symbol.asyncIterator]() { for (const m of SCRIPT) yield m; },
      interrupt: async () => { interruptCalls++; },
    })) as never;
    const handle = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
    await handle.interrupt();
    expect(interruptCalls).toBe(1);

    const noInterruptFn = (() => ({
      async *[Symbol.asyncIterator]() { for (const m of SCRIPT) yield m; },
      // no `interrupt` property at all
    })) as never;
    const handle2 = new ClaudeAgentBackend({ queryFn: noInterruptFn }).spawn(spec(), () => {}, async () => true);
    await expect(handle2.interrupt()).resolves.toBeUndefined();
    await expect(handle2.kill()).resolves.toBeUndefined();
  });

  it("kill() mid-stream stops further event delivery and invokes the SDK stream's interrupt()", async () => {
    const interrupt = vi.fn(async () => {});
    const fn = (() => ({
      async *[Symbol.asyncIterator]() {
        for (const m of SCRIPT) {
          await new Promise((r) => setTimeout(r, 20));
          yield m;
        }
      },
      interrupt,
    })) as never;
    const evs: BackendEvent[] = [];
    const handle = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await new Promise((r) => setTimeout(r, 30));   // let only the first ("agent_started") message land
    await handle.kill();
    await new Promise((r) => setTimeout(r, 100));  // give the remaining SCRIPT messages time to (not) arrive
    expect(evs.map((e) => e.kind)).toEqual(["agent_started"]);
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  describe("R2-TURN-LIFECYCLE: idle/max-duration watchdog", () => {
    it("idle timeout on a parked stream emits turn_timeout and sinks no result", async () => {
      const { fn } = foreverParkedQuery();
      const evs: BackendEvent[] = [];
      new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ idleTimeoutMs: 20 }), (e) => evs.push(e), async () => true);
      await new Promise((r) => setTimeout(r, 60));
      expect(evs.map((e) => e.kind)).toContain("turn_timeout");
      const ev = evs.find((e) => e.kind === "turn_timeout")!;
      expect(ev.data).toMatchObject({ reason: "idle", idleTimeoutMs: 20 });
      expect(evs.some((e) => e.kind === "result")).toBe(false);
    });

    it("max-duration timeout fires even while the stream keeps emitting messages", async () => {
      const fn = (() => ({
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 200; i++) {
            await new Promise((r) => setTimeout(r, 2));
            yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `chunk${i}` }] } };
          }
        },
        interrupt: async () => {},
      })) as never;
      const evs: BackendEvent[] = [];
      new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ maxTurnDurationMs: 20 }), (e) => evs.push(e), async () => true);
      await new Promise((r) => setTimeout(r, 80));
      expect(evs.map((e) => e.kind)).toContain("turn_timeout");
      const ev = evs.find((e) => e.kind === "turn_timeout")!;
      expect(ev.data).toMatchObject({ reason: "max-duration", maxTurnDurationMs: 20 });
      expect(evs.some((e) => e.kind === "result")).toBe(false);
    });

    it("does NOT idle out while merely waiting between turns (conductor session, no watchdog re-arm on result)", async () => {
      // Regression guard for the bug this design deliberately avoids: arming the watchdog right
      // after turn_complete (instead of only when the NEXT send() actually happens) would treat
      // a conductor's legitimate "waiting for the next human message" gap as a hang.
      const fn = ((args: { prompt: AsyncIterable<unknown> }) => (async function* () {
        const it = args.prompt[Symbol.asyncIterator]();
        await it.next();
        yield { type: "system", subtype: "init", session_id: "s1", model: "m1" };
        yield { type: "result", subtype: "success", result: "turn1", total_cost_usd: 0.1 };
        await it.next();   // parks here until the test's send() below pushes the next prompt
        yield { type: "result", subtype: "success", result: "turn2", total_cost_usd: 0.1 };
      })()) as never;
      const evs: BackendEvent[] = [];
      const handle = new ClaudeAgentBackend({ queryFn: fn })
        .spawn(spec({ idleTimeoutMs: 20, conductor: true }), (e) => evs.push(e), async () => true);
      await settle();
      // Idle far longer than idleTimeoutMs WHILE WAITING FOR A SEND — must not time out.
      await new Promise((r) => setTimeout(r, 60));
      expect(evs.some((e) => e.kind === "turn_timeout")).toBe(false);
      await handle.send("go on");
      await settle();
      expect(evs.some((e) => e.kind === "turn_timeout")).toBe(false);
      expect(evs.filter((e) => e.kind === "turn_complete").length).toBe(2);
    });

    it("unset idleTimeoutMs/maxTurnDurationMs (default) leaves kill()/interrupt() byte-identical", async () => {
      const interrupt = vi.fn(async () => {});
      const fn = (() => ({
        async *[Symbol.asyncIterator]() {
          for (const m of SCRIPT) {
            await new Promise((r) => setTimeout(r, 20));
            yield m;
          }
        },
        interrupt,
      })) as never;
      const evs: BackendEvent[] = [];
      const handle = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
      await new Promise((r) => setTimeout(r, 30));
      await handle.kill();
      await new Promise((r) => setTimeout(r, 100));
      expect(evs.some((e) => e.kind === "turn_timeout")).toBe(false);
      expect(evs.map((e) => e.kind)).toEqual(["agent_started"]);
      expect(interrupt).toHaveBeenCalledTimes(1);
    });
  });

  it("closes the input queue after an idle result (one-shot close) when no send is pending", async () => {
    const fn = ((args: { prompt: AsyncIterable<unknown> }) => (async function* () {
      const it = args.prompt[Symbol.asyncIterator]();
      await it.next();                                              // consume the initial prompt message
      yield { type: "system", subtype: "init", session_id: "s1", model: "m1" };
      yield { type: "result", subtype: "success", result: "turn1", total_cost_usd: 0.1 };
      const second = await it.next();                                // queue must already be closed & empty
      if (!second.done) yield { type: "result", subtype: "success", result: "turn2", total_cost_usd: 0.2 };
    })()) as never;
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "turn_complete", "result"]);
    expect(evs.at(-1)!.data).toEqual({ text: "turn1", costUsd: 0.1, model: "m1" });
  });

  it("keeps the input queue open across a turn when send() lands before the SDK result closes it", async () => {
    const fn = ((args: { prompt: AsyncIterable<unknown> }) => (async function* () {
      const it = args.prompt[Symbol.asyncIterator]();
      await it.next();                                              // consume the initial prompt message
      yield { type: "system", subtype: "init", session_id: "s1", model: "m1" };
      yield { type: "result", subtype: "success", result: "turn1", total_cost_usd: 0.1 };
      const second = await it.next();                                // must see the queued send(), not done
      if (!second.done) yield { type: "result", subtype: "success", result: "turn2", total_cost_usd: 0.2 };
    })()) as never;
    const evs: BackendEvent[] = [];
    const handle = new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await handle.send("late");   // enqueued synchronously, before the fake stream starts consuming
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "turn_complete", "turn_complete", "result"]);
    expect(evs.at(-1)!.data).toEqual({ text: "turn2", costUsd: 0.2, model: "m1" });
  });

  // TOKEN-OPT-P4: the SDK's own prompt cache (owned by the Agent SDK via cache_control on
  // the "claude_code" systemPrompt preset) only pays off across turns if the appended
  // systemPrompt string and mcpServers config are BYTE-STABLE for the life of a spawn —
  // a per-turn rebuild (or reordering) shifts the cached prefix and silently busts the
  // ~90%-off saving. query() is called exactly ONCE per spawn (turns ride the same
  // AsyncQueue, never a fresh query() call) — this guards that structural invariant.
  it("PROMPT-CACHE: computes systemPrompt/mcpServers ONCE per spawn — never rebuilt or mutated across turns", async () => {
    const { fn, calls } = foreverParkedQuery();
    const handle = new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({
        instructions: "be nice",
        orchestration: { allow: true, maxDepth: 3 },
        mcpServers: { zeta: { type: "stdio", command: "z" }, alpha: { type: "stdio", command: "a" } },
      }),
      () => {}, async () => true,
    );
    const optionsRef = calls[0]!.options;
    const systemPromptSnapshot = JSON.stringify(optionsRef.systemPrompt);
    const mcpServersSnapshot = JSON.stringify(optionsRef.mcpServers);

    await handle.send("turn 2");
    await handle.send("turn 3");
    await handle.send("turn 4");

    expect(calls.length).toBe(1);                        // query() invoked once per spawn, not once per turn
    expect(calls[0]!.options).toBe(optionsRef);           // same options object — never reconstructed
    expect(JSON.stringify(calls[0]!.options.systemPrompt)).toBe(systemPromptSnapshot);
    expect(JSON.stringify(calls[0]!.options.mcpServers)).toBe(mcpServersSnapshot);
  });

  it("PROMPT-CACHE: mcpServers keys are canonically sorted, regardless of caller insertion order", async () => {
    const { fn, calls } = fakeQuery(SCRIPT);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({
        orchestration: { allow: true, maxDepth: 3 },
        mcpServers: { zeta: { type: "stdio", command: "z" }, alpha: { type: "stdio", command: "a" } },
      }),
      () => {}, async () => true,
    );
    await settle();
    // "chimera" (appended after the spread) still sorts alphabetically alongside caller-supplied
    // servers — so two spawns of an equivalent spec always hand the SDK identical key order,
    // even if the caller's own mcpServers object were ever built in a different iteration order.
    expect(Object.keys(calls[0]!.options.mcpServers as object)).toEqual(["alpha", "chimera", "zeta"]);
  });
});
