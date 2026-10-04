import { expect, it } from "vitest";
import { initialState, reduce } from "@chimera/ui-state";
import type { NormalizedEvent } from "@chimera/protocol";

it("tracks voice turn activity before any message and only patches matching live tools", () => {
  let state = initialState; let seq = 0;
  const feed = (kind: NormalizedEvent["kind"], data: Record<string, unknown>) => {
    state = reduce(state, { type: "event", event: { agentId: "voice", kind, data, seq: ++seq, ts: seq } });
  };
  feed("status", { turnStarted: true, turnId: "t" });
  expect(state.agents.voice).toMatchObject({ busy: true, busySince: 1, transcript: [] });
  feed("tool_call", { toolName: "mcp:docs/search", toolId: "one" });
  feed("tool_call", { toolName: "command_execution", toolId: "two" });
  feed("status", { toolProgress: { toolId: "one", text: "Reading docs" } });
  expect(state.agents.voice!.transcript[0]).toMatchObject({ status: "called", result: "Reading docs" });
  expect(state.agents.voice!.transcript[1]).not.toHaveProperty("result");
  feed("status", { toolProgress: { toolId: "missing", text: "ignored" } });
  feed("status", { toolProgress: { toolId: "one", text: "x".repeat(50_000) } });
  expect(JSON.stringify(state.agents.voice!.transcript[0]).length).toBeLessThan(20_000);
  feed("tool_result", { toolId: "one", result: "Final result" });
  feed("status", { toolProgress: { toolId: "one", text: "late" } });
  expect(state.agents.voice!.transcript[0]).toMatchObject({ status: "done", result: "Final result" });
  expect(state.agents.voice!.busySince).toBe(1);
  feed("turn_complete", {});
  expect(state.agents.voice).toMatchObject({ busy: false, busySince: undefined });
});
