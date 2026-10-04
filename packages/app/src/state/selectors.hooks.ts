// HOOK-6 (PLAN-HOOKS.md §7) — PURE selectors/formatters for the lifecycle-hooks
// card, cloned from selectors.notify.ts. No React, no store, no rpc imports (same
// discipline as selectors.host.ts/selectors.notify.ts). A HookRule's live activity
// (last fired/suppressed) is folded in the ui-state reducer under state.hooks; this
// module only formats the rule array + that status map into table rows.
import { CONTENT_TOPICS, contentFilterIssue, UNSATISFIABLE_FILTER_KEYS as PROTOCOL_UNSATISFIABLE_FILTER_KEYS } from "@chimera/protocol";
import type { HookRule, HookAction, Topic, TopicFilter } from "@chimera/protocol";
import type { HookStatus } from "@chimera/ui-state";

// ---------------------------------------------------------------------------
// topics — the §2.2 curated vocabulary, in the order the form's <select> offers.
// ---------------------------------------------------------------------------

export const HOOK_TOPICS: readonly Topic[] = [
  "agent.settled", "agent.spawned", "task.state", "gate.verdict", "queue.drained",
  "repo.landed", "memory.added", "permission.pending", "question.pending", "budget.warning",
  "system.woke",
  "agent.promptStalled",
  "agent.output",
  "job.dead_letter",
  "memory.pressure",
  "memory.evicted",
];

/** A topic's lowercase-with-spaces label (mirrors selectors.notify's kindLabel). */
export function topicLabel(topic: string): string {
  switch (topic) {
    case "agent.settled": return "agent settled";
    case "agent.spawned": return "agent spawned";
    case "task.state": return "task state change";
    case "gate.verdict": return "gate verdict";
    case "queue.drained": return "queue drained";
    case "repo.landed": return "repo landed";
    case "memory.added": return "memory added";
    case "permission.pending": return "permission pending";
    case "question.pending": return "question pending";
    case "budget.warning": return "budget ≥80%";
    case "system.woke": return "machine woke";
    case "agent.promptStalled": return "prompt not acknowledged";
    case "agent.output": return "agent output contains";
    case "job.dead_letter": return "job dead-lettered";
    case "memory.pressure": return "shared memory near full";
    case "memory.evicted": return "memory note dropped";
    default: return topic.replace(/[._]/g, " ");
  }
}

// ---------------------------------------------------------------------------
// filters — the shallow TopicFilter (§2.1), same "k=v, k2=v2" hint as notify's.
// ---------------------------------------------------------------------------

// F46/QA finding E: the offered keys are a FUNCTION of the selected topic, not one fixed list.
// TopicFilterSchema is strict AND contentFilterIssue rejects `contains` on every non-content
// topic (and requires it on a content one), so a single flat list let the operator build a rule
// the server always refuses — a red error at submit for a choice the form had offered.
// treeId/team are deliberately NOT offered (F46 finding C): they are accepted by the schema but
// no projector ever populates them, so such a rule silently matches nothing forever — now also
// refused server-side by scopeFilterIssue (index.ts), whose UNSATISFIABLE_FILTER_KEYS list is
// the single source of truth this re-exports rather than duplicates. They stay renderable for a
// rule authored elsewhere (see hookFilterKeysFor) — just not proposable here.
const UNSATISFIABLE_FILTER_KEYS: readonly string[] = PROTOCOL_UNSATISFIABLE_FILTER_KEYS;
const NON_CONTENT_FILTER_KEYS: readonly (keyof TopicFilter)[] = [
  "agentId", "taskId", "queue", "state", "repo", "tags",
];

/** F46: does this topic carry matchable output text (i.e. does it take `contains`)? */
export function isContentTopic(topic: string): boolean {
  return (CONTENT_TOPICS as readonly string[]).includes(topic);
}

/** The TopicFilter keys the form offers for `topic`. Content topics match on TEXT and take
 * only `contains`; every other topic takes the scalar identity keys and never `contains`. */
export function hookFilterKeys(topic: Topic): readonly (keyof TopicFilter)[] {
  return CONTENT_TOPICS.includes(topic) ? (["contains"] as const) : NON_CONTENT_FILTER_KEYS;
}

/** The offered keys PLUS whatever key the draft already carries — so editing a rule authored
 * by an agent (or a pre-F46 form) with a treeId/team filter does not blank the <select>. */
export function hookFilterKeysFor(topic: Topic, current: string): readonly string[] {
  const keys = hookFilterKeys(topic);
  return current && !keys.includes(current as keyof TopicFilter) ? [...keys, current] : keys;
}

/** Move a filter key onto the newly-selected topic: content topics need `contains`, so it is
 * pre-selected; leaving a content topic drops it rather than carrying an illegal key along. */
export function reconcileFilterKey(topic: Topic, filterKey: string): string {
  if (CONTENT_TOPICS.includes(topic)) return "contains";
  return filterKey === "contains" ? "" : filterKey;
}

/** The refusal the SERVER would return for this draft, computed locally so it shows up while
 * the operator types instead of as a red round-trip at save. Wording is protocol's, never a
 * second copy of it; only the length rule (TopicFilterSchema's `contains` min 3/max 64) is
 * restated, because zod's own message for it is not operator-facing. */
export function hookDraftFilterIssue(topic: Topic, filterKey: string, filterValue: string): string | null {
  const key = filterKey.trim();
  const value = filterValue.trim();
  const issue = contentFilterIssue(topic, key === "contains" && value ? { contains: value } : key ? ({ [key]: value } as TopicFilter) : undefined);
  if (issue) return issue;
  if (key === "contains" && (value.length < 3 || value.length > 64)) {
    return "filter.contains must be 3-64 characters";
  }
  return null;
}

