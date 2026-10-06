import type { AgentDelivery } from "@chimera/protocol";
import { deliveryContent, requireTextContent, withMessageInput } from "../message-delivery.js";
import { randomUUID } from "node:crypto";
import type {
  AgentBackend, AgentHandle, BackendCapabilities, ChimeraEngineAccessor, EventSink,
  PermissionDecider, ResolvedAgentSpec, ContentBlock, Image,
} from "../backend.js";
import { ensureWorkdir } from "../workdir.js";
import { GENERIC_TOOL_DEFS, MUTATING_TOOLS, executeGenericTool } from "./generic-tools.js";
import { McpHost, buildMcpServerSpecs } from "./generic-mcp.js";
import { charBudgetForTokenThreshold, compactMessagesDetailed, resolveCompactionBudget, type CompactionReport } from "./compaction.js";
import { InterruptibleTurnLoop } from "../backend-kit.js";
import { TurnController } from "../turn-controller.js";
import { computeCostUsd, type CompactResult, type ModelMetadataLookup } from "@chimera/protocol";
import { validateJsonSchemaLite } from "../json-schema-lite.js";

// TOKEN-OPT-P3: a sane output cap so a runaway completion can't balloon a single round-trip
// (and, transitively, every future round-trip that re-sends it as history). providers/
// openai-compat.ts's `max_tokens` field and gemini-native.ts's `maxOutputTokens` both already
// consume ChatRequest.maxTokens -- this was the only caller that never populated it.
// TRUNCATION-SURFACE (observed 2026-09-02, glm5/zai-coding/glm-5.2): 8192 was NOT "generous
// enough" in practice -- a real turn hit it mid tool-call-JSON (usage.output_tokens===8192
// exactly), the provider reported that as a clean finish, and the agent's task silently landed
// "done" with an empty result. Raised as a blunter backstop against the same failure recurring
// for another low-ceiling model; the real fix is finishReason "length" detection below (never
// trust a cap hit as a clean stop) plus modelCatalog.maxOutputTokens() when a real per-model
// ceiling is known (see spawn()'s maxOutputTokens resolution).
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

// INPROC-CHIMERA-BRIDGE: the default when no real engine is wired (bare unit-construction of
// GenericAgentBackend outside the daemon). Only ever reached if a spec both grants
// orchestration.allow AND this backend was built without an engine accessor — every REAL
// caller (providers/registry.ts, wired from daemon/src/main.ts) always supplies one.
const NO_ENGINE_ACCESSOR: ChimeraEngineAccessor = {
  get(): never {
    throw new Error("GenericAgentBackend: orchestration.allow requires an engine accessor, none was wired");
  },
};

// ---------- ChatClient (F23-0B seam) ----------
// PLACEHOLDER TYPE: F23-0B (openai-compat ChatClient) is being built in parallel and owns the
// real transport (SSE parsing, fragmented tool-call-delta assembly, usage extraction). This is
// a local stand-in so 0C isn't blocked on it — align the two at merge. The contract assumed
// here: `stream()` yields incremental text as it arrives, then exactly one terminal
// `message_complete` per round-trip carrying the FULLY ASSEMBLED tool calls (if any) with
// complete JSON-string arguments (0B's job is reassembling OpenAI's per-token argument
// fragments into that single string before this type ever sees it).
// PROVIDER-META: mirrors openai-compat.ts's ChatToolCall.providerMeta — round-tripped verbatim
// through history so a provider-native driver (e.g. gemini-native.ts's thoughtSignature) can
// replay it unchanged; provider-agnostic code here never reads or mutates it.
export type ChatToolCall = { id: string; name: string; arguments: string; providerMeta?: Record<string, unknown> };
export type ChatUsage = { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; contentBlocks?: ContentBlock[] }
  | { role: "assistant"; content: string | null; toolCalls?: ChatToolCall[]; providerItems?: Record<string, unknown>[] }
  | { role: "tool"; toolCallId: string; content: string };
