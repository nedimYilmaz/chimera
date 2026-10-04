import { describe, it, expect } from "vitest";
import { WorkflowSpecSchema, WorkflowRecordSchema, TaskRecordSchema, PlanArtifactSchema, PLAN_MAX_STEPS, WorkflowParamSchema, WorkflowUpdateParams } from "@chimera/protocol";

const commandGate = { kind: "command" as const, spec: { command: "gate", args: [] } };
const noneGate = { kind: "none" as const };

describe("WorkflowSpecSchema — WorkflowGraph", () => {
  it("a plain linear spec (no step sets next/fanOut) parses unchanged", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "linear",
      steps: [
        { id: "s0", title: "plan", gate: noneGate },
        { id: "s1", title: "build", gate: noneGate },
      ],
    });
    expect(spec.steps[0]!.next).toBeUndefined();
    expect(spec.steps[0]!.fanOut).toBeUndefined();
    expect(spec.steps).toHaveLength(2);
  });

  it("a 2-step spec with an unconditional next edge parses", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "routed",
      steps: [
        { id: "s0", title: "plan", gate: noneGate, next: [{ to: "s1" }] },
        { id: "s1", title: "build", gate: noneGate },
      ],
    });
    expect(spec.steps[0]!.next).toEqual([{ to: "s1" }]);
  });

  it("a next edge with when:{kind:'artifact'} parses", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "routed-artifact",
      steps: [
        { id: "s0", title: "plan", gate: noneGate, next: [{ to: "s1", when: { kind: "artifact", spec: { artifactId: "a1" } } }] },
        { id: "s1", title: "build", gate: noneGate },
      ],
    });
    expect(spec.steps[0]!.next![0]!.when).toEqual({ kind: "artifact", spec: { artifactId: "a1" } });
  });

  it("next: [] on the last step parses (explicit terminal)", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "explicit-terminal",
      steps: [{ id: "s0", title: "only", gate: noneGate, next: [] }],
    });
    expect(spec.steps[0]!.next).toEqual([]);
  });

  it("rejects a dangling next[].to reference", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "dangling",
      steps: [{ id: "s0", title: "plan", gate: noneGate, next: [{ to: "nope" }] }],
    })).toThrow();
  });

  it("rejects duplicate step ids in a graph-ish spec", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "dup-ids",
      steps: [
        { id: "s0", title: "plan", gate: noneGate, next: [{ to: "s0" }] },
        { id: "s0", title: "build", gate: noneGate },
      ],
    })).toThrow();
  });

  it("does NOT reject duplicate step ids when the spec is plain-linear (no next/fanOut anywhere)", () => {
    // validateWorkflowGraph is gated behind "graphish" — a pure-linear spec pays zero extra
    // validation cost and cannot newly fail parsing that succeeded before this feature existed.
    expect(() => WorkflowSpecSchema.parse({
      name: "dup-ids-linear",
      steps: [
        { id: "s0", title: "plan", gate: noneGate },
        { id: "s0", title: "build", gate: noneGate },
      ],
    })).not.toThrow();
  });

  it("rejects a step with both next and fanOut set", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "both",
      steps: [
        { id: "s0", title: "plan", gate: noneGate, next: [{ to: "s1" }], fanOut: { source: { kind: "list", items: ["a"] }, joinStep: "s1" } },
        { id: "s1", title: "join", gate: noneGate },
      ],
    })).toThrow();
  });

  it("rejects fanOut on steps[0]", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "fanout-first",
      steps: [
        { id: "s0", title: "spread", gate: noneGate, fanOut: { source: { kind: "list", items: ["a"] }, joinStep: "s1" } },
        { id: "s1", title: "join", gate: noneGate },
      ],
    })).toThrow();
  });

  it("rejects a dangling fanOut.joinStep reference", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "fanout-dangling-join",
      steps: [
        { id: "s0", title: "plan", gate: noneGate },
        { id: "s1", title: "spread", gate: noneGate, fanOut: { source: { kind: "list", items: ["a"] }, joinStep: "nope" } },
      ],
    })).toThrow();
  });

  it("rejects fanOut.joinStep pointing at itself or an earlier step", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "fanout-self-join",
      steps: [
        { id: "s0", title: "plan", gate: noneGate },
        { id: "s1", title: "spread", gate: noneGate, fanOut: { source: { kind: "list", items: ["a"] }, joinStep: "s1" } },
      ],
    })).toThrow();
    expect(() => WorkflowSpecSchema.parse({
      name: "fanout-backward-join",
      steps: [
        { id: "s0", title: "plan", gate: noneGate },
        { id: "s1", title: "spread", gate: noneGate, fanOut: { source: { kind: "list", items: ["a"] }, joinStep: "s0" } },
      ],
    })).toThrow();
  });

  it("rejects two steps sharing the same fanOut.joinStep", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "dup-join-owners",
      steps: [
        { id: "s0", title: "plan", gate: noneGate },
        { id: "s1", title: "spread1", gate: noneGate, fanOut: { source: { kind: "list", items: ["a"] }, joinStep: "s3" } },
        { id: "s2", title: "spread2", gate: noneGate, fanOut: { source: { kind: "list", items: ["b"] }, joinStep: "s3" } },
        { id: "s3", title: "join", gate: noneGate },
      ],
    })).toThrow();
  });

  it("rejects a cycle via a backward next edge", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "cycle",
      steps: [
        { id: "s0", title: "plan", gate: noneGate, next: [{ to: "s1" }] },
        { id: "s1", title: "build", gate: noneGate, next: [{ to: "s0" }] },
      ],
    })).toThrow();
  });

  it("rejects a self-loop (next[].to === own id)", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "self-loop",
      steps: [{ id: "s0", title: "plan", gate: noneGate, next: [{ to: "s0" }] }],
    })).toThrow();
  });

  it("a valid fan-out + join spec parses (happy path)", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "map-reduce",
      steps: [
        { id: "plan", title: "plan", gate: commandGate },
        { id: "spread", title: "spread", gate: noneGate, fanOut: { source: { kind: "list", items: ["a", "b", "c"] }, joinStep: "join" } },
        { id: "join", title: "join", gate: commandGate },
      ],
    });
    const source = spec.steps[1]!.fanOut!.source;
    expect(source.kind).toBe("list");
    if (source.kind === "list") expect(source.items).toEqual(["a", "b", "c"]);
    expect(spec.steps[1]!.fanOut!.joinStep).toBe("join");
  });

  it("fan-out chunkSize/maxParallel default and round-trip", () => {
    const defaulted = WorkflowSpecSchema.parse({
      name: "map-reduce-defaults",
      steps: [
        { id: "plan", title: "plan", gate: noneGate },
        { id: "spread", title: "spread", gate: noneGate, fanOut: { source: { kind: "list", items: ["a"] }, joinStep: "join" } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });
    expect(defaulted.steps[1]!.fanOut!.chunkSize).toBe(1);
    expect(defaulted.steps[1]!.fanOut!.maxParallel).toBeUndefined();

    const explicit = WorkflowSpecSchema.parse({
      name: "map-reduce-bounded",
      steps: [
        { id: "plan", title: "plan", gate: noneGate },
        { id: "spread", title: "spread", gate: noneGate, fanOut: { source: { kind: "list", items: ["a"] }, joinStep: "join", chunkSize: 5, maxParallel: 3 } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });
    expect(explicit.steps[1]!.fanOut!.chunkSize).toBe(5);
    expect(explicit.steps[1]!.fanOut!.maxParallel).toBe(3);
  });

  it("rejects chunkSize:0 / maxParallel:0 / negative values", () => {
    const spec = (fanOut: Record<string, unknown>) => ({
      name: "invalid",
      steps: [
        { id: "plan", title: "plan", gate: noneGate },
        { id: "spread", title: "spread", gate: noneGate, fanOut: { source: { kind: "list", items: ["a"] }, joinStep: "join", ...fanOut } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });
    expect(() => WorkflowSpecSchema.parse(spec({ chunkSize: 0 }))).toThrow();
    expect(() => WorkflowSpecSchema.parse(spec({ chunkSize: -1 }))).toThrow();
    expect(() => WorkflowSpecSchema.parse(spec({ maxParallel: 0 }))).toThrow();
    expect(() => WorkflowSpecSchema.parse(spec({ maxParallel: -2 }))).toThrow();
  });

  it("an artifactList fan-out source parses with defaulted scope:'task' and optional artifactId", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "map-reduce-artifact",
      steps: [
        { id: "plan", title: "plan", gate: noneGate },
        { id: "spread", title: "spread", gate: noneGate, fanOut: { source: { kind: "artifactList", spec: {} }, joinStep: "join" } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });
    const source = spec.steps[1]!.fanOut!.source;
    expect(source.kind).toBe("artifactList");
    if (source.kind === "artifactList") {
      expect(source.spec.scope).toBe("task");
      expect(source.spec.artifactId).toBeUndefined();
    }

    const scoped = WorkflowSpecSchema.parse({
      name: "map-reduce-artifact-scoped",
      steps: [
        { id: "plan", title: "plan", gate: noneGate },
        { id: "spread", title: "spread", gate: noneGate, fanOut: { source: { kind: "artifactList", spec: { artifactId: "abc", scope: "step" } }, joinStep: "join" } },
        { id: "join", title: "join", gate: noneGate },
      ],
    });
    const scopedSource = scoped.steps[1]!.fanOut!.source;
    if (scopedSource.kind === "artifactList") {
      expect(scopedSource.spec.artifactId).toBe("abc");
      expect(scopedSource.spec.scope).toBe("step");
    }
  });
});

describe("WorkflowRemediateSchema — GATE-REMEDIATION-LOOP", () => {
  it("a plain onFail:'halt'/'retry' spec (no remediate field at all) parses byte-identically", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "unaffected",
      onFail: "retry", retryLimit: 2,
      steps: [{ id: "s0", title: "work", gate: commandGate }],
    });
    expect(spec.steps[0]!.remediate).toBeUndefined();
    expect((spec as { remediate?: unknown }).remediate).toBeUndefined();
  });

  it("round-trips a workflow-level remediate default and a step-level override", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "remediate-roundtrip",
      onFail: "remediate", remediate: { maxRounds: 5 },
      steps: [
        { id: "implement", title: "implement", gate: noneGate },
        { id: "verify", title: "verify", gate: commandGate, remediate: { remediateStep: "implement", maxRounds: 2 } },
      ],
    });
    expect(spec.remediate).toEqual({ maxRounds: 5 });
    expect(spec.steps[1]!.remediate).toEqual({ remediateStep: "implement", maxRounds: 2 });
    expect(spec.steps[0]!.remediate).toBeUndefined();
  });

  it("maxRounds defaults to 3", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "default-max-rounds",
      steps: [{ id: "s0", title: "work", gate: commandGate, onFail: "remediate", remediate: {} }],
    });
    expect(spec.steps[0]!.remediate).toEqual({ maxRounds: 3 });
  });

  it("rejects onFail:'remediate' resolved at the STEP level with no remediate policy at either level", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "missing-policy-step",
      steps: [{ id: "s0", title: "work", gate: commandGate, onFail: "remediate" }],
    })).toThrow();
  });

  it("rejects onFail:'remediate' resolved from the WORKFLOW default with no remediate policy at either level", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "missing-policy-workflow-default",
      onFail: "remediate",
      steps: [{ id: "s0", title: "work", gate: commandGate }],
    })).toThrow();
  });

  it("this check runs UNCONDITIONALLY on a purely linear spec (no next/fanOut/plan/subWorkflow) — the primary target shape", () => {
    // plan -> implement -> qa-verify -> land: no step sets next/fanOut, so `graphish` is false,
    // but the remediate-policy check must still fire (this is the whole point of hoisting it).
    expect(() => WorkflowSpecSchema.parse({
      name: "linear-feature-qa-shape",
      steps: [
        { id: "plan", title: "plan", gate: noneGate },
        { id: "implement", title: "implement", gate: noneGate },
        { id: "qa-verify", title: "qa-verify", gate: commandGate, onFail: "remediate" },
        { id: "land", title: "land", gate: noneGate },
      ],
    })).toThrow();
  });

  it("accepts that same linear spec once a remediate policy is present", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "linear-feature-qa-shape-fixed",
      steps: [
        { id: "plan", title: "plan", gate: noneGate },
        { id: "implement", title: "implement", gate: noneGate },
        { id: "qa-verify", title: "qa-verify", gate: commandGate, onFail: "remediate", remediate: {} },
        { id: "land", title: "land", gate: noneGate },
      ],
    });
    expect(spec.steps[2]!.remediate).toEqual({ maxRounds: 3 });
  });

  it("rejects an unknown remediateStep reference", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "dangling-remediate-target",
      steps: [{ id: "s0", title: "work", gate: commandGate, onFail: "remediate", remediate: { remediateStep: "nope" } }],
    })).toThrow();
  });

  it("rejects a remediateStep pointing at a fanOut step", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "remediate-target-fanout",
      steps: [
        { id: "s0", title: "work", gate: commandGate, onFail: "remediate", remediate: { remediateStep: "spread" } },
        { id: "spread", title: "spread", gate: noneGate, fanOut: { source: { kind: "list", items: ["a"] }, joinStep: "join" } },
        { id: "join", title: "join", gate: noneGate },
      ],
    })).toThrow();
  });

  it("rejects a remediateStep pointing at a subWorkflow step", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "remediate-target-subworkflow",
      steps: [
        { id: "s0", title: "work", gate: commandGate, onFail: "remediate", remediate: { remediateStep: "sub" } },
        { id: "sub", title: "sub", gate: noneGate, subWorkflow: { name: "child", joinStep: "join" } },
        { id: "join", title: "join", gate: noneGate },
      ],
    })).toThrow();
  });

  it("does NOT require a remediate policy on a critic-gated step even if onFail resolves to 'remediate' — critic keeps its own independent loop", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "critic-exempt",
      onFail: "remediate",
      steps: [{ id: "s0", title: "work", gate: { kind: "critic", spec: { criteria: "must be correct" } } }],
    });
    expect(spec.steps[0]!.remediate).toBeUndefined();
  });

  it("workflow.update patch accepts a remediate field", () => {
    const parsed = WorkflowUpdateParams.parse({ name: "wf", patch: { remediate: { maxRounds: 4 } } });
    expect(parsed.patch.remediate).toEqual({ maxRounds: 4 });
  });
});

