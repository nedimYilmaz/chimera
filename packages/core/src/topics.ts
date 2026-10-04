import type { EventKind, NormalizedEvent, Topic, TopicFilter } from "@chimera/protocol";
import { redactSecrets } from "./events.js";

// PLAN-HOOKS.md §2.2/§3.1 (HOOK-2): the ONE topic -> event-kind(s) + predicate table shared by
// SubscriptionRegistry (subscriptions.ts) and the future HookEngine (HOOK-4, hooks.ts) — a
// single source, never two divergent copies (§11 guardrail). Agents/hooks never see raw
// EventKinds; each topic below maps to the underlying kind(s) that can carry it plus a
// `toPayload` projector that (a) decides whether THIS particular event of a mapped kind really
// represents the topic (null = no, keep scanning other candidates) and (b) extracts the curated
// payload fields the §2.2 table promises — never the raw event `data` verbatim.
export type TopicPayload = Record<string, unknown>;

// Narrow structural lookup — deliberately NOT the real AgentRecord type, to avoid a
// subscriptions.ts <-> supervisor.ts import cycle. Only the fields a predicate below needs.
export type TopicAgentLookup = (agentId: string) => { state: string; spec: { resume?: string } } | undefined;
export type TopicContext = { getAgent: TopicAgentLookup };

