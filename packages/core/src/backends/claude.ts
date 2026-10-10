import { chimeraAccess, chimeraToolRestrictions } from "@chimera/protocol/chimera-capabilities";
import type { AgentDelivery } from "@chimera/protocol";
import { deliveryContent, withMessageInput } from "../message-delivery.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnChildProcess } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode, SpawnOptions as ClaudeCliSpawnOptions, SpawnedProcess as ClaudeCliSpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentBackend, AgentHandle, BackendCapabilities, ContentBlock, DialogDecider, EventSink, Image, PermissionDecider,
  RemoteControlHandleResult, ResolvedAgentSpec,
} from "../backend.js";
import { classifyError } from "../failover.js";
import { chimeraHome } from "../paths.js";
import { recordProviderModels } from "../providers/model-list-cache.js";
import { ensureWorkdir } from "../workdir.js";
import { toolResultText } from "./tool-result.js";
import { toolResultImageFields, withoutRawImages } from "./tool-result-images.js";
import { TurnController } from "../turn-controller.js";
import { findProvider } from "../providers/catalog.js";
import { computeCostUsd, estimateChimeraMcpToolSurface, TOOL_SURFACE_NOTE, CLAUDE_AUTO_COMPACT_WINDOW_MIN, CLAUDE_AUTO_COMPACT_WINDOW_MAX, type AccountQuotaWindow, type ModelMetadataLookup } from "@chimera/protocol";

// plain-node launcher (Task 16): resolvable from any cwd, unlike a bare `tsx` specifier
const MCP_BIN = fileURLToPath(new URL("../../../mcp/bin/chimera-mcp.js", import.meta.url));

// PROJECT-WORKSPACE-LAYOUT: a non-worktree spawn (project conductor, dispatch's direct project
// spawn, a project-native team worker, a workflow role reusing the calling agent's cwd, …) whose
// cwd has no `.git` is a repo-less scratch workspace (e.g. an operator's Jira-ticket project with
// no checkout of its own) — left unguided, an agent there clones straight into the workspace
// root. Detected via an actual `.git` existsSync check rather than ProjectSpec.origin: origin is
// only set for imported projects, so a registered local path (origin === null) can still be a
// real checkout, and this must not fire for one. The same check correctly stays silent for an
// isolation:"none" respawn into an existing worktree (AGENT-RESUME-TOOLS) since a worktree's
// `.git` is a file, not a directory, but existsSync sees it either way.
const WORKSPACE_CONTAINER_INSTRUCTION = "WORKSPACE: this project directory is a container, not a checkout. If you need a repository, clone it into a SUBDIRECTORY (<project>/<repo-name>) — never into the project root.";

// AGENT-PROCESS-NOT-REAPED: the SDK's own kill()/interrupt() are self-documented best-effort
// (see the R2-TURN-LIFECYCLE comment below) — closing the JS-side input queue and sending an
// interrupt control request never forcibly terminates the underlying `claude` CLI subprocess,
// let alone the 5-6 MCP server children it spawns of its own. Measured live: terminal
// (done/failed/killed) AgentRecords whose CLI process + MCP children were still running DAYS
// later. This is the actual OS-level enforcement those best-effort asks were missing.
//
// Only safe to signal the NEGATIVE pid (the whole process GROUP, reaching the MCP children)
// because spawnClaudeCodeProcess below spawns with detached:true, making this process its OWN
// group leader (pgid === pid) — negative-pid-signalling a non-detached child would hit the
// DAEMON's own process group (children inherit the parent's pgid unless detached), which is
// exactly why this is never applied to a plain ChildProcess spawned elsewhere without detached.
export function terminateProcessGroup(
  proc: { pid?: number | undefined; once(event: "exit", listener: () => void): void },
  opts: { graceMs?: number; kill?: (pid: number, signal: NodeJS.Signals) => void } = {},
): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  const kill = opts.kill ?? ((p: number, signal: NodeJS.Signals) => process.kill(p, signal));
  const graceMs = opts.graceMs ?? 5000;
  let exited = false;
  proc.once("exit", () => { exited = true; });
  // Graceful first: SIGTERM lets the CLI close its MCP client connections cleanly, which is
  // what lets a well-behaved MCP server see EOF/disconnect and exit on its own.
  try { kill(-pid, "SIGTERM"); } catch { /* already gone, or somehow not a group leader */ }
  const timer = setTimeout(() => {
    if (exited) return;
    // Bounded escalation: whatever ignored SIGTERM (a wedged MCP server, a stuck fetch) gets
    // no further grace — this is what actually guarantees termination within graceMs, closing
    // the exact gap the comment above documents.
    try { kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  }, graceMs);
  timer.unref?.();
  proc.once("exit", () => clearTimeout(timer));
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  push(item: T): void {
    if (this.closed) throw new Error("input stream closed");   // Phase 3: no silent ACK-and-drop after close
    const w = this.waiters.shift();
    w ? w({ value: item, done: false }) : this.items.push(item);
  }
  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  isEmpty(): boolean { return this.items.length === 0; }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function blockToSdk(b: ContentBlock): Record<string, unknown> {
  return b.type === "text"
    ? { type: "text" as const, text: b.text }
    : { type: "image" as const, source: { type: "base64" as const, media_type: b.mediaType, data: b.data } };
}

// SDKUserMessage.session_id and uuid are OPTIONAL — this is the minimal valid message.
// IMAGE.PASTE: images (when present) become additional ImageBlockParam entries
// AFTER the text block, in the SAME content array — verified SDK shape:
// SDKUserMessage.message: MessageParam.content = Array<ContentBlockParam>,
// ImageBlockParam { type:"image", source: Base64ImageSource { type:"base64", media_type, data } }.
// D9: `content` (when non-empty) takes over entirely — its blocks are mapped 1:1,
// in order, so an image referenced mid-sentence lands at that exact position
// instead of the legacy text-then-images bunching. `text`/`images` stay the
// fallback path so every pre-D9 caller is byte-for-byte unaffected.
// SAFE-1 CACHE-PREFIX: `preambleText` (when present) becomes its OWN leading text
// block, ahead of whichever of content/text-plus-images applies below — this is how
// per-spawn facts that used to ride the cacheable system-prompt append (orientation)
// get relocated into the first user turn without disturbing the existing text/content
// branching (an image-bearing `content` prompt still gets its blocks untouched, just
// preceded by the preamble block).
function userMessage(text: string, images?: Image[], content?: ContentBlock[], preambleText?: string) {
  const mainBlocks: Array<Record<string, unknown>> = content && content.length > 0
    ? content.map(blockToSdk)
    : [{ type: "text" as const, text }, ...(images ?? []).map((img) => blockToSdk({ type: "image", mediaType: img.mediaType, data: img.data }))];
  const blocks = preambleText ? [{ type: "text" as const, text: preambleText }, ...mainBlocks] : mainBlocks;
  return { type: "user" as const, message: { role: "user" as const, content: blocks }, parent_tool_use_id: null };
}

function mapPermission(profile: ResolvedAgentSpec["permissionProfile"]): "default" | "auto" {
  // Full is Chimera's policy, not consent to disable Claude's classifier. Read-only
  // keeps its prompting native mode and is still enforced by Chimera's tool policy.
  return profile === "readOnly" ? "default" : "auto";
}

// CAN_USE_TOOL_SHADOWED / toolPolicy-shadow FIX: the single tool-gate decision, shared
// verbatim between the two SDK wiring paths below. It NEVER returns a null/blocking
// behavior — only allow/deny — so decidePermission stays the one gate that runs in ALL
// permission modes (its per-profile autoDecision is authoritative regardless of the SDK
// permissionMode). Shape is identical to the SDK's PermissionResult so the non-bypass
// canUseTool path can return it directly.
type ToolDecision = { behavior: "allow" | "deny"; updatedInput?: unknown; message?: string };

// BYPASS path adapter: bypassPermissions SHADOWS canUseTool (the SDK emits
// CLAUDE_SDK_CAN_USE_TOOL_SHADOWED and never invokes it — sdk.mjs j5(): "canUseTool will
// not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call ...
// To gate every tool call, use a PreToolUse hook instead."). A PreToolUse hook DOES fire
// and DOES gate in bypass (sdk.d.ts §SDKPermissionDeniedMessage: "PreToolUse hook denies
// bypass canUseTool"). This maps a ToolDecision onto that hook's SyncHookJSONOutput:
// permissionDecision:'deny' blocks the tool; updatedInput carries AskUserQuestion answers
// (and any other rewrite) through to the tool exactly as canUseTool's updatedInput does.
function adaptHookDecision(d: ToolDecision): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: d.behavior === "allow" ? ("allow" as const) : ("deny" as const),
      ...(d.updatedInput !== undefined ? { updatedInput: d.updatedInput as Record<string, unknown> } : {}),
      ...(d.message !== undefined ? { permissionDecisionReason: d.message } : {}),
    },
  };
}

// Task AUTH-a (Phase 4, scoped): SDKAssistantMessage.error subtypes that mean the
// account's auth itself is broken (needs a re-login) — as opposed to rate_limit/
// billing_error, which are NOT auth problems and must NOT flip authExpired.
const AUTH_ERROR_SUBTYPES = new Set(["authentication_failed", "oauth_org_not_allowed"]);

// COMPACTION-THRESHOLD-CONFIG (the claude-SDK finding): the Agent SDK's `Options.settings`
// field (a "flag settings" layer, highest priority, no settings.json file needed) accepts an
// inline Settings object with `autoCompactEnabled`/`autoCompactWindow` — real, validated,
// forwarded to the underlying Claude Code CLI subprocess (verified: sdk.mjs's own zod schema
// is `autoCompactWindow: z.number().int().min(1e5).max(1e6).optional()`). This IS the CLI's
// native auto-compact trigger config, exactly the codex-parity knob CODEX-COMPACTION-GAP found
// for that backend — the CLI (not the JS wrapper) owns the actual trigger decision, same
// posture as codex's `model_auto_compact_token_limit`. LIMITATION: the SDK's own schema floors
// the window at 100_000 tokens — a configured threshold below that clamps UP to the floor (a
// `status` event reports the clamp) rather than silently under- or over-shooting. Unset ⇒
// `settings` is omitted entirely, so claude.ts's behavior is byte-identical to before this
// field existed (today's SDK-native auto-compact, whatever its own default window is).
// Constants live in @chimera/protocol (CTX-METER-TRIGGER-CLAMP) so supervisor.ts's ctx-meter
// denominator can apply the identical clamp and never drift from this actual trigger again.

// SOFT-TURN-LIMIT: under turnLimitPolicy:"soft" we do NOT pass the spec's nominal
// maxTurns to the SDK as a hard cap (that's exactly what makes it terminate the
// agent at the boundary) — instead the SDK is given this large sentinel so it
// never stops the conversation on turn count, and chimera tracks the NOMINAL
// budget itself (turnsCompleted below) purely to emit the turnBudgetExceeded
// signal. Well above any realistic session's turn count.
const SOFT_TURN_CAP = 1_000_000;

