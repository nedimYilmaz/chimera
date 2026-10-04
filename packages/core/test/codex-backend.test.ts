import { describe, it, expect, vi } from "vitest";
import {
  CodexAgentBackend, normalizeCodexEvent, buildCodexOptions, buildThreadOptions,
  type CodexFactory, type CodexThreadEvent,
} from "@chimera/core/backends/codex";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";
import { chimeraHome } from "@chimera/core/paths";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardrailError } from "@chimera/core/supervisor";
import { computeCostUsd } from "@chimera/protocol";
import { fakeCodex, cxSpec, settle } from "./codex-backend-helpers.js";

// CORE-SUITE-BASELINE: this file's worktree-isolation tests shell out to real `git` —
// under this machine's concurrent-agent load a subprocess spawn can exceed vitest's
// 5000ms default; widened per existing precedent (supervisor-crash-loop.test.ts).
vi.setConfig({ testTimeout: 20_000 });

const TURN_OK: CodexThreadEvent[] = [
  { type: "thread.started", thread_id: "th-1" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "i0", type: "reasoning", text: "planning" } },
  { type: "item.updated", item: { id: "i1", type: "agent_message", text: "working…" } },
  { type: "item.started", item: { id: "i2", type: "command_execution", command: "pnpm test", aggregated_output: "", status: "in_progress" } },
  { type: "item.completed", item: { id: "i2", type: "command_execution", command: "pnpm test", aggregated_output: "all green", exit_code: 0, status: "completed" } },
  { type: "item.completed", item: { id: "i3", type: "file_change", changes: [{ path: "a.ts", kind: "update" }], status: "completed" } },
  { type: "item.completed", item: { id: "i4", type: "agent_message", text: "tests pass" } },
  { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 5 } },
];

