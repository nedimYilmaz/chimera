import type { PermissionApplication, Principal, CodexContextLimits, AccountQuota, AccountQuotaReason, ToolOutputImage, ToolOutputImageWarning, AgentGroup, ContentBlock, EffortLevel, FailureCause as ProtocolFailureCause, McpListenerStatus, MemoryGetResult, MemoryRecord, MemorySearchMode, NormalizedEvent, ReviewSession, TaskEvidence, TaskState, WakeScheduling, WorkflowSpec, WorkflowStep } from "@chimera/protocol";

export type WorkflowGraphEdgeKind = "implicit" | "route" | "fanOutJoin" | "planResume" | "subWorkflowJoin";
export type WorkflowGraphNode = { id: string; step: WorkflowStep };
export type WorkflowGraphEdge = { id: string; from: string; to: string; kind: WorkflowGraphEdgeKind; order: number };
export type WorkflowGraphDocument = {
  name: string;
  onFail: WorkflowSpec["onFail"];
  retryLimit: number;
  // Recipe templating: preserved losslessly through normalize/serialize round-trips (flow.ts)
  // even though Workflow Studio has no dedicated UI for editing it yet — dropping it here would
  // silently strip a recipe's declared params every time it's opened and saved.
  params: WorkflowSpec["params"];
  nodeOrder: string[];
  nodesById: Record<string, WorkflowGraphNode>;
  edgesById: Record<string, WorkflowGraphEdge>;
};
export type WorkflowStudioState = {
  open: boolean;
  mode: "author" | "inspect";
  queue: string | null;
  taskId: string | null;
  version: number | null;
  baseline: WorkflowGraphDocument | null;
  draft: WorkflowGraphDocument | null;
  selectedNodeId: string | null;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  // set by a `{kind:"workflow", failedOnly:true}` deep link (the "Filter failed workflow
  // nodes" palette command) — the canvas renders only nodes whose runtime state is "failed".
  failedOnly: boolean;
};

// IMAGE.PASTE (TUI #7): the additive image-attachment shape threaded through
// the UI's send paths (compose input -> store.sendToMain/sendToSelected -> the
// agent.send RPC). Mirrors @chimera/core's backend.ts Image type structurally,
// kept as a SEPARATE local declaration -- the UI packages have no runtime/type
// dependency on @chimera/core (only @chimera/client + @chimera/protocol).
// W2 state port: this pair used to live in the retired TUI's clipboard.ts, but
// TranscriptItem/OutboxItem below carry it and @chimera/ui-state must never
// import from a UI package (no ui-state -> UI edge, ever) -- so the
// DECLARATION lives here.
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type Image = { mediaType: ImageMediaType; data: string };

// MEMORY TAB: one ranked hit from the memory.search RPC — the record plus its
// relevance score (0 when no query was given). Mirrors core's ScoredRecord shape
// exactly (the daemon returns it verbatim); typed here off the protocol's
// MemoryRecord so the Memory pane reads real fields, not an untyped blob.
export type MemoryHit = { record: MemoryRecord; score: number };

// MEM-5 (PLAN-MEMORY.md §8): the folder-rail selection composed into the search.
// A discriminated union rather than a bare `string | null` because "all" (no
// filter) and "unfiled" (the virtual folder of null-folder records) are two
// distinct states that a single nullable string can't tell apart — and the
// command layer maps each to different memory.search params (all → no folder;
// unfiled → no folder param + a client-side null-folder post-filter, since the
// RPC's folder param is a prefix match with no "is-null" form; folder → prefix).
export type MemoryFolderSel =
  | { kind: "all" }
  | { kind: "unfiled" }
  | { kind: "folder"; path: string };

// F34.UI: the scope selection is a SEPARATE axis from the folder — a folder is
// where an operator filed a note, a scope is which project the writing agent was
// in when it wrote one (server-stamped, never typed). Same discriminated-union
// reasoning as MemoryFolderSel: "all" and "global" (the null-scope records) are
// distinct states, and memory.search has no is-null form for scope — worse, it
// WIDENS (scope:X returns X ∪ global by design), so every selection here also
// carries a client-side post-filter.
export type MemoryScopeSel =
  | { kind: "all" }
  | { kind: "global" }
  | { kind: "scope"; name: string };

// F34.UI: the slice of memory.stats the UI actually renders (an older daemon
// answers memory.stats WITHOUT byScope, so it stays optional and every read
// defaults to []).
// F36.UI: `capacity` joins byScope on the same terms — the daemon that answers
// memory.stats with an eviction block is newer than the one that doesn't, and the
// TUI store CASTS the reply rather than parsing it, so both stay optional and every
// read defaults. Structural (not the protocol type) for the same reason the rest of
// this view is: ui-state must not force a protocol version on a cast reply.
export type MemoryStatsView = {
  total: number;
  byScope?: Array<{ scope: string | null; count: number }>;
  capacity?: MemoryCapacityView;
};

export type MemoryEvictionCandidateView = {
  id: string; title: string | null; kind: string; value: number; inbound: number; pinned: boolean;
};

export type MemoryCapacityView = {
  limit: number; total: number; fill: number; alarmAt: number; alarming: boolean;
  pinned: number; nextToEvict: MemoryEvictionCandidateView[];
};

// Task TRANSCRIPT.V2 (#9): the tool variant is first-class — it carries enough
// detail (toolName/input/status/result/toolId) for AgentDetail to render a
// single inline iconic row (collapsed) and, on demand, the full input+result
// (expanded) — replacing the old `{role:"tool", text:"→ Bash"}` arrow form
// that neither showed what ran nor its result.
// WD Stage 1 (coverage B4, per-turn timestamps): every variant additionally carries an
// OPTIONAL `ts` — the ORIGINATING event's ts, stamped by the reducer ONLY when the
// dispatching store opts in (Action "event"/"backfillHistory"'s `stampTs`; see
// reducer.ts). Optional + opt-in keeps every pre-existing projection (and the TUI,
// which renders nothing new) byte-identical; the app's event-scan
// transcriptTimestamps selector becomes redundant once it reads this field instead.
// TRANSCRIPT-EVICT-OLD: `seq` is the ORIGINATING event's seq, stamped
// unconditionally (unlike `ts`, which is opt-in) on every row born via the
// reducer's shared `at` spread — cheap (a number) and required so
// evictTranscriptFront() can recompute historyMinSeq from whatever row is now
// oldest after dropping the front of the array. A row later mutated in place
// (streaming deltas, tool call -> done) keeps its BIRTH seq, never advances it
// -- that's the conservative choice: it's always <= any event actually folded
// into the row, so treating it as "everything below this is not yet in
// transcript" never re-fetches something already shown.
export type TranscriptItem =
  | { role: "assistant"; text: string; streaming: boolean; ts?: number; seq?: number; completedSeq?: number }
  // IMAGE.SHOW (TUI): a user turn now optionally carries the image(s) that rode
  // along with the message (pasted/dropped, see clipboard.ts). Additive/optional
  // -- a plain text turn omits it and renders exactly as before. AgentDetail
  // renders one distinct chip row per image; App's mouse handler opens it in the
  // OS viewer on click (both keyed off this field).
  // DELIVERY.MARK: `from` is set ONLY when this turn was DELIVERED into the
  // agent's mailbox by another agent (deliverTo) -- it carries the origin agent
  // id so the renderer can mark it as an incoming delivery, not the human's own
  // input. A genuine user turn (the TUI's own send) leaves `from` undefined.
  // D9: additive ordered content blocks — present only on a DELIVERED turn (from
  // another client) whose original send used content[]; carries the same
  // interleaved text/image order the sender authored, so replay after a reload
  // re-renders identically instead of falling back to the flattened `text`.
  // FORCE-SEND-MIDTURN: `forced` — this turn bypassed the busy-hold outbox
  // (a direct opt+enter send while the target was mid-turn) — renders a
  // distinct tag next to "you" so it reads apart from an ordinary send.
  | { role: "user"; text: string; messageId?: string; messageOrigin?: Pick<Principal, "from" | "source" | "engineId">; images?: Image[]; content?: ContentBlock[]; from?: string; ts?: number; forced?: boolean; seq?: number }
  // TURN-COST-VISIBLE: `turnId` is the assistant message this call arrived on. Calls sharing one
  // were produced in a single model turn (one context read between them); calls with different ones
  // each cost their own. Optional — a backend that does not report it simply shows no turn count.
  | { role: "tool"; toolName: string; input?: unknown; status: "called" | "done" | "denied"; result?: string; images?: ToolOutputImage[]; imageOutputWarnings?: ToolOutputImageWarning[]; toolId?: string; turnId?: string; ts?: number; seq?: number }
  // BACKGROUND-TASK-VISIBILITY: a script the agent started and walked away from, shown inline
  // where it was started — the same treatment a tool call gets, because from the reader's side it
  // is the same question ("what is this agent doing right now"). Distinct from role:"tool" because
  // this row UPDATES IN PLACE for the life of the script rather than being a call followed by a
  // result, and because a task can end "killed", which no tool call can.
  | { role: "task"; taskId: string; description: string; taskType?: string; status: "running" | "done" | "failed" | "killed" | "ended"; error?: string; ts?: number; seq?: number }
  | { role: "system"; text: string; ts?: number; seq?: number };

export type ToolLogItem = { ts: number; toolName: string; toolId?: string; input?: unknown; status: "called" | "done" | "denied" };

// BACKGROUND-TASK-VISIBILITY: a script the agent started and walked away from — its own
// `taskType: "local_bash"` work, not a sub-agent. upsertShadow (core) refuses to make these fake
// agent rows, which is right, but left them invisible everywhere; this is where they live instead.
//
// Kept SEPARATE from ToolLogItem rather than folded into it: a tool call belongs to one turn and
// resolves inside it, while a background task outlives the turn that started it and is identified
// by a taskId the backend correlates on. Sharing the shape would have meant lying about both.
export type BackgroundTaskItem = {
  taskId: string;
  ts: number;                       // when it started
  description: string;
  taskType?: string;
  status: "running" | "done" | "failed" | "killed" | "ended";
  endedAt?: number;
  error?: string;
};

// FEATURE 2 (token usage): a provider-normalized per-agent token tally. Both
// backends emit per-turn usage on their `turn_complete` event — codex in the
// normalized `data.usage` (see backends/codex.ts), claude only in the raw SDK
// result message `raw.usage` (backends/claude.ts) — under DIFFERENT field
// names. extractUsage() (reducer.ts) reads either location and maps them onto
// this one canonical shape so every display site is provider-agnostic.
// `cacheRead`/`cacheCreation` are the prompt-cache token counts (claude splits
// them; codex only reports a single cached-input figure, mapped to cacheRead).
// Tracked with the SAME latest-wins semantics the reducer already uses for
// costUsd (a turn_complete/result overwrites, never sums) so tokens and cost
// always describe the same turn/run.
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheCreation: number };

// spec §17.2 agent_question projection (T5 fold-in): the ask→structured-answer
// round trip's question-side fields the TUI needs to render a prompt banner.
// pendingQuestion is cleared by: (a) a "questionAnswered" action once the user
// (or another client) actually answers the matching questionId, and (b) the
// agent reaching an error/interrupted terminal state (an "error" event, or a
// "status" event carrying an interrupted state) — a stuck ask must not survive
// a turn that errored out from under it. There is no analogous
// "questionResolved" status event today (unlike permissionResolved), so a
// second agent_question for the same agent simply replaces the pending one.
// ASK-UNREACHABLE-TARGET-LEAK: `to` mirrors the agent_question event's own `to` field —
// present only for an inter-agent ask_agent/ask_team question (the target agentId that
// must call answer_question), absent for an ask_human question. It is projected so the
// human-facing selectors below can exclude inter-agent questions from the QuestionCard
// surface; it is NOT cleared from the per-agent record, so the agent-list "?" waiting
// indicator still lights up for an asker blocked on another agent's answer.
export type AgentQuestion = {
  questionId: string;
  prompt: string;
  header?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  multiSelect: boolean;
  freeform: boolean;
  default?: { optionIds?: string[]; text?: string } | null;
  timeoutMs?: number | null;
  to?: string;
  // FEATURE-9 (attention inbox): when this question arrived (e.ts at projection) —
  // mirrors PendingPermission.ts, needed for FIFO ordering across item kinds.
  ts: number;
  // FEATURE-9: set iff this rode a workflow approval-gate ask() (scheduler.ts's
  // evaluateGate) — lets a human-facing selector label it distinctly from a plain
  // question instead of guessing off the approve/reject option ids. Absent for every
  // other ask() caller (ask_human/ask_agent/ask_team).
  gate?: "approval";
};

// Task T2 (F1 outbox): a message held because its target conductor was busy when
// submitted. FIFO per agentId — store.flushOutbox() sends the HEAD item once the
// target goes idle (busy:true -> false), one per turn. `id` is a deterministic
// `q<n>` counter (store.ts's outboxSeq) -- NO Math.random/Date.now.
// PARITY WS-B: `slash` marks a held item as a real agent-routed slash command so that,
// when flushed after the current turn, it is re-sent with `slash:true` — otherwise a
// command queued while the agent was busy would be demoted to a plain "[from tui] " message.
// F13 (D9 wire): `content` — additive ordered blocks, carried alongside `text`/`images` so a
// message that held inline image tags while its target was busy still sends with the tags at
// their exact positions once flushed, instead of degrading to the bunched legacy form.
export type OutboxItem = { id: string; agentId: string; text: string; images?: Image[]; content?: ContentBlock[]; slash?: boolean };

