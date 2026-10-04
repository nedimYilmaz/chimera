import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// TaskInspector renders ArtifactChip, which imports the Tauri rpc/bridge
// module — that module fires real @tauri-apps/api listen()/invoke() calls as
// an import-time DEV side effect, which throws ("window is not defined") in
// vitest's node environment (no other test file today imports a component
// that reaches bridge.ts transitively). Stub it so this test only exercises
// TaskInspector's own rendering, not the live daemon transport.
vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => ({})),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  readArtifactSnapshot: vi.fn(async () => ""),
  openArtifactSnapshot: vi.fn(async () => {}),
  openArtifactUrl: vi.fn(async () => {}),
  setDockBadge: vi.fn(async () => {}),
  exportCsv: vi.fn(async () => ""),
  checkpointFilesSince: vi.fn(async () => 0),
}));

import { TaskInspector } from "../src/components/TaskInspector";
import { taskRowView } from "../src/state/selectors.coord";
import { stepTimestamps, workflowRow } from "../src/state/selectors.workflows";

// F16.1 Phase 2 (WF-6 UI) — TaskInspector's workflow step list now reads
// TaskRecord.stepHistory (via stepHistoryEntry) for the per-step agent,
// gate-failure reason, and duration, instead of only the task's CURRENT
// agentId. Rendered with react-test-renderer (same harness as
// WorkflowStepDots.test.tsx — no DOM needed).

const workflow = workflowRow({
  name: "release-flow",
  version: 1,
  onFail: "halt",
  retryLimit: 0,
  createdAt: 0,
  steps: [
    { id: "plan", title: "plan", gate: { kind: "none" } },
    { id: "test", title: "test", gate: { kind: "command", spec: { command: "npm", args: ["test"] } } },
    { id: "ship", title: "ship it", gate: { kind: "approval", spec: { prompt: "ship it?" } } },
  ],
});

function baseRaw(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "t1",
    state: "failed",
    role: "worker",
    agentId: "current-agent",
    attempts: 1,
    priority: 0,
    prompt: "ship the release",
    workflow: { name: "release-flow", version: 1 },
    stepIndex: 1,
    stepHistory: [
      { stepIndex: 0, stepId: "plan", agentId: "agent-a", startedAt: 1000, endedAt: 41_000, outcome: "passed" },
      { stepIndex: 1, stepId: "test", agentId: "agent-b", startedAt: 100_000, endedAt: 130_000, outcome: "failed", reason: "exit 1" },
    ],
    ...overrides,
  };
}

function renderInspector(
  raw: Record<string, unknown>,
  onOpenAgent = vi.fn(),
  extra: Record<string, unknown> = {},
) {
  const task = taskRowView(raw);
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      React.createElement(TaskInspector, {
        task,
        raw,
        retryLimit: 0,
        team: null,
        workflow,
        stepTimestamps: stepTimestamps([], "t1"),
        onOpenAgent,
        ...extra,
      }),
    );
  });
  return { renderer, onOpenAgent };
}

