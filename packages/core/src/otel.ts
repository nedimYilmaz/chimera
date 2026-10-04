import { randomBytes } from "node:crypto";
import type { NormalizedEvent, OtelConfig, OtelRedaction, SliRollupCoverage, SliRollupParams, SliRollupResult, SliStepSummary, SliTaskSummary } from "@chimera/protocol";
import type { EventLog } from "./events.js";
import { usageFromRaw } from "./budget.js";

// FEATURE-7 (OTel GenAI tracing + SLI rollup + redaction): EVENT-LOG-DRIVEN, not a new seam
// threaded through supervisor.ts/scheduler.ts. Every signal the span tree needs is already a
// NormalizedEvent on the existing EventLog stream (agent_started/tool_call/tool_result/
// turn_complete/result/error/status/task_step_advanced/task_step_failed) — this module just
// subscribes and replays them into an in-memory span tree. Zero new instrumentation call sites
// anywhere else in the codebase.

type SpanKind = "spawn" | "turn" | "tool_call" | "gate" | "task";

type AgentInfo = { parentId: string | null; treeId: string; role?: string; model?: string; provider?: string; team?: string | null };

type ChimeraSpan = {
  spanId: string; traceId: string; parentSpanId: string | null;
  kind: SpanKind; name: string;
  startedAt: number; endedAt: number | null;
  attributes: Record<string, unknown>;
  status: "unset" | "ok" | "error";
  // Rollup grouping keys, resolved at span-open time (a persistent step-role worker can span
  // multiple tasks/steps across its lifetime — re-resolving per turn, not once at spawn, is
  // what correctly attributes each turn to the right task/step).
  taskId: string | null; stepIndex: number | null;
};

function newId(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? null;
}

// Bounded-capture convention matching checkpoints.ts's 80-char command truncation / the
// backend's own bounded tool-result text — prompt/output/tool-IO attributes never grow
// unbounded in memory, regardless of redaction policy (which only decides whether the
// (already-bounded) value is scrubbed at export, not how much of it was ever captured).
const TEXT_ATTR_MAX = 500;

export function redactAttributes(attrs: Record<string, unknown>, policy: OtelRedaction): Record<string, unknown> {
  const REDACTED = "[REDACTED]";
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const isPrompt = policy.redactPrompts && key === "gen_ai.output.text";
    const isToolIO = policy.redactToolIO && (key === "gen_ai.tool.call.arguments" || key === "gen_ai.tool.call.result");
    const isExtra = policy.extraKeys.includes(key);
    out[key] = isPrompt || isToolIO || isExtra ? REDACTED : value;
  }
  return out;
}

function otlpAttributeValue(v: unknown): { stringValue: string } | { intValue: number } | { boolValue: boolean } {
  if (typeof v === "number" && Number.isInteger(v)) return { intValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  return { stringValue: v === null || v === undefined ? "" : String(v) };
}

// OTLP/HTTP JSON traces payload shape (resourceSpans/scopeSpans/spans) — hand-rolled rather
// than pulling in the @opentelemetry/* SDK: this is a control-plane trace at modest volume, and
// avoiding the dependency keeps this a protocol+core-only slice with no new package.json churn.
// Redaction is applied HERE, per span, right before serialization — this IS the "before export"
// point the brief specifies; the in-memory span store (this.finished, used by rollup()) always
// keeps the raw, unredacted attributes.
export function buildOtlpTracePayload(spans: ChimeraSpan[], config: OtelConfig): unknown {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: config.serviceName } }] },
      scopeSpans: [{
        scope: { name: "chimera" },
        spans: spans.map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: "SPAN_KIND_INTERNAL",
          startTimeUnixNano: String(span.startedAt * 1_000_000),
          endTimeUnixNano: String((span.endedAt ?? span.startedAt) * 1_000_000),
          attributes: Object.entries(redactAttributes(span.attributes, config.redaction))
            .map(([key, value]) => ({ key, value: otlpAttributeValue(value) })),
          status: { code: span.status === "error" ? 2 : span.status === "ok" ? 1 : 0 },
        })),
      }],
    }],
  };
}

