import { describe, expect, it } from "vitest";
import { emptyAgent, type AgentView } from "@chimera/ui-state";
import { conductorLabel, type AgentRow } from "../src/state/selectors";
import {
  agentWorkflowStepDots,
  buildWorkflowPatch,
  buildWorkflowSpec,
  buildWorkflowSteps,
  defaultWorkflowFormValues,
  emptyWorkflowStep,
  gateLabel,
  groupAgentListRowsByTask,
  latestStepEvent,
  liveTaskStepAgentId,
  overlayTargetAgentId,
  overlayTaskStep,
  slugify,
  stepGateState,
  stepHandoffIndices,
  stepHistoryEntry,
  stepMeterView,
  stepTimestamps,
  stitchedStepSections,
  taskDistinctAgentIds,
  taskIdFromRowId,
  taskRowId,
  taskStepAgentIds,
  taskWorkflowBinding,
  validateWorkflowForm,
  visibleListRowIds,
  workflowFlowBarView,
  workflowDocumentFromRow,
  workflowExecutionOverlay,
  workflowGraphLayout,
  workflowGraphValidation,
  workflowFor,
  workflowFormValuesFromRow,
  workflowRow,
  workflowStepDots,
  type AgentMetaForTask,
  type WorkflowFormValues,
} from "../src/state/selectors.workflows";

describe("Workflow Studio graph selectors", () => {
  it("lays out branches deterministically and validates through the protocol schema", () => {
    const row = workflowRow({ name: "graph", version: 1, onFail: "halt", retryLimit: 0, createdAt: 1, steps: [
      { id: "a", title: "A", gate: { kind: "none" }, next: [{ to: "b" }, { to: "c" }] },
      { id: "b", title: "B", gate: { kind: "none" }, next: [] },
      { id: "c", title: "C", gate: { kind: "none" }, next: [] },
    ] });
    const doc = workflowDocumentFromRow(row);
    const layout = workflowGraphLayout(doc);
    expect(layout.nodes.b!.x).toBe(layout.nodes.c!.x);
    expect(layout.nodes.b!.y).not.toBe(layout.nodes.c!.y);
    expect(workflowGraphLayout(doc)).toEqual(layout);
    expect(workflowGraphValidation(doc)).toEqual([]);
  });

  it("maps attempts, failures, and approval waiting by step id", () => {
    const row = workflowRow({ name: "graph", version: 1, onFail: "halt", retryLimit: 0, createdAt: 1, steps: [
      { id: "build", title: "Build", gate: { kind: "none" } },
      { id: "ship", title: "Ship", gate: { kind: "approval", spec: {} } },
    ] });
    const overlay = workflowExecutionOverlay(workflowDocumentFromRow(row), { stepHistory: [
      { stepId: "build", stepIndex: 0, agentId: "a", outcome: "failed", reason: "lint" },
      { stepId: "build", stepIndex: 0, agentId: "a", outcome: "passed" },
      { stepId: "ship", stepIndex: 1, agentId: "b", outcome: null },
    ] }, { b: { pendingQuestion: { gate: "approval" } } } as never);
    expect(overlay.build).toMatchObject({ state: "passed", attempts: 2 });
    expect(overlay.ship).toMatchObject({ state: "waiting", agentId: "b" });
  });

  it("workflowDocumentFromRow falls back to an empty graph instead of throwing on a drifted spec", () => {
    const row = workflowRow({ name: "drifted", version: 3, onFail: "halt", retryLimit: 1, createdAt: 5, steps: [
      { id: "a", title: "A", gate: { kind: "not-a-real-gate-kind" } },
    ] });
    expect(() => workflowDocumentFromRow(row)).not.toThrow();
    expect(workflowDocumentFromRow(row)).toEqual({
      name: "drifted", onFail: "halt", retryLimit: 1, params: [], nodeOrder: [], nodesById: {}, edgesById: {},
    });
  });

  it("does not mis-attribute a stepHistory entry with no stepId and no numeric stepIndex to node 0", () => {
    const row = workflowRow({ name: "graph", version: 1, onFail: "halt", retryLimit: 0, createdAt: 1, steps: [
      { id: "build", title: "Build", gate: { kind: "none" } },
      { id: "ship", title: "Ship", gate: { kind: "none" } },
    ] });
    const overlay = workflowExecutionOverlay(workflowDocumentFromRow(row), { stepHistory: [{}] }, {});
    expect(overlay.build).toMatchObject({ state: "pending", attempts: 0 });
  });
});

const rec = (overrides: Record<string, unknown> = {}) => ({
  name: "release-flow",
  version: 2,
  onFail: "retry",
  retryLimit: 2,
  createdAt: 111,
  steps: [
    { id: "plan", title: "plan", gate: { kind: "none" }, instructions: "read the release checklist first" },
    { id: "test", title: "test", gate: { kind: "command", spec: { command: "npm", args: ["test"], timeoutMs: 300_000 } } },
    { id: "ship", title: "ship it", gate: { kind: "approval", spec: { prompt: "ship it?" } } },
  ],
  ...overrides,
});