export type TopicMapping = {
  kinds: readonly EventKind[];
  toPayload: (e: NormalizedEvent, ctx: TopicContext) => TopicPayload | null;
  // F46: set on the CONTENT topics only. Its presence is what tells both consumers that this
  // topic's payload carries matchable text and must be narrowed before delivery — the flag is
  // the single discriminator, so neither consumer hardcodes a topic name.
  matchField?: "text";
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// F46 cost bound: an agent can emit a megabyte in one message_complete, and every content
// subscription in the fleet would scan all of it. Only the head and the tail are searchable —
// a needle buried in the middle of a huge blob does not match, by design. The NUL joiner can
// never appear in a legal needle, so head/tail can never splice into a phantom match.
const MATCH_SCAN_HALF = 2048;
const MATCH_LINE_CHARS = 200;

export function scanWindow(s: string): string {
  return s.length <= MATCH_SCAN_HALF * 2
    ? s
    : `${s.slice(0, MATCH_SCAN_HALF)}\u0000${s.slice(-MATCH_SCAN_HALF)}`;
}

// §2.2 table. Each topic fires on exactly the kind(s) listed here — chosen so a single settle/
// transition never double-fires (e.g. agent.settled listens to "result" for done and "status"
// for failed/killed, the two kinds that ACTUALLY carry a terminal transition today; the raw
// "error"/"turn_timeout" kinds that precede a failed settle are deliberately excluded — they are
// intermediate signals, not the authoritative state commit).
export const TOPIC_TABLE: Record<Topic, TopicMapping> = {
  "agent.settled": {
    kinds: ["result", "status"],
    toPayload: (e) => {
      if (e.kind === "result") {
        return {
          agentId: e.agentId, state: "done",
          resultPreview: truncate(String(e.data["text"] ?? ""), 2000),
          costUsd: e.data["costUsd"] ?? 0,
        };
      }
      const state = e.data["state"];
      if (state === "failed" || state === "killed") return { agentId: e.agentId, state };
      return null;
    },
  },
  "agent.spawned": {
    kinds: ["agent_started"],
    toPayload: (e, ctx) => {
      const rec = ctx.getAgent(e.agentId);
      if (!rec || rec.spec.resume) return null;   // fresh spawns only, never a resume (§2.2)
      return { agentId: e.agentId };
    },
  },
  "task.state": {
    kinds: ["task_state_changed"],
    // TASK-TAGS: `tags` is what makes `filter: {tags:[...]}` work on task work at all —
    // TopicFilterSchema has declared the key since HOOK-1 and matchesTopicFilter below has
    // always implemented the match, but until QueueStore started stamping tags onto
    // task_state_changed the payload never carried any, so every such filter matched nothing.
    // `?? []` keeps a pre-tags persisted event (replayed from an older segment) matching
    // exactly as it did before — as "no tags", never as undefined.
    toPayload: (e) => ({
      queue: e.data["queue"], taskId: e.data["taskId"], state: e.data["state"],
      tags: e.data["tags"] ?? [],
      resultPreview: e.data["resultPreview"] ?? null,
    }),
  },
  "gate.verdict": {
    kinds: ["task_step_advanced", "task_step_failed"],
    // TASK-TAGS: gate verdicts carry the OWNING TASK's tags for the `gate:*` routing case —
    // "when the coverage-gated work passes, do X" is a tag question, not a stepId question.
    toPayload: (e) => ({
      taskId: e.data["taskId"], stepId: e.data["stepId"],
      tags: e.data["tags"] ?? [],
      outcome: e.kind === "task_step_advanced" ? "passed" : "failed",
      reason: e.data["reason"] ?? null,
    }),
  },
  "queue.drained": {
    kinds: ["queue_drained"],
    toPayload: (e) => ({ queue: e.data["queue"] }),
  },
  "repo.landed": {
    kinds: ["repo_head_moved"],   // HOOK-5's RepoWatcher (not landed yet) is the only emitter
    toPayload: (e) => ({
      repo: e.data["repo"], branch: e.data["branch"], from: e.data["from"], to: e.data["to"],
    }),
  },
  "memory.added": {
    kinds: ["memory_added"],
    toPayload: (e) => ({
      id: e.data["id"], kind: e.data["kind"], tags: e.data["tags"], author: e.data["author"],
    }),
  },
  "permission.pending": {
    kinds: ["permission_request"],
    toPayload: (e) => ({ agentId: e.agentId, toolName: e.data["toolName"] }),
  },
  "question.pending": {
    kinds: ["agent_question"],
    toPayload: (e) => ({
      agentId: e.agentId,
      preview: typeof e.data["prompt"] === "string" ? truncate(e.data["prompt"], 200) : null,
    }),
  },
  "budget.warning": {
    kinds: ["budget_warning"],
    toPayload: (e) => ({ agentId: e.agentId, pct: e.data["pct"] }),
  },
  "system.woke": {
    kinds: ["clock_jump"],
    // Only a FORWARD jump is a wake. A backward step (an NTP correction) is real and is in the
    // event log, but "you slept -12m" is not a thing to wake an agent for — null here means
    // "this event of a mapped kind is not this topic", the §2.2 predicate contract.
    toPayload: (e) => {
      if (e.data["direction"] !== "forward") return null;
      return { sleptMs: e.data["driftMs"] ?? 0, observedGapMs: e.data["observedGapMs"] ?? 0 };
    },
  },
  // F09/J3: a message was delivered and the agent never opened a turn. The payload is curated,
  // not the raw event data — a subscriber needs to know WHICH delivery and how long it has been
  // silent to act; sinceTs/lastSeq/messageCount stay in the event for whoever reads the log.
  "agent.promptStalled": {
    kinds: ["agent_prompt_stalled"],
    toPayload: (e) => ({
      agentId: e.agentId,
      deliveryId: e.data["deliveryId"],
      from: e.data["from"],
      sinceMs: e.data["sinceMs"],
    }),
  },
  // F46: an agent's own output, projected for literal matching. message_delta is deliberately
  // ABSENT — a streaming chunk splits a needle across two events, so matching it would both
  // miss and double-fire; only the settled forms carry the whole text. `textLower` is computed
  // ONCE per event here rather than per subscription, which is what keeps a 64-subscription
  // fleet at one lowercase pass instead of 64.
  "agent.output": {
    kinds: ["message_complete", "tool_result"],
    matchField: "text",
    toPayload: (e) => {
      const raw = e.kind === "message_complete"
        ? e.data["text"]
        : (e.data["result"] ?? e.data["output"]);
      if (typeof raw !== "string" || raw === "") return null;
      const text = scanWindow(raw);
      return {
        agentId: e.agentId,
        source: e.kind === "message_complete" ? "assistant" : "tool",
        // Only the codex backend stamps toolName on a tool_result; claude's carries none.
        ...(typeof e.data["toolName"] === "string" ? { toolName: e.data["toolName"] } : {}),
        text,
        textLower: text.toLowerCase(),
      };
    },
  },
  "job.dead_letter": {
    kinds: ["job_dead_letter"],
    // No predicate to apply — every job_dead_letter IS this topic (unlike agent.settled, which
    // must decide which "status" events are terminal). `lastError` is projected rather than the
    // whole reasons array: a signal is a wake-up, and the full list is one job_status away.
    toPayload: (e) => {
      const reasons = Array.isArray(e.data["reasons"]) ? (e.data["reasons"] as { error?: unknown }[]) : [];
      return {
        job: e.data["job"], attempts: e.data["attempts"], maxAttempts: e.data["maxAttempts"],
        lastError: truncate(String(reasons[reasons.length - 1]?.error ?? ""), 500),
      };
    },
  },
  // F36.FIX: the memory lifecycle was feed-only — the eviction machinery announced itself in the
  // event log and nowhere an operator could HOOK. memory.pressure is the warning that always
  // precedes any loss (MemoryStore.save() calls checkPressure() before prune()), so a rule on it
  // is a chance to pin something before it goes.
  "memory.pressure": {
    kinds: ["memory_pressure"],
    toPayload: (e) => ({
      total: e.data["total"], limit: e.data["limit"], fill: e.data["fill"],
      threshold: e.data["threshold"], nextToEvict: e.data["nextToEvict"] ?? null,
    }),
  },
  // The loss itself, PER RECORD. A pass over MAX_EVICTION_EVENTS_PER_PASS emits one extra
  // {truncated,total} summary event of the same kind; it names no record, so null here keeps it
  // out of the topic ("this event of a mapped kind is not this topic", the §2.2 predicate
  // contract — same shape as system.woke's backward-jump rejection).
  "memory.evicted": {
    kinds: ["memory_evicted"],
    toPayload: (e) => {
      if (typeof e.data["id"] !== "string") return null;
      return {
        id: e.data["id"], title: e.data["title"] ?? null, kind: e.data["kind"],
        scope: e.data["scope"] ?? null, pinned: e.data["pinned"] === true,
        archived: e.data["archived"] === true,
      };
    },
  },
};

// Reverse index: kind -> topics it can feed. Built once at module load; gives every consumer
// O(1) topic-candidate lookup per event instead of scanning all 10 topics (§9 budget: <0.5ms).
export const KIND_TO_TOPICS: ReadonlyMap<EventKind, readonly Topic[]> = (() => {
  const m = new Map<EventKind, Topic[]>();
  for (const [topic, mapping] of Object.entries(TOPIC_TABLE) as [Topic, TopicMapping][]) {
    for (const kind of mapping.kinds) {
      const arr = m.get(kind) ?? [];
      arr.push(topic);
      m.set(kind, arr);
    }
  }
  return m;
})();

// §2.1 filter semantics — SAME shallow-match rules as NotifyEvaluator's matchesFilter
// (notify.ts:31-41): a scalar filter value must equal the payload field exactly; an array value
// matches if the payload field is included in it ("includes-any"). `tags` is doubly-array
// (filter.tags[] vs payload.tags[]): matches if ANY filter tag is present in the payload's tags.
export function matchesTopicFilter(payload: TopicPayload, filter?: TopicFilter): boolean {
  if (!filter) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined) continue;
    // F46: LITERAL substring, never a regex — the needle comes from an untrusted subscriber and
    // runs against every output event in the fleet. Matched against the pre-lowered `textLower`
    // the projector computed, so a fleet of subscriptions costs one lowercase pass, not N.
    if (k === "contains") {
      const hay = payload["textLower"];
      if (typeof hay !== "string" || !hay.includes(String(v).toLowerCase())) return false;
      continue;
    }
    if (k === "tags") {
      const actualTags = Array.isArray(payload["tags"]) ? (payload["tags"] as unknown[]) : [];
      if (!(v as string[]).some((t) => actualTags.includes(t))) return false;
      continue;
    }
    const actual = payload[k];
    if (Array.isArray(v)) {
      if (!v.includes(actual as never)) return false;
    } else if (actual !== v) {
      return false;
    }
  }
  return true;
}

