import type { AgentDelivery } from "@chimera/protocol";
import { deliveryContent, withMessageInput } from "../message-delivery.js";
import { Codex } from "@openai/codex-sdk";
import { fileURLToPath } from "node:url";
import type {
  AgentBackend, AgentHandle, BackendCapabilities, BackendEvent, DialogDecider, EventSink,
  PermissionDecider, ResolvedAgentSpec, Image, ContentBlock,
} from "../backend.js";
import { ensureWorkdir } from "../workdir.js";
import { chimeraHome } from "../paths.js";
import { boundToolResultText, toolResultText } from "./tool-result.js";
import { toolResultImageFields, withoutRawImages } from "./tool-result-images.js";
import { findProvider } from "../providers/catalog.js";
import { InterruptibleTurnLoop } from "../backend-kit.js";
import { TurnController } from "../turn-controller.js";
import { computeCostUsd, type ModelMetadataLookup, type CodexContextLimits } from "@chimera/protocol";
import { validateJsonSchemaLite } from "../json-schema-lite.js";
import { prepareCodexInput, type CodexInput, type CodexTurnInput } from "./codex-input.js";
import { resolveCodexBinary, validateCodexModel } from "../providers/codex-cli-models.js";
import { CodexSessionUsage, codexUsage, codexUsageDelta } from "./codex-session-usage.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "./codex-app-server.js";
import type { RpcProcessFactory } from "./codex-rpc.js";

// Plain-node launcher (Phase 1 Task 16 rationale): resolvable from ANY cwd — the codex CLI spawns
// its MCP servers from arbitrary working directories, where a `--import tsx` specifier would not
// resolve. Same launcher the claude backend uses (Phase 1 Task 17 parity).
const MCP_BIN = fileURLToPath(new URL("../../../mcp/bin/chimera-mcp.js", import.meta.url));

// CODEX-COMPACTION-GAP (investigated 2026-07-20, finding: NO gap -- parity, not a hole): unlike
// generic.ts's hand-rolled tool loop (backends/compaction.ts, TOKEN-OPT-P3), this backend
// deliberately has no chimera-side context compaction or thread-rotation. Verified by disassembling
// the actual codex CLI binary (`strings` on the compiled Rust release, v0.144.5): the codex core
// protocol (codex_protocol crate) ships its own native auto-compaction -- config fields
// `model_context_window` / `model_auto_compact_token_limit` (+ `_scope`), a `ContextCompaction`
// ThreadItem/ResponseItem variant, a `ClientRequest::ThreadCompactStart` op, and a
// `ContextCompactedNotification` -- plus a literal in-context system message shown to the model:
// "Your context window is nearly exhausted (only {n_remaining} tokens remaining) and will be
// automatically reset for you soon." This fires automatically inside the `codex exec` subprocess
// the SDK's Thread wraps, well before context grows unbounded -- the same posture as the Claude
// Agent SDK's own internal compaction, which claude.ts likewise never reimplements. codex-sdk's
// public Thread surface (startThread/resumeThread/runStreamed/run, verified against
// dist/index.d.ts) exposes no knob for it and doesn't need to: it's on by default, config-only
// (`-c model_auto_compact_token_limit=...`) to tune. App-server additionally exposes
// thread/compact/start; native contextCompaction items drive Chimera's compaction
// UI without replacing the provider's summarization or rotating its thread.
export type CodexThreadEvent = { type: string; [k: string]: unknown };
export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(input: CodexInput, opts?: { signal?: AbortSignal; outputSchema?: unknown }): Promise<{ events: AsyncIterable<CodexThreadEvent> }>;
  steer?(input: CodexInput): Promise<boolean>;
}
export interface CodexLike {
  close?(): void;
  startThread(options?: Record<string, unknown>): CodexThreadLike;
  // Kept for seam completeness (capabilities.supportsResume; PM decision, resolved). Nothing calls it
  // in Phase 4 — in-process Thread objects persist across turns; daemon-restart reattach is out of
  // scope v1. It is one line mirroring the real SDK surface, and Phase 1's AgentRecord.sessionId
  // persistence makes it the first thing a future reattach phase calls. Recorded constraint: any
  // future resume MUST run under the SAME CODEX_HOME that ran the original turn (sessions live under it).
  resumeThread(id: string, options?: Record<string, unknown>): CodexThreadLike;
}
export type CodexFactoryOptions = { apiKey?: string; env?: Record<string, string>; config?: Record<string, unknown> };
export type CodexFactory = (opts: CodexFactoryOptions) => CodexLike;

// The real SDK matches CodexLike structurally; both casts keep @openai/codex-sdk types out of
// chimera's surface. The ARGUMENT cast is required too: under strict TS our loose
// `config?: Record<string, unknown>` is not assignable to the SDK's JSON-constrained CodexConfigObject.
// RELEASE-T1: same class of risk as claude.ts's CHIMERA_CLAUDE_CLI_PATH — codex-sdk resolves
// its vendored native `codex` binary from a sibling platform package via createRequire relative
// to its own module location, which a compiled-binary bundle (bun --compile) can't satisfy. A
// compiled deployment shipping the vendor binary alongside chimerad sets this to its path.
const defaultFactory: CodexFactory = (opts) =>
  new Codex({
    ...opts,
    codexPathOverride: resolveCodexBinary(opts.env ?? process.env),
  } as ConstructorParameters<typeof Codex>[0]) as unknown as CodexLike;

type CodexItem = { type: string; [k: string]: unknown };

// AGENT-FAILURE-REACHES-CONDUCTOR: unlike claude.ts (which owns its own child process spawn),
// this backend never touches a ChildProcess directly — @openai/codex-sdk spawns `codex exec`
// internally. Verified against its own dist/index.js: on a non-zero exit it ALREADY throws
// `Codex Exec exited with code ${n}: ${fullStderr}` — but that stderr is captured UNBOUNDED
// (its own in-memory Buffer[] concat) and just gets absorbed into a plain Error message with no
// structured exitCode/stderrTail our supervisor can key off of. This regex splits that shape back
// apart so we can (a) bound the stderr tail the same way claude.ts/kimi.ts do, and (b) surface
// exitCode as its own field — same diagnosability, without re-implementing process spawning.
const CODEX_EXIT_ERROR = /^Codex Exec exited with (code (\d+)|signal \S+): ([\s\S]*)$/;

// A leading slash command is interpreted on its own, so it can never be folded into a larger turn.
const CODEX_SLASH_INPUT = /^\/[a-z][\w-]*(?:\s|$)/i;

// `steered` marks inputs queued by an exec force-send (see handle.steer) so the run loop can fold
// everything queued up to the last of them into the single resumed turn.
type CodexLoopInput = CodexTurnInput & { steered?: true };

