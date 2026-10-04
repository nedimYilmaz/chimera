import { describe, it, expect } from "vitest";
import { initialState, reduce } from "@chimera/ui-state";

describe("parallel tool correlation", () => {
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
