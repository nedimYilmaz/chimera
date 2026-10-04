import type {
  HookAction, HookCause, HookRule, NormalizedEvent, Topic,
} from "@chimera/protocol";
import type { EventLog } from "./events.js";
import type { TaskPush } from "./queues.js";
import { TOPIC_TABLE, matchesTopicFilter, narrowContentPayload, type TopicContext, type TopicAgentLookup, type TopicPayload } from "./topics.js";
import { defaultGateExec, type GateExecFn } from "./scheduler.js";

// D14/HOOK-4 (PLAN-HOOKS.md §3): HookEngine — the declarative lifecycle-hook evaluator, sibling
// of NotifyEvaluator (notify.ts). Watches the shared EventLog for events matching a config-driven
// HookRule's topic+filter and runs its actions sequentially. Hooks are OBSERVATIONAL ONLY: they
// never veto/block the triggering transition (that's what workflow gates are for,
// scheduler.ts's evaluateGate) — a rule reacts to a state change, it never gates one.
//
// TOPIC MATCHING: consolidated onto HOOK-2's shared packages/core/src/topics.ts (TOPIC_TABLE +
// matchesTopicFilter, §2.2/§3.1) — the ONE topic -> kind(s)+predicate module SubscriptionRegistry
// also uses. `matchTopic` below is a thin HookEngine-specific wrapper: it adds the
// `subjectKind`/`subjectId` derivation the causation-chain guard needs (topics.ts's own payload
// shape has no opinion on "which topics carry a task vs. an agent as their subject" — that's a
// HOOK-4-only concern, not shared with subscriptions).
//
// LOOP SAFETY (§3.3, the guard trio, all auditable via hook_suppressed):
//  1. Causation chain depth — every hook-caused TaskRecord/AgentSpec carries `cause:
//     {rule,eventSeq,chain}`. A firing's chain = (the matched event's SUBJECT's own cause.chain
//     ?? 0) + 1; chain > rule.maxChainDepth (default 3) suppresses. This is what bounds an
//     unbounded "task fails -> push a retry -> retry fails -> push again" loop: real work still
//     happens for a few generations, but it hard-stops.
//  2. Per-rule rolling rate limit (maxFiresPerHour, default 20), counted at fire-START.
//  3. Self-cause REENTRANCY guard, keyed on the candidate event's own subject cause.eventSeq
//     matching one of the rule's currently in-flight originating eventSeqs (see evaluate()'s
//     doc comment for why a blanket per-rule flag is wrong).
export type SubjectKind = "task" | "agent" | "none";
export type TopicMatch = { payload: TopicPayload; subjectKind: SubjectKind; subjectId: string | null };

const TASK_SUBJECT_TOPICS = new Set<Topic>(["task.state", "gate.verdict"]);
const AGENT_SUBJECT_TOPICS = new Set<Topic>(["agent.settled", "agent.spawned", "permission.pending", "question.pending", "budget.warning", "agent.output"]);

function subjectOf(topic: Topic, payload: TopicPayload): { subjectKind: SubjectKind; subjectId: string | null } {
  if (TASK_SUBJECT_TOPICS.has(topic)) {
    const id = payload["taskId"];
    return { subjectKind: "task", subjectId: typeof id === "string" ? id : null };
  }
  if (AGENT_SUBJECT_TOPICS.has(topic)) {
    const id = payload["agentId"];
    return { subjectKind: "agent", subjectId: typeof id === "string" ? id : null };
  }
  return { subjectKind: "none", subjectId: null };
}

// QA-FIX F46/F: the (event, topic) projection — `mapping.toPayload` — is the expensive half of a
// match (a scanWindow slice + a full toLowerCase for a content topic). It depends only on the
// event and the topic, never on a rule's `contains` needle, so it is memoizable per event across
// every rule sharing the same `on` topic. Split out of matchTopic so onEvent's per-event cache
// (below) can compute it ONCE per topic instead of once per rule — the same invariant
// topics.ts:151-155 states and SubscriptionRegistry.onEvent already honours.
function projectTopic(topic: Topic, e: NormalizedEvent, ctx: TopicContext): TopicMatch | null {
  const mapping = TOPIC_TABLE[topic];
  if (!mapping.kinds.includes(e.kind)) return null;
  const payload = mapping.toPayload(e, ctx);
  if (!payload) return null;
  return { payload, ...subjectOf(topic, payload) };
}

