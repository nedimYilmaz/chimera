import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce } from "@chimera/ui-state";
import { initialState, type UiState } from "@chimera/ui-state";

// Native-CLI-parity Phase 1 (Task N2): reducer-wiring assertion (test 9 of the
// task brief) -- the pure flow.ts logic itself is covered exhaustively in
// flow-tree-n2.test.ts. This file only asserts the reducer folds agent_task/
// tool_call/tool_result into agentView.flowTree WITHOUT disturbing the
// existing agent.tools/transcript projections (both must be asserted).

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, s?: number): NormalizedEvent =>
  ({ ts: 1000 + (s ?? ++seq), seq: s ?? seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

describe("reducer: agent_task + parented tool_call fold into agentView.flowTree", () => {
  it("test 9: builds the nested flowTree shape while agent.tools/transcript update exactly as before", () => {
    const st = feed(initialState, [
      ev("a1", "agent_task", { toolUseId: "tu_parent", subagentType: "qa" }),
      ev("a1", "tool_call", { toolUseId: "tu_child", parentToolUseId: "tu_parent", toolName: "Read", input: { file: "x.ts" } }),
    ]);
    const agent = st.agents["a1"]!;

    // flowTree: nested shape.
    expect(agent.flowTree).toHaveLength(1);
    expect(agent.flowTree[0]).toMatchObject({ id: "tu_parent", kind: "task", label: "qa" });
    expect(agent.flowTree[0]!.children).toHaveLength(1);
    expect(agent.flowTree[0]!.children[0]).toMatchObject({ id: "tu_child", label: "Read", status: "called" });

    // agent.tools: EXACTLY as before this task (unaffected by flowTree).
    expect(agent.tools).toEqual([{ ts: agent.tools[0]!.ts, toolId: "tu_child", toolName: "Read", input: { file: "x.ts" }, status: "called" }]);

    // transcript: EXACTLY as before (the tool_call still pushes its usual item).
    expect(agent.transcript).toMatchObject([{ role: "tool", toolName: "Read", input: { file: "x.ts" }, status: "called" }]);

    // busy still flips true from the existing tool_call handling (agent_task
    // itself must NOT touch busy).
    expect(agent.busy).toBe(true);
  });

  it("a plain (unparented) agent_task does not affect agent.tools/transcript/busy at all", () => {
    const st = feed(initialState, [ev("a1", "agent_task", { taskId: "T1", workflowName: "build" })]);
    const agent = st.agents["a1"]!;
    expect(agent.flowTree).toHaveLength(1);
    expect(agent.flowTree[0]).toMatchObject({ id: "T1", kind: "workflow", label: "build" });
    expect(agent.tools).toEqual([]);
    expect(agent.transcript).toMatchObject([]);
    expect(agent.busy).toBe(false);
  });

  it("tool_result still patches agent.tools/transcript as before, AND patches the flowTree tool node to done", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolUseId: "tu_x", toolName: "Bash" }),
      ev("a1", "tool_result", { result: "ok" }),
    ]);
    const agent = st.agents["a1"]!;
    expect(agent.tools).toEqual([{ ts: agent.tools[0]!.ts, toolId: "tu_x", toolName: "Bash", status: "done" }]);
    expect(agent.transcript).toMatchObject([{ role: "tool", toolName: "Bash", status: "done", result: "ok" }]);
    expect(agent.flowTree[0]).toMatchObject({ id: "tu_x", status: "done" });
  });

  it("emptyAgent()-seeded agents start with flowTree: []", () => {
    const st = feed(initialState, [ev("a1", "agent_started", { model: "m1" })]);
    expect(st.agents["a1"]!.flowTree).toEqual([]);
  });
});