// TOKEN-EFF-2: settingSources must include "project" for the SDK itself to load CLAUDE.md
// (sdk.d.ts: "Must include 'project' to load CLAUDE.md files") — chimera always sets
// settingSources explicitly (never omitted, see below), so a spec that doesn't request
// "project" would otherwise spawn with zero repo orientation. Read the repo-root CLAUDE.md
// ourselves and fold it into the instructions append instead. Capped well under a typical
// context budget — a CLAUDE.md is meant to be a terse index, not a place to dump docs.
const CLAUDE_MD_MAX_BYTES = 8 * 1024;

function readProjectClaudeMd(cwd: string): string {
  const path = join(cwd, "CLAUDE.md");
  if (!existsSync(path)) return "";
  const raw = readFileSync(path, "utf8");
  return raw.length > CLAUDE_MD_MAX_BYTES ? raw.slice(0, CLAUDE_MD_MAX_BYTES) : raw;
}

// R2 (unified cache-aware token/ctx/cost metrics): claude's raw usage already excludes cache
// from input_tokens (additive, verified against the Anthropic SDK's Usage type) — no
// subtraction needed, unlike codex.ts's toCostUsage. Only used for the pricing-table cost
// FALLBACK (the SDK's own total_cost_usd is preferred whenever present).
// W2-3 CACHE-WRITE-TTL WIRING: the raw payload's `cache_creation` (verified on the pinned
// @anthropic-ai/sdk 0.110.0 BetaCacheCreation type, threaded through unchanged by the Claude
// Agent SDK's NonNullableUsage) is `{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens} | null`
// — present whenever the API itself returned a TTL breakdown. Reading it here is what turns
// W2-2's computeCostUsd TTL-split support from "detectable" into "detected": once cacheCreation5m/
// 1h are populated, cacheCreationCostUsd bills each bucket at its real rate instead of falling
// back to unresolvedTtlCacheWriteRate's 1h-default assumption. Absent/null on an older CLI or a
// response that never enabled TTL caching ⇒ both stay undefined, byte-identical to before this
// change (computeCostUsd's existing unresolved-TTL fallback still applies).
function claudeCostUsage(u: Record<string, unknown> | undefined): {
  input: number; output: number; cacheRead: number; cacheCreation: number;
  cacheCreation5m?: number; cacheCreation1h?: number;
} {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const split = u?.["cache_creation"] as { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown } | null | undefined;
  return {
    input: num(u?.["input_tokens"]),
    output: num(u?.["output_tokens"]),
    cacheRead: num(u?.["cache_read_input_tokens"]),
    cacheCreation: num(u?.["cache_creation_input_tokens"]),
    ...(split ? { cacheCreation5m: num(split.ephemeral_5m_input_tokens), cacheCreation1h: num(split.ephemeral_1h_input_tokens) } : {}),
  };
}

// ACCOUNT-QUOTA-METERS (Phase 0 finding; units CORRECTED — see QUOTA-METER-WRONG-BY-100X below):
// the Claude Agent SDK emits a `rate_limit_event` message (SDKRateLimitEvent, sdk.d.ts) with
// `rate_limit_info: SDKRateLimitInfo` for claude.ai subscription/OAuth accounts — ONE window
// per event: { status, resetsAt?, rateLimitType?:
// 'five_hour'|'seven_day'|'seven_day_opus'|'seven_day_sonnet'|'seven_day_overage_included'|
// 'overage', utilization?, ... }. Maps five_hour -> "session", the seven_day* variants ->
// "weekly"; 'overage' (a spend-credit concept, not a rolling time window) has no place in our
// two-window model and is dropped. `windowStartedAt` has no SDK field — DERIVED as
// resetsAt - a known window length (5h / 7d), per the design doc's explicit allowance for
// deriving it from a known window length when the provider doesn't report a start directly.
//
// QUOTA-METER-WRONG-BY-100X: the previous version of this comment claimed utilization/resetsAt
// units were "verified" by cross-referencing them against quota-poll.ts's CLAUDE_USAGE_ENDPOINT
// (GET /api/oauth/usage) sample — but that endpoint is a DIFFERENT transport (an async JSON poll)
// from this one (a push event, empirically sourced from the same live per-request rate-limit
// metadata the SDK reads off actual API response headers/trailers for a real request). Trusting
// the JSON endpoint's convention here was an unverified assumption dressed up as a verified one,
// and it produced a real 100x-understated `usedFraction` plus a `resetsAt`/`windowStartedAt`
// stuck in 1970 for a live "keychain"/oauthToken account (claude-pers) — silently telling
// routing/backpressure an ~96%-exhausted account had ~99% headroom left. Root-caused live:
// SDKRateLimitInfo has NO unit doc comment (unlike SDKControlGetUsageResponse's rate_limits,
// which explicitly says "0-100" / "ISO 8601") — sdk.d.ts genuinely does not specify. The observed
// bad values decoded cleanly under the OPPOSITE convention: `resetsAt` interpreted as epoch
// SECONDS (not ms) landed on the exact real reset time reported by the provider's own usage UI;
// `utilization` interpreted as an already-0..1 fraction (not a 0..100 percent) landed within a
// few points of that same UI's reported usage. This matches normalizeMessagesRateLimitHeaders's
// (quota-poll.ts) documented convention for the SAME kind of live-response-derived rate-limit
// data (0..1 fraction, epoch-seconds reset) — the event path and the header-probe path both read
// off live request/response metadata, not the async JSON usage endpoint, so they share ITS
// convention, not the JSON endpoint's. Returns null (never a fabricated window) when the window
// kind is unrecognized or a required field (resetsAt/utilization) is missing.
const CLAUDE_QUOTA_WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
  seven_day_opus: 7 * 24 * 60 * 60 * 1000,
  seven_day_sonnet: 7 * 24 * 60 * 60 * 1000,
  seven_day_overage_included: 7 * 24 * 60 * 60 * 1000,
};
/** EXTRA-USAGE-VISIBILITY: the overage half of SDKRateLimitInfo, which normalizeClaudeRateLimit
 *  correctly refuses to force into the two-window model and therefore threw away entirely.
 *
 *  It matters most in exactly the case the window model cannot represent: the primary window is
 *  `rejected` and the only remaining question is whether the account can continue on extra usage.
 *  Chimera was holding an agent until reset without being able to say whether that hold was
 *  necessary, and the operator had no view of the allowance the provider's own UI shows them.
 *
 *  Returns null when the event carries no overage field at all (API key, Bedrock, Vertex, a plan
 *  without extra usage) — absent is "unknown", never "disabled". `overageResetsAt` shares
 *  `resetsAt`'s epoch-SECONDS convention on this transport (see QUOTA-METER-WRONG-BY-100X). */
export function normalizeClaudeOverage(info: Record<string, unknown> | undefined): {
  status: "allowed" | "allowed_warning" | "rejected" | null;
  disabledReason: string | null;
  inUse: boolean | null;
  resetsAt: number | null;
} | null {
  if (!info) return null;
  const rawStatus = info["overageStatus"];
  const status = rawStatus === "allowed" || rawStatus === "allowed_warning" || rawStatus === "rejected" ? rawStatus : null;
  const rawReason = info["overageDisabledReason"];
  const disabledReason = typeof rawReason === "string" && rawReason.length > 0 ? rawReason : null;
  // The SDK carries the same fact under two names across versions; either is authoritative and
  // reading only one would silently report "unknown" against a provider that told us plainly.
  const inUseRaw = info["isUsingOverage"] ?? info["overageInUse"];
  const inUse = typeof inUseRaw === "boolean" ? inUseRaw : null;
  const resetsRaw = info["overageResetsAt"];
  const resetsAt = typeof resetsRaw === "number" && Number.isFinite(resetsRaw) ? resetsRaw * 1000 : null;
  if (status === null && disabledReason === null && inUse === null && resetsAt === null) return null;
  return { status, disabledReason, inUse, resetsAt };
}

export function normalizeClaudeRateLimit(info: Record<string, unknown> | undefined): AccountQuotaWindow | null {
  const rateLimitType = typeof info?.["rateLimitType"] === "string" ? info["rateLimitType"] : undefined;
  const windowMs = rateLimitType ? CLAUDE_QUOTA_WINDOW_MS[rateLimitType] : undefined;
  if (!windowMs) return null;   // unrecognized or "overage" — no window to render
  const kind: AccountQuotaWindow["kind"] = rateLimitType === "five_hour" ? "session" : "weekly";
  const resetsAtSec = info?.["resetsAt"];
  const utilization = info?.["utilization"];
  if (typeof resetsAtSec !== "number" || !Number.isFinite(resetsAtSec)) return null;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  const resetsAt = resetsAtSec * 1000;   // epoch SECONDS on this event path — see QUOTA-METER-WRONG-BY-100X above
  const usedFraction = Math.min(1, Math.max(0, utilization));   // already a 0..1 fraction on this event path
  return { kind, usedFraction, windowStartedAt: resetsAt - windowMs, resetsAt };
}

export class ClaudeAgentBackend implements AgentBackend {
  readonly provider = "claude";
  readonly capabilities: BackendCapabilities = { supportsResume: true, supportsMcpServers: true, supportsSettingSources: true, supportsVoiceRealtime: false };
  // DYNAMIC-MODEL-METADATA: `modelCatalog` is a lazy accessor (backends are built BEFORE the Engine
  // that owns the service, so it resolves at cost-computation time, not construction) — it lets the
  // authoritative result-event cost use catalog pricing for a model absent from protocol's hardcoded
  // map. Absent ⇒ hardcoded-map-only, byte-identical to before.
  constructor(private deps: {
    queryFn?: typeof query;
    modelCatalog?: () => ModelMetadataLookup | undefined;
    // AGENT-PROCESS-NOT-REAPED: test-only override so unit tests can verify the SIGTERM->SIGKILL
    // escalation on a real short-lived process tree without a multi-second wait.
    processTerminationGraceMs?: number;
  } = {}) {}