describe("CodexAgentBackend normalization", () => {
  it("stamps agent_started's data.model from spec.model when the spawn pinned one", async () => {
    const { factory } = fakeCodex([[{ type: "thread.started", thread_id: "th-1" }]]);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ model: "gpt-5.5" }), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs[0]!.data).toEqual({ threadId: "th-1", sessionId: "th-1", model: "gpt-5.5", codexTransport: "exec", nativeApprovals: false, nativeDialogs: false, supportsSteer: false });
  });

  // R2 EFFORT: spec-sourced (no live echo from the SDK, same story as model).
  it("stamps agent_started's data.effort from spec.effort when the spawn set one", async () => {
    const { factory } = fakeCodex([[{ type: "thread.started", thread_id: "th-1" }]]);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ model: "gpt-5.5", effort: "xhigh" }), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs[0]!.data).toEqual({ threadId: "th-1", sessionId: "th-1", model: "gpt-5.5", effort: "xhigh", codexTransport: "exec", nativeApprovals: false, nativeDialogs: false, supportsSteer: false });
  });

  it("normalizes a full turn and emits result with token usage and a real computed cost", async () => {
    const { factory } = fakeCodex([TURN_OK]);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual([
      "agent_started", "status", "message_delta", "message_delta", "tool_call", "tool_result",
      "tool_call", "tool_result", "message_complete", "turn_complete", "result",
    ]);
    // The exec turn.started is the authentic prompt-pickup proof; pull it out so the content
    // indices below keep addressing the message/tool events.
    expect(evs[1]!.data).toEqual({ turnStarted: true });
    evs.splice(1, 1);
    // MODEL-ACTUAL-SURFACE: cxSpec() pins no spec.model, so agent_started falls back to the
    // catalog's codex defaultModel (the SDK itself never reports back an effective model).
    expect(evs[0]!.data).toEqual({ threadId: "th-1", sessionId: "th-1", model: "gpt-5.6-sol", codexTransport: "exec", nativeApprovals: false, nativeDialogs: false, supportsSteer: false });
    expect(evs[1]!.data).toEqual({ text: "planning", channel: "reasoning" });
    expect(evs[3]!.data).toEqual({ toolName: "command_execution", input: { command: "pnpm test" }, toolId: "i2", toolUseId: "i2" });
    expect(evs[4]!.data).toEqual({ toolName: "command_execution", exitCode: 0, output: "all green", toolId: "i2", toolUseId: "i2" });
    // file_change is single-shot (item.completed only) — normalizeCodexEvent synthesizes
    // BOTH the tool_call and its immediate tool_result so the transcript marks it done (✓)
    // instead of stuck running forever.
    expect(evs[5]!.data).toEqual({ toolName: "file_change", input: { changes: [{ path: "a.ts", kind: "update" }], status: "completed" }, toolId: "i3", toolUseId: "i3" });
    expect(evs[6]!.data).toEqual({ toolName: "file_change", status: "completed", result: "update a.ts", toolId: "i3", toolUseId: "i3" });
    // R2: costUsd is now computed from the pricing table (no longer a hardcoded 0) — derived
    // here via the SAME computeCostUsd the backend uses, rather than a hand-duplicated literal,
    // so the assertion tracks the table instead of drifting from it. usage is the single turn's
    // raw payload verbatim (one turn ⇒ last-turn === cumulative, both fixes are covered
    // separately by the multi-turn tests below).
    const expectedCost = computeCostUsd({ input: 90, output: 50, cacheRead: 10, cacheCreation: 0 }, "gpt-5.6-sol")!;
    expect(expectedCost).toBeGreaterThan(0);
    // TOKEN-OPT-P0-1: billableUsage (cumulativeUsage) and contextUsage (lastTurnUsage) both
    // carry the same one-turn payload here (one turn ⇒ last-turn === cumulative; the
    // multi-turn tests below cover the cases where they diverge), plus the zeroUsage()
    // baseline's cache_write_input_tokens:0 that TURN_OK's raw usage never set.
    const usage = { input_tokens: 100, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 5 };
    expect(evs.at(-1)!.data).toEqual({
      text: "tests pass", costUsd: expectedCost, model: "gpt-5.6-sol",
      // F50 BUDGET-COVERAGE: codex derives costUsd from the price table itself — the flag tells
      // the supervisor's meterTurnCost this dollar figure is estimated, not provider-reported.
      costEstimated: true,
      billableUsage: usage, contextUsage: null, contextUsageSource: "rollout",
    });
    expect(evs[0]!.raw).toEqual(TURN_OK[0]);
  });

  it("emits incremental suffixes for successive agent_message snapshots (message_delta contract)", async () => {
    const { factory } = fakeCodex([[
      { type: "item.updated", item: { id: "i1", type: "agent_message", text: "wor" } },
      { type: "item.updated", item: { id: "i1", type: "agent_message", text: "working" } },
      { type: "item.updated", item: { id: "i1", type: "agent_message", text: "working" } },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: "working done" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ]]);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    const deltas = evs.filter((e) => e.kind === "message_delta").map((e) => e.data["text"]);
    expect(deltas).toEqual(["wor", "king"]);            // suffixes only; the identical third snapshot is swallowed
    expect(evs.find((e) => e.kind === "message_complete")!.data["text"]).toBe("working done");
  });

  it("maps mcp_tool_call, web_search, todo_list and item errors", async () => {
    const { factory } = fakeCodex([[
      { type: "item.started", item: { id: "m1", type: "mcp_tool_call", server: "chimera", tool: "agent_spawn", arguments: { prompt: "x" }, status: "in_progress" } },
      { type: "item.completed", item: { id: "m1", type: "mcp_tool_call", server: "chimera", tool: "agent_spawn", arguments: { prompt: "x" }, status: "completed" } },
      { type: "item.completed", item: { id: "w1", type: "web_search", query: "zod v3 docs" } },
      { type: "item.completed", item: { id: "t1", type: "todo_list", items: [{ text: "step", completed: false }] } },
      { type: "item.completed", item: { id: "e1", type: "error", message: "transient item issue" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ]]);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => [e.kind, e.data["toolName"] ?? null])).toEqual([
      ["tool_call", "mcp:chimera/agent_spawn"], ["tool_result", "mcp:chimera/agent_spawn"],
      // web_search is single-shot (item.completed only, no result payload of its own) —
      // synthesized tool_call + tool_result pair, mirroring file_change.
      ["tool_call", "web_search"], ["tool_result", "web_search"],
      ["status", null], ["status", null], ["turn_complete", null], ["result", null],
    ]);
    expect(evs[4]!.data).toEqual({ todos: [{ text: "step", completed: false }] });
    expect(evs[5]!.data).toEqual({ itemError: "transient item issue" });
  });

  it("maps unknown item types and unknown event types to forward-compatible status events", async () => {
    const { factory } = fakeCodex([[
      { type: "item.completed", item: { id: "f1", type: "future_thing", payload: 1 } },
      { type: "future.event" },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ]]);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs[0]!).toMatchObject({ kind: "status", data: { itemType: "future_thing" } });   // unknown item → status
    expect(evs[1]!).toMatchObject({ kind: "status", data: { codexEvent: "future.event" } }); // unknown event → status
  });

  it("never invokes the PermissionDecider across a full turn (documented codex no-op)", async () => {
    const { factory } = fakeCodex([TURN_OK]);
    const decide = vi.fn(async () => true);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(
      cxSpec({ on: { permissionRequest: "poke:caller" } }), (e) => evs.push(e), decide);
    await settle();
    expect(decide).not.toHaveBeenCalled();              // wiring it into any event path is a regression
    expect(evs.at(-1)!.kind).toBe("result");            // completes without hanging on a permission that never fires
  });

  it("turn.failed ends the agent with a fatal error and no result", async () => {
    const { factory } = fakeCodex([[
      { type: "thread.started", thread_id: "th-1" },
      { type: "turn.failed", error: { message: "UsageLimitExceeded: usage limit reached" } },
    ]]);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "error"]);
    expect(evs[1]!.data["message"]).toContain("usage limit");
  });

  it("reports SDK JSONL failures without persisting command text", async () => {
    const frame = '{"type":"item.started","item":{"command":"private command ' + "x".repeat(20_000);
    const factory: CodexFactory = () => ({
      startThread: () => ({
        id: null,
        runStreamed: async () => ({
          events: (async function* (): AsyncGenerator<CodexThreadEvent> { throw new Error(`Failed to parse item: ${frame}`, { cause: new SyntaxError("Unterminated string") }); })(),
        }),
      }),
      resumeThread() { return this.startThread(); },
    });
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), e => evs.push(e), async () => true);
    await settle();
    expect(evs).toEqual([{ kind: "error", data: {
      message: "Codex event stream contained an incomplete or invalid JSON frame",
      phase: "codex-exec-jsonl", frameBytes: Buffer.byteLength(frame),
    } }]);
    expect(JSON.stringify(evs)).not.toContain("private command");
  });

  it("a thrown stream error surfaces as an error event", async () => {
    const factory: CodexFactory = () => ({
      startThread: () => ({
        id: null,
        runStreamed: async () => ({
          events: (async function* (): AsyncGenerator<CodexThreadEvent> { throw new Error("HTTP 429 Too Many Requests"); })(),
        }),
      }),
      resumeThread() { return this.startThread(); },
    });
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs).toEqual([{ kind: "error", data: { message: "HTTP 429 Too Many Requests" } }]);
  });

  // Same non-Error-rejection hole QA closed in generic.ts:395 — a thrown string/plain object has
  // no `.message`, so a blind `(err as Error).message` cast used to surface `message: undefined`,
  // which supervisor.onError then reported as the content-free "unknown error".
  it("a thrown non-Error rejection still surfaces a readable error message", async () => {
    const factory: CodexFactory = () => ({
      startThread: () => ({
        id: null,
        runStreamed: async () => ({
          events: (async function* (): AsyncGenerator<CodexThreadEvent> { throw "plain string rejection"; })(),
        }),
      }),
      resumeThread() { return this.startThread(); },
    });
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs).toEqual([{ kind: "error", data: { message: "plain string rejection" } }]);
  });

  // AGENT-FAILURE-REACHES-CONDUCTOR: @openai/codex-sdk ALREADY throws `Codex Exec exited with
  // code ${n}: ${stderrBuffer}` on a non-zero process exit (verified against its own dist/index.js)
  // — but that stderr is unbounded and buried in a plain Error message with no structured field a
  // caller can key off of. This proves codex.ts splits it back into a bounded stderrTail + a
  // numeric exitCode, mirroring claude.ts/kimi.ts's shape.
  it("a codex-sdk process-exit error is split into a bounded stderrTail + numeric exitCode", async () => {
    const hugeStderr = "x".repeat(5000) + "leaked credential token=tok-codex-secret";
    const factory: CodexFactory = () => ({
      startThread: () => ({
        id: null,
        runStreamed: async () => ({
          events: (async function* (): AsyncGenerator<CodexThreadEvent> {
            throw new Error(`Codex Exec exited with code 1: ${hugeStderr}`);
          })(),
        }),
      }),
      resumeThread() { return this.startThread(); },
    });
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs).toHaveLength(1);
    const err = evs[0]!;
    expect(err.kind).toBe("error");
    expect(err.data["exitCode"]).toBe(1);
    expect(String(err.data["stderrTail"]).length).toBeLessThanOrEqual(4000);
    expect(String(err.data["stderrTail"])).toContain("token=tok-codex-secret");
    expect(String(err.data["stderrTail"])).not.toContain("x".repeat(5000));   // bounded — the head got dropped
    expect(String(err.data["message"])).toContain("Codex Exec exited with code 1");
  });

  it("a codex-sdk signal-exit error (no numeric code) is still bounded, with no exitCode field", async () => {
    const factory: CodexFactory = () => ({
      startThread: () => ({
        id: null,
        runStreamed: async () => ({
          events: (async function* (): AsyncGenerator<CodexThreadEvent> {
            throw new Error("Codex Exec exited with signal SIGKILL: killed by watchdog");
          })(),
        }),
      }),
      resumeThread() { return this.startThread(); },
    });
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs).toHaveLength(1);
    expect(evs[0]!.data["exitCode"]).toBeUndefined();
    expect(evs[0]!.data["stderrTail"]).toBe("killed by watchdog");
  });

  // W2-1 STRUCTURED-RETURNS
  it("wires resultSchema to runStreamed's outputSchema and surfaces the parsed JSON as structuredOutput", async () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
    const { factory, threads } = fakeCodex([[
      { type: "thread.started", thread_id: "th-1" },
      { type: "item.completed", item: { id: "i0", type: "agent_message", text: '{"verdict":"ok"}' } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },
    ]]);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ resultSchema: schema }), (e) => evs.push(e), async () => true);
    await settle();
    expect(threads[0]!.runs[0]!.turnOptions?.["outputSchema"]).toEqual(schema);
    expect(evs.at(-1)).toMatchObject({ kind: "result", data: { text: '{"verdict":"ok"}', structuredOutput: { verdict: "ok" } } });
  });

  it("omits outputSchema when resultSchema is unset (no regression)", async () => {
    const { factory, threads } = fakeCodex([TURN_OK]);
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), () => {}, async () => true);
    await settle();
    expect(threads[0]!.runs[0]!.turnOptions?.["outputSchema"]).toBeUndefined();
  });

  it("treats a non-JSON final response as a terminal error when resultSchema is set (best-effort enforcement)", async () => {
    const schema = { type: "object" };
    const { factory } = fakeCodex([[
      { type: "thread.started", thread_id: "th-1" },
      { type: "item.completed", item: { id: "i0", type: "agent_message", text: "not json at all" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },
    ]]);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ resultSchema: schema }), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.at(-1)!.kind).toBe("error");
    expect(evs.some((e) => e.kind === "result")).toBe(false);
  });

  // SDK-ADOPTION #4: the actual W2-1 asymmetry — valid JSON that violates resultSchema's shape
  // (missing a required field) must ALSO surface as a terminal error, not a silently-wrong
  // "result" a caller trusts as schema-conformant. Before this slice, Codex only checked
  // JSON.parse succeeded; this is the case that check let through.
  it("treats schema-violating (but syntactically valid) JSON as a terminal error", async () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
    const { factory } = fakeCodex([[
      { type: "thread.started", thread_id: "th-1" },
      { type: "item.completed", item: { id: "i0", type: "agent_message", text: '{"wrongField":123}' } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },
    ]]);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ resultSchema: schema }), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.at(-1)!.kind).toBe("error");
    expect((evs.at(-1)!.data["message"] as string)).toContain("missing required property");
    expect(evs.some((e) => e.kind === "result")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// COVERAGE: additional branch/edge tests beyond the brief's example cases.
// ---------------------------------------------------------------------------

describe("normalizeCodexEvent — direct unit coverage of remaining branches", () => {
  // MODEL-ACTUAL-SURFACE: the Codex SDK's thread.started event carries no model of its own
  // (verified against dist/index.d.ts) — the caller threads through its best-guess effective
  // model (spec.model, else the catalog defaultModel) as normalizeCodexEvent's 3rd arg.
  it("stamps agent_started's data.model from the effectiveModel arg on thread.started", () => {
    const ev = { type: "thread.started", thread_id: "th-1" };
    expect(normalizeCodexEvent(ev, undefined, "gpt-5.6-sol")).toEqual({
      kind: "agent_started", data: { threadId: "th-1", sessionId: "th-1", model: "gpt-5.6-sol" }, raw: ev,
    });
  });

  it("leaves agent_started's data.model absent when no effectiveModel is known", () => {
    const ev = { type: "thread.started", thread_id: "th-1" };
    expect(normalizeCodexEvent(ev)).toEqual({ kind: "agent_started", data: { threadId: "th-1", sessionId: "th-1" }, raw: ev });
  });

  // Prompt-pickup evidence: exec's turn.started has no turnId, yet it is the first authentic sign
  // Codex began the turn. thread.started only proves the process spawned, so it must never carry
  // the turn-start marker.
  it("emits turnStarted for an exec turn.started (no turnId) and keeps the app-server turnId", () => {
    const exec = { type: "turn.started" };
    expect(normalizeCodexEvent(exec)).toEqual({ kind: "status", data: { turnStarted: true }, raw: exec });
    const appServer = { type: "turn.started", turnId: "turn-a" };
    expect(normalizeCodexEvent(appServer)).toEqual({ kind: "status", data: { turnStarted: true, turnId: "turn-a" }, raw: appServer });
  });

  it("does not fabricate turnStarted from thread.started", () => {
    const evs = [normalizeCodexEvent({ type: "thread.started", thread_id: "th-1" })].flat();
    expect(evs.some((e) => e?.data["turnStarted"] !== undefined)).toBe(false);
  });

  it("without a deltas map, every agent_message update re-emits the FULL text (no suffix tracking possible)", () => {
    const ev = { type: "item.updated", item: { id: "z", type: "agent_message", text: "abc" } };
    expect(normalizeCodexEvent(ev)).toEqual({ kind: "message_delta", data: { text: "abc" }, raw: ev });
    // called again with the identical snapshot: still emitted (never swallowed) because there is no
    // map to remember the previous value against — a documented consequence of the optional seam.
    expect(normalizeCodexEvent(ev)).toEqual({ kind: "message_delta", data: { text: "abc" }, raw: ev });
  });

  it("without a deltas map, a completed agent_message still normalizes fine (the delete() call is a safe no-op)", () => {
    const ev = { type: "item.completed", item: { id: "z", type: "agent_message", text: "done" } };
    expect(normalizeCodexEvent(ev)).toEqual({ kind: "message_complete", data: { text: "done" }, raw: ev });
  });

  it("a non-sequential agent_message snapshot (doesn't start with the tracked prefix) emits the whole new text as the suffix", () => {
    const deltas = new Map<string, string>();
    const ev1 = { type: "item.updated", item: { id: "n1", type: "agent_message", text: "hello" } };
    const ev2 = { type: "item.updated", item: { id: "n1", type: "agent_message", text: "goodbye" } };
    expect(normalizeCodexEvent(ev1, deltas)).toEqual({ kind: "message_delta", data: { text: "hello" }, raw: ev1 });
    expect(normalizeCodexEvent(ev2, deltas)).toEqual({ kind: "message_delta", data: { text: "goodbye" }, raw: ev2 });
    expect(deltas.get("n1")).toBe("goodbye");
  });

  it("top-level error event with a message", () => {
    const ev = { type: "error", message: "boom" };
    expect(normalizeCodexEvent(ev)).toEqual({ kind: "error", data: { message: "boom" }, raw: ev });
  });

  it("top-level error event with NO message falls back to a generic message", () => {
    const ev = { type: "error" };
    expect(normalizeCodexEvent(ev)).toEqual({ kind: "error", data: { message: "codex error" }, raw: ev });
  });

  it("turn.failed with an empty error object falls back to a generic message", () => {
    const ev = { type: "turn.failed", error: {} };
    expect(normalizeCodexEvent(ev)).toEqual({ kind: "error", data: { message: "codex turn failed" }, raw: ev });
  });

  it("turn.failed with no error field at all falls back to a generic message", () => {
    const ev = { type: "turn.failed" };
    expect(normalizeCodexEvent(ev)).toEqual({ kind: "error", data: { message: "codex turn failed" }, raw: ev });
  });

  it("reasoning/command_execution/file_change/mcp_tool_call/web_search/todo_list are swallowed on the 'wrong' lifecycle event", () => {
    expect(normalizeCodexEvent({ type: "item.started", item: { id: "r1", type: "reasoning", text: "thinking" } })).toBeNull();
    expect(normalizeCodexEvent({ type: "item.updated", item: { id: "c1", type: "command_execution", command: "ls", aggregated_output: "", status: "in_progress" } })).toBeNull();
    expect(normalizeCodexEvent({ type: "item.updated", item: { id: "f1", type: "file_change", changes: [], status: "completed" } })).toBeNull();
    expect(normalizeCodexEvent({ type: "item.updated", item: { id: "m2", type: "mcp_tool_call", server: "s", tool: "t", arguments: {}, status: "in_progress" } })).toBeNull();
    expect(normalizeCodexEvent({ type: "item.started", item: { id: "w2", type: "web_search", query: "q" } })).toBeNull();
    expect(normalizeCodexEvent({ type: "item.started", item: { id: "t2", type: "todo_list", items: [] } })).toBeNull();
  });

  it("an item-level error fires on ANY lifecycle event (not gated by started/completed)", () => {
    const ev = { type: "item.started", item: { id: "e2", type: "error", message: "still fires" } };
    expect(normalizeCodexEvent(ev)).toEqual({ kind: "status", data: { itemError: "still fires" }, raw: ev });
  });
});

describe("buildCodexOptions — env/apiKey/MCP-grant branch coverage", () => {
  it("omits apiKey entirely when neither OPENAI_API_KEY nor CODEX_API_KEY is present", () => {
    const spec = { ...cxSpec(), env: { CODEX_HOME: "/tmp/codex-home-a" } } as ResolvedAgentSpec;
    expect("apiKey" in buildCodexOptions(spec)).toBe(false);
  });

  it("falls back to CODEX_API_KEY when OPENAI_API_KEY is absent", () => {
    const spec = { ...cxSpec(), env: { CODEX_API_KEY: "sk-codex-only", CODEX_HOME: "/tmp/codex-home-a" } } as ResolvedAgentSpec;
    expect(buildCodexOptions(spec).apiKey).toBe("sk-codex-only");
  });

  it("merges process.env then lets spec.env win (the SDK does not auto-inherit when env is provided)", () => {
    const original = process.env["CODEX_HOME"];
    process.env["CODEX_HOME"] = "should-be-overridden";
    try {
      const opts = buildCodexOptions(cxSpec());
      expect(opts.env?.["CODEX_HOME"]).toBe("/tmp/codex-home-a");      // spec.env wins
      expect(opts.env?.["PATH"]).toBe(process.env["PATH"]);            // process.env is inherited
    } finally {
      if (original === undefined) delete process.env["CODEX_HOME"]; else process.env["CODEX_HOME"] = original;
    }
  });

  it("snapshots the provider pin and source tool-output ceiling", () => {
    expect(buildCodexOptions(cxSpec()).config).toMatchInlineSnapshot(`
      {
        "features.realtime_conversation": false,
        "model_provider": "openai",
        "model_reasoning_summary": "none",
        "model_verbosity": "low",
        "tool_output_token_limit": 4000,
      }
    `);
  });

  // COMPACTION-THRESHOLD-CONFIG: codex's compaction is entirely native (CODEX-COMPACTION-GAP)
  // — the only chimera-side knob is forwarding the configured threshold as the CLI's own
  // documented `-c model_auto_compact_token_limit=<tokens>` override.
  it("forwards spec.compactionThreshold as config.model_auto_compact_token_limit when set", () => {
    const spec = { ...cxSpec(), compactionThreshold: 90_000 };
    expect(buildCodexOptions(spec).config).toMatchObject({ model_auto_compact_token_limit_scope: "total" });
    const opts = buildCodexOptions(spec);
    expect((opts.config as Record<string, unknown>)["model_auto_compact_token_limit"]).toBe(90_000);
  });

  it("injects the chimera MCP grant (depth/maxDepth/resolved home/default empty tree id) when orchestration.allow is true", () => {
    const spec = cxSpec({ orchestration: { allow: true, maxDepth: 5 } });
    const opts = buildCodexOptions(spec);
    const servers = (opts.config as Record<string, unknown> | undefined)?.["mcp_servers"] as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    expect(servers["chimera"]!.command).toBe(process.execPath);
    expect(servers["chimera"]!.args).toHaveLength(1);
    expect(servers["chimera"]!.args[0]).toMatch(/chimera-mcp\.js$/);
    expect(servers["chimera"]!.env["CHIMERA_DEPTH"]).toBe("0");
    expect(servers["chimera"]!.env["CHIMERA_MAX_DEPTH"]).toBe("5");
    expect(servers["chimera"]!.env["CHIMERA_TREE_ID"]).toBe("");        // "" until Phase 2's launch-env stamp is present
    // WORKER-TEAM-CONTEXT: this block had drifted from claude.ts's equivalent — CHIMERA_AGENT_ID
    // was missing entirely (misattributing ask_human/memory-author/etc for every codex team
    // worker) and CHIMERA_TEAM was dropped too (my_team always saw {team:null}). Both are plain
    // spec fields already resolved upstream, not new capability — a copy-gap fix.
    expect(servers["chimera"]!.env["CHIMERA_AGENT_ID"]).toBe("cx-1");
    expect(servers["chimera"]!.env["CHIMERA_TEAM"]).toBe("");           // "" (absent) mirrors CHIMERA_TREE_ID's convention
  });

  it("forwards CHIMERA_TREE_ID into the grant when present on spec.env", () => {
    const spec = { ...cxSpec({ orchestration: { allow: true, maxDepth: 2 } }), env: { ...cxSpec().env, CHIMERA_TREE_ID: "tree-42" } };
    const opts = buildCodexOptions(spec);
    const servers = (opts.config as Record<string, unknown> | undefined)?.["mcp_servers"] as Record<string, { env: Record<string, string> }>;
    expect(servers["chimera"]!.env["CHIMERA_TREE_ID"]).toBe("tree-42");
  });

  it("forwards CHIMERA_TEAM into the grant when present on spec.env (WORKER-TEAM-CONTEXT)", () => {
    const spec = { ...cxSpec({ orchestration: { allow: true, maxDepth: 2 } }), env: { ...cxSpec().env, CHIMERA_TEAM: "crew" } };
    const opts = buildCodexOptions(spec);
    const servers = (opts.config as Record<string, unknown> | undefined)?.["mcp_servers"] as Record<string, { env: Record<string, string> }>;
    expect(servers["chimera"]!.env["CHIMERA_TEAM"]).toBe("crew");
  });

  it("resolves CHIMERA_HOME via chimeraHome() when process.env.CHIMERA_HOME is unset (never empty string)", () => {
    const original = process.env["CHIMERA_HOME"];
    delete process.env["CHIMERA_HOME"];
    try {
      const opts = buildCodexOptions(cxSpec({ orchestration: { allow: true, maxDepth: 2 } }));
      const servers = (opts.config as Record<string, unknown> | undefined)?.["mcp_servers"] as Record<string, { env: Record<string, string> }>;
      expect(servers["chimera"]!.env["CHIMERA_HOME"]).toBe(chimeraHome());
      expect(servers["chimera"]!.env["CHIMERA_HOME"]).not.toBe("");
    } finally {
      if (original === undefined) delete process.env["CHIMERA_HOME"]; else process.env["CHIMERA_HOME"] = original;
    }
  });

  it("uses process.env.CHIMERA_HOME verbatim when set", () => {
    const original = process.env["CHIMERA_HOME"];
    process.env["CHIMERA_HOME"] = "/custom/chimera-home";
    try {
      const opts = buildCodexOptions(cxSpec({ orchestration: { allow: true, maxDepth: 2 } }));
      const servers = (opts.config as Record<string, unknown> | undefined)?.["mcp_servers"] as Record<string, { env: Record<string, string> }>;
      expect(servers["chimera"]!.env["CHIMERA_HOME"]).toBe("/custom/chimera-home");
    } finally {
      if (original === undefined) delete process.env["CHIMERA_HOME"]; else process.env["CHIMERA_HOME"] = original;
    }
  });

  it("preserves Streamable HTTP and stdio MCP servers", () => {
    const spec = {
      ...cxSpec(),
      mcpServers: {
        full: { command: "node", args: ["server.js"], env: { A: "1" } },
        minimal: { command: "bar" },
        remote: { url: "https://example.com/mcp" },
      },
    };
    const opts = buildCodexOptions(spec);
    const servers = (opts.config as Record<string, unknown> | undefined)?.["mcp_servers"] as Record<string, unknown>;
    expect(Object.keys(servers).sort()).toEqual(["full", "minimal", "remote"]);
    expect(servers["full"]).toEqual({ command: "node", args: ["server.js"], env: { A: "1" }, required: true });
    expect(servers["minimal"]).toEqual({ command: "bar", required: true });
    expect(servers["remote"]).toEqual({ url: "https://example.com/mcp", required: true });
  });

  it("without a spec allowlist, preserves configured enabled_tools/disabled_tools byte-for-byte", () => {
    const spec = {
      ...cxSpec(),
      mcpServers: {
        allowed: {
          command: "node",
          args: ["server.js"],
          enabled_tools: ["search", "read"],
          disabled_tools: ["delete"],
        },
        none: { command: "node", enabled_tools: [] },
      },
    };
    const config = buildCodexOptions(spec).config as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(config.mcp_servers).toMatchInlineSnapshot(`
      {
        "allowed": {
          "args": [
            "server.js",
          ],
          "command": "node",
          "disabled_tools": [
            "delete",
          ],
          "enabled_tools": [
            "search",
            "read",
          ],
          "required": true,
        },
        "none": {
          "command": "node",
          "enabled_tools": [],
          "required": false,
        },
      }
    `);
  });

  it("applies the per-agent allowlist as a closed-world intersection that cannot broaden config", () => {
    const config = buildCodexOptions(cxSpec({
      orchestration: { allow: true, maxDepth: 2 },
      mcpServers: {
        bounded: {
          command: "node",
          enabled_tools: ["read", "search", "admin"],
          disabled_tools: ["admin"],
        },
        unlisted: { command: "node" },
      },
      mcpToolAllowlist: {
        bounded: ["search", "missing", "admin"],
        chimera: ["my_team", "memory_search", "agent_send"],
      },
    })).config as { mcp_servers: Record<string, Record<string, unknown>> };

    expect(config.mcp_servers["bounded"]).toEqual({
      command: "node",
      enabled_tools: ["search", "admin"],
      disabled_tools: ["admin"],
      required: true,
    });
    // MCP-STARTUP-RACE gating: a server the closed-world grant left with NO tools is inert, so its
    // boot must not be able to fail the agent — required follows the grant.
    expect(config.mcp_servers["unlisted"]).toEqual({
      command: "node",
      enabled_tools: [],
      required: false,
    });
    expect(config.mcp_servers["chimera"]?.["enabled_tools"]).toEqual([
      "my_team",
      "memory_search",
      "agent_send",
    ]);
  });

  it("an empty per-agent allowlist disables every configured MCP server", () => {
    const config = buildCodexOptions(cxSpec({
      mcpServers: {
        first: { command: "node", enabled_tools: ["read"] },
        second: { command: "node" },
      },
      mcpToolAllowlist: {},
    })).config as { mcp_servers: Record<string, Record<string, unknown>> };

    expect(config.mcp_servers["first"]?.["enabled_tools"]).toEqual([]);
    expect(config.mcp_servers["second"]?.["enabled_tools"]).toEqual([]);
  });
});

describe("buildThreadOptions — sandbox mapping / model / providerOptions precedence", () => {
  it("maps permissionProfile to sandboxMode for all three profiles", () => {
    expect(buildThreadOptions(cxSpec({ permissionProfile: "readOnly" }), "/tmp/repo")["sandboxMode"]).toBe("read-only");
    expect(buildThreadOptions(cxSpec({ permissionProfile: "acceptEdits" }), "/tmp/repo")["sandboxMode"]).toBe("workspace-write");
    expect(buildThreadOptions(cxSpec({ permissionProfile: "full" }), "/tmp/repo")["sandboxMode"]).toBe("danger-full-access");
  });

  it("always pins a model so ambient CLI config cannot select unsupported metadata", () => {
    expect(buildThreadOptions(cxSpec(), "/tmp/repo")["model"]).toBe("gpt-5.6-sol");
    expect(buildThreadOptions(cxSpec({ model: "gpt-5-codex" }), "/tmp/repo")["model"]).toBe("gpt-5-codex");
  });

  it("an undefined model override cannot erase the selected or default model", () => {
    expect(buildThreadOptions(cxSpec({ model: "gpt-6-astra", providerOptions: { model: undefined } }), "/tmp/repo").model).toBe("gpt-6-astra");
    expect(buildThreadOptions(cxSpec({ providerOptions: { model: undefined } }), "/tmp/repo").model).toBe("gpt-5.6-sol");
    expect(buildThreadOptions(cxSpec({ model: "gpt-6-astra", providerOptions: { model: "gpt-6-sol" } }), "/tmp/repo").model).toBe("gpt-6-sol");
  });

  // R2 EFFORT: direct passthrough — chimera's neutral enum is a literal subset of codex's own
  // ModelReasoningEffort, so modelReasoningEffort mirrors spec.effort verbatim.
  it("maps modelReasoningEffort only when the spec sets an effort", () => {
    expect(buildThreadOptions(cxSpec(), "/tmp/repo")).not.toHaveProperty("modelReasoningEffort");
    expect(buildThreadOptions(cxSpec({ effort: "low" }), "/tmp/repo")["modelReasoningEffort"]).toBe("low");
  });

  it("sets the static fields (workingDirectory, skipGitRepoCheck, default approvalPolicy)", () => {
    const opts = buildThreadOptions(cxSpec(), "/tmp/worktree-x");
    expect(opts["workingDirectory"]).toBe("/tmp/worktree-x");
    expect(opts["skipGitRepoCheck"]).toBe(true);
    expect(opts["approvalPolicy"]).toBe("never");
  });

  it("providerOptions is a documented escape hatch that wins over chimera's defaults, including approvalPolicy/sandboxMode", () => {
    const opts = buildThreadOptions(
      cxSpec({ providerOptions: { sandboxMode: "danger-full-access", approvalPolicy: "on-request" } }),
      "/tmp/repo",
    );
    expect(opts["sandboxMode"]).toBe("danger-full-access");
    expect(opts["approvalPolicy"]).toBe("on-request");
  });
});

describe("CodexAgentBackend.spawn — additional branch/edge coverage", () => {
  const zeroUsage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };

  it("fails before constructing the SDK when a providerOptions model disables tool search", () => {
    const { factory, codexCalls } = fakeCodex([]);
    expect(() => new CodexAgentBackend({ codexFactory: factory }).spawn(
      cxSpec({ providerOptions: { model: "unsupported-model" } }),
      () => {},
      async () => true,
    )).toThrow(/Codex tool-schema deferral is inactive/);
    expect(codexCalls).toHaveLength(0);
  });

  it("prefixes the first turn's input with instructions when present", async () => {
    const { factory, threads } = fakeCodex([[{ type: "turn.completed", usage: zeroUsage }]]);
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ instructions: "be concise" }), () => {}, async () => true);
    await settle();
    expect(threads[0]!.runs[0]!.input).toBe("be concise\n\ntask");
  });

  it("uses the bare prompt as the first turn's input when instructions are absent", async () => {
    const { factory, threads } = fakeCodex([[{ type: "turn.completed", usage: zeroUsage }]]);
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), () => {}, async () => true);
    await settle();
    expect(threads[0]!.runs[0]!.input).toBe("task");
  });

  it("stops exactly at maxTurns even with a pending queued message (off-by-one boundary)", async () => {
    const turn: CodexThreadEvent[] = [{ type: "turn.completed", usage: zeroUsage }];
    const { factory, threads } = fakeCodex([turn, turn]);
    const evs: BackendEvent[] = [];
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(
      cxSpec({ maxTurns: 1 }), (e) => evs.push(e), async () => true);
    await handle.send("queued-but-never-run");
    await settle();
    expect(threads[0]!.runs.length).toBe(1);              // second turnScript never consumed — capped at maxTurns
    expect(evs.at(-1)!.kind).toBe("result");
  });

  // SOFT-TURN-LIMIT
  it("turnLimitPolicy:'soft' runs PAST maxTurns instead of stopping, emitting turnBudgetExceeded once at the boundary", async () => {
    const turn: CodexThreadEvent[] = [{ type: "turn.completed", usage: zeroUsage }];
    const { factory, threads } = fakeCodex([turn, turn, turn]);
    const evs: BackendEvent[] = [];
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(
      cxSpec({ maxTurns: 1, turnLimitPolicy: "soft" }), (e) => evs.push(e), async () => true);
    await handle.send("second");
    await handle.send("third");
    await settle();
    expect(threads[0]!.runs.length).toBe(3);   // unlike the "fail"-policy boundary test above, every queued turn runs
    const budgetEvents = evs.filter((e) => e.kind === "status" && e.data["turnBudgetExceeded"] === true);
    expect(budgetEvents).toHaveLength(1);
    expect(budgetEvents[0]!.data).toEqual({ turnBudgetExceeded: true, turnsCompleted: 1, turnBudget: 1 });
    expect(evs.some((e) => e.kind === "error")).toBe(false);
    expect(evs.at(-1)!.kind).toBe("result");
  });

  it("delivers a queued follow-up as a second turn on the same thread and reflects its result", async () => {
    const turn0: CodexThreadEvent[] = [{ type: "turn.completed", usage: zeroUsage }];
    const turn1: CodexThreadEvent[] = [
      { type: "item.completed", item: { id: "z1", type: "agent_message", text: "second turn done" } },
      { type: "turn.completed", usage: zeroUsage },
    ];
    const { factory, threads } = fakeCodex([turn0, turn1]);
    const evs: BackendEvent[] = [];
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await handle.send("followup");
    await settle();
    expect(threads[0]!.runs.map((r) => r.input)).toEqual(["task", "followup"]);
    expect(evs.map((e) => e.kind)).toEqual(["turn_complete", "message_complete", "turn_complete", "result"]);
    expect(evs.at(-1)!.data["text"]).toBe("second turn done");
  });

  it("a mid-turn top-level error event ends the run immediately, without processing later events in the same script", async () => {
    const { factory } = fakeCodex([[
      { type: "thread.started", thread_id: "th-1" },
      { type: "error", message: "boom mid turn" },
      { type: "turn.completed", usage: zeroUsage },
    ]]);
    const evs: BackendEvent[] = [];
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "error"]);
    expect(evs[1]!.data["message"]).toBe("boom mid turn");
  });

  it("recovers from a mid-turn interrupt: emits turn_complete{interrupted:true} then a result, without crashing", async () => {
    const { factory } = fakeCodex([[{ type: "thread.started", thread_id: "th-1" }]]);
    const evs: BackendEvent[] = [];
    // interruptGraceMs: 0 — this test predates Task 6's grace window (default 250ms) and pins the
    // "no follow-up arrives" finish path without coupling to the default's timing; see the "turns and
    // lifecycle" describe block below for the grace window's own dedicated coverage.
    const handle = new CodexAgentBackend({ codexFactory: factory, interruptGraceMs: 0 })
      .spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await handle.interrupt();
    await settle();
    expect(evs).toEqual([
      { kind: "turn_complete", data: { interrupted: true } },
      { kind: "result", data: { text: "", costUsd: 0, model: "gpt-5.6-sol", costEstimated: true, billableUsage: zeroUsage, contextUsage: null, contextUsageSource: "rollout" } },
    ]);
  });

  it("kill() before any event is processed ends the run with no events emitted at all", async () => {
    const { factory } = fakeCodex([[{ type: "thread.started", thread_id: "th-1" }]]);
    const evs: BackendEvent[] = [];
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await handle.kill();
    await settle();
    expect(evs).toEqual([]);
  });

  it("implements graceful close() for persistent/conductor input streams", () => {
    const { factory } = fakeCodex([[]]);
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), () => {}, async () => true);
    expect(handle.close).toBeTypeOf("function");
  });
});