export type SpanRecorderDeps = {
  events: EventLog;
  config: OtelConfig;
  // Resolves which task an AGENT's CURRENT turn belongs to — re-resolved per turn (see the
  // ChimeraSpan doc comment above), not cached from spawn time. Mirrors scheduler.ts's own
  // taskFor(agentId), already used by engine.ts's checkpointCreate seam.
  taskFor: (agentId: string) => string | null;
  // Resolves spawn-span parenting + a couple of informational attributes. Mirrors
  // SupervisorDeps.projectFor/gitBranch's "function seam, absent ⇒ unused" pattern — wired in
  // engine.ts as a try/catch around supervisor.status() (throws UnknownAgentError on a miss).
  agentInfo: (agentId: string) => AgentInfo | null;
  fetchFn?: typeof fetch;
  now?: () => number;
  // FEATURE-12 (span-store-replay-on-startup): a shadow recorder built inside replayFromLog
  // folds the retained log through the SAME onEvent reducer but must never see live traffic —
  // false makes the constructor's events.subscribe a no-op so the shadow's open-span maps
  // (taskRoots/openSpawn/openTurn/openToolCalls) can be thrown away wholesale after the fold.
  subscribe?: boolean;
};

// FEATURE-12: measured at packages/core's own EventLog.tail cost (plan section 2.1) — folding
// this many events end-to-end (shadow recorder construction + onEvent per event) is 22ms at this
// bound and 267ms at 302k events. Deliberately NOT an OtelConfig field: this is an internal
// replay-cost cap, not a policy a caller should be able to tune (a second telemetry-retention
// config knob was explicitly ruled out of scope for this task).
const REPLAY_MAX_EVENTS = 50_000;

export class SpanRecorder {
  private config: OtelConfig;
  private readonly taskFor: (agentId: string) => string | null;
  private readonly agentInfo: SpanRecorderDeps["agentInfo"];
  private readonly fetchFn: typeof fetch;
  private readonly wallClock: () => number;
  private readonly unsubscribe: () => void;
  private readonly deps: SpanRecorderDeps;
  private readonly log: EventLog;
  // Captured BEFORE subscribing: the first seq this (live) recorder's own onEvent will ever see.
  // replayFromLog only folds events with seq < liveFromSeq, so a historical span and a live span
  // can never double-count the same event.
  private readonly liveFromSeq: number;

  // FEATURE-12: event-time clock split. Live folding stamps spans with wallClock() (real time);
  // replaying a historical event stamps them with the EVENT's own ts instead, so a span replayed
  // at daemon boot doesn't get "started just now" — replayTs is set for the duration of exactly
  // one shadow-recorder onEvent call and cleared right after (see foldReplayed).
  private replayTs: number | null = null;
  private now(): number {
    return this.replayTs ?? this.wallClock();
  }

  private replayState: SliRollupCoverage | null = null;

  // FEATURE-12: set ONLY on the detached shadow recorder replayFromLog constructs — a live
  // recorder's replayIndex stays undefined, so resolveTask/resolveInfo fall straight through to
  // the live deps. Built incrementally by foldReplayed() in seq order (one event at a time, not
  // an end-of-window pass) so a persistent pool worker that serves task A then task B attributes
  // each turn to whichever task it was bound to AT THAT POINT in the log (T10) — and because it
  // lives on the shadow instance itself, the shadow's own resolveTask/resolveInfo (called from
  // its own onEvent fold) see it directly instead of reading a binding built on some other
  // recorder (T7: fresh-boot deps return null, the shadow's replayIndex is the only source left).
  private replayIndex: { taskByAgent: Map<string, string>; infoByAgent: Map<string, AgentInfo> } | undefined;

  private openSpawn = new Map<string, ChimeraSpan>();
  private openTurn = new Map<string, ChimeraSpan>();
  private openToolCalls = new Map<string, Map<string, ChimeraSpan>>();
  private taskRoots = new Map<string, ChimeraSpan>();
  private taskMeta = new Map<string, { workflow: string | null; version: number | null }>();
  private finished: ChimeraSpan[] = [];

  constructor(deps: SpanRecorderDeps) {
    this.config = deps.config;
    this.taskFor = deps.taskFor;
    this.agentInfo = deps.agentInfo;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.wallClock = deps.now ?? (() => Date.now());
    this.deps = deps;
    this.log = deps.events;
    this.liveFromSeq = deps.events.currentSeq() + 1;
    this.unsubscribe = deps.subscribe === false ? () => {} : deps.events.subscribe((e) => this.onEvent(e));
  }

  // Historical binding first: for a replayed event the log's own binding at that seq IS the
  // truth, and the live map (scheduler.tracked) is empty for every finished agent. Live is the
  // fallback, which matters for an agent that was reattached across the restart.
  private resolveTask(agentId: string): string | null {
    return this.replayIndex?.taskByAgent.get(agentId) ?? this.taskFor(agentId);
  }