// F46: `contains` is tested HERE, not by the caller's matchesTopicFilter, because a content
// match must be NARROWED to the matched line before it leaves this function (a rule's template
// renders the payload, and the raw scan window is far too big to notify with). Narrowing strips
// `textLower`, so a later contains-test against the returned payload could never succeed —
// hence the needle comes in and the whole contains decision is made before the narrow.
export function matchTopic(topic: Topic, e: NormalizedEvent, ctx: TopicContext, contains?: string): TopicMatch | null {
  const projected = projectTopic(topic, e, ctx);
  if (!projected) return null;
  return applyContains(topic, projected, contains);
}

function applyContains(topic: Topic, projected: TopicMatch, contains?: string): TopicMatch | null {
  const mapping = TOPIC_TABLE[topic];
  if (!mapping.matchField) return projected;
  if (!matchesTopicFilter(projected.payload, contains ? { contains } : undefined)) return null;
  return { payload: narrowContentPayload(projected.payload, contains), subjectKind: projected.subjectKind, subjectId: projected.subjectId };
}

// §3.2: mustache-lite over the compact payload — {{topic}}, {{agentId}}, {{seq}}, {{data.X}}.
// No expressions/logic (determinism over power). An unknown key resolves to "" and its raw
// `{{...}}` token is collected into `unknown` for the firing audit, per the brief.
function renderTemplate(template: string, ctx: { topic: string; agentId: string; seq: number; data: Record<string, unknown> }): { text: string; unknown: string[] } {
  const unknown: string[] = [];
  const text = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, path: string) => {
    const parts = path.split(".");
    let cur: unknown = parts[0] === "data" ? ctx.data : (ctx as Record<string, unknown>)[parts[0]!];
    for (const p of parts.slice(1)) {
      if (cur === null || typeof cur !== "object") { cur = undefined; break; }
      cur = (cur as Record<string, unknown>)[p];
    }
    if (cur === undefined || cur === null) { unknown.push(whole); return ""; }
    return String(cur);
  });
  return { text, unknown };
}

function note(unknown: string[]): string {
  return unknown.length ? ` (unknown template key(s): ${unknown.join(", ")})` : "";
}

// §3.2 `run`: no shell (execFile via GateExecFn) — a plain-string command needs splitting into
// program+args ourselves. Supports single/double-quoted segments (so a path or message with
// spaces can be one arg); not a full shell grammar (no pipes/redirects/expansion) by design —
// determinism over power, same posture as templates.
export function splitCommand(cmd: string): [string, string[]] {
  const tokens: string[] = [];
  let token = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else token += ch;
    } else if (ch === "\\") {
      const next = cmd[i + 1];
      if (next === undefined) throw new Error("hook command ends with an incomplete escape");
      // Double quotes only escape shell quoting characters; preserve e.g. Python's \\n.
      if (quote === '"' && !['$', '`', '"', "\\", "\n"].includes(next)) token += ch;
      else { if (next !== "\n") { token += next; started = true; } i++; }
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else token += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) { tokens.push(token); token = ""; started = false; }
    } else {
      token += ch;
      started = true;
    }
  }
  if (quote) throw new Error("hook command contains an unterminated quote");
  if (started) tokens.push(token);
  const [program, ...args] = tokens;
  return [program ?? "", args];
}