const TURN_MIN: CodexThreadEvent[] = [
  { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
];

describe("CodexAgentBackend option mapping", () => {
  it("maps permissionProfile to sandboxMode with approvalPolicy never", async () => {
    const { factory, threads } = fakeCodex([TURN_MIN, TURN_MIN, TURN_MIN]);
    const b = new CodexAgentBackend({ codexFactory: factory });
    b.spawn(cxSpec({ permissionProfile: "readOnly" }), () => {}, async () => true);
    b.spawn(cxSpec({ permissionProfile: "acceptEdits" }), () => {}, async () => true);
    b.spawn(cxSpec({ permissionProfile: "full" }), () => {}, async () => true);
    await settle();
    expect(threads.map((t) => t.options?.["sandboxMode"])).toEqual(["read-only", "workspace-write", "danger-full-access"]);
    expect(threads.every((t) => t.options?.["approvalPolicy"] === "never")).toBe(true);
    expect(threads.every((t) => t.options?.["skipGitRepoCheck"] === true)).toBe(true);
    expect(threads[0]!.options?.["workingDirectory"]).toBe("/tmp/repo");
  });

  it("merges process.env under spec.env and passes apiKey", async () => {
    const { factory, codexCalls } = fakeCodex([TURN_MIN]);
    new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), () => {}, async () => true);
    await settle();
    const env = codexCalls[0]!["env"] as Record<string, string>;
    expect(env["OPENAI_API_KEY"]).toBe("sk-test");
    expect(env["CODEX_HOME"]).toBe("/tmp/codex-home-a");
    expect(env["CHIMERA_AGENT_ID"]).toBe("cx-1");
    expect(env["PATH"]).toBe(process.env.PATH);          // explicit process.env merge (SDK does not inherit)
    expect(codexCalls[0]!["apiKey"]).toBe("sk-test");
  });

  it("falls back to CODEX_API_KEY for apiKey when OPENAI_API_KEY is absent (injectAs CODEX_API_KEY path)", async () => {
    const { factory, codexCalls } = fakeCodex([TURN_MIN]);
    const spec = { ...cxSpec(), env: { CODEX_API_KEY: "sk-cdx", CHIMERA_AGENT_ID: "cx-1", CHIMERA_DEPTH: "0" } } as ResolvedAgentSpec;
    new CodexAgentBackend({ codexFactory: factory }).spawn(spec, () => {}, async () => true);
    await settle();
    expect(codexCalls[0]!["apiKey"]).toBe("sk-cdx");     // Task 1 added CODEX_API_KEY to InjectAs for exactly this
  });

  it("prefixes instructions onto the first turn input and passes model", async () => {
    const { factory, threads } = fakeCodex([TURN_MIN]);
    new CodexAgentBackend({ codexFactory: factory })
      .spawn(cxSpec({ instructions: "Be terse.", model: "gpt-5.2-codex" }), () => {}, async () => true);
    await settle();
    expect(threads[0]!.runs[0]!.input).toBe("Be terse.\n\ntask");
    expect(threads[0]!.options?.["model"]).toBe("gpt-5.2-codex");
  });

  it("providerOptions spread last wins over the mapped defaults", async () => {
    const { factory, threads } = fakeCodex([TURN_MIN]);
    new CodexAgentBackend({ codexFactory: factory }).spawn(
      cxSpec({ providerOptions: { sandboxMode: "danger-full-access", modelReasoningEffort: "high", networkAccessEnabled: true } }),
      () => {}, async () => true);
    await settle();
    expect(threads[0]!.options?.["sandboxMode"]).toBe("danger-full-access");
    expect(threads[0]!.options?.["modelReasoningEffort"]).toBe("high");
    expect(threads[0]!.options?.["networkAccessEnabled"]).toBe(true);
  });

  it("injects the chimera MCP grant via codex config with full claude-backend parity", async () => {
    const { factory, codexCalls } = fakeCodex([TURN_MIN, TURN_MIN]);
    const b = new CodexAgentBackend({ codexFactory: factory });
    const orch = cxSpec({ orchestration: { allow: true, maxDepth: 3 } });
    b.spawn({ ...orch, env: { ...orch.env, CHIMERA_TREE_ID: "tree-1" } } as ResolvedAgentSpec, () => {}, async () => true);
    b.spawn(cxSpec(), () => {}, async () => true);
    await settle();
    const cfg = codexCalls[0]!["config"] as {
      mcp_servers: Record<string, { command: string; args?: string[]; env?: Record<string, string>; required?: boolean }>;
    };
    const chimera = cfg.mcp_servers["chimera"]!;
    expect(chimera).toBeDefined();
    expect(chimera.command).toBe(process.execPath);
    // MCP-STARTUP-RACE: the orchestration server flows through the same loop, so it too must block
    // turn 1 on its handshake — an agent granted orchestration but racing past chimera's own boot
    // would silently start with none of the tools its allowlist just granted.
    expect(chimera.required).toBe(true);
    expect(chimera.args?.[0]).toContain(join("mcp", "bin", "chimera-mcp.js"));  // plain-node launcher, not tsx
    expect(chimera.env?.["CHIMERA_DEPTH"]).toBe("0");
    expect(chimera.env?.["CHIMERA_MAX_DEPTH"]).toBe("3");     // the granting spec's own limit — no depth-cap escape
    expect(chimera.env?.["CHIMERA_TREE_ID"]).toBe("tree-1");  // forwarded from the launch env (Phase 2 budget ceiling)
    expect(chimera.env?.["CHIMERA_HOME"]).toBeTruthy();       // resolved via chimeraHome() — never empty string
    expect(codexCalls[1]!["config"]).toEqual({
      "features.realtime_conversation": false,
      model_provider: "openai",
      tool_output_token_limit: 4_000,
      model_verbosity: "low",
      model_reasoning_summary: "none",
    }); // no orchestration → deferral/source-truncation pins only
  });

  it("forwards remote MCP servers alongside injected orchestration", async () => {
    const { factory, codexCalls } = fakeCodex([TURN_MIN]);
    new CodexAgentBackend({ codexFactory: factory }).spawn(
      cxSpec({
        orchestration: { allow: true, maxDepth: 2 },
        mcpServers: {
          good: { command: "node", args: ["srv.js"] },
          remote: { url: "https://example.com/mcp" },
        },
      }), () => {}, async () => true);
    await settle();
    const cfg = codexCalls[0]!["config"] as { mcp_servers: Record<string, unknown> };
    expect(Object.keys(cfg.mcp_servers).sort()).toEqual(["chimera", "good", "remote"]);
  });

  it("creates a git worktree for isolation and rejects non-repos", async () => {
    const repo = mkdtempSync(join(tmpdir(), "chimera-cxrepo-"));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
    const { factory, threads } = fakeCodex([TURN_MIN]);
    new CodexAgentBackend({ codexFactory: factory })
      .spawn(cxSpec({ cwd: repo, isolation: "worktree" }), () => {}, async () => true);
    await settle();
    expect(String(threads[0]!.options?.["workingDirectory"])).toContain(join(repo, ".chimera", "worktrees"));

    const notRepo = mkdtempSync(join(tmpdir(), "chimera-cxnorepo-"));
    expect(() => new CodexAgentBackend({ codexFactory: factory })
      .spawn(cxSpec({ cwd: notRepo, isolation: "worktree" }), () => {}, async () => true))
      .toThrow(GuardrailError);
  });
});