describe("WorkflowParamSchema — recipe templating", () => {
  it("round-trips string/number/boolean defaults", () => {
    expect(WorkflowParamSchema.parse({ name: "env", default: "prod" }).default).toBe("prod");
    expect(WorkflowParamSchema.parse({ name: "count", type: "number", default: 3 }).default).toBe(3);
    expect(WorkflowParamSchema.parse({ name: "flag", type: "boolean", default: true }).default).toBe(true);
    expect(WorkflowParamSchema.parse({ name: "no-default" }).default).toBeUndefined();
    expect(WorkflowParamSchema.parse({ name: "no-default" }).type).toBe("string");   // defaulted
  });

  it("rejects a default that doesn't match its declared type", () => {
    expect(() => WorkflowParamSchema.parse({ name: "count", type: "number", default: "3" })).toThrow();
  });
});

describe("WorkflowSpecObject — recipe params", () => {
  it("params defaults to [] — a spec with no params parses unchanged", () => {
    const spec = WorkflowSpecSchema.parse({ name: "no-params", steps: [{ id: "s0", title: "only", gate: noneGate }] });
    expect(spec.params).toEqual([]);
  });

  it("rejects duplicate param names in a graph-ish spec", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "dup-params",
      params: [{ name: "env" }, { name: "env" }],
      steps: [
        { id: "s0", title: "plan", gate: noneGate, next: [{ to: "s1" }] },
        { id: "s1", title: "build", gate: noneGate },
      ],
    })).toThrow();
  });

  it("rejects duplicate param names even in a plain-linear spec (param dedup is unconditional, not gated behind `graphish`)", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "dup-params-linear",
      params: [{ name: "env" }, { name: "env" }],
      steps: [{ id: "s0", title: "only", gate: noneGate }],
    })).toThrow();
  });

  it("WorkflowUpdateParams.patch accepts params", () => {
    const patch = WorkflowUpdateParams.parse({ name: "recipe", patch: { params: [{ name: "env", default: "prod" }] } });
    expect(patch.patch.params).toEqual([{ name: "env", type: "string", default: "prod" }]);
  });
});

