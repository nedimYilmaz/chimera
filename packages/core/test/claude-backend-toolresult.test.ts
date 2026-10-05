import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";
import { TOOL_RESULT_MAX_CHARS } from "@chimera/core/backends/tool-result";

// WD Stage 1 (coverage B4, tool detail card): the claude backend used to emit
// tool_result with EMPTY data ({}). It now carries each user-message tool_result
// block's text as bounded `data.result` plus its tool_use_id as `data.toolId` (the
// ui-state reducer's correlation key) — one event PER BLOCK so parallel tool calls
// resolve to the right transcript items. A user message with no tool_result blocks
// keeps the historical single empty-data event byte-identically.

type Msg = Record<string, unknown>;
function fakeQuery(messages: Msg[]) {
  const fn = ((_args: unknown) => ({
    async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
    interrupt: vi.fn(async () => {}),
  })) as never;
  return fn;
}
function spec(): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none" }),
    agentId: "ag-tr", accountName: "main", resolvedProvider: "claude",
    env: { CHIMERA_AGENT_ID: "ag-tr", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

async function run(messages: Msg[]): Promise<BackendEvent[]> {
  const evs: BackendEvent[] = [];
  new ClaudeAgentBackend({ queryFn: fakeQuery(messages) }).spawn(spec(), (e) => evs.push(e), async () => true);
  await settle();
  return evs;
}

const INIT: Msg = { type: "system", subtype: "init", session_id: "s1", model: "m1" };
const RESULT: Msg = { type: "result", subtype: "success", result: "done", total_cost_usd: 0.01 };
const toolUse = (id: string): Msg => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file: "a.ts" } }] },
});
const userWith = (content: unknown): Msg => ({ type: "user", message: { role: "user", content } });

describe("ClaudeAgentBackend tool_result output (WD Stage 1)", () => {
  it("preserves Claude base64 image results and removes raw duplicate carriers", async () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/codex-image-generation.json", import.meta.url), "utf8"));
    const evs = await run([INIT, toolUse("image-result"), userWith([{ type: "tool_result", tool_use_id: "image-result", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: fixture.result } },
      { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "AAAA" } },
    ] }]), RESULT]);
    const result = evs.find(e => e.kind === "tool_result")!;
    expect(result.data).toMatchObject({ toolId: "image-result", images: [{ mediaType: "image/png", data: fixture.result }], imageOutputWarnings: ["invalid-or-unsupported"] });
    expect(JSON.stringify(result.raw)).not.toContain(fixture.result);
    expect(JSON.stringify(result.raw)).not.toContain("AAAA");
  });

  it("carries a string tool_result block's text as data.result with its tool_use_id as data.toolId", async () => {
    const evs = await run([
      INIT, toolUse("tu1"),
      userWith([{ type: "tool_result", tool_use_id: "tu1", content: "file contents here" }]),
      RESULT,
    ]);
    const call = evs.find((e) => e.kind === "tool_call")!;
    expect(call.data["toolId"]).toBe("tu1");                 // the reducer's correlation key, now on BOTH sides
    expect(call.data["toolUseId"]).toBe("tu1");              // the pre-existing field, untouched
    const res = evs.find((e) => e.kind === "tool_result")!;
    expect(res.data).toEqual({ toolId: "tu1", result: "file contents here" });
  });

  it("joins block-array content: text blocks verbatim, non-text blocks as a [type] placeholder", async () => {
    const evs = await run([
      INIT, toolUse("tu1"),
      userWith([{
        type: "tool_result", tool_use_id: "tu1",
        content: [{ type: "text", text: "line one" }, { type: "image", source: {} }, { type: "text", text: "line two" }],
      }]),
      RESULT,
    ]);
    expect(evs.find((e) => e.kind === "tool_result")!.data["result"]).toBe("line one\n[image]\nline two");
  });

  it("emits ONE tool_result event PER block, so parallel tool calls each get their own result", async () => {
    const evs = await run([
      INIT, toolUse("tu1"), toolUse("tu2"),
      userWith([
        { type: "tool_result", tool_use_id: "tu1", content: "first" },
        { type: "tool_result", tool_use_id: "tu2", content: "second", is_error: true },
      ]),
      RESULT,
    ]);
    const results = evs.filter((e) => e.kind === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0]!.data).toEqual({ toolId: "tu1", result: "first" });
    expect(results[1]!.data).toEqual({ toolId: "tu2", result: "second", isError: true });
  });

  it(`truncates at ${TOOL_RESULT_MAX_CHARS} chars with a visible marker (the documented bound)`, async () => {
    const huge = "x".repeat(TOOL_RESULT_MAX_CHARS + 5_000);
    const evs = await run([
      INIT, toolUse("tu1"),
      userWith([{ type: "tool_result", tool_use_id: "tu1", content: huge }]),
      RESULT,
    ]);
    const result = evs.find((e) => e.kind === "tool_result")!.data["result"] as string;
    expect(result.length).toBeLessThan(huge.length);
    expect(result.startsWith("x".repeat(100))).toBe(true);
    expect(result).toContain(`[truncated at ${TOOL_RESULT_MAX_CHARS} chars]`);
  });

  it("REGRESSION: a user message with NO tool_result blocks keeps the historical single empty-data event", async () => {
    const evs = await run([INIT, userWith([]), RESULT]);
    const results = evs.filter((e) => e.kind === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]!.data).toEqual({});
  });

  it("REGRESSION: an id-less tool_use block still emits tool_call without a toolId key (conditional spread)", async () => {
    const evs = await run([
      INIT,
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: {} }] } },
      RESULT,
    ]);
    const call = evs.find((e) => e.kind === "tool_call")!;
    expect("toolId" in call.data).toBe(false);
  });
});