export type HookSendFn = (agentId: string, text: string, from?: string) => Promise<void>;
export type HookChannelDeliverFn = (channel: "toast" | "os" | "webhook" | "a2a", sample: NormalizedEvent, opts: { name: string; webhookUrl?: string }) => void;
export type HookSpawnSpec = {
  prompt: string; cwd: string; model?: string; permissionProfile?: "readOnly" | "acceptEdits" | "full";
  deliverTo?: string | null; cause: HookCause;
};

export type HookEngineDeps = {
  events: EventLog;
  send: HookSendFn;
  // @conductor resolution — the source tree's depth-0 agent id, or null if unresolvable
  // (mirrors NotifyEvaluator's resolveTreeAgent, notify.ts:111-121-era convention).
  resolveTreeAgent: (agentId: string) => string | null;
  // topics.ts's TopicContext — the "agent.spawned" projector's fresh-spawn-only check (mirrors
  // engine.ts's identical seam for SubscriptionRegistry, HOOK-2).
  getAgent: TopicAgentLookup;
  membersOf: (team: string, role?: string) => Array<{ agentId: string }>;
  pushTask: (queue: string, input: TaskPush) => TaskRecordLike;
  getTaskCause: (taskId: string) => HookCause | null;
  getTaskAgentId: (taskId: string) => string | null;
  getAgentCause: (agentId: string) => HookCause | null;
  spawnAgent: (spec: HookSpawnSpec, membership?: { team: string; role: string }) => Promise<{ agentId: string }>;
  gateExec?: GateExecFn;
  channelDeliver: HookChannelDeliverFn;
  defaultCwd: () => string;
  now?: () => number;
};

type TaskRecordLike = { taskId: string; queue: string };

const RATE_WINDOW_MS = 60 * 60 * 1000;

export class UnknownHookTargetError extends Error { code = "protocol" as const; name = "UnknownHookTargetError"; }

export class HookEngine {
  private rules: HookRule[] = [];
  private fireTimestamps = new Map<string, number[]>();   // rule name -> rolling firing times
  // rule name -> the eventSeqs of its CURRENTLY in-flight originating firings (added when a
  // firing starts, removed when it fully completes, sync or async). Keyed by eventSeq — not a
  // plain boolean — so the self-cause check (below) can tell "a nested event that is a direct
  // child of THIS active firing" apart from "an unrelated event that merely arrived while some
  // OTHER firing of the same rule happens to still be resolving" (see evaluate()'s doc comment).
  private inFlight = new Map<string, Set<number>>();
  private now: () => number;
  private topicCtx: TopicContext;

  constructor(private deps: HookEngineDeps) {
    this.now = deps.now ?? Date.now;
    this.topicCtx = { getAgent: deps.getAgent };
    this.deps.events.subscribe((e) => { this.onEvent(e); });
  }

  // Config-diff-apply hook (engine.ts's changed.includes("hooks") pattern, mirrors
  // NotifyEvaluator.setRules): swap the live rule set. In-flight firings are unaffected.
  setRules(rules: HookRule[]): void {
    this.rules = rules;
  }