// Pull the inputs that must ride along with `first` out of the queue: everything up to the LAST
// force-send, in FIFO order. A force-send running as its own later turn would be downgraded to
// plain FIFO (the interrupt flag resets when the cancelled turn unwinds), and an older ordinary
// send must not run first and leave the force stuck behind it. Ordinary sends queued after the
// last force-send stay queued, and a slash command ends the fold wherever it appears.
function takeForcedFold(first: CodexLoopInput, loop: InterruptibleTurnLoop<CodexLoopInput>): CodexLoopInput {
  if (!first.preserveBlocks && CODEX_SLASH_INPUT.test(first.text.trimStart())) return first;
  const queued = loop.pending();
  let lastForced = -1;
  for (const [index, input] of queued.entries()) if (input.steered) lastForced = index;
  const folded: CodexLoopInput[] = [first];
  for (let index = 0; index <= lastForced; index++) {
    if (!queued[index]!.preserveBlocks && CODEX_SLASH_INPUT.test(queued[index]!.text.trimStart())) break;
    folded.push(loop.shift()!);
  }
  return mergeTurnInputs(folded);
}

function mergeTurnInputs(inputs: CodexLoopInput[]): CodexLoopInput {
  if (inputs.length === 1) return inputs[0]!;
  const blocks = (input: CodexTurnInput): ContentBlock[] => input.content?.length
    ? input.content
    : [{ type: "text", text: input.text }, ...(input.images ?? []).map((img) => ({ type: "image" as const, ...img }))];
  const preamble = inputs.find((input) => input.preamble)?.preamble;
  return {
    text: inputs.map((input) => input.text).join("\n\n"),
    // `content`, not `text`, is what the model reads whenever an input carried it — keep it for
    // text-only blocks too, otherwise a differing content/text pair silently collapses to `text`.
    ...(inputs.some((input) => input.content?.length || input.images?.length) ? { content: inputs.flatMap(blocks) } : {}),
    ...(preamble ? { preamble } : {}),
    ...(inputs.some(input => input.preserveBlocks) ? { preserveBlocks: true } : {}),
  };
}

export function normalizeCodexEvent(ev: CodexThreadEvent, deltas?: Map<string, string>, effectiveModel?: string, effort?: string): BackendEvent | BackendEvent[] | null {
  const result = normalizeCodexEventContent(ev, deltas, effectiveModel, effort);
  const id = (ev["item"] as CodexItem | undefined)?.["id"];
  for (const event of Array.isArray(result) ? result : result ? [result] : []) {
    event.raw = withoutRawImages(event.raw);
    if (typeof id === "string" && (event.kind === "tool_call" || event.kind === "tool_result")) {
      event.data = { ...event.data, toolId: id, toolUseId: id };
    }
  }
  return result;
}

function normalizeCodexEventContent(ev: CodexThreadEvent, deltas?: Map<string, string>, effectiveModel?: string, effort?: string): BackendEvent | BackendEvent[] | null {
  switch (ev.type) {
    case "goal.updated":
      return { kind: "status", data: { nativeGoalSummary: ev["summary"] }, raw: ev };
    case "thread.usage":
      return { kind: "usage", data: { contextOnly: true, contextUsage: ev["contextUsage"], sessionUsage: ev["sessionUsage"], ...(typeof ev["modelContextWindow"] === "number" ? { modelContextWindow: ev["modelContextWindow"] } : {}), ...(typeof ev["effectiveContextLimit"] === "number" ? { effectiveContextLimit: ev["effectiveContextLimit"] } : {}) }, raw: ev };
    case "thread.resume_fallback":
      return { kind: "status", data: { resumeFallback: "stale-session", resumedFromPause: false, previousSessionId: ev["previousThreadId"], reason: ev["reason"], contextLost: true }, raw: ev };
    case "compaction.aborted":
      return { kind: "compaction", data: { phase: "aborted", owner: "sdk", error: ev["error"] }, raw: ev };
    case "thread.started":
      // MODEL-ACTUAL-SURFACE: the Codex SDK's ThreadStartedEvent carries no model field (verified
      // against dist/index.d.ts — thread_id only) and no later event reports one either, so the
      // caller passes the best information it has: spec.model if the spawn pinned one, else the
      // catalog's codex defaultModel (an honest best-guess, not a live-confirmed serving model).
      // EFFORT: same story — spec-sourced, no live echo from the SDK.
      // Chimera's sessionId is the resumable conversation identifier. Codex resumes
      // by thread.id, NOT app-server's thread.sessionId (the session-tree root).
      return { kind: "agent_started", data: { threadId: ev["thread_id"], sessionId: ev["thread_id"], ...(effectiveModel ? { model: effectiveModel } : {}), ...(effort ? { effort } : {}) }, raw: ev };
    case "turn.started":
      // Native voice opens turns without a Chimera user_message/mailbox send.
      // The app-server supplies the turn ID so the UI can show work immediately; SDK exec has
      // none, but its turn.started is still the first authentic proof Codex picked the prompt up
      // (thread.started only proves the process spawned), so it must not be dropped.
      return { kind: "status", data: { turnStarted: true, ...(typeof ev["turnId"] === "string" ? { turnId: ev["turnId"] } : {}) }, raw: ev };
    case "tool.progress":
      return { kind: "status", data: { toolProgress: { toolId: ev["itemId"], text: boundToolResultText(String(ev["text"] ?? "")) } }, raw: ev };
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = ev["item"] as CodexItem;
      const completed = ev.type === "item.completed";
      const started = ev.type === "item.started";
      switch (item.type) {
        case "contextCompaction":
        case "context_compaction":
          return started || completed ? { kind: "compaction", data: { phase: started ? "start" : "end", owner: "sdk" }, raw: ev } : null;
        case "agent_message": {
          const id = String(item["id"] ?? "");
          if (completed) {
            deltas?.delete(id);
            return { kind: "message_complete", data: { text: item["text"] }, raw: ev };
          }
          // message_delta is INCREMENTAL by contract (Phase 3 appends), but codex item.updated
          // carries a full snapshot — emit only the new suffix since the last update for this item.
          const full = String(item["text"] ?? "");
          const prev = deltas?.get(id) ?? "";
          deltas?.set(id, full);
          const suffix = full.startsWith(prev) ? full.slice(prev.length) : full;
          if (suffix === "") return null;               // unchanged snapshot — nothing new to render
          return { kind: "message_delta", data: { text: suffix }, raw: ev };
        }
        case "reasoning":
          return completed ? { kind: "message_delta", data: { text: item["text"], channel: "reasoning" }, raw: ev } : null;
        case "command_execution":
          if (started) return { kind: "tool_call", data: { toolName: "command_execution", input: { command: item["command"] } }, raw: ev };
          if (completed) return { kind: "tool_result", data: { toolName: "command_execution", exitCode: item["exit_code"], output: item["aggregated_output"] }, raw: ev };
          return null;
        case "file_change": {
          // FileChangeItem (dist/index.d.ts): "Emitted once the patch succeeds or fails" —
          // no item.started/item.updated carries this item type, so unlike command_execution
          // there is no separate start edge to hang a tool_call on. Synthesize BOTH the
          // tool_call and its tool_result from this single completed event so the transcript
          // shows the tool as done (✓) instead of stuck running forever with no result.
          if (started && item["nativeLifecycle"] === true) return { kind: "tool_call", data: { toolName: "file_change", input: { changes: item["changes"], status: item["status"] } }, raw: ev };
          if (!completed) return null;
          const changes = (item["changes"] as Array<{ kind?: unknown; path?: unknown }> | undefined) ?? [];
          const summary = boundToolResultText(changes.map((c) => `${String(c.kind)} ${String(c.path)}`).join("\n"));
          return [
            ...(item["nativeLifecycle"] === true ? [] : [{ kind: "tool_call" as const, data: { toolName: "file_change", input: { changes: item["changes"], status: item["status"] } }, raw: ev }]),
            { kind: "tool_result", data: { toolName: "file_change", status: item["status"], ...(summary !== "" ? { result: summary } : {}) }, raw: ev },
          ];
        }
        case "mcp_tool_call": {
          const toolName = `mcp:${item["server"]}/${item["tool"]}`;
          if (started) return { kind: "tool_call", data: { toolName, input: item["arguments"] }, raw: ev };
          if (completed) {
            // WD Stage 1 (coverage B4): the codex SDK's McpToolCallItem carries the MCP
            // result payload (`result.content: ContentBlock[]`) on success and
            // `error.message` on failure — surface whichever exists as the bounded
            // `data.result` the ui-state reducer folds onto TranscriptItem.result.
            // Conditional spread: an entry with neither keeps the historical
            // { toolName, status } data byte-identical. (command_execution's output
            // already rides `data.output`, unchanged — the reducer's fold reads it as
            // the fallback, so that event's locked shape stays untouched.)
            const text = toolResultText((item["result"] as { content?: unknown } | undefined)?.content);
            const errMsg = (item["error"] as { message?: unknown } | undefined)?.message;
            const result = text !== "" ? text : typeof errMsg === "string" && errMsg !== "" ? boundToolResultText(errMsg) : undefined;
            return { kind: "tool_result", data: { toolName, status: item["status"], ...(result !== undefined ? { result } : {}), ...toolResultImageFields((item["result"] as { content?: unknown } | undefined)?.content) }, raw: ev };
          }
          return null;
        }
        case "web_search":
          // WebSearchItem (dist/index.d.ts) has the same single-shot lifecycle as file_change
          // above ("Completes when results are returned to the agent" — no started/updated
          // edge carries this item type) and no result payload of its own, so pair the
          // tool_call with an immediate tool_result to avoid the same stuck-running bug.
          if (started && item["nativeLifecycle"] === true) return { kind: "tool_call", data: { toolName: "web_search", input: { query: item["query"], action: item["action"] } }, raw: ev };
          return completed
            ? [
                ...(item["nativeLifecycle"] === true ? [] : [{ kind: "tool_call" as const, data: { toolName: "web_search", input: { query: item["query"] } }, raw: ev }]),
                { kind: "tool_result", data: { toolName: "web_search" }, raw: ev },
              ]
            : null;
        case "imageGeneration": {
          const toolName = "image_generation";
          if (started) return { kind: "tool_call", data: { toolName, input: {} }, raw: ev };
          if (!completed) return null;
          const imageFields = toolResultImageFields([{ type: "image", data: item["result"] }]);
          return [
            ...(item["nativeLifecycle"] === true ? [] : [{ kind: "tool_call" as const, data: { toolName, input: {} }, raw: ev }]),
            { kind: "tool_result", data: { toolName, status: item["status"],
              ...(item["failure"] || item["status"] === "failed" ? { isError: true, result: "Image generation failed" } : {}),
              ...(item["status"] === "completed" && !item["failure"] ? imageFields : {}),
            }, raw: ev },
          ];
        }
        case "dynamicToolCall":
        case "imageView": {
          const toolName = item.type === "imageView" ? "view_image" : String(item["tool"] ?? "dynamic_tool");
          if (started) return { kind: "tool_call", data: { toolName, input: item["arguments"] ?? { path: item["path"] } }, raw: ev };
          return completed ? { kind: "tool_result", data: { toolName, status: item["status"], result: toolResultText(item["contentItems"]), ...toolResultImageFields(item["contentItems"]) }, raw: ev } : null;
        }
        case "todo_list":
          return completed ? { kind: "status", data: { todos: item["items"] }, raw: ev } : null;
        case "error":
          return { kind: "status", data: { itemError: item["message"] }, raw: ev };
        default:
          return { kind: "status", data: { itemType: item.type }, raw: ev };
      }
    }
    case "turn.completed":
      return { kind: "turn_complete", data: { usage: ev["usage"] }, raw: ev };
    case "turn.failed":
      return { kind: "error", data: { message: String((ev["error"] as { message?: string } | undefined)?.message ?? "codex turn failed") }, raw: ev };
    case "error":
      return { kind: "error", data: { message: String(ev["message"] ?? "codex error") }, raw: ev };
    default:
      return { kind: "status", data: { codexEvent: ev.type }, raw: ev };
  }
}