describe("workflowRow + gateLabel (projecting a WorkflowRecord)", () => {
  it("projects steps with their gate kind + a rendered label", () => {
    const row = workflowRow(rec());
    expect(row).toMatchObject({
      name: "release-flow", version: 2, onFail: "retry", retryLimit: 2, createdAt: 111,
      steps: [
        { id: "plan", title: "plan", gateKind: "none", gateLabel: "none", command: "", args: "", timeoutMs: "", artifactId: "", artifactScope: "task", artifactKind: "", approvalPrompt: "", instructions: "read the release checklist first", onFail: "", retryLimit: "", role: "", context: "handoff" },
        { id: "test", title: "test", gateKind: "command", gateLabel: "command: npm test", command: "npm", args: "test", timeoutMs: "300000", artifactId: "", artifactScope: "task", artifactKind: "", approvalPrompt: "", instructions: "", onFail: "", retryLimit: "", role: "", context: "handoff" },
        { id: "ship", title: "ship it", gateKind: "approval", gateLabel: "approval: ship it?", command: "", args: "", timeoutMs: "", artifactId: "", artifactScope: "task", artifactKind: "", approvalPrompt: "ship it?", instructions: "", onFail: "", retryLimit: "", role: "", context: "handoff" },
      ],
    });
  });
  it("gateLabel: artifact + a malformed/missing gate both default sanely", () => {
    expect(gateLabel({ kind: "artifact", spec: { artifactId: "a1" } })).toBe("artifact: a1");
    expect(gateLabel({ kind: "artifact" })).toBe("artifact");
    expect(gateLabel(undefined)).toBe("none");
    expect(gateLabel({ kind: "bogus" })).toBe("none");
  });
  it("defensive: a step with no gate/title falls back sanely", () => {
    const row = workflowRow({ name: "n", steps: [{ id: "x" }] });
    expect(row.steps[0]).toMatchObject({ id: "x", title: "x", gateKind: "none" });
    expect(row.version).toBe(1);
    expect(row.onFail).toBe("halt");
  });
  it("reads artifact scope/kind and per-step onFail/retryLimit overrides (F16.1 Phase 2)", () => {
    const row = workflowRow(rec({
      steps: [
        { id: "build", title: "build", gate: { kind: "artifact", spec: { artifactId: "out", scope: "step", kind: "diff" } } },
        { id: "review", title: "review", gate: { kind: "none" }, onFail: "retry", retryLimit: 5 },
      ],
    }));
    expect(row.steps[0]).toMatchObject({ artifactId: "out", artifactScope: "step", artifactKind: "diff", onFail: "", retryLimit: "" });
    expect(row.steps[1]).toMatchObject({ onFail: "retry", retryLimit: "5" });
  });
  it("artifact scope defaults to \"task\" when absent/malformed", () => {
    const row = workflowRow(rec({ steps: [{ id: "a", title: "a", gate: { kind: "artifact", spec: {} } }] }));
    expect(row.steps[0]!.artifactScope).toBe("task");
  });
});

describe("taskWorkflowBinding + workflowFor", () => {
  it("null when the task carries no workflow binding", () => {
    expect(taskWorkflowBinding({ taskId: "t1" })).toBeNull();
  });
  it("reads the pinned {name, version}", () => {
    expect(taskWorkflowBinding({ workflow: { name: "release-flow", version: 1 } })).toEqual({ name: "release-flow", version: 1 });
  });
  it("workflowFor resolves by name (best-effort against the LATEST version — see doc comment)", () => {
    const rows = [workflowRow(rec())];
    expect(workflowFor({ name: "release-flow", version: 1 }, rows)?.name).toBe("release-flow");
    expect(workflowFor({ name: "missing", version: 1 }, rows)).toBeNull();
    expect(workflowFor(null, rows)).toBeNull();
  });
});

describe("stepMeterView (task row `◐ 3/5 test`)", () => {
  const workflow = workflowRow(rec());
  it("null for a plain, ungated task", () => {
    expect(stepMeterView({ taskId: "t1" }, workflow)).toBeNull();
  });
  it("renders glyph + 1-based fraction + the current step's title", () => {
    const raw = { workflow: { name: "release-flow", version: 2 }, stepIndex: 1, state: "in_progress" };
    expect(stepMeterView(raw, workflow)).toEqual({ glyph: "◐", label: "2/3 test", stepTitle: "test" });
  });
  it("failed/done states swap the glyph", () => {
    const bound = { workflow: { name: "release-flow", version: 2 }, stepIndex: 2 };
    expect(stepMeterView({ ...bound, state: "failed" }, workflow)!.glyph).toBe("✗");
    expect(stepMeterView({ ...bound, state: "done" }, workflow)!.glyph).toBe("●");
  });
  it("still renders (without a total/title) when the workflow definition hasn't resolved yet", () => {
    const raw = { workflow: { name: "release-flow", version: 2 }, stepIndex: 0, state: "in_progress" };
    expect(stepMeterView(raw, null)).toEqual({ glyph: "◐", label: "1", stepTitle: null });
  });
  it("F16.1 Phase 3 (WF-10): appends \"@role\" when the current step has one", () => {
    const withRole = workflowRow(rec({
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" } },
        { id: "review", title: "review", gate: { kind: "none" }, role: "qa" },
      ],
    }));
    const raw = { workflow: { name: "release-flow", version: 2 }, stepIndex: 1, state: "in_progress" };
    expect(stepMeterView(raw, withRole)!.label).toBe("2/2 review @qa");
    // no role on the step -> no suffix
    expect(stepMeterView({ ...raw, stepIndex: 0 }, withRole)!.label).toBe("1/2 plan");
  });
});

const evt = (kind: string, data: Record<string, unknown>) => ({ kind, data, ts: 5000 } as never);

describe("latestStepEvent + overlayTaskStep (optimistic render + reconcile)", () => {
  it("finds the newest matching event for a taskId, ignoring other tasks/kinds", () => {
    const events = [
      evt("task_step_advanced", { taskId: "other", stepIndex: 9 }),
      evt("status", { taskId: "t1" }),
      evt("task_step_advanced", { taskId: "t1", stepIndex: 1, stepId: "test", title: "test" }),
    ];
    expect(latestStepEvent(events, "t1")).toEqual({ stepIndex: 1, stepId: "test", title: "test", failed: false, willRetry: false, reason: null });
    expect(latestStepEvent(events, "nope")).toBeNull();
  });
  it("overlays an advance strictly ahead of the fetched stepIndex, never regresses", () => {
    const raw = { stepIndex: 1 };
    const ahead = { stepIndex: 2, stepId: "ship", title: "ship it", failed: false, willRetry: false, reason: null };
    expect(overlayTaskStep(raw, ahead)).toEqual({ stepIndex: 2 });
    const stale = { stepIndex: 0, stepId: "plan", title: "plan", failed: false, willRetry: false, reason: null };
    expect(overlayTaskStep(raw, stale)).toBe(raw); // reconciled already — no-op, same reference
    expect(overlayTaskStep(raw, null)).toBe(raw);
  });
  it("a non-retrying failure at the CURRENT step surfaces as failed", () => {
    const raw = { stepIndex: 1, state: "in_progress" };
    const failed = { stepIndex: 1, stepId: "test", title: null, failed: true, willRetry: false, reason: "exit 1" };
    expect(overlayTaskStep(raw, failed)).toEqual({ stepIndex: 1, state: "failed" });
    const retrying = { ...failed, willRetry: true };
    expect(overlayTaskStep(raw, retrying)).toBe(raw); // still retrying — not a terminal failure yet
  });
});