import type { AgentHandle } from "@chimera/core/backend";

const usage1 = { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };
const turnWith = (text: string): CodexThreadEvent[] => [
  { type: "item.completed", item: { id: "a", type: "agent_message", text } },
  { type: "turn.completed", usage: usage1 },
];

describe("CodexAgentBackend turns and lifecycle", () => {
  it("keeps a conductor session open after each turn and emits result only after close()", async () => {
    const { factory, threads } = fakeCodex([turnWith("first"), turnWith("second")]);
    const evs: BackendEvent[] = [];
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(
      cxSpec({ conductor: true }),
      (e) => evs.push(e),
      async () => true,
    );

    await settle();
    expect(threads[0]!.runs.map((r) => r.input)).toEqual(["task"]);
    expect(evs.filter((e) => e.kind === "turn_complete")).toHaveLength(1);
    expect(evs.some((e) => e.kind === "result")).toBe(false);

    await handle.send("follow up");
    await settle();
    expect(threads[0]!.runs.map((r) => r.input)).toEqual(["task", "follow up"]);
    expect(evs.filter((e) => e.kind === "turn_complete")).toHaveLength(2);
    expect(evs.some((e) => e.kind === "result")).toBe(false);

    await handle.close?.();
    await settle();
    expect(evs.at(-1)?.kind).toBe("result");
  });

  it("resume attaches to the prior thread id instead of starting a fresh one (CR1 parity)", async () => {
    const { factory, resumedIds, threads } = fakeCodex([turnWith("first")]);
    new CodexAgentBackend({ codexFactory: factory }).spawn(
      cxSpec({ resume: "sess-1" }), () => {}, async () => true,
    );
    await settle();
    expect(resumedIds).toEqual(["sess-1"]);
    expect(threads[0]!.runs.map((r) => r.input)).toEqual(["task"]);   // resume without resumeOnly still pushes the prompt
  });

  it("a persistent conductor's resumeOnly reattach idles on the resumed thread until send() (CR1 parity)", async () => {
    const { factory, resumedIds, threads } = fakeCodex([turnWith("first")]);
    const evs: BackendEvent[] = [];
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(
      cxSpec({ conductor: true, resume: "sess-1", resumeOnly: true }), (e) => evs.push(e), async () => true,
    );
    await settle();
    expect(resumedIds).toEqual(["sess-1"]);
    expect(threads[0]!.runs).toEqual([]);        // no thread run started: nothing was queued
    expect(evs.some((e) => e.kind === "result")).toBe(false);   // keepAlive: idles instead of finishing

    await handle.send("hi");
    await settle();
    expect(threads[0]!.runs.map((r) => r.input)).toEqual(["hi"]);
  });

  it("refreshes instructions once after idle reattach without replaying the task or changing slash commands", async () => {
    const { factory, threads } = fakeCodex([turnWith("compacted"), turnWith("first"), turnWith("second")]);
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(
      cxSpec({ persistent: true, resume: "sess-1", resumeOnly: true, instructions: "Chimera MCP first." }), () => {}, async () => true,
    );
    await settle();
    expect(threads[0]!.runs).toEqual([]);
    await handle.send("/compact"); await settle();
    await handle.send("/tmp/project: new task"); await settle();
    await handle.send("follow up"); await settle();
    expect(threads[0]!.runs.map(r => r.input)).toEqual(["/compact", "Chimera MCP first.\n\n/tmp/project: new task", "follow up"]);
    await handle.kill();
  });

  it("send() during turn_complete starts a follow-up turn on the same thread", async () => {
    const { factory, threads } = fakeCodex([turnWith("first"), turnWith("second")]);
    const evs: BackendEvent[] = [];
    let sent = false;
    let h: AgentHandle;
    const sink = (e: BackendEvent) => {
      evs.push(e);
      if (e.kind === "turn_complete" && !sent) { sent = true; void h.send("[from tester] go on"); }
    };
    h = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), sink, async () => true);
    await settle();
    expect(threads.length).toBe(1);                                  // ONE thread, two runs
    expect(threads[0]!.runs.map((r) => r.input)).toEqual(["task", "[from tester] go on"]);
    expect(evs.filter((e) => e.kind === "turn_complete").length).toBe(2);
    const result = evs.find((e) => e.kind === "result")!;
    expect(result.data["text"]).toBe("second");
    // R2 / TOKEN-OPT-P0-1: contextUsage on the final result is the LAST turn's raw payload only
    // (current context), not the run's cumulative sum — codex no longer clobbers it with an
    // accumulated total on the final result event (see PLAN.md §3). Both turns report usage1
    // (input_tokens:1), so a still-accumulating implementation would wrongly report 2 here.
    expect(result.data["contextUsage"]).toBeNull();
    expect((result.data["billableUsage"] as { input_tokens: number }).input_tokens).toBe(1);
  });

  it("exec session totals are not added twice or used as current context", async () => {
    const u1 = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };
    const u2 = { input_tokens: 20, cached_input_tokens: 5, output_tokens: 1, reasoning_output_tokens: 0 };
    const u3 = { input_tokens: 30, cached_input_tokens: 10, output_tokens: 1, reasoning_output_tokens: 0 };
    const turnWithUsage = (text: string, usage: typeof u1): CodexThreadEvent[] => [
      { type: "item.completed", item: { id: "a", type: "agent_message", text } },
      { type: "turn.completed", usage },
    ];
    const { factory } = fakeCodex([turnWithUsage("t1", u1), turnWithUsage("t2", u2), turnWithUsage("t3", u3)]);
    const evs: BackendEvent[] = [];
    let turnsSent = 0;
    let h: AgentHandle;
    const sink = (e: BackendEvent) => {
      evs.push(e);
      if (e.kind === "turn_complete" && turnsSent < 2) { turnsSent++; void h.send(`go ${turnsSent}`); }
    };
    h = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), sink, async () => true);
    await settle();
    const result = evs.find((e) => e.kind === "result")!;
    // cache_write_input_tokens:0 comes from zeroUsage()'s baseline merge — u3 itself never sets it.
    expect(result.data["contextUsage"]).toBeNull();
    expect(result.data["billableUsage"]).toEqual({ ...u3, cache_write_input_tokens: 0 });
  });

  it("costUsd prices cumulative exec totals once per model", async () => {
    const u1 = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0 };
    const u2 = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0 };
    const turnWithUsage = (text: string, usage: typeof u1): CodexThreadEvent[] => [
      { type: "item.completed", item: { id: "a", type: "agent_message", text } },
      { type: "turn.completed", usage },
    ];
    const twoTurnRun = () => {
      const { factory } = fakeCodex([turnWithUsage("t1", u1), turnWithUsage("t2", u2)]);
      const evs: BackendEvent[] = [];
      let sent = false;
      let h: AgentHandle;
      const sink = (e: BackendEvent) => {
        evs.push(e);
        if (e.kind === "turn_complete" && !sent) { sent = true; void h.send("go"); }
      };
      h = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), sink, async () => true);
      return { evs };
    };
    const { evs } = twoTurnRun();
    await settle();
    const result = evs.find((e) => e.kind === "result")!;
    const oneTurnCost = computeCostUsd({ input: 100, output: 100, cacheRead: 0, cacheCreation: 0 }, "gpt-5.6-sol")!;
    // Repeating the same session total must not charge it twice.
    expect(result.data["costUsd"]).toBeCloseTo(oneTurnCost, 10);

    const { evs: evsB } = (() => {
      const { factory } = fakeCodex([turnWithUsage("solo", u1)]);
      const evsB: BackendEvent[] = [];
      new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ model: "gpt-5.6-luna" }), (e) => evsB.push(e), async () => true);
      return { evs: evsB };
    })();
    await settle();
    const resultB = evsB.find((e) => e.kind === "result")!;
    const lunaCost = computeCostUsd({ input: 100, output: 100, cacheRead: 0, cacheCreation: 0 }, "gpt-5.6-luna")!;
    expect(resultB.data["costUsd"]).toBeCloseTo(lunaCost, 10);
    expect(lunaCost).toBeLessThan(oneTurnCost);   // luna is priced cheaper than the sol default
  });

  it("caps turns at maxTurns and still emits result", async () => {
    const { factory, threads } = fakeCodex([turnWith("only"), turnWith("never")]);
    const evs: BackendEvent[] = [];
    let h: AgentHandle;
    const sink = (e: BackendEvent) => {
      evs.push(e);
      if (e.kind === "turn_complete") void h.send("beyond the cap");
    };
    h = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ maxTurns: 1 }), sink, async () => true);
    await settle();
    expect(threads[0]!.runs.length).toBe(1);
    expect(evs.at(-1)!.kind).toBe("result");
    expect(evs.at(-1)!.data["text"]).toBe("only");
  });

  it("interrupt aborts the current turn but the agent survives for the next send", async () => {
    const hanging = Object.assign(
      [{ type: "item.completed", item: { id: "h", type: "agent_message", text: "stuck…" } }] as CodexThreadEvent[],
      { hang: true });
    const { factory, threads } = fakeCodex([hanging, turnWith("recovered")]);
    const evs: BackendEvent[] = [];
    // grace far above settle(): the follow-up send always lands inside the window — no timing coupling
    const h = new CodexAgentBackend({ codexFactory: factory, interruptGraceMs: 1000 })
      .spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    await h.interrupt();
    await settle();
    expect(evs.some((e) => e.kind === "turn_complete" && e.data["interrupted"] === true)).toBe(true);
    expect(evs.every((e) => e.kind !== "error")).toBe(true);         // interrupt is not a failure
    await h.send("try again");
    await settle();
    expect(threads[0]!.runs.length).toBe(2);
    expect(evs.at(-1)!.kind).toBe("result");
    expect(evs.at(-1)!.data["text"]).toBe("recovered");
  });

  it("after the grace expires with no send, the agent finishes with the pre-interrupt text", async () => {
    const hanging = Object.assign(
      [{ type: "item.completed", item: { id: "h", type: "agent_message", text: "partial answer" } }] as CodexThreadEvent[],
      { hang: true });
    const { factory, threads } = fakeCodex([hanging, turnWith("never")]);
    const evs: BackendEvent[] = [];
    const h = new CodexAgentBackend({ codexFactory: factory, interruptGraceMs: 20 })
      .spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    await h.interrupt();
    await new Promise((r) => setTimeout(r, 60));         // > interruptGraceMs: the grace expires idle
    expect(evs.at(-1)!.kind).toBe("result");             // documented divergence: interrupt-then-idle auto-finishes
    expect(evs.at(-1)!.data["text"]).toBe("partial answer");
    // LATE-MESSAGE-RESUME: a post-finish send() now REJECTS instead of silently queuing into a
    // dead loop — deliverBatch's catch re-enqueues it, so checkPendingOnSettle can pick it up.
    await expect(h.send("too late")).rejects.toThrow("input stream closed");
    await new Promise((r) => setTimeout(r, 60));
    expect(threads[0]!.runs.length).toBe(1);
  });

  it("kill during the grace exits the loop immediately without starting another turn", async () => {
    const hanging = Object.assign([] as CodexThreadEvent[], { hang: true });
    const { factory, threads } = fakeCodex([hanging, turnWith("never")]);
    const evs: BackendEvent[] = [];
    const h = new CodexAgentBackend({ codexFactory: factory, interruptGraceMs: 60_000 })
      .spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    await h.interrupt();
    await settle();                                       // loop is now sleeping in the 60s grace
    await h.kill();                                       // wake?.() breaks the sleep; loop re-checks killed and exits
    await settle();                                       // let run()'s finally (ended = true) land before send()
    // LATE-MESSAGE-RESUME: a send() after kill now REJECTS (mirrors claude.ts's closed AsyncQueue)
    // instead of silently queuing into a loop that already exited.
    await expect(h.send("after kill")).rejects.toThrow("input stream closed");
    await settle();
    expect(threads[0]!.runs.length).toBe(1);              // no new turn after kill, even with a queued send
    expect(evs.every((e) => e.kind !== "result" && e.kind !== "error")).toBe(true);
  });

  it("kill stops the script: no further events, no result", async () => {
    const hanging = Object.assign([] as CodexThreadEvent[], { hang: true });
    const { factory } = fakeCodex([hanging]);
    const evs: BackendEvent[] = [];
    const h = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), (e) => evs.push(e), async () => true);
    await settle();
    await h.kill();
    await h.send("too late");
    await settle();
    expect(evs.every((e) => e.kind !== "result" && e.kind !== "error")).toBe(true);
  });

  describe("R2-TURN-LIFECYCLE: idle/max-duration watchdog", () => {
    it("idle timeout mid-turn emits turn_timeout and ends the run with no result event", async () => {
      const hanging = Object.assign(
        [{ type: "item.completed", item: { id: "h", type: "agent_message", text: "stuck…" } }] as CodexThreadEvent[],
        { hang: true });
      const { factory } = fakeCodex([hanging]);
      const evs: BackendEvent[] = [];
      new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ idleTimeoutMs: 20 }), (e) => evs.push(e), async () => true);
      await new Promise((r) => setTimeout(r, 60));
      expect(evs.map((e) => e.kind)).toContain("turn_timeout");
      const timeoutEv = evs.find((e) => e.kind === "turn_timeout")!;
      expect(timeoutEv.data).toMatchObject({ reason: "idle", idleTimeoutMs: 20 });
      expect(evs.some((e) => e.kind === "result")).toBe(false);
    });

    it("max-duration timeout fires even while the stream keeps emitting events", async () => {
      const script: CodexThreadEvent[] = Array.from({ length: 200 }, (_, i) => ({
        type: "item.completed", item: { id: `m${i}`, type: "agent_message", text: "x" },
      }));
      const codexCalls: unknown[] = [];
      const factory: CodexFactory = (opts) => {
        codexCalls.push(opts);
        return {
          startThread: () => ({
            id: "th-1",
            async runStreamed(_input: string, o?: { signal?: AbortSignal }) {
              return {
                events: (async function* () {
                  for (const e of script) {
                    if (o?.signal?.aborted) throw new Error("aborted");
                    await new Promise((r) => setTimeout(r, 2));
                    yield e;
                  }
                })(),
              };
            },
          }),
          resumeThread(_id: string, options?: Record<string, unknown>) { return this.startThread(options); },
        };
      };
      const evs: BackendEvent[] = [];
      new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ maxTurnDurationMs: 20 }), (e) => evs.push(e), async () => true);
      await new Promise((r) => setTimeout(r, 80));
      expect(evs.map((e) => e.kind)).toContain("turn_timeout");
      const timeoutEv = evs.find((e) => e.kind === "turn_timeout")!;
      expect(timeoutEv.data).toMatchObject({ reason: "max-duration", maxTurnDurationMs: 20 });
      expect(evs.some((e) => e.kind === "result")).toBe(false);
    });

    it("unset idleTimeoutMs/maxTurnDurationMs (default) leaves the interrupt path byte-identical", async () => {
      const hanging = Object.assign(
        [{ type: "item.completed", item: { id: "h", type: "agent_message", text: "stuck…" } }] as CodexThreadEvent[],
        { hang: true });
      const { factory } = fakeCodex([hanging, turnWith("recovered")]);
      const evs: BackendEvent[] = [];
      const h = new CodexAgentBackend({ codexFactory: factory, interruptGraceMs: 1000 })
        .spawn(cxSpec(), (e) => evs.push(e), async () => true);
      await settle();
      await h.interrupt();
      await settle();
      expect(evs.some((e) => e.kind === "turn_timeout")).toBe(false);
      expect(evs.some((e) => e.kind === "turn_complete" && e.data["interrupted"] === true)).toBe(true);
    });
  });
});


