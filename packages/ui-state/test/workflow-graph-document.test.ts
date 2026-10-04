import { describe, expect, it } from "vitest";
import { WorkflowSpecSchema } from "@chimera/protocol";
import { initialState, normalizeWorkflowGraph, reduce, serializeWorkflowGraph, updateWorkflowGraphNode } from "../src/index.js";

const spec = WorkflowSpecSchema.parse({
  name: "release",
  steps: [
    { id: "plan", title: "Plan", gate: { kind: "none" }, next: [{ to: "fast", when: { kind: "artifact", spec: { artifactId: "ok" } } }, { to: "slow" }] },
    { id: "fast", title: "Fast", gate: { kind: "none" }, next: [] },
    { id: "slow", title: "Slow", gate: { kind: "critic", spec: { criteria: "safe", maxRounds: 3 } }, next: [] },
  ],
});

describe("workflow graph document", () => {
  it("normalizes ordered routes and round-trips the protocol document", () => {
    const doc = normalizeWorkflowGraph(spec);
    expect(doc.nodeOrder).toEqual(["plan", "fast", "slow"]);
    expect(Object.values(doc.edgesById).map((e) => [e.from, e.to, e.order])).toEqual([["plan", "fast", 0], ["plan", "slow", 1]]);
    expect(serializeWorkflowGraph(doc)).toEqual(spec);
  });

  it("distinguishes implicit, fan-out join, and plan resume edges", () => {
    const parsed = WorkflowSpecSchema.parse({ name: "graph", steps: [
      { id: "a", title: "A", gate: { kind: "none" } },
      { id: "fan", title: "Fan", gate: { kind: "none" }, fanOut: { source: { kind: "list", items: ["x"] }, joinStep: "join" } },
      { id: "join", title: "Join", gate: { kind: "plan", spec: { resumeStep: "end" } } },
      { id: "end", title: "End", gate: { kind: "none" }, next: [] },
    ] });
    expect(Object.values(normalizeWorkflowGraph(parsed).edgesById).map((e) => e.kind)).toEqual(["implicit", "fanOutJoin", "planResume"]);
  });

  it("updates nodes immutably and reducer tracks dirty/save lifecycle", () => {
    const doc = normalizeWorkflowGraph(spec);
    const next = updateWorkflowGraphNode(doc, "fast", { title: "Faster" });
    expect(doc.nodesById.fast!.step.title).toBe("Fast");
    let state = reduce(initialState, { type: "workflowStudioOpen", mode: "author", document: doc, queue: "q" });
    state = reduce(state, { type: "workflowStudioDraft", document: next });
    expect(state.workflowStudio.dirty).toBe(true);
    state = reduce(state, { type: "workflowStudioSaved", document: next, version: 2 });
    expect(state.workflowStudio).toMatchObject({ dirty: false, saving: false, version: 2, baseline: next });
    expect(reduce(state, { type: "workflowStudioClose" }).workflowStudio.open).toBe(false);
  });
});
