// KIMI-CLI-PROTOCOL: replaces S2's `@moonshot-ai/kimi-agent-sdk@0.1.8` transport, which could
// never spawn a working session against the real installed CLI at all (S0's finding:
// createSession() spawns the CLI with a bespoke `--wire`/`--work-dir` flag pair the real CLI
// (v0.29.2) doesn't recognize -- "error: unknown option '--work-dir'", confirmed live, reliably,
// on every attempt). This file now speaks the real CLI's OWN current headless protocol directly:
// `kimi acp`, a stdio Agent Client Protocol (ACP, https://agentclientprotocol.com) server --
// Zed's standardized editor<->agent wire format, via the official
// `@agentclientprotocol/sdk` TypeScript SDK (the package `@zed-industries/agent-client-protocol`
// was renamed to; its default entry still speaks PROTOCOL_VERSION 1, so the wire is unchanged —
// the v2 protocol lives behind a separate `./experimental/v2` subpath we deliberately do not use).
//
// TRANSPORT CHOICE, evidence (conductor's own live probes against the real installed CLI,
// zero-to-minimal LLM quota spent -- see the task's PHASE 1 for the full transcript):
//   - `kimi acp` genuinely works: initialize() negotiates protocolVersion 1, newSession() creates
//     a real session, and a real prompt() round trip replied "pong" verbatim to the operator's
//     connectivity-test wording, then a SECOND prompt() on the SAME session (no respawn) replied
//     "pong2" to a follow-up -- proving both a real spawn AND multi-turn on one live session.
//   - `kimi -p --output-format stream-json` was REJECTED without a live trial: the CLI's own
//     `--help` documents it as "Run ONE prompt non-interactively and print the response" -- each
//     invocation is a fresh process that exits after one reply. Chimera's contract requires
//     follow-up send() on a LIVE agent with in-band tool-approval round trips; a one-shot-per-
//     process mode cannot host that without spawning a new CLI process per turn and losing the
//     live approval loop entirely. No quota was spent confirming this since the CLI's documented
//     behavior already settles it.
//   - Pinning an older CLI version (S0's option (c)) was rejected per the task brief: the operator
//     uses `kimi` interactively themselves; downgrading their working CLI to serve chimera is not
//     an acceptable trade.
//
// WHAT THIS BUYS BEYOND PARITY (genuine upgrades over the old, never-functional SDK path):
//   - Permission-mode IS live-settable on a running session (`session/set_mode`, confirmed via a
//     live, zero-quota RPC round trip) -- unlike the old SDK's yoloMode, which S0 confirmed was
//     create-time-only (kill+respawn to change). See kimiModeFor() below.
//   - CLI-config/skills/MCP-config interop is now REAL by construction: this backend spawns the
//     operator's own `kimi` binary against the operator's own `~/.kimi-code` home (never
//     touched/redirected), so it shares the SAME config.toml, skills, and MCP server config the
//     operator's interactive CLI already uses -- no bespoke config-root plumbing needed (S0's (a)
//     REFUTED `shareDir`/`KIMI_SHARE_DIR` mechanism from the old SDK is simply gone, moot).
//     `--skills-dir`/`--add-dir` remain available (buildKimiAcpArgs, spec.providerOptions) as
//     EXPLICIT overrides for a caller that wants a non-default skill set, but are not required
//     for baseline interop.
//
// HONEST GAPS, carried into this design deliberately rather than papered over:
//   - NO TOKEN-USAGE TELEMETRY: confirmed by inspecting the full ACP schema and by the live pong
//     round trip above -- no notification or response anywhere in the protocol carries token
//     counts or cost. costUsd is therefore always 0 for kimi runs (never fabricated) until Kimi's
//     ACP surface adds one; this is a REAL capability loss versus what the old (non-functional)
//     SDK's StreamEvent.StatusUpdate.token_usage claimed to offer on paper.
//   - MCP-SERVER PASSTHROUGH (CROSS-PROVIDER-MCP-STORE), CORRECTED 2026-09-02
//     (KIMI-STDIO-MCP-UNSUPPORTED, see buildKimiMcpServers() below for the full writeup): this
//     paragraph originally claimed ACP's newSession/loadSession "genuinely accept an mcpServers
//     list", citing initialize()'s `mcpCapabilities: {http:true, sse:true}` as live confirmation.
//     That citation was a misread -- `{http, sse}` is the COMPLETE list of transports that field
//     can name; there is no `stdio` key, so the response was already saying stdio is NOT
//     supported. Reproduced live against the installed CLI (v0.37.2): every stdio mcpServers
//     entry makes session/new fail outright. buildKimiMcpServers() below still describes TWO
//     sources it WOULD wire in, but as of this correction both are withheld unconditionally
//     (stdio being the only shape either one produces) rather than sent:
//       1. chimera's OWN MCP server (bin/chimera-mcp.js, spawned as a stdio child -- the exact
//          same binary+transport claude.ts's chimera grant uses), whenever spec.orchestration.
//          allow is true. This is what makes mcp_store_tools/mcp_store_call (and every other
//          chimera-native tool) reachable from a kimi session -- previously impossible on ANY
//          provider without this wiring, since ACP never carried it at all. Per-agent IDENTITY
//          (CHIMERA_AGENT_ID/DEPTH/MAX_DEPTH/TREE_ID/TEAM/AUTONOMY env) is stamped exactly like
//          claude.ts's grant -- an operator hand-registering chimera in their own `kimi`
//          CLI's static ~/.kimi-code/mcp.json config instead of going through this path gets an
//          ANONYMOUS connection (server.ts's `process.env.CHIMERA_AGENT_ID || undefined`): no
//          agentId (ask_human/memory-author/queue-pushedBy attribution lost) and, more
//          seriously, no CHIMERA_MAX_DEPTH -- supervisor.ts's `opts.maxDepthCap ?? Infinity`
//          means the spawned agent's own self-declared orchestration.maxDepth becomes the ONLY
//          cap, unbounded by any ancestor. This file cannot prevent an operator from hand-
//          editing their own CLI config; it only guarantees ITS OWN injection is never
//          anonymous. Operators who added such an entry should remove it once this ships.
//       2. spec.mcpServers (external, per-agent-declared stdio servers) -- wired through
//          directly UNLESS spec.mcpToolAllowlist is set (even to {}), in which case EVERY
//          external server is withheld entirely (fail closed) rather than connected. Reason:
//          ACP's McpServer schema has no per-tool enabled_tools/disabled_tools equivalent, so
//          wiring a server through unfiltered while an operator configured a restrictive
//          allowlist would silently grant that server's FULL tool set -- a silent security
//          widening this file will not ship. Withholding beats partial exposure: the CLI has
//          ZERO visibility into a withheld server, a strictly stronger guarantee than filtering
//          would give even if ACP could express it. This is a real capability gap (an allowlist
//          that already worked on claude/codex now blocks the WHOLE server on kimi, not just
//          the disallowed tools) -- see buildKimiMcpServers()'s returned `notice`, surfaced to
//          both the operator (a `status` event) and, only when non-empty, the agent's own first
//          turn (one short line -- see KimiAgentBackend.spawn) so neither is left guessing why a
//          configured server never showed up.
//   - PERMISSION MAPPING: `permissionProfile:"full"` maps to ACP mode "yolo" (auto-approve tool
//     calls; the CLI's own docs say the agent "may still ask questions" -- partial suppression,
//     decidePermission stays wired for defense in depth). `autonomy:"full"` (AGENT-AUTONOMY,
//     commit 2bd084b5) ADDITIONALLY escalates to ACP mode "auto" ("fully autonomous... will not
//     ask questions") but ONLY when `permissionProfile` is ALSO "full" -- autonomy alone must
//     never bypass tool-call approval for a readOnly/acceptEdits agent; claude.ts's own
//     autonomy:"full" never bypasses canUseTool either, only native dialogs, so escalating solely
//     on autonomy here would be a Kimi-only safety regression relative to that precedent. See
//     kimiModeFor().
//   - INTERRUPT: `session/cancel` is a real request the CLI acknowledges (confirmed structurally
//     from the schema; TurnController.interrupt()'s effect on an in-flight upstream LLM call --
//     whether it truly stops billing server-side vs. merely stops the event stream -- was not
//     independently observable in a zero-quota probe, same caveat S0 raised for the old SDK).
//   - RESUME: `session/load` genuinely round-trips against the real CLI (confirmed live: an
//     unknown sessionId cleanly errors "Invalid params: Unknown sessionId: ..." rather than
//     hanging or crashing) and never calls prompt() again on attach, satisfying chimera's
//     resumeOnly contract (claude.ts's Task CR1) structurally. NOTE this also fixes a latent bug:
//     the old code's agent_started never included a `sessionId` field at all, so
//     supervisor.ts's `record.sessionId = e.data["sessionId"]` capture (supervisor.ts:1035) could
//     never have populated for kimi even if the SDK had worked. agent_started now fires AFTER the
//     real session is established (not synchronously before, unlike the old code -- see below)
//     specifically so it can carry the real ACP sessionId.
//   - agent_started timing: the old code fired this synchronously, before any live round trip,
//     because S0's finding meant a live round trip was certain to fail. That defensive posture no
//     longer applies -- the ACP handshake is a fast, reliable, local, zero-LLM-cost round trip --
//     so agent_started now fires once the real session exists (carrying its real sessionId), and
//     a connection failure instead surfaces as a clean `error` event with no agent_started, the
//     same distinguishable-failure shape claude.ts/codex.ts already have.
//
// KIMI-NATIVE-SUBAGENT-VISIBILITY: investigated whether Kimi's own sub-agent/swarm lifecycle
// (its `AgentSwarm` tool -- a parallel fan-out to N "coder" sub-agents, confirmed from the CLI's
// own tool catalog and a live capture below) can be mapped onto chimera's native `agent_task`
// event the way claude.ts's task_started/task_progress/task_updated are (packages/core/src/
// backends/claude.ts:820-847), so the UI's existing shadow-record/flowTree nesting
// (supervisor.ts's "Task N-SHADOW", ui-state's reducer.ts `agent_task` fold) could light up for
// Kimi swarms too. VERDICT: it cannot -- this is a genuine ACP protocol gap, not a chimera
// mapping bug, confirmed two ways:
//   1. SCHEMA: @agentclientprotocol/sdk's `SessionNotification.update`
//      discriminated union has exactly the 8 variants normalizeKimiEvent already switches on
//      (grepped dist/schema.d.ts for sub_agent/sub_session/swarm/nested/task_started/
//      task_progress -- zero hits). There is no sub-agent-lifecycle notification shape to map,
//      at any protocol version this client speaks.
//   2. LIVE CAPTURE (real `kube-env-status-checker` kimi agent, 2026-08-14, a real 3-way
//      `AgentSwarm` fan-out over Slack history by month -- ~/.chimera/events/events.jsonl
//      seq 680527): the ENTIRE fan-out crossed the ACP wire as ONE `tool_call` notification --
//      `title:"AgentSwarm"`, `kind:"other"`, `rawInput` ABSENT (the swarm's real args --
//      description/items/prompt_template, visible in the CLI's OWN internal wire.jsonl tool-call
//      log -- never reach the ACP wire at all), `status:"pending"` for the full duration of all
//      three sub-agents with zero intermediate tool_call_update notifications observed. No
//      per-sub-agent id, prompt, status, or partial result ever surfaces -- only the swarm's
//      single terminal tool_call_update (whenever the whole fan-out finishes) carries anything,
//      and that's a rolled-up result blob like any other tool, not a lineage the UI can nest.
// CONSEQUENCE: building a fabricated nesting tree here would misrepresent data the protocol
// simply never sends (the task brief's explicit "do not fabricate" line). What IS honest and
// additive: `normalizeKimiEvent`'s tool_call case (below) recognizes Kimi's own fan-out tool by
// name and annotates the announce event's `input` with a short operator-facing note, so the
// existing generic tool-call UI (ToolDetailCard.tsx already JSON-dumps `input` verbatim --
// selectors.ts's formatToolInput -- no new UI plumbing needed) reads "sub-agents running, not
// observable on this provider" instead of looking like a hung tool call. This is the (B)/(C)
// boundary case from the task brief: ACP gives a real (if coarse) pending/completed signal for
// the fan-out as a whole (not "nothing", so not pure (C)), but zero per-sub-agent structure to
// nest (so not (A), and nothing partial to progressively surface either, unlike a genuine (B)
// case with incremental signal). KIMI_FANOUT_TOOL_TITLES is a closed, explicit list (currently
// just "AgentSwarm") rather than a heuristic, so a future Kimi tool this file doesn't know about
// never silently gets mislabeled.
export const KIMI_FANOUT_TOOL_TITLES: ReadonlySet<string> = new Set(["AgentSwarm"]);
export const KIMI_FANOUT_NOTE =
  "Kimi reports this as a single tool call over ACP -- the sub-agents it spawns (their identity, prompts, and individual progress/results) are not observable through this protocol. This call will stay pending until the entire fan-out finishes.";