describe("Codex force-send steering", () => {
  const ok: CodexThreadEvent[] = [
    { type: "turn.started" },
    { type: "item.completed", item: { id: "answer", type: "agent_message", text: "used correction" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
  ];

  it.each([false, true])("interrupts SDK exec and resumes the same thread (early=%s)", async (early) => {
    const running = Object.assign([
      { type: "thread.started", thread_id: "th-1" }, { type: "turn.started" },
    ], { hang: true });
    const { factory, threads } = fakeCodex([running, ok]);
    const events: BackendEvent[] = [];
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), e => events.push(e), async () => true);
    if (!early) await settle();
    await handle.steer!("correct direction");
    await vi.waitFor(() => expect(events.some(e => e.kind === "result")).toBe(true));
    expect(threads).toHaveLength(1);
    expect(threads[0]!.runs.map(run => run.input)).toEqual(["task", "correct direction"]);
    expect(events.some(e => e.kind === "error")).toBe(false);
    expect(events.filter(e => e.kind === "turn_complete" && e.data.interrupted)).toHaveLength(1);
    expect(events.find(e => e.kind === "result")?.data.text).toBe("used correction");
  });

  it("ordinary send remains queued until the active turn is interrupted", async () => {
    const running = Object.assign([{ type: "thread.started", thread_id: "th-1" }, { type: "turn.started" }], { hang: true });
    const { factory, threads } = fakeCodex([running, ok]);
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), () => {}, async () => true);
    await settle();
    await handle.send("queued input");
    await settle();
    expect(threads[0]!.runs).toHaveLength(1);
    await handle.interrupt();
    await vi.waitFor(() => expect(threads[0]!.runs).toHaveLength(2));
    await handle.kill();
  });

  it("steering an idle persistent session starts a normal turn without interrupting it", async () => {
    const { factory, threads } = fakeCodex([ok]);
    const events: BackendEvent[] = [];
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec({ persistent: true, resumeOnly: true }), e => events.push(e), async () => true);
    await handle.steer!("idle input");
    await vi.waitFor(() => expect(events.some(e => e.kind === "turn_complete")).toBe(true));
    expect(threads[0]!.runs.map(run => run.input)).toEqual(["idle input"]);
    expect(events.some(e => e.data.interrupted)).toBe(false);
    await handle.kill();
    await settle();
    await expect(handle.steer!("too late")).rejects.toThrow("input stream closed");
  });
});


