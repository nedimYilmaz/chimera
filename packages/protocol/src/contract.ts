import * as canvas from "./canvas.js";
import { GroupCreateParamsSchema, GroupUpdateParamsSchema, GroupDeleteParamsSchema, GroupListResultSchema, AgentGroupSchema, AgentSetGroupsParamsSchema, AgentChangeGroupsParamsSchema } from "./agent-groups.js";
import * as fork from "./fork.js";
import { OperatorWebSettingsSchema, OperatorWebStatusSchema, OperatorWebPairStartSchema, OperatorWebPairCodeSchema, OperatorWebSessionSchema } from "./operator-web.js";
import { ContextLinkCreateSchema, ContextLinkListSchema, ContextLinkTargetSchema, ContextLinkViewSchema, ContextLinkListResponseSchema } from "./context-links.js";
import * as gitops from "./gitops.js";
import { SttPreferencesSchema, SttStatusSchema, SttInstallSchema, SttTranscribeSchema, SttTranscriptSchema, SttCancelSchema } from "./stt.js";
import { IssueSourceSchema, IssueBoardLinkSchema, IssueSourceListRequestSchema, IssueSourceUpsertRequestSchema, IssueSourceRemoveRequestSchema, IssueSyncRequestSchema, IssueSyncResultSchema, IssueLinkListRequestSchema, IssuePostCommentRequestSchema, IssuePostCommentResultSchema } from "./issues.js";
import { AgentResourcesRequestSchema, AgentResourcesResponseSchema, HostAdmissionSchema } from "./resources.js";
import { MeetingPlanInputSchema, MeetingPlanSchema } from "./meeting-plan.js";
// FEATURE-8: the Chimera Contract Compiler seam. RPC_CONTRACT is the single source of truth
// for a (growing) subset of the daemon's RPC surface — one entry per method, its request zod
// schema, and its response zod schema. Everything else in this file is DERIVED from it:
//  - ContractHandlers: the dispatcher shape an engine implements. Assigning an object literal
//    to this type makes a missing OR extra case a tsc error (object-literal excess/missing
//    property checks), unlike the legacy engine.ts `switch`'s runtime `default: throw`.
//  - RpcRequestFor<M>/RpcResponseFor<M>: what a typed client (@chimera/client's
//    ChimeraClient.call) uses so a caller can't send a malformed request or mis-type a
//    response.
//
// This module intentionally imports request/response building blocks FROM ./index.js (the
// package barrel) rather than the other way around — index.js does NOT `export *` this file,
// to avoid a real import cycle (index.js -> contract.js -> index.js), matching how
// mcp-server-factory.ts (which also imports from mcp-tools.js) is consumed via its own
// subpath rather than re-exported. Import this module as "@chimera/protocol/contract".
//
// FEATURE-8's landable slice migrated queue.* (8 RPCs), joined by evidence.get (FEATURE-10).
// FEATURE-11 adds team.*/workflow.*/artifact.* (12 RPCs), each family's handler implementation
// now living in its own packages/core/src/rpc/*.ts module (TeamRpc/WorkflowRpc/ArtifactRpc)
// rather than inline on Engine — see engine.ts's `contractHandlers` composition. Every other
// RPC still stays on engine.ts's existing `switch`, unaffected. Future slices keep growing
// RPC_CONTRACT (and so ContractHandlers) with more families, each getting its own module.
import { z } from "zod";
import { VoiceLimitsSchema, VoiceRoomSpecSchema, VoiceRoomSchema, VoiceRoomTargetSchema, VoiceRoomLeaseSchema, VoiceDiagnosticInputSchema } from "./voice-rooms.js";
import {
  QueueSpecSchema, TaskRecordSchema, QueueStatusSummarySchema, QueueCountsSchema,
  TaskEvidenceSchema, TeamSpecSchema, RoleSpecSchema, RoleBindingSchema, RoleNameSchema,
  PluginConfigSchema, WorkflowSpecSchema,
  WorkflowRecordSchema, WorkflowUpdateParams, WorkflowRunSpecSchema, ArtifactKindSchema, ArtifactRecordSchema,
  AuditVerifyResultSchema, RetryPolicySchema,
  ChronicleSearchRequestSchema, ChronicleSearchResponseSchema,
  ChronicleSemanticSearchParamsSchema, ChronicleSemanticSearchResultSchema,
  ChronicleGetParamsSchema, ChronicleGetResultSchema,
  SkillSearchRequestSchema, SkillSearchResponseSchema,
  SkillReadRequestSchema, SkillReadResponseSchema,
  TerminalAppendRequestSchema, TerminalAppendResponseSchema,
  TerminalReadRequestSchema, TerminalReadResponseSchema,
  TerminalWriteRequestSchema, TerminalWriteResponseSchema,
  TerminalTabStateRequestSchema, TerminalTabStateResponseSchema,
  ChronicleIndexStatusSchema, ChronicleReindexResultSchema,
  ChronicleExportRequestSchema, ChronicleExportResponseSchema,
  ReviewSessionSchema, ReviewFindingSchema,
  SubscriptionSchema,
  McpStoreNameSchema,
  EffortLevelSchema, HookCauseSchema,
  HookRuleSchema, TopicSchema, TopicFilterSchema, HookActionSchema, TaskTagsSchema, contentFilterIssue, scopeFilterIssue,
  TaskExplainResultSchema,
  WorktreeLeaseSchema, WorktreeLeaseViewSchema, WorktreeExplainWriteResultSchema,
  StepJournalEntrySchema,
  RunKindSchema, RunOutcomeSchema, RunHistoryRowSchema, RunHistoryCoverageSchema,
  HistoryRunsRequestSchema, HistoryRunsResponseSchema,
} from "./index.js";

// NOTE (RETRY-BACKOFF): QueueCountsSchema itself gained a required `dead_letter` field at its
// declaration site in ./index.js (TaskState grew a 6th member) — nothing to do here, this file
// just re-exports/consumes it via QueueStatusSchema below.

export function defineRpc<Req extends z.ZodType, Res extends z.ZodType>(
  request: Req, response: Res,
): { request: Req; response: Res } {
  return { request, response };
}

// ---------- queue.* request schemas ----------
// Verbatim ports of engine.ts's local param consts (QueueCreateParams etc., engine.ts:166-192)
// — same strict/non-strict-ness and optionality as today, so validation behavior does not
// shift for any existing caller. The one deliberate exception: queue.create's params used to
// be `{ spec: z.unknown() }`, re-validated one line later via `QueueSpecSchema.parse(...)`
// (engine.ts:1152) — folding that into the request schema changes WHERE that same validation
// error surfaces, not WHETHER it does.
const QueueCreateRequestSchema = z.object({ spec: QueueSpecSchema }).strict();
const QueueUpdateRequestSchema = z.object({
  name: z.string().min(1),
  patch: z.object({
    retryLimit: z.number().int().min(0).optional(),
    workflow: z.string().nullable().optional(),   // D12: the queue's default workflow binding
    retryPolicy: RetryPolicySchema.optional(),   // RETRY-BACKOFF
  }).strict(),
}).strict();
const QueueDeleteRequestSchema = z.object({ name: z.string().min(1) }).strict();
// Not .strict() — QueuePushParams (engine.ts:175-186) never was either; extra fields are
// silently ignored today and must keep being ignored.
const QueuePushRequestSchema = z.object({
  queue: z.string(), prompt: z.string().min(1),
  priority: z.number().int().optional(), role: z.string().optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
  dependsOn: z.array(z.string()).optional(),
  pushedBy: z.string().min(1).optional(),
  workflow: z.string().min(1).optional(),
  // TASK-TAGS: optional here (absent => the record's own [] default) rather than
  // TaskTagsSchema's defaulted form, so an omitted field stays omitted on the wire.
  tags: TaskTagsSchema.unwrap().optional(),
});
// Not .strict() — mirrors QueueNameParams.
const QueueStatusRequestSchema = z.object({ queue: z.string() });
// Not .strict() — mirrors QueueStatusSummaryParams.
const QueueStatusSummaryRequestSchema = z.object({
  queue: z.string(), limit: z.number().int().positive().max(200).optional(), cursor: z.string().optional(),
});
// Not .strict() — mirrors TaskIdParams.
const QueueCancelTaskRequestSchema = z.object({ taskId: z.string() });
// RETRY-BACKOFF: a brand-new RPC (no legacy caller to mirror) — strict by default.
const QueueRequeueRequestSchema = z.object({ taskId: z.string().min(1) }).strict();
// QUEUE-PAUSE: explicit pause/resume RPCs (not folded into queue.update) — a clear event +
// UI action, mirroring queue.requeue's own brand-new/strict shape.
const QueuePauseRequestSchema = z.object({ queue: z.string().min(1) }).strict();
const QueueResumeRequestSchema = z.object({ queue: z.string().min(1) }).strict();
// TASK-EDIT-VERSIONING: edit a still-queued (pending/blocked) task in place. Brand-new RPC — strict
// by default (both the envelope and the patch). SPARSE patch: only the keys the caller sets change;
// an omitted key is left untouched (NOT reset). `workflow` maps to TaskRecord.workflowOverride (the
// per-task workflow binding), matching queue.push's own `workflow` field name. `role` is nullable
// (null → the team's first role, same semantics as push). At least one patch field must be present
// (.refine) so a no-op edit is a caller error, not a silent version-less write. dependsOn editing is
// deliberately OUT OF SCOPE for this slice (see queues.ts editTask note) — omitted from the patch.
const QueueEditTaskRequestSchema = z.object({
  taskId: z.string().min(1),
  patch: z.object({
    prompt: z.string().min(1).optional(),
    role: z.string().min(1).nullable().optional(),
    priority: z.number().int().optional(),
    overrides: z.record(z.string(), z.unknown()).optional(),
    workflow: z.string().min(1).nullable().optional(),
    // TASK-TAGS: a REPLACEMENT, not a merge — the same whole-value semantics `overrides` above
    // already uses, and the only one that can express "remove a tag". Rides the existing
    // append-only version history like every other edited field.
    tags: TaskTagsSchema.unwrap().optional(),
  }).strict().refine((p) => Object.keys(p).length > 0, { message: "patch must set at least one field" }),
  // Stamped by the MCP layer from the caller's own identity (mirrors queue.push's pushedBy /
  // workflow.run's agentId) — the editing agent's principal, recorded on the version entry. Never
  // trusted from an untyped caller beyond that seam; null for a direct/human edit.
  editedBy: z.string().min(1).optional(),
}).strict();