// KIMI-TOOL-EVENT-ORPHANS (later fix): Kimi tool calls rendered as permanently pending in the UI
// because no correlatable tool_result ever arrived. Root cause was TWO compounding gaps, neither
// of them "the CLI never reports results" (a raw-wire probe proved the CLI sends the full
// lifecycle: tool_call(pending) -> tool_call_update(in_progress)* -> tool_call_update(completed|
// failed) with output in content + rawOutput):
//   1. The CLI's terminal updates carry `rawOutput` as a STRING, which the ACP library's
//      sessionNotificationSchema (`rawOutput: z.record(...)`) rejects -- the library dropped
//      every terminal update before client.sessionUpdate ran. Fixed by sanitizeKimiAcpLine, a
//      line-level shim on stdout before the library parses (see its comment).
//   2. The emitted chimera tool_call/tool_result carried no correlation id in `data` (the ACP
//      toolCallId existed only in `raw`). Both now carry data.toolId, which the ui-state reducer
//      strict-matches (reducer.ts tool_result case). Additionally: a turn that settles with a
//      tool call still open (interrupt, dropped update, failed prompt) sweeps it closed with a
//      synthetic error tool_result (closeOrphanedKimiToolCalls) -- no spinner can outlive a turn.
import { ClientSideConnection, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import type {
  Client as AcpClient, McpCapabilities, McpServer as AcpMcpServer, PermissionOption, RequestPermissionRequest,
  RequestPermissionResponse, SessionConfigOption, SessionNotification, ToolCallContent,
} from "@agentclientprotocol/sdk";
import { recordProviderModels, type ModelOption } from "../providers/model-list-cache.js";
import { scrubSecretShapes } from "../configstore.js";
import { type ChildProcess, spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ModelMetadataLookup } from "@chimera/protocol";
import type {
  AgentBackend, AgentHandle, BackendCapabilities, BackendEvent, ChimeraEngineAccessor, CompactionThresholdSource,
  DialogDecider, EventSink, PermissionDecider, ResolvedAgentSpec,
} from "../backend.js";
import type { McpListenerGrant } from "../mcp-listener.js";
import { InterruptibleTurnLoop } from "../backend-kit.js";
import { chimeraHome } from "../paths.js";
import { findProvider } from "../providers/catalog.js";
import { ensureWorkdir } from "../workdir.js";
import { toolResultText } from "./tool-result.js";

// CROSS-PROVIDER-MCP-STORE: mirrors claude.ts's MCP_BIN exactly -- same relative depth
// (packages/core/src/backends -> packages/mcp/bin/chimera-mcp.js), same stdio entrypoint.
const MCP_BIN = fileURLToPath(new URL("../../../mcp/bin/chimera-mcp.js", import.meta.url));

// KIMI-PATH-TRAP (S0/S2, precedent d8387e2 "fix(core): resolve Codex quota CLI outside shell
// PATH"): unchanged from S2 -- still exactly right. `~/.kimi-code/bin` is not on a non-interactive
// shell's PATH, so a launchd-spawned chimerad would ENOENT before ever reaching the CLI. Resolve
// an ABSOLUTE path ourselves: an explicit operator override always wins, then the well-known
// location confirmed on this machine, then bare "kimi" as a last resort (an interactive dev shell
// where PATH is already correct).
export function resolveKimiCliPath(): string {
  if (process.env.CHIMERA_KIMI_CLI_PATH) return process.env.CHIMERA_KIMI_CLI_PATH;
  const wellKnown = join(homedir(), ".kimi-code", "bin", "kimi");
  if (existsSync(wellKnown)) return wellKnown;
  return "kimi";
}

function asStringArray(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

// KIMI-CLI-PROTOCOL: --model/--skills-dir/--add-dir are GLOBAL kimi options and must precede the
// `acp` subcommand (confirmed live: `kimi acp --help` only lists --login/-h -- the CLI parses
// global options before dispatching to the subcommand, not after). --skills-dir/--add-dir are
// read from spec.providerOptions (the documented escape hatch, same precedent as every other
// backend's providerOptions spread) since AgentSpec has no dedicated field for them; omitting
// them keeps the CLI's own auto-discovery (~/.kimi-code/skills + project dirs), which is already
// full interop with the operator's interactive CLI. `extraArgs` is a general-purpose escape hatch
// for any other global flag (e.g. `--agent`, `--plan`) this file doesn't special-case.
export function buildKimiAcpArgs(spec: ResolvedAgentSpec): string[] {
  const args: string[] = [];
  const model = spec.model ?? findProvider("kimi")?.defaultModel;
  if (model) args.push("--model", model);
  for (const d of asStringArray(spec.providerOptions?.["skillsDir"])) args.push("--skills-dir", d);
  for (const d of asStringArray(spec.providerOptions?.["addDir"])) args.push("--add-dir", d);
  for (const extra of asStringArray(spec.providerOptions?.["extraArgs"])) args.push(extra);
  args.push("acp");
  return args;
}

// PERMISSION MAPPING: see the module header's "PERMISSION MAPPING" paragraph for the full
// reasoning. "default" (manual approvals; decidePermission answers every real requestPermission
// call) is the floor for anything not explicitly "full".
export type KimiAcpMode = "default" | "yolo" | "auto";
// DYNAMIC-MODEL-LISTS: pull the model list out of ACP's session config options. `category:
// "model"` is the SEMANTIC key (a vendor is free to name the option id anything), with the id as
// a fallback for an agent that omits the category. Select values may arrive flat OR grouped
// (SessionConfigSelectOptions is a union of both), so both shapes are flattened. Returns [] for
// anything unrecognized -- recordProviderModels ignores an empty list rather than clobbering a
// previously-learned one, so a kimi build that stops sending this can never blank the picker.
export function kimiModelOptions(configOptions: SessionConfigOption[] | null | undefined): ModelOption[] {
  const opt = (configOptions ?? []).find((o) => o.category === "model" || o.id === "model");
  if (!opt || opt.type !== "select") return [];
  const out: ModelOption[] = [];
  for (const entry of opt.options ?? []) {
    const flat = "group" in entry ? (entry.options ?? []) : [entry];
    for (const o of flat) {
      if (typeof o?.value !== "string" || !o.value) continue;
      out.push({ value: o.value, displayName: o.name || o.value, ...(o.description ? { description: o.description } : {}) });
    }
  }
  return out;
}

// EFFORT-ONE-SOURCE: kimi publishes its reasoning tiers the SAME way it publishes its models — an
// ACP configOptions entry, here the one whose category is "thought_level". There is no static list
// to fall back on for this provider (protocol's PROVIDER_EFFORT_LEVELS.kimi is deliberately empty),
// so this IS the source: without it a kimi agent's effort picker can only offer chimera's
// provider-neutral union, which is a guess.
//
// Returns [] for anything unrecognized, on purpose — recordProviderEfforts ignores an empty list
// rather than clobbering what a previous session already learned, mirroring kimiModelOptions.
export function kimiEffortOptions(configOptions: SessionConfigOption[] | null | undefined): string[] {
  const opt = (configOptions ?? []).find((o) => o.category === "thought_level" || o.id === "thought_level");
  if (!opt || opt.type !== "select") return [];
  const out: string[] = [];
  for (const entry of opt.options ?? []) {
    // Same flatten as the model list: SessionConfigSelectOptions is a union of flat entries and
    // grouped ones, and a grouped build would otherwise report no levels at all.
    const flat = "group" in entry ? (entry.options ?? []) : [entry];
    for (const o of flat) {
      if (typeof o?.value === "string" && o.value) out.push(o.value);
    }
  }
  return out;
}

export function kimiModeFor(spec: ResolvedAgentSpec): KimiAcpMode {
  if (spec.permissionProfile !== "full") return "default";
  return spec.autonomy === "full" ? "auto" : "yolo";
}

// mapKimiPermissionOptions: chimera's three-way PermissionDecider result (true / false / a
// specific deny-reason string, backend.ts's WORKTREE-AGENT-WRITES-REACH-MAIN) onto whichever
// PermissionOption the live session actually offered. Fail-closed: a `true` decision only ever
// resolves to an "allow_once"/"allow_always"-kind option that ACTUALLY EXISTS in this request; if
// none does, this falls through to a reject-kind option rather than fabricating an allow. THE
// HONESTY GAP: like the old SDK's turn.approve(), ACP's RequestPermissionResponse carries no
// message field, so a string deny-reason has no wire-level home here either and is dropped -- the
// ALLOW/DENY decision itself is still honestly enforced, only the custom denial text is lost.
// `=== true` is deliberate: a non-empty string is truthy in JS but must still map to reject.
export function mapKimiPermissionOptions(options: PermissionOption[], decision: boolean | string): string {
  if (options.length === 0) throw new Error("kimi acp: permission request carried no options");
  if (decision === true) {
    const allow = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always");
    if (allow) return allow.optionId;
    // No allow-shaped option offered -- fall through to reject rather than fabricate one.
  }
  const reject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always");
  return (reject ?? options[0]!).optionId;
}

// The subset of SessionNotification's update variants this file maps -- kept as a type alias
// (not redeclared) so the real schema stays the single source of truth for the wire shape.
export type KimiAcpUpdate = SessionNotification["update"];
// KimiMapCtx: `toolTitles` indexes every announced ACP toolCallId -> display title (also the
// set of OPEN calls: an id enters on the first tool_call notification). `toolClosed` records
// ids whose terminal chimera tool_result has already been emitted -- the dedupe guard keeping
// late/duplicate terminal updates and the turn-end orphan sweep from double-emitting.
// KIMI-COMPACT-COMMAND: `commands` receives the names the AGENT advertises via
// available_commands_update. The handle reads it to answer "can this provider compact on
// demand?" from evidence rather than from a guess hardcoded here — see the handle's
// compactCommand getter.
// L1-MEASURE (F39): `compaction` carries the threshold facts a compaction_update must report but
// cannot see — normalizeKimiEvent is a pure mapper with no spec in scope, so the spawn stamps them
// once (below) instead of every branch re-deriving them. Optional: a ctx built without it (a bare
// mapper test) omits the fields rather than guessing a threshold that was never in force.
export type KimiCompactionMeta = {
  thresholdInForce: number | null;
  thresholdSource: CompactionThresholdSource;
  model?: string;
  provider: string;
};
export type KimiMapCtx = { toolTitles: Map<string, string>; toolClosed: Set<string>; commands?: Set<string>; compaction?: KimiCompactionMeta };

// extractToolCallText: ToolCallContent[] carries {type:"content", content: ContentBlock} plus
// diff/terminal variants (schema.d.ts) -- flatten to the shape toolResultText() already knows how
// to render (a ContentBlock-like array), surfacing diff/terminal entries as a `[type]` placeholder
// via the same fallback toolResultText uses for any block with no `.text`, rather than guessing a
// diff-rendering format no test can pin.
function extractToolCallText(content: ToolCallContent[] | undefined): string {
  if (!content) return "";
  const flattened = content.map((c) => (c.type === "content" ? c.content : { type: c.type }));
  return toolResultText(flattened);
}

// rawOutputText: a terminal tool_call_update's `rawOutput` arrives (post-shim, see
// sanitizeKimiAcpLine) as an object -- the real CLI's native shape is a plain STRING, which the
// shim wraps as `{ text: s }` so the ACP library's `z.record` validation accepts it. Handle the
// raw string shape too (defensive: fixture feeds, a future CLI that nests differently), then
// fall back to toolResultText for anything else.
function rawOutputText(rawOutput: unknown): string {
  if (typeof rawOutput === "string") return toolResultText(rawOutput);
  if (rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput)) {
    const t = (rawOutput as Record<string, unknown>)["text"];
    if (typeof t === "string") return toolResultText(t);
  }
  return rawOutput === undefined ? "" : toolResultText(rawOutput);
}

// toolResultFor: the ONE place a chimera tool_result is built for an ACP tool call, so every
// terminal edge (tool_call_update, a single-shot terminal tool_call, the orphan sweep) emits
// the same correlated shape: data.toolId is the ACP toolCallId the matching tool_call carried.
function toolResultFor(ctx: KimiMapCtx, u: { toolCallId: string; title?: string | null; status?: string | null; content?: ToolCallContent[]; rawOutput?: unknown }): BackendEvent {
  ctx.toolClosed.add(u.toolCallId);
  const toolName = ctx.toolTitles.get(u.toolCallId) ?? u.title ?? u.toolCallId;
  const text = extractToolCallText(u.content);
  const result = text !== "" ? text : rawOutputText(u.rawOutput);
  return { kind: "tool_result", data: { toolId: u.toolCallId, toolName, isError: u.status === "failed", ...(result !== "" ? { result } : {}) }, raw: u };
}

// closeOrphanedKimiToolCalls: KIMI-TOOL-EVENT-ORPHANS sweep -- run when a turn settles
// (prompt() resolved/thrown, including interrupt). Every announced toolCallId that never
// reached a terminal status gets a synthetic ERROR tool_result so the UI can never be left
// with a permanently-spinning tool card: a cancelled turn or a dropped terminal update must
// still terminate the call visibly. Ids are marked closed, so a terminal update that arrives
// late (after the sweep) is deduped away rather than double-emitting.
export function closeOrphanedKimiToolCalls(ctx: KimiMapCtx): BackendEvent[] {
  const out: BackendEvent[] = [];
  for (const [toolCallId, title] of ctx.toolTitles) {
    if (ctx.toolClosed.has(toolCallId)) continue;
    out.push(toolResultFor(ctx, { toolCallId, title, status: "failed", rawOutput: "tool call ended without a terminal update from the CLI (turn interrupted or connection lost)" }));
  }
  return out;
}

// normalizeKimiEvent: §1-style pure mapping table, one case per ACP sessionUpdate variant --
// exported + pure so every row gets a direct fixture-driven unit test without a live process.
export function normalizeKimiEvent(update: KimiAcpUpdate, ctx: KimiMapCtx): BackendEvent | BackendEvent[] | null {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      // Echo of the client's OWN prompt -- chimera already has this text from spec.prompt/send();
      // surfaced as status only so nothing is silently dropped from the wire.
      return { kind: "status", data: { kimiEvent: "user_message_chunk" }, raw: update };
    case "agent_message_chunk": {
      const text = (update.content as { text?: string }).text;
      return text ? { kind: "message_delta", data: { text }, raw: update } : null;
    }
    case "agent_thought_chunk": {
      const text = (update.content as { text?: string }).text;
      return text ? { kind: "message_delta", data: { text, channel: "reasoning" }, raw: update } : null;
    }
    case "tool_call": {
      const u = update as { toolCallId: string; title: string; kind?: string; rawInput?: Record<string, unknown>; status?: string; content?: ToolCallContent[]; rawOutput?: unknown };
      if (ctx.toolClosed.has(u.toolCallId)) return null;   // late re-send of a finished call: nothing new to announce
      const alreadyOpen = ctx.toolTitles.has(u.toolCallId);
      ctx.toolTitles.set(u.toolCallId, u.title);
      // KIMI-TOOL-EVENT-ORPHANS: data.toolId carries the ACP toolCallId so the ui-state reducer
      // can STRICT-match this call's tool_result (its toolId match has no fallback when present)
      // -- previously the id existed only in `raw`, leaving every Kimi tool call unmatchable.
      // KIMI-NATIVE-SUBAGENT-VISIBILITY: see the module header's paragraph of that name --
      // `note` rides in `input` (the one field every tool-call UI already renders verbatim)
      // rather than a new event field nothing would consume yet.
      const input = KIMI_FANOUT_TOOL_TITLES.has(u.title)
        ? { ...(u.rawInput ?? {}), note: KIMI_FANOUT_NOTE }
        : (u.rawInput ?? {});
      const call: BackendEvent = { kind: "tool_call", data: { toolId: u.toolCallId, toolName: u.title, input, ...(u.kind ? { toolKind: u.kind } : {}) }, raw: update };
      if (u.status === "completed" || u.status === "failed") {
        // A single-shot terminal tool_call (no separate update notifications -- same lifecycle
        // gap codex.ts's file_change/web_search have): emit the result too, pairing with the
        // call only if it was never announced (a re-send of an open call emits just the result).
        const result = toolResultFor(ctx, u);
        return alreadyOpen ? result : [call, result];
      }
      // ACP lifecycle re-sends of an already-announced call (pending/in_progress) are status
      // only -- they must NOT each produce a fresh chimera tool_call.
      return alreadyOpen ? null : call;
    }
    case "tool_call_update": {
      const u = update as { toolCallId: string; title?: string | null; status?: string; rawOutput?: unknown; content?: ToolCallContent[] };
      if (u.status !== "completed" && u.status !== "failed") return null;   // pending/in_progress: no chimera tool_result yet
      if (ctx.toolClosed.has(u.toolCallId)) return null;   // terminal edge already emitted (duplicate, or the orphan sweep beat a late update)
      return toolResultFor(ctx, u);
    }
    case "plan":
      return { kind: "status", data: { plan: update.entries }, raw: update };
    case "available_commands_update": {
      // KIMI-COMPACT-COMMAND: the payload used to be discarded into a bare marker. It is the only
      // place the agent states what it can be ASKED to do, and "can you compact on demand?" is
      // exactly such a question — recorded here so the handle answers it from what this agent
      // actually advertises instead of a name hardcoded for a CLI version nobody re-checks.
      const commands = (update as { availableCommands?: Array<{ name?: unknown; description?: unknown }> }).availableCommands ?? [];
      const names = commands.map((c) => (typeof c.name === "string" ? c.name : "")).filter((n) => n.length > 0);
      if (ctx.commands) { ctx.commands.clear(); for (const n of names) ctx.commands.add(n); }
      // SLASH-COMMANDS-ARE-PER-PROVIDER: emit the SAME normalized event claude.ts emits, so kimi's
      // advertised commands reach ui-state's slashCommands fold and the app's "/" autocomplete
      // like any other provider's. This was surfaced as a generic `status` blob, which nothing
      // consumes — so kimi advertised its commands and the operator never saw one.
      //
      // This is what "dynamic" has to mean here: each backend reports what IT has and the UI reads
      // that list. There is no cross-provider command set to hardcode — claude and kimi advertise
      // different ones, and codex's SDK exposes no slash-command surface at all.
      return {
        kind: "commands_changed",
        data: {
          commands: commands
            .filter((c) => typeof c.name === "string" && (c.name as string).length > 0)
            .map((c) => ({
              name: c.name as string,
              ...(typeof c.description === "string" ? { description: c.description } : {}),
            })),
        },
        raw: update,
      };
    }
    // COMPACTION-OBSERVABILITY (ACP 1.4.0): kimi can finally SAY that it compacted. Mapped onto
    // the same normalized `compaction` event both other backends emit, so the transcript banner,
    // the ⇥ counter, the ctx meter's reset and the live "compacting…" indicator all work for kimi
    // with no UI change — the phase vocabulary this maps onto exists for exactly this.
    //
    // Deliberately reports NO trigger and NO before/after sizes: the ACP schema carries neither,
    // and both other backends' events are read as measurements. Guessing "budget" here would be
    // indistinguishable from a real reading. The THRESHOLD, by contrast, is chimera's own fact and
    // is known even when the sizes are not — so thresholdInForce/thresholdSource/model/provider
    // (ctx.compaction, stamped at spawn) ride along on every phase, including "start"/"aborted". (Marked @experimental in the SDK — an unknown status
    // string falls through to the terminal branch rather than being asserted as a success.)
    case "compaction_update": {
      const u = update as { compactionId?: string; status?: string; error?: string };
      const base = { owner: "sdk", ...(u.compactionId ? { compactionId: u.compactionId } : {}), ...(ctx.compaction ?? {}) };
      if (u.status === "in_progress") return { kind: "compaction", data: { ...base, phase: "start" }, raw: update };
      if (u.status === "completed") return { kind: "compaction", data: base, raw: update };
      return {
        kind: "compaction",
        data: { ...base, phase: "aborted", ...(u.error ? { error: u.error } : {}), ...(u.status ? { status: u.status } : {}) },
        raw: update,
      };
    }
    case "compaction_summary_chunk":
      // The retained summary streams in as content blocks. Nothing renders them yet, and inventing
      // a transcript position for a partial summary would be worse than not showing it — surfaced
      // as status so it is visible on the wire rather than silently dropped.
      return { kind: "status", data: { kimiEvent: "compaction_summary_chunk" }, raw: update };
    case "current_mode_update":
      return { kind: "status", data: { kimiEvent: "current_mode_update", currentModeId: update.currentModeId }, raw: update };
    default: {
      // Forward-compatible catch-all (mirrors codex.ts's `default:` for unrecognized item types),
      // including Kimi's own vendor extension notifications this npm client's strict schema
      // validation rejects before they ever reach here (e.g. "config_option_update", confirmed
      // live -- logged by the library as a parse error and dropped, never fatal to the session).
      const anyUpdate = update as { sessionUpdate: string };
      return { kind: "status", data: { kimiEvent: anyUpdate.sessionUpdate } };
    }
  }
}