it("waits for cancelled exec cleanup before resuming the same rollout", async () => {
  let releaseExit!: () => void;
  const exited = new Promise<void>(resolve => { releaseExit = resolve; });
  const inputs: unknown[] = [];
  const thread = {
    id: "th-1",
    async runStreamed(input: unknown, opts?: { signal?: AbortSignal }) {
      inputs.push(input);
      const first = inputs.length === 1;
      return { events: (async function* () {
        yield { type: "thread.started", thread_id: "th-1" };
        yield { type: "turn.started" };
        if (first) {
          if (!opts?.signal?.aborted) await new Promise<void>(resolve => opts?.signal?.addEventListener("abort", () => resolve(), { once: true }));
          // Exec may emit a cancellation error before its rollout is flushed.
          yield { type: "error", message: "cancelled" };
          await exited;
          throw new Error("aborted");
        }
        yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
      })() };
    },
  };
  const factory: CodexFactory = () => ({ startThread: () => thread, resumeThread: () => thread });
  const events: BackendEvent[] = [];
  const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(cxSpec(), e => events.push(e), async () => true);
  await settle();
  await handle.steer!("new input");
  await settle();
  expect(inputs).toEqual(["task"]);
  expect(events.some(e => e.kind === "error")).toBe(false);
  releaseExit();
  await vi.waitFor(() => expect(inputs).toEqual(["task", "new input"]));
  await handle.kill();
});