// QUEUE-REORDER: move a pending/blocked task one slot within its queue's drain order (adjacent
// swap of priority+orderKey with whichever task sits in that neighbouring slot — see queues.ts
// moveTask's own comment for why this is a swap, not a gap-insertion). Operator-only (app UI),
// not exposed to agents over MCP — see mcp-parity.test.ts's INTENTIONALLY_EXCLUDED_RPCS.
const QueueMoveTaskRequestSchema = z.object({
  taskId: z.string().min(1), direction: z.enum(["up", "down"]),
}).strict();
// QUEUE-REORDER: the operator's literal ask — recover a failed/dead_letter task WITHOUT
// retyping the prompt. Clones the task into a fresh pending one (queues.ts retryTask) rather
// than reviving in place; see that method's own comment for why. Operator-only, same as above.
const QueueRetryTaskRequestSchema = z.object({ taskId: z.string().min(1) }).strict();
// QUEUE-REORDER: add an ordering CONSTRAINT (dependsOn) to an already-existing pending/blocked
// task — the T15 incident's actual fix ("run last" is a dependency, not a priority tiebreak).
// Operator-only, same as above.
// F15: read-only "why is this task not running?" — evaluates the SAME predicate array the
// scheduler's dispatch path evaluates, without dispatching. Brand-new RPC, strict.
const QueueExplainTaskRequestSchema = z.object({ taskId: z.string().min(1) }).strict();
const QueueAddDependencyRequestSchema = z.object({
  taskId: z.string().min(1), dependsOnTaskId: z.string().min(1),
}).strict();

// AGENT-INITIATED-REMEDIATION: a step agent's own mid-turn request to route THIS task back to
// an earlier step with its diagnosis, instead of finishing its current step and hoping the
// step's own gate (if it even has one) catches the problem. Structural fields only — which step
// to jump to and the diagnosis text; requestedBy is stamped by the MCP layer from the caller's
// own identity (mirrors queue.push's pushedBy). Absent/null means a direct/human/operator call,
// which the engine.ts handler exempts from the "caller must be this task's current step agent"
// check. Brand-new RPC — strict by default (mirrors queue.requeue's own shape).
const QueueRequestRemediationRequestSchema = z.object({
  taskId: z.string().min(1),
  targetStepId: z.string().min(1),
  brief: z.string().min(1),
  requestedBy: z.string().min(1).nullable().optional(),
}).strict();
// roundsSoFar/maxRounds are a best-effort PREVIEW computed at request time — the authoritative
// accept/exhaust decision (and the actual jump) happens later, when this turn ends
// (scheduler.ts's handleWorkflowTurn), since only that moment's live TaskRecord state is
// trustworthy (see incrementRemediationRounds' own anchor-reset semantics).
const QueueRequestRemediationResponseSchema = z.object({
  recorded: z.literal(true),
  targetStepId: z.string(),
  targetStepTitle: z.string(),
  roundsSoFar: z.number().int().min(0),
  maxRounds: z.number().int().min(1),
  note: z.string(),
}).strict();

// ---------- journal.query (F11, durable step journal) ----------
// Every filter is optional and ANDed. Defaults (StepJournal.query's own): to = now,
// from = to - 7d, limit = 50 (max 500). from/to are epoch MILLISECONDS filtering on the
// entry's startedAt, not on row append time — the same unit UsageQueryParams documents.
const JournalQueryRequestSchema = z.object({
  taskId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  queue: z.string().min(1).optional(),
  team: z.string().min(1).optional(),
  outcome: z.enum(["passed", "failed", "retried", "open"]).optional(),
  from: z.number().optional(),
  to: z.number().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),   // the entryId of the previous page's last entry
}).strict();
const JournalQueryResponseSchema = z.object({
  entries: z.array(StepJournalEntrySchema),
  nextCursor: z.string().nullable(),
  // How many folded entries matched before the limit — so a caller knows a page is a page.
  matched: z.number().int().min(0),
}).strict();

// ---------- history.runs (F13, unified run history) ----------
// HistoryRunsRequestSchema/HistoryRunsResponseSchema live in ./index.js (see the import above) so
// core's RunHistoryStore can import their inferred types from the flat "@chimera/protocol" barrel.

// ---------- evidence.get (FEATURE-10, Changes & Evidence Review) ----------
const EvidenceGetRequestSchema = z.object({ taskId: z.string().min(1) }).strict();
// F25: taskId is OPTIONAL for an agent asking "what was filed against MY diff" — the engine
// resolves it from `agentId` via scheduler.taskFor (the checkpoint.create/artifact.add split:
// the caller's identity is stamped at the MCP seam, the task binding is resolved server-side and
// never trusted from params). The app keeps passing taskId and is unaffected.
const ReviewGetRequestSchema = z.object({
  taskId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
}).strict();
const ReviewFindingAddRequestSchema = z.object({
  taskId: z.string().min(1), path: z.string().min(1), hunkId: z.string().min(1).nullable().optional(),
  parentId: z.string().min(1).nullable().optional(), authorAgentId: z.string().min(1).nullable().optional(),
  severity: z.enum(["note", "warning", "blocking"]), body: z.string().min(1),
}).strict();
// F25: who is asking. Stamped from CHIMERA_AGENT_ID at the MCP seam (mirrors pushedBy /
// requestedBy); absent/null means the OPERATOR (app, TUI palette, CLI), which is the only
// identity allowed to clear another agent's blocking finding.
const ReviewFindingResolveRequestSchema = z.object({
  taskId: z.string().min(1), findingId: z.string().min(1),
  actorAgentId: z.string().min(1).nullable().optional(),
}).strict();
const ReviewDecideRequestSchema = z.object({
  taskId: z.string().min(1), status: z.enum(["accepted", "changes_requested"]),
  actorAgentId: z.string().min(1).nullable().optional(), summary: z.string(),
}).strict();

// ---------- team.* request schemas (FEATURE-11) ----------
// Verbatim ports of engine.ts's local param consts (TeamCreateParams etc., engine.ts:159-173)
// — same strict/non-strict-ness as today. TeamCreateParams today is `{ spec: z.unknown() }`,
// re-validated one line later via TeamSpecSchema.parse (engine.ts:1186) — folding that into the
// request schema here is the same deliberate WHERE-not-WHETHER shift queue.create's own note
// above already established.
const TeamCreateRequestSchema = z.object({ spec: TeamSpecSchema }).strict();
// Not .strict() — TeamNameParams (engine.ts:160) never was either.
const TeamNameRequestSchema = z.object({ name: z.string() });
const TeamUpdateRequestSchema = z.object({
  name: z.string().min(1),
  patch: z.object({
    maxConcurrent: z.number().int().positive().optional(),
    purpose: z.string().nullable().optional(),
    queue: z.string().nullable().optional(),
    roles: z.record(z.string(), RoleBindingSchema).optional(),
  }).strict(),
}).strict();

// ---------- team.attachRole / team.detachRole request schemas (ROLES-TAB S2 §4) ----------
// `as` lets the shared role land under a different team-local key than its session name
// (defaults to the role's own name); `cwd` overrides the "first existing role's cwd" default.
const TeamAttachRoleRequestSchema = z.object({
  team: z.string().min(1),
  role: z.string().min(1),
  as: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
}).strict();
const TeamDetachRoleRequestSchema = z.object({
  team: z.string().min(1),
  role: z.string().min(1),
}).strict();

// ---------- team.updateRoleBinding request schema (ROLES-UNIFY §5) ----------
// Server-side RMW against the CURRENT roles record, touching only `roleKey` — removes the need
// for a client-side rebase-at-submit dance. Handler requires at least one of role/overrides
// present (a handler-level check, same as RoleUpdateRequestSchema leaves "at least one changed
// field" unenforced at the schema layer).
const TeamUpdateRoleBindingRequestSchema = z.object({
  team: z.string().min(1),
  roleKey: z.string().min(1),
  role: RoleNameSchema.optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
}).strict();