describe("stepGateState + stepTimestamps (TaskInspector step list)", () => {
  it("classifies before/at/after the task's current stepIndex", () => {
    expect(stepGateState(0, 2, "in_progress")).toBe("done");
    expect(stepGateState(2, 2, "in_progress")).toBe("current");
    expect(stepGateState(2, 2, "failed")).toBe("failed");
    expect(stepGateState(3, 2, "in_progress")).toBe("pending");
  });
  it("stepTimestamps keys the FIRST ts a stepIndex was reached, per taskId", () => {
    const events = [
      { kind: "task_step_advanced", data: { taskId: "t1", stepIndex: 0 }, ts: 100 },
      { kind: "task_step_advanced", data: { taskId: "t2", stepIndex: 0 }, ts: 200 },
      { kind: "task_step_advanced", data: { taskId: "t1", stepIndex: 1 }, ts: 150 },
      { kind: "task_step_failed", data: { taskId: "t1", stepIndex: 1 }, ts: 175 },        // never keyed (not "advanced")
    ] as never[];
    expect(stepTimestamps(events, "t1")).toEqual(new Map([[0, 100], [1, 150]]));
  });
});

describe("stepHistoryEntry (TaskInspector per-step agent/duration/failure reason)", () => {
  it("null when the task carries no stepHistory at all", () => {
    expect(stepHistoryEntry({ taskId: "t1" }, 0)).toBeNull();
  });
  it("null for a stepIndex never reached", () => {
    const raw = { stepHistory: [{ stepIndex: 0, stepId: "plan", agentId: "a1", startedAt: 100, endedAt: 110, outcome: "passed" }] };
    expect(stepHistoryEntry(raw, 1)).toBeNull();
  });
  it("computes durationMs from endedAt - startedAt", () => {
    const raw = { stepHistory: [{ stepIndex: 0, stepId: "plan", agentId: "a1", startedAt: 100, endedAt: 140, outcome: "passed" }] };
    expect(stepHistoryEntry(raw, 0)).toEqual({
      stepIndex: 0, agentId: "a1", startedAt: 100, endedAt: 140, outcome: "passed", reason: null, durationMs: 40, handoffSummary: null,
    });
  });
  it("durationMs is null while the attempt is still in flight (endedAt null) — never guessed", () => {
    const raw = { stepHistory: [{ stepIndex: 0, stepId: "plan", agentId: "a1", startedAt: 100, endedAt: null, outcome: null }] };
    expect(stepHistoryEntry(raw, 0)!.durationMs).toBeNull();
  });
  it("a failed attempt carries its reason", () => {
    const raw = { stepHistory: [{ stepIndex: 1, stepId: "test", agentId: "a1", startedAt: 100, endedAt: 130, outcome: "failed", reason: "exit 1" }] };
    expect(stepHistoryEntry(raw, 1)).toMatchObject({ outcome: "failed", reason: "exit 1", durationMs: 30 });
  });
  it("multiple attempts at the same stepIndex (retries): the LATEST entry wins", () => {
    const raw = {
      stepHistory: [
        { stepIndex: 1, stepId: "test", agentId: "a1", startedAt: 100, endedAt: 110, outcome: "retried", reason: "exit 1" },
        { stepIndex: 1, stepId: "test", agentId: "a2", startedAt: 200, endedAt: 240, outcome: "passed" },
      ],
    };
    expect(stepHistoryEntry(raw, 1)).toEqual({
      stepIndex: 1, agentId: "a2", startedAt: 200, endedAt: 240, outcome: "passed", reason: null, durationMs: 40, handoffSummary: null,
    });
  });
  it("F16.1 Phase 3 (WF-9/WF-10): reads a captured handoffSummary when present", () => {
    const raw = { stepHistory: [{ stepIndex: 1, stepId: "review", agentId: "a2", startedAt: 200, endedAt: 240, outcome: "passed", handoffSummary: "did the thing" }] };
    expect(stepHistoryEntry(raw, 1)!.handoffSummary).toBe("did the thing");
  });
});

describe("stepHandoffIndices (F16.1 Phase 3 WF-10, task_step_handoff event ring)", () => {
  it("collects every toStepIndex this task's handoff events landed on", () => {
    const events = [
      evt("task_step_handoff", { taskId: "t1", toStepIndex: 1 }),
      evt("task_step_advanced", { taskId: "t1", stepIndex: 1 }),
      evt("task_step_handoff", { taskId: "t2", toStepIndex: 1 }),
      evt("task_step_handoff", { taskId: "t1", toStepIndex: 2 }),
    ];
    expect(stepHandoffIndices(events, "t1")).toEqual(new Set([1, 2]));
    expect(stepHandoffIndices(events, "t2")).toEqual(new Set([1]));
    expect(stepHandoffIndices(events, "t3")).toEqual(new Set());
  });
});

