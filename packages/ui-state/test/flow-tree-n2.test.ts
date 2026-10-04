import { describe, it, expect } from "vitest";
import { applyFlowEvent, findFlowNode } from "@chimera/ui-state";
import type { FlowNode } from "@chimera/ui-state";

// Native-CLI-parity Phase 1 (Task N2): pure unit tests for the flowTree
// helpers, isolated from the reducer (see reducer-flowtree-n2.test.ts for the
// reducer-wiring assertion). `ev()` builds the minimal normalized-event shape
// applyFlowEvent consumes: { kind, seq, data }.
let seq = 0;
const ev = (kind: string, data: Record<string, unknown> = {}, s?: number): { kind: string; seq: number; data: Record<string, unknown> } =>
  ({ kind, seq: s ?? ++seq, data });

describe("flow.ts — findFlowNode", () => {
  it("returns null on an empty tree", () => {
    expect(findFlowNode([], "x")).toBeNull();
  });

  it("finds a root node by id", () => {
    const tree: FlowNode[] = [{ id: "a", kind: "tool", label: "Bash", status: "called", children: [] }];
    expect(findFlowNode(tree, "a")).toBe(tree[0]);
  });

  it("finds a deeply nested node (depth-first)", () => {
    const grandchild: FlowNode = { id: "gc", kind: "tool", label: "Read", status: "called", children: [] };
    const child: FlowNode = { id: "c", kind: "tool", label: "Task", status: "called", children: [grandchild] };
    const root: FlowNode = { id: "r", kind: "task", label: "root", status: "running", children: [child] };
    expect(findFlowNode([root], "gc")).toBe(grandchild);
  });

  it("returns null for an id that doesn't exist anywhere in the forest", () => {
    const tree: FlowNode[] = [{ id: "a", kind: "tool", label: "Bash", status: "called", children: [] }];
    expect(findFlowNode(tree, "nope")).toBeNull();
  });
});

describe("flow.ts — applyFlowEvent: agent_task + tool_call node creation", () => {
  it("test 1: a tool_call with toolUseId, no parent -> one root tool node", () => {
    const tree = applyFlowEvent([], ev("tool_call", { toolUseId: "tu_a", toolName: "Bash" }));
    expect(tree).toEqual([{ id: "tu_a", kind: "tool", label: "Bash", status: "called", children: [] }]);
  });

  it("test 2: tool_call (Task) then agent_task with the SAME toolUseId merges into ONE node (upgrade, not duplicate)", () => {
    let tree = applyFlowEvent([], ev("tool_call", { toolUseId: "tu_parent", toolName: "Task" }));
    tree = applyFlowEvent(tree, ev("agent_task", { toolUseId: "tu_parent", subagentType: "qa" }));
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ id: "tu_parent", kind: "task", label: "qa" });
  });

  it("test 3: agent_task (root) then a tool_call parented to it nests as a child", () => {
    let tree = applyFlowEvent([], ev("agent_task", { toolUseId: "tu_parent", subagentType: "qa" }));
    tree = applyFlowEvent(tree, ev("tool_call", { toolUseId: "tu_child", parentToolUseId: "tu_parent", toolName: "Read" }));
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]).toMatchObject({ id: "tu_child", label: "Read", kind: "tool" });
  });

  it("test 4: agent_task with a workflowName (no existing node) creates a root 'workflow' node", () => {
    const tree = applyFlowEvent([], ev("agent_task", { taskId: "W1", workflowName: "build", taskType: "local_workflow" }));
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ id: "W1", kind: "workflow", label: "build" });
  });

  it("fix pass: a status-only agent_task follow-up on a workflow node never downgrades its kind back to 'task'", () => {
    // Regression for review finding #1: task_started {taskId:"W1", workflowName:"build"}
    // establishes a "workflow" node; a later task_updated {taskId:"W1", status:"completed"}
    // carries no workflowName (N1 drops it on updates) and must NOT flip kind back to "task".
    let tree = applyFlowEvent([], ev("agent_task", { taskId: "W1", workflowName: "build" }));
    expect(tree[0]).toMatchObject({ id: "W1", kind: "workflow", label: "build" });
    tree = applyFlowEvent(tree, ev("agent_task", { taskId: "W1", status: "completed" }));
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ id: "W1", kind: "workflow", label: "build", status: "completed" });
  });

  it("test 5: a taskId-only follow-up (no toolUseId) resolves back to the toolUseId-keyed node via the taskId fallback", () => {
    let tree = applyFlowEvent([], ev("agent_task", { taskId: "T1", toolUseId: "tu_p", status: "running" }));
    tree = applyFlowEvent(tree, ev("agent_task", { taskId: "T1", status: "completed" }));
    expect(tree).toHaveLength(1);                 // still ONE node, not a stray second root keyed "T1"
    expect(tree[0]!.id).toBe("tu_p");              // the id stays the original toolUseId key
    expect(tree[0]!.status).toBe("completed");
  });

  it("test 6: tool_call then tool_result marks the tool node 'done'", () => {
    let tree = applyFlowEvent([], ev("tool_call", { toolUseId: "tu_x", toolName: "Bash" }));
    tree = applyFlowEvent(tree, ev("tool_result", {}));
    expect(tree[0]!.status).toBe("done");
  });

  it("test 7: an orphan tool_call (parentToolUseId doesn't resolve) becomes a ROOT, never dropped or thrown", () => {
    const tree = applyFlowEvent([], ev("tool_call", { toolUseId: "tu_orphan", parentToolUseId: "nope", toolName: "Bash" }));
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ id: "tu_orphan" });
  });

  it("test 8: applyFlowEvent returns a NEW array; the input tree reference is unchanged", () => {
    const input: FlowNode[] = [];
    const output = applyFlowEvent(input, ev("tool_call", { toolUseId: "tu_a", toolName: "Bash" }));
    expect(output).not.toBe(input);
    expect(input).toEqual([]); // untouched
  });
});