describe("WorkflowSubWorkflowSchema — nested sub-workflows", () => {
  it("round-trips with defaulted inputs: {}", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "nests",
      steps: [
        { id: "s0", title: "prior", gate: noneGate },
        { id: "s1", title: "dispatch", gate: noneGate, subWorkflow: { name: "deploy-recipe", joinStep: "s2" } },
        { id: "s2", title: "join", gate: noneGate },
      ],
    });
    expect(spec.steps[1]!.subWorkflow!.inputs).toEqual({});
    expect(spec.steps[1]!.subWorkflow!.version).toBeUndefined();
  });

  it("rejects a step combining subWorkflow with next", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "sub-plus-next",
      steps: [
        { id: "s0", title: "prior", gate: noneGate },
        { id: "s1", title: "dispatch", gate: noneGate, next: [{ to: "s2" }], subWorkflow: { name: "r", joinStep: "s2" } },
        { id: "s2", title: "join", gate: noneGate },
      ],
    })).toThrow();
  });

  it("rejects a step combining subWorkflow with fanOut", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "sub-plus-fanout",
      steps: [
        { id: "s0", title: "prior", gate: noneGate },
        { id: "s1", title: "dispatch", gate: noneGate, fanOut: { source: { kind: "list", items: ["a"] }, joinStep: "s2" }, subWorkflow: { name: "r", joinStep: "s2" } },
        { id: "s2", title: "join", gate: noneGate },
      ],
    })).toThrow();
  });

  it("rejects a plan gate combined with subWorkflow", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "plan-plus-sub",
      steps: [
        { id: "s0", title: "dispatch", gate: { kind: "plan", spec: { resumeStep: "s1" } }, subWorkflow: { name: "r", joinStep: "s1" } },
        { id: "s1", title: "join", gate: noneGate },
      ],
    })).toThrow();
  });

  it("rejects subWorkflow on steps[0]", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "sub-first",
      steps: [
        { id: "s0", title: "dispatch", gate: noneGate, subWorkflow: { name: "r", joinStep: "s1" } },
        { id: "s1", title: "join", gate: noneGate },
      ],
    })).toThrow();
  });

  it("rejects a dangling subWorkflow.joinStep reference", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "sub-dangling-join",
      steps: [
        { id: "s0", title: "prior", gate: noneGate },
        { id: "s1", title: "dispatch", gate: noneGate, subWorkflow: { name: "r", joinStep: "nope" } },
      ],
    })).toThrow();
  });

  it("rejects subWorkflow.joinStep pointing at itself or an earlier step", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "sub-self-join",
      steps: [
        { id: "s0", title: "prior", gate: noneGate },
        { id: "s1", title: "dispatch", gate: noneGate, subWorkflow: { name: "r", joinStep: "s1" } },
      ],
    })).toThrow();
    expect(() => WorkflowSpecSchema.parse({
      name: "sub-backward-join",
      steps: [
        { id: "s0", title: "prior", gate: noneGate },
        { id: "s1", title: "dispatch", gate: noneGate, subWorkflow: { name: "r", joinStep: "s0" } },
      ],
    })).toThrow();
  });

  it("rejects a fanOut step and a subWorkflow step sharing the same joinStep", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "sub-fanout-dup-join",
      steps: [
        { id: "s0", title: "prior", gate: noneGate },
        { id: "s1", title: "spread", gate: noneGate, fanOut: { source: { kind: "list", items: ["a"] }, joinStep: "s3" } },
        { id: "s2", title: "dispatch", gate: noneGate, subWorkflow: { name: "r", joinStep: "s3" } },
        { id: "s3", title: "join", gate: noneGate },
      ],
    })).toThrow();
  });

  it("a valid subWorkflow + join spec parses (happy path)", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "recipe-runner",
      steps: [
        { id: "plan", title: "plan", gate: commandGate },
        { id: "dispatch", title: "dispatch", gate: noneGate, subWorkflow: { name: "deploy-recipe", version: 2, inputs: { env: "prod" }, joinStep: "join" } },
        { id: "join", title: "join", gate: commandGate },
      ],
    });
    expect(spec.steps[1]!.subWorkflow!.name).toBe("deploy-recipe");
    expect(spec.steps[1]!.subWorkflow!.version).toBe(2);
    expect(spec.steps[1]!.subWorkflow!.inputs).toEqual({ env: "prod" });
  });
});