// Native-CLI-parity Phase 2 (Task DLG3): the per-agent projection of DLG1's
// `agent_dialog` event -- a native interactive dialog (AskUserQuestion /
// elicitation) the backend itself is blocked on (decideDialog), distinct from
// agent_question's ask_human MCP-tool round trip. `payload` is the dialog's
// raw (loosely-typed, provider/dialog-kind-specific) data -- DialogPanel.tsx
// interprets it per `dialogKind`. Cleared by: a `status{dialogResolved,
// dialogId}` event for this dialogId, a "dialogAnswered" action (once
// answered via store.answerDialog), or the agent reaching an error/
// interrupted terminal state -- mirrors pendingQuestion's own clear paths
// exactly (see AgentQuestion's doc comment above).
export type PendingDialog = { dialogId: string; dialogKind: string; payload: Record<string, unknown> };

// Native-CLI-parity Phase 1 (Task N2): a node in the per-agent subagent/workflow
// tree the FlowPane (N3) renders, built by flow.ts's pure applyFlowEvent from
// N1's agent_task + parented tool_call/tool_result events. `id` is a stable key:
// a task's toolUseId (the Task tool_use id) or taskId; a tool's toolUseId or
// `tool:${seq}`. `taskId` is internal bookkeeping (NOT part of FlowPane's
// display contract) — the Claude Agent SDK's task_updated message may repeat a
// taskId WITHOUT the toolUseId the original task_started carried, so a later
// status-only agent_task must still resolve back to the same node; see flow.ts's
// node-resolution comment for the full keying decision.
export type FlowNode = {
  id: string;
  kind: "task" | "workflow" | "tool";
  label: string;
  status: string;                       // "called"|"running"|"completed"|"failed"|"done"|... (raw; FlowPane colors it)
  subLabel?: string;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  children: FlowNode[];
  taskId?: string;
};

// Native-CLI-parity Phase 3 (Task SC2): the per-command projection of SC1's two
// slash-command sources -- `agent_started`'s `slashCommands` (bare name strings,
// pre-descriptions -- reducer.ts's "agent_started" case) and `commands_changed`'s
// richer `SlashCommand[]` (REPLACE semantics -- reducer.ts's own "commands_changed"
// case). `name` is the only field guaranteed populated; `description`/
// `argumentHint` stay undefined until a `commands_changed` event supplies them.
//
// PARITY WS-A: `source` distinguishes a TUI-LOCAL built-in (state/commands.ts,
// run locally) from an AGENT-advertised command (routed to the SDK). It is
// undefined on the agent-side folds (reducer.ts) -- an undefined source is
// treated as "agent" -- and set to "builtin" only by builtinCommandViews(); the
// popup uses it purely to draw a distinguishing glyph.
export type SlashCommandView = { name: string; description?: string; argumentHint?: string; source?: "builtin" | "agent" };

// WS-D (parity: surface MCP servers read-only): the per-server projection of the
// SDK system/init `mcp_servers` array (reducer.ts's "agent_started" case). Both
// fields come straight off the SDK entry; `status` is the connection health word
// ("connected"/"failed"/"needs-auth"/... — verbatim, never enum-narrowed here) that
// AgentDetail maps onto the theme connection glyph. `[]` until an agent_started
// carrying mcpServers is projected.
export type McpServerView = { name: string; status: string };

// HOOK-7 (PLAN-HOOKS.md §7 — TUI minimal parity): a display projection of one of
// an agent's live event subscriptions (protocol SubscriptionSchema), fetched on
// demand via `sub.list { subscriberId }` (store.loadSubscriptions) — NOT folded
// off the hot event stream, exactly like resultDetail. Only the fields the
// AgentDetail "⌚ n subs" line renders are kept (id for keys, topic + filter for
// the expanded rows, once/wake/note as light qualifiers); the app (HOOK-6) reads
// the same field for its inspector "watching" chips. `filter` stays the loose
// TopicFilter record — the renderer only summarizes it, never matches on it.
export type SubscriptionView = {
  id: string;
  topic: string;
  filter?: Record<string, unknown>;
  once: boolean;
  wake: string;
  note?: string;
};

// PAUSED-AGENTS-VISIBLE: mirrors core's AgentRecord.pauseReason (supervisor.ts) verbatim —
// the ONE union both AgentRecordLite (wire) and AgentView (projected) key off, so a new pause
// mechanism added on the daemon side can't silently drift out of sync between the two.
export type PauseReason = "session-limit" | "crash-loop-backoff" | "reattach-recovery" | "daemon-restart" | "idle-timeout" | "operator-hold";

// F08: mirrors protocol's FailureCauseSchema (packages/protocol/src/index.ts) verbatim — the ONE
// union both AgentRecordLite (wire) and AgentView (projected) key off, so a new daemon-side cause
// cannot silently drift out of sync between the two. Same contract as PauseReason above.
export type FailureCause = "account-cap" | "provider-rate-limit" | "provider-capacity" | "provider-stream" | "transient-network" | "bad-request" | "credential" | "output-truncated" | "context-overflow" | "unclassified";
// F08.QA: PauseReason above can only be hand-checked, but protocol EXPORTS this union, so the
// copy is machine-checkable — a cause added to (or removed from) FailureCauseSchema without
// updating the line above fails `tsc -b packages/ui-state` instead of surfacing months later as
// a label that renders the raw cause string in the fleet list.
type _FailureCauseLockstep = [FailureCause] extends [ProtocolFailureCause]
  ? ([ProtocolFailureCause] extends [FailureCause] ? true : never)
  : never;
const _failureCauseLockstep: _FailureCauseLockstep = true;
void _failureCauseLockstep;
// F08.UI: the four disposition booleans ride the SAME wire object the daemon persists
// (FailureDispositionSchema) and are the ONLY sanctioned way to read the engine's intent —
// protocol forbids re-deriving it from cause/errorClass. Optional because an older daemon (or a
// snapshot taken before F08.UI) sends the cause alone; failureNeedsOperator falls back to a
// cause table in that case.
export type FailureView = {
  cause: FailureCause;
  evidence?: string;
  at?: number;
  errorClass?: string;
  retryable?: boolean;
  failoverAccount?: boolean;
  holdForReset?: boolean;
  restartInPlace?: boolean;
};