describe("flow.ts — applyFlowEvent: additional branch/edge coverage", () => {
  it("an unknown event kind leaves the tree unchanged (same reference, no-op)", () => {
    const input: FlowNode[] = [{ id: "a", kind: "tool", label: "Bash", status: "called", children: [] }];
    const output = applyFlowEvent(input, ev("message_delta", { text: "hi" }));
    expect(output).toBe(input);
  });

  it("agent_task with neither taskId nor toolUseId is ignored (nothing to key on)", () => {
    const input: FlowNode[] = [];
    const output = applyFlowEvent(input, ev("agent_task", { subagentType: "qa" }));
    expect(output).toBe(input);
    expect(output).toEqual([]);
  });

  it("agent_task with only a description (no workflowName/subagentType) creates a 'task' node labeled from description", () => {
    const tree = applyFlowEvent([], ev("agent_task", { toolUseId: "tu_d", description: "investigate bug" }));
    expect(tree[0]).toMatchObject({ kind: "task", label: "investigate bug", subLabel: "investigate bug" });
  });

  it("agent_task label fallback chain: no workflowName/subagentType/description falls back to taskId", () => {
    const tree = applyFlowEvent([], ev("agent_task", { taskId: "T9" }));
    expect(tree[0]).toMatchObject({ id: "T9", kind: "task", label: "T9" });
  });

  it("agent_task merge preserves prior subLabel/usage when the follow-up event omits them", () => {
    let tree = applyFlowEvent([], ev("agent_task", { toolUseId: "tu_p", subagentType: "qa", usage: { totalTokens: 42 } }));
    tree = applyFlowEvent(tree, ev("agent_task", { toolUseId: "tu_p", status: "completed" }));
    expect(tree[0]).toMatchObject({ subLabel: "qa", status: "completed", usage: { totalTokens: 42 } });
  });

  it("agent_task usage is normalized: non-numeric/garbage fields are dropped, valid ones kept", () => {
    const tree = applyFlowEvent(
      [],
      ev("agent_task", { taskId: "T2", usage: { totalTokens: 10, toolUses: "nope", durationMs: NaN } }),
    );
    expect(tree[0]!.usage).toEqual({ totalTokens: 10 });
  });

  it("agent_task with a usage value that isn't an object is ignored (no usage field on the node)", () => {
    const tree = applyFlowEvent([], ev("agent_task", { taskId: "T3", usage: "not-an-object" }));
    expect(tree[0]!.usage).toBeUndefined();
  });

  it("agent_task with an empty-object usage (no recognized numeric fields) yields no usage field", () => {
    const tree = applyFlowEvent([], ev("agent_task", { taskId: "T4", usage: {} }));
    expect(tree[0]!.usage).toBeUndefined();
  });

  it("agent_task nests a NEW node under parentToolUseId when it resolves", () => {
    let tree = applyFlowEvent([], ev("tool_call", { toolUseId: "tu_root", toolName: "Task" }));
    tree = applyFlowEvent(tree, ev("agent_task", { taskId: "T5", toolUseId: "tu_child2", parentToolUseId: "tu_root" }));
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]).toMatchObject({ id: "tu_child2" });
  });

  it("agent_task with a parentToolUseId that doesn't resolve becomes a ROOT (never dropped/thrown)", () => {
    const tree = applyFlowEvent([], ev("agent_task", { taskId: "T6", parentToolUseId: "nope" }));
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ id: "T6" });
  });

  it("tool_call with a missing/non-string toolName defaults its label to '?'", () => {
    const tree = applyFlowEvent([], ev("tool_call", { toolUseId: "tu_q" }));
    expect(tree[0]).toMatchObject({ label: "?" });
  });

  it("tool_call with no toolUseId (and no seq collision) keys the node by tool:<seq>", () => {
    const tree = applyFlowEvent([], ev("tool_call", { toolName: "Bash" }, 77));
    expect(tree[0]!.id).toBe("tool:77");
  });

  it("tool_call with an empty-string toolUseId falls back to tool:<seq> (empty string treated as absent)", () => {
    const tree = applyFlowEvent([], ev("tool_call", { toolUseId: "", toolName: "Bash" }, 5));
    expect(tree[0]!.id).toBe("tool:5");
  });

  it("tool_call with an empty-string parentToolUseId is treated as no parent (becomes root)", () => {
    const tree = applyFlowEvent([], ev("tool_call", { toolUseId: "tu_z", parentToolUseId: "", toolName: "Bash" }));
    expect(tree).toHaveLength(1);
    expect(tree[0]!.id).toBe("tu_z");
  });

  it("tool_result with no 'called' tool anywhere in the tree is a no-op (same reference, no throw)", () => {
    const input: FlowNode[] = [{ id: "a", kind: "tool", label: "Bash", status: "done", children: [] }];
    const output = applyFlowEvent(input, ev("tool_result", {}));
    expect(output).toBe(input);
  });

  it("tool_result on an empty tree is a no-op (same reference)", () => {
    const input: FlowNode[] = [];
    const output = applyFlowEvent(input, ev("tool_result", {}));
    expect(output).toBe(input);
  });

  it("tool_result patches the DEPTH-FIRST LAST 'called' tool node, nested deeper than a still-called root", () => {
    let tree = applyFlowEvent([], ev("tool_call", { toolUseId: "tu_root", toolName: "Task" }));
    tree = applyFlowEvent(tree, ev("tool_call", { toolUseId: "tu_leaf", parentToolUseId: "tu_root", toolName: "Read" }));
    tree = applyFlowEvent(tree, ev("tool_result", {}));
    expect(tree[0]!.status).toBe("called");            // the root (Task) is still in-flight
    expect(tree[0]!.children[0]!.status).toBe("done");  // the nested leaf was the last 'called' -> patched
  });

  it("applyFlowEvent never throws when ev.data is missing/malformed (e.g. null)", () => {
    expect(() => applyFlowEvent([], { kind: "agent_task", seq: 1, data: null as unknown as Record<string, unknown> })).not.toThrow();
    expect(() => applyFlowEvent([], { kind: "tool_call", seq: 1, data: null as unknown as Record<string, unknown> })).not.toThrow();
    const out = applyFlowEvent([], { kind: "agent_task", seq: 1, data: null as unknown as Record<string, unknown> });
    expect(out).toEqual([]);
  });

  it("applyFlowEvent never throws on wildly-typed fields (numbers/objects where strings are expected)", () => {
    expect(() =>
      applyFlowEvent(
        [],
        ev("agent_task", { taskId: 123, toolUseId: {}, workflowName: [], subagentType: null, status: 7 }),
      ),
    ).not.toThrow();
  });

  it("immutability: a tool_result patch clones only the mutated path, sibling arrays keep their reference", () => {
    const siblingChildren: FlowNode[] = [];
    const siblingRoot: FlowNode = { id: "sib", kind: "tool", label: "Edit", status: "done", children: siblingChildren };
    const calledRoot: FlowNode = { id: "cal", kind: "tool", label: "Bash", status: "called", children: [] };
    const input: FlowNode[] = [siblingRoot, calledRoot];
    const output = applyFlowEvent(input, ev("tool_result", {}));
    expect(output).not.toBe(input);
    expect(output[0]).toBe(siblingRoot);       // untouched sibling keeps its exact reference
    expect(output[1]).not.toBe(calledRoot);    // the patched node is a new object
    expect(output[1]).toMatchObject({ id: "cal", status: "done" });
  });
});