describe("WorkflowRecordSchema — shares WorkflowGraph validation", () => {
  it("rejects a dangling next[].to reference, not just WorkflowSpecSchema", () => {
    expect(() => WorkflowRecordSchema.parse({
      name: "dangling-record",
      steps: [{ id: "s0", title: "plan", gate: noneGate, next: [{ to: "nope" }] }],
      version: 1,
      createdAt: Date.now(),
    })).toThrow();
  });

  it("accepts a valid graph spec with version/createdAt", () => {
    const rec = WorkflowRecordSchema.parse({
      name: "routed-record",
      steps: [
        { id: "s0", title: "plan", gate: noneGate, next: [{ to: "s1" }] },
        { id: "s1", title: "build", gate: noneGate },
      ],
      version: 1,
      createdAt: 12345,
    });
    expect(rec.version).toBe(1);
  });

  it("a pre-existing (pre-ephemeral) record parses byte-identically, defaulting ephemeral:false", () => {
    const rec = WorkflowRecordSchema.parse({
      name: "old-record",
      steps: [{ id: "s0", title: "only", gate: noneGate }],
      version: 1,
      createdAt: 12345,
    });
    expect(rec.ephemeral).toBe(false);
  });

  it("round-trips an explicit ephemeral:true record", () => {
    const rec = WorkflowRecordSchema.parse({
      name: "plan-abc",
      steps: [{ id: "s0", title: "only", gate: noneGate }],
      version: 1,
      createdAt: 12345,
      ephemeral: true,
    });
    expect(rec.ephemeral).toBe(true);
  });
});