  spawn(spec: ResolvedAgentSpec, sink: EventSink, decide: PermissionDecider, decideDialog?: DialogDecider): AgentHandle {
    const q = this.deps.queryFn ?? query;
    const { workdir: cwd, branch, baseSha, mainRepo } = ensureWorkdir(spec);
    // TOKEN-EFF-1: a worktree-isolated agent is dropped into a detached-HEAD worktree with
    // no context — left to spend a dozen exploratory git calls just orienting itself. workdir.ts
    // already knows the branch/base/main-repo the instant it creates the worktree; hand it to
    // the agent up front instead of making every spawn rediscover the same facts.
    // WF-7: workdirKey means this worktree is a SHARED task workspace (e.g. a workflow's
    // step-role switches all land in the same dir) — other agents' work may already be here,
    // and land-on-main is not this agent's call to make unconditionally. Only the plain
    // per-agent path (no workdirKey) gets the unconditional land-on-main instruction.
    // TOKEN-OPT-ORIENTATION: structured lines, each path stated once and referenced by name
    // after. The prose version repeated the worktree path, branch and main checkout four or five
    // times (~1,050 chars for a worker); these carry the same facts and instructions.
    const workspaceFacts = `- <worktree>: ${cwd}\n- <branch>: ${branch} (from main ${baseSha?.slice(0, 12)})\n- <main> checkout: ${mainRepo}`;
    const orientationText = spec.isolation === "worktree"
      ? spec.workdirKey
        ? `WORKSPACE (shared by every agent on this task; already set up: don't re-check it with git rev-parse/branch --show-current/worktree list, and don't use EnterWorktree/ExitWorktree)\n${workspaceFacts}\n- Other agents' work may already be here: never discard work you didn't create.\n- Don't merge to main or remove this worktree/branch unless your instructions say so.`
        : `WORKSPACE (already set up: don't re-check it with git rev-parse/branch --show-current/worktree list, and don't use EnterWorktree/ExitWorktree)\n${workspaceFacts}\n- When done and verified: commit, then \`git -C <main> merge --no-ff <branch>\`, \`git -C <main> worktree remove --force <worktree>\`, \`git -C <main> branch -D <branch>\`, and report the merge commit hash.`
      : existsSync(join(cwd, ".git")) ? "" : WORKSPACE_CONTAINER_INSTRUCTION;
    // SAFE-1 CACHE-PREFIX: orientation embeds THIS spawn's own worktree path/branch/base
    // sha — riding the Claude system-prompt append (as it used to) would make the system
    // block byte-DIFFERENT on every single worktree spawn, defeating Anthropic's exact-
    // prefix cache match across every agent this daemon spawns. Hoisted into the first
    // user turn instead (still precomputed, still "do NOT re-derive" — only its position
    // moves). A resumeOnly reattach pushes no first user message at all (Task CR1 below),
    // so for that path only, orientation still rides the system append — resent fresh on
    // every resumed query() — since there is no user turn to carry it on instead.
    const orientationForSystem = spec.resumeOnly && orientationText ? `\n\n${orientationText}` : "";
    const orientationForPrompt = !spec.resumeOnly ? orientationText : "";
    // TOKEN-EFF-2: only self-inject when the spec's settingSources won't make the SDK load
    // CLAUDE.md on its own — otherwise the project's CLAUDE.md would land in the prompt twice.
    const claudeMd = spec.inherit.settingSources.includes("project") ? "" : readProjectClaudeMd(cwd);
    // AGENT-AUTONOMY: the one-line brief for a "full" autonomy agent — no human/orchestrator
    // is reachable (ask_human/ask_agent/ask_team are unregistered, see the chimera-mcp grant
    // below, and supportedDialogKinds is omitted), so it must decide on its own.
    const autonomyLine = spec.autonomy === "full"
      ? "\n\nAUTONOMY: no human is available to ask — decide yourself, state the assumption you made, and record durable decisions in memory."
      : "";
    const input = new AsyncQueue<ReturnType<typeof userMessage>>();
    // Task CR1: resumeOnly resumes the SDK session but does NOT seed it with the original
    // prompt — the agent resumes idle and waits for the first send() (re-attaching a persistent
    // conductor after a daemon restart must not replay its original spawn prompt as a new turn).
    if (!spec.resumeOnly) input.push(userMessage(spec.prompt, undefined, spec.initialDelivery ? deliveryContent(spec.prompt, undefined, spec.content, spec.initialDelivery) : spec.content, orientationForPrompt || undefined));

    // AGENT-PROCESS-NOT-REAPED: captured by spawnClaudeCodeProcess below the moment the real CLI
    // subprocess exists, so kill()/the terminal `finally` can hard-terminate its process GROUP
    // (see terminateProcessGroup) independent of whether the SDK's own JS-level stream ever
    // yields another message. Stays null for a fake queryFn (every existing test) since those
    // never call spawnClaudeCodeProcess at all — byte-identical behavior for them.
    let cliExited = false;
    let cliProcess: { pid?: number | undefined; once(event: "exit", listener: () => void): void } | null = null;
    // AGENT-FAILURE-REACHES-CONDUCTOR: a process-layer death (the CLI exits non-zero on its own,
    // outside any SDK-recognized protocol error) used to surface as a bare "exited with code 1" —
    // the SDK's own rejection message never carries stderr. Mirrors kimi.ts's connectKimiAcp exactly:
    // a bounded TAIL (not unbounded buffering — this process can run for a long-lived
    // conductor/persistent session), captured live off the real child's stderr the moment it exists.
    let stderrTail = "";
    let cliExitCode: number | null = null;

    const mcpServersUnsorted: Record<string, unknown> = { ...spec.mcpServers };
    if (chimeraAccess(spec) !== "none") {
      mcpServersUnsorted["chimera"] = {
        type: "stdio", command: process.execPath, args: [MCP_BIN],
        env: {
          CHIMERA_MCP_ACCESS: chimeraAccess(spec),
          ...(chimeraToolRestrictions(spec).toolAllowlist !== undefined ? { CHIMERA_MCP_TOOL_ALLOWLIST: JSON.stringify(chimeraToolRestrictions(spec).toolAllowlist) } : {}),
          ...(chimeraToolRestrictions(spec).toolDenylist !== undefined ? { CHIMERA_MCP_TOOL_DENYLIST: JSON.stringify(chimeraToolRestrictions(spec).toolDenylist) } : {}),
          CHIMERA_AGENT_ID: spec.agentId,                         // spec §17.4: ask_human uses this to address agent.ask
          CHIMERA_DEPTH: String(spec.depth),
          CHIMERA_MAX_DEPTH: String(spec.orchestration.maxDepth),   // parent's cap; Task 16 forwards it as maxDepthCap
          CHIMERA_HOME: process.env.CHIMERA_HOME ?? chimeraHome(),  // NEVER "": empty string is not nullish for ??
          CHIMERA_TREE_ID: spec.env["CHIMERA_TREE_ID"] ?? "",       // "" is safe: Task 10's reader treats "" as absent via || undefined
          // WORKER-TEAM-CONTEXT fix: this hand-built env dict never forwarded CHIMERA_TEAM
          // (supervisor.ts stamps it onto spec.env for scheduler team spawns) into the chimera-mcp
          // subprocess's own env, so a team worker's my_team always saw process.env.CHIMERA_TEAM
          // undefined -> {team:null}, no matter what the daemon's AgentRecord said.
          CHIMERA_TEAM: spec.env["CHIMERA_TEAM"] ?? "",
          // AGENT-AUTONOMY: forwarded verbatim; "" (autonomy "ask", the default) means
          // server.ts registers ask_human/ask_agent/ask_team as usual.
          CHIMERA_AUTONOMY: spec.autonomy === "full" ? "full" : "",
          // CONDUCTOR-TOOLS-MATCH-THE-PLAYBOOK: lets the MCP server register the orchestration
          // verbs CONDUCTOR_PLAYBOOK instructs a conductor to use (see CONDUCTOR_TOOL_NAMES).
          CHIMERA_CONDUCTOR: spec.conductor ? "1" : "",
        },
      };
    }
    // TOKEN-OPT-P4: canonicalize key order before this ever reaches the SDK — the SDK
    // derives its tool-definition prefix (part of the cached prefix, see the
    // systemPrompt/mcpServers spawn-once contract below) from this object, and an
    // incidental insertion-order difference between two spawns of an equivalent spec
    // would shift that prefix and silently defeat the cache. Sorted ONCE per spawn, then
    // never touched again for the life of this handle (mirrors options' compute-once).
    const mcpServers: Record<string, unknown> = Object.fromEntries(
      Object.keys(mcpServersUnsorted).sort().map((k) => [k, mcpServersUnsorted[k]]),
    );

    // TOOL-SURFACE-MEASURE: spawn-time visibility into what chimera itself is about to inject
    // (see mcp-tools.ts's estimateChimeraMcpToolSurface doc comment for exactly what this does
    // and does not cover). Only meaningful when the chimera MCP grant is actually mounted —
    // an orchestration-disallowed spawn gets no chimera tools at all, so emitting a zero/absent
    // estimate for it would be noise, not signal.
    if (chimeraAccess(spec) !== "none") {
      const estimate = estimateChimeraMcpToolSurface({ autonomy: spec.autonomy, conductor: spec.conductor === true });
      sink({
        kind: "status",
        data: {
          toolSurface: {
            source: "chimera-mcp-grant",
            ...estimate,
            settingSources: spec.inherit.settingSources,
            note: TOOL_SURFACE_NOTE,
          },
        },
      });
    }

    // Options.env REPLACES the subprocess environment entirely when set — the
    // process.env spread is mandatory (PATH/HOME). But the parent's own auth
    // vars OUTRANK an injected credential in the CLI's auth precedence
    // (ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY > apiKeyHelper >
    // CLAUDE_CODE_OAUTH_TOKEN), so whenever spec.env injects any credential,
    // strip the competing vars from the inherited copy — otherwise per-account
    // isolation is silently defeated. Exactly one auth var is ever injected
    // per account (guaranteed by injectAs).
    const AUTH_VARS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    if (AUTH_VARS.some((k) => k in spec.env)) for (const k of AUTH_VARS) delete inherited[k];
    // SAFE-2 DEFER-ASSERT: an ambient/custom endpoint or disabled experimental betas makes
    // Claude silently expand deferred MCP schemas into the first request. Strip both process
    // and per-spec copies, and positively enable ToolSearch in the final subprocess env.
    const claudeEnv: NodeJS.ProcessEnv = { ...inherited, ...spec.env, ENABLE_TOOL_SEARCH: "1" };
    delete claudeEnv["ANTHROPIC_BASE_URL"];
    delete claudeEnv["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"];

    // CAN_USE_TOOL_SHADOWED / toolPolicy-shadow FIX: the shared tool-gate decision. This is
    // the EXACT former canUseTool body, only re-parameterised on toolUseID so both the
    // canUseTool path (non-bypass) and the PreToolUse hook path (bypass) route through it.
    // Native-CLI-parity Phase 2 (FIX): AskUserQuestion is delivered through the permission
    // channel, NOT onUserDialog — render it as an interactive DIALOG (decideDialog → the TUI
    // DialogPanel → the user's choice) and hand the answer back by ALLOWING the tool with
    // `answers` pre-filled in updatedInput; the tool then returns that selection to the model.
    // NEVER return a null/blocking behavior — only allow/deny.
    const decideToolUse = async (toolName: string, toolInput: unknown, toolUseID?: string): Promise<ToolDecision> => {
      if (toolName === "AskUserQuestion" && decideDialog) {
        const decision = await decideDialog({
          dialogId: toolUseID ?? randomUUID(),
          dialogKind: "permission_ask_user_question",
          payload: (toolInput ?? {}) as Record<string, unknown>,
          toolUseId: toolUseID,
        });
        if (decision.behavior === "completed") {
          const answers = (decision.result as { answers?: unknown } | undefined)?.answers ?? decision.result ?? {};
          return { behavior: "allow", updatedInput: { ...(toolInput as Record<string, unknown>), answers } };
        }
        return { behavior: "deny", message: "question cancelled by the user" };
      }
      // WORKTREE-AGENT-WRITES-REACH-MAIN: decide() may now return a string instead of false —
      // a specific deny reason (e.g. the worktree-main-guard's "this targets main, not your
      // worktree") to surface verbatim instead of the generic fallback below. `=== true` is
      // deliberate: a non-empty string is truthy but must still deny.
      const decision = await decide({ requestId: toolUseID ?? randomUUID(), toolName, input: toolInput });
      if (decision === true) return { behavior: "allow", updatedInput: toolInput };
      return { behavior: "deny", message: typeof decision === "string" ? decision : "denied by chimera permission policy" };
    };

    const explicitPermissionMode = spec.providerOptions.permissionMode;
    const executionPermissionMode = (profile: ResolvedAgentSpec["permissionProfile"]): PermissionMode =>
      typeof explicitPermissionMode === "string" && explicitPermissionMode !== "plan"
        ? explicitPermissionMode as PermissionMode : mapPermission(profile);
    const permissionMode = spec.executionMode === "auto" ? "auto" : executionPermissionMode(spec.permissionProfile);
    let activePermissionMode: string = spec.executionMode === "plan" ? "plan" : permissionMode;
    // Explicit bypass shadows canUseTool and requires the skip-permissions opt-in.
    // Auto uses a deny-only hook so native classifier approval cannot skip Chimera's
    // policy and Chimera approval cannot skip the classifier.
    const permissionWiring: Record<string, unknown> = permissionMode === "bypassPermissions"
      ? {
          allowDangerouslySkipPermissions: true,
          hooks: {
            PreToolUse: [{
              hooks: [
                async (input: { tool_name: string; tool_input: unknown; tool_use_id?: string }) => {
                  const decision = await decideToolUse(input.tool_name, input.tool_input, input.tool_use_id);
                  return decision.behavior === "deny" || activePermissionMode === "bypassPermissions" || input.tool_name === "AskUserQuestion"
                    ? adaptHookDecision(decision) : {};
                },
              ],
            }],
          },
        }
      : {
          // Auto can approve tools without canUseTool. Keep Chimera's denials in a
          // hook, but NEVER turn its allow into a native allow: the classifier must
          // still evaluate it. Explicit bypass retains its separate wiring above.
          // Install for every non-bypass launch: a read-only/plan session can
          // later enter auto through the supported live mode control.
          hooks: { PreToolUse: [{ hooks: [async (input: { tool_name: string; tool_input: unknown; tool_use_id?: string }) => {
              // Questions must be completed once via canUseTool's updatedInput channel.
              if (input.tool_name === "AskUserQuestion") return {};
              const decision = await decideToolUse(input.tool_name, input.tool_input, input.tool_use_id);
              return decision.behavior === "deny" ? adaptHookDecision(decision) : {};
          }] }] },
          // Use the SDK-provided toolUseID as the permission requestId when present.
          canUseTool: async (toolName: string, toolInput: unknown, opts?: { toolUseID?: string }) =>
            decideToolUse(toolName, toolInput, opts?.toolUseID),
        };

    // COMPACTION-THRESHOLD-CONFIG: clamp into the SDK's own validated range and surface a
    // `status` event when clamped, so an operator who configured e.g. 20000 for a small-window
    // provider sees why the effective trigger differs from what they set — never a silent
    // reinterpretation. Omitted entirely (no `settings` key) when unset, see the doc comment above.
    let claudeSettings: Record<string, unknown> | undefined;
    if (spec.compactionThreshold !== undefined) {
      const clamped = Math.min(CLAUDE_AUTO_COMPACT_WINDOW_MAX, Math.max(CLAUDE_AUTO_COMPACT_WINDOW_MIN, spec.compactionThreshold));
      if (clamped !== spec.compactionThreshold) {
        sink({
          kind: "status",
          data: { compactionThresholdClamped: { requested: spec.compactionThreshold, applied: clamped, min: CLAUDE_AUTO_COMPACT_WINDOW_MIN, max: CLAUDE_AUTO_COMPACT_WINDOW_MAX } },
        });
      }
      claudeSettings = { autoCompactEnabled: true, autoCompactWindow: clamped };
    }

    const options: Record<string, unknown> = {
      cwd,
      model: spec.model,
      // EFFORT: chimera's neutral 4-value enum is a literal subset of the SDK's own
      // EffortLevel ('low'|'medium'|'high'|'xhigh'|'max') — direct passthrough, no mapping.
      // Undefined ⇒ key omitted, SDK falls back to its own default ('high'), matching model's
      // own omit-when-unset contract.
      ...(spec.effort ? { effort: spec.effort } : {}),
      // SOFT-TURN-LIMIT: "soft" hands the SDK a large sentinel instead of the
      // nominal budget so it never enforces the cap itself (see SOFT_TURN_CAP);
      // the nominal spec.maxTurns is instead tracked chimera-side, below.
      maxTurns: spec.turnLimitPolicy === "soft" ? SOFT_TURN_CAP : spec.maxTurns,
      ...(spec.resume ? { resume: spec.resume } : {}),   // Task RS1: forward a non-null resume sessionId to the SDK
      permissionMode: spec.executionMode === "plan" ? "plan" : permissionMode,
      // CAN_USE_TOOL_SHADOWED / toolPolicy-shadow FIX: canUseTool (non-bypass) OR the
      // PreToolUse hook + allowDangerouslySkipPermissions (bypass). See permissionWiring above.
      ...permissionWiring,
      // ALWAYS set — never drop this option from the options object: since SDK
      // 0.3.x an OMITTED settingSources loads ALL sources (user/project/local);
      // [] is the explicit isolation escape, not the default.
      settingSources: spec.inherit.settingSources,
      mcpServers,
      // LEAN-AGENT-MCPS: deliberately independent of settingSources above — strictMcpConfig
      // governs MCP loading only (SDK's own --strict-mcp-config: ignore project .mcp.json/user
      // settings/plugins/subagent frontmatter, use ONLY `mcpServers` above), while settingSources
      // keeps governing skills/CLAUDE.md. This is what lets a spec inherit project/user skills
      // AND run MCP-lean at the same time. Omitted (undefined) ⇒ key absent, same as before this
      // field existed — supervisor.ts's LEAN-AGENT-CONTEXT default (or its own providerOptions
      // escape hatch, spread last below) is what sets it in that case.
      ...(spec.strictMcpConfig !== undefined ? { strictMcpConfig: spec.strictMcpConfig } : {}),
      // WS-E (native-CLI-parity: load plugins from spec): forward the spec's native
      // plugins (SdkPluginConfig[]) verbatim, mirroring how mcpServers/settingSources
      // are threaded. Guard: only set the key when the spec declares plugins so a spec
      // with none omits the option entirely (an omitted plugins loads none — behaves
      // EXACTLY as before), rather than passing an empty [].
      ...(spec.plugins.length > 0 ? { plugins: spec.plugins } : {}),
      // LEAN-AGENT-SKILLS: forwarded whenever the spec has an opinion, and the opinion is usually
      // "none". Unlike plugins above, an OMITTED `skills` is not "no skills" — the SDK's own doc
      // says the CLI defaults still apply — so leaving it off is what loaded ~348 skill
      // descriptions into every prompt. supervisor.ts decides the default; this only carries it.
      ...(spec.skills !== undefined ? { skills: spec.skills } : {}),
      env: claudeEnv,
      // SAFE-1 CACHE-PREFIX: shared instructions precede session-specific role instructions
      // so their prefix can be cached; task bodies and delivery metadata stay in user input.
      // Workspace orientation normally accompanies the initial user input:
      // orientationForSystem is "" on every path except the rare resumeOnly reattach, which
      // has no first user turn to carry it instead). `excludeDynamicSections: true` additionally
      // hands the CLI's OWN dynamic bits (cwd/auto-memory/git status) the identical treatment —
      // stripped from the system block and reinjected as a first-user-turn message by the SDK
      // itself, so the appended system block stays a stable, cross-session-cacheable prefix
      // regardless of which agent, team, or worktree is spawning.
      // AGENT-AUTONOMY: `autonomyLine` is safe to ride this same cached append — unlike
      // orientationText (unique PER SPAWN INSTANCE: worktree path/branch/sha), autonomy is a
      // fixed two-valued spec setting, so it only ever produces two stable prefix variants
      // ("full" / not), each still shared across every agent spawned with that setting — not a
      // per-instance cache-buster.
      systemPrompt: {
        type: "preset", preset: "claude_code", excludeDynamicSections: true,
        ...(spec.instructions || autonomyLine || orientationForSystem || claudeMd
          ? { append: `${spec.instructions ?? ""}${autonomyLine}${orientationForSystem}${claudeMd ? `\n\n${claudeMd}` : ""}` }
          : {}),
      },
      // Native-CLI-parity Phase 2 (DLG2): declare the dialog kinds the SDK CLI may
      // emit — an OMITTED supportedDialogKinds fails closed (no dialog is emitted at all),
      // silently degrading AskUserQuestion/elicitation to no-ops. AGENT-AUTONOMY: deliberately
      // omitted for a "full" autonomy spec — that existing fail-closed behavior IS the
      // mechanism that keeps AskUserQuestion from ever reaching a human who isn't there.
      ...(spec.autonomy === "full" ? {} : { supportedDialogKinds: ["permission_ask_user_question", "elicitation_dialog", "elicitation_url_dialog"] }),
      onUserDialog: async (request: { dialogKind?: string; payload?: Record<string, unknown>; toolUseID?: string }) => {
        if (!decideDialog) return { behavior: "cancelled" as const };
        // DialogDecision is structurally identical to the SDK's UserDialogResult → return verbatim.
        return await decideDialog({
          dialogId: request.toolUseID ?? randomUUID(),
          dialogKind: String(request.dialogKind ?? "unknown"),
          payload: request.payload ?? {},
          toolUseId: request.toolUseID,
        });
      },
      onElicitation: async (request: {
        serverName?: string; message?: string; mode?: string; url?: string; requestedSchema?: unknown;
        title?: string; displayName?: string; description?: string; elicitationId?: string;
      }) => {
        if (!decideDialog) return { action: "cancel" as const };
        const decision = await decideDialog({
          dialogId: request.elicitationId ?? randomUUID(),
          dialogKind: request.mode === "url" ? "elicitation_url_dialog" : "elicitation_dialog",
          payload: { ...request },
          toolUseId: request.elicitationId,
        });
        return decision.behavior === "completed"
          ? { action: "accept" as const, content: (decision.result ?? {}) as Record<string, unknown> }
          : { action: "cancel" as const };
      },
      includePartialMessages: true,                    // Phase 3: token-level streaming for the TUI (kept above providerOptions so it can be overridden)
      // R2 (inline sub-agent/workflow surfacing): by default the SDK only forwards a subagent's
      // tool_use/tool_result blocks (already captured above, unrouted before this feature); this
      // additionally streams the subagent's own TEXT, tagged with the same parent_tool_use_id, so
      // a shadow row can carry a real transcript instead of just task lifecycle summaries. See
      // supervisor.ts's subagentToolUseIndex for where this gets routed. Unconditional, same as
      // includePartialMessages above — kept ahead of providerOptions so a caller can still override it.
      forwardSubagentText: true,
      // RELEASE-T1: the SDK's default resolution finds its vendored native `claude` CLI by
      // resolving a sibling @anthropic-ai/claude-agent-sdk-<platform> package relative to its
      // OWN import.meta.url — which breaks once this module is bundled into a single compiled
      // binary (bun --compile), since that path no longer has a real node_modules tree beside
      // it. A compiled deployment that ships the vendor package's binary alongside chimerad
      // sets this env var to point straight at it; unset in dev, where SDK default resolution
      // already works.
      ...(process.env.CHIMERA_CLAUDE_CLI_PATH ? { pathToClaudeCodeExecutable: process.env.CHIMERA_CLAUDE_CLI_PATH } : {}),
      // AGENT-PROCESS-NOT-REAPED: override the SDK's default local spawn ONLY to add
      // detached:true — everything else (stdio shape, env, cwd, args) matches what the SDK's
      // own ProcessTransport would do. detached is what makes this process its own process
      // GROUP leader (pgid === pid) instead of inheriting the daemon's own pgid, which is the
      // prerequisite for terminateProcessGroup below to ever safely signal `-pid` (the whole
      // group, reaching the MCP children) without also hitting the daemon itself. `signal` is
      // the SDK's own forwarded, delayed abort (fires only after ITS stdin-EOF+grace path) —
      // threading it into Node's spawn({signal}) preserves the SDK's existing best-effort
      // graceful-first behavior; terminateProcessGroup is the separate, BOUNDED backstop for
      // when that best-effort path doesn't finish the job (see its own doc comment).
      // POSIX only: Windows process groups don't support negative-pid signalling the same way,
      // so detached is skipped there and this spawn falls back to the SDK's un-terminated
      // default behavior on that platform — a known, narrower gap left for a follow-up.
      spawnClaudeCodeProcess: (spawnOpts: ClaudeCliSpawnOptions): ClaudeCliSpawnedProcess => {
        const child = spawnChildProcess(spawnOpts.command, spawnOpts.args, {
          cwd: spawnOpts.cwd, env: spawnOpts.env, stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32", signal: spawnOpts.signal,
        });
        cliExited = false;
        cliProcess = child;
        child.stderr?.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });
        child.once("exit", (code) => { cliExitCode = code; if (cliProcess === child) cliExited = true; });
        return child as unknown as ClaudeCliSpawnedProcess;
      },
      ...(claudeSettings ? { settings: claudeSettings } : {}),
      // W2-1 STRUCTURED-RETURNS: verified against pinned SDK 0.3.219's sdk.d.ts — Options.outputFormat
      // accepts { type:'json_schema', schema }; the SDK enforces it server-side (retrying on a
      // non-conforming response) and reports the validated value on the terminal "result" message's
      // `structured_output` field, or fails that message with subtype
      // 'error_max_structured_output_retries' when the model can't satisfy it after retries — read
      // below in the "result" branch. Omitted entirely when unset, byte-identical to before.
      ...(spec.resultSchema ? { outputFormat: { type: "json_schema" as const, schema: spec.resultSchema } } : {}),
      // ADVISOR-TOOL: the CLI only offers its server-side advisor when a model is configured
      // (`--advisor <model>`, alias or full id) and refuses a model that does not support the
      // tool. Passed through extraArgs — the SDK's own escape hatch for CLI flags — rather than
      // as a settings file, so it stays a per-spawn decision and never touches the operator's
      // settings on disk. Spread BEFORE providerOptions so that escape hatch still wins.
      ...(spec.advisorModel ? { extraArgs: { advisor: spec.advisorModel } } : {}),
      ...spec.providerOptions,
    };

    // providerOptions is intentionally the final SDK escape hatch. Validate after its spread so
    // it cannot silently undo the deferral pin.
    const effectiveEnv = options["env"] as NodeJS.ProcessEnv | undefined;
    if (
      !effectiveEnv
      || effectiveEnv["ANTHROPIC_BASE_URL"] !== undefined
      || effectiveEnv["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"] !== undefined
      || effectiveEnv["ENABLE_TOOL_SEARCH"] !== "1"
    ) {
      throw new Error(
        "Claude tool-schema deferral is inactive: ANTHROPIC_BASE_URL and "
        + "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS must be unset and ENABLE_TOOL_SEARCH must be 1",
      );
    }

    // The explicit mode is a first-class choice, not a providerOptions escape hatch.
    if (spec.executionMode) options.permissionMode = spec.executionMode === "plan" ? "plan" : permissionMode;
    const stream = q({ prompt: input as never, options: options as never });
    let killed = false;
    let costUsd = 0;
    // R2: true once the SDK has reported an ACTUAL total_cost_usd number on some message (even
    // 0) — distinguishes "the SDK never reports cost" (fall back to the pricing table) from
    // "the SDK's cost happens to be 0"/omitted-on-this-message (carry the prior value forward,
    // the existing behavior — see the msg.type==="result" branch below).
    let sdkCostSeen = false;
    // R2: best model id seen so far, for the pricing-table fallback — mirrors codex.ts's
    // MODEL-ACTUAL-SURFACE fallback chain (live > spec-pinned > catalog default).
    let resolvedModel: string | undefined = spec.model;
    let lastText = "";
    // W2-1 STRUCTURED-RETURNS: captured off the terminal "result" message only when
    // spec.resultSchema was set — see the outputFormat wiring above. structuredOutputFailed
    // means the SDK exhausted its own conformance retries (subtype
    // 'error_max_structured_output_retries'); that must surface as a terminal `error`, never a
    // "result" carrying an unvalidated/stale lastText.
    let structuredOutput: unknown;
    let structuredOutputFailed = false;
    // TOKEN-OPT-P4: the SDK's "result" message carries a `usage` object (snake_case,
    // e.g. input_tokens/output_tokens/cache_read_input_tokens/cache_creation_input_tokens)
    // — forwarded VERBATIM (never reshaped) so usage.ts's extraction and the raw SDK
    // contract can never drift. Same overwrite-latest discipline as costUsd above: the
    // SDK's own totals are already cumulative for the session, so the last message wins.
    let usage: Record<string, unknown> | undefined;
    // LIVE-CTX-USAGE: the Anthropic API stream's message_start carries the turn's real
    // input/cache token counts UP FRONT (before any output is generated) and message_delta
    // then reports the CUMULATIVE output_tokens as generation proceeds — sunk as "usage"
    // events so the reducer can advance the ctx meter/tokens column live instead of only at
    // turn_complete/result. message_start REPLACES this baseline each turn (a fresh prompt
    // size); message_delta only ever overlays output_tokens on top of it.
    let liveUsage: Record<string, unknown> | undefined;
    // Lifecycle patches/notifications omit the identity supplied at task start.
    const taskMetadata = new Map<string, Record<string, unknown>>();
    // L1-MEASURE (F39): armed by a compact_boundary, consumed by the NEXT real turn's usage
    // snapshot. The price of an SDK compaction is not in the boundary event — it is the full
    // prefix-cache REWRITE the next real call pays (measured 2026-09-02: cache_creation 33,412
    // and 49,409 on the calls after two boundaries, against a 1,107-1,955 steady state). Marking
    // that one call is the only way an audit finds it without guessing which call was "first
    // after". A plain per-spawn let, in the same closure liveUsage lives in: it dies with the spawn.
    let pendingAfterCompaction = false;
    // SOFT-TURN-LIMIT: one SDK "result" message = one completed turn (a
    // turn_complete is emitted for each). turnsCompleted + turnBudgetSignaled are
    // only ever touched under turnLimitPolicy:"soft" — a "fail" spec's SDK-side
    // maxTurns cap means this counter never has a chance to matter.
    let turnsCompleted = 0;
    let turnBudgetSignaled = false;

    // R2-TURN-LIFECYCLE: claude.ts drives the SDK's own streaming AsyncQueue input and has no
    // per-turn AbortController of its own (unlike generic.ts/codex.ts, whose signal is threaded
    // straight into the actual fetch/SDK call) -- interrupt()/kill() below are ALREADY
    // best-effort only (SDK's own stream.interrupt(), which may resolve undefined; kill() just
    // flips a local flag + closes input, it doesn't forcibly terminate a wedged subprocess
    // either). A timeout here gets the SAME best-effort posture, not a shortcut: if the SDK
    // stream never yields another message, the `for await` below can't be forcibly broken from
    // outside (nothing plumbed into `q()`) and just leaks harmlessly in the background -- the
    // `if (killed) break` / `if (!killed) sink(...)` guards throughout mean it can never emit
    // anything further or double-settle the record. Genuine hard-cancel would need restructuring
    // this loop into a manual-iterator Promise.race against the timeout; deferred (see PLAN.md
    // follow-ups) given the regression risk on this heavily-tested file.
    //
    // Watchdog window is armed by armTurn() only when a fresh prompt actually starts being
    // processed -- turn 1 here (already queued before q() was called above) and every
    // subsequent turn from send() below -- and explicitly PAUSED (turnCtl.endTurn()) once a
    // turn's "result" lands and the agent goes idle waiting for the next user input. Arming it
    // unconditionally right after every "result" would tick the idle/max-duration clock down
    // during a conductor/persistent session's ENTIRELY LEGITIMATE wait for the next human
    // message -- indistinguishable from a real hang otherwise.
    const turnCtl = new TurnController({ idleTimeoutMs: spec.idleTimeoutMs, maxDurationMs: spec.maxTurnDurationMs });
    let timedOut = false;
    const armTurn = () => {
      turnCtl.beginTurn((reason) => {
        if (killed || timedOut) return;
        timedOut = true;
        sink({ kind: "turn_timeout", data: { reason, elapsedMs: turnCtl.elapsedMs, idleTimeoutMs: spec.idleTimeoutMs, maxTurnDurationMs: spec.maxTurnDurationMs } });
        killed = true;
        input.close();
        void (stream as { interrupt?: () => Promise<unknown> }).interrupt?.().catch(() => {});
      });
    };
    armTurn();   // covers turn 1, before the loop below starts

    void (async () => {
      try {
        for await (const raw of stream as AsyncIterable<Record<string, unknown>>) {
          if (killed) break;
          turnCtl.heartbeat();
          const msg = raw as { type: string; subtype?: string; [k: string]: unknown };
          if (msg.type === "system" && (msg.subtype === "init" || msg.subtype === "status")
            && ["plan", "default", "acceptEdits", "bypassPermissions", "dontAsk", "auto"].includes(String(msg["permissionMode"]))) {
            activePermissionMode = String(msg["permissionMode"]);
            sink({ kind: "status", data: { executionMode: activePermissionMode === "plan" ? "plan" : activePermissionMode === "auto" ? "auto" : "execute", nativePermissionMode: msg["permissionMode"] } });
          }
          if (msg.type === "system" && msg.subtype === "init") {
            if (typeof msg["model"] === "string") resolvedModel = msg["model"];   // R2: pricing-table fallback chain
            // native-CLI-parity Phase 3 (Task SC1): additive — surface the SDK's slash-command
            // catalog/skills/plugins/auth source alongside the pre-existing sessionId/model.
            // Undefined on older CLIs → simply absent in data; the reducer reads defensively.
            // WS-D: also thread the SDK's mcp_servers (name+status per configured server) so
            // the TUI can surface per-agent MCP connection health read-only. Same defensive
            // contract: undefined on older CLIs → simply absent in data.
            sink({
              kind: "agent_started",
              data: {
                sessionId: msg["session_id"], model: msg["model"],
                // EFFORT: spec-sourced (not SDK-echoed) — unlike model, the SDK's system/init
                // message has no confirmed `effort` echo to prefer, so stamp what chimera asked
                // for. Deterministic for tests/UI regardless of SDK behavior.
                ...(spec.effort ? { effort: spec.effort } : {}),
                slashCommands: msg["slash_commands"], skills: msg["skills"], plugins: msg["plugins"],
                mcpServers: msg["mcp_servers"],
                apiKeySource: msg["apiKeySource"],
              },
              raw,
            });
            // SDK-MODEL-LISTS: supportedModels() just awaits the SAME initialize handshake
            // that produced this system/init message (Query's constructor kicks it off
            // eagerly) — free, no extra round trip, no separate turn. Fire-and-forget: the
            // daemon-wide cache (providers.models's live source for claude) is best-effort
            // and must never block or fail this agent's turn. `?.()` guards a test queryFn
            // stub that doesn't implement the full Query interface (only the real SDK's
            // stream does) — absent ⇒ this whole chain is a no-op, not a throw.
            void stream.supportedModels?.()
              .then((models) => recordProviderModels("claude", models.map((m) => {
                // EFFORT-ONE-SOURCE: supportedEffortLevels/supportsEffort ride on the SAME
                // ModelInfo rows this map already had in hand, and were being discarded right
                // here — so the one authoritative, PER-MODEL answer to "which efforts does this
                // model take" arrived free on every session start and was thrown away, while six
                // hand-written copies of the list drifted in the clients.
                //
                // Both are optional in the SDK's own type and are only populated by a CLI new
                // enough to report them; absent stays absent rather than becoming an empty list,
                // because "none" and "not said" mean different things to the picker.
                const info = m as typeof m & { supportedEffortLevels?: string[]; supportsEffort?: boolean };
                return {
                  value: m.value, displayName: m.displayName,
                  ...(m.description ? { description: m.description } : {}),
                  ...(Array.isArray(info.supportedEffortLevels) && info.supportedEffortLevels.length > 0
                    ? { supportedEfforts: info.supportedEffortLevels }
                    : {}),
                  ...(typeof info.supportsEffort === "boolean" ? { supportsEffort: info.supportsEffort } : {}),
                };
              })))
              .catch(() => {});
          } else if (msg.type === "system" && msg.subtype === "commands_changed") {
            // native-CLI-parity Phase 3 (Task SC1): the SDK's live slash-command list push
            // (SDKCommandsChangedMessage) — REPLACE semantics, mapped verbatim into a new
            // commands_changed event so the TUI (SC2) can render a `/` autocomplete.
            sink({ kind: "commands_changed", data: { commands: msg["commands"] }, raw });
          } else if (msg.type === "system" && msg.subtype === "local_command_output") {
            // native-CLI-parity Phase 3 (Task SC2a): surface a real slash command's output
            // (SDKLocalCommandOutputMessage) via the EXISTING message_complete kind so the
            // reducer renders it in the transcript with no new event kind. role/localCommand
            // are advisory data flags the reducer reads defensively.
            const content = typeof msg["content"] === "string" ? msg["content"] : "";
            sink({ kind: "message_complete", data: { text: content, role: "system", localCommand: true }, raw });
          } else if (msg.type === "system" && msg.subtype === "compact_boundary") {
            // R2 (ctx meter, post-compaction): SDKCompactBoundaryMessage (verified in sdk.d.ts) —
            // the Claude Agent SDK's own auto-compact (COMPACTION-THRESHOLD-CONFIG's autoCompactWindow,
            // or a manual /compact) just ran. compact_metadata.post_tokens, when the SDK supplies it,
            // is the SDK's OWN report of the post-compaction context size — reset the live ctx
            // baseline with it IMMEDIATELY (same "usage" event kind LIVE-CTX-USAGE already uses, so
            // the reducer's existing latest-wins fold picks it up with no new reducer code) instead of
            // waiting for the next turn's message_start, so the meter drops the instant compaction
            // happens rather than one turn late. Absent post_tokens: still report the compaction (so
            // it's visible/auditable) but leave the ctx baseline alone — the next real message_start
            // will report the smaller context naturally (proven by claude's own already-correct
            // "message_start REPLACES the baseline each turn" behavior above), just one turn later.
            // COMPACTION-OBSERVABILITY: normalized cross-backend "compaction" event (protocol
            // EventKindSchema) — this SDK's `trigger: 'auto'|'manual'` maps onto the same
            // "budget"|"manual" vocabulary generic.ts's own chimera-owned compaction uses, so a
            // UI/reducer needs exactly one case for both. owner:"sdk", tokens only (no
            // messages/chars — the SDK never reports those, and its internal compaction
            // mechanism is opaque to chimera, so this never claims "summarized").
            const meta = msg["compact_metadata"] as { trigger?: string; pre_tokens?: number; post_tokens?: number } | undefined;
            sink({
              kind: "compaction",
              data: {
                trigger: meta?.trigger === "manual" ? "manual" : "budget",
                owner: "sdk",
                // L1-MEASURE (F39): what this compaction fired AGAINST, so an audit never has to
                // re-derive the threshold from a spawn record that may already be pruned. `null`
                // is the honest value for a native SDK trigger with no chimera threshold —
                // omitting the key would be indistinguishable from an event written before this
                // field existed. `model` is the model the SDK REPORTED (resolvedModel, i.e.
                // system/init's model then any live /model change), never spec.model: supervisor
                // .onEvent sniffs `data.model` on every event kind to keep actualModel and the
                // ctx-meter denominator live, so echoing a requested alias here would overwrite
                // the served model on every compaction.
                thresholdInForce: spec.compactionThreshold ?? null,
                thresholdSource: spec.compactionThresholdSource ?? "native",
                ...(resolvedModel ? { model: resolvedModel } : {}),
                provider: spec.resolvedProvider,
                ...(typeof meta?.pre_tokens === "number" ? { before: { tokens: meta.pre_tokens } } : {}),
                ...(typeof meta?.post_tokens === "number" ? { after: { tokens: meta.post_tokens } } : {}),
              },
              raw,
            });
            if (typeof meta?.post_tokens === "number") {
              liveUsage = { input_tokens: meta.post_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
              // L1-MEASURE (F39): NOT an API call. This event exists only to reset the live ctx
              // meter (R2, above) to the SDK's own post-compaction reading. A ledger that sums
              // `usage` bills post_tokens at the FULL fresh-input rate — measured 2026-09-02: 7
              // such events, 103,480 phantom input tokens — and that error scales with exactly
              // what a lower threshold produces. The marker is how a ledger excludes it without
              // pattern-matching a read==0/write==0/output==0 signature a real cache-cold call
              // also produces.
              sink({ kind: "usage", data: { usage: liveUsage, synthetic: "compaction-baseline" } });
            }
            pendingAfterCompaction = true;   // armed AFTER the synthetic sink — the marker belongs on the next REAL call
          } else if (msg.type === "rate_limit_event") {
            // ACCOUNT-QUOTA-METERS: see normalizeClaudeRateLimit's doc comment for the field
            // mapping/derivation and the Phase 0 sourcing rationale. Silently no-ops when the
            // event doesn't map to a renderable session/weekly window (e.g. "overage").
            const info = msg["rate_limit_info"] as Record<string, unknown> | undefined;
            const window = normalizeClaudeRateLimit(info);
            if (window) sink({ kind: "quota", data: { window }, raw });
            // EXTRA-USAGE-VISIBILITY: emitted SEPARATELY from the window, because the case that
            // matters is a rejected window with usable overage — where there is no window to
            // attach it to.
            const overage = normalizeClaudeOverage(info);
            if (overage) sink({ kind: "quota", data: { overage }, raw });
          } else if (msg.type === "assistant") {
            // Task AUTH-a: surface an AUTH-subtype SDK error as a status event so the
            // supervisor can mark the account authExpired. Other subtypes (rate_limit,
            // billing_error, ...) are NOT auth problems — ignored here, no behavior change.
            const errSubtype = msg["error"];
            if (typeof errSubtype === "string" && AUTH_ERROR_SUBTYPES.has(errSubtype)) {
              sink({ kind: "status", data: { authError: errSubtype }, raw });
            }
            const assistantMessage = msg["message"] as { content: Array<Record<string, unknown>>; model?: unknown };
            const content = assistantMessage.content ?? [];
            // MODEL-LIVE: the API message names the model that actually produced it —
            // forward it on message_complete so the UI's model chip tracks an
            // IN-SESSION model change (the SDK's /model command never passes
            // through agent.setModel, so agent_started's model goes stale).
            const liveModel = typeof assistantMessage.model === "string" ? assistantMessage.model : undefined;
            if (liveModel) resolvedModel = liveModel;   // R2: pricing-table fallback chain — most authoritative
            // R2 (inline sub-agent/workflow surfacing): a non-null parent_tool_use_id marks this
            // WHOLE message as having originated inside a subagent's own turn (forwarded only when
            // forwardSubagentText is set below) — read once per message, not per block, since the
            // SDK stamps it at the message level. Conditional spread: a top-level message's
            // parent_tool_use_id is null, so this key stays OMITTED and message_complete.data is
            // byte-identical to before this change for every existing (non-subagent) caller.
            const parentToolUseId = (msg as Record<string, unknown>)["parent_tool_use_id"];
            const parentToolUseIdField = typeof parentToolUseId === "string" ? { parentToolUseId } : {};
            for (const block of content) {
              if (block["type"] === "text") sink({ kind: "message_complete", data: { text: block["text"], ...(liveModel ? { model: liveModel } : {}), ...parentToolUseIdField }, raw });
              else if (block["type"] === "tool_use") {
                sink({
                  kind: "tool_call",
                  data: {
                    toolName: block["name"],
                    input: block["input"],
                    toolUseId: block["id"],
                    // WD Stage 1 (coverage B4): `toolId` is the ui-state reducer's
                    // correlation key (its tool_result strict-match reads data.toolId on
                    // BOTH sides) — stamped alongside the pre-existing toolUseId, and only
                    // when the SDK actually supplied an id (conditional spread so an
                    // id-less block's data stays byte-identical).
                    ...(typeof block["id"] === "string" ? { toolId: block["id"] } : {}),
                    parentToolUseId: (msg as Record<string, unknown>)["parent_tool_use_id"] ?? null,
                    // TURN-COST-VISIBLE: the assistant message these blocks arrived on. Tool calls
                    // sharing one id were emitted in ONE model turn and cost ONE context read;
                    // consecutive calls with different ids each cost their own. The transcript
                    // collapses both into the same "Bash x3" strip, so without this the operator
                    // cannot see the difference — and it is the difference that costs money.
                    ...(typeof (msg["message"] as { id?: unknown } | undefined)?.id === "string"
                      ? { turnId: (msg["message"] as { id: string }).id } : {}),
                  },
                  raw,
                });
              }
            }
          } else if (
            msg.type === "system" &&
            (msg.subtype === "task_started" || msg.subtype === "task_progress" || msg.subtype === "task_updated" || msg.subtype === "task_notification")
          ) {
            // native-CLI-parity Phase 1 (Task N1): additive mapping of the SDK's subagent/workflow
            // task lifecycle messages into a chimera-native agent_task event. Read every SDK field
            // defensively — older CLIs may omit any of them.
            const m = msg as Record<string, unknown>;
            const patch = (m["patch"] ?? {}) as Record<string, unknown>;
            const identity: Record<string, unknown> = { ...taskMetadata.get(String(m["task_id"])) };
            for (const key of ["task_type", "subagent_type", "workflow_name", "is_backgrounded", "skip_transcript", "ambient"]) {
              if (m[key] !== undefined) identity[key] = m[key];
              if (patch[key] !== undefined) identity[key] = patch[key];
            }
            if (typeof m["task_id"] === "string") {
              taskMetadata.set(m["task_id"], identity);
              if (taskMetadata.size > 4096) taskMetadata.delete(taskMetadata.keys().next().value!);
            }
            const nativeStatus = msg.subtype === "task_notification" ? m["status"]
              : msg.subtype === "task_updated" ? patch["status"] : "running";
            const usage = m["usage"] as { total_tokens?: number; tool_uses?: number; duration_ms?: number } | undefined;
            sink({
              kind: "agent_task",
              raw,
              data: {
                taskId: m["task_id"],
                toolUseId: m["tool_use_id"],
                subagentType: identity["subagent_type"],
                taskType: identity["task_type"],
                // BACKGROUND-TASK-VISIBILITY: distinguishes a script the agent kicked off and
                // walked away from (which needs its own live row) from one the spawning tool call
                // is still blocking on (already visible as that tool call).
                isBackgrounded: identity["is_backgrounded"],
                workflowName: identity["workflow_name"],
                description: m["description"] ?? patch["description"],
                // Normalize stopped to the existing terminal state shared with task_updated.
                status: nativeStatus === "stopped" ? "killed" : nativeStatus,
                error: patch["error"] ?? (nativeStatus === "failed" ? m["summary"] : undefined),
                skipTranscript: identity["skip_transcript"],
                ambient: identity["ambient"],
                lastToolName: m["last_tool_name"],
                summary: m["summary"],
                usage: usage
                  ? { totalTokens: usage.total_tokens, toolUses: usage.tool_uses, durationMs: usage.duration_ms }
                  : undefined,
              },
            });
          } else if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
            // Malformed data is not an empty live set. Keep unknown task types out
            // of the script list; real subagents already have their own rows.
            if (Array.isArray(msg["tasks"])) {
              sink({ kind: "background_tasks", raw, data: { tasks: msg["tasks"]
                .filter((task: any) => task && typeof task.task_id === "string" && task.ambient !== true
                  && (task.task_type === "local_bash" || task.task_type === "mcp_task"))
                .map((task: any) => ({ taskId: task.task_id, taskType: task.task_type, description: task.description })) } });
            }
          } else if (msg.type === "user") {
            // WD Stage 1 (coverage B4, tool detail card): a user-role SDK message is the
            // tool-result carrier — its message.content holds tool_result blocks
            // ({ type:"tool_result", tool_use_id, content, is_error }). Carry each
            // block's TEXT (bounded, see tool-result.ts) as data.result plus its
            // tool_use_id as data.toolId (the reducer's correlation key), one
            // tool_result event PER BLOCK so parallel tool calls resolve to the right
            // transcript items. A user message with NO tool_result blocks (e.g. an
            // injected user turn echo) keeps the historical single empty-data event —
            // byte-identical to the pre-Stage-1 shape.
            const content = (msg["message"] as { content?: unknown } | undefined)?.content;
            const blocks = Array.isArray(content)
              ? (content as Array<Record<string, unknown>>).filter((b) => b && b["type"] === "tool_result")
              : [];
            // R2 (inline sub-agent/workflow surfacing): same message-level parent_tool_use_id read
            // as the assistant branch above — a subagent's own tool_result blocks share ONE
            // parent_tool_use_id (the message they arrived on), conditionally spread onto every
            // block so a top-level tool_result's data stays byte-identical to before this change.
            const userParentToolUseId = (msg as Record<string, unknown>)["parent_tool_use_id"];
            const userParentToolUseIdField = typeof userParentToolUseId === "string" ? { parentToolUseId: userParentToolUseId } : {};
            if (blocks.length === 0) {
              sink({ kind: "tool_result", data: {}, raw });
            } else {
              for (const b of blocks) {
                const text = toolResultText(b["content"]);
                sink({
                  kind: "tool_result",
                  data: {
                    ...(typeof b["tool_use_id"] === "string" ? { toolId: b["tool_use_id"] } : {}),
                    ...(text !== "" ? { result: text } : {}),
                    ...toolResultImageFields(b["content"]),
                    ...(b["is_error"] === true ? { isError: true } : {}),
                    ...userParentToolUseIdField,
                  },
                  raw: withoutRawImages(raw),
                });
              }
            }
          } else if (msg.type === "stream_event") {
            const ev = msg["event"] as {
              type?: string; delta?: { type?: string; text?: string };
              message?: { usage?: Record<string, unknown> }; usage?: Record<string, unknown>;
            } | undefined;
            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
              sink({ kind: "message_delta", data: { text: ev.delta.text }, raw });
            } else if (ev?.type === "message_start" && ev.message?.usage && typeof ev.message.usage === "object") {
              // LIVE-CTX-USAGE (a): turn start — the real context size for THIS turn, before
              // any output token exists yet.
              liveUsage = ev.message.usage;
              // L1-MEASURE (F39): the compaction latch is consumed HERE and only here. The
              // message_delta sink below re-emits this same turn's input/cache numbers, so
              // marking it too would report one compaction's rewrite as many.
              const afterCompaction = pendingAfterCompaction ? { afterCompaction: true } : {};
              pendingAfterCompaction = false;
              sink({ kind: "usage", data: { usage: liveUsage, ...afterCompaction }, raw });
            } else if (ev?.type === "message_delta" && ev.usage && typeof ev.usage === "object" && liveUsage) {
              // LIVE-CTX-USAGE (b): output_tokens ticks up during generation; input/cache
              // stay pinned to the message_start baseline (message_delta never repeats them).
              liveUsage = { ...liveUsage, ...ev.usage };
              sink({ kind: "usage", data: { usage: liveUsage }, raw });
            }
          } else if (msg.type === "result") {
            const isErrorResult = msg["is_error"] === true;
            if (typeof msg["total_cost_usd"] === "number") sdkCostSeen = true;   // R2: SDK IS authoritative when present
            costUsd = Number(msg["total_cost_usd"] ?? costUsd);
            if (msg.subtype === "success") lastText = String(msg["result"] ?? lastText);
            // W2-1 STRUCTURED-RETURNS: only meaningful when outputFormat was set above.
            if (msg.subtype === "error_max_structured_output_retries") structuredOutputFailed = true;
            if (msg["structured_output"] !== undefined) structuredOutput = msg["structured_output"];
            if (msg["usage"] && typeof msg["usage"] === "object") usage = msg["usage"] as Record<string, unknown>;
            turnsCompleted++;
            // SOFT-TURN-LIMIT: fire once, the first time the running turn count
            // reaches the spec's NOMINAL budget — a status event (not a terminal
            // one), so the agent stays "running" and the UI can flag it.
            if (spec.turnLimitPolicy === "soft" && !turnBudgetSignaled && turnsCompleted >= spec.maxTurns) {
              turnBudgetSignaled = true;
              sink({ kind: "status", data: { turnBudgetExceeded: true, turnsCompleted, turnBudget: spec.maxTurns } });
            }
            // TURN-LIMIT-SILENT-STOP: under the default "fail" policy the SDK ENDS THE TURN
            // at maxTurns (subtype error_max_turns, typically mid-tool-use) — and for a
            // conductor/persistent agent, whose input stays open, that is NOT terminal: the
            // record stays "running" and nothing anywhere told the operator why the agent
            // suddenly went quiet mid-task. Name it. Never fires under "soft" (the SDK is
            // given the SOFT_TURN_CAP sentinel, so it has no cap to hit).
            if (msg.subtype === "error_max_turns") {
              sink({ kind: "status", data: {
                turnLimitStop: true,
                turnsCompleted: Number(msg["num_turns"] ?? turnsCompleted),
                turnBudget: spec.maxTurns,
              } });
            }
            // CTX-BASIS-PERTURN: forward the PER-TURN usage (liveUsage — the current turn's real
            // prompt+output from message_start/delta), NOT the SDK "result" message's `usage`, which
            // is CUMULATIVE for the whole session (TOKEN-OPT-P4 above). The cumulative cache_read grows
            // unbounded across a long session, so using it as the ctx basis reads far past the context
            // window (the "3.8M/200k → pinned 100%" bug). liveUsage's message_start baseline is the
            // live prompt size (≤ window), mirroring codex.ts's lastTurnUsage + generic.ts's
            // current-request usage so the ctx meter is per-turn uniformly across providers. Falls back
            // to the cumulative `usage` only when this run produced no message_start baseline (no
            // streaming). Cost is unaffected — it rides turnCostUsd / claudeCostUsage(usage) (cumulative).
            const turnUsage = liveUsage ?? usage;
            // LEDGER-UNCLEAN-EXIT: additionally carry the CUMULATIVE session usage (`usage`, the
            // same scope turnCostUsd/finalCostUsd are computed over — never turnUsage/liveUsage,
            // which is per-turn) so a run killed before its terminal "result" still has an
            // authoritative cost snapshot supervisor.ts can flush to the ledger instead of losing
            // it. Additive field; existing turn_complete consumers (ctx meter) read `usage`
            // (turnUsage) unchanged.
            sink({ kind: "turn_complete", data: { turnCostUsd: msg["total_cost_usd"], ...(turnUsage ? { usage: turnUsage } : {}), ...(usage ? { billableUsage: usage } : {}), ...(isErrorResult ? { errorResult: true as const } : {}) }, raw });
            if (input.isEmpty() && !spec.conductor && !spec.persistent) input.close();   // one-shot: end after idle turn; conductors/persistent workers stay open
            // Input stays open for a conductor/persistent agent, so the SDK query stream never
            // terminates and never throws this error — the agent would absorb a session/rate
            // limit as a normal turn and idle forever on a capped account. Surfacing it here
            // routes it into the same onError failover every one-shot agent already gets.
            // Deliberately NOT emitted on the close path: the SDK throws there, and a second
            // onError would stamp two cooldowns and launch a duplicate process.
            //
            // CONDUCTOR-FAIL-REGRESSION: gated on RATE-LIMIT CLASS, not on is_error alone.
            // is_error is true for any failed turn, and onError hard-fails every class it can't
            // route (state="failed"). An un-gated emit therefore KILLED a conductor on the first
            // ordinary turn error — strictly worse than the silent idle it replaced, and observed
            // doing exactly that (agent dc267a57 died on a result with is_error true and NO text,
            // classified "unknown"). Only a limit is actionable here, because only a limit has a
            // failover disposition; every other class keeps the pre-existing swallow-and-idle
            // behaviour, which never killed a long-lived agent.
            else if (isErrorResult && classifyError(String(msg["result"] ?? "")) === "rate-limit") {
              sink({ kind: "error", data: { message: String(msg["result"]) } });
            }
            // R2-TURN-LIFECYCLE: pause the watchdog while idle between turns -- send() below
            // re-arms it the moment a fresh prompt actually starts. If a next input is ALREADY
            // queued (rare; the supervisor normally waits for turn_complete before delivering
            // the next mailbox message), it starts unwatched until whatever queues after it --
            // an accepted, narrow gap rather than firing on genuine "waiting for a human" idle.
            else turnCtl.endTurn();
          } else if (msg.type === "system") {
            // NOTHING-SILENTLY-DROPPED: the forward-compatible catch-all codex.ts and kimi.ts both
            // already have, and this backend did not. The SDK emits ~40 system subtypes; the
            // branches above map a handful and every other one fell off the end of this chain and
            // vanished. LAST in the chain on purpose — each specific branch above still claims its
            // own subtype first; this only ever sees what nothing else wanted.
            //
            // The gap was not cosmetic. `api_retry` is how the CLI says it is retrying a failed
            // request — without it a retry is indistinguishable from a hang. `hook_started`/
            // `hook_progress`/`hook_response` are hook execution, `background_tasks_changed` is a
            // backgrounded shell, `error`/`error_during_execution` are errors, and `status`/
            // `informational` are the CLI's own notices. None of it reached the transcript.
            //
            // Passed through as a generic `status` carrying the subtype and the raw payload rather
            // than mapped one subtype at a time: a per-subtype mapping would be a claim about a
            // shape written without observing it, while passing it through claims only that the
            // SDK said something — which is true, and is exactly what was missing.
            sink({ kind: "status", data: { sdkEvent: String(msg.subtype ?? "system") }, raw });
          }
        }
        // R2: prefer the SDK's own authoritative cost (already cumulative for the session, per
        // the TOKEN-OPT-P4 comment above); fall back to the pricing table only when the SDK
        // NEVER reported total_cost_usd on any message this run (e.g. a stream shape the table
        // doesn't cover) — computeCostUsd's null (unpriced model) leaves costUsd at its last
        // value (0 if genuinely never set) rather than fabricating a number.
        const finalCostUsd = sdkCostSeen ? costUsd
          : (computeCostUsd(claudeCostUsage(usage), resolvedModel ?? findProvider("claude")?.defaultModel, this.deps.modelCatalog?.()) ?? costUsd);
        // CTX-BASIS-PERTURN: the forwarded usage is per-turn (liveUsage) for the ctx meter/tokens
        // display — same rationale as turn_complete above; cost already used the cumulative `usage`.
        const resultUsage = liveUsage ?? usage;
        // TOKEN-OPT-P0-1: the terminal "result" event used to sink ONE `usage` field
        // (resultUsage, per-turn) alongside a CUMULATIVE costUsd — a scope mismatch: usage.ts's
        // ledger paired a whole-run cost with a last-request token snapshot, undercounting
        // cache-read by however many turns the run actually made. Now both scopes ride
        // explicitly: billableUsage (the SDK's cumulative `usage`, the SAME totals finalCostUsd
        // was computed over) for cost/ledger accounting, contextUsage (resultUsage, per-turn)
        // for the ctx-window meter — never conflate the two again.
        // P0-2 MODEL-ATTR: stamp the RESOLVED model (system/init's model, refreshed by any
        // later message's live model — same resolvedModel the cost fallback above already
        // trusts) on the terminal result too, so the ledger's resolveContext chain can prefer
        // this per-event value over the record's last-known actualModel.
        if (!killed && structuredOutputFailed) {
          // W2-1 STRUCTURED-RETURNS: the SDK's own conformance retries were exhausted — an
          // unvalidatable result is an error, never a "result" carrying stale/prose text.
          sink({ kind: "error", data: { message: "structured output validation failed: model could not produce a result matching resultSchema after the SDK's own retries" } });
        } else if (!killed) {
          sink({
            kind: "result",
            data: {
              // W2-1 STRUCTURED-RETURNS: when resultSchema forced structured output, `text` carries
              // the same value serialized (every existing consumer reads `text`); structuredOutput
              // carries the parsed object for schema-aware consumers (e.g. agent.result).
              text: structuredOutput !== undefined ? JSON.stringify(structuredOutput) : lastText,
              costUsd: finalCostUsd,
              // F50 BUDGET-COVERAGE: when the SDK reported total_cost_usd the figure is a real
              // provider measurement; the pricing-table fallback above is not, and the budget
              // governor must be able to tell the two apart.
              ...(sdkCostSeen ? {} : { costEstimated: true }),
              ...(resolvedModel ? { model: resolvedModel } : {}),
              ...(usage ? { billableUsage: usage } : {}),
              ...(resultUsage ? { contextUsage: resultUsage } : {}),
              ...(structuredOutput !== undefined ? { structuredOutput } : {}),
            },
          });
        }
      } catch (err) {
        if (!killed) {
          // AGENT-FAILURE-REACHES-CONDUCTOR: fold the captured stderr tail into the surfaced
          // error — this is exactly the gap that produced a bare "exited with code 1" with no
          // diagnosable cause. exitCode/stderrTail also ride as separate fields so the supervisor
          // can carry them structurally into its status event/mailbox notification (onError ->
          // markFailed) instead of a caller having to re-parse them out of the message text.
          const tail = stderrTail.trim();
          const message = tail ? `${(err as Error).message}: ${tail}` : (err as Error).message;
          sink({
            kind: "error",
            data: {
              message,
              ...(cliExitCode !== null ? { exitCode: cliExitCode } : {}),
              ...(tail ? { stderrTail: tail } : {}),
            },
          });
        }
      } finally {
        turnCtl.endTurn();
        // LATE-MESSAGE-RESUME: the SDK's own iteration has ended for good (one-shot close
        // above, a kill, or an error/natural end) — a conductor/persistent spec's input is
        // otherwise NEVER closed on our side, so a send() arriving after this point would
        // silently queue into `input.items` with nothing left to ever drain it. Closing here
        // unconditionally (idempotent — AsyncQueue.close() is a no-op if already closed) makes
        // every post-settle send() reject instead, which deliverBatch's catch re-enqueues.
        input.close();
        // AGENT-PROCESS-NOT-REAPED: enforce OS-level termination regardless of WHY the loop
        // ended (natural "result", an error, kill(), or turn_timeout). A happy-path natural
        // finish is supposed to already exit the CLI on its own (stdin EOF -> the SDK's own
        // grace window) but measured evidence — terminal AgentRecords whose CLI process + MCP
        // children were still alive DAYS later — shows that doesn't always happen; this is the
        // backstop that guarantees it within processTerminationGraceMs regardless. No-ops when
        // cliProcess is null (every existing fake-queryFn test, which never calls
        // spawnClaudeCodeProcess, so this is byte-identical behavior for them).
        if (cliProcess) terminateProcessGroup(cliProcess, { graceMs: this.deps.processTerminationGraceMs });
      }
    })();

    return withMessageInput({
      get processPid() { return cliExited ? null : cliProcess?.pid ?? null; },
      send: async (text: string, images?: Image[], content?: ContentBlock[], delivery?: AgentDelivery) => {
        input.push(userMessage(text, images, delivery ? deliveryContent(text, images, content, delivery) : content));
        armTurn();   // R2-TURN-LIFECYCLE: a fresh prompt is now in flight — (re)arm the watchdog
      },
      setExecutionMode: async (mode, profile) => {
        if (killed) throw new Error("Claude session is no longer running");
        if (typeof stream.setPermissionMode !== "function") throw new Error("This Claude SDK cannot change planning mode live");
        const nativeMode = mode === "execute" ? executionPermissionMode(profile) : mode;
        await stream.setPermissionMode(nativeMode);
        activePermissionMode = nativeMode;
      },
      validateSlash: async (text: string) => {
        const name = /^\/(\S+)/.exec(text.trim())?.[1];
        const commands = await stream.supportedCommands();
        if (!name || !commands.some(command => command.name === name)) throw new Error(`/${name ?? ""} is not available in this Claude SDK session. Select a command from the / menu; terminal-only commands require Claude Code. Nothing was sent as a prompt.`);
      },
      // SDK interrupt() resolves { still_queued: string[] } | undefined (the
      // receipt payload needs Claude Code >= 2.1.205; older CLIs resolve
      // undefined) — the result is intentionally ignored here.
      interrupt: async () => { await (stream as { interrupt?: () => Promise<unknown> }).interrupt?.(); },
      kill: async () => {
        killed = true;
        input.close();
        // AGENT-PROCESS-NOT-REAPED: bounded — a wedged interrupt() RPC must never block kill()
        // itself indefinitely, since supervisor.suspendForShutdown() awaits every running
        // agent's kill() in turn; an unbounded await here is exactly what let one stuck agent
        // hang the daemon's ENTIRE shutdown forever (see main.ts's shutdown(), no timeout of
        // its own around suspendForShutdown()). terminateProcessGroup below is the real
        // guarantee of termination; this is just a short best-effort window to let a healthy
        // CLI respond to the graceful ask before its process group gets signalled anyway.
        await Promise.race([
          (async () => { await (stream as { interrupt?: () => Promise<unknown> }).interrupt?.().catch(() => {}); })(),
          new Promise<void>((resolve) => setTimeout(resolve, 1000).unref?.()),
        ]);
        if (cliProcess) terminateProcessGroup(cliProcess, { graceMs: this.deps.processTerminationGraceMs });
      },
      close: async () => { input.close(); },
      // REMOTE-CONTROL: `enableRemoteControl` is a REAL control-request method the CLI
      // implements today (subtype "remote_control", verified empirically against a live
      // session — see docs/superpowers/design-plans/REMOTE-CONTROL.md) sitting right next
      // to setModel/applyFlagSettings in the SDK's internal Query class, but it is NOT
      // declared on the public `Query` type in sdk.d.ts yet. No respawn needed: the CLI
      // starts/stops the claude.ai/code bridge on the LIVE session and hands back the
      // attach URL. Cast defensively so an older CLI/SDK build that lacks the method
      // fails with a clear error instead of a silent no-op.
      remoteControl: async (enable: boolean, name?: string): Promise<RemoteControlHandleResult> => {
        const fn = (stream as {
          enableRemoteControl?: (enabled: boolean, name?: string) => Promise<{ session_url?: string; connect_url?: string } | undefined>;
        }).enableRemoteControl;
        if (!fn) throw new Error("this Claude Agent SDK/CLI build has no enableRemoteControl control request");
        const result = await fn.call(stream, enable, name);
        return result ? { sessionUrl: result.session_url, connectUrl: result.connect_url } : undefined;
      },
      // MANUAL-COMPACT-ANY-PROVIDER: this SDK owns compaction, so chimera cannot perform it —
      // but the CLI behind the SDK takes `/compact` as a user turn exactly like the native
      // interactive session does, and reports the result back through the compact_boundary
      // handler above with trigger:"manual". That handler predates this: the "manual" branch
      // existed for a trigger nothing in chimera could yet pull.
      compactCommand: "/compact",
    });
  }
}
