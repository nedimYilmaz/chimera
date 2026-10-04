import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSpecSchema } from "@chimera/protocol";
import { GenericAgentBackend, type ChatClient, type ChatStreamEvent, type ChatStreamRequest } from "@chimera/core/backends/generic";
import type { BackendEvent, PermissionDecider, ResolvedAgentSpec } from "@chimera/core/backend";

// MCP-HOST-GENERIC: fakes the MCP SDK's transport-level pieces so the GenericAgentBackend ->
// McpHost wiring can be exercised end-to-end without spawning a real subprocess. Mirrors the
// same mock shape as generic-mcp.test.ts's unit tests, one config per connect() call (in
// Object.entries(specs) order).
const mcpQueue: Array<{
  tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  callToolResult?: unknown;
}> = [];
const mcpMockClients: Array<{ closeCalls: number; calls: unknown[] }> = [];
function enqueueMcpClientConfig(cfg: (typeof mcpQueue)[number]): void {
  mcpQueue.push(cfg);
}
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  class MockClient {
    cfg: (typeof mcpQueue)[number];
    closeCalls = 0;
    calls: unknown[] = [];
    constructor() {
      this.cfg = mcpQueue.shift() ?? {};
      mcpMockClients.push(this as unknown as (typeof mcpMockClients)[number]);
    }
    async connect() {}
    async listTools() {
      return { tools: this.cfg.tools ?? [] };
    }
    async callTool(params: unknown) {
      this.calls.push(params);
      return this.cfg.callToolResult ?? { content: [{ type: "text", text: "ok" }] };
    }
    async close() {
      this.closeCalls++;
    }
  }
  return { Client: MockClient };
});
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  class MockStdioClientTransport {
    constructor(public params: unknown) {}
  }
  return { StdioClientTransport: MockStdioClientTransport };
});