// ---------- role.* request schemas (ad-hoc sessions design §4, widened by ROLES-UNIFY §2/§5) ----------
// Standalone (not nested in TeamSpec.roles — see RoleSpecSchema's own comment in index.ts for
// why the unified role library is unbound to any single team/queue).
// ROLES-UNIFY §3.2: role.create rejects a dotted name — the `<team>.<key>` qualifier namespace is
// reserved for automatic team-migration/discovery (RoleNameSchema, index.ts), never hand-typed,
// so a user-authored role can never accidentally shadow a team-qualified library entry.
const RoleCreateRequestSchema = z.object({
  spec: RoleSpecSchema.extend({
    name: z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, "role.create names cannot contain '.' — reserved for team-qualified library entries"),
  }),
}).strict();
const RoleNameRequestSchema = z.object({ name: z.string() }).strict();
// Not RoleSpecSchema.omit({name:true}).partial() — several fields carry .default(), and zod's
// defaults still fire under .partial() for an absent key, silently reintroducing every default
// value into a patch meant to be sparse. Mirrors TeamUpdateRequestSchema's own explicit
// optional-field shape (contract.ts, above) for the identical reason. Widened to the full RoleSpec
// field set (minus `name`, the identifier) now that team-role and session-role templates share
// one schema — every field a library role can carry is now patchable, not just the old
// SessionRoleSpecSchema's picked subset.
const RoleUpdateRequestSchema = z.object({
  name: z.string(),
  patch: z.object({
    cwd: z.string().min(1).optional(),
    displayLabel: z.string().trim().min(1).optional(),
    account: z.string().optional(),
    provider: z.string().min(1).optional(),
    isolation: z.enum(["none", "worktree"]).optional(),
    workdirKey: z.string().min(1).optional(),
    model: z.string().optional(),
    effort: EffortLevelSchema.optional(),
    instructions: z.string().optional(),
    resultSchema: z.record(z.string(), z.unknown()).optional(),
    executionMode: z.enum(["plan", "execute", "auto"]).optional(),
    permissionProfile: z.enum(["readOnly", "acceptEdits", "full"]).optional(),
    autonomy: z.enum(["ask", "full"]).optional(),
    acknowledgeCodexFullAccessRisk: z.boolean().optional(),
    maxTurns: z.number().int().positive().optional(),
    turnLimitPolicy: z.enum(["fail", "soft"]).optional(),
    idleTimeoutMs: z.number().int().positive().optional(),
    maxTurnDurationMs: z.number().int().positive().optional(),
    compactionThreshold: z.number().int().positive().nullable().optional(),
    contextWindow: z.number().int().positive().nullable().optional(),
    inherit: z.object({
      settingSources: z.array(z.enum(["user", "project", "local"])),
    }).optional(),
    // SPAWN-SETTING-SOURCES: mirrors AgentSpecSchema's own field (index.ts) — the friendly
    // on/off surface over inherit.settingSources, patchable on a library role like every other
    // field here.
    loadSettings: z.boolean().optional(),
    mcpServers: z.record(z.string(), z.unknown()).optional(),
    mcpToolAllowlist: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
    strictMcpConfig: z.boolean().optional(),
    plugins: z.array(PluginConfigSchema).optional(),
    orchestration: z.object({
      allow: z.boolean(),
      maxDepth: z.number().int().positive(),
    }).optional(),
    crossProviderFailover: z.boolean().optional(),
    deliverTo: z.string().regex(/^[^/]+(\/[^/]+)?$/).nullable().optional(),
    deliverWake: z.enum(["resume"]).optional(),
    maxBudgetUsd: z.number().positive().nullable().optional(),
    conductor: z.boolean().optional(),
    session: z.boolean().optional(),
    persistent: z.boolean().optional(),
    poolSize: z.number().int().min(1).optional(),
    on: z.object({
      permissionRequest: z.enum(["auto", "poke:caller", "tui"]),
    }).optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    resume: z.string().nullable().optional(),
    resumeOnly: z.boolean().optional(),
    cause: HookCauseSchema.nullable().optional(),
    skills: z.array(z.string()).optional(),
  }).strict(),
}).strict();

// ---------- team.list / team.status responses ----------
// TEAM-STATS: totalRuns sums scheduler.runCountFor over every agent EVER
// tagged with this team's membership (supervisor.list() keeps terminal
// records forever, filtered by membership.team === name — see team-rpc.ts),
// not just the currently-live roster, so churned/replaced members still
// count. A brand-new team with no completed runs is 0, never absent.
const TeamListEntrySchema = TeamSpecSchema.extend({ running: z.number().int(), totalRuns: z.number().int() }).strict();
// team.status's `agents` rows mix full AgentRecord fields (supervisor.list()) with a synthetic
// phase/runCount, plus a differently-shaped "not_spawned" placeholder row (spec.roles[role]
// instead of a real record) — see engine.ts:1208-1219. No AgentRecordSchema exists in protocol
// yet (agent.* is unmigrated); inventing one here as a side effect of the team.* slice would be
// scope creep this migration explicitly defers (see PLAN.md's family-selection section). Kept
// as loose as engine.ts's current `Array<Record<string, unknown>>` return type — just now an
// explicit contract entry instead of an untyped return. Tightens naturally once agent.* migrates.
export const TeamStatusResponseSchema = z.object({
  spec: TeamSpecSchema,
  running: z.number().int(),
  agents: z.array(z.record(z.string(), z.unknown())),
  totalRuns: z.number().int(),
}).strict();

// ---------- team.mine (WORKER-TEAM-CONTEXT) ----------
// my_team's authoritative fallback: env (CHIMERA_TEAM) is a caching convenience a subprocess
// backend must remember to forward, and two backends (claude.ts, codex.ts) were both found
// silently dropping it from the chimera-mcp subprocess's env — so my_team resolved {team:null}
// for every team worker regardless of provider. team.mine resolves team membership the
// AUTHORITATIVE way instead: look up the caller's OWN AgentRecord (by the agentId the MCP ctx
// already carries) and read its `membership` field, which the scheduler stamps at spawn time and
// which cannot drift out of sync the way a hand-copied env dict can. Response mirrors
// team.status's (found) or {team:null} (not a team member / unknown agentId).
const TeamMineRequestSchema = z.object({ agentId: z.string().min(1) }).strict();
export const TeamMineResponseSchema = z.union([TeamStatusResponseSchema, z.object({ team: z.null() }).strict()]);

// ---------- workflow.* request schemas (FEATURE-11) ----------
// Verbatim ports of engine.ts's local param consts (WorkflowCreateParams/WorkflowNameParams,
// engine.ts:248-249). WorkflowUpdateParams already lives in ./index.js (protocol/src/index.ts:
// 1357) and is reused directly below, unlike the other two families' update requests.
const WorkflowCreateRequestSchema = z.object({ spec: WorkflowSpecSchema }).strict();
// Not .strict() — WorkflowNameParams (engine.ts:249) never was either.
const WorkflowNameRequestSchema = z.object({ name: z.string().min(1) });

// FEATURE WORKFLOW-RUN-P1: a brand-new RPC (no legacy caller to mirror) — strict by
// default, same precedent as queue.requeue above. `spec` nests WorkflowRunSpecSchema
// (already graph-validated via its own superRefine) exactly like workflow.create nests
// WorkflowSpecSchema under `spec` — the graph checks run at THIS parse, before the
// handler (WorkflowRpc) ever touches the store. `agentId` is stamped by the MCP layer
// from the caller's own identity (mirrors artifact.add/checkpoint.create's `agentId`
// field) — never trusted from an untyped caller beyond that seam.
const WorkflowRunRequestSchema = z.object({
  spec: WorkflowRunSpecSchema,
  prompt: z.string().min(1),
  queue: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  priority: z.number().int().optional(),
  dependsOn: z.array(z.string()).optional(),
  provision: z.boolean().optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
  agentId: z.string().min(1).optional(),
}).strict();

// FEATURE WORKFLOW-RUN-P2: workflow.plan — the "design-and-run" entry. Unlike workflow.run
// (caller supplies the steps), the caller supplies only a `goal`; WorkflowRpc synthesizes a
// two-step ephemeral workflow whose step 0 is `plan`-gated (the SAME Dynamic Planner gate
// scheduler.ts's evaluatePlanGate/beginPlanDispatch already run for a hand-authored
// workflow) so an agent designs the real work, then its step 1 ("done") is where the parent
// resumes once the compiled plan's child task joins. `plannerOverrides` is a narrow
// model/account/permissionProfile subset (NOT the free-form `overrides` bag below) — model
// lands on the synthesized planner step directly (WorkflowStep.model), account/
// permissionProfile fold into the task-level overrides WorkflowRpc builds.
const WorkflowPlanRequestSchema = z.object({
  goal: z.string().min(1),
  queue: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  priority: z.number().int().optional(),
  provision: z.boolean().optional(),
  plannerOverrides: z.object({
    model: z.string().min(1).optional(),
    account: z.string().min(1).optional(),
    permissionProfile: z.enum(["readOnly", "acceptEdits", "full"]).optional(),
  }).strict().optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
  agentId: z.string().min(1).optional(),
}).strict();
// plannedWorkflowName is NOT resolvable synchronously — the planner hasn't run yet by the
// time this RPC returns (its PlanArtifact is only compiled once the `plan` gate evaluates,
// asynchronously, on a later scheduler tick) — omitted (not populated with a guess) on
// every real response; the optional field exists for a future caller that polls after the
// fact (e.g. via the task_plan_dispatched event or workflow.get on the child).
const WorkflowPlanResponseSchema = z.object({
  taskId: z.string(),
  plannedWorkflowName: z.string().optional(),
}).strict();