describe("workflowStepDots + agentWorkflowStepDots (AgentList step indicator)", () => {
  const workflow = workflowRow(rec()); // 3 steps: plan (none) / test (command) / ship it (approval)

  it("null when the task carries no binding, or the definition hasn't resolved", () => {
    expect(workflowStepDots({ taskId: "t1" }, workflow, false)).toBeNull();
    expect(workflowStepDots({ workflow: { name: "release-flow", version: 2 } }, null, false)).toBeNull();
  });

  it("done/pending/current split around stepIndex", () => {
    const raw = { workflow: { name: "release-flow", version: 2 }, stepIndex: 1, state: "in_progress" };
    expect(workflowStepDots(raw, workflow, false)).toEqual(["done", "current", "pending"]);
  });

  it("a failed gate at the current step is red, not current", () => {
    const raw = { workflow: { name: "release-flow", version: 2 }, stepIndex: 1, state: "failed" };
    expect(workflowStepDots(raw, workflow, false)).toEqual(["done", "failed", "pending"]);
  });

  it("waiting=true colors the current step amber instead of pulsing green", () => {
    const raw = { workflow: { name: "release-flow", version: 2 }, stepIndex: 2, state: "in_progress" };
    expect(workflowStepDots(raw, workflow, true)).toEqual(["done", "done", "waiting"]);
  });

  it("a done task is ALL green, even though stepIndex never advances past the last step", () => {
    const raw = { workflow: { name: "release-flow", version: 2 }, stepIndex: 2, state: "done" };
    expect(workflowStepDots(raw, workflow, false)).toEqual(["done", "done", "done"]);
  });

  it("agentWorkflowStepDots: waiting only when the CURRENT step is an approval gate AND a question is pending", () => {
    const atApproval = { workflow: { name: "release-flow", version: 2 }, stepIndex: 2, state: "in_progress" };
    expect(agentWorkflowStepDots(atApproval, workflow, { questionId: "q1" })).toEqual(["done", "done", "waiting"]);
    expect(agentWorkflowStepDots(atApproval, workflow, null)).toEqual(["done", "done", "current"]);

    const atCommand = { workflow: { name: "release-flow", version: 2 }, stepIndex: 1, state: "in_progress" };
    // a pendingQuestion at a NON-approval step never paints waiting (command/artifact gates don't ask())
    expect(agentWorkflowStepDots(atCommand, workflow, { questionId: "q1" })).toEqual(["done", "current", "pending"]);
  });

  it("agentWorkflowStepDots is null with no raw task or no resolved workflow", () => {
    expect(agentWorkflowStepDots(null, workflow, null)).toBeNull();
    expect(agentWorkflowStepDots({ workflow: { name: "release-flow", version: 2 } }, null, null)).toBeNull();
  });
});

