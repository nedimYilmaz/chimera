import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { attentionInbox, initialState, reduce, type UiState } from "@chimera/ui-state";

// Mirrors reducer-events.test.ts's own ev()/feed() pattern.
let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, s?: number): NormalizedEvent =>
  ({ ts: 1000 + (s ?? ++seq), seq: s ?? seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

const permissionEvent = (agentId: string, requestId: string) =>
  ev(agentId, "permission_request", { requestId, toolName: "Bash", input: { cmd: "ls" }, policy: "tui" });
const questionEvent = (agentId: string, questionId: string, extra: Record<string, unknown> = {}) =>
  ev(agentId, "agent_question", { questionId, prompt: "ship it?", ...extra });
const approvalEvent = (agentId: string, questionId: string) =>
  ev(agentId, "agent_question", {
    questionId, prompt: "Approve step 1/1 (\"review\") of workflow \"release\"?",
    options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
    default: { optionIds: ["reject"] }, gate: "approval",
  });
const taskStatusEvent = (taskId: string, state: string, extra: Record<string, unknown> = {}) =>
  ev(`task:${taskId}`, "status", { taskId, queue: "work", state, attempts: 0, priority: 0, agentId: null, error: null, subject: taskId, ...extra });

describe("attentionInbox", () => {
  it("aggregates all kinds with the right urgency", () => {
    const st = feed(initialState, [
      permissionEvent("a1", "r1"),
      questionEvent("a2", "q1"),
      approvalEvent("a3", "q2"),
      taskStatusEvent("t1", "failed", { error: "boom" }),
      taskStatusEvent("t2", "blocked"),
    ]);
    const items = attentionInbox(st);
    expect(items).toHaveLength(5);
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]));
    expect(byKind["permission"]!.urgency).toBe("blocking");
    expect(byKind["question"]!.urgency).toBe("blocking");
    expect(byKind["approval"]!.urgency).toBe("blocking");
    expect(byKind["task_failed"]!.urgency).toBe("waiting");
    expect(byKind["task_blocked"]!.urgency).toBe("fyi");
  });

  it("orders by urgency tier first, then FIFO (oldest ts) within a tier", () => {
    // the blocked task (fyi) is fed FIRST (earliest ts) but must still sort AFTER
    // the permission (blocking), which is fed later.
    const st = feed(initialState, [
      taskStatusEvent("t1", "blocked"),
      permissionEvent("a1", "r1"),
    ]);
    const items = attentionInbox(st);
    expect(items.map((i) => i.kind)).toEqual(["permission", "task_blocked"]);

    const st2 = feed(initialState, [
      permissionEvent("a1", "r-first"),    // called first -> earlier ts
      permissionEvent("a2", "r-second"),   // called second -> later ts
    ]);
    // both are "blocking" -- the FIFO tie-break puts the oldest (earlier-ts) one first
    const items2 = attentionInbox(st2);
    expect(items2.map((i) => (i as { permission: { requestId: string } }).permission.requestId)).toEqual(["r-first", "r-second"]);
  });

  it("excludes an inter-agent (to-carrying) question from the human-facing inbox — ASK-UNREACHABLE-TARGET-LEAK regression", () => {
    const st = feed(initialState, [
      ev("a1", "agent_question", { questionId: "q1", prompt: "answer me", to: "a2", replyTo: "a1" }),
    ]);
    expect(attentionInbox(st).filter((i) => i.kind === "question" || i.kind === "approval")).toEqual([]);
    // the per-agent "?" waiting indicator invariant stays intact
    expect(st.agents["a1"]!.pendingQuestion).not.toBeNull();
  });

  it("labels a workflow approval-gate ask as `approval`, and an identically-shaped plain question as `question` (no option-id guessing)", () => {
    const st = feed(initialState, [
      approvalEvent("a1", "q-gate"),
      ev("a2", "agent_question", {
        questionId: "q-plain", prompt: "approve or reject manually?",
        options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
      }),
    ]);
    const items = attentionInbox(st);
    expect(items.find((i) => i.agentId === "a1")!.kind).toBe("approval");
    expect(items.find((i) => i.agentId === "a2")!.kind).toBe("question");
  });

  it("dedup / idempotent replay: re-feeding the same seq is a no-op; a second question for the same agent replaces the first", () => {
    const e = permissionEvent("a1", "r1");
    const st = feed(feed(initialState, [e]), [e]);   // fed twice, same seq
    expect(attentionInbox(st).filter((i) => i.kind === "permission")).toHaveLength(1);

    const st2 = feed(initialState, [questionEvent("a1", "q1"), questionEvent("a1", "q2")]);
    const questions = attentionInbox(st2).filter((i) => i.kind === "question");
    expect(questions).toHaveLength(1);
    expect((questions[0] as { question: { questionId: string } }).question.questionId).toBe("q2");
  });

  it("disappears when resolved: permissionAnswered, questionAnswered, and a task retried by another client", () => {
    let st = feed(initialState, [permissionEvent("a1", "r1"), questionEvent("a2", "q1"), taskStatusEvent("t1", "failed")]);
    expect(attentionInbox(st)).toHaveLength(3);

    st = reduce(st, { type: "permissionAnswered", requestId: "r1" });
    expect(attentionInbox(st).some((i) => i.kind === "permission")).toBe(false);

    st = reduce(st, { type: "questionAnswered", agentId: "a2", questionId: "q1" });
    expect(attentionInbox(st).some((i) => i.kind === "question")).toBe(false);

    // "resolved elsewhere": a later status event for the SAME task (e.g. a retry pushed
    // by another client) overwrites the TaskLite entry -- no explicit inbox action needed.
    st = feed(st, [taskStatusEvent("t1", "pending")]);
    expect(attentionInbox(st).some((i) => i.kind === "task_failed")).toBe(false);
  });

  it("a question/approval resolved elsewhere (status{questionResolved}, e.g. a fail-closed gate timeout or another client answering) drops from the inbox — FEATURE-9 phantom-inbox-item regression", () => {
    let st = feed(initialState, [questionEvent("a1", "q1"), approvalEvent("a2", "q2")]);
    expect(attentionInbox(st).filter((i) => i.kind === "question" || i.kind === "approval")).toHaveLength(2);

    // server-side resolution (timeout fail-closed, or another client's answer) arrives as
    // a status event, NOT a local questionAnswered action -- no client-side answer ever ran.
    st = feed(st, [ev("a1", "status", { questionResolved: true, questionId: "q1", timedOut: true })]);
    expect(attentionInbox(st).some((i) => i.kind === "question")).toBe(false);
    expect(st.agents["a1"]!.pendingQuestion).toBeNull();

    st = feed(st, [ev("a2", "status", { questionResolved: true, questionId: "q2" })]);
    expect(attentionInbox(st).some((i) => i.kind === "approval")).toBe(false);
  });

  it("a stale questionResolved for an already-replaced questionId does not clear the current pendingQuestion", () => {
    const st = feed(initialState, [questionEvent("a1", "q1"), questionEvent("a1", "q2")]);   // q2 replaces q1
    const st2 = feed(st, [ev("a1", "status", { questionResolved: true, questionId: "q1" })]);   // stale resolution for q1
    expect(st2.agents["a1"]!.pendingQuestion?.questionId).toBe("q2");
    expect(attentionInbox(st2).filter((i) => i.kind === "question")).toHaveLength(1);
  });

  it("a blocked task self-heals (dependency satisfied) without leaving any residual item", () => {
    let st = feed(initialState, [taskStatusEvent("t1", "blocked")]);
    expect(attentionInbox(st)).toHaveLength(1);
    st = feed(st, [taskStatusEvent("t1", "pending")]);
    expect(attentionInbox(st)).toHaveLength(0);
  });
});