export type ChatToolDef = { name: string; description: string; parameters: Record<string, unknown> };
export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  // MODEL-ACTUAL-SURFACE: `model` is the wire response's own served-model field (when the
  // provider echoes one back), forwarded on the backend's message_complete BackendEvent so
  // the reducer's existing MODEL-LIVE fold (packages/ui-state/src/reducer.ts) picks it up
  // unchanged — same field the claude backend already forwards.
  // TRUNCATION-SURFACE: forwarded verbatim from the wire's finish_reason so the loop below can
  // tell "the model stopped on its own" from "the provider cut it off mid-generation" — a
  // truncated turn (esp. mid tool-call-JSON) must never silently read as a clean, resumable
  // finish. Absent when the ChatClient never reports one (e.g. the compat client's non-stream
  // fallback prior to F23-1D, or a future ChatClient that doesn't surface it).
  | { type: "message_complete"; content: string | null; toolCalls?: ChatToolCall[]; providerItems?: Record<string, unknown>[]; model?: string; finishReason?: "stop" | "tool_calls" | "length" | "content_filter" | "error" }
  | { type: "usage"; usage: ChatUsage }
  | { type: "error"; message: string };
export interface ChatStreamRequest {
  messages: ChatMessage[];
  tools: ChatToolDef[];
  model?: string;
  signal?: AbortSignal;
  // GENERIC-SPAWN-CREDENTIAL: this spawn's resolved credential (spec.env[envVar]), threaded
  // through so two accounts of the same provider each use their own key instead of sharing
  // whatever key the backend was constructed with. accountName is carried only so the
  // ChatClient can name the account in a "no credential resolved" error.
  apiKey?: string;
  accountName?: string;
  maxTokens?: number;
  effort?: ResolvedAgentSpec["effort"];
  resultSchema?: Record<string, unknown>;
  openaiApi?: unknown;
}
export interface ChatClient {
  stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent>;
}

// Safety net unique to this backend: unlike claude.ts/codex.ts (which wrap an agentic SDK that
// runs its own bounded tool loop), GenericAgentBackend drives the tool-call round-trip itself,
// so a single "turn" from the caller's perspective can require many LLM calls in a row. Each
// round-trip (final-text OR tool-call) consumes one unit of spec.maxTurns under turnLimitPolicy
// "fail" — this is what stops a model that never stops calling tools, exactly the failure mode
// unique to a hand-rolled loop.
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw === "" ? "{}" : raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// R2 (ctx meter, generic/openai-compat): ChatUsage is camelCase ({inputTokens, outputTokens}) —
// converts to the canonical SNAKE_CASE wire shape ui-state's extractUsage actually reads
// (input_tokens/output_tokens, mirroring codex.ts's own snake_case Usage type). Without this
// conversion extractUsage's `u["input_tokens"]` lookup silently misses every field and every
// generic/openai-compat agent's tokens/ctx% reads 0, always — verified by grepping every
// inputTokens/input_tokens site in backends/*.ts + providers/*.ts + ui-state's reducer.ts; nothing
// else in the pipeline translates one shape into the other. No cached_input_tokens/
// cache_read_input_tokens key at all: ChatUsage has no cache concept (openai-compat.ts reports no
// cache breakdown today), so extractUsage correctly takes its claude-shaped branch (input passed
// through unchanged, nothing to subtract) — cacheRead/cacheCreation simply stay 0 for this provider.
function toWireUsage(u: ChatUsage): Record<string, number> {
  return { input_tokens: u.inputTokens ?? 0, output_tokens: u.outputTokens ?? 0, ...(u.cachedInputTokens !== undefined ? { cached_input_tokens: u.cachedInputTokens } : {}) };
}