// TOKEN-OPT-P0-1: pinned SDK 0.145.0's Usage type (dist/index.d.ts) DOES carry
// cache_write_input_tokens — codex has had a cache-write concept since at least this pin,
// GPT-5.6 bills writes at a multiplier over fresh input (pricing.ts applies the rate; this
// type/toCostUsage only need to stop discarding the SDK's own number).
type Usage = {
  input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number;
  output_tokens: number; reasoning_output_tokens: number;
};
const zeroUsage = (): Usage => ({ input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
function addUsage(total: Usage, u: unknown): void {
  const usage = (u ?? {}) as Partial<Usage>;
  for (const k of Object.keys(total) as Array<keyof Usage>) total[k] += Number(usage[k] ?? 0);
}
// R2 (unified cache-aware token/ctx/cost metrics): normalizes a raw codex Usage into the
// pricing table's shape — SAME cached-subset math as ui-state's extractUsage
// (cached_input_tokens is a SUBSET of input_tokens for codex, verified against OpenAI docs),
// duplicated here rather than imported since ui-state cannot be a dependency of core (the
// reverse direction, core → protocol only, is the one this repo's package graph allows).
function toCostUsage(u: Usage): { input: number; output: number; cacheRead: number; cacheCreation: number } {
  return {
    input: Math.max(0, u.input_tokens - u.cached_input_tokens - u.cache_write_input_tokens),
    output: u.output_tokens,
    cacheRead: u.cached_input_tokens,
    cacheCreation: u.cache_write_input_tokens,
  };
}

const SANDBOX_BY_PROFILE: Record<ResolvedAgentSpec["permissionProfile"], string> = {
  readOnly: "read-only",
  acceptEdits: "workspace-write",
  full: "danger-full-access",
};

// SAFE-2 DEFER-ASSERT: Codex 0.145 only exposes MCP schemas through tool_search when BOTH
// model_info.supports_search_tool and provider.capabilities.namespace_tools are true. Pin the
// built-in OpenAI provider (whose namespace_tools capability is true) and reject any model that
// cannot resolve to one of the search-capable entries in the SDK version pinned by this package.
// Codex resolves versioned/legacy suffixes by longest prefix, hence the `${slug}-...` allowance.
const CODEX_MODEL_PROVIDER = "openai";
// SAFE-3 CODEX-KNOBS: match Chimera's existing ~16k-character transcript bound at the
// provider source (Codex converts this token ceiling through each model's truncation policy).
export const CODEX_TOOL_OUTPUT_TOKEN_LIMIT = 4_000;
// SDK-ADOPTION #3: hardcoded config defaults, same shape/precedent as CODEX_TOOL_OUTPUT_TOKEN_LIMIT
// above — a token-spend lever independent of `effort`, not exposed as a per-spec override (no
// operator-visible use case identified for tuning these per-agent; promote to a spec field if one
// shows up). Confirmed live against the actual pinned codex binary (0.147.0) via `codex doctor -c
// model_verbosity=low -c model_reasoning_summary=none --json` — config.load reports "ok" (doctor
// DOES hard-fail with "config could not be loaded" on a bogus value, confirmed separately, so this
// is a real accept, not doctor being permissive). "low" directly shrinks Codex's own output token
// count on every turn; "none" suppresses reasoning-summary tokens chimera doesn't surface anyway.
const CODEX_MODEL_VERBOSITY = "low";
const CODEX_MODEL_REASONING_SUMMARY = "none";
const CODEX_SEARCH_TOOL_MODELS = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gpt-5.4",
  "gpt-5.2",
  "codex-auto-review",
] as const;

function codexModelSupportsToolSearch(model: string): boolean {
  return CODEX_SEARCH_TOOL_MODELS.some((slug) => model === slug || model.startsWith(`${slug}-`));
}

export function assertCodexToolDeferral(
  factoryOptions: CodexFactoryOptions,
  threadOptions: Record<string, unknown>,
): void {
  const provider = factoryOptions.config?.["model_provider"];
  const model = threadOptions["model"];
  if (
    provider !== CODEX_MODEL_PROVIDER
    || typeof model !== "string"
    || !codexModelSupportsToolSearch(model)
  ) {
    throw new Error(
      `Codex tool-schema deferral is inactive: expected provider=${CODEX_MODEL_PROVIDER} `
      + `and a search-capable model, received provider=${String(provider)} model=${String(model)}`,
    );
  }
}

export function buildCodexOptions(spec: ResolvedAgentSpec): CodexFactoryOptions {
  if (spec.contextWindow != null && (!Number.isSafeInteger(spec.contextWindow) || spec.contextWindow <= 0)) {
    throw new Error("Codex contextWindow must be a positive safe integer");
  }
  // The SDK does NOT inherit process.env when env is provided (verified JSDoc on CodexOptions.env
  // in @openai/codex-sdk: "the SDK will not inherit variables from process.env") — merge it explicitly.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, spec.env);                       // credential + CODEX_HOME + CHIMERA_* win
  const apiKey = spec.env["OPENAI_API_KEY"] ?? spec.env["CODEX_API_KEY"];

  const servers: Record<string, unknown> = { ...spec.mcpServers };
  if (spec.orchestration.allow) {
    // Grant parity with the claude backend (Phase 1 Task 17): plain-node launcher + depth,
    // the PARENT's max-depth cap (no depth-cap escape via codex), the tree id (Phase 2 stamps
    // CHIMERA_TREE_ID into the launch env; forwarded when present so recursive codex spawns
    // stay under the tree budget ceiling), and a RESOLVED home (never empty string).
    servers["chimera"] = {
      command: process.execPath, args: [MCP_BIN],
      // Codex's 60s default is shorter than Chimera's 300s question/wait window.
      tool_timeout_sec: 3_600,
      env: {
        // WORKER-TEAM-CONTEXT fix: this block had drifted from claude.ts's — it never forwarded
        // CHIMERA_AGENT_ID (so ask_human/memory-author/queue pushedBy/etc misattribute for every
        // codex team worker) nor CHIMERA_TEAM (so my_team always saw {team:null}). Both are plain
        // spec fields/spec.env already computed upstream; this was a copy gap, not a design choice.
        CHIMERA_AGENT_ID: spec.agentId,                           // spec §17.4: ask_human uses this to address agent.ask
        CHIMERA_DEPTH: String(spec.depth),
        CHIMERA_MAX_DEPTH: String(spec.orchestration.maxDepth),   // parent's cap; the MCP forwards it as maxDepthCap
        CHIMERA_TREE_ID: spec.env["CHIMERA_TREE_ID"] ?? "",       // "" until Phase 2 lands its launch-env stamp
        CHIMERA_TEAM: spec.env["CHIMERA_TEAM"] ?? "",
        CHIMERA_HOME: process.env.CHIMERA_HOME ?? chimeraHome(),  // NEVER "": empty string is not nullish for ??
        // AGENT-AUTONOMY: mirrors claude.ts's identical grant — see its comment for why.
        CHIMERA_AUTONOMY: spec.autonomy === "full" ? "full" : "",
        CHIMERA_CONDUCTOR: spec.conductor ? "1" : "",
      },
    };
  }
  const mcpServers: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(servers)) {
    const srv = s as {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      enabled_tools?: string[];
      disabled_tools?: string[];
      type?: string;
      url?: string;
      headers?: Record<string, string>;
      http_headers?: Record<string, string>;
      env_http_headers?: Record<string, string>;
      bearer_token_env_var?: string;
      cwd?: string;
      env_vars?: string[];
      enabled?: boolean;
      startup_timeout_sec?: number;
      tool_timeout_sec?: number;
    };
    if (!srv || srv.type === "sse" || (!srv.command && !srv.url)) {
      throw new Error(`Codex MCP server "${name}" requires a stdio command or Streamable HTTP url; legacy SSE is unsupported`);
    }
    const specEnabledTools = spec.mcpToolAllowlist?.[name];
    // W2-4 precedence is deliberately fail-closed:
    //   no spec map              -> preserve configured enabled_tools byte-for-byte;
    //   listed server            -> intersection(spec, configured), or spec alone if config is open;
    //   unlisted server in a map -> [] (the spec map is a closed-world per-agent grant).
    // Configured disabled_tools is always forwarded too, so it remains the final deny and a role
    // can never use this field to broaden an operator's server-level grant.
    const enabledTools = spec.mcpToolAllowlist === undefined
      ? srv.enabled_tools
      : specEnabledTools === undefined
        ? []
        : srv.enabled_tools === undefined
          ? specEnabledTools
          : specEnabledTools.filter((tool) => srv.enabled_tools!.includes(tool));
    mcpServers[name] = {
      ...(srv.command ? {
        command: srv.command,
        ...(srv.args ? { args: srv.args } : {}),
        ...(srv.env ? { env: srv.env } : {}),
        ...(srv.cwd ? { cwd: srv.cwd } : {}),
        ...(srv.env_vars ? { env_vars: srv.env_vars } : {}),
      } : {
        url: srv.url,
        ...(srv.http_headers || srv.headers ? { http_headers: srv.http_headers ?? srv.headers } : {}),
        ...(srv.env_http_headers ? { env_http_headers: srv.env_http_headers } : {}),
        ...(srv.bearer_token_env_var ? { bearer_token_env_var: srv.bearer_token_env_var } : {}),
      }),
      ...(srv.enabled !== undefined ? { enabled: srv.enabled } : {}),
      ...(srv.startup_timeout_sec !== undefined ? { startup_timeout_sec: srv.startup_timeout_sec } : {}),
      ...(srv.tool_timeout_sec !== undefined ? { tool_timeout_sec: srv.tool_timeout_sec } : {}),
      // SAFE-3: preserve even an empty enabled_tools list — [] intentionally allows no tools.
      ...(enabledTools !== undefined ? { enabled_tools: enabledTools } : {}),
      ...(srv.disabled_tools !== undefined ? { disabled_tools: srv.disabled_tools } : {}),
      // MCP-STARTUP-RACE: codex does NOT synchronize turn 1 with MCP startup. The first provider
      // request's tool surface is a snapshot of whichever servers happened to finish
      // initialize + tools/list by then (~0.5-1s after spawn), so a server whose process boots
      // slowly is silently absent from turn 1 — and with it the whole enabled_tools grant chimera
      // just computed above. `required` makes codex block session creation on the handshake
      // instead, which is the only knob that does so (startup_timeout_sec alone merely bounds that
      // wait once required is set; codex's default bound is >11s). Measured identical on the
      // pinned 0.152.0 and on 0.147.0/0.150.1, so this is inherent codex behavior, not a version
      // regression. The tradeoff is deliberate and loud: an MCP server that fails to initialize
      // now hard-fails the agent ("required MCP servers failed to initialize") rather than
      // producing an agent that quietly cannot see the tools it was configured with.
      // Gated on the grant: a server this agent was allowed NO tools from (enabled_tools: []) has
      // nothing to race for, so its boot failure must not take the agent down with it — the
      // fail-closed allowlist above already made it inert.
      required: enabledTools === undefined || enabledTools.length > 0,
    };
  }
  // COMPACTION-THRESHOLD-CONFIG: codex's auto-compaction is entirely native/in-binary (see the
  // CODEX-COMPACTION-GAP writeup above). The compaction target is separate from the nominal
  // model_context_window override; never derive one from the other. The CLI's documented
  // `-c model_auto_compact_token_limit=<tokens>` config override, threaded here exactly like
  // mcp_servers above. Unset ⇒ omitted entirely, so codex keeps its own default/native trigger.
  const configOverrides: Record<string, unknown> = {
    // Agent-local opt-in. Also override an ambient account-wide enable so ordinary
    // agents never acquire realtime just because they share a CODEX_HOME.
    "features.realtime_conversation": spec.providerOptions["codexRealtime"] === true,
    ...(spec.instructions !== undefined ? { developer_instructions: spec.instructions } : {}),
    // SAFE-2: command-line config overrides outrank ambient CODEX_HOME config, so a user's
    // model_provider setting cannot silently select a provider with namespace_tools=false.
    model_provider: CODEX_MODEL_PROVIDER,
    // SAFE-3: hard provider-side ceiling, applied before tool output becomes model history.
    tool_output_token_limit: CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
    // SDK-ADOPTION #3: see the constants' own doc comment above for the live-verification note.
    model_verbosity: CODEX_MODEL_VERBOSITY,
    model_reasoning_summary: CODEX_MODEL_REASONING_SUMMARY,
    ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}),
    ...(spec.contextWindow != null ? { model_context_window: spec.contextWindow } : {}),
    ...(spec.compactionThreshold !== undefined ? { model_auto_compact_token_limit: spec.compactionThreshold, model_auto_compact_token_limit_scope: "total" } : {}),
  };
  return {
    ...(apiKey ? { apiKey } : {}),
    env,
    config: configOverrides,
  };
}