// ---------- artifact.* request schemas (FEATURE-11) ----------
// Verbatim ports of engine.ts's local param consts (ArtifactAddParams etc., engine.ts:255-263).
const ArtifactAddRequestSchema = z.object({
  kind: ArtifactKindSchema,
  path: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  label: z.string().min(1),
  agentId: z.string().optional(),
});
const ArtifactListRequestSchema = z.object({ taskId: z.string().optional(), agentId: z.string().optional() });
// Not .strict() — ArtifactIdParams (engine.ts:263) never was either.
const ArtifactIdRequestSchema = z.object({ id: z.string().min(1) });

// ---------- audit.verify (tamper-evident hash-chained audit ledger) ----------
const AuditVerifyRequestSchema = z.object({}).strict();

// ---------- budget.* request/response schemas ----------
// F50 BUDGET-RESUME: `treeId` is the BUDGET NODE id. For every spawn pattern in this repo today it
// IS the tree root's id (supervisor.ts:1069-1081), and it is exactly the value the pause event
// already carries as `treeId` (supervisor.ts:4808) — which is where the operator reads it from, so
// the field is named for the surface, not for the internal map key.
// `principal` is REQUIRED and free-form (e.g. "app", "tui", a username): this RPC is not reachable
// from the MCP tool surface at all (see mcp-tools.ts — F50 adds nothing there), so the field is not
// an authorization check, it is the audit record's answer to "who". A caller that cannot name a
// principal has no business releasing a guardrail.
export const BudgetResumeRequestSchema = z.object({
  treeId: z.string().min(1),
  principal: z.string().min(1),
  reason: z.string().max(500).optional(),
}).strict();

export const BudgetResumeResponseSchema = z.object({
  resumed: z.boolean(),
  treeId: z.string(),
  totalCostUsd: z.number(),
  estimatedUsd: z.number(),
  maxBudgetUsd: z.number(),
  // true ⇒ the node is STILL over its ceiling; the guardrail re-engages the moment new spend is
  // booked. This RPC does not and will not raise maxBudgetUsd — see the handler's doc comment.
  overBudget: z.boolean(),
  // The nearest ancestor budget node that is still paused, if any. The subtree cannot dispatch
  // until that one is resumed too; naming it beats leaving the operator to guess.
  blockedByAncestorNodeId: z.string().nullable(),
  note: z.string(),
}).strict();
export type BudgetResumeResponse = z.infer<typeof BudgetResumeResponseSchema>;

// ---------- health.status / replay.agentsAsOf (R2 self-healing supervision) ----------
const HealthStatusRequestSchema = z.object({}).strict();
// No AgentRecordSchema exists yet (agent.* is unmigrated — the same gap
// TeamStatusResponseSchema's own `agents` field documents above); this stays a narrow,
// purpose-built health projection instead of inventing one prematurely.
export const AgentHealthSchema = z.object({
  agentId: z.string(),
  state: z.enum(["running", "paused", "done", "failed", "killed"]),
  crashCount: z.number().int(),
  circuitOpen: z.boolean(),
  pauseReason: z.string().nullable(),
}).strict();
// Not .strict() — a bare toSeq-bounded query; extra fields ignored is fine for a local-only,
// read-only diagnostic RPC.
const ReplayAgentsAsOfRequestSchema = z.object({ toSeq: z.number().int().positive().optional() });

// ---------- shadow.workflowInspect (SHADOW-WORKFLOW-VISIBILITY) ----------
// A WORKFLOW shadow row has no transcript of its own: the workflow's inner agents run as
// separate harness-side processes whose events never flow through the parent SDK session, so
// nothing reaches the parent's transcript. Their activity lives ONLY on disk under the
// workflow's transcriptDir (journal.jsonl + per-agent agent-<id>.jsonl), whose path the parent's
// Workflow tool_result prints. This RPC parses that dir ON DEMAND (no watchers, v1 poll) so a UI
// can show the inner-agent roster and drill into one inner agent's transcript tail. UI-only,
// LOCAL-ONLY (never an agent MCP tool, never a peer method).
const ShadowWorkflowInspectRequestSchema = z.object({
  agentId: z.string().min(1),
  // When set, additionally return this inner agent's transcript tail (drill-down).
  innerAgentId: z.string().min(1).optional(),
  // Tail length for the inner-agent transcript (ignored without innerAgentId). Default 200.
  tailLines: z.number().int().positive().max(2000).optional(),
}).strict();

// PLAN-HOOKS.md §2/§6.1 (HOOK-2): sub.create/remove/list — the agent-facing event-subscription
// primitive's RPC surface, implemented by SubscriptionRegistry (packages/core/src/subscriptions.ts)
// via SubRpc. LOCAL-ONLY (absent from PEER_METHODS, like agent.wait) — subscriptions never
// federate in v1 (§2.4). `subscriberId` is a normal request field; the CALLER (the future
// subscribe/unsubscribe/subscriptions_list MCP tools, HOOK-3) is responsible for stamping it
// from ctx and never trusting a caller-supplied value.
// F46: the content-topic rules are applied AFTER the `.omit()` (see contentFilterIssue's own
// note on why it is a function, not a refinement baked into SubscriptionSchema).
const SubCreateRequestSchema = SubscriptionSchema.omit({ id: true }).strict().superRefine((s, ctx) => {
  const issue = contentFilterIssue(s.topic, s.filter, { once: s.once }) ?? scopeFilterIssue(s.filter);
  if (issue) ctx.addIssue({ code: "custom", message: issue, path: ["filter"] });
});
const SubRemoveRequestSchema = z.object({ subscriberId: z.string().min(1), id: z.string().min(1) }).strict();
const SubListRequestSchema = z.object({ subscriberId: z.string().min(1) }).strict();
export const WorkflowInnerAgentSchema = z.object({
  agentId: z.string(),
  agentType: z.string().nullable(),   // agent-<id>.meta.json agentType (e.g. "general-purpose")
  label: z.string().nullable(),        // first user-prompt line, truncated (no explicit label is persisted on disk)
  phase: z.string().nullable(),        // reserved — the workflow phase() group is not persisted on disk (always null in v1)
  state: z.enum(["running", "done"]),  // "done" once journal.jsonl carries a result record for this agent
  resultPreview: z.string().nullable(),
  lastActivityTs: z.number().nullable(),   // epoch ms — newest transcript record, else the transcript file mtime
  spawnDepth: z.number().nullable(),
  model: z.string().nullable(),
}).strict();
export type WorkflowInnerAgent = z.infer<typeof WorkflowInnerAgentSchema>;
export const WorkflowTranscriptLineSchema = z.object({
  role: z.enum(["user", "assistant", "tool", "system"]),
  text: z.string(),
  ts: z.number().nullable(),
}).strict();
export type WorkflowTranscriptLine = z.infer<typeof WorkflowTranscriptLineSchema>;
export const ShadowWorkflowInspectResponseSchema = z.object({
  available: z.boolean(),        // false + reason when not a workflow / dir unknown / dir gone
  reason: z.string().nullable(),
  runId: z.string().nullable(),
  transcriptDir: z.string().nullable(),
  agents: z.array(WorkflowInnerAgentSchema),
  // Reserved: workflow log() narrator lines are not persisted to the workflow dir in this
  // runtime, so v1 always returns []. Kept in the contract so surfacing them later needs no
  // schema/UI change.
  narratorLines: z.array(z.string()),
  transcript: z.array(WorkflowTranscriptLineSchema).nullable(),   // present only when innerAgentId requested
}).strict();
export type ShadowWorkflowInspectResponse = z.infer<typeof ShadowWorkflowInspectResponseSchema>;

// ---------- queue.status response ----------
// QueueStore.status()'s actual return shape (core/src/queues.ts:349) — was never a named
// protocol schema before this; queue.statusSummary's QueueStatusSummarySchema is the
// (unrelated, paginated/projected) sibling.
export const QueueStatusSchema = z.object({
  spec: QueueSpecSchema,
  counts: QueueCountsSchema,
  tasks: z.array(TaskRecordSchema),
}).strict();
export type QueueStatus = z.infer<typeof QueueStatusSchema>;