describe("WorkflowFormCard field-state helpers", () => {
  it("validateWorkflowForm catches name/step/retryLimit shape errors", () => {
    const base = defaultWorkflowFormValues();
    expect(validateWorkflowForm({ ...base, name: "" })).toMatch(/name/);
    expect(validateWorkflowForm({ ...base, name: "bad name" })).toMatch(/name/);
    expect(validateWorkflowForm({ ...base, name: "ok", steps: [] })).toMatch(/step/);
    expect(validateWorkflowForm({ ...base, name: "ok", retryLimit: "-1" })).toMatch(/retry limit/);
    const noTitle = { ...base, name: "ok", steps: [emptyWorkflowStep()] };
    expect(validateWorkflowForm(noTitle)).toMatch(/title/);
    const commandNoCommand = { ...base, name: "ok", steps: [{ ...emptyWorkflowStep(), title: "t", gateKind: "command" as const }] };
    expect(validateWorkflowForm(commandNoCommand)).toMatch(/command/);
    const dupIds = { ...base, name: "ok", steps: [{ ...emptyWorkflowStep(), title: "same" }, { ...emptyWorkflowStep(), title: "same" }] };
    expect(validateWorkflowForm(dupIds)).toMatch(/unique/);
    expect(validateWorkflowForm({ ...base, name: "ok", steps: [{ ...emptyWorkflowStep(), title: "plan" }] })).toBeNull();
  });

  it("validateWorkflowForm: per-step timeoutMs (command-only) and retryLimit overrides", () => {
    const base = defaultWorkflowFormValues();
    const badTimeout = { ...base, name: "ok", steps: [{ ...emptyWorkflowStep(), title: "t", gateKind: "command" as const, command: "npm", timeoutMs: "500" }] };
    expect(validateWorkflowForm(badTimeout)).toMatch(/timeout/);
    const okTimeout = { ...base, name: "ok", steps: [{ ...emptyWorkflowStep(), title: "t", gateKind: "command" as const, command: "npm", timeoutMs: "300000" }] };
    expect(validateWorkflowForm(okTimeout)).toBeNull();
    // timeoutMs on a non-command step is simply ignored (never built) — no validation error
    const ignoredTimeout = { ...base, name: "ok", steps: [{ ...emptyWorkflowStep(), title: "t", timeoutMs: "500" }] };
    expect(validateWorkflowForm(ignoredTimeout)).toBeNull();
    const badStepRetryLimit = { ...base, name: "ok", steps: [{ ...emptyWorkflowStep(), title: "t", retryLimit: "-1" }] };
    expect(validateWorkflowForm(badStepRetryLimit)).toMatch(/retry limit/);
    const okStepRetryLimit = { ...base, name: "ok", steps: [{ ...emptyWorkflowStep(), title: "t", onFail: "retry" as const, retryLimit: "5" }] };
    expect(validateWorkflowForm(okStepRetryLimit)).toBeNull();
  });

  it("slugify derives a CoordName-safe default step id from its title", () => {
    expect(slugify("Run Tests!")).toBe("run-tests");
    expect(slugify("  ship it  ")).toBe("ship-it");
  });

  it("buildWorkflowSteps/Spec/Patch shape the protocol params", () => {
    const v: WorkflowFormValues = {
      name: "release-flow", onFail: "retry", retryLimit: "2",
      steps: [
        { ...emptyWorkflowStep(), id: "", title: "run tests", gateKind: "command", command: "npm", args: "test --ci" },
        { ...emptyWorkflowStep(), id: "ship", title: "ship it", gateKind: "approval", approvalPrompt: "ship it?" },
      ],
    };
    expect(buildWorkflowSteps(v)).toEqual([
      { id: "run-tests", title: "run tests", gate: { kind: "command", spec: { command: "npm", args: ["test", "--ci"] } } },
      { id: "ship", title: "ship it", gate: { kind: "approval", spec: { prompt: "ship it?" } } },
    ]);
    expect(buildWorkflowSpec(v)).toEqual({ name: "release-flow", onFail: "retry", retryLimit: 2, steps: buildWorkflowSteps(v) });
    expect(buildWorkflowPatch(v)).toEqual({ onFail: "retry", retryLimit: 2, steps: buildWorkflowSteps(v) });
    expect(buildWorkflowPatch(v)).not.toHaveProperty("name");
  });

  it("buildWorkflowSteps includes instructions when set, and OMITS the key entirely when blank/whitespace", () => {
    const v: WorkflowFormValues = {
      name: "release-flow", onFail: "halt", retryLimit: "",
      steps: [
        { ...emptyWorkflowStep(), id: "plan", title: "plan", instructions: "  read the checklist  " },
        { ...emptyWorkflowStep(), id: "test", title: "test", instructions: "   " },
      ],
    };
    const steps = buildWorkflowSteps(v);
    expect(steps[0]).toEqual({ id: "plan", title: "plan", gate: { kind: "none" }, instructions: "read the checklist" });
    expect(steps[1]).toEqual({ id: "test", title: "test", gate: { kind: "none" } });
    expect(steps[1]).not.toHaveProperty("instructions");
  });

  it("buildWorkflowSteps: command timeoutMs, artifact scope/kind, per-step onFail/retryLimit — all OMITTED when unset, included when set", () => {
    const bare: WorkflowFormValues = {
      name: "wf", onFail: "halt", retryLimit: "",
      steps: [{ ...emptyWorkflowStep(), id: "build", title: "build", gateKind: "artifact" }],
    };
    expect(buildWorkflowSteps(bare)[0]).toEqual({ id: "build", title: "build", gate: { kind: "artifact", spec: {} } });

    const full: WorkflowFormValues = {
      name: "wf", onFail: "halt", retryLimit: "",
      steps: [
        { ...emptyWorkflowStep(), id: "test", title: "test", gateKind: "command", command: "npm", args: "test", timeoutMs: "300000", onFail: "retry", retryLimit: "3" },
        { ...emptyWorkflowStep(), id: "build", title: "build", gateKind: "artifact", artifactId: "out", artifactScope: "step", artifactKind: "diff" },
      ],
    };
    expect(buildWorkflowSteps(full)[0]).toEqual({
      id: "test", title: "test", gate: { kind: "command", spec: { command: "npm", args: ["test"], timeoutMs: 300_000 } },
      onFail: "retry", retryLimit: 3,
    });
    expect(buildWorkflowSteps(full)[1]).toEqual({
      id: "build", title: "build", gate: { kind: "artifact", spec: { artifactId: "out", scope: "step", kind: "diff" } },
    });
  });

  it("workflowFormValuesFromRow round-trips a WorkflowRow losslessly (edit-prefill), instructions included", () => {
    const row = workflowRow(rec());
    const values = workflowFormValuesFromRow(row);
    expect(values.name).toBe("release-flow");
    expect(values.onFail).toBe("retry");
    expect(values.retryLimit).toBe("2");
    expect(values.steps).toEqual([
      { id: "plan", title: "plan", gateKind: "none", command: "", args: "", timeoutMs: "", artifactId: "", artifactScope: "task", artifactKind: "", approvalPrompt: "", instructions: "read the release checklist first", onFail: "", retryLimit: "", role: "", context: "handoff" },
      { id: "test", title: "test", gateKind: "command", command: "npm", args: "test", timeoutMs: "300000", artifactId: "", artifactScope: "task", artifactKind: "", approvalPrompt: "", instructions: "", onFail: "", retryLimit: "", role: "", context: "handoff" },
      { id: "ship", title: "ship it", gateKind: "approval", command: "", args: "", timeoutMs: "", artifactId: "", artifactScope: "task", artifactKind: "", approvalPrompt: "ship it?", instructions: "", onFail: "", retryLimit: "", role: "", context: "handoff" },
    ]);
    // re-derives the SAME gate shape + instructions the original record carried
    expect(buildWorkflowSteps(values)[0]).toEqual({
      id: "plan", title: "plan", gate: { kind: "none" }, instructions: "read the release checklist first",
    });
    expect(buildWorkflowSteps(values)[1]!["gate"]).toEqual({ kind: "command", spec: { command: "npm", args: ["test"], timeoutMs: 300_000 } });
    // step with no instructions round-trips to absent, not ""
    expect(buildWorkflowSteps(values)[1]).not.toHaveProperty("instructions");
  });

  it("F16.1 Phase 3 (WF-10): role/context round-trip through workflowRow -> form values -> buildWorkflowSteps", () => {
    const row = workflowRow(rec({
      steps: [
        { id: "plan", title: "plan", gate: { kind: "none" }, role: "reviewer", context: "none" },
        { id: "test", title: "test", gate: { kind: "none" } },
      ],
    }));
    expect(row.steps[0]).toMatchObject({ role: "reviewer", context: "none" });
    expect(row.steps[1]).toMatchObject({ role: "", context: "handoff" });

    const values = workflowFormValuesFromRow(row);
    expect(values.steps[0]).toMatchObject({ role: "reviewer", context: "none" });
    expect(values.steps[1]).toMatchObject({ role: "", context: "handoff" });

    const built = buildWorkflowSteps(values);
    // a set role + non-default context are both sent on the wire
    expect(built[0]).toMatchObject({ role: "reviewer", context: "none" });
    // a blank role and the default "handoff" context are both OMITTED, not sent as "" / "handoff"
    expect(built[1]).not.toHaveProperty("role");
    expect(built[1]).not.toHaveProperty("context");
  });
});

// ---------------------------------------------------------------------------
// WORKFLOW-TASK-VIEW-2: task-row grouping + the stitched-transcript builder.
// Mode-agnostic: a multi-agent task (distinct stepHistory agentIds per step)
// and a single-agent task (the SAME agentId across every step) must produce
// the SAME shape — exactly ONE row (no nested children, ever) — via the
// identical code path (no mode branch).
// ---------------------------------------------------------------------------

