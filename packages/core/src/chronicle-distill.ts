// CHRONICLE-SEMANTIC — turn a raw event into a compact, human-readable document worth embedding.
//
// WHY a distiller and not "just index the events": measured on a real 5000-event segment, the log
// is overwhelmingly made of things that carry no recoverable history —
//
//   capability_decision  41% of events   (an authorization verdict, not a memory)
//   message_delta        26% of events   (streaming fragments; message_complete supersedes them)
//   status/agent_started 45% of BYTES    (avg 105 KB — the system prompt, re-logged per spawn)
//
// Indexing all of it would spend most of the embedding budget on noise AND make every search
// compete against it. The allowlist below is ~17% of events, and it is the 17% that answers
// "what did this agent actually do".
//
// WHY per-kind extractors with a generic fallback: a generic flatten produces `data.foo.bar: value`
// token soup — fine for substring matching (what EventLog.search does), poor as embedding input,
// because the field paths dominate the sentence. The extractors below produce natural text for the
// kinds that matter. The fallback means a kind nobody wrote an extractor for is still indexed
// reasonably rather than silently dropped — the failure mode of a hand-maintained list.

import type { EventKind, NormalizedEvent } from "@chimera/protocol";
import { SECRET_KEY, redactSecrets } from "./events.js";

// The kinds worth remembering. Deliberately NOT "everything except a denylist": a new noisy kind
// added later would silently join the corpus, and the cost of that is paid on every search forever.
export const CHRONICLE_INDEXED_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "message_complete",   // what the agent said — the single densest source
  "tool_call",          // what it did
  "tool_result",        // what came back
  "agent_task",         // what it was asked to do
  "turn_complete",      // the turn's outcome/summary
  "result",             // a finished run's result
  "error",              // failures are history too, and the most-asked-about kind
  "agent_question",     // an unblock request and its answer
  "artifact_added",     // produced outputs
  "task_state_changed", // queue progress
  "compaction",         // the very event that creates the need for this search
]);

/** How much distilled text we keep per document. The embedder truncates at 1500 chars anyway; this
 *  is also what BM25 scores, what a snippet is cut from, and what survives when the raw event has
 *  been pruned — so it is a storage decision as much as a quality one (see CHRONICLE_DOC_BYTES). */
export const DOC_TEXT_MAX = 1200;

/** A single indexed unit. Self-contained ON PURPOSE: it must stay answerable after the raw event
 *  has been pruned from the log AND after the agent record has been forgotten, so every field
 *  needed to filter or display it is captured here rather than looked up later. */
export type ChronicleDoc = {
  seq: number;
  ts: number;
  engineId: string;
  agentId: string;
  kind: EventKind;
  text: string;
  /** Scope keys captured AT INDEX TIME. The supervisor is the only thing that knows an agent's
   *  tree/team, and it forgets a terminal agent — so resolving these lazily at search time would
   *  make exactly the oldest, most valuable documents unfilterable. */
  treeId: string | null;
  team: string | null;
};

/** Resolves an agent's tree/team at index time. Returns nulls for an agent already gone. */
export type ScopeResolver = (agentId: string) => { treeId: string | null; team: string | null };

const NO_SCOPE: ScopeResolver = () => ({ treeId: null, team: null });

export function isIndexableKind(kind: EventKind): boolean {
  return CHRONICLE_INDEXED_KINDS.has(kind);
}

/** Distill one event, or null if its kind is not indexed / it carries no text worth embedding. */
export function distillEvent(event: NormalizedEvent, resolveScope: ScopeResolver = NO_SCOPE): ChronicleDoc | null {
  if (!isIndexableKind(event.kind)) return null;
  const body = extractText(event);
  if (!body) return null;
  const { treeId, team } = resolveScope(event.agentId);
  return {
    seq: event.seq, ts: event.ts, engineId: event.engineId, agentId: event.agentId, kind: event.kind,
    // The kind leads the text so it is part of what gets embedded: "tool_result … permission denied"
    // and "error … permission denied" are genuinely different memories, and a query naming one of
    // them should be able to prefer it.
    text: `${event.kind}: ${body}`.slice(0, DOC_TEXT_MAX),
    treeId, team,
  };
}

type Extractor = (d: Record<string, unknown>) => string | null;

// Per-kind extraction. Each returns the sentence a human would write about the event.
const EXTRACTORS: Partial<Record<EventKind, Extractor>> = {
  message_complete: (d) => text(d, "text", "content", "message"),
  agent_task: (d) => join([text(d, "description", "prompt", "summary"), text(d, "subagentType", "taskType")]),
  turn_complete: (d) => join([text(d, "summary", "text"), text(d, "stopReason", "reason")]),
  result: (d) => text(d, "result", "text", "summary"),
  error: (d) => join([text(d, "message", "error", "text"), text(d, "code")]),
  agent_question: (d) => join([text(d, "question", "prompt"), text(d, "answer", "response")]),
  artifact_added: (d) => join([text(d, "title", "name", "path"), text(d, "summary", "description")]),
  task_state_changed: (d) => join([text(d, "title", "description", "text"), text(d, "state", "status")]),
  compaction: (d) => join([text(d, "phase"), text(d, "summary", "text")]),
  tool_call: (d) => join([text(d, "name", "toolName", "tool"), compact(d["input"] ?? d["args"] ?? d["params"])]),
  tool_result: (d) => join([text(d, "name", "toolName", "tool"), compact(d["result"] ?? d["output"] ?? d["content"] ?? d["text"])]),
};

function extractText(event: NormalizedEvent): string | null {
  const extractor = EXTRACTORS[event.kind];
  const specific = extractor?.(event.data);
  if (specific) return specific;
  // GENERIC FALLBACK — a kind with no extractor, or one whose expected fields were absent, still
  // gets indexed off whatever scalars it carries. Silently dropping it would make the allowlist
  // above lie about what is searchable.
  return compact(event.data);
}

function text(d: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = d[key];
    if (typeof v === "string" && v.trim()) return SECRET_KEY.test(key) ? "[REDACTED]" : v.trim();
  }
  return null;
}

const join = (parts: Array<string | null>): string | null => {
  const kept = parts.filter((p): p is string => Boolean(p));
  return kept.length ? kept.join(" — ") : null;
};

/** Render an arbitrary value as compact prose. Objects become `key: value` pairs (no dotted paths —
 *  those read as noise to an embedder); long strings keep their HEAD AND TAIL, because a tool
 *  result's verdict (the error line, the summary) is usually at the end, and head-only truncation
 *  is what makes a 9 KB failure look like a 9 KB success. */
function compact(value: unknown, depth = 0): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return clip(value.trim()) || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth > 2) return null;
  if (Array.isArray(value)) {
    const parts = value.slice(0, 10).map((v) => compact(v, depth + 1)).filter(Boolean);
    return parts.length ? parts.join("; ") : null;
  }
  if (typeof value === "object") {
    const parts: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
      if (SECRET_KEY.test(key)) { parts.push(`${key}: [REDACTED]`); continue; }
      const rendered = compact(child, depth + 1);
      if (rendered) parts.push(`${key}: ${rendered}`);
    }
    return parts.length ? parts.join(", ") : null;
  }
  return null;
}

const CLIP_HEAD = 700;
const CLIP_TAIL = 300;
function clip(s: string): string {
  const safe = redactSecrets(s);
  if (safe.length <= CLIP_HEAD + CLIP_TAIL) return safe;
  return `${safe.slice(0, CLIP_HEAD)} … ${safe.slice(-CLIP_TAIL)}`;
}