export type AgentView = {
  agentId: string;
  state: string;                        // "running" | "paused" | "done" | "failed" | "killed" | "unknown"
  // Optional user-chosen identity. Separate from the execution account and from a native
  // shadow's `label`; clients fall back to their deterministic generated name when absent.
  displayLabel?: string;
  // JOB-FLEET-GROUPING: the scheduled job that spawned this agent (mirrors AgentSummary/
  // AgentRecordLite.jobName below verbatim) — undefined for a spawn with no owning job.
  // Folded via foldAgentIdentity (reducer.ts), same two first-sight events (registration
  // marker + agent_started) as account/provider/permissionProfile/permissionRequest below.
  jobName?: string | null;
  // AGENT-GROUPS Phase 1: operator-defined wrapper-box membership (mirrors AgentSummary/
  // AgentRecordLite.groups below verbatim). Folded via the same two first-sight events as
  // jobName above, PLUS a live re-emit whenever agent.setGroups fires (see foldAgentIdentity's
  // status-event branch) — unlike jobName/sessionRole, group membership can change any number
  // of times after spawn, not just be stamped once. Absent/empty ⇒ ungrouped.
  groups?: string[];
  // F47: attentionAt has TWO producers, exactly like `model`/`effectiveContextLimit` — the
  // agent.list snapshot fold (agentRecords case) AND the live event stream, since the reducer
  // sees the very same ATTENTION_EVENT_KINDS events the daemon stamps from. reviewedAt has two
  // as well: the snapshot, and agent.markSeen's status event. Both undefined until one of those
  // carries a value; read them only through isUnseen (seen.ts), never compared inline.
  attentionAt?: number;
  reviewedAt?: number;
  // JOB-FLEET-GROUPING: AgentRecord.createdAt, stamped on the SAME two first-sight events as
  // jobName above — the event-sourced desktop app never polls agent.list (see
  // AGENT-IDENTITY-INVISIBLE-IN-APP), so without this it has no timestamp to rank a job
  // group's runs "most recent first" by. Undefined only for an older daemon that predates
  // this field; AgentRecordLite.createdAt (the TUI's polled path) is non-optional and always
  // present, so the app is the only client that can ever see this absent.
  createdAt?: number;
  account?: string;
  provider?: string;
  model?: string;
  effort?: EffortLevel;
  // CONDUCTOR-FULL-ACCESS: the agent's LIVE permission scope, surfaced so the TUI/app can both
  // SHOW it (AgentDetail chip) and let the user CHANGE it via agent.setPermission. Two sources,
  // authoritative-when-present like gitBranch below: the agent.list snapshot (agentRecords case,
  // from spec.permissionProfile / spec.on.permissionRequest) AND the live `permissionChanged`
  // status event setPermission emits (reducer status fold), so a change reflects instantly with
  // no poll wait. Undefined until the first snapshot/event carries it (older daemon / pre-spawn).
  // `permissionProfile` is readOnly|acceptEdits|full; `permissionRequest` is auto|poke:caller|tui.
  permissionProfile?: string;
  permissionRequest?: string;
  permissionApplication?: PermissionApplication;
  /** Legacy provider response; newer daemons also report independently acknowledged posture. */
  permissionAppliedToRunningProcess?: boolean;
  // DENIED-TOOL-CALL-INVISIBLE: whether this agent hit a host-tool-policy deny (Bash toolPolicy
  // or foreign-MCP policy) at any point — projected from AgentRecordLite.toolPolicyDenied via
  // the "agentRecords" snapshot path, sticky like turnBudgetExceeded (once true, a later poll
  // that races ahead of a fresh event never blanks the warning). `lastToolPolicyDenial` carries
  // the tool/profile detail for the chip's tooltip-equivalent text; only ever present when the
  // FULL agent.list snapshot was polled (agent.listSummary omits it, token discipline).
  toolPolicyDenied?: boolean;
  lastToolPolicyDenial?: { tool: string; profile: string | null; profileUnresolved?: boolean; requestId: string; at: number };
  // F22: whether this agent currently holds the single-writer worktree lease (authoritative-
  // when-present, mirroring gitBranch below — a lease can be legitimately released, so unlike
  // toolPolicyDenied this must NOT stick once cleared) vs. was refused a write because ANOTHER
  // live agent holds it (worktreeLeaseDenied, sticky like toolPolicyDenied — the refusal stays
  // visible even if a later poll races ahead of the event). `lastWorktreeLeaseDenial` carries
  // the owner/key detail for the chip's tooltip-equivalent text; only ever present when the
  // FULL agent.list snapshot was polled (agent.listSummary omits it, token discipline).
  worktreeLeaseHeld?: boolean;
  worktreeLeaseDenied?: boolean;
  lastWorktreeLeaseDenial?: { tool: string; workdirKey: string; owner: string; ownerState: "active" | "retained"; target: string; requestId: string; at: number };
  // F22.UI (QA gap): supervisor.launch() deliberately swallows acquire()'s GuardrailError, so
  // "a second agent tried to take a live worktree" existed ONLY as a string inside a raw status
  // event — nothing projected, nothing rendered. Sticky like worktreeLeaseDenied (the contention
  // is a past fact worth keeping visible), event-only: no snapshot carries it, so a client that
  // reconnects after the contention will not see it (core would have to stamp the record).
  worktreeLeaseContended?: { message: string; at: number };
  // F22.UI: the enforcement mode as OBSERVED from this agent's own lease decisions — a refusal
  // means "enforce", a warn-mode capability_decision{decision:"allow"} means "warn". Deliberately
  // NOT the configured cfg.worktreeLease: no config value is projected to either UI, and "off"
  // emits no events at all, so it is not observable. Absent ⇒ no lease decision seen yet.
  worktreeLeaseMode?: "enforce" | "warn";
  // R2 (ctx meter effective-limit): the ctx% meter's denominator — an operator-configured
  // compactionThreshold when set, else the resolved model's native context window. Projected
  // from agent.list's AgentRecordLite (AgentRecord.effectiveContextLimit, stamped by the
  // daemon's launch() on every spawn/setModel) via the "agentRecords" snapshot path, same as
  // gitBranch/turnBudgetExceeded below. CTX-METER-LIVE-FORWARD: ALSO event-driven now, mirroring
  // `model` above -- supervisor.ts's onEvent stamps the record's current value onto every
  // agent_started, and onto message_complete whenever a live /model change just fired, so this
  // stays correct between snapshots instead of only updating on the next agent.list refetch
  // (which the desktop app never does after its one-shot bootstrap fetch). Undefined until the
  // first snapshot/event carries it (older daemon that predates this field) -- app/state/
  // selectors.ts's effectiveContextLimitFor falls back to contextWindowFor(model) in that case,
  // so ctxPct never breaks, just less precisely (native window instead of a configured
  // threshold).
  effectiveContextLimit?: number;
  contextLimits?: CodexContextLimits;
  // Task RS2 (conductor session-resume): the provider session id the backend emits on
  // `agent_started` (reducer.ts's "agent_started" case). Undefined until an
  // agent_started carrying data.sessionId is projected -- either live or via startup's
  // history-tail replay, which is how a RESTORED historical conductor (one that was
  // already running before this TUI launched) carries its sessionId. store.ts's
  // self-heal respawn paths read this to thread `resume:<sessionId>` into the fresh
  // agent.spawn spec, so a daemon-restart respawn continues the conversation instead
  // of starting blank.
  sessionId?: string;
  // RESUMED-AGENT-TRANSCRIPT-CONTINUITY: the ordered chain of PREDECESSOR agentIds (oldest
  // first, this agent excluded) this AgentView's sessionId was resumed from -- e.g. ["a1",
  // "a2"] on a3 means a1 -> a2 -> a3. Folded once, at agent_started time (reducer.ts), when a
  // brand-new agentId's sessionId matches an already-projected AgentView elsewhere in the
  // agents map -- a respawn-with-resume (self-heal or an operator-driven `resume:<sessionId>`
  // redelivery, see supervisor.ts) mints a NEW agentId whose chimera event log starts empty,
  // even though the provider SDK session (and thus the model's real memory) carries over
  // whole. Its transcript/tools/usage/costUsd are seeded from the resolved predecessor (the
  // chain tip: the OTHER agents-map entry sharing this sessionId with the longest transcript,
  // since each generation's merge already folds every earlier one in) so the transcript pane
  // and ctx meter read correctly from this agent's very first render instead of looking
  // amnesiac. A single `role: "system"` banner item marks the generation boundary in the
  // transcript itself (TranscriptSegment/AgentDetail already render that role distinctly, so
  // no UI-package change was needed). Undefined for every agent that isn't a resume (no
  // matching predecessor found) -- the overwhelmingly common case -- and for daemons that
  // predate this projection.
  resumedFrom?: string[];
  conductor: boolean;
  // Ad-hoc sessions design §1/§6: marks this agent as a SESSION-tier agent (a transient
  // investigation, not a project conductor) — buckets separately in the agents list. Defaults
  // false, never undefined — same contract as `conductor`.
  session: boolean;
  transcript: TranscriptItem[];
  tools: ToolLogItem[];
  // BACKGROUND-TASK-VISIBILITY: live + recently-finished background scripts, newest last.
  backgroundTasks: BackgroundTaskItem[];
  // TERMINAL-RUNTIME: set only for an agent running as a real CLI in a tmux session. Its presence
  // is what tells the UI to show a live terminal where the transcript would be — there IS no
  // transcript for these agents, the screen is the transcript.
  terminal?: { session: string; attach: string };
  costUsd: number;
  // FEATURE 2 (token usage): per-agent token tally, null until a turn_complete/
  // result carrying usage is projected. Latest-wins, exactly like costUsd above.
  usage: TokenUsage | null;
  // CTX-VS-BILLABLE: `usage` above is the BILLABLE tally and is latest-wins across three event
  // sources, one of which (`result`) carries the run's CUMULATIVE usage. That is correct for
  // cost and for the tokens column, and WRONG as a context basis: a cumulative figure only
  // grows, so the ctx meter climbed past the model's own window (observed live: 471k against a
  // 200k limit) and then sat pinned at 100% forever. `ctxUsage` is the context baseline alone —
  // written only by the dedicated `usage` event (LIVE-CTX-USAGE, and the post-compaction reset
  // that rides the same kind), never by a cumulative result. null until one arrives, in which
  // case readers fall back to `usage` and behave exactly as before.
  ctxUsage?: TokenUsage | null;
  codexTransport?: "exec" | "app-server";
  // COMPACTION-VISIBLE-STATE: how many times this agent's context has been compacted, and when
  // last — folded from the normalized `compaction` event (see reducer's own case). The event
  // already produced a transcript banner; this is the same fact kept as STATE so a meter can
  // show it without the reader scrolling back to find the line. Undefined = never compacted.
  compactions?: number;
  lastCompactedAt?: number;
  // COMPACTION-IN-PROGRESS: true between a compaction's start event and its completion. What makes
  // compaction watchable while it happens rather than only afterwards.
  compacting?: boolean;
  // COMPACTION-OUTLIVES-THE-TURN: set when the PROVIDER itself announced the compaction had begun
  // (a phase:"start" event), as opposed to chimera merely having requested one. That difference
  // decides who is allowed to end it — see goIdle.
  compactingConfirmed?: boolean;
  sessionUsage?: TokenUsage;
  usageMeasuredAt?: number;
  lastEventTs: number;
  pendingQuestion: AgentQuestion | null;
  // Native-CLI-parity Phase 2 (Task DLG3): see PendingDialog's own doc comment above.
  pendingDialog: PendingDialog | null;
  // Task T1: true while a turn is in progress (the conductor is working), false
  // when idle/terminal. Foundation for F1 (outbox), F3 (thinking animation), F6
  // (per-agent activity) -- NO other feature logic lives here yet.
  busy: boolean;
  // ELAPSED-TIMER: event ts (epoch ms) of the event that drove the CURRENT turn
  // busy — stamped only on the busy false→true transition, preserved across the
  // turn's remaining events, cleared on turn_complete/result/error/terminal. The
  // thinking/streaming elapsed counters anchor on THIS (not component mount), so a
  // transcript opened mid-turn shows TRUE elapsed. Never Date.now()-derived here
  // (reducer stays snapshot-pure); undefined until the turn's first event lands
  // (e.g. an optimistic local send), where the UI falls back to mount time.
  busySince?: number;
  // F09: a delivered-but-unacknowledged message. Distinct from `busy` (a turn IS running) and
  // from the app's fleet `stalled` (a turn running with no events — selectors.fleet.ts:43):
  // this is the agent NOT starting a turn at all. null once cleared.
  // `text` is UI-derived (the last user turn folded into this transcript) so the cockpits can
  // offer a one-key RESEND without any daemon change; it is absent when history was never loaded
  // or was evicted, and the UIs degrade to "type a nudge" rather than inventing a message.
  // `partial` marks a stall known only from the boolean agent.list projection (AgentRecordLite
  // .promptStalled) — real, but with no timestamp/sender, so the badge drops its duration.
  promptStall?: { deliveryId: string; from: string; sinceTs: number; sinceMs: number; text?: string; partial?: boolean } | null;
  // SLASH-COMMAND-IN-FLIGHT: the provider slash command this turn is running ("/compact"), when
  // the turn was started by one. A slow command shows as a bare "thinking…" otherwise, with
  // nothing on screen to say what is taking the time — /compact on a large context runs for a
  // minute or more and looks indistinguishable from a wedged agent. Cleared when the turn ends.
  pendingCommand?: string;
  /** Operator hold used by fleet bulk actions. It is projection-only until a
   * matching status snapshot/event clears it; it never aliases provider-limit holds. */
  manualPaused?: boolean;
  // PAUSED-AGENTS-VISIBLE: WHY this agent is currently held at state "paused" — mirrors
  // core's AgentRecord.pauseReason (supervisor.ts's parkPaused), folded onto the view both
  // live (a `status{paused:true}` event) and via the next agent.list snapshot. undefined
  // whenever state !== "paused" (cleared alongside the resume transition on both paths) —
  // never assume presence just because a PREVIOUS pause left it set from an earlier life of
  // this agentId.
  pauseReason?: PauseReason;
  // F08: the disposition record for this agent's last failure — cause, plus evidence/at for
  // debugging. Rides the SAME agent.list snapshot (AgentRecord.failure) and the live
  // status{state:"failed"} event — optional/defensive: absent for an older daemon or an agent
  // that never failed.
  failure?: FailureView;
  // PAUSED-AGENTS-VISIBLE: WHEN a "paused" agent is scheduled to auto-resume (epoch ms) —
  // mirrors AgentRecord.resumeAt. Same undefined-when-not-paused contract as pauseReason
  // above. Absent for a pause with no scheduled resume (crash-loop-backoff still stamps one
  // via its own delay, so in practice this is populated for every pause kind the daemon
  // currently emits — but a reader must not assume it, per AgentRecord.resumeAt's own
  // "Present only while state === 'paused'" contract, which says only WHEN paused, not that
  // every pause carries a resume time).
  resumeAt?: number;
  // COVERAGE (agent.status + agent.result): the on-demand detail fetched by
  // store.loadAgentResult() for a (usually finished) agent — the daemon's final
  // result text + the authoritative status record. null until the user asks for
  // it (Ctrl-R); rendered as a bordered block in AgentDetail. Kept off the hot
  // event path (it's a manual fetch, not projected from the subscribe stream).
  resultDetail: AgentResultDetail | null;
  // HOOK-7 (PLAN-HOOKS.md §7): the agent's live event subscriptions, fetched on
  // demand by store.loadSubscriptions (sub.list) when the agent is selected — off
  // the hot event path, exactly like resultDetail above. Undefined until the first
  // fetch resolves; AgentDetail treats absent as none and renders nothing (a plain
  // agent with no subscriptions shows no ⌚ line at all).
  subscriptions?: SubscriptionView[];
  // FEATURE 1 (startup history backfill): true once this agent's full transcript
  // has been lazily backfilled from a per-agent `agent.tail { agentId }` fetch
  // (store.loadHistory, dispatched the first time the agent is selected). The
  // store's global startup replay only tails the last-N events GLOBALLY, so a
  // done agent that finished before this TUI launched has its events evicted
  // from that window and would otherwise show an empty AgentDetail on a fresh
  // start; the per-agent tail restores it. Guards against re-fetching.
  historyLoaded: boolean;
  // TRANSCRIPT-LOADING-STATE: historyLoaded alone conflates "not fetched yet",
  // "fetch in flight" and "fetch failed" into the same `false` — a pane can't
  // tell a genuinely-empty agent from one still loading. "idle" until a
  // backfill fetch starts (installHistoryBackfill / TUI's loadHistory), "loading"
  // while in flight, "loaded" once historyLoaded flips true (kept in lockstep by
  // the backfillHistory reducer case), "failed" when the fetch rejects —
  // historyLoaded itself stays false on failure so the once-per-agent retry
  // contract (a later reselect retries) is untouched.
  historyLoadState: "idle" | "loading" | "loaded" | "failed";
  // The rejection's errorText(), set alongside historyLoadState "failed" — lets
  // the pane show WHY the load failed instead of just "something went wrong".
  historyLoadError?: string;
  // TRANSCRIPT-TAIL-FIRST: the lowest event `seq` currently folded into
  // `transcript` via backfillHistory/prependHistory — null until the first
  // (newest) page lands. prependHistory filters an incoming older batch
  // against this so a retried/duplicate page can never double-prepend rows
  // (see its own doc comment in reducer.ts).
  historyMinSeq: number | null;
  // TRANSCRIPT-WINDOWING (was TRANSCRIPT-TAIL-FIRST's background walk — now
  // scroll-triggered, ONE page per call, see history.ts's loadNextOlderHistoryPage):
  // the fetch lifecycle of the on-demand older-page load that runs behind the
  // newest page (which historyLoadState/historyLoaded already cover). "idle"
  // until the operator scrolls near the top for the first time, "loading"
  // while that page is in flight, "loaded" once it lands (more may still
  // remain — see historyOlderExhausted), "failed" if the fetch rejects (a
  // later near-top scroll retries — see history.ts).
  historyOlderLoadState: "idle" | "loading" | "loaded" | "failed";
  historyOlderLoadError?: string;
  // TRANSCRIPT-EVICT-OLD: whether the operator is currently pinned at/near the
  // bottom of this agent's transcript pane — mirrors useTranscriptScroll's
  // atBottomRef, synced in via the "transcriptAtBottom" action so the reducer
  // (which never touches the DOM) can gate eviction on it. Defaults true: a
  // freshly-selected/never-scrolled pane starts pinned to the tail, same as
  // the scroll hook's own initial atBottomRef value.
  atBottom: boolean;
  // TRANSCRIPT-EVICT-OLD: bumped every time evictTranscriptFront() actually
  // drops rows from the front of `transcript`. history.ts watches this per
  // agent (alongside its own `exhausted` guard) to know eviction just made
  // "older" content exist again and clear the guard — plain equality-compare
  // is enough since it only ever increases, never Date.now/random (reducer
  // purity).
  historyEvictedAt: number;
  // TRANSCRIPT-WINDOWING: true once an older-page fetch has come back short
  // (fewer than a full page) — the true beginning of this agent's on-disk
  // history has been reached, so loadNextOlderHistoryPage stops firing and
  // the pane can render a "— beginning of history —" marker instead of an
  // indefinite "scroll up for more" hint.
  historyOlderExhausted: boolean;
  // Native-CLI-parity Phase 1 (Task N2): the per-agent subagent/workflow tree,
  // folded from agent_task + parented tool_call/tool_result events by
  // flow.ts's applyFlowEvent (see reducer.ts's agent_task/tool_call/tool_result
  // cases). Empty until the first agent_task or parented tool_call arrives.
  flowTree: FlowNode[];
  // Native-CLI-parity Phase 3 (Task SC2): the agent's current slash-command list
  // (see SlashCommandView's own doc comment above). `[]` until the first
  // agent_started/commands_changed event; SC2's App.tsx wiring filters this for
  // the inline "/" autocomplete popup.
  slashCommands: SlashCommandView[];
  // WS-D (parity: surface plugins/skills/mcp read-only): the agent's advertised
  // plugin and skill NAME lists + configured MCP servers, folded from the same
  // SDK system/init the slash-command list rides on (reducer.ts's "agent_started"
  // case, mirroring slashCommands' defensive fold). `plugins`/`skills` are bare
  // name strings; `mcpServers` carries per-server connection health. All `[]`
  // until an agent_started supplies them, so a plain agent renders exactly as
  // before. AgentDetail surfaces them as read-only Chip rows. OPTIONAL (defensive):
  // an AgentView built without them -- an older projection path or a test fixture
  // -- simply omits them, and every reader treats an absent field as `[]` (renders
  // nothing). emptyAgent seeds `[]` for the live projection path so the reducer's
  // folds always have a concrete array to read the prior value from.
  plugins?: string[];
  skills?: string[];
  mcpServers?: McpServerView[];
  // Task STREE: the sub-agent tree this agent belongs to, projected from
  // agent.list's per-record treeId/depth (see AgentRecordLite's own doc
  // comment). undefined until an agentRecords action carries a valid
  // (typeof-checked) value for this agent -- an older daemon build's flat
  // list leaves both undefined, so AgentList renders it exactly as before.
  treeId?: string;
  depth?: number;
  // Task TEAMGROUP: the team this agent belongs to (name + role), projected from
  // agent.list's per-record `membership` (see AgentRecordLite). undefined for the
  // main conductor and any plain agent.spawn -- those render flat/top-level.
  // AgentList groups team workers under a lightweight team header and indents
  // them beneath it (the spawn/ownership hierarchy the daemon already tracks).
  membership?: { team: string; role: string };
  // G1/S1 (ROLES-TAB spec): the session-role NAME this agent was spawned with
  // (`sp.role`, forwarded into supervisor.spawn and stamped on the record/event --
  // see engine.ts:1563-1566, supervisor.ts). This is the session-role usage join's
  // session half (roles.ts's sessionRoleUsage) -- without it a session-role spawn
  // left no trace and the tab couldn't answer "which agents use this role" for half
  // the roles. `undefined` for a plain spawn with no role, an older daemon that
  // predates S1, or a team spawn (those use `membership` instead); `null` is a
  // valid "explicitly no role" wire value. Never assume presence -- every reader
  // (roles.ts, this doc's own join) degrades to "no usage" when absent.
  sessionRole?: string | null;
  // ROLES-UNIFY §3.3: the sparse overrides actually resolved onto this agent's spec at
  // spawn time (AgentSummarySchema.sessionRoleOverrides, protocol index.ts:2086). A FROZEN
  // AUDIT record, not a live template -- operator decision confirmed there is no post-hoc
  // edit RPC (agent/session-side role binding is spawn-time only, unlike a team binding's
  // live-resolved overrides, §4). Feeds a "spawned from `<role>` with: ..." display line and
  // a "spawn another like this" prefill (§6.3/§9.2) -- never a patch-builder target. `undefined`
  // for a plain spawn with no role, an older daemon that predates this field, or S2 not yet
  // landed; `null` is a valid "role resolved with zero overrides" wire value. Never assume
  // presence, mirroring sessionRole's own degrade contract above.
  sessionRoleOverrides?: Record<string, unknown> | null;
  // Task N-SHADOW: true for a synthesized native sub-agent/workflow row; `label`
  // is its friendly name. Projected from agent.list (see reducer's agentRecords
  // case). AgentList shows `label` in place of the shortId for a shadow row.
  shadow?: boolean;
  label?: string;
  // Task SHADOW-ACT: the shadow's live per-task progress (description/last tool/
  // summary/metrics/error), projected verbatim from agent.list. Undefined for a
  // real agent (and for a bare task_started shadow with nothing rich yet), in
  // which case AgentDetail falls back to the normal transcript path. AgentDetail
  // renders it as a live "what it's doing" activity panel for a selected shadow.
  shadowInfo?: ShadowInfo;
  // WD Stage 1 (coverage B2, remote rows): the ORIGIN ENGINE of a remote agent —
  // undefined for every local agent. Two additive sources, both derived (the daemon
  // adds no field: a supervisor record is by definition local, so a record-side
  // engineId would be the constant "local"; remote identity already rides the wire in
  // NormalizedEvent.engineId and in the "<engineId>/<localId>" qualified agent id):
  //   * projectEvent stamps it from a non-"local" event engineId;
  //   * the agentRecords merge parses it off a qualified record id (parseAgentAddress).
  engine?: string;
  // WD Stage 1 (coverage B12, sessions-table branch): the agent cwd's git branch,
  // projected from agent.list's per-record `gitBranch` (supervisor stamps it async at
  // spawn + refreshes on agent.status). Optional/defensive like treeId/membership —
  // an older daemon omits it and the column just stays empty.
  gitBranch?: string;
  // IN-APP-TERMINAL: the agent's effective working directory, projected from agent.list's
  // per-record `workdir` (see AgentRecordLite's own doc comment) — used to open a terminal
  // tab at the right cwd. Optional/defensive like gitBranch: an older daemon omits it.
  workdir?: string | null;
  // SOFT-TURN-LIMIT: true once a turnLimitPolicy:"soft" agent has crossed its
  // nominal maxTurns (projected from agent.list's per-record turnBudgetExceeded,
  // or the live "status" event carrying it — see reducer.ts). `state` stays
  // "running"; this is purely a UI flag (AgentList/AgentDetail render it as a
  // warn-toned "over budget" badge instead of failing the row). Optional/
  // defensive like gitBranch — an older daemon simply omits it.
  turnBudgetExceeded?: boolean;
  // TOOL-SURFACE-MEASURE: mirrors turnBudgetExceeded's own projection convention — set once
  // from agent.list's per-record `toolSurfaceEstimate` or the live "status" event carrying it
  // (core/supervisor.ts AgentRecord.toolSurfaceEstimate; see mcp-tools.ts's
  // estimateChimeraMcpToolSurface for exactly what it does/doesn't cover). Absent for a spawn
  // that never got a chimera MCP grant, or an older daemon that doesn't emit it yet.
  toolSurfaceEstimate?: { source: string; toolCount: number; approxChars: number; approxTokens: number; settingSources: string[]; note: string;
    // F41.UI: the per-server rows behind approxTokens ("chimera-core" / "chimera-conductor" /
    // a tool tag). core's AgentRecord.toolSurfaceEstimate now declares bySource too
    // (F41.QA-FIX) — stays optional here only for cross-version skew against an older daemon
    // binary's persisted record, not because the current type lies about the shape.
    bySource?: readonly { source: string; toolCount: number; approxChars: number; approxTokens: number }[] };
  // TOOL-SURFACE-MEASURE: the real billed cache-write size of this agent's first turn
  // (core/supervisor.ts AgentRecord.toolSurfaceCacheWriteTokens) — measured usage, not an
  // estimate, and covers the WHOLE first-turn prompt (instructions + tool defs + any ambient
  // MCP catalog), not exclusively tools. Absent until the first turn's usage lands.
  toolSurfaceCacheWriteTokens?: number;
  // TOOL-SURFACE-MEASURE / F41: rides the SAME agent.list snapshot (AgentRecord.toolSurfaceServers).
  // The server set toolSurfaceCacheWriteTokens above was measured over — that figure means nothing
  // without it. Optional/defensive: absent for an older daemon or a backend that reports no servers.
  toolSurfaceServers?: readonly string[];
  // P3-T2 (project-conductor routing, PLAN-PROJECT-CONDUCTOR-ROUTING.md): the
  // REAL spawner id (P3-T1's AgentRecord.parentId), rides the same agent.list
  // snapshot as treeId/depth. `null` means "no spawning agent" (a genuine root
  // spawn); `undefined` means an older daemon that doesn't emit the field yet —
  // treeOrder falls back to its depth+createdAt heuristic in that case (see
  // reducer.ts). Authoritative-when-present, mirroring gitBranch/shadowInfo.
  forkLineage?: import("@chimera/protocol").ForkLineage;
  parentId?: string | null;
  originConductorId?: string | null;
  /** Derived inspector indentation; wire depth remains real spawn depth. */
  displayDepth?: number;
  // P3-T2: the project this agent belongs to (P3-T1's AgentRecord.projectId,
  // explicit or derived from cwd), rides the same snapshot. `null` = no
  // project (matches the legacy single-conductor world); `undefined` = an
  // older daemon that omits the field. Feeds conductorByProject below.
  projectId?: string | null;
  // REMOTE-CONTROL: last known status of the provider's native remote-control bridge
  // on this agent's live session, projected from the "status" event's `remoteControl`
  // field (AgentSupervisor.remoteControl appends it on every toggle — see reducer.ts).
  // undefined until the agent's remote control has been toggled at least once this
  // session; a backend with no live control surface for it never emits the event.
  remoteControl?: Omit<import("@chimera/protocol").RemoteControlStatus, "agentId" | "provider">;
};

