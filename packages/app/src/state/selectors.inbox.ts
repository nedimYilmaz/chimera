// FEATURE-9 (attention inbox) — PURE display-formatting helpers over ui-state's
// InboxItem, mirroring selectors.workflows.ts's own gateLabel pattern: the shared
// ui-state package stays UI-framework- and copy-agnostic (attentionInbox returns raw
// state refs, no display strings), formatting lives one layer up here. No React, no
// store import, fully unit-testable.
import type { InboxItem, InboxItemKind, InboxUrgency, UiState } from "@chimera/ui-state";
import { displayName, formatToolInput, shortId, toneVar, type Tone } from "./selectors";

export const URGENCY_SECTION_TITLE: Record<InboxUrgency, string> = {
  blocking: "Needs you now",
  waiting: "Needs a decision",
  fyi: "FYI",
};

const KIND_GLYPH: Record<InboxItemKind, { glyph: string; tone: Tone }> = {
  permission: { glyph: "⚠", tone: "warn" },
  question: { glyph: "?", tone: "info" },
  approval: { glyph: "?", tone: "info" },
  task_failed: { glyph: "✗", tone: "danger" },
  task_blocked: { glyph: "◐", tone: "muted" },
  review_decision: { glyph: "!", tone: "danger" },
};

/** The glyph + tone shown at the start of an inbox row. */
export function inboxRowGlyph(item: InboxItem): { glyph: string; tone: Tone } {
  return KIND_GLYPH[item.kind];
}

/** The glyph's resolved CSS color, ready to hand to a style attribute. */
export function inboxRowGlyphColor(item: InboxItem): string {
  return toneVar(inboxRowGlyph(item).tone);
}

/** One-line row title. */
export function inboxRowTitle(item: InboxItem): string {
  switch (item.kind) {
    case "permission": return `Permission: ${item.permission.toolName}`;
    case "question": return item.question.prompt;
    case "approval": return `Approval: ${item.question.prompt}`;
    case "task_failed": return `Task failed: ${item.task.subject}`;
    case "task_blocked": return `Task blocked: ${item.task.subject}`;
    case "review_decision": return `Changes requested: ${item.taskId}`;
  }
}

/** Secondary detail line — tool input excerpt / failure reason / queue hint. null
 * when the title already carries everything worth showing (a plain question/approval's
 * prompt IS the title, so no redundant detail line). */
export function inboxRowDetail(item: InboxItem): string | null {
  switch (item.kind) {
    case "permission": return formatToolInput(item.permission.input, false) || null;
    case "question":
    case "approval":
      return null;
    case "task_failed": return item.task.error ?? null;
    case "task_blocked": return `waiting on dependencies in "${item.task.queue}"`;
    case "review_decision": return item.summary || "review findings need attention";
  }
}

/** The owning agent's display name (falls back to a short id for an agent not yet
 * projected into state.agents), or null when the item carries no agent (a task row's
 * `agentId` is null until a worker picks it up). */
export function inboxRowAgentLabel(state: Pick<UiState, "agents">, agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  const agent = state.agents[agentId];
  return agent ? displayName(agent) : shortId(agentId);
}

/** Groups already-sorted InboxItems (attentionInbox's own urgency-then-FIFO order is
 * preserved) into the three urgency sections the screen renders, omitting empty ones. */
export function inboxSections(items: readonly InboxItem[]): Array<{ urgency: InboxUrgency; title: string; items: InboxItem[] }> {
  const order: InboxUrgency[] = ["blocking", "waiting", "fyi"];
  return order
    .map((urgency) => ({ urgency, title: URGENCY_SECTION_TITLE[urgency], items: items.filter((i) => i.urgency === urgency) }))
    .filter((s) => s.items.length > 0);
}