// ---------- VOICE S2 (docs/superpowers/specs/2026-07-24-voice-agents-design.md §6/§10) ----------
// Mic session lifecycle + conversation-mode toggle. Minimal + additive: this slice wires the
// contract + a trivial in-memory session registry only — no audio/STT/TTS (S5/S7/S8) and no
// EventSink emitter for the voice_* event kinds yet (S4).
export const VoiceSessionStateSchema = z.enum(["idle", "listening", "transcribing", "speaking", "error"]);
export type VoiceSessionState = z.infer<typeof VoiceSessionStateSchema>;
const VoiceSessionRecordSchema = z.object({
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  state: VoiceSessionStateSchema,
  startedAt: z.number().int().nonnegative(),
}).strict();
export type VoiceSessionRecord = z.infer<typeof VoiceSessionRecordSchema>;
// Native audio stays on WebRTC. These operator RPCs only negotiate and lease a
// session; SDP and audio must never be copied into the durable agent event log.
const NativeVoiceTargetSchema = z.object({ agentId: z.string().min(1) }).strict();
const NativeVoiceSessionSchema = z.object({ sessionId: z.string().uuid() }).strict();
export const NativeVoiceMessageSchema = z.object({
  roomId: z.string().uuid().optional(),
  id: z.string().uuid(), sessionId: z.string().uuid(),
  role: z.enum(["user", "assistant"]), text: z.string().max(8192),
  final: z.boolean(), ts: z.number().int().nonnegative().max(8_640_000_000_000_000),
}).strict();
export type NativeVoiceMessage = z.infer<typeof NativeVoiceMessageSchema>;
const NativeVoiceRequestSchema = z.object({
  requestId: z.string().uuid(), agentId: z.string().min(1),
  callerAgentId: z.string().min(1).optional(), reason: z.string().max(500), expiresAt: z.number(),
}).strict();
export type NativeVoiceRequest = z.infer<typeof NativeVoiceRequestSchema>;
const NativeVoiceCallerTargetSchema = z.object({ agentId: z.string().min(1), callerAgentId: z.string().min(1).optional() }).strict();
const NativeVoiceStateSchema = z.object({
  active: z.boolean(),
  transcript: z.string().max(16384),
  error: z.string().max(4000).nullable(),
  messages: z.array(NativeVoiceMessageSchema).max(100).optional(),
}).strict();
export type NativeVoiceState = z.infer<typeof NativeVoiceStateSchema>;
const VoiceSessionStartRequestSchema = z.object({ agentId: z.string().min(1) }).strict();
const VoiceSessionStopRequestSchema = z.object({ sessionId: z.string().min(1) }).strict();
const VoiceSessionStopResponseSchema = z.object({ stopped: z.boolean() }).strict();
// Conversation mode (V2, §8) is gated on ProviderCapabilities.realtime — the toggle RPC itself
// is additive now so S9's engine can flip it without another protocol change.
const VoiceConversationSetRequestSchema = z.object({ agentId: z.string().min(1), enabled: z.boolean() }).strict();
const VoiceConversationSetResponseSchema = z.object({ agentId: z.string().min(1), enabled: z.boolean() }).strict();

// ---------- VOICE R1 (docs/superpowers/specs/2026-07-24-voice-realtime-design.md §7/§9) ----------
// Mints a short-lived OpenAI realtime ephemeral token, daemon-side, so the raw platform key
// never reaches the webview (§3 SECURITY invariant). This slice adds the schema + a STUB core
// handler (VoiceRpc, "credential"-coded VoiceRealtimeNotConfiguredError) that always rejects
// until RK1 wires the real `POST /v1/realtime/client_secrets` mint against a configured OpenAI
// voice account. Gate note (§1 correction): this is gated on "an OpenAI voice account is
// configured", NOT on the landed per-agent-provider ProviderCapabilities.realtime flag — that
// flag stays reserved for approach B (OpenAI S2S) only.
export const VoiceRealtimeModeSchema = z.enum(["transcription", "s2s"]);
export type VoiceRealtimeMode = z.infer<typeof VoiceRealtimeModeSchema>;
const VoiceRealtimeTokenRequestSchema = z.object({
  accountName: z.string().min(1).optional(),
  mode: VoiceRealtimeModeSchema,
  model: z.string().min(1).optional(),
}).strict();
const VoiceRealtimeTokenResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
  url: z.string().min(1),
  model: z.string().min(1),
}).strict();

// ---------- MCP-OAUTH slice 1: mcpstore OAuth 2.1 (auth-code + PKCE + DCR) contract ----------
// `finish` and `cancel` are UI-only, same as mcpstore.setAuth (McpStoreSetAuthParams in
// ./index.js) -- deliberately NOT registered in engine-help.ts's ENGINE_TOOL_NAMES, the app's
// commands.system.ts, or protocol/mcp-tools.ts's agent-facing tool table.
//
// MCP-AUTH-STATUS revises that for `start` ONLY, and the reason the original rule gave is the
// reason it can be revised: it was "for no benefit", not "unsafe". The benefit now exists --
// an agent whose mcp_store_call just died on a revoked grant is the first thing in the system
// to KNOW auth is gone, and it was previously stuck reporting a connection error to nobody.
// So `start` is agent-facing as mcp_store_reauth: it returns a pendingId + authorizeUrl the
// agent hands to a human (ask_human) and nothing else. An agent still cannot FINISH a flow --
// there is no browser in a daemon, the authorization code comes back over the loopback
// listener straight into the daemon, and no token ever passes through the agent's transcript.
// `finish`/`cancel` stay UI-only because an agent has nothing to do with either. This slice
// adds the schema + STUB core handlers only (both throw a
// clear "not implemented -- slice 2" protocol error) so ContractHandlers stays exhaustive;
// slice 2 fills in the real PKCE/DCR flow (MCP SDK 1.29.0 authProvider does the OAuth mechanics,
// core adds persistence + a loopback listener for the redirect).
const McpStoreOAuthStartRequestSchema = z.object({ name: McpStoreNameSchema }).strict();
const McpStoreOAuthStartResponseSchema = z.object({
  pendingId: z.string().min(1),
  authorizeUrl: z.string().min(1),
}).strict();
const McpStoreOAuthFinishRequestSchema = z.object({ pendingId: z.string().min(1) }).strict();
const McpStoreOAuthFinishResponseSchema = z.object({
  status: z.enum(["connected", "pending", "error"]),
  error: z.string().optional(),
}).strict();
// MCPSTORE-OAUTH-CANCEL: lets the UI abandon a pending Authorize flow instead of it idling
// out to the 10-minute McpStoreOAuthFlow timeout. Fire-and-forget from the caller's
// perspective (empty response) — the daemon-side effect (drop the pending record, close the
// loopback listener) is the same cleanup the timeout/failure paths already perform, so there
// is nothing for the response to report. Safe to call for an unknown/already-settled
// pendingId (no-op, never throws) — see McpStoreOAuthFlow.cancel().
const McpStoreOAuthCancelRequestSchema = z.object({ pendingId: z.string().min(1) }).strict();
const McpStoreOAuthCancelResponseSchema = z.object({}).strict();

// ---------- hook.* request schemas ----------
// HOOK-CRUD-RPC: hook rules are stored where they always were — ChimeraConfig.hooks on the
// config.d overlay — and the desktop HooksCard still reads/writes them through config.get/
// config.patch. What this family adds is a DAEMON-SIDE read-modify-write: doing it in the
// caller (get the array, splice it, patch it back) is three round trips, so two agents adding a
// rule at the same time silently clobber each other — JSON-merge-patch replaces an array
// wholesale, it cannot merge one. Brand-new RPCs, so `.strict()` per the new-RPC convention.
const HookCreateRequestSchema = z.object({ rule: HookRuleSchema }).strict();
// Sparse patch, mirroring queue.update/team.update: only the keys the caller set are touched,
// and the MERGED rule is re-validated as a whole HookRuleSchema before anything is written — a
// patch that would make the rule invalid leaves the stored one untouched.
const HookUpdateRequestSchema = z.object({
  name: z.string().min(1),
  patch: z.object({
    on: TopicSchema.optional(),
    filter: TopicFilterSchema.nullable().optional(),
    actions: z.array(HookActionSchema).min(1).max(4).optional(),
    enabled: z.boolean().optional(),
    maxChainDepth: z.number().int().positive().optional(),
    maxFiresPerHour: z.number().int().positive().optional(),
  }).strict().refine((p) => Object.keys(p).length > 0, { message: "patch must set at least one field" }),
}).strict();
const HookNameRequestSchema = z.object({ name: z.string().min(1) }).strict();
// Separate from hook.update's `enabled` for the same reason queue.pause/resume are separate from
// queue.update: flipping a rule off is a distinct, frequent operator action, not a config edit.
const HookSetEnabledRequestSchema = z.object({ name: z.string().min(1), enabled: z.boolean() }).strict();