describe("Codex rapid force-sends while the first exec abort is unwinding", () => {
  // First turn only exits after `releaseExit()`, like a real `codex exec` child that is still
  // flushing its rollout. Later turns either complete or hang until aborted.
  function unwindingThread(later: "complete" | "hang") {
    let releaseExit!: () => void;
    const exited = new Promise<void>(resolve => { releaseExit = resolve; });
    const inputs: unknown[] = [];
    const thread = {
      id: "th-1",
      async runStreamed(input: unknown, opts?: { signal?: AbortSignal }) {
        inputs.push(input);
        const first = inputs.length === 1;
        return { events: (async function* () {
          yield { type: "thread.started", thread_id: "th-1" };
          yield { type: "turn.started" };
          if (first || later === "hang") {
            if (!opts?.signal?.aborted) await new Promise<void>(resolve => opts?.signal?.addEventListener("abort", () => resolve(), { once: true }));
            if (first) await exited;
            throw new Error("aborted");
          }
          yield { type: "item.completed", item: { id: `a${inputs.length}`, type: "agent_message", text: `done ${inputs.length}` } };
          yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
        })() };
      },
    };
    const factory: CodexFactory = () => ({ startThread: () => thread, resumeThread: () => thread });
    return { factory, inputs, releaseExit: () => releaseExit() };
  }

  it("delivers A/B/C and a later send exactly once, in order, without a terminal error", async () => {
    const { factory, inputs, releaseExit } = unwindingThread("complete");
    const events: BackendEvent[] = [];
    const handle = new CodexAgentBackend({ codexFactory: factory })
      .spawn(cxSpec({ persistent: true }), e => events.push(e), async () => true);
    await settle();
    await handle.steer!("A");
    await handle.steer!("B");
    await handle.steer!("C");
    await handle.send("later");
    await settle();
    expect(inputs).toEqual(["task"]);
    releaseExit();
    await vi.waitFor(() => expect(inputs.slice(1).join("\n\n")).toBe("A\n\nB\n\nC\n\nlater"));
    await settle();
    expect(inputs[0]).toBe("task");
    // A merged turn and one-turn-per-input are both valid; only order and exactly-once matter.
    expect(inputs.slice(1).join("\n\n")).toBe("A\n\nB\n\nC\n\nlater");
    expect(events.some(e => e.kind === "error")).toBe(false);
    expect(events.filter(e => e.kind === "turn_complete" && e.data.interrupted)).toHaveLength(1);
    await handle.kill();
  });

  it("does not leave a force-send queued behind a turn that is already running", async () => {
    const { factory, inputs, releaseExit } = unwindingThread("hang");
    const handle = new CodexAgentBackend({ codexFactory: factory })
      .spawn(cxSpec({ persistent: true }), () => {}, async () => true);
    await settle();
    await handle.steer!("A");
    await handle.steer!("B");
    await handle.steer!("C");
    releaseExit();
    // The resumed turn hangs until aborted, so B and C can only reach the thread if they were
    // folded into the resumed prompt rather than queued as ordinary FIFO mail behind A.
    await vi.waitFor(() => expect(inputs.slice(1).join("\n\n")).toBe("A\n\nB\n\nC"));
    await handle.kill();
  });

  it("folds an older ordinary send queued ahead of a force-send into the resumed turn", async () => {
    const { factory, inputs, releaseExit } = unwindingThread("hang");
    const handle = new CodexAgentBackend({ codexFactory: factory })
      .spawn(cxSpec({ persistent: true }), () => {}, async () => true);
    await settle();
    // Durable mail is flushed ahead of the force, so the resumed turn would otherwise start with
    // "older" and hang, leaving the force queued behind it.
    await handle.send("older");
    await handle.steer!("force");
    releaseExit();
    await vi.waitFor(() => expect(inputs.slice(1).join("\n\n")).toBe("older\n\nforce"));
    await handle.kill();
  });

  it("folds everything up to the last force-send in order, keeping image attachments and trailing sends queued", async () => {
    const { factory, inputs, releaseExit } = unwindingThread("complete");
    const handle = new CodexAgentBackend({ codexFactory: factory })
      .spawn(cxSpec({ persistent: true }), () => {}, async () => true);
    await settle();
    await handle.steer!("A", [{ mediaType: "image/png", data: "AAAA" }]);
    await handle.steer!("B");
    await handle.send("ordinary");
    await handle.steer!("C");
    await handle.send("trailing");
    releaseExit();
    await vi.waitFor(() => expect(inputs).toHaveLength(3));
    expect(inputs[1]).toEqual([
      { type: "text", text: "A" },
      { type: "local_image", path: expect.stringMatching(/\.png$/) },
      { type: "text", text: "B" },
      { type: "text", text: "ordinary" },
      { type: "text", text: "C" },
    ]);
    expect(inputs[2]).toBe("trailing");
    await handle.kill();
  });

  it("keeps explicit text-only content when merging inputs whose content differs from text", async () => {
    const { factory, inputs, releaseExit } = unwindingThread("hang");
    const handle = new CodexAgentBackend({ codexFactory: factory })
      .spawn(cxSpec({ persistent: true }), () => {}, async () => true);
    await settle();
    await handle.steer!("A (summary)", undefined, [{ type: "text", text: "A (model-visible)" }]);
    await handle.steer!("B");
    releaseExit();
    await vi.waitFor(() => expect(inputs.slice(1)).toEqual(["A (model-visible)\n\nB"]));
    await handle.kill();
  });

  it("never folds a slash command into a force-send turn", async () => {
    const { factory, inputs, releaseExit } = unwindingThread("complete");
    const handle = new CodexAgentBackend({ codexFactory: factory })
      .spawn(cxSpec({ persistent: true }), () => {}, async () => true);
    await settle();
    await handle.send("older");
    await handle.send("/compact now");
    await handle.steer!("force");
    releaseExit();
    // The fold stops in front of the slash command; the force keeps its place behind it.
    await vi.waitFor(() => expect(inputs.slice(1)).toEqual(["older", "/compact now", "force"]));
    await handle.kill();
  });

});