function fakeChatClient(turnScripts: Array<ChatStreamEvent[] & { hang?: boolean }>) {
  const requests: ChatStreamRequest[] = [];
  let turn = 0;
  const client: ChatClient = {
    stream(req) {
      requests.push(req);
      const script = turnScripts[turn++] ?? [];
      return (async function* () {
        for (const ev of script) {
          if (req.signal?.aborted) throw new Error("aborted");
          yield ev;
        }
        if (script.hang) {
          await new Promise<never>((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        }
      })();
    },
  };
  return { client, requests };
}

function genSpec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  const { accountName, env, ...specOver } = over;
  return {
    ...AgentSpecSchema.parse({ prompt: "do the task", cwd: tmpdir(), isolation: "none", ...specOver }),
    agentId: "gen-1", accountName: accountName ?? "gen-main", resolvedProvider: "claude",
    env: env ?? {}, depth: 0,
  } as ResolvedAgentSpec;
}

const allow: PermissionDecider = async () => true;
const settle = () => new Promise((r) => setTimeout(r, 20));
// Poll helper for tests whose margin against a fixed settle() is too tight for real I/O under
// load (mirrors packages/core/test/coord-helpers.ts's waitUntil, not imported directly to keep
// this file's own dependency surface unchanged).
async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
// MCP-layer transports are mocked above, so the in-process chimera bridge never actually
// calls engine.handle() in these tests -- this stub only needs to satisfy the accessor shape.
const fakeEngine = { get: () => ({ handle: async () => ({}) }) };

describe("GenericAgentBackend", () => {
  it("happy path: streams text deltas then completes with usage", async () => {
    const { client } = fakeChatClient([
      [
        { type: "text_delta", text: "Hel" },
        { type: "text_delta", text: "lo" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
        { type: "message_complete", content: "Hello", toolCalls: [] },
      ],
    ]);
    const evs: BackendEvent[] = [];
    new GenericAgentBackend("test-provider", client).spawn(genSpec(), (e) => evs.push(e), allow);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual([
      "agent_started", "message_delta", "message_delta", "message_complete", "turn_complete", "result",
    ]);
    expect(evs[1]!.data).toEqual({ text: "Hel" });
    expect(evs.find((e) => e.kind === "message_complete")!.data).toEqual({ text: "Hello" });
    // R2: sunk in the canonical SNAKE_CASE wire shape (input_tokens/output_tokens) ui-state's
    // extractUsage actually reads — the prior camelCase assertion here was pinning a real bug
    // (extractUsage's `u["input_tokens"]` lookup silently missed the camelCase fields, so every
    // generic/openai-compat agent's tokens/ctx% read 0, always).
    expect(evs.find((e) => e.kind === "turn_complete")!.data).toEqual({ usage: { input_tokens: 10, output_tokens: 5 } });
    // F50: generic computes costUsd from the catalog, never from a provider bill — always estimated.
    expect(evs.at(-1)!.data).toEqual({ text: "Hello", costUsd: 0, costEstimated: true, usage: { input_tokens: 10, output_tokens: 5 } });
  });

  // GENERIC-COST-LEDGER: previously this backend hardcoded costUsd:0 unconditionally, so an
  // openai-compat/gemini-native provider contributed nothing to the usage ledger no matter what
  // pricing was available. A `modelCatalog` accessor (mirroring claude.ts/codex.ts's own DYNAMIC-
  // MODEL-METADATA seam) now lets a priced model's real cost through; two round-trips (one
  // tool-call turn, one final turn) must SUM rather than overwrite, since this backend resends
  // the full context on every call and bills each turn separately.
  it("computes real cost from a modelCatalog when the model has a priced row, summed across turns", async () => {
    const { client } = fakeChatClient([
      [
        { type: "usage", usage: { inputTokens: 1_000_000, outputTokens: 0 } },
        { type: "message_complete", content: "", toolCalls: [{ id: "1", name: "read_file", arguments: "{}" }] },
      ],
      [
        { type: "usage", usage: { inputTokens: 0, outputTokens: 1_000_000 } },
        { type: "message_complete", content: "done", toolCalls: [] },
      ],
    ]);
    const modelCatalog = () => ({
      pricing: (model: string) => (model === "priced-model" ? { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 } : undefined),
      contextWindow: () => undefined,
    });
    const evs: BackendEvent[] = [];
    new GenericAgentBackend("test-provider", client, {}, undefined, modelCatalog).spawn(
      genSpec({ model: "priced-model" }), (e) => evs.push(e), allow,
    );
    await waitUntil(() => evs.at(-1)?.kind === "result");
    // $3/MTok input * 1M + $15/MTok output * 1M = $18 total across the two turns.
    expect(evs.at(-1)!.data).toEqual({ text: "done", costUsd: 18, costEstimated: true, usage: { input_tokens: 0, output_tokens: 1_000_000 } });
  });

  describe("TRUNCATION-SURFACE: finish_reason length", () => {
    it("a message_complete with finishReason \"length\" fails the turn instead of emitting result", async () => {
      const { client } = fakeChatClient([
        [{ type: "message_complete", content: "partial output cut off mid", toolCalls: [], finishReason: "length" }],
      ]);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client).spawn(genSpec(), (e) => evs.push(e), allow);
      await settle();
      expect(evs.some((e) => e.kind === "result")).toBe(false);
      const errorEv = evs.find((e) => e.kind === "error");
      expect(errorEv).toBeDefined();
      expect(String(errorEv!.data["message"])).toMatch(/truncated/i);
    });

    it("a truncated turn with partial tool-call JSON still fails loudly instead of silently coercing args to {}", async () => {
      const { client } = fakeChatClient([
        [{ type: "message_complete", content: "", toolCalls: [{ id: "1", name: "write_file", arguments: '{"path":"x.txt","content":"unterm' }], finishReason: "length" }],
      ]);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client).spawn(genSpec(), (e) => evs.push(e), allow);
      await settle();
      expect(evs.some((e) => e.kind === "tool_call")).toBe(false);
      expect(evs.some((e) => e.kind === "result")).toBe(false);
      expect(evs.some((e) => e.kind === "error")).toBe(true);
    });

    it("finishReason \"stop\" (or absent) is unaffected — still completes normally", async () => {
      const { client } = fakeChatClient([
        [{ type: "message_complete", content: "all good", toolCalls: [], finishReason: "stop" }],
      ]);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client).spawn(genSpec(), (e) => evs.push(e), allow);
      await settle();
      expect(evs.at(-1)!.data).toMatchObject({ text: "all good" });
    });

    it("consults modelCatalog.maxOutputTokens() for the per-model ceiling, falling back to the default when unknown", async () => {
      const { client, requests } = fakeChatClient([
        [{ type: "message_complete", content: "ok", toolCalls: [] }],
      ]);
      const modelCatalog = () => ({
        pricing: () => undefined,
        contextWindow: () => undefined,
        maxOutputTokens: (model: string) => (model === "glm-5.2" ? 65_536 : undefined),
      });
      new GenericAgentBackend("test-provider", client, {}, undefined, modelCatalog).spawn(
        genSpec({ model: "glm-5.2" }), () => {}, allow,
      );
      await settle();
      expect(requests[0]!.maxTokens).toBe(65_536);
    });
  });

  describe("TRUNCATION-IS-TURN-LEVEL-FOR-A-LIVE-SESSION", () => {
    it("a conductor survives a truncated turn: a system transcript notice, no error, session still takes the next turn", async () => {
      const { client, requests } = fakeChatClient([
        [{ type: "message_complete", content: "half a thought", toolCalls: [], finishReason: "length" }],
        [{ type: "message_complete", content: "recovered", toolCalls: [] }],
      ]);
      const evs: BackendEvent[] = [];
      const handle = new GenericAgentBackend("test-provider", client).spawn(
        genSpec({ conductor: true }), (e) => evs.push(e), allow,
      );

      await settle();
      // NOT an error event — that is terminal (supervisor.onError + the ui-state reducer both
      // commit "failed"), which would kill a healthy long-lived session over one bad round-trip.
      expect(evs.some((e) => e.kind === "error")).toBe(false);
      const notice = evs.find((e) => e.kind === "message_complete" && e.data["role"] === "system");
      expect(String(notice!.data["text"])).toMatch(/truncated/i);
      expect(evs.find((e) => e.kind === "turn_complete")!.data["truncated"]).toBe(true);

      await handle.send("try again, shorter");
      await settle();
      expect(requests).toHaveLength(2);
      // the partial text stays in history so the next turn has context, but the truncated turn
      // never produced tool calls to replay
      expect(requests[1]!.messages).toContainEqual({ role: "assistant", content: "half a thought" });
      expect(evs.some((e) => e.kind === "result")).toBe(false);

      await handle.close?.();
      await settle();
      expect(evs.at(-1)!.kind).toBe("result");
      expect(evs.at(-1)!.data["text"]).toBe("recovered");
    });

    it("a truncated turn's tool calls are never executed, even on a surviving session", async () => {
      const { client } = fakeChatClient([
        [{ type: "message_complete", content: "", toolCalls: [{ id: "1", name: "write_file", arguments: '{"path":"x.txt","content":"unterm' }], finishReason: "length" }],
      ]);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client).spawn(genSpec({ persistent: true }), (e) => evs.push(e), allow);
      await settle();
      expect(evs.some((e) => e.kind === "tool_call")).toBe(false);
      expect(evs.some((e) => e.kind === "error")).toBe(false);
      expect(evs.find((e) => e.kind === "turn_complete")!.data["truncated"]).toBe(true);
    });

    it("a ONE-SHOT agent still fails fatally — there is no live session to surface a turn-level notice in", async () => {
      const { client } = fakeChatClient([
        [{ type: "message_complete", content: "cut off", toolCalls: [], finishReason: "length" }],
      ]);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client).spawn(genSpec(), (e) => evs.push(e), allow);
      await settle();
      expect(evs.some((e) => e.kind === "error")).toBe(true);
      expect(evs.some((e) => e.kind === "result")).toBe(false);
    });
  });

  it("keeps a conductor session open after each turn and emits result only after close()", async () => {
    const { client, requests } = fakeChatClient([
      [{ type: "message_complete", content: "first", toolCalls: [] }],
      [{ type: "message_complete", content: "second", toolCalls: [] }],
    ]);
    const evs: BackendEvent[] = [];
    const handle = new GenericAgentBackend("test-provider", client).spawn(
      genSpec({ conductor: true }),
      (e) => evs.push(e),
      allow,
    );

    await settle();
    expect(requests).toHaveLength(1);
    expect(evs.filter((e) => e.kind === "turn_complete")).toHaveLength(1);
    expect(evs.some((e) => e.kind === "result")).toBe(false);

    await handle.send("follow up");
    await settle();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages).toContainEqual({ role: "user", content: "follow up" });
    expect(evs.filter((e) => e.kind === "turn_complete")).toHaveLength(2);
    expect(evs.some((e) => e.kind === "result")).toBe(false);

    await handle.close?.();
    await settle();
    expect(evs.at(-1)?.kind).toBe("result");
  });

  it("a persistent conductor's resumeOnly reattach skips the original prompt and idles until send() (CR1 parity)", async () => {
    const { client, requests } = fakeChatClient([
      [{ type: "message_complete", content: "resumed", toolCalls: [] }],
    ]);
    const evs: BackendEvent[] = [];
    const handle = new GenericAgentBackend("test-provider", client).spawn(
      genSpec({ conductor: true, resumeOnly: true }),
      (e) => evs.push(e),
      allow,
    );

    await settle();
    expect(requests).toHaveLength(0);            // nothing queued: the original prompt is not replayed
    expect(evs.some((e) => e.kind === "result")).toBe(false);   // keepAlive: idles instead of finishing

    await handle.send("hi");
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages).toContainEqual({ role: "user", content: "hi" });
  });

  // R2 (ctx meter): usage is a PER-TURN snapshot (mirrors codex-backend.test.ts's own
  // "the result event's usage is the LAST of three turns, not the first and not their sum" —
  // same class of bug, this backend's own hand-rolled accumulator had it too until this fix).
  // Uses tool-call round-trips (not send()) to get multiple physical LLM calls within ONE
  // spawn: this backend is one-shot (a naturally-completed turn ends the whole run — only a
  // tool round-trip or a mid-stream interrupt keeps the loop alive for another round-trip), so
  // a tool call is the natural way to exercise "usage across several round-trips in one run".
  it("usage is a PER-TURN snapshot, not summed across round-trips — two round-trips reporting the SAME usage must not double", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-backend-"));
    const file = join(dir, "hello.txt");
    writeFileSync(file, "world", "utf8");
    const { client } = fakeChatClient([
      [
        { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } },
        { type: "message_complete", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: file }) }] },
      ],
      [
        { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } },
        { type: "message_complete", content: "done reading", toolCalls: [] },
      ],
    ]);
    const evs: BackendEvent[] = [];
    new GenericAgentBackend("test-provider", client).spawn(genSpec({ cwd: dir }), (e) => evs.push(e), allow);
    await waitUntil(() => evs.some((e) => e.kind === "result"));
    // a still-accumulating implementation would wrongly report {input_tokens:200, output_tokens:20} here.
    const result = evs.find((e) => e.kind === "result")!;
    expect(result.data["usage"]).toEqual({ input_tokens: 100, output_tokens: 10 });
  });

  it("a later round-trip's SMALLER usage (simulating compactMessages() having shrunk the context) is reflected as-is, never clamped to the max seen so far", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-backend-"));
    const file = join(dir, "hello.txt");
    writeFileSync(file, "world", "utf8");
    const { client } = fakeChatClient([
      [
        { type: "usage", usage: { inputTokens: 100_000, outputTokens: 50 } },
        { type: "message_complete", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: file }) }] },
      ],
      [
        { type: "usage", usage: { inputTokens: 150_000, outputTokens: 50 } },
        { type: "message_complete", content: "", toolCalls: [{ id: "c2", name: "read_file", arguments: JSON.stringify({ path: file }) }] },
      ],
      [
        { type: "usage", usage: { inputTokens: 20_000, outputTokens: 50 } },   // compaction shrank the context
        { type: "message_complete", content: "done", toolCalls: [] },
      ],
    ]);
    const evs: BackendEvent[] = [];
    new GenericAgentBackend("test-provider", client).spawn(genSpec({ cwd: dir }), (e) => evs.push(e), allow);
    await waitUntil(() => evs.some((e) => e.kind === "result"));
    const result = evs.find((e) => e.kind === "result")!;
    expect(result.data["usage"]).toEqual({ input_tokens: 20_000, output_tokens: 50 });
  });

  // MODEL-ACTUAL-SURFACE: a chat transport (e.g. z.ai via the openai-compat adapter) can echo
  // back a served model that differs from the requested one — forwarded on message_complete so
  // the reducer's existing MODEL-LIVE fold (packages/ui-state/src/reducer.ts) picks it up.
  it("forwards the served model on message_complete when the chat client reports one", async () => {
    const { client } = fakeChatClient([
      [{ type: "message_complete", content: "hi", toolCalls: [], model: "glm-5.2" }],
    ]);
    const evs: BackendEvent[] = [];
    new GenericAgentBackend("test-provider", client).spawn(genSpec(), (e) => evs.push(e), allow);
    await settle();
    expect(evs.find((e) => e.kind === "message_complete")!.data).toEqual({ text: "hi", model: "glm-5.2" });
  });

  it("omits model from message_complete when the chat client reports none", async () => {
    const { client } = fakeChatClient([
      [{ type: "message_complete", content: "hi", toolCalls: [] }],
    ]);
    const evs: BackendEvent[] = [];
    new GenericAgentBackend("test-provider", client).spawn(genSpec(), (e) => evs.push(e), allow);
    await settle();
    expect(evs.find((e) => e.kind === "message_complete")!.data).toEqual({ text: "hi" });
  });

  it("tool_call -> execute -> loop: reads a real file then finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-backend-"));
    const file = join(dir, "hello.txt");
    writeFileSync(file, "world", "utf8");
    const { client } = fakeChatClient([
      [{ type: "message_complete", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: file }) }] }],
      [{ type: "message_complete", content: "done reading", toolCalls: [] }],
    ]);
    const evs: BackendEvent[] = [];
    new GenericAgentBackend("test-provider", client).spawn(genSpec({ cwd: dir }), (e) => evs.push(e), allow);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "tool_call", "tool_result", "message_complete", "turn_complete", "result"]);
    expect(evs[1]!.data).toMatchObject({ toolName: "read_file", input: { path: file } });
    expect(evs[2]!.data).toMatchObject({ toolName: "read_file", result: "world" });
    expect(evs.at(-1)!.data).toMatchObject({ text: "done reading" });
  });

  it("tool_call -> execute -> loop: writes then edits a real file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-backend-"));
    const file = join(dir, "out.txt");
    const { client } = fakeChatClient([
      [{ type: "message_complete", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: file, content: "foo bar" }) }] }],
      [{ type: "message_complete", content: "", toolCalls: [{ id: "c2", name: "edit_file", arguments: JSON.stringify({ path: file, oldText: "bar", newText: "baz" }) }] }],
      [{ type: "message_complete", content: "done", toolCalls: [] }],
    ]);
    const evs: BackendEvent[] = [];
    new GenericAgentBackend("test-provider", client).spawn(genSpec({ cwd: dir }), (e) => evs.push(e), allow);
    // Two REAL fs round-trips (write_file, edit_file) across three turns — poll for the run's
    // own terminal "result" instead of a fixed settle() wait, which is too tight a margin for
    // real disk I/O under load (matches TOKEN-OPT-P3's precedent for this exact flake class).
    await waitUntil(() => evs.some((e) => e.kind === "result"));
    expect(readFileSync(file, "utf8")).toBe("foo baz");
    const results = evs.filter((e) => e.kind === "tool_result");
    expect(results.every((r) => (r.data as { isError?: boolean }).isError === undefined)).toBe(true);
  });

  it("permission denial surfaces as a tool_result error and the loop continues", async () => {
    const deny: PermissionDecider = async () => false;
    const { client } = fakeChatClient([
      [{ type: "message_complete", content: "", toolCalls: [{ id: "c1", name: "bash", arguments: JSON.stringify({ command: "echo hi" }) }] }],
      [{ type: "message_complete", content: "finished anyway", toolCalls: [] }],
    ]);
    const evs: BackendEvent[] = [];
    new GenericAgentBackend("test-provider", client).spawn(genSpec(), (e) => evs.push(e), deny);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "tool_call", "tool_result", "message_complete", "turn_complete", "result"]);
    expect(evs[2]!.data).toMatchObject({ toolName: "bash", isError: true, result: "denied by chimera permission policy" });
    expect(evs.at(-1)!.data).toMatchObject({ text: "finished anyway" });
  });

  it("readOnly profile denies bash locally, without ever consulting decidePermission", async () => {
    const decide = vi.fn(async () => true);
    const { client } = fakeChatClient([
      [{ type: "message_complete", content: "", toolCalls: [{ id: "c1", name: "bash", arguments: JSON.stringify({ command: "rm -rf /" }) }] }],
      [{ type: "message_complete", content: "ok", toolCalls: [] }],
    ]);
    const evs: BackendEvent[] = [];
    new GenericAgentBackend("test-provider", client).spawn(genSpec({ permissionProfile: "readOnly" }), (e) => evs.push(e), decide);
    await settle();
    const toolResult = evs.find((e) => e.kind === "tool_result")!;
    expect(toolResult.data).toMatchObject({ toolName: "bash", isError: true });
    expect(String((toolResult.data as { result: string }).result)).toContain("readOnly");
    expect(decide).not.toHaveBeenCalled();
  });

  it("readOnly profile still allows read-only tools via decidePermission", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-backend-"));
    const file = join(dir, "hello.txt");
    writeFileSync(file, "world", "utf8");
    const decide = vi.fn(async () => true);
    const { client } = fakeChatClient([
      [{ type: "message_complete", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: file }) }] }],
      [{ type: "message_complete", content: "ok", toolCalls: [] }],
    ]);
    const evs: BackendEvent[] = [];
    new GenericAgentBackend("test-provider", client).spawn(genSpec({ permissionProfile: "readOnly", cwd: dir }), (e) => evs.push(e), decide);
    // waitUntil, not the fixed 20ms settle(): this test does REAL fs I/O (mkdtemp + read_file)
    // behind an async permission decision, and 20ms is not a margin on a loaded machine -- it
    // failed deterministically under parallel agent load, not intermittently.
    await waitUntil(() => evs.some((e) => e.kind === "tool_result"));
    expect(evs.find((e) => e.kind === "tool_result")!.data).toMatchObject({ result: "world" });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("interrupt mid-stream: emits turn_complete{interrupted:true} then resumes on the next send", async () => {
    const turn1 = Object.assign([{ type: "text_delta" as const, text: "thinking" }], { hang: true });
    const { client } = fakeChatClient([turn1, [{ type: "message_complete", content: "resumed", toolCalls: [] }]]);
    const evs: BackendEvent[] = [];
    const handle = new GenericAgentBackend("test-provider", client).spawn(genSpec(), (e) => evs.push(e), allow);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "message_delta"]);
    await handle.interrupt();
    await settle();
    expect(evs.map((e) => e.kind)).toContain("turn_complete");
    expect(evs.find((e) => e.kind === "turn_complete")!.data).toEqual({ interrupted: true });
    await handle.send("keep going");
    await settle();
    expect(evs.at(-1)!.data).toMatchObject({ text: "resumed" });
  });

  it("kill() stops the loop and emits no further events", async () => {
    const turn1 = Object.assign([{ type: "text_delta" as const, text: "..." }], { hang: true });
    const { client } = fakeChatClient([turn1]);
    const evs: BackendEvent[] = [];
    const handle = new GenericAgentBackend("test-provider", client).spawn(genSpec(), (e) => evs.push(e), allow);
    await settle();
    await handle.kill();
    await settle();
    const countAfterKill = evs.length;
    await settle();
    expect(evs.length).toBe(countAfterKill);
    expect(evs.some((e) => e.kind === "result" || e.kind === "error")).toBe(false);
  });

  describe("R2-TURN-LIFECYCLE: idle/max-duration watchdog", () => {
    it("idle timeout mid-stream emits turn_timeout and ends the run with no result event", async () => {
      const turn1 = Object.assign([{ type: "text_delta" as const, text: "thinking" }], { hang: true });
      const { client } = fakeChatClient([turn1]);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client).spawn(genSpec({ idleTimeoutMs: 20 }), (e) => evs.push(e), allow);
      await settle();
      await new Promise((r) => setTimeout(r, 40));
      expect(evs.map((e) => e.kind)).toContain("turn_timeout");
      const timeoutEv = evs.find((e) => e.kind === "turn_timeout")!;
      expect(timeoutEv.data).toMatchObject({ reason: "idle", idleTimeoutMs: 20 });
      expect(evs.some((e) => e.kind === "result")).toBe(false);
    });

    it("max-duration timeout fires even while the stream keeps emitting text_delta events", async () => {
      const events: ChatStreamEvent[] = Array.from({ length: 200 }, () => ({ type: "text_delta" as const, text: "x" }));
      const client: ChatClient = {
        stream(req) {
          return (async function* () {
            for (const ev of events) {
              if (req.signal?.aborted) throw new Error("aborted");
              await new Promise((r) => setTimeout(r, 2));
              yield ev;
            }
          })();
        },
      };
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client).spawn(genSpec({ maxTurnDurationMs: 20 }), (e) => evs.push(e), allow);
      await new Promise((r) => setTimeout(r, 80));
      expect(evs.map((e) => e.kind)).toContain("turn_timeout");
      const timeoutEv = evs.find((e) => e.kind === "turn_timeout")!;
      expect(timeoutEv.data).toMatchObject({ reason: "max-duration", maxTurnDurationMs: 20 });
      expect(evs.some((e) => e.kind === "result")).toBe(false);
    });

    it("unset idleTimeoutMs/maxTurnDurationMs (default) leaves the interrupt/kill paths byte-identical", async () => {
      // Regression guard: the two tests above prove TurnController fires when armed; this proves
      // it stays fully inert for the pre-existing default (no spec override) case — same
      // interrupt-mid-stream scenario as the un-watchdogged test above, no turn_timeout expected.
      const turn1 = Object.assign([{ type: "text_delta" as const, text: "thinking" }], { hang: true });
      const { client } = fakeChatClient([turn1, [{ type: "message_complete", content: "resumed", toolCalls: [] }]]);
      const evs: BackendEvent[] = [];
      const handle = new GenericAgentBackend("test-provider", client).spawn(genSpec(), (e) => evs.push(e), allow);
      await settle();
      await handle.interrupt();
      await settle();
      expect(evs.some((e) => e.kind === "turn_timeout")).toBe(false);
      expect(evs.map((e) => e.kind)).toContain("turn_complete");
    });
  });

  describe("GENERIC-SPAWN-CREDENTIAL: threads spec.env[envVar] into the ChatClient as a per-spawn apiKey", () => {
    it("passes spec.env[envVar] and spec.accountName through to every stream() call", async () => {
      const { client, requests } = fakeChatClient([
        [{ type: "message_complete", content: "ok", toolCalls: [] }],
      ]);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("zai-coding", client, { envVar: "ZAI_CODING_PLAN_API_KEY" }).spawn(
        genSpec({ accountName: "glm", env: { ZAI_CODING_PLAN_API_KEY: "zai-secret-key" } }),
        (e) => evs.push(e),
        allow,
      );
      await settle();
      expect(requests[0]!.apiKey).toBe("zai-secret-key");
      expect(requests[0]!.accountName).toBe("glm");
    });

    it("omits apiKey when the backend has no envVar configured (e.g. tests, or a caller that never resolves a credential)", async () => {
      const { client, requests } = fakeChatClient([
        [{ type: "message_complete", content: "ok", toolCalls: [] }],
      ]);
      new GenericAgentBackend("test-provider", client).spawn(genSpec({ env: { SOMETHING_ELSE: "x" } }), () => {}, allow);
      await settle();
      expect(requests[0]!.apiKey).toBeUndefined();
    });

    it("omits apiKey when envVar is configured but absent from spec.env (falls back to the ChatClient's own construction-time key)", async () => {
      const { client, requests } = fakeChatClient([
        [{ type: "message_complete", content: "ok", toolCalls: [] }],
      ]);
      new GenericAgentBackend("zai-coding", client, { envVar: "ZAI_CODING_PLAN_API_KEY" }).spawn(genSpec({ env: {} }), () => {}, allow);
      await settle();
      expect(requests[0]!.apiKey).toBeUndefined();
    });
  });

  describe("TOKEN-OPT-P3: max_tokens cap + messages[] compaction", () => {
    it("sends a max_tokens cap on every stream() call", async () => {
      const { client, requests } = fakeChatClient([
        [{ type: "message_complete", content: "ok", toolCalls: [] }],
      ]);
      new GenericAgentBackend("test-provider", client).spawn(genSpec(), () => {}, allow);
      await settle();
      expect(requests[0]!.maxTokens).toBeGreaterThan(0);
    });

    it("a 40-round-trip run (default maxTurns) never re-sends an unbounded messages[] and never orphans a tool call", async () => {
      const dir = mkdtempSync(join(tmpdir(), "gen-backend-compaction-"));
      // pad every round's assistant text so the running total blows past compaction's default
      // char budget well before round 40, forcing at least one real compaction mid-run.
      const pad = "x".repeat(3000);
      const scripts: ChatStreamEvent[][] = [];
      for (let i = 0; i < 39; i++) {
        scripts.push([{ type: "message_complete", content: pad, toolCalls: [{ id: `c${i}`, name: "list_dir", arguments: JSON.stringify({ path: dir }) }] }]);
      }
      scripts.push([{ type: "message_complete", content: "done", toolCalls: [] }]);

      const { client, requests } = fakeChatClient(scripts);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client).spawn(genSpec({ cwd: dir }), (e) => evs.push(e), allow);
      // 40 real sequential round-trips (each doing a real fs.readdir) can outlast a single
      // fixed 20ms settle() under load -- poll for the terminal "result" event instead.
      for (let i = 0; i < 100 && !evs.some((e) => e.kind === "result"); i++) await settle();

      expect(evs.at(-1)!.data).toMatchObject({ text: "done" });
      expect(requests.length).toBe(40);

      // the LAST request (round 40) is the worst case for an unbounded array -- assert it
      // stayed near the configured compaction window (~20 recent rounds), not anywhere close
      // to what 39 uncompacted tool round-trips (each ~3000+ chars, ~117k total) would send.
      const lastReq = requests.at(-1)!;
      const lastReqChars = lastReq.messages.reduce((n, m) => n + ((m as { content?: string | null }).content?.length ?? 0), 0);
      expect(lastReqChars).toBeLessThan(90_000);
      expect(lastReqChars).toBeLessThan(39 * pad.length);

      // no request ever contains an assistant tool call with no matching tool result later in
      // the same array (compaction only ever drops/collapses WHOLE rounds, never splits one).
      for (const req of requests) {
        for (let i = 0; i < req.messages.length; i++) {
          const m = req.messages[i]!;
          if (m.role !== "assistant" || !m.toolCalls?.length) continue;
          const answered = new Set<string>();
          for (let j = i + 1; j < req.messages.length && req.messages[j]!.role === "tool"; j++) {
            answered.add((req.messages[j] as { toolCallId: string }).toolCallId);
          }
          for (const tc of m.toolCalls) expect(answered.has(tc.id)).toBe(true);
        }
      }
    });
  });

  // COMPACTION-OBSERVABILITY: the "compaction" event — fires with correct before/after when a
  // budget-triggered pass actually drops rounds, never fires when the run stays under budget,
  // and the manual trigger (handle.compact()) applies immediately when idle, queues instead of
  // racing a request when a turn is in flight, and is a no-op when nothing is droppable.
  describe("COMPACTION-OBSERVABILITY", () => {
    it("emits a compaction event with correct before/after when the budget is crossed", async () => {
      const dir = mkdtempSync(join(tmpdir(), "gen-backend-compaction-event-"));
      const pad = "x".repeat(3000);
      const scripts: ChatStreamEvent[][] = [];
      for (let i = 0; i < 39; i++) {
        scripts.push([{ type: "message_complete", content: pad, toolCalls: [{ id: `c${i}`, name: "list_dir", arguments: JSON.stringify({ path: dir }) }] }]);
      }
      scripts.push([{ type: "message_complete", content: "done", toolCalls: [] }]);
      const { client } = fakeChatClient(scripts);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client).spawn(genSpec({ cwd: dir }), (e) => evs.push(e), allow);
      for (let i = 0; i < 100 && !evs.some((e) => e.kind === "result"); i++) await settle();

      const compactions = evs.filter((e) => e.kind === "compaction");
      expect(compactions.length).toBeGreaterThan(0);
      const data = compactions[0]!.data;
      expect(data).toMatchObject({ trigger: "budget", owner: "chimera", budgetSource: "default" });
      const before = data["before"] as { messages: number; chars: number };
      const after = data["after"] as { messages: number; chars: number };
      expect(before.chars).toBeGreaterThan(after.chars);
      expect(before.messages).toBeGreaterThan(after.messages);
      expect(data["droppedRounds"]).toBeGreaterThan(0);
    });

    it("does not emit a compaction event when the run stays under budget", async () => {
      const { client } = fakeChatClient([[{ type: "message_complete", content: "ok", toolCalls: [] }]]);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client).spawn(genSpec(), (e) => evs.push(e), allow);
      await settle();
      expect(evs.some((e) => e.kind === "compaction")).toBe(false);
    });

    it("manual compact() applies immediately while idle and reports the real before/after", async () => {
      // TOOL_ROUNDS tool-call round-trips chain automatically (no manual send() needed between
      // them, unlike a plain no-tool-call turn) -- +1 initial user round puts total rounds well
      // past DEFAULT_COMPACTION_KEEP_ROUNDS (20) so something is droppable, but small per-round
      // content keeps the total well under the char budget -- nothing auto-triggers, only the
      // manual force does.
      const dir = mkdtempSync(join(tmpdir(), "gen-backend-compaction-manual-"));
      const TOOL_ROUNDS = 24;
      const scripts: ChatStreamEvent[][] = [];
      for (let i = 0; i < TOOL_ROUNDS; i++) {
        scripts.push([{ type: "message_complete", content: `t${i}`, toolCalls: [{ id: `c${i}`, name: "list_dir", arguments: JSON.stringify({ path: dir }) }] }]);
      }
      scripts.push([{ type: "message_complete", content: "done", toolCalls: [] }]);
      const { client } = fakeChatClient(scripts);
      const evs: BackendEvent[] = [];
      const handle = new GenericAgentBackend("test-provider", client).spawn(genSpec({ cwd: dir, persistent: true }), (e) => evs.push(e), allow);
      for (let i = 0; i < 200 && !evs.some((e) => e.kind === "turn_complete"); i++) await settle();
      expect(evs.some((e) => e.kind === "compaction")).toBe(false);   // confirms nothing auto-triggered

      const result = await handle.compact!();

      expect(result.ok).toBe(true);
      expect(result.before!.messages!).toBeGreaterThan(result.after!.messages!);
      const compaction = evs.find((e) => e.kind === "compaction");
      expect(compaction?.data).toMatchObject({ trigger: "manual", owner: "chimera" });
      expect((compaction!.data["droppedRounds"] as number)).toBeGreaterThan(0);

      await handle.kill();
    });

    it("manual compact() returns ok:false without emitting an event when nothing is droppable", async () => {
      const { client } = fakeChatClient([[{ type: "message_complete", content: "ok", toolCalls: [] }]]);
      const evs: BackendEvent[] = [];
      const handle = new GenericAgentBackend("test-provider", client).spawn(genSpec({ persistent: true }), (e) => evs.push(e), allow);
      for (let i = 0; i < 50 && !evs.some((e) => e.kind === "turn_complete"); i++) await settle();

      const result = await handle.compact!();

      expect(result).toEqual({ ok: false, message: "nothing to compact — history is already within the protected recent-rounds window" });
      expect(evs.some((e) => e.kind === "compaction")).toBe(false);

      await handle.kill();
    });

    it("manual compact() queues (does not mutate messages[] mid-flight) while a turn is in flight, then applies at the next round-trip boundary", async () => {
      // TOOL_ROUNDS tool-call round-trips build up droppable history automatically, then the
      // NEXT round-trip (the hang script) starts right after the last tool result is pushed --
      // no manual send() needed, since a tool-call turn never sets awaitingUserInput.
      const dir = mkdtempSync(join(tmpdir(), "gen-backend-compaction-queue-"));
      const TOOL_ROUNDS = 24;
      const scripts: (ChatStreamEvent[] & { hang?: boolean })[] = [];
      for (let i = 0; i < TOOL_ROUNDS; i++) {
        scripts.push([{ type: "message_complete", content: `t${i}`, toolCalls: [{ id: `c${i}`, name: "list_dir", arguments: JSON.stringify({ path: dir }) }] }]);
      }
      const hangScript: ChatStreamEvent[] & { hang?: boolean } = [];
      hangScript.hang = true;
      scripts.push(hangScript);
      scripts.push([{ type: "message_complete", content: "after resume", toolCalls: [] }]);

      const { client } = fakeChatClient(scripts);
      const evs: BackendEvent[] = [];
      const handle = new GenericAgentBackend("test-provider", client).spawn(genSpec({ cwd: dir, persistent: true }), (e) => evs.push(e), allow);
      // wait until all TOOL_ROUNDS tool round-trips have landed -- the hang round is already
      // streaming (turnInFlight:true) by the time the last tool_result appears.
      for (let i = 0; i < 200 && evs.filter((e) => e.kind === "tool_result").length < TOOL_ROUNDS; i++) await settle();
      await settle();

      const queued = await handle.compact!();
      expect(queued).toEqual({ ok: true, message: "queued — will run at the next round-trip boundary (a turn is currently in flight)" });
      expect(evs.some((e) => e.kind === "compaction")).toBe(false);   // NOT applied yet -- would race the in-flight request

      await handle.interrupt();
      await settle();
      await handle.send("resume");   // next round-trip boundary -- the deferred forced compaction applies here
      for (let i = 0; i < 200 && !evs.some((e) => e.kind === "compaction"); i++) await settle();

      const compaction = evs.find((e) => e.kind === "compaction");
      expect(compaction?.data).toMatchObject({ trigger: "manual", owner: "chimera" });
      expect((compaction!.data["droppedRounds"] as number)).toBeGreaterThan(0);

      await handle.kill();
    });
  });

  // GENERIC-COMPACTION-WINDOW: the compaction budget must be VISIBLE at runtime (a real window
  // vs the last-resort default guess), not silently blended into one number.
  describe("GENERIC-COMPACTION-WINDOW: compaction budget visibility", () => {
    it("emits a status event with source \"catalog\" when the model has a known window", async () => {
      const { client } = fakeChatClient([[{ type: "message_complete", content: "ok", toolCalls: [] }]]);
      const modelCatalog = () => ({ contextWindow: (m: string) => (m === "small-model" ? 32_000 : undefined), pricing: () => undefined });
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client, {}, undefined, modelCatalog).spawn(
        genSpec({ model: "small-model" }), (e) => evs.push(e), allow,
      );
      await settle();
      const status = evs.find((e) => e.kind === "status" && "compactionBudget" in e.data);
      expect(status?.data).toEqual({ compactionBudget: { charBudget: Math.floor(32_000 * 0.75) * 4, source: "catalog", model: "small-model" } });
    });

    it("emits no compactionBudget status event when no window is reachable (byte-identical to before this field existed)", async () => {
      const { client } = fakeChatClient([[{ type: "message_complete", content: "ok", toolCalls: [] }]]);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client).spawn(genSpec(), (e) => evs.push(e), allow);
      await settle();
      expect(evs.some((e) => e.kind === "status" && "compactionBudget" in e.data)).toBe(false);
      expect(evs.map((e) => e.kind)).toEqual(["agent_started", "message_complete", "turn_complete", "result"]);
    });
  });

  it("capabilities report v1 limits", () => {
    const backend = new GenericAgentBackend("test-provider", fakeChatClient([]).client);
    expect(backend.capabilities).toEqual({ supportsResume: false, supportsMcpServers: true, supportsSettingSources: false, supportsVoiceRealtime: false });
    expect(backend.provider).toBe("test-provider");
  });

  describe("MCP host (MCP-HOST-GENERIC)", () => {
    beforeEach(() => {
      mcpQueue.length = 0;
      mcpMockClients.length = 0;
    });

    it("mcp__chimera__* tools are merged into the tool list and a tool_call to one routes through the MCP host", async () => {
      enqueueMcpClientConfig({
        tools: [{ name: "memory_add", description: "add a memory", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
        callToolResult: { content: [{ type: "text", text: "stored" }] },
      });
      const { client, requests } = fakeChatClient([
        [{ type: "message_complete", content: "", toolCalls: [{ id: "c1", name: "mcp__chimera__memory_add", arguments: JSON.stringify({ text: "hi" }) }] }],
        [{ type: "message_complete", content: "done", toolCalls: [] }],
      ]);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client, {}, fakeEngine).spawn(genSpec({ orchestration: { allow: true, maxDepth: 2 } }), (e) => evs.push(e), allow);
      await settle();
      // the SECOND stream() call (after the tool round-trip) sees the full merged tool list
      expect(requests[1]!.tools.map((t) => t.name)).toContain("mcp__chimera__memory_add");
      const toolResult = evs.find((e) => e.kind === "tool_result")!;
      expect(toolResult.data).toMatchObject({ toolName: "mcp__chimera__memory_add", result: "stored" });
      expect(mcpMockClients[0]!.calls).toEqual([{ name: "memory_add", arguments: { text: "hi" } }]);
    });

    // MCP-FOREIGN-POLICY: a FOREIGN MCP tool is no longer denied locally by the readOnly gate —
    // it now routes through decidePermission (the toolPolicy gate), so a readOnly agent's foreign
    // MCP READ is grantable via config/ask instead of being silently denied. Only MUTATING host
    // tools (bash/write_file/edit_file) still hit readOnly's local outright-deny (asserted in
    // "readOnly profile denies bash locally" above). Contrast with mcp__chimera__* which stays
    // an auto-allow via autoDecision (asserted in the chimera-merge test above).
    it("readOnly routes a foreign MCP server's tool through decidePermission (grantable) — allowed when the policy answers allow", async () => {
      enqueueMcpClientConfig({ tools: [{ name: "do_thing", inputSchema: { type: "object" } }], callToolResult: { content: [{ type: "text", text: "ok-result" }] } });
      const decide = vi.fn(async () => true);
      const { client } = fakeChatClient([
        [{ type: "message_complete", content: "", toolCalls: [{ id: "c1", name: "mcp__myserver__do_thing", arguments: "{}" }] }],
        [{ type: "message_complete", content: "ok", toolCalls: [] }],
      ]);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client).spawn(
        genSpec({ permissionProfile: "readOnly", mcpServers: { myserver: { command: "some-cmd" } } }),
        (e) => evs.push(e),
        decide,
      );
      await settle();
      const toolResult = evs.find((e) => e.kind === "tool_result")!;
      expect(decide).toHaveBeenCalledWith(expect.objectContaining({ toolName: "mcp__myserver__do_thing" }));
      expect(toolResult.data).toMatchObject({ toolName: "mcp__myserver__do_thing", result: "ok-result" });
      expect(toolResult.data).not.toMatchObject({ isError: true });
    });

    it("readOnly foreign MCP tool is denied when decidePermission answers deny (unattended-safe: no local relaxation)", async () => {
      enqueueMcpClientConfig({ tools: [{ name: "do_thing", inputSchema: { type: "object" } }] });
      const decide = vi.fn(async () => false);
      const { client } = fakeChatClient([
        [{ type: "message_complete", content: "", toolCalls: [{ id: "c1", name: "mcp__myserver__do_thing", arguments: "{}" }] }],
        [{ type: "message_complete", content: "ok", toolCalls: [] }],
      ]);
      const evs: BackendEvent[] = [];
      new GenericAgentBackend("test-provider", client).spawn(
        genSpec({ permissionProfile: "readOnly", mcpServers: { myserver: { command: "some-cmd" } } }),
        (e) => evs.push(e),
        decide,
      );
      await settle();
      const toolResult = evs.find((e) => e.kind === "tool_result")!;
      expect(decide).toHaveBeenCalledWith(expect.objectContaining({ toolName: "mcp__myserver__do_thing" }));
      expect(toolResult.data).toMatchObject({ toolName: "mcp__myserver__do_thing", isError: true });
      expect(String((toolResult.data as { result: string }).result)).toContain("denied by chimera permission policy");
    });

    it("kill() tears down the MCP client's subprocess, not just the chat stream", async () => {
      enqueueMcpClientConfig({ tools: [] });
      const turn1 = Object.assign([{ type: "text_delta" as const, text: "..." }], { hang: true });
      const { client } = fakeChatClient([turn1]);
      const handle = new GenericAgentBackend("test-provider", client, {}, fakeEngine).spawn(genSpec({ orchestration: { allow: true, maxDepth: 2 } }), () => {}, allow);
      await settle();
      await handle.kill();
      await settle();
      expect(mcpMockClients[0]!.closeCalls).toBe(1);
    });
  });
});