export function codexTransportFor(spec: ResolvedAgentSpec): "exec" | "app-server" {
  const transport = spec.providerOptions["codexTransport"] ?? (spec.permissionProfile === "full" ? "exec" : "app-server");
  if (transport !== "exec" && transport !== "app-server") throw new Error("codexTransport must be exec or app-server");
  return transport;
}

export function buildThreadOptions(spec: ResolvedAgentSpec, cwd: string): Record<string, unknown> {
  // Always pass an explicit model. Leaving it absent lets ambient CLI config select an unknown
  // model whose fallback metadata has supports_search_tool=false.
  const model = spec.model ?? findProvider("codex")?.defaultModel;
  return {
    workingDirectory: cwd,
    skipGitRepoCheck: true,               // chimera owns isolation (ensureWorkdir); codex's own repo check is redundant
    sandboxMode: SANDBOX_BY_PROFILE[spec.permissionProfile],
    approvalPolicy: spec.permissionProfile === "full" || codexTransportFor(spec) === "exec" ? "never" : "on-request",
    // EFFORT: chimera's neutral enum is a literal subset of codex's own ModelReasoningEffort
    // ("minimal"|"low"|"medium"|"high"|"xhigh") — direct passthrough, no mapping.
    ...(spec.effort ? { modelReasoningEffort: spec.effort } : {}),
    ...spec.providerOptions,              // provider-exact escape hatch wins (spec §5)
    // Older in-memory specs may contain model:undefined after a settings change.
    // Only a defined override may replace the explicit model/default.
    model: spec.providerOptions.model !== undefined ? spec.providerOptions.model : model,
  };
}

