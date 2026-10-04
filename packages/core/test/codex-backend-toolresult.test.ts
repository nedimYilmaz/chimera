import { describe, it, expect } from "vitest";
import { normalizeCodexEvent } from "@chimera/core/backends/codex";
import { boundToolResultText, toolResultText, TOOL_RESULT_MAX_CHARS } from "@chimera/core/backends/tool-result";

// WD Stage 1 (coverage B4): the codex side of the tool_result-output task, tested
// through the exported pure normalizer. mcp_tool_call now surfaces the SDK's
// McpToolCallItem result payload (result.content text blocks) / error.message as
// bounded `data.result`; command_execution's locked wire shape is pinned unchanged
// (its output already rode `data.output` — the ui-state reducer reads that as the
// fallback, see reducer-toolresult-output-wd.test.ts).

const mcpItem = (over: Record<string, unknown>) => ({
  type: "item.completed",
  item: { id: "m1", type: "mcp_tool_call", server: "chimera", tool: "ask_human", arguments: {}, status: "completed", ...over },
});

describe("codex mcp_tool_call result text (WD Stage 1)", () => {
  it("carries result.content text blocks as bounded data.result", () => {
    const ev = normalizeCodexEvent(mcpItem({
      result: { content: [{ type: "text", text: "the human said yes" }], structured_content: null },
    }) as never);
    expect(ev).toMatchObject({ kind: "tool_result" });
    expect(ev!.data).toEqual({ toolName: "mcp:chimera/ask_human", status: "completed", result: "the human said yes", toolId: "m1", toolUseId: "m1" });
  });

  it("falls back to error.message for a failed call", () => {
    const ev = normalizeCodexEvent(mcpItem({ status: "failed", error: { message: "tool exploded" } }) as never);
    expect(ev!.data).toEqual({ toolName: "mcp:chimera/ask_human", status: "failed", result: "tool exploded", toolId: "m1", toolUseId: "m1" });
  });

  it("REGRESSION: neither result nor error → the historical { toolName, status } data, no result key", () => {
    const ev = normalizeCodexEvent(mcpItem({}) as never);
    expect(ev!.data).toEqual({ toolName: "mcp:chimera/ask_human", status: "completed", toolId: "m1", toolUseId: "m1" });
  });

  it("REGRESSION: command_execution's completed data shape is byte-identical (output field, no result key)", () => {
    const ev = normalizeCodexEvent({
      type: "item.completed",
      item: { id: "i2", type: "command_execution", command: "pnpm test", aggregated_output: "all green", exit_code: 0, status: "completed" },
    } as never);
    expect(ev!.data).toEqual({ toolName: "command_execution", exitCode: 0, output: "all green", toolId: "i2", toolUseId: "i2" });
  });
});

describe("codex file_change / web_search single-shot tool_call+tool_result pairing (BUG: stuck ◑ fix)", () => {
  it("file_change item.completed produces a [tool_call, tool_result] pair; the result marks it completed and lists the changed paths/kinds", () => {
    const ev = {
      type: "item.completed",
      item: {
        id: "fc1", type: "file_change", status: "completed",
        changes: [{ path: "src/ResizableSplit.tsx", kind: "add" }, { path: "src/App.tsx", kind: "update" }],
      },
    };
    const r = normalizeCodexEvent(ev as never);
    expect(Array.isArray(r)).toBe(true);
    const [call, result] = r as [{ kind: string; data: Record<string, unknown> }, { kind: string; data: Record<string, unknown> }];
    expect(call).toMatchObject({ kind: "tool_call", data: { toolName: "file_change" } });
    expect(result).toEqual({
      kind: "tool_result",
      data: { toolName: "file_change", status: "completed", result: "add src/ResizableSplit.tsx\nupdate src/App.tsx", toolId: "fc1", toolUseId: "fc1" },
      raw: ev,
    });
  });

  it("a failed file_change patch still resolves (no stuck running state) and reports status: failed", () => {
    const ev = { type: "item.completed", item: { id: "fc2", type: "file_change", status: "failed", changes: [{ path: "a.ts", kind: "update" }] } };
    const [, result] = normalizeCodexEvent(ev as never) as [unknown, { data: Record<string, unknown> }];
    expect(result.data).toEqual({ toolName: "file_change", status: "failed", result: "update a.ts", toolId: "fc2", toolUseId: "fc2" });
  });

  it("file_change with no changes omits the result key rather than an empty string", () => {
    const ev = { type: "item.completed", item: { id: "fc3", type: "file_change", status: "completed", changes: [] } };
    const [, result] = normalizeCodexEvent(ev as never) as [unknown, { data: Record<string, unknown> }];
    expect(result.data).toEqual({ toolName: "file_change", status: "completed", toolId: "fc3", toolUseId: "fc3" });
  });

  it("item.started/item.updated for file_change are still swallowed (SDK never emits them for this item type)", () => {
    const started = { type: "item.started", item: { id: "fc4", type: "file_change", status: "completed", changes: [] } };
    expect(normalizeCodexEvent(started as never)).toBeNull();
  });

  it("web_search item.completed produces a [tool_call, tool_result] pair so it also resolves instead of sticking", () => {
    const ev = { type: "item.completed", item: { id: "ws1", type: "web_search", query: "zod v3 docs" } };
    const r = normalizeCodexEvent(ev as never);
    expect(r).toEqual([
      { kind: "tool_call", data: { toolName: "web_search", input: { query: "zod v3 docs" }, toolId: "ws1", toolUseId: "ws1" }, raw: ev },
      { kind: "tool_result", data: { toolName: "web_search", toolId: "ws1", toolUseId: "ws1" }, raw: ev },
    ]);
  });
});

describe("toolResultText / boundToolResultText (the shared bound)", () => {
  it("passes a short string through verbatim and truncates a long one with the marker", () => {
    expect(boundToolResultText("short")).toBe("short");
    const bounded = boundToolResultText("y".repeat(TOOL_RESULT_MAX_CHARS + 1));
    expect(bounded).toContain(`[truncated at ${TOOL_RESULT_MAX_CHARS} chars]`);
    expect(bounded.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 100);
  });

  it("normalizes strings, block arrays (text + [type] placeholders) and garbage", () => {
    expect(toolResultText("plain")).toBe("plain");
    expect(toolResultText([{ type: "text", text: "a" }, { type: "resource", uri: "x" }, "raw"])).toBe("a\n[resource]\nraw");
    expect(toolResultText(undefined)).toBe("");
    expect(toolResultText({ not: "content" })).toBe("");
  });
});