// F22.2: worktree.leaseHandoff/leaseRelease carry an optional `callerAgentId` — absent on the
// direct-RPC path (TUI/app operator UI, always trusted), present when the call arrived through
// an MCP tool's resolve() (forced from ctx.agentId, the caller's own unforgeable identity) so
// engine.ts's handler can refuse a foreign agent releasing/handing off a lease it doesn't hold.
// The lease store itself (worktree-lease.ts) has no notion of a caller/principal — this is
// deliberately enforced one layer up, in the RPC handler, not the store.
const WorktreeLeaseHandoffRequestSchema = z.object({
  workdirKey: z.string().min(1),
  toAgentId: z.string().min(1),
  callerAgentId: z.string().min(1).optional(),
}).strict();
// QA of F22: leaseList carries the same optional `callerAgentId` for the same reason — absent
// (operator) means "the whole fleet", present (MCP, forced from ctx.agentId) means "only the
// leases you hold". Without it the tool handed every agent every tenant's holder id, label and
// absolute worktree path.
const WorktreeLeaseListRequestSchema = z.object({
  callerAgentId: z.string().min(1).optional(),
}).strict();
const WorktreeLeaseReleaseRequestSchema = z.object({
  workdirKey: z.string().min(1),
  force: z.boolean().default(false),
  callerAgentId: z.string().min(1).optional(),
}).strict();
// QA of F15/F22: the DRY-RUN half of the worktree-write gate — "would this write be refused, and
// why", asked BEFORE the write instead of read off the refusal afterwards. `callerAgentId` follows
// the same two-path idiom as the lease RPCs: forced from ctx.agentId on the MCP path (an agent can
// only ever ask AS ITSELF), absent on the operator's direct RPC — which then asks as a caller with
// no worktree of its own, the strictest case, for which every leased worktree is foreign.
// BOUNDED at 16 targets: this rides an MCP tool result and each target costs one path resolution.
const WorktreeExplainWriteRequestSchema = z.object({
  targets: z.array(z.string().min(1)).min(1).max(16),
  callerAgentId: z.string().min(1).optional(),
}).strict();