describe("TaskInspector — workflow step list reads stepHistory (WF-6)", () => {
  it("renders each step's duration from stepHistory, and the failed step's gate-failure reason", () => {
    const { renderer } = renderInspector(baseRaw());
    const planStep = renderer.root.findByProps({ "data-workflow-step": "plan" });
    const testStep = renderer.root.findByProps({ "data-workflow-step": "test" });
    expect(flattenText(planStep)).toContain("[40s]");
    expect(flattenText(testStep)).toContain("[30s]");
    expect(flattenText(testStep)).toContain("— exit 1");
    // the untouched, not-yet-reached step carries neither
    const shipStep = renderer.root.findByProps({ "data-workflow-step": "ship" });
    expect(flattenText(shipStep)).not.toMatch(/\[\d+s\]/);
  });

  it("click-through targets the STEP's own agentId from stepHistory, not the task's current agentId", () => {
    const { renderer, onOpenAgent } = renderInspector(baseRaw());
    const planStep = renderer.root.findByProps({ "data-workflow-step": "plan" });
    const testStep = renderer.root.findByProps({ "data-workflow-step": "test" });
    act(() => { (planStep.props["onClick"] as () => void)(); });
    expect(onOpenAgent).toHaveBeenCalledWith("agent-a");
    act(() => { (testStep.props["onClick"] as () => void)(); });
    expect(onOpenAgent).toHaveBeenCalledWith("agent-b");
  });

  it("a pending (not-yet-reached) step has no click target", () => {
    const { renderer } = renderInspector(baseRaw());
    const shipStep = renderer.root.findByProps({ "data-workflow-step": "ship" });
    expect(shipStep.props["onClick"]).toBeUndefined();
  });

  it("the current step falls back to task.agentId when stepHistory hasn't closed its entry yet", () => {
    const raw = baseRaw({
      state: "in_progress",
      stepIndex: 1,
      stepHistory: [
        { stepIndex: 0, stepId: "plan", agentId: "agent-a", startedAt: 1000, endedAt: 1040, outcome: "passed" },
        { stepIndex: 1, stepId: "test", agentId: null, startedAt: 2000, endedAt: null, outcome: null },
      ],
    });
    const { renderer, onOpenAgent } = renderInspector(raw);
    const testStep = renderer.root.findByProps({ "data-workflow-step": "test" });
    act(() => { (testStep.props["onClick"] as () => void)(); });
    expect(onOpenAgent).toHaveBeenCalledWith("current-agent");
  });
});

describe("TaskInspector — dim handoff marker between steps (F16.1 Phase 3, WF-10)", () => {
  it("renders a handoff marker before a step whose stepHistory entry carries a handoffSummary", () => {
    const raw = baseRaw({
      stepHistory: [
        { stepIndex: 0, stepId: "plan", agentId: "agent-a", startedAt: 1000, endedAt: 41_000, outcome: "passed" },
        { stepIndex: 1, stepId: "test", agentId: "agent-b", startedAt: 100_000, endedAt: 130_000, outcome: "failed", reason: "exit 1", handoffSummary: "did the plan, worktree clean" },
      ],
    });
    const { renderer } = renderInspector(raw);
    const marker = renderer.root.findByProps({ "data-handoff-marker": "test" });
    expect(flattenText(marker)).toContain("handoff");
    // no marker before the FIRST step (there is no prior step to hand off from)
    expect(() => renderer.root.findByProps({ "data-handoff-marker": "plan" })).toThrow();
  });

  it("also renders a marker from the stepHandoffs (task_step_handoff event ring) prop when stepHistory carries no summary", () => {
    const raw = baseRaw({
      stepHistory: [
        { stepIndex: 0, stepId: "plan", agentId: "agent-a", startedAt: 1000, endedAt: 41_000, outcome: "passed" },
        { stepIndex: 1, stepId: "test", agentId: "agent-b", startedAt: 100_000, endedAt: 130_000, outcome: "failed", reason: "exit 1" },
      ],
    });
    const { renderer } = renderInspector(raw, vi.fn(), { stepHandoffs: new Set([1]) });
    expect(() => renderer.root.findByProps({ "data-handoff-marker": "test" })).not.toThrow();
  });

  it("renders no marker when the boundary was NOT a role-switch (neither source present)", () => {
    const { renderer } = renderInspector(baseRaw());
    expect(() => renderer.root.findByProps({ "data-handoff-marker": "test" })).toThrow();
  });
});