export class CodexAgentBackend implements AgentBackend {
  readonly provider = "codex";
  readonly capabilities: BackendCapabilities = { supportsResume: true, supportsMcpServers: true, supportsSettingSources: false, supportsVoiceRealtime: true };
  // DYNAMIC-MODEL-METADATA: lazy `modelCatalog` accessor (see ClaudeAgentBackend) — routes the
  // authoritative run cost through catalog pricing when a model is outside protocol's hardcoded map.
  constructor(private deps: { codexFactory?: CodexFactory; appServerProcess?: RpcProcessFactory; interruptGraceMs?: number; modelCatalog?: () => ModelMetadataLookup | undefined; validateModel?: typeof validateCodexModel } = {}) {}

  // Exec enforces permissions at the sandbox level; the opt-in app-server also
  // routes native approvals/dialogs and steering. Neither exposes Claude's
  // per-tool canUseTool hook, so the supervisor's full-access risk gate remains.
  spawn(spec: ResolvedAgentSpec, sink: EventSink, _decidePermission: PermissionDecider, _decideDialog?: DialogDecider): AgentHandle {
    const transport = codexTransportFor(spec);
    if (spec.plugins.length || spec.strictMcpConfig) throw new Error("Codex does not support Claude plugins/strictMcpConfig fields; configure native Codex plugins and MCP grants instead");
    const { workdir: cwd } = ensureWorkdir(spec);
    const factoryOptions = buildCodexOptions(spec);
    const threadOptions = buildThreadOptions(spec, cwd);
    if (transport === "app-server") threadOptions["developerInstructions"] = spec.instructions;
    // Injected SDK fakes retain deterministic validation; real sessions consult
    // the same configured binary used for execution, including future models.
    if (this.deps.codexFactory && !this.deps.validateModel) assertCodexToolDeferral(factoryOptions, threadOptions);
    const codex = transport === "app-server"
      ? new CodexAppServer(factoryOptions, _decidePermission, _decideDialog, this.deps.appServerProcess, spec.autonomy === "full", spec.permissionProfile === "full" && spec.acknowledgeCodexFullAccessRisk && threadOptions.approvalPolicy === "never" && threadOptions.sandboxMode === "danger-full-access")
      : (this.deps.codexFactory ?? defaultFactory)(factoryOptions);
    const thread = spec.resume
      ? codex.resumeThread(spec.resume, threadOptions)
      : codex.startThread(threadOptions);

    // Include providerOptions overrides in telemetry and pricing. These are the
    // requested effective settings; the SDK does not echo the actual serving model.
    const effectiveModel = threadOptions["model"] as string | undefined;
    const effectiveEffort = threadOptions["modelReasoningEffort"] as string | undefined;

    const loop = new InterruptibleTurnLoop<CodexLoopInput>({ graceMs: this.deps.interruptGraceMs });
    // Session instructions use Codex's developer channel on both transports and
    // resume paths. They must never become part of an operator/peer's task body.
    if (!spec.resumeOnly) loop.push({ text: spec.prompt,
      content: spec.initialDelivery ? deliveryContent(spec.prompt, undefined, spec.content, spec.initialDelivery) : spec.content,
      ...(spec.initialDelivery ? { preserveBlocks: true } : {}),
    });

    const keepAlive = spec.conductor || spec.persistent;
    // R2-TURN-LIFECYCLE: stream-idle + hard max-duration watchdog over the runStreamed() call
    // below. Undefined idleTimeoutMs/maxTurnDurationMs (the default) ⇒ fully inert. Heartbeat
    // fires on EVERY raw SDK event (before normalizeCodexEvent's null-filter) -- a legitimately
    // slow-but-active tool call (e.g. command_execution still emitting progress) keeps resetting
    // idle; only true silence on the wire trips it. See SPIKE §17.4 above: an ask_human-style
    // tool that gets exactly one item.started then goes silent until item.completed is still
    // vulnerable to a configured idleTimeoutMs tighter than the human's response time -- leave
    // it unset (the default) for specs that expect long human-in-the-loop waits.
    const turnCtl = new TurnController({ idleTimeoutMs: spec.idleTimeoutMs, maxDurationMs: spec.maxTurnDurationMs });
    let failed = false;
    let executingTurn = false;
    let execTurnStarted = false;
    let interruptForSteer = false;
    let readyForSteer = Promise.resolve();
    const steerCleanups = new Set<() => void>();
    const cleanSteeredInputs = () => { for (const cleanup of steerCleanups) cleanup(); steerCleanups.clear(); };
    let contextLimits: CodexContextLimits = { source: "codex", ...(spec.contextWindow != null ? { requestedWindow: spec.contextWindow } : {}), ...(spec.compactionThreshold ? { compactAt: spec.compactionThreshold } : {}) };
    let lastText = "";
    let turnOutcome: "completed" | "interrupted" | undefined;
    let resultBeforeTurn: { text: string; outcome: "completed" | "interrupted" | undefined } | undefined;
    let turns = 0;
    let turnBudgetSignaled = false;   // SOFT-TURN-LIMIT: fires once, mirrors claude.ts
    // Exec reports cumulative SESSION usage (including resumed history), whereas
    // app-server supplies turn deltas. Neither is the current context snapshot.
    const cumulativeUsage = zeroUsage();
    let lastTurnUsage: Usage | null = null;
    let execBaseline: Usage | null = spec.resume ? null : zeroUsage();
    let telemetry: CodexSessionUsage | undefined;
    let telemetryId: string | undefined;
    let nextTelemetryRead = 0;
    const telemetrySince = Date.now();
    const readTelemetry = async (id: string, force = false): Promise<void> => {
      if (transport !== "exec" || !/^[0-9a-f-]{36}$/i.test(id)) return;
      if (telemetryId !== id) {
        telemetryId = id;
        telemetry = new CodexSessionUsage(factoryOptions.env?.CODEX_HOME ?? join(homedir(), ".codex"), id, telemetrySince);
      }
      if (!force && Date.now() < nextTelemetryRead) return;
      nextTelemetryRead = Date.now() + 1_000;
      const sample = await telemetry!.read(force);
      if (loop.killed) return;
      lastTurnUsage = sample.context;
      if (execBaseline === null && sample.total) execBaseline = sample.total;
      for (let i = 0; i < sample.compactions; i++) sink({ kind: "compaction", data: { phase: "end", owner: "sdk" } });
      if (sample.window) contextLimits = { ...contextLimits, sessionWindow: sample.window };
      sink({ kind: "usage", data: { contextOnly: true, contextUsage: sample.context, sessionUsage: sample.total, contextLimits,
        ...(sample.window ? { modelContextWindow: sample.window, effectiveContextLimit: Math.min(spec.compactionThreshold ?? sample.window, sample.window) } : {}) } });
    };
    const deltas = new Map<string, string>();   // per-item last emitted agent_message text (message_delta contract)

    const emitRaw = (raw: CodexThreadEvent): void => {
      if (loop.killed) return;
      if (typeof raw.modelContextWindow === "number" && Number.isFinite(raw.modelContextWindow) && raw.modelContextWindow > 0) {
        contextLimits = { ...contextLimits, sessionWindow: raw.modelContextWindow };
      }
      if (raw.type === "turn.started") {
        // Native/voice turns bypass the queued input loop. Each real turn owns
        // its answer/outcome; maintenance is only identified at completion.
        resultBeforeTurn = { text: lastText, outcome: turnOutcome };
        lastText = "";
        turnOutcome = undefined;
        deltas.clear();
        execTurnStarted = transport === "exec";
        // A force-send can arrive before exec has established its rollout. Wait
        // for turn.started so the original prompt survives the resumed turn.
        if (interruptForSteer && execTurnStarted) loop.interrupt();
      }
      turnCtl.heartbeat();
      const normalized = normalizeCodexEvent(raw, deltas, effectiveModel, effectiveEffort);
      for (const ev of !normalized ? [] : Array.isArray(normalized) ? normalized : [normalized]) {
        if (ev.kind === "usage") ev.data = { ...ev.data, contextLimits };
        if (ev.kind === "agent_started") ev.data = { ...ev.data, codexTransport: transport, nativeApprovals: transport === "app-server", nativeDialogs: transport === "app-server" && spec.autonomy !== "full", supportsSteer: transport === "app-server", ...(transport === "app-server" ? { nativeVoice: spec.providerOptions["codexRealtime"] === true } : {}) };
        // Explicit commentary is progress, not a final response. Exec versions
        // without phase metadata still identify their response by item completion.
        if (ev.kind === "message_complete" && (raw.item as Record<string, unknown> | undefined)?.phase !== "commentary") lastText = String(ev.data["text"] ?? "");
        if (ev.kind === "turn_complete") {
          if (raw["maintenance"] === true) {
            if (resultBeforeTurn) {
              lastText = resultBeforeTurn.text;
              turnOutcome = resultBeforeTurn.outcome;
            }
          } else turnOutcome = raw.interrupted === true ? "interrupted" : "completed";
          resultBeforeTurn = undefined;
          cleanSteeredInputs();
          executingTurn = false;
          execTurnStarted = false;
          const reported = codexUsage(raw["usage"]) ?? zeroUsage();
          if (transport === "exec") {
            if (execBaseline) addUsage(cumulativeUsage, codexUsageDelta(reported, execBaseline));
            execBaseline = reported;
          } else {
            addUsage(cumulativeUsage, reported);
            lastTurnUsage = codexUsage(raw["contextUsage"]);
          }
          ev.data = { ...ev.data, billableUsage: { ...cumulativeUsage },
            contextUsage: lastTurnUsage ? { ...lastTurnUsage } : null, contextUsageSource: transport === "exec" ? "rollout" : "app-server",
            costUsd: computeCostUsd(toCostUsage(cumulativeUsage), effectiveModel, this.deps.modelCatalog?.()) ?? 0,
            costEstimated: true, ...(raw.interrupted === true ? { interrupted: true } : {}) };
        }
        if (ev.kind === "error") failed = true;
        sink(ev);
        if (ev.kind === "turn_complete" && raw["maintenance"] !== true) {
          turns++;
          if (turns >= spec.maxTurns) {
            if (spec.turnLimitPolicy !== "soft") {
              loop.close();
              if (codex instanceof CodexAppServer) void codex.nativeVoice.stop().catch(() => {});
            } else if (!turnBudgetSignaled) {
              turnBudgetSignaled = true;
              sink({ kind: "status", data: { turnBudgetExceeded: true, turnsCompleted: turns, turnBudget: spec.maxTurns } });
            }
          }
        }
      }
    };
    if (codex instanceof CodexAppServer) codex.onBackgroundEvent = emitRaw;
    if (codex instanceof CodexAppServer) codex.onRemoteControl = status => {
      if (!loop.killed) sink({ kind: "status", data: { remoteControl: { agentId: spec.agentId, provider: "codex", enabled: status.connectionStatus !== "disabled", ...status } } });
    };

    const run = async () => {
      try {
        if (transport === "exec" && spec.resume) await readTelemetry(spec.resume, true);
        // maxTurns enforced chimera-side (no codex equivalent). SOFT-TURN-LIMIT:
        // under "soft" the loop never stops on turn count — only killed/queue-empty
        // end it — so turns crossing spec.maxTurns just fires the budget signal below.
        while (!loop.killed && (spec.turnLimitPolicy === "soft" || turns < spec.maxTurns)) {
          let prompt: CodexLoopInput | undefined = loop.shift();
          if (prompt === undefined && loop.armed) {
            prompt = await loop.waitForNext();
            if (loop.killed) return;                    // kill landed during the grace — never start another turn
          }
          if (prompt === undefined && keepAlive && !loop.closed) {
            prompt = await loop.waitForInput();
            if (loop.killed) return;
          }
          if (prompt === undefined) break;              // idle turn boundary → finish (one-shot semantics, Phase 1 parity)
          prompt = takeForcedFold(prompt, loop);
          // A later interrupted or empty turn must never inherit an earlier answer.
          lastText = "";
          turnOutcome = undefined;
          resultBeforeTurn = undefined;
          let markReady!: () => void;
          readyForSteer = new Promise<void>((resolve) => { markReady = resolve; });
          const controller = loop.beginTurn();
          executingTurn = true;
          execTurnStarted = false;
          turnCtl.beginTurn(() => controller.abort());
          let prepared: ReturnType<typeof prepareCodexInput> | undefined;
          try {
            try {
              if (!this.deps.codexFactory || this.deps.validateModel) {
                const catalogLimits = await (this.deps.validateModel ?? validateCodexModel)(effectiveModel, effectiveEffort, !!prompt.images?.length || !!prompt.content?.some((b) => b.type === "image"), factoryOptions.env ?? process.env);
                if (loop.killed) return;
                if (spec.contextWindow != null) {
                  const max = catalogLimits?.maxWindow;
                  if (!max) throw new Error("Codex contextWindow requires a live model maximum; capacity is unknown");
                  if (spec.contextWindow > max) throw new Error(`Codex contextWindow ${spec.contextWindow} exceeds model ${effectiveModel} maximum ${max}`);
                }
                if (catalogLimits) {
                  contextLimits = { ...catalogLimits, ...(spec.contextWindow != null ? { requestedWindow: spec.contextWindow } : {}), ...(contextLimits.sessionWindow ? { sessionWindow: contextLimits.sessionWindow } : {}), ...(spec.compactionThreshold ? { compactAt: spec.compactionThreshold } : {}) };
                  sink({ kind: "usage", data: { contextOnly: true, model: effectiveModel, contextLimits } });
                }
                controller.signal.throwIfAborted();
              }
              prepared = prepareCodexInput(prompt);
              const { events } = await thread.runStreamed(prepared.input, {
                signal: controller.signal,
                // W2-1 STRUCTURED-RETURNS: verified against pinned SDK 0.145.0's dist/index.d.ts —
                // TurnOptions.outputSchema is "JSON schema describing the expected agent output",
                // passed once per turn (not once per thread, unlike claude's Options.outputFormat).
                // Unlike Claude's SDK, Codex does NOT itself validate/retry against it — the
                // AgentMessageItem's own doc comment says its `text` is "Either natural-language
                // text or JSON when structured output is requested", nothing stronger. SDK-ADOPTION
                // #4 closed the resulting asymmetry: the run-end block below now checks parsed JSON
                // against resultSchema via json-schema-lite.ts's bounded structural validator (not
                // a full JSON-Schema implementation — see that file's own doc comment for scope).
                ...(spec.resultSchema ? { outputSchema: spec.resultSchema } : {}),
              });
              markReady();
              for await (const raw of events) {
                if (loop.killed) return;
                // Drain the cancelled SDK invocation to process exit before a
                // resume can reopen its rollout. Do not treat cancellation output
                // as an agent failure or close the iterator early.
                if (interruptForSteer && controller.signal.aborted) continue;
                const id = typeof raw["thread_id"] === "string" ? raw["thread_id"] : thread.id;
                if (transport === "exec" && id && raw.type !== "thread.started") await readTelemetry(id, raw.type === "turn.completed");
                emitRaw(raw);
                if (transport === "exec" && id && raw.type === "thread.started") await readTelemetry(id, true);
                if (failed) return;
              }
              // The SDK iterator closes only after exec exits and flushes its rollout.
              if (transport === "exec" && thread.id) await readTelemetry(thread.id, true);
              // Some iterators finish cleanly on cancellation instead of throwing.
              if (interruptForSteer) controller.signal.throwIfAborted();
            } catch (turnErr) {
              if (loop.killed) return;
              const timeoutReason = turnCtl.consumeTimeout();
              if (timeoutReason) {
                sink({ kind: "turn_timeout", data: { reason: timeoutReason, elapsedMs: turnCtl.elapsedMs, idleTimeoutMs: spec.idleTimeoutMs, maxTurnDurationMs: spec.maxTurnDurationMs } });
                return;
              }
              if (loop.consumeInterrupt()) {
                turnOutcome = "interrupted";
                sink({ kind: "turn_complete", data: { interrupted: true, ...(interruptForSteer ? { steering: true } : {}) } });
                continue;                                // agent stays alive; next mailbox message starts a new turn
              }
              throw turnErr;
            }
          } finally {
            markReady();
            executingTurn = false;
            execTurnStarted = false;
            interruptForSteer = false;
            prepared?.cleanup();
            cleanSteeredInputs();
            turnCtl.endTurn();
          }
        }
        if (!loop.killed && !failed) {
          // A drained iterator/grace window is a process boundary, not proof that
          // the requested work completed. The supervisor and jobs trust result.
          if (turnOutcome !== "completed") {
            sink({ kind: "error", data: {
              message: turnOutcome === "interrupted" ? "Codex turn interrupted before a final result"
                : "Codex event stream ended without a completed turn",
              phase: "codex-turn-incomplete", ...(turnOutcome === "interrupted" ? { interrupted: true } : {}),
            } });
            return;
          }
          // W2-1 STRUCTURED-RETURNS / SDK-ADOPTION #4: an unparseable result, OR one that parses
          // but fails json-schema-lite's structural check against resultSchema (wrong types,
          // missing required fields — the asymmetry with Claude's self-validating outputFormat
          // path), is an error, never a "result" carrying a value the caller expects to already
          // conform to resultSchema.
          let structuredOutput: unknown;
          let structuredOutputFailed = false;
          let structuredOutputErrors: string[] = [];
          if (spec.resultSchema) {
            try {
              structuredOutput = JSON.parse(lastText);
              structuredOutputErrors = validateJsonSchemaLite(structuredOutput, spec.resultSchema);
              if (structuredOutputErrors.length > 0) structuredOutputFailed = true;
            } catch {
              structuredOutputFailed = true;
            }
          }
          if (structuredOutputFailed) {
            const detail = structuredOutputErrors.length > 0
              ? `: ${structuredOutputErrors.slice(0, 3).join("; ")}`
              : " (codex response was not valid JSON)";
            sink({ kind: "error", data: { message: `structured output validation failed against resultSchema${detail}` } });
          } else {
            // Cost is for newly consumed tokens in this run; context is the latest request.
            const costUsd = computeCostUsd(toCostUsage(cumulativeUsage), effectiveModel, this.deps.modelCatalog?.()) ?? 0;
            // P0-2 MODEL-ATTR: stamp the RESOLVED model (MODEL-ACTUAL-SURFACE's effectiveModel,
            // same value already used for cost above) on the terminal result, mirroring claude.ts.
            // TOKEN-OPT-P0-1: emit BOTH scopes explicitly on the terminal result — billableUsage
            // (cumulativeUsage, the SAME totals costUsd was computed over) for cost/ledger
            // accounting, contextUsage (latest request, or unknown) for the ctx-window meter.
            // The old single `usage: lastTurnUsage` field paired a whole-run cost with a
            // last-request token snapshot in the ledger — a scope mismatch, never conflate again.
            sink({
              kind: "result",
              data: {
                text: lastText, costUsd, costEstimated: true,   // F50: table-derived, never provider-reported
                ...(effectiveModel ? { model: effectiveModel } : {}),
                billableUsage: { ...cumulativeUsage }, contextUsage: lastTurnUsage ? { ...lastTurnUsage } : null, contextUsageSource: transport === "exec" ? "rollout" : "app-server",
                ...(structuredOutput !== undefined ? { structuredOutput } : {}),
              },
            });
          }
        }
      } catch (err) {
        if (!loop.killed) {
          // A non-Error rejection (a thrown string / plain object) has no `.message`, so the
          // blind cast used to emit `message: undefined` -- which supervisor.onError then
          // reports as the content-free "unknown error". Same hole QA closed in generic.ts:395;
          // terminal.ts:90's `?? String(err)` is the existing precedent for the fallback.
          const raw = err instanceof Error ? err.message : String(err);
          const m = CODEX_EXIT_ERROR.exec(raw);
          if (raw.startsWith("Failed to parse item: ")) {
            // SDK JSON.parse failures include raw command/input text. Keep diagnostics
            // bounded and content-free, and let the supervisor resume the saved session.
            sink({ kind: "error", data: {
              message: "Codex event stream contained an incomplete or invalid JSON frame",
              phase: "codex-exec-jsonl",
              frameBytes: Buffer.byteLength(raw.slice("Failed to parse item: ".length), "utf8"),
            } });
          } else if (m) {
            // Bounded tail (not the unbounded blob codex-sdk itself buffered) — mirrors
            // claude.ts/kimi.ts's 4000-char cap so a noisy process can't bloat the durable
            // event/mailbox logs.
            const tail = m[3]!.slice(-4000).trim();
            sink({
              kind: "error",
              data: {
                message: `Codex Exec exited with ${m[1]}${tail ? `: ${tail}` : ""}`,
                ...(m[2] !== undefined ? { exitCode: Number(m[2]) } : {}),
                ...(tail ? { stderrTail: tail } : {}),
              },
            });
          } else {
            sink({ kind: "error", data: { message: raw } });
          }
        }
      } finally {
        // LATE-MESSAGE-RESUME: run() has left its loop for good — unlike claude.ts's AsyncQueue,
        // the kit's queue has no closed state of its own, so without this a send() arriving after
        // this point would silently push into an array nothing will ever drain again.
        loop.end();
        codex.close?.();
      }
    };
    void run();

    return withMessageInput({
      get processPid() { return codex instanceof CodexAppServer ? codex.processPid : null; },
      ...(codex instanceof CodexAppServer ? { command: (text: string) => codex.command(text) } : {}),
      isTurnActive: () => executingTurn || codex instanceof CodexAppServer && codex.isTurnActive(),
      ...(codex instanceof CodexAppServer ? { compact: () => codex.compact(), compactOwner: "sdk" as const, remoteControl: (enable: boolean) => codex.remoteControl(enable) } : {}),
      ...(codex instanceof CodexAppServer && codex.realtimeEnabled ? { nativeVoice: codex.nativeVoice } : {}),
      send: async (text: string, images?: Image[], content?: ContentBlock[], delivery?: AgentDelivery) => {
        if (loop.ended || loop.closed) throw new Error("input stream closed");
        loop.push({ text, images, content: delivery ? deliveryContent(text, images, content, delivery) : content, ...((delivery || content?.length) ? { preserveBlocks: true } : {}) });
      },
      interrupt: async () => { loop.interrupt(); if (codex instanceof CodexAppServer) await codex.interruptActiveTurn(); },
      kill: async () => { loop.kill(); codex.close?.(); },
      close: async () => { loop.close(); },
      steer: async (text: string, images?: Image[], content?: ContentBlock[], delivery?: AgentDelivery) => {
        if (delivery) content = deliveryContent(text, images, content, delivery);
        if (loop.ended || loop.closed) throw new Error("input stream closed");
        if (thread.steer) {
          // turn/start may still be in flight when the operator force-sends.
          await readyForSteer;
          if (loop.ended || loop.closed) throw new Error("input stream closed");
          const prepared = prepareCodexInput({ text, images, content, preserveBlocks: !!delivery || !!content?.length });
          try {
            if (!await thread.steer(prepared.input)) {
              prepared.cleanup();
              if (loop.ended || loop.closed) throw new Error("input stream closed");
              loop.push({ text, images, content, ...((delivery || content?.length) ? { preserveBlocks: true } : {}) });
            } else if (executingTurn || codex instanceof CodexAppServer && codex.isTurnActive()) {
              // Codex may read an accepted image at its next inference step.
              steerCleanups.add(prepared.cleanup);
            } else prepared.cleanup();
          } catch (error) { prepared.cleanup(); throw error; }
          return;
        }
        // SDK exec has no live input channel. Queue first, then interrupt the
        // active invocation; the same Thread resumes its rollout with this input.
        // Ordinary send() remains FIFO and never interrupts a running turn.
        loop.push({ text, images, content, preserveBlocks: !!delivery || !!content?.length, steered: true });
        if (executingTurn) {
          interruptForSteer = true;
          if (execTurnStarted) loop.interrupt();
        }
      },
    });
  }
}