// F46: what a content match actually DELIVERS — the matched LINE, not the scanned window. The
// full text and its lowered twin are dropped: a signal is capped at 600 chars downstream, so
// shipping the window would just truncate mid-blob and tell the subscriber nothing. Line
// extraction is split/find, deliberately not a regex (see the contains note).
export function narrowContentPayload(payload: TopicPayload, needle?: string): TopicPayload {
  const { text, textLower: _lower, ...rest } = payload as { text?: string; textLower?: string };
  const hay = typeof text === "string" ? text : "";
  // F46/QA: the line is found by scanning LINES, never by computing an index on a lowercased
  // copy and slicing the original with it — toLowerCase() is NOT length-preserving ("İ" lowers
  // to two code points), so such an index drifts and delivers a line the needle is not even on
  // while still stamping `match`. scanWindow's elision joiner counts as a line break for the
  // same "text the agent never emitted" reason: head and tail come from distant regions of the
  // output, so a line spanning the splice is a fabricated line (and would ship a raw NUL).
  const lines = hay.split("\u0000").flatMap((chunk) => chunk.split("\n"));
  const needleLower = needle?.toLowerCase();
  const line =
    (needleLower ? lines.find((l) => l.toLowerCase().includes(needleLower)) : lines[0]) ??
    lines[0] ?? "";
  return {
    ...rest,
    ...(needle ? { match: needle } : {}),
    text: truncate(redactSecrets(line).trim(), MATCH_LINE_CHARS),
  };
}
