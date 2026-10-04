import { describe, it, expect } from "vitest";
import { WorkflowSpecSchema, WorkflowRecordSchema, PlanArtifactSchema, TaskRecordSchema } from "@chimera/protocol";

// Bounded conditional loops (iterate-until gate): a `loopBack` marker on WorkflowEdgeSchema lets
// ONE `next` edge point backward to an earlier step, guarded by a mandatory maxIterations cap and
// (optionally) an artifactValue RouteCondition. Mirrors workflow-graph.test.ts's conventions.

const noneGate = { kind: "none" as const };

describe("WorkflowEdgeSchema — loopBack", () => {
  it("a next edge with loopBack targeting a strictly earlier step parses", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "loop",
      steps: [
        { id: "head", title: "head", gate: noneGate },
        { id: "work", title: "work", gate: noneGate, next: [{ to: "head", loopBack: { maxIterations: 5 } }] },
      ],
    });
    expect(spec.steps[1]!.next![0]!.loopBack).toEqual({ maxIterations: 5 });
  });

  it("rejects loopBack missing maxIterations", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "loop-no-max",
      steps: [
        { id: "head", title: "head", gate: noneGate },
        { id: "work", title: "work", gate: noneGate, next: [{ to: "head", loopBack: {} }] },
      ],
    })).toThrow();
  });

  it("rejects loopBack.maxIterations below 1", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "loop-zero-max",
      steps: [
        { id: "head", title: "head", gate: noneGate },
        { id: "work", title: "work", gate: noneGate, next: [{ to: "head", loopBack: { maxIterations: 0 } }] },
      ],
    })).toThrow();
  });

  it("rejects a loopBack edge pointing at itself (self-loop)", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "loop-self",
      steps: [
        { id: "s0", title: "only", gate: noneGate, next: [{ to: "s0", loopBack: { maxIterations: 3 } }] },
      ],
    })).toThrow();
  });

  it("rejects a loopBack edge pointing at a LATER step (forward loopBack is nonsensical)", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "loop-forward",
      steps: [
        { id: "s0", title: "first", gate: noneGate, next: [{ to: "s1", loopBack: { maxIterations: 3 } }] },
        { id: "s1", title: "second", gate: noneGate },
      ],
    })).toThrow();
  });

  it("differentiator: a bounded loopBack edge does NOT whitelist an unrelated, unmarked cycle elsewhere in the same graph", () => {
    // s2 -> s0 is a legitimate bounded loop; s1 -> s0 is a SEPARATE, unmarked edge that (combined
    // with the implicit s0->s1 fallthrough) closes its own accidental cycle — must still reject.
    expect(() => WorkflowSpecSchema.parse({
      name: "loop-plus-accidental-cycle",
      steps: [
        { id: "s0", title: "head", gate: noneGate },
        { id: "s1", title: "mid", gate: noneGate, next: [{ to: "s0" }] },
        { id: "s2", title: "work", gate: noneGate, next: [{ to: "s0", loopBack: { maxIterations: 5 } }, { to: "done" }] },
        { id: "done", title: "done", gate: noneGate, next: [] },
      ],
    })).toThrow();
  });

  it("a workflow with ONLY a bounded loopBack edge (no other cycle) parses", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "loop-only",
      steps: [
        { id: "head", title: "head", gate: noneGate },
        {
          id: "work", title: "work", gate: noneGate,
          next: [{ to: "head", when: { kind: "artifactValue", spec: { value: "continue" } }, loopBack: { maxIterations: 5 } }, { to: "done" }],
        },
        { id: "done", title: "done", gate: noneGate, next: [] },
      ],
    })).not.toThrow();
  });
});

describe("RouteConditionSchema — artifactValue", () => {
  it("round-trips with every op value, defaulting op to 'equals' and scope to 'task' when omitted", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "artifact-value-default",
      steps: [
        { id: "s0", title: "plan", gate: noneGate, next: [{ to: "s1", when: { kind: "artifactValue", spec: { value: "done" } } }] },
        { id: "s1", title: "build", gate: noneGate },
      ],
    });
    const when = spec.steps[0]!.next![0]!.when;
    expect(when).toEqual({ kind: "artifactValue", spec: { value: "done", op: "equals", scope: "task" } });

    for (const op of ["equals", "notEquals", "contains", "gte", "lte"] as const) {
      const s = WorkflowSpecSchema.parse({
        name: `artifact-value-${op}`,
        steps: [
          { id: "s0", title: "plan", gate: noneGate, next: [{ to: "s1", when: { kind: "artifactValue", spec: { value: "1", op } } }] },
          { id: "s1", title: "build", gate: noneGate },
        ],
      });
      expect((s.steps[0]!.next![0]!.when as { spec: { op: string } }).spec.op).toBe(op);
    }
  });

  it("rejects an artifactValue spec missing value", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "artifact-value-no-value",
      steps: [
        { id: "s0", title: "plan", gate: noneGate, next: [{ to: "s1", when: { kind: "artifactValue", spec: {} } }] },
        { id: "s1", title: "build", gate: noneGate },
      ],
    })).toThrow();
  });
});

describe("WorkflowRecordSchema / PlanArtifactSchema — share the same loopBack validation", () => {
  it("WorkflowRecordSchema rejects the same self-loop as WorkflowSpecSchema", () => {
    expect(() => WorkflowRecordSchema.parse({
      name: "loop-self-record",
      steps: [{ id: "s0", title: "only", gate: noneGate, next: [{ to: "s0", loopBack: { maxIterations: 3 } }] }],
      version: 1,
      createdAt: 12345,
    })).toThrow();
  });

  it("PlanArtifactSchema accepts a valid bounded loop in a compiled plan", () => {
    expect(() => PlanArtifactSchema.parse({
      steps: [
        { id: "head", title: "head", gate: noneGate },
        { id: "work", title: "work", gate: noneGate, next: [{ to: "head", loopBack: { maxIterations: 3 } }, { to: "done" }] },
        { id: "done", title: "done", gate: noneGate, next: [] },
      ],
    })).not.toThrow();
  });

  it("PlanArtifactSchema still rejects an accidental (unmarked) cycle", () => {
    expect(() => PlanArtifactSchema.parse({
      steps: [
        { id: "s0", title: "a", gate: noneGate, next: [{ to: "s1" }] },
        { id: "s1", title: "b", gate: noneGate, next: [{ to: "s0" }] },
      ],
    })).toThrow();
  });
});

describe("TaskRecordSchema — loopIterations", () => {
  const base = { taskId: "t1", queue: "work", prompt: "do it", createdAt: 1 };

  it("defaults to {} — a legacy record with no loopIterations key parses unchanged", () => {
    const rec = TaskRecordSchema.parse(base);
    expect(rec.loopIterations).toEqual({});
  });

  it("round-trips an explicit loopIterations map", () => {
    const rec = TaskRecordSchema.parse({ ...base, loopIterations: { work: 2 } });
    expect(rec.loopIterations).toEqual({ work: 2 });
  });
});