export class GenericAgentBackend implements AgentBackend {
  readonly capabilities: BackendCapabilities = { supportsResume: false, supportsMcpServers: true, supportsSettingSources: false, supportsVoiceRealtime: false };
  // opts.vision defaults true so existing 2-arg callers/tests are unaffected; FAZ-1 drivers for
  // text-only APIs (deepseek, groq, ...) pass `{ vision: false }` from the catalog's
  // capabilities.vision via registry.ts. engine defaults to NO_ENGINE_ACCESSOR so every
  // existing 2/3-arg caller that never grants orchestration.allow is unaffected too.
  // opts.envVar (GENERIC-SPAWN-CREDENTIAL): the catalog profile's envVar, i.e. the key under
  // which supervisor.ts's launch() stashes this spawn's resolved credential in
  // ResolvedAgentSpec.env — absent for callers that never resolve a per-spawn credential
  // (tests, or a provider with no envVar), in which case the ChatClient falls back to its
  // construction-time key.
  // GENERIC-COST-LEDGER: `modelCatalog` mirrors claude.ts/codex.ts's own lazy accessor (see
  // registry.ts's BuildBackendsDeps) — resolved at cost time, not construction, since backends
  // are built before the Engine that owns the model-metadata service. Absent ⇒ hardcoded
  // MODEL_PRICING-only lookup, same as every existing caller that never passed a 5th arg.
  constructor(
    readonly provider: string,
    private chatClient: ChatClient,
    private opts: { vision?: boolean; envVar?: string } = {},
    private engine: ChimeraEngineAccessor = NO_ENGINE_ACCESSOR,
    private modelCatalog?: () => ModelMetadataLookup | undefined,
  ) {}

  validateInput(content: ContentBlock[]): void { if (this.opts.vision === false) requireTextContent(content); }