export const RPC_CONTRACT = {
  "canvas.get": defineRpc(canvas.CanvasGetSchema, canvas.CanvasGetResponseSchema),
  "canvas.saveLayout": defineRpc(canvas.CanvasSaveLayoutSchema, canvas.CanvasSaveResponseSchema),
  "group.list": defineRpc(z.object({}).strict(), GroupListResultSchema),
  "group.create": defineRpc(GroupCreateParamsSchema, AgentGroupSchema),
  "group.update": defineRpc(GroupUpdateParamsSchema, AgentGroupSchema),
  "group.delete": defineRpc(GroupDeleteParamsSchema, z.object({ ok: z.literal(true) }).strict()),
  "agent.setGroups": defineRpc(AgentSetGroupsParamsSchema, z.object({ ok: z.literal(true) }).strict()),
  "agent.addGroups": defineRpc(AgentChangeGroupsParamsSchema, z.object({ ok: z.literal(true) }).strict()),
  "agent.removeGroups": defineRpc(AgentChangeGroupsParamsSchema, z.object({ ok: z.literal(true) }).strict()),
  "agent.forkCapabilities": defineRpc(fork.ForkCapabilitiesRequestSchema, fork.ForkCapabilitiesSchema),
  "agent.fork": defineRpc(fork.ForkRequestSchema, fork.ForkResponseSchema),
  "operatorweb.operatorStatus": defineRpc(z.object({}).strict(), z.object({ enabled: z.boolean(), bundleAvailable: z.boolean(), limitation: z.string() }).strict()),
  "operatorweb.status": defineRpc(z.object({}).strict(), OperatorWebStatusSchema),
  "operatorweb.enable": defineRpc(z.object({}).strict(), OperatorWebStatusSchema),
  "operatorweb.disable": defineRpc(z.object({}).strict(), OperatorWebStatusSchema),
  "operatorweb.pairStart": defineRpc(OperatorWebPairStartSchema, OperatorWebPairCodeSchema),
  "operatorweb.sessionList": defineRpc(z.object({}).strict(), z.array(OperatorWebSessionSchema)),
  "operatorweb.sessionRevoke": defineRpc(z.object({ id: z.string().min(1).nullable() }).strict(), z.object({ revoked: z.number() }).strict()),
  "operatorweb.settingsSet": defineRpc(OperatorWebSettingsSchema, OperatorWebStatusSchema),
  "contextlink.create": defineRpc(ContextLinkCreateSchema, ContextLinkViewSchema),
  "contextlink.list": defineRpc(ContextLinkListSchema, ContextLinkListResponseSchema),
  "contextlink.get": defineRpc(ContextLinkTargetSchema, ContextLinkViewSchema),
  "contextlink.revoke": defineRpc(ContextLinkTargetSchema, ContextLinkViewSchema),
  "worktree.gitStatus": defineRpc(gitops.GitStatusRequestSchema, gitops.GitStatusSchema),
  "worktree.gitDiff": defineRpc(gitops.GitDiffRequestSchema, gitops.GitDiffSchema),
  "worktree.fileRead": defineRpc(gitops.FileReadRequestSchema, gitops.FileReadSchema),
  "worktree.fileWrite": defineRpc(gitops.FileWriteRequestSchema, gitops.FileWriteSchema),
  "worktree.gitStage": defineRpc(gitops.GitStageRequestSchema, gitops.GitStageSchema),
  "worktree.gitCommit": defineRpc(gitops.GitCommitRequestSchema, gitops.GitCommitSchema),
  "issues.sourceList": defineRpc(IssueSourceListRequestSchema, z.array(IssueSourceSchema)),
  "issues.sourceUpsert": defineRpc(IssueSourceUpsertRequestSchema, IssueSourceSchema),
  "issues.sourceRemove": defineRpc(IssueSourceRemoveRequestSchema, z.object({ removed: z.boolean() }).strict()),
  "issues.sync": defineRpc(IssueSyncRequestSchema, IssueSyncResultSchema),
  "issues.linkList": defineRpc(IssueLinkListRequestSchema, z.array(IssueBoardLinkSchema)),
  "issues.postComment": defineRpc(IssuePostCommentRequestSchema, IssuePostCommentResultSchema),
  "queue.create": defineRpc(QueueCreateRequestSchema, QueueSpecSchema),
  "queue.list": defineRpc(z.object({}).strict(), z.array(QueueSpecSchema)),
  "queue.update": defineRpc(QueueUpdateRequestSchema, QueueSpecSchema),
  "queue.delete": defineRpc(QueueDeleteRequestSchema, z.object({ deleted: z.boolean() }).strict()),
  "queue.push": defineRpc(QueuePushRequestSchema, TaskRecordSchema),
  "queue.status": defineRpc(QueueStatusRequestSchema, QueueStatusSchema),
  "queue.statusSummary": defineRpc(QueueStatusSummaryRequestSchema, QueueStatusSummarySchema),
  "queue.cancelTask": defineRpc(QueueCancelTaskRequestSchema, z.object({ cancelled: z.boolean() }).strict()),
  // RETRY-BACKOFF: replay a dead-lettered task (queues.ts requeue) — the only way out of
  // "dead_letter" besides letting it sit quarantined forever.
  "queue.requeue": defineRpc(QueueRequeueRequestSchema, TaskRecordSchema),
  // QUEUE-PAUSE: durable per-queue pause/resume. Pausing stops the scheduler from draining NEW
  // tasks off this queue (running agents finish naturally, pending tasks stay pending); resuming
  // ticks the scheduler so pending work drains immediately. Persisted in QueueSpec.paused — see
  // its doc comment in index.ts. Both return the updated QueueSpec.
  "queue.pause": defineRpc(QueuePauseRequestSchema, QueueSpecSchema),
  "queue.resume": defineRpc(QueueResumeRequestSchema, QueueSpecSchema),
  // TASK-EDIT-VERSIONING: sparse in-place edit of a pending/blocked task with append-only version
  // history — see QueueEditTaskRequestSchema. Returns the updated TaskRecord (its versions[] head
  // is the new edit). Rejected with a clear protocol error on in_progress/terminal tasks.
  "queue.editTask": defineRpc(QueueEditTaskRequestSchema, TaskRecordSchema),
  // QUEUE-REORDER: see the request schemas' own comments above. All three return the updated
  // TaskRecord (moveTask/addDependency) or the freshly cloned one (retryTask).
  "queue.moveTask": defineRpc(QueueMoveTaskRequestSchema, TaskRecordSchema),
  "queue.retryTask": defineRpc(QueueRetryTaskRequestSchema, TaskRecordSchema),
  "queue.addDependency": defineRpc(QueueAddDependencyRequestSchema, TaskRecordSchema),
  "queue.explainTask": defineRpc(QueueExplainTaskRequestSchema, TaskExplainResultSchema),
  // AGENT-INITIATED-REMEDIATION: records the request; the actual jump happens later, at this
  // turn's end (scheduler.ts's handleWorkflowTurn) — see QueueRequestRemediationRequestSchema.
  "queue.requestRemediation": defineRpc(QueueRequestRemediationRequestSchema, QueueRequestRemediationResponseSchema),
  "evidence.get": defineRpc(EvidenceGetRequestSchema, TaskEvidenceSchema),
  "journal.query": defineRpc(JournalQueryRequestSchema, JournalQueryResponseSchema),
  "history.runs": defineRpc(HistoryRunsRequestSchema, HistoryRunsResponseSchema),
  "review.get": defineRpc(ReviewGetRequestSchema, ReviewSessionSchema),
  "review.finding.add": defineRpc(ReviewFindingAddRequestSchema, ReviewFindingSchema),
  "review.finding.resolve": defineRpc(ReviewFindingResolveRequestSchema, ReviewFindingSchema),
  "review.decide": defineRpc(ReviewDecideRequestSchema, ReviewSessionSchema),
  "team.create": defineRpc(TeamCreateRequestSchema, TeamSpecSchema),
  "team.list": defineRpc(z.object({}).strict(), z.array(TeamListEntrySchema)),
  "team.status": defineRpc(TeamNameRequestSchema, TeamStatusResponseSchema),
  "team.mine": defineRpc(TeamMineRequestSchema, TeamMineResponseSchema),
  "team.dissolve": defineRpc(TeamNameRequestSchema, z.object({ ok: z.literal(true) }).strict()),
  "team.update": defineRpc(TeamUpdateRequestSchema, TeamSpecSchema),
  "team.attachRole": defineRpc(TeamAttachRoleRequestSchema, TeamSpecSchema),
  "team.detachRole": defineRpc(TeamDetachRoleRequestSchema, TeamSpecSchema),
  "team.updateRoleBinding": defineRpc(TeamUpdateRoleBindingRequestSchema, TeamSpecSchema),
  "role.create": defineRpc(RoleCreateRequestSchema, RoleSpecSchema),
  "role.list": defineRpc(z.object({}).strict(), z.array(RoleSpecSchema)),
  "role.update": defineRpc(RoleUpdateRequestSchema, RoleSpecSchema),
  "role.delete": defineRpc(RoleNameRequestSchema, z.object({ ok: z.literal(true) }).strict()),
  "workflow.create": defineRpc(WorkflowCreateRequestSchema, WorkflowRecordSchema),
  "workflow.list": defineRpc(z.object({}).strict(), z.array(WorkflowRecordSchema)),
  "workflow.update": defineRpc(WorkflowUpdateParams, WorkflowRecordSchema),
  "workflow.delete": defineRpc(WorkflowNameRequestSchema, z.object({ deleted: z.boolean() }).strict()),
  // FEATURE WORKFLOW-RUN-P1: compiles `spec` into a fresh ephemeral WorkflowRecord and
  // pushes ONE task bound to it, riding the exact same gate/checkpoint/budget machinery
  // as any named workflow — see WorkflowRpc.handlers["workflow.run"].
  "workflow.run": defineRpc(WorkflowRunRequestSchema, TaskRecordSchema),
  // FEATURE WORKFLOW-RUN-P2: see WorkflowPlanRequestSchema above — WorkflowRpc.handlers
  // ["workflow.plan"] composes workflow.run's exact queue-resolution/provision code path.
  "workflow.plan": defineRpc(WorkflowPlanRequestSchema, WorkflowPlanResponseSchema),
  "artifact.add": defineRpc(ArtifactAddRequestSchema, ArtifactRecordSchema),
  "artifact.list": defineRpc(ArtifactListRequestSchema, z.array(ArtifactRecordSchema)),
  "artifact.get": defineRpc(ArtifactIdRequestSchema, ArtifactRecordSchema),
  "audit.verify": defineRpc(AuditVerifyRequestSchema, AuditVerifyResultSchema),
  "budget.resume": defineRpc(BudgetResumeRequestSchema, BudgetResumeResponseSchema),
  "events.search": defineRpc(ChronicleSearchRequestSchema, ChronicleSearchResponseSchema),
  "events.searchExport": defineRpc(ChronicleExportRequestSchema, ChronicleExportResponseSchema),
  // CHRONICLE-SEMANTIC — see the schemas in index.ts for why search and get are separate calls.
  "chronicle.search": defineRpc(ChronicleSemanticSearchParamsSchema, ChronicleSemanticSearchResultSchema),
  "chronicle.get": defineRpc(ChronicleGetParamsSchema, ChronicleGetResultSchema),
  "chronicle.status": defineRpc(z.object({}).strict(), ChronicleIndexStatusSchema),
  "chronicle.reindex": defineRpc(z.object({}).strict(), ChronicleReindexResultSchema),
  // TERMINAL-READBACK: the app tees its PTY output in; an agent (or the UI) reads the tail back.
  // SKILL-DISCOVERY: find a skill by what it does, then load its text on demand.
  "skill.search": defineRpc(SkillSearchRequestSchema, SkillSearchResponseSchema),
  "skill.read": defineRpc(SkillReadRequestSchema, SkillReadResponseSchema),
  "terminal.append": defineRpc(TerminalAppendRequestSchema, TerminalAppendResponseSchema),
  "terminal.read": defineRpc(TerminalReadRequestSchema, TerminalReadResponseSchema),
  "terminal.write": defineRpc(TerminalWriteRequestSchema, TerminalWriteResponseSchema),
  "terminal.tabState": defineRpc(TerminalTabStateRequestSchema, TerminalTabStateResponseSchema),
  "agent.resources": defineRpc(AgentResourcesRequestSchema, AgentResourcesResponseSchema),
  "host.admission": defineRpc(z.object({}).strict(), HostAdmissionSchema),
  "health.status": defineRpc(HealthStatusRequestSchema, z.array(AgentHealthSchema)),
  // Same "no AgentRecordSchema yet" loose-record convention as team.status's `agents` field.
  "replay.agentsAsOf": defineRpc(ReplayAgentsAsOfRequestSchema, z.array(z.record(z.string(), z.unknown()))),
  // SHADOW-WORKFLOW-VISIBILITY: on-demand inspect of a WORKFLOW shadow's inner agents. UI-only.
  "shadow.workflowInspect": defineRpc(ShadowWorkflowInspectRequestSchema, ShadowWorkflowInspectResponseSchema),
  // PLAN-HOOKS.md §2 (HOOK-2): agent-facing event subscriptions — see SubCreateRequestSchema above.
  "sub.create": defineRpc(SubCreateRequestSchema, SubscriptionSchema),
  "sub.remove": defineRpc(SubRemoveRequestSchema, z.object({ removed: z.boolean() }).strict()),
  "sub.list": defineRpc(SubListRequestSchema, z.array(SubscriptionSchema)),
  // HOOK-CRUD-RPC: atomic CRUD over ChimeraConfig.hooks — see the request schemas above.
  "hook.list": defineRpc(z.object({}).strict(), z.array(HookRuleSchema)),
  "hook.create": defineRpc(HookCreateRequestSchema, HookRuleSchema),
  "hook.update": defineRpc(HookUpdateRequestSchema, HookRuleSchema),
  "hook.setEnabled": defineRpc(HookSetEnabledRequestSchema, HookRuleSchema),
  "hook.delete": defineRpc(HookNameRequestSchema, z.object({ deleted: z.literal(true) }).strict()),
  // VOICE S2: mic session lifecycle + conversation-mode toggle — see VoiceSessionRecordSchema above.
  "stt.configure": defineRpc(SttPreferencesSchema, SttPreferencesSchema),
  "stt.status": defineRpc(z.object({}).strict(), SttStatusSchema),
  "stt.install": defineRpc(SttInstallSchema, SttStatusSchema),
  "stt.installCancel": defineRpc(z.object({}).strict(), z.object({ cancelled: z.boolean() }).strict()),
  "stt.uninstall": defineRpc(z.object({}).strict(), z.object({ removed: z.boolean() }).strict()),
  "stt.transcribe": defineRpc(SttTranscribeSchema, SttTranscriptSchema),
  "stt.transcribeCancel": defineRpc(SttCancelSchema, z.object({ cancelled: z.boolean() }).strict()),
  "voice.session.start": defineRpc(VoiceSessionStartRequestSchema, VoiceSessionRecordSchema),
  "voice.session.stop": defineRpc(VoiceSessionStopRequestSchema, VoiceSessionStopResponseSchema),
  "voice.conversation.set": defineRpc(VoiceConversationSetRequestSchema, VoiceConversationSetResponseSchema),
  // VOICE R1: mint an ephemeral OpenAI realtime token — see VoiceRealtimeTokenRequestSchema above.
  "voice.realtime.token": defineRpc(VoiceRealtimeTokenRequestSchema, VoiceRealtimeTokenResponseSchema),
  "voice.native.check": defineRpc(NativeVoiceTargetSchema, z.object({ needsTransition: z.boolean() }).strict()),
  "voice.native.configure": defineRpc(z.object({ agentId: z.string().min(1), enabled: z.boolean() }).strict(), z.object({ enabled: z.boolean() }).strict()),
  "voice.native.start": defineRpc(z.object({
    agentId: z.string().min(1), sessionId: z.string().uuid(),
    sdp: z.string().min(1).max(65536), acknowledgeTransition: z.boolean().default(false),
    requestId: z.string().uuid().optional(),
    meeting: VoiceRoomLeaseSchema.optional(),
  }).strict(), z.object({ sdp: z.string().min(1).max(65536) }).strict()),
  "voice.native.poll": defineRpc(NativeVoiceSessionSchema, NativeVoiceStateSchema),
  "voice.native.stop": defineRpc(NativeVoiceSessionSchema, VoiceSessionStopResponseSchema.extend({ messages: z.array(NativeVoiceMessageSchema).max(100).optional() })),
  "voice.native.history": defineRpc(NativeVoiceTargetSchema, z.object({ messages: z.array(NativeVoiceMessageSchema).max(100) }).strict()),
  "voice.native.request": defineRpc(NativeVoiceCallerTargetSchema.extend({ reason: z.string().max(500).default("") }), NativeVoiceRequestSchema),
  "voice.native.requests": defineRpc(z.object({}).strict(), z.array(NativeVoiceRequestSchema).max(16)),
  "voice.native.dismiss": defineRpc(z.object({ requestId: z.string().uuid() }).strict(), z.object({ dismissed: z.boolean() }).strict()),
  "voice.native.end": defineRpc(NativeVoiceCallerTargetSchema, VoiceSessionStopResponseSchema),
  "voice.native.text": defineRpc(NativeVoiceSessionSchema.extend({ text: z.string().min(1).max(65536), role: z.enum(["user", "developer"]).default("user") }), z.object({ accepted: z.boolean() }).strict()),
  "voice.room.create": defineRpc(VoiceRoomSpecSchema.extend({ callerAgentId: z.string().min(1).optional() }), VoiceRoomSchema),
  "voice.room.list": defineRpc(z.object({ callerAgentId: z.string().min(1).optional() }).strict(), z.object({ rooms: z.array(VoiceRoomSchema), limits: VoiceLimitsSchema }).strict()),
  "voice.room.update": defineRpc(VoiceRoomTargetSchema.extend({ spec: VoiceRoomSpecSchema, revision: z.number().int() }), VoiceRoomSchema),
  "voice.room.end": defineRpc(VoiceRoomTargetSchema.extend({ reason: z.string().min(1).max(1000).optional(), source: z.string().min(1).max(80).optional() }), VoiceRoomSchema),
  "voice.room.delete": defineRpc(VoiceRoomTargetSchema, z.object({ deleted: z.boolean() }).strict()),
  "voice.room.approve": defineRpc(VoiceRoomLeaseSchema.extend({ revision: z.number().int() }), VoiceRoomSchema),
  "voice.room.reviewUpdate": defineRpc(VoiceRoomLeaseSchema.extend({ revision: z.number().int(), accept: z.boolean() }), VoiceRoomSchema),
  "voice.room.heartbeat": defineRpc(VoiceRoomLeaseSchema, VoiceRoomSchema),
  "voice.room.cancelPlan": defineRpc(VoiceRoomLeaseSchema.extend({ requestId: z.string().uuid() }), z.object({ cancelled: z.boolean() }).strict()),
  "voice.room.plan": defineRpc(VoiceRoomLeaseSchema.extend({ requestId: z.string().uuid(), revision: z.number().int(), input: MeetingPlanInputSchema }), MeetingPlanSchema),
  "voice.room.report": defineRpc(VoiceRoomLeaseSchema.extend({ diagnostic: VoiceDiagnosticInputSchema }), z.object({ recorded: z.boolean() }).strict()),
  "voice.room.removeParticipant": defineRpc(VoiceRoomLeaseSchema.extend({ agentId: z.string().min(1), revision: z.number().int() }), VoiceRoomSchema),
  // MCP-OAUTH slice 1: UI-only OAuth 2.1 start/finish for a store server — see
  // McpStoreOAuthStartRequestSchema above. STUB handlers until slice 2.
  "mcpstore.oauth.start": defineRpc(McpStoreOAuthStartRequestSchema, McpStoreOAuthStartResponseSchema),
  "mcpstore.oauth.finish": defineRpc(McpStoreOAuthFinishRequestSchema, McpStoreOAuthFinishResponseSchema),
  "mcpstore.oauth.cancel": defineRpc(McpStoreOAuthCancelRequestSchema, McpStoreOAuthCancelResponseSchema),
  // F22.2: list/handoff/release RPCs over the single-writer worktree lease store (see
  // the handoff/release schemas above for the callerAgentId operator-or-holder-only design).
  "worktree.leaseList": defineRpc(WorktreeLeaseListRequestSchema, z.array(WorktreeLeaseViewSchema)),
  "worktree.leaseHandoff": defineRpc(WorktreeLeaseHandoffRequestSchema, WorktreeLeaseSchema),
  "worktree.leaseRelease": defineRpc(WorktreeLeaseReleaseRequestSchema, z.object({ released: z.boolean() }).strict()),
  // QA of F15/F22: the dry-run the F22 verdict promised "from day one" — the same evaluation the
  // permission gate runs, reachable before the write rather than only explainable after it.
  "worktree.explainWrite": defineRpc(WorktreeExplainWriteRequestSchema, WorktreeExplainWriteResultSchema),
} as const;

