import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce } from "@chimera/ui-state";
import { initialState, type UiState } from "@chimera/ui-state";

// W18 (F16 task workflows) — task_step_advanced/_failed carry a synthetic
// `task:<taskId>` agentId (id rule (a): never a real agent), so by default they
// only land in the global events ring. When a queue drill-in is open and one of
// its tasks is bound to a live agent, the reducer ALSO drops a dim system
// banner into that agent's own transcript (TranscriptPanel already renders
// role:"system" items dimly — no new item variant needed).

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, s?: number): NormalizedEvent =>
  ({ ts: 1000 + (s ?? ++seq), seq: s ?? seq, agentId, kind, data });

const withAgent = (state: UiState, agentId: string): UiState =>
  reduce(state, { type: "event", event: ev(agentId, "agent_started", { model: "m1" }) });

const withQueueDetail = (state: UiState, tasks: Array<Record<string, unknown>>): UiState =>
  reduce(state, { type: "queueDetail", detail: { spec: { name: "q1" }, counts: {}, tasks } });

describe("reducer: task_step_advanced/_failed (W18)", () => {
  it("with no queue drill open, only rides the events ring (no agent map touched)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: ev("task:t1", "task_step_advanced", { taskId: "t1", stepIndex: 0, stepId: "plan", title: "plan" }),
    });
    expect(st.events).toHaveLength(1);
    expect(st.agents).toEqual({});
  });

  it("drops a dim banner into the bound agent's transcript when the queue drill resolves it", () => {
    let st = withAgent(initialState, "a1");
    st = withQueueDetail(st, [{ taskId: "t1", agentId: "a1" }]);
    st = reduce(st, {
      type: "event",
      event: ev("task:t1", "task_step_advanced", { taskId: "t1", stepIndex: 2, stepId: "test", title: "test" }),
    });
    const last = st.agents["a1"]!.transcript.at(-1);
    expect(last).toMatchObject({ role: "system", text: "step 3 → test" });
    // the raw event still rides the global ring (coordination-screen reconcile trigger)
    expect(st.events.at(-1)!.kind).toBe("task_step_advanced");
  });

  it("a failed gate banner mentions the reason and a retry", () => {
    let st = withAgent(initialState, "a1");
    st = withQueueDetail(st, [{ taskId: "t1", agentId: "a1" }]);
    st = reduce(st, {
      type: "event",
      event: ev("task:t1", "task_step_failed", { taskId: "t1", stepIndex: 1, stepId: "test", reason: "exit 1", willRetry: true }),
    });
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({ role: "system", text: "step 2 test failed: exit 1 (retrying)" });
  });

  it("a taskId with no matching queueDetail row leaves every agent untouched", () => {
    let st = withAgent(initialState, "a1");
    st = withQueueDetail(st, [{ taskId: "other", agentId: "a1" }]);
    st = reduce(st, {
      type: "event",
      event: ev("task:t1", "task_step_advanced", { taskId: "t1", stepIndex: 0, stepId: "plan", title: "plan" }),
    });
    expect(st.agents["a1"]!.transcript).toMatchObject([]);
  });

  it("stampTs (opt-in) stamps the banner's ts, mirroring result/error/failover", () => {
    let st = withAgent(initialState, "a1");
    st = withQueueDetail(st, [{ taskId: "t1", agentId: "a1" }]);
    const e = ev("task:t1", "task_step_advanced", { taskId: "t1", stepIndex: 0, stepId: "plan", title: "plan" });
    st = reduce(st, { type: "event", event: e, stampTs: true });
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({ role: "system", text: "step 1 → plan", ts: e.ts });
  });
});

// R2 QA fix wave 2 (#3): a {kind:"workflow", failedOnly:true} deep link must thread failedOnly
// through workflowStudioOpen into WorkflowStudio's own filter state (App.tsx's
// useNavigationSurfaces resolves the document, then dispatches this action).
const DOC = { name: "release-flow", onFail: "halt" as const, retryLimit: 0, params: [], nodeOrder: ["a"], nodesById: { a: { id: "a", step: { id: "a", title: "A", gate: { kind: "none" as const } } } }, edgesById: {} };

describe("workflowStudioOpen: failedOnly threading", () => {
  it("sets workflowStudio.failedOnly when the action carries it", () => {
    const st = reduce(initialState, { type: "workflowStudioOpen", mode: "inspect", document: DOC, failedOnly: true });
    expect(st.workflowStudio.failedOnly).toBe(true);
  });

  it("defaults failedOnly to false when the action omits it (every pre-existing call site)", () => {
    const st = reduce(initialState, { type: "workflowStudioOpen", mode: "author", document: DOC });
    expect(st.workflowStudio.failedOnly).toBe(false);
  });
});
