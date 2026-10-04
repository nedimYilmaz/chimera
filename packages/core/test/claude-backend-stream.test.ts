import { describe, it, expect } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";

type Msg = Record<string, unknown>;
function fakeQuery(messages: Msg[]) {
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const fn = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    return {
      async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
      interrupt: async () => {},
    };
  }) as never;
  return { fn, calls };
}
function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none", ...over }),
    agentId: "ag-1", accountName: "main", resolvedProvider: "claude",
    env: { CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

const STREAMY: Msg[] = [
  { type: "system", subtype: "init", session_id: "s1", model: "m1" },
  { type: "stream_event", session_id: "s1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "par" } } },
  { type: "stream_event", session_id: "s1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "tial" } } },
  { type: "stream_event", session_id: "s1", event: { type: "message_stop" } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } },
  { type: "result", subtype: "success", result: "partial", total_cost_usd: 0.05 },
];

describe("ClaudeAgentBackend partial-message streaming", () => {
  it("passes includePartialMessages to the SDK", async () => {
    const { fn, calls } = fakeQuery(STREAMY);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
    await settle();
    expect(calls[0]!.options.includePartialMessages).toBe(true);
  });

  it("normalizes text_delta stream events to message_delta and ignores other stream events", async () => {
    const { fn } = fakeQuery(STREAMY);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual([
      "agent_started", "message_delta", "message_delta", "message_complete", "turn_complete", "result",
    ]);
    expect(evs[1]!.data).toEqual({ text: "par" });
    expect(evs[2]!.data).toEqual({ text: "tial" });
  });

  it("lets providerOptions override includePartialMessages", async () => {
    const { fn, calls } = fakeQuery(STREAMY);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({ providerOptions: { includePartialMessages: false } }), () => {}, async () => true);
    await settle();
    expect(calls[0]!.options.includePartialMessages).toBe(false);
  });
});

// ---------- additional coverage: every branch/edge in the new stream_event handling ----------

describe("ClaudeAgentBackend: stream_event branch/edge coverage", () => {
  it("does not override includePartialMessages when providerOptions omits it (stays true by default)", async () => {
    const { fn, calls } = fakeQuery(STREAMY);
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ providerOptions: { customFlag: 1 } }), () => {}, async () => true);
    await settle();
    expect(calls[0]!.options.includePartialMessages).toBe(true);
    expect(calls[0]!.options.customFlag).toBe(1);
  });

  it("ignores stream_event messages with no event payload at all", async () => {
    const NO_EVENT: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      { type: "stream_event", session_id: "s1" },   // no `event` key -> ev is undefined
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0 },
    ];
    const { fn } = fakeQuery(NO_EVENT);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "turn_complete", "result"]);
  });

  it("ignores non-content_block_delta stream events (message_start, message_stop)", async () => {
    const OTHER_EVENTS: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      { type: "stream_event", event: { type: "message_start" } },
      { type: "stream_event", event: { type: "message_stop" } },
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0 },
    ];
    const { fn } = fakeQuery(OTHER_EVENTS);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "turn_complete", "result"]);
  });

  it("ignores content_block_delta stream events with no delta at all", async () => {
    const NO_DELTA: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      { type: "stream_event", event: { type: "content_block_delta", index: 0 } },   // no `delta` key
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0 },
    ];
    const { fn } = fakeQuery(NO_DELTA);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "turn_complete", "result"]);
  });

  it("ignores content_block_delta stream events whose delta is input_json_delta (tool-call partial input)", async () => {
    const TOOL_DELTA: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"a\":" } } },
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0 },
    ];
    const { fn } = fakeQuery(TOOL_DELTA);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "turn_complete", "result"]);
  });

  it("ignores text_delta stream events whose text is missing or not a string (malformed payload)", async () => {
    const BAD_TEXT: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: 42 } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta" } } },   // text key absent
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0 },
    ];
    const { fn } = fakeQuery(BAD_TEXT);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "turn_complete", "result"]);
  });

  it("carries the raw stream_event message through on the emitted message_delta event", async () => {
    const ONE_DELTA: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } },
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0 },
    ];
    const { fn } = fakeQuery(ONE_DELTA);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs[1]!.kind).toBe("message_delta");
    expect(evs[1]!.raw).toEqual(ONE_DELTA[1]);
  });
});