// Task SHADOW-ACT: mirrors core's ShadowInfo (supervisor.ts). All optional — an
// older daemon omits any field, and AgentDetail reads each defensively.
// R2 (inline sub-agent/workflow surfacing): subagentType/workflowName preserve which of the two
// the row's flattened `label` derivation read — lets the UI render a sub-agent card vs. an
// attached-workflow view distinctly instead of guessing from the label string.
export type ShadowInfo = {
  description?: string; lastToolName?: string; summary?: string;
  totalTokens?: number; toolUses?: number; durationMs?: number; error?: string;
  subagentType?: string; workflowName?: string;
};

// COVERAGE: the shape store.loadAgentResult() stashes on an AgentView — `result`
// is agent.result's `{ state, text?, costUsd }`; `status` is the raw agent.status
// AgentRecord (rendered defensively, so field drift never crashes the pane).
export type AgentResultDetail = {
  result: { state: string; text?: string; costUsd: number };
  status: Record<string, unknown>;
};

export type PendingPermission = { requestId: string; agentId: string; toolName: string; input: unknown; ts: number };

// FEATURE-9 (attention inbox): a live per-task projection folded from the `status`
// events QueueStore.emitTask fires on every task state transition (packages/core/src/
// queues.ts) — the task/queue-state analogue of AgentView.state, since ui-state
// previously tracked NO task state at all (queue drill-in was the only source, on
// demand only). Keyed by taskId in UiState.tasks below; latest status event wins (no
// history kept -- stepHistory detail lives server-side only).
export type TaskLite = {
  taskId: string;
  queue: string;
  state: TaskState;
  agentId: string | null;
  attempts: number;
  priority: number;
  error?: string | null;
  subject: string;
  updatedAt: number;
};

// HOOK-6: a lifecycle-hook rule's live activity, folded from the event stream
// (hook_fired / hook_suppressed under the synthetic "hooks" agentId). The HooksCard
// renders lastFired/lastSuppressed timestamps + the last suppression reason next to
// each rule, the way the notify card shows its own derived state. Purely additive —
// a rule that has never fired simply has no entry.
export type HookStatus = {
  lastFired?: number;        // ts of the most recent hook_fired for this rule
  fireCount: number;         // hook_fired count seen this session
  lastSuppressed?: number;   // ts of the most recent hook_suppressed
  suppressCount: number;     // hook_suppressed count seen this session
  lastSuppressReason?: string;
};

// Task AUTH-b: authExpired is additive/optional -- an older daemon build that
// doesn't send it leaves it undefined, so AccountsPane renders exactly as before.
// ACCOUNT-QUOTA-METERS: quota is additive/optional exactly like authExpired above -- an older
// daemon build that doesn't send it, an unsupported auth type, or a source that has not returned
// a usable window yet leaves it undefined and the UI renders "unknown" rather than a fake fill.
export type AccountStatus = { name: string; provider: string; authType: string; cooling: boolean; coolingUntil: number | null; authExpired?: boolean; quota?: AccountQuota; quotaReason?: AccountQuotaReason };

// FC-2 (F4-display): daemon.status's federation peers (engine.ts:194, empty [] when
// unfederated) -- surfaced in StatusBar alongside accounts.
export type PeerStatus = { engineId: string; state: string; outboxPending: number };

// CONCURRENCY-CAP-UI: daemon.status's `agentCap` (engine.ts, DynamicCapTracker.effectiveCap) --
// the live admission-cap snapshot the Settings concurrency control renders. `cap` is the
// effective admission cap RIGHT NOW (== ceiling when dynamic is off/not narrowing); `ceiling` is
// registry.maxTotal() (== config caps.maxAgentsTotal). `explain` is the human-readable live-input
// string ("load 11.4/12 cores, 3.2 GB free") -- never recompute this client-side, it mirrors the
// same string the admission refusal error carries.
export type AgentCapStatus = {
  cap: number;
  ceiling: number;
  healthy: boolean;
  cpuPressure: boolean;
  memPressure: boolean;
  load1: number | null;
  cores: number | null;
  freeMemGb: number | null;
  explain: string;
};

// COVERAGE (accounts.list): a raw account record from accounts.list. The registry
// returns { name, provider, auth: { type, ... } } — kept loosely typed and read
// defensively by AccountsPane (authType via auth.type), so daemon-side field drift
// never crashes the pane. Distinct from AccountStatus (daemon.status's cooling-
// augmented projection the StatusBar already shows): this is the fuller auth-detail
// list, loaded on demand when the accounts overlay opens.
export type AccountInfo = Record<string, unknown>;

