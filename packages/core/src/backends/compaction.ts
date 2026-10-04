// TOKEN-OPT-P3: GenericAgentBackend (generic.ts) re-sends its full messages[] on every
// round-trip with no bound -- a single "turn" from the caller's perspective can be dozens of
// tool round-trips (the hand-rolled loop has no agentic-SDK-side context management the way
// claude.ts/codex.ts do). This module bounds that array.
//
// Deterministic, NOT an LLM summarization call (unlike scheduler.ts's beginHandoff, F16.1
// Phase 3): spending tokens on a summarization request to save tokens is self-defeating for a
// feature whose whole point is cutting this backend's token spend. Instead this mirrors
// Anthropic's context-editing "clear_tool_uses" strategy -- mechanically clear/collapse the
// oldest history first, the safest form of compaction -- and reuses tool-result.ts's existing
// truncation as the per-message cap on the resulting summary note.
import { boundToolResultText } from "./tool-result.js";
import type { ChatMessage } from "./generic.js";
import { MODEL_CONTEXT_WINDOWS, type ModelMetadataLookup } from "@chimera/protocol";

export const DEFAULT_COMPACTION_CHAR_BUDGET = 80_000;
// COMPACTION-THRESHOLD-CONFIG: a configured compactionThreshold is TOKENS (uniform across
// backends — see protocol's ProviderOverrideSchema), but this module's budget has always been
// chars (no tokenizer dependency). ~4 chars/token is the standard rough-order English/code
// heuristic (matches the ballpark OpenAI/Anthropic docs quote) — good enough for a soft
// compaction trigger, not meant to be exact.
export const DEFAULT_CHARS_PER_TOKEN = 4;
export function charBudgetForTokenThreshold(tokens: number): number {
  return tokens * DEFAULT_CHARS_PER_TOKEN;
}

// GENERIC-COMPACTION-WINDOW: with no operator-set compactionThreshold, this backend used to
// compact on the flat DEFAULT_COMPACTION_CHAR_BUDGET regardless of the model's real context
// window — context-window-blind, unlike claude.ts/codex.ts which delegate to their SDK's own
// window-aware auto-compaction. Fraction of the model's KNOWN window we trigger at, leaving
// headroom for the rest of the current round (further tool calls, DEFAULT_MAX_OUTPUT_TOKENS of
// output) before the next compaction check runs at the top of generic.ts's loop — mirrors the
// kind of safety margin protocol's CLAUDE_AUTO_COMPACT_WINDOW_MIN/MAX clamp exists for.
export const COMPACTION_WINDOW_SAFETY_FRACTION = 0.75;

export type CompactionBudgetSource = "catalog" | "hardcoded" | "default";
export type CompactionBudget = { charBudget: number; source: CompactionBudgetSource };

// Resolves the compaction char budget for a model with NO operator override. Prefers the
// model's real window — first the injected catalog's dynamic entry (config override / remote
// LiteLLM cache), then protocol's hardcoded per-model table — converted token->char via the
// same ~4-chars/token heuristic charBudgetForTokenThreshold already uses for an explicit
// compactionThreshold. `source` distinguishes a real window from the last-resort
// DEFAULT_COMPACTION_CHAR_BUDGET guess so a caller can surface WHICH one is in effect (see
// generic.ts's spawn-time status event) instead of silently blending them — this project has
// spent the week making silent defaults visible instead of guessed. Unknown model / no catalog
// ⇒ "default", byte-identical charBudget to before this function existed.
export function resolveCompactionBudget(model: string | undefined, catalog?: ModelMetadataLookup): CompactionBudget {
  if (model) {
    const dynamic = catalog?.contextWindow(model);
    if (dynamic !== undefined) {
      return { charBudget: charBudgetForTokenThreshold(Math.floor(dynamic * COMPACTION_WINDOW_SAFETY_FRACTION)), source: "catalog" };
    }
    const hard = MODEL_CONTEXT_WINDOWS[model];
    if (hard !== undefined) {
      return { charBudget: charBudgetForTokenThreshold(Math.floor(hard * COMPACTION_WINDOW_SAFETY_FRACTION)), source: "hardcoded" };
    }
  }
  return { charBudget: DEFAULT_COMPACTION_CHAR_BUDGET, source: "default" };
}
// Rounds, not user-turns: a round is one assistant response (+ its tool results, if any) or
// one user message -- see splitRounds below. A single user turn with no further user input
// can span many rounds (a tool-call loop), so windowing on rounds is what actually bounds a
// long single-turn tool loop, which windowing on user-message-delimited turns would not.
export const DEFAULT_COMPACTION_KEEP_ROUNDS = 20;

const SUMMARY_MARKER = "[compacted history]";