/** A non-blocking caution for a filter key that is legal but useless (F46 finding C). Kept OUT
 * of hookDraftFilterIssue on purpose: an existing rule carrying such a key must stay editable. */
export function hookFilterWarning(filterKey: string): string | null {
  return UNSATISFIABLE_FILTER_KEYS.includes(filterKey.trim())
    ? `no event carries ${filterKey.trim()} today — a rule filtered on it will never fire`
    : null;
}

export function hookFilterLabel(filter: TopicFilter | undefined): string | null {
  if (!filter) return null;
  const parts = Object.entries(filter)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : String(v)}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** F46.UI - the same filter as an operator reads it in a watch chip: the needle FIRST
 * and quoted (it is the whole reason a content subscription exists, and hookFilterLabel's
 * bare `contains=ERROR` buries it after a uuid), then the remaining keys as k=v. */
export function watchFilterLabel(filter: TopicFilter | undefined): string | null {
  if (!filter) return null;
  const { contains, ...rest } = filter;
  const parts: string[] = [];
  if (typeof contains === "string" && contains !== "") parts.push(`contains "${contains}"`);
  const others = hookFilterLabel(rest as TopicFilter);
  if (others) parts.push(others);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ---------------------------------------------------------------------------
// actions — a terse one-line summary of the rule's action list (5 types, §3.2).
// ---------------------------------------------------------------------------

export function actionLabel(action: HookAction): string {
  switch (action.type) {
    case "notify": return `notify → ${action.to}`;
    case "push": return `push ${action.queue}`;
    case "spawn": return `spawn ${action.spec.role ?? "agent"}`;
    case "run": return `run ${truncate(action.command, 24)}`;
    case "channel": return action.channel;
  }
}

export function actionsLabel(actions: readonly HookAction[]): string {
  return actions.map(actionLabel).join(" · ") || "—";
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------
// rows — one per rule, enriched with its folded activity status.
// ---------------------------------------------------------------------------

export type HookRuleRow = {
  name: string;
  enabled: boolean;
  topicLabel: string;
  filterLabel: string | null;
  actionsLabel: string;
  /** ts of the most recent hook_fired for this rule (undefined = never fired). */
  lastFired?: number;
  lastSuppressed?: number;
  fireCount: number;
  suppressCount: number;
  lastSuppressReason?: string;
};

export function buildHookRows(
  rules: readonly HookRule[],
  status: Readonly<Record<string, HookStatus>>,
): HookRuleRow[] {
  return rules.map((r) => {
    const s = status[r.name];
    return {
      name: r.name,
      enabled: r.enabled,
      topicLabel: topicLabel(r.on),
      filterLabel: hookFilterLabel(r.filter),
      actionsLabel: actionsLabel(r.actions),
      ...(s?.lastFired !== undefined ? { lastFired: s.lastFired } : {}),
      ...(s?.lastSuppressed !== undefined ? { lastSuppressed: s.lastSuppressed } : {}),
      fireCount: s?.fireCount ?? 0,
      suppressCount: s?.suppressCount ?? 0,
      ...(s?.lastSuppressReason ? { lastSuppressReason: s.lastSuppressReason } : {}),
    };
  });
}

/** A rule's terse activity cell: "fired ×3" / "suppressed (rate-limit)" / "—".
 * The card renders the clock separately; this is the count/reason summary. */
export function activityLabel(row: HookRuleRow): string {
  const fired = row.lastFired !== undefined && (row.lastSuppressed === undefined || row.lastFired >= row.lastSuppressed);
  if (fired) return row.fireCount > 1 ? `fired ×${row.fireCount}` : "fired";
  if (row.lastSuppressed !== undefined) return row.lastSuppressReason ? `suppressed · ${row.lastSuppressReason}` : "suppressed";
  return "—";
}

// ---------------------------------------------------------------------------
// F46.UI - pushed subscription signals in the transcript.
// ---------------------------------------------------------------------------

/** What the signal header should say for one delivered signal body. */
export type SignalHeadline = {
  topic: string;
  /** operator wording for the header tag, e.g. `output matched "ERROR"`. */
  label: string;
  /** the one line that actually matched (content topics only), else null. */
  detail: string | null;
};

/** F46.UI - a pushed signal arrives as `[signal:<topic>] ... - seq N\n{payload json}`
 * (core/subscriptions.ts buildSignalText). Without this the transcript shows a bare
 * signal tag over raw JSON, so an operator cannot tell WHY the agent was woken - on
 * agent.output the whole point is the matched needle and its line. The JSON is capped
 * at 600 chars server-side and may therefore be truncated: parsing is best-effort and
 * falls back to the topic label alone, never throwing. */
export function signalHeadline(text: string): SignalHeadline | null {
  const m = /^\[signal:([^\]]+)\]/.exec(text);
  if (!m) return null;
  const topic = m[1]!;
  const fallback: SignalHeadline = { topic, label: topicLabel(topic), detail: null };
  const nl = text.indexOf("\n");
  if (nl < 0) return fallback;
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text.slice(nl + 1));
    if (typeof parsed !== "object" || parsed === null) return fallback;
    payload = parsed as Record<string, unknown>;
  } catch {
    return fallback; // truncated at the 600-char cap - the topic is still worth showing
  }
  if (!isContentTopic(topic)) return fallback;
  const match = typeof payload["match"] === "string" ? payload["match"] : null;
  const line = typeof payload["text"] === "string" ? payload["text"].trim() : "";
  const source = payload["source"] === "tool" ? "tool output" : "output";
  return {
    topic,
    label: match ? `${source} matched "${match}"` : topicLabel(topic),
    detail: line.length > 0 ? line : null,
  };
}
