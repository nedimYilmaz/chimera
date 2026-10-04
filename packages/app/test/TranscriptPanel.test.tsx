import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// WORKFLOW-UI-4: TranscriptPanel is now the ONLY transcript component — a
// task-row selection feeds it the `workflow` prop (raw/workflow/sections,
// the same triple the retired StitchedTranscriptPanel used to derive for
// itself) instead of mounting a second component. This file replaces
// StitchedTranscriptPanel.test.tsx: every workflow-mode assertion below is
// that file's, retargeted at TranscriptPanel + `workflow`; the normal-mode
// describe block at the bottom is new — the structure proof that folding in
// task-mode left single-agent rendering untouched.
const tailByAgent = vi.hoisted(() => new Map<string, unknown[]>());

// TranscriptPanel (via its store.ts import) transitively reaches the Tauri
// rpc/bridge module, which fires real listen()/invoke() calls as an
// import-time DEV side effect — same problem TaskInspector.test.tsx hit.
// Stub it so this test only exercises rendering/layout, not the live daemon
// transport.
vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "agent.tail" && params && typeof params["agentId"] === "string") {
      return tailByAgent.get(params["agentId"]) ?? [];
    }
    return {};
  }),
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

// The body renders through TranscriptSegment's shared keyboard hook, whose
// selection effect touches `window.addEventListener` (mirrors
// WorkflowFormCard.test.tsx's note on OverlayCard's esc-key effect): the
// package's vitest config runs a bare node env (no jsdom dependency), so stub
// only event listeners and the activity indicator's timers rather than a DOM.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval,
    clearInterval,
  };
}

import { useTokenRing, TranscriptPanel, type TranscriptWorkflowData } from "../src/components/TranscriptPanel";
import { agentTasksLocal } from "../src/state/commands.agentTasks";
import { workflowsLocal } from "../src/state/commands.workflows";
import { appStore } from "../src/state/store";
import { agentName, fmtCost } from "../src/state/selectors";
import type { AgentRow } from "../src/state/selectors";
import {
  groupAgentListRowsByTask, stitchedStepSections, taskAgentTotals, taskWorkflowBinding, workflowFor, workflowRow,
  type AgentMetaForTask,
} from "../src/state/selectors.workflows";

// WORKFLOW-UI-1 — the pinned WorkflowFlowBar must sit ABOVE the scroll body
// as a flex-shrink:0 SIBLING (TranscriptPanel.module.css's .pane is a column
// flex via Panel's own `.panel`), never nested inside it (that was the
// pre-fix bug: the old inline .pipeline/TaskInspector block scrolled away
// with the transcript).

const xprovWorkflow = workflowRow({
  name: "q-xprov", version: 1,
  steps: [
    { id: "design", title: "design", gate: { kind: "none" }, role: "glm" },
    { id: "build", title: "build", gate: { kind: "none" }, role: "claude" },
    { id: "verify", title: "verify", gate: { kind: "none" }, role: "codex" },
  ],
});

function multiAgentTask(): Record<string, unknown> {
  return {
    taskId: "t-multi", queue: "q-xprov", state: "in_progress", agentId: "codex-3",
    role: "worker", priority: 0, prompt: "ship it", attempts: 1,
    workflow: { name: "q-xprov", version: 1 }, stepIndex: 2,
    stepHistory: [
      { stepIndex: 0, stepId: "design", agentId: "glm-1", startedAt: 100, endedAt: 200, outcome: "passed" },
      { stepIndex: 1, stepId: "build", agentId: "claude-2", startedAt: 200, endedAt: 300, outcome: "passed" },
      { stepIndex: 2, stepId: "verify", agentId: "codex-3", startedAt: 300, endedAt: null, outcome: null },
    ],
  };
}

/** The same {raw, workflow, sections} triple AgentsScreen derives for a
 * task-row selection — built here with the identical selectors so a test
 * exercises the REAL wiring, not a hand-rolled shortcut. */