// ---------- LIVE-CTX-USAGE: message_start/message_delta usage streaming + turn_complete usage ----------

describe("ClaudeAgentBackend: live usage streaming", () => {
  it("emits a usage event off message_start's input/cache tokens, then another merging message_delta's cumulative output_tokens", async () => {
    const LIVE: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      {
        type: "stream_event",
        event: { type: "message_start", message: { usage: { input_tokens: 5000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } },
      },
      { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 12 } } },
      { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 30 } } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
      { type: "result", subtype: "success", result: "hi", total_cost_usd: 0.01, usage: { input_tokens: 5000, output_tokens: 30, cache_read_input_tokens: 1000 } },
    ];
    const { fn } = fakeQuery(LIVE);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    const usageEvents = evs.filter((e) => e.kind === "usage");
    expect(usageEvents.map((e) => e.data)).toEqual([
      { usage: { input_tokens: 5000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } },
      { usage: { input_tokens: 5000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 12 } },
      { usage: { input_tokens: 5000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 30 } },
    ]);
    // CTX-BASIS-PERTURN: turn_complete carries the PER-TURN usage (liveUsage — this turn's
    // message_start prompt merged with message_delta's output), NOT the SDK "result" message's
    // CUMULATIVE session usage. Here they agree numerically; liveUsage additionally carries the
    // cache_creation_input_tokens:0 that message_start established (the result msg omitted it).
    // LEDGER-UNCLEAN-EXIT: billableUsage additionally carries the CUMULATIVE session `usage` this
    // SDK "result" message reported verbatim — the figure supervisor.ts stashes so a run killed
    // before its terminal result can still flush an authoritative cost to the ledger.
    const turnComplete = evs.find((e) => e.kind === "turn_complete")!;
    expect(turnComplete.data).toEqual({
      turnCostUsd: 0.01,
      usage: { input_tokens: 5000, output_tokens: 30, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
      billableUsage: { input_tokens: 5000, output_tokens: 30, cache_read_input_tokens: 1000 },
    });
  });

  it("CTX-BASIS-PERTURN: turn_complete/result forward the PER-TURN prompt, NOT the SDK's cumulative session usage", async () => {
    // The bug: the SDK "result" message's usage is CUMULATIVE for the whole session, so on a
    // long-running conductor cache_read_input_tokens balloons to millions (the observed
    // "3.8M/200k → pinned 100%" ctx meter). The current turn's real context is the message_start
    // prompt (input+cache = 200k here, ≤ the window). Forwarding the cumulative figure would make
    // the ctx meter read ~19x past the window; the fix forwards liveUsage (the per-turn baseline).
    const LIVE: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      {
        type: "stream_event",
        event: { type: "message_start", message: { usage: { input_tokens: 20_000, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 0 } } },
      },
      { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 40 } } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      // CUMULATIVE session totals — cache_read summed over every prior turn, far past the window:
      { type: "result", subtype: "success", result: "ok", total_cost_usd: 2.5, usage: { input_tokens: 500_000, output_tokens: 40, cache_read_input_tokens: 3_750_000 } },
    ];
    const { fn } = fakeQuery(LIVE);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    const perTurn = { input_tokens: 20_000, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 0, output_tokens: 40 };
    const turnComplete = evs.find((e) => e.kind === "turn_complete")!;
    expect(turnComplete.data["usage"]).toEqual(perTurn);       // NOT the 3.75M cumulative cache_read
    const result = evs.find((e) => e.kind === "result")!;
    // TOKEN-OPT-P0-1: result now carries BOTH scopes explicitly — contextUsage stays per-turn
    // (mirrors codex.ts's lastTurnUsage), billableUsage is the SDK's cumulative session usage
    // (the SAME totals costUsd was computed over) — never conflated into one field again.
    expect(result.data["contextUsage"]).toEqual(perTurn);
    expect(result.data["billableUsage"]).toEqual({ input_tokens: 500_000, output_tokens: 40, cache_read_input_tokens: 3_750_000 });
    // fullContext (input+cacheRead+cacheCreation) = exactly the 200k window, not 4.27M.
    const u = turnComplete.data["usage"] as { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
    expect(u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens).toBe(200_000);
  });

  it("ignores a message_delta's usage before any message_start has established a baseline", async () => {
    const NO_BASELINE: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 12 } } },
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0 },
    ];
    const { fn } = fakeQuery(NO_BASELINE);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "turn_complete", "result"]);
  });
});