const agentRow = (agentId: string, overrides: Partial<AgentRow> = {}): AgentRow => ({
  kind: "agent", agentId, depth: 0, collapsible: false, collapsed: false, hiddenCount: 0, ...overrides,
});

const xprovWorkflow = rec({
  name: "q-xprov", version: 1,
  steps: [
    { id: "design", title: "design", gate: { kind: "none" }, role: "glm" },
    { id: "build", title: "build", gate: { kind: "none" }, role: "claude" },
    { id: "verify", title: "verify", gate: { kind: "none" }, role: "codex" },
  ],
});

function multiAgentTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "t-multi", queue: "q-xprov", state: "in_progress", agentId: "codex-3",
    workflow: { name: "q-xprov", version: 1 }, stepIndex: 2,
    stepHistory: [
      { stepIndex: 0, stepId: "design", agentId: "glm-1", startedAt: 100, endedAt: 200, outcome: "passed" },
      { stepIndex: 1, stepId: "build", agentId: "claude-2", startedAt: 200, endedAt: 300, outcome: "passed" },
      { stepIndex: 2, stepId: "verify", agentId: "codex-3", startedAt: 300, endedAt: null, outcome: null },
    ],
    ...overrides,
  };
}

function singleAgentTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "t-single", queue: "q-solo", state: "in_progress", agentId: "solo-1",
    workflow: { name: "release-flow", version: 2 }, stepIndex: 2,
    stepHistory: [
      { stepIndex: 0, stepId: "plan", agentId: "solo-1", startedAt: 100, endedAt: 200, outcome: "passed" },
      { stepIndex: 1, stepId: "test", agentId: "solo-1", startedAt: 200, endedAt: 300, outcome: "passed" },
      { stepIndex: 2, stepId: "ship", agentId: "solo-1", startedAt: 300, endedAt: null, outcome: null },
    ],
    ...overrides,
  };
}

describe("taskRowId/taskIdFromRowId", () => {
  it("round-trips a taskId through the synthetic row id", () => {
    expect(taskRowId("t-1")).toBe("task:t-1");
    expect(taskIdFromRowId("task:t-1")).toBe("t-1");
  });
  it("a plain agentId (no task: prefix) resolves to null", () => {
    expect(taskIdFromRowId("agent-abc")).toBeNull();
  });
});

describe("taskStepAgentIds", () => {
  it("distinct, first-seen order, deduped", () => {
    expect(taskStepAgentIds(multiAgentTask())).toEqual(["glm-1", "claude-2", "codex-3"]);
  });
  it("single-agent: one distinct id even though it repeats 3×", () => {
    expect(taskStepAgentIds(singleAgentTask())).toEqual(["solo-1"]);
  });
  it("falls back to task.agentId for an empty/legacy stepHistory", () => {
    expect(taskStepAgentIds({ agentId: "legacy-1", stepHistory: [] })).toEqual(["legacy-1"]);
    expect(taskStepAgentIds({ agentId: null, stepHistory: [] })).toEqual([]);
  });
});

describe("taskDistinctAgentIds", () => {
  it("multi-agent: matches taskStepAgentIds — the live agent is already the tail history entry", () => {
    expect(taskDistinctAgentIds(multiAgentTask())).toEqual(["glm-1", "claude-2", "codex-3"]);
  });
  it("single-agent: one distinct id", () => {
    expect(taskDistinctAgentIds(singleAgentTask())).toEqual(["solo-1"]);
  });
  it("unions in the current bound agentId when it hasn't landed in stepHistory yet (the markInProgress-before-startStep window)", () => {
    const task = { agentId: "a2", stepHistory: [{ stepIndex: 0, stepId: "s0", agentId: "a1", startedAt: 100, endedAt: 200, outcome: "passed" }] };
    expect(taskDistinctAgentIds(task)).toEqual(["a1", "a2"]);
  });
  it("falls back to task.agentId for an empty/legacy stepHistory, same as taskStepAgentIds", () => {
    expect(taskDistinctAgentIds({ agentId: "legacy-1", stepHistory: [] })).toEqual(["legacy-1"]);
  });
});