function workflowDataFor(taskId: string): TranscriptWorkflowData {
  const raw = agentTasksLocal.getState().tasks.find((t) => t["taskId"] === taskId) ?? null;
  const binding = raw ? taskWorkflowBinding(raw) : null;
  const wf = workflowFor(binding, workflowsLocal.getState().items);
  const sections = raw ? stitchedStepSections(raw, wf) : [];
  return { raw, workflow: wf, sections };
}

function renderPanel(taskId: string) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(TranscriptPanel, { agent: undefined, workflow: workflowDataFor(taskId) }));
  });
  return renderer;
}

/** Renders and flushes the mocked rpcCall("agent.tail") -> backfillHistory
 * round trip (both microtasks: the promise resolution AND its `.then`
 * dispatch) so a test can rely on the REAL backfill effect populating
 * tailEventsRef, not a hand-dispatched backfillHistory shortcut. */
async function renderPanelBackfilled(taskId: string) {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(React.createElement(TranscriptPanel, { agent: undefined, workflow: workflowDataFor(taskId) }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

/** Nearest HOST-element ancestor of a given type — skips over composite
 * (function component) instances in react-test-renderer's tree, since a
 * child forwarded through a wrapper (Panel's `children`) is parented to
 * wherever it's actually rendered, not to the composite that forwarded it. */
function closestHost(node: ReturnType<ReturnType<typeof create>["root"]["findByProps"]>, type: string) {
  let n: typeof node | null = node.parent;
  while (n && n.type !== type) n = n.parent;
  if (!n) throw new Error(`no ancestor of type ${type}`);
  return n;
}

describe("TranscriptPanel (workflow mode) — WorkflowFlowBar placement (WORKFLOW-UI-1)", () => {
  it("pins the bar as a sibling of the scroll body, not nested inside it", () => {
    agentTasksLocal.set({ tasks: [multiAgentTask()] });
    workflowsLocal.set({ items: [xprovWorkflow] });
    const renderer = renderPanel("t-multi");

    const bar = renderer.root.findByProps({ "data-workflow-flow-bar": true });
    const body = renderer.root.findByProps({ "data-transcript-body": true });

    // siblings under the same Panel <section>...
    expect(closestHost(bar, "section")).toBe(closestHost(body, "section"));
    // ...and the bar is NOT among the body's own descendants.
    expect(() => body.findByProps({ "data-workflow-flow-bar": true })).toThrow();
  });

  it("maps done/current/pending step state to distinct classes, done carrying a duration", () => {
    agentTasksLocal.set({ tasks: [multiAgentTask()] });
    workflowsLocal.set({ items: [xprovWorkflow] });
    const renderer = renderPanel("t-multi");

    const steps = renderer.root.findAll((n) => Boolean((n.props as Record<string, unknown>)["data-workflow-flow-step"] !== undefined));
    expect(steps).toHaveLength(3);
    expect(steps[0]!.props["data-step-state"]).toBe("done");
    expect(steps[1]!.props["data-step-state"]).toBe("done");
    expect(steps[2]!.props["data-step-state"]).toBe("current");

    const classesOf = (n: (typeof steps)[number]) => String(n.props["className"]);
    expect(classesOf(steps[0]!)).toMatch(/stepDone/);
    expect(classesOf(steps[1]!)).toMatch(/stepDone/);
    expect(classesOf(steps[2]!)).toMatch(/stepCurrent/);
    // a done step's chip renders its recorded duration (100s window -> "1m40s"/"100s" per fmtDurationSec).
    const doneText = JSON.stringify(steps[0]!.findAllByType("span").map((s) => s.children));
    expect(doneText.length).toBeGreaterThan(0);
  });

  it("a task with no workflow binding renders no bar at all", () => {
    agentTasksLocal.set({ tasks: [{ taskId: "t-plain", state: "in_progress", agentId: "a1", workflow: null }] });
    workflowsLocal.set({ items: [] });
    const renderer = renderPanel("t-plain");
    expect(() => renderer.root.findByProps({ "data-workflow-flow-bar": true })).toThrow();
  });
});

function singleAgentTask(): Record<string, unknown> {
  return {
    taskId: "t-single", queue: "q-solo", state: "in_progress", agentId: "solo-1",
    role: "worker", priority: 0, prompt: "ship it", attempts: 1,
    workflow: { name: "q-xprov", version: 1 }, stepIndex: 2,
    stepHistory: [
      { stepIndex: 0, stepId: "design", agentId: "solo-1", startedAt: 100, endedAt: 200, outcome: "passed" },
      { stepIndex: 1, stepId: "build", agentId: "solo-1", startedAt: 200, endedAt: 300, outcome: "passed" },
      { stepIndex: 2, stepId: "verify", agentId: "solo-1", startedAt: 300, endedAt: null, outcome: null },
    ],
  };
}

// R2 UI FIX 2: a flow-bar step's agent click must OPEN that agent (dispatch selectAgent),
// not just scroll within the stitched view — AgentsScreen switches TranscriptPanel out of
// task mode the instant selectedAgentId stops being a "task:<id>" string.
describe("TranscriptPanel (workflow mode) — step-agent click opens the agent", () => {
  function clickableSteps(renderer: ReturnType<typeof create>) {
    return renderer.root.findAll((n) => Boolean((n.props as Record<string, unknown>)["data-workflow-flow-step"] !== undefined));
  }

  it("multi-agent: clicking each step dispatches selectAgent with THAT step's agentId", () => {
    agentTasksLocal.set({ tasks: [multiAgentTask()] });
    workflowsLocal.set({ items: [xprovWorkflow] });
    const renderer = renderPanel("t-multi");
    const steps = clickableSteps(renderer);
    expect(steps).toHaveLength(3);

    act(() => { (steps[0]!.props["onClick"] as () => void)(); });
    expect(appStore.getState().selectedAgentId).toBe("glm-1");

    act(() => { (steps[2]!.props["onClick"] as () => void)(); }); // the current (in-progress) step
    expect(appStore.getState().selectedAgentId).toBe("codex-3");
  });

  it("single-agent: every step shares one agentId — clicking still fires selectAgent for it", () => {
    agentTasksLocal.set({ tasks: [singleAgentTask()] });
    workflowsLocal.set({ items: [xprovWorkflow] });
    const renderer = renderPanel("t-single");
    const steps = clickableSteps(renderer);
    expect(steps).toHaveLength(3);

    act(() => { (steps[1]!.props["onClick"] as () => void)(); });
    expect(appStore.getState().selectedAgentId).toBe("solo-1");
  });
});

const agentRow = (agentId: string): AgentRow => ({ kind: "agent", agentId, depth: 0, collapsible: false, collapsed: false });

describe("TranscriptPanel (workflow mode) — header parity (WORKFLOW-UI-2)", () => {
  it("shows the workflow name + the CURRENT live step agent's id, and sums cost across every step agent (no drift vs groupAgentListRowsByTask)", () => {
    appStore.dispatch({
      type: "agentRecords",
      records: [
        { agentId: "glm-1", state: "done", accountName: "acct-glm", provider: "zhipu", costUsd: 0.1, createdAt: 1 },
        { agentId: "claude-2", state: "done", accountName: "acct-claude", provider: "claude", costUsd: 0.2, createdAt: 2 },
        { agentId: "codex-3", state: "running", accountName: "acct-codex", provider: "openai", costUsd: 0.05, createdAt: 3 },
      ],
    });
    agentTasksLocal.set({ tasks: [multiAgentTask()] });
    workflowsLocal.set({ items: [xprovWorkflow] });
    const renderer = renderPanel("t-multi");

    const toggle = renderer.root.findByProps({ "data-agent-detail-toggle": true });
    const toggleTexts = toggle.findAllByType("span").map((s) => s.children.join(""));
    expect(toggleTexts).toContain("q-xprov"); // name = the workflow's own binding name
    expect(toggleTexts).toContain("codex-3"); // fullId = the current live step agent (task.agentId, state in_progress)

    const meta: Record<string, AgentMetaForTask> = {
      "glm-1": { costUsd: 0.1, usage: null, pendingQuestion: undefined },
      "claude-2": { costUsd: 0.2, usage: null, pendingQuestion: undefined },
      "codex-3": { costUsd: 0.05, usage: null, pendingQuestion: undefined },
    };
    const rowCost = (
      groupAgentListRowsByTask(
        [agentRow("glm-1"), agentRow("claude-2"), agentRow("codex-3")], [multiAgentTask()], meta, [xprovWorkflow], {},
      )[0] as { costUsd: number }
    ).costUsd;
    expect(taskAgentTotals(multiAgentTask(), meta).costUsd).toBeCloseTo(rowCost); // the shared helper can't drift from the row

    const chipTexts = renderer.root
      .findAll((n) => typeof n.props["className"] === "string" && /chip/.test(n.props["className"] as string) && !/chipRow/.test(n.props["className"] as string))
      .map((n) => n.children.join(""));
    expect(chipTexts).toContain(fmtCost(rowCost));
  });
});

// WORKFLOW-UI-3 — body parity: the retired StepTranscript rendered plain
// text with a bare "⚙" line and no images; the body renders through the SAME
// TranscriptSegment/Block pipeline single-agent mode uses, via
// `backfillHistory` (the exact projection path production's own agent.tail
// backfill uses — see selectors.test.ts's `ev` helper for the same
// NormalizedEvent-fixture convention) so a tool_call/tool_result pair and a
// delivered-with-images user turn land as REAL transcript items, not
// hand-typed TranscriptItem literals.
function ev(seq: number, kind: string, agentId: string, ts: number, data: Record<string, unknown> = {}) {
  return { seq, ts, engineId: "local", agentId, kind, data };
}

function stepEvents(agentId: string, base: number, seqStart: number) {
  return [
    ev(seqStart, "tool_call", agentId, base + 10, { toolName: "Bash" }),
    ev(seqStart + 1, "tool_result", agentId, base + 20, { result: "ok" }),
    ev(seqStart + 2, "message_delta", agentId, base + 30, { text: "working on it" }),
    ev(seqStart + 3, "message_complete", agentId, base + 30, { text: "working on it" }),
    ev(seqStart + 4, "status", agentId, base + 40, {
      delivered: true, from: "pm-agent", text: "see attached",
      images: [{ mediaType: "image/png", data: "AAAA" }],
    }),
  ];
}

function backfill(agentId: string, base: number, seqStart: number): void {
  appStore.dispatch({ type: "backfillHistory", agentId, events: stepEvents(agentId, base, seqStart) as never });
}

function toolStripCount(renderer: ReturnType<typeof create>): number {
  return renderer.root.findAll((n) => (n.props as Record<string, unknown>)["data-bkey"] !== undefined
    && typeof (n.props as Record<string, unknown>)["data-bkey"] === "string"
    && ((n.props as Record<string, unknown>)["data-bkey"] as string).startsWith("t")).length;
}

function imageChipCount(renderer: ReturnType<typeof create>): number {
  return renderer.root.findAll((n) => (n.props as Record<string, unknown>)["data-image-chip"] !== undefined).length;
}

// Own agentIds/taskId, distinct from every other describe block in this file
// — the backfill effect fires a (mocked, async) agent.tail fetch on mount for
// any agent it sees with historyLoaded:false, and that resolution can leak
// into a LATER test's synchronous body (a classic cross-test race via the
// shared appStore singleton); reusing an agentId another describe block
// already mounted risks exactly that.
function workflowUi3MultiTask(): Record<string, unknown> {
  return {
    taskId: "t-wf3-multi", queue: "q-wf3", state: "in_progress", agentId: "wf3-codex",
    role: "worker", priority: 0, prompt: "ship it", attempts: 1,
    workflow: { name: "q-wf3", version: 1 }, stepIndex: 2,
    stepHistory: [
      { stepIndex: 0, stepId: "design", agentId: "wf3-glm", startedAt: 100, endedAt: 195, outcome: "passed" },
      { stepIndex: 1, stepId: "build", agentId: "wf3-claude", startedAt: 200, endedAt: 295, outcome: "passed" },
      { stepIndex: 2, stepId: "verify", agentId: "wf3-codex", startedAt: 300, endedAt: null, outcome: null },
    ],
  };
}
const wf3Workflow = workflowRow({
  name: "q-wf3", version: 1,
  steps: [
    { id: "design", title: "design", gate: { kind: "none" }, role: "glm" },
    { id: "build", title: "build", gate: { kind: "none" }, role: "claude" },
    { id: "verify", title: "verify", gate: { kind: "none" }, role: "codex" },
  ],
});

describe("TranscriptPanel (workflow mode) — body parity (WORKFLOW-UI-3)", () => {
  it("multi-agent: N step sections each render Block-based tool strips + images through their OWN agent", () => {
    backfill("wf3-glm", 100, 1);
    backfill("wf3-claude", 200, 10);
    backfill("wf3-codex", 300, 20);
    agentTasksLocal.set({ tasks: [workflowUi3MultiTask()] });
    workflowsLocal.set({ items: [wf3Workflow] });
    const renderer = renderPanel("t-wf3-multi");

    // one tool strip per section (3 sections, 3 distinct agents)
    expect(toolStripCount(renderer)).toBe(3);
    expect(imageChipCount(renderer)).toBe(3);
    // deliverTo attribution survives through the real Block renderer (the retired
    // StepTranscript hard-coded "you" regardless of `from`). A2A-UX-OVERHAUL · PART 3:
    // the source now renders as a clickable "@name" mention (the sender's display
    // name), not the raw id — so the sender's friendly name appears in a mention chip.
    const senderName = agentName("pm-agent");
    const mentionStrings = renderer.root
      .findAll((n) => typeof n.props["className"] === "string" && /mention/.test(n.props["className"] as string))
      .flatMap((n) => (n.children as unknown[]).filter((c): c is string => typeof c === "string"));
    expect(mentionStrings.some((t) => t.includes(senderName))).toBe(true);
    // exactly one shared scroller — no per-step scroll region.
    expect(renderer.root.findAll((n) => (n.props as Record<string, unknown>)["data-transcript-body"] === true)).toHaveLength(1);
  });

  it("single-agent: one agent's transcript segments into per-step blocks via the SAME body, no key collisions", async () => {
    const soloTask: Record<string, unknown> = {
      taskId: "t-wf3-solo", queue: "q-wf3-solo", state: "in_progress", agentId: "wf3-solo",
      role: "worker", priority: 0, prompt: "ship it", attempts: 1,
      workflow: { name: "q-wf3-solo", version: 1 }, stepIndex: 1,
      stepHistory: [
        { stepIndex: 0, stepId: "design", agentId: "wf3-solo", startedAt: 100, endedAt: 195, outcome: "passed" },
        { stepIndex: 1, stepId: "build", agentId: "wf3-solo", startedAt: 200, endedAt: null, outcome: null },
      ],
    };
    const soloWorkflow = workflowRow({
      name: "q-wf3-solo", version: 1,
      steps: [
        { id: "design", title: "design", gate: { kind: "none" } },
        { id: "build", title: "build", gate: { kind: "none" } },
      ],
    });
    // ONE agent's events span BOTH step windows — the same segmentation
    // StitchedStepSections' MODE-AGNOSTIC contract requires. Routed through
    // the mocked agent.tail (not a hand-dispatched backfillHistory) so the
    // panel's REAL backfill effect populates tailEventsRef — the correlation
    // walk that segments this one transcript by time window needs the SAME
    // per-agent event cache production uses, not the (empty) live ring.
    tailByAgent.set("wf3-solo", [...stepEvents("wf3-solo", 100, 1), ...stepEvents("wf3-solo", 200, 10)]);
    // The backfill effect only fetches for an agent it already KNOWS about
    // (state !== "unknown") — mirrors how a real step agent is first seen via
    // agent.list/agentRecords before its history is ever backfilled.
    appStore.dispatch({ type: "agentRecords", records: [{ agentId: "wf3-solo", state: "done", createdAt: 1 }] });
    agentTasksLocal.set({ tasks: [soloTask] });
    workflowsLocal.set({ items: [soloWorkflow] });
    const renderer = await renderPanelBackfilled("t-wf3-solo");

    // 2 step sections, each windowed to ITS OWN half of the one transcript.
    expect(toolStripCount(renderer)).toBe(2);
    expect(imageChipCount(renderer)).toBe(2);
    const headers = renderer.root.findAll((n) => typeof (n.props as Record<string, unknown>)["data-step-header"] === "string");
    expect(headers).toHaveLength(2);
    expect(renderer.root.findAll((n) => (n.props as Record<string, unknown>)["data-transcript-body"] === true)).toHaveLength(1);
  });
});

// WORKFLOW-UI-4 — normal mode structure proof: a plain (non-workflow) agent
// selection must render exactly as it did before the fold (TranscriptHeader
// -> ONE TranscriptSegment, no WorkflowFlowBar/StepHeader chrome at all).
describe("TranscriptPanel (normal mode)", () => {
  it("select an agent: no agent -> the empty pane, not the task-not-found copy", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(TranscriptPanel, { agent: undefined }));
    });
    expect(() => renderer.root.findByProps({ "data-transcript-body": true })).toThrow();
    const hintTexts = renderer.root.findAll((n) => typeof n.props["className"] === "string" && /emptyHint/.test(n.props["className"] as string))
      .flatMap((n) => (n.children as unknown[]).filter((c): c is string => typeof c === "string"));
    expect(hintTexts).toContain("select an agent");
  });

  it("renders header + a single scroller + one TranscriptSegment's blocks, and NO workflow chrome", () => {
    appStore.dispatch({
      type: "agentRecords",
      records: [{ agentId: "solo-normal", state: "running", accountName: "acct-a", provider: "claude", costUsd: 0.42, createdAt: 1 }],
    });
    backfill("solo-normal", 100, 1);
    const agent = appStore.getState().agents["solo-normal"]!;

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(TranscriptPanel, { agent }));
    });

    // exactly one shared scroller, agent's own name/id in the header.
    expect(renderer.root.findAll((n) => (n.props as Record<string, unknown>)["data-transcript-body"] === true)).toHaveLength(1);
    const toggle = renderer.root.findByProps({ "data-agent-detail-toggle": true });
    const toggleTexts = toggle.findAllByType("span").map((s) => s.children.join(""));
    expect(toggleTexts).toContain("solo-normal");

    // ordinary Block pipeline still renders (one tool strip from the backfilled events).
    expect(toolStripCount(renderer)).toBe(1);
    expect(imageChipCount(renderer)).toBe(1);

    // no workflow-only chrome leaks into single-agent mode.
    expect(() => renderer.root.findByProps({ "data-workflow-flow-bar": true })).toThrow();
    expect(renderer.root.findAll((n) => typeof (n.props as Record<string, unknown>)["data-step-header"] === "string")).toHaveLength(0);
    expect(renderer.root.findByProps({ label: "transcript" })).toBeTruthy();
  });

  it("uses the project name and live-conductor suffix in the agent-detail header", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [
          {
            agentId: "detail-c1", state: "running", accountName: "main", provider: "claude",
            costUsd: 0, createdAt: 10, spec: { conductor: true }, projectId: "chimera",
          },
          {
            agentId: "detail-c2", state: "paused", accountName: "main", provider: "claude",
            costUsd: 0, createdAt: 11, spec: { conductor: true }, projectId: "chimera",
          },
        ],
      });
    });
    const agent = appStore.getState().agents["detail-c2"]!;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(TranscriptPanel, { agent }));
    });

    const toggle = renderer.root.findByProps({ "data-agent-detail-toggle": true });
    const toggleTexts = toggle.findAllByType("span").map((s) => s.children.join(""));
    expect(toggleTexts).toContain("chimera-2");
    expect(toggleTexts).toContain("detail-c2");
    expect(toggleTexts).not.toContain(agentName("detail-c2"));
  });
});