  spawn(spec: ResolvedAgentSpec, sink: EventSink, decidePermission: PermissionDecider): AgentHandle {
    // Reject unsupported images before starting a provider request.
    if (this.opts.vision === false && spec.content?.some((b) => b.type === "image")) {
      sink({ kind: "agent_started", data: {} });
      sink({ kind: "error", data: { message: `provider "${this.provider}" does not support image input (text-only API)` } });
      return { send: async () => {}, interrupt: async () => {}, kill: async () => {} };
    }

    const { workdir: cwd } = ensureWorkdir(spec);
    const userMessage = (text: string, images?: Image[], content?: ContentBlock[]): Extract<ChatMessage, { role: "user" }> => {
      const blocks = content?.length ? content : images?.length
        ? [{ type: "text" as const, text }, ...images.map((img) => ({ type: "image" as const, ...img }))]
        : undefined;
      if (this.opts.vision === false && blocks?.some((b) => b.type === "image")) {
        throw new Error(`provider "${this.provider}" does not support image input (text-only API)`);
      }
      return { role: "user", content: blocks ? blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n") : text, ...(blocks ? { contentBlocks: blocks } : {}) };
    };

    const messages: ChatMessage[] = [];
    if (spec.instructions) messages.push({ role: "system", content: spec.instructions });
    if (!spec.resumeOnly) messages.push(userMessage(spec.prompt, undefined, spec.initialDelivery ? deliveryContent(spec.prompt, undefined, spec.content, spec.initialDelivery) : spec.content));

    const loop = new InterruptibleTurnLoop<Extract<ChatMessage, { role: "user" }>>();
    const keepAlive = spec.conductor || spec.persistent;
    // R2-TURN-LIFECYCLE: stream-idle + hard max-duration watchdog over the chatClient.stream()
    // call below. Undefined idleTimeoutMs/maxTurnDurationMs (the default) ⇒ fully inert.
    const turnCtl = new TurnController({ idleTimeoutMs: spec.idleTimeoutMs, maxDurationMs: spec.maxTurnDurationMs });
    let failed = false;
    let lastText = "";
    let structuredOutput: unknown;
    let turns = 0;
    let turnBudgetSignaled = false;
    // COMPACTION-OBSERVABILITY (manual trigger): true only while a round-trip's HTTP request is
    // actually in flight (set right after loop.beginTurn(), cleared in the same finally that
    // ends turnCtl) -- messages[] is otherwise only ever touched between turns (see TOKEN-OPT-P3
    // above), so this is the one window a manual compact() call must NOT mutate it in. Instead it
    // sets pendingManualCompact and the next round-trip boundary (the same top-of-loop check that
    // already runs compaction every turn) applies it as a forced pass.
    let turnInFlight = false;
    let pendingManualCompact = false;
    // R2 (ctx meter, generic/openai-compat): a PER-TURN snapshot, reset at the top of every loop
    // iteration (mirrors codex.ts's lastTurnUsage, and openai-compat.ts's own `usage = chunkUsage`
    // latest-wins-within-a-turn behavior this reads from) — NOT accumulated across turns. The
    // provider's own usage.promptTokens for a round-trip already reflects the CURRENT full request
    // (openai-compat resends the whole messages[] every call), so the last chunk within a turn is
    // the right "current context" figure; summing across turns would only ever grow and never
    // reflect compactMessages() having shrunk the context (the exact bug this replaces).
    let turnUsage: ChatUsage = {};
    // GENERIC-COST-LEDGER: unlike claude.ts/codex.ts's SDK-reported CUMULATIVE session cost,
    // this backend resends the full messages[] on every round-trip (see turnUsage's own comment
    // above) — each turn is its own separately-billed API call, so cost must be SUMMED across
    // turns rather than read as a last-turn snapshot. computeCostUsd returns null for a model
    // with no pricing row (hardcoded or catalog) — treated as 0, same as this backend's prior
    // unconditional costUsd:0 for every such model.
    let costUsd = 0;

    // checkPermission: readOnly denies MUTATING host tools (bash/write_file/edit_file) OUTRIGHT
    // (this backend has no sandbox to rely on, unlike codex's sandboxMode/claude's permissionMode
    // — the profile gate has to live here). Everything else goes through the injected
    // decidePermission so the standard audit/policy/tui pipeline keeps applying, exactly like
    // every other backend.
    // MCP-FOREIGN-POLICY: a FOREIGN (non-chimera) MCP tool used to be denied outright here for
    // readOnly, but that made the host's own Claude MCP tools ungrantable. It now routes through
    // decidePermission like every non-mutating tool, so the toolPolicy gate can allow/ask/deny it
    // (a readOnly agent's foreign MCP READ becomes grantable via config or a UI prompt; on an
    // unanswered ask the flow still times out to autoDecision → deny for readOnly, so nothing is
    // relaxed silently). mcp__chimera__* still falls through to autoDecision's every-profile allow.
    const checkPermission = async (toolName: string, input: unknown): Promise<{ allow: boolean; message?: string }> => {
      if (spec.permissionProfile === "readOnly" && MUTATING_TOOLS.has(toolName)) {
        return { allow: false, message: `denied by permissionProfile "readOnly"` };
      }
      // WORKTREE-AGENT-WRITES-REACH-MAIN: decidePermission may return a string deny reason
      // instead of false — surface it verbatim; `=== true` (not truthiness) still means allow.
      const decision = await decidePermission({ requestId: randomUUID(), toolName, input });
      if (decision === true) return { allow: true };
      return { allow: false, message: typeof decision === "string" ? decision : "denied by chimera permission policy" };
    };

    // MCP-HOST-GENERIC: this backend has no agentic SDK/runtime to be the MCP client for it
    // (unlike claude.ts/codex.ts, which hand mcpServers to their own SDK) — it IS the client.
    // One host per spawn, torn down in run()'s finally so a killed/errored/finished agent never
    // leaks the child MCP server processes.
    const mcpHost = new McpHost();

    // GENERIC-SPAWN-CREDENTIAL: read once per spawn, not per turn — a resolved credential
    // never changes mid-agent-lifetime.
    const apiKey = this.opts.envVar ? spec.env[this.opts.envVar] : undefined;

    // GENERIC-COMPACTION-WINDOW: resolved once per spawn (model/catalog don't change
    // mid-agent-lifetime, mirrors apiKey above). An explicit spec.compactionThreshold always
    // wins, unchanged from before this field existed. Otherwise prefer the model's real context
    // window over the flat DEFAULT_COMPACTION_CHAR_BUDGET guess — see compaction.ts.
    const compactionBudget = spec.compactionThreshold !== undefined
      ? { charBudget: charBudgetForTokenThreshold(spec.compactionThreshold), source: "operator" as const }
      : resolveCompactionBudget(spec.model, this.modelCatalog?.());

    // TRUNCATION-SURFACE: prefer the model's real output ceiling (config override > remote
    // LiteLLM catalog) over the flat DEFAULT_MAX_OUTPUT_TOKENS guess, same layering as
    // compactionBudget above. spec.model undefined (provider default) ⇒ no catalog lookup
    // possible, falls through to the default exactly as before this field existed.
    const maxOutputTokens = (spec.model ? this.modelCatalog?.()?.maxOutputTokens?.(spec.model) : undefined)
      ?? DEFAULT_MAX_OUTPUT_TOKENS;

    // MODEL-ACTUAL-SURFACE: the last model the transport actually SERVED (message_complete's own
    // `model` field), which can differ from the requested one. Held across turns so the compaction
    // event below reports the served model rather than re-asserting the request.
    let servedModel: string | undefined;

    // COMPACTION-OBSERVABILITY: this backend OWNS compaction (unlike claude.ts/codex.ts, which
    // delegate to their SDK), so every field is exact -- messages/chars before+after, and the
    // count of whole rounds mechanically collapsed (never "summarized" -- compaction.ts's own
    // header is explicit this is NOT an LLM call).
    const emitCompactionEvent = (trigger: "budget" | "manual", report: CompactionReport) => {
      sink({
        kind: "compaction",
        data: {
          trigger, owner: "chimera", budgetSource: compactionBudget.source,
          // L1-MEASURE (F39): the same "what did this fire against" fields claude.ts's SDK
          // boundary carries, so one audit reads both backends. budgetSource is the CHAR budget's
          // provenance and stays; thresholdSource is the TOKEN threshold's rung — "operator" means
          // a chimera-managed threshold answered (spec > account > provider), anything else means
          // no chimera threshold existed and this backend fell back to the model's own window.
          thresholdInForce: spec.compactionThreshold ?? null,
          thresholdSource: compactionBudget.source === "operator" ? (spec.compactionThresholdSource ?? "spawn") : "native",
          // The SERVED model when the transport has reported one (MODEL-ACTUAL-SURFACE), else the
          // requested one — supervisor.onEvent sniffs `data.model` on every event kind, so a
          // served-model-aware backend must not regress actualModel back to the request here.
          ...((servedModel ?? spec.model) ? { model: servedModel ?? spec.model } : {}),
          provider: spec.resolvedProvider,
          // A FACT, not an estimate: this compaction is a deterministic mechanical collapse of
          // oldest history and never an LLM call (compaction.ts's header), so it costs zero. The
          // SDK-owned backends deliberately emit no costUsd — theirs is genuinely unknown.
          costUsd: 0,
          before: { messages: report.beforeMessages, chars: report.beforeChars },
          after: { messages: report.afterMessages, chars: report.afterChars },
          droppedRounds: report.droppedRounds,
        },
      });
    };

    const run = async () => {
      try {
        sink({ kind: "agent_started", data: {} });
        // GENERIC-COMPACTION-WINDOW: makes the trigger visible instead of a silent guess — an
        // operator can tell "compacting at the model's real window" (source: catalog/hardcoded)
        // from "compacting at the last-resort default" (source: default) at runtime. Only
        // emitted when a real window was actually resolved: a spawn with no modelCatalog wired
        // or an unknown model falls through to the exact same "default" behavior as before this
        // field existed, so it emits nothing new — byte-identical event stream.
        if (compactionBudget.source === "catalog" || compactionBudget.source === "hardcoded") {
          sink({ kind: "status", data: { compactionBudget: { charBudget: compactionBudget.charBudget, source: compactionBudget.source, ...(spec.model ? { model: spec.model } : {}) } } });
        }
        await mcpHost.connect(buildMcpServerSpecs(spec, this.engine));
        let awaitingUserInput = spec.resumeOnly;
        while (!loop.killed && (spec.turnLimitPolicy === "soft" || turns < spec.maxTurns)) {
          if (awaitingUserInput) {
            let next = loop.shift();
            if (next === undefined && loop.armed) {
              next = await loop.waitForNext();
              if (loop.killed) return;
            }
            if (next === undefined && keepAlive && !loop.closed) {
              next = await loop.waitForInput();
              if (loop.killed) return;
            }
            if (next === undefined) break;   // idle turn boundary → finish (one-shot semantics, parity with codex/claude)
            messages.push(next);
            awaitingUserInput = false;
          }

          // TOKEN-OPT-P3: compact BEFORE building the request, never after -- messages[] is
          // always in a consistent state here (every previous round's tool results are
          // already pushed synchronously, no async gap can see a dangling tool_call), so this
          // is the only place compaction needs to run. No-op (same reference) under budget.
          // COMPACTION-THRESHOLD-CONFIG: an operator-configured threshold (tokens) converts to
          // this module's char budget; unset ⇒ the existing DEFAULT_COMPACTION_CHAR_BUDGET,
          // byte-identical to before this field existed.
          // COMPACTION-OBSERVABILITY (manual trigger): a compact() call that landed while a
          // turn was in flight set pendingManualCompact instead of mutating messages[] directly
          // -- this is that deferred application point, forcing the check to run even under
          // budget.
          const forcedByManualTrigger = pendingManualCompact;
          pendingManualCompact = false;
          const { messages: compacted, report } = compactMessagesDetailed(messages, { charBudget: compactionBudget.charBudget, force: forcedByManualTrigger });
          if (compacted !== messages) {
            messages.splice(0, messages.length, ...compacted);
            if (report) emitCompactionEvent(forcedByManualTrigger ? "manual" : "budget", report);
          }
          turnUsage = {};   // reset for THIS turn — must not carry the previous turn's total forward

          const controller = loop.beginTurn();
          turnCtl.beginTurn(() => controller.abort());
          turnInFlight = true;
          let text = "";
          let toolCalls: ChatToolCall[] = [];
          let model: string | undefined;
          let finishReason: string | undefined;
          let providerItems: Record<string, unknown>[] | undefined;
          try {
            try {
              for await (const ev of this.chatClient.stream({ messages, tools: [...GENERIC_TOOL_DEFS, ...mcpHost.tools], model: spec.model, signal: controller.signal, apiKey, accountName: spec.accountName, maxTokens: maxOutputTokens, effort: spec.effort, resultSchema: spec.resultSchema, openaiApi: spec.providerOptions["openaiApi"] })) {
                if (loop.killed) return;
                turnCtl.heartbeat();
                if (ev.type === "text_delta") { text += ev.text; sink({ kind: "message_delta", data: { text: ev.text } }); }
                else if (ev.type === "message_complete") { text = ev.content ?? text; toolCalls = ev.toolCalls ?? []; providerItems = ev.providerItems; model = ev.model; servedModel = ev.model ?? servedModel; finishReason = ev.finishReason; }
                else if (ev.type === "usage") {
                  turnUsage = ev.usage;   // latest-wins WITHIN this turn, mirrors openai-compat.ts's own chunk fold
                } else if (ev.type === "error") { sink({ kind: "error", data: { message: ev.message } }); failed = true; return; }
              }
            } catch (streamErr) {
              if (loop.killed) return;
              const timeoutReason = turnCtl.consumeTimeout();
              if (timeoutReason) {
                sink({ kind: "turn_timeout", data: { reason: timeoutReason, elapsedMs: turnCtl.elapsedMs, idleTimeoutMs: spec.idleTimeoutMs, maxTurnDurationMs: spec.maxTurnDurationMs } });
                return;   // treat as fatal, like the ev.type === "error" branch above — no resume, no "result"
              }
              if (loop.consumeInterrupt()) {
                awaitingUserInput = true;
                sink({ kind: "turn_complete", data: { interrupted: true } });
                continue;
              }
              throw streamErr;
            }
          } finally {
            turnCtl.endTurn();
            turnInFlight = false;
          }

          turns++;
          costUsd += computeCostUsd(
            { input: Math.max(0, (turnUsage.inputTokens ?? 0) - (turnUsage.cachedInputTokens ?? 0)), output: turnUsage.outputTokens ?? 0, cacheRead: turnUsage.cachedInputTokens ?? 0, cacheCreation: 0 },
            servedModel ?? spec.model,
            this.modelCatalog?.(),
          ) ?? 0;
          if (spec.turnLimitPolicy === "soft" && !turnBudgetSignaled && turns >= spec.maxTurns) {
            turnBudgetSignaled = true;
            sink({ kind: "status", data: { turnBudgetExceeded: true, turnsCompleted: turns, turnBudget: spec.maxTurns } });
          }

          // TRUNCATION-SURFACE: finish_reason "length" means the provider cut generation off at
          // maxOutputTokens, not that the model chose to stop — possibly mid tool-call-JSON
          // (parseToolArgs would silently read a truncated argument string as `{}`, no error).
          // Either way the truncated tool calls are DROPPED, never executed.
          if (finishReason === "length") {
            const truncationMessage = `output truncated at ${maxOutputTokens} tokens (finish_reason: length) -- the model's response was cut off mid-generation`;
            // TRUNCATION-IS-TURN-LEVEL-FOR-A-LIVE-SESSION: a `kind:"error"` event is TERMINAL on
            // both sides — supervisor.onError commits failed/failover, and ui-state's reducer
            // sets state:"failed" — so a keepAlive session (a conductor, a persistent pool
            // worker) would be DESTROYED by one truncated turn out of hundreds, taking its whole
            // context with it. Truncation is a property of ONE round-trip, not of the session:
            // surface it as a turn-level system notice in the transcript (the same role:"system"
            // message_complete shape a local command's output already uses, so no reducer change
            // is needed) and stay alive for the next input. The operator sees exactly what
            // happened and can retry with a shorter ask.
            // The partial assistant text is kept in history ONLY when non-empty — a content-less
            // assistant message carrying no tool calls is rejected outright by some providers.
            if (keepAlive) {
              if (text !== "") messages.push({ role: "assistant", content: text });
              sink({ kind: "message_complete", data: { text: truncationMessage, role: "system" } });
              // `truncated` tells the scheduler's persistent-worker branch that this turn's
              // output is NOT a usable task result (it would otherwise markDone the task on a
              // half-generated turn) — see scheduler.ts's own TRUNCATION-SURFACE comment.
              sink({ kind: "turn_complete", data: { usage: toWireUsage(turnUsage), truncated: true } });
              awaitingUserInput = true;
              continue;
            }
            // One-shot: fatal, like the turn_timeout/ev.type==="error" branches above — no
            // resume, no "result" event, so a task never lands "done" on a response the model
            // never finished. There is no session left to surface a turn-level notice in.
            sink({ kind: "error", data: { message: truncationMessage } });
            failed = true;
            return;
          }

          if (toolCalls.length === 0) {
            if (finishReason === "content_filter" || finishReason === "error") throw new Error(`OpenAI/provider response did not complete successfully (${finishReason})`);
            if (spec.resultSchema) {
              let value: unknown;
              try { value = JSON.parse(text); } catch { throw new Error("structured output was not valid JSON"); }
              const validation = validateJsonSchemaLite(value, spec.resultSchema);
              if (validation.length) throw new Error(`structured output did not match resultSchema: ${validation.join("; ")}`);
              structuredOutput = value;
            }
            lastText = text;
            messages.push({ role: "assistant", content: text, ...(providerItems ? { providerItems } : {}) });
            sink({ kind: "message_complete", data: { text, ...(model ? { model } : {}) } });
            sink({ kind: "turn_complete", data: { usage: toWireUsage(turnUsage) } });
            awaitingUserInput = true;
            continue;   // next loop iteration drains the queue or idles out (one-shot semantics, parity with codex.ts)
          }

          messages.push({ role: "assistant", content: text === "" ? null : text, toolCalls, ...(providerItems ? { providerItems } : {}) });
          for (const call of toolCalls) {
            if (loop.killed) return;
            const input = parseToolArgs(call.arguments);
            sink({ kind: "tool_call", data: { toolName: call.name, input, toolUseId: call.id } });
            const decision = await checkPermission(call.name, input);
            if (!decision.allow) {
              const message = decision.message ?? "denied";
              sink({ kind: "tool_result", data: { toolName: call.name, toolUseId: call.id, result: message, isError: true } });
              messages.push({ role: "tool", toolCallId: call.id, content: message });
              continue;
            }
            const result = mcpHost.isMcpTool(call.name) ? await mcpHost.call(call.name, input) : await executeGenericTool(call.name, input, cwd);
            sink({
              kind: "tool_result",
              data: { toolName: call.name, toolUseId: call.id, result: result.text, ...(result.isError ? { isError: true } : {}) },
            });
            messages.push({ role: "tool", toolCallId: call.id, content: result.text });
          }
          // tool round-trip: loop again immediately, no new user input needed
        }
        // F50 BUDGET-COVERAGE: costUsd accumulates computeCostUsd above — a pricing-table
        // derivation, never a provider's own billing figure.
        if (!loop.killed && !failed) sink({ kind: "result", data: { text: lastText, costUsd, costEstimated: true, usage: toWireUsage(turnUsage), ...(structuredOutput !== undefined ? { structuredOutput } : {}) } });
      } catch (err) {
        // A non-Error rejection (a thrown string / plain object, which a fetch-based provider
        // path can genuinely produce) has no `.message`, so the blind cast used to emit
        // `message: undefined` -- which supervisor.onError then reports as the content-free
        // "unknown error". Same loss describeKimiError fixed for kimi; terminal.ts:90's
        // `?? String(err)` is the existing precedent for the fallback.
        if (!loop.killed) sink({ kind: "error", data: { message: err instanceof Error ? err.message : String(err) } });
      } finally {
        // LIFECYCLE: every exit path (natural end, kill, thrown error) tears down the MCP child
        // processes — nothing else in this backend owns their lifetime.
        loop.end();
        await mcpHost.close();
      }
    };
    void run();

    return withMessageInput({
      send: async (text: string, images?: Image[], content?: ContentBlock[], delivery?: AgentDelivery) => {
        if (loop.ended || loop.closed) throw new Error("input stream closed");
        loop.push(userMessage(text, images, delivery ? deliveryContent(text, images, content, delivery) : content));
      },
      interrupt: async () => { loop.interrupt(); },
      kill: async () => { loop.kill(); },
      close: async () => { loop.close(); },
      // COMPACTION-OBSERVABILITY (manual trigger): this backend OWNS compaction, so unlike
      // claude.ts/codex.ts it can actually do this. A turn in flight means messages[] must not
      // be mutated out from under the request already built off it (see turnInFlight's own
      // comment) -- queue it for the next round-trip boundary instead of racing the request.
      // Idle (no turn in flight): apply immediately, synchronously, and report the real effect.
      compact: async (): Promise<CompactResult> => {
        if (turnInFlight) {
          pendingManualCompact = true;
          return { ok: true, message: "queued — will run at the next round-trip boundary (a turn is currently in flight)" };
        }
        const { messages: compacted, report } = compactMessagesDetailed(messages, { charBudget: compactionBudget.charBudget, force: true });
        if (!report) {
          return { ok: false, message: "nothing to compact — history is already within the protected recent-rounds window" };
        }
        messages.splice(0, messages.length, ...compacted);
        emitCompactionEvent("manual", report);
        return {
          ok: true,
          before: { messages: report.beforeMessages, chars: report.beforeChars },
          after: { messages: report.afterMessages, chars: report.afterChars },
        };
      },
    });
  }
}