describe("WorkflowGateSchema — Dynamic Planner `plan` gate", () => {
  it("parses with a required resumeStep and defaulted scope", () => {
    const spec = WorkflowSpecSchema.parse({
      name: "planner",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "plan", spec: { resumeStep: "s1" } } },
        { id: "s1", title: "join", gate: noneGate },
      ],
    });
    const gate = spec.steps[0]!.gate;
    expect(gate.kind).toBe("plan");
    if (gate.kind === "plan") {
      expect(gate.spec.resumeStep).toBe("s1");
      expect(gate.spec.scope).toBe("step");
    }
  });

  it("rejects a plan gate with no resumeStep", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "planner-no-resume",
      steps: [{ id: "s0", title: "plan", gate: { kind: "plan", spec: {} } }],
    })).toThrow();
  });

  it("rejects a plan gate combined with next (ambiguous successor)", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "planner-plus-next",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "plan", spec: { resumeStep: "s1" } }, next: [{ to: "s1" }] },
        { id: "s1", title: "join", gate: noneGate },
      ],
    })).toThrow();
  });

  it("rejects a dangling plan gate resumeStep", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "planner-dangling-resume",
      steps: [{ id: "s0", title: "plan", gate: { kind: "plan", spec: { resumeStep: "nope" } } }],
    })).toThrow();
  });

  it("rejects a plan gate resumeStep pointing at itself or an earlier step", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "planner-self-resume",
      steps: [{ id: "s0", title: "plan", gate: { kind: "plan", spec: { resumeStep: "s0" } } }],
    })).toThrow();
    expect(() => WorkflowSpecSchema.parse({
      name: "planner-backward-resume",
      steps: [
        { id: "s0", title: "prior", gate: noneGate },
        { id: "s1", title: "plan", gate: { kind: "plan", spec: { resumeStep: "s0" } } },
      ],
    })).toThrow();
  });

  it("a plan gate on steps[0] is allowed (unlike fanOut) — it's a normal executing step", () => {
    expect(() => WorkflowSpecSchema.parse({
      name: "planner-first",
      steps: [
        { id: "s0", title: "plan", gate: { kind: "plan", spec: { resumeStep: "s1" } } },
        { id: "s1", title: "join", gate: noneGate },
      ],
    })).not.toThrow();
  });
});

