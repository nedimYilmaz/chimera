import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { initialState, reduce, type UiState } from "@chimera/ui-state";

// WD Stage 1 (coverage B4): the tool_result fold's result sources. `data.result` is
// the normalized channel (both backends emit it pre-bounded now); `data.output` is
// codex command_execution's pre-existing field — its wire shape is LOCKED (pinned by
// codex-backend tests), so the projection reads it as the fallback and applies the
// ~16k bound itself.

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);
const toolItem = (st: UiState) => st.agents["a1"]!.transcript[0] as { status: string; result?: string };

describe("reducer tool_result: codex `output` fallback (WD Stage 1)", () => {
  it("populates TranscriptItem.result from a command_execution-shaped tool_result (output field)", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "command_execution", input: { command: "pnpm test" } }),
      ev("a1", "tool_result", { toolName: "command_execution", exitCode: 0, output: "all green" }),
    ]);
    expect(toolItem(st)).toMatchObject({ status: "done", result: "all green" });
  });

  it("`result` wins over `output` when both are present", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "x" }),
      ev("a1", "tool_result", { result: "normalized", output: "raw log" }),
    ]);
    expect(toolItem(st).result).toBe("normalized");
  });

  it("bounds an oversized output at ~16k chars with the truncation marker", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "command_execution" }),
      ev("a1", "tool_result", { output: "z".repeat(20_000) }),
    ]);
    const r = toolItem(st).result!;
    expect(r.length).toBeLessThan(20_000);
    expect(r).toContain("[truncated at 16000 chars]");
  });

  it("REGRESSION: neither result nor output → the item keeps NO result key (unchanged contract)", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "x" }),
      ev("a1", "tool_result", {}),
    ]);
    expect(toolItem(st).status).toBe("done");
    expect("result" in toolItem(st)).toBe(false);
  });
});