// COVERAGE (team.status): the team.status drill-in payload — the team spec, the
// running-agent count, and each running agent's status record. Loosely typed for
// the same defensive-render reason as AccountInfo.
// TEAM-STATS: totalRuns is optional here (not on the wire response type) so a
// mock/fixture predating this field still type-checks — read defensively
// (num()-style fallback to 0) at every call site, never assume it's present.
export type TeamStatusView = { spec: Record<string, unknown>; running: number; agents: Array<Record<string, unknown>>; totalRuns?: number };

// COVERAGE (queue.status): the queue.status drill-in payload — the queue spec,
// per-state task counts, and the task records themselves (each is a TaskRecord;
// read defensively).
export type QueueStatusView = { spec: Record<string, unknown>; counts: Record<string, number>; tasks: Array<Record<string, unknown>> };

// COVERAGE: a pending destructive action awaiting the confirm overlay's y/n. Every
// irreversible daemon call (team.dissolve, queue.cancelTask, daemon.stop) routes
// through this single guard so no keystroke ever fires one un-confirmed.
export type ConfirmAction =
  | { kind: "dissolveTeam"; name: string }
  | { kind: "cancelTask"; taskId: string; queue: string }
  // D11/F15 (W16 CRUD completion): queue.delete is only OFFERED once the
  // caller has already confirmed zero pending/in_progress tasks client-side
  // (the engine re-checks and refuses regardless — this is just so the
  // confirm card never even opens for a queue that's about to be refused).
  | { kind: "deleteQueue"; name: string }
  | { kind: "killAgent"; agentId: string; label: string }
  // CLOSE-CONFIRM: agent.close ends a session irreversibly (the next message
  // lazily respawns a fresh one with no memory of this session) — gated the
  // same way killAgent is, in both app (mod+shift+w closeMain) and tui (ctrl+w).
  | { kind: "closeAgent"; agentId: string; label: string }
  // Ad-hoc sessions design §6 "close all sessions" — batch-destructive (kills every
  // currently running/paused session-marked agent), gated the same way killAgent is.
  | { kind: "closeAllSessions" }
  // PURGE-TERMINAL-SESSIONS: forgets FINISHED agents (records + their archived copy and mailbox),
  // the counterpart to closeAllSessions above which ENDS live ones.
  | { kind: "purgeTerminalSessions" }
  | { kind: "stopDaemon" }
  // F50.UI: budget.resume is operator-only and AUDITED (one ledger record per call), and a
  // release re-arms the watermark at whatever is booked at that instant — so a stray double
  // fire is not idempotent. Both UIs route the resume through this one gate; the carried
  // figures are what the confirm card must state before the operator commits.
  | { kind: "resumeBudget"; treeId: string; label: string; totalCostUsd: number; estimatedUsd: number; maxBudgetUsd: number }
  // ROLES-TAB S4 (spec §2/§3): user-created session-role delete is a real, irrecoverable
  // delete (future spawns referencing it fail); builtin "delete" is really a reset-to-
  // pristine (never a true delete -- SessionRoleStore reseeds any missing builtin).
  | { kind: "deleteSessionRole"; name: string }
  | { kind: "resetBuiltinRole"; name: string }
  // §3: explicit team-role removal, never a construction-from-omission patch.
  | { kind: "removeTeamRole"; team: string; role: string }
  // §4: detach a shared-role copy, keeping it as a plain team-local role.
  | { kind: "detachTeamRole"; team: string; role: string }
  // §2 form modality (dirty-close guard, mirrors WorkflowStudio's discard confirm).
  | { kind: "discardRoleForm" }
  // `agentId` is the transcript the operator took the action FROM (the app acts from the
  // holder's own detail panel; the TUI acts from the DENIED agent's seat) — it is where the
  // resulting system line lands, never an RPC argument.
  // F22.UI: taking a single-writer worktree lease away from its holder, or releasing it. Both
  // are destructive to ANOTHER agent (the loser's next write is refused mid-turn with no
  // warning), and release --force can drop a lease a live agent still believes it holds —
  // so both route through this same gate. `label`/`ownerLabel` are display-only.
  | { kind: "worktreeLeaseHandoff"; agentId: string; workdirKey: string; toAgentId: string; label: string; ownerLabel: string }
  | { kind: "worktreeLeaseRelease"; agentId: string; workdirKey: string; force: boolean; ownerLabel: string };

// Task STREE: the daemon's agent.list snapshot (supervisor.list verbatim)
// already carries per-record `treeId`/`depth` -- optional here (defensive:
// an older daemon build omitting them must still type-check and render a
// flat list, see reducer.ts's treeOrder/agentRecords case and AgentList.tsx's
// indent). `treeId === agentId` marks a tree's root; `depth` is its nesting
// level under the MCP `agent_spawn` chain that created it.
// Task TEAMGROUP: `membership` rides along on the SAME agent.list snapshot
// (supervisor.list returns the full AgentRecord, and scheduler team spawns
// stamp membership -- see scheduler.ts's spawnForTask). Optional/defensive: a
// plain agent.spawn (and the main conductor) has none, so it stays undefined
// and the agent renders flat/top-level exactly as before.
// Task N-SHADOW: `shadow`/`label` ride on the SAME agent.list snapshot for a
// native sub-agent/workflow "shadow" row (see supervisor.ts's AgentRecord.shadow).
// A shadow carries treeId+depth like any agent, so treeOrder nests it beneath its
// parent; AgentList shows `label` (subagentType/workflowName/description) instead
// of the raw `shadow:...` id. Optional/defensive: a real agent has neither, so it
// renders exactly as before.
export type AgentRecordLite = {
  agentId: string; state: string; accountName: string; provider: string;
  permissionApplication?: PermissionApplication;
  displayLabel?: string;
  // CONDUCTOR-FULL-ACCESS: agent.list returns the FULL AgentRecord (spec included), so the
  // agent's live permission scope already rides this snapshot — no new RPC field needed.
  // `permissionProfile` sits directly on the spec; the request-routing mode sits under
  // `spec.on.permissionRequest` (see protocol AgentSpecSchema). Both optional/defensive: an
  // older daemon's agent.listSummary path drops the spec entirely, leaving them undefined.
  costUsd: number; createdAt: number;
  spec?: { conductor?: boolean; session?: boolean; displayLabel?: string; permissionProfile?: string; on?: { permissionRequest?: string } };
  treeId?: string; depth?: number; membership?: { team: string; role: string };
  // ROLES-TAB S1: rides the SAME agent.list snapshot (AgentRecord.sessionRole).
  // Optional/defensive: absent for an older daemon / a non-session-role spawn.
  sessionRole?: string | null;
  // ROLES-UNIFY §3.3: rides the SAME agent.list snapshot (AgentRecord.sessionRoleOverrides) —
  // the sparse overrides actually resolved at spawn, a frozen audit record.
  sessionRoleOverrides?: Record<string, unknown> | null;
  shadow?: boolean; label?: string;
  // Task SHADOW-ACT: rides the SAME agent.list snapshot (supervisor.list returns the
  // full AgentRecord incl. shadowInfo). Optional/defensive: absent for a real agent.
  shadowInfo?: ShadowInfo;
  // WD Stage 1 (coverage B12): rides the SAME agent.list snapshot (AgentRecord.gitBranch,
  // stamped async by the supervisor). Optional/defensive: absent until the probe lands
  // (or forever, for a non-git cwd / older daemon).
  gitBranch?: string;
  // SOFT-TURN-LIMIT: rides the SAME agent.list snapshot (AgentRecord.turnBudgetExceeded).
  // Optional/defensive: absent for a "fail"-policy agent or an older daemon.
  turnBudgetExceeded?: boolean;
  // TOOL-SURFACE-MEASURE: rides the SAME agent.list snapshot (AgentRecord.toolSurfaceEstimate /
  // .toolSurfaceCacheWriteTokens). Optional/defensive: absent for an older daemon, a spawn with
  // no chimera MCP grant (estimate), or before the first turn's usage lands (cache-write).
  toolSurfaceEstimate?: { source: string; toolCount: number; approxChars: number; approxTokens: number; settingSources: string[]; note: string;
    // F41.UI: the per-server rows behind approxTokens ("chimera-core" / "chimera-conductor" /
    // a tool tag). core's AgentRecord.toolSurfaceEstimate now declares bySource too
    // (F41.QA-FIX) — stays optional here only for cross-version skew against an older daemon
    // binary's persisted record, not because the current type lies about the shape.
    bySource?: readonly { source: string; toolCount: number; approxChars: number; approxTokens: number }[] };
  toolSurfaceCacheWriteTokens?: number;
  // TOOL-SURFACE-MEASURE / F41: rides the SAME agent.list snapshot (AgentRecord.toolSurfaceServers).
  // Optional/defensive: absent for an older daemon or a backend that reports no servers.
  toolSurfaceServers?: readonly string[];
  // P3-T2: rides the SAME agent.list snapshot (AgentRecord.parentId/projectId,
  // P3-T1). See AgentView's own doc comment for the optional/defensive contract
  // (undefined = older daemon; null = a real "no parent"/"no project" value).
  forkLineage?: import("@chimera/protocol").ForkLineage;
  parentId?: string | null;
  originConductorId?: string | null;
  projectId?: string | null;
  // R2 (ctx meter effective-limit): rides the SAME agent.list snapshot
  // (AgentRecord.effectiveContextLimit). Optional/defensive: absent for an older daemon build
  // that predates this field. See AgentView.effectiveContextLimit's own doc comment.
  effectiveContextLimit?: number;
  contextLimits?: CodexContextLimits;
  // IN-APP-TERMINAL: rides the SAME agent.list snapshot (AgentSummary.workdir, core's
  // resolveWorkdirPath — the agent's worktree when one exists, else spec.cwd). Optional/
  // defensive like gitBranch: absent for an older daemon.
  workdir?: string | null;
  // DENIED-TOOL-CALL-INVISIBLE: rides the SAME agent.list/listSummary snapshot
  // (AgentRecord.toolPolicyDenied / .lastToolPolicyDenial). Optional/defensive: absent for an
  // older daemon or an agent that never hit a host-tool-policy deny. `lastToolPolicyDenial` is
  // only present on the FULL agent.list snapshot (agent.listSummary's AgentSummary carries just
  // the boolean, per its own token-discipline doc) — a listSummary-only poll still gets the
  // boolean chip, just not the tool/profile detail.
  toolPolicyDenied?: boolean;
  lastToolPolicyDenial?: { tool: string; profile: string | null; profileUnresolved?: boolean; requestId: string; at: number };
  // F22: rides the SAME agent.list/listSummary snapshot (AgentRecord.worktreeLeaseHeld is
  // LIVE-derived by the engine, never stamped; .worktreeLeaseDenied/.lastWorktreeLeaseDenial are
  // stamped on refusal). See AgentView's own doc comment for the held-vs-denied merge contrast.
  worktreeLeaseHeld?: boolean;
  worktreeLeaseDenied?: boolean;
  lastWorktreeLeaseDenial?: { tool: string; workdirKey: string; owner: string; ownerState: "active" | "retained"; target: string; requestId: string; at: number };
  // JOB-FLEET-GROUPING: rides the SAME agent.list snapshot (AgentRecord.jobName). Optional/
  // defensive: absent for an older daemon or a spawn with no owning job. See AgentView's own
  // doc comment for the fuller rationale.
  jobName?: string | null;
  // AGENT-GROUPS Phase 1: rides the SAME agent.list snapshot (AgentRecord.groups). See
  // AgentView's own doc comment for the fuller rationale (including the live re-emit path).
  groups?: string[];
  // F47: rides the SAME agent.list snapshot (AgentRecord.attentionAt/.reviewedAt). Optional/
  // defensive like gitBranch: absent for an older daemon or an agent with no attention history.
  attentionAt?: number;
  reviewedAt?: number;
  // PAUSED-AGENTS-VISIBLE: rides the SAME agent.list snapshot (AgentRecord.pauseReason/
  // resumeAt — supervisor.ts's list() returns the raw record, so these already ride the wire
  // today; only the client-side type/fold was missing). See AgentView's own doc comment.
  pauseReason?: PauseReason;
  resumeAt?: number;
  // F08: rides the SAME agent.list snapshot (AgentRecord.failure) — optional/defensive: absent
  // for an older daemon or an agent that never failed. See AgentView's own doc comment.
  failure?: FailureView;
  // F09: rides the SAME agent.list snapshot (AgentSummary.promptStalled). Boolean-only here,
  // mirroring toolPolicyDenied above — the full PromptStall record lives on agent.status only.
  promptStalled?: boolean;
};