  // Live first here, because a reattached agent's supervisor record is complete and current,
  // while the log entry is a snapshot from spawn time.
  private resolveInfo(agentId: string): AgentInfo | null {
    return this.agentInfo(agentId) ?? this.replayIndex?.infoByAgent.get(agentId) ?? null;
  }

  close(): void {
    this.unsubscribe();
  }

  setConfig(config: OtelConfig): void {
    // Hot-reload seam, called from engine.ts's applyConfig. Plain field assignment — every
    // in-flight span keeps whatever policy was live at EXPORT time; spans already exported
    // under the old policy are not retroactively fixed (same "next call sees it" contract
    // toolPolicy/pluginFilter already document).
    this.config = config;
  }

  private pushFinished(span: ChimeraSpan): void {
    this.finished.push(span);
    const overflow = this.finished.length - this.config.maxFinishedSpans;
    if (overflow > 0) this.finished.splice(0, overflow);
  }

  private finish(span: ChimeraSpan, status: "ok" | "error"): void {
    span.endedAt = this.now();
    span.status = status;
    this.pushFinished(span);
    this.exportSpan(span);
  }

  private exportSpan(span: ChimeraSpan): void {
    // FEATURE-12: a replayed span was already exported (or not) by the process that first saw
    // the event live — re-exporting it here on every boot would double-post it to the collector.
    if (this.replayTs !== null) return;
    if (!this.config.endpoint) return;   // no-op exporter when unconfigured — nothing breaks offline
    const payload = buildOtlpTracePayload([span], this.config);
    this.fetchFn(this.config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((err: unknown) => {
      console.warn(`chimerad: otel export failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private ensureTaskRoot(taskId: string): ChimeraSpan {
    let root = this.taskRoots.get(taskId);
    if (!root) {
      root = {
        spanId: newId(8), traceId: newId(16), parentSpanId: null,
        kind: "task", name: "chimera.task",
        startedAt: this.now(), endedAt: null,
        attributes: { "chimera.task_id": taskId },
        status: "unset",
        taskId, stepIndex: null,
      };
      this.taskRoots.set(taskId, root);
    }
    return root;
  }

  private lastStepIndexFor(taskId: string): number | null {
    // The most recently recorded gate span for this task — used to attribute an in-flight
    // turn to the step it belongs to (turn spans don't otherwise know their stepIndex).
    for (let i = this.finished.length - 1; i >= 0; i--) {
      const s = this.finished[i]!;
      if (s.kind === "gate" && s.taskId === taskId) return s.stepIndex;
    }
    return null;
  }

  private ensureTurnSpan(agentId: string): ChimeraSpan {
    let turn = this.openTurn.get(agentId);
    if (!turn) {
      const spawn = this.openSpawn.get(agentId);
      const taskId = this.resolveTask(agentId);
      const info = this.resolveInfo(agentId);
      turn = {
        spanId: newId(8), traceId: spawn?.traceId ?? newId(16), parentSpanId: spawn?.spanId ?? null,
        kind: "turn", name: "gen_ai.chat",
        startedAt: this.now(), endedAt: null,
        attributes: { "chimera.agent_id": agentId, "chimera.team": info?.team ?? null, "gen_ai.system": info?.provider ?? null },
        status: "unset",
        taskId, stepIndex: taskId ? this.lastStepIndexFor(taskId) : null,
      };
      this.openTurn.set(agentId, turn);
    }
    return turn;
  }

  private closeOpenTurn(agentId: string, status: "ok" | "error"): void {
    const turn = this.openTurn.get(agentId);
    if (!turn) return;
    this.finish(turn, status);
    this.openTurn.delete(agentId);
  }

  private closeOpenToolCalls(agentId: string): void {
    const map = this.openToolCalls.get(agentId);
    if (!map || map.size === 0) return;
    for (const span of map.values()) {
      span.attributes["chimera.orphaned"] = true;
      this.finish(span, "error");
    }
    map.clear();
  }

  // FEATURE-12: incremental attribution fold, called ONE EVENT AT A TIME on a shadow recorder
  // (see replayFromLog) — built incrementally, in seq order, so a persistent pool worker that
  // serves task A then task B attributes each turn to the task it was bound to at that point in
  // the log — exactly what the live scheduler.taskFor(agentId) (re-resolved per turn) does. A
  // single end-of-window pass would attribute every earlier turn to the last task (T10).
  private foldReplayed(e: NormalizedEvent): void {
    const idx = this.replayIndex!;
    if (e.agentId.startsWith("task:") && e.kind === "status") {
      const worker = e.data["agentId"];
      const taskId = e.data["taskId"];
      if (typeof worker === "string" && typeof taskId === "string") idx.taskByAgent.set(worker, taskId);
    } else if (e.kind === "agent_started") {
      const d = e.data as Record<string, unknown>;
      const m = d["membership"] as { team?: unknown; role?: unknown } | null | undefined;
      idx.infoByAgent.set(e.agentId, {
        parentId: typeof d["parentId"] === "string" ? d["parentId"] : null,
        treeId: typeof d["treeId"] === "string" ? d["treeId"] : e.agentId,
        role: typeof m?.role === "string" ? m.role : undefined,
        model: typeof d["model"] === "string" ? d["model"] : undefined,
        provider: typeof d["provider"] === "string" ? d["provider"] : undefined,
        team: typeof m?.team === "string" ? m.team : null,
      });
    }
    this.replayTs = e.ts;
    try {
      this.onEvent(e);
    } finally {
      this.replayTs = null;
    }
  }

  // FEATURE-12: folds the retained log's tail through a DETACHED shadow SpanRecorder (never
  // subscribed to live traffic) and merges back only its finished spans + task metadata — never
  // taskRoots/openSpawn/openTurn/openToolCalls, which belong to whichever process is live right
  // now and must not be clobbered by history. A task root still open at the end of the replayed
  // window belongs to a process that is gone; rollup() still surfaces the task from its
  // turn/gate spans, with durationMs/activeAgeMs left null rather than inventing an end time.
  // Idempotent: a second call is a no-op that returns the cached coverage from the first.
  replayFromLog(maxEvents: number = REPLAY_MAX_EVENTS): SliRollupCoverage {
    if (this.replayState) return this.replayState;
    // `truncated` must describe the TAIL BOUND, not what survived the live filter: events
    // appended between construction and warm-up (reattach/conductor/scheduler.tick all emit
    // before the daemon even listens) are folded live and dropped here, which would otherwise
    // pull raw.length below maxEvents and report a cut window as complete.
    const tail = this.log.tail(null, maxEvents);
    return this.foldTail(tail, maxEvents);
  }

  // FEATURE-12 QA fix: post-listen warm-up must not block the event loop with the synchronous
  // EventLog.tail (measured 378ms on a ~/.chimera-sized log, during which every RPC/MCP call
  // stalls). Shares foldTail with the sync path below — this is a second entry point onto the
  // same fold, not a fork of it, so a reducer change can't silently diverge between the two.
  async replayFromLogAsync(maxEvents: number = REPLAY_MAX_EVENTS): Promise<SliRollupCoverage> {
    if (this.replayState) return this.replayState;
    const tail = await this.log.tailAsync(null, maxEvents);
    return this.foldTail(tail, maxEvents);
  }

  private foldTail(tail: NormalizedEvent[], maxEvents: number): SliRollupCoverage {
    if (this.replayState) return this.replayState;
    const raw = tail.filter((e) => e.seq < this.liveFromSeq);
    const shadow = new SpanRecorder({ ...this.deps, subscribe: false });
    shadow.replayIndex = { taskByAgent: new Map(), infoByAgent: new Map() };
    for (const e of raw) shadow.foldReplayed(e);

    this.finished = [...shadow.finished, ...this.finished]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-this.config.maxFinishedSpans);
    for (const [taskId, meta] of shadow.taskMeta) {
      if (!this.taskMeta.has(taskId)) this.taskMeta.set(taskId, meta);
    }

    this.replayState = {
      replayed: true,
      events: raw.length,
      spans: shadow.finished.length,
      fromSeq: raw[0]?.seq ?? null,
      fromTs: raw[0]?.ts ?? null,
      truncated: tail.length >= maxEvents,
    };
    return this.replayState;
  }

  private onEvent(e: NormalizedEvent): void {
    // D12/FEATURE-9: task lifecycle `status` AND task_step_advanced/task_step_failed all carry
    // agentId `task:<taskId>` (queues.ts's emitTask / scheduler.ts's own step events) — one
    // namespace check routes both into the task-root/gate-span machinery below.
    if (e.agentId.startsWith("task:")) {
      this.onTaskEvent(e);
      return;
    }
    if (e.kind === "agent_started") {
      this.onAgentStarted(e);
      return;
    }
    if (e.kind === "message_delta" || e.kind === "message_complete" || e.kind === "tool_call" || e.kind === "tool_result" || e.kind === "usage") {
      const turn = this.ensureTurnSpan(e.agentId);
      if (e.kind === "message_complete" && typeof e.data["text"] === "string") {
        const prev = typeof turn.attributes["gen_ai.output.text"] === "string" ? turn.attributes["gen_ai.output.text"] as string : "";
        turn.attributes["gen_ai.output.text"] = (prev + String(e.data["text"])).slice(0, TEXT_ATTR_MAX);
      } else if (e.kind === "tool_call") {
        this.onToolCall(e, turn);
      } else if (e.kind === "tool_result") {
        this.onToolResult(e);
      } else if (e.kind === "usage") {
        this.applyUsage(turn, e.data["usage"] as Record<string, unknown> | undefined);
      }
      return;
    }
    if (e.kind === "turn_complete") {
      // A turn with no tool calls and no visible streaming (message_delta/message_complete)
      // before its turn_complete still needs a span — ensure one rather than requiring some
      // OTHER event to have opened it first.
      const turn = this.ensureTurnSpan(e.agentId);
      this.applyUsage(turn, e.data["usage"] as Record<string, unknown> | undefined);
      turn.attributes["chimera.turn_cost_usd"] = e.data["turnCostUsd"] ?? null;
      this.closeOpenTurn(e.agentId, "ok");
      return;
    }
    if (e.kind === "result" || e.kind === "error" || (e.kind === "status" && (e.data["state"] === "failed" || e.data["state"] === "killed"))) {
      this.onAgentTerminal(e);
    }
  }

  private applyUsage(turn: ChimeraSpan, raw: Record<string, unknown> | undefined): void {
    if (!raw) return;
    const usage = usageFromRaw(raw);
    turn.attributes["gen_ai.usage.input_tokens"] = usage.input;
    turn.attributes["gen_ai.usage.output_tokens"] = usage.output;
  }

  private onTaskEvent(e: NormalizedEvent): void {
    const taskId = e.data["taskId"];
    if (typeof taskId !== "string" || taskId.length === 0) return;
    const root = this.ensureTaskRoot(taskId);

    const workflow = e.data["workflow"];
    const version = e.data["version"];
    if (typeof workflow === "string" || typeof version === "number") {
      const meta = this.taskMeta.get(taskId) ?? { workflow: null, version: null };
      if (typeof workflow === "string") meta.workflow = workflow;
      if (typeof version === "number") meta.version = version;
      this.taskMeta.set(taskId, meta);
      root.attributes["workflow"] = meta.workflow;
      root.attributes["version"] = meta.version;
    }

    if (e.kind === "task_step_advanced" || e.kind === "task_step_failed") {
      const passed = e.kind === "task_step_advanced";
      const gate: ChimeraSpan = {
        spanId: newId(8), traceId: root.traceId, parentSpanId: root.spanId,
        kind: "gate", name: "chimera.gate",
        startedAt: this.now(), endedAt: this.now(),
        attributes: {
          stepId: e.data["stepId"] ?? null,
          passed,
          reason: e.data["reason"] ?? null,
          willRetry: e.data["willRetry"] ?? null,
        },
        status: passed ? "ok" : "error",
        taskId, stepIndex: typeof e.data["stepIndex"] === "number" ? e.data["stepIndex"] : null,
      };
      this.pushFinished(gate);
      this.exportSpan(gate);
      return;
    }

    // kind === "status" (task lifecycle, queues.ts's emitTask)
    const state = e.data["state"];
    if (typeof e.data["queue"] === "string") root.attributes["chimera.queue"] = e.data["queue"];
    if (state === "done" || state === "failed") {
      if (root.endedAt === null) this.finish(root, state === "done" ? "ok" : "error");
      this.taskRoots.delete(taskId);
    }
  }

  private onAgentStarted(e: NormalizedEvent): void {
    const info = this.resolveInfo(e.agentId);
    let parentSpanId: string | null = null;
    let traceId: string;
    const parentSpawn = info?.parentId ? this.openSpawn.get(info.parentId) : undefined;
    if (parentSpawn) {
      parentSpanId = parentSpawn.spanId;
      traceId = parentSpawn.traceId;
    } else {
      const taskId = this.resolveTask(e.agentId);
      const root = taskId ? this.taskRoots.get(taskId) ?? this.ensureTaskRoot(taskId) : undefined;
      if (root) {
        parentSpanId = root.spanId;
        traceId = root.traceId;
      } else {
        traceId = newId(16);
      }
    }
    const span: ChimeraSpan = {
      spanId: newId(8), traceId, parentSpanId,
      kind: "spawn", name: "gen_ai.agent",
      startedAt: this.now(), endedAt: null,
      attributes: {
        "chimera.agent_id": e.agentId,
        "chimera.role": info?.role ?? null,
        "gen_ai.request.model": info?.model ?? null,
      },
      status: "unset",
      taskId: this.resolveTask(e.agentId), stepIndex: null,
    };
    this.openSpawn.set(e.agentId, span);
  }

  private onToolCall(e: NormalizedEvent, turn: ChimeraSpan): void {
    const key = String(e.data["toolId"] ?? e.data["toolUseId"] ?? "");
    const span: ChimeraSpan = {
      spanId: newId(8), traceId: turn.traceId, parentSpanId: turn.spanId,
      kind: "tool_call", name: "gen_ai.tool.execute",
      startedAt: this.now(), endedAt: null,
      attributes: {
        "gen_ai.tool.name": e.data["toolName"] ?? null,
        "gen_ai.tool.call.id": e.data["toolId"] ?? e.data["toolUseId"] ?? null,
        "gen_ai.tool.call.arguments": JSON.stringify(e.data["input"] ?? {}).slice(0, TEXT_ATTR_MAX),
      },
      status: "unset",
      taskId: turn.taskId, stepIndex: turn.stepIndex,
    };
    const mapKey = key || span.spanId;   // id-less tool_call still gets a span, just unmatchable
    let map = this.openToolCalls.get(e.agentId);
    if (!map) { map = new Map(); this.openToolCalls.set(e.agentId, map); }
    map.set(mapKey, span);
  }

  private onToolResult(e: NormalizedEvent): void {
    const key = String(e.data["toolId"] ?? e.data["toolUseId"] ?? "");
    if (!key) return;
    const map = this.openToolCalls.get(e.agentId);
    const span = map?.get(key);
    if (!span) return;
    span.attributes["gen_ai.tool.call.result"] = String(e.data["result"] ?? "").slice(0, TEXT_ATTR_MAX);
    this.finish(span, e.data["isError"] === true ? "error" : "ok");
    map!.delete(key);
  }

  private onAgentTerminal(e: NormalizedEvent): void {
    this.closeOpenTurn(e.agentId, "error");   // no-op if already closed by turn_complete (common path)
    this.closeOpenToolCalls(e.agentId);
    const spawn = this.openSpawn.get(e.agentId);
    if (spawn) {
      this.finish(spawn, e.kind === "result" ? "ok" : "error");
      this.openSpawn.delete(e.agentId);
    }
  }

  rollup(params: SliRollupParams): SliRollupResult {
    const coverage = this.replayFromLog();
    let spans = this.finished;
    if (params.from !== undefined) spans = spans.filter((s) => s.startedAt >= params.from!);
    if (params.to !== undefined) spans = spans.filter((s) => s.startedAt < params.to!);

    // A task with an open (not-yet-terminal) root span has no FINISHED spans of its own yet
    // (the root itself only lands in `finished` once it closes) — still surface a row for it,
    // with all-zero aggregates, rather than making it invisible until something completes.
    const taskIds = new Set<string>();
    for (const s of spans) if (s.taskId) taskIds.add(s.taskId);
    for (const [taskId, root] of this.taskRoots) {
      if (params.from !== undefined && root.startedAt < params.from) continue;
      if (params.to !== undefined && root.startedAt >= params.to) continue;
      taskIds.add(taskId);
    }

    const tasks: SliTaskSummary[] = [];
    for (const taskId of taskIds) {
      if (params.taskId && taskId !== params.taskId) continue;
      const meta = this.taskMeta.get(taskId) ?? { workflow: null, version: null };
      if (params.workflow && meta.workflow !== params.workflow) continue;

      const taskSpans = spans.filter((s) => s.taskId === taskId);
      const root = taskSpans.find((s) => s.kind === "task") ?? this.taskRoots.get(taskId);
      const turns = taskSpans.filter((s) => s.kind === "turn");
      const gates = taskSpans.filter((s) => s.kind === "gate");
      // Turn-scoped only: gate failures and the task-root failure status are already
      // surfaced via gateFailures, and mixing them in here pushed errorRate past 1.0.
      const errored = turns.filter((s) => s.status === "error");

      const stepIndexes = new Set<number>();
      for (const s of taskSpans) if (s.stepIndex !== null) stepIndexes.add(s.stepIndex);
      const steps: SliStepSummary[] = [...stepIndexes].sort((a, b) => a - b).map((stepIndex) => {
        const stepSpans = taskSpans.filter((s) => s.stepIndex === stepIndex);
        const stepTurns = stepSpans.filter((s) => s.kind === "turn");
        const stepGates = stepSpans.filter((s) => s.kind === "gate");
        const stepErrors = stepTurns.filter((s) => s.status === "error");
        const stepGateWithId = stepGates.find((g) => typeof g.attributes["stepId"] === "string");
        return {
          stepIndex,
          stepId: (stepGateWithId?.attributes["stepId"] as string | undefined) ?? null,
          durationMs: envelopeDurationMs(stepSpans),
          tokensIn: sumAttr(stepTurns, "gen_ai.usage.input_tokens"),
          tokensOut: sumAttr(stepTurns, "gen_ai.usage.output_tokens"),
          costUsd: sumAttr(stepTurns, "chimera.turn_cost_usd"),
          gatePasses: stepGates.filter((g) => g.status === "ok").length,
          gateFailures: stepGates.filter((g) => g.status === "error").length,
          turnCount: stepTurns.length, errorCount: stepErrors.length,
          errorRate: stepTurns.length ? stepErrors.length / stepTurns.length : 0,
        };
      });

      const turnCount = turns.length;
      const errorCount = errored.length;
      const agentIds = [...new Set(turns.map((s) => s.attributes["chimera.agent_id"]).filter((v): v is string => typeof v === "string"))];
      const teams = [...new Set(turns.map((s) => s.attributes["chimera.team"]).filter((v): v is string => typeof v === "string"))];
      const providers = [...new Set(turns.map((s) => s.attributes["gen_ai.system"]).filter((v): v is string => typeof v === "string"))];
      const endedAt = root?.endedAt ?? null;
      // FEATURE-12: earliest-of(root, member spans), never the root alone. Replay deliberately
      // drops taskRoots, so a task that straddles a restart gets a NEW root stamped at wall-clock
      // now by the first post-restart task event — while its replayed turn spans still carry the
      // real (event-time) start. Trusting the root there reports a ~0ms duration/age for work
      // that ran for hours and poisons p50/p95. For a live task the root is always earliest, so
      // this is a no-op.
      const startedAt = Math.min(root?.startedAt ?? Infinity, ...taskSpans.map((s) => s.startedAt));
      tasks.push({
        taskId, workflow: meta.workflow, version: meta.version,
        startedAt, endedAt,
        activeAgeMs: root && endedAt === null ? Math.max(0, Math.min(this.now(), params.to ?? this.now()) - startedAt) : null,
        agentIds, team: teams.length === 1 ? teams[0]! : teams.length > 1 ? "mixed" : null,
        provider: providers.length === 1 ? providers[0]! : providers.length > 1 ? "mixed" : null,
        queue: typeof root?.attributes["chimera.queue"] === "string" ? root.attributes["chimera.queue"] as string : null,
        durationMs: root && endedAt !== null ? endedAt - startedAt : null,
        tokensIn: sumAttr(turns, "gen_ai.usage.input_tokens"),
        tokensOut: sumAttr(turns, "gen_ai.usage.output_tokens"),
        costUsd: sumAttr(turns, "chimera.turn_cost_usd"),
        gatePasses: gates.filter((g) => g.status === "ok").length,
        gateFailures: gates.filter((g) => g.status === "error").length,
        turnCount, errorCount,
        errorRate: turnCount ? errorCount / turnCount : 0,
        steps,
      });
    }

    const totals = tasks.reduce((acc, t) => ({
      durationMs: acc.durationMs + (t.durationMs ?? 0),
      tokensIn: acc.tokensIn + t.tokensIn,
      tokensOut: acc.tokensOut + t.tokensOut,
      costUsd: acc.costUsd + t.costUsd,
      gatePasses: acc.gatePasses + t.gatePasses,
      gateFailures: acc.gateFailures + t.gateFailures,
      turnCount: acc.turnCount + t.turnCount,
      errorCount: acc.errorCount + t.errorCount,
    }), { durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, gatePasses: 0, gateFailures: 0, turnCount: 0, errorCount: 0 });

    const durations = tasks.flatMap((t) => t.durationMs === null ? [] : [t.durationMs]);
    const keyFor = (t: SliTaskSummary): string => params.groupBy === "team" ? t.team ?? "unassigned"
      : params.groupBy === "provider" ? t.provider ?? "unknown" : t.workflow ?? "unbound";
    const breakdown = params.groupBy ? [...new Set(tasks.map(keyFor))].map((key) => {
      const rows = tasks.filter((t) => keyFor(t) === key);
      const ds = rows.flatMap((t) => t.durationMs === null ? [] : [t.durationMs]);
      return rows.reduce((a, t) => ({ ...a, taskCount: a.taskCount + 1,
        completedTasks: a.completedTasks + (t.durationMs === null ? 0 : 1), activeTasks: a.activeTasks + (t.durationMs === null ? 1 : 0),
        tokensIn: a.tokensIn + t.tokensIn, tokensOut: a.tokensOut + t.tokensOut, costUsd: a.costUsd + t.costUsd,
        gatePasses: a.gatePasses + t.gatePasses, gateFailures: a.gateFailures + t.gateFailures,
        turnCount: a.turnCount + t.turnCount, errorCount: a.errorCount + t.errorCount }),
      { key, taskCount: 0, completedTasks: 0, activeTasks: 0, p50DurationMs: percentile(ds, 50), p95DurationMs: percentile(ds, 95),
        tokensIn: 0, tokensOut: 0, costUsd: 0, gatePasses: 0, gateFailures: 0, turnCount: 0, errorCount: 0 });
    }) : [];
    const buckets = params.bucketMs && params.from !== undefined && params.to !== undefined
      ? Array.from({ length: Math.min(168, Math.ceil((params.to - params.from) / params.bucketMs)) }, (_, i) => {
        const from = params.from! + i * params.bucketMs!; const to = Math.min(params.to!, from + params.bucketMs!);
        const rows = tasks.filter((t) => t.startedAt >= from && t.startedAt < to);
        return rows.reduce((a, t) => ({ ...a, completedTasks: a.completedTasks + (t.durationMs === null ? 0 : 1),
          activeTasks: a.activeTasks + (t.durationMs === null ? 1 : 0), durationMs: a.durationMs + (t.durationMs ?? 0),
          latencySamples: a.latencySamples + (t.durationMs === null ? 0 : 1), tokensIn: a.tokensIn + t.tokensIn,
          tokensOut: a.tokensOut + t.tokensOut, costUsd: a.costUsd + t.costUsd, gatePasses: a.gatePasses + t.gatePasses,
          gateFailures: a.gateFailures + t.gateFailures, turnCount: a.turnCount + t.turnCount, errorCount: a.errorCount + t.errorCount }),
        { from, to, completedTasks: 0, activeTasks: 0, durationMs: 0, latencySamples: 0, tokensIn: 0, tokensOut: 0,
          costUsd: 0, gatePasses: 0, gateFailures: 0, turnCount: 0, errorCount: 0 });
      }) : [];
    return { tasks, buckets, breakdown, totals: { ...totals,
      errorRate: totals.turnCount ? totals.errorCount / totals.turnCount : 0,
      completedTasks: durations.length, activeTasks: tasks.length - durations.length, latencySamples: durations.length,
      p50DurationMs: percentile(durations, 50), p95DurationMs: percentile(durations, 95) }, coverage };
  }
}

function sumAttr(spans: ChimeraSpan[], key: string): number {
  let total = 0;
  for (const s of spans) {
    const v = s.attributes[key];
    if (typeof v === "number") total += v;
  }
  return total;
}

// Wall-clock envelope (earliest start -> latest end), NOT a sum of individual span durations —
// tool_call spans nest INSIDE their turn span, so summing raw durations would double-count the
// tool time that's already part of the turn's own span.
function envelopeDurationMs(spans: ChimeraSpan[]): number {
  const started = spans.map((s) => s.startedAt);
  const ended = spans.filter((s): s is ChimeraSpan & { endedAt: number } => s.endedAt !== null).map((s) => s.endedAt);
  if (started.length === 0 || ended.length === 0) return 0;
  return Math.max(...ended) - Math.min(...started);
}
