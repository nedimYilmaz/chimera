import type { AgentQuestion, PendingPermission, TaskLite, UiState } from "./types.js";

export type InboxUrgency = "blocking" | "waiting" | "fyi";
export type InboxItemKind = "permission" | "question" | "approval" | "task_failed" | "task_blocked" | "review_decision";

export type InboxItem =
  | { id: string; kind: "permission"; urgency: "blocking"; ts: number; agentId: string; permission: PendingPermission }
  | { id: string; kind: "question" | "approval"; urgency: "blocking"; ts: number; agentId: string; question: AgentQuestion & { agentId: string } }
  | { id: string; kind: "task_failed"; urgency: "waiting"; ts: number; task: TaskLite }
  | { id: string; kind: "task_blocked"; urgency: "fyi"; ts: number; task: TaskLite }
  | { id: string; kind: "review_decision"; urgency: "blocking"; ts: number; taskId: string; summary: string };

const URGENCY_RANK: Record<InboxUrgency, number> = { blocking: 0, waiting: 1, fyi: 2 };

/**
 * FEATURE-9: the single prioritized, deduplicated feed of everything actionable across
 * every agent/task in this client's state. Urgency: blocking (an agent turn is literally
 * paused on this — permission/question/approval) > waiting (a task terminally failed, no
 * turn is stalled but a human decision is needed) > fyi (a task is blocked on unmet deps —
 * informational, self-heals once the dependency finishes). Within a tier, oldest first
 * (FIFO — the longest-waiting item is most urgent), matching this codebase's existing
 * queue-fairness convention (see selectors.coord.ts's priority-desc-then-FIFO note).
 *
 * Dedup is structural, not a post-hoc filter: `pendingPermissions` is already
 * requestId-unique (reducer.ts's permission_request case checks `pending.some(...)`
 * before appending), `AgentView.pendingQuestion` is a single per-agent slot (a second
 * agent_question REPLACES, never appends), and `state.tasks` is taskId-keyed (a second
 * status event for the same task overwrites). So one source object can only ever produce
 * one InboxItem; the `id` field (`${kind}:${sourceId}`) exists for stable React keys, not
 * as a dedup mechanism.
 *
 * Resolution (an item "disappears when resolved, including elsewhere"): this function
 * reads the CURRENT state and does no caching of its own — a permissionAnswered/
 * questionAnswered action, a status{permissionResolved|questionResolved} event (FEATURE-9
 * bug fix: the daemon's own timeout fallback resolving a question/approval-gate elsewhere,
 * e.g. fail-closed on timeout, mirrors the existing permission/dialog timeout events), or a
 * later status{state:"done"|"pending"|...} event overwriting a TaskLite entry (whether it
 * arrived because THIS client answered, or another client / the timeout fallback did),
 * removes the source object from state BEFORE the next call, so the row is simply absent on
 * the next derive. No inbox-local "resolved" bookkeeping.
 */
export function attentionInbox(state: UiState): InboxItem[] {
  const items: InboxItem[] = [];

  for (const p of state.pendingPermissions) {
    items.push({ id: `permission:${p.requestId}`, kind: "permission", urgency: "blocking", ts: p.ts, agentId: p.agentId, permission: p });
  }

  for (const agentId of state.agentOrder) {
    const q = state.agents[agentId]?.pendingQuestion;
    // ASK-UNREACHABLE-TARGET-LEAK invariant (see types.ts's AgentQuestion doc comment):
    // a question carrying `to` is addressed to ANOTHER AGENT (ask_agent/ask_team), never
    // to the human — answerable only by that agent calling answer_question. Surfacing it
    // here would let a human "answer" a question that isn't theirs to answer, exactly the
    // bug that fix closed for QuestionCard. Every human-facing surface must apply this
    // same filter; do not special-case the inbox.
    if (!q || q.to !== undefined) continue;
    const kind = q.gate === "approval" ? "approval" : "question";
    items.push({ id: `${kind}:${q.questionId}`, kind, urgency: "blocking", ts: q.ts, agentId, question: { ...q, agentId } });
  }

  for (const task of Object.values(state.tasks)) {
    if (task.state === "failed") {
      items.push({ id: `task_failed:${task.taskId}`, kind: "task_failed", urgency: "waiting", ts: task.updatedAt, task });
    } else if (task.state === "blocked") {
      items.push({ id: `task_blocked:${task.taskId}`, kind: "task_blocked", urgency: "fyi", ts: task.updatedAt, task });
    }
  }

  for (const session of Object.values(state.reviewRoom.sessionsByTask)) {
    if (session.decision?.status === "changes_requested") items.push({
      id: `review_decision:${session.taskId}:${session.decision.revision}`,
      kind: "review_decision", urgency: "blocking", ts: session.decision.decidedAt,
      taskId: session.taskId, summary: session.decision.summary,
    });
  }

  return items.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || a.ts - b.ts);
}