// W7 (coverage B12): "projects" joins the TabId union for the desktop app's
// six-slot strip. TAB_ORDER deliberately does NOT include it — the TUI's tab
// bar/cycling reads TAB_ORDER and must stay a five-tab surface (its suite is
// locked); the app binds the projects slot through its own keymap/TopBar
// handlers, never through the TAB_ORDER-driven tabNext/tabPrev built-ins.
// W9 (coverage B15/B16): "settings" joins the union the SAME app-only way —
// the desktop strip's 7th slot (1 agents … 7 settings). It is NOT added to
// TAB_ORDER, so the TUI's five-tab cycling surface and its locked reducer suite
// are untouched (the TUI renders its own settings slot app-locally via its
// TopTabId, never as a reducer TabId); the app dispatches selectTab {tab:
// "settings"} from its TopBar registration + digit-7 chord, never through the
// TAB_ORDER-driven tabNext/tabPrev built-ins.
// FEATURE-9 (attention inbox): "inbox" joins the union the SAME app-only way as
// projects/settings above — the desktop strip's 8th slot. NOT added to TAB_ORDER.
// ROLES-TAB S4: "roles" joins the union the SAME app-only way -- NOT added to
// TAB_ORDER (§7 of the spec: the TUI's 5-tab ring is locked by its own
// convention). The app tab itself is S5; a full TUI view is the optional S7.
// F13.2: "runs" (the unified run-history screen) joins the union the same
// app-only way -- an 11th slot on mod+shift+h, NOT in TAB_ORDER (the TUI reaches
// run history through an overlay pane, not a sixth tab).
export type TabId = "teams" | "agents" | "queues" | "events" | "memory" | "projects" | "settings" | "inbox" | "slo" | "roles" | "runs";
export const TAB_ORDER: readonly TabId[] = ["agents", "teams", "queues", "events", "memory"];
// F05: the global event feed keeps a 5k in-memory ring; older history is paged
// on demand from events.jsonl via the events.replay RPC (EventsScreen), so the
// live cap trades a little memory for a long, scrollable session tail.
export const EVENT_BUFFER_MAX = 5000;
// TUI-008 (MAJOR): reducer.ts clones the FULL per-agent transcript/tools arrays on
// EVERY event (`transcript: [...prev.transcript]` etc.) -- unlike the global `events`
// ring buffer, these were previously unbounded, making a long-lived conductor's
// per-event clone cost (and memory) grow without bound (O(n^2) over a session).
// Capped generously so scrollback stays ample for real usage while growth (and the
// per-event clone cost, since the array size feeding the next clone is now bounded
// too) is bounded.
export const TRANSCRIPT_BUFFER_MAX = 2000;
export const TOOLS_BUFFER_MAX = 1000;

export type LiveboardLane = {
  agentId: string;
  follow: boolean;
  unread: number;
};

// W7 (coverage B1 row 3, the events-tab badge): counters of the decision/
// failure events the user has NOT seen because the events tab wasn't active
// when they arrived — permission_request / agent_question / error, mirroring
// the coverage contract ("görülmemiş permission+question+error sayısı").
// Folded by the reducer's event projection ONLY while activeTab !== "events"
// (an on-screen event is seen by definition) and reset to zero by any tab
// switch that LANDS on "events" (selectTab or a tabNext/tabPrev cycle).
export type UnseenCounts = { permissions: number; questions: number; errors: number };

/** Serializable cross-screen navigation intent. The reducer applies the parts it
 * owns and leaves the target parked for an app-side consumer to finish any RPC
 * drill-in (for example resolving a task id to queue.status). */
export type DeepLink =
  | { kind: "tab"; tab: TabId }
  | { kind: "agent"; agentId: string }
  | { kind: "project"; name: string }
  | { kind: "team"; name: string }
  | { kind: "queue"; name: string }
  | { kind: "task"; taskId: string; queue?: string }
  | { kind: "event"; seq: number }
  | { kind: "memory"; id: string }
  | { kind: "artifact"; id: string; taskId?: string; agentId?: string }
  | { kind: "workflow"; name: string; failedOnly?: boolean }
  | { kind: "settings"; section?: string }
  | { kind: "mcpTool"; name: string };

export type NavigationState = { requestId: number; target: DeepLink | null };
export type ReviewRoomState = {
  openTaskId: string | null; loading: boolean; error: string | null;
  evidenceByTask: Record<string, TaskEvidence>; sessionsByTask: Record<string, ReviewSession>;
  // review.get is a NEWER rpc than evidence.get — against an older daemon it 404s
  // (unknown method) while evidence.get still succeeds. sessionError carries that
  // degraded-but-not-fatal state for the CURRENTLY open task only (mirrors
  // loading/error, not a per-task cache like evidenceByTask/sessionsByTask) so the
  // screen can render the diff and a friendly "review unavailable" rail note
  // instead of taking the whole room down.
  sessionError: string | null;
  selectedPath: string | null; selectedHunkId: string | null; selectedFindingId: string | null;
  focus: "files" | "diff" | "findings" | "decision";
};

// TASK-EDIT-VERSIONING: the in-flight edit target for the queued-task edit form.
// Holds the taskId/queue to route the queue.editTask RPC, plus the prefilled
// scalar values as strings so CoordForm can seed its initial fields directly.
export type EditTaskTarget = {
  taskId: string;
  queue: string;
  prompt: string;
  role: string;
  priority: string;
};

// IN-APP-TERMINAL Task 4: tab/dock state for the embedded PTY terminal (Tasks
// 2-3 own the Rust side, Task 5 the xterm view, Task 6 the dock chrome).
// `exited` is set only on a NON-zero exit — a zero-code exit removes the tab
// outright (same as an explicit close), so the operator only ever sees an
// `exited` badge for a real failure, never a spurious one on a clean quit.
export type TerminalTab = { id: string; title: string; cwd: string; agentId: string | null; exited: { code: number | null } | null };
// TERMINAL-DOCK-PER-AGENT: `tabs` stays ONE flat list (every tab's TerminalView must stay
// mounted regardless of the selected agent, or switching agents would kill live PTYs — see
// TerminalView.tsx's unmount cleanup) but `activeId`/`dockOpen` are now keyed BY AGENT so one
// agent's dock/tabs never leak into another's. `dockHeight` stays global — a layout
// preference, not per-agent data. A tab with `agentId: null` is deliberately UNREACHABLE
// through these maps (never rendered by any agent's dock, never killed either) rather than
// bucketed under a shared key — see reducer.ts's terminal cases.
export type TerminalState = {
  tabs: TerminalTab[];
  activeByAgent: Record<string, string | null>;
  openByAgent: Record<string, boolean>;
  dockHeight: number;
};