// sanitizeKimiAcpLine: KIMI-TOOL-EVENT-ORPHANS root cause, confirmed by a raw-wire probe of the
// real CLI (kimi v0.29.x, yolo mode): the CLI DOES send the full tool lifecycle -- an initial
// `tool_call` (status pending), `tool_call_update` stream (in_progress), and a terminal
// `tool_call_update` (completed/failed) whose `rawOutput` is a plain STRING (e.g.
// "probe-ok-12345\n"). But @zed-industries/agent-client-protocol@0.4.5's
// sessionNotificationSchema declares `rawOutput: z.record(z.unknown())` (object only), so the
// library's strict .parse() in its notification handler THREW on every terminal update and the
// notification was dropped before client.sessionUpdate ever ran -- the CLI's only "this tool
// finished" signal never reached chimera, leaving every Kimi tool call permanently pending.
// This shim rewrites a non-object rawOutput to `{ text: <string> }` (schema-valid, and
// rawOutputText() above unwraps it) on session/update lines only; every other line passes
// through byte-identical. Pure + exported for fixture-driven tests.
// ACP-SDK-RENAME: the successor SDK (@agentclientprotocol/sdk, PROTOCOL_VERSION still 1) FIXED
// this upstream -- its schema is now `rawOutput: defaultOnError(z.unknown().optional())`, which
// accepts a bare string AND falls back to a default rather than throwing. The shim is therefore
// no longer load-bearing; it is kept as defense-in-depth (it also normalizes the shape the way
// rawOutputText's object branch expects) and stays cheap via the `includes` fast path above.
// Its ONE remaining hard requirement is that it must not corrupt an already-valid line.
export function sanitizeKimiAcpLine(line: string): string {
  if (!line.includes('"rawOutput"')) return line;   // fast path: nothing to inspect
  let msg: { method?: unknown; params?: { update?: unknown } };
  try { msg = JSON.parse(line); } catch { return line; }   // not JSON: pass through, the library's own error path owns it
  const update = msg?.params?.update;
  if (msg?.method !== "session/update" || !update || typeof update !== "object") return line;
  const u = update as Record<string, unknown>;
  if (!("rawOutput" in u)) return line;
  const ro = u["rawOutput"];
  if (ro !== null && typeof ro === "object" && !Array.isArray(ro)) return line;   // already schema-valid
  u["rawOutput"] = { text: typeof ro === "string" ? ro : JSON.stringify(ro) };
  return JSON.stringify(msg);
}