// TRANSCRIPT-LOADING-STATE: a done-before-app-launch agent's history backfill
// used to leave the pane totally blank while in flight — historyLoaded=false
// meant "not fetched", "in flight" AND "failed" all at once, so there was no
// signal to render a loading state off of. historyLoadState (ui-state) now
// distinguishes them; these prove the single-agent pane (TranscriptEmptyBody)
// renders each of the three states correctly and ONLY that state's markup.
describe("TranscriptPanel (normal mode) — TRANSCRIPT-LOADING-STATE", () => {
  function soloAgent(agentId: string, state = "running") {
    appStore.dispatch({
      type: "agentRecords",
      records: [{ agentId, state, accountName: "acct-a", provider: "claude", costUsd: 0, createdAt: 1 }],
    });
    return appStore.getState().agents[agentId]!;
  }

  it("shows native work and the activity bar before the first transcript message, then live tool progress", () => {
    const agentId = "native-voice-working"; soloAgent(agentId);
    let seq = 2_000_000;
    const feed = (kind: "status" | "tool_call" | "tool_result" | "turn_complete", data: Record<string, unknown>) => appStore.dispatch({ type: "event", event: { agentId, seq: ++seq, ts: Date.now(), kind, data } });
    feed("status", { turnStarted: true, turnId: "native" });
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(TranscriptPanel, { agent: appStore.getState().agents[agentId]! })); });
    const update = () => renderer.update(React.createElement(TranscriptPanel, { agent: appStore.getState().agents[agentId]! }));
    try {
      expect(renderer.root.findByProps({ "data-thinking": true })).toBeTruthy();
      expect(renderer.root.findByProps({ "data-stream-glow": true })).toBeTruthy();
      act(() => {
        feed("tool_call", { toolId: "mcp", toolName: "mcp:docs/search", input: { query: "API" } });
        feed("status", { toolProgress: { toolId: "mcp", text: "Reading API reference" } }); update();
      });
      expect(renderer.root.findByProps({ "data-tool-progress": true }).children.join("")).toContain("Reading API reference");
      expect(toolStripCount(renderer)).toBe(1);
      act(() => { feed("tool_result", { toolId: "mcp", result: "Found reference" }); feed("turn_complete", {}); update(); });
      expect(renderer.root.findAllByProps({ "data-tool-progress": true })).toHaveLength(0);
      expect(renderer.root.findAllByProps({ "data-thinking": true })).toHaveLength(0);
      expect(renderer.root.findAllByProps({ "data-stream-glow": true })).toHaveLength(0);
    } finally { act(() => renderer.unmount()); }
  });

  it("in-flight (historyLoadState \"loading\"): renders the skeleton only", () => {
    const agentId = "load-loading";
    soloAgent(agentId);
    appStore.dispatch({ type: "historyLoadStarted", agentId });
    const agent = appStore.getState().agents[agentId]!;

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(TranscriptPanel, { agent }));
    });

    expect(renderer.root.findByProps({ "data-transcript-skeleton": true })).toBeTruthy();
    expect(() => renderer.root.findByProps({ "data-transcript-load-empty": true })).toThrow();
    expect(() => renderer.root.findByProps({ "data-transcript-load-failed": true })).toThrow();
  });

  it("completed-and-empty (historyLoaded true, no transcript): renders \"no messages yet\", NOT the skeleton", () => {
    const agentId = "load-empty";
    soloAgent(agentId, "done");
    appStore.dispatch({ type: "backfillHistory", agentId, events: [] });
    const agent = appStore.getState().agents[agentId]!;
    expect(agent.historyLoaded).toBe(true);

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(TranscriptPanel, { agent }));
    });

    expect(() => renderer.root.findByProps({ "data-transcript-skeleton": true })).toThrow();
    const empty = renderer.root.findByProps({ "data-transcript-load-empty": true });
    expect(empty.children.join("")).toBe("no messages yet");
  });

  it("failed (historyLoadState \"failed\"): renders the error/retry line, NOT a permanent skeleton", () => {
    const agentId = "load-failed";
    soloAgent(agentId);
    appStore.dispatch({ type: "historyLoadStarted", agentId });
    appStore.dispatch({ type: "historyLoadFailed", agentId, message: "daemon unreachable" });
    const agent = appStore.getState().agents[agentId]!;
    expect(agent.historyLoaded).toBe(false); // a permanent shimmer would be worse than blank -- this must NOT look like "loading"

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(TranscriptPanel, { agent }));
    });

    expect(() => renderer.root.findByProps({ "data-transcript-skeleton": true })).toThrow();
    const failed = renderer.root.findByProps({ "data-transcript-load-failed": true });
    expect(failed.children.join("")).toMatch(/history failed to load: daemon unreachable/);
  });

  it("a successful backfill replaces the skeleton with the real messages", () => {
    const agentId = "load-recovers";
    soloAgent(agentId);
    appStore.dispatch({ type: "historyLoadStarted", agentId });

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(TranscriptPanel, { agent: appStore.getState().agents[agentId]! }));
    });
    expect(renderer.root.findByProps({ "data-transcript-skeleton": true })).toBeTruthy();

    act(() => {
      backfill(agentId, 300, 1);
      renderer.update(React.createElement(TranscriptPanel, { agent: appStore.getState().agents[agentId]! }));
    });

    expect(() => renderer.root.findByProps({ "data-transcript-skeleton": true })).toThrow();
    expect(toolStripCount(renderer)).toBe(1);
  });

  it("regression guard (185127c): a failed load's requested-set guard is released, so a reselect retries and eventually reaches \"loaded\"", async () => {
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    const agentId = "load-retry-e2e";
    soloAgent(agentId);
    // drive it through the REAL installHistoryBackfill-shaped lifecycle by hand
    // (this describe block renders the panel directly, not via the selection
    // watcher) -- the panel itself must not care HOW it got to "failed" then
    // "loading" again, only render each state correctly in turn.
    appStore.dispatch({ type: "historyLoadStarted", agentId });
    appStore.dispatch({ type: "historyLoadFailed", agentId, message: "boom" });

    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(React.createElement(TranscriptPanel, { agent: appStore.getState().agents[agentId]! }));
    });
    expect(renderer.root.findByProps({ "data-transcript-load-failed": true })).toBeTruthy();

    act(() => {
      appStore.dispatch({ type: "historyLoadStarted", agentId }); // the retry
      renderer.update(React.createElement(TranscriptPanel, { agent: appStore.getState().agents[agentId]! }));
    });
    expect(renderer.root.findByProps({ "data-transcript-skeleton": true })).toBeTruthy();

    act(() => {
      backfill(agentId, 400, 1);
      renderer.update(React.createElement(TranscriptPanel, { agent: appStore.getState().agents[agentId]! }));
    });
    await flush();
    expect(appStore.getState().agents[agentId]!.historyLoadState).toBe("loaded");
    expect(() => renderer.root.findByProps({ "data-transcript-load-failed": true })).toThrow();
    expect(toolStripCount(renderer)).toBe(1);
  });
});


describe("token rate measurement time", () => {
  it("ignores history hydration, uses event time and expires idle samples", () => {
    vi.useFakeTimers();
    const now = 1800000000000;
    vi.setSystemTime(now);
    let ring: number[] = [];
    function Probe({ total, ts }: { total: number | null; ts?: number }) {
      ring = useTokenRing("agent", total, ts);
      return null;
    }
    let view: ReturnType<typeof create>;
    try {
      act(() => { view = create(<Probe total={null} />); });
      act(() => { view.update(<Probe total={2400000} ts={now - 300000} />); });
      expect(ring).toEqual([]);
      act(() => { view.update(<Probe total={1000} ts={now - 10000} />); });
      expect(ring).toEqual([]); // resumed attempt reset
      act(() => { view.update(<Probe total={2000} ts={now} />); });
      expect(ring).toEqual([6000]); // 1000 tokens / ten seconds, not render interval
      act(() => { vi.advanceTimersByTime(60001); });
      expect(ring).toEqual([]);
    } finally { act(() => view?.unmount()); vi.useRealTimers(); }
  });
});