describe("TaskInspector — TASK-EDIT-VERSIONING version indicator + prior history", () => {
  it("shows a compact v{n} · edited {ago} indicator and expands the prior history on click", () => {
    const raw = baseRaw({
      state: "pending",
      versions: [
        { version: 1, editedAt: Date.now() - 120_000, editedBy: null, changedFields: ["prompt"], prior: { prompt: "old brief" } },
        { version: 2, editedAt: Date.now() - 60_000, editedBy: null, changedFields: ["priority"], prior: { priority: 5 } },
      ],
    });
    const { renderer } = renderInspector(raw);
    const indicator = renderer.root.findByProps({ "data-task-versions": true });
    expect(flattenText(indicator)).toContain("v2");
    expect(flattenText(indicator)).toContain("edited");
    // collapsed by default — the prior rows aren't rendered until the toggle
    expect(() => renderer.root.findByProps({ "data-task-version": 2 })).toThrow();
    act(() => { (indicator.props["onClick"] as () => void)(); });
    const v2 = renderer.root.findByProps({ "data-task-version": 2 });
    expect(flattenText(v2)).toContain("changed: priority");
    expect(flattenText(v2)).toContain("priority=5"); // compact prior values
  });

  it("renders no version indicator for an un-edited task (versions: [])", () => {
    const { renderer } = renderInspector(baseRaw({ versions: [] }));
    expect(() => renderer.root.findByProps({ "data-task-versions": true })).toThrow();
  });
});

describe("TaskInspector — SURFACE-QUEUE-LATENCY wait/run duration rows", () => {
  it("renders the wait duration (pushedAt -> startedAt) and run duration (startedAt -> endedAt) for a task with both stamps", () => {
    const raw = baseRaw({ pushedAt: 1000, startedAt: 4000, endedAt: 9000 });
    const { renderer } = renderInspector(raw);
    const card = renderer.root.findByProps({ "data-task-inspector": true });
    const text = flattenText(card);
    expect(text).toContain("waited 3s");
    expect(text).toContain("ran 5s");
  });

  it("renders an empty state — no duration, no NaN, no fabricated 0 — for a task with no startedAt (queued or pre-TASK-STAMPS)", () => {
    const raw = baseRaw({ pushedAt: 1000 });
    delete raw["startedAt"];
    delete raw["endedAt"];
    const { renderer } = renderInspector(raw);
    const card = renderer.root.findByProps({ "data-task-inspector": true });
    const text = flattenText(card);
    expect(text).not.toMatch(/NaN/);
    expect(text).not.toContain("waited 0s");
    expect(text).not.toContain("ran 0s");
    expect(text).toContain("waited —");
    expect(text).toContain("ran —");
  });
});

// TASK-DETAIL: TaskInspector had the same gap the TUI's TaskInspector did —
// resultText/dependsOn live on the raw TaskRecord but were never rendered here.
describe("TaskInspector — resultText / dependsOn (TASK-DETAIL)", () => {
  it("renders dependsOn, and an empty list as an explicit '(none)'", () => {
    const { renderer } = renderInspector(baseRaw({ dependsOn: ["t-a", "t-b"] }));
    const deps = renderer.root.findByProps({ "data-task-depends-on": true });
    expect(flattenText(deps)).toBe("t-a, t-b");

    const { renderer: renderer2 } = renderInspector(baseRaw({ dependsOn: [] }));
    const deps2 = renderer2.root.findByProps({ "data-task-depends-on": true });
    expect(flattenText(deps2)).toBe("(none)");
  });

  it("renders resultText for a done task", () => {
    const { renderer } = renderInspector(baseRaw({ state: "done", resultText: "merged as a1b2c3d" }));
    const result = renderer.root.findByProps({ "data-task-result": true });
    expect(flattenText(result)).toBe("merged as a1b2c3d");
  });

  it("a still-running task with no result shows an honest 'still running' state, not a blank", () => {
    const { renderer } = renderInspector(baseRaw({ state: "in_progress", resultText: null }));
    const result = renderer.root.findByProps({ "data-task-result": true });
    expect(flattenText(result)).toContain("still running");
  });

  it("a terminal task with a genuinely empty resultText renders '(empty result)', distinct from still-running", () => {
    const { renderer } = renderInspector(baseRaw({ state: "failed", resultText: "" }));
    const result = renderer.root.findByProps({ "data-task-result": true });
    expect(flattenText(result)).toBe("(empty result)");
  });
});

function flattenText(node: { children?: unknown }): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === "string") { parts.push(n); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n && typeof n === "object" && "children" in n) walk((n as { children?: unknown }).children);
  };
  walk(node);
  return parts.join("");
}