  private onEvent(e: NormalizedEvent): void {
    // hook_fired/hook_error/hook_suppressed never self-trigger a hook rule — an audit event
    // reacting to itself is exactly the kind of accidental loop the guard trio exists to kill,
    // and none of the curated §2.2 topics ever map to these kinds anyway (belt-and-suspenders).
    if (e.kind === "hook_fired" || e.kind === "hook_error" || e.kind === "hook_suppressed") return;
    // QA-FIX F46/F: project each candidate topic at most ONCE per event, before the rule loop —
    // N rules on the same topic (e.g. several `agent.output` rules with different needles) used
    // to each re-run `mapping.toPayload` (a scanWindow slice + a full toLowerCase), costing N×
    // instead of the 1× every other consumer of TOPIC_TABLE pays. `contains` is per-rule, so it
    // stays applied per-rule via applyContains — only the projection is shared.
    const projections = new Map<Topic, TopicMatch | null>();
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      let projected = projections.get(rule.on);
      if (projected === undefined) {
        projected = projectTopic(rule.on, e, this.topicCtx);
        projections.set(rule.on, projected);
      }
      if (!projected) continue;
      const match = applyContains(rule.on, projected, rule.filter?.contains);
      if (!match) continue;
      // `contains` was already decided inside matchTopic (and its haystack is gone from the
      // narrowed payload) — re-testing it here would fail every content rule. matchesTopicFilter
      // skips undefined values, so blanking the key is enough to leave the rest of the filter on.
      if (!matchesTopicFilter(match.payload, rule.filter ? { ...rule.filter, contains: undefined } : undefined)) continue;
      this.evaluate(rule, e, match);
    }
  }

  // Deliberately SYNCHRONOUS up through the guard checks and any leading sync-capable actions
  // (push/channel) — an `await` on an async function call ALWAYS defers one microtask even when
  // the callee's body never actually suspends, which would otherwise let the rate-limit window
  // linger past the caller's return and corrupt it for a tight synchronous loop of unrelated
  // events (e.g. a scheduler failing many tasks back to back). Actions needing real async work
  // (notify/spawn/run) finish out-of-band via finishAsync.
  private evaluate(rule: HookRule, e: NormalizedEvent, match: TopicMatch): void {
    const subjectCause = this.subjectCause(match);
    // Guard 3 (self-cause reentrancy) — checked first: cheapest, and the one case chain-depth
    // alone would take 3 real generations to catch. Keyed on the SUBJECT's own cause.eventSeq
    // being one of THIS rule's currently in-flight originating events (not merely "is this rule
    // firing at all") — code review finding, pre-HOOK-4-land: a blanket per-rule flag spanning
    // an async action's in-flight tail would also suppress a GENUINELY INDEPENDENT concurrent
    // event that happens to match the same rule while an unrelated prior firing is still
    // resolving (e.g. 3 unrelated tasks failing while a `run`/`spawn`/`notify` action from the
    // first one's firing hasn't finished yet) — that event has no cause at all, or a cause
    // pointing at some OTHER eventSeq, so it never matches here regardless of what else this
    // rule currently has in flight. What this DOES still catch, regardless of the sync/async
    // boundary: a nested event that is a direct child of the ACTIVE firing itself — e.g. a
    // `push` that runs synchronously, or (mixed rule) a `push` that runs later inside
    // finishAsync after an earlier async action's await — because its cause.eventSeq is
    // stamped with the ORIGINAL triggering event's seq, which stays in `inFlight` for exactly
    // as long as that firing (sync or async) is still running.
    if (subjectCause && this.inFlight.get(rule.name)?.has(subjectCause.eventSeq)) {
      this.suppress(rule, e, "self-cause");
      return;
    }
    const chain = (subjectCause?.chain ?? 0) + 1;
    if (chain > rule.maxChainDepth) {
      this.suppress(rule, e, "chain-depth");
      return;
    }
    if (this.rateLimited(rule)) {
      this.suppress(rule, e, "rate-limit");
      return;
    }
    // Recorded at fire-START, not completion (code review finding, pre-HOOK-4-land): for a rule
    // whose actions need the async tail (finishAsync), completion is deferred past the current
    // synchronous stack — a synchronous burst of matching events (e.g. a queue operation that
    // fails 100 tasks inline) would otherwise all pass this rolling-window check before any of
    // them had a chance to record, blowing straight past maxFiresPerHour in one tick.
    this.recordFiring(rule);
    this.markInFlight(rule.name, e.seq);
    const cause: HookCause = { rule: rule.name, eventSeq: e.seq, chain };
    const results: Array<{ type: HookAction["type"]; ok: boolean; detail: string }> = [];
    let i = 0;
    for (; i < rule.actions.length; i++) {
      const action = rule.actions[i]!;
      if (action.type !== "push" && action.type !== "channel") break;   // first async-needing action — hand off below
      try {
        results.push({ type: action.type, ok: true, detail: this.runSyncAction(action, rule, e, match, cause) });
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        results.push({ type: action.type, ok: false, detail: message });
        this.deps.events.append({ agentId: "hooks", kind: "hook_error", data: { rule: rule.name, eventSeq: e.seq, actionType: action.type, message } });
      }
    }
    if (i >= rule.actions.length) {
      // every action was sync-capable and already ran — finish synchronously.
      this.clearInFlight(rule.name, e.seq);
      this.deps.events.append({ agentId: "hooks", kind: "hook_fired", data: { rule: rule.name, eventSeq: e.seq, chain, actions: results } });
      return;
    }
    void this.finishAsync(rule, e, match, cause, results, i);
  }

  private markInFlight(ruleName: string, eventSeq: number): void {
    let set = this.inFlight.get(ruleName);
    if (!set) { set = new Set(); this.inFlight.set(ruleName, set); }
    set.add(eventSeq);
  }

  private clearInFlight(ruleName: string, eventSeq: number): void {
    const set = this.inFlight.get(ruleName);
    if (!set) return;
    set.delete(eventSeq);
    if (set.size === 0) this.inFlight.delete(ruleName);
  }

  private async finishAsync(
    rule: HookRule, e: NormalizedEvent, match: TopicMatch, cause: HookCause,
    results: Array<{ type: HookAction["type"]; ok: boolean; detail: string }>, startIndex: number,
  ): Promise<void> {
    for (let i = startIndex; i < rule.actions.length; i++) {
      const action = rule.actions[i]!;
      try {
        const detail = await this.runAction(action, rule, e, match, cause);
        results.push({ type: action.type, ok: true, detail });
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        results.push({ type: action.type, ok: false, detail: message });
        this.deps.events.append({ agentId: "hooks", kind: "hook_error", data: { rule: rule.name, eventSeq: e.seq, actionType: action.type, message } });
      }
    }
    this.clearInFlight(rule.name, e.seq);
    this.deps.events.append({ agentId: "hooks", kind: "hook_fired", data: { rule: rule.name, eventSeq: e.seq, chain: cause.chain, actions: results } });
  }

  private subjectCause(match: TopicMatch): HookCause | null {
    if (match.subjectKind === "task" && match.subjectId) return this.deps.getTaskCause(match.subjectId);
    if (match.subjectKind === "agent" && match.subjectId) return this.deps.getAgentCause(match.subjectId);
    return null;
  }

  private rateLimited(rule: HookRule): boolean {
    const cutoff = this.now() - RATE_WINDOW_MS;
    const times = (this.fireTimestamps.get(rule.name) ?? []).filter((t) => t > cutoff);
    this.fireTimestamps.set(rule.name, times);
    return times.length >= rule.maxFiresPerHour;
  }

  private recordFiring(rule: HookRule): void {
    const times = this.fireTimestamps.get(rule.name) ?? [];
    times.push(this.now());
    this.fireTimestamps.set(rule.name, times);
  }

  private suppress(rule: HookRule, e: NormalizedEvent, reason: "chain-depth" | "rate-limit" | "self-cause"): void {
    this.deps.events.append({ agentId: "hooks", kind: "hook_suppressed", data: { rule: rule.name, reason, eventSeq: e.seq } });
  }

  // Synchronous action types only (push/channel — no Promise anywhere in their deps). Kept as
  // the single source of truth for both the leading-sync-run fast path in evaluate() and
  // runAction's delegation below (an action AFTER an async one in the same rule still needs to
  // run, just via the async tail).
  private runSyncAction(action: HookAction & { type: "push" | "channel" }, rule: HookRule, e: NormalizedEvent, match: TopicMatch, cause: HookCause): string {
    const ctx = { topic: rule.on, agentId: e.agentId, seq: e.seq, data: match.payload };
    if (action.type === "channel") {
      this.deps.channelDeliver(action.channel, e, { name: rule.name, webhookUrl: action.webhookUrl });
      return `delivered via ${action.channel}`;
    }
    const { text: prompt, unknown } = renderTemplate(action.prompt, ctx);
    let dependsOn: string[] = [];
    if (action.dependsOnCause && match.subjectKind === "task" && match.subjectId) {
      dependsOn = [match.subjectId];
    }
    const task = this.deps.pushTask(action.queue, {
      prompt, role: action.role ?? null, priority: action.priority, dependsOn, cause,
    });
    return `pushed task ${task.taskId} to ${action.queue}${note(unknown)}`;
  }

  private async runAction(action: HookAction, rule: HookRule, e: NormalizedEvent, match: TopicMatch, cause: HookCause): Promise<string> {
    const ctx = { topic: rule.on, agentId: e.agentId, seq: e.seq, data: match.payload };
    switch (action.type) {
      case "notify": {
        const { text, unknown } = renderTemplate(action.text, ctx);
        const targets = this.resolveNotifyTargets(action.to, e, match);
        for (const target of targets) await this.deps.send(target, text, `hook:${rule.name}`);
        return `sent to ${targets.length ? targets.join(",") : "(no target)"}${note(unknown)}`;
      }
      case "push": case "channel":
        return this.runSyncAction(action, rule, e, match, cause);
      case "spawn": {
        const { text: prompt, unknown } = renderTemplate(action.spec.prompt, ctx);
        const spec: HookSpawnSpec = {
          prompt, cwd: action.spec.cwd ?? this.deps.defaultCwd(), model: action.spec.model,
          permissionProfile: action.spec.permissionProfile, deliverTo: action.spec.deliverTo ?? null, cause,
        };
        const membership = action.spec.team && action.spec.role ? { team: action.spec.team, role: action.spec.role } : undefined;
        // A rule can set `team` without `role` (or vice versa) since HookActionSchema declares
        // them independently optional — that's a misconfiguration (membership needs both), not
        // a silent no-op: surface it in the firing audit rather than spawning a detached agent
        // with no diagnostic (code review finding, pre-HOOK-4-land).
        const partialMembership = (action.spec.team && !action.spec.role) || (!action.spec.team && action.spec.role)
          ? ` (spawn spec has team/role set independently — membership needs both; spawned with no team membership)` : "";
        const rec = await this.deps.spawnAgent(spec, membership);
        return `spawned ${rec.agentId}${note(unknown)}${partialMembership}`;
      }
      case "run": {
        const { text: command, unknown } = renderTemplate(action.command, ctx);
        const [program, args] = splitCommand(command);
        const exec = this.deps.gateExec ?? defaultGateExec;
        const env: Record<string, string> = {
          CHIMERA_HOOK_RULE: rule.name, CHIMERA_HOOK_TOPIC: rule.on,
          CHIMERA_HOOK_EVENT_SEQ: String(e.seq), CHIMERA_HOOK_CHAIN: String(cause.chain),
          CHIMERA_HOOK_PAYLOAD: JSON.stringify(match.payload).slice(0, 4000),
        };
        const res = await exec(program, args, action.cwd ?? this.deps.defaultCwd(), env, action.timeoutSec * 1000);
        if (!res.ok) throw new Error(res.message || `"${command}" exited non-zero`);
        return `${res.message}${note(unknown)}`;
      }
    }
  }

  // "<agentId>" | "@conductor" | "@team:<team>[/<role>]"
  private resolveNotifyTargets(to: string, e: NormalizedEvent, match: TopicMatch): string[] {
    if (to === "@conductor") {
      const anchor = match.subjectKind === "agent" && match.subjectId ? match.subjectId
        : match.subjectKind === "task" && match.subjectId ? this.deps.getTaskAgentId(match.subjectId)
        : e.agentId;
      const resolved = anchor ? this.deps.resolveTreeAgent(anchor) : null;
      return resolved ? [resolved] : [];
    }
    if (to.startsWith("@team:")) {
      const [team, role] = to.slice("@team:".length).split("/");
      if (!team) return [];
      return this.deps.membersOf(team, role).map((m) => m.agentId);
    }
    return [to];
  }
}