describe("groupAgentListRowsByTask — mode-agnostic (multi-agent + single-agent, same code path)", () => {
  const workflows = [workflowRow(xprovWorkflow), workflowRow(rec())]; // rec() === "release-flow" v2
  const meta = (costs: Record<string, number> = {}): Record<string, AgentMetaForTask> => {
    const m: Record<string, AgentMetaForTask> = {};
    for (const [id, costUsd] of Object.entries(costs)) m[id] = { costUsd, usage: null, pendingQuestion: undefined };
    return m;
  };
  // R2 UI FIX: label resolution reads agent NAMES via conductorLabel — a fixture with
  // real (empty-but-shaped) AgentView entries for every step agent used below.
  const agents: Record<string, AgentView> = {
    "glm-1": emptyAgent("glm-1"),
    "claude-2": emptyAgent("claude-2"),
    "codex-3": emptyAgent("codex-3"),
    "solo-1": emptyAgent("solo-1"),
  };

  it("multi-agent: 3 distinct step agents collapse into exactly ONE row — no nested children at all", () => {
    const rows = [agentRow("glm-1"), agentRow("claude-2"), agentRow("codex-3")];
    const out = groupAgentListRowsByTask(rows, [multiAgentTask()], meta(), workflows, agents);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "task", taskId: "t-multi", depth: 0 });
  });

  it("single-agent: the SAME agentId across every step still collapses into ONE row — same shape as the multi-agent case", () => {
    const rows = [agentRow("solo-1")];
    const out = groupAgentListRowsByTask(rows, [singleAgentTask()], meta(), workflows, agents);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "task", taskId: "t-single", depth: 0 });
  });

  it("single-agent: labels with the AGENT's name (+ queue), not the workflow name", () => {
    const single = groupAgentListRowsByTask([agentRow("solo-1")], [singleAgentTask()], meta(), workflows, agents)[0] as { label: string };
    expect(single.label).toBe(`${conductorLabel(agents, "solo-1")} · q-solo`);
    expect(single.label).not.toMatch(/release-flow/);
  });

  it("multi-agent: keeps the workflow name + queue, appending the CURRENT step agent so rows stay distinguishable", () => {
    const multi = groupAgentListRowsByTask(
      [agentRow("glm-1"), agentRow("claude-2"), agentRow("codex-3")], [multiAgentTask()], meta(), workflows, agents,
    )[0] as { label: string };
    expect(multi.label).toBe(`q-xprov · q-xprov · @${conductorLabel(agents, "codex-3")}`); // workflow name === queue name in this fixture
  });

  it("single-agent: an agent absent from the `agents` map falls back to conductorLabel's own shortId behavior, never crashes", () => {
    const single = groupAgentListRowsByTask([agentRow("solo-1")], [singleAgentTask()], meta(), workflows, {})[0] as { label: string };
    expect(single.label).toBe(`${conductorLabel({}, "solo-1")} · q-solo`);
  });

  it("both modes produce step DOTS in the state cell, driven by the task's own stepIndex/state (not a per-member value)", () => {
    const multi = groupAgentListRowsByTask(
      [agentRow("glm-1"), agentRow("claude-2"), agentRow("codex-3")], [multiAgentTask()], meta(), workflows, agents,
    )[0] as { stepDots: string[] | null };
    const single = groupAgentListRowsByTask([agentRow("solo-1")], [singleAgentTask()], meta(), workflows, agents)[0] as { stepDots: string[] | null };
    // both fixtures: stepIndex 2 of 3, state in_progress, current step gate isn't "approval" ⇒ "current"
    expect(multi.stepDots).toEqual(["done", "done", "current"]);
    expect(single.stepDots).toEqual(["done", "done", "current"]);
  });

  it("cost AND tokens sum every member agent's usage, for either mode", () => {
    const multiMeta: Record<string, AgentMetaForTask> = {
      "glm-1": { costUsd: 0.1, usage: { input: 100, output: 50 }, pendingQuestion: undefined },
      "claude-2": { costUsd: 0.2, usage: { input: 200, output: 80 }, pendingQuestion: undefined },
      "codex-3": { costUsd: 0.05, usage: null, pendingQuestion: undefined },
    };
    const multi = groupAgentListRowsByTask(
      [agentRow("glm-1"), agentRow("claude-2"), agentRow("codex-3")], [multiAgentTask()], multiMeta, workflows, agents,
    )[0] as { costUsd: number; usage: { input: number; output: number } | null };
    expect(multi.costUsd).toBeCloseTo(0.35);
    expect(multi.usage).toEqual({ input: 300, output: 130 }); // codex-3's null usage doesn't zero out the sum

    const single = groupAgentListRowsByTask(
      [agentRow("solo-1")], [singleAgentTask()], meta({ "solo-1": 0.42 }), workflows, agents,
    )[0] as { costUsd: number; usage: unknown };
    expect(single.costUsd).toBeCloseTo(0.42);
    expect(single.usage).toBeNull(); // meta()'s usage is always null in this fixture
  });

  it("a task with no workflow binding at all is left ungrouped", () => {
    const rows = [agentRow("plain-1")];
    const out = groupAgentListRowsByTask(rows, [{ taskId: "t-plain", agentId: "plain-1", workflow: null, stepHistory: [] }], meta(), workflows, agents);
    expect(out).toEqual(rows);
  });

  it("a member not currently present in `rows` (e.g. search-filtered out) still collapses whatever IS visible into one row", () => {
    const out = groupAgentListRowsByTask([agentRow("glm-1")], [multiAgentTask()], meta(), workflows, agents);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "task", taskId: "t-multi" });
  });
});

describe("visibleListRowIds", () => {
  it("a workflow task maps to its ONE synthetic id — no nested agent row to also step over", () => {
    const out = groupAgentListRowsByTask([agentRow("solo-1")], [singleAgentTask()], {}, [workflowRow(rec())], {});
    expect(visibleListRowIds(out)).toEqual(["task:t-single"]);
  });
  it("a plain (non-grouped) agent row maps to its agentId", () => {
    expect(visibleListRowIds([agentRow("plain-1")])).toEqual(["plain-1"]);
  });
});

describe("stitchedStepSections — mode-agnostic (agentId + a time range per attempt)", () => {
  const xprovRow = workflowRow(xprovWorkflow);
  const releaseRow = workflowRow(rec());

  it("multi-agent: one section per step, each a distinct agentId + handoff boundary at every step past the first", () => {
    const sections = stitchedStepSections(multiAgentTask(), xprovRow);
    expect(sections).toHaveLength(3);
    expect(sections.map((s) => s.agentId)).toEqual(["glm-1", "claude-2", "codex-3"]);
    expect(sections.map((s) => s.isHandoffBoundary)).toEqual([false, true, true]);
    expect(sections[0]).toMatchObject({ stepIndex: 0, attempt: 0, stepTitle: "design", role: "glm", startedAt: 100, endedAt: 200, durationMs: 100 });
    expect(sections[2]).toMatchObject({ stepIndex: 2, endedAt: null, durationMs: null }); // still in flight
  });

  it("single-agent: one section per step, SAME agentId throughout, NO handoff boundaries", () => {
    const sections = stitchedStepSections(singleAgentTask(), releaseRow);
    expect(sections).toHaveLength(3);
    expect(sections.map((s) => s.agentId)).toEqual(["solo-1", "solo-1", "solo-1"]);
    expect(sections.every((s) => !s.isHandoffBoundary)).toBe(true);
    // each still carries its OWN [startedAt,endedAt] window — the segmentation signal
    expect(sections.map((s) => [s.startedAt, s.endedAt])).toEqual([[100, 200], [200, 300], [300, null]]);
  });

  it("a retried step gets a second section with attempt:1 at the SAME stepIndex", () => {
    const retried = multiAgentTask({
      stepHistory: [
        { stepIndex: 0, stepId: "design", agentId: "glm-1", startedAt: 100, endedAt: 150, outcome: "failed", reason: "timeout" },
        { stepIndex: 0, stepId: "design", agentId: "glm-1b", startedAt: 150, endedAt: 220, outcome: "passed" },
      ],
    });
    const sections = stitchedStepSections(retried, xprovRow);
    expect(sections.map((s) => ({ stepIndex: s.stepIndex, attempt: s.attempt, outcome: s.outcome }))).toEqual([
      { stepIndex: 0, attempt: 0, outcome: "failed" },
      { stepIndex: 0, attempt: 1, outcome: "passed" },
    ]);
  });

  it("empty/legacy stepHistory yields no sections", () => {
    expect(stitchedStepSections({ stepHistory: [] }, xprovRow)).toEqual([]);
  });
});