export type UiState = {
  connected: boolean;
  // TUI-007 (MAJOR): true while ChimeraStore's guarded reconnect loop is running
  // (client dropped, awaiting reconnectFn + re-subscribe). StatusBar renders this
  // as a third (yellow) state between the green "connected" and red "disconnected".
  reconnecting: boolean;
  protocolVersion: number | null;
  agentCounts: { running: number; paused: number; done: number; failed: number; killed: number };
  accounts: AccountStatus[];
  // FC-2 (F4-display): federation peers from daemon.status; [] when unfederated.
  peers: PeerStatus[];
  // F49.UI: agentIds holding a loopback-MCP grant as of the last daemon.status poll.
  // null means "never observed" so the first poll seeds silently instead of announcing
  // every already-live client as a fresh connection.
  mcpListenerGrantAgents: readonly string[] | null;
  // F01-QA-follow-up: last wakeScheduling seen from daemon.status; null means "never polled"
  // (TUI-only client before its first refresh() tick) rather than "unavailable".
  wakeScheduling: WakeScheduling | null;
  agents: Record<string, AgentView>;
  agentOrder: string[];
  pendingPermissions: PendingPermission[];
  // FEATURE-9 (attention inbox): live per-task projection, keyed by taskId — see
  // TaskLite's own doc comment above. Folded in reducer.ts from `status` events on
  // synthetic `task:<id>` agentIds (the same namespaced-id branch that already
  // handles task_step_advanced/checkpoint_created).
  tasks: Record<string, TaskLite>;
  // HOOK-6: per-rule lifecycle-hook status, folded from hook_fired/hook_suppressed
  // events (agentId "hooks", never a real agent). Keyed by rule name — the HooksCard
  // reads lastFired/lastSuppressed to show a rule's live activity, exactly as the
  // notify card derives its own state from the event stream. Additive: a daemon that
  // never fires a hook leaves this an empty map.
  hooks: Record<string, HookStatus>;
  workflowStudio: WorkflowStudioState;
  reviewRoom: ReviewRoomState;
  events: NormalizedEvent[];            // ring buffer, newest last
  lastSeq: number;
  teams: { available: boolean; items: Array<Record<string, unknown>> };
  queues: { available: boolean; items: Array<Record<string, unknown>> };
  // ROLES-TAB S4: mirrors teams/queues exactly -- `items` holds session-role
  // records (role.list, loose like teams/queues above) for the app tab (S5) and
  // roles.ts's join to read. `available` false until the first fetch resolves /
  // for an older daemon that lacks role.list (§6 tryPhase2 degradation, S5's job).
  roles: { available: boolean; items: Array<Record<string, unknown>> };
  // AGENT-GROUPS Phase 1: the operator-defined group REGISTRY (group.list) — mirrors
  // roles/teams/queues exactly (`available` false until the first fetch resolves / for an
  // older daemon that lacks group.list). Membership itself lives per-agent on AgentView.groups
  // (folded from the live event stream, see reducer.ts's foldAgentIdentity); this is only the
  // id->name/color registry app-local commands.groups.ts fetches and CRUDs.
  groups: { available: boolean; items: AgentGroup[] };
  // AGENT-GROUPS Phase 1: which group box the operator is currently working in, if any — a
  // spawn triggered while a box is focused inherits it (spec.groups). Client-VIEW state only,
  // never daemon-persisted (mirrors selectedAgentId's own scope) — set by clicking a group
  // box's header, cleared by clicking the main tree / another unrelated surface.
  activeGroupId: string | null;
  activeTab: TabId;
  navigation: NavigationState;
  // W7 (coverage B1 row 3): see UnseenCounts above. Additive — the TUI never
  // reads it, so its projection stays behavior-identical.
  unseen: UnseenCounts;
  selectedAgentId: string | null;
  /** AGENT-MARK: the agents ticked for a BATCH action, independent of `selectedAgentId`.
   *
   *  Two selections on purpose. `selectedAgentId` is "the one I am looking at" and drives the
   *  transcript; marking is "the set I am about to act on". Folding them together would mean
   *  reading an agent's transcript could not help changing what a kill applies to. */
  markedAgentIds: readonly string[];
  // COLLAPSIBLE SUB-AGENTS: the set of agentIds whose subtree is folded away in
  // the AgentList. A collapsed parent still renders (with a ▸ affordance); only
  // its descendants are hidden (buildAgentRows skips them). Defaults to EMPTY, so
  // tick-0 renders byte-identically. A stale id (an agent that later leaves
  // agentOrder) is simply inert -- buildAgentRows never re-encounters it -- so it
  // needs no pruning, exactly like the flow pane's own `flowCollapsed` set.
  collapsed: Set<string>;
  /** F47.UI: the TUI's attention-only fleet view — when true the AgentList shows just the agents
   *  with unread activity (plus their ancestors). Lives in shared state, NOT component-local
   *  React state, because the TUI's mouse hit-testing (agentRowInfoAt) and the reducer's
   *  ↑/↓ visible-order mirror both rebuild the row list from UiState alone: a filter only the
   *  component knew about would make clicks and arrow keys land on rows nobody can see.
   *  Defaults to false, so an untouched session renders byte-identically. The app keeps its own
   *  persisted toggle (localStorage) and never writes this. */
  unseenOnly: boolean;
  /** F08.UI: the TUI's needs-operator fleet view — just the agents whose failure disposition
   *  says the engine has no automatic remedy left (plus their ancestors). Same
   *  lives-in-shared-state rationale as unseenOnly above, and the same false default. */
  needsOperatorOnly: boolean;
  /** The bounded fleet liveboard. Transcript data remains on AgentView. */
  liveboardLanes: LiveboardLane[];
  // COVERAGE: extended past "normal"/"spawn" with the input-owning overlays this
  // task adds. Any non-"normal" mode both deactivates the always-on compose input
  // and makes App's main useInput bow out (spawn/teamForm/queueForm/pushForm each
  // mount their own useInput; "confirm" is handled inline in App). The compose-
  // active gate (App.tsx) is `mode === "normal" && !question`, so every value here
  // correctly steals focus.
  // MEMORY TAB: "memoryForm" is the add-a-note form (CoordForm), mirroring the
  // teamForm/queueForm/pushForm modes exactly — it deactivates the compose input
  // and makes App's main useInput bow out so CoordForm owns its own keys.
  // TASK-EDIT-VERSIONING: "editForm" is the edit-a-queued-task form (CoordForm),
  // mirroring pushForm exactly — it deactivates the compose input and makes App's
  // main useInput bow out so CoordForm owns its own keys. Opened by `e` on a
  // pending/blocked cursor task in the Queues drill-in.
  // ROLES-TAB S4: "roleForm" mirrors teamForm/queueForm exactly -- it deactivates
  // the compose input and makes App's main useInput bow out so CoordForm (or the
  // app's own RoleFormCard, S5) owns its own keys. No app screen opens it yet
  // (that's S5); the union member exists now so S4's confirm plumbing (the
  // "discardRoleForm" dirty-close guard) type-checks against a real mode value.
  mode: "normal" | "spawn" | "teamForm" | "queueForm" | "pushForm" | "confirm" | "memoryForm" | "editForm" | "roleForm";
  // COVERAGE: list cursors for the Teams/Queues panes and the per-queue task list.
  // The always-on compose input owns Enter + printable keys, so selection is driven
  // by the arrow keys (which TextField ignores) and drill-in/actions by Ctrl-keys.
  teamCursor: number;
  queueCursor: number;
  taskCursor: number;
  // ROLES-TAB S4: mirrors teamCursor -- the Roles tab's one master-list cursor
  // (§1: "one cursor, one detail pane" across the session/team sections).
  roleCursor: number;
  // COVERAGE: open drill-in payloads. Non-null ⇒ the Teams/Queues pane renders the
  // detail view instead of the list. Loaded on demand (Ctrl-T) and refreshed after
  // a mutation (queue.push / queue.cancelTask). Both render INSIDE middleHeight, so
  // they add no chrome rows (unlike the SpawnForm overlay).
  teamDetail: TeamStatusView | null;
  queueDetail: QueueStatusView | null;
  // COVERAGE (queue.push): the queue name the push-task form targets (set when the
  // form opens from a queue drill-in).
  pushQueue: string | null;
  // TASK-EDIT-VERSIONING: the task being edited (set when the edit form opens from
  // a queue drill-in). Carries the target taskId/queue plus the prefilled scalar
  // values (prompt/role/priority as strings, ready to seed CoordForm's initial
  // fields). Null when no edit is in flight. Mirrors pushQueue's lifecycle.
  editTask: EditTaskTarget | null;
  // TASK-EDIT-VERSIONING: the read-only version-history overlay. When true,
  // TaskVersionsPane renders the cursor task's versions[] over the Queues tab
  // (read-only, so compose stays live — mirrors accountsOpen/helpOpen exactly).
  versionsOpen: boolean;
  // TASK-DETAIL: the read-only result/dependsOn overlay for the cursor task.
  // Both fields already live on the full TaskRecord queue.status returns, so
  // opening this needs no extra fetch — mirrors versionsOpen exactly.
  taskDetailOpen: boolean;
  // COVERAGE (accounts.list): the accounts overlay. `accountsOpen` renders
  // AccountsPane over whatever tab is active (read-only, so compose stays live);
  // `accountList` is the on-demand accounts.list payload.
  accountsOpen: boolean;
  accountList: AccountInfo[];
  // HELP overlay: when true, HelpPane renders the full keyboard-shortcut
  // reference over whatever tab is active (read-only, so compose stays live,
  // exactly like accountsOpen above). Toggled by `?`. The footer legend only
  // carries a tiny hint now — the authoritative list lives in the overlay.
  helpOpen: boolean;
  // A2A-UX-OVERHAUL: the ⇄ a2a history overlay. When true, A2AHistoryPane renders
  // the recent inter-agent exchange list over whatever tab is active (read-only,
  // so compose stays live — mirrors helpOpen exactly). Replaces the retired pinned
  // a2a ticker's "enter → a2a history" affordance; reached now via the command
  // palette (`a2a`) and a keybinding. TUI-only overlay flag (the app tracks its
  // own a2aHistoryOpen in projectsLocal); additive for the app, which ignores it.
  a2aHistoryOpen: boolean;
  // PARITY WS-C: the command palette. `paletteOpen` renders CommandPalette (a
  // fuzzy, searchable list over the builtinCommands catalog) over whatever tab
  // is active; `paletteQuery` is the live fuzzy-filter query typed into it.
  // Mirrors helpOpen/accountsOpen exactly (read-only-over-the-tab, App owns its
  // keys) -- both default closed/empty so tick-0 renders byte-identically. The
  // highlighted-row cursor stays App-local (like slashIndex), reset on open/type.
  paletteOpen: boolean;
  paletteQuery: string;
  // PARITY WS-F: the MCP TOOL PALETTE. When true, McpToolPalette renders over the
  // middle area -- a browse+invoke surface for the Chimera daemon-RPC tools. It is
  // a SELF-OWNED modal (like the spawn/coord forms): App early-returns while it is
  // open and the component owns every keystroke, so no query/index lives here (its
  // list-filter + form state are component-local, reset fresh on each open since
  // it is mounted only while open). Defaults closed so tick-0 renders identically.
  mcpPaletteOpen: boolean;
  // COVERAGE (agent.status + agent.result): when true, an AgentResultPane overlay
  // renders the selected agent's fetched resultDetail over the middle area. Kept a
  // separate full-pane overlay (rather than inlined into AgentDetail) so
  // AgentDetail's load-bearing transcript flex/clip math (computeTranscriptN) stays
  // untouched.
  resultOpen: boolean;
  // COVERAGE: the pending confirm-gated destructive action, paired with mode
  // "confirm". null when no confirmation is in flight.
  confirm: ConfirmAction | null;
  lastError: string | null;              // last failed command RPC, surfaced in the App footer (Task 11)
  // TUI-042 (MINOR): a dedicated channel for INFORMATIONAL messages (e.g. the
  // conductor account/respawn notices) that must NOT ride the red `lastError`
  // channel and render like a failure. Entirely independent of lastError --
  // setting/clearing one never touches the other (see the "notice" reducer case).
  notice: string | null;
  // Task SHELL.2: the lazily-spawned "main" conductor the always-on input talks to.
  // null until the first message is submitted; never spawned just by launching the TUI.
  // P3-T2: this legacy scalar is KEPT AS-IS (still dispatched by store.ts's/
  // commands.agents.ts's own adoption logic, read by ~20 call sites across
  // tui+app) -- migrating those callers onto conductorByProject is P3-T3's job.
  // See conductorByProject below and legacyMainConductorId() for the
  // project-aware replacement data this field will eventually be dropped for.
  mainConductorId: string | null;
  // P3-T2 (project-conductor routing): per-project conductor map, projectId ->
  // agentId, derived PURELY from the latest agent.list snapshot (see reducer.ts's
  // "agentRecords" case) -- a record is a candidate when its `spec.conductor` is
  // true; a RUNNING candidate always wins over a terminal one for the same
  // project, ties broken by latest createdAt. Keyed by NO_PROJECT_CONDUCTOR_KEY
  // for a projectId===null conductor (the legacy single-conductor case), so the
  // map fully subsumes what the scalar mainConductorId field represents today.
  // Rebuilt wholesale on every snapshot (authoritative, like treeOrder), never
  // merged with a prior value.
  conductorByProject: Record<string, string>;
  // Task SHELL.2 §3: the permission mode applied to the NEXT conductor spawn (bypass
  // by default per the user's explicit ask — "auto"+"full" never prompts). Toggled by
  // Ctrl-P; live-changing an already-running agent's mode is a later task (8b).
  permissionMode: "bypass" | "ask";
  // Task T2 (F1 outbox): messages held because their target was busy when submitted,
  // FIFO per agentId. Populated by the hold-while-busy branch in sendToMain/
  // sendToSelected; drained by store.flushOutbox() one item per busy->idle transition.
  outbox: OutboxItem[];
  // MEMORY TAB: the shared-memory records shown in the Memory pane (the memory.search
  // RPC reply, newest/most-relevant first), the live search query the user is typing,
  // and the highlighted-row cursor. Loaded on tab-open + after an add (store.loadMemory/
  // memorySearch/memoryAdd). Defaults empty so tick-0 renders a byte-stable empty pane.
  // MEM-5: `mode` (search ranking, default "hybrid" ≡ lexical until MEM-4's embedder)
  // and `folder` (the folder-rail selection) both compose into the memory.search the
  // command layer issues — held here (not screen-local) because they PERSIST the query
  // filter the same way `query` does and must survive the same reducer-driven reloads.
  memory: { items: MemoryHit[]; query: string; mode: MemorySearchMode; folder: MemoryFolderSel; scope: MemoryScopeSel };
  /** F34.UI: memory.stats for the scope summary line; null until the first reply (loading). */
  memoryStats: MemoryStatsView | null;
  memoryCursor: number;
  // MEM-8 (PLAN-MEMORY.md §9): the open note's adjacency detail (a memory.get reply) or
  // null when the bottom detail region is closed, plus a cursor over its jump targets
  // (memoryJumpTargets: resolved links then backlinks). `enter` on a list row opens the
  // detail; `enter` on a jump row navigates. A fresh search / query edit closes it.
  memoryDetail: MemoryGetResult | null;
  memoryDetailCursor: number;
  // IN-APP-TERMINAL Task 4: see TerminalState's own doc comment above.
  terminals: TerminalState;
};

