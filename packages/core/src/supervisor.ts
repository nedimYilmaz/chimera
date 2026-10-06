import { createMessage, deliverAgentInput, UnsupportedContentError } from "./message-delivery.js";
import { randomUUID } from "node:crypto";
import { parseCodexCommand } from "./backends/codex-commands.js";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { AgentSetGroupsParamsSchema, AgentSpecSchema, ATTENTION_EVENT_KINDS, parseAgentAddress, effectiveContextLimitFor, clampCompactionThresholdForProvider, type Principal, type AccountQuotaWindow, type AgentSpec, type CompactResult, type EffortLevel, type ModelMetadataLookup, type CodexContextLimits, type QuestionAnswer, type QuestionOption, type QuestionDefault, type RemoteControlStatus, type DynamicCapConfig, type ExplainCheck, type WorktreeSetupHook, type AgentSendResult, type PromptStall, type FailureDisposition, type UsageScope } from "@chimera/protocol";
import type { DynamicCapTracker } from "./dynamic-cap.js";
import type { EngineToolName } from "@chimera/protocol/engine-help";
import { ConfigError, type AccountRegistry } from "./accounts.js";
import { redact, type CredentialResolver } from "./credentials.js";
import type { AgentBackend, AgentHandle, BackendEvent, CompactionThresholdSource, ContentBlock, DialogDecision, DialogRequest, Image, PermissionRequest, ResolvedAgentSpec } from "./backend.js";
import type { EventLog } from "./events.js";
import { summarizeTransferContext } from "./context-transfer.js";
import type { MailboxStore, MailboxMessage } from "./mailbox.js";
import { classifyFailure, dispositionFor, parseSessionLimit, computeBackoffMs, isStaleResumeSessionError, DEFAULT_CRASH_LOOP_POLICY, type CooldownTracker, type CrashLoopPolicy, type QuotaTracker } from "./failover.js";
import { defaultEffortForRole } from "./effort-policy.js";
import { parseBashTargets, detectDestructiveBash, findMainNodeModulesWrite, findMainSourceWrite, bashWriteTargets, editToolTargetPath, realishPath, classifyCloudMutation, isLandingBash, isReadOnlyBash, looksUnresolvedProfile, hostToolDenialMessage, mcpToolDenialMessage } from "./hosttools.js";
import type { CapabilityBroker } from "./broker.js";
import type { AuditLedger } from "./audit-ledger.js";
import { OUTPUT_COMPONENTS_CHEATSHEET } from "./output-components.js";
import { MAX_TIMER_DELAY_MS } from "./timers.js";
import { autoCommitDirtyWorktree, checkWorktreeUnlanded, ensureWorkdir, removeWorktree, resolveWorkdirPath, worktreePath } from "./workdir.js";
import { runWorktreeSetup } from "./worktree-setup.js";
import type { WorktreeWriteCaller } from "./worktree-lease.js";
import { buildHandoffPackage } from "./handoff-package.js";
// GuardrailError lives in errors.ts (zero-dependency, bootstrap-safe — see that file's header),
// not defined here; re-exported so existing `import { GuardrailError } from
// "@chimera/core/supervisor"` call sites across the codebase keep working unchanged.
import { GuardrailError } from "./errors.js";
export { GuardrailError } from "./errors.js";
import { BudgetDeniedError, estimateEffectiveSpendUsd, meterTurnCost, usageFromRaw } from "./budget.js";
import { findProvider } from "./providers/catalog.js";
import { parseWorkflowTranscriptRef } from "./rpc/workflow-inspect.js";
import { SentenceChunker } from "./voice-tts.js";
import { PromptAckWatch, PROMPT_STALL_MS } from "./prompt-ack.js";
import { isTurnOpening } from "./turn-kinds.js";

// Tool schemas carry the catalog. Keep only discovery and cross-tool policy here;
// repeating the catalog on every spawn adds context without adding capabilities.
export const CAPABILITY_BLOCK_TOOLS = {
  chimeraTools: "chimera_tools", chimeraCall: "chimera_call",
  mcpStoreTools: "mcp_store_tools", mcpStoreCall: "mcp_store_call",
} as const satisfies Record<string, EngineToolName>;

// Operator messages need no attribution; peer messages retain their sender identity.
const OPERATOR_SENDERS: ReadonlySet<string> = new Set(["app", "tui", "caller", "external", "operator"]);

export function buildCapabilityBlock(opts: { skillsUsable?: boolean; provider?: string } = {}): string {
  const t = CAPABILITY_BLOCK_TOOLS;
  // Only Claude has this Skill allowlist. Other providers must not be promised a
  // Claude-specific tool, or told that their native skill discovery is disabled.
  const skills = opts.provider !== undefined && opts.provider !== "claude" ? ""
    : opts.skillsUsable === false ? "\nSkill tool is off; read a relevant SKILL.md from project/user skill directories when needed." : "";
  return `CHIMERA TOOLS
Discover unlisted tools with ${t.chimeraTools}; invoke them with ${t.chimeraCall}. Other services (including browser/desktop): ${t.mcpStoreTools}/${t.mcpStoreCall}. Reuse discovered schemas.
Use Chimera tools before provider-native MCP; use a native fallback only if discovery finds no suitable tool, and report the gap. A denial, busy desktop lease, timeout or connection error is not a missing tool: resolve or report it, never bypass it. Keep desktop actions on Chimera; never access the daemon socket directly.
Batch independent tool calls. Keep messages focused on outcomes; do not copy these shared instructions into roles or task briefs.${skills}`;
}

// AGENT-RECONFIGURE: the spec fields a live agent can be respawned-into-its-own-session with.
// Deliberately an ALLOWLIST: AgentSpec carries identity and workspace facts beside its settings,
// and a patch that reached those would silently mean something other than "change this setting".
export const RECONFIGURABLE_KEYS = [
  "model", "effort", "account", "acknowledgeCodexFullAccessRisk",
  "maxTurns", "turnLimitPolicy", "maxBudgetUsd", "compactionThreshold", "contextWindow",
  "instructions", "autonomy", "orchestration", "loadSettings",
] as const;
export const RECONFIGURABLE: ReadonlySet<string> = new Set(RECONFIGURABLE_KEYS);
export type AgentSpecPatch = Partial<Pick<AgentSpec, (typeof RECONFIGURABLE_KEYS)[number]>> & Record<string, unknown>;

// The fields that look reconfigurable and are not. Each names what DOES change it, because
// "cannot" without "instead, do this" is where an operator gives up and respawns by hand.
const UNRECONFIGURABLE: Record<string, string> = {
  provider: "a session id belongs to one provider; use agent_handoff to move the context to a new one",
  isolation: "its worktree is already materialised; use agent_rebind to move the agent to a different workspace",
  cwd: "use agent_rebind, which also handles the worktree the agent is standing in",
  conductor: "fixed at spawn — it is what the agent IS, not a setting it has",
  session: "fixed at spawn — it is what the agent IS, not a setting it has",
};

// WORKFLOW-FIX-READONLY-ISOLATION: AgentSpecSchema's isolation field defaults to "worktree"
// unconditionally — fine for acceptEdits/full agents (they mutate files, need their own
// checkout), but a readOnly helper never touches disk and materializing one per spawn just
// orphans worktrees once the agent finishes. Resolve isolation:"none" for readOnly specs, but
// ONLY when the caller left isolation unset entirely: the schema's own .default() erases
// "explicit vs. defaulted" once .parse() runs, so the explicitness check must happen against
// the raw, pre-parse input. An explicit isolation:"worktree" on a readOnly spec still wins.
export function resolveAgentSpec(input: unknown): AgentSpec {
  const explicitIsolation = typeof input === "object" && input !== null
    && "isolation" in (input as Record<string, unknown>)
    && (input as Record<string, unknown>)["isolation"] !== undefined;
  let spec = AgentSpecSchema.parse(input);
  // A conductor is an interactive, multi-turn session by contract. Normalize it onto the
  // shared persistent-session bit at the one spawn entry every UI/RPC/MCP path traverses, so
  // backend implementations cannot accidentally treat a standalone conductor as one-shot.
  if (spec.conductor && !spec.persistent) spec = { ...spec, persistent: true };
  // SESSION-IS-A-CHAT-NOT-A-TASK: an ad-hoc session is an interactive, multi-turn seat by the
  // same contract a conductor is — it is opened to work WITH, and the operator decides when it
  // is finished (which is why the list keeps a finished session's row until they dismiss it).
  // Without `persistent` the backend closes its input the moment its first turn goes idle
  // (backends/claude.ts: `if (input.isEmpty() && !conductor && !persistent) input.close()`), so a
  // quick-spawned chat answered once and died — you had to spawn a new one to ask the follow-up.
  // Normalized at the same seam and for the same reason as the conductor bit above.
  if (spec.session && !spec.persistent) spec = { ...spec, persistent: true };
  // CONDUCTOR-NO-TURN-CAP: same reasoning as the persistent bit above, applied to the other
  // setting that contradicts "interactive, multi-turn session by contract". maxTurns defaults to
  // 40 with turnLimitPolicy "fail", which means a project conductor — a seat meant to live as
  // long as its project — was scheduled to die on its 40th turn and take the project's routing
  // with it. "soft" keeps the number as a nominal budget (it still emits turnBudgetExceeded the
  // first time it is crossed, so the signal is not lost) but the agent stops only on natural
  // completion, the tree budget guard, or an explicit kill.
  // An operator who explicitly asked for "fail" on a conductor still gets it — checked against
  // the RAW input, since .parse()'s own default erases explicit-vs-defaulted, exactly as the
  // isolation check below does.
  const explicitTurnPolicy = typeof input === "object" && input !== null
    && "turnLimitPolicy" in (input as Record<string, unknown>)
    && (input as Record<string, unknown>)["turnLimitPolicy"] !== undefined;
  // The turn cap is the same contradiction for a session as for a conductor: maxTurns counts
  // across the WHOLE seat, so a long chat reaches 40 and — under the default "fail" policy — the
  // SDK ends that turn mid-tool-use (TURN-LIMIT-SILENT-STOP in backends/claude.ts). The agent
  // survives now that it is persistent, which is precisely what makes this worth fixing too:
  // otherwise the fix above buys a session that no longer dies, only freezes.
  if ((spec.conductor || spec.session) && !explicitTurnPolicy) spec = { ...spec, turnLimitPolicy: "soft" };
  return spec.permissionProfile === "readOnly" && !explicitIsolation
    ? { ...spec, isolation: "none" }
    : spec;
}

// REATTACH-TERMINAL-RECORDS / MEMORY-BOUNDED-DISK-COMPLETE: bound on how many terminal
// (done/failed/killed) agent records stay FULLY resident (spec.prompt/instructions/content,
// resultText, structuredResult all intact) in `this.agents` — both across a live run
// (archiveColdTerminalAgents, called from snapshotAgents) and across a daemon restart
// (reattach.ts). Beyond this cap, a terminal record is "lightened" (heavy fields stripped, see
// AgentRecord.archived) and its full form is written once, permanently, to AgentArchiveStore —
// UNLIKE queues.ts's MAX_TERMINAL_PER_QUEUE=200 (which this constant's value still mirrors),
// nothing is ever deleted; status()/result()/resume() transparently rehydrate a lightened
// record from the archive on demand (see rehydrate()). Without this cap, this.agents (never
// pruned by state transitions alone) would keep every terminal record's full text resident
// forever, growing without bound across a long-running daemon's whole life.
export const MAX_TERMINAL_AGENTS_PERSISTED = 200;

// QUOTA-UNCOOL: mirrors quota-poll.ts's DEFAULT_INTERVAL_MS. Restated rather than imported so the
// supervisor keeps no dependency on the poller module (deps.quotaPoller is a structural seam) —
// engine.ts, which owns both, is free to inject the poller's real interval via quotaFreshnessMs.
const DEFAULT_QUOTA_FRESHNESS_MS = 10 * 60_000;

// MEMORY-BOUNDED-DISK-COMPLETE: strips the fields that dominate an AgentRecord's memory
// footprint once it's terminal and no longer hot — measured on a real 2d4h-uptime daemon's
// state.json: spec.prompt + spec.instructions + resultText alone accounted for 83% of total
// serialized bytes (2.03MB of 2.45MB across 209 records). `content` (D9 ordered blocks) can
// carry unbounded base64 image data and is dropped for the same reason, even though it wasn't
// present in that sample. Every identity/status field a roster row needs (state, costUsd,
// model, treeId, depth, parentId, gitBranch, timestamps, membership, ...) is left untouched —
// agent.list/AgentSummary never read the stripped fields (confirmed: ui-state's AgentRecordLite
// projection doesn't carry prompt/instructions/resultText at all), so a lightened record is
// indistinguishable from a full one in every roster/list view. `prompt` stays a required string
// on AgentSpec (schema: `z.string().min(1)`) — emptied to "" rather than omitted, which is safe
// ONLY because a lightened record's spec is never re-parsed/re-spawned directly; every internal
// respawn path (checkPendingOnSettle, resume(), setModel, ...) reads through status(), which
// rehydrates the full spec from the archive first.
// TOKEN-OPT-BATCH-TURNS: split a drained batch into runs that may share one turn. FIFO order is
// preserved absolutely — this only decides where the turn boundaries fall, never what order
// messages arrive in. A message is "foldable" only when its whole payload is the prefixed text:
// a slash command must be the entire turn verbatim, and images/content blocks carry position
// that concatenating text would destroy.
function isFoldable(m: MailboxMessage): boolean {
  return !m.slash && !(m.images && m.images.length > 0) && !(m.content && m.content.length > 0);
}

export function groupDeliverable(batch: readonly MailboxMessage[]): MailboxMessage[][] {
  const groups: MailboxMessage[][] = [];
  for (const m of batch) {
    const last = groups[groups.length - 1];
    if (last && !!m.force === !!last[0]!.force && isFoldable(m) && isFoldable(last[0]!)) last.push(m);
    else groups.push([m]);
  }
  return groups;
}

function lightenAgentRecord(a: AgentRecord): AgentRecord {
  const { prompt: _prompt, instructions: _instructions, content: _content, ...restSpec } = a.spec;
  return {
    ...a,
    spec: { ...restSpec, prompt: "" } as AgentSpec,
    resultText: undefined,
    structuredResult: undefined,
    archived: true,
  };
}

// Recency key for capping terminal records: the last attempt's endedAt (when the account
// session actually finished) falling back to createdAt (a terminal record with an empty
// attempts[] — e.g. a spawn that failed before launch — has nothing else to sort on).
export function agentRecency(a: AgentRecord): number {
  return a.attempts[a.attempts.length - 1]?.endedAt ?? a.createdAt;
}

export class UnknownAgentError extends Error { code = "protocol" as const; name = "UnknownAgentError"; }
export class AgentNotRunningError extends Error { code = "protocol" as const; name = "AgentNotRunningError"; }
export class InvalidPermissionError extends Error { code = "protocol" as const; name = "InvalidPermissionError"; }
export class RemoteControlUnsupportedError extends Error { code = "protocol" as const; name = "RemoteControlUnsupportedError"; }
// REMOTE-CONTROL-CAPABILITY: the provider rejects enableRemoteControl for a running
// session whose credential isn't subscription-authed (verified empirically — see
// AgentSupervisor.remoteControl). Distinct from RemoteControlUnsupportedError (no
// control-request method at all) so a caller/UI can tell "wrong account" from "wrong
// provider" apart.
export class RemoteControlDeniedError extends Error { code = "protocol" as const; name = "RemoteControlDeniedError"; }
// COMPACTION-OBSERVABILITY: mirrors RemoteControlUnsupportedError's own "no control surface at
// all" contract — thrown when the backend has no handle.compact (claude.ts/codex.ts, which
// delegate compaction entirely to their own agentic SDK/CLI). This is the honest refusal path:
// AgentSupervisor.compact never pretends a manual compact ran when chimera doesn't own it.
export class CompactionUnsupportedError extends Error { code = "protocol" as const; name = "CompactionUnsupportedError"; }
// AGENT-RESUME-TOOLS: agent.resume refuses a still-running agent or one whose worktree was
// removed (e.g. landed-and-cleaned-up). A distinct protocol error so the caller can tell the
// refusal apart from a generic spawn failure and act on the guidance ("kill it first" / "spawn
// fresh").
export class ResumeRefusedError extends Error { code = "protocol" as const; name = "ResumeRefusedError"; }

// "paused" (session-limit-aware pause): a non-terminal HOLD state. The agent's backend
// query already errored on a session/usage limit, but instead of failing we cool the
// account until the parsed reset and auto-resume then (see holdUntilReset/resumePaused).
// Ordering matters for callers that switch on state: "paused" is NOT terminal.
export type AgentState = "running" | "paused" | "done" | "failed" | "killed";
export type AgentRecord = {
  agentId: string; spec: AgentSpec; accountName: string; provider: string;
  // User-facing identity, separate from the execution account and shadow label. Duplicated
  // from spec at spawn so record snapshots expose it directly without overloading `name`.
  displayLabel?: string;
  // REBIND / rename_self one-shot guard: true once displayLabel is no longer free to move —
  // stamped true at spawn when the caller explicitly set spec.displayLabel (an operator's own
  // choice, never to be overwritten), and stamped true by renameAgent itself right after a
  // successful self-rename (so a session can only ever rename itself once). In-process only —
  // no wire consumer needs it, renameAgent is the sole reader.
  displayLabelPinned?: boolean;
  state: AgentState; depth: number; treeId: string; createdAt: number; sessionId?: string;
  // Session-limit HOLD: absolute epoch-ms when a paused agent is scheduled to auto-resume
  // (the parsed limit reset). Snapshotted with the record so a daemon restart can re-arm
  // the resume timer (reattachPaused). Present only while state === "paused".
  resumeAt?: number;
  // who asked for this spawn; always "local" in Phases 1–4 — Phase 5 per-peer
  // quota enforcement keys counters on it (no behavior change now)
  principal: string;
  attempts: Array<{ account: string; startedAt: number; endedAt?: number; errorClass?: string }>;
  resultText?: string; costUsd: number;
  // W2-1 STRUCTURED-RETURNS: parsed value from the terminal result's `structuredOutput` — set
  // only when spec.resultSchema forced a machine-shaped result (see claude.ts/codex.ts). undefined
  // for every ordinary (prose) result, exactly as before this field existed.
  structuredResult?: unknown;
  // Task B1: set only for scheduler team spawns (ephemeral or persistent) — a
  // plain agent.spawn has no membership. Consumed by launch() to inject
  // CHIMERA_TEAM/CHIMERA_ROLE env, and by B2's my_team tool.
  membership?: { team: string; role: string };
  // ROLES-TAB S1: the ad-hoc session role name (engine.ts's agent.spawn `role` param,
  // resolved against the session-role registry BEFORE supervisor.spawn is called) this agent
  // was spawned with. Distinct from membership.role (a TEAM role) — orthogonal, either or
  // neither may be set. null for a spawn that named no role (every pre-S1 caller).
  sessionRole?: string | null;
  // ROLES-UNIFY §3.3: the sparse overrides bag actually resolved at spawn time (engine.ts's
  // agent.spawn — the caller's own raw spec, folded in as resolveRole's final merge stage).
  // A FROZEN audit record, never a live template: there is no RPC that edits a running
  // agent's copy (decision #2, §1/§9.2 — no retroactive respawn). Present only alongside
  // sessionRole (never set without it); undefined for a spawn that named no role.
  sessionRoleOverrides?: Record<string, unknown> | null;
  // PLAN-PROJECT-CONDUCTOR-ROUTING P3-T1 (spawn-lineage UI foundation): the REAL spawner —
  // the id of the agent that called agent.spawn to create this one, captured at spawn time
  // from an explicit caller-supplied opts.parentId. null for a spawn with no live spawning
  // agent (scheduler/UI/reattach-originated), not merely "unknown" — always stamped (never
  // left undefined) so a fresh record is never confused with a pre-P3-T1 one. Replaces the
  // depth+createdAt parent-reconstruction heuristic in ui-state/reducer.ts's treeOrder.
  parentId: string | null;
  promptFrom?: string;
  // Initial body lives only in spec; retain just its immutable author here.
  initialAuthor?: Principal;
  forkLineage?: import("@chimera/protocol").ForkLineage;
  // CROSS-PROVIDER-HANDOFF: the reverse edge from parentId above. parentId answers "who
  // called agent.spawn to create me" (a live spawning agent); handoffFrom answers "whose
  // context was I built from" (supervisor.handoff — the source agent may already be dead by
  // the time this record exists, so this is never a live spawn edge). handoffTo is the
  // forward pointer, stamped on the SOURCE record once it settles "done" via a handoff.
  // Optional/undefined (not null-always-present like parentId) — only a handoff's two
  // participants ever carry either field, same sparse convention as jobName below.
  handoffFrom?: string;
  handoffTo?: string;
  // Durable asynchronous ownership for queue/workflow work. Separate from the
  // real spawn edge above and from budget ancestry.
  originConductorId?: string | null;
  // FEATURE-5 (hierarchical budget governor): OPTIONAL override of the key this spawn's own
  // maxBudgetUsd (if any) registers under in AgentSupervisor's treeBudgets map — lets a
  // caller (e.g. scheduler.ts's task-root spawn) register a budget under a STABLE id (e.g.
  // task.taskId) that survives across agent respawns, instead of the ephemeral agentId.
  // Absent (the default, every pre-FEATURE-5 caller) ⇒ trackCost falls back to `treeId`
  // exactly as before — byte-identical when unused.
  budgetNodeId?: string;
  // The owning project's name (ProjectSpec.name doubles as its id — projects have no
  // separate uuid). Either explicit (opts.projectId) or derived at spawn time via the
  // injectable `projectFor` seam (isPathUnder(spec.cwd, project.path)). Independent of the
  // team-scoped `membership.projectId` side-channel above (P1-T1) — a project conductor has
  // no `membership` at all, so this is the only carrier for its project ownership.
  projectId: string | null;
  // JOB-FLEET-GROUPING: the scheduled job that spawned this agent (JobRecord.name), stamped
  // from an explicit caller-supplied opts.jobName — currently only JobScheduler.fire's
  // agent-target spawn call sites (jobs.ts) pass it. Optional/undefined (not null-always-
  // present like parentId above) since the overwhelming majority of spawns have no owning
  // job: matches sessionRole's sparse convention, not parentId's always-stamped one. Replaces
  // the old transient JobScheduler.jobForAgent in-flight map as the durable half of the job
  // link (job -> agent already existed via JobRecord.lastRuns[].agentId) — this is what fixed
  // usage.query's groupBy:"job" always landing on "none" (the in-flight map was gone by the
  // time most rows were attributed) and what AgentSummary.jobName/AgentView.jobName project.
  jobName?: string | null;
  // AGENT-GROUPS Phase 1: operator-defined wrapper-box membership (core/src/groups.ts's
  // GroupStore holds the id->name/color registry; this is just the per-record membership
  // list, mutated via setAgentGroups below). Absent inherits; [] explicitly opts out. Sparse for the
  // overwhelming majority of agents, same convention as jobName above. A group id that no
  // longer exists in the registry is resolved (or ignored) at ui-state READ time, never
  // guessed/rewritten here — mirrors 248dbc1a's discipline for originConductorId.
  groups?: string[];
  // F47 (fleet seen-state): two independent stamps, not one boolean. `attentionAt` is when this
  // agent last emitted an ATTENTION_EVENT_KINDS event; `reviewedAt` is when an operator last
  // marked it seen. Unseen is derived (isAgentUnseen) rather than stored, so a NEW attention
  // event re-unsees the agent for free — no flag to remember to clear. Both are absent on every
  // pre-F47 record and are deliberately NOT backfilled: a fleet that boots with 900 agents all
  // screaming for attention is worse than one that starts quiet.
  attentionAt?: number;
  reviewedAt?: number;
  // Task N-SHADOW (native sub-agent surfacing): a synthetic "shadow" record that
  // surfaces a native Task/Agent-tool sub-agent (or workflow task) — an SDK
  // agent_task with no real chimera agentId — as a nested left-pane row via the
  // SAME agent.list -> treeOrder -> AgentList path real agents use. Shadows live
  // in a SEPARATE map from this.agents (so they never count against spawn
  // guardrails / per-account caps / tree budgets, which all iterate this.agents),
  // have no live handle, and carry a friendly `label` (subagentType/workflowName/
  // description) that AgentList shows instead of the raw `shadow:...` id. They are
  // list-only markers: costUsd/attempts stay 0/[], and a selected shadow's
  // transcript is empty (its events are logged under the PARENT's agentId — see
  // upsertShadow's DEFERRED note).
  shadow?: true; label?: string;
  // Task SHADOW-ACT: the live per-task progress claude.ts already forwards on the
  // agent_task event (description/lastToolName/summary/usage/error). Stored ONLY on
  // a shadow record and refreshed on every subsequent agent_task, so a selected
  // shadow can render a live "what it's doing" activity panel instead of an empty
  // "no messages yet" transcript (its real per-task events still log under the
  // PARENT's agentId — see upsertShadow's DEFERRED note). Serializes verbatim on the
  // agent.list snapshot to the TUI (no protocol schema strips it).
  shadowInfo?: ShadowInfo;
  // SHADOW-WORKFLOW-VISIBILITY: for a WORKFLOW shadow, the on-disk transcript location the
  // parent's Workflow tool_result prints ("Transcript dir:" / "Run ID:"). A workflow's inner
  // agents run as separate harness-side processes, so their activity NEVER flows through the
  // parent SDK session (unlike native sub-agents, whose events re-route here via
  // subagentToolUseIndex) — it lives only under this dir (journal.jsonl + per-agent
  // agent-<id>.jsonl). shadow.workflowInspect reads it on demand to surface the inner-agent
  // roster + transcripts. Stashed by captureWorkflowTranscriptRef when the Workflow tool_result
  // event lands; absent for every native sub-agent shadow (and until that tool_result arrives).
  // Deliberately NOT on the agent.list wire snapshot — the inspect RPC reads it straight off this
  // record, and the UI already knows a shadow is a workflow via shadowInfo.workflowName.
  workflowTranscriptDir?: string;
  workflowRunId?: string;
  // WD Stage 1 (coverage B12, sessions-table branch column): the git branch of the
  // spec's cwd, stamped ASYNCHRONOUSLY at spawn (never blocks/gates the spawn) and
  // refreshed fire-and-forget on the engine's agent.status. undefined when the cwd is
  // not a git repo, git is missing, or the probe hasn't landed yet — every reader
  // treats absent as "no branch". Rides the agent.list snapshot verbatim.
  gitBranch?: string;
  // SOFT-TURN-LIMIT: set true when a turnLimitPolicy:"soft" agent's backend signals
  // it crossed its nominal maxTurns (a `status` event carrying turnBudgetExceeded —
  // see onEvent below). Never set for the default "fail" policy. `state` stays
  // "running" — this is a UI flag, not a terminal transition. Rides the agent.list
  // snapshot verbatim (mirrors gitBranch above), so the TUI/app can render a
  // running-but-flagged row. Sticky for the rest of THIS run (cleared on a fresh
  // spawn, since a new AgentRecord starts undefined).
  turnBudgetExceeded?: boolean;
  // STALE-RESUME-SESSION-FALLBACK: set when resumePaused's launch() fails because the record's
  // OWN stored sessionId no longer resumes on the backend (evicted/expired) — the fresh relaunch
  // that follows uses the original spec/prompt, not the prior session, so `resumedFromPause` is
  // deliberately `false` here even though this record IS a paused-agent revive, to distinguish it
  // from a real continuation for any reader keying off that field. Sparse/sticky, same convention
  // as turnBudgetExceeded above — absent for every ordinary resume.
  staleResumeFallback?: { resumedFromPause: false; reason: string };
  // TOOL-SURFACE-MEASURE: mirrors turnBudgetExceeded's own convention (rides the agent.list
  // snapshot verbatim, set once from a backend `status` event, sticky for this record's life).
  // toolSurfaceEstimate is the spawn-time estimate a backend computed synchronously (currently
  // only claude.ts, via mcp-tools.ts's estimateChimeraMcpToolSurface — see its doc comment for
  // exactly what it does and doesn't cover); absent for a backend that never emits one.
  toolSurfaceEstimate?: {
    source: string; toolCount: number; approxChars: number; approxTokens: number; settingSources: string[]; note: string;
    // F41.QA-FIX carry-forward: claude.ts's `...estimate` spread already includes bySource
    // (McpToolSurfaceEstimate's own field) at runtime -- this type was missing it, so :1961's
    // cast was silently lying about the shape it produced.
    bySource: readonly { source: string; toolCount: number; approxChars: number; approxTokens: number }[];
  };
  // TOOL-SURFACE-MEASURE: the actual billed cache-write size of this agent's FIRST turn
  // (usageFromRaw's provider-agnostic cacheCreation — claude's cache_creation_input_tokens or
  // codex's cache_write_input_tokens), captured once in onEvent's "usage" branch below. Unlike
  // toolSurfaceEstimate this is real billed usage, not a guess, and includes EVERYTHING that
  // turn's system prompt carried (instructions, CLAUDE.md, tool defs, ambient MCP catalog) —
  // not exclusively tool schemas. Absent until the first usage-bearing event lands, and absent
  // forever for a provider/response that never reports a cache-write figure.
  toolSurfaceCacheWriteTokens?: number;
  // TOOL-SURFACE-MEASURE / F41: the MCP server names the PROVIDER actually resolved for this
  // agent, captured once from agent_started (claude.ts:792 forwards the SDK's own `mcp_servers`,
  // which includes the ambient/settings-resolved catalog toolSurfaceEstimate cannot see). Names
  // only, sorted and deduped, so two spawns with the same servers produce the same key. Pairs
  // with toolSurfaceCacheWriteTokens above: one scalar cache-write figure is only interpretable
  // next to the server set it was measured over — that pairing IS the "per MCP server"
  // attribution.
  toolSurfaceServers?: readonly string[];
  // R2 (self-healing supervision): consecutive backend-crash/wedge/failed-reattach count fed
  // into scheduleCrashRestart's circuit breaker — reset to 0 on the next successful
  // agent_started (mirrors authExpired.delete's own reset-on-successful-init one line below in
  // onEvent). Absent/0 for every agent that has never crashed — byte-identical to before this
  // feature for the common case.
  crashCount?: number;
  // CONTEXT-OVERFLOW-RECOVERY: consecutive count of "context-overflow" onError branches serviced
  // for this record by dropping `resume` and relaunching fresh — reset to 0 on the next successful
  // completed turn. A poisoned native thread that overflows AGAIN
  // immediately after a fresh relaunch (attempt 2 while this is still 1) means the fresh session
  // itself can't stay under the ceiling either, so onError fails terminally instead of looping.
  contextOverflowRecoveries?: number;
  // R2: true once scheduleCrashRestart's circuit breaker has tripped for this record — the
  // record is terminal ("failed") and will NEVER be auto-restarted again. Sticky for the rest
  // of this record's life (a fresh spawn under the same agentId, e.g. a manual retry, starts a
  // brand-new record with this undefined).
  circuitOpen?: boolean;
  // F08: the persisted disposition for this record's LAST failure — cause, the derived
  // errorClass, the four booleans onError branches on, and the matched rule name. Stamped on
  // EVERY onError call, unlike attempts[last].errorClass, which onError's `if (att)` guard skips
  // when a spawn dies before its first attempt was recorded. Rides state.json (snapshotAgents ->
  // JSON.stringify, no zod round-trip) and the status event for free, and survives
  // lightenAgentRecord's `...a` spread. Cleared on the next successful agent_started, alongside
  // crashCount — a recovered agent must not keep showing a stale cause.
  failure?: FailureDisposition;
  // Keep the scrubbed terminal reason on the durable record so queue settlement and
  // post-restart inspection don't have to recover it from a rotated event segment.
  failureMessage?: string;
  // R2: which HOLD mechanism parked this record as "paused" — set alongside `resumeAt`,
  // cleared by resumePaused on resume. Purely diagnostic (drives health.status's projection);
  // the resume mechanics themselves (scheduleResume/resumePaused) don't branch on it.
  // LAZY-REATTACH adds "daemon-restart": a prior running agent brought back by a restart, held
  // WITHOUT a process until something actually needs its session. Unlike the other three, this
  // hold has no clock and no fault behind it — it is the normal resting state after a restart.
  // OPERATOR-HOLD: "operator-hold" is deliberately absent from REVIVABLE_PAUSE_REASONS — every
  // other pause is a condition that clears itself (a restart to recover from, an idle window that
  // ends the moment work arrives), so mail wakes those. A hold is a DECISION, and mail arriving is
  // not a reason to overrule it: the inbox fills and the agent stays down until released.
  pauseReason?: "session-limit" | "crash-loop-backoff" | "reattach-recovery" | "daemon-restart" | "idle-timeout" | "operator-hold";
  // REMOTE-CONTROL-SURVIVES-PAUSE: the operator's DESIRED remote-control state, stamped by
  // remoteControl() itself on every successful toggle — not live-session state, which dies
  // with the OS process on every parkIdle/hold/crash-restart/resume cycle. Absent means "never
  // asked" (the pre-existing default, byte-identical for every record that never touched RC).
  // An explicit disable clears this back to absent (not `{enabled:false}`) so a later resume
  // has nothing to re-apply — `enabled:false` would still be a stored intent an over-eager
  // reader might act on. Only `enabled:true` records ever carry `name` (RemoteControlParams'
  // own convention: name is meaningless off). Read by reissueRemoteControlIntent after every
  // resumePaused relaunch (including the freshFallback/stale-session-fallback sub-paths) to
  // re-issue enableRemoteControl on the NEW process/session, since a fresh CLI always starts
  // with the bridge off regardless of what the prior process had toggled.
  remoteControlIntent?: { enabled: true; name?: string };
  // BLOCKED-LANDING-NEEDS-A-DATA-FLAG: set true the moment a permission request for a
  // landing-class command (git merge / worktree remove / branch -D — see hosttools.ts's
  // isLandingBash) resolves to `false`, whether by an explicit human deny (respondPermission)
  // or an unanswered timeout falling back to a deny. Two incidents (d4a1ed6, then 19751e4 the
  // SAME DAY) had a cron sweep re-merge a branch whose agent had just been told no — the only
  // record of that refusal was the agent's own prose terminal report, which a second LLM had
  // to read and correctly interpret to notice. This is the structured alternative: a sweep can
  // check `landingPermissionDenied === true` instead of parsing resultText for "blocked".
  // Sticky for the rest of this record's life (never cleared) — a landing refusal is a fact
  // about this run, not a transient state; a fresh spawn/retry starts a brand-new record with
  // this undefined. Absent for every agent that never hit a landing-class deny — byte-identical
  // to before this field existed.
  landingPermissionDenied?: boolean;
  // STRUCTURED-INCOMPLETE-RUN: any interactive permission request that resolves false (human
  // decline, native cancellation, or a deny fallback) stamps the run. Scheduler completion
  // uses this fact instead of trying to infer "blocked" from the model's final prose.
  permissionDenied?: boolean;
  // DENIED-TOOL-CALL-INVISIBLE: generalizes landingPermissionDenied above from ONE class of
  // denial (landing Bash) to ANY host-tool-policy deny (toolPolicyGate's Bash "deny" row, or
  // mcpPolicyGate's foreign-MCP "deny" row) — the exact mechanism the incident this fixes was
  // built on (10 policy_denied events, all kubectl, all missed: the operator saw nothing, the
  // agent got an opaque refusal, the conductor got no signal, and the queue task the agent gave
  // up on still showed `done`). Set true the moment decidePermission's toolPolicyGate or
  // mcpPolicyGate branch returns "deny" — sticky for the rest of this record's life, same
  // never-cleared convention as landingPermissionDenied (a denial is a fact about this run).
  // Rides agent.listSummary (see engine.ts's projection) so a sweep/conductor can check this
  // boolean without parsing prose OR without deep-reading the policy_denied event stream.
  toolPolicyDenied?: boolean;
  // Provider-native background work can outlive the foreground turn that launched it. These
  // structured fields let queue settlement wait without interpreting the model's prose.
  backgroundTasks?: Record<string, { status: string }>;
  backgroundTaskAwaitingFinal?: boolean;
  backgroundTaskBarrierStartedAt?: number;
  backgroundTaskFailure?: string;
  // The detail lastToolPolicyDenied's boolean alone can't carry — enough for an operator/
  // conductor to distinguish "denied because this context isn't allowed" from "denied because
  // the policy gate couldn't tell which context this was" (hosttools.ts's looksUnresolvedProfile)
  // without re-reading the raw event log. Deliberately NOT on agent.listSummary (token discipline:
  // the summary only needs the boolean to decide "does this need a closer look"); full detail is
  // reachable via agent.status, same tier split as everything else that's summary-boolean +
  // status-detail. Overwritten (not appended) on each new denial — a running total living
  // forever wasn't asked for and would grow unbounded; the LAST denial is what explains "why did
  // this agent stop", which is the question this exists to answer.
  lastToolPolicyDenial?: { tool: string; profile: string | null; profileUnresolved?: boolean; requestId: string; at: number };
  // F22: the lease analogue of the toolPolicy pair above — set true the moment decidePermission's
  // worktree-lease guard refuses a write into ANOTHER agent's leased worktree, sticky for the rest
  // of this record's life (a denial is a fact about this run). Same tier split: the boolean rides
  // agent.listSummary so a conductor can spot "this agent is fighting over a worktree" without
  // parsing prose; the detail below is agent.status only, and is OVERWRITTEN per denial (the last
  // one is what explains "why did this agent stop"). NOT set in "warn" mode — warn refuses
  // nothing, so stamping a denial there would report a block that never happened.
  worktreeLeaseDenied?: boolean;
  lastWorktreeLeaseDenial?: { tool: string; workdirKey: string; owner: string; ownerState: "active" | "retained"; target: string; requestId: string; at: number };
  // R2 (ctx meter effective-limit): the ctx% meter's denominator for this agent — an
  // operator-configured compactionThreshold when set (AccountRegistry.compactionThresholdFor),
  // else the resolved model's native context window (protocol's contextWindowFor). Stamped by
  // launch() on EVERY (re)spawn under this record — including setModel/setEffort's kill+respawn
  // dance, which reuses the same launch() call, so this recomputes for free on a model change
  // without any parallel bookkeeping. Rides agent.list/agent.status verbatim, like gitBranch/
  // turnBudgetExceeded above (no AgentRecordSchema exists to extend — additive field convention).
  effectiveContextLimit?: number;
  contextLimits?: CodexContextLimits;
  // P0-2 MODEL-ATTR: the RESOLVED model the backend actually ran, as opposed to spec.model
  // (the caller's pin, optional — undefined for an unpinned/auto spawn). Captured in onEvent
  // from agent_started's data.model (claude: SDK system/init `model`; codex: MODEL-ACTUAL-
  // SURFACE's effectiveModel, already resolved from the provider default) and refreshed from
  // any later message-level model event (claude's message_complete MODEL-LIVE liveModel, e.g.
  // after an in-session /model change) — same "last-known-value-wins" refresh other optional
  // fields on this record use (gitBranch, turnBudgetExceeded). This is what UsageLedger's
  // resolveContext (engine.ts) stamps onto every ledger row instead of the old, wrong
  // `spec.model ?? "default"` fallback. Absent only for a record that has never received a
  // model-bearing event (e.g. it errored before agent_started).
  actualModel?: string;
  // LEDGER-UNCLEAN-EXIT: the cumulative cost/usage last reported by a "turn_complete" event
  // (claude's SDK-authoritative total_cost_usd, codex's pricing-table estimate over its own
  // cumulativeUsage — see claude.ts/codex.ts) for the run CURRENTLY in flight. Only ever read by
  // settleUnrecordedUsage, to flush a usage-ledger row when the run ends WITHOUT a "result" event
  // (killed, crashed out, circuit-breaker-tripped) — a clean "result" already books the
  // authoritative figure via record.costUsd/usage.ts, at which point these are irrelevant.
  // Cleared the instant they're flushed so a record can never double-book the same accrued cost.
  lastTurnCostUsd?: number;
  lastTurnBillableUsage?: Record<string, unknown>;
  // F50 BUDGET-COVERAGE: whether the LAST turn's booked dollars were DERIVED from token counts
  // (budget.ts's meterTurnCost) rather than reported by the provider. Read by
  // settleUnrecordedUsage so an unclean exit books the same estimated/measured verdict the
  // turn_complete seam already reached. Cleared alongside lastTurnCostUsd.
  lastTurnCostEstimated?: boolean;
  // BUDGET-MIDRUN-BLIND: how much of lastTurnCostUsd's cumulative figure has already been
  // booked into record.costUsd/trackCost for the CURRENT attempt. Without this, a
  // long-lived persistent/conductor agent (which may run hundreds of turns and never emit
  // a "result") only had its real spend committed to the budget governor at exit time via
  // settleUnrecordedUsage — until then, applyCostToNode's authoritative totalCostUsd/
  // maxBudgetUsd hard pause and 80% warning never fired for it at all; only
  // applyLiveEstimate's provisional, reversible mid-turn ESTIMATE offered any protection.
  // The onEvent "turn_complete" branch now books the delta (cumulative - already-booked)
  // the moment each turn completes, same as a clean "result" always has. Reset alongside
  // lastTurnCostUsd wherever that's cleared, so a fresh attempt's cumulative counter (which
  // itself resets to 0 per claude.ts/codex.ts session) is never compared against a dead
  // attempt's figures.
  bookedTurnCostUsd?: number;
  // F11: monotone per-record cumulative billable tokens — the token counterpart of costUsd,
  // booked with the IDENTICAL delta discipline (the backend's cumulative PER-SESSION figure
  // minus what this record already booked, so a respawn's reset-to-0 counter can never
  // subtract). StepJournal reads it at step open and close and stores both snapshots; the
  // per-step delta is the reader's subtraction. Absent until the first usage-bearing turn.
  billableTokens?: UsageScope;
  // F11: usage's exact analogue of bookedTurnCostUsd above — how much of the CURRENT attempt's
  // cumulative usage has already been folded into billableTokens. Reset alongside it.
  bookedTurnUsage?: UsageScope;
  // STALE-WORKTREE-RECORD: a cheap, durable snapshot of whether this worktree-isolated agent's
  // branch still has commits main hasn't merged, taken the moment it's reaped (kill()/
  // reportUnresponsive() — see workdir.ts's checkWorktreeUnlanded doc comment). A janitor can
  // read this straight off the record instead of re-deriving branch liveness/diff state from
  // git on every sweep. Absent for isolation:"none", a record never reaped, or one whose
  // worktree was already gone (landed-and-cleaned-up) at reap time. Last-known-value-wins, like
  // gitBranch/actualModel above — a later reap (or a fresh kill after a successful retry lands
  // the work) overwrites it; it is not retroactively cleared by an unrelated state change.
  worktreeUnlanded?: boolean;
  worktreeLandingCheckedAt?: number;
  // MEMORY-BOUNDED-DISK-COMPLETE: true only on a "light shell" left resident in `this.agents`
  // after a terminal record aged out of the hot set (archiveColdTerminalAgents) — its heavy
  // fields (spec.prompt/instructions/content, resultText, structuredResult) have been stripped
  // and the FULL record written to AgentArchiveStore. Every identity/status field a roster needs
  // (state, costUsd, model, treeId, timestamps, gitBranch, ...) stays intact and accurate on the
  // shell itself — only status()'s rehydrate path needs this flag, to know when to read the full
  // record back from disk. Absent (not just false) on every live/hot/never-archived record —
  // byte-identical to before this field existed.
  archived?: true;
  // F09: set when a message was delivered to this agent while it was between turns and no
  // turn-opening event followed within PROMPT_STALL_MS. Cleared by the turn-opening event that
  // finally arrives, and by any terminal/hold transition. Advisory ONLY — nothing in this file
  // re-delivers or retries because of it.
  promptStall?: PromptStall | null;
};

// Task SHADOW-ACT: the subset of agent_task progress fields worth surfacing for a
// shadow's activity panel. All optional/defensive — an older CLI (or an early
// task_started) may carry none of them; each is refreshed independently
// (last-known-value-wins) so a later progress update that carries only some fields
// never wipes the others.
// R2 (inline sub-agent/workflow surfacing): subagentType/workflowName preserve WHICH of the two
// `upsertShadow`'s `label` derivation read (label itself flattens them into one string) — the UI
// needs to know "this shadow is a sub-agent" vs "this shadow is an attached workflow" to render
// distinct chrome. Present-keys-only like every other field here.
export type ShadowInfo = {
  description?: string; lastToolName?: string; summary?: string;
  totalTokens?: number; toolUses?: number; durationMs?: number; error?: string;
  subagentType?: string; workflowName?: string;
};

export type SupervisorDeps = {
  registry: AccountRegistry; credentials: CredentialResolver;
  backends: Map<string, AgentBackend>; events: EventLog;
  mailboxes: MailboxStore; cooldowns: CooldownTracker;
  // ACCOUNT-QUOTA-METERS: optional (mirrors mailboxForward's backward-compatible seam pattern
  // below) so the many existing SupervisorDeps test fixtures that don't care about quota
  // meters stay untouched — a "quota" BackendEvent with no tracker configured is a no-op.
  quotas?: QuotaTracker;
  // ACCOUNT-QUOTA-METERS-PULL: optional opportunistic top-up trigger (quota-poll.ts's
  // QuotaPoller) — fired from the "result" branch below so a just-finished turn's account gets
  // a fresh pull shortly after activity, on top of QuotaPoller's own baseline timer. Internally
  // debounced (minPollGapMs), so a burst of same-account completions costs at most one request.
  quotaPoller?: { pollAccount(name: string): void | Promise<void> };
  // QUOTA-UNCOOL: how recently a quota window must have been fetched for reconcileResetAt to let
  // it EXTEND a session-limit hold. Defaults to the poller's own baseline cadence — a reading
  // older than one poll interval is one the poller should already have refreshed and didn't.
  quotaFreshnessMs?: number;
  permissionTimeoutMs?: number;
  questionTimeoutMs?: number;
  // Session-limit pause: injectable clock (mirrors CooldownTracker's own `now` seam) so
  // reset-time parsing / resume scheduling is deterministic under test. Defaults to Date.now.
  now?: () => number;
  // Phase 5 seam: fire-and-forget cross-engine delivery for a QUALIFIED
  // deliverTo. Absent ⇒ federation disabled (qualified deliverTo drops-with-event).
  mailboxForward?: (target: { engineId: string; agentId: string }, message: MailboxMessage) => void;
  // WD Stage 1 (coverage B12): injectable git-branch probe (mirrors the `now` seam) so
  // tests pin the async stamp deterministically. Defaults to a real
  // `git -C <cwd> rev-parse --abbrev-ref HEAD` (bounded, failure → undefined).
  gitBranch?: (cwd: string) => Promise<string | undefined>;
  // WD Stage 2 (coverage B14) / FEATURE-6: the capability broker consumed by
  // decidePermission's Bash gate — a live object seam (not a snapshot), so host.setPolicy
  // changes apply to the very next Bash decision, mirroring how setPermission's live
  // spec mutation works. Absent ⇒ no gate — every existing deployment/test is
  // byte-identical (the entire policy feature is opt-in).
  capabilityBroker?: CapabilityBroker;
  // Tamper-evident hash-chained audit ledger — records the destructive-Bash checkpoint trigger
  // and credential-resolution facts below (capability_decision itself is dual-written from
  // engine.ts's broker emit closure, not here). Absent ⇒ no-op, same "byte-identical without it"
  // convention as capabilityBroker/checkpointCreate.
  auditLedger?: AuditLedger;
  // WD Stage 2 (coverage B13): the plugins.toggle view consumed at spawn resolution
  // (launch()) so a NEW spawn omits disabled entries. Also a function seam — read
  // fresh per launch, so a toggle lands on the next spawn without any replumbing.
  pluginFilter?: () => { disabledSkills: string[]; disabledPlugins: string[] };
  // D16 (checkpoints, coverage §C18, F20): the auto-checkpoint trigger seam. Absent ⇒
  // the whole feature is a no-op here (every existing deployment/test byte-identical).
  // MUST NEVER reject — the Engine-side wiring swallows every CheckpointStore error
  // itself (a real git failure) so a checkpoint miss can never block a spawn or a Bash
  // call. Called twice: fire-and-forget from spawn() ("task_start", mirrors
  // stampGitBranch), and AWAITED from decidePermission() ("destructive_bash") — the
  // await is what guarantees the checkpoint lands BEFORE the destructive command runs.
  // Both call sites gate on isGitRepo FIRST (below) — a non-git cwd never reaches this
  // seam at all, so it never fires and never logs.
  checkpointCreate?: (input: { cwd: string; trigger: "task_start" | "destructive_bash"; agentId: string; command?: string }) => Promise<void>;
  // HOOK-5 (PLAN-HOOKS.md §10): registers a worktree-isolated spawn's mainRepo (ensureWorkdir's
  // `mainRepo` is always spec.cwd for isolation:"worktree" — see workdir.ts — so this is called
  // straight off the resolved spec, no ensureWorkdir call needed here) for merge-to-main
  // watching. `unwatch` is called ONLY on a launch failure here (the record never reached a
  // real terminal event); every other unwatch is driven by RepoWatcher's own EventLog
  // subscription (an agent settling done/failed/killed). Absent ⇒ no-op, byte-identical to
  // every pre-HOOK-5 deployment/test.
  repoWatcher?: { watch(repo: string, refId: string): void; unwatch(refId: string): void };
  // D16 fix (checkpoint auto-trigger scoping): the cheap pre-check that gates
  // checkpointCreate above — a non-git cwd (e.g. a conductor's home-dir cwd) must never
  // even ATTEMPT a checkpoint, not attempt-then-swallow-the-error. A function seam
  // (mirrors gitBranch) so tests can fake it instead of shelling out to real git.
  // Defaults to a real `git -C <cwd> rev-parse --is-inside-work-tree` probe (bounded,
  // never rejects, resolves false on any failure).
  isGitRepo?: (cwd: string) => Promise<boolean>;
  // F21/D17: gates the OUTPUT_COMPONENTS_CHEATSHEET append below — true when at least
  // one currently-subscribed client declared the "ui.components" capability (Engine's
  // hasClientCap). A function seam (mirrors pluginFilter/toolPolicy) so it's read fresh
  // per launch, and absent ⇒ every existing deployment/test is byte-identical (no
  // capability was ever declared, so this can only ever have been false).
  uiComponentsEnabled?: () => boolean;
  // LEAN-AGENT-CONTEXT (token economy): true ⇒ a fresh claude spawn boots with ONLY chimera's
  // injected MCP server and no skills, reaching the machine's foreign MCP catalog and its skills
  // on demand instead. Function seam read fresh per launch (mirrors pluginFilter/
  // uiComponentsEnabled); absent ⇒ old full-catalog behavior. A spec that decided for itself
  // (strictMcpConfig, or its own `skills`) is never overridden.
  //
  // Conductors used to be exempt. They are not any more: measured, they are 43% of all spend and
  // carry 25 MCP servers each, which the exemption re-read on every one of their calls.
  leanAgentContext?: () => boolean;
  // LEAN-AGENT-SKILLS: the skills a lean spawn keeps. Absent ⇒ [] (none), which is the correct
  // default only because the operator can name what they actually use — see the config field.
  leanAgentSkills?: () => readonly string[];
  // ADVISOR-TOOL: the daemon-wide default advisor model, read fresh per spawn like the seams
  // above. Absent (or returning undefined) ⇒ no advisor unless a spec names one.
  advisorModel?: () => string | undefined;
  // PLAN-PROJECT-CONDUCTOR-ROUTING P3-T1: resolves a spawn's `projectId` from its cwd —
  // a function seam (mirrors gitBranch/toolPolicy) read fresh per spawn, since core owns
  // ProjectStore and supervisor.ts must not import it directly (same layering reason
  // checkpointCreate/isGitRepo are seams instead of direct CheckpointStore references).
  // Only consulted when the spawn caller didn't pass an explicit opts.projectId. Absent ⇒
  // every spawn's projectId is null unless explicitly supplied (byte-identical to a
  // deployment where no project ever matches).
  projectFor?: (cwd: string) => string | null;
  // SPAWN-SETTING-SOURCES: does the project a spawn resolved to (projectFor's return value)
  // have its own loadProjectSettings toggle on? Read fresh per spawn, mirrors projectFor's own
  // seam shape (core owns ProjectStore; supervisor.ts must not import it directly). Only
  // consulted for a spawn whose spec.loadSettings is unset AND inherit.settingSources is still
  // empty (see spawn() below) — an explicit true/false, or a caller-supplied custom
  // settingSources array, always wins outright. Absent ⇒ never defaults on, byte-identical to
  // a deployment where no project ever matches.
  projectLoadSettings?: (projectId: string) => boolean;
  // F26: the resolved project's worktree setup hook (or null) — same seam shape as
  // projectLoadSettings above (core owns ProjectStore; supervisor.ts must not import it
  // directly), read fresh per spawn so a project.setSetupHook RPC applies to the very next
  // spawn. Only consulted by runWorktreeSetupHook (see below) when isolation is "worktree" and
  // record.projectId is set. Absent ⇒ hook is always null, byte-identical to a deployment
  // where no project ever configures one.
  projectSetupHook?: (projectId: string) => WorktreeSetupHook | null;
  // F26 test seam: overrides the real runWorktreeSetup runner (worktree-setup.ts) so tests can
  // drive success/failure/timeout deterministically without shelling out. Absent ⇒ the real
  // runner, byte-identical to production.
  runSetupHook?: typeof runWorktreeSetup;
  // SECRET-MANAGER: the "inject"-granted secrets for an agent, as env vars. Injected as a seam
  // (not a SecretStore import) so the supervisor stays testable without a keychain, and absent ⇒
  // no secret is ever injected — byte-identical to before this existed.
  injectedSecretsFor?: (agentId: string) => Promise<Record<string, string>>;
  // CLOUD-MUTATION-GATE-OPTOUT: the config-level default for CLOUD-MUTATION-GATE, read fresh
  // per permission check (mirrors gitBranch/toolPolicy/leanAgentContext) so a config.patch
  // applies to the very next Bash call, not just new spawns. Absent ⇒ "prompt", byte-identical
  // to every pre-optout deployment/test.
  cloudMutationGate?: () => "prompt" | "off";
  // F22: the single-writer worktree lease. `worktreeLeases` is narrowed to the ONE method
  // launch() needs (the gate itself goes through capabilityBroker.decideWorktreeWrite, which owns
  // its own evaluator seam) and typed structurally rather than as WorktreeLeaseStore so tests can
  // pass a two-line stub. `worktreeLeaseMode` is read fresh per launch/permission check, exactly
  // like cloudMutationGate above, so a config.patch applies to the very next tool call. BOTH
  // absent ⇒ nothing is acquired and the guard never even extracts write targets — byte-identical
  // to every deployment from before this feature (A12).
  worktreeLeases?: { acquire: (workdirKey: string, worktreeDir: string, agentId: string) => unknown };
  worktreeLeaseMode?: () => "enforce" | "warn" | "off";
  // R2 (self-healing supervision): the crash-loop backoff+circuit-breaker policy —
  // absent ⇒ DEFAULT_CRASH_LOOP_POLICY (byte-identical default; tests inject tiny ms values,
  // mirroring permissionTimeoutMs/questionTimeoutMs).
  crashLoopPolicy?: CrashLoopPolicy;
  // DYNAMIC-MODEL-METADATA: the layered model-metadata resolver, consulted for BOTH the ctx-meter
  // effective-limit stamp (launch()) and the live cost estimate (applyLiveEstimate via
  // estimateEffectiveSpendUsd). Absent ⇒ protocol's hardcoded map + DEFAULT are used directly,
  // byte-identical to before the service existed (every existing test unaffected).
  modelCatalog?: ModelMetadataLookup;
  // VOICE S4 (backend TTS-tap seam): resolves the active voice session for an agentId — a
  // function seam (mirrors pluginFilter/projectFor), read fresh per event so a mid-turn
  // voice.session.start/stop takes effect on the very next message_delta. Absent ⇒ the tap is a
  // no-op (every existing deployment/test byte-identical: no voice_tts_chunk ever emitted).
  voiceActiveSession?: (agentId: string) => { sessionId: string } | undefined;
  // DYNAMIC-CONCURRENCY-CAP: the resource-aware admission cap tracker — HealthMonitor's
  // periodic tick is the only thing that ever SAMPLES it (dynamic-cap.ts); this admission
  // check only ever READS its cheap synchronous effectiveCap() snapshot. Absent ⇒ every
  // spawn's admission check falls back to registry.maxTotal() exactly as before this feature
  // existed (byte-identical to every pre-existing deployment/test).
  dynamicCap?: DynamicCapTracker;
  // Live config accessor (mirrors cloudMutationGate/leanAgentContext above) — read fresh per
  // admission check so a config.patch to caps.dynamicCap applies to the very next spawn
  // attempt, no daemon restart. Absent or returning undefined ⇒ dynamicCap.effectiveCap()
  // itself falls back to the static ceiling (see that method's own contract).
  dynamicCapConfig?: () => DynamicCapConfig | undefined;
  // MEMORY-BOUNDED-DISK-COMPLETE: the archive backing archiveColdTerminalAgents/status's
  // rehydrate path (a real deployment wires AgentArchiveStore; structural, not a class import,
  // so tests can fake it with a plain object). Absent ⇒ the whole feature is a no-op — terminal
  // records are never lightened and `this.agents` behaves exactly as before this existed (every
  // pre-existing test's SupervisorDeps fixture is byte-identical without it).
  agentArchive?: { write(record: AgentRecord): void; read(agentId: string): AgentRecord | undefined };
  // F09 QA (item 1): boot-time-only, resolved once by engine.ts from
  // ChimeraConfigSchema.promptAck.stallMs (see that field's comment for the derivation policy).
  // Absent ⇒ falls back to PROMPT_STALL_MS, so every pre-existing SupervisorDeps test fixture
  // stays byte-identical without it.
  promptStallMs?: number;
};

// WD Stage 1 (coverage B12): the default branch probe. execFile (no shell), 2s timeout,
// and EVERY failure mode (no git, not a repo, timeout, empty output) resolves undefined —
// this promise must never reject, because callers fire it without awaiting.
function defaultGitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 2_000 }, (err, stdout) => {
      resolve(err ? undefined : (stdout.trim() || undefined));
    });
  });
}

// D16 fix: the default isGitRepo probe backing the checkpoint auto-trigger gate — same
// shape as defaultGitBranch (bounded, never rejects, every failure mode resolves false).
function defaultIsGitRepo(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { timeout: 2_000 }, (err, stdout) => {
      resolve(!err && stdout.trim() === "true");
    });
  });
}

// spec §17.3 — the ask_human payload the daemon blocks on. `options` absent ⇒
// free-form; `default` is applied on timeout, mirroring the permission fallback.
export type AskInput = {
  prompt: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
  freeform?: boolean;
  default?: QuestionDefault | null;
  timeoutMs?: number | null;
  header?: string;
  // Task D1: single-peer agent->agent ask. When set, the question is ALSO
  // delivered to this agent's mailbox (so it is prompted to answer) and the
  // emitted agent_question event carries to/replyTo. Absent => today's §17
  // human ask, byte-identical (no delivery, no to/replyTo fields).
  to?: { agentId: string };
  // FEATURE-9 (attention inbox): tags a workflow approval-gate ask (scheduler.ts's
  // evaluateGate) so ui-state can label it distinctly from a plain question instead of
  // guessing off the approve/reject option ids (a real false-positive risk — any
  // two-option question with those exact ids would misclassify). Absent for every other
  // ask() caller (ask_human/ask_agent/ask_team) — byte-identical event shape for them.
  gate?: "approval";
};

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// The chimera coordination MCP server is injected ONLY when spec.orchestration.allow
// is true (see backends/claude.ts) and its blast radius is already bounded by that
// grant + the depth caps. The readOnly/acceptEdits/full profiles govern HOST
// filesystem/shell risk — a DIFFERENT axis. Gating the coordination substrate behind
// them is a category error: it silently denies the memory_search/my_team/ask_* the
// scheduler system prompt explicitly promises the agent (they land here as
// "mcp__chimera__<tool>" and match neither READ_TOOLS nor EDIT_TOOLS → auto-deny).
// So: any chimera MCP tool an agent was granted is auto-allowed under "auto".
const CHIMERA_MCP_PREFIX = "mcp__chimera__";
// MCP-FOREIGN-POLICY: every MCP tool name is "mcp__<server>__<tool>". A "foreign" MCP tool is
// any such name that is NOT the auto-allowed coordination substrate (CHIMERA_MCP_PREFIX) — the
// host's own Claude MCP tools (Atlassian/EKB/gateway/...) an agent may be granted. These route
// through the toolPolicy gate (mcpPolicyGate) instead of falling through to autoDecision's deny.
const MCP_TOOL_PREFIX = "mcp__";
// READONLY-BASH-NO-PROMPT / PERM-READONLY-FALSE-PROMPTS: `command` is optional and
// Bash-only — every existing caller that doesn't pass it (every non-Bash decision, and any
// test exercising the tool-name-only contract) is byte-identical to before. A provably
// read-only Bash command (hosttools.ts isReadOnlyBash — fails closed on anything it can't
// prove: command substitution, redirection, an unlisted tool/subcommand all deny) auto-
// allows under EVERY profile, including "readOnly" — this is a deliberate operator
// override of the earlier "readOnly denies every shell call" contract: isReadOnlyBash is a
// fail-closed allowlist that already PROVES the command cannot write, so "readOnly" denying
// it too was withholding nothing but friction. "full" already allows Bash unconditionally
// above regardless of this check; "acceptEdits"/"readOnly" both get exactly this one
// relaxation beyond their own base allowances.
export function autoDecision(profile: AgentSpec["permissionProfile"], toolName: string, command?: string): boolean {
  if (profile === "full") return true;
  if (toolName.startsWith(CHIMERA_MCP_PREFIX)) return true;
  if (READ_TOOLS.has(toolName)) return true;
  if (profile === "acceptEdits" && EDIT_TOOLS.has(toolName)) return true;
  if (toolName === "Bash" && typeof command === "string" && command !== "" && isReadOnlyBash(command)) return true;
  return false;
}

// TUI backlog 8b: mirrors AgentSpecSchema's `on.permissionRequest` / `permissionProfile`
// enums (protocol/src/index.ts) so setPermission rejects bad values with the same
// vocabulary the spawn-time zod schema enforces, without importing zod internals here.
const PERMISSION_REQUEST_VALUES = new Set<AgentSpec["on"]["permissionRequest"]>(["auto", "poke:caller", "tui"]);
const PERMISSION_PROFILE_VALUES = new Set<AgentSpec["permissionProfile"]>(["readOnly", "acceptEdits", "full"]);

// LIVE-PERMISSION-CHANGE-NOT-TOLD-TO-AGENT: the single source of truth for what a profile
// means in prose, so setPermission's mailbox notice (below) and any future surface describe
// the SAME semantics autoDecision/mapPermission/SANDBOX_BY_PROFILE actually enforce, instead of
// a hand-written second description drifting from the real behavior.
const PERMISSION_PROFILE_DESCRIPTION: Record<AgentSpec["permissionProfile"], string> = {
  readOnly: "read-only — file edits and shell/write tools are denied; read/search tools and provably read-only shell commands (grep, ls, git log, etc.) are still allowed",
  acceptEdits: "acceptEdits — file edits are auto-allowed; other tools may still require approval",
  full: "full — all tools are auto-allowed with no approval prompts",
};
const PERMISSION_REQUEST_DESCRIPTION: Record<AgentSpec["on"]["permissionRequest"], string> = {
  auto: "auto — permission decisions are made automatically from the profile, no operator is asked",
  "poke:caller": "poke:caller — the agent's caller is asked to decide",
  tui: "tui — the attached operator (desktop app) is asked to decide",
};

// LAZY-REATTACH / IDLE-REAP: the pause reasons that mean "held only because nothing needed this
// agent" — they end the instant something does (a message, or mail landing in its box). The other
// reasons deliberately do NOT: a session-limit hold is a provider quota with its own reset clock
// and a crash-loop backoff is a circuit breaker, so reviving either on demand would defeat the
// exact thing it exists to enforce. reattach-recovery is likewise a fault path, not an idle one.
const REVIVABLE_PAUSE_REASONS: ReadonlySet<string> = new Set(["daemon-restart", "idle-timeout"]);

export function isRevivableHold(record: { state: string; pauseReason?: string }): boolean {
  return record.state === "paused" && REVIVABLE_PAUSE_REASONS.has(record.pauseReason ?? "");
}

// IDLE-REAP-PARENT / PAUSED-CONDUCTOR: is this record work its owner is still OWED? Running, or
// paused on a hold with a CLOCK (resumeAt: session-limit, crash backoff) — that one is coming back
// on its own and will report in. A clockless pause (idle-timeout, daemon-restart, operator-hold)
// waits for someone to message it; it is not in flight, and its eventual wake reaches a parked
// owner anyway (deliverPending/ask revive the owner on delivery). Counting it would let one
// dormant pool worker keep its conductor resident forever — the opposite of what idle-reap is for.
export function isLiveDependant(record: { state: string; shadow?: boolean; resumeAt?: number }): boolean {
  if (record.shadow) return false;
  return record.state === "running" || (record.state === "paused" && record.resumeAt !== undefined);
}

// F15 (task_explain / spawn_estimate): the supervisor's spawn-admission checks, named, in the
// order spawn() evaluates them. This order is load-bearing — budgetHeadroom must be evaluated
// before spawn() mutates anything, so a denial leaves every ancestor's totalCostUsd untouched.
// Lives at module scope (not inside the F15-ADMISSION-FENCE below) only because the fence must
// stay a contiguous slice of the CLASS BODY for its source-guard test.
export const ADMISSION_CHECK_NAMES = ["depth", "treeNotPaused", "budgetHeadroom", "globalCap", "accountRouting", "accountCap"] as const;
export type AdmissionCheckName = (typeof ADMISSION_CHECK_NAMES)[number];

/** F15: everything the admission array reads. F51 (spawn_estimate) builds one of these too —
 *  keep it exported and stable. */
export type AdmissionProbe = {
  spec: AgentSpec;
  depth: number;
  maxDepthCap?: number;
  treeId: string;
  budgetParentId?: string;
};

// F15: which ERROR CLASS a denial must be thrown as. NOT cosmetic: scheduler.ts's four
// `err.code === "guardrail"` branches mean "transient starvation — stay pending, retry next
// tick", while ConfigError ("protocol") and BudgetDeniedError ("budget_denied") deliberately
// fall through to markFailed. Collapsing either into GuardrailError turns a permanent failure
// into an infinite starve, so the class travels WITH the failing check instead of being
// re-derived from its message.
type AdmissionDenialKind = "guardrail" | "config" | "budget";

type AdmissionOutcome =
  | { checks: ExplainCheck[]; accountName: string; deniedAs: null; deniedMessage: null }
  | { checks: ExplainCheck[]; accountName: string | null; deniedAs: AdmissionDenialKind; deniedMessage: string };

export class AgentSupervisor {
  private transferSources = new WeakMap<AgentRecord, ResolvedAgentSpec>();
  private killingRecords = new WeakSet<AgentRecord>();
  private providerTransfers = new Map<string, { source: AgentRecord; controller: AbortController }>();
  private agents = new Map<string, AgentRecord>();
  // Task N-SHADOW: shadow records for native sub-agent/workflow tasks. SEPARATE
  // from this.agents BY DESIGN — the guardrail/budget iterations over this.agents
  // (spawn caps ~:116-122, tree-pause interrupt ~:720-722) must NOT see shadows,
  // and shadows have no live handle to kill/deliver to. Keyed on the shadow id
  // `shadow:<parentAgentId>:<taskId>` (see upsertShadow).
  private shadowAgents = new Map<string, AgentRecord>();
  // R2 (inline sub-agent/workflow surfacing): toolUseId -> shadow agentId, populated in
  // upsertShadow whenever an agent_task supplies a toolUseId (and isn't skipTranscript). Lets
  // onEvent resolve a LATER message_complete/tool_call/tool_result's parentToolUseId to the
  // shadow it belongs to, so that event can be re-emitted under the shadow's own agentId instead
  // of leaking into the parent's transcript. Same unbounded-but-accepted lifetime as shadowAgents
  // just above (see its own comment) — not introducing a new pruning obligation this class
  // doesn't already accept for shadow state.
  private subagentToolUseIndex = new Map<string, string>();
  // FEATURE-4 fix: monotonic counter, bumped once per NEW AgentRecord materializing in
  // `agents`/`shadowAgents` (never decremented). SnapshotScheduler's growth-detection used to
  // compare live roster SIZE against a high-water mark, which a failed-launch `agents.delete`
  // (below) can defeat: size drops back down, so a later same-size refill reads as "no growth"
  // and its founding fields (never in the event log) can be lost to a crash. A monotonic count
  // of insertions can't be un-defeated by a delete the way a size comparison can.
  private generation = 0;
  private handles = new Map<string, AgentHandle>();
  private secrets: string[] = [];
  // F26: dedupes concurrent runWorktreeSetupHook calls for the same resolved workdir — two
  // spawns racing into the same reused worktree must run the hook once, not twice. Keyed on
  // the resolved workdir path (not agentId), cleared once the run settles (success or failure).
  private setupInFlight = new Map<string, Promise<{ ran: boolean; durationMs: number }>>();
  // ANSWERED-PROMPT-STAYS-PENDING: each registry carries the agentId alongside its resolver so
  // respondPermission/answerQuestion/answerDialog can append the matching *Resolved event. They
  // used to just resolve the promise, silently — see those methods for what that cost.
  private pendingPermissions = new Map<string, { agentId: string; resolve: (allow: boolean) => void }>();
  private pendingQuestions = new Map<string, { agentId: string; resolve: (answer: QuestionAnswer) => void }>();
  private pendingDialogs = new Map<string, { agentId: string; resolve: (d: DialogDecision) => void }>();
  private pausedTrees = new Set<string>();
  // BUDGET-LIVE-ESTIMATE-REVERSIBLE: nodes paused by applyLiveEstimate's PROVISIONAL,
  // fixed-opus-rate estimate (budget.ts) rather than a real trackCost overage. Tracked
  // separately so applyCostToNode can reconcile the estimate away once the turn's
  // AUTHORITATIVE cost lands — without this, a subtree tiered to a cheaper model (real
  // rate well under the fixed $3/$15 per-M estimate) could get a single large-context
  // turn wildly over-estimated, get added to pausedTrees, and stay paused FOREVER even
  // after the real (much lower) cost proves it never actually breached the ceiling.
  private liveEstimatePausedTrees = new Set<string>();
  // F50 BUDGET-RESUME: nodeId -> the node's totalCostUsd at the instant an operator released it.
  // WHY A WATERMARK AND NOT A BARE SET DELETE: applyCostToNode re-pauses on
  // `totalCostUsd > maxBudgetUsd && !pausedTrees.has(nodeId)` (:4805), and trackCost is called
  // with delta 0 on EVERY unclean exit (:4727) — so simply deleting the node from pausedTrees is
  // undone by the next settle, typically within milliseconds, and the resume buys the operator
  // nothing at all. The watermark says "the operator has SEEN this much overspend"; the guardrail
  // re-engages the moment spend advances past it. It raises no ceiling: one dollar of NEW spend
  // re-pauses the node, and maxBudgetUsd is never touched.
  private budgetResumeAcks = new Map<string, number>();
  // Task AUTH-a: per-account auth-STATE tracking (mirrors CooldownTracker's per-account
  // shape). A status{authError} marks the account expired; a subsequent agent_started
  // (successful init) proves the account authed again and clears it.
  private authExpired = new Set<string>();
  // FEATURE-5: `parentNodeId` makes this a real hierarchy — a node's own spend (applyCostToNode)
  // ALSO propagates to its parent's node (and that node's parent, ...) via trackCost's climb.
  // null (the common/root case, e.g. today's only caller) means "no ancestor to propagate to" —
  // byte-identical to the pre-FEATURE-5 flat single-ceiling behavior.
  private treeBudgets = new Map<string, {
    maxBudgetUsd: number; totalCostUsd: number; warned80?: boolean; parentNodeId: string | null;
    // F50: the DERIVED share of totalCostUsd. Never used in any threshold comparison — the
    // ceiling means the same thing it did before. It exists so no surface can present a total
    // containing derived dollars as a measurement.
    estimatedUsd: number;
  }>();
  // per-agent delivery chain (Deferred Must #1): teams/queues make concurrent
  // same-deliverTo delivery live (the scheduler spawns concurrent agents), so
  // overlapping deliverPending triggers must never run concurrent deliverBatch
  // calls whose handle.send()s could interleave across batches (spec §8 FIFO).
  private delivering = new Map<string, Promise<void>>();
  // ACCOUNT-AUTOSWITCH: messages already handed to the CURRENT turn's handle. deliverBatch
  // drains the mailbox before sending, so without this a turn that fails (rate limit, crash)
  // takes the operator's prompt with it — nothing else holds a copy. onError re-enqueues from
  // here so the failover relaunch re-runs the same prompt on the new account.
  private inFlight = new Map<string, MailboxMessage[]>();
  // Session-limit pause: per-agent auto-resume timers, so a re-pause/kill can clear a
  // pending resume and a restart can re-arm one. unref'd — a resume timer must never keep
  // the daemon process alive on its own.
  private resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // LATE-MESSAGE-RESUME: per-agent resume-attempt-once guard, keyed to the id of the LAST
  // mailbox message an auto-resume was attempted for. Prevents an infinite respawn loop when
  // a resumed run settles again with that SAME message still stuck (see checkPendingOnSettle).
  private autoResumeAttempted = new Map<string, string>();
  // VOICE S4: per-agent sentence-chunker for the message_delta -> voice_tts_chunk tap in
  // onEvent below. Lazily created on first delta while a voice session is active; removed on
  // flush (message_complete/turn_complete) so this map never grows past "currently streaming".
  private voiceChunkers = new Map<string, SentenceChunker>();
  // F09-PROMPT-STALL: proves a delivered message actually started a turn. Lives in prompt-ack.ts
  // so its measured constants and their justification are one grep away from each other; this
  // class only feeds it events/deliveries and reports what it decides.
  private promptAck: PromptAckWatch;
  // F09 QA (item 1): resolved once here (constructor runs after the `deps` parameter property is
  // assigned) rather than as a field initializer, so it's never ambiguous whether `this.deps` is
  // ready yet. Consumed by firePromptStall's reported thresholdMs and by promptAck's stall timer.
  private promptStallMs: number;

  constructor(private deps: SupervisorDeps) {
    deps.mailboxes.setPrincipalResolver((from, engineId) => this.principalFor(from, engineId));
    this.promptStallMs = deps.promptStallMs ?? PROMPT_STALL_MS;
    this.promptAck = new PromptAckWatch({
      now: () => this.now(),
      onStall: (agentId, stall) => this.firePromptStall(agentId, stall),
      stallMs: this.promptStallMs,
    });
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  // F15-ADMISSION-FENCE:BEGIN
  // Everything between these markers is the ONE spawn-admission decision surface. A
  // source-guard test (test/supervisor-admission-array.test.ts) asserts this slice constructs
  // exactly ONE GuardrailError — add an inline guardrail beside the array and it fails until
  // you move the check into evaluateAdmission, where explainTask/spawn_estimate can see it.

  /** F15. Pure: evaluates ALL six admission checks with no short-circuit and no mutation,
   *  returning one entry per ADMISSION_CHECK_NAMES in that exact order. spawn() throws on the
   *  first !ok; explainAdmission() returns the whole array. */
  private evaluateAdmission(p: AdmissionProbe): AdmissionOutcome {
    const checks: ExplainCheck[] = [];
    let deniedAs: AdmissionDenialKind | null = null;
    let deniedMessage: string | null = null;
    // Records the FIRST failure's class + FULL message and hands the message back for `detail`.
    // The two are kept apart on purpose: ExplainCheck.detail is capped at 240 chars (it rides an
    // MCP result) while the thrown message must stay byte-identical to the pre-extraction text —
    // capSnapshot.explain is unbounded, so truncating what we throw could silently reword a
    // guardrail.
    const fail = (kind: AdmissionDenialKind, message: string): string => {
      if (deniedAs === null) { deniedAs = kind; deniedMessage = message; }
      return message;
    };
    const push = (name: AdmissionCheckName, ok: boolean, detail: string, skipped = false): void => {
      checks.push({ name, ok, skipped, detail: detail.length > 240 ? `${detail.slice(0, 237)}...` : detail });
    };

    const effectiveMax = Math.min(p.spec.orchestration.maxDepth, p.maxDepthCap ?? Infinity);
    const depthOk = !(p.depth > effectiveMax);
    push("depth", depthOk, depthOk
      ? `depth ${p.depth} is within effective maxDepth ${effectiveMax}`
      : fail("guardrail", `depth ${p.depth} exceeds effective maxDepth ${effectiveMax}`));

    const treeOk = !this.pausedTrees.has(p.treeId);
    push("treeNotPaused", treeOk, treeOk
      ? `tree ${p.treeId} is not paused`
      : fail("guardrail", `tree ${p.treeId} is paused: budget ceiling exceeded`));

    // FEATURE-5: hierarchical PRE-FLIGHT admission. probeBudgetAdmission is the pure half of
    // checkBudgetAdmission — same climb, same messages, but it neither emits budget_denied nor
    // throws, so explaining a task can never move a budget or write an event.
    if (p.budgetParentId === undefined) {
      push("budgetHeadroom", true, "no budget ancestor to check");
    } else {
      const denial = this.probeBudgetAdmission(p.budgetParentId, p.spec.maxBudgetUsd);
      push("budgetHeadroom", denial === null, denial === null
        ? `budget node "${p.budgetParentId}" and its ancestors have headroom`
        : fail("budget", denial.message));
    }

    const running = [...this.agents.values()].filter((a) => a.state === "running");
    // DYNAMIC-CONCURRENCY-CAP: registry.maxTotal() remains the CEILING (the operator's
    // declared max) — the dynamic tracker, when configured, only ever narrows the OPERATING
    // POINT below it for new admissions. This can never disturb an agent already counted in
    // `running` above: a refusal here only prevents THIS spawn from being added to that set.
    // effectiveCap() is a pure read of already-smoothed EWMA state ("it never itself samples",
    // dynamic-cap.ts) — which is what makes it safe to replay on the explain path.
    const ceiling = this.deps.registry.maxTotal();
    const dynamicCapCfg = this.deps.dynamicCapConfig?.();
    const capSnapshot = this.deps.dynamicCap?.effectiveCap(ceiling, dynamicCapCfg);
    const effectiveMaxTotal = capSnapshot?.cap ?? ceiling;
    const globalOk = running.length < effectiveMaxTotal;
    // Observability (SCOPE #4): a refused admission MUST name its live inputs, not just a
    // bare number — an opaque limit is the operator's whole complaint. Only the detailed
    // form is used when a tracker is actually wired AND its config is enabled; otherwise
    // this is byte-identical to the pre-dynamic-cap message.
    push("globalCap", globalOk, globalOk
      ? `${running.length} of ${effectiveMaxTotal} agent slots in use`
      : fail("guardrail", capSnapshot && dynamicCapCfg?.enabled
        ? `dynamic cap ${capSnapshot.cap} of ${ceiling} reached (${capSnapshot.explain})`
        : `maxAgentsTotal ${ceiling} reached`));

    let accountName: string | null = null;
    try {
      accountName = this.routeAccount(p.spec);
      push("accountRouting", true, `routed to account "${accountName}"`);
    } catch (err) {
      // routeAccount throws ConfigError for "zero accounts configured" and GuardrailError for
      // its three routing failures — carry the class forward, do not flatten it.
      push("accountRouting", false,
        fail(err instanceof ConfigError ? "config" : "guardrail", err instanceof Error ? err.message : String(err)));
    }

    if (accountName === null) {
      push("accountCap", false, "not evaluated: account routing failed", true);
    } else {
      const used = running.filter((a) => a.accountName === accountName).length;
      const cap = this.deps.registry.capFor(accountName);
      const capOk = used < cap;
      push("accountCap", capOk, capOk
        ? `account "${accountName}": ${used} of ${cap} in use`
        : fail("guardrail", `per-account cap for "${accountName}" reached`));
    }

    return (deniedAs === null
      ? { checks, accountName: accountName as string, deniedAs: null, deniedMessage: null }
      : { checks, accountName, deniedAs, deniedMessage: deniedMessage as unknown as string }) as AdmissionOutcome;
  }

  /** F15. The one place a denied admission becomes a thrown error, so the error CLASS per
   *  check lives beside the check itself. Returns never — spawn() relies on that to narrow. */
  private throwAdmissionDenial(outcome: AdmissionOutcome, budgetParentId: string | undefined, requestedUsd: number | null): never {
    const message = outcome.deniedMessage ?? "spawn admission denied";
    // A budget denial keeps BOTH its side effect (the budget_denied event) and its distinct
    // error class, so it is re-run through the live checker rather than re-thrown here — the
    // climb is an in-memory Map walk, and this only ever happens on the denial path.
    if (outcome.deniedAs === "budget" && budgetParentId !== undefined) this.checkBudgetAdmission(budgetParentId, requestedUsd);
    if (outcome.deniedAs === "config") throw new ConfigError(message);
    throw new GuardrailError(message);
  }

  /** F15. Runs the SAME array spawn() runs, without spawning and without mutating anything.
   *  Reused verbatim by F51 (spawn_estimate) and by the scheduler's supervisorAdmission
   *  dispatch predicate — never re-derive admission elsewhere. */
  explainAdmission(probe: AdmissionProbe): ExplainCheck[] {
    return this.evaluateAdmission(probe).checks;
  }
  // F15-ADMISSION-FENCE:END

  async spawn(
    input: unknown,
    opts: {
      depth?: number; maxDepthCap?: number; treeId?: string; principal?: string;
      // Task B1: OPTIONAL — only the scheduler's team spawn paths set this.
      membership?: { team: string; role: string };
      // ROLES-TAB S1: OPTIONAL — engine.ts's agent.spawn forwards sp.role here, already
      // resolved into the merged spec by then. Absent ⇒ record.sessionRole stays undefined,
      // byte-identical to before this field existed.
      sessionRole?: string | null;
      // ROLES-UNIFY §3.3: OPTIONAL, mirrors sessionRole's own stamping discipline exactly —
      // engine.ts forwards the caller's raw spec (the sparse overrides resolveRole actually
      // applied) here whenever sessionRole is set; absent otherwise.
      sessionRoleOverrides?: Record<string, unknown> | null;
      // Task CR1: OPTIONAL — reuse a specific agentId (e.g. re-attaching a conductor after a
      // daemon restart so its event-log transcript stays continuous). Absent ⇒ today's fresh uuid.
      agentId?: string;
      // PLAN-PROJECT-CONDUCTOR-ROUTING P3-T1: OPTIONAL — the real spawner's agentId (the
      // engine.ts RPC layer threads this from an explicit caller-supplied param). Absent ⇒
      // record.parentId is null (no live spawning agent for this spawn).
      parentId?: string | null;
      promptFrom?: string;
      promptAuthor?: Principal;
      // CROSS-PROVIDER-HANDOFF: OPTIONAL — supervisor.handoff() passes the SOURCE agentId here
      // for the fresh target it spawns. Absent ⇒ record.handoffFrom stays undefined (every
      // non-handoff spawn). Deliberately NOT threaded onto opts.parentId — a handoff target
      // wasn't spawned by a live caller invoking agent.spawn, it's a continuation.
      handoffFrom?: string;
      forkLineage?: import("@chimera/protocol").ForkLineage;
      originConductorId?: string | null;
      // OPTIONAL explicit project override. undefined ⇒ derive via deps.projectFor(spec.cwd);
      // null or a string ⇒ use exactly that value, no derivation.
      projectId?: string | null;
      // JOB-FLEET-GROUPING: OPTIONAL — jobs.ts's JobScheduler.fire passes JobRecord.name for
      // its agent-target spawn call sites. Absent ⇒ record.jobName stays undefined, exactly
      // like every non-job spawn (agent_spawn RPC, scheduler team-role spawns, ...).
      jobName?: string | null;
      // FEATURE-5: OPTIONAL — see AgentRecord.budgetNodeId's doc comment. Absent ⇒ this
      // spawn's own maxBudgetUsd (if any) registers under `agentId`, exactly as before.
      budgetNodeId?: string;
      // FEATURE-5: OPTIONAL — the id of an ALREADY-REGISTERED budget node this spawn's own
      // node (if it registers one) should nest under, AND that pre-flight admission checks
      // for remaining headroom before admitting this spawn at all. Absent (every pre-
      // FEATURE-5 caller) ⇒ no ancestor check, no propagation — byte-identical to before.
      budgetParentId?: string;
      // F47.FIX L-1: OPTIONAL — carry a PRIOR record's seen stamps into the fresh record this
      // spawn builds. Set only by reattach.ts's eager branch, which re-creates a running agent
      // through spawn() and would otherwise hand it a record with neither stamp, i.e. every agent
      // reads SEEN after a `reattach: "eager"` daemon restart and the operator loses the whole
      // unseen set. Passed IN (rather than re-stamped after the promise resolves) so the record is
      // never briefly wrong and an attention event landing during the spawn can't be clobbered.
      // Absent everywhere else ⇒ a fresh spawn has no stamps, exactly as before.
      attentionAt?: number;
      reviewedAt?: number;
    } = {},
  ): Promise<AgentRecord> {
    let spec = resolveAgentSpec(input);
    // Expand a leading ~ in cwd to the home dir — a shell-ism the OS never
    // resolves as a real chdir target, so a spec.cwd like "~/Documents" would
    // fail the spawn ("agent failed", chdir ENOENT, ~80ms, cost 0 — the schedule
    // failure the user hit). Done ONCE here at the spawn entry so every
    // downstream consumer (workdir, backend cwd, checkpoint/gitBranch/projectFor
    // probes) sees an absolute path.
    if (spec.cwd === "~" || spec.cwd.startsWith("~/")) {
      spec = { ...spec, cwd: join(homedir(), spec.cwd.slice(1)) };
    }
    // PLAN-PROJECT-CONDUCTOR-ROUTING P3-T1: hoisted above its original single use site (the
    // record construction below) so SPAWN-SETTING-SOURCES can consult it too, before `spec` is
    // otherwise finalized.
    const projectId = opts.projectId !== undefined ? opts.projectId : (this.deps.projectFor?.(spec.cwd) ?? null);
    // SPAWN-SETTING-SOURCES: loadSettings is the friendly on/off surface for
    // inherit.settingSources (the SDK's --setting-sources flag — loads user/project
    // CLAUDE.md, skills, and every installed plugin's MCP tools; see AgentSpecSchema's own
    // comment, index.ts). true/false always win outright, overwriting whatever
    // inherit.settingSources resolved to. undefined (no explicit opinion — the common case)
    // defers to inherit.settingSources UNLESS it's still empty (the lean default — an
    // explicit `inherit.settingSources: []` is behaviorally identical, so there's no
    // ambiguity worth resolving) AND this spawn's cwd resolved to a REGISTERED PROJECT that
    // already opted into loadProjectSettings (project.create/import's own toggle): mirrors the
    // identical default engine.ts's spawnProjectConductor and syncProjectTeam already give
    // that same project's conductor and discovered roles — a hand-spawned agent working in the
    // project gets the same answer instead of silently missing it (the "I made a project, why
    // didn't its agents get plugins" gap this field exists to close). Deliberately does NOT
    // touch the global default for a spawn with no project context: only an operator who
    // already turned the project toggle on inherits it here, so the fleet-wide lean-by-default
    // token economy (backends/claude.ts TOKEN-EFF-2/LEAN-AGENT-MCPS) is unaffected.
    if (spec.loadSettings === true) {
      spec = { ...spec, inherit: { settingSources: ["project", "user"] } };
    } else if (spec.loadSettings === false) {
      spec = { ...spec, inherit: { settingSources: [] } };
    } else if (spec.inherit.settingSources.length === 0 && projectId && this.deps.projectLoadSettings?.(projectId)) {
      spec = { ...spec, inherit: { settingSources: ["project", "user"] } };
    }
    const depth = opts.depth ?? 0;
    // WS-OPT (model tiering): stamp the configured cheap model onto any depth>0
    // spawn that didn't ask for a specific model, so opus is reserved for the
    // depth-0 primary. Guards keep this byte-identical when unused: depth===0 (the
    // primary) is never touched; an explicit spec.model always wins; and with no
    // caps.subAgentModel configured the accessor returns undefined ⇒ no override.
    // Mutates a fresh spec copy (the parsed object), never the caller's input.
    if (depth > 0 && spec.model === undefined) {   // presence check, not truthiness: an explicit model (even "") wins
      const tiered = this.deps.registry.subAgentModel();
      if (tiered) spec = { ...spec, model: tiered };
    }
    // W2-8 EFFORT-POLICY: per-role static default, same guard shape as the model-tiering
    // block above — an explicit spec.effort always wins, and opts.membership is only ever
    // set by the scheduler's team-role spawn paths (every team spawn funnels through here),
    // so this only ever touches team-bound spawns, never a bare agent_spawn. See
    // effort-policy.ts for the W2-7-backed rationale; roles that don't match stay
    // undefined, i.e. today's backend-default behavior, unchanged. That default is 'high' for the
    // Claude SDK (documented on its own EffortLevel type) — not "max", as this comment used to say.
    if (spec.effort === undefined && opts.membership?.role !== undefined) {
      const roleDefault = defaultEffortForRole(opts.membership.role);
      if (roleDefault) spec = { ...spec, effort: roleDefault };
    }
    const agentId = opts.agentId ?? randomUUID();
    const treeId = opts.treeId ?? agentId;
    // FEATURE-5: hierarchical PRE-FLIGHT admission — climb budgetParentId's own recorded
    // parent chain (NOT AgentRecord.parentId, which is null for the vast majority of
    // scheduler-originated spawns — see PLAN.md) denying this spawn if any ancestor node
    // is already exhausted, or if this spawn's own requested maxBudgetUsd would exceed an
    // ancestor's remaining headroom. Runs BEFORE any state mutation below, so a denial
    // leaves every ancestor's totalCostUsd untouched ("parent budget preserved").
    //
    // BUGFIX (nested agent_spawn budget escape): opts.budgetParentId must be a KEY already
    // registered in treeBudgets — checkBudgetAdmission/trackCost climb it directly. A raw
    // agent-to-agent nested spawn (engine.ts's agent.spawn RPC) only knows the caller's own
    // agentId (opts.parentId), and for a scheduler-spawned conductor that agentId is NEVER
    // the registered node key (scheduler registers budgetNodeId=task.taskId, a distinct
    // uuid from the conductor's agentId). Resolve to the PARENT RECORD's own registered
    // node (record.budgetNodeId, falling back to its treeId — the exact chain-start
    // trackCost/applyLiveEstimate use for that same record) so a nested spawn lands on the
    // ancestor the caller itself climbs from. An explicit opts.budgetParentId (every
    // scheduler call site) always wins; this only fills the gap for parentId-only callers.
    const budgetParentId = opts.budgetParentId ??
      (opts.parentId != null ? (this.agents.get(opts.parentId)?.budgetNodeId ?? this.agents.get(opts.parentId)?.treeId) : undefined);
    // F15: every spawn-admission decision now lives in ONE named, ordered array
    // (evaluateAdmission above) that queue.explainTask and spawn_estimate replay WITHOUT
    // spawning. spawn() still short-circuits on the first failure and still throws the exact
    // error class each check threw inline — see throwAdmissionDenial.
    const admission = this.evaluateAdmission({ spec, depth, maxDepthCap: opts.maxDepthCap, treeId, budgetParentId });
    if (admission.deniedAs !== null) this.throwAdmissionDenial(admission, budgetParentId, spec.maxBudgetUsd);
    const accountName = admission.accountName;

    const account = this.deps.registry.get(accountName);
    const principal = opts.principal ?? "local";
    const budgetNodeId = opts.budgetNodeId ?? agentId;
    // FEATURE-5: where trackCost/applyLiveEstimate/send begin climbing the budget hierarchy
    // for THIS record. Explicit, not treeId-coincidental: a spawn that registers its OWN node
    // (spec.maxBudgetUsd !== null) climbs from EXACTLY the key it registered under
    // (`budgetNodeId` above) regardless of treeId — this matters for a native nested spawn
    // that both sets its own maxBudgetUsd AND inherits a caller's treeId (treeId !== agentId),
    // where falling back to treeId would silently miss the just-registered node. A budget-LESS
    // sub-agent (no own maxBudgetUsd) nested under a budgetParentId registers no node of its
    // own — its climb starts at the parent directly, so a grandchild's cost books into every
    // ancestor (step AND root), which pre-flight admission then reads as spent. Neither case ⇒
    // undefined ⇒ the field is omitted and trackCost falls back to treeId, byte-identical to
    // every pre-FEATURE-5 caller.
    const budgetClimbStart = spec.maxBudgetUsd !== null ? budgetNodeId : budgetParentId;
    const record: AgentRecord = {
      agentId, spec, accountName, provider: spec.provider ?? account.provider,
      // A resume-only backend may stay idle without emitting agent_started until
      // its first turn. Keep the known resume target available for voice/hold.
      ...(spec.resume ? { sessionId: spec.resume } : {}),
      ...(spec.displayLabel !== undefined ? { displayLabel: spec.displayLabel, displayLabelPinned: true } : {}),
      state: "running", depth, treeId, createdAt: Date.now(), principal, attempts: [], costUsd: 0,
      parentId: opts.parentId ?? null, originConductorId: opts.originConductorId ?? null, projectId,
      ...(opts.promptFrom ? { promptFrom: opts.promptFrom } : {}),
      initialAuthor: structuredClone(opts.promptAuthor ?? this.principalFor(opts.promptFrom ?? opts.parentId ?? "operator")),
      ...(opts.forkLineage ? { forkLineage: opts.forkLineage } : {}),
      ...(opts.handoffFrom !== undefined ? { handoffFrom: opts.handoffFrom } : {}),
      ...(opts.membership ? { membership: opts.membership } : {}),
      ...(opts.sessionRole !== undefined ? { sessionRole: opts.sessionRole } : {}),
      ...(opts.sessionRoleOverrides !== undefined ? { sessionRoleOverrides: opts.sessionRoleOverrides } : {}),
      ...(opts.jobName !== undefined ? { jobName: opts.jobName } : {}),
      // AGENT-GROUPS Phase 1: read straight off spec (not an out-of-band opt like jobName
      // above) — spec.groups always parses to an array (schema default []), so only stamp
      // the record when non-empty, matching every other sparse field's guard here.
      ...(spec.groups.length ? { groups: spec.groups } : {}),
      ...(budgetClimbStart !== undefined ? { budgetNodeId: budgetClimbStart } : {}),
      // F47.FIX L-1: eager reattach's seen stamps (see the opts doc above).
      ...(opts.attentionAt !== undefined ? { attentionAt: opts.attentionAt } : {}),
      ...(opts.reviewedAt !== undefined ? { reviewedAt: opts.reviewedAt } : {}),
    };
    // FEATURE-5: registration generalized from "root spawn only" (old: `treeId === agentId`)
    // to ANY spawn that declares its own maxBudgetUsd, keyed by budgetNodeId (defaults to
    // agentId — for the common root case with no explicit treeId/budgetNodeId override,
    // agentId === treeId, so this is byte-identical to the old root-only check there).
    if (spec.maxBudgetUsd !== null && !this.treeBudgets.has(budgetNodeId))
      this.treeBudgets.set(budgetNodeId, { maxBudgetUsd: spec.maxBudgetUsd, totalCostUsd: 0, estimatedUsd: 0, parentNodeId: budgetParentId ?? null });
    this.agents.set(record.agentId, record);
    this.generation++;
    // HOOK-5: register this spawn's mainRepo for merge-to-main watching BEFORE launch — a
    // launch failure below still unwatches cleanly (RepoWatcher's EventLog subscription only
    // triggers on a real terminal event, so a failed launch that never got that far would
    // otherwise leak a watch; the catch below explicitly unwatches to cover that gap).
    if (spec.isolation === "worktree") this.deps.repoWatcher?.watch(spec.cwd, record.agentId);
    try {
      await this.launch(record, accountName);
    } catch (e) {
      this.agents.delete(record.agentId);
      this.deps.repoWatcher?.unwatch(record.agentId);
      throw e;
    }
    // PROJECT-CONDUCTOR-VISIBILITY: a resumeOnly spawn (lazy project conductor, reattach
    // re-spawn) pushes no first turn — see backends/claude.ts's `!spec.resumeOnly` guard — so
    // the backend may never emit agent_started (or ANY event) on its own, and a client with no
    // polling refresh (packages/app: connectAndLoad fetches agent.list exactly once at
    // bootstrap; every row after that materializes solely from the live event stream, see
    // reducer.ts's agentOrder append) never learns this record exists until the next reconnect.
    // Announce every successfully-launched record here, unconditionally — a plain fresh spawn
    // already gets a real agent_started moments later (its prompt is queued), so this is a
    // harmless, additive extra "row exists" signal for that case and the ONLY signal at all for
    // a resumeOnly one. Deliberately kind:"status" (not a synthetic agent_started): the real
    // agent_started has onEvent-side consumers with lifecycle semantics (sessionId capture,
    // authExpired clear, crashCount reset, deliverPending) this registration must NOT trigger —
    // see health.ts's HealthMonitor for the one place that needs to recognize this marker as
    // "no turn opened yet" (same idle-exemption as an unseen/agent_started record).
    this.deps.events.append({
      agentId: record.agentId,
      kind: "status",
      data: {
        state: "running", registered: true,
        // AGENT-IDENTITY-INVISIBLE-IN-APP: account/provider/permission are SNAPSHOT-ONLY fields —
        // their only path into a client was agent.list's agentRecords fold, and the desktop app
        // never dispatches one (the `connectAndLoad` bootstrap snapshot these comments describe
        // does not exist in packages/app; `agentRecords` appears there in TESTS ONLY, which is why
        // every test stayed green). So an app-side agent showed no account chip, no `full·auto`
        // permission chip — and since the account chip IS the click-to-switch affordance
        // (TranscriptHeader's `account ? … : null`), no way to change accounts either. An idle
        // project conductor is the worst case: it emits THIS event and nothing else, ever.
        // Read from record.spec because setPermission mutates it in place, so these are the LIVE
        // values, and setAccount's respawn spreads the same spec — which is what makes the
        // permission chip come BACK after an account switch instead of silently vanishing.
        accountName: record.accountName,
        provider: record.provider,
        permissionProfile: record.spec.permissionProfile,
        permissionRequest: record.spec.on.permissionRequest,
        // JOB-FLEET-GROUPING: the app is event-sourced (see this block's own doc comment) and
        // has no other way to learn a record's spawn time to rank a job group's runs by — mirrors
        // jobName's own stamping discipline below.
        createdAt: record.createdAt,
        ...(record.spec.conductor ? { conductor: true } : {}),
        ...(record.spec.session ? { session: true } : {}),
        ...(record.displayLabel !== undefined ? { displayLabel: record.displayLabel } : {}),
        ...(record.projectId !== null ? { projectId: record.projectId } : {}),
        ...(record.forkLineage ? { forkLineage: record.forkLineage } : {}),
        ...(record.handoffFrom !== undefined ? { handoffFrom: record.handoffFrom } : {}),
        ...(record.membership ? { membership: record.membership } : {}),
        ...(record.sessionRole ? { sessionRole: record.sessionRole } : {}),
        ...(record.sessionRoleOverrides ? { sessionRoleOverrides: record.sessionRoleOverrides } : {}),
        ...(record.jobName ? { jobName: record.jobName } : {}),
        ...(record.groups?.length ? { groups: record.groups } : {}),
        // REGISTRATION-EVENT-MISSING-LINEAGE: this marker is the app's FIRST sight of a
        // freshly-spawned record — mirrors agent_started's lineage shape (~line 1186 below)
        // exactly so a queue-spawned worker is placeable under its real conductor from the
        // moment it appears, instead of only 8+ events later when agent_started finally lands.
        ...(record.originConductorId ? { originConductorId: record.originConductorId } : {}),
        treeId: record.treeId,
        depth: record.depth,
        ...(record.parentId ? { parentId: record.parentId } : {}),
      },
    });
    // WD Stage 1 (coverage B12): stamp gitBranch AFTER a successful launch,
    // fire-and-forget — the probe must never block or fail a spawn.
    this.stampGitBranch(record.agentId);
    // D16 (F20): task-start checkpoint trigger — same fire-and-forget contract as
    // stampGitBranch above (a checkpoint miss must never fail/delay a spawn). Gated on
    // isGitRepo FIRST: a non-git cwd (e.g. a conductor's home-dir cwd) never reaches
    // checkpointCreate at all — no attempt, no swallowed-error log.
    if (this.deps.checkpointCreate) {
      const checkpointCreate = this.deps.checkpointCreate;
      const cwd = record.spec.cwd;
      void (this.deps.isGitRepo ?? defaultIsGitRepo)(cwd)
        .then((ok) => ok ? checkpointCreate({ cwd, trigger: "task_start", agentId: record.agentId }) : undefined)
        .catch(() => {});
    }
    return record;
  }

  // WD Stage 1 (coverage B12): resolve the record's cwd branch asynchronously and
  // stamp it. Fire-and-forget by design (spawn calls it un-awaited; the engine's
  // agent.status calls it as a refresh) — a probe failure simply leaves the previous
  // value in place (a transient git error must not blank a known branch). Silent
  // no-op for unknown ids and shadow rows (a shadow shares its parent's spec/cwd but
  // is a list-only marker, not a session of its own).
  stampGitBranch(agentId: string): void {
    const record = this.agents.get(agentId);
    if (!record) return;
    // AGENT-RECORD-GITBRANCH-LIES: spec.cwd is the MAIN repo path a worktree-isolated agent was
    // spawned from, not where it actually runs — probing it always reports whatever branch main
    // itself happens to be on (observed: every worktree agent showed gitBranch:"main"), never
    // this agent's own branch. resolveWorkdirPath (workdir.ts) resolves to the worktree dir once
    // it exists (byte-identical to spec.cwd for isolation:"none" or a not-yet-materialized
    // worktree — same fallback WF-3's gate-execution callers already rely on). record.spec.agentId
    // is not reliably populated (mirrors stampWorktreeLanding's identical agentId-param-not-
    // record.spec.agentId pattern above) — pass the record's own id explicitly.
    void (this.deps.gitBranch ?? defaultGitBranch)(
      resolveWorkdirPath({ isolation: record.spec.isolation, cwd: record.spec.cwd, agentId, workdirKey: record.spec.workdirKey }),
    )
      .then((branch) => { if (branch) record.gitBranch = branch; })
      .catch(() => {});
  }

  protected routeAccount(spec: AgentSpec): string {
    // ONBOARDING-PROVIDER: a fresh install boots with zero accounts (the config schema
    // no longer requires ≥1) — give that case one clear message instead of the
    // auto-branch's "matches provider undefined" or the explicit-branch's "unknown account".
    if (this.deps.registry.list().length === 0)
      throw new ConfigError("no accounts configured — connect a provider in Settings");
    if (spec.account !== "auto") {
      const acct = this.deps.registry.get(spec.account);
      if (spec.provider !== undefined && acct.provider !== spec.provider)
        throw new GuardrailError(`account "${spec.account}" is provider "${acct.provider}" but the spawn asks for "${spec.provider}"`);
      return acct.name;
    }
    const provider = spec.provider ?? this.deps.registry.preferredProvider();
    const order = this.deps.registry.autoOrder()
      .filter((n) => provider === undefined || this.deps.registry.get(n).provider === provider);
    if (order.length === 0)
      throw new GuardrailError(`no account in autoOrder matches provider "${provider}"`);
    // Anchor BEFORE cooldown filtering: cooling the first account must not silently shift providers.
    const anchorProvider = this.deps.registry.get(order[0]!).provider;
    const eligible = spec.crossProviderFailover
      ? order
      : order.filter((n) => this.deps.registry.get(n).provider === anchorProvider);
    for (const name of eligible)
      if (!this.deps.cooldowns.isCooling(name)) return name;
    throw new GuardrailError("no account available: every eligible autoOrder account is cooling down");
  }

  /** Where this agent compacts: the SPAWN's own window wins over the account/provider default,
   *  because the right window is a property of the workload, not of the account paying for it.
   *
   *  COMPACTION-THRESHOLD-ONE-FORMULA: two call sites stamp the ctx meter's denominator —
   *  launch(), and the re-stamp when the backend reports an actualModel differing from the
   *  pre-spawn guess. They MUST agree, because that number is divided into the same context the
   *  CLI actually compacts. They did not: the re-stamp read only the registry, so a per-spawn
   *  window was silently dropped the first time a model arrived, and the meter went back to the
   *  model's native window while the CLI kept compacting at the spawn's. Hence one function,
   *  called by both, rather than a comment claiming they are the same formula. */
  private resolveCompactionThreshold(record: AgentRecord, accountName: string): { value: number | undefined; source: CompactionThresholdSource } {
    // L1-MEASURE (F39): the resolved value now travels with the RUNG that produced it, so the
    // backend's compaction event can say what it fired against. The precedence itself is
    // unchanged and still lives in exactly one place per level (spawn here, the rest in
    // AccountRegistry.compactionThresholdWithSource).
    if (record.spec.compactionThreshold != null) return { value: record.spec.compactionThreshold, source: "spawn" };
    return this.deps.registry.compactionThresholdWithSource(record.provider, accountName);
  }

  protected async launch(record: AgentRecord, accountName: string, recoveryPrompt?: string): Promise<void> {
    const account = this.deps.registry.get(accountName);
    record.provider = record.spec.provider ?? account.provider;   // re-stamp per attempt: follow the account across a cross-provider failover
    // TERMINAL-RUNTIME: the runtime picks the backend, the account still picks the provider. A
    // terminal agent is the SAME claude/codex/kimi on the same account — only the surface it runs
    // on differs — so overriding `provider` here instead would have made every provider-keyed
    // decision (routing, quotas, failover, cost) read "terminal" and silently misattribute.
    const backend = record.spec.runtime === "terminal"
      ? this.deps.backends.get("terminal")
      : this.deps.backends.get(record.provider);
    if (!backend) {
      throw new UnknownAgentError(record.spec.runtime === "terminal"
        ? "no terminal backend registered — terminal-runtime agents are unavailable in this build"
        : `no backend registered for provider "${record.provider}"`);
    }
    // CODEX-GATE-EXPOSURE: codex has no decidePermission hook (backends/codex.ts) — "full"
    // maps to sandboxMode "danger-full-access", which disables the OS sandbox entirely (no
    // filesystem or network restriction) AND leaves chimera's own policies (cloud mutation
    // gate, worktree/node_modules write guards, destructive-bash checkpoint) unenforced, since
    // those all live in decidePermission. Refuse rather than silently grant an unenforced
    // "full" — the caller can lower permissionProfile, or set acknowledgeCodexFullAccessRisk
    // to spawn anyway with the risk on record. claude spawns are unaffected: decidePermission
    // still runs there regardless of this field.
    if (record.provider === "codex" && record.spec.permissionProfile === "full" && !record.spec.acknowledgeCodexFullAccessRisk) {
      throw new GuardrailError(
        `codex spawn refused: permissionProfile "full" maps to sandboxMode "danger-full-access", which disables `
        + `the codex sandbox entirely and bypasses chimera's own permission policies (cloud mutation gate, `
        + `worktree/node_modules write guards, destructive-bash checkpoint) — codex has no decidePermission hook `
        + `to enforce them. Use permissionProfile "acceptEdits" or "readOnly" (sandboxed, network-restricted), or `
        + `set acknowledgeCodexFullAccessRisk:true on the spawn to proceed unsandboxed anyway.`,
      );
    }
    // F22: claim the single-writer lease for this agent's worktree. Idempotent (same owner ⇒
    // no-op) and takeover-on-relaunch, so this runs on EVERY launch attempt — including the
    // setModel/setEffort kill+respawn dance and a crash-loop retry — with no release hook
    // anywhere: liveness is derived at decision time, so a settled owner's key is instantly
    // reacquirable.
    //
    // DELIBERATE DEVIATION from the plan's §2.5(a) snippet, which lets acquire's GuardrailError
    // propagate and fail the spawn: scheduler.ts's runCritic spawns the critic with the WORKER's
    // own workdirKey while that worker is still live (see its "MUST match the worker's own key"
    // comment), so propagating would fail every critic-gate spawn in the fleet — the exact
    // false-denial class this card is required to avoid. Swallowing is safe because the write
    // gate, not the spawn, is where A1 is actually enforced: evaluateWrite short-circuits on
    // callerKey === layout.key, so two agents deliberately sharing a workdirKey are allowed into
    // that worktree regardless of which of them holds the record. The contention is recorded as a
    // status event so it is never silent.
    if (record.spec.isolation === "worktree" && this.deps.worktreeLeases && (this.deps.worktreeLeaseMode?.() ?? "off") !== "off") {
      // realishPath, not the raw join: the write-target detectors resolve symlinks, and the
      // stored worktreeDir is compared against their output.
      const dir = realishPath(worktreePath({ cwd: record.spec.cwd, agentId: record.agentId, workdirKey: record.spec.workdirKey }));
      try {
        this.deps.worktreeLeases.acquire(record.spec.workdirKey ?? record.agentId, dir, record.agentId);
      } catch (e) {
        this.deps.events.append({
          agentId: record.agentId, kind: "status",
          data: { state: record.state, worktreeLeaseContended: String((e as Error).message ?? e) },
        });
      }
    }

    const cred = await this.deps.credentials.resolve(account.auth);
    const env: Record<string, string> = {
      CHIMERA_AGENT_ID: record.agentId,
      CHIMERA_DEPTH: String(record.depth),
      CHIMERA_TREE_ID: record.treeId,
    };
    // Task B1: only scheduler team spawns set membership — a plain agent.spawn
    // leaves env untouched (no CHIMERA_TEAM/CHIMERA_ROLE keys at all).
    if (record.membership) {
      env["CHIMERA_TEAM"] = record.membership.team;
      env["CHIMERA_ROLE"] = record.membership.role;
    }
    // AGENT-KNOWS-ITS-GROUP: the operator's wrapper-box membership, same shape as
    // CHIMERA_TEAM/CHIMERA_ROLE above. This is the SPAWN-TIME value and cannot be anything else:
    // env is stamped once, when the process starts, while agent.setGroups can move a LIVE agent
    // afterwards. So the two answer different questions and both are needed — this one answers
    // "which group was I started in", and agent_status(self).groups answers "which group am I in
    // right now". Any path that relaunches the process (a resume out of the restart/idle hold, a
    // model or effort change) re-stamps this from the current record, so it self-heals rather
    // than drifting forever. Absent when the agent is in no group, mirroring the membership pair.
    if (record.groups?.length) env["CHIMERA_GROUPS"] = record.groups.join(",");
    // SECRET-MANAGER (inject grants): values this agent was granted for INJECTION land in its
    // process environment, exactly the way an account credential does above — and for the same
    // reason. The model never sees them: the agent uses one by naming its variable in a command,
    // so the plaintext is not in the context to be echoed, memorised or forwarded. Registered for
    // redaction on the same line, so it cannot come back through the agent's own output either.
    //
    // Read at LAUNCH, which is what makes an inject grant given to a running agent take effect at
    // its next process start rather than immediately — engine.ts says so in the grant's response
    // instead of leaving the operator to assume otherwise.
    const injected = await this.deps.injectedSecretsFor?.(record.agentId);
    if (injected) {
      for (const [key, value] of Object.entries(injected)) {
        env[key] = value;
        this.registerSecret(value);
      }
    }
    if (cred) {
      env[cred.envVar] = cred.value;
      this.secrets.push(cred.value);               // scrubbed out of every event before append (spec §6)
      // The secret VALUE is never referenced below — redaction by construction, a stronger
      // guarantee than redact()'s scrub-after-the-fact (which only works once the value is
      // already registered in this.secrets).
      this.deps.auditLedger?.append({
        agentId: record.agentId, action: "credential_resolution", resource: accountName,
        decision: "recorded", reason: `resolved credential for account "${accountName}" (${account.provider})`,
        detail: { provider: account.provider, envVar: cred.envVar },
      });
    }

    if (account.auth.homeDir) {
      // Codex requires CODEX_HOME to exist BEFORE the variable is set — it will not create the
      // directory itself, and a missing dir silently breaks per-account isolation (verified caveat).
      mkdirSync(account.auth.homeDir, { recursive: true, mode: 0o700 });   // owner-only: this dir holds provider auth (e.g. codex writes auth.json under CODEX_HOME)
      env[account.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] = account.auth.homeDir;
    }

    // Shared routing policy belongs to the session, not to individual messages.
    // Discovery comes from tool schemas; memory usage is task-dependent.
    const leanSkillsCandidate = account.provider === "claude" && this.deps.leanAgentContext?.() === true;
    const skillsUsable = record.spec.skills !== undefined
      ? record.spec.skills.length > 0
      : !leanSkillsCandidate || (this.deps.leanAgentSkills?.() ?? []).length > 0;
    const capabilityBlock = record.spec.orchestration?.allow
      ? buildCapabilityBlock({ skillsUsable, provider: account.provider })
      : null;
    // F21/D17: same AWARENESS discipline as capabilityBlock above — only appended when
    // the gate is live, so a deployment where no client ever declared "ui.components"
    // (uiComponentsEnabled absent, or present and false) stays byte-identical.
    const componentsBlock = this.deps.uiComponentsEnabled?.() ? OUTPUT_COMPONENTS_CHEATSHEET : null;
    const extraBlocks = [capabilityBlock, componentsBlock].filter((b): b is string => b !== null);
    // TOKEN-OPT-CACHE-PREFIX: shared blocks go FIRST, per-agent instructions after. Anthropic's
    // prompt cache matches on an exact PREFIX, so ordering decides whether shared policy is paid
    // once per daemon or once per agent. With the caller's own instructions in front — which is
    // where they used to be — two agents shared no prefix at all beyond the preset, and every
    // spawn re-created this identical text as fresh tokens. Leading with it makes it one cached
    // prefix every orchestration-enabled agent on this daemon hits.
    // This is the same reasoning as SAFE-1 in backends/claude.ts (which hoisted per-spawn
    // orientation OUT of the system append for the mirror-image reason); the earlier comment
    // here preferred "role/team headers keep first position", a presentation preference that
    // costs real tokens on every spawn and buys nothing the second paragraph doesn't.
    const withCapabilities = extraBlocks.length > 0
      ? [...extraBlocks, record.spec.instructions].filter((b): b is string => Boolean(b)).join("\n\n")
      : record.spec.instructions;
    // WD Stage 2 (coverage B13): spawn-time exclusion of plugins.toggle-disabled
    // entries — the toggle contract is "applies to NEW spawns", and this launch is
    // exactly that seam. Claude-only: codex has no plugins/skills surface. Two levers
    // (each the strongest per-spawn control the SDK exposes, see PLAN-TAURI.md §7
    // Stage-2 ledger for the kinds that have none):
    //   * plugin  → drop matching spec.plugins entries (matched on the plugin
    //     directory's basename — the SDK identifies a local plugin by its dir), so
    //     the SDK options omit them entirely (backends/claude.ts only sets the
    //     `plugins` key for a non-empty list);
    //   * skill   → merge `Skill(<name>)` deny rules into providerOptions.
    //     disallowedTools (providerOptions spreads LAST into SDK options, so this
    //     lands as options.disallowedTools; caller-supplied entries are preserved).
    //     The SDK docs describe `skills` (an enable-list) as the skills switch, but
    //     an enable-list would require enumerating EVERY skill from every source to
    //     compute a complement — a deny rule is additive and can't accidentally
    //     hide project/plugin skills this registry never cataloged.
    // record.spec itself is never mutated: the record keeps the caller's spec
    // verbatim, and the exclusion re-applies fresh on every (re)launch.
    const filter = account.provider === "claude" ? this.deps.pluginFilter?.() : undefined;
    let pluginExclusions: Partial<AgentSpec> = {};
    if (filter && (filter.disabledPlugins.length > 0 || filter.disabledSkills.length > 0)) {
      const disabledDirs = new Set(filter.disabledPlugins);
      const plugins = record.spec.plugins.filter((p) => !disabledDirs.has(basename(p.path.replace(/\/+$/, ""))));
      const skillRules = filter.disabledSkills.map((n) => `Skill(${n})`);
      const prior = record.spec.providerOptions["disallowedTools"];
      pluginExclusions = {
        plugins,
        ...(skillRules.length > 0
          ? { providerOptions: { ...record.spec.providerOptions, disallowedTools: [...(Array.isArray(prior) ? prior : []), ...skillRules] } }
          : {}),
      };
    }
    // LEAN-AGENT-CONTEXT (token economy): claude only, opt-outable. strictMcpConfig makes the SDK
    // mount ONLY chimera's injected MCP server(s) and ignore the machine's foreign MCP config
    // (claude.ai connectors, EKB, atlassian, ...) — hundreds of tool definitions per spawn.
    // Agents reach a foreign tool on demand through mcp_store_tools/mcp_store_call (the discovery
    // pointer in capabilityBlock names it). Composes with pluginExclusions above via the shared
    // providerOptions.
    // LEAN-AGENT-MCPS: `record.spec.strictMcpConfig` (the first-class field, claude.ts applies
    // it directly, independent of this daemon-wide default) is the SAME opt-out signal as the
    // older `providerOptions.strictMcpConfig` escape hatch — either one set (true OR false)
    // means the spec already decided, so this daemon default must not clobber it.
    // LEAN-AGENT-CONTEXT: an agent boots knowing its brief and chimera's own tools, and reaches
    // everything else on demand — foreign MCP servers through mcp_store_tools/mcp_store_call,
    // chimera's deferred tools through chimera_tools/chimera_call.
    //
    // Measured before widening this: the fixed prefix is re-read on EVERY model call, which makes
    // it 31% of all input tokens, and at equal MCP count an agent carrying 300+ skills and 400+
    // commands sits at a 53k prefix against 29k for one carrying few. That 24k is paid again on
    // every call for the life of the agent.
    //
    // CONDUCTORS ARE NO LONGER EXCLUDED. They were, on the theory that orchestration needs the
    // servers to hand — but they are 43% of all spend and carry 25 MCP servers each, and
    // mcp_store_tools reaches every one of them on demand. The exclusion was the most expensive
    // line in the fleet.
    const leanCandidate = account.provider === "claude" && this.deps.leanAgentContext?.() === true;
    const lean = leanCandidate
      && record.spec.strictMcpConfig === undefined
      && !("strictMcpConfig" in record.spec.providerOptions);
    if (lean) {
      const base = pluginExclusions.providerOptions ?? record.spec.providerOptions;
      pluginExclusions = { ...pluginExclusions, providerOptions: { ...base, strictMcpConfig: true } };
    }
    // LEAN-AGENT-SKILLS: separate from the MCP switch above because the SDK treats them
    // separately — strictMcpConfig governs MCP loading only, and an omitted `skills` is NOT
    // "skills off" (sdk.d.ts is explicit). A spec with its own opinion always wins, so a role that
    // genuinely needs a skill lists it and is unaffected.
    if (leanCandidate && record.spec.skills === undefined) {
      // An ALLOWLIST, not an off switch: the SDK rejects an unlisted skill at the Skill tool rather
      // than deferring it, so an empty list removes a capability instead of making it lazy. The
      // operator names the few they actually use; everything else stops riding in every prompt.
      pluginExclusions = { ...pluginExclusions, skills: [...(this.deps.leanAgentSkills?.() ?? [])] };
    }
    // COMPACTION-THRESHOLD-CONFIG: read live off the registry (hot-read per spawn — no
    // reconcileBackends/rebuild needed, unlike providerOverrides.baseUrl/defaultModel, since
    // this is pure per-spawn data, not something baked into a backend instance). Conditional
    // spread: an unset threshold omits the key entirely, so a spec with no configured
    // threshold is byte-identical to before this field existed.
    // COMPACTION-THRESHOLD-PER-AGENT: the SPAWN's own value wins over the account/provider default
    // — the right window is a property of the workload, not of the account paying for it. Resolved
    // once here so the ctx meter's denominator below and the value handed to the backend can never
    // disagree about where compaction actually fires.
    const compactionThreshold = this.resolveCompactionThreshold(record, accountName);
    const advisorModel = record.spec.advisorModel ?? this.deps.advisorModel?.();
    // R2 (ctx meter effective-limit): mirrors claude.ts/codex.ts's own MODEL-ACTUAL-SURFACE
    // fallback (spec.model ?? the provider's catalog defaultModel) — record.spec.model is
    // frequently undefined (a spec that never pinned a model), and falling back to the bare
    // DEFAULT_CONTEXT_WINDOW would be wrong whenever the provider's real default model has a
    // different native window (e.g. an unpinned codex spawn actually runs gpt-5.6-sol's 400k,
    // not the 200k default).
    const effectiveModel = record.spec.model ?? findProvider(record.provider)?.defaultModel;
    // CTX-METER-TRIGGER-CLAMP: mirror claude.ts's own SDK-range clamp on compactionThreshold
    // before using it as the meter's denominator, so the meter never diverges from the actual
    // compaction trigger for a configured value outside the SDK's valid range. No-op for every
    // non-claude provider (raw threshold IS their real trigger already).
    record.effectiveContextLimit = record.provider === "codex" ? compactionThreshold.value ?? 0 : effectiveContextLimitFor(effectiveModel, clampCompactionThresholdForProvider(record.provider, compactionThreshold.value), this.deps.modelCatalog);
    if (record.provider === "codex") record.contextLimits = { source: "codex", ...(record.spec.contextWindow ? { requestedWindow: record.spec.contextWindow } : {}), ...(compactionThreshold.value ? { compactAt: compactionThreshold.value } : {}) };
    const resolved: ResolvedAgentSpec = {
      ...record.spec, ...pluginExclusions, ...(withCapabilities !== undefined ? { instructions: withCapabilities } : {}), agentId: record.agentId, accountName,
      resolvedProvider: account.provider, env, depth: record.depth,
      ...(!record.spec.resumeOnly ? {
        initialDelivery: { messages: [createMessage(record.spec.prompt,
          record.initialAuthor ?? this.principalFor(record.promptFrom ?? record.parentId ?? "operator"), { id: `${record.agentId}:initial`, createdAt: record.createdAt, content: record.spec.content })] },
      } : {}),
      ...(recoveryPrompt ? { prompt: recoveryPrompt, resumeOnly: false, images: undefined, content: undefined, initialDelivery: { messages: [createMessage(recoveryPrompt, this.principalFor("system"))] } } : {}),
      // COMPACTION-THRESHOLD-CLEARED: record.spec can carry an explicit null — agent_reconfigure's
      // only way to say "drop my override", since an absent key means "unchanged" in a sparse
      // patch. The spread above would carry that null through, and claude.ts gates on
      // `!== undefined`, so a CLEARED field would read as a real value and clamp to the SDK
      // minimum: 100k. Resolve to a number or to undefined here; null never survives this line.
      ...(compactionThreshold.value !== undefined
        ? { compactionThreshold: compactionThreshold.value, compactionThresholdSource: compactionThreshold.source }
        : { compactionThreshold: undefined }),
      // ADVISOR-TOOL: the spawn's own choice wins, else the daemon default — so an operator who
      // wants the whole fleet to have an advisor sets it once, and a spec that names one (or
      // deliberately names none) is never overridden by it.
      ...(advisorModel !== undefined ? { advisorModel } : {}),
    };
    record.accountName = accountName;
    record.attempts.push({ account: accountName, startedAt: Date.now() });
    // F26: fail-closed — a hook that throws here propagates out of launch() and is caught by
    // spawn()'s try/catch (which deletes the record and rethrows to the caller), so a failing
    // hook refuses the spawn outright. Must run BEFORE backend.spawn(): an agent must never be
    // launched into a half-set-up worktree.
    await this.runWorktreeSetupHook(record, resolved);
    this.transferSources.set(record, resolved);
    const handle = backend.spawn(
      resolved,
      (e) => this.onEvent(record, e),
      (req) => this.decidePermission(record, req),
      (req) => this.decideDialog(record, req),
    );
    this.handles.set(record.agentId, handle);
    // A resumeOnly backend may stay silent until its first input, so waiting for
    // agent_started to drain persisted mail deadlocks recovery. The installed
    // handle is enough; deliverPending still respects active Codex turn boundaries.
    this.deliverPending(record.agentId);
  }

  // F26: fail-closed worktree setup hook. No-ops unless this spawn is worktree-isolated, belongs
  // to a project, and that project has an enabled hook — every pre-F26 deployment/test is
  // byte-identical. ensureWorkdir() is called here (not just relied on from the backend's own
  // call moments later) to learn the resolved workdir path for dedup/marker purposes AND whether
  // this attempt created the worktree (which decides whether a hook failure may remove it); it
  // is idempotent and cheap on the reuse path, so calling it twice is free, never doubles work.
  private async runWorktreeSetupHook(record: AgentRecord, resolved: ResolvedAgentSpec): Promise<void> {
    if (resolved.isolation !== "worktree" || !record.projectId) return;
    const hook = this.deps.projectSetupHook?.(record.projectId) ?? null;
    if (!hook || !hook.enabled) return;

    const { workdir, mainRepo, branch, created } = ensureWorkdir(resolved);
    // mainRepo is only null for a non-worktree resolution; the isolation check above guarantees
    // worktree here, so ensureWorkdir always resolves a real main-repo path in this branch.
    if (!mainRepo) return;

    const existing = this.setupInFlight.get(workdir);
    if (existing) return this.joinSetupInFlight(record, existing, hook, workdir);

    const run = (async () => {
      try {
        const outcome = await (this.deps.runSetupHook ?? runWorktreeSetup)({
          hook,
          workdir,
          mainRepo,
          branch,
          project: record.projectId!,
          emit: (data) => this.deps.events.append({ agentId: record.agentId, kind: "worktree_setup", data }),
        });
        this.deps.auditLedger?.append({
          agentId: record.agentId,
          action: "worktree_setup_ran",
          resource: workdir,
          decision: "recorded",
          reason: "worktree setup hook ran",
          detail: { command: redact(hook.command, this.secrets), project: record.projectId, timeoutSec: hook.timeoutSec, workdir },
        });
        return outcome;
      } catch (e) {
        this.deps.auditLedger?.append({
          agentId: record.agentId,
          action: "worktree_setup_ran",
          resource: workdir,
          decision: "deny",
          reason: "worktree setup hook failed",
          detail: { command: redact(hook.command, this.secrets), project: record.projectId, workdir, error: (e as Error).message },
        });
        // Fail-closed refuses the spawn, but `git worktree add` already ran above — without this
        // every refused attempt orphans a worktree and a branch. Synchronous and before the
        // `finally` that clears setupInFlight, so no joiner can resolve into a doomed workdir.
        if (created) removeWorktree(mainRepo, workdir, branch);
        throw e;
      } finally {
        this.setupInFlight.delete(workdir);
      }
    })();
    this.setupInFlight.set(workdir, run);
    await run;
  }

  // A spawn that JOINS another spawn's in-flight setup used to await in total silence: no event
  // under its own agentId and no audit record, so an operator watching it saw a spawn hang for up
  // to the hook's 900s deadline with an empty transcript. It now narrates its own start and the
  // leader's outcome, marked `joined` so a client can word it as "waiting for" rather than
  // "running", and leaves the same audit trail a non-deduped spawn would.
  private async joinSetupInFlight(
    record: AgentRecord,
    existing: Promise<{ ran: boolean; durationMs: number }>,
    hook: WorktreeSetupHook,
    workdir: string,
  ): Promise<void> {
    const project = record.projectId!;
    const emit = (data: Record<string, unknown>) =>
      this.deps.events.append({ agentId: record.agentId, kind: "worktree_setup", data });
    const base = { project, command: hook.command, joined: true };
    const audit = (decision: "recorded" | "deny", reason: string, extra: Record<string, unknown>) =>
      this.deps.auditLedger?.append({
        agentId: record.agentId,
        action: "worktree_setup_ran",
        resource: workdir,
        decision,
        reason,
        detail: { command: redact(hook.command, this.secrets), project, timeoutSec: hook.timeoutSec, workdir, joined: true, ...extra },
      });

    emit({ phase: "start", ...base });
    try {
      const result = await existing;
      emit({ phase: "ok", ...base, exitCode: 0, durationMs: result.durationMs, ran: result.ran });
      audit("recorded", "worktree setup hook ran (joined an in-flight run)", {});
    } catch (e) {
      // The leader's real exit code/timeout ride on WorktreeSetupError, so the joiner's transcript
      // line reads "exit 1" like the leader's instead of degrading to "could not start <cmd>".
      const err = e as { exitCode?: number | null; timedOut?: boolean; stderrTail?: string; message: string };
      emit({
        phase: "fail", ...base,
        exitCode: err.exitCode ?? null,
        timedOut: err.timedOut === true,
        stderrTail: err.stderrTail || err.message,
      });
      audit("deny", "worktree setup hook failed (joined an in-flight run)", { error: err.message });
      throw e;
    }
  }

  // VOICE S4 (backend TTS-tap seam, design doc §5/§10): ONE tap in the shared onEvent path
  // serves both claude and codex — message_delta is sentence-chunked into voice_tts_chunk
  // events; message_complete/turn_complete flush whatever's left with final:true. Never reads
  // message_complete's own text (claude/codex both re-emit the FULL message text there, which
  // would double-speak content already streamed via deltas) — only the chunker's buffer counts.
  // Gated on an active voice session, re-checked on every call (a mid-stream stop takes effect
  // immediately); a session that was active for the deltas but stops before message_complete
  // still gets its chunker entry cleaned up, just silently (no dangling per-agent state).
  private tapVoiceTts(record: AgentRecord, e: BackendEvent): void {
    if (e.kind !== "message_delta" && e.kind !== "message_complete" && e.kind !== "turn_complete") return;
    const session = this.deps.voiceActiveSession?.(record.agentId);
    if (e.kind === "message_delta") {
      if (!session) return;
      const text = e.data["text"];
      if (typeof text !== "string" || text === "") return;
      let chunker = this.voiceChunkers.get(record.agentId);
      if (!chunker) { chunker = new SentenceChunker(); this.voiceChunkers.set(record.agentId, chunker); }
      for (const chunk of chunker.push(text)) {
        this.deps.events.append({ agentId: record.agentId, kind: "voice_tts_chunk", data: { sessionId: session.sessionId, text: chunk, final: false } });
      }
      return;
    }
    const chunker = this.voiceChunkers.get(record.agentId);
    if (!chunker) return;
    this.voiceChunkers.delete(record.agentId);
    if (!session) return;
    const remaining = chunker.flush() ?? "";
    this.deps.events.append({ agentId: record.agentId, kind: "voice_tts_chunk", data: { sessionId: session.sessionId, text: remaining, final: true } });
  }

  // EventLog notifies subscribers SYNCHRONOUSLY: commit record state BEFORE
  // append, or waitFor sees a stale "running" on the terminal event and hangs.
  protected onEvent(record: AgentRecord, e: BackendEvent): void {
    if (this.killingRecords.has(record) || record.state === "killed") return;
    if (this.agents.get(record.agentId) !== record) return;
    if (this.providerTransfers.get(record.agentId)?.source === record) return;
    this.tapVoiceTts(record, e);
    // F09-PROMPT-STALL:BEGIN — fold every event through the ack watch. Second statement on
    // purpose: a turn-opening event is the ONLY proof a delivery landed, and the checks below
    // can transition the record out from under it.
    const resolved = this.promptAck.observe(record.agentId, e.kind, this.deps.events.currentSeq(), e.data);
    if (resolved) {
      record.promptStall = null;
      this.deps.events.append({
        agentId: record.agentId, kind: "status",
        data: { promptStallCleared: true, deliveryId: resolved.deliveryId, ackMs: resolved.ackMs },
      });
    } else if (record.promptStall && isTurnOpening(e.kind, e.data)) {
      // F09.QA: the two halves of the stall have different lifetimes. replay.ts rebuilds
      // record.promptStall from the persisted agent_prompt_stalled event, but PromptAckWatch is
      // reconstructed EMPTY — so after a daemon restart observe() has no entry to resolve and
      // the badge would stick forever on an agent that is visibly taking turns. Clear off the
      // record itself whenever a turn opens, whatever the watch remembers.
      const stall = record.promptStall;
      record.promptStall = null;
      this.deps.events.append({
        agentId: record.agentId, kind: "status",
        data: { promptStallCleared: true, deliveryId: stall.deliveryId, ackMs: Math.max(0, this.now() - stall.sinceTs) },
      });
    }
    // F09-PROMPT-STALL:END
    // P0-2 MODEL-ATTR: capture the backend-reported RESOLVED model off any event that carries
    // one — agent_started (both backends stamp it at spawn) and claude's message_complete
    // (MODEL-LIVE's in-session liveModel, which can supersede agent_started's after a /model
    // change). Last-known-value-wins; a later event with no model field leaves it untouched.
    // CTX-METER-STALE-DENOM: launch()'s effectiveContextLimit is computed from the PRE-spawn
    // guess (spec.model ?? provider.defaultModel — supervisor.ts's launch()), which the
    // backend-reported actualModel can override the very first time it arrives (an unpinned
    // spawn resolved to a different default than guessed) or later (an in-session /model
    // change via message_complete's liveModel, with no respawn to re-run launch()'s stamp).
    // Either way, re-resolve the SAME formula launch() uses so the meter's denominator tracks
    // the model that actually ran instead of going stale for the record's whole life.
    //
    // CTX-METER-LIVE-FORWARD: the recompute above only ever updated the SERVER's own record —
    // no live event carried the new effectiveContextLimit to clients, and the desktop app never
    // re-fetches agent.list after its one-shot bootstrap snapshot (see createStore.ts), so the
    // ctx meter kept dividing by the OLD model's window after a live model change even though
    // agent.model (the chip next to it) updated correctly. `liveModelChanged` (guarded against
    // the same "<...>" SDK sentinel placeholders the reducer already filters agent.model on —
    // see MODEL-LIVE below) marks whether THIS event should carry the freshly recomputed limit
    // downstream, at the data-enrichment site further below.
    let liveModelChanged = false;
    if (typeof e.data["model"] === "string" && e.data["model"] !== record.actualModel) {
      record.actualModel = e.data["model"];
      const compactionThreshold = this.resolveCompactionThreshold(record, record.accountName);
      record.effectiveContextLimit = record.provider === "codex" ? compactionThreshold.value ?? 0 : effectiveContextLimitFor(record.actualModel, clampCompactionThresholdForProvider(record.provider, compactionThreshold.value), this.deps.modelCatalog);
      if (record.provider === "codex") record.contextLimits = { source: "codex", ...(record.spec.contextWindow ? { requestedWindow: record.spec.contextWindow } : {}), ...(compactionThreshold.value ? { compactAt: compactionThreshold.value } : {}) };
      liveModelChanged = !e.data["model"].startsWith("<");
    }
    if (record.provider === "codex" && e.data["contextLimits"] && typeof e.data["contextLimits"] === "object") {
      record.contextLimits = e.data["contextLimits"] as CodexContextLimits;
    }
    if (e.kind === "usage" && typeof e.data["effectiveContextLimit"] === "number" && e.data["effectiveContextLimit"] > 0) {
      record.effectiveContextLimit = e.data["effectiveContextLimit"];
    }
    if (e.kind === "agent_started") {
      if (typeof e.data["sessionId"] === "string") record.sessionId = e.data["sessionId"];
      // Task AUTH-a: a successful init proves the account authed — clear any stale expiry.
      this.authExpired.delete(record.accountName);
      // A thread ID proves startup, not recovery: an overloaded model or corrupt event
      // stream can fail immediately after every start. Reset only after a completed turn.
      // Clear the previous attempt's disposition from the running UI; unlike the retry
      // count, it describes current status rather than a run of unsuccessful attempts.
      delete record.failure;
      delete record.failureMessage;
      // TOOL-SURFACE-MEASURE / F41: first-write-wins, mirrors toolSurfaceCacheWriteTokens below —
      // claude.ts:792 forwards the SDK's own mcp_servers (name+status per configured server).
      if (record.toolSurfaceServers === undefined && Array.isArray(e.data["mcpServers"])) {
        const names = (e.data["mcpServers"] as unknown[])
          .map((s) => (s as { name?: unknown })?.name)
          .filter((n): n is string => typeof n === "string" && n !== "");
        if (names.length > 0) record.toolSurfaceServers = [...new Set(names)].sort();
      }
      // LATE-MESSAGE-RESUME: a resumeOnly respawn (setModel, session-limit resume, or this
      // file's checkPendingOnSettle) starts idle with NO prompt pushed — the fresh handle
      // never gets a turn to drain the mailbox on its own. Safe unconditionally: a no-op for
      // the common case (nothing pending) via deliverPending's own drain-is-empty path.
      this.deliverPending(record.agentId);
    } else if (e.kind === "status" && e.data["turnBudgetExceeded"] === true) {
      // SOFT-TURN-LIMIT: the backend crossed the spec's nominal maxTurns under a
      // "soft" policy — flag the record for the UI, but deliberately leave `state`
      // untouched (it stays "running").
      record.turnBudgetExceeded = true;
    } else if (e.kind === "status" && typeof e.data["authError"] === "string") {
      // Task AUTH-a: mirrors CooldownTracker.stamp() — mark the account expired.
      this.authExpired.add(record.accountName);
    } else if (e.kind === "status" && e.data["toolSurface"] && typeof e.data["toolSurface"] === "object") {
      // TOOL-SURFACE-MEASURE: mirrors turnBudgetExceeded's own field-capture-from-status-event
      // convention. See AgentRecord.toolSurfaceEstimate's doc comment above.
      record.toolSurfaceEstimate = e.data["toolSurface"] as AgentRecord["toolSurfaceEstimate"];
    } else if (e.kind === "result") {
      record.crashCount = 0;
      const hasActiveBackgroundTask = Object.values(record.backgroundTasks ?? {}).some(
        (task) => !["completed", "done", "failed", "killed", "cancelled"].includes(task.status),
      );
      if (hasActiveBackgroundTask) {
        record.backgroundTaskAwaitingFinal = true;
        record.backgroundTaskBarrierStartedAt ??= Date.now();
      } else if (record.backgroundTaskAwaitingFinal && !record.backgroundTaskFailure) {
        // This result is newer than every terminal task notification, so it is the provider's
        // follow-up conclusion rather than the foreground "I will wait" result.
        record.backgroundTaskAwaitingFinal = false;
        record.backgroundTaskBarrierStartedAt = undefined;
      }
      record.state = "done";
      record.resultText = String(e.data["text"] ?? "");
      // W2-1 STRUCTURED-RETURNS: mirrors resultText's capture, only present under resultSchema.
      if (e.data["structuredOutput"] !== undefined) record.structuredResult = e.data["structuredOutput"];
      // BUDGET-MIDRUN-BLIND: e.data.costUsd is this attempt's cumulative total — the same
      // shape turn_complete already books incrementally below. Book only whatever fraction
      // turn_complete hasn't already fed into trackCost, so a run with N completed turns
      // before its final "result" never double-books turns 1..N-1's spend.
      {
        // F50 BUDGET-COVERAGE: a backend that priced nothing (unpriced model, no provider
        // billing figure) used to land here as a flat $0 — dollars really spent that no ceiling
        // could ever see. meterTurnCost derives them from billableUsage instead, and flags them.
        const metered = meterTurnCost(
          typeof e.data["costUsd"] === "number" ? e.data["costUsd"] : undefined,
          e.data["billableUsage"] as Record<string, unknown> | undefined,
          (typeof e.data["model"] === "string" ? e.data["model"] : undefined) ?? record.actualModel ?? record.spec.model,
          this.deps.modelCatalog,
          e.data["costEstimated"] === true,
        );
        // billableUsage is CUMULATIVE for the attempt (claude.ts/codex.ts), the same scope
        // costUsd already had — so the derived figure is cumulative too and the delta
        // bookkeeping below is unchanged.
        const total = metered.costUsd;
        const delta = total - (record.bookedTurnCostUsd ?? 0);
        // BUDGET-LIVE-ESTIMATE-REVERSIBLE: trackCost must run even when delta <= 0 (e.g. a
        // turn whose real, authoritative cost lands at $0) — applyCostToNode's reconciliation
        // of any REVERSIBLE live-estimate pause (applyLiveEstimate) only fires from inside
        // trackCost. Skipping the call here left a node paused forever once its real cost
        // proved the estimate wrong, since nothing else ever un-pauses it.
        if (delta > 0) record.costUsd += delta;
        this.trackCost(record, Math.max(delta, 0), metered.estimated);
        record.bookedTurnCostUsd = undefined;
        // F11: the terminal message's cumulative usage is this attempt's LAST word — book its
        // un-booked remainder, then reset the per-attempt baseline alongside bookedTurnCostUsd.
        const finalUsage = e.data["billableUsage"];
        if (finalUsage && typeof finalUsage === "object") {
          this.bookUsageDelta(record, usageFromRaw(finalUsage as Record<string, unknown>));
        }
        record.bookedTurnUsage = undefined;
      }
      const att = record.attempts[record.attempts.length - 1];
      if (att) att.endedAt = Date.now();
      // Task N-SHADOW: the parent finished — force any of its still-running shadow
      // rows terminal so none linger "running" if the SDK omitted a terminal
      // task_updated for that sub-agent/workflow task.
      this.terminateShadows(record.agentId, "done");
      // ACCOUNT-QUOTA-METERS-PULL: opportunistic top-up — fire-and-forget, never blocks or
      // throws into onEvent (pollAccount already catches internally; .catch here is only a
      // backstop against a broken injected fake in tests).
      void this.deps.quotaPoller?.pollAccount(record.accountName)?.catch?.(() => {});
      // F50.QA-FIX finding 7: after trackCost's own reconciliation above has had its chance to
      // consult the watermark, this agent is done and can never re-trigger it again.
      this.clearBudgetResumeAck(record);
    } else if (e.kind === "error") {
      // AGENT-FAILURE-REACHES-CONDUCTOR: forward the whole event data (not just message) — a
      // process-death error carries exitCode/stderrTail (see claude.ts/codex.ts) that must ride
      // through to whichever disposition below terminates the agent, so markFailed's mailbox
      // notification and status event can surface them.
      this.onError(record, String(e.data["message"] ?? "unknown error"), e.data);
    } else if (e.kind === "turn_timeout") {
      // R2-TURN-LIFECYCLE: route a backend-detected hang through the SAME onError/
      // classifyError disposition a real crash gets (failover.ts's "turn timed out" CRASH
      // pattern) instead of leaving the agent silently stalled. Zero new failover POLICY here
      // — backend-crash-class errors fail loud today (matches every non-rate-limit class);
      // teaching onError to retry/failover on a hang specifically is a separate, deliberately
      // deferred feature (see PLAN.md follow-ups).
      const reason = e.data["reason"] === "max-duration" ? "max-duration" : "idle";
      this.onError(record, `turn timed out (${reason}): backend hang detected, no forward progress`);
    } else if (e.kind === "turn_complete") {
      if (e.data["interrupted"] !== true) record.crashCount = 0;
      // LEDGER-UNCLEAN-EXIT: stash the run's cumulative cost/usage as reported on THIS turn —
      // claude.ts/codex.ts now carry it on every turn_complete (see their doc comments), not just
      // the terminal "result". Last-known-value-wins, mirroring actualModel above: a run that
      // ends uncleanly after N completed turns still has turn N's real figures available to
      // settleUnrecordedUsage instead of losing every turn's spend to a silent $0.
      if (typeof e.data["costUsd"] === "number") record.lastTurnCostUsd = e.data["costUsd"];
      else if (typeof e.data["turnCostUsd"] === "number") record.lastTurnCostUsd = e.data["turnCostUsd"];
      if (e.data["billableUsage"] && typeof e.data["billableUsage"] === "object") {
        record.lastTurnBillableUsage = e.data["billableUsage"] as Record<string, unknown>;
      }
      // F11: fold this turn's cumulative usage into the record's monotone token total. Only
      // billableUsage is ever booked — contextUsage is last-turn-only and a different scope.
      if (record.lastTurnBillableUsage) this.bookUsageDelta(record, usageFromRaw(record.lastTurnBillableUsage));
      // BUDGET-MIDRUN-BLIND: book this turn's real spend into the budget governor NOW,
      // not just at exit — a persistent/conductor agent may run indefinitely and never
      // reach settleUnrecordedUsage's exit-only call sites.
      if (record.lastTurnCostUsd !== undefined) {
        // F50 BUDGET-COVERAGE: same derivation as the "result" branch — a codex/openai-compat
        // turn on an unpriced model reports $0 with real token counts riding alongside.
        const metered = meterTurnCost(
          record.lastTurnCostUsd, record.lastTurnBillableUsage,
          record.actualModel ?? record.spec.model, this.deps.modelCatalog,
          e.data["costEstimated"] === true,
        );
        record.lastTurnCostEstimated = metered.estimated;
        const delta = metered.costUsd - (record.bookedTurnCostUsd ?? 0);
        // BUDGET-LIVE-ESTIMATE-REVERSIBLE: reconcile via trackCost even at delta<=0 — see
        // the matching comment in the "result" branch above.
        if (delta > 0) record.costUsd += delta;
        this.trackCost(record, Math.max(delta, 0), metered.estimated);
        // Book the METERED figure, never the raw reported one: storing the reported $0 while
        // having booked a derived $1.20 would make the terminal "result" re-derive the same
        // $1.20 as a fresh delta and double-book the turn.
        record.bookedTurnCostUsd = metered.costUsd;
      }
    } else if (e.kind === "usage") {
      // FEATURE-5: LIVE_CTX_USAGE's mid-turn snapshot — cache-aware pre-"result" backpressure
      // (see applyLiveEstimate's doc comment). A no-op when no ancestor budget node is
      // registered (the treeBudgets lookup inside the climb just finds nothing).
      const usage = e.data["usage"] as Record<string, unknown> | undefined;
      // R2: thread the record's model through so a priced model (claude/codex catalog entries)
      // uses the real per-model pricing table instead of the flat-rate approximation.
      if (usage) this.applyLiveEstimate(record, estimateEffectiveSpendUsd(usageFromRaw(usage), record.spec.model, this.deps.modelCatalog));
      // TOOL-SURFACE-MEASURE: capture the FIRST turn's real cache-write size — the honest,
      // measured counterpart to toolSurfaceEstimate above (see AgentRecord field doc comments).
      // First-only (not last-known-value-wins like actualModel/lastTurnCostUsd): turn 1's
      // cache write is what actually billed for the system prompt + tool definitions; a later
      // turn's cache-write reflects growing conversation history, not the tool surface.
      if (usage && record.toolSurfaceCacheWriteTokens === undefined) {
        const cacheCreation = usageFromRaw(usage).cacheCreation;
        if (cacheCreation > 0) record.toolSurfaceCacheWriteTokens = cacheCreation;
      }
    } else if (e.kind === "agent_task") {
      const taskId = typeof e.data["taskId"] === "string" ? e.data["taskId"] : undefined;
      if (taskId && (e.data["isBackgrounded"] === true || record.backgroundTasks?.[taskId])) {
        const status = typeof e.data["status"] === "string" ? e.data["status"] : "running";
        record.backgroundTasks = { ...(record.backgroundTasks ?? {}), [taskId]: { status } };
        if (status === "failed" || status === "killed" || status === "cancelled") {
          record.backgroundTaskFailure = `provider background task ${taskId} ${status}`;
        }
      }
      // Task N-SHADOW: fold a native sub-agent/workflow task into a shadow row.
      // `record` is the PARENT agent (the one running the Task/Agent tool); the
      // shadow inherits its tree/account/provider and nests one level deeper.
      this.upsertShadow(record, e.data);
    } else if (e.kind === "quota") {
      // ACCOUNT-QUOTA-METERS: attribute the backend's live rate-limit snapshot to THIS
      // record's account (mirrors CooldownTracker.stamp's record.accountName usage above).
      const window = e.data["window"] as AccountQuotaWindow | undefined;
      if (window) this.deps.quotas?.record(record.accountName, window);
      // EXTRA-USAGE-VISIBILITY: the overage half arrives on the same channel but as its own
      // payload — it is a spend budget, not a window, and the case that matters is a REJECTED
      // window where there is no window to hang it on.
      const overage = e.data["overage"] as Parameters<QuotaTracker["recordOverage"]>[1] | undefined;
      if (overage) this.deps.quotas?.recordOverage(record.accountName, overage);
    }
    // Final-acceptance MAJOR 3: agent_started additionally carries the spec's
    // conductor flag, so a UI following the live stream can stamp the ◆ marker
    // in-session — without this the flag only ever arrived via an agent.list
    // snapshot, and a lazy-spawned conductor stayed unmarked until a refetch.
    // Additive: non-conductor spawns emit byte-identical data (no false field).
    //
    // TEAMGROUP-LIVE: fold the scheduler-stamped team/role membership onto
    // agent_started for the SAME reason. Membership otherwise rides ONLY on the
    // agent.list snapshot (connectAndLoad), which the app fetches only on
    // connect/reconnect — so a team worker spawned AFTER load (assign/queue →
    // spawnForTask) had no membership in the UI's projection and rendered
    // teamless/detached at the bottom of AgentList until the next refetch,
    // instead of grouping under its team. Additive: a plain agent.spawn has no
    // membership, so those emit byte-identical data (no field added).
    // MULTI-LEVEL-NESTING: fold the record's LINEAGE (treeId/depth/parentId/projectId) onto
    // agent_started too, mirroring membership/originConductorId above and the shadow-directed
    // agent_task re-emit in upsertShadow. Without these an event-stream-only client (the desktop
    // app fetches agent.list exactly once at bootstrap) had NO way to learn where a post-connect
    // spawn sits in the tree — a depth-1 direct spawn (parentId set, originConductorId null, so
    // none of the fields above fire) projected lineage-free and rendered as a detached TOP-LEVEL
    // row, and its own native sub-agent shadows (whose events DO carry treeId) mis-attached
    // inside the conductor's tree instead of under their real parent. parentId/projectId are
    // emitted only when non-null (additive, mirrors the truthy-guards above); treeId/depth are
    // always meaningful (a root's treeId is its own id at depth 0).
    // CTX-METER-LIVE-FORWARD: agent_started always stamps the record's CURRENT
    // effectiveContextLimit (covers an unpinned spawn resolving to a different default than
    // launch()'s pre-spawn guess, mirroring the other record-derived fields below). Any other
    // event only carries it when liveModelChanged just fired above (an in-session /model change
    // via message_complete's MODEL-LIVE) -- tying the two together means the client only ever
    // learns a new limit in the same event where it learns the new model, never out of sync.
    const data =
      e.kind === "agent_started"
        ? {
            ...e.data,
            // AGENT-IDENTITY-INVISIBLE-IN-APP: mirrors the registration marker's stamp above
            // (~line 896) verbatim — an agent that DOES open a turn must learn the same four
            // fields from its own first event, not only from the registration marker.
            accountName: record.accountName,
            provider: record.provider,
            permissionProfile: record.spec.permissionProfile,
            permissionRequest: record.spec.on.permissionRequest,
            // JOB-FLEET-GROUPING: mirrors the registration marker's stamp above verbatim.
            createdAt: record.createdAt,
            ...(record.spec.conductor ? { conductor: true } : {}),
            ...(record.spec.session ? { session: true } : {}),
            ...(record.displayLabel !== undefined ? { displayLabel: record.displayLabel } : {}),
            ...(record.membership ? { membership: record.membership } : {}),
            ...(record.sessionRole ? { sessionRole: record.sessionRole } : {}),
            ...(record.sessionRoleOverrides ? { sessionRoleOverrides: record.sessionRoleOverrides } : {}),
            ...(record.jobName ? { jobName: record.jobName } : {}),
            ...(record.groups?.length ? { groups: record.groups } : {}),
            ...(record.originConductorId ? { originConductorId: record.originConductorId } : {}),
            treeId: record.treeId,
            depth: record.depth,
            ...(record.parentId ? { parentId: record.parentId } : {}),
            ...(record.projectId ? { projectId: record.projectId } : {}),
            ...(record.contextLimits ? { contextLimits: record.contextLimits } : {}),
            ...(record.effectiveContextLimit !== undefined ? { effectiveContextLimit: record.effectiveContextLimit } : {}),
          }
        : e.kind === "turn_complete" || e.kind === "result"
          ? { ...e.data, totalCostUsd: record.costUsd }
        : liveModelChanged && record.effectiveContextLimit !== undefined
          ? { ...e.data, effectiveContextLimit: record.effectiveContextLimit, ...(record.contextLimits ? { contextLimits: record.contextLimits } : {}) }
          : e.data;
    // R2 (inline sub-agent/workflow surfacing): message_complete/tool_call/tool_result carrying a
    // parentToolUseId originated inside a subagent's own turn (see claude.ts) — resolve it against
    // subagentToolUseIndex and re-emit under the SHADOW's own agentId instead of the parent's, so
    // agent.tail/events.replay (already agentId-string-keyed, no daemon change needed) transparently
    // serve a real per-shadow transcript. An unresolvable parentToolUseId (the task wasn't indexed —
    // never seen, or deliberately skipTranscript, see upsertShadow) is DROPPED rather than falling
    // back to the parent: today that's an accidental leak (see the TODO this replaces); dropping is
    // strictly better and matches the SDK's own "hide from inline transcript" intent for skipTranscript.
    const isSubagentTaggedKind = e.kind === "message_complete" || e.kind === "tool_call" || e.kind === "tool_result";
    const parentToolUseId = isSubagentTaggedKind && typeof e.data["parentToolUseId"] === "string" ? e.data["parentToolUseId"] : undefined;
    const shadowRoute = parentToolUseId !== undefined ? this.subagentToolUseIndex.get(parentToolUseId) : undefined;
    const dropUnresolvedSubagentEvent = parentToolUseId !== undefined && shadowRoute === undefined;
    if (!dropUnresolvedSubagentEvent) {
      this.deps.events.append({
        agentId: shadowRoute ?? record.agentId, kind: e.kind, data: this.scrub(data),
        raw: this.secrets.length && e.raw !== undefined ? this.scrubValue(e.raw) : e.raw,
      });
    }
    // F47: stamp the REAL agent, never shadowRoute — the shadow-routing guard above only ever
    // covers message_complete/tool_call/tool_result, none of which are attention kinds, so this
    // sits outside it deliberately (a dropped sub-agent event must not swallow a result/error).
    this.noteAttention(record.agentId, e.kind);
    // SHADOW-WORKFLOW-VISIBILITY: capture a workflow's on-disk transcript location off its
    // tool_result (see captureWorkflowTranscriptRef). A no-op for every non-workflow tool_result.
    if (e.kind === "tool_result") this.captureWorkflowTranscriptRef(e.data);
    if (e.kind === "result") this.afterResult(record);
    else if (e.kind === "turn_complete") {
      // A turn that ended without an error consumed its messages legitimately — drop the
      // retained copies so a LATER, unrelated error can't redeliver them.
      if (e.data["errorResult"] !== true) {
        this.inFlight.delete(record.agentId);
        // Init alone doesn't prove the replacement context works: it can immediately
        // overflow again. Reset the bounded recovery only after a successful turn.
        record.contextOverflowRecoveries = 0;
      }
      this.deliverPending(record.agentId, true);
    }
    // LATE-MESSAGE-RESUME: "result" (-> done, synchronously above), "error", and "turn_timeout"
    // (both -> onError, which may commit "failed" synchronously above) are the ways this event
    // can settle the agent terminal within this call — check its OWN mailbox for anything
    // stranded.
    if (e.kind === "result" || e.kind === "error" || e.kind === "turn_timeout") this.checkPendingOnSettle(record);
  }

  // LATE-MESSAGE-RESUME: a send() that lands near end-of-run can strand a user_message in the
  // agent's own mailbox — deliverPending's `state !== "running"` guard silently skips draining
  // once the record has already settled, and nothing else ever rechecks that mailbox. Called at
  // every place a record commits to "done"/"failed" (this file greps its own `record.state = /
  // r.state = ` assignments for the full list). A "done" settle with a live session auto-resumes
  // under the SAME agentId (mirrors setModel's kill+respawn-with-resume, but no live query to
  // kill here) so the fresh handle's agent_started -> deliverPending hook above drains it.
  // "failed"/no-session/a-resume-that-still-left-it-stuck all degrade to a visible status event
  // instead of silence or an infinite respawn loop. Only ever looks at kind "user_message" (a
  // child_result must never resurrect a finished conductor loop — that gap has its own fix,
  // checkDeliverTargetSettled below).
  //
  // PLAN-HOOKS.md §4.3 gap fix (a): "killed" is now ALSO handled — kill() calls this (below) with
  // the record already committed to "killed". Unlike done/failed, killed NEVER auto-resumes (an
  // explicit kill must never be silently undone by incoming mail) — every kind of stranded mail
  // (not just user_message) is surfaced as one undeliveredMessage status event instead of
  // vanishing, since nothing will ever drain this agentId's mailbox again.
  private checkPendingOnSettle(record: AgentRecord): void {
    if (record.state !== "done" && record.state !== "failed" && record.state !== "killed") return;
    const pending = record.state === "killed"
      ? this.deps.mailboxes.pending(record.agentId)
      : this.deps.mailboxes.pending(record.agentId).filter((m) => m.kind === "user_message");
    if (pending.length === 0) {
      this.autoResumeAttempted.delete(record.agentId);
      return;
    }
    const lastId = pending[pending.length - 1]!.id;
    const undelivered = (reason: string) => {
      this.autoResumeAttempted.delete(record.agentId);
      this.deps.events.append({
        agentId: record.agentId, kind: "status",
        data: { undeliveredMessage: true, reason, count: pending.length },
      });
    };
    if (record.state === "killed") { undelivered("agent killed with mail still pending"); return; }
    if (record.state === "failed") { undelivered("agent failed with a message still pending"); return; }
    if (!record.sessionId) { undelivered("undelivered message, no session to resume"); return; }
    if (this.autoResumeAttempted.get(record.agentId) === lastId) { undelivered("resume did not deliver the pending message"); return; }
    this.autoResumeAttempted.set(record.agentId, lastId);
    const { spec, treeId, depth, sessionId } = record;
    void this.spawn(
      { ...spec, resume: sessionId, resumeOnly: true },
      { agentId: record.agentId, treeId, depth },   // SAME agentId → transcript/identity continuity (CR1), mirrors setModel
    ).catch((err) => {
      this.autoResumeAttempted.delete(record.agentId);
      this.deps.events.append({
        agentId: record.agentId, kind: "status",
        data: this.scrub({ undeliveredMessage: true, reason: `auto-resume failed: ${err instanceof Error ? err.message : String(err)}` }),
      });
    });
  }

  // PLAN-HOOKS.md §4.3 gap fix (b) / §2.3 wake:"resume": generalizes checkPendingOnSettle's
  // resume machinery to a moment that is NOT the subscriber's own settle transition — a
  // resume-eligible message (a wake:"resume" signal, or a deliverWake:"resume" child_result)
  // landing in a mailbox that is ALREADY settled by the time the message arrives. Reuses the
  // SAME autoResumeAttempted guard (keyed by agentId -> last-attempted message id) so a stuck
  // agent can never respawn-loop on the same undeliverable message twice. Only resumes a "done"
  // agent (mirrors checkPendingOnSettle's own stance: "failed"/no-session never resumes, and
  // "killed" is deliberate — it must never be silently undone by later mail); EVERY other
  // outcome still emits an explicit undeliveredMessage status event — never a silent drop.
  // Callers only invoke this once they've confirmed the target is settled with mail waiting;
  // running/paused agents are the caller's own early-return (live delivery / drains on next
  // start), not this method's concern.
  private wakeSettledMailbox(agentId: string, undeliveredReason: string): void {
    const undelivered = (reason: string) => {
      this.autoResumeAttempted.delete(agentId);
      this.deps.events.append({ agentId, kind: "status", data: this.scrub({ undeliveredMessage: true, reason: `${undeliveredReason}: ${reason}` }) });
    };
    const raw = this.agents.get(agentId);
    if (!raw) return;
    // MEMORY-BOUNDED-DISK-COMPLETE: this fires for a target that may have settled long ago (a
    // subscription wake or deliverWake can arrive well after archiveColdTerminalAgents lightened
    // the record) — rehydrate the full spec from the archive first, so the respawn below never
    // carries a lightened (prompt-stripped) spec. Skipping this would resurface as a ZodError
    // from AgentSpecSchema's `prompt: min(1)` inside spawn().
    const record = raw.archived === true ? this.rehydrate(raw) : raw;
    if (record.state === "killed") { undelivered("agent killed, cannot resume"); return; }
    if (record.state === "failed") { undelivered("agent failed; automatic resume is disabled"); return; }
    if (record.state !== "done" || !record.sessionId) { undelivered("no live session to resume"); return; }
    const lastId = this.deps.mailboxes.pending(agentId).at(-1)?.id;
    if (!lastId) return;   // defensive: caller already confirmed pending mail exists
    if (this.autoResumeAttempted.get(agentId) === lastId) { undelivered("resume did not deliver the pending message"); return; }
    this.autoResumeAttempted.set(agentId, lastId);
    const { spec, treeId, depth, sessionId } = record;
    void this.spawn(
      { ...spec, resume: sessionId, resumeOnly: true },
      this.respawnOpts(record),
    ).catch((err) => undelivered(err instanceof Error ? err.message : String(err)));
  }

  // §2.3: SubscriptionRegistry's wake:"resume" hook — called AFTER it has already enqueued the
  // signal into `agentId`'s mailbox, only when that subscriber is already settled.
  resumeForSignal(agentId: string): void {
    this.wakeSettledMailbox(agentId, "signal resume failed");
  }

  // PLAN-HOOKS.md §4.3 gap fix (b): afterResult's deliverTo enqueue used to drop the mail
  // silently when the target had already settled (deliverPending's running-only guard). Called
  // right after that enqueue with the CHILD's own deliverWake opt-in (a target may have many
  // children with different needs, so this is decided per-child, not per-target).
  private checkDeliverTargetSettled(targetId: string, deliverWake: "resume" | undefined): void {
    const target = this.agents.get(targetId);
    if (!target || target.state === "running" || target.state === "paused") return;
    // AGENT-FAILURE-REACHES-CONDUCTOR: child_failed shares this settle-check with child_result —
    // a failure notification arriving after its target already settled deserves the exact same
    // undelivered-vs-resume treatment, not a silent drop.
    const pending = this.deps.mailboxes.pending(targetId).filter((m) => m.kind === "child_result" || m.kind === "child_failed");
    if (pending.length === 0) return;
    if (deliverWake === "resume") { this.wakeSettledMailbox(targetId, "deliverWake resume failed"); return; }
    this.deps.events.append({
      agentId: targetId, kind: "status",
      data: { undeliveredMessage: true, reason: "child_result arrived after deliverTo target settled", count: pending.length },
    });
  }

  // Task N-SHADOW: upsert a shadow record for one native sub-agent/workflow task,
  // so it renders as a nested left-pane row via the SAME agent.list -> treeOrder
  // -> AgentList path real agents use. Keyed on taskId (NOT toolUseId — a
  // follow-up task_updated can drop the toolUseId the original task_started
  // carried; mirrors flow.ts's identical keying decision). `parent` is the agent
  // running the Task/Agent tool: the shadow inherits its treeId/account/provider/
  // principal/membership and nests one level deeper.
  //
  // Task SHADOW-ACT (Level 1): a selected shadow now renders a live ACTIVITY panel
  // (description / last tool / summary / token+tool-use metrics / error) folded from
  // the rich agent_task fields into `shadowInfo` below — so a sub-agent/workflow row
  // shows WHAT IT'S DOING instead of an empty "no messages yet".
  //
  // R2 (inline sub-agent/workflow surfacing): Level 2, the real streaming transcript,
  // is now implemented — see subagentToolUseIndex (populated below) and onEvent's
  // shadowRoute dispatch. claude.ts threads `parent_tool_use_id` onto message_complete/
  // tool_call/tool_result; this method indexes the task's own `toolUseId` so a LATER
  // subagent-tagged event resolves back to this shadow's agentId. Deep native nesting
  // (task-under-task) still pins to parent.depth+1 (one level only) — task_started/
  // task_progress/task_updated carry no field identifying which OTHER task spawned
  // them, only which tool_use, so there's no chain to walk; out of reach without an
  // SDK-side change.
  private upsertShadow(parent: AgentRecord, data: Record<string, unknown>): void {
    const taskId = data["taskId"];
    // Reject a missing/empty/non-string taskId: it's the shadow's only stable
    // dedup key, and an empty "" would collide every unnamed task under one parent
    // into a single `shadow:<parent>:` row (each upsert clobbering the last).
    if (typeof taskId !== "string" || taskId === "") return;
    // Task SHADOW-FILTER: the SDK emits agent_task for the agent's OWN local
    // tool executions too — notably `taskType: "local_bash"` for backgrounded
    // shell commands (gate runs like `cd … && npx vitest`, `pnpm install`, tsc).
    // Those are NOT sub-agents/workflows and must never become nested shadow
    // rows (they clutter the tree with bogus "cd …"/"SHORT=…" entries). Only
    // real sub-agent (subagentType) / workflow (workflowName) tasks become
    // shadows; `local_bash` (and any future local-tool taskType) is dropped.
    if (data["taskType"] === "local_bash") return;
    const id = `shadow:${parent.agentId}:${taskId}`;
    const status = data["status"];
    // Map the SDK task status verbatim-passed by claude.ts. The task_updated
    // patch.status union is 'pending'|'running'|'completed'|'failed'|'killed'|
    // 'paused' — map every TERMINAL value to its AgentState (completed->done,
    // failed->failed, killed->killed); pending/running/paused (and task_started/
    // task_progress, which carry status:"running") are all still live.
    const state: AgentState =
      status === "completed" ? "done"
      : status === "failed" ? "failed"
      : status === "killed" ? "killed"
      : "running";
    // A STRONG name (subagentType/workflowName) is the stable identity of the
    // sub-agent/workflow; `description` is a weaker, often-transient fallback. Split
    // them so a later description-only progress update can NEVER downgrade an
    // established strong label (nor, per `named ?? taskId`, revert it to the raw id).
    // sanitizeLabel() strips newlines/control chars: a free-text `description` used
    // as a row label must stay ONE physical line or it desyncs AgentList's windowing
    // + click hit-testing (both assume one physical row per agent).
    const strong =
      (typeof data["subagentType"] === "string" && this.sanitizeLabel(data["subagentType"])) ||
      (typeof data["workflowName"] === "string" && this.sanitizeLabel(data["workflowName"])) ||
      null;
    // TASK-SHADOW-GHOST: the SHADOW-FILTER above is stateless, and the SDK stamps a task's
    // IDENTITY only on its FIRST event. `task_started` carries task_type/subagent_type; the later
    // `task_updated` carries just task_id + patch.status. So a backgrounded Bash task was dropped
    // correctly on task_started and then walked straight through this method on its COMPLETION
    // event -- materializing a shadow row at the moment the work ENDED, for a task that was never
    // a sub-agent. With no name and no description on that event, `label` fell back to the raw
    // task id and shadowInfo was never populated: a permanently empty row (observed live -- 8 of
    // them under one conductor, every label a bare task id).
    //
    // So CREATION now requires the task to identify itself as a sub-agent/workflow, which is the
    // policy the SHADOW-FILTER comment above already states. An UPDATE does not: a bare
    // task_updated for a row that already exists is exactly how a real sub-agent reaches its
    // terminal state, and `shadowAgents.has(id)` is the state the stateless filter was missing.
    if (!strong && !this.shadowAgents.has(id)) return;
    // BUG shadow-live-state: mirror this same agent_task event under the shadow's OWN
    // agentId (the primary emit below, at the bottom of onEvent, keeps appending it under
    // the PARENT's agentId too — unchanged, that's what feeds the parent's flowTree). A UI
    // client that only re-fetches agent.list on connect/reconnect (the desktop app —
    // createStore.ts's connectAndLoad has no polling refresh, by design) previously had NO
    // way to learn this shadow row's state/label from the live stream at all: nothing was
    // ever emitted under `id` itself, so the row the reducer's event-fold path materializes
    // (R2's `shadow:` id exception) sat at emptyAgent's default state:"unknown" with no
    // label forever, until/unless a snapshot happened to land. Re-emitting the identical
    // data here lets the reducer derive state/label client-side the same way this method
    // just did, purely from the event stream.
    //
    // LINEAGE (same bug class, the remainder): the snapshot record below (shadowAgents.set)
    // carries parentId/treeId/depth/projectId/membership, but until now this re-emit only
    // forwarded the scrubbed SDK task data -- an event-only client had no way to learn the
    // shadow's lineage, so the reducer's event-fold materialization left parentId/treeId/depth
    // undefined and the row rendered detached at the top level instead of nested under `parent`.
    // Additive keys only (SDK task data never uses these names), so this is scrub-safe and the
    // parent-directed flowTree emit at the bottom of onEvent is untouched.
    this.deps.events.append({
      agentId: id,
      kind: "agent_task",
      data: {
        ...this.scrub(data),
        parentId: parent.agentId,
        treeId: parent.treeId,
        depth: parent.depth + 1,
        projectId: parent.projectId,
        // SHADOW-NESTING-UI: carry the owner too (mirrors the shadowAgents.set record's own
        // `originConductorId: parent.originConductorId` below). The app's AgentList indents on
        // displayDepth, whose conductor-owned +1 bump keys off originConductorId — without it an
        // event-only client rendered a queue-worker's shadow as a SIBLING of the worker under the
        // conductor instead of nested one level deeper under the worker. `parent.originConductorId`
        // is a real AgentRecord field (null when unowned), so this is scrub-safe/additive.
        originConductorId: parent.originConductorId ?? null,
        ...(parent.membership ? { membership: parent.membership } : {}),
      },
    });
    // Task SHADOW-ACT: extract the live progress fields (present-keys-only, so the
    // spread-merge below never overwrites a prior value with `undefined`).
    const infoPatch = this.shadowInfoPatch(data);
    // R2 (inline sub-agent/workflow surfacing): index toolUseId -> this shadow's agentId, UNLESS
    // the task is skipTranscript (ambient/housekeeping — the SDK's own "hide this from the inline
    // transcript" intent, see SDKTaskStartedMessage's doc). Runs on every sighting (task_started,
    // task_progress, task_updated can each independently supply toolUseId), not just creation.
    if (typeof data["toolUseId"] === "string" && data["toolUseId"] !== "" && data["skipTranscript"] !== true) {
      this.subagentToolUseIndex.set(data["toolUseId"], id);
    }
    const existing = this.shadowAgents.get(id);
    if (existing) {
      existing.state = state;                                // running -> terminal on a later task_updated (incl. killed)
      if (strong) existing.label = strong;                   // upgrade only on a strong name; never clobber it with a transient description
      // Task SHADOW-ACT: last-known-value-wins per field — a task_progress carrying
      // only lastToolName never wipes the description task_started set.
      if (Object.keys(infoPatch).length)
        existing.shadowInfo = { ...existing.shadowInfo, ...infoPatch };
      return;
    }
    // Restates the creation gate above so `label` narrows to a plain string: TS cannot correlate
    // `strong` with the `shadowAgents.has(id)` half of that condition. Unreachable in practice.
    if (!strong) return;
    this.shadowAgents.set(id, {
      agentId: id,
      // Reuse the parent's spec (a valid AgentSpec) with conductor forced off so a
      // shadow never shows the ♦ conductor marker; the spec is otherwise unread for
      // a shadow (a list-only marker).
      spec: { ...parent.spec, conductor: false },
      accountName: parent.accountName,
      provider: parent.provider,
      state,
      depth: parent.depth + 1,
      treeId: parent.treeId,
      createdAt: Date.now(),                                 // stable after first sight (the upsert path above never resets it)
      principal: parent.principal,
      attempts: [],
      costUsd: 0,
      // P3-T1: the shadow's "spawner" is the real parent agent running the Task/Agent
      // tool; projectId is inherited (mirrors the membership inheritance just below).
      parentId: parent.agentId,
      originConductorId: parent.originConductorId,
      projectId: parent.projectId,
      shadow: true,
      label: strong,                                         // non-null past the creation gate above
      // Task SHADOW-ACT: seed the activity fields from the first sighting (omit the
      // key entirely when nothing rich landed yet, so a bare task_started shadow
      // simply has no shadowInfo and the TUI still renders "no messages yet").
      ...(Object.keys(infoPatch).length ? { shadowInfo: infoPatch } : {}),
      // Inherit team membership so the shadow stays inside its parent's team run
      // in AgentList (buildAgentRows groups by membership) and nests one extra
      // indent under the team worker that spawned it.
      ...(parent.membership ? { membership: parent.membership } : {}),
    });
    this.generation++;
  }

  // SHADOW-WORKFLOW-VISIBILITY: a top-level Workflow tool_result (the PARENT's own tool call —
  // no parentToolUseId, so it flows here under the parent agentId unchanged) carries the
  // workflow's on-disk transcript location as "Transcript dir:" / "Run ID:" lines. Correlate it
  // back to the workflow's shadow via subagentToolUseIndex — the Workflow tool_use id is exactly
  // the agent_task toolUseId that created (and indexed) the shadow — and stash the path on that
  // shadow record so shadow.workflowInspect can read the inner-agent journal on demand. A
  // tool_result whose toolId resolves to a native sub-agent shadow (no workflowName) or to
  // nothing (any ordinary tool) is a no-op. First-writer-wins: a later re-emit never clobbers a
  // captured path.
  private captureWorkflowTranscriptRef(data: Record<string, unknown>): void {
    const toolId = typeof data["toolId"] === "string" ? data["toolId"] : undefined;
    const result = typeof data["result"] === "string" ? data["result"] : undefined;
    if (toolId === undefined || result === undefined) return;
    const shadowId = this.subagentToolUseIndex.get(toolId);
    if (shadowId === undefined) return;
    const shadow = this.shadowAgents.get(shadowId);
    if (!shadow || !shadow.shadowInfo?.workflowName) return;
    const ref = parseWorkflowTranscriptRef(result);
    if (ref.dir !== undefined && shadow.workflowTranscriptDir === undefined) shadow.workflowTranscriptDir = ref.dir;
    if (ref.runId !== undefined && shadow.workflowRunId === undefined) shadow.workflowRunId = ref.runId;
  }

  // SHADOW-WORKFLOW-VISIBILITY: read-only shadow lookup for shadow.workflowInspect (reads
  // workflowTranscriptDir/workflowRunId off the record). Returns undefined for a non-shadow id.
  getShadow(agentId: string): AgentRecord | undefined {
    return this.shadowAgents.get(agentId);
  }

  // Task SHADOW-ACT: read the rich progress fields off an agent_task's data into a
  // ShadowInfo patch. PRESENT-KEYS-ONLY (a defensive typeof guard per field, and no
  // key when absent) so a spread-merge onto the prior shadowInfo preserves any field
  // this particular event omitted — the SDK's task_started/task_progress/task_updated
  // messages each carry a different subset (see claude.ts's agent_task mapping).
  // The free-text fields are run through sanitizeLabel (same as the row-label
  // derivation above) to strip newlines/tabs/control chars/ANSI ESC: `lastToolName`
  // rides a single-line `wrap="truncate-end"` row in the activity panel (a newline
  // there desyncs it), and an ANSI escape in ANY field could corrupt the terminal.
  // A field that sanitizes to "" is OMITTED (falsy) so a junk-only update never wipes
  // a prior good value through the merge — mirroring the label rule's `|| ...` skip.
  private shadowInfoPatch(data: Record<string, unknown>): ShadowInfo {
    const info: ShadowInfo = {};
    const desc = typeof data["description"] === "string" ? this.sanitizeLabel(data["description"]) : "";
    if (desc) info.description = desc;
    const tool = typeof data["lastToolName"] === "string" ? this.sanitizeLabel(data["lastToolName"]) : "";
    if (tool) info.lastToolName = tool;
    const summary = typeof data["summary"] === "string" ? this.sanitizeLabel(data["summary"]) : "";
    if (summary) info.summary = summary;
    const error = typeof data["error"] === "string" ? this.sanitizeLabel(data["error"]) : "";
    if (error) info.error = error;
    // R2 (inline sub-agent/workflow surfacing): preserve WHICH of subagentType/workflowName the
    // row's `strong` label derivation (in upsertShadow) read — the flattened `label` string alone
    // can't tell a sub-agent card from an attached-workflow view apart.
    const subagentType = typeof data["subagentType"] === "string" ? this.sanitizeLabel(data["subagentType"]) : "";
    if (subagentType) info.subagentType = subagentType;
    const workflowName = typeof data["workflowName"] === "string" ? this.sanitizeLabel(data["workflowName"]) : "";
    if (workflowName) info.workflowName = workflowName;
    // usage is claude.ts's already-normalized { totalTokens?, toolUses?, durationMs? }.
    const usage = data["usage"];
    if (usage && typeof usage === "object") {
      const u = usage as Record<string, unknown>;
      if (typeof u["totalTokens"] === "number") info.totalTokens = u["totalTokens"];
      if (typeof u["toolUses"] === "number") info.toolUses = u["toolUses"];
      if (typeof u["durationMs"] === "number") info.durationMs = u["durationMs"];
    }
    return info;
  }

  // Task N-SHADOW: force a parent's still-running shadow rows terminal. Called
  // when the parent itself reaches a terminal state (result / kill), because the
  // SDK does not always emit a terminal task_updated for every sub-agent/workflow
  // task — without this a shadow would linger "running" forever after its parent
  // is gone. Keyed on the `shadow:<parentAgentId>:` id prefix (see upsertShadow).
  private terminateShadows(parentAgentId: string, state: AgentState): void {
    const prefix = `shadow:${parentAgentId}:`;
    // BUG shadow-live-state: the SDK doesn't always send a final task_updated for a shadow
    // whose parent just ended, so this forced flip has no natural agent_task event of its
    // own to ride along on — synthesize one (status mapped back to the SDK vocabulary
    // upsertShadow itself reads) so a live-only client (no polling refresh — see the
    // matching comment in upsertShadow) still sees the terminal state without a snapshot.
    const status = state === "done" ? "completed" : state === "killed" ? "killed" : "failed";
    for (const s of this.shadowAgents.values())
      if (s.agentId.startsWith(prefix) && s.state === "running") {
        s.state = state;
        // LINEAGE: carry the same additive fields as upsertShadow's re-emit (read off the
        // shadow's own snapshot record `s`, which already has them) -- a forced-terminal flip
        // can in principle be the first agent_task an event-only client ever sees for this
        // shadow (the SDK doesn't guarantee an earlier task_started/task_progress reached the
        // wire before the parent ended), so this emit must be lineage-complete on its own too.
        this.deps.events.append({
          agentId: s.agentId,
          kind: "agent_task",
          data: {
            status,
            parentId: s.parentId,
            treeId: s.treeId,
            depth: s.depth,
            projectId: s.projectId,
            ...(s.membership ? { membership: s.membership } : {}),
          },
        });
      }
  }

  // Task N-SHADOW: collapse newlines/tabs/control chars (incl. ANSI ESC) to single
  // spaces and trim, so a free-text SDK `description` used as a shadow row label
  // can never span multiple physical lines. AgentList (Ink <Text wrap="truncate-end">)
  // truncates on WIDTH but renders an embedded "\n" as a second physical row, which
  // would break the one-physical-row-per-agent invariant its windowing/click
  // hit-testing rely on. A real agent's shortId can't contain these characters.
  private sanitizeLabel(s: string): string {
    return s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  }

  // Deep-redact: SDK raw payloads are plain JSON (no circular refs), and a
  // secret can be nested inside an object/array in event data as easily as it
  // can sit at the top level — a shallow, top-level-only scrub lets those leak
  // to the on-disk EventLog (spec §6).
  private scrubValue(v: unknown): unknown {
    if (typeof v === "string") return redact(v, this.secrets);
    if (Array.isArray(v)) return v.map((x) => this.scrubValue(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = this.scrubValue(val);
      return out;
    }
    return v;
  }

  private scrub(data: Record<string, unknown>): Record<string, unknown> {
    if (this.secrets.length === 0) return data;
    return this.scrubValue(data) as Record<string, unknown>;
  }

  // spec §7: rate-limit-class errors on an "auto" account failover to the next
  // eligible account (same-provider unless spec.crossProviderFailover opts in);
  // explicit (non-auto) accounts, and every other error class, fail loudly.
  protected onError(record: AgentRecord, message: string, errData?: Record<string, unknown>): void {
    // ACCOUNT-AUTOSWITCH: put the current turn's messages back BEFORE deciding the
    // disposition, so failover, holdUntilReset and hard-fail all inherit it from one place.
    // Delete after, so a second error for the same agent can't enqueue them twice.
    const stranded = this.inFlight.get(record.agentId);
    if (stranded && stranded.length > 0) {
      for (const m of stranded) {
        this.deps.mailboxes.enqueue(record.agentId, {
          from: m.from, kind: m.kind, text: m.text, engineId: m.engineId, message: this.deps.mailboxes.envelope(m), id: randomUUID(),
          ...(m.meta ? { meta: m.meta } : {}),
          ...(m.images ? { images: m.images } : {}),
          ...(m.content ? { content: m.content } : {}),
          ...(m.slash ? { slash: true } : {}),
          ...(m.force ? { force: true } : {}),
        });
      }
    }
    this.inFlight.delete(record.agentId);
    // F08: one classifier for the whole disposition. KIMI-HANDSHAKE-CRASH-PARITY (the
    // `data.phase:"handshake"` override) now lives inside classifyFailure — see failover.ts.
    const base = classifyFailure(message, errData, this.now());
    // F08 BAD-REQUEST-NEVER-SPENDS-ACCOUNTS: the ONE new disposition. Everything else below is
    // today's behaviour re-expressed as booleans. A rejected REQUEST fails identically on every
    // account and after every wait, so it must not consult parseSessionLimit (a 400 body echoing
    // "…resets 8:20pm" would otherwise park a permanently-doomed agent for an hour), must not
    // rotate accounts, and must not enter the crash-loop breaker. With reset forced null and
    // both failoverAccount/restartInPlace false it falls straight through to markFailed below —
    // no special-case block, which is why this cannot drift out of sync with the other causes.
    const reset = base.cause === "bad-request" ? null : parseSessionLimit(message, this.now());
    // F08: a PARSEABLE RESET is itself definitive proof of an account cap — stronger evidence
    // than any regex. This is BARE-LIMIT-NO-FAILOVER expressed as a disposition upgrade instead
    // of a widened pattern: "You've hit your account limit · resets 4:10am" matches no CAP row,
    // classified unknown, never failed over, and the agent idled on a capped account until a
    // human noticed. Preserves the old `att.errorClass = reset ? "rate-limit" : cls` exactly,
    // because account-cap's errorClass IS "rate-limit".
    const d = reset && base.cause !== "account-cap"
      ? dispositionFor("account-cap", "parsed reset time", this.now())
      : base;
    record.failure = d;
    const att = record.attempts[record.attempts.length - 1];
    if (att) { att.endedAt = Date.now(); att.errorClass = d.errorClass; }

    // We PREFER cross-account failover first (below) — HOLD is only the fallback when no
    // failover target exists. `reset` is null for a bare rate limit (no reset time), so a
    // plain 429/overloaded keeps today's failover-or-fail behavior unchanged.
    if (d.failoverAccount && record.spec.account === "auto") {
      this.deps.cooldowns.stamp(record.accountName);
      try {
        const next = this.routeAccount(record.spec);   // spec §7 confinement now lives inside routeAccount (anchor provider + crossProviderFailover)
        const fromProvider = record.provider;
        // keep the backend lookup in sync with the resolved account: launch()
        // dispatches via backends.get(record.provider), and record.provider was
        // only ever set once at spawn() time — on a cross-provider reroute it
        // must be updated here, or launch() keeps dispatching through the
        // ORIGINAL provider's backend instead of the rerouted account's provider.
        record.provider = this.deps.registry.get(next).provider;
        this.deps.events.append({
          agentId: record.agentId, kind: "failover",
          data: this.scrub({
            from: record.accountName, fromProvider,
            to: next, toProvider: record.provider,
            reason: message,
          }),   // reason may echo provider error text — the scrub wrapper stays (spec §6 redaction)
        });
        // if the rerouted launch itself rejects later (e.g. credential resolve
        // fails on the new account), commit failed state AND publish a terminal
        // event so a pending waitFor() observes it instead of hanging (mirrors kill()).
        void this.launch(record, next).catch((rerouteErr) => {
          this.settleUnrecordedUsage(record);   // LEDGER-UNCLEAN-EXIT
          this.markFailed(record, `rerouted launch failed: ${rerouteErr instanceof Error ? rerouteErr.message : String(rerouteErr)}`);
          this.checkPendingOnSettle(record);   // LATE-MESSAGE-RESUME: surface any stranded mailbox message
        });
        return;                                    // state stays "running"
      } catch { /* no eligible failover account left — HOLD below if we have a reset, else fail */ }
    }
    // No failover target (auto path exhausted above, or a non-auto/explicit account which
    // never fails over): if this was a session limit with a parseable reset, HOLD the agent
    // until then instead of losing its work. Otherwise keep today's fail-loud behavior.
    if (d.holdForReset && reset) { this.holdUntilReset(record, reset.resetAt, message); return; }
    // CONTEXT-OVERFLOW-RECOVERY: a resumed native thread that blew the transport's own frame/
    // context ceiling (see failover.ts's CONTEXT_OVERFLOW signal) can never succeed by retrying
    // the SAME resume id — every disposition boolean is false so it falls through both branches
    // above, and this is checked before restartInPlace because context-overflow needs a DIFFERENT
    // recovery (drop resume, fresh session) than a plain crash restart (resume the same session).
    // Capped at one consecutive recovery per record: a SECOND context-overflow while
    // contextOverflowRecoveries is still 1 (i.e. the fresh session it just launched into also
    // overflowed) proves relaunching alone can't fix it, so this falls through to markFailed
    // below instead of looping forever on the same oversized thread.
    if (d.cause === "context-overflow") {
      const recoveries = (record.contextOverflowRecoveries ?? 0) + 1;
      if (recoveries <= 1) {
        record.contextOverflowRecoveries = recoveries;
        // Drop resume so launch() starts a brand-new native thread instead of re-resuming the
        // poisoned one — mirrors resumePaused's own `record.spec = {...}` mutation idiom.
        record.spec = { ...record.spec, resume: null, resumeOnly: false };
        this.deps.events.append({
          agentId: record.agentId, kind: "status",
          data: this.scrub({ state: "running", resumed: true, account: record.accountName, resumeFallback: "context-overflow", reason: message }),
        });
        void this.launch(record, record.accountName).catch((relaunchErr) => {
          this.settleUnrecordedUsage(record);
          this.markFailed(record, `context-overflow recovery failed: ${relaunchErr instanceof Error ? relaunchErr.message : String(relaunchErr)}`, { failure: d, ...this.errExtra(errData) });
          this.checkPendingOnSettle(record);
        });
        return;
      }
      // Falls through to settleUnrecordedUsage/markFailed below — a second consecutive overflow
      // must fail loud, not loop.
    }
    // R2 (self-healing supervision): a backend-crash-classified error (process exit, stream
    // broken/closed, ECONNRESET — see failover.ts's CRASH patterns) used to fall straight
    // through to the generic fail-loud path below, permanently killing the agent on its FIRST
    // crash. Route it through the crash-loop backoff+circuit-breaker instead — checked after
    // the rate-limit/session-reset dispositions above (which take priority when a message
    // happens to match both) and before the plain-fail fallback.
    if (d.restartInPlace) { this.scheduleCrashRestart(record, message, "crash-loop-backoff", errData); return; }
    this.settleUnrecordedUsage(record);   // LEDGER-UNCLEAN-EXIT
    // POST-LANDING-PROVIDER-FAILURE: a provider error arriving here (e.g. "Codex model
    // capabilities unavailable") tells us nothing about whether the agent's work already landed
    // — it only means THIS turn broke. kill()/reportUnresponsive() always stamp the landing fact
    // before marking terminal; this plain fail-loud path used to skip straight to markFailed,
    // leaving worktreeUnlanded undefined even when the branch was already merged to main, so
    // scheduler.ts settle() had no fact to act on and requeued/retried already-landed work.
    // Mirrors kill()'s ordering: snapshot any uncommitted work, THEN check ancestry.
    autoCommitDirtyWorktree({ isolation: record.spec.isolation, cwd: record.spec.cwd, agentId: record.agentId, workdirKey: record.spec.workdirKey }, `agent ${record.agentId} failed: ${message}`);
    this.stampWorktreeLanding(record, record.agentId);
    // FEATURE-4: every OTHER record.state="failed"/"paused"/"killed" transition in this file
    // is already paired with a status event carrying that state (the rerouted-launch catch
    // just above, holdUntilReset, resumePaused's catch, kill(), closeInput()) — this was the
    // one exception, observable only via the live in-memory record. Boot-time replay
    // (reattach.ts's reconstructAgentsFromLog) now depends on every state transition being
    // durably visible in the event log, since state.json is no longer rewritten on every event.
    this.markFailed(record, message, { failure: d, ...this.errExtra(errData) });
  }

  // AGENT-FAILURE-REACHES-CONDUCTOR: pluck just the diagnostic fields (C) claude.ts/codex.ts
  // attach to a process-death error event — everything else on `errData` (raw SDK message
  // duplicate, etc.) is irrelevant to the conductor and left out of the status event/mailbox meta.
  private errExtra(errData?: Record<string, unknown>): Record<string, unknown> {
    if (!errData) return {};
    const out: Record<string, unknown> = {};
    if (errData["exitCode"] !== undefined) out["exitCode"] = errData["exitCode"];
    if (errData["stderrTail"]) out["stderrTail"] = errData["stderrTail"];
    return out;
  }

  // Session-limit HOLD: park an agent as "paused" until its account's limit resets, then
  // auto-resume. Reuses CooldownTracker (stampUntil the parsed reset, so routeAccount keeps
  // avoiding the account) rather than a parallel system, and drops the dead backend handle
  // (its query already errored) — resumePaused creates a fresh one. `reason` is the raw
  // provider error (may echo an injected credential) → scrubbed before it hits the event log.
  //
  // DEFERRED (flagged): a paused agent does NOT count against the running-agent guardrails
  // (spawn caps / per-account cap / team maxConcurrent all filter state==="running"), so a
  // pending task can spawn a replacement while this one holds. On the common AUTO path that is
  // just failover onto another account (benign). On an EXPLICIT account it can transiently
  // exceed capFor(account) when several tasks pause on the same account and resume together —
  // a narrow, transient overshoot left for a follow-up (counting paused against caps would
  // instead block replacements for the whole hold, a separate design tradeoff).
  protected holdUntilReset(record: AgentRecord, resetAt: number, reason: string): void {
    const until = this.reconcileResetAt(record.accountName, resetAt);
    this.deps.cooldowns.stampUntil(record.accountName, until);
    // EXTRA-USAGE-VISIBILITY: stamp what the provider last said about this account's SECOND
    // allowance onto the hold itself. Deliberately recorded, not acted on: whether a rejected
    // primary window plus an `allowed` overage means an immediate retry would succeed is provider
    // behaviour nobody here has observed, and skipping the hold on that assumption would be the
    // same class of mistake as QUOTA-METER-WRONG-BY-100X — a plausible reading of an undocumented
    // field, shipped as if verified. What this DOES buy is the ability to tell a hold that had no
    // alternative from one that may not have been necessary, which is the evidence any future
    // automation needs and which was previously thrown away at the backend boundary.
    const overage = this.deps.quotas?.getOverage(record.accountName);
    this.parkPaused(record, until, "session-limit", {
      account: record.accountName, detail: reason,
      ...(overage ? {
        overageStatus: overage.status,
        ...(overage.disabledReason ? { overageDisabledReason: overage.disabledReason } : {}),
        ...(overage.inUse !== null ? { overageInUse: overage.inUse } : {}),
      } : {}),
    });
  }

  // QUOTA-UNCOOL: end an account's cooldown EARLY and un-park everything that was holding for it.
  //
  // The bug this exists for: holdUntilReset decided the hold's duration ONCE, from a parsed error
  // string, and nothing could revise it. Observed live — the provider's session window had rolled
  // (a fresh reading showed 15% used, window started 16:10, resets 21:10) while the daemon still
  // reported the account cooling until 17:10, refused every spawn onto it, and left three agents
  // parked. Fresh evidence existed and had no way to reach the decision.
  //
  // Both halves happen together on purpose: clearing the stamp alone makes the account routable
  // for NEW spawns while the agents that were actually waiting on it stay parked (which is what
  // the operator's manual workaround produced), and resuming alone leaves routeAccount still
  // refusing the account. Resumes are KICKED, never awaited — a launch can take seconds and this
  // runs inside a poll tick and an RPC handler, neither of which may block on a backend spawn.
  /** QUOTA-UNCOOL: is anything parked waiting for THIS account's limit to lift? Distinct from
   *  CooldownTracker.isCooling and not derivable from it — the tracker is in-memory while the
   *  pause is persisted (AgentRecord.resumeAt), so across a daemon restart the parked agents are
   *  the only surviving evidence that the account is being waited on. */
  hasSessionLimitPause(account: string): boolean {
    for (const record of this.agents.values()) {
      if (record.state === "paused" && record.pauseReason === "session-limit" && record.accountName === account) return true;
    }
    return false;
  }

  clearAccountCooldown(
    account: string,
    clearedBy: "quota-poll" | "operator",
    evidence?: Record<string, unknown>,
  ): { account: string; wasCooling: boolean; clearedUntil: number | null; resumed: string[] } {
    const clearedUntil = this.deps.cooldowns.clear(account);
    // Not gated on `clearedUntil`: a session-limit pause is persisted (AgentRecord.resumeAt) but
    // CooldownTracker is in-memory, so after a daemon restart the parked agents outlive the stamp
    // entirely. Refusing to resume them because "it wasn't cooling" would fail exactly the case an
    // operator reaches for this in.
    const resumed: string[] = [];
    for (const record of this.agents.values()) {
      if (record.state !== "paused" || record.pauseReason !== "session-limit") continue;
      if (record.accountName !== account) continue;
      resumed.push(record.agentId);
    }
    this.deps.events.append({
      agentId: "accounts", kind: "account_cooldown_cleared",
      data: this.scrub({ account, clearedBy, clearedUntil, resumed, ...(evidence ? { evidence } : {}) }),
    });
    for (const agentId of resumed) void this.resumePaused(agentId).catch(() => {});
    return { account, wasCooling: clearedUntil !== null, clearedUntil, resumed };
  }

  // QUOTA-METER-WRONG-BY-100X: `parsedResetAt` is scraped from a human-readable provider error
  // string (parseSessionLimit) and can be wrong/stale — observed live: a "resets 2:10am" message
  // stamped a cooldown that would have released the account ~2 hours before its REAL reset
  // (~04:10, per the account's own quota window). When this account already has a
  // guard-validated ("implausible" windows never reach QuotaTracker — see failover.ts) session
  // quota window on file whose resetsAt is (a) still in the future and (b) LATER than the parsed
  // string's reset, trust the quota reading instead. This can only ever EXTEND a cooldown, never
  // shorten one below what the string said: a missing/stale/earlier-than-parsed quota window
  // falls straight back to `parsedResetAt` unchanged, so a stale quota reading can never release
  // a genuinely capped account early — the one direction this task must not move in.
  //
  // QUOTA-UNCOOL: and only when that reading is FRESH. "Trust the quota window over the error
  // string" was written assuming the window described the CURRENT state of the account — but
  // QuotaTracker keeps its last known-good value forever (never fabricates, never expires), so a
  // window fetched hours ago (a failing poll, an unsupported auth type that once worked, a
  // long-idle account) would keep LENGTHENING every new hold with a resetsAt that has nothing to
  // do with the limit just hit. A stale reading must be treated as no reading at all: fall back
  // to the parsed string, which at least came from THIS error.
  // `fetchedAt` is per-ACCOUNT (any window kind), not per-session-window — QuotaTracker stamps it
  // on every accepted record — so a fresh weekly reading marks the session window fresh too. That
  // is the correct coarse read: both windows come from the same response.
  private reconcileResetAt(account: string, parsedResetAt: number): number {
    const quota = this.deps.quotas?.get(account);
    const session = quota?.windows.find((w) => w.kind === "session");
    if (!session) return parsedResetAt;
    const freshnessMs = this.deps.quotaFreshnessMs ?? DEFAULT_QUOTA_FRESHNESS_MS;
    if (this.now() - (quota?.fetchedAt ?? 0) > freshnessMs) return parsedResetAt;
    return session.resetsAt > this.now() && session.resetsAt > parsedResetAt ? session.resetsAt : parsedResetAt;
  }

  // R2 (self-healing supervision): the generic "park as paused, resume later under the same
  // agentId/session" tail shared by holdUntilReset (session-limit HOLD) and
  // scheduleCrashRestart (crash-loop backoff) below — extracted so crash-loop recovery reuses
  // the EXACT same mechanics (resumeAt persistence, the status event shape, the timer arm)
  // instead of a parallel implementation. Account-cooldown stamping is deliberately NOT part of
  // this tail — that's session-limit-specific (a crash isn't an account rate limit) and stays in
  // holdUntilReset itself. `extra` is merged into the status event's data (scrubbed) — each
  // caller supplies its own reason-specific fields.
  // IDLE-REAP: release the OS process of an agent that has been idle BETWEEN TURNS, keeping the
  // record and its session so the next message picks up exactly where it left off. The sibling
  // of reattachDormant — same resting state ("paused", no clock, revivable), different trigger.
  //
  // Unlike parkPaused below this KILLS the handle rather than merely dropping the reference:
  // reclaiming CPU/RAM is the entire point, and a dropped-but-alive process would additionally
  // be invisible to the terminal-process sweep (whose owner is "paused", not terminal) — a real
  // leak rather than a saving. `resumeOnly` is stamped for the same reason reattachDormant
  // stamps it: waking must resume the session IDLE, never replay the original prompt as new work.
  // PAUSED-CONDUCTOR: "an agent with live sub-agents must not be auto-paused". Wall-clock idleness
  // says nothing about whether an agent is still NEEDED — a conductor waiting on five workers looks
  // exactly as idle as an abandoned one, and parking it strands every worker whose deliverTo /
  // ask_agent points back at it (the operator-reported bug). Which records count is ONE rule,
  // isLiveDependant, shared with HealthMonitor's per-tick awaitedBy set so the two layers can never
  // disagree. Shadows live in a separate map and are excluded for free — they are list-only
  // markers with no live process. Exact-match deliverTo on purpose: an "engine/id"-qualified value
  // names a FEDERATED target, not this local agent. Ownership is the three stamped edges only —
  // a same-tree depth+1 heuristic was tried and dropped: a sibling's child sits at that depth too.
  hasLiveDependants(agentId: string): boolean {
    for (const [id, r] of this.agents) {
      if (id === agentId || !isLiveDependant(r)) continue;
      if (r.spec.deliverTo === agentId || r.originConductorId === agentId || r.parentId === agentId) return true;
    }
    return false;
  }

  async parkIdle(agentId: string, idleMs: number): Promise<void> {
    const record = this.agents.get(agentId);
    if (!record || record.state !== "running") return;
    if (this.killingRecords.has(record)) return;
    if (this.hasLiveDependants(agentId)) return;   // PAUSED-CONDUCTOR: see hasLiveDependants
    const handle = this.handles.get(agentId);
    this.handles.delete(agentId);
    await handle?.kill().catch(() => {});
    if (this.agents.get(agentId) !== record || record.state !== "running" || this.killingRecords.has(record)) return;
    record.state = "paused";
    record.pauseReason = "idle-timeout";
    // F09.QA (A7): a parked agent owes no ack. Without this the 45 s timer fires while the
    // record is "paused", firePromptStall drops it — but PromptAckWatch has already marked the
    // entry `fired`, so the FIRST turn-opening event after resume resolves a stall that was
    // never announced and appends a bogus promptStallCleared status.
    this.promptAck.forget(agentId);
    record.promptStall = null;
    delete record.resumeAt;                 // no clock: this hold ends when something needs the agent
    record.spec = { ...record.spec, resume: record.sessionId ?? null, resumeOnly: true };
    this.deps.events.append({
      agentId, kind: "status",
      data: this.scrub({ state: "paused", paused: true, reason: "idle-timeout", idleMs }),
    });
  }

  // OPERATOR-HOLD: stop this agent NOW without losing it. The SDK cannot freeze a turn in place,
  // so an immediate hold means aborting the running turn — and the only thing that makes that
  // safe is putting the turn's own input BACK in the mailbox (the same stranded-inFlight move
  // onError already makes). On release the session resumes with its full context and that input
  // is redelivered, so the turn runs again rather than being lost.
  //
  // What this does NOT undo, and must not pretend to: side effects the aborted turn already
  // caused. A file it wrote stays written. The re-run is of the model's reasoning, not of the
  // world.
  //
  // Returns whether this call is what put the agent on hold, so a bulk caller can report what
  // actually happened rather than counting requests (an already-held or terminal agent is not an
  // error — it is simply not a transition).
  async hold(agentId: string): Promise<boolean> {
    this.providerTransfers.get(agentId)?.controller.abort();
    const record = this.agents.get(agentId);
    if (!record || record.state !== "running") return false;
    if (this.killingRecords.has(record)) return false;
    // Handle FIRST, exactly as parkIdle does: a kill whose handle is still registered would let
    // the teardown's own terminal event flip this record out of the hold we are establishing.
    const handle = this.handles.get(agentId);
    this.handles.delete(agentId);
    const stranded = this.inFlight.get(agentId) ?? [];
    for (const m of stranded) {
      this.deps.mailboxes.enqueue(agentId, {
        from: m.from, kind: m.kind, text: m.text, engineId: m.engineId, message: this.deps.mailboxes.envelope(m), id: randomUUID(),
        ...(m.meta ? { meta: m.meta } : {}),
        ...(m.images ? { images: m.images } : {}),
        ...(m.content ? { content: m.content } : {}),
        ...(m.slash ? { slash: true } : {}),
        ...(m.force ? { force: true } : {}),
      });
    }
    this.inFlight.delete(agentId);
    await handle?.kill().catch(() => {});
    if (this.agents.get(agentId) !== record || record.state !== "running" || this.killingRecords.has(record)) return false;
    record.state = "paused";
    record.pauseReason = "operator-hold";
    this.promptAck.forget(agentId);                             // F09 (A7): a held agent owes no ack
    record.promptStall = null;
    delete record.resumeAt;                 // no clock — a hold ends when the operator says so
    record.spec = { ...record.spec, resume: record.sessionId ?? null, resumeOnly: true };
    this.deps.events.append({
      agentId, kind: "status",
      data: this.scrub({ state: "paused", paused: true, reason: "operator-hold", requeued: stranded.length }),
    });
    return true;
  }

  /** The other half of hold(): resume the session and let launch()'s own agent_started hook drain
   * the mailbox that built up (including the aborted turn's own input). Dormant restart/idle
   * sessions can also be explicitly released. Releasing a session-limit or crash-backoff hold early
   * would restart an agent into the very condition that parked it. */
  /* QUOTA-UNCOOL: `force` is the explicit escape from that refusal, for the one pause reason where
   * the operator can hold better evidence than the hold does — a "session-limit" hold's duration
   * came from a parsed error string, and an operator looking at a rolled quota window knows it is
   * wrong. Still deliberately narrow: a crash-backoff pause is NOT force-releasable, because
   * nothing an operator can see says a crashing agent stopped crashing. */
  async release(agentId: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const record = this.agents.get(agentId);
    if (!record || record.state !== "paused") return false;
    const releasable = record.pauseReason === "operator-hold" || isRevivableHold(record)
      || (opts.force === true && record.pauseReason === "session-limit");
    if (!releasable) return false;
    await this.resumePaused(agentId);
    // Drain EXPLICITLY rather than waiting on launch()'s agent_started hook. "Release delivers
    // what queued while it was held" is the half of the contract that makes a hold safe, and
    // leaving it to a backend event makes it conditional on every backend emitting that event —
    // one that does not would strand the whole backlog with the agent sitting there running.
    // Idempotent: deliverPending chains behind any in-flight batch and a drained mailbox is a
    // no-op, so the hook firing too is harmless.
    this.deliverPending(agentId);
    return true;
  }

  private parkPaused(record: AgentRecord, resumeAt: number, pauseReason: NonNullable<AgentRecord["pauseReason"]>, extra: Record<string, unknown>): void {
    if (this.killingRecords.has(record) || record.state === "killed") return;
    this.handles.delete(record.agentId);
    record.state = "paused";
    record.resumeAt = resumeAt;                       // snapshotted → survives a daemon restart (reattachPaused)
    record.pauseReason = pauseReason;
    this.promptAck.forget(record.agentId);   // F09.QA (A7): same reason as parkIdle's forget
    record.promptStall = null;
    this.deps.events.append({
      agentId: record.agentId, kind: "status",
      // `state:"paused"` mirrors the reattach "interrupted" / setModel "failed" status-event
      // convention so a future TUI reducer can surface the HOLD uniformly (spec: emit clear events).
      data: this.scrub({ state: "paused", paused: true, reason: pauseReason, resumeScheduledAt: resumeAt, ...extra }),
    });
    this.scheduleResume(record.agentId, resumeAt);
  }

  // R2 (self-healing supervision): crash-loop backoff + circuit breaker — the disposition for a
  // backend-crash-classified error (onError), a liveness-probe-reported wedge
  // (reportUnresponsive), or a failed reattach (recoverFromFailedReattach). `reason` is a raw
  // free-text description (the provider error, or a synthesized liveness/reattach message) —
  // stored under the status event's `detail` key, mirroring holdUntilReset's own
  // reason-param-is-actually-raw-text convention. `pauseReason` lets recoverFromFailedReattach
  // tag its own call distinctly from a plain crash/wedge, even though both share this one
  // recovery mechanism.
  private scheduleCrashRestart(
    record: AgentRecord, reason: string,
    pauseReason: "crash-loop-backoff" | "reattach-recovery" = "crash-loop-backoff",
    errData?: Record<string, unknown>,
  ): void {
    const policy = this.deps.crashLoopPolicy ?? (record.failure?.cause === "provider-capacity"
      ? { ...DEFAULT_CRASH_LOOP_POLICY, baseDelayMs: 30_000 }
      : DEFAULT_CRASH_LOOP_POLICY);
    const crashCount = (record.crashCount ?? 0) + 1;
    record.crashCount = crashCount;
    if (crashCount > policy.maxRestarts) {
      // Circuit breaker trips: no further auto-restart. Audit-specific event FIRST, then the
      // standard status{failed} event every other terminal transition in this file already
      // pairs with (see the FEATURE-4 comment a few lines above onError's own fail-loud
      // fallback) — replay/reattach depend on THAT one, not circuit_breaker_tripped.
      // AGENT-FAILURE-REACHES-CONDUCTOR (Gap D): this is the ONLY crash-loop outcome that
      // notifies deliverTo — a crash that's about to be retried below (parkPaused) is not news
      // for the conductor, only the terminal give-up is. Getting this backwards turns the fix
      // into mailbox spam the conductor learns to ignore.
      record.circuitOpen = true;
      this.handles.delete(record.agentId);
      // LEDGER-UNCLEAN-EXIT: this is the terminal disposition for BOTH a real backend crash-loop
      // and reportUnresponsive's liveness-probe reap (see its own call into this method) —
      // exactly the two exit paths that used to lose the run's already-accrued cost to a silent
      // $0 when retries ran out.
      this.settleUnrecordedUsage(record);
      this.deps.events.append({ agentId: record.agentId, kind: "circuit_breaker_tripped", data: this.scrub({ crashCount, reason }) });
      // POST-LANDING-PROVIDER-FAILURE: same gap as onError's plain fail-loud path — a crash-loop
      // that trips the breaker via a repeated in-turn error (not reportUnresponsive, which already
      // stamps this) must not requeue work already merged to main. See the sibling comment in
      // onError for the full incident.
      autoCommitDirtyWorktree({ isolation: record.spec.isolation, cwd: record.spec.cwd, agentId: record.agentId, workdirKey: record.spec.workdirKey }, `agent ${record.agentId} circuit breaker tripped: ${reason}`);
      this.stampWorktreeLanding(record, record.agentId);
      this.markFailed(record, reason, { circuitOpen: true, crashCount, ...(record.failure ? { failure: record.failure } : {}), ...this.errExtra(errData) });
      this.checkPendingOnSettle(record);   // LATE-MESSAGE-RESUME: surface any stranded mailbox message
      return;
    }
    // LEDGER-UNCLEAN-EXIT follow-up (flagged, not shipped, at that run's landing): the crashed
    // process is about to be replaced by a FRESH one whose cumulative cost counter restarts at
    // 0 (claude.ts/codex.ts's cumulative usage is per-process-session). Without this flush, the
    // dead attempt's already-accrued spend just sat in record.lastTurnCostUsd until the next
    // attempt's own turn_complete overwrote it (last-known-value-wins) — silently dropping real,
    // already-billed cost for the MOST COMMON crash-loop outcome: a retry that goes on to
    // succeed cleanly, which never reaches settleUnrecordedUsage's other five call sites (those
    // only fire on a terminal kill/circuit-break, not a plain retry-then-recover). Same
    // idempotent flush the circuit-breaker branch above already uses: books a "usage_settle" row
    // for whatever this attempt genuinely accrued, then clears lastTurnCostUsd so the next
    // attempt's stash starts clean instead of being compared against a dead process's figures.
    // No-op (by settleUnrecordedUsage's own guard) when this attempt crashed before any
    // turn_complete ever landed — a real $0 attempt, not a bug.
    this.settleUnrecordedUsage(record);
    const delayMs = computeBackoffMs(policy, crashCount);
    const resumeAt = this.now() + delayMs;
    this.parkPaused(record, resumeAt, pauseReason, { crashCount, attempt: crashCount, delayMs, detail: reason });
  }

  // Session-limit HOLD: arm a single bounded, unref'd wake at `resetAt` (no busy-wait). A
  // prior timer for the same agent is cleared first so a re-pause/reattach never leaves two.
  // setTimeout clamps a delay past the 32-bit range (~24.8 days) to fire ~immediately, which
  // would tight-loop relaunch/error on a far-future reset — so cap each hop and re-arm until
  // the reset is actually reached.
  protected scheduleResume(agentId: string, resetAt: number): void {
    const prev = this.resumeTimers.get(agentId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.resumeTimers.delete(agentId);
      if (this.now() < resetAt) this.scheduleResume(agentId, resetAt);   // far-future reset chunked into ≤MAX_TIMER_DELAY_MS hops
      else void this.resumePaused(agentId).catch(() => {});
    }, Math.min(Math.max(0, resetAt - this.now()), MAX_TIMER_DELAY_MS));
    timer.unref?.();
    this.resumeTimers.set(agentId, timer);
  }

  // Session-limit HOLD: resume a paused agent when its account's limit has reset. Re-launches
  // under the SAME agentId on the SAME account (the reset has lifted its limit), resuming the
  // prior SDK session (resume=sessionId) so accumulated work/context is preserved rather than
  // restarting from scratch — the existing spawn-resume path. A missing sessionId (limit hit
  // before the session initialized) degrades to a fresh session (resume=null, prompt re-sent).
  // No-op unless the agent is still paused (a kill or an earlier resume already moved it on).
  async resumePaused(agentId: string, via?: { resumedBy: string; from?: string }): Promise<void> {
    if (this.providerTransfers.has(agentId)) throw new GuardrailError("a manual provider switch is already in progress");
    const record = this.agents.get(agentId);
    if (!record || record.state !== "paused") return;
    const prev = this.resumeTimers.get(agentId);
    if (prev) { clearTimeout(prev); this.resumeTimers.delete(agentId); }
    const wokeFrom = record.pauseReason;   // captured BEFORE the delete below: the event says WHY it woke
    const recoveryPrompt = record.sessionId && wokeFrom === "crash-loop-backoff"
      && (record.failure?.cause === "provider-capacity" || record.failure?.cause === "provider-stream")
      ? "Continue the unfinished user task from the saved conversation. The previous turn was interrupted by a temporary provider failure. First inspect the latest tool results and existing files to determine what already completed; a missing stream event does not mean a command failed. Do not repeat completed actions or replay the original task from scratch. Keep the user's current instructions and constraints."
      : undefined;
    delete record.resumeAt;
    delete record.pauseReason;   // R2: purely diagnostic tag, cleared alongside resumeAt
    record.state = "running";                        // commit BEFORE launch/append (waitFor + re-entrancy invariant)
    // PAUSED-CONDUCTOR: parkIdle/reattachDormant stamp `resumeOnly: true` INTO the stored spec,
    // and both backends skip pushing the prompt when it is set — so waking a record whose
    // sessionId never materialized would launch a session with NO input at all and settle
    // instantly, over and over (the observed crash-loop shape). With nothing to resume, a fresh
    // launch of the record's own spec is the only wake that can actually do work.
    const freshFallback = !record.sessionId && record.spec.resumeOnly === true;
    // Legacy settings changes left ephemeral workers resume-only with no queued input.
    // Crash recovery must seed their task again. Operator holds and dormant sessions
    // already have mailbox-driven wake semantics and must not get a duplicate seed.
    const resumeTask = record.membership && !record.spec.session
      && (wokeFrom === "crash-loop-backoff" || wokeFrom === "reattach-recovery");
    record.spec = { ...record.spec, resume: record.sessionId ?? null,
      ...(freshFallback || resumeTask ? { resumeOnly: false } : {}) };
    this.deps.events.append({ agentId, kind: "status", data: {
      state: "running", resumed: true, account: record.accountName,
      // Observability for the operator's "why did this wake?": who woke it, and out of what hold.
      ...(via ? { resumedBy: via.resumedBy, ...(via.from ? { from: via.from } : {}) } : {}),
      ...(wokeFrom ? { resumedFromPause: wokeFrom } : {}),
      ...(freshFallback ? { resumeFallback: "fresh-launch" } : {}),
    } });
    try {
      await this.launch(record, record.accountName, recoveryPrompt);
      // Race guard: kill(agentId) landing DURING launch()'s pre-handle await window (credential
      // resolve) sees state "running" with no handle yet (holdUntilReset dropped it), so it marks
      // us killed but has nothing to terminate. Tear down the handle launch just created, else a
      // live backend session lingers and its later `result` would flip the record killed→done.
      // Re-read via status() — a concurrent async mutation is invisible to TS's flow narrowing.
      if (this.status(agentId).state === "killed") {
        await this.handles.get(agentId)?.kill().catch(() => {});
        this.handles.delete(agentId);
      } else {
        this.reissueRemoteControlIntent(agentId);   // REMOTE-CONTROL-SURVIVES-PAUSE
      }
    } catch (e) {
      const message = (e as Error).message;
      // STALE-RESUME-SESSION-FALLBACK: the record HAD a captured sessionId (freshFallback is the
      // separate no-sessionId case above, already spared this path) but the backend rejects it as
      // gone/expired — retrying with the SAME resume id would fail identically forever. Fall back
      // once to a fresh launch of the original spec (mirrors freshFallback's own resumeOnly:false
      // shape) instead of failing the revive outright. A non-stale throw (generic backend/network
      // error, credential failure, ...) falls through to the terminal markFailed below unchanged —
      // see supervisor-session-limit.test.ts's "resume whose re-launch throws fails terminally".
      if (record.sessionId && !freshFallback && isStaleResumeSessionError(message)) {
        record.spec = { ...record.spec, resume: null, resumeOnly: false };
        record.staleResumeFallback = { resumedFromPause: false, reason: message };
        this.deps.events.append({ agentId, kind: "status", data: {
          state: "running", resumed: true, account: record.accountName,
          ...(via ? { resumedBy: via.resumedBy, ...(via.from ? { from: via.from } : {}) } : {}),
          resumeFallback: "stale-session", resumedFromPause: false, reason: message,
        } });
        try {
          await this.launch(record, record.accountName);
          if (this.status(agentId).state === "killed") {
            await this.handles.get(agentId)?.kill().catch(() => {});
            this.handles.delete(agentId);
          } else {
            this.reissueRemoteControlIntent(agentId);   // REMOTE-CONTROL-SURVIVES-PAUSE
          }
          return;
        } catch (e2) {
          this.settleUnrecordedUsage(record);
          this.markFailed(record, `resume failed: ${(e2 as Error).message}`);
          this.checkPendingOnSettle(record);
          return;
        }
      }
      // Same failure discipline as onError's rerouted-launch catch: commit failed + publish a
      // terminal event so a pending waitFor observes it instead of hanging. Scrub: launch()
      // resolves a credential into scope before it can throw.
      this.settleUnrecordedUsage(record);   // LEDGER-UNCLEAN-EXIT
      this.markFailed(record, `resume failed: ${message}`);
      this.checkPendingOnSettle(record);   // LATE-MESSAGE-RESUME: surface any stranded mailbox message
    }
  }

  // LAZY-REATTACH: rehydrate a prior RUNNING agent from the on-disk snapshot as a PAUSED record
  // with NO process and NO auto-resume timer — the deliberate contrast with reattachPaused just
  // below, whose whole job is to re-arm a session-limit hold's own clock.
  //
  // Why the process can be deferred at all: a resumable agent's conversation lives in
  // AgentRecord.sessionId, not in the OS process. Re-spawning every one of them at boot cost a
  // burst of provider CLI processes (measured: ~20 on a real fleet) at exactly the moment a
  // reconnecting UI is fetching its first snapshot — enough to push agent.list past the desktop
  // bridge's 30s call timeout. Deferring loses nothing and removes the burst entirely.
  //
  // `resumeOnly: true` is stamped into the stored spec HERE, not at resume time, so whichever
  // path later revives this record (an operator resume, an RPC that needs the live session)
  // inherits the restart contract the eager path always had: resume the session IDLE, never
  // re-send the original prompt. resumePaused's own default is the opposite (a session-limit
  // hold DOES want the prompt re-sent to nudge the task along), so leaving it unstamped would
  // silently change what a restarted agent does on its first turn.
  reattachDormant(prior: AgentRecord, reason: NonNullable<AgentRecord["pauseReason"]> = "daemon-restart"): void {
    const record: AgentRecord = {
      ...prior,
      state: "paused",
      pauseReason: reason,
      spec: { ...prior.spec, resume: prior.sessionId ?? null, resumeOnly: true },
    };
    // No resumeAt: an absent reset time is precisely what tells reattachPaused-style logic
    // "there is no clock here" — this hold ends when a human or an action ends it.
    delete record.resumeAt;
    this.agents.set(record.agentId, record);
    this.generation++;
    this.deps.events.append({
      agentId: record.agentId, kind: "status",
      data: this.scrub({ state: "paused", paused: true, reason, dormant: true }),
    });
  }

  // Session-limit HOLD (restart-survival): rehydrate a paused agent from the on-disk state
  // snapshot on daemon boot — re-register it and re-arm its auto-resume. If the reset already
  // passed while the daemon was down, resume immediately. Called by reattach.ts's boot glue.
  // CLOCKLESS-HOLD-SURVIVES-RESTART: `resumeAt` is what separates the two kinds of pause, and
  // its ABSENCE is meaningful — it is not a missing value to substitute a default for.
  //
  // A pause WITH a clock (session-limit, crash-loop backoff) is waiting for a moment to arrive:
  // re-arm it, or resume now if that moment already passed while the daemon was down.
  // A pause WITHOUT one (idle-timeout, daemon-restart, operator-hold) is waiting for a DECISION —
  // an operator releasing it, or work arriving for a revivable hold. There is no time at which it
  // becomes due, and resuming it on boot overrules the very thing it records.
  //
  // This read `record.resumeAt ?? this.now()` and then resumed anything already due, which for a
  // clockless hold is `now() <= now()` — always true. Written when "paused" only ever meant a
  // session-limit hold (this method's own name says so); idle-reap, lazy reattach and operator
  // hold each added a clockless pause afterwards, and every one of them came back RUNNING on the
  // next restart. Reported as "paused agents turned into running ones after a reinstall".
  reattachPaused(prior: AgentRecord): void {
    const record: AgentRecord = { ...prior, state: "paused" };
    this.agents.set(record.agentId, record);
    this.generation++;
    if (record.resumeAt === undefined) return;   // a clockless hold outlives the restart, untouched
    if (record.resumeAt <= this.now()) void this.resumePaused(record.agentId).catch(() => {});
    else this.scheduleResume(record.agentId, record.resumeAt);
  }

  // REATTACH-TERMINAL-RECORDS: rehydrate a prior TERMINAL (done/failed/killed) agent record from
  // the on-disk state snapshot on daemon boot — DISPLAY-ONLY, unlike reattachPaused above: no
  // process is spawned, no session is resumed, no timer is armed. Just re-registers the record
  // as-is so it reappears in list() (agent_list/team.status) with its state/costUsd/usage/
  // membership/spec intact; its transcript stays reachable via the persisted event log under
  // the same agentId. Called by reattach.ts's boot glue, already capped to the most recent
  // MAX_TERMINAL_AGENTS_PERSISTED records by the caller.
  // PURGE-TERMINAL-SESSIONS: forget every finished agent. A terminal record costs nothing to
  // RUN but is not free to keep: it rides state.json on every snapshot, ships in every
  // agent.list, and holds an archived record + a mailbox on disk. A long-lived fleet accumulates
  // thousands of them and the operator has no way to say "I am done with these".
  //
  // Deliberately narrow, and deliberately not clever about it:
  //   - running/paused are LIVE WORK and are never touched. A paused record is not "finished" —
  //     a restart-dormant or session-limited agent resumes into its session (reattachDormant),
  //     so forgetting it would destroy work the operator is waiting on.
  //   - every TERMINAL state goes: done, failed and killed alike. A finished agent is finished,
  //     whichever way it ended.
  // The line that matters is terminal vs live, and it is drawn by state alone — there is no
  // heuristic here that could widen it by accident.
  // Returns the purged ids so the caller can drop their on-disk companions — this method owns
  // the in-memory roster and nothing else, mirroring how every other supervisor mutator stays
  // out of the stores it doesn't own.
  // `agentIds`, when given, narrows the sweep to those records — the single-row dismissal
  // (agent.forget) shares this method rather than reimplementing the terminal-only test, so the
  // live-work guarantee above is enforced in exactly one place for both callers.
  purgeTerminal(agentIds?: readonly string[]): string[] {
    const only = agentIds ? new Set(agentIds) : null;
    const purged: string[] = [];
    for (const [agentId, record] of this.agents) {
      if (only && !only.has(agentId)) continue;
      if (record.state !== "done" && record.state !== "failed" && record.state !== "killed") continue;
      this.clearBudgetResumeAck(record);   // F50.QA-FIX finding 7: idempotent backstop
      this.agents.delete(agentId);
      purged.push(agentId);
    }
    if (purged.length > 0) this.generation++;
    return purged;
  }

  reattachTerminal(prior: AgentRecord): void {
    this.agents.set(prior.agentId, { ...prior });
    this.generation++;
  }

  // R2 (self-healing supervision): the fix for reattach.ts's "silent death" problem —
  // reattachConductors' re-spawn is fire-and-forget, and a failed re-spawn used to just
  // console.error while spawn() itself had ALREADY deleted the just-created record on launch
  // failure, leaving zero trace (not running, not failed, invisible to agent.list/team.status).
  // Re-registers the prior record and routes it through the SAME crash-loop backoff/circuit-
  // breaker path a real backend crash uses — one more resume attempt after backoff, or an
  // immediately-visible `failed`+`circuitOpen` record if `prior.crashCount` was already
  // exhausted before this boot. Called from reattach.ts's reattachConductors catch handler.
  recoverFromFailedReattach(prior: AgentRecord, errorMessage: string): void {
    const record: AgentRecord = { ...prior };
    this.agents.set(record.agentId, record);
    this.generation++;
    this.scheduleCrashRestart(record, `reattach failed: ${errorMessage}`, "reattach-recovery");
  }

  // R2 (self-healing supervision): the liveness-probe recovery hook — called by HealthMonitor's
  // periodic tick when a running, non-shadow agent has produced no event for longer than the
  // configured staleMs threshold. No-ops for an unknown/non-running/shadow agent (a race with
  // the agent settling on its own between the probe's scan and this call). Best-effort kills the
  // wedged handle, then routes into the SAME crash-loop backoff/circuit-breaker path a real
  // backend crash uses — a wedge and a crash both mean "this process isn't going to produce a
  // result on its own", so they share one recovery primitive.
  reportUnresponsive(agentId: string, idleMs: number, thresholdMs: number): void {
    const record = this.agents.get(agentId);
    if (!record || record.state !== "running" || record.shadow) return;
    this.deps.events.append({ agentId, kind: "agent_unresponsive", data: { idleMs, thresholdMs } });
    void this.handles.get(agentId)?.kill().catch(() => {});
    // REAP-SAFETY: the exact failure mode this exists for — an agent backgrounded a long run,
    // ended its turn, and the liveness probe is reaping it right now. See workdir.ts doc comment.
    autoCommitDirtyWorktree({ isolation: record.spec.isolation, cwd: record.spec.cwd, agentId, workdirKey: record.spec.workdirKey }, `agent ${agentId} unresponsive for ${idleMs}ms`);
    // STALE-WORKTREE-RECORD: see kill()'s identical call — the liveness probe is the OTHER
    // real-world reap path (a backgrounded run that never comes back), not just an explicit kill.
    this.stampWorktreeLanding(record, agentId);
    this.scheduleCrashRestart(record, `liveness probe: unresponsive for ${idleMs}ms (threshold ${thresholdMs}ms)`);
  }

  // spec §8: route a finished child's result into its conductor's mailbox and
  // wake the conductor's pending delivery so it can act on the result.
  protected afterResult(record: AgentRecord): void {
    const target = record.spec.deliverTo;
    if (!target) return;
    // Phase 5: a BARE deliverTo stays inside the local trust domain — the
    // existing enqueue+deliverPending path below is UNCHANGED from Phase 1.
    // A QUALIFIED (<engineId>/<localId>) deliverTo crosses an engine boundary
    // and routes through the forward seam instead (or drops-with-event when
    // no seam is configured — federation disabled).
    const addr = parseAgentAddress(target);
    if (addr.engineId === null) {
      this.deps.mailboxes.enqueue(target, {
        from: record.agentId, kind: "child_result", text: record.resultText ?? "",
        // W2-1 STRUCTURED-RETURNS: forward the parsed value alongside the text so a conductor
        // reading this off the mailbox (the actual "task-result report" handoff) doesn't have to
        // re-parse JSON out of `text` itself. Present only under resultSchema.
        // DENIED-TOOL-CALL-INVISIBLE: this is exactly the path a "done" result that hid a
        // give-up takes — a well-formed terminal result still calls afterResult, so this is
        // where the conductor's mailbox gets a chance to know, PUSHED, without polling
        // queue.status or agent.status. Boolean only (mirrors the record field); the conductor
        // can pull agent.status for lastToolPolicyDenial's detail if it wants to act on it.
        meta: {
          costUsd: record.costUsd, ...(record.structuredResult !== undefined ? { structuredResult: record.structuredResult } : {}),
          ...(record.toolPolicyDenied ? { toolPolicyDenied: true } : {}),
        },
      });
      this.deliverPending(target);
      // PLAN-HOOKS.md §4.3 gap fix (b): deliverPending above is a no-op when `target` isn't
      // currently running — check whether it's actually settled and needs the undelivered-vs-
      // resume treatment instead of just silently leaving the mail there forever.
      this.checkDeliverTargetSettled(target, record.spec.deliverWake);
    } else if (this.deps.mailboxForward) {
      const message: MailboxMessage = {
        id: randomUUID(), ts: Date.now(), from: record.agentId, kind: "child_result",
        // Trust-boundary redaction (spec §6): record.resultText is stored RAW
        // (onEvent scrubs only appended event data, never this field), but this
        // text is now leaving the local machine for a peer engine — it MUST be
        // scrubbed against every injected credential before it crosses the wire.
        // (redact() is a no-op on secret-free text, so ordinary results pass through unchanged.)
        text: redact(record.resultText ?? "", this.secrets),
        engineId: "local",
        // W2-1 STRUCTURED-RETURNS: same forward as the local branch above; structuredResult is
        // chimera-internal JSON (never raw credential text), so no redact() pass is needed here.
        meta: {
          costUsd: record.costUsd, ...(record.structuredResult !== undefined ? { structuredResult: record.structuredResult } : {}),
          ...(record.toolPolicyDenied ? { toolPolicyDenied: true } : {}),
        },
      };
      this.deps.mailboxForward({ engineId: addr.engineId, agentId: addr.localId }, message);
    } else {
      this.deps.events.append({
        agentId: record.agentId, kind: "status",
        data: this.scrub({ deliverToDropped: target, reason: "federation disabled" }),
      });
    }
  }

  // AGENT-FAILURE-REACHES-CONDUCTOR: the ONE chokepoint every terminal-failure transition in this
  // file must route through — sets state, appends the (scrubbed) status event, and notifies the
  // conductor's deliverTo mailbox. Before this, only afterResult() (the "result"/done path)
  // notified deliverTo; every failure path duplicated "record.state = 'failed'; events.append(...)"
  // by hand and none of them told the conductor. Routing all 7 through here means a future failure
  // path literally cannot be added without also delivering — there's no parallel "set failed +
  // append" left to copy-paste.
  //
  // `record` is mutated in place and must already be (or is about to be) the live object under
  // `this.agents.get(record.agentId)` — setModel/setEffort/setAccount's atomic-failure recovery
  // builds a fresh record and inserts it into the map themselves before calling this, exactly as
  // they did with the inline state+event pair this replaces. `extra` folds diagnostic fields
  // (circuitOpen, crashCount, exitCode, stderrTail, …) into the SAME status event so the event
  // log/UI shows the full picture without a second event, and rides along into the mailbox
  // message too (see notifyChildFailed).
  // F09-PROMPT-STALL-FIRE:BEGIN
  // The stall is a REPORT, never an action: record the fact and append the event, full stop.
  // Re-delivering here would turn one unlucky slow start into a duplicated prompt, and the
  // mailbox is already the only thing that owns delivery. A10 guards this body by source.
  private firePromptStall(agentId: string, stall: PromptStall): void {
    const record = this.agents.get(agentId);
    if (!record || record.state !== "running") return;
    record.promptStall = stall;
    this.deps.events.append({
      agentId, kind: "agent_prompt_stalled",
      data: { ...stall, thresholdMs: this.promptStallMs },
    });
    // F09 QA (item 3): this event is synthesized here, not read back from a backend's own stream,
    // so it never passes through the generic onEvent path above (supervisor.ts:2258) that stamps
    // every other attention kind. Without this call a stall never re-marks the row `new` for F47.
    this.noteAttention(agentId, "agent_prompt_stalled");
  }
  // F09-PROMPT-STALL-FIRE:END

  // F50.QA-FIX finding 7: a resume watermark is scoped to THIS record's own budget node — once
  // the record that could have re-triggered it is terminal, the watermark can never be consulted
  // again for that reason and would otherwise sit in the map for the process's life. NOT called
  // from handoff()/rebind()'s old-record "done" transition: those continue the SAME treeId under
  // a fresh agentId/budgetNodeId (respawnOpts deliberately never carries budgetNodeId forward —
  // see its own comment), so the old node can still be a live ancestor for children spawned
  // before the handoff and pruning here would wrongly drop their still-relevant watermark.
  private clearBudgetResumeAck(record: AgentRecord): void {
    const nodeId = record.budgetNodeId ?? record.treeId;
    this.budgetResumeAcks.delete(nodeId);
  }

  private markFailed(record: AgentRecord, reason: string, extra: Record<string, unknown> = {}): void {
    record.state = "failed";
    record.failureMessage = redact(reason, this.secrets);
    this.clearBudgetResumeAck(record);
    // F08.QA: `record.failure` describes ONE death — the one being recorded here. Only onError
    // (which ran the classifier) and the crash-loop breaker (which forwards that same
    // disposition) pass one; the other ten call sites (rerouted launch, resume, setModel,
    // setAccount, handoff, rebind, ...) never classified anything, so whatever is still on the
    // record belongs to an EARLIER incident and would make agent.status/the fleet list report
    // this death with the previous one's cause ("provider throttled" for an agent that actually
    // died because the failover target's credentials are broken). Mirrors the reset-on-recovery
    // `delete record.failure` in the agent_started handler.
    if (extra["failure"]) record.failure = extra["failure"] as FailureDisposition;
    else delete record.failure;
    // F08.QA-FIX N1: onError stamps att.errorClass BEFORE calling markFailed (see above), but the
    // ~10 other terminal-failure call sites (rerouted-launch, resume, setModel/setAccount/handoff/
    // rebind atomic-failure recovery, ...) never classified anything, so scheduler.ts settle()'s
    // `rec.attempts[last]?.errorClass` read undefined for every one of them and queues.ts's poison
    // check (retryableClasses) could never fire outside the onError path. Classify HERE, once, for
    // whichever of those paths reaches this chokepoint. Skip when already stamped (onError's own
    // call) so a message never gets classified twice with potentially different results. Never
    // stamp "unknown": a genuinely unclassifiable reason must stay undefined, exactly like today —
    // otherwise this fix would start dead-lettering deaths that were previously safe from the
    // poison check (see F08.md N1's caveat).
    const lastAttempt = record.attempts[record.attempts.length - 1];
    if (lastAttempt && lastAttempt.errorClass === undefined) {
      const cls = classifyFailure(reason).errorClass;
      if (cls !== "unknown") { lastAttempt.endedAt = Date.now(); lastAttempt.errorClass = cls; }
    }
    this.promptAck.forget(record.agentId);                      // F09 (A7)
    record.promptStall = null;
    this.deps.events.append({
      agentId: record.agentId, kind: "status",
      data: this.scrub({ state: "failed", error: reason, ...extra }),
    });
    this.notifyChildFailed(record, reason, extra);
  }

  // afterResult's failure-side mirror (Gap 1 fix): afterResult's deliverTo enqueue only ever
  // fires on kind:"result" — every OTHER terminal transition (crash-loop circuit breaker,
  // rerouted-launch failure, resume/setModel/setEffort/setAccount atomic-failure recovery) never
  // told the target conductor at all. Reuses afterResult's exact bare-vs-qualified /
  // deliverPending / checkDeliverTargetSettled / federation-drop machinery — only the mailbox
  // `kind` and payload shape differ (child_failed meta carries error/exitCode/stderrTail, not
  // resultText/costUsd).
  //
  // spec §6: unlike afterResult's local branch (which leaves resultText RAW — trusted local
  // delivery), BOTH branches here scrub/redact `reason`/stderrTail before they ride the mailbox
  // message. A failure's payload is far more likely to carry raw, credential-bearing process
  // output (stderr) than an ordinary result, so it can't get the same "local is trusted" pass.
  private notifyChildFailed(record: AgentRecord, reason: string, extra: Record<string, unknown>): void {
    const target = record.spec.deliverTo;
    if (!target) return;
    const meta = this.scrub({
      error: reason,
      ...(extra["exitCode"] !== undefined ? { exitCode: extra["exitCode"] } : {}),
      ...(extra["stderrTail"] ? { stderrTail: extra["stderrTail"] } : {}),
      // F08: the conductor's mailbox gets the disposition it must branch on (retryable /
      // failoverAccount / holdForReset) instead of having to re-parse `error` prose.
      ...(extra["failure"] ? { failure: extra["failure"] } : {}),
    });
    const text = redact(reason, this.secrets);
    const addr = parseAgentAddress(target);
    if (addr.engineId === null) {
      this.deps.mailboxes.enqueue(target, { from: record.agentId, kind: "child_failed", text, meta });
      this.deliverPending(target);
      this.checkDeliverTargetSettled(target, record.spec.deliverWake);
    } else if (this.deps.mailboxForward) {
      const message: MailboxMessage = {
        id: randomUUID(), ts: Date.now(), from: record.agentId, kind: "child_failed",
        text, engineId: "local", meta,
      };
      this.deps.mailboxForward({ engineId: addr.engineId, agentId: addr.localId }, message);
    } else {
      this.deps.events.append({
        agentId: record.agentId, kind: "status",
        data: this.scrub({ deliverToDropped: target, reason: "federation disabled" }),
      });
    }
  }

  // PLAN-HOOKS.md §4.3 gap fix (c) / §2.3: public deliverPending wrapper for callers OUTSIDE
  // this class that enqueue into a mailbox this store owns but can't reach the protected method
  // directly — engine.ts's federated mailbox.forward handler (peer mail enqueued into a possibly
  // non-running local agent's mailbox) and SubscriptionRegistry's signal delivery (subscriptions.ts,
  // via the wakeMailbox dep). Safe to call for any agentId in any state: deliverPending itself
  // already no-ops unless the record is live+running.
  resourceProcessPid(agentId: string): number | null {
    const record = this.status(agentId);
    return record.state === "running" ? this.handles.get(agentId)?.processPid ?? null : null;
  }

  wakeMailbox(agentId: string): void {
    this.deliverPending(agentId);
  }

  // spec §8: drain the mailbox into the live handle. No-op unless the record
  // exists, is running, and has a live handle — draining/acking otherwise
  // would lose messages with nowhere to deliver them.
  //
  // Deferred Must #1: chain this call's deliverBatch after any still-in-flight
  // deliverBatch for the SAME agentId. Without this, two overlapping triggers
  // (e.g. two children with the same deliverTo finishing close together) each
  // drain their own batch and fire deliverBatch immediately/concurrently — their
  // handle.send()s can then interleave across batches, violating per-mailbox
  // FIFO (spec §8) even though within-batch ordering is already correct.
  protected deliverPending(agentId: string, turnBoundary = false): void {
    if (this.providerTransfers.has(agentId)) return;
    const record = this.agents.get(agentId);
    const handle = this.handles.get(agentId);
    // LAZY-REATTACH / IDLE-REAP: mail arriving for an agent that is only DORMANT must wake it,
    // not queue silently — a dormant agent is still a live participant, and its inbox is how
    // deliverTo results, hook notifies and subscription signals reach it. Without this the
    // orchestration simply stalls with the work sitting in a mailbox nobody drains. Resuming is
    // enough on its own: launch()'s own agent_started hook calls deliverPending again once the
    // handle exists, which is what actually drains this batch.
    if (record && !handle && isRevivableHold(record)) {
      void this.resumePaused(agentId, { resumedBy: "mailbox" }).catch(() => {});
      return;
    }
    if (!record || !handle || record.state !== "running") return;
    const pending = this.deps.mailboxes.pending(agentId);
    if (pending.length === 0) return;
    // Exec has no mid-turn input channel. Ordinary mail stays durable until a boundary;
    // interpreting every child result as steering repeatedly aborts useful work.
    if (record.provider === "codex" && !turnBoundary
      && (handle.isTurnActive?.() ?? this.promptAck.isMidTurn(agentId))
      && !pending.some(m => m.force || m.slash)) return;
    const drain = this.deps.mailboxes.drain(agentId);
    const prior = this.delivering.get(agentId) ?? Promise.resolve();
    const chained = prior.then(() => this.deliverBatch(agentId, handle, drain));
    this.delivering.set(agentId, chained.catch(() => {}));
  }

  // Deliver a drained batch in FIFO order (spec §8: FIFO per mailbox, nothing
  // dropped). Sends are awaited one at a time; on a send failure, the failed
  // message AND every not-yet-delivered message are re-enqueued in original
  // order and delivery stops — so a mid-batch failure preserves relative order
  // instead of shuffling the failed message behind ones that succeeded after it.
  // (Residual: process death mid-send can still lose the in-flight message; v1.)
  private async deliverBatch(
    agentId: string,
    handle: AgentHandle,
    batch: ReturnType<MailboxStore["drain"]>,
  ): Promise<void> {
    if (batch.length === 0) return;
    if (!this.inFlight.has(agentId)) this.inFlight.set(agentId, []);
    // TOKEN-OPT-BATCH-TURNS: a drained batch used to become one SEND PER MESSAGE, and a send is
    // a turn — so five deliverTo results arriving together made the agent re-read its entire
    // context five times and produce five replies, when the work is one wake with five inputs.
    // The cost is per-turn and scales with the conversation, so it grows exactly where it hurts
    // most (a long-lived conductor fanning out work).
    //
    // Consecutive plain-text messages share one turn with separate delivery metadata. A message that cannot be concatenated
    // breaks the run and is sent on its own: a slash command must arrive verbatim as the whole
    // turn (a prefix would stop the backend recognizing it), and anything carrying images or
    // ordered content blocks keeps its exact block order. Nothing is dropped or reordered, and
    // the per-message delivery events below are unchanged — a transcript still shows five
    // messages, because five messages is what arrived.
    const groups = groupDeliverable(batch);
    // F09: classify against the state at DELIVERY time — handle.send below can open a turn
    // within milliseconds, and "was it mid-turn when I handed this over" is the question.
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      const m = group[0]!;
      // The provider can already be working before its first visible event.
      // Re-evaluate each group: a preceding delivery may have started a turn.
      const midTurn = handle.isTurnActive?.() ?? this.promptAck.isMidTurn(agentId);
      try {
        const messages = group.map(msg => this.deps.mailboxes.envelope(msg));
        const record = this.agents.get(agentId)!;
        const backend = this.deps.backends.get(record.spec.runtime === "terminal" ? "terminal" : record.provider);
        for (const message of messages) backend?.validateInput?.(message.content);
        // F09 race: read the seq BEFORE the send, because the backend can emit its first
        // turn-opening event while we are still awaiting it — see PromptAckWatch's ALREADY-OPENED
        // branch. It is passed ALONGSIDE the post-send `lastSeq` rather than replacing it:
        // `lastSeq` is reported verbatim in PromptStall.lastSeq ("the event seq the agent was
        // parked at"), which must stay the position at arming time.
        const preSendSeq = this.deps.events.currentSeq();
        await deliverAgentInput(handle, m.slash
          ? { type: "command", text: m.text }
          : { type: "messages", messages, mode: m.force && midTurn ? "steer" : "enqueue" });
        for (const msg of group) this.inFlight.get(agentId)?.push(msg);
        // F09: the delivery happened — arm the ack watch. Keyed by every message id in the
        // group, because a coalesced group can carry several callers' sends and each must get
        // its own answer.
        this.promptAck.armed(agentId, {
          deliveryId: group[0]!.id, messageIds: group.map((msg) => msg.id), from: m.from,
          messageCount: group.length, midTurn, slash: m.slash === true,
          lastSeq: this.deps.events.currentSeq(), preSendSeq,
        });
        // Phase 3: normalized record of the delivered user turn, so ANY client's
        // transcript can render turns injected by other clients (the TUI skips
        // its own via from === "tui"). Scrub for spec §6: text can be a child
        // agent's own (unscrubbed-at-source) result text, which may echo an
        // injected credential — every sibling append in this file scrubs too.
        // D9: mirror `images`/`content` too (previously text-only), so a replay of
        // this event reproduces the exact same block order the original send used —
        // without it, a delivered turn's images/blocks were unrecoverable after reload.
        for (const msg of group) {
          this.deps.events.append({
            agentId, kind: "status",
            data: this.scrub({
              delivered: true, from: msg.from, text: msg.text, messageMetadata: { ...this.deps.mailboxes.envelope(msg).author, kind: msg.kind }, messageId: this.deps.mailboxes.envelope(msg).id,
              // SLASH-COMMAND-IN-FLIGHT: say that this turn is a COMMAND, not prose. A client
              // cannot tell from the text alone (an ordinary message may start with "/"), and a
              // slow command — /compact on a large context runs for a minute or more — otherwise
              // shows as a bare "thinking…" with nothing to say what is running.
              ...(msg.slash ? { slash: true } : {}),
              ...(msg.force ? { force: true } : {}),
              ...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
              ...(msg.content && msg.content.length > 0 ? { content: msg.content } : {}),
            }),
          });
        }
      } catch (error) {
        if (error instanceof UnsupportedContentError) {
          for (const msg of group) this.deps.events.append({ agentId, kind: "status", data: {
            deliveryRejected: true, messageId: this.deps.mailboxes.envelope(msg).id,
            deliveryId: msg.id, reason: error.message,
          } });
          continue; // A permanent content mismatch must not block later messages.
        }
        for (const r of groups.slice(i).flat()) {
          // IMAGE.PASTE: re-enqueue must preserve `images` too, or a mid-batch
          // send failure would silently drop the attachment on retry.
          this.deps.mailboxes.enqueue(agentId, {
            from: r.from, kind: r.kind, text: r.text, engineId: r.engineId, message: this.deps.mailboxes.envelope(r), id: randomUUID(),
            ...(r.meta ? { meta: r.meta } : {}),
            ...(r.images ? { images: r.images } : {}),
            // D9: preserve `content` on re-enqueue too, for the same reason as `images`.
            ...(r.content ? { content: r.content } : {}),
            // PARITY WS-B: preserve the slash flag on re-enqueue too, or a mid-batch
            // send failure would demote the retried command back to a plain "[from …] " message.
            ...(r.slash ? { slash: true } : {}),
            ...(r.force ? { force: true } : {}),
          });
        }
        return;
      }
    }
  }

  // Identity comes from the daemon registry, never message text or caller-supplied
  // metadata. A remote engine cannot impersonate a local operator or teammate.
  principalFor(from: string, engineId = "local"): Principal {
    const agent = engineId === "local" ? this.agents.get(from) : undefined;
    const source = engineId !== "local" ? "external" : agent ? "agent"
      : OPERATOR_SENDERS.has(from) ? "operator" : ["system", "scheduler"].includes(from) ? "system" : "external";
    const label = agent ? this.displayLabelOf(from) : undefined;
    return {
      from, source, engineId,
      ...(label && label !== from ? { label } : {}),
      ...(agent?.membership ? { team: agent.membership.team, role: agent.membership.role } : {}),
    };
  }

  // spec §8: "auto" decides instantly from the permission profile; "poke:caller"
  // and "tui" emit a permission_request event and wait for an external answer
  // (respondPermission), falling back to the auto decision on timeout so a
  // headless agent never hangs.
  // WD Stage 2 (coverage B14) / FEATURE-6: resolve a Bash call's host-tool policy verdict
  // through the capability broker. null unless a capabilityBroker seam is wired AND this
  // is a Bash call with a string command — everything else (other tools, object-form
  // inputs) passes untouched. Across the command's segments, ANY deny wins over prompt
  // (fail-closed), and the first prompt wins over allow; per-segment tool/profile
  // detection lives in hosttools.ts's parseBashTargets (argv flags + leading env
  // assignments) — the broker itself only turns an already-detected (tool, profile) into
  // a decision + an audit event, it doesn't re-derive them.
  private toolPolicyGate(record: AgentRecord, req: PermissionRequest): { mode: "deny" | "ask"; tool: string; profile: string | null; command: string } | null {
    const broker = this.deps.capabilityBroker;
    if (!broker || req.toolName !== "Bash") return null;
    const command = (req.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== "string" || command === "") return null;
    let ask: { mode: "ask"; tool: string; profile: string | null; command: string } | null = null;
    // Redacted copy for the broker only — the broker's emit seam feeds BOTH the general
    // EventLog's capability_decision event and the audit ledger (engine.ts), neither of which
    // was scrubbed before (a pre-existing leak: unlike policy_denied/permission_request below,
    // capability_decision echoed the raw command verbatim). The gate's own returned `command`
    // (used for policy_denied's scrub() and the destructive-Bash checkpoint trailer) stays raw.
    const redactedCommand = redact(command, this.secrets);
    for (const t of parseBashTargets(command)) {
      const { decision } = broker.decideHostTool(record.agentId, t.tool, t.profile, redactedCommand);
      if (decision === "deny") return { mode: "deny", tool: t.tool, profile: t.profile, command };
      if (decision === "prompt") ask ??= { mode: "ask", tool: t.tool, profile: t.profile, command };
    }
    return ask;
  }

  // MCP-FOREIGN-POLICY: the foreign-MCP analogue of toolPolicyGate. null unless a
  // capabilityBroker is wired AND this is a FOREIGN MCP tool call (mcp__<server>__<tool> that is
  // NOT mcp__chimera__*) — every other tool (Bash, native, chimera MCP) passes untouched. The
  // broker resolves the toolPolicy verdict; its KEY difference from the Bash gate is the UNSET
  // default: an ungoverned tool resolves to "prompt" (not "allow"), so it surfaces a permission
  // card instead of the pre-fix silent autoDecision deny. Returns "allow" too (not just deny/ask
  // like the Bash gate) because a config allow must short-circuit past the per-profile
  // autoDecision, which denies foreign MCP for every non-full profile.
  // The full/bypass profile keeps its frictionless access: for it the unset default is "allow"
  // (mirroring the Bash gate, whose unset default is allow and so never prompts a full agent) —
  // otherwise a full+auto agent would newly stall on the 120s permission timeout for every
  // ungoverned foreign MCP call before autoDecision(full) allowed it anyway. An EXPLICIT
  // allow/ask/deny still applies to full, exactly as the Bash gate denies/prompts even full.
  private mcpPolicyGate(record: AgentRecord, req: PermissionRequest): { decision: "allow" | "deny" | "prompt"; tool: string } | null {
    const broker = this.deps.capabilityBroker;
    if (!broker) return null;
    const tool = req.toolName;
    if (!tool.startsWith(MCP_TOOL_PREFIX) || tool.startsWith(CHIMERA_MCP_PREFIX)) return null;
    const unsetDefault = record.spec.permissionProfile === "full" ? "allow" : "prompt";
    const res = broker.decideMcpTool(record.agentId, tool, unsetDefault);
    if (!res) return null;   // seam absent (feature not wired) → no gate, byte-identical to before
    return { decision: res.decision, tool };
  }

  protected async decidePermission(record: AgentRecord, req: PermissionRequest): Promise<boolean | string> {
    if (req.signal?.aborted) return false;
    // WORKTREE-MAIN-GUARD: runs before every other gate, unconditionally — no
    // capabilityBroker/permissionProfile dependency, because this is a hard isolation
    // invariant, not a configurable policy (a "full"/bypass agent must not be able to
    // corrupt main's node_modules symlinks any more than a restricted one can). See
    // hosttools.ts's findMainNodeModulesWrite doc for the observed failure this closes.
    if (record.spec.isolation === "worktree" && req.toolName === "Bash") {
      const command = (req.input as { command?: unknown } | undefined)?.command;
      if (typeof command === "string" && command !== "") {
        const wt = worktreePath({ cwd: record.spec.cwd, agentId: record.agentId, workdirKey: record.spec.workdirKey });
        const hit = findMainNodeModulesWrite(command, wt, record.spec.cwd);
        if (hit) {
          this.deps.events.append({
            agentId: record.agentId, kind: "policy_denied",
            data: this.scrub({
              tool: "Bash", command, requestId: req.requestId,
              reason: "worktree_main_node_modules_write", target: hit,
            }),
          });
          return false;
        }
      }
    }
    // WORKTREE-AGENT-WRITES-REACH-MAIN: the Edit-family generalization of the guard above.
    // findMainNodeModulesWrite only ever sees a Bash argv — an Edit/Write/MultiEdit/
    // NotebookEdit call writes straight to disk with no shell involved, so it was invisible
    // to that check. Real incident: a worktree agent's own Edit-tool write landed (also) in
    // MAIN's checkout at the same relative source path, uncommitted and duplicated — see
    // hosttools.ts's findMainSourceWrite doc for the full account. Same unconditional
    // treatment as the Bash guard (no profile/broker dependency), and — unlike that guard's
    // `return false` — this one returns a specific, actionable message: a silent generic
    // deny here just produces retries against the same wrong path.
    if (record.spec.isolation === "worktree" && EDIT_TOOLS.has(req.toolName)) {
      const wt = worktreePath({ cwd: record.spec.cwd, agentId: record.agentId, workdirKey: record.spec.workdirKey });
      const hit = findMainSourceWrite(req.toolName, req.input, wt, record.spec.cwd);
      if (hit) {
        this.deps.events.append({
          agentId: record.agentId, kind: "policy_denied",
          data: this.scrub({
            tool: req.toolName, requestId: req.requestId,
            reason: "worktree_main_source_write", target: hit,
          }),
        });
        return `Refused: this ${req.toolName} call targets "${hit}", which resolves INSIDE the main ` +
          `checkout (${record.spec.cwd}), not your own isolated worktree (${wt}). Your worktree already ` +
          `contains this file at the same relative path under ${wt} — write there instead.`;
      }
    }
    // F22: the single-writer worktree gate — the THIRD write-target guard, deliberately placed
    // after the two main-checkout guards above (their payloads must stay byte-identical) and
    // before the tool-policy gate below ("you are writing in someone else's worktree" is a fact
    // about the TARGET, not about whether this tool is allowed at all). Everything below the mode
    // check is skipped when the feature is off or unwired, so no write-target extraction cost and
    // no behavior change is added to a pre-F22 deployment.
    const leaseMode = this.deps.worktreeLeaseMode?.() ?? "off";
    if (this.deps.capabilityBroker && leaseMode !== "off") {
      const { caller, execCwd } = this.worktreeWriteContext(record);
      const command = (req.input as { command?: unknown } | undefined)?.command;
      const targets = req.toolName === "Bash"
        ? (typeof command === "string" && command !== "" ? bashWriteTargets(command, execCwd) : [])
        : EDIT_TOOLS.has(req.toolName)
          ? [editToolTargetPath(req.toolName, req.input, execCwd)].filter((t): t is string => t !== null)
          : [];
      const verdict = this.deps.capabilityBroker.decideWorktreeWrite(record.agentId, caller, targets);
      if (verdict && verdict.decision === "deny") {
        this.deps.events.append({
          agentId: record.agentId, kind: "policy_denied",
          // scrub, same as the Bash gate: a command string can echo an injected credential.
          data: this.scrub({
            tool: req.toolName, requestId: req.requestId, reason: "worktree_lease_foreign_write",
            target: verdict.target, workdirKey: verdict.workdirKey, owner: verdict.owner,
            ownerState: verdict.ownerState,
          }),
        });
        record.worktreeLeaseDenied = true;
        record.lastWorktreeLeaseDenial = {
          tool: req.toolName, workdirKey: verdict.workdirKey, owner: verdict.owner,
          ownerState: verdict.ownerState, target: verdict.target, requestId: req.requestId, at: Date.now(),
        };
        // A descriptive string, not `false`: claude.ts's decideToolUse surfaces it verbatim as the
        // deny message. verdict.reason IS the store's ExplainCheck detail — the ledger, the
        // dry-run (worktree.explainWrite, same evaluateWrite call) and this refusal are one
        // sentence, not three that agree by convention.
        return `Refused: this ${req.toolName} call writes to "${verdict.target}", which is inside another agent's worktree. ${verdict.reason}`;
      }
    }
    // WD Stage 2 (coverage B14): the host-tool policy gate runs FIRST — before the
    // "auto" fast path — so deny/ask apply even when the agent's own profile would
    // auto-allow (full/bypass). deny → reject the call outright and append the
    // policy_denied audit event; ask → fall through into the STANDARD
    // permission_request flow below even under policy "auto" (its timeout keeps the
    // standard fallback: the profile's auto decision, exactly like a "tui" request);
    // allow / no policy / non-Bash → gate is null and behavior is byte-identical to
    // before this feature.
    const gate = this.toolPolicyGate(record, req);
    if (gate?.mode === "deny") {
      const profileUnresolved = looksUnresolvedProfile(gate.profile);
      this.deps.events.append({
        agentId: record.agentId, kind: "policy_denied",
        // scrub (spec §6): a command string can echo an injected credential.
        data: this.scrub({
          tool: gate.tool, ...(gate.profile !== null ? { profile: gate.profile } : {}),
          ...(profileUnresolved ? { profileUnresolved: true } : {}),
          command: gate.command, requestId: req.requestId,
        }),
      });
      // DENIED-TOOL-CALL-INVISIBLE: stamp the record (AgentRecord.toolPolicyDenied doc) BEFORE
      // returning, and return the descriptive string instead of bare `false` — claude.ts's
      // decideToolUse treats a string return as the deny `message` verbatim; `false` falls back
      // to the generic "denied by chimera permission policy", which named neither tool nor
      // profile nor "don't retry". Same deny outcome either way (still `behavior: "deny"`) —
      // only what's SAID about it changes.
      record.toolPolicyDenied = true;
      record.lastToolPolicyDenial = {
        tool: gate.tool, profile: gate.profile, ...(profileUnresolved ? { profileUnresolved: true } : {}),
        requestId: req.requestId, at: Date.now(),
      };
      return hostToolDenialMessage(gate.tool, gate.profile);
    }
    // MCP-FOREIGN-POLICY: the foreign-MCP gate, parallel to the Bash gate above but with the
    // OPPOSITE default (unset → prompt, see mcpPolicyGate). allow → succeed now (short-circuits
    // the autoDecision that would deny foreign MCP for non-full profiles); deny → policy_denied
    // (no command/profile — an MCP call has neither), mirroring the Bash deny path; prompt →
    // fall through into the standard permission_request flow below exactly like a forced Bash ask.
    const mcpGate = this.mcpPolicyGate(record, req);
    if (mcpGate?.decision === "allow") return true;
    if (mcpGate?.decision === "deny") {
      this.deps.events.append({
        agentId: record.agentId, kind: "policy_denied",
        data: this.scrub({ tool: mcpGate.tool, requestId: req.requestId }),
      });
      // DENIED-TOOL-CALL-INVISIBLE: same stamp+message treatment as the Bash deny above — an
      // MCP call has no CLI profile dimension, so `profile` is always null here.
      record.toolPolicyDenied = true;
      record.lastToolPolicyDenial = { tool: mcpGate.tool, profile: null, requestId: req.requestId, at: Date.now() };
      return mcpToolDenialMessage(mcpGate.tool);
    }
    // D16 (F20): the destructive-Bash checkpoint trigger — "detected in the SAME argv
    // parse as D4's host-tools enforcement" (parseBashTargets above). AWAITED (unlike
    // the task-start trigger's fire-and-forget) so the checkpoint is guaranteed to exist
    // BEFORE the command actually runs, regardless of which path below resolves the
    // permission (auto / ask / policy-forced ask). Runs once per Bash call even when the
    // eventual decision is a deny or a timeout — a spurious checkpoint is harmless. Gated
    // on isGitRepo FIRST, same as the task-start trigger — a non-git cwd never attempts
    // checkpointCreate.
    if (req.toolName === "Bash" && (this.deps.checkpointCreate || this.deps.auditLedger)) {
      const command = (req.input as { command?: unknown } | undefined)?.command;
      if (typeof command === "string" && command !== "" && detectDestructiveBash(command)) {
        const isGitRepo = await (this.deps.isGitRepo ?? defaultIsGitRepo)(record.spec.cwd).catch(() => false);
        if (isGitRepo && this.deps.checkpointCreate) {
          await this.deps.checkpointCreate({ cwd: record.spec.cwd, trigger: "destructive_bash", agentId: record.agentId, command }).catch(() => {});
        }
        // The audit fact ("a destructive command was detected") is recorded independent of
        // whether a git checkpoint could actually be taken (isGitRepo) — a non-git cwd still
        // ran a destructive command and that belongs in the security trail.
        this.deps.auditLedger?.append({
          agentId: record.agentId, action: "destructive_bash_checkpoint", resource: record.spec.cwd,
          decision: "recorded", reason: "destructive Bash command detected",
          detail: { command: redact(command, this.secrets), isGitRepo },
        });
      }
    }
    const policy = record.spec.on.permissionRequest;
    const fallback = () => {
      const bashCommand = req.toolName === "Bash" ? (req.input as { command?: unknown } | undefined)?.command : undefined;
      return autoDecision(record.spec.permissionProfile, req.toolName, typeof bashCommand === "string" ? bashCommand : undefined);
    };
    // A toolPolicy-forced ask (Bash "ask" OR foreign-MCP "prompt") must NOT take the "auto"
    // fast path — it has to reach the permission_request flow so the UI card can appear. On
    // timeout that flow still falls back to `fallback` (the profile's autoDecision → deny for
    // non-full), so an unattended agent's ungoverned MCP call stays safe.
    // CLOUD-MUTATION-GATE (ad-hoc sessions design §3): a state-changing cloud CLI call must
    // reach a human approval card even for a full+auto agent — the profile's frictionless
    // access is intended for read-only investigation, not for `aws ec2 terminate-instances`.
    // Expressed as an askStamp rather than a deny: the operator's rule is "confirm per
    // action", not "forbid", so the correct outcome is a card that names what is about to
    // run, not a refusal.
    const cloudMutation = req.toolName === "Bash"
      ? (() => {
          const command = (req.input as { command?: unknown } | undefined)?.command;
          return typeof command === "string" && command !== "" ? classifyCloudMutation(command) : null;
        })()
      : null;
    // CLOUD-MUTATION-GATE-OPTOUT: per-spec acknowledgeCloudMutationRisk beats the config
    // default in both directions; unset defers to cloudMutationGate() (absent seam ⇒ "prompt",
    // same fail-toward-asking default as before this feature existed).
    const cloudMutationGateOff = record.spec.acknowledgeCloudMutationRisk === true
      || (record.spec.acknowledgeCloudMutationRisk !== false && (this.deps.cloudMutationGate?.() ?? "prompt") === "off");
    if (cloudMutation) {
      const command = (req.input as { command?: unknown } | undefined)?.command as string;
      this.deps.auditLedger?.append({
        agentId: record.agentId, action: "cloud_mutation_gated",
        resource: `${cloudMutation.tool} ${cloudMutation.verb}`,
        decision: cloudMutationGateOff ? "allow" : "prompt",
        reason: cloudMutationGateOff
          ? (record.spec.acknowledgeCloudMutationRisk === true
              ? "acknowledgeCloudMutationRisk on spawn permits auto-allow"
              : "cloudMutationGate config set to off permits auto-allow")
          : "state-changing cloud CLI call requires per-action approval",
        detail: { command: redact(command, this.secrets) },
      });
      // GATED-BUT-ALLOWED-INVISIBLE: the auditLedger entry above is durable but NOT visible in
      // an agent's transcript (EventsPane/EventsScreen read the EventLog, not the audit
      // ledger) — a full+auto agent's state-changing cloud CLI call could execute with zero
      // trace an operator would actually see while scrolling. Only emit on the BYPASSED branch
      // (cloudMutationGateOff): the non-bypassed case already gets a visible permission_request
      // card via askStamp below, so there's nothing new to surface there.
      if (cloudMutationGateOff) {
        this.deps.events.append({
          agentId: record.agentId, kind: "capability_decision",
          data: this.scrub({
            principal: record.agentId, action: "cloud_mutation_gated",
            resource: `${cloudMutation.tool} ${cloudMutation.verb}`, decision: "allow",
            reason: record.spec.acknowledgeCloudMutationRisk === true
              ? "acknowledgeCloudMutationRisk on spawn permits auto-allow"
              : "cloudMutationGate config set to off permits auto-allow",
            tool: cloudMutation.tool, command, explicitPolicy: true,
          }),
        });
      }
    }
    const askStamp = gate?.mode === "ask"
      ? { policyAsk: true as const, tool: gate.tool, ...(gate.profile !== null ? { profile: gate.profile } : {}) }
      : mcpGate?.decision === "prompt"
        ? { policyAsk: true as const, tool: mcpGate.tool }
        : cloudMutation && !cloudMutationGateOff
          ? { policyAsk: true as const, tool: `${cloudMutation.tool} ${cloudMutation.verb}` }
          : undefined;
    // BLOCKED-LANDING-NEEDS-A-DATA-FLAG: classify BEFORE any return in this function so
    // every exit path below (auto fast-path, explicit respond, timeout) can stamp the
    // record the same way — see AgentRecord.landingPermissionDenied's doc for why this
    // needs to be data, not prose.
    const landingCommand = req.toolName === "Bash"
      ? (req.input as { command?: unknown } | undefined)?.command
      : undefined;
    const isLanding = typeof landingCommand === "string" && landingCommand !== "" && isLandingBash(landingCommand);
    const stampLandingDenied = (allow: boolean) => {
      if (!allow) record.permissionDenied = true;
      if (isLanding && !allow) record.landingPermissionDenied = true;
      return allow;
    };
    if (policy === "auto" && !askStamp) return stampLandingDenied(fallback());

    // A backend request id is only scoped to that backend process/thread. Claude tool-use ids
    // and Codex JSON-RPC ids can be reused by concurrent agents or after a process restart. The
    // pending registry is supervisor-wide, so exposing either id directly as its key lets a
    // late answer for an old card resolve a different agent's new request. Give every displayed
    // approval a supervisor-owned nonce and retain the backend id only as correlation metadata.
    const approvalRequestId = randomUUID();

    // Register BEFORE emitting: EventLog notifies subscribers SYNCHRONOUSLY and a
    // poked caller may call respondPermission from inside the subscribe callback —
    // the pending entry must already exist when permission_request fires.
    const decision = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(approvalRequestId);
        const allow = fallback();                              // autoDecision is synchronous
        // Phase 3: correlatable event so a TUI-rendered permission banner for a
        // request the daemon already resolved (via timeout) can be cleared —
        // without it the banner would persist forever and hijack the y/n keys.
        this.deps.events.append({
          agentId: record.agentId, kind: "status",
          data: { permissionResolved: true, requestId: approvalRequestId, allow, timedOut: true },
        });
        resolve(stampLandingDenied(allow));
      }, this.deps.permissionTimeoutMs ?? 120_000);
      this.pendingPermissions.set(approvalRequestId, { agentId: record.agentId, resolve: (allow) => {
        clearTimeout(timer);
        this.pendingPermissions.delete(approvalRequestId);
        resolve(stampLandingDenied(allow));
      } });
    });
    this.deps.events.append({
      agentId: record.agentId, kind: "permission_request",
      // scrub for §6 consistency with onEvent/failover: a tool input can echo an
      // injected credential. (Top-level string redaction only; deep-redacting a
      // secret nested inside an object input is the tracked redaction-hardening item.)
      // WD Stage 2 (coverage B14) / MCP-FOREIGN-POLICY: a toolPolicy-forced ask (Bash "ask" or
      // foreign-MCP "prompt") stamps ADDITIVE keys (policyAsk + the detected tool, plus the
      // profile for Bash) so the permission card can say WHY this prompt appeared for an
      // otherwise auto-allowing agent. For an MCP ask, `tool` is the full mcp__server__tool name.
      data: this.scrub({
        requestId: approvalRequestId, backendRequestId: req.requestId,
        toolName: req.toolName, input: req.input, policy,
        ...(askStamp ?? {}),
      }),
    });
    this.noteAttention(record.agentId, "permission_request");
    const cancel = () => { this.respondPermission(approvalRequestId, false); };
    req.signal?.addEventListener("abort", cancel, { once: true });
    if (req.signal?.aborted) cancel();
    try { return await decision; } finally { req.signal?.removeEventListener("abort", cancel); }
  }

  // native-CLI-parity Phase 2 (Task DLG1): native interactive dialogs (AskUserQuestion/
  // elicitation). Mirrors decidePermission()'s register-before-emit + timeout discipline
  // EXACTLY: the pendingDialogs entry MUST exist before the agent_dialog event fires
  // (EventLog notifies subscribers SYNCHRONOUSLY, so a TUI answerer can call answerDialog
  // from inside the subscribe callback). On timeout the dialog resolves {behavior:"cancelled"}
  // (there is no permission-style auto-decision fallback for a native dialog) and a
  // dialogResolved status event lets a TUI-rendered dialog banner clear itself.
  protected async decideDialog(record: AgentRecord, req: DialogRequest): Promise<DialogDecision> {
    const fallback: DialogDecision = { behavior: "cancelled" };
    if (req.signal?.aborted) return fallback;
    const decision = new Promise<DialogDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingDialogs.delete(req.dialogId);
        this.deps.events.append({
          agentId: record.agentId, kind: "status",
          data: { dialogResolved: true, dialogId: req.dialogId, cancelled: true, timedOut: true },
        });
        resolve(fallback);
      }, this.deps.questionTimeoutMs ?? 120_000);
      this.pendingDialogs.set(req.dialogId, { agentId: record.agentId, resolve: (d) => {
        clearTimeout(timer);
        this.pendingDialogs.delete(req.dialogId);
        resolve(d);
      } });
    });
    this.deps.events.append({
      agentId: record.agentId, kind: "agent_dialog",
      data: this.scrub({ dialogId: req.dialogId, dialogKind: req.dialogKind, payload: req.payload, toolUseId: req.toolUseId }),
    });
    const cancel = () => { this.answerDialog(req.dialogId, fallback); };
    req.signal?.addEventListener("abort", cancel, { once: true });
    if (req.signal?.aborted) cancel();
    try { return await decision; } finally { req.signal?.removeEventListener("abort", cancel); }
  }

  // TUI backlog 8b: live (no-restart) permission change for a RUNNING agent.
  // decidePermission() reads record.spec.on.permissionRequest / record.spec.permissionProfile
  // FRESH on every canUseTool call (claude.ts calls decidePermission per tool), so mutating
  // the live record here changes behavior starting with the agent's VERY NEXT permission
  // decision — no SDK restart, no respawn. Throws UnknownAgentError for a ghost/unknown
  // agent (via status()) and InvalidPermissionError for a value outside the protocol's enums.
  setPermission(
    agentId: string,
    patch: { permissionRequest?: AgentSpec["on"]["permissionRequest"]; permissionProfile?: AgentSpec["permissionProfile"] },
  ): { appliedToRunningProcess: boolean } {
    const record = this.status(agentId);   // throws UnknownAgentError for ghosts
    if (patch.permissionRequest !== undefined && !PERMISSION_REQUEST_VALUES.has(patch.permissionRequest))
      throw new InvalidPermissionError(`invalid permissionRequest "${patch.permissionRequest}"`);
    if (patch.permissionProfile !== undefined && !PERMISSION_PROFILE_VALUES.has(patch.permissionProfile))
      throw new InvalidPermissionError(`invalid permissionProfile "${patch.permissionProfile}"`);

    // LIVE-PERMISSION-CHANGE-NOT-TOLD-TO-AGENT: capture the PRE-mutation values so the
    // mailbox notice below can tell what actually changed vs. what merely got re-set to
    // its current value (a no-op setPermission({permissionProfile: "acceptEdits"}) on an
    // agent already at "acceptEdits" must not cost the agent a mailbox message).
    const prevPermissionRequest = record.spec.on.permissionRequest;
    const prevPermissionProfile = record.spec.permissionProfile;

    // shallow-clone `on` (mirrors AgentSpecSchema's own shape) so any other key under
    // `record.spec.on` future phases add stays intact; permissionProfile sits directly
    // on record.spec, so it's set in place without touching the rest of the spec.
    if (patch.permissionRequest !== undefined)
      record.spec.on = { ...record.spec.on, permissionRequest: patch.permissionRequest };
    if (patch.permissionProfile !== undefined)
      record.spec.permissionProfile = patch.permissionProfile;

    // CODEX-SETPERMISSION-IS-COSMETIC-TO-THE-OPERATOR: codex has no live canUseTool hook
    // (decidePermission is never invoked for it — codex.ts) and its OS sandbox is fixed at
    // process launch from SANDBOX_BY_PROFILE, so NEITHER permissionProfile NOR permissionRequest
    // takes effect on an already-running codex process — only on some future respawn. Surface
    // this to the OPERATOR (not just the agent's mailbox notice below), because the dangerous
    // direction is silent: an operator LOWERING a running codex agent's profile to contain it
    // must not be told "ok" and believe it's contained when the live sandbox is unchanged.
    // KIMI-BACKEND S3 / S0(d1) CONFIRMED (docs/superpowers/specs/2026-07-28-kimi-backend-s0-findings.md):
    // kimi's yoloMode (permissionProfile's live wire) is a plain property setter the SDK only
    // diffs at the START of the NEXT turn (SessionImpl.configChanged()/getClientWithConfigCheck())
    // — there is no live RPC that pushes a posture change into an already-running Kimi CLI child
    // process, same operator-facing shape as codex's cosmetic gap (this record mutation and the
    // decidePermission wiring (kimi.ts) both read the fresh spec, but the CURRENTLY RUNNING CLI
    // process/turn does not re-check it mid-flight).
    const appliedToRunningProcess = record.provider !== "codex" && record.provider !== "kimi";

    // observability: so a TUI/CLI watching this agent's stream can reflect the
    // live change (spec §6-style scrub for consistency with every other status event).
    this.deps.events.append({
      agentId, kind: "status",
      data: this.scrub({
        permissionChanged: true,
        appliedToRunningProcess,
        ...(patch.permissionRequest !== undefined ? { permissionRequest: patch.permissionRequest } : {}),
        ...(patch.permissionProfile !== undefined ? { permissionProfile: patch.permissionProfile } : {}),
      }),
    });

    // LIVE-PERMISSION-CHANGE-NOT-TOLD-TO-AGENT: decidePermission() reads the live spec
    // (comment above), so enforcement is already correct from the very next tool call —
    // but nothing on that path ever told the AGENT its permissions changed. The agent's
    // only source of truth about its own permissions was its spawn-time system prompt
    // (which never states permissionProfile/permissionRequest at all — verified against
    // launch()'s capabilityBlock/componentsBlock construction above and both backends'
    // spawn-time mapping in claude.ts/codex.ts), so a running agent has NO way to learn
    // of an operator's live grant/revocation on its own. Reuse the SAME mailbox path
    // agent_send/send() uses (mailboxes.enqueue + deliverPending) — delivered at the
    // agent's NEXT turn boundary, same as any other operator message. This CANNOT reach
    // a turn already in flight right now: there is no channel to inject into a live
    // in-progress turn, only the next one.
    const changedProfile = patch.permissionProfile !== undefined && patch.permissionProfile !== prevPermissionProfile;
    const changedRequest = patch.permissionRequest !== undefined && patch.permissionRequest !== prevPermissionRequest;
    if (changedProfile || changedRequest) {
      const lines: string[] = ["Your permissions were changed by the operator:"];
      if (changedProfile)
        lines.push(`- permission profile is now "${patch.permissionProfile}": ${PERMISSION_PROFILE_DESCRIPTION[patch.permissionProfile!]}`);
      if (changedRequest)
        lines.push(`- permission request routing is now "${patch.permissionRequest}": ${PERMISSION_REQUEST_DESCRIPTION[patch.permissionRequest!]}`);
      // CODEX-SANDBOX-FIXED-AT-SPAWN: codex has no live canUseTool equivalent (codex.ts
      // comment on the `decidePermission` no-op) — its OS-level sandbox is fixed at process
      // launch from the profile codex was SPAWNED with. A live permissionProfile change here
      // updates the record and this notice's TEXT, but does not re-sandbox the running codex
      // process. Say so plainly rather than implying the agent can now actually reach the
      // filesystem/network the new profile would imply.
      if (changedProfile && record.provider === "codex")
        lines.push("  (codex note: your OS-level sandbox was fixed at spawn and is NOT changed by this — this profile value now only affects any future codex respawn, not this running process)");
      // KIMI-BACKEND S3 / S0(d1) CONFIRMED: unlike codex, this DOES self-heal — the SDK diffs
      // yoloMode automatically and kills+respawns the underlying CLI process at the START of the
      // next turn, no chimera-side respawn needed. But it is NOT retroactive: the turn (if any)
      // already in flight right now keeps running under the OLD posture.
      if (changedProfile && record.provider === "kimi")
        lines.push("  (kimi note: this does NOT change the approval posture of any turn already in flight — it takes effect automatically at the start of your NEXT turn, when the SDK re-checks it and respawns its CLI process)");
      this.deps.mailboxes.enqueue(agentId, { from: "system", kind: "user_message", text: lines.join("\n") });
      this.deliverPending(agentId);
    }
    return { appliedToRunningProcess };
  }

  // RESPAWN-KEEPS-IDENTITY: every kill+respawn-under-the-same-agentId path (setModel, setEffort,
  // setAccount, setTurnLimit, reconfigure, rebind, and the auto-resume-on-mail path) used to hand
  // spawn() exactly `{ agentId, treeId, depth }` — so an agent came back with its transcript and
  // its session but WITHOUT its identity: no team membership, no session role, no origin
  // conductor, and a projectId re-derived from cwd rather than the one it actually had.
  //
  // Observed live: an operator moved three team agents to another account with agent_set_account
  // to work around a stuck cooldown, and all three silently fell out of their team — agent_find
  // reported role:null afterwards. The queue task stayed bound only because agentId was reused,
  // which is precisely what made the loss hard to see.
  //
  // Identity is not a spec field, so a `{...spec}` spread cannot carry it; it lives on the
  // AgentRecord and has to be threaded back through spawn()'s opts explicitly. Everything here is
  // a stamped-at-spawn binding that the respawn must reproduce byte-for-byte, never re-derive.
  //
  // NOT included, deliberately: `budgetNodeId`. Reconstructing it means passing `budgetParentId`
  // for a budget-less record, which additionally re-triggers spawn()'s pre-flight budget-headroom
  // admission — turning a settings change into something that can be REFUSED when the tree is
  // near its cap. That is a separate decision from preserving identity and is left alone.
  private respawnOpts(record: AgentRecord): {
    agentId: string; treeId: string; depth: number; principal: string;
    parentId: string | null; originConductorId: string | null; projectId: string | null; promptFrom?: string; promptAuthor?: Principal;
    membership?: { team: string; role: string };
    sessionRole?: string | null;
    sessionRoleOverrides?: Record<string, unknown> | null;
    jobName?: string | null;
    handoffFrom?: string;
  } {
    return {
      agentId: record.agentId, treeId: record.treeId, depth: record.depth,
      principal: record.principal,
      parentId: record.parentId,
      ...(record.promptFrom ? { promptFrom: record.promptFrom } : {}),
      ...(record.initialAuthor ? { promptAuthor: record.initialAuthor } : {}),
      originConductorId: record.originConductorId ?? null,
      // Explicit, never re-derived: spawn() falls back to projectFor(spec.cwd) when this is
      // undefined, which silently drops the projectId of any agent whose cwd is not itself a
      // registered project path (a project conductor's own, most of all).
      projectId: record.projectId,
      ...(record.membership ? { membership: record.membership } : {}),
      ...(record.sessionRole !== undefined ? { sessionRole: record.sessionRole } : {}),
      ...(record.sessionRoleOverrides !== undefined ? { sessionRoleOverrides: record.sessionRoleOverrides } : {}),
      ...(record.jobName !== undefined ? { jobName: record.jobName } : {}),
      ...(record.handoffFrom !== undefined ? { handoffFrom: record.handoffFrom } : {}),
    };
  }

  private settingsResumeOnly(record: AgentRecord): boolean {
    // An ephemeral team worker has a task to finish and nobody waiting to send it
    // another prompt. Starting it idle consumes a queue slot until the liveness
    // breaker fires. Resume its task in the same session after a settings change.
    return !record.membership || record.spec.session;
  }

  // Task MDL-a: change a running agent's model by respawn-with-resume under the SAME
  // agentId. A model is fixed once the SDK session is created, so "changing" it means:
  // kill the current query, then respawn the spec (with model swapped) resuming the
  // prior session id — CR1's opts.agentId keeps transcript/identity continuity, and
  // Interactive sessions wait for the next send; ephemeral team workers continue
  // their assigned task immediately. If the current agent is a
  // conductor, the respawned one stays a conductor (spec.conductor carries over).
  // `opts.idle` forces the respawn to start idle-until-send regardless of settingsResumeOnly:
  // for a caller (trySwitchToFastModel) whose task turn already COMPLETED and that is about to
  // send its own prompt, "resume the task" would re-seed the original spec.prompt on the new
  // model — a stale-task replay whose turn_complete the caller would then mistake for its reply.
  async setModel(agentId: string, model: string, opts: { idle?: boolean } = {}): Promise<AgentRecord> {
    if (this.providerTransfers.has(agentId)) throw new GuardrailError("a manual provider switch is already in progress");
    const r = this.status(agentId);            // throws UnknownAgentError for a ghost
    const { spec, treeId, depth, sessionId } = r;
    // An own model:undefined property still wins a later SDK-options spread.
    // Remove the old override so the selected model survives the idle resume.
    const providerOptions = { ...spec.providerOptions };
    delete providerOptions.model;
    await this.kill(agentId);                   // stop the current query (its model is fixed); awaits interrupt
    try {
      return await this.spawn(
        { ...spec, model, providerOptions, resume: sessionId ?? null, resumeOnly: opts.idle || this.settingsResumeOnly(r) },
        this.respawnOpts(r),                      // SAME agentId → transcript/identity continuity (CR1)
      );
    } catch (err) {
      // Respawn failed — the old query is already killed and unrecoverable, AND spawn()'s
      // own catch already DELETED the fresh record it had set for this agentId (it replaced
      // kill()'s "killed" record before launch() rejected) — without restoring an entry here
      // the agent VANISHES (absent from status()/agent.list). True atomicity is impossible;
      // instead make the failure VISIBLE: restore a terminal "failed" record under the SAME
      // agentId (mirrors onError's failed-state commit) carrying the reason, then re-throw
      // so the RPC caller (TUI store.setModel) still sees the original error.
      const message = `model change failed: ${err instanceof Error ? err.message : String(err)}`;
      const failedRecord: AgentRecord = { ...r, state: "failed" };
      this.agents.set(agentId, failedRecord);
      this.generation++;
      // scrub: err.message may echo a live credential — launch() (line ~170/184) resolves and
      // pushes the credential into this.secrets BEFORE the step that can fail, so at this catch
      // a real secret may be in scope. Mirrors the failover event's scrub at line ~278 (spec §6).
      this.markFailed(failedRecord, message);
      throw err;
    }
  }

  // Mirrors setModel (Task MDL-a) exactly: kill+respawn-with-resume under the SAME agentId,
  // same atomic-failure handling (a respawn failure restores a visible "failed" record rather
  // than letting the agent vanish from status()/agent.list).
  async setEffort(agentId: string, effort: EffortLevel): Promise<AgentRecord> {
    if (this.providerTransfers.has(agentId)) throw new GuardrailError("a manual provider switch is already in progress");
    const r = this.status(agentId);
    const { spec, treeId, depth, sessionId } = r;
    await this.kill(agentId);
    try {
      return await this.spawn(
        { ...spec, effort, resume: sessionId ?? null, resumeOnly: this.settingsResumeOnly(r) },
        this.respawnOpts(r),
      );
    } catch (err) {
      const message = `effort change failed: ${err instanceof Error ? err.message : String(err)}`;
      const failedRecord: AgentRecord = { ...r, state: "failed" };
      this.agents.set(agentId, failedRecord);
      this.generation++;
      this.markFailed(failedRecord, message);
      throw err;
    }
  }

  // SOFT-TURN-LIMIT (live): the turn-budget counterpart of setModel/setEffort — same
  // kill+respawn-with-resume dance under the SAME agentId, for the same structural reason:
  // maxTurns is baked into the SDK query at creation (backends/claude.ts passes spec.maxTurns,
  // or the SOFT_TURN_CAP sentinel under "soft"), so a live query can never be re-capped in
  // place. This is how an operator raises a nominal budget mid-run, or flips a "fail" agent to
  // "soft" so it stops being TERMINATED at the cap at all (error_max_turns, mid-tool-use),
  // without losing its session, context or identity.
  // A patch that changes nothing returns the record untouched: a respawn interrupts a live
  // turn, and no-op interruption is a real cost, not a harmless retry.
  // AGENT-RECONFIGURE: setModel/setEffort/setAccount/setTurnLimit are five copies of one move —
  // kill the process, respawn the SAME agentId into the SAME session with one spec field changed.
  // This is that move, taken once, over a sparse patch. Two things follow that the five could not
  // give: changing three settings costs ONE respawn instead of three (each of which would also
  // interrupt whatever turn is running), and fields that simply never got a setter of their own
  // (instructions, autonomy, orchestration, loadSettings, budget) become changeable at all —
  // until now the only way to adjust an agent's instructions was to spawn a different agent.
  //
  // "Dynamic" here means the CONVERSATION survives, not that the process does: the SDK has no way
  // to change a running session's model or system prompt in place. The session id is carried
  // through, so the agent comes back with its full context and its next turn behaves the new way.
  async reconfigure(agentId: string, patch: AgentSpecPatch): Promise<AgentRecord> {
    if (this.providerTransfers.has(agentId)) throw new GuardrailError("a manual provider switch is already in progress");
    const r = this.status(agentId);                          // throws UnknownAgentError for ghosts
    // TERMINAL-RUNTIME: reconfigure works by killing the agent and respawning it into its own
    // session. For a terminal agent that would tear down the tmux session and take the whole
    // conversation with it — a settings change that silently destroys the work. Refused, and
    // pointed at the place where it actually works: the terminal itself, which for a terminal
    // agent is the operator's real control surface.
    if (r.spec.runtime === "terminal") {
      throw new GuardrailError(
        "a terminal-runtime agent cannot be reconfigured from here — a respawn would kill its session. "
        + "Change it in the terminal instead (/model, /effort), or kill and spawn a new one.",
      );
    }
    for (const key of Object.keys(patch)) {
      const why = UNRECONFIGURABLE[key];
      if (why) throw new GuardrailError(`"${key}" cannot be changed on a live agent — ${why}`);
      if (!RECONFIGURABLE.has(key)) throw new GuardrailError(`"${key}" is not a reconfigurable agent setting`);
    }
    // Same-provider guard, identical to setAccount's: a session id belongs to ONE provider, so
    // "resume this conversation on a different provider" is not a spec edit — it is agent_handoff.
    if (patch.account !== undefined && patch.account !== r.accountName) {
      const acct = this.deps.registry.get(patch.account);    // ConfigError for an unknown account
      if (acct.provider !== r.provider) return this.switchProvider(r, patch.account, patch);
    }
    const { spec, treeId, depth, sessionId } = r;
    const nextSpec = { ...spec, ...patch };
    if (patch.model !== undefined) {
      nextSpec.providerOptions = { ...nextSpec.providerOptions };
      delete nextSpec.providerOptions.model;
    }
    if (patch.effort !== undefined) nextSpec.providerOptions = { ...nextSpec.providerOptions, effort: undefined };
    // A patch that changes nothing must not restart a running turn for no reason — the panel
    // sends the whole form, so most fields in most saves are unchanged.
    if (RECONFIGURABLE_KEYS.every((k) => JSON.stringify(nextSpec[k]) === JSON.stringify(spec[k]))) return r;
    await this.kill(agentId);
    try {
      return await this.spawn(
        { ...nextSpec, resume: sessionId ?? null, resumeOnly: this.settingsResumeOnly(r) },
        this.respawnOpts(r),
      );
    } catch (err) {
      const message = `reconfigure failed: ${err instanceof Error ? err.message : String(err)}`;
      const failedRecord: AgentRecord = { ...r, state: "failed" };
      this.agents.set(agentId, failedRecord);
      this.generation++;
      this.markFailed(failedRecord, message);
      throw err;
    }
  }

  async setTurnLimit(
    agentId: string,
    opts: { maxTurns?: number; turnLimitPolicy?: AgentSpec["turnLimitPolicy"] },
  ): Promise<AgentRecord> {
    if (this.providerTransfers.has(agentId)) throw new GuardrailError("a manual provider switch is already in progress");
    const r = this.status(agentId);
    const { spec, treeId, depth, sessionId } = r;
    const maxTurns = opts.maxTurns ?? spec.maxTurns;
    const turnLimitPolicy = opts.turnLimitPolicy ?? spec.turnLimitPolicy;
    if (maxTurns === spec.maxTurns && turnLimitPolicy === spec.turnLimitPolicy) return r;
    await this.kill(agentId);
    try {
      return await this.spawn(
        { ...spec, maxTurns, turnLimitPolicy, resume: sessionId ?? null, resumeOnly: this.settingsResumeOnly(r) },
        this.respawnOpts(r),
      );
    } catch (err) {
      const message = `turn limit change failed: ${err instanceof Error ? err.message : String(err)}`;
      const failedRecord: AgentRecord = { ...r, state: "failed" };
      this.agents.set(agentId, failedRecord);
      this.generation++;
      this.markFailed(failedRecord, message);
      throw err;
    }
  }

  // Manual account/model changes keep the Chimera identity. Same-provider changes
  // resume natively; cross-provider changes use portable source context in a fresh session.
  async setAccount(agentId: string, account: string, model?: string, acknowledgeCodexFullAccessRisk?: boolean): Promise<AgentRecord> {
    if (this.providerTransfers.has(agentId)) throw new GuardrailError("a manual provider switch is already in progress");
    const r = this.status(agentId);
    const acct = this.deps.registry.get(account);   // throws ConfigError for an unknown account
    if (acct.provider !== r.provider) return this.switchProvider(r, account, { ...(model ? { model } : {}), ...(acknowledgeCodexFullAccessRisk !== undefined ? { acknowledgeCodexFullAccessRisk } : {}) });
    if (model) return this.reconfigure(agentId, { account, model });
    const { spec, treeId, depth, sessionId, accountName: fromAccount } = r;
    await this.kill(agentId);
    try {
      const next = await this.spawn(
        { ...spec, account, resume: sessionId ?? null, resumeOnly: this.settingsResumeOnly(r) },
        this.respawnOpts(r),
      );
      // Mirrors onError's failover event shape so existing failover-aware UI (transcript
      // banner in ui-state's reducer, replay.ts's state:"running" pin) picks up a manual
      // account switch the same way it already picks up an automatic cooldown reroute.
      this.deps.events.append({
        agentId, kind: "failover",
        data: this.scrub({ from: fromAccount, to: account, provider: acct.provider, reason: "manual account switch" }),
      });
      return next;
    } catch (err) {
      const message = `account change failed: ${err instanceof Error ? err.message : String(err)}`;
      const failedRecord: AgentRecord = { ...r, state: "failed" };
      this.agents.set(agentId, failedRecord);
      this.generation++;
      this.markFailed(failedRecord, message);
      throw err;
    }
  }

  private async switchProvider(r: AgentRecord, accountName: string, patch: AgentSpecPatch): Promise<AgentRecord> {
    const agentId = r.agentId;
    const initialState = r.state;
    if (this.providerTransfers.has(agentId)) throw new GuardrailError("a manual provider switch is already in progress");
    if (r.spec.runtime === "terminal") throw new GuardrailError("terminal-runtime agents cannot be switched from here");
    const account = this.deps.registry.get(accountName);
    const backend = this.deps.backends.get(account.provider);
    if (!backend) throw new GuardrailError(`no backend registered for provider "${account.provider}"`);
    const model = patch.model ?? findProvider(account.provider)?.defaultModel;
    if (!model || typeof model !== "string") throw new GuardrailError("select a target model for the provider switch");
    if (account.provider === "codex" && r.spec.permissionProfile === "full" && !(patch.acknowledgeCodexFullAccessRisk ?? r.spec.acknowledgeCodexFullAccessRisk)) throw new GuardrailError("Codex full access requires acknowledgeCodexFullAccessRisk:true; or lower the permission profile first");
    const cwd = r.spec.isolation === "worktree" ? worktreePath({ ...r.spec, agentId }) : r.spec.cwd;
    if (!existsSync(cwd)) throw new GuardrailError(`working directory no longer exists: ${cwd}`);
    // Validate the entire new spec and credential BEFORE interrupting the source.
    const nextSpec = AgentSpecSchema.parse({ ...r.spec, ...patch, account: accountName, provider: account.provider, model,
      effort: patch.effort, providerOptions: {}, plugins: [],
      compactionThreshold: patch.compactionThreshold, contextWindow: patch.contextWindow, resume: null, resumeOnly: false,
    });
    await this.deps.credentials.resolve(account.auth);
    if (this.providerTransfers.has(agentId) || this.status(agentId) !== r || r.state !== initialState) throw new GuardrailError("agent changed while preparing the provider switch; retry");
    const controller = new AbortController();
    this.providerTransfers.set(agentId, { source: r, controller });
    this.deps.events.append({ agentId, kind: "status", data: { providerSwitch: "compacting", fromProvider: r.provider, toProvider: account.provider } });
    try {
      await this.delivering.get(agentId);
      controller.signal.throwIfAborted();
      const stranded = this.inFlight.get(agentId) ?? [];
      for (const message of stranded) this.deps.mailboxes.enqueue(agentId, { ...message, id: randomUUID(), message: this.deps.mailboxes.envelope(message) });
      this.inFlight.delete(agentId);
      await this.handles.get(agentId)?.kill();
      this.handles.delete(agentId);
      const timer = this.resumeTimers.get(agentId);
      if (timer) { clearTimeout(timer); this.resumeTimers.delete(agentId); }
      this.promptAck.forget(agentId);
      this.settleUnrecordedUsage(r);
      const history = this.deps.events.replay({ agentId, limit: 10_000 }).filter((event) => event.kind !== "message_delta");
      const archiveText = String(this.scrubValue(`# Original task\n${r.spec.prompt}\n\n# Instructions\n${r.spec.instructions ?? ""}\n\n# Retained events (latest 10000; raw provider internals excluded)\n${history.map((e) => JSON.stringify({ seq: e.seq, kind: e.kind, data: e.data })).join("\n")}\n\n# Mailbox history (includes user corrections and attachments)\n${JSON.stringify(this.deps.mailboxes.history(agentId))}`));
      const archive = this.deps.events.archiveContext(archiveText);
      let summary: string | undefined;
      let fallbackReason = "source session is unavailable; using retained history";
      const source = this.transferSources.get(r);
      const sourceBackend = this.deps.backends.get(r.provider);
      if (source && r.sessionId && sourceBackend?.capabilities.supportsResume) {
        try {
          summary = await summarizeTransferContext(sourceBackend, source, r.sessionId, cwd, controller.signal, (cost, estimated) => {
            r.costUsd += cost; this.trackCost(r, cost, estimated);
          });
        } catch (error) { fallbackReason = error instanceof Error ? error.message : String(error); }
      }
      controller.signal.throwIfAborted();
      const recentMail = this.deps.mailboxes.history(agentId).slice(-20).map((m) => `[${m.from}] ${m.text}`).join("\n");
      const context = summary ?? history.filter((e) => e.kind === "message_complete").slice(-15).map((e) => String(e.data.text ?? "")).join("\n\n");
      const prompt = String(this.scrubValue(`# Manual provider transfer\nYou are the SAME Chimera agent ${agentId}, now using ${account.provider}/${model}. Native session history is not transferable.\nWorking directory is unchanged: ${cwd}. Verify on-disk state before editing.\n\n# Original objective\n${r.spec.prompt.slice(0, 16000)}\n\n# ${summary ? "Source-session context compaction" : "Fallback recorded context (not a source compaction)"}\n${context.slice(0, 48000)}\n\n# Recent messages, including user corrections\n${recentMail.slice(-24000)}\n\n# Detailed context archive\n${archive}\nRead this file when details, earlier constraints, tool outputs or attachments are needed. It contains retained events and mailbox history, not hidden provider reasoning.\nPending mailbox messages will follow separately. Preserve ALL user constraints, including stop/wait instructions unless the USER superseded them. Do not treat the handover as a new authorization.\n${summary ? "" : `Compaction unavailable: ${fallbackReason}`}`));
      this.deps.events.archiveContext(String(this.scrubValue(`# Transfer to ${account.provider}/${model}\n${prompt}`)));
      // No terminal event for the old process: workflow/task ownership stays on this id.
      r.state = "killed";
      const images = r.spec.content?.filter((block) => block.type === "image") ?? [];
      const next = await this.spawn({ ...nextSpec, prompt, content: images.length ? [{ type: "text", text: prompt }, ...images] : undefined }, this.respawnOpts(r));
      if (controller.signal.aborted || next.state === "failed") {
        await this.handles.get(agentId)?.kill();
        this.handles.delete(agentId);
        controller.signal.throwIfAborted();
        throw new GuardrailError("target provider failed to start; source session retained for recovery");
      }
      next.createdAt = r.createdAt;
      next.displayLabel = r.displayLabel;
      next.displayLabelPinned = r.displayLabelPinned;
      next.groups = r.groups === undefined ? undefined : [...r.groups];
      next.costUsd += r.costUsd;
      this.deps.events.append({ agentId, kind: "status", data: { providerSwitch: "completed", provider: account.provider, accountName, model, createdAt: next.createdAt, costUsd: next.costUsd, displayLabel: next.displayLabel, groups: next.groups, contextTransfer: { mode: summary ? "source-compaction" : "history-fallback", archive, fromProvider: r.provider, fromSessionId: r.sessionId, ...(summary ? {} : { reason: fallbackReason }) } } });
      return next;
    } catch (error) {
      // Keep the source session and its archive available for recovery; never
      // pass its native session id to the target provider on failure.
      if (!controller.signal.aborted) {
        this.agents.set(agentId, r);
        this.generation++;
        r.state = "failed";
        this.markFailed(r, `manual provider switch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    } finally {
      this.providerTransfers.delete(agentId);
      this.deliverPending(agentId);
    }
  }

  // CROSS-PROVIDER-HANDOFF: setAccount's explicit gap, filled — move a running/paused/
  // stranded agent's CONTEXT to a FRESH agent on a different provider/account. Unlike
  // setAccount's context-transfer path, this legacy API replaces the Chimera identity.
  // A Claude session id means nothing to Codex/Kimi/GLM, so there is no native session to
  // resume across the boundary. Instead: build a portable brief from the event log (see
  // handoff-package.ts — mechanical extraction, no LLM, never fabricates tool-call history)
  // and spawn a BRAND NEW agentId with it as the opening prompt, re-pointed at the SAME
  // worktree with isolation:"none" (mirrors resume()'s exact worktree-reuse mechanics).
  //
  // Design decisions (see the approved design in chat, 2026-08-24):
  //  - `model` is REQUIRED on the caller side (AgentHandoffParams) — chimera has no
  //    cross-provider model-equivalence table, so silently carrying the source's model
  //    string over would just fail late on the target provider.
  //  - Refuses (GuardrailError, BEFORE touching the live process — mirrors setAccount's own
  //    provider guard) unless isolation:"worktree": that is the one condition chimera can
  //    actually vouch durable state survived on disk. isolation:"none" has nothing to hand
  //    forward but the event-log narrative, which is not enough to trust a handoff blindly.
  //  - No new AgentState value. The source settles to the existing "done" (not "killed" —
  //    the just-landed glyph-toning commit paints "killed" as a warning, and a deliberate
  //    handoff is not an error) with `handoffTo` stamped; a prior "failed" source is still
  //    legible as having failed via the status event's `priorState` field and the reason the
  //    caller can read off agent.status — handoff is allowed from ANY prior state (this is
  //    the feature's own motivating case: rescuing agents already paused/failed on a quota
  //    exhaustion), it does not retroactively pretend a real failure didn't happen.
  //  - Pending mailbox messages (queued AND this-turn in-flight, the latter re-enqueued
  //    durably first via the exact onError "stranded" pattern) are FORWARDED to the new
  //    agent's mailbox, never merely mentioned as a gap — those are undelivered
  //    instructions, not history.
  //  - deliverTo/maxBudgetUsd/deliverWake/membership/originConductorId/projectId/principal/
  //    sessionRole all carry over (spec fields via the `...inherited` spread; the
  //    record-level ones threaded explicitly into spawn()'s opts below) — a parent
  //    conductor waiting on this agent's result must not wait forever. parentId does NOT
  //    carry over (a handoff target wasn't spawned by a live caller invoking agent.spawn).
  async handoff(agentId: string, opts: { toAccount: string; model: string; note?: string }): Promise<AgentRecord> {
    const r = this.status(agentId);   // throws UnknownAgentError for a ghost
    if (r.spec.isolation !== "worktree") {
      throw new GuardrailError(
        `agent ${agentId} has isolation:"${r.spec.isolation}" — chimera cannot vouch that its durable state survived on disk outside a worktree, so handoff is refused. ` +
        `Either let it finish on its current provider, or spawn a fresh agent on the target provider with a new brief instead of handing this one off.`,
      );
    }
    const acct = this.deps.registry.get(opts.toAccount);   // throws ConfigError for an unknown account
    const effectiveCwd = worktreePath({ cwd: r.spec.cwd, agentId: r.agentId, workdirKey: r.spec.workdirKey });
    if (!existsSync(effectiveCwd)) {
      throw new GuardrailError(
        `agent ${agentId}'s worktree no longer exists (${effectiveCwd}) — chimera cannot vouch that its state survived, so handoff is refused. Spawn a fresh agent on the target provider instead.`,
      );
    }

    // ONERROR-STRANDED-MIRROR: re-enqueue any in-flight (this-turn) messages into the agent's
    // OWN mailbox durably BEFORE touching the live handle — exactly onError's stranded block
    // (supervisor.ts, rate-limit reroute path). Converts "at risk in memory" into "durably
    // queued", so the peek/forward/drain dance below picks it up uniformly alongside anything
    // that was already mailbox-queued.
    const stranded = this.inFlight.get(agentId);
    if (stranded && stranded.length > 0) {
      for (const m of stranded) {
        this.deps.mailboxes.enqueue(agentId, {
          from: m.from, kind: m.kind, text: m.text, engineId: m.engineId, message: this.deps.mailboxes.envelope(m), id: randomUUID(),
          ...(m.meta ? { meta: m.meta } : {}),
          ...(m.images ? { images: m.images } : {}),
          ...(m.content ? { content: m.content } : {}),
          ...(m.slash ? { slash: true } : {}),
          ...(m.force ? { force: true } : {}),
        });
      }
    }
    this.inFlight.delete(agentId);

    // Stop the live process (if any) BEFORE snapshotting ground truth for the brief — a
    // still-running agent must not keep mutating the worktree while we read it.
    await this.handles.get(agentId)?.kill();
    const timer = this.resumeTimers.get(agentId);
    if (timer) { clearTimeout(timer); this.resumeTimers.delete(agentId); }
    autoCommitDirtyWorktree(
      { isolation: r.spec.isolation, cwd: r.spec.cwd, agentId, workdirKey: r.spec.workdirKey },
      `agent ${agentId} handed off to ${opts.toAccount}`,
    );

    // Peek (non-destructive) now — the count feeds the package text below — but do NOT ack
    // (drain) the source mailbox until the target actually exists (see the try/catch: a
    // failed spawn must not lose mail that was never delivered anywhere).
    const pendingMail = this.deps.mailboxes.pending(agentId);
    const pkg = buildHandoffPackage({
      record: r, events: this.deps.events, effectiveCwd,
      targetModel: opts.model, targetProvider: acct.provider, catalog: this.deps.modelCatalog,
      note: opts.note, pendingMailCount: pendingMail.length,
    });

    const newAgentId = randomUUID();
    const { content: _content, provider: _sourceProvider, ...inherited } = r.spec;
    const spec: AgentSpec = {
      ...inherited,
      prompt: pkg.text,
      cwd: effectiveCwd,
      isolation: "none",
      account: opts.toAccount,
      model: opts.model,
      resume: null,
      resumeOnly: false,
    };

    let next: AgentRecord;
    try {
      next = await this.spawn(spec, {
        agentId: newAgentId, treeId: r.treeId, depth: r.depth, handoffFrom: agentId,
        membership: r.membership, originConductorId: r.originConductorId, projectId: r.projectId,
        principal: r.principal, sessionRole: r.sessionRole, sessionRoleOverrides: r.sessionRoleOverrides,
      });
    } catch (err) {
      const message = `handoff failed: ${err instanceof Error ? err.message : String(err)}`;
      const failedRecord: AgentRecord = { ...r, state: "failed" };
      this.agents.set(agentId, failedRecord);
      this.generation++;
      this.markFailed(failedRecord, message);
      throw err;
    }

    // The target exists now — safe to actually forward + ack the source mailbox (re-peek
    // rather than trust the earlier snapshot: a message could have landed in the gap).
    const toForward = this.deps.mailboxes.pending(agentId);
    for (const m of toForward) {
      this.deps.mailboxes.enqueue(newAgentId, {
        from: m.from, kind: m.kind, text: m.text, engineId: m.engineId, message: this.deps.mailboxes.envelope(m), id: randomUUID(),
        ...(m.meta ? { meta: m.meta } : {}),
        ...(m.images ? { images: m.images } : {}),
        ...(m.content ? { content: m.content } : {}),
        ...(m.slash ? { slash: true } : {}),
        ...(m.force ? { force: true } : {}),
      });
    }
    if (toForward.length > 0) this.deps.mailboxes.drain(agentId);

    // Settle the source AFTER the target exists — never claim "done" before there is
    // something real to hand off to. settleUnrecordedUsage must run BEFORE flipping state to
    // "done" (its own guard no-ops once state==="done", mirroring kill()'s ordering intent).
    this.settleUnrecordedUsage(r);
    const priorState = r.state;
    r.state = "done";                          // commit BEFORE append (waitFor invariant, mirrors kill())
    r.handoffTo = newAgentId;
    this.deps.events.append({
      agentId, kind: "status",
      data: this.scrub({
        state: "done", handoffTo: newAgentId, toProvider: acct.provider, toAccount: opts.toAccount,
        priorState, forwardedMailCount: toForward.length, reason: "handoff",
      }),
    });
    this.stampWorktreeLanding(r, agentId);
    this.terminateShadows(agentId, "done");
    this.generation++;

    return next;
  }

  // REBIND: has this agent produced any real turn yet? Zero message_complete/tool_call/
  // tool_result events means there is nothing worth preserving — the cheap same-agentId
  // respawn path in rebind() below is safe. Mirrors handoff-package.ts's own event-kind
  // filter exactly (the same three kinds it scans for anchors/recent-turns).
  private hasRealHistory(agentId: string): boolean {
    // No fromSeq ⇒ replay returns this agent's NEWEST `limit` events (any kind) — 500 is far
    // more than a genuinely idle default agent (a handful of status/registered events, nothing
    // else) could ever have, so a real message_complete/tool_call/tool_result is never missed.
    return this.deps.events
      .replay({ agentId, limit: 500 })
      .some((e) => e.kind === "message_complete" || e.kind === "tool_call" || e.kind === "tool_result");
  }

  // REBIND: the cwd counterpart of handoff() above — move a running/paused/stranded agent to a
  // NEW working directory, same provider/account/model throughout (never a provider/account
  // change, so no cross-provider model-equivalence problem to solve). Its own motivating case is
  // the "instant default spawn" feature: a chat session started with isolation:"none" and no
  // path bound yet (see app's spawnDefault/DEFAULT_SESSION_INSTRUCTIONS) that turns out to be
  // about something real and needs relocating to an actual project path.
  //
  // Design decisions:
  //  - Deliberately carries NO isolation:"worktree" guard, unlike handoff() — that guard exists
  //    there to vouch durable state survived ON DISK before claiming a handoff carried it
  //    forward. rebind() never makes that claim: the package's "ground truth" section (see
  //    handoff-package.ts's axis:"cwd" framing) explicitly tells the target the OLD cwd's state
  //    was NOT copied to the new one, only the conversation narrative was. Refusing exactly the
  //    isolation:"none" agents this feature exists to relocate would defeat the point.
  //  - TWO paths, chosen by hasRealHistory (not by a caller flag — the cheap path is only ever
  //    correct when there is nothing to lose, so it must not be requestable when there is):
  //    (a) no real history yet: kill + respawn the SAME agentId at the new cwd, resume:null
  //        (a session tied to the OLD cwd cannot resume at a new one — same invariant
  //        agent_resume's own contract documents) but resumeOnly preserved from the ORIGINAL
  //        spec, so a still-idle "fresh but idle" default agent (resumeOnly:true, placeholder
  //        prompt never sent) stays idle at its new location instead of firing its placeholder
  //        as a real first turn. No package, no lineage — mirrors setModel's kill+respawn-same-
  //        agentId precedent exactly, chosen over minting a new id because there is no real
  //        conversation identity yet worth distinguishing from a fresh spawn.
  //    (b) real history exists: mechanically identical to handoff() from here — a live SDK
  //        session cannot be resumed under a different cwd any more than under a different
  //        provider, so this MUST mint a fresh lineaged agentId with the package as its opening
  //        prompt (consistency with handoff()'s precedent, not novelty — same underlying
  //        "session can't cross this boundary" reason as the provider axis). Reuses
  //        handoffFrom/handoffTo for the lineage edge rather than adding rebind-specific fields:
  //        both mean the same thing ("whose context was I built from"), just a different axis of
  //        what changed; the status event's own `reason` field ("rebind" vs "handoff") is what
  //        actually distinguishes them for anyone reading the event log.
  async rebind(agentId: string, opts: { cwd: string; isolation?: "none" | "worktree"; note?: string }): Promise<AgentRecord> {
    const r = this.status(agentId);   // throws UnknownAgentError for a ghost
    const targetIsolation = opts.isolation ?? "none";
    const newCwd = opts.cwd;

    if (!this.hasRealHistory(agentId)) {
      const { spec, treeId, depth } = r;
      // ADMISSION-SAFE: the real kill() (not just the raw handle) — rebind never changes
      // account, so without flipping r.state off "running" here, spawn()'s own per-account/
      // global admission check would count BOTH the about-to-be-replaced record and the new
      // one it's admitting, wrongly refusing a same-account rebind exactly when the account is
      // tightly capped (the common case). Mirrors setModel/setEffort/setAccount's own
      // kill()-then-respawn-under-the-same-agentId precedent exactly.
      await this.kill(agentId);
      const nextSpec: AgentSpec = { ...spec, cwd: newCwd, isolation: targetIsolation, resume: null };
      try {
        // RESPAWN-KEEPS-IDENTITY, minus projectId: rebind is the one respawn that deliberately
        // CHANGES cwd, so project ownership must be re-derived from the new one rather than
        // pinned to the project the old cwd belonged to.
        const { projectId: _rederive, ...identity } = this.respawnOpts(r);
        return await this.spawn(nextSpec, identity);   // SAME agentId — nothing real to lose yet
      } catch (err) {
        const message = `rebind failed: ${err instanceof Error ? err.message : String(err)}`;
        const failedRecord: AgentRecord = { ...r, state: "failed" };
        this.agents.set(agentId, failedRecord);
        this.generation++;
        this.markFailed(failedRecord, message);
        throw err;
      }
    }

    // Real-history path — mechanically identical to handoff() (see its own comments for the
    // stranded-mail/mailbox-forwarding/settle-after-target-exists rationale, unchanged here).
    const stranded = this.inFlight.get(agentId);
    if (stranded && stranded.length > 0) {
      for (const m of stranded) {
        this.deps.mailboxes.enqueue(agentId, {
          from: m.from, kind: m.kind, text: m.text, engineId: m.engineId, message: this.deps.mailboxes.envelope(m), id: randomUUID(),
          ...(m.meta ? { meta: m.meta } : {}),
          ...(m.images ? { images: m.images } : {}),
          ...(m.content ? { content: m.content } : {}),
          ...(m.slash ? { slash: true } : {}),
          ...(m.force ? { force: true } : {}),
        });
      }
    }
    this.inFlight.delete(agentId);

    const priorState = r.state;   // captured before any mutation below
    await this.handles.get(agentId)?.kill();
    const timer = this.resumeTimers.get(agentId);
    if (timer) { clearTimeout(timer); this.resumeTimers.delete(agentId); }
    // ADMISSION-SAFE (same reasoning as the no-history branch above, see its comment): rebind
    // never changes account, so the source record must stop counting as "running" BEFORE the
    // replacement is spawned under a NEW agentId, or a same-account admission check double-
    // counts them. Unlike the no-history branch this can't just call kill() — that would emit
    // a "killed" event and this settles "done" (a deliberate rebind, not an error, exactly
    // handoff()'s own reasoning) — so it flips the field directly with no event yet, mirroring
    // this file's own "commit state before append" invariant (kill()'s comment), just extended
    // to also precede spawning the replacement. If the spawn below throws, the catch path
    // already builds its OWN failedRecord with an explicit state:"failed", so this premature
    // flip is never the final observable outcome of a failed rebind.
    r.state = "done";
    // effectiveCwd is the OLD cwd — read for the package's historical "ground truth" section
    // only (never refused if missing/unreadable, unlike handoff()'s hard existsSync guard: this
    // path is reachable from isolation:"none" agents with no worktree to vouch for at all).
    const effectiveCwd = worktreePath({ cwd: r.spec.cwd, agentId: r.agentId, workdirKey: r.spec.workdirKey });
    if (existsSync(effectiveCwd))
      autoCommitDirtyWorktree(
        { isolation: r.spec.isolation, cwd: r.spec.cwd, agentId, workdirKey: r.spec.workdirKey },
        `agent ${agentId} rebound to ${newCwd}`,
      );

    const pendingMail = this.deps.mailboxes.pending(agentId);
    const pkg = buildHandoffPackage({
      record: r, events: this.deps.events, effectiveCwd, newCwd, axis: "cwd",
      targetModel: r.spec.model ?? "", targetProvider: r.provider, catalog: this.deps.modelCatalog,
      note: opts.note, pendingMailCount: pendingMail.length,
    });

    const newAgentId = randomUUID();
    const { content: _content, ...inherited } = r.spec;
    const spec: AgentSpec = {
      ...inherited,
      prompt: pkg.text,
      cwd: newCwd,
      isolation: targetIsolation,
      resume: null,
      resumeOnly: false,
    };

    let next: AgentRecord;
    try {
      next = await this.spawn(spec, {
        agentId: newAgentId, treeId: r.treeId, depth: r.depth, handoffFrom: agentId,
        membership: r.membership, originConductorId: r.originConductorId, projectId: r.projectId,
        principal: r.principal, sessionRole: r.sessionRole, sessionRoleOverrides: r.sessionRoleOverrides,
      });
    } catch (err) {
      const message = `rebind failed: ${err instanceof Error ? err.message : String(err)}`;
      const failedRecord: AgentRecord = { ...r, state: "failed" };
      this.agents.set(agentId, failedRecord);
      this.generation++;
      this.markFailed(failedRecord, message);
      throw err;
    }

    const toForward = this.deps.mailboxes.pending(agentId);
    for (const m of toForward) {
      this.deps.mailboxes.enqueue(newAgentId, {
        from: m.from, kind: m.kind, text: m.text, engineId: m.engineId, message: this.deps.mailboxes.envelope(m), id: randomUUID(),
        ...(m.meta ? { meta: m.meta } : {}),
        ...(m.images ? { images: m.images } : {}),
        ...(m.content ? { content: m.content } : {}),
        ...(m.slash ? { slash: true } : {}),
        ...(m.force ? { force: true } : {}),
      });
    }
    if (toForward.length > 0) this.deps.mailboxes.drain(agentId);

    this.settleUnrecordedUsage(r);
    r.handoffTo = newAgentId;
    this.deps.events.append({
      agentId, kind: "status",
      data: this.scrub({
        state: "done", handoffTo: newAgentId, toCwd: newCwd,
        priorState, forwardedMailCount: toForward.length, reason: "rebind",
      }),
    });
    this.stampWorktreeLanding(r, agentId);
    this.terminateShadows(agentId, "done");
    this.generation++;

    return next;
  }

  // AGENT-RESUME-TOOLS: one-call recovery of a TERMINAL agent. Unlike setModel/setEffort
  // (which respawn a LIVE agent under the SAME agentId), this is a FRESH spawn that re-enters
  // the dead agent's existing worktree and SDK session with a new continuation brief:
  //   - cwd is the dead agent's EFFECTIVE working dir — its `.chimera/worktrees/<key>` for an
  //     isolation:"worktree" agent (derived via workdirPath, NOT string-concatenated), else its
  //     own spec.cwd. isolation:"none" on the respawn because that worktree ALREADY exists — we
  //     must not have ensureWorkdir try to `git worktree add` a second time.
  //   - resume = its captured sessionId (accumulated context preserved); resumeOnly stays false
  //     so the continuation `prompt` IS pushed as the next turn (recovery has a real brief to
  //     act on, unlike a conductor re-attach).
  //   - account/provider/model/permissionProfile inherit from the dead spec (spread) unless the
  //     turn overrides below replace them.
  // turnLimitPolicy defaults to "soft" so the recovered agent isn't immediately re-failed at the
  // old turn cap. Refuses a still-running/paused agent (kill it first) or one whose worktree is
  // gone (spawn fresh) — both ResumeRefusedError so the caller gets actionable guidance.
  async resume(
    agentId: string,
    opts: { prompt: string; author?: Principal; maxTurns?: number; turnLimitPolicy?: AgentSpec["turnLimitPolicy"]; deliverTo?: string },
  ): Promise<AgentRecord> {
    const r = this.status(agentId);   // throws UnknownAgentError for a ghost
    if (!this.isTerminal(r.state)) {
      throw new ResumeRefusedError(`agent ${agentId} is ${r.state}, not terminal — interrupt or kill it before resuming`);
    }
    const effectiveCwd = r.spec.isolation === "worktree"
      ? worktreePath({ cwd: r.spec.cwd, agentId: r.agentId, workdirKey: r.spec.workdirKey })
      : r.spec.cwd;
    if (!existsSync(effectiveCwd)) {
      throw new ResumeRefusedError(`agent ${agentId}'s workdir no longer exists (${effectiveCwd}) — spawn a fresh agent instead of resuming`);
    }
    // Rebuild the spec from the dead one but drop `content` (its original prompt's image/content
    // blocks would otherwise re-drive the backend instead of the new `prompt`), re-point at the
    // existing worktree with isolation:"none", and resume the captured session.
    const { content: _content, ...inherited } = r.spec;
    const spec: AgentSpec = {
      ...inherited,
      prompt: opts.prompt,
      cwd: effectiveCwd,
      isolation: "none",
      resume: r.sessionId ?? null,
      resumeOnly: false,
      turnLimitPolicy: opts.turnLimitPolicy ?? "soft",
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.deliverTo !== undefined ? { deliverTo: opts.deliverTo } : {}),
    };
    // Fresh agentId (a new record), but keep treeId/depth so the recovered agent stays in the
    // dead one's tree. treeId preserves budget rollup for the common (unbudgeted) case — spend
    // books against the shared treeId node exactly as before. A resumed agent that inherits its
    // OWN maxBudgetUsd instead registers a fresh bounded node for the continuation (not re-nested
    // under the dead agent's ancestor); that's an acceptable recovery semantic, not lineage we
    // try to reconstruct here.
    return await this.spawn(spec, { treeId: r.treeId, depth: r.depth, promptAuthor: opts.author ?? this.principalFor("operator") });
  }

  // TOKEN-OPT-P5: best-effort routing of a single upcoming turn (the workflow
  // handoff-summary turn is the default consumer — pure summarization of an outgoing
  // agent's own session, no capability risk) to the configured per-provider fast/cheap
  // model, via the SAME kill()+respawn-with-resume dance setModel uses above (full
  // session context preserved under the SAME agentId, only the model changes). Silent
  // no-op (returns false, agent left exactly as it was) when: no fast model is
  // configured for this provider (caps.fastModel), the account is already on that
  // model, the backend can't resume a session (capabilities.supportsResume false —
  // e.g. GenericAgentBackend), no sessionId has been captured yet, or the respawn
  // itself fails — every no-op path lets the caller fall through to using the agent at
  // its current (unchanged) model.
  // CALLER CONTRACT: a caller that tracks its own agentId-keyed bindings (QueueScheduler)
  // MUST unbind before calling this and rebind after (mirrors replaceStepAgent's
  // identical unbind-before-teardown ordering) — the kill()+spawn() below emits real
  // terminal + agent_started events under the same agentId that a still-bound caller's
  // own event handler would otherwise race into mis-finalizing whatever it's tracking.
  async trySwitchToFastModel(agentId: string): Promise<boolean> {
    const record = this.agents.get(agentId);
    if (!record || record.state !== "running" || !record.sessionId) return false;
    const backend = this.deps.backends.get(record.provider);
    if (!backend?.capabilities.supportsResume) return false;
    const fast = this.deps.registry.fastModelFor(record.provider);
    if (!fast || record.spec.model === fast) return false;
    // idle: the step's task already finished — the caller sends the summarize prompt itself.
    try { await this.setModel(agentId, fast, { idle: true }); return true; }
    catch { return false; }
  }

  // REMOTE-CONTROL: toggle a provider's native remote-control bridge on a RUNNING
  // agent's live session — unlike setModel above, no kill/respawn: the backend handle's
  // remoteControl() (when present) is a live control-request round trip, so the
  // session's transcript/identity is never interrupted. A provider with no live control
  // surface for it (such as Codex exec) has no
  // handle.remoteControl at all; that surfaces as a clean RemoteControlUnsupportedError
  // rather than a silent no-op. `name` defaults to `chimera-<agentId prefix>` so the
  // attached session is identifiable without the caller inventing one.
  async remoteControl(agentId: string, enable: boolean, name?: string): Promise<RemoteControlStatus> {
    const r = this.status(agentId);                            // throws UnknownAgentError for ghosts
    if (r.state !== "running")
      throw new AgentNotRunningError(`agent ${agentId} is ${r.state}; cannot toggle remote control`);
    const fn = this.handles.get(agentId)?.remoteControl;
    if (!fn) throw new RemoteControlUnsupportedError(`remote control is not supported by this agent's transport (provider "${r.provider}", agentId ${agentId})${r.provider === "codex" ? "; Codex requires codexTransport: app-server and a compatible CLI" : ""}`);

    const effectiveName = enable ? (name ?? `chimera-${agentId.slice(0, 8)}`) : undefined;
    let result: Awaited<ReturnType<typeof fn>>;
    try {
      result = await fn(enable, effectiveName);
    } catch (err) {
      if (r.provider === "codex") throw err;
      throw this.explainRemoteControlDenial(agentId, err as Error);
    }
    const status: RemoteControlStatus = {
      agentId, provider: r.provider, enabled: enable,
      ...(enable ? { name: effectiveName, sessionUrl: result?.sessionUrl, connectUrl: result?.connectUrl } : {}),
      ...(result?.connectionStatus ? { connectionStatus: result.connectionStatus } : {}),
      ...(result?.serverName ? { serverName: result.serverName } : {}),
      ...(result?.environmentId ? { environmentId: result.environmentId } : {}),
    };
    // REMOTE-CONTROL-SURVIVES-PAUSE: persist the operator's DESIRED state onto the record,
    // durable across the process kill/relaunch every pause mechanism does. A successful
    // disable clears it (delete, not `{enabled:false}`) — see AgentRecord.remoteControlIntent's
    // own comment for why an explicit off must leave nothing for a later resume to re-apply.
    const record = this.agents.get(agentId);
    if (record) {
      if (enable) record.remoteControlIntent = { enabled: true, ...(effectiveName ? { name: effectiveName } : {}) };
      else delete record.remoteControlIntent;
    }
    // observability: same "status" event kind setPermission uses above, so a TUI/app
    // watching this agent's stream can render the attach URL the moment it's live.
    this.deps.events.append({ agentId, kind: "status", data: this.scrub({ remoteControl: status }) });
    return status;
  }

  private nativeVoiceChanges = new Set<string>();

  nativeVoiceCheck(agentId: string, allowOwnedTransition = false): { needsTransition: boolean } {
    const r = this.status(agentId);
    if (r.provider !== "codex" || r.spec.runtime === "terminal") throw new GuardrailError("Native voice requires a Codex SDK agent");
    // Approved meeting leases may observe another participant in the brief
    // hold/resume used to enable voice. A manual pause/kill is never exempt.
    if (r.state !== "running" && !(allowOwnedTransition && r.state === "paused" && this.nativeVoiceChanges.has(agentId))) throw new AgentNotRunningError(`Agent is ${r.state}; start it before opening native voice`);
    return { needsTransition: !this.handles.get(agentId)?.nativeVoice || !(r.spec.persistent || r.spec.conductor) };
  }

  currentNativeVoice(agentId: string) {
    const r = this.agents.get(agentId);
    return r?.state === "running" && !this.providerTransfers.has(agentId) && !this.nativeVoiceChanges.has(agentId) ? this.handles.get(agentId)?.nativeVoice : undefined;
  }

  async configureNativeVoice(agentId: string, enabled: boolean): Promise<{ enabled: boolean }> {
    const r = this.status(agentId);
    if (r.provider !== "codex" || r.spec.runtime === "terminal") throw new GuardrailError("Native voice requires a Codex SDK agent");
    if (r.state !== "running" && r.state !== "paused") throw new AgentNotRunningError(`Agent is ${r.state}; cannot configure native voice`);
    if (this.providerTransfers.has(agentId) || this.nativeVoiceChanges.has(agentId)) throw new GuardrailError("An agent connection change is in progress");
    const running = r.state === "running";
    const unchanged = (r.spec.providerOptions.codexRealtime === true) === enabled;
    if (unchanged && (!running || enabled === !!this.handles.get(agentId)?.nativeVoice && (!enabled || r.spec.persistent || r.spec.conductor))) return { enabled };
    if (running && !r.sessionId) throw new GuardrailError("Wait for the Codex agent to establish its session before enabling native voice");
    this.nativeVoiceChanges.add(agentId);
    try {
      // Hold/resume preserves identity and pinned schedules (unlike terminal
      // kill). A paused agent only changes its stored preference; it stays paused.
      if (running && !await this.hold(agentId)) throw new GuardrailError("Agent changed while configuring native voice; retry");
      if (this.agents.get(agentId) !== r || this.status(agentId).state !== "paused") throw new GuardrailError("Agent changed while enabling native voice; retry");
      r.spec = { ...r.spec, ...(enabled ? { persistent: true } : {}), providerOptions: { ...r.spec.providerOptions, ...(enabled ? { codexTransport: "app-server" } : {}), codexRealtime: enabled } };
      this.deps.events.append({ agentId, kind: "status", data: { nativeVoiceEnabled: enabled } });
      if (running) await this.resumePaused(agentId);
      return { enabled };
    } finally { this.nativeVoiceChanges.delete(agentId); }
  }

  async prepareNativeVoice(agentId: string, acknowledgeTransition: boolean) {
    if (this.nativeVoiceCheck(agentId).needsTransition) {
      if (!acknowledgeTransition) throw new GuardrailError("Native voice needs an explicit app-server transition confirmation");
      await this.configureNativeVoice(agentId, true);
    }
    const handle = this.currentNativeVoice(agentId);
    if (!handle) throw new GuardrailError("Native Codex voice is unavailable for this connection");
    return handle;
  }

  // REMOTE-CONTROL-SURVIVES-PAUSE: re-apply a previously-granted remote-control intent to a
  // FRESH process/session after resumePaused relaunches one — every pause path (idle-reap,
  // operator-hold, session-limit, crash-loop, the freshFallback/stale-session sub-paths) kills
  // the OS process, and a new CLI process always starts with the bridge off, so without this
  // "resume" silently drops remote control the operator explicitly turned on.
  //
  // Deliberately swallows every failure via remoteControl()'s own event-emitting/denial-
  // explaining path rather than surfacing one: RemoteControlUnsupportedError is the CLEAN
  // no-op codex (no control surface at all) must produce on every single resume, not a defect;
  // any other rejection (denied credential, transient CLI hiccup) is a nice-to-have attach
  // convenience failing, never a reason to fail a resume the operator is waiting on. A denial
  // still reaches the operator via explainRemoteControlDenial's own status/error path on the
  // NEXT explicit agent.remoteControl call, so nothing is silently lost — just not retried here.
  private reissueRemoteControlIntent(agentId: string): void {
    const intent = this.agents.get(agentId)?.remoteControlIntent;
    if (!intent?.enabled) return;
    void this.remoteControl(agentId, true, intent.name).catch(() => {});
  }

  // COMPACTION-OBSERVABILITY: manually trigger context compaction NOW instead of waiting for a
  // budget to be crossed. Only generic/openai-compat backends implement handle.compact — chimera
  // OWNS their compaction (backends/compaction.ts). claude.ts/codex.ts delegate compaction
  // entirely to their own agentic SDK/CLI (verified: neither's public surface exposes a manual-
  // compact control request chimera could call), so they have no handle.compact at all, and this
  // throws CompactionUnsupportedError naming the real reason — never a silent no-op, never a
  // fabricated "ok: true".
  // MANUAL-COMPACT-ANY-PROVIDER: two genuinely different mechanisms behind one operator gesture.
  // Where chimera owns the context (generic/openai-compat) it compacts directly. Where the
  // provider's own SDK owns it, chimera asks that agent loop to compact via the slash command
  // its CLI already understands — the same thing an operator typing /compact natively does. What
  // it will NOT do is pretend: a provider that offers neither still refuses, and the refusal now
  // says which providers do support it rather than only what this one lacks.
  async compact(agentId: string): Promise<CompactResult> {
    const r = this.status(agentId);                            // throws UnknownAgentError for ghosts
    if (r.state !== "running")
      throw new AgentNotRunningError(`agent ${agentId} is ${r.state}; cannot compact`);
    const handle = this.handles.get(agentId);
    const fn = handle?.compact;
    const command = handle?.compactCommand;
    if (!fn && !command) {
      throw new CompactionUnsupportedError(
        `chimera does not own context compaction for provider "${r.provider}" (agentId ${agentId}), and that ` +
        `transport exposes no compact command.${r.provider === "codex" ? " Switch this agent to codexTransport: app-server to use native thread/compact/start." : ""}`,
      );
    }
    // COMPACTION-IN-PROGRESS: announce the START, so a UI can show compaction WHILE it happens
    // instead of only learning about it from the completion event. Every existing emitter stays
    // an end event (phase absent ⇒ "end"), so this is additive for all of them.
    this.deps.events.append({
      agentId, kind: "compaction",
      data: { phase: "start", trigger: "manual", owner: handle?.compactOwner ?? (fn ? "chimera" : "sdk") },
    });
    try {
      if (fn) return await fn();
      // The provider's loop reports completion itself (claude.ts's compact_boundary handler,
      // trigger:"manual"). Deliberately does NOT claim a result it cannot observe.
      // VERBATIM, via the slash channel (PARITY WS-B). Sent as an ordinary message it arrives as
      // "[from caller] /compact" — the attribution prefix masks the leading "/" and the backend
      // never sees a command at all. Measured on a live agent doing exactly that: the model read
      // it as prose and replied with a status summary, the context did not drop, and this call
      // still reported ok. That is the failure mode this codebase keeps finding — an operation
      // that reports success while doing nothing — introduced here by a defaulted argument.
      await this.send(agentId, command!, "caller", undefined, true);
      // `ok` means the REQUEST was delivered, never that compaction happened: only the provider
      // can do that, and it says so with its own compaction event. The wording has to carry that
      // distinction, because the operator reads this string and nothing else.
      return { ok: true, via: "provider-command", command, message: `asked ${r.provider} to compact (sent "${command}") — watch for the compaction mark; it is the provider's to run, not chimera's` };
    } catch (e) {
      // Never leave a UI pinned on "compacting" because the trigger itself failed.
      this.deps.events.append({ agentId, kind: "compaction", data: { phase: "aborted", trigger: "manual", error: String((e as Error).message) } });
      throw e;
    }
  }

  // REMOTE-CONTROL-CAPABILITY: turns the provider's opaque rejection (e.g. "disabled by
  // your organization's policy") into an actionable one — names the agent's account and
  // its credential type, states that THAT credential type is what's refused (not the
  // org), and lists which configured accounts ARE subscription-authed so the operator
  // knows the fix is "spawn on one of those". Never swallows the original message. Falls
  // back to the bare original error when the account can't be resolved (e.g. handles
  // entry outlived the record) so this enrichment can never mask a real error as a crash.
  private explainRemoteControlDenial(agentId: string, err: Error): Error {
    const accountName = this.agents.get(agentId)?.accountName;
    if (!accountName) return err;
    const accounts = this.deps.registry.list();
    const account = accounts.find((a) => a.name === accountName);
    if (!account) return err;
    const credLabel = account.credentialType ? `${account.authType}/${account.credentialType}` : account.authType;
    const capable = accounts.filter((a) => a.remoteControlCapable).map((a) => a.name);
    const capableMsg = capable.length > 0
      ? `accounts capable of remote control (subscription-authed): ${capable.join(", ")}`
      : "no configured account is subscription-authed";
    return new RemoteControlDeniedError(
      `remote control denied for account "${accountName}" (${credLabel}): this credential type is not ` +
      `permitted Remote Control by the provider — it requires a subscription-authed account. ${capableMsg}. ` +
      `Original error: ${err.message}`,
    );
  }

  // Task N-SHADOW: real agents first, then shadow rows. Both carry treeId+depth,
  // so the TUI's treeOrder nests every shadow beneath its parent automatically.
  // Callers that must count/guard REAL agents only (daemon.status counts, per-peer
  // running cap — engine.ts) filter on `!a.shadow`.
  list(): AgentRecord[] { return [...this.agents.values(), ...this.shadowAgents.values()]; }

  /** Rebind a long-lived pool worker to the conductor owning its current task. */
  setOriginConductor(agentId: string, originConductorId: string | null): void {
    const record = this.status(agentId);
    record.originConductorId = originConductorId;
    this.generation++;
    this.deps.events.append({ agentId, kind: "status", data: { originConductorId } });
  }

  // FEATURE-4: O(1) "did a new agent/shadow record just appear" probe for SnapshotScheduler —
  // list() is O(N) (spreads both maps into a fresh array on every call), too expensive to call
  // on every single event just to detect growth. A monotonic insertion counter rather than
  // `agents.size + shadowAgents.size`: size is NON-monotonic (a failed launch's `agents.delete`
  // above can shrink it), so a same-size refill after a delete would read as "no growth" under
  // a size comparison. `generation` only ever increases, so it can't be defeated that way.
  spawnGeneration(): number { return this.generation; }

  // MEMORY-BOUNDED-DISK-COMPLETE: archives (see AgentArchiveStore) the full form of every
  // terminal (done/failed/killed), non-shadow record beyond the most-recent
  // MAX_TERMINAL_AGENTS_PERSISTED (by agentRecency), then replaces its `this.agents` entry with
  // a lightened shell (lightenAgentRecord) — freeing spec.prompt/instructions/content and
  // resultText/structuredResult from memory while leaving every identity/status field intact.
  // A no-op when deps.agentArchive is absent (every pre-existing test/deployment). Idempotent:
  // an already-archived record (a.archived === true) is skipped, and a record rehydrated back to
  // full by status() naturally re-qualifies on the next call if it's still old — same self-
  // correcting cadence archive writes already tolerate (write() overwrites with identical bytes).
  private archiveColdTerminalAgents(): void {
    const archive = this.deps.agentArchive;
    if (!archive) return;
    const candidates = [...this.agents.values()].filter(
      (a) => a.shadow !== true && this.isTerminal(a.state) && a.archived !== true,
    );
    if (candidates.length <= MAX_TERMINAL_AGENTS_PERSISTED) return;
    candidates.sort((x, y) => agentRecency(y) - agentRecency(x));
    for (const a of candidates.slice(MAX_TERMINAL_AGENTS_PERSISTED)) {
      archive.write(a);
      this.agents.set(a.agentId, lightenAgentRecord(a));
    }
  }

  // status()'s read-through: called ONLY for a record already flagged `archived === true`.
  // Restores the full record from disk and PROMOTES it back into `this.agents` (not a detached
  // copy) — every existing caller that mutates status()'s return value in place (e.g.
  // setOriginConductor) keeps working unchanged, and the record simply re-qualifies for
  // archiveColdTerminalAgents' next sweep if it's still old and untouched. A missing/corrupt
  // archive file (deleted home dir, disk issue) degrades to the light shell already in memory —
  // callers still see accurate identity/status fields, just not the heavy text — rather than
  // throwing.
  private rehydrate(light: AgentRecord): AgentRecord {
    const full = this.deps.agentArchive?.read(light.agentId);
    if (!full) return light;
    this.agents.set(light.agentId, full);
    return full;
  }

  // REATTACH-TERMINAL-RECORDS: the state.json persistence view. Same rows as list(), but first
  // runs archiveColdTerminalAgents so any terminal record beyond the hot cap is durably
  // archived and lightened BEFORE this snapshot is taken — state.json ends up holding every
  // agent ever (live/hot-terminal rows in full, cold-terminal rows as light shells), never
  // truncated. This is a durability improvement over the old cap-then-truncate behavior (which
  // silently dropped terminal records past MAX_TERMINAL_AGENTS_PERSISTED from disk too): nothing
  // is lost, only the heavy text moves to AgentArchiveStore.
  snapshotAgents(): AgentRecord[] {
    this.archiveColdTerminalAgents();
    return this.list();
  }

  // Phase 5 trust-boundary accessor (spec §6): scrub a peer-facing string against
  // THIS supervisor's injected credentials, mirroring the redaction already applied
  // to appended events (onEvent's scrub()) and to deliverTo forwards (afterResult).
  // Exists so Engine.handlePeer can redact resultText on agent.status/agent.result/
  // agent.spawn responses without reaching into `secrets` directly (private).
  redactForPeer(text: string): string { return redact(text, this.secrets); }

  // F34: the agent's project binding, for memory scoping. Total and cheap by design — unlike
  // status() this never throws and never rehydrates an archived record; an unknown id is simply
  // "no project", i.e. global. A memory write must not fail or pay a disk read on account of
  // scoping.
  projectIdOf(agentId: string): string | null {
    return this.agents.get(agentId)?.projectId ?? null;
  }

  /** QA of F15/F22: the ONE derivation of "who is writing, and what does a relative path mean to
   *  them" — the caller identity the write gate evaluates plus the cwd its targets resolve
   *  against. The permission gate (decidePermission) and the read-only worktree.explainWrite RPC
   *  both call THIS, because a dry-run that re-derived the pair itself would answer about a
   *  caller the gate never evaluates. Throws UnknownAgentError for an unknown id. */
  worktreeWriteContext(agent: string | AgentRecord): { caller: WorktreeWriteCaller; execCwd: string } {
    const record = typeof agent === "string" ? this.status(agent) : agent;
    // The caller is a KEY *plus* the directory that key names in THIS checkout: `.chimera/
    // worktrees/<key>` exists once per main checkout, so a key alone cannot prove ownership
    // (QA of F22). realishPath + the same worktreePath() spelling launch()'s acquire uses, so
    // the two sides of the dir proof are byte-identical. null for a non-worktree agent: it has
    // no worktree of its own, so EVERY worktree it writes into is someone else's.
    const caller = record.spec.isolation === "worktree"
      ? {
        key: record.spec.workdirKey ?? record.agentId,
        dir: realishPath(worktreePath({ cwd: record.spec.cwd, agentId: record.agentId, workdirKey: record.spec.workdirKey })),
      }
      : null;
    return { caller, execCwd: resolveWorkdirPath({ ...record.spec, agentId: record.agentId }) };
  }

  status(agentId: string): AgentRecord {
    // Task N-SHADOW: resolve shadow ids too, so status/result/kill on a SELECTED
    // shadow row (e.g. TUI Ctrl-R) returns the synthetic record instead of
    // throwing UnknownAgentError. A shadow has no live handle, so result() reads
    // its empty text / 0 cost and kill() is a no-op on the handle (see kill()).
    const r = this.agents.get(agentId) ?? this.shadowAgents.get(agentId);
    if (!r) throw new UnknownAgentError(`unknown agent ${agentId}`);
    // MEMORY-BOUNDED-DISK-COMPLETE: transparent read-through — every caller of status()
    // (agent.status, agent.result via result() below, agent.resume, retry/setModel/setEffort
    // respawn paths) gets the FULL record whether or not it's currently hot in memory.
    if (r.archived === true) return this.rehydrate(r);
    return r;
  }

  result(agentId: string): { state: AgentState; text?: string; costUsd: number; structuredResult?: unknown } {
    const r = this.status(agentId);
    return {
      state: r.state, text: r.resultText, costUsd: r.costUsd,
      // W2-1 STRUCTURED-RETURNS: present only when the spawn set resultSchema.
      ...(r.structuredResult !== undefined ? { structuredResult: r.structuredResult } : {}),
    };
  }

  // A session-limit HOLD ("paused") is NON-terminal — the agent auto-resumes at its reset — so
  // waitFor must keep waiting through it, NOT resolve as if the agent finished. Resolving on
  // "paused" would hand a conductor an empty-result "paused" record it mistakes for completion,
  // then the child's real result (produced ~an hour later on resume) would have no waiter.
  private isTerminal(s: AgentState): boolean { return s === "done" || s === "failed" || s === "killed"; }

  // F22: the liveness + label seams WorktreeLeaseStore is constructed with. Public because the
  // store is built in engine.ts BEFORE the supervisor exists (it is one of the supervisor's own
  // deps), so engine passes lazy closures back into these. An UNKNOWN agentId is NOT live —
  // matching the store's documented contract: a pruned owner leaves a retained lease, never an
  // active one.
  isLive(agentId: string): boolean {
    const record = this.agents.get(agentId);
    return record !== undefined && !this.isTerminal(record.state);
  }

  displayLabelOf(agentId: string): string | null {
    return this.agents.get(agentId)?.displayLabel ?? null;
  }

  async waitFor(agentId: string, timeoutMs: number): Promise<AgentRecord> {
    const r = this.status(agentId);
    if (this.isTerminal(r.state)) return r;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsub(); reject(new Error(`waitFor timed out after ${timeoutMs}ms`)); }, timeoutMs);
      const check = () => {
        if (this.isTerminal(this.status(agentId).state)) {
          clearTimeout(timer); unsub(); resolve(this.status(agentId));
        }
      };
      const unsub = this.deps.events.subscribe((e) => {
        if (e.agentId === agentId) queueMicrotask(check);   // defer past the synchronous dispatch (belt-and-braces)
      });
      queueMicrotask(check);                                 // close the subscribe-vs-finish gap
    });
  }

  // WORKER-TEAM-CONTEXT: a team worker's roster (scheduler.ts rosterFor) deliberately shows
  // only an 8-char agentId prefix in its spawn instructions ("short id prefixes for
  // readability, per the design") — so agent_send must accept that same short form directly,
  // or every worker that addresses a teammate exactly as it was told the teammate's id is gets
  // "unknown agent". Exact match always wins outright (no behavior change for the common case,
  // and no risk of a full id accidentally prefix-matching something else); a short form
  // resolves only when it names exactly one live-or-shadow agent. Zero or >1 matches fall
  // through unresolved so the caller sees the ambiguity/absence spelled out by id.
  private resolveAgentId(idOrPrefix: string): string {
    if (this.agents.has(idOrPrefix) || this.shadowAgents.has(idOrPrefix)) return idOrPrefix;
    const matches = [...this.agents.keys(), ...this.shadowAgents.keys()].filter((k) => k.startsWith(idOrPrefix));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1)
      throw new UnknownAgentError(`agent id "${idOrPrefix}" is ambiguous — matches ${matches.join(", ")}; use the full id`);
    return idOrPrefix;
  }

  // images: additive optional param (IMAGE.PASTE) — omitted/empty is normalized
  // away entirely (no `images` key at all) so a plain text send stays byte-identical
  // to before this feature, both in the mailbox JSONL and over handle.send().
  // content: additive (D9) — same normalize-away-when-empty convention as `images`.
  // F09: answers with EVIDENCE instead of {ok:true}. `opts.awaitAckMs` is opt-in (J5) — internal
  // callers (deliverTo results, hook notifies, teammate asks) must not pay a synchronous wait for
  // an answer nobody reads; only the agent.send RPC asks for one.
  hasScheduledMessage(agentId: string, messageId: string): boolean {
    return this.deps.mailboxes.hasMessage(agentId, messageId);
  }

  async sendScheduled(agentId: string, text: string, from: string, messageId: string, maxPendingMessages?: number): Promise<void> {
    if (this.hasScheduledMessage(agentId, messageId)) {
      this.deps.mailboxes.flushDurable();
      return;
    }
    let r = this.status(agentId);
    if (!this.agents.has(agentId)) throw new AgentNotRunningError(`scheduled target ${agentId} is a shadow agent; select a managed agent`);
    if (maxPendingMessages !== undefined && this.deps.mailboxes.pending(agentId).length >= maxPendingMessages) throw new GuardrailError(`scheduled target ${agentId} mailbox is full (${maxPendingMessages} pending messages); prompt was not queued`);
    if (r.state === "paused" && !this.killingRecords.has(r)) {
      await this.resumePaused(agentId, { resumedBy: "scheduled-job", from });
      r = this.status(agentId); // A kill or failed launch may have won while resuming.
    }
    // A different job can enqueue while this one's resume awaits the backend.
    if (maxPendingMessages !== undefined && this.deps.mailboxes.pending(agentId).length >= maxPendingMessages) throw new GuardrailError(`scheduled target ${agentId} mailbox is full (${maxPendingMessages} pending messages); prompt was not queued`);
    if (r.state !== "running" || this.killingRecords.has(r)) throw new AgentNotRunningError(`scheduled target ${agentId} is ${r.state}; no replacement agent will be created`);
    await this.send(agentId, text, from, undefined, false, undefined, { messageId });
    this.deps.mailboxes.flushDurable();
  }

  private readonly commandOperations = new Map<string, Promise<AgentSendResult>>();

  private async codexCommand(agentId: string, text: string, from: string): Promise<AgentSendResult> {
    const command = parseCodexCommand(text);
    const r = this.status(agentId);
    if (r.state !== "running") throw new AgentNotRunningError(`Agent is ${r.state}; resume it before using a native command`);
    if (command.name === "compact" || command.action === "set" && command.status === "active") {
      let budgetId: string | null = r.budgetNodeId ?? r.treeId;
      while (budgetId) {
        if (this.pausedTrees.has(budgetId)) throw new BudgetDeniedError(`budget node "${budgetId}" is exhausted; cannot start native work`);
        budgetId = this.treeBudgets.get(budgetId)?.parentNodeId ?? null;
      }
    }
    if (this.providerTransfers.has(agentId) || this.nativeVoiceChanges.has(agentId)) throw new GuardrailError("An agent connection change is in progress");
    let handle = this.handles.get(agentId);
    if (!handle?.command || !(r.spec.persistent || r.spec.conductor)) {
      if (r.spec.providerOptions.codexTransport === "exec") throw new GuardrailError("This agent explicitly pins codexTransport: exec. Native /goal and /compact require codexTransport: app-server.");
      if (handle?.isTurnActive?.() || this.promptAck.isMidTurn(agentId) || this.deps.mailboxes.pending(agentId).length || this.inFlight.get(agentId)?.length) throw new GuardrailError("Wait for the current turn and queued messages to finish before switching this Codex agent to native commands");
      if (!r.sessionId) throw new GuardrailError("Wait for the Codex agent to establish its session before using native commands");
      // Reattach the same session/account/workspace, preserving permissions and
      // schedules. Exec has no slash-command parser or persistent goal controls.
      this.nativeVoiceChanges.add(agentId);
      try {
        if (!await this.hold(agentId) || this.agents.get(agentId) !== r) throw new GuardrailError("Agent changed while enabling native commands; retry");
        r.spec = { ...r.spec, persistent: true, providerOptions: { ...r.spec.providerOptions, codexTransport: "app-server" } };
        await this.resumePaused(agentId);
      } finally { this.nativeVoiceChanges.delete(agentId); }
      handle = this.handles.get(agentId);
    }
    if (!handle?.command) throw new GuardrailError("This Codex backend does not expose native commands");
    const output = command.name === "compact" ? (await this.compact(agentId)).message : await handle.command(text);
    this.deps.events.append({ agentId, kind: "status", data: this.scrub({ delivered: true, from, text, slash: true, nativeCommand: true }) });
    this.deps.events.append({ agentId, kind: "message_complete", data: this.scrub({ text: output, role: "system", localCommand: true }) });
    return { ok: true, delivered: true, turnStarted: false, ack: "command", ackMs: null, deliveryId: randomUUID(), stallThresholdMs: this.promptStallMs };
  }

  async send(agentId: string, text: string, from = "caller", images?: Image[], slash = false, content?: ContentBlock[], opts?: { awaitAckMs?: number; messageId?: string; force?: boolean; author?: Principal; engineId?: string; taskId?: string }): Promise<AgentSendResult> {
    if (slash && (images?.length || content?.length)) throw new GuardrailError("Send native commands without attachments");
    const author = opts?.author ?? this.principalFor(from, opts?.engineId);
    from = author.from;
    const message = createMessage(text, author, { id: opts?.messageId, content, images, ...(opts?.taskId ? { context: { taskId: opts.taskId } } : {}) });
    agentId = this.resolveAgentId(agentId);
    let r: AgentRecord;
    try {
      r = this.status(agentId);
    } catch (err) {
      if (err instanceof UnknownAgentError)
        throw new UnknownAgentError(`unknown agent ${agentId} — call my_team or team_list for the live roster's full agent ids`);
      throw err;
    }
    const inputBackend = this.deps.backends.get(r.spec.runtime === "terminal" ? "terminal" : r.provider);
    inputBackend?.validateInput?.(message.content);
    if (slash && r.spec.runtime !== "terminal") {
      if (r.provider === "codex") {
        if (images?.length || content?.length) throw new GuardrailError("Send Codex native commands without attachments");
        const previous = this.commandOperations.get(agentId) ?? Promise.resolve();
        const operation = previous.catch(() => {}).then(() => this.codexCommand(agentId, text, from));
        this.commandOperations.set(agentId, operation);
        try { return await operation; }
        finally {
          if (this.commandOperations.get(agentId) === operation) this.commandOperations.delete(agentId);
          this.deps.events.append({ agentId, kind: "status", data: { commandComplete: true, turnActive: this.handles.get(agentId)?.isTurnActive?.() ?? this.promptAck.isMidTurn(agentId) } });
        }
      }
      try {
        if (this.providerTransfers.has(agentId)) throw new GuardrailError("Wait for the provider transfer before sending a slash command");
        if (!this.handles.has(agentId)) throw new AgentNotRunningError(`Agent is ${r.state}; resume it before using a native command`);
        await this.handles.get(agentId)?.validateSlash?.(text);
      }
      catch (error) {
        this.deps.events.append({ agentId, kind: "status", data: { commandComplete: true, turnActive: this.promptAck.isMidTurn(agentId) } });
        throw error;
      }
    }
    // LAZY-REATTACH: "the first real message revives it". A restart-dormant agent holds its
    // session but no process; delivering to it launches that session first, then proceeds
    // normally — from the caller's side this is just a slightly slower send.
    //
    // Scoped to "daemon-restart" ON PURPOSE: the other holds must NOT be bypassable by sending
    // a message. A session-limit hold is a provider quota with its own reset clock, and a
    // crash-loop backoff is a circuit breaker — reviving either on demand would defeat exactly
    // the thing it exists to enforce.
    if (isRevivableHold(r) && !this.providerTransfers.has(agentId)) {
      await this.resumePaused(agentId, { resumedBy: "mailbox", from });
      r = this.status(agentId);
    }
    // OPERATOR-HOLD: a hold means "stop working", not "stop existing" — so a message to a held
    // agent is ACCEPTED into its mailbox and simply not delivered yet. Refusing it here would
    // make a hold lossy in exactly the case it is most useful: hold a fleet mid-run, and every
    // deliverTo result, teammate ask and hook notify aimed at a held agent would error instead of
    // waiting. Release drains the mailbox in order, so the agent resumes with everything it
    // missed, oldest first.
    //
    // Deliberately NOT extended to the other non-revivable holds: a session-limit or crash-loop
    // pause refuses on purpose (see isRevivableHold's comment) and changing that is a separate
    // decision about circuit breakers, not part of what a hold means.
    if (r.state === "paused" && r.pauseReason === "operator-hold") {
      const held = this.deps.mailboxes.enqueue(agentId, {
        from, kind: "user_message", text, message, engineId: author.engineId,
        ...(images && images.length > 0 ? { images } : {}),
        ...(content && content.length > 0 ? { content } : {}),
        ...(slash ? { slash: true } : {}),
        ...(opts?.force ? { force: true } : {}),
      });
      return { ok: true, delivered: false, turnStarted: false, ack: "held", ackMs: null, deliveryId: held.id, stallThresholdMs: this.promptStallMs };
    }
    if (r.state !== "running" && !this.providerTransfers.has(agentId))
      throw new AgentNotRunningError(`agent ${agentId} is ${r.state}; cannot deliver messages`);
    // FEATURE-5: pre-flight for the NEXT TURN — closes the gap spawn()'s admission check
    // alone leaves open: a persistent/conductor agent admitted before its subtree
    // exhausted could otherwise keep taking turns forever after a breach (spawn() only
    // runs once, at creation). Climbs the SAME budgetNodeId/treeId → parentNodeId chain
    // trackCost books into; a no-op (one cheap iteration, no throw) when nothing budget-
    // related is configured anywhere in the chain — byte-identical to before then.
    let budgetNodeId: string | null = r.budgetNodeId ?? r.treeId;
    while (budgetNodeId) {
      if (this.pausedTrees.has(budgetNodeId))
        throw new BudgetDeniedError(`budget node "${budgetNodeId}" is exhausted; cannot dispatch a new turn to ${agentId}`);
      budgetNodeId = this.treeBudgets.get(budgetNodeId)?.parentNodeId ?? null;
    }
    // PARITY WS-B: `slash` rides the SAME enqueue as `images`/`content` so it stays
    // FIFO-ordered in the mailbox (no side-channel that could race the queue); omitted when false.
    const enqueued = this.deps.mailboxes.enqueue(agentId, {
      ...(opts?.messageId ? { id: opts.messageId } : {}),
      from, kind: "user_message", text, message, engineId: author.engineId,
      ...(images && images.length > 0 ? { images } : {}),
      ...(content && content.length > 0 ? { content } : {}),
      ...(slash ? { slash: true } : {}),
      ...(opts?.force ? { force: true } : {}),
    });
    if (this.providerTransfers.has(agentId)) return { ok: true, delivered: false, turnStarted: false, ack: "pending", ackMs: null, deliveryId: enqueued.id, stallThresholdMs: this.promptStallMs };
    this.deliverPending(agentId);
    if (r.provider === "codex"
      && (this.handles.get(agentId)?.isTurnActive?.() ?? this.promptAck.isMidTurn(agentId))
      && this.deps.mailboxes.pending(agentId).some(m => m.id === enqueued.id)) {
      // Accepted into a busy Codex mailbox, not yet handed to its backend. No idle-start
      // timeout runs while the preceding turn is still legitimately working.
      return { ok: true, delivered: false, turnStarted: false, ack: "mid_turn", ackMs: null, deliveryId: enqueued.id, stallThresholdMs: this.promptStallMs };
    }
    // The waiter is registered SYNCHRONOUSLY here, before deliverPending's chained delivery can
    // run, so no ack can be missed. Waiting is opt-in; without it the honest answer is "pending".
    const outcome = opts?.awaitAckMs
      ? await this.promptAck.await(enqueued.id, opts.awaitAckMs)
      : { ack: "pending" as const, ackMs: null };
    return {
      ok: true, delivered: true, turnStarted: outcome.ack === "started",
      ack: outcome.ack, ackMs: outcome.ackMs,
      deliveryId: enqueued.id, stallThresholdMs: this.promptStallMs,
    };
  }

  // RESTART-RESUME: graceful-shutdown suspension. Terminates every running
  // agent's PROCESS (a backend handle.kill() is event-silent — claude.ts's
  // `killed` flag suppresses the result/error emit, so no terminal transition
  // fires) while leaving the RECORDS untouched: still "running", sessionId
  // intact. The daemon's post-suspend snapshot therefore persists a RESUMABLE
  // set, and the next boot's reattach brings each agent back into its prior
  // session. This is the deliberate contrast with kill(): kill() is the user
  // saying "this agent is over" (state -> killed, never resumed); shutdown is
  // "the daemon is going away" — agents should survive it. Pending session-
  // limit auto-resume timers are cleared (the process is going away; boot's
  // reattachPaused re-arms them from the persisted record).
  async suspendForShutdown(): Promise<void> {
    for (const transfer of this.providerTransfers.values()) transfer.controller.abort();
    for (const [agentId, handle] of this.handles) {
      if (this.agents.get(agentId)?.state !== "running") continue;
      await handle.kill().catch(() => {});
    }
    for (const timer of this.resumeTimers.values()) clearTimeout(timer);
    this.resumeTimers.clear();
    this.promptAck.dispose();                                   // F09 (A7): no live timer survives shutdown
  }

  // STALE-WORKTREE-RECORD: shared by kill()/reportUnresponsive() — the two real reap paths.
  // Stamps the record with checkWorktreeUnlanded's result and, when it produced an actual fact
  // (non-null), appends a second small "status" event carrying it, so a daemon-restart replay
  // (replay.ts's "status" case) reconstructs the same field a live run set. No-ops (no event,
  // no field write) when there's nothing to record — isolation:"none" or an already-gone
  // worktree — so those agents' status-event stream is byte-identical to before this existed.
  private stampWorktreeLanding(record: AgentRecord, agentId: string): void {
    const unlanded = checkWorktreeUnlanded({ isolation: record.spec.isolation, cwd: record.spec.cwd, agentId, workdirKey: record.spec.workdirKey });
    if (unlanded === null) return;
    record.worktreeUnlanded = unlanded;
    record.worktreeLandingCheckedAt = this.now();
    this.deps.events.append({
      agentId, kind: "status",
      data: { worktreeUnlanded: unlanded, worktreeLandingCheckedAt: record.worktreeLandingCheckedAt },
    });
  }

  // KILL-REPORTS-TRUTHFULLY: returns whether anything was actually killed. A terminal agent has
  // no process and no timer, so every branch below is a no-op for it — and the RPC used to
  // answer {ok:true} regardless, which reads to an operator as "the command worked" while the
  // row stubbornly stays exactly where it was. Reported live: an already-finished session that
  // could not be dismissed, with the UI cheerfully confirming each attempt.
  async kill(agentId: string): Promise<boolean> {
    const record = this.status(agentId);
    this.killingRecords.add(record);
    try {
      return await this.killAgentProcess(agentId);
    } finally {
      this.killingRecords.delete(record);
    }
  }

  private async killAgentProcess(agentId: string): Promise<boolean> {
    this.providerTransfers.get(agentId)?.controller.abort();
    const r = this.status(agentId);
    const wasLive = r.state === "running" || r.state === "paused";
    await this.handles.get(agentId)?.kill();
    this.handles.delete(agentId);
    // Session-limit HOLD: cancel a pending auto-resume so a killed-while-paused agent never
    // comes back to life. A paused agent has no live handle (holdUntilReset dropped it), so
    // the kill above is a no-op for it — this timer clear is what actually stops the resume.
    const timer = this.resumeTimers.get(agentId);
    if (timer) { clearTimeout(timer); this.resumeTimers.delete(agentId); }
    this.promptAck.forget(agentId);                             // F09 (A7)
    r.promptStall = null;
    if (r.state === "running" || r.state === "paused") {
      r.state = "killed";                                       // commit state BEFORE append (waitFor invariant)
      delete r.pauseReason;
      delete r.resumeAt;
      // LEDGER-UNCLEAN-EXIT: an explicit kill (reap or cancel) never gets a "result" event —
      // flush whatever cost was already accrued instead of losing it to a silent $0.
      this.settleUnrecordedUsage(r);
      // F50.QA-FIX finding 7: killed is terminal — this agent's node can never re-trigger the
      // watermark again. After settleUnrecordedUsage, which is where a re-pause could still fire.
      this.clearBudgetResumeAck(r);
      // publish a terminal event so a waitFor() already pending on this agent
      // observes the transition via its subscription instead of hanging to timeout
      this.deps.events.append({ agentId, kind: "status", data: { state: "killed" } });
      // PLAN-HOOKS.md §4.3 gap fix (a): surface (never silently strand) any mail already
      // sitting in this agent's mailbox — nothing will ever drain it now.
      this.checkPendingOnSettle(r);
      // REAP-SAFETY: a live agent is transitioning to killed RIGHT NOW — snapshot its
      // worktree before the process/worktree is forgotten. See workdir.ts doc comment.
      autoCommitDirtyWorktree({ isolation: r.spec.isolation, cwd: r.spec.cwd, agentId, workdirKey: r.spec.workdirKey }, `agent ${agentId} killed`);
      // STALE-WORKTREE-RECORD: stamp the landing check AFTER the autosave above, so a tree that
      // was just committed is reflected in the branch tip this checks.
      this.stampWorktreeLanding(r, agentId);
    }
    // Task N-SHADOW: killing a parent also evicts its still-running shadow rows to
    // "killed" (a no-op when `agentId` is itself a shadow — a shadow spawns no
    // sub-shadows). Runs regardless of `r.state` so it also cleans up after a
    // parent that already finished before the kill.
    this.terminateShadows(agentId, "killed");
    return wasLive;
  }

  // PARITY WS-H: public esc-to-interrupt. Aborts the agent's IN-FLIGHT turn without
  // killing the agent (unlike kill() above) — the SDK ends the partial turn and the
  // agent stays running, ready for the next send. This reuses the EXACT handle.interrupt()
  // path already driven internally for tree-pause/budget aborts (applyCostToNode/applyLiveEstimate);
  // no new backend code. Throws UnknownAgentError for ghosts via status(); a no-op for a
  // non-running agent (no live handle) or a backend whose interrupt() is a no-op (fake).
  async interrupt(agentId: string): Promise<void> {
    this.status(agentId);                                    // throws UnknownAgentError for ghosts
    await this.handles.get(agentId)?.interrupt();
  }

  // Ad-hoc sessions design §5: a session names itself (its displayLabel) after its first turn.
  // Mirrors the existing displayLabel re-emit shape at launch() (:649/:1036) — no new event kind.
  // ONE-SHOT (REBIND task, decision #2): a no-op once displayLabelPinned is already true — either
  // the operator named this agent explicitly at spawn (never overwrite that), or a prior
  // rename_self call already claimed the one free move (never rename twice, a name that keeps
  // moving is worse than a generic one). Silent no-op, not a thrown error: rename_self is meant
  // to be called speculatively by any default-spawned agent, and a second/redundant call is not
  // a caller mistake worth surfacing as a tool failure.
  // OPERATOR-RENAME: the one-shot above protects the OPERATOR's choice from the agent — either a
  // name set at spawn, or the one free self-rename already spent. Neither reason is about the
  // operator, and applying the pin to them meant a name, once set, could never be corrected: a
  // quick-spawned agent was stuck with whatever it called itself, forever.
  //
  // So the guard is now about WHO is asking. `byOperator` always applies, and still SETS the pin
  // — an agent must not be able to rename its way out of the name a person just gave it, which is
  // the very thing reason one exists for.
  // SECRET-MANAGER: register a value as redactable. Every event produced by an AGENT goes through
  // this supervisor's own sink, which scrubs both `data` and `raw` against this list — so a
  // secret handed to an agent cannot come back into chimera's logs through that agent's output,
  // which is the realistic leak. (Deliberately not a claim about every append in the daemon:
  // EventLog itself does no scrubbing, and an operator-side append is not an agent echoing a
  // value back.) It does NOT stop the agent propagating it elsewhere — nothing can, once the
  // plaintext is in the model — it stops chimera becoming a second copy.
  registerSecret(value: string): void {
    if (value.length > 0 && !this.secrets.includes(value)) this.secrets.push(value);
  }

  async renameAgent(agentId: string, displayLabel: string, opts: { byOperator?: boolean } = {}): Promise<void> {
    const record = this.status(agentId);                      // throws UnknownAgentError for ghosts
    if (record.displayLabelPinned && !opts.byOperator) return;
    record.displayLabel = displayLabel;
    record.displayLabelPinned = true;
    this.deps.events.append({
      agentId, kind: "status",
      data: { state: record.state, displayLabel },
    });
  }

  // AGENT-GROUPS Phase 1: replaces this record's wrapper-box membership wholesale (not a
  // one-shot like renameAgent — an operator can re-file an agent into a different group any
  // number of times). Mirrors renameAgent's shape exactly: throws UnknownAgentError for
  // ghosts via status(), mutates the record, emits a `status` event carrying the new value
  // so every connected client's ui-state projection stays live without a refetch (mirrors
  // jobName/sessionRole's own `status` re-emit, not just agent.list's snapshot path).
  // Deduped, never re-validated against the group registry here — a membership naming a
  // deleted/unknown group retains the app’s raw-ID box fallback until explicitly cleared
  // or reassigned, never rejected at write time.
  async setAgentGroups(agentId: string, groups: string[]): Promise<void> {
    const record = this.status(agentId);
    const deduped = [...new Set(groups)];
    AgentSetGroupsParamsSchema.parse({ agentId, groups: deduped });
    record.groups = deduped;
    this.deps.events.append({
      agentId, kind: "status",
      data: { state: record.state, groups: deduped },
    });
  }

  async changeAgentGroups(agentId: string, groups: string[], operation: "add" | "remove"): Promise<void> {
    AgentSetGroupsParamsSchema.parse({ agentId, groups });
    const current = this.status(agentId).groups ?? [];
    const changes = new Set(groups);
    // No await between reading the record and replacement: concurrent calls cannot lose
    // another caller's membership changes, and the total cap is checked before mutation.
    await this.setAgentGroups(agentId, operation === "add"
      ? [...current, ...groups]
      : current.filter((id) => !changes.has(id)));
  }

  // F47 (fleet seen-state): the single stamp seam. Called from every site that appends an
  // attention-class event. Shadow records are skipped — a native sub-agent is not a fleet row an
  // operator triages; the parent's own events are what surface.
  private noteAttention(agentId: string, kind: string): void {
    if (!ATTENTION_EVENT_KINDS.has(kind)) return;
    const r = this.agents.get(agentId);
    if (!r || r.shadow === true) return;
    r.attentionAt = Date.now();
  }

  // Bulk mark-seen. Validate-all-then-mutate so a page containing one stale id fails loudly
  // instead of half-stamping. The status event is MANDATORY, not cosmetic: SnapshotScheduler only
  // wakes on events, so without it reviewedAt would never reach state.json and every restart would
  // resurrect the badges.
  //
  // F47.FIX M-1: the lookup is a DIRECT map read, deliberately NOT status(). status() is the
  // MEMORY-BOUNDED-DISK read-through (`if (r.archived === true) return this.rehydrate(r)`), so
  // validating through it would, for every archived id in the page, do a synchronous
  // agentArchive.read() AND re-promote the full record into `this.agents` — undoing
  // archiveColdTerminalAgents. Mark-all-seen is exactly the call most likely to name hundreds of
  // old terminal agents (an unread `result` keeps a settled agent unseen forever), so one keystroke
  // could block the event loop on hundreds of file reads and re-inflate the hot map. The light
  // shell is sufficient here: archiveColdTerminalAgents REPLACES the map entry rather than deleting
  // it, so `agents` + `shadowAgents` remains a complete existence check, and lightenAgentRecord
  // spreads `...a`, so a reviewedAt stamped on a shell survives the next archive sweep (test A8).
  //
  // F47.FIX M-2: `skipUnknown` (the fleet-wide sweep only) stamps every known id and returns the
  // rest instead of throwing — see AgentMarkSeenParamsSchema.
  markSeen(agentIds: string[], opts: { skipUnknown?: boolean } = {}): { marked: number; unknownIds: string[] } {
    const records: AgentRecord[] = [];
    const unknownIds: string[] = [];
    for (const id of agentIds) {
      const r = this.agents.get(id) ?? this.shadowAgents.get(id);
      if (!r) {
        if (opts.skipUnknown !== true) throw new UnknownAgentError(`unknown agent ${id}`);
        unknownIds.push(id);
        continue;
      }
      records.push(r);
    }
    const at = Date.now();
    for (const record of records) {
      record.reviewedAt = at;
      this.deps.events.append({
        agentId: record.agentId, kind: "status",
        data: { state: record.state, reviewedAt: at },
      });
    }
    return { marked: records.length, unknownIds };
  }

  // Phase 3: gracefully end a conductor session's input stream. Throws
  // UnknownAgentError for ghosts (via status()); a no-op for handles without
  // an optional close() (e.g. FakeAgentBackend) — the agent keeps running
  // and finishes normally through its own event stream.
  async closeInput(agentId: string): Promise<void> {
    const r = this.status(agentId);                          // throws UnknownAgentError for ghosts
    // Session-limit HOLD: a paused agent has no live handle to close, but it DOES have an armed
    // auto-resume timer. Closing its input means we no longer want it (e.g. team dissolution's
    // retire()), so cancel the pending resume and end it terminally — otherwise the timer would
    // fire and resurrect a running agent no caller tracks anymore (a leaked, never-settling agent).
    if (r.state === "paused") {
      const timer = this.resumeTimers.get(agentId);
      if (timer) { clearTimeout(timer); this.resumeTimers.delete(agentId); }
      r.state = "killed";                                    // commit BEFORE append (waitFor invariant)
      this.settleUnrecordedUsage(r);   // LEDGER-UNCLEAN-EXIT
      this.clearBudgetResumeAck(r);    // F50.QA-FIX finding 7
      this.deps.events.append({ agentId, kind: "status", data: { state: "killed" } });
      return;
    }
    await this.handles.get(agentId)?.close?.();
  }

  // ANSWERED-PROMPT-STAYS-PENDING: resolving the promise is NOT enough. A client only ever
  // cleared its own banner because IT dispatched a local "questionAnswered"/permission action
  // after calling this — so a prompt answered by anyone ELSE (another agent via the chimera MCP
  // ask/answer tools, the other client, or the same client after a reload) left every other
  // surface showing a stale ? / pending banner until the agent hit a terminal state. Observed on
  // a live agent whose question was answered by its conductor: the event log held exactly one
  // agent_question and NO resolution event of any kind.
  //
  // The *Resolved status events already existed and every reducer already folds them — they were
  // just emitted ONLY from the timeout fallbacks (`timedOut: true`). Emitting them here too makes
  // every client converge on the daemon's truth regardless of who answered. Omitting `timedOut`
  // is what distinguishes a real answer from the fallback.
  /** Operator projection exposes resolver ownership, never provider handles. */
  operatorAttention(): Array<{ id: string; agentId: string; kind: "permission" | "question" }> {
    return [
      ...[...this.pendingPermissions].map(([id, p]) => ({ id, agentId: p.agentId, kind: "permission" as const })),
      ...[...this.pendingQuestions].map(([id, p]) => ({ id, agentId: p.agentId, kind: "question" as const })),
    ];
  }

  respondPermission(requestId: string, allow: boolean): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    pending.resolve(allow);
    this.deps.events.append({
      agentId: pending.agentId, kind: "status",
      data: { permissionResolved: true, requestId, allow },
    });
    return true;
  }

  // TRUST-TIER: the mcp store's own entry point into the SAME pendingPermissions/
  // permission_request machinery decidePermission() uses for Bash/foreign-MCP — deliberately a
  // standalone method rather than a call into decidePermission() itself, since this gate fires
  // from engine.ts's "mcpstore.call" RPC handler (a write-capable tool on an untrusted mcp
  // store server, see broker.decideMcpStoreCall), which is NOT a backend tool-use decision and
  // has none of decidePermission's Bash/worktree/toolPolicy machinery to reuse. Reusing the
  // SAME event kind (permission_request) + resolver map + respondPermission() answer path means
  // the TUI/app permission card renders and answers this with ZERO new UI code.
  //
  // FAIL CLOSED: status() throws UnknownAgentError for a ghost/unknown agentId — the caller
  // (engine.ts) must treat any throw from this method as a denial, never fall open. Unlike
  // decidePermission's Bash/foreign-MCP timeout (which falls back to the profile's autoDecision),
  // a timeout HERE resolves false — an untrusted server's write-capable call must never proceed
  // on silence; there is no "safe default profile" to fall back to for this class of gate.
  async requestMcpStoreApproval(agentId: string, detail: { server: string; tool: string; reason: string }): Promise<boolean> {
    this.status(agentId);                                  // throws UnknownAgentError for ghosts
    const requestId = randomUUID();
    const decision = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        this.deps.events.append({
          agentId, kind: "status",
          data: { permissionResolved: true, requestId, allow: false, timedOut: true },
        });
        resolve(false);
      }, this.deps.permissionTimeoutMs ?? 120_000);
      this.pendingPermissions.set(requestId, { agentId, resolve: (allow) => {
        clearTimeout(timer);
        this.pendingPermissions.delete(requestId);
        resolve(allow);
      } });
    });
    this.deps.events.append({
      agentId, kind: "permission_request",
      data: this.scrub({
        requestId, toolName: `mcp_store:${detail.server}__${detail.tool}`,
        input: { server: detail.server, tool: detail.tool, reason: detail.reason },
        mcpStoreTrust: true as const,
      }),
    });
    this.noteAttention(agentId, "permission_request");
    return decision;
  }

  // spec §17: emit an agent_question event and BLOCK until answerQuestion() or
  // timeout. Mirrors decidePermission()'s register-before-emit + timeout fallback
  // (EventLog notifies subscribers SYNCHRONOUSLY, so a tui/poke answerer can call
  // answerQuestion from inside the subscribe callback — the pending entry must
  // already exist when agent_question fires). On timeout the question resolves
  // with its `default` (or {} — an empty answer) so a stuck ask never hangs forever.
  // NOTE: this registry-side wait is unbounded up to questionTimeoutMs/timeoutMs —
  // it does NOT itself guarantee the end-to-end agent→chimera-MCP tools/call hop
  // stays open that long: the SDK MCP client applies its own request timeout
  // (~60s default, UNVERIFIED — spec §17.4 spike is still open) on that hop.
  async ask(agentId: string, q: AskInput): Promise<{ questionId: string; answer: QuestionAnswer }> {
    this.status(agentId);                                  // throws UnknownAgentError for ghosts
    const record = this.agents.get(agentId)!;

    // ASK-UNREACHABLE-TARGET-LEAK: validate the target BEFORE registering the
    // questionId / emitting agent_question below — checking only at delivery time
    // (inside send(), further down) let an undeliverable inter-agent ask still
    // broadcast a question-card event that nothing would ever answer, which fell
    // to the human as an orphaned QuestionCard. Same liveness rule send() applies.
    //
    // PAUSED-CONDUCTOR: a target held only because nothing needed it (daemon-restart /
    // idle-timeout) is NOT unreachable — send() below revives it exactly as a plain message does.
    // Refusing it here was the asymmetry the operator hit: agent_send woke a dormant conductor
    // while ask_agent bounced off it, so workers spawned after a restart could not reach their
    // own conductor. A non-revivable hold still refuses, but now names the reason.
    if (q.to) {
      let target = this.status(q.to.agentId);   // throws UnknownAgentError for ghosts
      // ASK-REVIVES-DORMANT: the SAME revive step send() below performs, hoisted ahead of this
      // liveness check — otherwise the check refuses an idle-reaped / restart-dormant target that
      // send() would have woken, and a child asking its parked conductor for a decision fails
      // hard ("is paused; cannot deliver messages") exactly when the conductor is most needed.
      // The via tag is "mailbox"/"ask" because the wake IS a delivery — same shape send() emits.
      if (isRevivableHold(target)) {
        await this.resumePaused(q.to.agentId, { resumedBy: "mailbox", from: "ask" });
        target = this.status(q.to.agentId);
      }
      if (target.state === "paused") {
        const reason = target.pauseReason ?? "unknown";
        // Only operator-hold has an operator-facing release: a session-limit hold clears on the
        // provider's own reset clock and a crash-loop backoff is a circuit breaker.
        const hint = reason === "operator-hold" ? "; release it with agent_release" : "";
        throw new AgentNotRunningError(`agent ${q.to.agentId} is paused (${reason})${hint}; cannot deliver messages`);
      }
      if (target.state !== "running")
        throw new AgentNotRunningError(`agent ${q.to.agentId} is ${target.state}; cannot deliver messages`);
    }

    const questionId = randomUUID();
    const def = q.default ?? null;
    const toAnswer = (d: QuestionDefault | null): QuestionAnswer =>
      d ? { ...(d.optionIds ? { optionIds: d.optionIds } : {}), ...(d.text !== undefined ? { text: d.text } : {}) } : {};

    // Task D1: hoisted so a failed peer-delivery (send() below throwing) can
    // clean up the resolver + timer before rethrowing — otherwise a bad-target
    // ask() would leak an orphaned pendingQuestions entry (and its live timer)
    // until questionTimeoutMs elapses.
    let cleanup = () => {};
    const decision = new Promise<QuestionAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingQuestions.delete(questionId);
        // FEATURE-9 (attention inbox): mirrors decidePermission()'s timeout-fallback
        // status{permissionResolved} event — without it, a client whose pendingQuestion
        // banner for this questionId is still showing (e.g. an approval gate that timed
        // out fail-closed with nobody answering) would strand that banner forever, since
        // there's no other signal that the daemon already resolved it.
        this.deps.events.append({
          agentId, kind: "status",
          data: { questionResolved: true, questionId, timedOut: true },
        });
        resolve(toAnswer(def));
      }, q.timeoutMs ?? this.deps.questionTimeoutMs ?? 300_000);
      cleanup = () => { clearTimeout(timer); this.pendingQuestions.delete(questionId); };
      this.pendingQuestions.set(questionId, { agentId, resolve: (answer) => {
        cleanup();
        resolve(answer);
      } });
    });

    this.deps.events.append({
      agentId, kind: "agent_question",
      // scrub for §6 consistency with permission_request: a prompt/option/header
      // can echo an injected credential. Deep-redaction handles nested option text.
      data: this.scrub({
        questionId,
        prompt: q.prompt,
        ...(q.header !== undefined ? { header: q.header } : {}),
        ...(q.options !== undefined ? { options: q.options } : {}),
        multiSelect: q.multiSelect ?? false,
        freeform: q.freeform ?? (q.options === undefined),
        default: def,
        timeoutMs: q.timeoutMs ?? null,
        policy: record.spec.on.permissionRequest,          // same routing vocabulary as permission_request
        group: null,
        ...(q.to ? { to: q.to.agentId, replyTo: agentId } : {}),
        ...(q.gate ? { gate: q.gate } : {}),
      }),
    });
    this.noteAttention(agentId, "agent_question");

    // Task D1: deliver the question into the target's mailbox so it is
    // prompted to answer. Done AFTER registering the resolver + emitting the
    // event (above) so the resolver already exists before the target could
    // possibly call answerQuestion. send() throws UnknownAgentError/
    // AgentNotRunningError for a bad target — let it propagate (asking a
    // dead/unknown agent is an error); the answer still routes back through
    // the EXISTING questionId registry, not a second channel.
    if (q.to) {
      try {
        await this.send(
          q.to.agentId,
          `[question ${questionId} from ${agentId}] ${q.prompt}\nAnswer it by calling answer_question with questionId "${questionId}".`,
          "ask",
        );
      } catch (err) {
        cleanup();          // undelivered — don't leak the resolver/timer for the full timeout
        throw err;
      }
    }

    return { questionId, answer: await decision };
  }

  /** See respondPermission's ANSWERED-PROMPT-STAYS-PENDING note — same contract. */
  answerQuestion(questionId: string, answer: QuestionAnswer): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return false;
    pending.resolve(answer);
    // The answer's CONTENT is deliberately not in the event: it can carry whatever the operator
    // typed, and this rides the general event log every client tails. Clients only need to know
    // the question is settled — the agent itself already received the answer through the promise.
    this.deps.events.append({
      agentId: pending.agentId, kind: "status",
      data: { questionResolved: true, questionId },
    });
    return true;
  }

  // native-CLI-parity Phase 2 (Task DLG1): unblocks decideDialog()'s pending promise for
  // dialogId — mirrors answerQuestion()/respondPermission() exactly.
  /** See respondPermission's ANSWERED-PROMPT-STAYS-PENDING note — same contract. */
  answerDialog(dialogId: string, decision: DialogDecision): boolean {
    const pending = this.pendingDialogs.get(dialogId);
    if (!pending) return false;
    pending.resolve(decision);
    this.deps.events.append({
      agentId: pending.agentId, kind: "status",
      data: { dialogResolved: true, dialogId },
    });
    return true;
  }

  // LEDGER-UNCLEAN-EXIT: called at every non-"done" terminal transition (kill(), onError's
  // fail-loud fallback, the crash-loop circuit breaker, a rerouted-launch/resume failure) —
  // the ways a record settles WITHOUT ever emitting a "result" event, so usage.ts's ledger
  // (which only listens for "result") would otherwise silently record nothing for spend that
  // genuinely happened. Emits a ledger-only "usage_settle" event carrying the last cost/usage
  // figures a "turn_complete" reported (see the onEvent turn_complete branch above) — a no-op
  // when nothing was ever accrued (a record killed before its first completed turn genuinely
  // cost $0, not a bug) or the record already reached "done" (its real cost is already booked
  // via the normal "result" path; never double-book the same spend from both).
  //
  // BUDGET-UNCLEAN-EXIT-BLIND: this used to only feed usage.ts's billing ledger, never the
  // FEATURE-5 budget governor (trackCost/treeBudgets) — mirroring the "result" branch's own
  // `record.costUsd += costUsd; trackCost(record, costUsd)` pair fixes a real gap: a tree that
  // crash-loops (each attempt racking up real turn cost before dying) or gets killed mid-turn
  // spent real, billed dollars that never counted against its maxBudgetUsd ceiling, so a
  // crash-looping tree could burn arbitrarily past its budget without ever tripping the pause.
  // Safe to book directly (no delta bookkeeping needed): lastTurnCostUsd is the CUMULATIVE
  // total for the current attempt's session (claude.ts/codex.ts emit total_cost_usd, which
  // resets to 0 each fresh process) — exactly the same shape "result"'s costUsd already is.
  private settleUnrecordedUsage(record: AgentRecord): void {
    if (record.state === "done") return;
    // F50 BUDGET-COVERAGE: an unclean exit whose only trace is a token count is exactly the
    // case the flat $0 hid — derive it here too, reusing the turn_complete seam's verdict about
    // whether the reported figure was itself table-derived.
    const metered = meterTurnCost(
      record.lastTurnCostUsd, record.lastTurnBillableUsage,
      record.actualModel ?? record.spec.model, this.deps.modelCatalog,
      record.lastTurnCostEstimated === true,
    );
    const costUsd = metered.costUsd;
    // BUDGET-LIVE-ESTIMATE-REVERSIBLE: EVERY exit path must reconcile through trackCost, even
    // with nothing left to book. applyLiveEstimate does not merely pause — it interrupt()s the
    // running subtree, and claude.ts's interrupt/kill are best-effort with no guaranteed final
    // cost-bearing turn_complete (see backends/claude.ts:35). So the provisional over-estimate
    // is itself a likely CAUSE of this unclean exit, and applyCostToNode — reachable only from
    // inside trackCost — is the only thing that can ever lift the pause it set. "Nothing to
    // book" (never completed a turn, or a genuinely $0 one) does not mean "nothing to
    // reconcile": the un-pause is gated on RECORDED spend still being under the ceiling, so a
    // node that really did overspend stays paused regardless.
    if (costUsd <= 0) {
      this.trackCost(record, 0);
      // F50: usage is per-ATTEMPT. It was inert before this card (an undefined lastTurnCostUsd
      // short-circuited here), but now it is load-bearing — leaving it set lets the NEXT
      // crash-loop attempt's settle re-derive the dead attempt's tokens as phantom spend.
      // F11: book before the flush — an unpriced model reports $0 with real tokens riding
      // alongside, which is exactly the spend this branch used to drop on the floor.
      if (record.lastTurnBillableUsage) this.bookUsageDelta(record, usageFromRaw(record.lastTurnBillableUsage));
      record.lastTurnBillableUsage = undefined;
      record.bookedTurnCostUsd = undefined;
      record.bookedTurnUsage = undefined;
      return;
    }
    this.deps.events.append({
      agentId: record.agentId, kind: "usage_settle",
      data: {
        costUsd,
        // F50: the ledger row must disclose that this figure was derived, not measured.
        ...(metered.estimated ? { costEstimated: true } : {}),
        ...(record.lastTurnBillableUsage ? { billableUsage: record.lastTurnBillableUsage } : {}),
        ...(record.actualModel ? { model: record.actualModel } : {}),
      },
    });
    // BUDGET-MIDRUN-BLIND: the onEvent "turn_complete" branch above already books each
    // turn's delta into record.costUsd/trackCost as it lands, so most of this attempt's
    // spend is typically already accounted for by the time settle runs. Book only the
    // (usually zero) remainder, so a run that DID reach at least one turn_complete never
    // has its cost double-counted here.
    const delta = costUsd - (record.bookedTurnCostUsd ?? 0);
    // BUDGET-LIVE-ESTIMATE-REVERSIBLE: trackCost unconditionally, mirroring the "result" and
    // "turn_complete" branches — delta is 0 for the COMMON case (turn_complete already booked
    // this attempt's whole cumulative cost), and gating the call on it stranded exactly the
    // reconciliation described above.
    if (delta > 0) record.costUsd += delta;
    this.trackCost(record, Math.max(delta, 0), metered.estimated);
    // F11: same book-before-flush as the costUsd<=0 branch. bookedTurnUsage MUST be cleared
    // wherever bookedTurnCostUsd is — otherwise a crash-and-respawn on the same record compares
    // the fresh session's reset-to-0 counter against the dead attempt's booked figure and the
    // max(0, …) clamp silently undercounts until the new session overtakes the old.
    if (record.lastTurnBillableUsage) this.bookUsageDelta(record, usageFromRaw(record.lastTurnBillableUsage));
    record.lastTurnCostUsd = undefined;   // flushed — never re-flush the same accrued spend
    record.lastTurnBillableUsage = undefined;   // F50: same flush — see the costUsd<=0 branch above
    record.lastTurnCostEstimated = undefined;
    record.bookedTurnCostUsd = undefined;
    record.bookedTurnUsage = undefined;
  }

  // spec §7 + FEATURE-5: accumulate a result's cost delta into its OWN budget node
  // (record.budgetNodeId, falling back to record.treeId — the pre-FEATURE-5 only path)
  // AND propagate the same delta up every ancestor via each node's own recorded
  // parentNodeId — a leaf spend now books against every bounding node, not just one flat
  // root ceiling. For the common case (no budgetNodeId/budgetParentId ever used), this
  // is byte-identical to the old trackTreeCost: one node (root, parentNodeId null), one
  // iteration.
  // F50: `estimated` says the delta was DERIVED from token counts (budget.ts's meterTurnCost)
  // rather than reported by a provider. Defaulted so every existing caller — and any subclass
  // override in tests — stays source-compatible.
  protected trackCost(record: AgentRecord, deltaUsd: number, estimated = false): void {
    let nodeId: string | null = record.budgetNodeId ?? record.treeId;
    while (nodeId) {
      const budget = this.treeBudgets.get(nodeId);
      if (!budget) break;
      this.applyCostToNode(nodeId, budget, deltaUsd, estimated);
      nodeId = budget.parentNodeId;
    }
  }

  // First breach past maxBudgetUsd pauses THIS NODE (blocks FUTURE spawns/turns under it
  // only — best-effort interrupt() of still-running tree agents; already-finished work is
  // not retroactively failed) and emits a status event on agentId=nodeId. The interrupt
  // sweep matches on `a.treeId === nodeId`, which only finds live agents for a
  // treeId-rooted node (today's only spawn pattern) — a nested node keyed by an explicit
  // budgetNodeId (e.g. a task-id, not any live agent's own treeId) still correctly PAUSES
  // (denying further admission under it) but has no live agents to reverse-match for the
  // interrupt sweep; see PLAN.md Follow-ups.
  // F11: fold a backend's cumulative-per-session usage figure into the record's monotone
  // total, booking only the un-booked remainder. Mirrors the costUsd delta arithmetic in the
  // "result"/"turn_complete" branches of onEvent exactly, including the max(0, …) clamp — a
  // backend that reports a SMALLER cumulative than last turn (a fresh session on the same
  // record) must never subtract from the total. Strictly additive: it never touches costUsd
  // and never calls trackCost, so no budget decision can change because of it.
  private bookUsageDelta(record: AgentRecord, cumulative: UsageScope): void {
    const booked = record.bookedTurnUsage ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    const total = record.billableTokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    record.billableTokens = {
      input: total.input + Math.max(0, cumulative.input - booked.input),
      output: total.output + Math.max(0, cumulative.output - booked.output),
      cacheRead: total.cacheRead + Math.max(0, cumulative.cacheRead - booked.cacheRead),
      cacheCreation: total.cacheCreation + Math.max(0, cumulative.cacheCreation - booked.cacheCreation),
    };
    record.bookedTurnUsage = cumulative;
  }

  private applyCostToNode(
    nodeId: string,
    budget: { maxBudgetUsd: number; totalCostUsd: number; warned80?: boolean; parentNodeId: string | null; estimatedUsd: number },
    deltaUsd: number, estimated = false,
  ): void {
    budget.totalCostUsd += deltaUsd;
    // F50: tracked ALONGSIDE the total, never instead of it — the ceiling comparison below is
    // deliberately untouched, so a derived dollar bites exactly as hard as a measured one.
    if (estimated) budget.estimatedUsd += deltaUsd;
    // BUDGET-LIVE-ESTIMATE-REVERSIBLE: this is the authoritative delta for whatever turn
    // (if any) tripped applyLiveEstimate's provisional pause on this node — reconcile now
    // that the real number is in. If real spend keeps the node under its ceiling, the
    // estimate was an over-estimate: un-pause. If real spend ALSO breaches the ceiling,
    // drop the "reversible" marker only — pausedTrees stays set as a genuine overage (the
    // block below is then a no-op since pausedTrees already has nodeId).
    if (this.liveEstimatePausedTrees.delete(nodeId) && budget.totalCostUsd <= budget.maxBudgetUsd) {
      this.pausedTrees.delete(nodeId);
      this.deps.events.append({
        agentId: nodeId, kind: "status",
        data: { paused: false, reason: "budget", treeId: nodeId, totalCostUsd: budget.totalCostUsd, maxBudgetUsd: budget.maxBudgetUsd },
      });
    }
    // F18/D14: fire ONCE per node the moment spend crosses 80% of the ceiling — a distinct
    // event from the 100% pause below (that one still fires every time, though pausedTrees
    // already guards it to once too).
    if (!budget.warned80 && budget.totalCostUsd >= budget.maxBudgetUsd * 0.8) {
      budget.warned80 = true;
      this.deps.events.append({
        agentId: nodeId, kind: "budget_warning",
        data: { treeId: nodeId, totalCostUsd: budget.totalCostUsd, estimatedUsd: budget.estimatedUsd, maxBudgetUsd: budget.maxBudgetUsd, pct: budget.totalCostUsd / budget.maxBudgetUsd },
      });
    }
    const ack = this.budgetResumeAcks.get(nodeId);
    const acknowledged = ack !== undefined && budget.totalCostUsd <= ack;
    if (budget.totalCostUsd > budget.maxBudgetUsd && !acknowledged && !this.pausedTrees.has(nodeId)) {
      // Consume the ack as we re-pause: Map.delete's boolean IS "this node had been released",
      // which is the only place that fact still exists once the watermark is gone.
      const afterResume = this.budgetResumeAcks.delete(nodeId);
      this.pausedTrees.add(nodeId);
      this.deps.events.append({
        agentId: nodeId, kind: "status",
        data: { paused: true, reason: "budget", treeId: nodeId, totalCostUsd: budget.totalCostUsd,
                estimatedUsd: budget.estimatedUsd, maxBudgetUsd: budget.maxBudgetUsd,
                ...(afterResume ? { afterResume: true } : {}) },
      });
      for (const a of this.agents.values())
        if (a.treeId === nodeId && a.state === "running")
          void this.handles.get(a.agentId)?.interrupt();
    }
  }

  // FEATURE-5: LIVE, pre-"result" backpressure — called from onEvent's "usage" branch with
  // a cache-aware $ ESTIMATE (see budget.ts) derived from mid-turn message_start/delta
  // token counts. Unlike applyCostToNode, this NEVER mutates budget.totalCostUsd (the
  // estimate is provisional and would double-count once the turn's real costUsd lands via
  // trackCost) — it only compares totalCostUsd+estimate against the ceiling to decide
  // whether to pause EARLY. A cache-heavy turn (mostly cache_read tokens) produces a much
  // lower estimate than an equivalent all-fresh-token turn, so it's far less likely to
  // trip this early pause — this is the "cache signals reduce effective spend" behavior.
  // The pause added here is REVERSIBLE (liveEstimatePausedTrees) — applyCostToNode
  // reconciles it against the turn's real cost once trackCost delivers it, un-pausing if
  // the estimate (computed at budget.ts's flat, opus-tier rate) turns out to have been an
  // over-estimate, e.g. for a subtree tiered to a cheaper model.
  private applyLiveEstimate(record: AgentRecord, estimateUsd: number): void {
    let nodeId: string | null = record.budgetNodeId ?? record.treeId;
    while (nodeId) {
      const budget = this.treeBudgets.get(nodeId);
      if (!budget) break;
      // F50 BUDGET-RESUME: the estimator has to honour the same watermark, or the very turn the
      // operator just released is interrupt()ed mid-flight before it books a single dollar. The
      // released turn runs to its own completion and is then re-paused by the real cost — a
      // bounded, one-turn suspension of live backpressure, which is the price of having a
      // release valve at all.
      const ack = this.budgetResumeAcks.get(nodeId);
      const acknowledged = ack !== undefined && budget.totalCostUsd <= ack;
      if (!acknowledged && !this.pausedTrees.has(nodeId) && budget.totalCostUsd + estimateUsd > budget.maxBudgetUsd) {
        this.pausedTrees.add(nodeId);
        this.liveEstimatePausedTrees.add(nodeId);   // reversible — see applyCostToNode's reconciliation
        this.deps.events.append({
          agentId: nodeId, kind: "status",
          data: { paused: true, reason: "budget", treeId: nodeId, totalCostUsd: budget.totalCostUsd, maxBudgetUsd: budget.maxBudgetUsd, live: true },
        });
        for (const a of this.agents.values())
          if (a.treeId === nodeId && a.state === "running")
            void this.handles.get(a.agentId)?.interrupt();
      }
      nodeId = budget.parentNodeId;
    }
  }

  // FEATURE-5: pre-flight admission — climbs `parentId`'s own recorded ancestor chain
  // (budgetParentId at the FIRST hop, then each node's own parentNodeId), throwing
  // BudgetDeniedError (a DISTINCT `code` from GuardrailError's "guardrail" — see budget.ts's
  // doc comment on why that matters to scheduler.ts's retry-vs-terminal routing) the moment
  // any ancestor is already exhausted, or this spawn's own requestedUsd would exceed an
  // ancestor's remaining headroom. Mutates NOTHING — a denial leaves every ancestor
  // untouched ("parent budget preserved").
  //
  // F15 split this in two WITHOUT changing what the live path does: probeBudgetAdmission is the
  // pure climb (no event, no throw) the admission array calls, and checkBudgetAdmission is the
  // live wrapper that keeps the emit + the distinct BudgetDeniedError class. Explaining a task
  // must never append budget_denied to the event log.
  private probeBudgetAdmission(parentId: string, requestedUsd: number | null):
    { nodeId: string; requestedUsd: number | null; remainingUsd: number; maxBudgetUsd: number; message: string } | null {
    let nodeId: string | null = parentId;
    while (nodeId) {
      if (this.pausedTrees.has(nodeId)) {
        const b = this.treeBudgets.get(nodeId);
        return { nodeId, requestedUsd: null, remainingUsd: b ? b.maxBudgetUsd - b.totalCostUsd : 0,
          maxBudgetUsd: b?.maxBudgetUsd ?? 0, message: `ancestor budget node "${nodeId}" is already exhausted` };
      }
      const budget = this.treeBudgets.get(nodeId);
      if (!budget) break;   // climbs to an unregistered/unknown id — nothing further to check
      if (requestedUsd != null) {
        const remaining = budget.maxBudgetUsd - budget.totalCostUsd;
        if (requestedUsd > remaining) {
          return { nodeId, requestedUsd, remainingUsd: remaining, maxBudgetUsd: budget.maxBudgetUsd,
            message: `requested ${requestedUsd} exceeds budget node "${nodeId}"'s remaining ${remaining}` };
        }
      }
      nodeId = budget.parentNodeId;
    }
    return null;
  }

  private checkBudgetAdmission(parentId: string, requestedUsd: number | null): void {
    const denial = this.probeBudgetAdmission(parentId, requestedUsd);
    if (!denial) return;
    this.emitBudgetDenied(denial.nodeId, denial.requestedUsd, denial.remainingUsd, denial.maxBudgetUsd);
    throw new BudgetDeniedError(denial.message);
  }

  private emitBudgetDenied(nodeId: string, requestedUsd: number | null, remainingUsd: number, maxBudgetUsd: number): void {
    this.deps.events.append({
      agentId: nodeId, kind: "budget_denied",
      data: { nodeId, parentId: this.treeBudgets.get(nodeId)?.parentNodeId ?? null, treeId: nodeId, requestedUsd, remainingUsd, maxBudgetUsd },
    });
  }

  treePaused(treeId: string): boolean { return this.pausedTrees.has(treeId); }

  // F50 BUDGET-RESUME. Releases ONE budget node. Deliberately NOT a raise: maxBudgetUsd is never
  // read-modify-written here, and clearing a pause vs. granting more budget are two different
  // operator intentions — conflating them is how a runaway becomes unbounded (40-verdict.md §14,
  // the con's Security note, adopted verbatim).
  // Returns the facts the caller needs to tell the operator what actually happened, including the
  // nearest still-paused ancestor, since resuming a leaf under an exhausted ancestor changes
  // nothing that checkBudgetAdmission (:4853) will let through.
  resumeBudget(nodeId: string): {
    resumed: boolean; totalCostUsd: number; estimatedUsd: number; maxBudgetUsd: number;
    overBudget: boolean; blockedByAncestorNodeId: string | null;
  } | null {
    const budget = this.treeBudgets.get(nodeId);
    if (!budget) return null;                       // unknown node — caller reports resumed:false
    const wasPaused = this.pausedTrees.delete(nodeId);
    // Clear the reversible marker too: leaving it set makes the NEXT applyCostToNode emit a
    // spurious status{paused:false} for a node nothing paused (:4788).
    const wasLiveEstimatePaused = this.liveEstimatePausedTrees.delete(nodeId);
    const overBudget = budget.totalCostUsd > budget.maxBudgetUsd;
    // Watermark on ANY released pause, not only an over-BUDGET one: applyLiveEstimate re-pauses
    // from MID-TURN token counts, so a release granted on a pure over-ESTIMATE (totalCostUsd still
    // under the ceiling) carried no watermark and was undone by the next `usage` event of the very
    // turn it released. Recording the spend at release time suspends BOTH re-pause paths until real
    // new spend books past it — the bounded, one-turn suspension applyLiveEstimate describes.
    // But ONLY for a pause we actually released: this RPC is reachable from the app banner, the tui
    // command and raw RPC, and a watermark on a HEALTHY tree would disarm that mid-turn guard for
    // free and mislabel its next first-ever breach as afterResume.
    if (wasPaused || wasLiveEstimatePaused) this.budgetResumeAcks.set(nodeId, budget.totalCostUsd);
    else this.budgetResumeAcks.delete(nodeId);
    if (wasPaused) this.deps.events.append({
      agentId: nodeId, kind: "status",
      data: { paused: false, reason: "budget", treeId: nodeId, totalCostUsd: budget.totalCostUsd,
              estimatedUsd: budget.estimatedUsd, maxBudgetUsd: budget.maxBudgetUsd, resumed: true },
    });
    let ancestor: string | null = budget.parentNodeId;
    while (ancestor && !this.pausedTrees.has(ancestor))
      ancestor = this.treeBudgets.get(ancestor)?.parentNodeId ?? null;
    return {
      resumed: wasPaused, totalCostUsd: budget.totalCostUsd, estimatedUsd: budget.estimatedUsd,
      maxBudgetUsd: budget.maxBudgetUsd, overBudget, blockedByAncestorNodeId: ancestor,
    };
  }

  // Task AUTH-a: exposes the per-account auth-STATE set to the engine (mirrors
  // CooldownTracker.snapshot()'s role for cooling accounts) — daemon.status reads
  // this to surface authExpired per account.
  authExpiredAccounts(): ReadonlySet<string> { return this.authExpired; }
}