describe("liveTaskStepAgentId", () => {
  it("the task's current agentId while in_progress", () => {
    expect(liveTaskStepAgentId({ state: "in_progress", agentId: "codex-3" })).toBe("codex-3");
  });
  it("null once settled (done/failed/pending) — nothing 'live' to target", () => {
    expect(liveTaskStepAgentId({ state: "done", agentId: "codex-3" })).toBeNull();
    expect(liveTaskStepAgentId({ state: "pending", agentId: null })).toBeNull();
    expect(liveTaskStepAgentId(null)).toBeNull();
  });
});

// WORKFLOW-HEADER-CHIPS-DEAD: model/effort/account overlays (ModelCard/EffortCard/
// AccountCard, commands.system.ts) all used to index `state.agents[selectedAgentId]`
// directly — a task-row selection is the synthetic `task:<id>` string (never a real
// agents key), so the lookup silently returned undefined and the overlay rendered
// nothing despite its own "open" flag flipping true. overlayTargetAgentId is the fix:
// it resolves a task-row selection to that task's live step agent (mirroring
// liveTaskStepAgentId's own in_progress gate, via the TaskLite fold instead of raw).
describe("overlayTargetAgentId", () => {
  it("passes a real (non-task-row) selectedAgentId through unchanged", () => {
    expect(overlayTargetAgentId({ selectedAgentId: "codex-3", tasks: {} })).toBe("codex-3");
  });

  it("null when nothing is selected", () => {
    expect(overlayTargetAgentId({ selectedAgentId: null, tasks: {} })).toBeNull();
  });

  it("resolves a task-row selection to its live step agentId while in_progress", () => {
    expect(
      overlayTargetAgentId({
        selectedAgentId: "task:t1",
        tasks: { t1: { state: "in_progress", agentId: "codex-3" } },
      }),
    ).toBe("codex-3");
  });

  it("null for a task-row selection once the task has settled — no live agent to change", () => {
    expect(
      overlayTargetAgentId({
        selectedAgentId: "task:t1",
        tasks: { t1: { state: "done", agentId: "codex-3" } },
      }),
    ).toBeNull();
  });

  it("null for a task-row selection the store hasn't folded a TaskLite for yet", () => {
    expect(overlayTargetAgentId({ selectedAgentId: "task:unknown", tasks: {} })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WORKFLOW-UI-1: workflowFlowBarView — the pinned bar's view model, zipping
// workflow.steps against workflowStepDots + the latest stitchedStepSections
// entry per step. Same multi-/single-agent fixtures as the stitched-sections
// suite above — mode-agnostic, no branch on which mode this task is.
// ---------------------------------------------------------------------------

describe("workflowFlowBarView", () => {
  const xprovRow = workflowRow(xprovWorkflow);
  const releaseRow = workflowRow(rec());

  it("multi-agent: per-step role/agent/duration + handoff boundary at every step past the first", () => {
    const task = multiAgentTask();
    const sections = stitchedStepSections(task, xprovRow);
    const view = workflowFlowBarView(task, xprovRow, sections);
    expect(view).toMatchObject({ name: "q-xprov", version: 1, enforced: true });
    expect(view!.steps).toEqual([
      { title: "design", role: "glm", state: "done", durationMs: 100, agentId: "glm-1", isHandoffBoundary: false, reason: null },
      { title: "build", role: "claude", state: "done", durationMs: 100, agentId: "claude-2", isHandoffBoundary: true, reason: null },
      { title: "verify", role: "codex", state: "current", durationMs: null, agentId: "codex-3", isHandoffBoundary: true, reason: null },
    ]);
  });

  it("single-agent: same repeated agent throughout, NO handoff boundaries", () => {
    const task = singleAgentTask();
    const sections = stitchedStepSections(task, releaseRow);
    const view = workflowFlowBarView(task, releaseRow, sections);
    expect(view).toMatchObject({ name: "release-flow", version: 2, enforced: true });
    expect(view!.steps.map((s) => s.agentId)).toEqual(["solo-1", "solo-1", "solo-1"]);
    expect(view!.steps.map((s) => s.isHandoffBoundary)).toEqual([false, false, false]);
    expect(view!.steps.map((s) => s.state)).toEqual(["done", "done", "current"]);
  });

  it("a failed step surfaces its gate-failure reason", () => {
    const task = multiAgentTask({
      state: "failed",
      stepIndex: 1,
      stepHistory: [
        { stepIndex: 0, stepId: "design", agentId: "glm-1", startedAt: 100, endedAt: 200, outcome: "passed" },
        { stepIndex: 1, stepId: "build", agentId: "claude-2", startedAt: 200, endedAt: 260, outcome: "failed", reason: "exit 1" },
      ],
    });
    const sections = stitchedStepSections(task, xprovRow);
    const view = workflowFlowBarView(task, xprovRow, sections);
    expect(view!.steps[1]).toMatchObject({ state: "failed", reason: "exit 1" });
    expect(view!.steps[2]).toMatchObject({ state: "pending", agentId: null });
  });

  it("null when the task carries no workflow binding at all", () => {
    expect(workflowFlowBarView({ taskId: "t-plain" }, null, [])).toBeNull();
  });

  it("null when the binding hasn't resolved to a definition yet", () => {
    expect(workflowFlowBarView(multiAgentTask(), null, [])).toBeNull();
  });
});