export type Action =
  // WD Stage 1 (coverage B4): `stampTs` (optional, default OFF) opts the projection
  // into stamping the event's ts onto every transcript item it creates
  // (TranscriptItem.ts). Opt-in BY DESIGN: the reducer's output for a flag-less
  // dispatch stays byte-identical (the TUI's store and every pre-existing test path
  // dispatch without it); createStore — the shared app-side store — turns it on for
  // its live event stream.
  | { type: "event"; event: NormalizedEvent; stampTs?: boolean }
  | { type: "connected"; connected: boolean }
  | { type: "reconnecting"; reconnecting: boolean }         // TUI-007
  | { type: "daemonStatus"; status: { protocolVersion: number; agents: UiState["agentCounts"]; accounts?: AccountStatus[]; peers?: PeerStatus[]; mcpListener?: McpListenerStatus; wakeScheduling?: WakeScheduling } }
  | { type: "agentRecords"; records: AgentRecordLite[] }
  | { type: "teams"; available: boolean; items: Array<Record<string, unknown>> }
  | { type: "queues"; available: boolean; items: Array<Record<string, unknown>> }
  // ROLES-TAB S4: mirrors "teams"/"queues" exactly.
  | { type: "roles"; available: boolean; items: Array<Record<string, unknown>> }
  // AGENT-GROUPS Phase 1: mirrors "roles" exactly (the id->name/color registry, not membership).
  | { type: "groups"; available: boolean; items: AgentGroup[] }
  | { type: "setActiveGroup"; groupId: string | null }
  | { type: "workflowStudioOpen"; mode: "author" | "inspect"; document: WorkflowGraphDocument; queue?: string | null; taskId?: string | null; version?: number | null; failedOnly?: boolean }
  | { type: "workflowStudioClose" }
  | { type: "workflowStudioDraft"; document: WorkflowGraphDocument }
  | { type: "workflowStudioSelect"; nodeId: string | null }
  | { type: "workflowStudioSaving"; saving: boolean; error?: string | null }
  | { type: "workflowStudioSaved"; document: WorkflowGraphDocument; version?: number | null }
  | { type: "reviewRoomOpen"; taskId: string }
  | { type: "reviewRoomClose" }
  | { type: "reviewRoomLoading"; taskId: string }
  | { type: "reviewRoomLoaded"; taskId: string; evidence: TaskEvidence; session: ReviewSession | null; sessionError?: string | null }
  | { type: "reviewRoomFailed"; taskId: string; error: string }
  // Live-poll refresh of an in_progress task's diff (evidence.get only — no session refetch,
  // no loading/error churn) — see ReviewRoomScreen's poll effect.
  | { type: "reviewRoomEvidenceRefreshed"; taskId: string; evidence: TaskEvidence }
  | { type: "reviewRoomSession"; session: ReviewSession }
  | { type: "reviewRoomSelect"; path?: string | null; hunkId?: string | null; findingId?: string | null }
  | { type: "reviewRoomFocus"; focus: ReviewRoomState["focus"] }
  | { type: "selectTab"; tab: TabId }
  | { type: "navigate"; target: DeepLink }
  | { type: "navigationConsumed"; requestId: number }
  | { type: "tabNext" }
  | { type: "tabPrev" }
  | { type: "selectDelta"; delta: number }
  | { type: "setMode"; mode: UiState["mode"] }
  | { type: "permissionAnswered"; requestId: string }
  | { type: "questionAnswered"; agentId: string; questionId: string }
  // Native-CLI-parity Phase 2 (Task DLG3): dispatched by store.answerDialog after
  // agent.answerDialog's RPC resolves. Unlike questionAnswered, this carries only
  // the dialogId (not an agentId) -- store.answerDialog doesn't look up which
  // agent owns the dialog, so the reducer searches agentOrder for the matching
  // pendingDialog itself (see the "dialogAnswered" case).
  | { type: "dialogAnswered"; dialogId: string }
  // IMAGE.SHOW (TUI): `images` is additive/optional -- the store threads any
  // image(s) attached to the just-sent message here so the projected user turn
  // carries them (survives re-render); a plain text send omits it, unchanged.
  // F13 (D9 wire): `content` — the same interleaved text/image block order the
  // sender authored (inline tags), so the SENDER's own echo renders thumbnails
  // at their exact positions too, not just a delivered turn from another client.
  // FORCE-SEND-MIDTURN: `forced` marks a send that bypassed the busy-hold outbox
  // (opt+enter while the target was mid-turn) — carried onto the projected
  // transcript item so the UI can render a distinct tag. Omitted (not `false`)
  // for every ordinary send, keeping a plain turn byte-identical to before.
  | { type: "userSent"; agentId: string; text: string; messageId?: string; messageOrigin?: Pick<Principal, "from" | "source" | "engineId">; images?: Image[]; content?: ContentBlock[]; forced?: boolean }
  | { type: "commandError"; message: string | null }     // null clears the error line
  // F22.UI: a CLIENT-ORIGINATED transcript line. worktree.leaseHandoff/leaseRelease succeed
  // silently — the daemon emits no event for either — so without this the operator would take
  // a worktree away from another agent and see absolutely nothing happen. Also used to record
  // the failure, so a refused handoff is not just a transient toast.
  | { type: "agentSystemLine"; agentId: string; text: string }
  // F22.UI: optimistic lease ownership after a successful handoff/release RPC — same reason as
  // above (no daemon event), so the "⌂ sole writer" chip cannot linger on an agent that just
  // gave the worktree away.
  | { type: "agentLeaseHeld"; agentId: string; held: boolean }
  | { type: "notice"; message: string | null }            // TUI-042: null clears the notice line
  | { type: "mainConductorId"; agentId: string | null }   // TUI-025: null clears it (e.g. closing the main conductor)
  | { type: "permissionMode"; mode: UiState["permissionMode"] }
  | { type: "selectAgent"; agentId: string | null }      // null clears selection after an explicit kill
  // AGENT-MARK: tick/untick one agent for a batch action, or clear the whole set. Separate from
  // selectAgent because looking at an agent must not change what a batch applies to.
  | { type: "toggleAgentMark"; agentId: string }
  | { type: "clearAgentMarks" }
  | { type: "liveboardLaneAdd"; agentId: string }
  | { type: "liveboardLaneRemove"; agentId: string }
  | { type: "liveboardLaneFollow"; agentId: string; follow: boolean }
  | { type: "liveboardLaneRead"; agentId: string }
  // COLLAPSIBLE SUB-AGENTS: toggle a node's fold in AgentList.collapsed (a pure
  // same-target toggle -- re-dispatching on the same id un-folds it). Collapsing
  // a node that CONTAINS the current selection lifts the selection up to the
  // (still-visible) node so the selection pill never vanishes into a hidden row.
  | { type: "collapse"; agentId: string }
  // COVERAGE: cursor moves for the Teams/Queues/task lists. Clamped in the reducer
  // against the CURRENT list length so a cursor can never point past the last row.
  | { type: "teamCursor"; delta: number }
  | { type: "queueCursor"; delta: number }
  | { type: "roleCursor"; delta: number }
  | { type: "taskCursor"; delta: number }
  | { type: "teamDetail"; detail: TeamStatusView | null }
  | { type: "queueDetail"; detail: QueueStatusView | null }
  | { type: "pushQueue"; queue: string | null }
  | { type: "editTask"; target: EditTaskTarget | null }   // TASK-EDIT-VERSIONING: set/clear the edit-form target
  | { type: "versionsOpen"; open: boolean }               // TASK-EDIT-VERSIONING: toggle the version-history overlay
  | { type: "taskDetailOpen"; open: boolean }             // TASK-DETAIL: toggle the result/dependsOn detail overlay
  | { type: "accountsOpen"; open: boolean }
  | { type: "accountList"; items: AccountInfo[] }
  | { type: "helpOpen"; open: boolean }
  | { type: "agentsUnseenOnly"; only: boolean }
  | { type: "agentsNeedsOperatorOnly"; only: boolean }
  | { type: "a2aHistoryOpen"; open: boolean }   // A2A-UX-OVERHAUL: toggle the ⇄ a2a history overlay (TUI)
  // PARITY WS-C: toggle the command palette / set its fuzzy-filter query. Opening
  // (or closing) always resets the query to "" so the palette starts fresh.
  | { type: "paletteOpen"; open: boolean }
  | { type: "paletteQuery"; query: string }
  | { type: "mcpPaletteOpen"; open: boolean }
  | { type: "resultOpen"; open: boolean }
  | { type: "confirm"; confirm: ConfirmAction | null }
  | { type: "agentResult"; agentId: string; detail: AgentResultDetail }   // COVERAGE (agent.status + agent.result)
  | { type: "subscriptions"; agentId: string; subscriptions: SubscriptionView[] }   // HOOK-7 (sub.list on inspect)
  // FEATURE 1 (startup history backfill): fold a per-agent `agent.tail` reply
  // into ONE agent's transcript, bypassing the global lastSeq dedupe (those
  // historical events have low seqs already below the live watermark). Never
  // touches the global events ring, lastSeq, selection, or pendingPermissions.
  // WD Stage 1 (coverage B4): stampTs mirrors the "event" action's flag — a backfill
  // replay opting in gets the same per-item timestamps the live path stamps.
  | { type: "backfillHistory"; agentId: string; events: NormalizedEvent[]; stampTs?: boolean }
  // TRANSCRIPT-LOADING-STATE: the fetch lifecycle either side of backfillHistory.
  // Dispatched right before the request fires (historyLoadState → "loading") and,
  // on rejection, instead of backfillHistory (→ "failed" + the error text).
  | { type: "historyLoadStarted"; agentId: string }
  | { type: "historyLoadFailed"; agentId: string; message: string }
  // TRANSCRIPT-TAIL-FIRST: fold one OLDER page of history onto the FRONT of an
  // agent's transcript. Deliberately narrow versus backfillHistory — see the
  // reducer case's own doc comment for exactly what it does and does not touch
  // (transcript rows only; never state/costUsd/usage/model/pendingQuestion).
  | { type: "prependHistory"; agentId: string; events: NormalizedEvent[]; stampTs?: boolean }
  // TRANSCRIPT-TAIL-FIRST: the background older-page walk's own fetch lifecycle,
  // sibling to historyLoadStarted/historyLoadFailed above but for
  // historyOlderLoadState instead (see its doc comment above).
  | { type: "historyOlderLoadStarted"; agentId: string }
  | { type: "historyOlderLoadFailed"; agentId: string; message: string }
  | { type: "historyOlderLoadFinished"; agentId: string; exhausted: boolean }
  // TRANSCRIPT-EVICT-OLD: sync the operator's at-bottom pin state in from
  // useTranscriptScroll (TranscriptSegment.tsx) so the reducer can gate
  // eviction on it. Dispatched on every atBottomRef transition, both ways —
  // becoming false suspends eviction, becoming true (re)triggers it if the
  // agent is currently over TRANSCRIPT_BUFFER_MAX.
  | { type: "transcriptAtBottom"; agentId: string; atBottom: boolean }
  // Task T2 (F1 outbox): queue/dequeue a held message.
  | { type: "outboxAdd"; item: OutboxItem }
  | { type: "outboxRemove"; id: string }
  // MEMORY TAB: replace the record list (a memory.search reply), set the live search
  // query, or move the record cursor (clamped against the current list length).
  | { type: "memory"; items: MemoryHit[] }
  | { type: "memoryQuery"; query: string }
  | { type: "memoryCursor"; delta: number }
  // MEM-8: set/clear the detail region (memory.get reply), move the jump cursor within it,
  // or set the record cursor to an absolute index (a link jump lands on the target's row).
  | { type: "memoryDetail"; detail: MemoryGetResult | null }
  | { type: "memoryDetailCursor"; delta: number }
  | { type: "memoryCursorSet"; index: number }
  // MEM-5: the search-mode chip (ctrl+m cycles) and the folder-rail selection —
  // both change the params the next memory.search issues.
  | { type: "memoryMode"; mode: MemorySearchMode }
  | { type: "memoryFolder"; folder: MemoryFolderSel }
  | { type: "memoryScope"; scope: MemoryScopeSel }
  | { type: "memoryStats"; stats: MemoryStatsView | null }
  // IN-APP-TERMINAL Task 4: see TerminalState's own doc comment above. TERMINAL-DOCK-PER-AGENT:
  // terminalDockToggled now takes the agentId whose dock is being shown/hidden — open state is
  // per-agent, so the toggle can no longer be agent-less.
  | { type: "terminalOpened"; tab: TerminalTab }
  | { type: "terminalClosed"; id: string }
  | { type: "terminalActivated"; id: string }
  // TERMINAL-NAMES: an operator-chosen tab name. A blank one falls back to the generated default
  // rather than leaving a nameless tab.
  | { type: "terminalRenamed"; id: string; title: string }
  | { type: "terminalExited"; id: string; code: number | null }
  | { type: "terminalDockToggled"; agentId: string }
  | { type: "terminalDockResized"; height: number };

// TUI-004 (MAJOR): a pendingQuestion is scoped per-agent (AgentView.pendingQuestion),
// and with multiple agents running concurrently a question on any agent OTHER than
// the currently selected one used to be entirely invisible (useFirstPendingQuestion)
// and unanswerable (store.answerQuestion) -- both used to read ONLY
// state.agents[state.selectedAgentId]. This shared pure helper is the single source
// of truth both the panel (via useFirstPendingQuestion) and the answer path (via
// store.answerQuestion) now agree on: aggregate across ALL agents in agentOrder and
// surface the FIRST one with a non-null pendingQuestion, tagged with its agentId, so
// a waiting sub-agent's question is always the one shown/answered regardless of
// which agent the user happens to be looking at.
//
// ASK-UNREACHABLE-TARGET-LEAK: a question carrying `to` is inter-agent (ask_agent/
// ask_team) — it is addressed to another agent via answer_question, never to the
// human, so it is skipped here even though it stays on its asker's AgentView.pendingQuestion
// (that keeps the agent-list "?" waiting indicator working).
export function firstPendingQuestion(state: UiState): (AgentQuestion & { agentId: string }) | null {
  for (const id of state.agentOrder) {
    const q = state.agents[id]?.pendingQuestion;
    if (q && q.to === undefined) return { ...q, agentId: id };
  }
  return null;
}

// Native-CLI-parity Phase 2 (Task DLG3): mirrors firstPendingQuestion exactly, but
// over PendingDialog -- the SAME cross-agent aggregation rationale applies (a
// sub-agent's dialog must be visible/answerable regardless of which agent the
// user happens to have selected).
export function firstPendingDialog(state: UiState): (PendingDialog & { agentId: string }) | null {
  for (const id of state.agentOrder) {
    const d = state.agents[id]?.pendingDialog;
    if (d) return { ...d, agentId: id };
  }
  return null;
}

// P3-T2 (project-conductor routing): the conductorByProject key for a
// projectId===null conductor -- a project name (ProjectSpec.name) is always a
// non-empty string, so "" never collides with a real project.
export const NO_PROJECT_CONDUCTOR_KEY = "";

// P3-T2: the project-aware equivalent of the legacy scalar mainConductorId --
// reads conductorByProject's projectId===null slot, i.e. exactly what
// mainConductorId represented before per-project conductors existed. New
// callers should prefer this (or conductorByProject directly for a specific
// project) over the legacy field; see mainConductorId's own doc comment.
export function legacyMainConductorId(state: UiState): string | null {
  return state.conductorByProject[NO_PROJECT_CONDUCTOR_KEY] ?? null;
}

export const initialState: UiState = {
  connected: false,
  reconnecting: false,
  protocolVersion: null,
  agentCounts: { running: 0, paused: 0, done: 0, failed: 0, killed: 0 },
  accounts: [],
  peers: [],
  mcpListenerGrantAgents: null,
  wakeScheduling: null,
  agents: {},
  agentOrder: [],
  pendingPermissions: [],
  tasks: {},
  hooks: {},
  workflowStudio: { open: false, mode: "author", queue: null, taskId: null, version: null, baseline: null, draft: null, selectedNodeId: null, dirty: false, saving: false, error: null, failedOnly: false },
  reviewRoom: { openTaskId: null, loading: false, error: null, evidenceByTask: {}, sessionsByTask: {}, sessionError: null, selectedPath: null, selectedHunkId: null, selectedFindingId: null, focus: "files" },
  events: [],
  lastSeq: 0,
  // TUI-038 (MINOR): OPTIMISTIC by default -- available:false used to be the
  // initial value too, so ListPane's "requires a Phase 2 daemon" notice
  // rendered not just for a genuine Phase-1 daemon but also before the first
  // successful team.list/queue.list call, and after any transient
  // (non-isUnknownMethod) failure (store.ts's tryPhase2 keeps prior contents
  // on a transient error -- no dispatch at all). Starting true means the
  // pre-load and transient-failure states instead show the pane's normal
  // empty hint; only a positively-confirmed isUnknownMethod (a real Phase-1
  // daemon) flips this to false.
  teams: { available: true, items: [] },
  queues: { available: true, items: [] },
  roles: { available: true, items: [] },   // ROLES-TAB S4: mirrors teams/queues above
  groups: { available: true, items: [] },  // AGENT-GROUPS Phase 1: mirrors roles above
  activeGroupId: null,
  activeTab: "agents",
  navigation: { requestId: 0, target: null },
  unseen: { permissions: 0, questions: 0, errors: 0 },
  selectedAgentId: null,
  markedAgentIds: [],
  collapsed: new Set(),
  unseenOnly: false,
  needsOperatorOnly: false,
  liveboardLanes: [],
  mode: "normal",
  teamCursor: 0,
  queueCursor: 0,
  taskCursor: 0,
  roleCursor: 0,   // ROLES-TAB S4: mirrors teamCursor above
  teamDetail: null,
  queueDetail: null,
  pushQueue: null,
  editTask: null,          // TASK-EDIT-VERSIONING
  versionsOpen: false,     // TASK-EDIT-VERSIONING
  taskDetailOpen: false,   // TASK-DETAIL
  accountsOpen: false,
  accountList: [],
  helpOpen: false,
  a2aHistoryOpen: false,
  paletteOpen: false,
  paletteQuery: "",
  mcpPaletteOpen: false,
  resultOpen: false,
  confirm: null,
  lastError: null,
  notice: null,
  mainConductorId: null,
  conductorByProject: {},
  permissionMode: "bypass",
  outbox: [],
  memory: { items: [], query: "", mode: "hybrid", folder: { kind: "all" }, scope: { kind: "all" } },
  memoryStats: null,
  memoryCursor: 0,
  memoryDetail: null,
  memoryDetailCursor: 0,
  terminals: { tabs: [], activeByAgent: {}, openByAgent: {}, dockHeight: 260 },
};