// ---------- R2 (ctx meter, post-compaction): SDKCompactBoundaryMessage handling ----------

describe("ClaudeAgentBackend: compact_boundary (post-compaction ctx drop)", () => {
  it("a compact_boundary with post_tokens sinks a compaction event AND immediately resets the live ctx baseline (drops before the next turn even starts)", async () => {
    const COMPACTED: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      {
        type: "stream_event",
        event: { type: "message_start", message: { usage: { input_tokens: 150_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "turn 1" }] } },
      { type: "result", subtype: "success", result: "turn 1", total_cost_usd: 0.01 },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 195_000, post_tokens: 20_000 } },
    ];
    const { fn } = fakeQuery(COMPACTED);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();

    const compaction = evs.find((e) => e.kind === "compaction");
    // F39 L1-MEASURE: deliberately still toEqual on the WHOLE object, not toMatchObject — the
    // next field added to this event must fail here and be reviewed, not escape silently.
    expect(compaction?.data).toEqual({
      trigger: "budget", owner: "sdk", thresholdInForce: null, thresholdSource: "native",
      model: "m1", provider: "claude",
      before: { tokens: 195_000 }, after: { tokens: 20_000 },
    });

    // the LAST usage event (sunk by compact_boundary, after the turn's own message_start usage)
    // is the smaller post-compaction figure — the meter must reflect this drop immediately.
    const usageEvents = evs.filter((e) => e.kind === "usage");
    const first = usageEvents[0]!.data["usage"] as { input_tokens: number };
    const last = usageEvents.at(-1)!.data["usage"] as { input_tokens: number };
    expect(first.input_tokens).toBe(150_000);
    expect(last.input_tokens).toBe(20_000);
    expect(last.input_tokens).toBeLessThan(first.input_tokens);
  });

  it("a compact_boundary with no post_tokens still reports the compaction, but leaves the ctx baseline for the next real message_start (no fabricated number)", async () => {
    const NO_POST_TOKENS: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      {
        type: "stream_event",
        event: { type: "message_start", message: { usage: { input_tokens: 150_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "turn 1" }] } },
      { type: "result", subtype: "success", result: "turn 1", total_cost_usd: 0.01 },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } },   // no post_tokens
    ];
    const { fn } = fakeQuery(NO_POST_TOKENS);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();

    const compaction = evs.find((e) => e.kind === "compaction");
    expect(compaction?.data).toEqual({
      trigger: "manual", owner: "sdk", thresholdInForce: null, thresholdSource: "native",
      model: "m1", provider: "claude",
    });
    // exactly ONE usage event (from message_start) — compact_boundary did not fabricate a second.
    expect(evs.filter((e) => e.kind === "usage")).toHaveLength(1);
  });

  it("a subsequent turn's message_start after compaction reports the smaller (already-compacted) context, proving no chimera-side clamping/staleness", async () => {
    const TWO_TURNS: Msg[] = [
      { type: "system", subtype: "init", session_id: "s1", model: "m1" },
      { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 150_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "turn 1" }] } },
      { type: "result", subtype: "success", result: "turn 1", total_cost_usd: 0.01 },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", post_tokens: 20_000 } },
      { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 21_500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "turn 2" }] } },
      { type: "result", subtype: "success", result: "turn 2", total_cost_usd: 0.01 },
    ];
    const { fn } = fakeQuery(TWO_TURNS);
    const evs: BackendEvent[] = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e), async () => true);
    await settle();

    const usageEvents = evs.filter((e) => e.kind === "usage");
    const values = usageEvents.map((e) => (e.data["usage"] as { input_tokens: number }).input_tokens);
    // 150k (turn 1) -> 20k (compact_boundary's immediate reset) -> 21.5k (turn 2's real message_start)
    // — every step stays near the compacted floor, never snapping back to the pre-compaction 150k.
    expect(values).toEqual([150_000, 20_000, 21_500]);
  });
});