// KimiAcpSessionLike / KimiFactory: the structural seam (mirrors codex.ts's CodexLike/
// CodexThreadLike) keeping the real ACP library's types out of chimera's public surface and
// letting tests inject a fully scripted fake instead of a live CLI process. `ready` resolves once
// initialize()+newSession()/loadSession() (and, if applicable, setSessionMode()) have all
// succeeded; `killNow` is available IMMEDIATELY (before `ready` settles) so a kill() arriving
// mid-handshake still reaches the real child process -- see connectKimiAcp().
export interface KimiAcpSessionLike {
  readonly sessionId: string;
  // F49: the POST-handshake notice. Only the connection knows what the CLI actually advertised
  // and whether a grant was minted, so the pre-handshake guess KimiAgentBackend.spawn used to
  // build (mcpCapabilities undefined => always "stdio-unsupported") is no longer authoritative.
  // Optional so every existing scripted-fake factory in the tests still satisfies the seam.
  readonly mcpNotice?: KimiMcpNotice;
  prompt(text: string): Promise<{ stopReason: string }>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
export interface KimiAcpHandleLike {
  readonly ready: Promise<KimiAcpSessionLike>;
  killNow(): void;
}
export type KimiAcpDeps = {
  onUpdate: (update: KimiAcpUpdate) => void;
  decidePermission: PermissionDecider;
  // F49: mint a loopback HTTP MCP grant for THIS spawn, or null when there is no listener to mint
  // from. Called only after initialize() reports http support, so a CLI that cannot use it never
  // opens a socket. `listenerEnabled` is the "chimera has a listener path at all" flag that lets
  // buildKimiMcpServers tell "no door offered" apart from "your CLI cannot use the door".
  grantMcp?: () => Promise<McpListenerGrant | null>;
  listenerEnabled?: boolean;
};
export type KimiFactory = (spec: ResolvedAgentSpec, cwd: string, deps: KimiAcpDeps) => KimiAcpHandleLike;

// KIMI-STDIO-MCP-UNSUPPORTED (correction, 2026-09-02, kimi CLI v0.37.2 -- root cause of two
// dead-on-spawn agents): the module header's "MCP-SERVER PASSTHROUGH" paragraph above claims ACP
// stdio MCP servers are wired through and cites, as live evidence, initialize()'s
// `mcpCapabilities: {http:true, sse:true}` -- that citation was a MISREAD. Those are the ONLY two
// transports the field can name; there is no `stdio` key, so the response was already saying
// "no stdio" and the old code read it backwards. Reproduced live against the installed CLI (both
// with and without an explicit `type` field on the entry -- see below): a non-empty
// `mcpServers` array containing chimera's stdio grant made EVERY session/new call fail with a
// JSON-RPC -32603 whose `.data.details` was `"ACP stdio MCP server chimera does not declare a
// runtime identity"` (describeKimiError's fix above is what first made that text visible at
// all -- previously only the generic "Internal error" reached the operator). Extracting the
// CLI's own source from the installed binary (`acpMcpServersToConfigRecord`) explains why no
// `type` field can fix this client-side: the CLI's request schema strips an unrecognized `type`
// key before this validation ever sees it (the published @agentclientprotocol/sdk's
// McpServerStdio type has no `type` field either, so this file's outgoing JSON had none),
// meaning the throw fires unconditionally for every stdio entry -- and even in the counterfactual
// where `type: "stdio"` DID survive, that function only builds a config for `type === "http" |
// "sse"`; a stdio entry with a type it does recognize is still just `log.warn`+dropped, never
// wired. Stdio-transport MCP servers are simply unsupported by this CLI build's ACP surface,
// full stop -- not a missing-field bug this file can paper over from the client side.
// spec.orchestration.allow is true for every normal chimera grant (chimera's own tool server is
// ALWAYS stdio -- it is the exact same stdio child claude.ts spawns, see MCP_BIN above), so this
// unconditionally wired a doomed entry into every kimi spawn that requested chimera tools; every
// one died here. FIX: withhold every stdio-transport entry (the chimera grant AND
// spec.mcpServers, since the existing "v1 scope" comment already established stdio is the only
// shape spec.mcpServers produces) instead of sending them -- degrade the same way an
// allowlist-withheld server already degrades (KimiMcpNotice, capabilityNotice status event, the
// first-turn text line) rather than crashing the whole spawn. The path back to real chimera-tool
// access on kimi is external to this repo: chimera's MCP server would need an http/sse listener
// (the CLI's own code reads `headers: namedPairsToRecord(server.headers)` for those transports,
// so identity env vars would become HTTP headers instead) -- not attempted here, out of scope for
// a spawn-crash fix.
// F49: "listener-disabled" is the third, NEW reason -- chimera itself had no HTTP door to offer.
// It is dual-cause on purpose (the notice text below spells both out): either the operator has
// `mcpListener.enabled:false`, or this kimi build advertises neither http nor stdio. Both mean
// "chimera could have wired tools and did not", which is exactly what must never be silent.
export type KimiMcpWithholdReason = "allowlist" | "stdio-unsupported" | "listener-disabled";
// KimiMcpNotice: the operator/agent-visible half of CROSS-PROVIDER-MCP-STORE -- what
// buildKimiMcpServers() below could NOT honor for this spawn, so `supportsMcpServers:false`/
// `supportsSettingSources:false`-style silent drops never happen again. `mcpServersWithheld` now
// carries the reason (KIMI-STDIO-MCP-UNSUPPORTED added "stdio-unsupported" alongside the
// pre-existing "allowlist" case) since the two need distinct operator-facing text. Both top-level
// fields default to "nothing to report" (empty array / false) so the common case (no allowlist,
// no settingSources request -- stdio-unsupported is NOT in that "common case" list: it now fires
// on every orchestration.allow:true spawn, by design, until kimi gets a non-stdio transport) still
// produces zero notice text where nothing changed.
export type KimiMcpNotice = { mcpServersWithheld: Array<{ name: string; reason: KimiMcpWithholdReason }>; settingSourcesUnsupported: boolean };

// buildKimiMcpServers: pure function of spec -> the exact ACP `mcpServers: McpServer[]` array
// to hand newSession/loadSession, plus the notice describing what got left out. See the module
// header's "MCP-SERVER PASSTHROUGH" paragraph (and the KIMI-STDIO-MCP-UNSUPPORTED correction
// just above) for the full reasoning; kept pure + exported so both connectKimiAcp (which needs
// the servers) and KimiAgentBackend.spawn (which needs the notice, before the ACP handshake even
// starts) can call it independently without threading extra state through KimiFactory's return
// shape -- cheap (no I/O), so calling it twice per spawn is not a real cost.
// KIMI-STDIO-CAPABILITY-LIVE (QA of the QA of c7c2bff1): the stdio withhold above was hard-coded
// off, un-informed by anything the live CLI actually reports. `McpCapabilities` (this SDK's
// published type) only names `http`/`sse`/`acp` today -- there is no `stdio` key -- so reading
// `.stdio` off it is a deliberate `Record<string, unknown>` probe, not a typo: the wire payload
// is JSON the CLI controls, and an upstream kimi/ACP release that starts advertising stdio
// support gets picked up here the moment it ships, with NO code change required on this side.
// Until then this always reads undefined and the withhold behavior is byte-identical to before.
function stdioCapable(mcpCapabilities: McpCapabilities | undefined): boolean {
  return (mcpCapabilities as Record<string, unknown> | undefined)?.["stdio"] === true;
}

export function buildKimiMcpServers(
  spec: ResolvedAgentSpec,
  mcpCapabilities?: McpCapabilities,
  httpGrant?: { url: string; token: string } | null,
  listenerEnabled?: boolean,
): { mcpServers: AcpMcpServer[]; notice: KimiMcpNotice } {
  // KIMI-STDIO-CAPABILITY-LIVE: mcpCapabilities is undefined on the pre-handshake call
  // (KimiAgentBackend.spawn builds the notice text before the ACP connection even exists) --
  // that call conservatively assumes stdio-unsupported, same as before this field existed. The
  // call INSIDE connectKimiAcp's `ready` (after initialize() resolves) passes the real, live
  // capabilities, so THAT call is the one whose withhold decision can actually flip.
  const stdioSupported = stdioCapable(mcpCapabilities);
  const mcpServers: AcpMcpServer[] = [];
  const mcpServersWithheld: Array<{ name: string; reason: KimiMcpWithholdReason }> = [];
  if (spec.orchestration.allow) {
    if (httpGrant) {
      // F49: http WINS over stdio even when a future CLI advertises both. The loopback listener is
      // the transport chimera controls end to end (identity bound server-side, revoked on kill);
      // the stdio path re-derives identity from env in a child chimera-mcp process, which is
      // strictly more surface for the same tool table.
      mcpServers.push({
        type: "http",
        name: "chimera",
        url: httpGrant.url,
        // IDENTITY-BY-TOKEN: this is the WHOLE authorization payload. Unlike the stdio entry below
        // -- which ships CHIMERA_AGENT_ID/DEPTH/MAX_DEPTH/TREE_ID/TEAM/AUTONOMY as env for
        // packages/mcp/src/server.ts to read back -- nothing here describes who the agent is.
        // The daemon bound that ctx to the token at mint time; the CLI cannot widen it, cannot
        // forge it, and cannot become anonymous with it. This also closes the hole this file's own
        // header warns about (a hand-registered ~/.kimi-code/mcp.json entry connecting with no
        // CHIMERA_MAX_DEPTH, hence no ancestor depth cap): the URL is per-spawn and unguessable.
        headers: [{ name: "Authorization", value: `Bearer ${httpGrant.token}` }],
      });
    } else if (stdioSupported) {
      mcpServers.push({
        name: "chimera",
        command: process.execPath,
        args: [MCP_BIN],
        env: [
          // IDENTITY: byte-for-byte the same variables/semantics as claude.ts's chimera grant
          // (pre-KIMI-STDIO-MCP-UNSUPPORTED shape, restored here since it is only reachable once
          // stdioSupported is true) -- an ACP-spawned chimera-mcp.js child must be exactly as
          // identity-scoped as the SDK-spawned one, never anonymous.
          { name: "CHIMERA_AGENT_ID", value: spec.agentId },
          { name: "CHIMERA_DEPTH", value: String(spec.depth) },
          { name: "CHIMERA_MAX_DEPTH", value: String(spec.orchestration.maxDepth) },
          { name: "CHIMERA_HOME", value: process.env.CHIMERA_HOME ?? chimeraHome() },
          { name: "CHIMERA_TREE_ID", value: spec.env["CHIMERA_TREE_ID"] ?? "" },
          { name: "CHIMERA_TEAM", value: spec.env["CHIMERA_TEAM"] ?? "" },
          { name: "CHIMERA_AUTONOMY", value: spec.autonomy === "full" ? "full" : "" },
        ],
      });
    } else {
      // listenerEnabled true + no grant + no stdio => chimera HAS the http path and it did not
      // apply (operator disabled it, or this CLI advertises neither transport). Distinct from the
      // engine-less case below, where there is no http path in this process at all.
      mcpServersWithheld.push({ name: "chimera", reason: listenerEnabled === true ? "listener-disabled" : "stdio-unsupported" });
    }
  }
  // v1 scope (matches codex.ts's mcp_servers restriction / generic-mcp.ts's buildMcpServerSpecs):
  // stdio only -- a url/sse/http entry in spec.mcpServers has no `command` and is silently
  // skipped (not withheld: there was never anything ACP-shaped to wire for it).
  const allowlistActive = spec.mcpToolAllowlist !== undefined;
  for (const [name, raw] of Object.entries(spec.mcpServers)) {
    const s = raw as { command?: string; args?: string[]; env?: Record<string, string> };
    if (!s.command) continue;
    // FAIL CLOSED (allowlist case, pre-existing): ACP's McpServer schema has no per-tool
    // enabled_tools/disabled_tools equivalent (see module header) -- withhold the WHOLE server
    // rather than grant it unfiltered, had this transport even been wirable. KIMI-STDIO-MCP-
    // UNSUPPORTED means every spec.mcpServers entry is withheld regardless of allowlist state
    // now (see reason below), but the allowlist reason is kept distinct: an operator who
    // configured a restrictive allowlist AND is on a future stdio-capable kimi build should still
    // see "withheld for allowlist", not a stale "stdio unsupported" that no longer applies to them.
    if (allowlistActive) { mcpServersWithheld.push({ name, reason: "allowlist" }); continue; }
    if (stdioSupported) {
      mcpServers.push({ name, command: s.command, args: s.args ?? [], env: Object.entries(s.env ?? {}).map(([k, v]) => ({ name: k, value: v })) });
      continue;
    }
    mcpServersWithheld.push({ name, reason: "stdio-unsupported" });
  }
  return {
    mcpServers,
    notice: {
      mcpServersWithheld,
      // settingSources/loadSettings: kimi has no equivalent of the SDK's --setting-sources --
      // the CLI always reads its own ~/.kimi-code config, full stop. Non-empty means the
      // resolved spec actually WANTED project/user settings loaded (not the lean default).
      settingSourcesUnsupported: spec.inherit.settingSources.length > 0,
    },
  };
}

// KIMI-ERROR-DIAGNOSABILITY: RequestError.message (jsonrpc.js) is always the GENERIC JSON-RPC
// spec text for its numeric code -- e.g. every -32603 is literally the string "Internal error",
// no matter what actually went wrong on the CLI side. The real diagnostic detail, when the CLI
// supplies any, rides in `.data` instead (jsonrpc.js's client-side reject path: `new
// RequestError(code, message, data)` built straight from the wire's `error` object). Reading
// only `.message` (this file's prior behavior) surfaced a content-free "Internal error" for
// every CLI-side handshake/prompt failure -- indistinguishable from a hang, a crash, or anything
// else. This folds the code and `.data` into the string that actually reaches chimera's `error`
// event / daemon.log, without discarding `.message` itself (classifyError's substring patterns,
// e.g. /authentication/i, still match against the SAME leading text).
// KIMI-ERROR-DATA-UNTRUSTED (QA of c7c2bff1): `.data` is raw wire JSON handed straight through by
// the ACP SDK (jsonrpc.js's `new RequestError(code, message, data)` from `response.error.data`) --
// i.e. arbitrary, unbounded, CHILD-PROCESS-CONTROLLED content that a validation-error path can
// easily echo request params back through (mcpServers env pairs, prompt text). It lands verbatim
// in the durable event log: EventLog.append writes `JSON.stringify(full)` with no redaction of its
// own (events.ts's redactSecrets/flatten only builds the chronicle SEARCH index, not the jsonl),
// and rides on to the conductor's mailbox via supervisor.notifyChildFailed. So the detail gets the
// same treatment every other external-text-to-event-message path in this repo already applies --
// scrubSecretShapes + a length cap (engine.ts:419, network.ts:216, cloudflare.ts) -- with the cap
// matching THIS file's own stderrTail budget (see connectKimiAcp) since it is the same class of
// bounded diagnostic tail. Only the DETAIL is transformed: the leading `message (code N)` stays
// byte-exact so classifyError's substring patterns keep matching what they matched before.
const KIMI_ERROR_DATA_MAX = 4000;
export function describeKimiError(err: unknown): string {
  if (err instanceof RequestError) {
    return `${err.message} (code ${err.code})${describeKimiErrorData(err.data)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// Never throws and never returns "undefined": `.data` is untrusted, so a value JSON.stringify
// refuses (a cycle) or silently maps to undefined (a function/symbol) must still degrade to
// SOMETHING readable rather than turning the error report itself into a second failure.
function describeKimiErrorData(data: unknown): string {
  if (data === undefined) return "";
  let raw: string;
  try {
    raw = JSON.stringify(data) ?? String(data);
  } catch {
    raw = String(data);
  }
  const scrubbed = scrubSecretShapes(raw);
  return ` ${scrubbed.length > KIMI_ERROR_DATA_MAX ? `${scrubbed.slice(0, KIMI_ERROR_DATA_MAX)}… (truncated)` : scrubbed}`;
}

// connectKimiAcp: the REAL factory -- spawns `kimi acp` and drives the actual handshake. Owns the
// child process directly (unlike the old SDK, which spawned internally and only exposed
// Session.close()) so kill()/close() are genuine, always-available process control from the
// moment this function returns, independent of whichever RPC is in flight.
export const connectKimiAcp: KimiFactory = (spec, cwd, deps) => {
  const cliPath = (spec.providerOptions?.["executable"] as string | undefined) ?? resolveKimiCliPath();
  const args = buildKimiAcpArgs(spec);
  // Manual env merge (codex.ts precedent): we now own the spawn directly, so nothing else merges
  // process.env in for us the way the old SDK's ProtocolClient did internally.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, spec.env);

  const proc: ChildProcess = spawnProcess(cliPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderrTail = "";
  proc.stderr?.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });

  let closed = false;
  // F49: CLOSURE-local, never module-level -- two concurrent kimi agents each run their own
  // connectKimiAcp invocation, and a shared binding would let one agent's terminate() revoke the
  // other's grant. revoke() is idempotent, so terminate() and the child's exit handler may both fire.
  let grantRevoke: (() => void) | null = null;
  const terminate = (): void => {
    if (closed) return;
    closed = true;
    grantRevoke?.();
    try { proc.kill("SIGTERM"); } catch { /* already gone */ }
    const grace = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, 3000);
    proc.once("exit", () => clearTimeout(grace));
  };

  // A grant must never outlive the process holding its token, however that process ends -- a
  // crash or a self-exit never runs terminate().
  proc.once("exit", () => { grantRevoke?.(); });
  const spawnFailed = new Promise<never>((_, reject) => {
    proc.once("error", (err) => reject(err));
    proc.once("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`kimi acp exited with code ${code}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""}`));
      }
    });
  });

  let sessionId = "";
  const client: AcpClient = {
    async sessionUpdate(params: SessionNotification) {
      if (params.sessionId !== sessionId) return;
      deps.onUpdate(params.update);
    },
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      if (params.sessionId !== sessionId) throw RequestError.invalidParams({ reason: "unknown sessionId" });
      const tc = params.toolCall;
      // §3/S3 precedent, carried forward: `toolName` has no direct machine-readable field on the
      // wire (ACP's ToolCallUpdate carries only a human-readable `title` + coarse `kind`) --
      // `title` is the best-fitting stand-in, `kind`/`rawInput` ride along as `input`.
      const decision = await deps.decidePermission({
        requestId: tc.toolCallId, toolName: tc.title ?? tc.toolCallId,
        input: { ...(tc.rawInput ?? {}), ...(tc.kind ? { toolKind: tc.kind } : {}) },
      });
      return { outcome: { outcome: "selected", optionId: mapKimiPermissionOptions(params.options, decision) } };
    },
  };
  // KIMI-TOOL-EVENT-ORPHANS: run stdout through the rawOutput shim BEFORE the ACP library's
  // strict schema validation sees each line (see sanitizeKimiAcpLine) -- otherwise every
  // terminal tool_call_update is parse-rejected and silently dropped inside the library.
  let sanitizeBuf = "";
  const sanitizer = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sanitizeBuf += chunk.toString("utf8");
      let idx;
      while ((idx = sanitizeBuf.indexOf("\n")) >= 0) {
        this.push(sanitizeKimiAcpLine(sanitizeBuf.slice(0, idx)) + "\n");
        sanitizeBuf = sanitizeBuf.slice(idx + 1);
      }
      cb();
    },
    flush(cb) {
      if (sanitizeBuf) this.push(sanitizeKimiAcpLine(sanitizeBuf));
      cb();
    },
  });
  proc.stdout!.pipe(sanitizer);
  const stream = ndJsonStream(Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(sanitizer) as ReadableStream<Uint8Array>);
  const conn = new ClientSideConnection(() => client, stream);

  const ready = (async (): Promise<KimiAcpSessionLike> => {
    const initResp = await Promise.race([
      conn.initialize({ protocolVersion: 1, clientCapabilities: {} }),
      spawnFailed,
    ]);
    // KIMI-STDIO-CAPABILITY-LIVE: log what the CLI actually advertised (info level, daemon-log
    // only -- mirrors mcpstore.ts's console.warn precedent for this class of observability-only
    // signal) so an operator/future-debugger can see the withhold decision's real input, not just
    // its output.
    console.info(`[kimi] initialize() mcpCapabilities: ${JSON.stringify(initResp.agentCapabilities?.mcpCapabilities ?? {})}`);
    // CROSS-PROVIDER-MCP-STORE: see module header's "MCP-SERVER PASSTHROUGH" paragraph and
    // buildKimiMcpServers() above -- the notice half of this call's return is read separately,
    // before the handshake even starts, by KimiAgentBackend.spawn (below), which cannot know the
    // live capabilities yet and so conservatively withholds. THIS call, after initialize() has
    // resolved, is the one whose withhold decision can actually flip on a future CLI.
    const caps = initResp.agentCapabilities?.mcpCapabilities;
    // Mint only when the CLI can actually consume it: an unused grant would bind the listener's
    // socket for a client that will never connect.
    const httpGrant: McpListenerGrant | null = spec.orchestration.allow && caps?.http === true
      ? (await deps.grantMcp?.().catch((err: unknown) => {
          // A bind/mint failure must not silently read as "the operator turned it off" -- the
          // notice below cannot tell those apart, so the real cause is logged here.
          console.warn(`[kimi] loopback mcp grant failed, continuing without chimera tools: ${String(err)}`);
          return null;
        })) ?? null
      : null;
    // kill() can land while the await above is in flight: terminate() has already run and will
    // never run again, so nothing else would ever revoke this grant.
    if (closed) httpGrant?.revoke();
    else if (httpGrant) grantRevoke = httpGrant.revoke;
    const { mcpServers, notice } = buildKimiMcpServers(spec, caps, httpGrant, deps.listenerEnabled);
    if (spec.resume) {
      // LoadSessionResponse carries no sessionId of its own (the caller already knows it -- it's
      // the same id passed in the request); newSession's response is the only one that MINTS one.
      await Promise.race([conn.loadSession({ sessionId: spec.resume, cwd, mcpServers }), spawnFailed]);
      sessionId = spec.resume;
    } else {
      const sessResp = await Promise.race([conn.newSession({ cwd, mcpServers }), spawnFailed]);
      sessionId = sessResp.sessionId;
      // DYNAMIC-MODEL-LISTS: kimi answers newSession with its OWN live model catalog as a
      // `configOptions` select (category "model") -- the same list its interactive picker shows.
      // It was being discarded, so chimera's model pickers fell back to a ONE-entry static
      // catalog while the CLI itself was offering four. Recording it here is free (the response
      // is already in hand) and outlives the daemon via the disk-backed cache.
      // EFFORT-ONE-SOURCE: the levels ride on the SAME configOptions payload as the models, so
      // learning them costs nothing extra — they are attached to every model row this session
      // reports, which is the shape effortLevelsFor() reads.
      const kimiEfforts = kimiEffortOptions(sessResp.configOptions);
      recordProviderModels("kimi", kimiModelOptions(sessResp.configOptions).map((m) =>
        (kimiEfforts.length > 0 ? { ...m, supportedEfforts: kimiEfforts } : m)));
    }
    const mode = kimiModeFor(spec);
    if (mode !== "default") await conn.setSessionMode({ sessionId, modeId: mode });
    return {
      sessionId,
      mcpNotice: notice,
      prompt: (text) => conn.prompt({ sessionId, prompt: [{ type: "text", text }] }),
      cancel: async () => { await conn.cancel({ sessionId }); },
      close: async () => terminate(),
    };
  })();
  // Never surface an unhandled-rejection warning for the handshake promise just because the
  // caller only ever awaits it later (or not at all, if killed first) -- the real error still
  // reaches whoever DOES await `ready`.
  ready.catch(() => {});

  return { ready, killNow: terminate };
};

export class KimiAgentBackend implements AgentBackend {
  readonly provider = "kimi";
  // CROSS-PROVIDER-MCP-STORE, CORRECTED (QA of c7c2bff1): this claimed supportsMcpServers:true
  // "now that buildKimiMcpServers() genuinely wires the chimera grant + spec.mcpServers through
  // ACP" -- KIMI-STDIO-MCP-UNSUPPORTED made that untrue in the same change that wrote the fix:
  // every INSTALLED kimi CLI observed so far rejects stdio outright. A capability flag that says
  // "yes" while the code can only ever say "no" is exactly the silent drop KimiMcpNotice exists
  // to prevent, so it reads false until kimi gains a non-stdio MCP transport (flip it back in the
  // same change that makes that the common case). KIMI-STDIO-CAPABILITY-LIVE made
  // buildKimiMcpServers() itself capability-aware (it now WOULD wire entries through given a live
  // initialize() response advertising stdio) — this static flag can't reflect that per-spawn,
  // async probe, so it stays the conservative default until stdio support is common enough to
  // hard-code true. F49 gives it a SECOND reason to stay false: the loopback http grant is now
  // the usual way chimera's own tools reach kimi, and it too is decided per spawn (the operator's
  // mcpListener.enabled AND the CLI's live http capability), never statically.
  // supportsSettingSources stays false for its own, unrelated reason: genuinely unsupported, ACP
  // has no equivalent knob -- see KimiMcpNotice.settingSourcesUnsupported.
  readonly capabilities: BackendCapabilities = {
    supportsResume: true, supportsMcpServers: false, supportsSettingSources: false, supportsVoiceRealtime: false,
  };
  // F49: `engine` is the ONLY new dep and it is optional -- an Engine-less test/embedder keeps
  // exactly today's behaviour (no grant, withheld with "stdio-unsupported"). Deliberately the
  // lazy accessor and not an Engine: backends are constructed before the Engine exists.
  constructor(private deps: {
    kimiFactory?: KimiFactory;
    modelCatalog?: () => ModelMetadataLookup | undefined;
    engine?: ChimeraEngineAccessor;
  } = {}) {}

  // decideDialog is accepted per the AgentBackend contract but never invoked: ACP has no
  // distinct "question" RPC surface (unlike the old SDK's QuestionRequest) -- ANY user-facing
  // question the CLI wants to ask rides the SAME requestPermission round trip (its "may still ask
  // questions" language for yolo mode is the CLI's own docs' way of describing this), which this
  // file already answers via decidePermission. No live evidence of a separate dialog surface to
  // wire decideDialog against.
  spawn(spec: ResolvedAgentSpec, sink: EventSink, decidePermission: PermissionDecider, _decideDialog?: DialogDecider): AgentHandle {
    const { workdir: cwd } = ensureWorkdir(spec);
    const effectiveModel = spec.model ?? findProvider("kimi")?.defaultModel;
    const ctx: KimiMapCtx = {
      toolTitles: new Map(), toolClosed: new Set(), commands: new Set(),
      compaction: {
        thresholdInForce: spec.compactionThreshold ?? null,
        thresholdSource: spec.compactionThresholdSource ?? "native",
        // The SAME model agent_started reports below, not the raw request: supervisor.onEvent
        // sniffs `data.model` on every event kind, so a compaction event disagreeing with
        // agent_started would flip actualModel (and the ctx-meter denominator) mid-run.
        ...(effectiveModel ? { model: effectiveModel } : {}),
        provider: spec.resolvedProvider,
      },
    };
    let lastText = "";
    let turnFailed = false;

    const loop = new InterruptibleTurnLoop();
    const keepAlive = spec.conductor || spec.persistent;

    const acpHandle = (this.deps.kimiFactory ?? connectKimiAcp)(spec, cwd, {
      onUpdate: (update) => {
        const normalized = normalizeKimiEvent(update, ctx);
        if (!normalized) return;
        for (const ev of Array.isArray(normalized) ? normalized : [normalized]) {
          if (ev.kind === "message_delta" && ev.data["channel"] === undefined) lastText += String(ev.data["text"] ?? "");
          sink(ev);
        }
      },
      decidePermission,
      // "chimera has an http path in this process at all" -- lets buildKimiMcpServers tell
      // "the door was closed" apart from "there is no door here", which are different bugs.
      listenerEnabled: this.deps.engine !== undefined,
      grantMcp: () => this.deps.engine?.get().mcpListener?.grant({
        agentId: spec.agentId,
        // Byte-for-byte the ctx packages/mcp/src/server.ts derives from the stdio env block in
        // buildKimiMcpServers: server.ts:30 reads CHIMERA_DEPTH and adds one, so the grant's
        // depth is the depth this agent's OWN children would spawn at.
        depth: spec.depth + 1,
        maxDepthCap: spec.orchestration.maxDepth,
        ...(spec.env["CHIMERA_TREE_ID"] ? { treeId: spec.env["CHIMERA_TREE_ID"] } : {}),
        ...(spec.env["CHIMERA_TEAM"] ? { team: spec.env["CHIMERA_TEAM"] } : {}),
        ...(spec.autonomy === "full" ? { autonomy: "full" as const } : {}),
        // conductor and toolTags are DELIBERATELY absent: the stdio env block carries no
        // equivalent of either, and an http agent must never get authority its stdio twin
        // could not have had.
        provider: "kimi",
      }) ?? Promise.resolve(null),
    });

    const run = async () => {
      let session: KimiAcpSessionLike;
      try {
        session = await acpHandle.ready;
      } catch (err) {
        // KIMI-HANDSHAKE-CRASH-PARITY: acpHandle.ready rejecting here means initialize/newSession/
        // loadSession itself failed -- the CLI is dead on spawn, same incident as "kimi acp exited
        // with code N" (connectKimiAcp's spawnFailed path), but the message text is generic
        // JSON-RPC boilerplate ("Internal error (code -32603)...") that matches none of
        // failover.ts's CRASH patterns, so supervisor.onError classified it "unknown" and never
        // restarted -- unlike the SAME incident surfaced via process exit. `phase:"handshake"`
        // lets onError override the classification to backend-crash regardless of message text.
        if (!loop.killed) sink({ kind: "error", data: { message: describeKimiError(err), phase: "handshake" } });
        loop.end();
        return;
      }
      if (loop.killed) { loop.end(); return; }
      // CROSS-PROVIDER-MCP-STORE (SURFACING): the operator's sharper complaint was not just "it
      // can't reach the MCP", it was "and it doesn't know" -- a capability this backend silently
      // dropped used to leave both the operator and the agent guessing.
      // F49 MOVED THIS OUT OF spawn(): the pre-handshake build ran with mcpCapabilities
      // undefined, so it ALWAYS said "stdio-unsupported" -- a notice that now actively lies when
      // the CLI turns out to speak http and a grant was wired. `session.mcpNotice` is the
      // post-handshake verdict from the connection that actually saw the capabilities; the
      // fallback covers a scripted test fake (or a resumed session seam) that carries none.
      const notice = session.mcpNotice ?? buildKimiMcpServers(spec).notice;
      const allowlistWithheld = notice.mcpServersWithheld.filter((w) => w.reason === "allowlist").map((w) => w.name);
      const stdioWithheld = notice.mcpServersWithheld.filter((w) => w.reason === "stdio-unsupported").map((w) => w.name);
      const listenerWithheld = notice.mcpServersWithheld.filter((w) => w.reason === "listener-disabled").map((w) => w.name);
      const capabilityNoticeLines: string[] = [
        ...(allowlistWithheld.length > 0
          ? [`${allowlistWithheld.length} external MCP server(s) configured on this agent were withheld entirely this session (${allowlistWithheld.join(", ")}): kimi's ACP transport cannot enforce the configured mcpToolAllowlist's per-tool restrictions, so the whole server was left disconnected rather than granting it unfiltered.`]
          : []),
        ...(stdioWithheld.length > 0
          ? [`${stdioWithheld.length} MCP server(s) (${stdioWithheld.join(", ")}) were withheld entirely this session: the installed kimi CLI's ACP transport rejects stdio-transport MCP servers (confirmed live -- session/new fails outright for one), so no chimera-native tools (memory, ask_agent, queue, etc.) are reachable on this provider right now.`]
          : []),
        // DUAL-CAUSE ON PURPOSE: from inside this spawn the two are indistinguishable (both end
        // as "no grant, no stdio"), and naming only one of them would send an operator to the
        // wrong knob. Saying both is the whole point of the notice.
        ...(listenerWithheld.length > 0
          ? [`${listenerWithheld.length} MCP server(s) (${listenerWithheld.join(", ")}) were withheld entirely this session: chimera reaches kimi over a loopback HTTP MCP listener, and either that listener is off (config mcpListener.enabled) or this kimi build advertises neither http nor stdio MCP transport -- so no chimera-native tools (memory, ask_agent, queue, etc.) are reachable on this agent.`]
          : []),
        ...(notice.settingSourcesUnsupported
          ? [`project/user settings were requested (loadSettings/settingSources) but kimi has no equivalent -- this session always uses the operator's own ~/.kimi-code CLI config instead.`]
          : []),
      ];
      const capabilityNoticeText = capabilityNoticeLines.length > 0
        ? `\n\n[chimera capability notice] ${capabilityNoticeLines.join(" ")}`
        : "";
      const firstInput = (spec.instructions ? `${spec.instructions}\n\n${spec.prompt}` : spec.prompt) + capabilityNoticeText;
      // MODEL-ACTUAL-SURFACE + RESUME fix: unlike the old code (which fired this synchronously,
      // before any live event, defensively against S0's certain-crash finding), agent_started now
      // fires AFTER the real session exists -- see the module header's "agent_started timing"
      // paragraph. This also fixes a latent bug: only THIS event's `data.sessionId` is ever
      // captured for resume (supervisor.ts:1035), and the old code never included one.
      sink({
        kind: "agent_started",
        data: { sessionId: session.sessionId, ...(effectiveModel ? { model: effectiveModel } : {}), ...(spec.effort ? { effort: spec.effort } : {}) },
      });
      // CROSS-PROVIDER-MCP-STORE (SURFACING): operator-visible even when the agent's own first
      // turn already carries capabilityNoticeText (e.g. surfaced in a UI transcript/tail without
      // reading the prompt) -- and the ONLY signal at all on a resumeOnly reattach, which pushes
      // no first user turn to carry the prompt-side notice.
      if (capabilityNoticeLines.length > 0) {
        sink({ kind: "status", data: { capabilityNotice: { mcpServersWithheld: notice.mcpServersWithheld, settingSourcesUnsupported: notice.settingSourcesUnsupported, lines: capabilityNoticeLines } } });
      }

      if (!spec.resumeOnly) loop.push(firstInput);
      // Refresh shared rules on the first new task, keeping native slash commands intact.
      let resumedInstructions = spec.resumeOnly ? (spec.instructions ?? "") + capabilityNoticeText : "";
      try {
        while (!loop.killed) {
          let prompt = loop.shift();
          if (prompt === undefined && keepAlive && !loop.closed) {
            prompt = await loop.waitForInput();
            if (loop.killed) break;
          }
          if (prompt === undefined) break;
          const controller = loop.beginTurn();
          // ACP cancellation is a fire-and-forget notification, not a promise-rejecting abort --
          // the in-flight prompt() call below still resolves normally, just with
          // stopReason:"cancelled" once the CLI honors it (see the module header's INTERRUPT note).
          const onAbort = () => { void session.cancel(); };
          controller.signal.addEventListener("abort", onAbort);
          let result: { stopReason: string };
          try {
            const refreshInstructions = resumedInstructions && !/^\/[a-z][\w-]*(?:\s|$)/i.test(prompt.trimStart());
            result = await session.prompt(refreshInstructions ? `${resumedInstructions}\n\n${prompt}` : prompt);
            if (refreshInstructions) resumedInstructions = "";
          } catch (err) {
            if (loop.killed) break;
            // Orphan sweep BEFORE the error event: any tool call left open by the failed turn
            // terminates as an error tool_result first, so its card never outlives the turn.
            for (const ev of closeOrphanedKimiToolCalls(ctx)) sink(ev);
            // F08.QA-FIX item 3: same "Internal error" shape as the handshake catch above, now
            // mid-session -- phase:"session" gets classifyFailure's identical restart-in-place
            // disposition (see KIMI-HANDSHAKE-CRASH-PARITY in failover.ts), since a sessionId is
            // already captured here and the restart resumes it rather than starting fresh.
            sink({ kind: "error", data: { message: describeKimiError(err), phase: "session" } });
            turnFailed = true;
            break;
          } finally {
            controller.signal.removeEventListener("abort", onAbort);
          }
          if (loop.killed) break;
          // Orphan sweep: in the normal path every tool's terminal update arrived before
          // prompt() resolved (confirmed by the raw-wire probe) and this is a no-op; on an
          // interrupted turn it closes whatever the cancel left hanging. Runs BEFORE
          // turn_complete so the tool card settles first.
          for (const ev of closeOrphanedKimiToolCalls(ctx)) sink(ev);
          sink({
            kind: "turn_complete",
            data: result.stopReason === "cancelled" ? { interrupted: true } : { stopReason: result.stopReason },
          });
        }
      } finally {
        loop.end();
      }
      if (loop.killed || turnFailed) return;
      // NO TOKEN-USAGE TELEMETRY (module header): costUsd is always 0, never fabricated -- ACP
      // exposes no usage/cost field anywhere on the wire (confirmed against the full schema and
      // the live pong round trip).
      sink({ kind: "result", data: { text: lastText, costUsd: 0, ...(effectiveModel ? { model: effectiveModel } : {}) } });
    };
    void run();

    return {
      send: async (text: string, images?: unknown[], content?: unknown[]) => {
        if (loop.ended || loop.closed) throw new Error("input stream closed");
        // IMAGE.PASTE: NOT wired in this slice (unchanged scope from S2) -- ACP's ContentBlock
        // union DOES support image content (confirmed: initialize()'s
        // promptCapabilities.image:true), a genuine capability the old SDK path never reached, but
        // wiring it is a future increment, not required here.
        if ((images && images.length > 0) || (content && content.length > 0)) {
          throw new Error("kimi backend: images/content blocks are not yet supported (send is text-only)");
        }
        loop.push(text);
      },
      // KIMI-COMPACT-COMMAND: answered from what this agent advertised, not from a constant.
      // MANUAL-COMPACT-ANY-PROVIDER asks a backend for the slash command its CLI understands as
      // "compact now"; kimi tells us its command list at runtime, so the honest answer is "the
      // compact command IF this build has one" — a name hardcoded here would keep claiming the
      // capability after a CLI that dropped it, which is the failure mode that rule exists to
      // avoid. Undefined while the agent has advertised nothing, so compact() refuses honestly.
      get compactCommand(): string | undefined {
        const name = [...(ctx.commands ?? [])].find((c) => c === "compact" || c === "/compact");
        return name === undefined ? undefined : (name.startsWith("/") ? name : `/${name}`);
      },
      interrupt: async () => { loop.interrupt(); },
      // close()/kill() are identical -- carried forward from S2: no softer teardown was
      // confirmed to exist for kimi then, and none was investigated here either; both hard-kill
      // the real child process immediately (see connectKimiAcp's `terminate`), available even
      // mid-handshake via `killNow`.
      kill: async () => { loop.kill(); acpHandle.killNow(); },
      close: async () => { loop.kill(); acpHandle.killNow(); },
    };
  }
}