describe("PlanArtifactSchema — Dynamic Planner compiled-plan payload", () => {
  it("round-trips a valid plan, defaulting onFail/retryLimit", () => {
    const plan = PlanArtifactSchema.parse({
      steps: [{ id: "do", title: "do it", gate: noneGate }],
    });
    expect(plan.onFail).toBe("halt");
    expect(plan.retryLimit).toBe(0);
    expect(plan.steps).toHaveLength(1);
  });

  it(`rejects more than PLAN_MAX_STEPS (${PLAN_MAX_STEPS}) steps`, () => {
    const steps = Array.from({ length: PLAN_MAX_STEPS + 1 }, (_, i) => ({ id: `s${i}`, title: `step ${i}`, gate: noneGate }));
    expect(() => PlanArtifactSchema.parse({ steps })).toThrow();
  });

  it("accepts exactly PLAN_MAX_STEPS steps", () => {
    const steps = Array.from({ length: PLAN_MAX_STEPS }, (_, i) => ({ id: `s${i}`, title: `step ${i}`, gate: noneGate }));
    expect(() => PlanArtifactSchema.parse({ steps })).not.toThrow();
  });

  it("reuses validateWorkflowGraph — rejects a cycle in the compiled plan's own steps", () => {
    expect(() => PlanArtifactSchema.parse({
      steps: [
        { id: "s0", title: "a", gate: noneGate, next: [{ to: "s1" }] },
        { id: "s1", title: "b", gate: noneGate, next: [{ to: "s0" }] },
      ],
    })).toThrow();
  });

  it("reuses validateWorkflowGraph — rejects a dangling next[].to reference", () => {
    expect(() => PlanArtifactSchema.parse({
      steps: [{ id: "s0", title: "a", gate: noneGate, next: [{ to: "nope" }] }],
    })).toThrow();
  });

  it("rejects an empty steps array", () => {
    expect(() => PlanArtifactSchema.parse({ steps: [] })).toThrow();
  });
});

describe("TaskRecordSchema — WorkflowGraph branch fields", () => {
  const base = {
    taskId: "t1", queue: "work", prompt: "do it", createdAt: 1,
  };

  it("round-trips parentTaskId and branchChildren when explicitly set", () => {
    const rec = TaskRecordSchema.parse({ ...base, parentTaskId: "parent1", branchChildren: ["c1", "c2"] });
    expect(rec.parentTaskId).toBe("parent1");
    expect(rec.branchChildren).toEqual(["c1", "c2"]);
  });

  it("a sparse pre-existing record (neither key present) parses with both defaults", () => {
    const rec = TaskRecordSchema.parse(base);
    expect(rec.parentTaskId).toBeNull();
    expect(rec.branchChildren).toEqual([]);
  });

  it("fanOutRemaining defaults to [] and round-trips when set", () => {
    const sparse = TaskRecordSchema.parse(base);
    expect(sparse.fanOutRemaining).toEqual([]);

    const rec = TaskRecordSchema.parse({ ...base, fanOutRemaining: [["a", "b"], ["c"]] });
    expect(rec.fanOutRemaining).toEqual([["a", "b"], ["c"]]);
  });
});
