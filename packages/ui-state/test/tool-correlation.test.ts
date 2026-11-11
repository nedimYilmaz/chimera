import { describe, it, expect } from "vitest";
import { initialState, reduce } from "@chimera/ui-state";

describe("parallel tool correlation", () => {
  it("operator shell activity does not invent a model turn or complete an unrelated tool", () => {
    let state = reduce(initialState, { type: "event", event: { agentId: "a", seq: 1, ts: 1, kind: "status", data: { state: "running" } } });
    const wasBusy = state.agents.a!.busy;
    state = reduce(state, { type: "event", event: { agentId: "a", seq: 2, ts: 2, kind: "tool_call", data: { toolName: "operator_shell", toolUseId: "shell", operatorInitiated: true } } });
    expect(state.agents.a!.busy).toBe(wasBusy);
    state = reduce(state, { type: "event", event: { agentId: "a", seq: 3, ts: 3, kind: "tool_call", data: { toolName: "model_tool", toolUseId: "model" } } });
    state = reduce(state, { type: "event", event: { agentId: "a", seq: 4, ts: 4, kind: "tool_result", data: { toolUseId: "shell", result: "finished", operatorInitiated: true } } });
    expect(state.agents.a!.tools.map(t => t.status)).toEqual(["done", "called"]);
    expect(state.agents.a!.busy).toBe(true);
  });
  it.each(["toolId", "toolUseId"])("matches out-of-order results across all projections using %s", (key) => {
    let state = initialState;
    let seq = 0;
    const feed = (kind: "tool_call" | "tool_result", id: string) => {
      state = reduce(state, { type: "event", event: { agentId: "a", ts: ++seq, seq, kind, data: { toolName: "same_tool", [key]: id, result: `result ${id}` } } });
    };
    feed("tool_call", "one"); feed("tool_call", "two"); feed("tool_result", "one");
    expect(state.agents.a!.tools.map((t) => t.status)).toEqual(["done", "called"]);
    expect(state.agents.a!.transcript.map((t) => "status" in t ? t.status : null)).toEqual(["done", "called"]);
    expect(state.agents.a!.flowTree.map((t) => t.status)).toEqual(["done", "called"]);
    feed("tool_result", "unknown");
    expect(state.agents.a!.tools.map((t) => t.status)).toEqual(["done", "called"]);
    feed("tool_result", "two");
    expect(state.agents.a!.flowTree.every((t) => t.status === "done")).toBe(true);
  });
});