export type RpcContractMap = typeof RPC_CONTRACT;
export type RpcMethod = keyof RpcContractMap;
export type RpcRequestFor<M extends RpcMethod> = z.infer<RpcContractMap[M]["request"]>;
export type RpcResponseFor<M extends RpcMethod> = z.infer<RpcContractMap[M]["response"]>;

// TYPED-CLIENT-SDK: the CALLER-facing counterpart of RpcRequestFor. `z.infer` (used above) is
// zod's OUTPUT type — every field with a `.default()` becomes required, because ContractHandlers'
// server-side handlers run AFTER the daemon has already parsed+defaulted the raw params. A
// caller of ChimeraClient.call/FamilyClient sends the PRE-parse shape instead (same as calling
// `schema.parse()` directly — a `.default()` field is optional to supply), so it needs `z.input`,
// zod's genuinely different pre-transform type. Deliberately NOT changing RpcRequestFor itself:
// that would ripple into every ContractHandlers implementation (packages/core/src/rpc/*.ts),
// which correctly relies on defaults already being resolved by the time a handler runs.
export type RpcRequestInputFor<M extends RpcMethod> = z.input<RpcContractMap[M]["request"]>;

// ---------- TYPED-CLIENT-SDK: per-family method groups + opt-in response validation ----------
// Pure type-level computation over RpcMethod — no hand-maintained family list. A future family
// (agent.*, project.*, ...) landing in RPC_CONTRACT via the separate RpcContract-migration thread
// changes NOTHING here; RpcFamily/RpcLeaf/FamilyClient recompute automatically from the wider
// RpcMethod union, and buildFamilyClient() below picks it up at runtime with zero new code.
// `M extends string = RpcMethod` (rather than referencing RpcMethod directly in the `extends`
// check) is required, not stylistic: TS conditional types only distribute over a union when the
// checked type is a BARE type parameter. RpcMethod is a fixed alias, not a parameter — checking
// it directly (`RpcMethod extends ...`) tests the WHOLE union at once, which fails (and degrades
// to the `never` branch) the instant the pattern only matches SOME members, exactly the case for
// every family-specific `RpcLeaf<F>` lookup. Routing through a defaulted generic parameter `M`
// makes the checked type a naked parameter again, restoring per-member distribution.
export type RpcFamily<M extends string = RpcMethod> = M extends `${infer F}.${string}` ? F : never;
export type RpcLeaf<F extends string, M extends string = RpcMethod> = M extends `${F}.${infer L}` ? L : never;

export type RpcCallOpts = { validateResponse?: boolean };
export type RpcCallFn = <M extends RpcMethod>(
  method: M, params: RpcRequestInputFor<M>, opts?: RpcCallOpts,
) => Promise<RpcResponseFor<M>>;

// `Extract<..., RpcMethod>` is a defensive idiom: `${F}.${L}` reconstructed from two
// independently-derived mapped-type params doesn't always get accepted directly as satisfying
// the `M extends RpcMethod` constraint RpcRequestInputFor/RpcResponseFor need, even though by
// construction (RpcLeaf only yields leaves that exist under F) it always IS a real RpcMethod.
export type FamilyClient = {
  [F in RpcFamily]: {
    [L in RpcLeaf<F>]: (
      params: RpcRequestInputFor<Extract<`${F}.${L}`, RpcMethod>>, opts?: RpcCallOpts,
    ) => Promise<RpcResponseFor<Extract<`${F}.${L}`, RpcMethod>>>
  }
};

// Runtime counterpart: groups Object.keys(RPC_CONTRACT) by the "." prefix, binding each leaf to
// the caller-supplied `call`. Shared by every transport (ChimeraClient's real socket, the Tauri
// app's bridge) so the grouping logic itself is never duplicated.
export function buildFamilyClient(call: RpcCallFn): FamilyClient {
  const groups: Record<string, Record<string, unknown>> = {};
  for (const method of Object.keys(RPC_CONTRACT) as RpcMethod[]) {
    const dot = method.indexOf(".");
    const family = method.slice(0, dot), leaf = method.slice(dot + 1);
    (groups[family] ??= {})[leaf] =
      (params: unknown, opts?: RpcCallOpts) => call(method, params as never, opts);
  }
  return groups as FamilyClient;
}

// Opt-in runtime response validation, shared by every transport for the same DRY reason. Throws
// the daemon's own {code,message} shape (code:"protocol") so existing error classifiers
// (isUnknownMethod-style checks in the app's store) keep working unchanged against it.
export function validateRpcResponse<M extends RpcMethod>(method: M, value: unknown): RpcResponseFor<M> {
  const result = RPC_CONTRACT[method].response.safeParse(value);
  if (!result.success) {
    throw { code: "protocol", message: `response validation failed for "${method}": ${result.error.message}` };
  }
  return result.data as RpcResponseFor<M>;
}

// The exhaustiveness seam (see file header). A handler map is assigned to this type as ONE
// object literal — deleting a key, or adding a key that isn't a real RpcMethod, is a tsc
// error, not a runtime surprise.
export type ContractHandlers = {
  [M in RpcMethod]: (req: RpcRequestFor<M>) => Promise<RpcResponseFor<M>> | RpcResponseFor<M>;
};

export function isContractMethod(method: string): method is RpcMethod {
  return Object.prototype.hasOwnProperty.call(RPC_CONTRACT, method);
}