function messageChars(m: ChatMessage): number {
  let n = (m.content ?? "").length;
  // This is a memory/character budget, not a claim about image token pricing.
  if (m.role === "user") for (const block of m.contentBlocks ?? []) {
    if (block.type === "image") n += block.data.length;
  }
  if (m.role === "assistant" && m.toolCalls) {
    for (const tc of m.toolCalls) n += tc.name.length + tc.arguments.length;
  }
  if (m.role === "assistant" && m.providerItems) n += JSON.stringify(m.providerItems).length;
  return n;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// A "round" is exactly one push-group generic.ts's run() loop ever writes atomically before
// its next await: a lone user message, OR one assistant message plus every "tool" message
// answering its toolCalls (always pushed in the same synchronous for-loop, before the next
// LLM call). Collapsing whole rounds -- never splitting one -- is what guarantees a
// tool_call/tool_result pair is never orphaned by compaction.
function splitRounds(messages: ChatMessage[]): { system: ChatMessage | null; rounds: ChatMessage[][] } {
  let system: ChatMessage | null = null;
  let start = 0;
  if (messages[0]?.role === "system") { system = messages[0]; start = 1; }
  const rounds: ChatMessage[][] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool" && rounds.length > 0) rounds[rounds.length - 1]!.push(m);
    else rounds.push([m]);
  }
  return { system, rounds };
}

function summarizeRound(round: ChatMessage[]): string {
  const m = round[0]!;
  if (m.role === "user") {
    // a prior compaction's own summary note, carried forward verbatim (not re-truncated to
    // 200 chars every pass) so repeated compaction over a very long run degrades gracefully
    // instead of shredding earlier summaries down to nothing.
    if (m.content?.startsWith(SUMMARY_MARKER)) return m.content;
    return `user: ${truncate(m.content ?? "", 200)}`;
  }
  if (m.role === "assistant") {
    const bits: string[] = [];
    if (m.content) bits.push(`assistant: ${truncate(m.content, 200)}`);
    if (m.toolCalls?.length) bits.push(`assistant called ${m.toolCalls.map((tc) => tc.name).join(", ")}`);
    return bits.join(" ") || "assistant: (tool round)";
  }
  return "";
}

// COMPACTION-OBSERVABILITY: `force` bypasses the charBudget check entirely (a manual trigger
// wants to compact NOW regardless of size) but never the keepRecentRounds protected-window
// guard below -- a manual compact still can't eat into the recent history a budget-triggered
// one wouldn't either.
export type CompactionOptions = { charBudget?: number; keepRecentRounds?: number; force?: boolean };

// COMPACTION-OBSERVABILITY: exact, not estimated -- every field here is counted from the same
// arrays compactMessages already builds, so a caller emitting an event off this report is
// never guessing at what happened.
export type CompactionReport = {
  beforeMessages: number;
  afterMessages: number;
  beforeChars: number;
  afterChars: number;
  droppedRounds: number;
};

// Returns `messages` unchanged (same reference) when no compaction is needed/possible, so
// callers can cheaply detect a no-op via reference equality; `report` is null in that same
// case (nothing happened, nothing to report).
export function compactMessagesDetailed(
  messages: ChatMessage[],
  opts: CompactionOptions = {},
): { messages: ChatMessage[]; report: CompactionReport | null } {
  const charBudget = opts.charBudget ?? DEFAULT_COMPACTION_CHAR_BUDGET;
  const keepRecentRounds = opts.keepRecentRounds ?? DEFAULT_COMPACTION_KEEP_ROUNDS;

  const beforeChars = messages.reduce((n, m) => n + messageChars(m), 0);
  if (!opts.force && beforeChars <= charBudget) return { messages, report: null };

  const { system, rounds } = splitRounds(messages);
  // Never eat into the preserved recent-K window -- if there isn't more than keepRecentRounds
  // to drop, stay over budget rather than dropping protected history. (The system instruction
  // is always preserved separately, above.) Applies even when force:true -- a manual trigger
  // with nothing droppable is a no-op, not a way to bypass the protected window.
  if (rounds.length <= keepRecentRounds) return { messages, report: null };

  const dropCount = rounds.length - keepRecentRounds;
  const dropped = rounds.slice(0, dropCount);
  const kept = rounds.slice(dropCount);

  const summaryBody = dropped.map(summarizeRound).filter(Boolean).join("\n");
  const summaryText = boundToolResultText(`${SUMMARY_MARKER} (${dropped.length} earlier round(s))\n${summaryBody}`);
  const summaryMessage: ChatMessage = { role: "user", content: summaryText };

  const result = [
    ...(system ? [system] : []),
    summaryMessage,
    ...kept.flat(),
  ];
  const afterChars = result.reduce((n, m) => n + messageChars(m), 0);
  return {
    messages: result,
    report: { beforeMessages: messages.length, afterMessages: result.length, beforeChars, afterChars, droppedRounds: dropped.length },
  };
}

// Pre-existing callers/tests want just the array -- compactMessagesDetailed is the reporting
// superset new (generic.ts) callers use to emit the "compaction" event.
export function compactMessages(messages: ChatMessage[], opts: CompactionOptions = {}): ChatMessage[] {
  return compactMessagesDetailed(messages, opts).messages;
}
