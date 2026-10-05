import { CanvasRpc } from "./rpc/canvas-rpc.js";
import { CanvasStore } from "./canvas-store.js";
import { ConversationForks } from "./fork.js";
import { ForkRpc } from "./rpc/fork-rpc.js";
import { OperatorWeb } from "./operator-web.js";
import { operatorWebEngine } from "./operator-web-engine.js";
import { OperatorWebRpc } from "./rpc/operator-web-rpc.js";
import { ContextLinkStore } from "./context-links.js";
import { ContextLinksRpc } from "./rpc/context-links-rpc.js";
import { GitOpsRpc } from "./rpc/gitops-rpc.js";
import { GitOpsError } from "./gitops.js";
import { leaseKeyForPath } from "./worktree-lease.js";
import { LocalStt } from "./stt.js";
import { SttRpc } from "./rpc/stt-rpc.js";
import { IssuesBoard } from "./issues-board.js";
import { IssuesRpc } from "./rpc/issues-rpc.js";
import { McpStoreMonitorParams } from "@chimera/protocol";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION, AgentBulkParamsSchema, AgentReleaseParamsSchema, AccountUncoolParamsSchema,
  AgentRenameParamsSchema, AgentReconfigureParamsSchema,
  SecretSetParams, SecretNameParams, SecretGrantParams, SecretRevokeParams, SecretForAgentParams, SecretReadParams, AgentFindParamsSchema, QuestionAnswerSchema, QuestionOptionSchema, QuestionDefaultSchema,
  AgentMarkSeenParamsSchema, isAgentUnseen,
  QueueSpecSchema,
  isPeerMethod, parseAgentAddress, formatAgentAddress, assertFederationSafeSpec,
  MailboxForwardParamsSchema, ContentBlockSchema, AgentSendOptionsSchema, AssignParams, DispatchParams, AnswerDialogParams, SetModelParams,
  SetEffortParams, SetTurnLimitParams, SetAccountParams, AgentHandoffParams, AgentRebindParams,
  RemoteControlParams, CompactParams, FsListParams, FsReadParams, FsResolveParams,
  AgentBulkSendParamsSchema, AgentBulkResumeParamsSchema,
  MemoryAddParams, MemoryEditParams, MemoryDeleteParams, MemorySearchParams, MemoryGetParams, MemoryStatsParams, MemoryGraphParams, MemoryIndexParams, ToolPolicyModeSchema, ToolPolicySchema,
  PeerConfigSchema, InviteCreateParams, InviteRevokeParams, FedJoinParams, FedGrantParams, JobUpdateParams,
  UsageQueryParams,
  FedCloudflareUpParamsSchema, type CloudflareProvisionStatus,
  SliRollupParamsSchema,
  CheckpointCwdParams, CheckpointCreateParams, CheckpointRevertParams,
  McpStoreEntrySchema, BuiltInsInstallParamsSchema, McpStoreRemoveParams, McpStoreToolsParams, McpStoreCallParams, McpStoreSessionParams, McpStoreImportParams, McpStoreSetDirectParams,
  McpStoreSetAuthParams, McpStoreDetectAuthParams, McpStoreSetAuthKindParams, McpStoreSetEnabledParams, McpStoreSetTrustParams, McpStoreAuthStatusParams, resolveDefaultOAuthScopes,
  encodePairBlob, decodePairBlob, CLIENT_CAP_UI_COMPONENTS, CONDUCTOR_PLAYBOOK,
  estimateChimeraMcpToolSurface, TOOL_SURFACE_NOTE,
  type PeerConfig, type PeerEndpoint, type EngineCard, type ChimeraConfig, type ToolPolicy,
  type FedJoinResult, type FedJoinStepResult, type ProjectSpec, type DispatchResult, type AgentSummary,
  type TeamSpec, type McpStoreHttpAuth, type NormalizedEvent, type ReviewSession, type ChronicleSearchScope,
  WorktreeSetupHookSchema,
} from "@chimera/protocol";
// FEATURE-8: the RpcContract seam — imported from its own subpath (not the barrel) since
// contract.ts itself imports FROM @chimera/protocol's index and re-exporting it there would
// create an import cycle. See contract.ts's file header.
import { RPC_CONTRACT, NativeVoiceMessageSchema, isContractMethod, type ContractHandlers, type RpcMethod } from "@chimera/protocol/contract";
import { rpcError } from "./rpc-error.js";
import { AccountRegistry, accountHasKey, ConfigError } from "./accounts.js";
import { ConfigStore, scrubSecretShapes } from "./configstore.js";
import { MacKeychain, accountService, mcpStoreAuthService, type Keychain } from "./keychain.js";
import { SecretStore, secretEnvVar, type SecretGrantMode } from "./secrets.js";
import { RealAccountProber, type AccountProber } from "./prober.js";
import { CredentialResolver, type ExecFn } from "./credentials.js";
import { classifyCredential } from "./credential-classify.js";
import {
  CloudflareProvisioner, cloudflareTunnelTokenService, cloudflareAccessSelfSecretService, type CfFetchFn,
} from "./cloudflare.js";
import { selfprobeCloudflareTunnel, type ProbeFn } from "./cloudflare-selfprobe.js";
import { OAuthTokenStore } from "./providers/oauth.js";
import { PROVIDERS, findProvider, findEffectiveProvider, effectiveCatalog } from "./providers/catalog.js";
import { buildBackends, type BuildBackendsDeps } from "./providers/registry.js";
import { ModelCatalogService } from "./providers/model-catalog.js";
import { GroupStore } from "./groups.js";
import { fetchProviderModels } from "./providers/models.js";
import { fetchCodexCliModels } from "./providers/codex-cli-models.js";
import { ModelListCache, installModelListCache, type ModelOption } from "./providers/model-list-cache.js";
import { probeClaudeModelsDefault, probeKimiModels } from "./providers/model-probes.js";
import { PendingOAuthStore } from "./providers/pending-oauth.js";
import {
  CopilotOAuthFlow, CopilotTokenRefresher, GrokCliOAuthFlow, GrokCliTokenRefresher, type OAuthFlow,
} from "./providers/oauth-flows.js";
import { EventLog } from "./events.js";
import { UsageLedger } from "./usage.js";
import { StepJournal, stepInputDigest } from "./step-journal.js";
import { MailboxStore } from "./mailbox.js";
import { CooldownTracker, QuotaTracker, type CrashLoopPolicy } from "./failover.js";
import { QuotaPoller } from "./quota-poll.js";
import { AgentSupervisor, agentRecency, resolveAgentSpec, UnknownAgentError, type AgentRecord } from "./supervisor.js";
import { GuardrailError } from "./errors.js";
import { resolveWorkdirPath, worktreePath } from "./workdir.js";
import { AgentArchiveStore } from "./agent-archive.js";
import { TeamManager } from "./teams.js";
import { RoleStore } from "./roles-store.js";
import { resolveRole } from "./shared-roles.js";
import { migrateRolesOnBoot } from "./roles-migration.js";
import { QueueStore, RemediationRequestInvalidError } from "./queues.js";
import { MemoryStore } from "./memory.js";
import { MemoryVectorIndex } from "./memory-index.js";
import { ChronicleIndex } from "./chronicle-index.js";
import { TerminalLog, stripTerminalText } from "./terminal-log.js";
import { terminalKeyNames, terminalKeySequence } from "./terminal-keys.js";
import { indexSkills, readSkill, searchSkills } from "./skills.js";
import { distillEvent } from "./chronicle-distill.js";
import { resolveEmbeddingProvider } from "./memory-embed.js";
import {
  ProjectStore, DuplicateProjectError, ProjectConflictError, ProjectPathError,
  isPathUnder, isGitSource, deriveProjectName, gitClone, resolveProjectBaseDir, gitInitSeed,
} from "./projects.js";
import { MainConductorStore } from "./main-conductor.js";
import { listDir, readAtWidenedRoot, readFile } from "./fsbrowse.js";
import { scanClaudeAgents, foldRoleKey, type SettingSource } from "./claude-agents.js";
import { PluginRegistry } from "./plugins.js";
import { McpStoreRegistry, McpStoreConnectionManager } from "./mcpstore.js";
import { builtInStatuses, findRuntimeRoot, loadBuiltInContext, reconcileBuiltIns, rollbackBuiltInMigration, type BuiltInContext } from "./builtin-integrations.js";
import { installLaya } from "./laya-install.js";
import { McpPackageInstaller } from "./mcp-packages.js";
import { LoopbackMcpListener } from "./mcp-listener.js";
import { McpStoreOAuthFlow, McpStoreOAuthNotConfiguredError } from "./providers/mcpstore-oauth.js";
import { detectMcpStoreOAuth } from "./providers/mcpstore-oauth-detect.js";
import { McpImportScanner, sanitizeMcpStoreName } from "./mcp-imports.js";
import { HostToolsScanner, ToolPolicyStore, realishPath, type HostToolInfo } from "./hosttools.js";
import { CapabilityBroker } from "./broker.js";
import { AuditLedger } from "./audit-ledger.js";
import { WorktreeLeaseStore } from "./worktree-lease.js";
import {
  NetworkManager, ensureFedSshKey, acceptFedKey, removeFedKey, retagFedKey,
  mintInviteKeypair, writeIdentityKeyFile, removeIdentityKeyFile,
  realReadHostKeys, materializeKnownHosts, removeKnownHostsEntries,
  type NetExecFn, type PathExistsFn, type ReadHostKeysFn,
} from "./network.js";
import { QueueScheduler, type GateExecFn } from "./scheduler.js";
import { JobScheduler } from "./jobs.js";
import { makeWakeScheduler } from "./wake.js";
import { WorkflowStore } from "./workflows.js";
import { ArtifactStore } from "./artifacts.js";
import { CheckpointStore } from "./checkpoints.js";
import { SpanRecorder } from "./otel.js";
import { EvidenceStore } from "./evidence.js";
import { ReviewStore } from "./reviews.js";
import { TeamRpc } from "./rpc/team-rpc.js";
import { RoleRpc } from "./rpc/role-rpc.js";
import { WorkflowRpc } from "./rpc/workflow-rpc.js";
import { ArtifactRpc } from "./rpc/artifact-rpc.js";
import { ResourcesRpc } from "./rpc/resources-rpc.js";
import { HealthRpc } from "./rpc/health-rpc.js";
import { ShadowRpc } from "./rpc/shadow-rpc.js";
import { SubRpc } from "./rpc/sub-rpc.js";
import { HookRpc } from "./rpc/hook-rpc.js";
import { VoiceRpc } from "./rpc/voice-rpc.js";
import { NativeVoiceRpc } from "./rpc/native-voice-rpc.js";
import { VoiceRoomRpc } from "./rpc/voice-room-rpc.js";
import { voiceAgentName } from "@chimera/protocol/agent-name";
import { SubscriptionRegistry } from "./subscriptions.js";
import { HealthMonitor, listRunningChimeradProcesses, listRunningAgentProcesses, type ChimeradProcess, type AgentOsProcess } from "./health.js";
import { DynamicCapTracker } from "./dynamic-cap.js";
import { NotifyEvaluator, type FetchFn as NotifyFetchFn, type TimerFn as NotifyTimerFn, type ClearTimerFn as NotifyClearTimerFn } from "./notify.js";
import { RepoWatcher } from "./repo-watch.js";
import { HookEngine } from "./hooks.js";
import type { AgentBackend, ResolvedAgentSpec } from "./backend.js";
import { EngineIdentity } from "./federation/identity.js";
import { FederationManager } from "./federation/manager.js";
import { InviteStore } from "./federation/invites.js";
import { RunHistoryStore } from "./run-history.js";
import { probeTunnel, runPairingHandshake } from "./federation/pairing.js";

const Id = z.object({ agentId: z.string() });
const SpawnParams = z.object({ spec: z.unknown(), depth: z.number().int().min(0).optional(), maxDepthCap: z.number().int().positive().optional(), treeId: z.string().optional(),
  // Coverage B12b: an OPTIONAL team+role membership carried by a direct agent.spawn so
  // the app's `r run team` (no-queue) path stamps the same {team, role} the scheduler's
  // queued spawnForTask path sets via supervisor.spawn's membership option — without it,
  // no-queue project-run sessions show "—" in the sessions-table team·role column.
  membership: z.object({ team: z.string().min(1), role: z.string().min(1) }).optional(),
  // PLAN-PROJECT-CONDUCTOR-ROUTING P3-T1: OPTIONAL — the real spawner's agentId, threaded
  // by the caller (e.g. the chimera MCP server forwards its own CHIMERA_AGENT_ID for a
  // nested agent_spawn call). Absent ⇒ the resulting record's parentId is null.
  parentId: z.string().optional(),
  // OPTIONAL explicit project override; absent ⇒ supervisor.spawn derives it from the
  // spec's cwd via the engine's projectFor seam.
  projectId: z.string().nullable().optional(),
  // Ad-hoc sessions design §4: a session role name, resolved against SessionRoleStore and
  // merged onto `spec` BEFORE resolveAgentSpec parses it (see the local "agent.spawn" case
  // below) — a sibling param, same pattern as `membership`/`parentId` above, never a field on
  // the strict AgentSpecSchema itself. Absent ⇒ spec is used completely unmerged, byte-
  // identical to today.
  role: z.string().min(1).optional() });
// AGENT-RESUME-TOOLS: params for the agent.resume RPC — the dead agent's id + the continuation
// brief, plus optional turn-budget/delivery overrides (everything else is inherited server-side
// from the dead agent's own spec). Local to engine.ts, mirroring SpawnParams/WaitParams above.
const ResumeParams = z.object({
  agentId: z.string().min(1),
  prompt: z.string().min(1),
  maxTurns: z.number().int().positive().optional(),
  turnLimitPolicy: z.enum(["fail", "soft"]).optional(),
  deliverTo: z.string().optional(),
}).strict();
const WaitParams = Id.extend({ timeoutMs: z.number().int().positive().max(300_000).default(60_000) });
// IMAGE.PASTE (TUI #7): additive optional `images` array, same shape as
// @chimera/core/backend's Image — mediaType is the SDK's 4-way base64 image
// enum, data is the base64 payload (never empty).
const ImageParamSchema = z.object({
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string().min(1),
});
// PARITY WS-B: `slash` (optional, default false) marks a real SDK slash command so the
// supervisor delivers it VERBATIM (no "[from …] " prefix). Only the TUI sets it, and only
// for names the selected agent actually advertised (allowlist lives in the store).
// D9 (F13 composer wire): `content` — additive ordered blocks, same shape as the spawn
// spec's `content` (@chimera/protocol ContentBlockSchema) — lets a caller interleave
// images at exact mid-sentence positions instead of the legacy text-then-images bunching.
// `text` stays required so every pre-D9 caller (and the flattened display/prefix value) is unaffected.
const SendParams = Id.extend({
  ...AgentSendOptionsSchema.shape,
  text: z.string().min(1), from: z.string().default("caller"),
  images: z.array(ImageParamSchema).optional(), slash: z.boolean().optional(),
  content: z.array(ContentBlockSchema).optional(),
});
// AGENT-LOOKUP-BY-NAME: mirrors AgentState's terminal set (supervisor.ts's own
// isTerminal — done/failed/killed; "paused" is a non-terminal HOLD state and stays live).
const TERMINAL_AGENT_STATES = new Set(["done", "failed", "killed"]);
const TailParams = z.object({ agentId: z.string().optional(), n: z.number().int().positive().default(50) });
// WD Stage 1 (coverage B7, replay bar): range-read of the persisted event jsonl.
// fromSeq/toSeq are inclusive; limit defaults to 500 and is hard-capped at 5000.
// agentId is a BARE local id — handle()'s qualified-id router (which fires before the
// switch) rejects an engine-qualified agentId for any method outside its allowlist,
// so events.replay is local-only by construction.
const ReplayParams = z.object({
  fromSeq: z.number().int().min(0).optional(),
  toSeq: z.number().int().min(0).optional(),
  agentId: z.string().optional(),
  limit: z.number().int().positive().max(5000).default(500),
});
const RespondParams = z.object({ requestId: z.string(), allow: z.boolean() });
// TUI backlog 8b: live permission change for a RUNNING agent — mirrors the protocol's
// own on.permissionRequest / permissionProfile enums (@chimera/protocol AgentSpecSchema).
const SetPermissionParams = Id.extend({
  permissionRequest: z.enum(["auto", "poke:caller", "tui"]).optional(),
  permissionProfile: z.enum(["readOnly", "acceptEdits", "full"]).optional(),
});
// header: intentionally NO length cap here. The spec's "≤12-char" guidance is
// advisory display-only formatting for the TUI/CLI renderer — neither T3's
// ask_human MCP tool nor the supervisor's AskInput impose one, and capping only
// at this layer would let a >12-char header pass the tool then be rejected as
// an opaque {code:'protocol'} error at the daemon.
const AskParams = Id.extend({
  prompt: z.string().min(1),
  header: z.string().optional(),
  options: z.array(QuestionOptionSchema).optional(),
  multiSelect: z.boolean().optional(),
  freeform: z.boolean().optional(),
  default: QuestionDefaultSchema.nullable().optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
  to: z.object({ agentId: z.string().min(1) }).strict().optional(),
});
// Task D2: fan-out ask over a team (optionally scoped to one role). Same field
// set as AskParams minus `to` (the target is resolved live from scheduler.membersOf,
// not supplied by the caller) plus `team`/`role`.
const AskTeamParams = Id.extend({
  team: z.string().min(1),
  role: z.string().min(1).optional(),
  prompt: z.string().min(1),
  header: z.string().optional(),
  options: z.array(QuestionOptionSchema).optional(),
  multiSelect: z.boolean().optional(),
  freeform: z.boolean().optional(),
  default: QuestionDefaultSchema.nullable().optional(),
  timeoutMs: z.number().int().positive().nullable().optional(),
});
const AnswerParams = z.object({ questionId: z.string(), answer: QuestionAnswerSchema });
// FEATURE-8: queue.* request parsing moved to @chimera/protocol/contract's RPC_CONTRACT
// (QueueCreateRequestSchema etc.) — see the contract-dispatch branch in handle() below.
// FEATURE-11: team.* request parsing (TeamCreateParams/TeamNameParams/TeamUpdateParams) moved
// there too (TeamCreateRequestSchema etc.) — same dispatch branch.
// WD Stage 2 (coverage B12): the project.* RPC family. Spec-side validation
// (CoordName, absolute path, existing dir) lives in ProjectStore/ProjectSpecSchema;
// these parse only the request envelope.
// Mirrors protocol's CoordName exactly. It MUST run at the params layer, not
// only inside ProjectSpecSchema.parse: project.import computes
// join(base, name) (base = config.projectImportDir ?? CHIMERA_HOME/projects) and
// CLONES there before create() ever parses the spec, so a schema-only check would
// validate AFTER the filesystem side effect — an explicit name like
// "../../../../tmp/x" escaped the base dir (WD2 review MAJOR: path traversal).
// Rejecting "/"-, "."-, anything-but [A-Za-z0-9_-] names here makes the
// traversal unrepresentable pre-clone.
const ProjectName = z.string().regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ and - only");
const ProjectCreateParams = z.object({
  name: ProjectName,
  // PROJECT-DEFAULT-DIR: path is now OPTIONAL — omitted means "create a fresh blank
  // project", resolved under resolveProjectBaseDir(config.projectImportDir, home)/<name>.
  path: z.string().min(1).optional(),
  teams: z.array(z.string().min(1)).optional(), queue: z.string().min(1).optional(),
  // PLAN-PROJECT-CONDUCTOR-ROUTING P1-T2: opt a project OUT of the lazy auto-conductor
  // (default true, per ProjectSpecSchema) at creation time. Omitted ⇒ schema default.
  autoConductor: z.boolean().optional(),
  // PROJECT-CREATE-GITINIT-OPTION: only meaningful on the no-path (fresh-dir)
  // create branch below — ignored when `path` is given (existing dir, unaffected).
  // Default true so checkpoints/worktrees work out of the box; false ⇒ plain
  // empty directory, no git init, no seed commit.
  gitInit: z.boolean().optional(),
  // PROJECT-CREATE-PERMISSION-PROFILE: per-project permissionProfile override, persisted onto
  // the spec (ProjectSpecSchema) and read by spawnProjectConductor for this project's FRESH
  // conductor spawns. Omitted ⇒ schema default (null, meaning "fall back to global config").
  permissionProfile: z.enum(["readOnly", "acceptEdits", "full"]).optional(),
  // PROJECT-CONDUCTOR-ACCOUNT: pin the account (and optionally the model) this project's
  // conductor is born on. Omitted ⇒ schema default (null, "no pin, use the global default").
  // The account name is validated against the registry BEFORE any fs side effect below.
  conductorAccount: z.string().min(1).optional(),
  conductorModel: z.string().min(1).optional(),
});
const ProjectImportParams = z.object({
  source: z.string().min(1),                 // git URL (incl. file://) to clone, or an existing local dir to register
  name: ProjectName.optional(),              // default: derived from the source's last path segment
  team: z.string().min(1).optional(),        // assigned after a successful import
  // PROJECT-CREATE-PERMISSION-PROFILE: same per-project override as project.create above.
  permissionProfile: z.enum(["readOnly", "acceptEdits", "full"]).optional(),
  // PROJECT-CONDUCTOR-ACCOUNT: same per-project conductor pin as project.create above.
  conductorAccount: z.string().min(1).optional(),
  conductorModel: z.string().min(1).optional(),
});
const ProjectNameParams = z.object({ name: z.string().min(1) });
const ProjectAssignParams = z.object({ project: z.string().min(1), team: z.string().min(1) });
// PROJECT-DEFAULT-DIR-AND-DELETE: deleteFiles defaults false — registration-only
// removal unless the caller explicitly opts into wiping the on-disk directory.
const ProjectDeleteParams = z.object({ name: z.string().min(1), deleteFiles: z.boolean().optional() });
// PROJECT-NATIVE-TEAMS T7: the app's project-detail toggle. `value` becomes the
// settingSources ["project","user"] (ON) vs [] (OFF) fed to the NEXT conductor
// spawn (spawnProjectConductor) and the NEXT syncProjectTeam materialize/merge —
// never retroactive on already-running sessions.
const ProjectSetLoadProjectSettingsParams = z.object({ project: z.string().min(1), value: z.boolean() });
// PROJECT-CONDUCTOR-ACCOUNT: `account: null` CLEARS the pin back to the global default. `model`
// omitted means "leave the model pin as it is"; `model: null` clears it — the two are distinct
// because an absent model is meaningful downstream (spec.model ?? provider.defaultModel).
const ProjectSetConductorAccountParams = z.object({
  project: z.string().min(1),
  account: z.string().min(1).nullable(),
  model: z.string().min(1).nullable().optional(),
  // These birth-time settings share tri-state semantics: omitted preserves the
  // project pin, null falls back to global config on the next conductor start.
  permissionProfile: z.enum(["readOnly", "acceptEdits", "full"]).nullable().optional(),
});
// F26: operator-facing only — deliberately NO MCP tool (mcp-parity's exclusion list) and NOT an
// AgentSpec field. Granting a spawned agent the ability to set its own next spawn's setup hook
// would be arbitrary daemon-privileged execution; only an operator RPC caller can reach this.
const ProjectSetSetupHookParams = z.object({ project: z.string().min(1), hook: WorktreeSetupHookSchema.nullable() });
// PLAN-PROJECT-CONDUCTOR-ROUTING P1-T2/D2: the lazily-spawned project conductor's
// instructions — the shared CONDUCTOR_PLAYBOOK (protocol: full capability map +
// operating rules, one source of truth with the app/tui main conductor) plus the
// project-scoped routing preamble. P2-T2's `dispatch` tool implements the
// preference algorithm (queue-first → own-team → global → direct)
// deterministically — the conductor reaches for it directly rather than
// re-deriving the policy itself.
function projectConductorInstructions(name: string): string {
  // PROMPT-CACHE-PREFIX: the FIXED playbook comes first and the project-specific line last, so
  // every conductor in the fleet — main and per-project — shares one identical prompt prefix
  // that a provider's prefix cache can actually hit. The previous order put the project name in
  // front, which diverged the prefix on the very first tokens and made the whole playbook
  // re-billed per project. Same reasoning the default-spawn instructions already document
  // ("a fixed, spec-setting-shaped string ... still a shared cache prefix across the fleet").
  // PROJECT-CONDUCTOR-DEFAULTS: the on-demand line sits BEFORE the project-specific sentence and
  // names no project, so it stays part of the shared, cacheable prefix (see the ordering rule
  // above) — one variant for the whole fleet of project conductors, not one per project.
  //
  // It exists because the operator's ask was "let them find these and load them on the fly", NOT
  // "preload them": measured on this fleet, handing a conductor the machine's full skill catalogue
  // is 734 SKILL.md files / ~54k tokens of listing in EVERY prompt, and the foreign MCP catalogue
  // was already established as the most expensive line in the fleet. Both stay lazy; what was
  // missing is that nothing told the conductor the lazy paths exist, so they went unused — the same
  // failure the capability block was originally written to fix (0 memory/ask_* calls in ~39k
  // events because no instruction surface named them).
  return `${CONDUCTOR_PLAYBOOK}\n\n` +
    `ON DEMAND, NOT PRELOADED: your MCP and skill surface is deliberately lean — nothing here is ` +
    `missing, it is lazy. Foreign MCP servers (Slack/Jira/gateways/etc) are NOT in your tool list: ` +
    `mcp_store_tools finds a server's tools by keyword and mcp_store_call runs one, same args. A ` +
    `capability missing from the store may use a provider-native MCP fallback after discovery confirms the gap; ` +
    `say what is missing. You can PROPOSE a missing shared server with mcp_store_add (a stdio command or ` +
    `a remote url): it is saved disabled and untrusted, and the operator reviews, enables and authorizes ` +
    `it in Settings → MCP store — you cannot enable it or finish its OAuth sign-in. Your project's own .claude/ — CLAUDE.md, commands, ` +
    `skills — IS already loaded natively; the machine-wide catalogue is not, and reading a ` +
    `SKILL.md off disk is the way to pull one in when you need it. Pull a capability in when the ` +
    `work needs it; never front-load one because it might.\n\n` +
    `You are the conductor for PROJECT "${name}". Route this project's work with dispatch ` +
    `({projectName:"${name}", prompt, role?}) — it picks queue-first → own-team role → global team → direct for you. ` +
    `team_list/project_status show what's assigned here.`;
}
// FEATURE MAIN-CONDUCTOR-PERSISTENT: identical wording to packages/app's own lazily-spawned
// main conductor (commands.agents.ts) — one source of truth for what "the MAIN session" means,
// regardless of whether a client's first message or the daemon's own boot/account-trigger spawned it.
// PROMPT-CACHE-PREFIX: playbook first, session-specific line last — see
// projectConductorInstructions above for why the order is load-bearing.
const MAIN_CONDUCTOR_INSTRUCTIONS = `${CONDUCTOR_PLAYBOOK}\n\nYou are the Chimera MAIN session (the top-level conductor).`;
// WD Stage 2 (coverage B13): plugins.list/{cwd} scans that project's .claude/commands.
const PluginsListParams = z.object({ cwd: z.string().min(1).optional() });
const PluginsToggleParams = z.object({ id: z.string().min(1), enabled: z.boolean() });
// WD Stage 2 (coverage B14): host.setPolicy — profile "*" is the wildcard row.
const HostSetPolicyParams = z.object({ tool: z.string().min(1), profile: z.string().min(1), mode: ToolPolicyModeSchema });

// D10 (scheduled actions, coverage C12): the job.* RPC family. `spec` is validated
// (schedule/target shape, cron parse, team existence) inside JobScheduler.create/update,
// not here — mirrors team.create/queue.push's split between envelope parsing (here) and
// subsystem validation (there).
const JobCreateParams = z.object({ spec: z.unknown() });
const JobNameParams = z.object({ name: z.string().min(1) });

// FEATURE-11: workflow.* request parsing (WorkflowCreateParams/WorkflowNameParams) moved to
// @chimera/protocol/contract's RPC_CONTRACT (WorkflowCreateRequestSchema etc.) — see the
// contract-dispatch branch in handle() below. `workflow.update`'s WorkflowUpdateParams already
// lived in @chimera/protocol and is reused there directly.
// FEATURE-11: artifact.* request parsing (ArtifactAddParams/ArtifactListParams/
// ArtifactIdParams) moved there too (ArtifactAddRequestSchema etc.) — same dispatch branch.

// D14 (notifications, coverage C16): notify.test's only param — the rule NAME (config.notify
// entries are keyed by `name`, mirroring workflow/job's own name-keyed identity).
const NotifyTestParams = z.object({ rule: z.string().min(1) });

// D7 (config management & accounts, coverage C9/C10 · B16). `config.patch` takes an
// arbitrary JSON-merge-patch (validated against the full effective config inside
// ConfigStore.patch, not here). Account names mirror the config's CoordName-ish rule
// (letters/digits/_/-) so a name can never inject a "/" into the keychain service
// "chimera:<name>" or the config. `key` is min(1) and NEVER echoed back in any response.
const ConfigPatchParams = z.object({ patch: z.unknown() });
const AccountName = z.string().regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ and - only");
// F23-0D: widened from z.enum(["claude","codex"]) — any catalog provider id is acceptable
// now; accountsAdd() below rejects an id absent from the F23-0D catalog with a clean
// {code:"protocol"} error instead of a Zod parse failure far from the actual mistake
// (same rationale as protocol's AccountConfigSchema.provider widening).
const AccountAddParams = z.object({ name: AccountName, provider: z.string().min(1).optional() });
// SUBSCRIPTION-CONNECT: creates a `subscription` account (the provider CLI's own ambient
// login, e.g. `claude login` / codex's ChatGPT login) — distinct from accounts.add's
// keychain-key accounts and from F23-2A's oauth device-code accounts. Only agentic-sdk
// catalog providers (claude, codex) ride a CLI login; no name param — the account name is
// derived from the provider id so the UI only ever needs to pass {provider}.
const AccountsAddSubscriptionParams = z.object({ provider: z.string().min(1) });
// CUSTOM-OPENAI-COMPAT: `id` is the operator-chosen key into cfg.customProviders — its own
// namespace, deliberately disjoint from the built-in PROVIDERS catalog (see providersAddCustom
// below, which rejects a collision) so a custom entry can never hijack e.g. "openai".
const ProvidersAddCustomParams = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ and - only"),
  label: z.string().min(1),
  baseUrl: z.string().min(1),
  defaultModel: z.string().min(1),
  requiresKey: z.boolean().optional(),
});
const AccountNameParams = z.object({ name: AccountName });
const AccountSetKeyParams = z.object({ name: AccountName, key: z.string().min(1) });
// F23-2A: subscription OAuth. oauth_start takes just the provider id (the daemon owns the
// whole exchange — PKCE verifier/device-code state lives server-side in PendingOAuthStore,
// never round-tripped through the client); oauth_finish takes the pendingId it was handed
// back plus an OPTIONAL pasted `code` (only authorize-code/PKCE flows consume it — device and
// immediate flows resolve on their own and ignore a code if one is passed).
const AccountsOAuthStartParams = z.object({ provider: z.string().min(1) });
const AccountsOAuthFinishParams = z.object({ pendingId: z.string().min(1), code: z.string().min(1).optional() });
// D6 (Network & tailscale, coverage C6 · B15). `key` is min(1) and NEVER echoed back (it goes
// straight to the Keychain). `fed.accept` binds a peer's PUBLIC key (shape-validated in
// network.ts's validateSshPublicKey, not here) under an engineId whose chars can never inject
// into the authorized_keys comment field.
const SetAuthKeyParams = z.object({ key: z.string().min(1) });
const FedAcceptParams = z.object({
  publicKey: z.string().min(1),
  engineId: z.string().regex(/^[A-Za-z0-9._-]+$/, "letters, digits, ., _ and - only"),
});
// The env var an added account's key is injected as (keychain auth). Provider-default.
// F23-0D: claude/codex keep their pre-F23 literal defaults byte-identical (ANTHROPIC_API_KEY/
// OPENAI_API_KEY were never the catalog's own envVar for either — claude's catalog envVar is
// also ANTHROPIC_API_KEY, but codex's is OPENAI_API_KEY too, so this map and the catalog agree
// for both); every other provider falls back to its catalog entry's `envVar`.
const DEFAULT_INJECT_AS: Record<string, string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
};
function defaultInjectAs(provider: string): string | undefined {
  return DEFAULT_INJECT_AS[provider] ?? findProvider(provider)?.envVar;
}
// CUSTOM-OPENAI-COMPAT: same lookup as defaultInjectAs, but also resolves a provider id that
// only exists as a cfg.customProviders entry (findProvider alone only sees the built-in
// PROVIDERS catalog) — accountsAdd uses this instead of the plain defaultInjectAs above so a
// custom provider's synthesized envVar (catalog.ts's customProviderProfile) is honored.
function defaultInjectAsEffective(provider: string, cfg: Pick<ChimeraConfig, "providerOverrides" | "customProviders">): string | undefined {
  return DEFAULT_INJECT_AS[provider] ?? findEffectiveProvider(provider, cfg)?.envVar;
}

// PROJECT-NATIVE-TEAMS T3: order-insensitive deep-equality for syncProjectTeam's
// idempotence check (sorts object keys recursively before comparing) — plain
// JSON.stringify would false-positive a "changed" on key-order alone.
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

// D8: default invite TTL when fed.invite.create omits ttlSeconds (24h — long enough to copy a
// blob between machines, short enough that a leaked-but-unused invite lapses on its own).
const DEFAULT_INVITE_TTL_SECONDS = 24 * 3600;

// Deep-merge two toolPolicy maps ({tool: {profile: mode}}); `over` wins per (tool, profile).
function mergeToolPolicy(base: ToolPolicy, over: ToolPolicy): ToolPolicy {
  const out: ToolPolicy = { ...base };
  for (const [tool, profs] of Object.entries(over)) out[tool] = { ...(out[tool] ?? {}), ...profs };
  return out;
}

// A best-effort, secret-safe message for a fed.join step failure. The invite token is base64url
// (no sk-/tskey- shape) and never appears in these errors by construction; scrub anyway (D0).
// CONDUCTOR-SPAWN-RUNAWAY: two spawns dying on arrival is a pattern, not bad luck; a minute is
// long enough that a passive screen refresh cannot out-wait it, short enough that a real fix
// takes effect without needing a daemon restart.
const CONDUCTOR_SPAWN_MAX_DEATHS = 2;
const CONDUCTOR_SPAWN_COOLDOWN_MS = 60_000;

function stepError(err: unknown): string {
  const e = err as { message?: unknown } | undefined;
  const raw = typeof e?.message === "string" ? e.message : String(err);
  return scrubSecretShapes(raw).slice(0, 300);
}

// BOOT-LATENCY-AGENT-LIST: the `agent.list {lite:true}` projection — see its case in handle().
// A DENYLIST, not an allowlist: every other field (including ones added later) keeps riding the
// snapshot untouched, so this can never silently starve a UI selector of a field it reads. The
// four names here are the measured bulk — on a 980-agent fleet, spec.instructions (1.6MB) +
// spec.prompt (1.2MB) + resultText (0.6MB) + lastTurnBillableUsage (0.5MB) are 73% of the
// payload and are read by NO list-view consumer; the per-agent detail panel gets them from
// agent.status(agentId), and the team/project tables get them from team.status/project.status.
const LIST_BULK_SPEC_FIELDS = ["instructions", "prompt"] as const;
const LIST_BULK_RECORD_FIELDS = ["resultText", "lastTurnBillableUsage"] as const;

function stripListBulkText(record: AgentRecord | Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(record as Record<string, unknown>) };
  for (const f of LIST_BULK_RECORD_FIELDS) delete out[f];
  const spec = out["spec"];
  if (spec && typeof spec === "object") {
    const trimmed: Record<string, unknown> = { ...(spec as Record<string, unknown>) };
    for (const f of LIST_BULK_SPEC_FIELDS) delete trimmed[f];
    out["spec"] = trimmed;
  }
  return out;
}

// TOKEN-OPT-SEARCH-EXCERPT: memory_search returns up to 20 records and each record's text is
// unbounded, so a single search could carry tens of KB — and the memory discipline now makes
// that call happen at every agent's session start and before every related task, which is
// exactly the multiplier that turns "a bit large" into the fleet's biggest recurring read.
//
// A searcher is SCANNING: it needs enough of each hit to judge relevance, then reads the one it
// wants. So hits carry an excerpt and say they were truncated; memory_get returns the whole
// record by the id already in the hit. Nothing is unreachable, only unfetched-by-default.
const MEMORY_EXCERPT_MAX = 400;

function excerptHit<T extends { record: { text: string } }>(hit: T): T {
  const { text } = hit.record;
  if (text.length <= MEMORY_EXCERPT_MAX) return hit;
  return {
    ...hit,
    record: {
      ...hit.record,
      text: `${text.slice(0, MEMORY_EXCERPT_MAX)}… [${text.length - MEMORY_EXCERPT_MAX} more chars — memory_get for the full record]`,
    },
  };
}

// TOKEN-OPT-TAIL-CAP: agent_tail is an agent-facing tool, so whatever it returns lands in a
// model's context — but it was returning raw normalized events, whose `data` is unbounded by
// design. Measured on a real event log: single events over 50KB (a large tool_result, or a
// delivered message carrying image base64), with 1.3% of a segment's lines holding 52% of its
// bytes. One agent_tail(n:50) over a busy agent could therefore dump hundreds of KB into the
// caller's window — and an agent asking "what has this agent been doing" wants the SHAPE of
// recent activity, not a verbatim replay of every payload.
//
// So each field is capped INDIVIDUALLY and told it was capped, rather than the event being
// dropped: a truncated tool_result still answers "which tool ran and did it work", and the
// caller can fetch the full thing with agent_result/agent_status when the excerpt isn't enough.
// The event LOG itself is untouched — this is a projection for one tool, not a retention rule.
const TAIL_FIELD_MAX = 2_000;

function capEventForTail(e: NormalizedEvent): NormalizedEvent {
  const data = e.data as Record<string, unknown> | undefined;
  if (!data) return e;
  let capped: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(data)) {
    // Binary blocks have no useful excerpt — a 2KB slice of base64 is 2KB of noise. Say what was
    // there instead, which is the part a reader can act on.
    if ((k === "images" || k === "content") && Array.isArray(v)) {
      capped ??= { ...data };
      capped[k] = `[${v.length} block(s) omitted — fetch the agent's own transcript for the payload]`;
      continue;
    }
    if (typeof v === "string" && v.length > TAIL_FIELD_MAX) {
      capped ??= { ...data };
      capped[k] = `${v.slice(0, TAIL_FIELD_MAX)}… [truncated ${v.length - TAIL_FIELD_MAX} chars]`;
      continue;
    }
    if (typeof v === "object" && v !== null) {
      const json = JSON.stringify(v);
      if (json.length > TAIL_FIELD_MAX) {
        capped ??= { ...data };
        capped[k] = `${json.slice(0, TAIL_FIELD_MAX)}… [truncated ${json.length - TAIL_FIELD_MAX} chars]`;
      }
    }
  }
  return capped ? { ...e, data: capped } as NormalizedEvent : e;
}

// CONDUCTOR-TURN-BUDGET: a conductor's SDK query stays OPEN for the life of the session
// (backends/claude.ts only closes input for a one-shot), so the default turnLimitPolicy
// "fail" doesn't end the agent at maxTurns — it ends its TURN, mid-tool-use, with an
// is_error result (subtype error_max_turns) and leaves the record "running". To the
// operator that is a conductor that inexplicably stops every 40 turns and has to be
// poked. "soft" keeps maxTurns a NOMINAL budget (flagged once via turnBudgetExceeded)
// instead of a kill switch, which is the only sane policy for an agent meant to live for
// the whole session; the nominal number is raised in step so the flag still means
// "this conductor has run unusually long", not "it has been running normally for an hour".
// Applies to a FRESH spawn only — an existing conductor keeps its stored spec across
// reattach, and is re-policied live via agent.setTurnLimit.
const CONDUCTOR_TURN_BUDGET = { maxTurns: 1000, turnLimitPolicy: "soft" } as const;

// F22 lease-chip projection rule — see the call site in the agent summary for WHY this is a
// present-or-omitted decision rather than a plain boolean field.
function worktreeLeaseHeldField(
  held: boolean,
  isolation: string | undefined,
  federated: boolean,
): { worktreeLeaseHeld?: boolean } {
  if (federated) return {};
  return held || isolation === "worktree" ? { worktreeLeaseHeld: held } : {};
}

export class Engine {
  readonly events: EventLog;
  // Tamper-evident hash-chained audit ledger — the durable, never-pruned copy of every
  // authorization decision (see the capabilityBroker emit closure below), destructive-Bash
  // detection, and credential-resolution fact. Separate store from `events` above.
  readonly auditLedger: AuditLedger;
  readonly supervisor: AgentSupervisor;
  readonly teams: TeamManager;
  readonly queues: QueueStore;
  // F11: append-only step-attempt journal. Outlives QueueStore.prune()'s 200-terminal-task
  // eviction because it lives in its own JSONL file family, not in queues.json.
  readonly stepJournal: StepJournal;
  // FEATURE-8: the RpcContract dispatcher — see handle()'s isContractMethod branch. Originally
  // queue.* only; FEATURE-10 added evidence.get (a second family, same map — ContractHandlers
  // is a single flat type over ALL of RPC_CONTRACT's keys, so a new family is just a new case
  // here, not a new dispatcher). FEATURE-11 grew this into a spread composition (team.*/
  // workflow.*/artifact.* handlers now live in their own packages/core/src/rpc/*.ts modules,
  // see teamRpc/workflowRpc/artifactRpc below) — that spread evaluates EAGERLY, unlike the
  // queue.*/evidence.get/audit.verify closures below (which only touch `this.queues`/
  // `this.workflows`/`this.scheduler`/`this.evidence`/`this.auditLedger` when actually
  // INVOKED, long after the constructor runs). So, unlike before FEATURE-11, this can no
  // longer be a field initializer (class fields initialize in declaration order, before the
  // constructor body runs `this.teamRpc = new TeamRpc(...)` etc.) — it's assigned in the
  // constructor body instead, right after those three modules are constructed. The type
  // annotation stays here so its shape is still checked against ContractHandlers at a
  // single, easy-to-find declaration site.
  private readonly contractHandlers: ContractHandlers;
  private readonly teamRpc: TeamRpc;
  private readonly roleRpc: RoleRpc;
  private readonly roles: RoleStore;
  private readonly workflowRpc: WorkflowRpc;
  private readonly canvasRpc: CanvasRpc;
  private readonly forkRpc: ForkRpc;
  private readonly contextLinksRpc: ContextLinksRpc;
  private readonly issuesRpc: IssuesRpc;
  private readonly artifactRpc: ArtifactRpc;
  // R2 (self-healing supervision): health.status/replay.agentsAsOf RPC family.
  private readonly healthRpc: HealthRpc;
  private readonly gitOpsRpc: GitOpsRpc;
  private readonly resourcesRpc: ResourcesRpc;
  // SHADOW-WORKFLOW-VISIBILITY: shadow.workflowInspect RPC family.
  private readonly shadowRpc: ShadowRpc;
  readonly memory: MemoryStore;
  /** CHRONICLE-SEMANTIC: null when the embedder is off or under vitest — every reader must handle
   *  that rather than assume an index exists. */
  readonly chronicle: ChronicleIndex | null;
  // TERMINAL-READBACK: output teed in by the desktop app, so an agent can read the terminal that
  // was opened under it. In memory and unconditional — see terminal-log.ts for why neither a
  // config flag nor persistence would be right here.
  readonly terminals = new TerminalLog();

  /** SKILL-DISCOVERY: an agent's own working directory, so its PROJECT's skills are indexed too.
   *  Resolved here from the agent id rather than accepted as a path — a caller does not get to
   *  aim the index at an arbitrary directory. Undefined for an unknown agent, which simply means
   *  user and plugin skills only. */
  private agentCwd(agentId: string | undefined): string | undefined {
    if (!agentId) return undefined;
    try { return this.supervisor.status(agentId).spec.cwd; } catch { return undefined; }
  }

  /** F34: the caller's project scope — resolved SERVER-SIDE from the calling agent's own record,
   *  never from a parameter. An unknown or external caller (the app, the TUI, a peer, a test) has
   *  no project binding and is therefore never narrowed: partitioning must not subtract visibility
   *  from a caller that has no partition to be in. */
  private projectScopeFor(agentId: string | undefined): string | null {
    return agentId ? this.supervisor.projectIdOf(agentId) : null;
  }
  // WD Stage 2: the three new subsystems (coverage B12/B13/B14).
  readonly projects: ProjectStore;
  // FEATURE MAIN-CONDUCTOR-PERSISTENT: the single global MAIN conductor's persisted
  // agentId pointer (distinct from ProjectStore's per-project conductorId).
  private readonly mainConductorStore: MainConductorStore;
  readonly plugins: PluginRegistry;
  readonly hostTools: HostToolsScanner;
  readonly toolPolicy: ToolPolicyStore;
  // FEATURE-6: the capability broker (Policy Decision Point) — the single choke point
  // Bash host-tool decisions AND mcpstore.call decisions both route through.
  readonly capabilityBroker: CapabilityBroker;
  // F22 (single-writer worktree lease): the lease registry the broker's worktree-write gate and
  // supervisor.launch() share. PUBLIC/readonly for the same reason capabilityBroker is — the
  // worktree_lease_* RPC handlers reach it straight off the engine.
  readonly worktreeLeases: WorktreeLeaseStore;
  // MCP-STORE: chimera-level MCP registry (mcpstore.json) + the daemon-hosted, lazily-
  // connected, idle-torn-down client pool every mcpstore.tools/call and mcp_store_tools/
  // mcp_store_call round trip shares (main.ts's shutdown() closes it).
  readonly mcpStore: McpStoreRegistry;
  readonly mcpPackages: McpPackageInstaller;
  private mcpRemoving = new Set<string>();
  // Null whenever this engine is not running from an installed Chimera runtime (dev, tests): the
  // built-in integrations then simply do not exist and the legacy/user entries are untouched.
  private builtInCtx: BuiltInContext | null = null;
  readonly mcpStoreConnections: McpStoreConnectionManager;
  // F49 LOOPBACK-MCP: public because a backend reaches it through ChimeraEngineHandle.mcpListener
  // and the daemon closes it on shutdown. Always constructed, even when disabled — a disabled
  // listener binds nothing and grant() answers null, so there is no "off" object to branch on.
  readonly mcpListener: LoopbackMcpListener;
  readonly operatorWeb: OperatorWeb;
  readonly mcpImports: McpImportScanner;
  // MCP-OAUTH slice 2: the oauth-kind mcpstore start/finish seam — pendingMcpOAuth is its own
  // PendingOAuthStore instance (never shared with accounts' this.pendingOAuth above: different
  // provider namespace, different caller, same in-memory-only "restart just means retry"
  // discipline — see pending-oauth.ts's header).
  readonly pendingMcpOAuth: PendingOAuthStore;
  readonly mcpStoreOAuth: McpStoreOAuthFlow;
  // MCP-OAUTH-DISCOVERABILITY: the oauth-detect probe seam (absent ⇒ the real
  // discoverOAuthProtectedResourceMetadata-backed implementation) — a test injects a stub
  // here instead of letting mcpstore.add/import/detectAuth hit the real network.
  private readonly mcpStoreDetectAuthFn: typeof detectMcpStoreOAuth;
  readonly scheduler: QueueScheduler;
  // D12 (task workflows, coverage C14): workflow.* RPC family + the step-gate spec store
  // (${home}/workflows.json). Constructed BEFORE the scheduler (below) — the scheduler's
  // step machine depends on it.
  readonly workflows: WorkflowStore;
  // D13 (artifact registry, coverage C15): artifact.* RPC family + the report/diff/chart/
  // file/link registry (${home}/artifacts.json + ${home}/artifacts/<id> snapshots).
  // Constructed alongside workflows, BEFORE the scheduler — the scheduler's `artifact`
  // gate runner depends on it.
  readonly artifacts: ArtifactStore;
  // D16 (checkpoints, coverage §C18, F20): git-plumbing checkpoint.* RPC family
  // (create/list/revert/status). No home-scoped persistence of its own — every
  // checkpoint's state lives entirely in the TARGET repo's own refs/commit objects (see
  // CheckpointStore). Constructed alongside the supervisor below: isRepoBusy closes over
  // `this.supervisor` (assigned in the SAME constructor, referenced only lazily — the
  // established mailboxForward/checkpointCreate closure trick).
  readonly checkpoints: CheckpointStore;
  // MEMORY-BOUNDED-DISK-COMPLETE: the disk-complete backing store for terminal AgentRecords
  // AgentSupervisor lightens out of its in-memory hot set — see AgentArchiveStore and
  // supervisor.ts's archiveColdTerminalAgents/rehydrate.
  readonly agentArchive: AgentArchiveStore;
  // FEATURE-7 (OTel GenAI tracing + SLI rollup + redaction): subscribes to this.events
  // directly (EVENT-LOG-DRIVEN, no new instrumentation call sites in scheduler.ts/
  // supervisor.ts) and replays the stream into an in-memory span tree backing the
  // sli.rollup RPC + an OTLP exporter (no-op while config.otel.endpoint is unset).
  // Constructed AFTER this.scheduler (below) — its taskFor seam closes over it lazily,
  // same closure-ordering trick isRepoBusy/checkpointCreate above already use.
  readonly otel: SpanRecorder;
  // FEATURE-10 (Changes & Evidence Review): the read-only evidence.get RPC (on the FEATURE-8
  // RpcContract dispatcher, see `contractHandlers` below) — aggregates stepHistory + artifacts
  // + a git-derived diff/provenance for one task. Constructed AFTER queues/workflows/artifacts
  // (below), which it depends on directly (no lazy-closure trick needed, unlike checkpoints).
  readonly evidence: EvidenceStore;
  readonly reviews: ReviewStore;
  // D10 (scheduled actions, coverage C12): job.* RPC family + persistent cron/interval/
  // one-shot scheduler (${home}/jobs.json). Constructed AFTER teams/queues/supervisor/
  // scheduler (below) — it depends on all four.
  readonly jobs: JobScheduler;
  // R2 (self-healing supervision): periodic liveness probe over running agents — constructed
  // right after this.supervisor (mirrors JobScheduler's "constructed after supervisor" ordering
  // convention), started by main.ts (public so it can call .start()) alongside
  // snapshotScheduler.start(). No explicit .stop() call in main.ts's shutdown — same precedent
  // as JobScheduler's own unref'd timer, left to die with the process.
  readonly healthMonitor: HealthMonitor;
  // DYNAMIC-CONCURRENCY-CAP: constructed right after this.registry (mirrors quotaPoller's own
  // "built right before its first consumer" ordering) — shared between healthMonitor (the only
  // thing that ever SAMPLES it, on its existing tick) and the supervisor (which only ever reads
  // its cheap synchronous snapshot at admission time). One instance, two consumers, same as
  // registry itself.
  readonly dynamicCap: DynamicCapTracker;
  // D14 (notifications, coverage C16): the notify.* rule evaluator — watches this.events for
  // matches against the config's `notify` rules (config.d overlay, D7 pattern) and delivers
  // through os/toast (a `notify` event)/a2a (agent.send to the source tree's depth-0 agent)/
  // webhook (POST + 3 retries), throttled per-rule (see NotifyEvaluator).
  readonly notifier: NotifyEvaluator;
  // HOOK-5 (PLAN-HOOKS.md §5/§10): merge-to-main visibility — debounced fs.watch on every
  // live worktree spawn's mainRepo + every registered project's path, emitting
  // repo_head_moved with zero polling. Constructed before the supervisor so its repoWatcher
  // seam can close over it (same lazy-closure convention as checkpoints/isRepoBusy above);
  // seeded with the project list once this.projects exists (see seedProjects call below).
  readonly repoWatcher: RepoWatcher;
  // PLAN-HOOKS.md §3 (HOOK-4): the hooks.* declarative lifecycle-rule evaluator — watches
  // this.events for matches against the config's `hooks` rules and runs notify/push/spawn/run/
  // channel actions, sibling of notifier above (same config.d overlay hot-reload pattern).
  readonly hooks: HookEngine;
  // PLAN-HOOKS.md §2 (HOOK-2): agent-facing event subscriptions — sibling of `notifier` above,
  // same "subscribes to this.events itself, constructed here" shape. sub.create/remove/list RPC
  // family lives on `subRpc` (packages/core/src/rpc/sub-rpc.ts), a thin dispatcher onto it.
  readonly subscriptions: SubscriptionRegistry;
  private readonly subRpc: SubRpc;
  // HOOK-CRUD-RPC: atomic CRUD over ChimeraConfig.hooks — see rpc/hook-rpc.ts.
  private readonly hookRpc: HookRpc;
  // VOICE S2: voice.session.*/voice.conversation.* RPC family, a thin dispatcher onto an
  // in-memory registry (packages/core/src/rpc/voice-rpc.ts) — no audio/STT/TTS wiring yet.
  private readonly sttRpc: SttRpc;
  private readonly voiceRpc: VoiceRpc;
  private readonly nativeVoiceRpc: NativeVoiceRpc;
  private readonly voiceRoomRpc: VoiceRoomRpc;
  // D6 (Network & tailscale, coverage C6 · B15): the tailscale probe/up/auth-key seam. Emits
  // network_changed/network_error into the shared event log (agentId "network").
  readonly network: NetworkManager;
  readonly engineId: string;
  // DAEMON-RUNS-FROM-DELETED-WORKTREE: see the constructor opt doc comment above.
  readonly codeRoot: string;
  readonly processStartedAtMs: number;
  readonly mailboxes: MailboxStore;
  readonly federation: FederationManager | null;
  // D8 (pairing): this engine's ed25519 identity (null when unfederated) + the single-use invite
  // ledger. Both drive fed.invite.create / fed.join / responder-side auto-pin.
  private identity: EngineIdentity | null = null;
  readonly invites: InviteStore;
  readonly runHistory: RunHistoryStore;
  // D15 (usage ledger, coverage §C17, F19): append-only usage.jsonl (one row per `result`
  // event) + usage.query aggregation. Constructed AFTER supervisor/teams/queues/jobs (it
  // resolves account/model/team/job context off those) — see the constructor call site.
  // Also the single source for daemon.status's spendTodayUsd (D1 unification: no more
  // separate SpendLedger running total — one ledger, no divergence).
  readonly usage: UsageLedger;
  // D7 (config management & accounts): the effective-config source (config.json +
  // config.d/* overlay) and the credential/probe seams. configStore is readonly so the
  // daemon's ConfigWatcher can call reloadConfig() against it.
  readonly configStore: ConfigStore;
  private keychain: Keychain;
  // SECRET-MANAGER: operator-held secrets in the keychain, readable only by specifically granted
  // agents. Public so the daemon/tests can reach it the way they reach auditLedger/groupStore.
  readonly secrets: SecretStore;
  private prober: AccountProber;
  private registry: AccountRegistry;
  // Cloudflare federation Plan A: provisioning status for THIS engine only (a daemon never
  // provisions a peer). Set only after selfprobe:"passed" gates it — see selfEndpoint()/
  // fed.invite.create. accessClientId is non-secret (the Access secret lives in the Keychain).
  private cloudflareStatus?: CloudflareProvisionStatus;
  private cloudflareAccessClientId?: string;
  private cloudflareProvisioner?: CloudflareProvisioner;
  private cfFetch?: CfFetchFn;
  private cfProbe?: ProbeFn;
  private cfSelfprobeRetryWindowMs?: number;
  private cfSelfprobeRetryIntervalMs?: number;
  // SPAWN-FORM-ACCOUNTS: same instance handed to the supervisor below — providers.models
  // resolves an account's key through every auth type (keychain/env/command/oauth), not
  // just keychain, so a live model probe works for however the user actually authed.
  private credentials: CredentialResolver;
  // F23-0D: readonly (not private) so a future oauth_start/oauth_finish RPC (FAZ-2A) can
  // reach it without threading a new constructor seam through Engine.
  readonly oauthTokenStore: OAuthTokenStore;
  // F23-2A: the accounts.oauth_start/oauth_finish seam. pendingOAuth tracks in-flight
  // exchanges (never persisted — a daemon restart mid-flow just means "retry oauth_start").
  // oauthFlows is keyed by provider id; a provider with authModes including "oauth" but no
  // entry here (e.g. a future Google Code Assist skeleton) fails oauth_start with a clean
  // "not implemented yet" error instead of a crash.
  readonly pendingOAuth: PendingOAuthStore;
  private oauthFlows: Map<string, OAuthFlow>;
  // readonly (not private) so tests can observe the live failover window survives
  // failoverCooldownMinutes hot-reload; the supervisor shares this same instance.
  readonly cooldowns: CooldownTracker;
  readonly quotas: QuotaTracker;   // ACCOUNT-QUOTA-METERS: mirrors cooldowns' construction/injection pattern exactly
  // ACCOUNT-QUOTA-METERS-PULL: constructed here (cheap, no I/O — matches modelCatalogService's
  // construction-vs-init() split above) but NEVER auto-started by the constructor, so the 69+
  // existing tests that build a bare `new Engine(...)` stay network-free. main.ts calls
  // .start() explicitly, gated the same way modelCatalog.init() is (skipped under
  // CHIMERA_BACKEND=fake).
  readonly quotaPoller: QuotaPoller;
  private cfg: ChimeraConfig;
  private home: string;   // WD Stage 2: project.import's clone target root fallback ($CHIMERA_HOME/projects/<name> when config.projectImportDir is unset)
  // DYNAMIC-MODEL-METADATA: the layered model-metadata service (config override > cached remote >
  // provider API > hardcoded fallback). Exposed via `modelCatalog` getter so backends built before
  // the Engine (main.ts) can reach it lazily. Consumed server-side by the supervisor (ctx limit +
  // live cost estimate) and the claude/codex backends (authoritative cost).
  private modelCatalogService: ModelCatalogService;
  // AGENT-GROUPS Phase 1: the operator-defined group REGISTRY (id/name/color) — sync,
  // local-file-backed, no init()/refresh() split needed (mirrors ConfigStore's construction-
  // time load, not modelCatalogService's async one, since there's no remote source).
  private groupStore: GroupStore;
  private netExec?: NetExecFn;   // D6: injectable ssh-keygen/tailscale seam (shared with NetworkManager)
  // §13 addendum: injectable seam over /etc/ssh/ssh_host_*.pub — NEVER read for real under test.
  private readHostKeys: ReadHostKeysFn;
  // §13c: injectable seam over the "user" acceptFedKey target's ssh dir (default ~/.ssh) — every
  // test supplies an isolated tmp dir so no test EVER writes into a real user's ~/.ssh.
  private userSshDir?: string;
  private backendsRef: Map<string, AgentBackend>;
  // HOT-RELOAD-BACKENDS: deps for building a NEW provider's backend live (mirrors
  // main.ts's boot-time buildBackends call). Absent in every existing test/caller ⇒
  // defaults (real process.env / global fetch) — see doReconcileBackends.
  private backendBuildDeps: BuildBackendsDeps;
  // test seam: the function used to build new backend instances (absent ⇒ the real
  // buildBackends, same one main.ts uses at boot). Lets a test inject a fake builder
  // (returning FakeAgentBackend) to prove a live-added provider is actually spawnable
  // without hitting a real provider's network/SDK.
  private backendBuilder: typeof buildBackends;
  // snapshot of the providerOverrides object last applied to backendsRef, so a live
  // reconcile can tell "override changed for provider X" (rebuild) apart from "provider
  // X untouched" (leave its running backend instance alone).
  private appliedProviderOverrides: ChimeraConfig["providerOverrides"];
  private appliedCustomProviders: ChimeraConfig["customProviders"];
  // serializes reconcile runs — applyConfig can fire in quick succession (e.g. two rapid
  // config.patch calls) and buildBackends is async, so without this two overlapping runs
  // could race and one's Map writes could be clobbered by the other's stale computation.
  private backendReconcileChain: Promise<void> = Promise.resolve();
  // Phase 5: peer:spawnId -> agentId, idempotent-retry cache. In-memory only —
  // documented: lost on daemon restart (a retry after a restart would double-spawn;
  // acceptable v1 residual, tracked separately from this task's scope).
  private fedSpawnIds = new Map<string, string>();
  // F21/D17: capability strings declared by each live `subscribe` connection, keyed on
  // an opaque per-connection token (server.ts passes the raw net.Socket; tests can pass
  // any stable object). In-memory only, like fedSpawnIds above — a capability is
  // "active" while ANY connection currently declares it, so one plain CLI subscriber
  // alongside one ui.components-aware client still gets the cheatsheet on new spawns.
  private clientCapsByConn = new Map<object, Set<string>>();
  // PLAN-PROJECT-CONDUCTOR-ROUTING P1-T2: TOCTOU guard for ensureProjectConductor
  // (mirrors the app's `mainSpawn` in-flight-promise pattern, commands.agents.ts:869)
  // — two concurrent triggers (e.g. two rapid project.status focuses) for the SAME
  // project must await the ONE spawn in flight, never spawn twice. In-memory only;
  // cleared once the spawn settles (success or failure) so a failed attempt retries
  // fresh on the next trigger instead of wedging forever.
  private conductorSpawns = new Map<string, Promise<AgentRecord>>();
  // CONDUCTOR-SPAWN-RUNAWAY: per-project record of conductors that died on arrival — see
  // ensureProjectConductor. In-memory only: a daemon restart is itself a fresh chance, and
  // persisting a brake would outlive the cause it was protecting against.
  private readonly conductorSpawnBrake = new Map<string, { deaths: number; lastAt: number }>();
  // FEATURE MAIN-CONDUCTOR-PERSISTENT: the SAME TOCTOU discipline as conductorSpawns
  // above, just for the single global MAIN seat instead of a per-project map — two
  // concurrent triggers (boot-ensure racing a client's lazy spawn RPC, say) must
  // await the ONE spawn in flight, never spawn twice.
  private mainConductorSpawn: Promise<AgentRecord> | null = null;
  // SDK-MODEL-LISTS test seams (absent ⇒ real behavior): providers.models's agentic-sdk
  // live sources. Without these a "codex" probe in a test would shell out to whatever
  // `codex` binary happens to be on the TEST MACHINE's PATH (flaky/nondeterministic across
  // dev machines and CI) — tests inject a fake here exactly like every other exec seam above.
  private fetchCodexCliModels: typeof fetchCodexCliModels;
  readonly modelLists: ModelListCache;
  private probeClaudeModels: () => Promise<ModelOption[]>;
  private probeKimiModels: () => Promise<ModelOption[]>;

  constructor(opts: {
    home: string; backends: Map<string, AgentBackend>; exec?: ExecFn;
    fedReconnectBaseMs?: number; fedHeartbeatMs?: number;
    // WD Stage 2, all OPTIONAL test seams (absent ⇒ real behavior):
    // hostExec/hostToolsStaleMs pin the host.tools probe sweep; claudeDir points the
    // plugins catalog at a fake ~/.claude.
    hostExec?: ExecFn; hostToolsStaleMs?: number; claudeDir?: string;
    // MCP-STORE test seams (absent ⇒ real behavior): mcpImportScanner replaces the
    // whole scanner (a fake FsSeam pointed at fixture files); mcpStoreIdleMs/mcpStoreTimers
    // shrink+control the connection manager's idle-teardown clock for deterministic tests.
    mcpImportScanner?: McpImportScanner;
    // BUILT-IN integrations test seam: the installed runtime root that carries integrations/manifest.json.
    // undefined => detect from this module's own location; null => no managed runtime (dev checkouts).
    runtimeRoot?: string | null;
    mcpStoreIdleMs?: number; mcpStoreSetTimer?: (fn: () => void, ms: number) => unknown; mcpStoreClearTimer?: (h: unknown) => void;
    // MCP-OAUTH slice 2 test seams (absent ⇒ real behavior): shrink+control the loopback
    // flow's ~10min dangling-listener timeout, same injectable-timer pattern as mcpStore*Timer.
    mcpStoreOAuthSetTimer?: (fn: () => void, ms: number) => unknown; mcpStoreOAuthClearTimer?: (h: unknown) => void;
    mcpStoreOAuthTimeoutMs?: number;
    // MCP-OAUTH-DISCOVERABILITY test seam (absent ⇒ real network probe): replaces the
    // detectMcpStoreOAuth call mcpstore.add/import/detectAuth make — a fake avoids every
    // test that adds/imports an http entry needing a real (or mocked-fetch) OAuth server.
    mcpStoreDetectAuth?: typeof detectMcpStoreOAuth;
    // D7 test seams (absent ⇒ real behavior): a fake Keychain / AccountProber so accounts
    // CRUD + accounts.test run token-free with no `security` process and no live key.
    keychain?: Keychain; accountProber?: AccountProber;
    // D7: an already-loaded ConfigStore to REUSE (absent ⇒ construct one from opts.home).
    // The daemon reads the effective config once for backend selection, then hands that
    // same store in so boot doesn't parse config.json + config.d/* twice.
    configStore?: ConfigStore;
    // D6 test seams (absent ⇒ real behavior): a fake NetExecFn (no `tailscale`/`ssh-keygen`
    // subprocess) + a fake clock so the fed.network 5s cache is driven deterministically, and a
    // fake `existsSync` so the off-PATH tailscale-binary resolver doesn't depend on whatever the
    // test/CI machine actually has installed at the known absolute paths.
    netExec?: NetExecFn; netNow?: () => number; netCacheMs?: number; netPathExists?: PathExistsFn;
    // §13 addendum test seam (absent ⇒ realReadHostKeys, i.e. real /etc/ssh reads in prod):
    // a fake sshd host-public-key reader so tests never touch a real /etc/ssh.
    readHostKeys?: ReadHostKeysFn;
    // §13c test seam (absent ⇒ real ~/.ssh in prod, exactly what sshd reads): an isolated tmp
    // dir standing in for the user's ~/.ssh so acceptFedKey/removeFedKey/retagFedKey's
    // target:"user" mode NEVER touches a real user's authorized_keys under test.
    userSshDir?: string;
    // D14 test seams (absent ⇒ real behavior): an injectable webhook fetch + throttle timers
    // so notify tests drive webhook retries/throttle windows deterministically (no real
    // network calls, no real 60s waits) — mirrors ConfigWatcher's own injectable timer seam.
    notifyFetch?: NotifyFetchFn; notifySetTimer?: NotifyTimerFn; notifyClearTimer?: NotifyClearTimerFn;
    // F23-2A test seams (absent ⇒ real behavior): a fetch override shared by every oauth flow
    // (Copilot device/exchange/refresh) and a fully custom oauthFlows map (an escape hatch for
    // tests that want to stub the whole flow rather than fake HTTP underneath it).
    oauthFetch?: typeof fetch; oauthFlows?: Map<string, OAuthFlow>; grokAuthFilePath?: string;
    // HOT-RELOAD-BACKENDS test seams (absent ⇒ real process.env / global fetch / real codex
    // SDK, exactly like main.ts's boot-time buildBackends call): backendBuildDeps is
    // forwarded verbatim to buildBackends; backendBuilder replaces buildBackends itself
    // (a test's escape hatch to return fakes instead of real backend instances).
    backendBuildDeps?: BuildBackendsDeps;
    backendBuilder?: typeof buildBackends;
    // SDK-MODEL-LISTS test seams (absent ⇒ real behavior — see the field comments above).
    fetchCodexCliModels?: typeof fetchCodexCliModels;
    modelListTtlMs?: number;
    probeClaudeModels?: () => Promise<ModelOption[]>;
    probeKimiModels?: () => Promise<ModelOption[]>;
    // FEATURE-7 test seams (absent ⇒ real behavior): otelFetch replaces the OTLP exporter's
    // POST call (no real network, mirrors oauthFetch/notifyFetch); otelNow pins span
    // start/end timestamps for deterministic duration assertions (mirrors netNow).
    otelFetch?: typeof fetch; otelNow?: () => number;
    // R2 (self-healing supervision) test seam (absent ⇒ DEFAULT_CRASH_LOOP_POLICY, real
    // behavior) — mirrors otelNow/netCacheMs above: forwarded verbatim to AgentSupervisor so a
    // deterministic daemon-level blackbox test can drive a crash-loop backoff+recovery cycle
    // fast instead of waiting on the multi-second real default.
    crashLoopPolicy?: CrashLoopPolicy;
    // HOOK-8 (PLAN-HOOKS.md §4.2 suspend/resume landing recipe) test seam (absent ⇒
    // defaultGateExec, real behavior): forwarded verbatim to the QueueScheduler so a
    // blackbox Engine test can drive a workflow `command` gate's pass/fail deterministically
    // (and observe the worker is settled while the gate runs) without shelling out — mirrors
    // the scheduler-level seam coord-helpers already exposes.
    gateExec?: GateExecFn;
    // Cloudflare federation Plan A test seams (absent ⇒ real behavior): cfFetch replaces every
    // Cloudflare v4 API call (mirrors oauthFetch/notifyFetch/otelFetch — no test ever touches
    // the real network); cfProbe replaces the selfprobe's `cloudflared access ssh` spawn;
    // cfSelfprobeRetryWindowMs/cfSelfprobeRetryIntervalMs shrink the selfprobe's retry loop for
    // deterministic tests. cloudflaredSupervisorFactory is intentionally NOT wired here — the
    // daemon process (packages/daemon/src/cloudflared-tunnel.ts) is a sibling package core does
    // not depend on, same reason SshTunnelSupervisor is started from daemon/main.ts rather than
    // from inside Engine; a later wiring step starts it there once fed.cloudflare.up reports a
    // tunnel token, mirroring how `tunnels` is built from `engine.peerConfigs()` today.
    cfFetch?: CfFetchFn; cfProbe?: ProbeFn; cfSelfprobeRetryWindowMs?: number; cfSelfprobeRetryIntervalMs?: number;
    // DAEMON-RUNS-FROM-DELETED-WORKTREE: the daemon's own resolved code root (absent ⇒ falls
    // back to this file's own on-disk location — still meaningful for an embedded/test Engine,
    // just not the bin-script path main.ts passes in prod). Surfaced via daemon.status so an
    // operator can tell how stale the running process is and whether its code is still on disk,
    // without shelling out to `ps` (the failure mode this exists for: a daemon kept running for
    // days from a worktree the janitor had already swept).
    codeRoot?: string;
    // ORPHANED-DAEMON-LEAK: test seams for HealthMonitor's orphan-chimerad sweep (absent ⇒ real
    // `ps`-based scan / real process.kill — see health.ts). Only main.ts's real daemon boot ever
    // calls healthMonitor.start(), so no existing Engine test observes either default.
    listChimeradProcesses?: () => ChimeradProcess[];
    killChimeradProcess?: (pid: number, signal: NodeJS.Signals) => void;
    // AGENT-PROCESS-NOT-REAPED: same test-seam shape, for HealthMonitor's terminal-agent-process
    // sweep (absent ⇒ real `ps`-based scan / real process.kill — see health.ts).
    listAgentProcesses?: () => AgentOsProcess[];
    killAgentProcess?: (pid: number, signal: NodeJS.Signals) => void;
    // DYNAMIC-CONCURRENCY-CAP: test seam for DynamicCapTracker's resource probe (absent ⇒
    // real os.loadavg()/os.freemem() — see dynamic-cap.ts). Same opt-in shape as
    // listChimeradProcesses/listAgentProcesses above.
    resourceSampler?: ConstructorParameters<typeof DynamicCapTracker>[0];
  }) {
    // D7: the effective config is config.json overlaid by config.d/* (precedence
    // overlay > config). With no overlay present this is byte-identical to the prior
    // loadConfig(opts.home), so every existing caller is unaffected.
    this.configStore = opts.configStore ?? new ConfigStore(opts.home);
    this.keychain = opts.keychain ?? new MacKeychain();
    this.cfFetch = opts.cfFetch;
    this.cfProbe = opts.cfProbe;
    this.cfSelfprobeRetryWindowMs = opts.cfSelfprobeRetryWindowMs;
    this.cfSelfprobeRetryIntervalMs = opts.cfSelfprobeRetryIntervalMs;
    this.prober = opts.accountProber ?? new RealAccountProber();
    // F08/D7 residual: migrate a legacy ${home}/toolpolicy.json ONCE onto the config.d overlay so
    // host.setPolicy writes go through configstore like every other daemon write (chosen over a
    // permanent fallback layer — one source of truth after boot). Runs BEFORE cfg is read so the
    // effective config already carries the migrated policy; the legacy file is renamed aside.
    this.migrateLegacyToolPolicy(opts.home);
    const cfg = this.configStore.current();
    this.cfg = cfg;
    this.home = opts.home;
    this.engineId = cfg.engine?.id ?? "local";
    // DAEMON-RUNS-FROM-DELETED-WORKTREE: captured once at construction, not re-derived later —
    // process.uptime() advances from THIS moment, and the code root a lazily-loaded module
    // resolves from can't change after import anyway (Node caches the module graph).
    this.codeRoot = opts.codeRoot ?? dirname(fileURLToPath(import.meta.url));
    this.processStartedAtMs = Date.now() - Math.round(process.uptime() * 1000);
    // DYNAMIC-MODEL-METADATA: constructed before the backends' accessor could ever fire (backends
    // only compute cost after an agent runs, long after boot). `() => this.cfg.modelCatalog` reads
    // the config live so an overrides edit needs no restart. init() (loads the persisted cache +
    // kicks a stale/absent-triggered background fetch) is fired in start() below, never awaited on
    // the network path — an offline daemon boots on the stale/empty cache. Skipped under the fake
    // backend so unit tests never touch the network or CHIMERA_HOME.
    this.modelCatalogService = new ModelCatalogService(() => this.cfg.modelCatalog, { home: opts.home });
    this.groupStore = new GroupStore(opts.home);
    this.secrets = new SecretStore({
      home: opts.home,
      keychain: this.keychain,
      // A grant is bound to an agent and must never outlive it — the store asks this on every
      // read rather than subscribing to terminal transitions.
      isLiveAgent: (agentId) => {
        const rec = this.supervisor.list().find((a) => a.agentId === agentId);
        return rec !== undefined && (rec.state === "running" || rec.state === "paused");
      },
    });
    this.backendsRef = opts.backends;
    // INPROC-CHIMERA-BRIDGE: every backend rebuilt on a live hot-reload gets an engine accessor
    // too, same as the boot-time buildBackends call in main.ts — `this` is already the real
    // Engine instance by the time anything actually calls .get() (backends only spawn agents
    // after boot fully completes). A test's own backendBuildDeps.engine override wins if given.
    this.backendBuildDeps = {
      ...(opts.backendBuildDeps ?? {}),
      engine: opts.backendBuildDeps?.engine ?? { get: () => this },
      // DYNAMIC-MODEL-METADATA: a live-added provider's backend gets the same catalog accessor the
      // boot-time backends do (main.ts), so its authoritative cost also uses catalog pricing.
      modelCatalog: opts.backendBuildDeps?.modelCatalog ?? (() => this.modelCatalogService),
    };
    this.backendBuilder = opts.backendBuilder ?? buildBackends;
    this.fetchCodexCliModels = opts.fetchCodexCliModels ?? fetchCodexCliModels;
    // DYNAMIC-MODEL-LISTS: one disk-backed cache, installed module-wide so a BACKEND that
    // observes its provider's list mid-session (claude.ts, kimi.ts) can record it without a
    // reference to the Engine.
    this.modelLists = new ModelListCache(opts.home, opts.modelListTtlMs !== undefined ? { ttlMs: opts.modelListTtlMs } : {});
    installModelListCache(this.modelLists);
    this.probeClaudeModels = opts.probeClaudeModels ?? (() => probeClaudeModelsDefault());
    this.probeKimiModels = opts.probeKimiModels ?? (() => probeKimiModels());
    // boot's backends map was already built against these overrides (main.ts runs the same
    // PROVIDERS+providerOverrides merge before calling buildBackends) — start the snapshot
    // there so the FIRST live reconcile only rebuilds providers whose override actually
    // changed since boot, not every provider on the first accounts/providerOverrides edit.
    this.appliedProviderOverrides = cfg.providerOverrides;
    this.appliedCustomProviders = cfg.customProviders;
    this.registry = new AccountRegistry(cfg);
    // DYNAMIC-CONCURRENCY-CAP: opts.resourceSampler is a test seam (absent ⇒ the real
    // os.loadavg()/os.freemem() sampler — see dynamic-cap.ts's realResourceSampler). No test
    // that leaves caps.dynamicCap unconfigured ever observes it (sample() itself no-ops when
    // the config is disabled, which is every existing deployment/test).
    this.dynamicCap = new DynamicCapTracker(opts.resourceSampler);
    // R2-DURABLE-LOG: boot-time-only durability config (like snapshot/providerOverrides above) —
    // a config.patch to `durability` takes effect on the NEXT restart, not live.
    this.events = new EventLog(opts.home, {
      durability: cfg.durability,
      maxEventsPerSegment: cfg.eventRetention?.maxEventsPerSegment,
      maxSegments: cfg.eventRetention?.maxSegments,
    });
    // BOOT-LATENCY-EVENTLOG: the sealed-segment verification no longer finishes inside the
    // EventLog constructor (it walks ~700MB of retained history on a real daemon and used to
    // hold the whole boot — and therefore the RPC socket — for seconds), so the operator log
    // hangs off its completion instead of being read inline. Fire-and-forget: an integrity
    // sweep must never gate anything on the boot path.
    void this.events.verified().then(() => {
      const recovery = this.events.recoveryReport();
      if (recovery.quarantined.length > 0 || recovery.seqGaps.length > 0) {
        console.error(`chimerad: event log recovery on boot — ${recovery.quarantined.length} segment(s) quarantined, ${recovery.seqGaps.length} seq gap(s) found (see the event_log_recovery event for detail)`);
      }
    });
    // HOOK-5: constructed right after this.events so the supervisor's repoWatcher seam below
    // can close over it. Only needs this.events at construction time — seeded with the
    // project list further down, once this.projects exists (ProjectStore is constructed
    // after the supervisor).
    this.repoWatcher = new RepoWatcher({ events: this.events });
    this.auditLedger = new AuditLedger(opts.home);
    this.mcpListener = new LoopbackMcpListener({
      // `?? false` and not just the schema default: a config object persisted before this key
      // existed round-trips through here without the parse that would have applied the default.
      enabled: this.cfg.mcpListener?.enabled ?? false,
      // The SAME dispatch the stdio chimera-mcp child reaches over the daemon socket — an HTTP
      // grant must never be a wider door than the pipe it replaces.
      dispatch: (method, params) => this.handle(method, params),
      audit: (input) => { this.auditLedger.append(input); },
      // F49.QA-FIX2: a rejected client was audit-ledger-only (no RPC/event ever surfaced it) —
      // this reaches the transcript/UI through the same events machinery every other
      // system-namespaced signal (network/config/federation) already uses. Routed under the
      // grant's real agentId when known (this is fundamentally about THAT agent's rejected
      // request); "mcp-listener" is a synthetic fallback only for a replayed/unknown grantId,
      // mirroring the audit record's own `agentId ?? null`.
      emit: ({ grantId, agentId, reason }) => {
        this.events.append({ agentId: agentId ?? "mcp-listener", kind: "mcp_listener_rejected", data: { grantId, agentId, reason } });
      },
    });
    this.cooldowns = new CooldownTracker(cfg.failoverCooldownMinutes * 60_000);
    this.quotas = new QuotaTracker();
    this.mailboxes = new MailboxStore(opts.home, { durability: cfg.durability });
    // WD Stage 2 (coverage B13/B14): constructed BEFORE the supervisor so its
    // toolPolicy/pluginFilter seams below can close over them. Both seams are
    // FUNCTIONS (read fresh per decision/launch) so host.setPolicy and
    // plugins.toggle apply live — no daemon restart.
    this.toolPolicy = new ToolPolicyStore(opts.home, cfg.toolPolicy);
    // FEATURE-6: constructed right after toolPolicy so its hostToolMode seam can close
    // over it (same "seam closes over the thing constructed just above" convention as
    // toolPolicy/pluginFilter below). agentId "capability" mirrors the existing
    // "config"/"network"/"federation" system-event namespacing for the (rare) case a
    // decision has no real principal; a host-tool decision always has one (record.agentId).
    // F22: constructed BEFORE the broker so its evaluator seam can close over it. Both deps are
    // lazy closures into `this.supervisor`, which does not exist yet — liveness is DERIVED at
    // decision time (there is no release hook), so it MUST read the supervisor live rather than
    // capture a snapshot.
    this.worktreeLeases = new WorktreeLeaseStore(opts.home, {
      isLive: (agentId) => this.supervisor.isLive(agentId),
      displayLabelFor: (agentId) => this.supervisor.displayLabelOf(agentId),
    });
    this.capabilityBroker = new CapabilityBroker(
      (tool, profile) => this.toolPolicy.modeFor(tool, profile),
      (event) => {
        this.events.append({ agentId: event.principal ?? "capability", kind: "capability_decision", data: event as unknown as Record<string, unknown> });
        // Dual-write: the general EventLog above is a live/recent-window cache (see events.ts's
        // file header) — this is the durable, hash-chained, never-pruned copy. `event.command`
        // arrives already redacted (supervisor.ts's toolPolicyGate scrubs it before calling
        // broker.decideHostTool), so no redaction needed here.
        this.auditLedger.append({
          agentId: event.principal, action: event.action, resource: event.resource,
          decision: event.decision, reason: event.reason,
          // F22 adds the three worktree-lease fields: the ledger is the only durable record of
          // what "warn" mode WOULD have refused, and "which worktree, whose" is the whole content
          // of that record — a bare resource string cannot be queried.
          detail: { tool: event.tool, profile: event.profile, command: event.command, server: event.server, mcpTool: event.mcpTool, workdirKey: event.workdirKey, owner: event.owner, ownerState: event.ownerState },
        });
      },
      // MCP-FOREIGN-POLICY: the foreign-MCP lookup seam. Same live-object convention as
      // hostToolMode above — reads the ToolPolicyStore fresh per decision so host.setPolicy /
      // config hot-reload apply to the very next MCP tool call, no daemon restart.
      (tool, serverKey) => this.toolPolicy.modeForMcpMaybe(tool, serverKey),
      // GATED-BUT-ALLOWED-INVISIBLE: same live-object convention as the seams above —
      // hasExplicitPolicy reads the ToolPolicyStore fresh per decision.
      (tool) => this.toolPolicy.hasExplicitPolicy(tool),
      this.worktreeLeases,
      // F22: read fresh off the live config (mirrors cloudMutationGate below) so flipping
      // enforce -> warn via config.patch applies to the very next permission check. That live
      // reachability IS the two-stage rollback.
      () => this.cfg.worktreeLease,
    );
    this.plugins = new PluginRegistry(opts.home, { claudeDir: opts.claudeDir });
    this.mcpStore = new McpStoreRegistry(opts.home);
    this.mcpPackages = new McpPackageInstaller(this.mcpStore, opts.home);
    this.registerBuiltIns(opts.home, opts.runtimeRoot);
    this.mcpStoreConnections = new McpStoreConnectionManager(this.mcpStore, this.keychain, {
      idleMs: opts.mcpStoreIdleMs, setTimer: opts.mcpStoreSetTimer, clearTimer: opts.mcpStoreClearTimer,
    });
    this.pendingMcpOAuth = new PendingOAuthStore();
    this.mcpStoreOAuth = new McpStoreOAuthFlow(this.mcpStore, this.keychain, this.pendingMcpOAuth, {
      setTimer: opts.mcpStoreOAuthSetTimer, clearTimer: opts.mcpStoreOAuthClearTimer, timeoutMs: opts.mcpStoreOAuthTimeoutMs,
    });
    this.mcpImports = opts.mcpImportScanner ?? new McpImportScanner();
    this.mcpStoreDetectAuthFn = opts.mcpStoreDetectAuth ?? detectMcpStoreOAuth;
    this.hostTools = new HostToolsScanner({ exec: opts.hostExec, staleMs: opts.hostToolsStaleMs });
    // D6: the tailscale/network seam. Shares the keychain (auth-key storage) and the event log
    // (network_changed/network_error under agentId "network"). netExec is retained for the
    // fed.sshkey.ensure ssh-keygen path below (same injectable seam).
    this.netExec = opts.netExec;
    this.readHostKeys = opts.readHostKeys ?? realReadHostKeys;
    this.userSshDir = opts.userSshDir;
    this.network = new NetworkManager({
      home: opts.home, engineId: cfg.engine?.id ?? "local", keychain: this.keychain,
      emit: (kind, data) => this.events.append({ agentId: "network", kind, data }),
      exec: opts.netExec, now: opts.netNow, cacheMs: opts.netCacheMs, pathExists: opts.netPathExists,
    });
    // D16: constructed BEFORE the supervisor so its checkpointCreate seam below can close
    // over it — isRepoBusy itself closes over `this.supervisor`, assigned right after
    // (same "lazy closure, order doesn't matter for calls after construction" trick
    // mailboxForward above uses for `this.federation`).
    this.checkpoints = new CheckpointStore({
      events: this.events,
      // repoRoot is git's SYMLINK-RESOLVED toplevel (`rev-parse --show-toplevel`) — an
      // agent's raw spec.cwd is realpath-normalized here too before comparing, or this
      // guard silently misses on any host where the cwd (or an ancestor) is a symlink
      // (routine on macOS: /tmp and /var are themselves symlinks into /private).
      isRepoBusy: (repoRoot) => this.supervisor.list().some((a) => {
        if (a.state !== "running") return false;
        let cwd = a.spec.cwd;
        try { cwd = realpathSync(cwd); } catch { /* cwd gone/unreadable — fall back to the raw string */ }
        return cwd === repoRoot || cwd.startsWith(`${repoRoot}/`);
      }),
    });
    // F23-0D (D4): the same Keychain instance accounts.setKey/accounts.test already use —
    // an oauth account's token JSON lives at rest under its own service name (tokenRef),
    // never colliding with a keychain-auth account's `chimera:<name>` service.
    this.oauthTokenStore = new OAuthTokenStore(this.keychain);
    this.pendingOAuth = new PendingOAuthStore();
    if (opts.oauthFlows) {
      this.oauthFlows = opts.oauthFlows;
    } else {
      const copilotProfile = findProvider("copilot");
      this.oauthFlows = new Map<string, OAuthFlow>();
      this.oauthFlows.set("copilot", new CopilotOAuthFlow({
        clientId: copilotProfile?.oauth?.clientId ?? "Iv1.b507a08c87ecfe98",
        scopes: copilotProfile?.oauth?.scopes ?? ["read:user"],
        fetchFn: opts.oauthFetch,
      }));
      this.oauthFlows.set("grok-build", new GrokCliOAuthFlow({ authFilePath: opts.grokAuthFilePath }));
    }
    this.oauthTokenStore.registerRefresher("copilot", new CopilotTokenRefresher(opts.oauthFetch));
    this.oauthTokenStore.registerRefresher("grok-build", new GrokCliTokenRefresher({ authFilePath: opts.grokAuthFilePath }));
    this.credentials = new CredentialResolver(opts.exec, process.env, { store: this.oauthTokenStore, findProvider });
    // ACCOUNT-QUOTA-METERS-PULL: needs registry/credentials/quotas, all constructed above —
    // built right before the supervisor so it can be handed in as quotaPoller below (the
    // opportunistic top-up call site, supervisor.ts's "result" branch).
    this.quotaPoller = new QuotaPoller({
      registry: this.registry, credentials: this.credentials, quotas: this.quotas, exec: opts.exec,
      // EVIDENCE-DRIVEN-UN-COOL: the poller learns an account's window rolled and nothing could
      // act on it — cooldowns and the parked agents lived on the other side of the daemon. This
      // closure is that link. `this.supervisor` is built a few lines below and read lazily (same
      // pattern as mailboxForward's), so by the time a poll tick runs it is always present.
      cooldownRelief: {
        heldState: (account) => {
          const stamp = this.cooldowns.stampFor(account);
          const parked = this.supervisor.hasSessionLimitPause(account);
          if (!stamp && !parked) return null;
          // A plain failover stamp with nothing parked is an overloaded/RPM 429, not a quota
          // exhaustion — quota headroom is no evidence about it, so it is reported as held (for
          // the tighter cadence) but never session-limit (so it is never cleared from here).
          if (stamp && stamp.kind === "failover" && !parked) return { since: stamp.stampedAt, sessionLimit: false };
          return { since: stamp ? stamp.stampedAt : null, sessionLimit: true };
        },
        clear: (account, evidence) => { this.supervisor.clearAccountCooldown(account, "quota-poll", evidence); },
      },
    });
    this.agentArchive = new AgentArchiveStore(opts.home);
    this.supervisor = new AgentSupervisor({
      registry: this.registry,
      credentials: this.credentials,
      backends: opts.backends,
      events: this.events,
      mailboxes: this.mailboxes,
      cooldowns: this.cooldowns,
      quotas: this.quotas,
      quotaPoller: this.quotaPoller,
      // Task-5 seam egress: forward re-stamps from/engineId from the "local" alias to the
      // concrete engineId at the moment of send (federation is built AFTER the supervisor
      // below, but this closure reads this.federation/this.engineId lazily at forward time).
      mailboxForward: (target, message) => {
        void this.federation?.forwardOrPark(target.engineId, "mailbox.forward", {
          agentId: target.agentId,
          message: { ...message, from: formatAgentAddress(this.engineId, message.from), engineId: this.engineId },
        }, message.id).catch((err) => {
          // forwardOrPark parks on unreachability; a re-thrown error is a real peer-side
          // rejection. Log-and-drop (code only — never echo message text) so this
          // fire-and-forget forward can't surface as an unhandled promise rejection.
          this.events.append({ agentId: message.from, kind: "status",
            data: { deliverToForwardFailed: target.engineId, code: (err as { code?: string })?.code ?? "unknown" } });
        });
      },
      // WD Stage 2 (coverage B14/B13) / FEATURE-6: the enforcement seams — see SupervisorDeps.
      capabilityBroker: this.capabilityBroker,
      auditLedger: this.auditLedger,
      pluginFilter: () => this.plugins.disabledFor(),
      // F21/D17: read fresh per launch (mirrors pluginFilter/toolPolicy above) so a
      // client that just subscribed with the capability gets it on its very next spawn.
      uiComponentsEnabled: () => this.hasClientCap(CLIENT_CAP_UI_COMPONENTS),
      // LEAN-AGENT-CONTEXT: read fresh per launch off the live config (mirrors pluginFilter/
      // uiComponentsEnabled) so a config.patch to leanAgentContext applies to the next spawn.
      leanAgentContext: () => this.cfg.leanAgentContext,
      leanAgentSkills: () => this.cfg.leanAgentSkills,
      advisorModel: () => this.cfg.advisorModel,
      // CLOUD-MUTATION-GATE-OPTOUT: read fresh off the live config (mirrors leanAgentContext) so
      // a config.patch to cloudMutationGate applies to the very next Bash permission check —
      // no daemon restart, no applyConfig live-apply hook needed (this.cfg is already reassigned
      // there).
      cloudMutationGate: () => this.cfg.cloudMutationGate,
      // F22: launch() acquires the lease; decidePermission reads the mode. Same live-config
      // convention as cloudMutationGate above.
      worktreeLeases: this.worktreeLeases,
      worktreeLeaseMode: () => this.cfg.worktreeLease,
      // PLAN-PROJECT-CONDUCTOR-ROUTING P3-T1: resolve a spawn's projectId from its cwd —
      // `this.projects` is constructed a few lines below (lazy closure, same
      // order-doesn't-matter trick isRepoBusy/checkpointCreate use for `this.supervisor`/
      // `this.scheduler` above). First project whose path the cwd is under wins.
      projectFor: (cwd) => this.projects.list().find((p) => isPathUnder(cwd, p.path))?.name ?? null,
      // SPAWN-SETTING-SOURCES: projectId here IS the project's own `name` (projectFor's return
      // value above) — look it up fresh per spawn so a project.setLoadProjectSettings toggle
      // applies to the very next spawn, no restart needed. Missing project (e.g. archived/
      // deleted between projectFor and this call) ⇒ false, never throws.
      projectLoadSettings: (projectId) => this.projects.list().find((p) => p.name === projectId)?.loadProjectSettings ?? false,
      // F26: same projectId-is-name, lookup-fresh-per-spawn shape as projectLoadSettings above —
      // a project.setSetupHook change applies to the very next spawn. Missing/archived project ⇒
      // null, byte-identical to "no hook configured" (runWorktreeSetupHook then no-ops).
      projectSetupHook: (projectId) => this.projects.list().find((p) => p.name === projectId)?.worktreeSetup ?? null,
      // SECRET-MANAGER: inject-granted values, resolved at every launch so a revoked grant stops
      // being injected at the agent's next process start.
      injectedSecretsFor: (agentId) => this.secrets.injectedEnvFor(agentId),
      // DYNAMIC-MODEL-METADATA: the ctx-limit stamp + live cost estimate resolve through the
      // layered catalog (config override > cached remote > provider API > hardcoded fallback).
      modelCatalog: this.modelCatalogService,
      // R2 (self-healing supervision): opts.crashLoopPolicy is a test seam — absent (every real
      // deployment) ⇒ AgentSupervisor's own DEFAULT_CRASH_LOOP_POLICY.
      crashLoopPolicy: opts.crashLoopPolicy,
      // D16 fix: gates checkpointCreate below on the SAME isGitRepo probe (and the same
      // injectable `git` seam) CheckpointStore itself uses — a non-git cwd is filtered
      // out in the supervisor BEFORE this closure is ever called, so it never fires and
      // never warns for that case.
      isGitRepo: (cwd) => this.checkpoints.isGitRepo(cwd),
      // HOOK-5: registers a worktree spawn's mainRepo for merge-to-main watching (see
      // repo-watch.ts). `this.repoWatcher` is constructed above, right after this.events.
      repoWatcher: this.repoWatcher,
      // D16: taskId resolves the SAME way artifact.add's does (scheduler.taskFor) —
      // `this.scheduler` is constructed right after the supervisor below, referenced
      // here only lazily. Swallows every CheckpointStore error — now only a REAL git
      // failure in an already-confirmed git repo, since isGitRepo above already
      // filtered the non-git-cwd case — so it never surfaces as a spawn/Bash failure.
      checkpointCreate: (input) => this.checkpoints.create({
        cwd: input.cwd, trigger: input.trigger, agentId: input.agentId, taskId: this.scheduler.taskFor(input.agentId),
        ...(input.command ? { message: `chimera checkpoint: before destructive command "${input.command.slice(0, 80)}"` } : {}),
      }).then(() => {}).catch((err) => {
        console.warn(`chimerad: checkpoint auto-trigger failed for "${input.cwd}": ${(err as Error).message}`);
      }),
      // VOICE S4: the EventSink tap's gate — `this.voiceRpc` is constructed a few lines below
      // (lazy closure, same order-doesn't-matter trick projectFor/checkpointCreate use above).
      voiceActiveSession: (agentId) => this.voiceRpc.activeSessionForAgent(agentId),
      // DYNAMIC-CONCURRENCY-CAP: the shared tracker (constructed above, right after
      // this.registry) — healthMonitor below is the only thing that ever samples it.
      dynamicCap: this.dynamicCap,
      dynamicCapConfig: () => this.cfg.caps.dynamicCap,
      agentArchive: this.agentArchive,
      // F09 QA (item 1): boot-time-only (mirrors wake's leadMs/lateFireThresholdMs convention) —
      // a config.patch to promptAck.stallMs takes effect on the NEXT daemon restart, not live.
      promptStallMs: this.cfg.promptAck.stallMs,
    });
    // R2 (self-healing supervision): constructed right after this.supervisor (mirrors
    // JobScheduler's own "constructed after supervisor" ordering convention below) — not
    // started here (main.ts calls .start() after full boot, alongside snapshotScheduler.start()).
    // ORPHANED-DAEMON-LEAK: real process-table scan wired by default (mirrors keychain/accountProber
    // above) — safe to leave always-on because the sweep only ever fires from healthMonitor.start(),
    // which only main.ts (the real daemon boot) calls; no test constructs Engine and then starts it.
    this.healthMonitor = new HealthMonitor({
      supervisor: this.supervisor, events: this.events, codeRoot: this.codeRoot,
      listChimeradProcesses: opts.listChimeradProcesses ?? listRunningChimeradProcesses,
      killChimeradProcess: opts.killChimeradProcess, selfHome: opts.home,
      listAgentProcesses: opts.listAgentProcesses ?? listRunningAgentProcesses,
      // IDLE-REAP: boot-time snapshot like snapshot/durability above — a config.patch to
      // idleReap applies on the NEXT restart, not live.
      idleReapMs: cfg.idleReap.enabled ? cfg.idleReap.idleMinutes * 60_000 : 0,
      // TERMINAL-RETENTION: same boot-time snapshot discipline as idleReap beside it.
      terminalRetentionMs: cfg.terminalRetention.enabled ? Math.round(cfg.terminalRetention.hours * 3_600_000) : 0,
      purgeExpiredTerminal: (olderThanMs) => this.purgeExpiredTerminal(olderThanMs),
      killAgentProcess: opts.killAgentProcess,
      // DYNAMIC-CONCURRENCY-CAP: same shared tracker the supervisor reads from above — this
      // is the only place that ever calls tracker.sample() (once per tick).
      dynamicCap: this.dynamicCap,
      dynamicCapConfig: () => this.cfg.caps.dynamicCap,
    });
    // ROLES-UNIFY §7: must run before TeamManager/RoleStore ever construct — both
    // strict-parse their files immediately and would reject a pre-migration shape outright.
    migrateRolesOnBoot(opts.home);
    this.teams = new TeamManager(opts.home, this.events);
    this.roles = new RoleStore(opts.home);
    // F11: constructed before the QueueStore that feeds it. resolveAgent mirrors
    // UsageLedger's resolveContext below (same "look up the live AgentRecord" trick), with
    // one deliberate difference: an unknown model is `null` here, not "unknown" — the
    // journal schema is nullable and a reader must be able to tell "not recorded" apart
    // from a real model id. The P0-2 MODEL-ATTR discipline still holds: never "default".
    this.stepJournal = new StepJournal(opts.home, {
      resolveAgent: (agentId) => {
        const record = this.supervisor.list().find((a) => a.agentId === agentId);
        if (!record) return null;
        return {
          model: record.actualModel ?? record.spec.model ?? findProvider(record.provider)?.defaultModel ?? null,
          account: record.accountName ?? null,
          provider: record.provider ?? null,
          team: record.membership?.team ?? null,
          costUsd: record.costUsd ?? null,
          // billableTokens, not the turn-local counter: message_delta re-emits the same
          // usage block message_start already reported, so anything else double-counts.
          usage: record.billableTokens ?? null,
          inputDigest: stepInputDigest(record.spec.model ?? null, record.spec.instructions ?? null, record.spec.prompt ?? null),
        };
      },
    });
    this.queues = new QueueStore(opts.home, this.events, { journal: this.stepJournal });
    // F11: one-time, idempotent — guarded on "does any journal segment already exist", so a
    // second boot re-reads the same tasks and writes nothing.
    this.stepJournal.backfillOnce(this.queues.allTasks());
    this.projects = new ProjectStore(opts.home, this.events);   // WD Stage 2 (coverage B12)
    // HOOK-5: seed watches for every already-registered, non-archived project — projects
    // created/archived/deleted AFTER this point are picked up live via repoWatcher's own
    // EventLog subscription (ProjectStore's create/archive/delete status events).
    this.repoWatcher.seedProjects(this.projects.list());
    this.mainConductorStore = new MainConductorStore(opts.home);   // FEATURE MAIN-CONDUCTOR-PERSISTENT
    // Shared cross-agent note store. F36: wired to this.events below — memory_added and
    // edit/delete `status` events, plus memory_pressure/memory_evicted, now actually reach the
    // event log (before F36 the store got `events: undefined` and emitted into the void). Only
    // memory_added has a curated topic, so the other two are log/chronicle readers only.
    // MEM-4 (PLAN-MEMORY.md §6): attach an OPTIONAL local vector index for hybrid/semantic search.
    // The embedder resolves LAZILY inside the index (first semantic query / memory.index call) — never
    // here at boot — so this construction stays cheap and network-free; with embedder "off" or absent,
    // memory search is byte-identical to today's lexical behavior. `factory` closes over the effective
    // config so a config.patch takes effect on the next restart (like snapshot/durability).
    const memCfg = cfg.memory;
    // Hermetic tests: never construct a real embedding index under vitest — a developer's live Ollama
    // (or an installed transformers.js) must not make memory-search tests nondeterministic or hit the
    // network. The index path itself is covered directly with a fake provider (memory-hybrid.test.ts).
    const memoryIndex = memCfg.embedder === "off" || process.env.VITEST
      ? undefined
      : new MemoryVectorIndex(join(opts.home, "memory-index"), () =>
          resolveEmbeddingProvider(memCfg.embedder, {
            modelsDir: join(opts.home, "models"),
            ollamaHost: memCfg.ollamaHost,
            ollamaModel: memCfg.ollamaModel,
          }));
    this.memory = new MemoryStore(opts.home, this.events, undefined, memoryIndex, { alarmAt: memCfg.evictionAlarmAt });
    // CHRONICLE-SEMANTIC: the searchable long memory over event history. Same lazy/hermetic rules as
    // the memory index above — constructed cheaply, embedder resolved on first query, never under
    // vitest (a developer's live model must not make tests nondeterministic).
    this.chronicle = memCfg.embedder === "off" || process.env.VITEST
      ? null
      : new ChronicleIndex(join(opts.home, "chronicle-index"), () =>
          resolveEmbeddingProvider(memCfg.embedder, {
            modelsDir: join(opts.home, "models"),
            ollamaHost: memCfg.ollamaHost,
            ollamaModel: memCfg.ollamaModel,
          }));
    if (this.chronicle) {
      try { this.chronicle.load(); } catch { /* the sidecar is disposable — boot empty and re-index */ }
      // Index on append. Distillation is a synchronous filter that drops ~78% of events on kind
      // alone, so this stays cheap on the hot event path; embedding happens in the background.
      this.events.subscribe((e) => {
        const doc = distillEvent(e, (agentId) => {
          try {
            const rec = this.supervisor.status(agentId);
            return { treeId: rec.treeId ?? null, team: rec.membership?.team ?? null };
          } catch {
            // The agent is already gone. Its events are still worth indexing — that is the whole
            // point of a memory that outlives the agent — they just carry no scope keys.
            return { treeId: null, team: null };
          }
        });
        if (doc) this.chronicle!.add(doc);
      });
    }
    // D12: constructed before the scheduler — its step machine depends on it.
    this.workflows = new WorkflowStore(opts.home, this.events);
    // D13: constructed before the scheduler — its step machine's `artifact` gate depends on it.
    this.artifacts = new ArtifactStore(opts.home, this.events);
    this.reviews = new ReviewStore(opts.home, this.events);
    this.evidence = new EvidenceStore({
      queues: this.queues, workflows: this.workflows, artifacts: this.artifacts,
      resolveAgentCwd: (agentId) => {
        try { return this.supervisor.status(agentId).spec.cwd; } catch { return null; }
      },
    });
    this.scheduler = new QueueScheduler({
      teams: this.teams, queues: this.queues, supervisor: this.supervisor, events: this.events,
      workflows: this.workflows, artifacts: this.artifacts, roles: this.roles,
      ...(opts.gateExec !== undefined ? { gateExec: opts.gateExec } : {}),
    });
    this.scheduler.attach();
    // FEATURE-11: constructed after teams/queues/scheduler/supervisor/workflows/artifacts
    // (all above) — every dependency any of the three modules touches is guaranteed assigned
    // by this point.
    const issuesBoard = new IssuesBoard({ home: opts.home, queues: this.queues, accepted: taskId => this.reviews.get(taskId).decision?.status === "accepted" });
    this.issuesRpc = new IssuesRpc({
      board: issuesBoard, queues: this.queues, projectExists: id => this.projects.has(id),
      scope: caller => {
        const record = this.supervisor.status(caller);
        const project = record.projectId ? this.projects.get(record.projectId) : null;
        const queue = record.membership ? this.teams.get(record.membership.team).queue : null;
        const projectQueues = project ? [project.queue, ...project.teams.map(t => this.teams.get(t).queue)].filter((q): q is string => q !== null) : [];
        return { projectId: record.projectId ?? null, queue, conductor: record.spec.conductor, projectQueues };
      },
      origin: (queue, caller) => this.resolveTaskOriginConductor(queue, caller), tick: () => this.scheduler.tick(),
    });
    this.teamRpc = new TeamRpc({ teams: this.teams, queues: this.queues, scheduler: this.scheduler, supervisor: this.supervisor, roles: this.roles });
    this.roleRpc = new RoleRpc({ roles: this.roles, teams: this.teams });
    // FEATURE WORKFLOW-RUN-P1: workflow.run needs queues/teams/projects/supervisor/
    // scheduler (queue resolution + provisioning) alongside the workflow store itself.
    this.workflowRpc = new WorkflowRpc({
      workflows: this.workflows, queues: this.queues, teams: this.teams, projects: this.projects,
      supervisor: this.supervisor, scheduler: this.scheduler, home: opts.home,
    });
    this.forkRpc = new ForkRpc(new ConversationForks({
      agent: id => this.supervisor.status(id), backend: provider => this.backendsRef.get(provider),
      accountProvider: account => this.registry.get(account).provider, events: this.events,
      spawn: this.supervisor.spawn.bind(this.supervisor), redact: text => this.supervisor.redactForPeer(text),
      changed: record => { this.events.append({ agentId: record.agentId, kind: "status", data: { forkLineage: record.forkLineage } }); },
    }));
    const contextLinkStore = new ContextLinkStore(opts.home, {
      agent: id => this.supervisor.status(id), summary: id => this.supervisor.result(id).text,
      artifact: id => this.artifacts.get(id), artifactText: (id, max) => this.artifacts.readContent(id, max),
      redact: (_id, text) => this.supervisor.redactForPeer(text),
      audit: input => { this.auditLedger.append(input); },
      changed: link => { this.events.append({ agentId: link.toAgentId, kind: "context_link_changed", data: { id: link.id } }); },
    });
    this.contextLinksRpc = new ContextLinksRpc(contextLinkStore, async (agentId, linkId) => { await this.supervisor.send(agentId, `Context snapshot available: ${linkId}`, "contextlink"); });
    this.canvasRpc = new CanvasRpc({
      store: new CanvasStore(opts.home),
      projectQueues: id => { const p = this.projects.get(id); return [p.queue, ...p.teams.map(t => this.teams.get(t).queue)].filter((q): q is string => q !== null); },
      agents: () => this.supervisor.list().filter(a => !a.shadow).map(a => ({ ...a, spec: { ...a.spec, title: a.displayLabel } })),
      tasks: () => { const links = new Map(issuesBoard.linkList().map(l => [l.taskId, l])); return this.queues.allTasks().map(t => ({ ...t, issueLink: links.get(t.taskId) })); },
      artifacts: () => this.artifacts.list(),
      links: callerAgentId => contextLinkStore.list({}, callerAgentId ? { agentId: callerAgentId } : { operator: true }).links,
      callerQueue: id => { const a = this.supervisor.status(id); return a.membership ? this.teams.get(a.membership.team).queue : null; },
    });
    this.artifactRpc = new ArtifactRpc({ artifacts: this.artifacts, scheduler: this.scheduler, queues: this.queues,
      agentWorkdir: agentId => {
        const record = this.supervisor.status(agentId);
        return resolveWorkdirPath({ ...record.spec, agentId });
      },
    });
    // R2 (self-healing supervision): reads state.json directly (via replayAgentsAsOfFromStateFile),
    // same "home"-scoped file access pattern reattach.ts's boot glue already uses.
    this.gitOpsRpc = new GitOpsRpc({
      resolve: (target, caller) => {
        const agentId = "agentId" in target ? target.agentId : this.queues.getTask(target.taskId).agentId;
        if (!agentId) throw new GitOpsError("unsupported", "task has no current worktree agent; select a provenance agent");
        const record = this.supervisor.status(agentId);
        if (record.shadow || record.spec.isolation !== "worktree") throw new GitOpsError("unsupported", "only local isolated worktrees are eligible");
        if (caller) {
          let id: string | null = agentId;
          const seen = new Set<string>();
          while (id && id !== caller && !seen.has(id)) { seen.add(id); id = this.supervisor.status(id).parentId; }
          if (id !== caller) throw new GitOpsError("access_denied", "only your own or descendant worktrees are visible");
        }
        const spec = { ...record.spec, agentId };
        if (!existsSync(worktreePath(spec))) throw new GitOpsError("unsupported", "isolated worktree is gone");
        const root = realpathSync(resolveWorkdirPath(spec));
        if (root !== resolve(worktreePath(spec))) throw new GitOpsError("unsupported", "symlinked worktree roots are not eligible");
        if (!leaseKeyForPath(root)) throw new GitOpsError("unsupported", "worktree is gone; main checkout is never a fallback");
        return root;
      },
      writeReason: (root, caller) => {
        const layout = leaseKeyForPath(root)!;
        const owner = this.worktreeLeases.ownerOf(layout.key);
        if (caller) {
          const ctx = this.supervisor.worktreeWriteContext(caller);
          if (!ctx?.caller || realpathSync(ctx.caller.dir) !== root || owner?.lease.ownerAgentId !== caller) return "your own authorized worktree lease is required";
          const permissions = this.supervisor.status(caller).spec.permissionProfile;
          if (permissions === "readOnly") return "restricted permissions: use the operator review actions";
        } else if (owner) return `worktree lease held by ${owner.lease.ownerAgentId}; explicitly release or hand off before editing`;
        return null;
      },
    });
    this.resourcesRpc = new ResourcesRpc({ supervisor: this.supervisor, admission: () => ({
      ...this.dynamicCap.effectiveCap(this.registry.maxTotal(), this.cfg.caps.dynamicCap),
      running: this.supervisor.list().filter(a => a.state === "running" && !a.shadow).length,
    }) });
    this.healthRpc = new HealthRpc({ supervisor: this.supervisor, events: this.events, home: opts.home });
    this.shadowRpc = new ShadowRpc({ supervisor: this.supervisor });
    // PLAN-HOOKS.md §2 (HOOK-2): agent-facing event subscriptions — persisted state (not
    // config-driven), so unlike `notifier` below it needs no setRules() call; constructed here
    // (after supervisor/mailboxes/events) so `subRpc.handlers` can join the SAME contractHandlers
    // spread as every other RPC-family module instead of a separate readonly reassignment.
    this.subscriptions = new SubscriptionRegistry(opts.home, {
      events: this.events,
      mailboxes: this.mailboxes,
      getAgent: (agentId) => {
        const record = this.supervisor.list().find((a) => a.agentId === agentId);
        return record ? { state: record.state, spec: { resume: record.spec.resume ?? undefined } } : undefined;
      },
      wakeMailbox: (agentId) => this.supervisor.wakeMailbox(agentId),
      resumeForSignal: (agentId) => this.supervisor.resumeForSignal(agentId),
    });
    this.subRpc = new SubRpc({ registry: this.subscriptions });
    // HOOK-CRUD-RPC: reads/writes go through the SAME configStore.patch + applyConfig pair the
    // config.patch handler uses, so a rule created this way hot-reloads into the live HookEngine
    // exactly like an operator edit, and an invalid result is refused with nothing written.
    this.hookRpc = new HookRpc({
      readHooks: () => this.cfg.hooks,
      writeHooks: (rules) => {
        const { config, changed } = this.configStore.patch({ hooks: rules });
        this.applyConfig(config, changed);
      },
    });
    this.operatorWeb = new OperatorWeb({ ...operatorWebEngine(this), home: opts.home, bundleDir: resolve(dirname(fileURLToPath(import.meta.url)), "../../app/dist") });
    this.sttRpc = new SttRpc(new LocalStt({ home: opts.home }));
    this.voiceRpc = new VoiceRpc();
    const voiceIdentity = (id: string) => {
      const r = this.supervisor.status(id);
      return { agentId: id, name: voiceAgentName(id, r.displayLabel, r.spec.conductor, r.projectId ?? undefined), role: r.spec.conductor ? "conductor" : r.membership?.role ?? "agent", state: r.state, conductor: r.spec.conductor };
    };
    this.voiceRoomRpc = new VoiceRoomRpc({ plan: async (id, input, signal) => {
      signal.throwIfAborted();
      const handle = this.supervisor.currentNativeVoice(id) ?? await this.supervisor.prepareNativeVoice(id, true);
      signal.throwIfAborted();
      if (!handle.planMeeting) throw new Error("This Codex transport does not support meeting participation planning");
      return handle.planMeeting(input, signal);
    }, identity: voiceIdentity, limits: () => this.cfg.nativeVoice, check: (id, allowOwnedTransition) => this.supervisor.nativeVoiceCheck(id, allowOwnedTransition), stop: id => this.nativeVoiceRpc.stopRoom(id), stopParticipant: (room, agent) => this.nativeVoiceRpc.stopParticipant(room, agent), updated: (room, context) => this.nativeVoiceRpc.updateRoomContext(room, context),
      diagnostic: (agentId, roomId, diagnostic) => { this.events.append({ agentId, kind: "voice_diagnostic", data: { roomId, ...diagnostic } }); },
    });
    this.nativeVoiceRpc = new NativeVoiceRpc({
      maxSessions: () => this.cfg.nativeVoice.maxSessions,
      identity: id => { const { agentId, name, role } = voiceIdentity(id); return { agentId, name, role }; },
      meeting: (room, host, agent) => this.voiceRoomRpc.context(room, host, agent),
      validateCaller: id => { if (this.supervisor.status(id).state !== "running") throw new Error("Voice requester is not running"); },
      history: async id => (await this.events.tailKindAsync(id, "voice_native_message", 100)).flatMap(e => {
        const parsed = NativeVoiceMessageSchema.safeParse(e.data);
        return parsed.success ? [parsed.data] : [];
      }),
      persist: (agentId, message) => { this.events.append({ agentId, kind: "voice_native_message", data: { ...message } }); if (message.role === "assistant") this.voiceRoomRpc.message(agentId); },
      ended: agentId => { this.events.append({ agentId, kind: "voice_session_state", data: { native: true, state: "idle", stopRequested: true } }); },
      diagnostic: (agentId, roomId, diagnostic) => {
        if (roomId) this.voiceRoomRpc.record(roomId, { ...diagnostic, agentId });
        else this.events.append({ agentId, kind: "voice_diagnostic", data: { ...diagnostic, origin: "daemon", at: Date.now() } });
      },
      configure: (agentId, enabled) => this.supervisor.configureNativeVoice(agentId, enabled),
      check: (id) => this.supervisor.nativeVoiceCheck(id),
      prepare: (id, acknowledged) => this.supervisor.prepareNativeVoice(id, acknowledged),
      current: (id) => this.supervisor.currentNativeVoice(id),
    });
    this.contractHandlers = {
      "group.list": () => ({ groups: this.groupStore.list() }),
      "group.create": (p) => {
        const group = this.groupStore.create({ ...p, now: Date.now() });
        this.events.append({ agentId: "group:registry", kind: "group_registry_changed", data: { operation: "create", id: group.id } });
        return group;
      },
      "group.update": (p) => {
        const group = this.groupStore.update(p.id, p);
        this.events.append({ agentId: "group:registry", kind: "group_registry_changed", data: { operation: "update", id: group.id } });
        return group;
      },
      "group.delete": (p) => {
        const existed = this.groupStore.get(p.id) !== undefined;
        this.groupStore.delete(p.id);
        if (existed) this.events.append({ agentId: "group:registry", kind: "group_registry_changed", data: { operation: "delete", id: p.id } });
        return { ok: true };
      },
      "agent.setGroups": async (p) => { await this.supervisor.setAgentGroups(p.agentId, p.groups); return { ok: true }; },
      "agent.addGroups": async (p) => { await this.supervisor.changeAgentGroups(p.agentId, p.groups, "add"); return { ok: true }; },
      "agent.removeGroups": async (p) => { await this.supervisor.changeAgentGroups(p.agentId, p.groups, "remove"); return { ok: true }; },
      "queue.create": (p) => {
        if (p.spec.workflow !== null) this.workflows.get(p.spec.workflow);   // UnknownWorkflowError BEFORE anything persists
        return this.queues.create(p.spec);
      },
      "queue.list": () => this.queues.list(),
      "queue.update": (p) => {
        if (p.patch.workflow !== undefined && p.patch.workflow !== null) this.workflows.get(p.patch.workflow);
        return this.queues.update(p.name, p.patch);
      },
      "queue.delete": (p) => ({ deleted: this.queues.delete(p.name) }),
      "queue.push": async (p) => {
        if (p.workflow !== undefined) this.workflows.get(p.workflow);   // UnknownWorkflowError BEFORE anything persists
        const originConductorId = await this.resolveTaskOriginConductor(p.queue, p.pushedBy ?? null);
        const task = this.queues.push(p.queue, {
          prompt: p.prompt, priority: p.priority, role: p.role ?? null, overrides: p.overrides,
          tags: p.tags,   // TASK-TAGS
          dependsOn: p.dependsOn, pushedBy: p.pushedBy ?? null,   // WD Stage 1 (coverage B9)
          originConductorId,
          workflow: p.workflow ?? null,   // D12
        });
        await this.scheduler.tick();
        return task;
      },
      "queue.status": (p) => this.queues.status(p.queue),
      // TOKEN-OPT-P1: the DEFAULT an orchestrator should poll instead of queue.status — same
      // counts, but tasks are projected to {id, state, subject} and the terminal (done/failed)
      // slice is paginated (default page 25). queue.status is unchanged for callers that need
      // full prompt/resultText/stepHistory (e.g. TaskInspector).
      "queue.statusSummary": (p) => this.queues.summary(p.queue, { limit: p.limit, cursor: p.cursor }),
      "queue.cancelTask": (p) => ({ cancelled: this.queues.cancel(p.taskId) }),
      // RETRY-BACKOFF: replay a dead-lettered task — reverts it to "pending" (fresh retry
      // budget) and drains it on this same tick, same as queue.push.
      "queue.requeue": async (p) => {
        const task = this.queues.requeue(p.taskId);
        await this.scheduler.tick();
        return task;
      },
      // QUEUE-PAUSE: pause needs no tick (it can only shrink what the scheduler drains); resume
      // ticks immediately so pending work resumes draining to the queue's team agents right away,
      // same as queue.push/requeue.
      "queue.pause": (p) => this.queues.pause(p.queue),
      "queue.resume": async (p) => {
        const spec = this.queues.resume(p.queue);
        await this.scheduler.tick();
        return spec;
      },
      // TASK-EDIT-VERSIONING: sparse in-place edit of a pending/blocked task. Validate the new
      // workflow binding BEFORE anything persists (mirrors queue.push/queue.update's pre-persist
      // this.workflows.get guard — a non-null workflow override must name a real workflow). A
      // priority change can promote the task; tick so a now-higher-priority pending task is
      // considered on this same call, same as queue.push/requeue.
      "queue.editTask": async (p) => {
        if (p.patch.workflow !== undefined && p.patch.workflow !== null) this.workflows.get(p.patch.workflow);
        const task = this.queues.editTask(p.taskId, p.patch, p.editedBy ?? null);
        await this.scheduler.tick();
        return task;
      },
      // QUEUE-REORDER: reordering a BLOCKED task can't itself make new work eligible, but a
      // pending one can jump the queue relative to others — tick so a newly-front task is
      // considered on this same call, same as queue.push/requeue/editTask.
      "queue.moveTask": async (p) => {
        const task = this.queues.moveTask(p.taskId, p.direction);
        await this.scheduler.tick();
        return task;
      },
      // QUEUE-REORDER: retryTask pushes a fresh clone (queues.ts) — tick immediately, same as
      // queue.push itself.
      "queue.retryTask": async (p) => {
        const task = this.queues.retryTask(p.taskId);
        await this.scheduler.tick();
        return task;
      },
      // QUEUE-REORDER: adding a dependency can only ever narrow eligibility (pending -> blocked),
      // never widen it — no tick needed, mirrors queue.pause's own no-tick rationale.
      "queue.addDependency": (p) => this.queues.addDependency(p.taskId, p.dependsOnTaskId),
      // F15: read-only, NEVER ticks. queue.pause's own no-tick rationale applies a fortiori —
      // explaining cannot change what drains.
      "queue.explainTask": (p) => this.scheduler.explainTask(p.taskId),
      // AGENT-INITIATED-REMEDIATION: workflow-SHAPE validation lives here (this is the only
      // caller with WorkflowStore access) — queues.ts's setPendingRemediationRequest only checks
      // task-shape (workflow-bound, in_progress, caller-is-current-agent). The actual jump is
      // deferred to this turn's end (scheduler.ts's handleWorkflowTurn), which re-validates
      // everything below in case the workflow/step moved between this call and then — never
      // trust a stale RPC-time snapshot as license to skip re-checking at execution time.
      "queue.requestRemediation": (p) => {
        const task = this.queues.getTask(p.taskId);
        if (task.workflow === null) throw new RemediationRequestInvalidError(`task ${p.taskId} is not workflow-bound`);
        const wf = this.workflows.get(task.workflow.name, task.workflow.version);
        const step = wf.steps[task.stepIndex];
        if (!step) throw new RemediationRequestInvalidError(`task ${p.taskId} has no step at index ${task.stepIndex}`);
        const onFailResolved = step.onFail ?? wf.onFail;
        const remediatePolicy = step.gate.kind !== "critic" && onFailResolved === "remediate" ? (step.remediate ?? wf.remediate) : undefined;
        if (!remediatePolicy) {
          throw new RemediationRequestInvalidError(`step "${step.id}" has no configured remediate policy — agent-initiated remediation is unavailable here`);
        }
        const targetIndex = wf.steps.findIndex((s) => s.id === p.targetStepId);
        if (targetIndex < 0) throw new RemediationRequestInvalidError(`unknown step id "${p.targetStepId}"`);
        if (targetIndex >= task.stepIndex) {
          throw new RemediationRequestInvalidError(`target step "${p.targetStepId}" must be strictly earlier than the current step (index ${task.stepIndex})`);
        }
        const targetStep = wf.steps[targetIndex]!;
        if (targetStep.fanOut || targetStep.subWorkflow) {
          throw new RemediationRequestInvalidError(`target step "${p.targetStepId}" is a fan-out/sub-workflow dispatch step — no agent runs for it`);
        }
        const sameAnchor = task.remediationGateStep === task.stepIndex;
        const roundsSoFar = sameAnchor ? task.remediationRounds : 0;
        this.queues.setPendingRemediationRequest(p.taskId, {
          targetStepId: p.targetStepId, brief: p.brief, requestedBy: p.requestedBy ?? null,
        });
        return {
          recorded: true as const, targetStepId: p.targetStepId, targetStepTitle: targetStep.title,
          roundsSoFar, maxRounds: remediatePolicy.maxRounds,
          note: `Recorded. Step "${step.title}"'s own gate will be SKIPPED once you end this turn, and step "${targetStep.title}" runs next with your brief attached. This is a preview, not a guarantee — ${Math.max(0, remediatePolicy.maxRounds - roundsSoFar - 1)} round(s) would remain after this one if accepted.`,
        };
      },
      "evidence.get": (p) => this.evidence.getTaskEvidence(p.taskId),
      "history.runs": (p) => this.runHistory.runs(p),
      "journal.query": (p) => this.stepJournal.query(p),
      // F25: taskId is optional for an agent — resolve it from the caller's CURRENT binding, the
      // same server-side resolution checkpoint.create uses rather than trusting params.
      "review.get": (p) => {
        const taskId = p.taskId ?? (p.agentId ? this.scheduler.taskFor(p.agentId) : null);
        if (!taskId) throw rpcError("protocol", "review.get needs a taskId — you are not currently bound to a task");
        return this.reviews.get(taskId);
      },
      "review.finding.add": (p) => this.reviews.addFinding({ ...p, hunkId: p.hunkId ?? null, parentId: p.parentId ?? null, authorAgentId: p.authorAgentId ?? null }),
      "review.finding.resolve": (p) => this.reviews.resolveFinding(p.taskId, p.findingId, p.actorAgentId ?? null),
      "review.decide": (p) => {
        const session = this.reviews.decide(p.taskId, { status: p.status, actorAgentId: p.actorAgentId ?? null, summary: p.summary });
        if (p.status === "changes_requested") this.wakeReviewAuthor(session);
        return session;
      },
      "audit.verify": () => this.auditLedger.verify(),
      // F22.2: leaseHandoff/leaseRelease reach here via TWO paths — direct RPC (TUI/app operator
      // UI, `callerAgentId` absent, always trusted) and MCP `worktree_lease_handoff`/`_release`
      // tools (resolve() forces `callerAgentId` to the caller's own ctx.agentId, unforgeable).
      // When present, it must match the lease's current holder — a foreign agent cannot
      // hand off or release a lease it doesn't hold. The lease store itself has no notion of a
      // caller; that check belongs here, one layer up.
      // leaseList takes the SAME callerAgentId on the same two paths (QA of F22): the operator's
      // direct RPC omits it and still sees the whole fleet (that IS the TUI/app lease view), while
      // an agent asking through the MCP tool only ever sees the leases it holds — the holder ids,
      // labels and absolute worktree dirs of other tenants are not its business.
      "worktree.leaseList": (p) => {
        const all = this.worktreeLeases.list();
        return p.callerAgentId ? all.filter((v) => v.ownerAgentId === p.callerAgentId) : all;
      },
      "worktree.leaseHandoff": (p) => {
        if (p.callerAgentId) {
          const owner = this.worktreeLeases.ownerOf(p.workdirKey);
          if (!owner || owner.lease.ownerAgentId !== p.callerAgentId) {
            throw new GuardrailError(`worktree "${p.workdirKey}" is leased to ${owner?.lease.ownerAgentId ?? "no one"}; only the operator or the current holder may hand it off`);
          }
        }
        return this.worktreeLeases.handoff(p.workdirKey, p.toAgentId);
      },
      "worktree.leaseRelease": (p) => {
        if (p.callerAgentId) {
          const owner = this.worktreeLeases.ownerOf(p.workdirKey);
          if (!owner || owner.lease.ownerAgentId !== p.callerAgentId) {
            throw new GuardrailError(`worktree "${p.workdirKey}" is leased to ${owner?.lease.ownerAgentId ?? "no one"}; only the operator or the current holder may release it`);
          }
        }
        // The store's boolean, not a constant `true`: on the operator path (no callerAgentId,
        // so the holder check above is skipped) releasing an unknown/already-gone key must
        // report `released:false` rather than claim a release that never happened.
        return { released: this.worktreeLeases.release(p.workdirKey, { force: p.force }) };
      },
      // QA of F15/F22: the dry-run. Everything here is READ-ONLY — evaluateWrite acts on nothing,
      // and the checks it returns are the SAME array the permission gate refuses on, so "why was
      // I refused" and "would I be refused" can never be two different sentences. The caller
      // identity and the cwd relative targets resolve against come from the supervisor's own
      // worktreeWriteContext, the very method decidePermission uses — re-deriving them here is
      // exactly how a dry-run starts lying. No callerAgentId (operator's direct RPC) ⇒ caller
      // null, the strictest case: an asker with no worktree of its own, for whom every leased
      // worktree is foreign; relative targets then resolve against the daemon's own cwd.
      "worktree.explainWrite": (p) => {
        const mode = this.cfg.worktreeLease;
        const ctx = p.callerAgentId ? this.supervisor.worktreeWriteContext(p.callerAgentId) : null;
        // realishPath(resolve(...)) is byte-identical to how bashWriteTargets/editToolTargetPath
        // normalise a live tool's targets — a symlinked worktree dir must compare equal here too.
        const targets = p.targets.map((t) => realishPath(resolve(ctx?.execCwd ?? process.cwd(), t)));
        const { checks, blocked } = this.worktreeLeases.evaluateWrite(ctx?.caller ?? null, targets);
        // `blocked` alone is not a refusal: "warn" runs the identical evaluation and allows.
        return { mode, wouldRefuse: blocked !== null && mode === "enforce", targets, checks };
      },
      // F50 BUDGET-RESUME: operator-only by CONSTRUCTION — this method is absent from
      // mcp-tools.ts, and chimera_call dispatches nothing outside that table, so there is no
      // agent-reachable path to it. `principal` is therefore an audit field, not an authz check.
      "budget.resume": (p) => {
        const r = this.supervisor.resumeBudget(p.treeId);
        if (!r) return {
          resumed: false, treeId: p.treeId, totalCostUsd: 0, estimatedUsd: 0, maxBudgetUsd: 0,
          overBudget: false, blockedByAncestorNodeId: null,
          note: `no budget node "${p.treeId}" is registered — nothing to resume`,
        };
        // Ledger AFTER the release, and only for a node that actually exists: an audit trail of
        // no-ops is noise, and the entry must record the state the operator released, not a state
        // the release itself invalidated. agentId:"operator" mirrors the job_command_created
        // precedent at engine.ts:2652 — this RPC has no agent-reachable path by construction.
        this.auditLedger.append({
          agentId: "operator", action: "budget_resumed", resource: `budget:${p.treeId}`,
          decision: "allow",
          reason: p.reason ?? `budget pause released by ${p.principal}`,
          detail: {
            principal: p.principal, totalCostUsd: r.totalCostUsd, estimatedUsd: r.estimatedUsd,
            maxBudgetUsd: r.maxBudgetUsd, wasPaused: r.resumed, overBudget: r.overBudget,
          },
        });
        return {
          resumed: r.resumed, treeId: p.treeId, totalCostUsd: r.totalCostUsd,
          estimatedUsd: r.estimatedUsd, maxBudgetUsd: r.maxBudgetUsd, overBudget: r.overBudget,
          blockedByAncestorNodeId: r.blockedByAncestorNodeId,
          note: r.overBudget
            ? `released — the tree is still $${(r.totalCostUsd - r.maxBudgetUsd).toFixed(2)} over its cap, so the guardrail re-engages as soon as new spend is booked. This did not raise the budget.`
            : `released — the tree is under its cap and stays runnable.`,
        };
      },
      // SEARCH-OFF-THREAD: the whole-log read runs in the worker pool's background queue, so a
      // search — a scan over everything — can no longer freeze the daemon or outrank a click.
      "events.search": (p) => this.events.searchAsync(this.scopeChronicleToCaller(p)),
      "events.searchExport": (p) => this.events.searchExport(this.scopeChronicleToCaller(p)),
      // CHRONICLE-SEMANTIC. The MCP layer supplies the caller's identity (callerAgentId) and the
      // engine applies the policy, because only the engine knows the spawn lineage. No
      // callerAgentId is the operator's UI, which legitimately searches everything.
      // SKILL-DISCOVERY — search the machine's SKILL.md index, then load one on demand. Reading
      // the file directly is what lets a lean spawn still use a skill: the SDK's allowlist governs
      // its own Skill tool, not the daemon's filesystem.
      "skill.search": (p) => {
        const cwd = this.agentCwd(p.agentId);
        const hits = searchSkills(p.query, { cwd }, p.limit);
        return {
          skills: hits.map((h) => ({ id: h.id, name: h.name, description: h.description, source: h.source })),
          indexed: indexSkills({ cwd }).length,
        };
      },
      "skill.read": (p) => {
        const found = readSkill(p.skill, { cwd: this.agentCwd(p.agentId) });
        if (!found) return { found: false, id: null, name: null, text: null };
        return { found: true, id: found.entry.id, name: found.entry.name, text: found.text };
      },
      // TERMINAL-READBACK — the app tees, the agent reads.
      "terminal.append": (p) => {
        // Stripped HERE, not in the app: what is stored is what was on the SCREEN, and the
        // consumer is a model reading output — escape sequences are noise that also costs tokens.
        this.terminals.append(p.agentId, p.termId, stripTerminalText(p.text), p.title);
        return { ok: true as const };
      },
      // TERMINAL-WRITE: the daemon cannot reach the PTY — it lives in the app — so this resolves
      // and scopes the request and then EMITS it. The app, already subscribed and already owning
      // the PTY, does the write. Resolution happens HERE rather than in the app so the caller gets
      // a real answer: which terminal it went to, or that it had nowhere to go.
      "terminal.write": (p) => {
        // A named key is resolved HERE so the sequence exists in one place; an unknown name is
        // refused rather than typed as its own letters, which would put "ctrl-x" in a shell prompt.
        const keySeq = p.key === undefined ? "" : terminalKeySequence(p.key);
        if (keySeq === null) {
          throw rpcError("protocol", `unknown key "${p.key}" — try one of: ${terminalKeyNames().join(", ")}`);
        }
        const data = (p.text ?? "") + keySeq;
        const termId = this.terminals.resolve(p.agentId, p.terminal);
        // A write with nowhere to land is REPORTED, never silently dropped: an agent that believes
        // it typed a command and did not is worse than one that knows it failed.
        if (!termId) return { termId: null, delivered: false };
        this.events.append({ agentId: p.agentId, kind: "terminal_input", data: { termId, text: data } });
        return { termId, delivered: true };
      },
      "terminal.tabState": (p) => {
        if (p.title !== undefined) this.terminals.setTitle(p.agentId, p.termId, p.title);
        if (p.active) this.terminals.setActive(p.agentId, p.termId);
        return { ok: true as const };
      },
      "terminal.read": (p) => {
        // No agentId means "mine": the mcp layer supplies the CALLING agent's id, and a UI caller
        // passes one explicitly. Returning nothing rather than everyone's is the safe default for
        // a request that failed to say whose terminal it wanted.
        if (!p.agentId) return { terminals: [] };
        return {
          terminals: this.terminals.read(p.agentId, { termId: p.termId, limit: p.limit }).map((r) => ({
            termId: r.termId, title: r.title, text: r.text,
            truncated: r.truncated, startedAt: r.startedAt, lastAt: r.lastAt,
          })),
        };
      },
      "chronicle.search": async (p) => {
        if (!this.chronicle) return { hits: [], searched: 0, semantic: false, indexed: false, retained: this.events.retainedRange() };
        const retained = this.events.retainedRange();
        const res = await this.chronicle.search(p.query, p.scope ?? {}, Math.min(p.limit ?? 10, 50));
        return {
          ...res, indexed: true, retained,
          // A hit older than the log's retained range still ANSWERS, but its raw event is gone —
          // say so rather than let the caller chronicle_get it and get nothing back.
          hits: res.hits.map((h) => ({ ...h, distilledOnly: h.seq < retained.firstSeq })),
        };
      },
      "chronicle.get": async (p) => {
        if (!this.chronicle) return { docs: [], missing: [...p.seqs] };
        const docs = await this.chronicle.getDocs(p.seqs);
        const found = new Set(docs.map((d) => d.seq));
        return { docs, missing: p.seqs.filter((seq: number) => !found.has(seq)) };
      },
      "chronicle.status": async () => {
        if (!this.chronicle) return { enabled: false, docs: 0, embedded: 0, pending: 0, segments: 0, model: null, maxDocs: 0, error: null, oldestTs: null };
        await this.chronicle.ensureProvider();
        return { enabled: true, ...this.chronicle.status() };
      },
      "chronicle.reindex": async () => {
        if (!this.chronicle) return { indexed: 0, enabled: false };
        // Backfill from whatever the event log still holds. New installs and a freshly-deleted
        // sidecar both land here; it is a bulk verb, which is why the RPC timeout classes give
        // ".reindex" the long budget.
        let indexed = 0;
        for (const e of this.events.replay({ fromSeq: 1, limit: Number.MAX_SAFE_INTEGER })) {
          const doc = distillEvent(e, (agentId) => {
            try { const r = this.supervisor.status(agentId); return { treeId: r.treeId ?? null, team: r.membership?.team ?? null }; }
            catch { return { treeId: null, team: null }; }
          });
          if (doc && !this.chronicle.has(doc.seq)) { this.chronicle.add(doc); indexed++; }
        }
        this.chronicle.flushWrites();
        await this.chronicle.ensureProvider();
        void this.chronicle.processPending();   // embedding continues in the background
        return { indexed, enabled: true };
      },
      // FEATURE-11: team.*/workflow.*/artifact.* handlers now live in their own modules
      // (packages/core/src/rpc/*.ts) — this spread is why contractHandlers stops growing
      // linearly as more families migrate.
      ...this.teamRpc.handlers,
      ...this.roleRpc.handlers,
      ...this.workflowRpc.handlers,
      ...this.forkRpc.handlers,
      ...this.canvasRpc.handlers,
      ...this.contextLinksRpc.handlers,
      ...this.issuesRpc.handlers,
      ...this.artifactRpc.handlers,
      ...this.healthRpc.handlers,
      ...this.gitOpsRpc.handlers,
      ...this.resourcesRpc.handlers,
      ...this.shadowRpc.handlers,
      ...this.subRpc.handlers,
      ...this.hookRpc.handlers,
      ...this.sttRpc.handlers,
      ...new OperatorWebRpc(this.operatorWeb).handlers,
      ...this.voiceRpc.handlers,
      ...this.nativeVoiceRpc.handlers,
      ...this.voiceRoomRpc.handlers,
      // MCP-OAUTH slice 2: real PKCE/DCR flow — see McpStoreOAuthFlow (loopback listener +
      // KeychainOAuthClientProvider). oauth.start kicks off the SDK auth() orchestrator and
      // returns the authorize URL for the UI to open; oauth.finish is a pure poll of the
      // pending record the loopback callback resolves in the background — mirrors accounts.
      // oauth_start/oauth_finish's start-then-poll contract (accountsOAuthStart/Finish above).
      "mcpstore.oauth.start": async (p) => {
        try {
          return await this.mcpStoreOAuth.start(p.name);
        } catch (err) {
          if (err instanceof McpStoreOAuthNotConfiguredError) throw rpcError("protocol", err.message);
          throw err;
        }
      },
      "mcpstore.oauth.finish": (p) => {
        const record = this.pendingMcpOAuth.get(p.pendingId);
        if (!record) throw rpcError("protocol", `unknown or expired oauth pending id "${p.pendingId}"`);
        if (record.state.status === "pending") return { status: "pending" as const };
        if (record.state.status === "error") {
          const error = record.state.message;
          this.pendingMcpOAuth.delete(p.pendingId);
          return { status: "error" as const, error };
        }
        this.pendingMcpOAuth.delete(p.pendingId);
        return { status: "connected" as const };
      },
      // MCPSTORE-OAUTH-CANCEL: UI-triggered abandon of a pending Authorize flow (see
      // McpStoreOAuthFlow.cancel() for the close-listener/race precedence). Always succeeds
      // with an empty response -- there is nothing distinct to report for an unknown or
      // already-settled pendingId, and the RPC must be safe to call twice.
      "mcpstore.oauth.cancel": async (p) => {
        await this.mcpStoreOAuth.cancel(p.pendingId);
        return {};
      },
    };
    // FEATURE-7: constructed after this.scheduler (taskFor closes over it) and
    // this.supervisor (agentInfo closes over it) — both lazy closures, order-doesn't-matter
    // for calls after construction, same trick isRepoBusy/checkpointCreate use above.
    this.otel = new SpanRecorder({
      events: this.events, config: cfg.otel,
      taskFor: (id) => this.scheduler.taskFor(id),
      agentInfo: (id) => {
        try {
          const r = this.supervisor.status(id);
          return { parentId: r.parentId, treeId: r.treeId, role: r.membership?.role, model: r.spec.model,
            provider: r.provider, team: r.membership?.team ?? null };
        } catch {
          return null;
        }
      },
      fetchFn: opts.otelFetch, now: opts.otelNow,
    });
    // D10: constructed after teams/queues/supervisor/scheduler — loads jobs.json,
    // reconciles any run missed while the daemon was down, and arms its own timer.
    this.jobs = new JobScheduler({
      home: opts.home, teams: this.teams, queues: this.queues, supervisor: this.supervisor, scheduler: this.scheduler, events: this.events,
      roles: this.roles,
      // F01: the OS power seam, built from config.wake. Both switches off is expressed as the
      // ABSENCE of the dep rather than a flag inside it, so the whole platform path is
      // unreachable rather than merely guarded. Boot-time only, like snapshot/durability — a
      // config.patch({wake}) takes effect on the NEXT daemon restart.
      ...(this.cfg.wake.scheduleWake || this.cfg.wake.holdAwakeDuringRuns
        ? { wake: makeWakeScheduler(this.cfg.wake) } : {}),
      lateFireThresholdMs: this.cfg.wake.lateFireThresholdMs,
      wakeLeadMs: this.cfg.wake.leadMs,
    });
    // D15: constructed AFTER supervisor/jobs — resolveContext looks up the live
    // AgentRecord (account/model/team/job) for every `result` event, the same "look up the
    // live record" trick NotifyEvaluator's resolveTreeAgent uses below.
    this.usage = new UsageLedger(opts.home, {
      events: this.events,
      resolveContext: (agentId) => {
        const record = this.supervisor.list().find((a) => a.agentId === agentId);
        if (!record) return null;
        // P0-2 MODEL-ATTR: never fall back to the literal "default" — that string is not a
        // model id and made 59% of ledger rows unattributable. Prefer the backend-reported
        // actualModel (set from agent_started/message model events, see supervisor.onEvent),
        // then the spec's pinned model, then the provider's catalog default, then "unknown"
        // (an honest "we don't know", distinct from the misleading "default").
        return {
          account: record.accountName, provider: record.provider,
          model: record.actualModel ?? record.spec.model ?? findProvider(record.provider)?.defaultModel ?? "unknown",
          // JOB-FLEET-GROUPING: record.jobName (AgentRecord, stamped at spawn by jobs.ts's
          // agent-target fire() call sites) replaces the old JobScheduler.jobForAgent lookup —
          // that was a transient in-flight map, deleted the moment a run settled, so most
          // `result` events (processed at/after settlement) read it as already-gone and every
          // groupBy:"job" row collapsed to "none". record.jobName lives for the record's whole
          // life, so this is correct regardless of when the event is processed. Still only
          // covers agent-target jobs — a team-target job's worker is attributed via `team`
          // above instead (unchanged from before).
          team: record.membership?.team ?? null, job: record.jobName ?? null,
        };
      },
    });
    // F13: the read-only run-history join. Built after supervisor/queues/jobs/stepJournal/otel
    // (all four constructed above) since it only ever reads through them — no state of its own.
    this.runHistory = new RunHistoryStore({
      supervisor: this.supervisor,
      queues: this.queues,
      jobs: this.jobs,
      journal: this.stepJournal,
      rollup: (params) => this.otel.rollup(params),
    });
    // D8: the single-use invite ledger (${home}/invites.json — hashes only). Cheap; built
    // unconditionally so fed.invite.* has a store even before the first federated boot.
    this.invites = new InviteStore(opts.home);
    // D14: the notify.* rule evaluator. Subscribes to this.events itself (constructor);
    // rules are seeded from the effective config below and kept live via applyConfig's
    // diff-apply. a2a resolves the source agentId's TREE to that tree's depth-0 agentId
    // (AgentRecord.treeId IS the depth-0 agent's own id) and delivers there.
    this.notifier = new NotifyEvaluator({
      events: this.events,
      send: async (agentId, text, from) => { await this.supervisor.send(agentId, text, from); },
      resolveTreeAgent: (agentId) => {
        const record = this.supervisor.list().find((a) => a.agentId === agentId);
        return record ? record.treeId : null;
      },
      fetchFn: opts.notifyFetch, setTimer: opts.notifySetTimer, clearTimer: opts.notifyClearTimer,
    });
    this.notifier.setRules(cfg.notify);

    // PLAN-HOOKS.md §3 (HOOK-4): the hooks.* rule evaluator, constructed right after the
    // notifier it's a sibling of — same "subscribes itself, rules seeded now, kept live via
    // applyConfig" shape. Seams mirror notify's own (send/resolveTreeAgent) plus the additional
    // ones hooks' 5 action types need (task push, agent spawn, gate exec, channel delivery).
    this.hooks = new HookEngine({
      events: this.events,
      send: async (agentId, text, from) => { await this.supervisor.send(agentId, text, from); },
      resolveTreeAgent: (agentId) => {
        const record = this.supervisor.list().find((a) => a.agentId === agentId);
        return record ? record.treeId : null;
      },
      // Same lookup shape as this.subscriptions' own getAgent seam just above (HOOK-2) — the
      // "agent.spawned" topic projector's fresh-spawn-only check needs it here too.
      getAgent: (agentId) => {
        const record = this.supervisor.list().find((a) => a.agentId === agentId);
        return record ? { state: record.state, spec: { resume: record.spec.resume ?? undefined } } : undefined;
      },
      membersOf: (team, role) => this.scheduler.membersOf(team, role),
      pushTask: (queue, input) => this.queues.push(queue, input),
      getTaskCause: (taskId) => {
        try { return this.queues.getTask(taskId).cause; } catch { return null; }
      },
      getTaskAgentId: (taskId) => {
        try { return this.queues.getTask(taskId).agentId; } catch { return null; }
      },
      getAgentCause: (agentId) => {
        try { return this.supervisor.status(agentId).spec.cause; } catch { return null; }
      },
      spawnAgent: (spec, membership) => this.supervisor.spawn(spec, membership ? { membership } : {}),
      channelDeliver: (channel, sample, o) => this.notifier.deliverChannel(channel, sample, o),
      defaultCwd: () => resolveProjectBaseDir(this.cfg.projectImportDir, this.home),
    });
    this.hooks.setRules(cfg.hooks);

    if (cfg.engine?.id) {
      this.identity = EngineIdentity.loadOrCreate(opts.home);   // set BEFORE engineCard() reads publicKey
      this.federation = new FederationManager({
        home: opts.home, engineId: cfg.engine.id, identity: this.identity, card: this.engineCard(),
        peers: cfg.federation?.peers ?? [],
        reconnectBaseMs: opts.fedReconnectBaseMs, heartbeatMs: opts.fedHeartbeatMs,
        // D14/F18: the "peer partitioned" default notify rule watches this event.
        onPartitioned: (engineId) => this.events.append({ agentId: "federation", kind: "peer_partitioned", data: { engineId } }),
      });
      this.federation.start();
    } else {
      this.federation = null;
    }
  }

  // Registers/refreshes the Chimera-managed built-in integrations. Startup must survive any failure
  // here (a corrupt manifest, a read-only home): the user's own MCP entries are never at stake, so
  // it is logged and the built-ins are simply absent until the next start.
  private registerBuiltIns(home: string, runtimeRoot: string | null | undefined): void {
    try {
      const root = runtimeRoot === undefined ? findRuntimeRoot() : runtimeRoot;
      if (!root) return;
      this.builtInCtx = loadBuiltInContext(root);
      reconcileBuiltIns(this.mcpStore, { home, ctx: this.builtInCtx });
    } catch (err) {
      console.warn(`chimerad: built-in integrations unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // MCP-OAUTH-DISCOVERABILITY: a fresh http entry with NO explicit `auth` at all (mcpstore.add)
  // or an importable with no oauth-aware caller input (mcpstore.import) gets a best-effort
  // OAuth probe -- if the remote resolves an authorization server, it defaults to
  // auth.kind:"oauth" (default scopes) instead of staying auth-less/bearer. A caller that
  // already decided an explicit `auth` shape is NEVER second-guessed here (back-compat: an
  // existing bearer entry, or one built from an explicit UI choice, is untouched). A probe
  // failure (unreachable, timeout, not-oauth) is swallowed -- this must never block a plain add.
  // MCP-OAUTH-FOREIGN-SCOPES: the scope list must come from the SERVER, not from an
  // operator-configured gateway's catalog (config `mcpOAuthGateways`). That catalog describes the
  // gateway's own downstreams and is meaningless to any other authorization server; stamping it
  // on every http add sent Cloudflare seven scopes it had never heard of, and the
  // authorize/registration round-trip came back Unauthorized. Measured against real servers:
  // cloudflare advertises NO scopes_supported at all, context7 advertises openid/profile/email/...,
  // atlassian advertises 32 of its own — not one of them overlaps a gateway's private list.
  //
  // Precedence, narrowest true statement first:
  //   1. what the server itself advertises (detect's scopes_supported, RFC 8414/9728), else
  //   2. a configured gateway's defaultScopes, but ONLY for a url on that gateway's hosts, else
  //   3. no scope parameter at all — the AS then grants its registered default, which is
  //      exactly what a client with no opinion should ask for. Omitting `scope` is well-defined
  //      (RFC 6749 §3.3); sending a scope the AS does not know is an error on most servers.
  private async detectDefaultHttpAuth(name: string, url: string): Promise<McpStoreHttpAuth | undefined> {
    try {
      const detected = await this.mcpStoreDetectAuthFn(url);
      if (detected.oauth) {
        const scopes = resolveDefaultOAuthScopes(url, detected.scopesSupported, this.cfg.mcpOAuthGateways);
        return {
          kind: "oauth", keychainRef: mcpStoreAuthService(name),
          // Deliberately OMITTED rather than `[]` when nothing is known: McpStoreHttpAuthSchema
          // makes scopes optional, and oauth-client-provider.ts only emits a `scope` field when
          // the list is non-empty — so absent and empty behave identically today, but absent is
          // the honest record of "we were never told".
          ...(scopes ? { scopes } : {}),
        };
      }
    } catch {
      // best-effort — see header comment above.
    }
    return undefined;
  }

  // F08/D7 residual: one-time legacy toolPolicy migration (see the constructor call site).
  private migrateLegacyToolPolicy(home: string): void {
    const legacy = join(home, "toolpolicy.json");
    if (!existsSync(legacy)) return;
    try {
      const parsed = ToolPolicySchema.parse(JSON.parse(readFileSync(legacy, "utf8")));
      const current = (this.configStore.current().toolPolicy ?? {}) as ToolPolicy;
      // Legacy overlay historically WON over config.json — preserve that by merging it on top.
      this.configStore.patch({ toolPolicy: mergeToolPolicy(current, parsed) });
      renameSync(legacy, `${legacy}.migrated`);   // out of the way so ToolPolicyStore ignores it
    } catch {
      // A corrupt legacy file is left in place; ToolPolicyStore's own load fails fast on it (as before).
    }
  }

  // DYNAMIC-MODEL-METADATA: the layered model-metadata service. Exposed so main.ts's boot-time
  // backends (built before this Engine) can reach it via a lazy accessor, and so main.ts can fire
  // init() (persisted-cache load + stale/absent-triggered background refresh) at real-daemon boot.
  get modelCatalog(): ModelCatalogService {
    return this.modelCatalogService;
  }

  async handle(method: string, params: unknown, route?: { trustedLocalClient: true }): Promise<unknown> {
    try {
      // Listener/session administration belongs to the local socket route, never an
      // agent tool or authenticated browser session. New management methods fail closed.
      const agentIdentified = params && typeof params === "object"
        && ["callerAgentId", "agentId", "actorAgentId", "authorAgentId", "principal"].some(k => k in params);
      if (method.startsWith("operatorweb.") && method !== "operatorweb.operatorStatus" && (!route?.trustedLocalClient || agentIdentified)) {
        throw rpcError("forbidden", "Operator panel management requires a trusted local client");
      }
      // Prevent re-enable/rekey while uninstall awaits a connecting child or Keychain.
      if (method.startsWith("mcpstore.") && params && typeof params === "object" && "name" in params
        && typeof params.name === "string" && this.mcpRemoving.has(params.name)) {
        throw rpcError("conflict", "This MCP server is being uninstalled. Wait for it to finish.");
      }
      // Phase 5 Task 10: qualified-id requester-side router. A bare (local) agentId has
      // addr.engineId === null so this is a no-op and the existing local switch below
      // handles it unchanged (Phase 1-4 LOCKED). agent.spawn/accounts.list carry no
      // agentId so they always fall through to their own switch cases.
      const p = params as { agentId?: string; engine?: string } | undefined;
      // Guard: only route on a well-formed STRING agentId. A malformed (e.g. non-string)
      // agentId must fall through untouched to the per-case zod parse below, which is what
      // produces the existing {code:"protocol"} validation error (Phase 1 LOCKED behavior) —
      // calling parseAgentAddress on a non-string throws a raw TypeError with no `.code`,
      // which would otherwise mis-map to {code:"unknown"}.
      const addr = typeof p?.agentId === "string" && p.agentId.length > 0 ? parseAgentAddress(p.agentId) : null;
      if (addr?.engineId && addr.engineId !== this.engineId) {
        if (!this.federation) throw rpcError("protocol", "federation is not configured (no engine.id in config)");
        if (method === "agent.wait") throw rpcError("protocol", "agent.wait is not federated in MVP; poll agent.status");
        if (!["agent.status", "agent.result", "agent.send", "agent.kill", "agent.tail"].includes(method))
          throw rpcError("protocol", `method ${method} does not accept engine-qualified ids`);
        const remoteParams = { ...(params as Record<string, unknown>), agentId: addr.localId };
        try {
          const result = await this.federation.call(addr.engineId, method, remoteParams);
          if (method === "agent.status") {
            // Re-qualify the record's agentId to <engine>/<id> (mirrors agent.spawn) so every
            // federated surface hands back a consistent qualified id, and cache that form —
            // a caller reusing a bare id from a status result would otherwise misroute locally.
            const record = { ...(result as Record<string, unknown>), agentId: p!.agentId! };
            this.federation.cacheRecord(p!.agentId!, record);
            return record;
          }
          if (method === "agent.kill") {
            // A5: a killed remote agent must not be resurrected by agent.list's cache merge. The
            // generic forward never refreshes the record cache after a kill (only agent.status
            // does, above), so its last-cached row (e.g. state:'running') would otherwise linger
            // indefinitely. Evict the record on a successful kill so it stops surfacing.
            this.federation.evictRecord(p!.agentId!);
          }
          return result;
        } catch (err) {
          if ((err as { code?: string }).code === "peer-unreachable" && method === "agent.status") {
            const cached = this.federation.cachedRecord(p!.agentId!);
            if (cached) return { ...(cached as Record<string, unknown>), state: "unreachable", stale: true };
          }
          throw err;
        }
      }
      // FEATURE-8: RpcContract dispatch. queue.* (not a PEER_METHODS entry, so unaffected by
      // the qualified-id routing block above) is the migrated cluster this run — everything
      // else falls through to the legacy switch below, unchanged. Staying inside this method's
      // outer try/catch means ZodError/rpcError normalization (see the catch below) is
      // inherited for free — a bad queue.push request produces the exact same {code:"protocol"}
      // shape it always has.
      if (isContractMethod(method)) {
        const spec = RPC_CONTRACT[method];
        const req = spec.request.parse(params);
        const result = method.startsWith("canvas.") && route?.trustedLocalClient
          ? await this.canvasRpc.operator(method, req as never)
          : method.startsWith("contextlink.") && route?.trustedLocalClient
          ? await this.contextLinksRpc.operator(method, req)
          : (method === "agent.fork" || method === "agent.forkCapabilities") && route?.trustedLocalClient
            ? await this.forkRpc.operator(method, req as never)
            : await this.contractHandlers[method](req as never);
        return spec.response.parse(result);
      }
      switch (method) {
        case "daemon.status": {
          // F49.QA-FIX2 (finding #4): mirrors worktree.leaseList's callerAgentId idiom — an
          // agent-sourced call (via the daemon_status MCP tool) is forced to pass its own
          // ctx.agentId and only ever sees its OWN mcpListener grant; the operator's direct
          // RPC path (TUI/app) omits the field and keeps seeing the full grant roster.
          const callerAgentId = typeof (params as { callerAgentId?: unknown } | undefined)?.callerAgentId === "string"
            ? (params as { callerAgentId: string }).callerAgentId
            : undefined;
          const counts = { running: 0, paused: 0, done: 0, failed: 0, killed: 0 };   // "paused": session-limit HOLD
          // Task N-SHADOW: count REAL agents only — shadow rows are native
          // sub-agent/workflow markers, not independently-scheduled agents, so
          // folding them in would inflate the run/done tallies the StatusBar shows.
          for (const a of this.supervisor.list()) if (!a.shadow) counts[a.state]++;
          const cooling = new Map(this.cooldowns.snapshot().map((c) => [c.account, c.until]));
          // ORDER-FAILOVER: project in autoOrder (failover priority), not registry/config
          // insertion order — UI surfaces (header chips, mod+u overlay, TUI StatusBar) treat
          // array position as failover slot / "primary" account, and must agree with the
          // Settings provider table (buildProviderRows), which already orders by autoOrder.
          // Mirrors selectors.settings.ts's ordered-list construction: autoOrder entries
          // first (in autoOrder order), then any account absent from autoOrder appended last.
          const list = this.registry.list();
          const byName = new Map(list.map((a) => [a.name, a]));
          const ordered: string[] = [];
          for (const n of this.registry.autoOrder()) if (byName.has(n) && !ordered.includes(n)) ordered.push(n);
          for (const a of list) if (!ordered.includes(a.name)) ordered.push(a.name);
          return {
            protocolVersion: PROTOCOL_VERSION,
            engineId: this.engineId,                             // Phase 5: upgrades Phase 1/PP5's "local" literal to the concrete id
            agents: counts,
            accounts: ordered.map((name) => {                    // Phase 3 (Task 4): RETAINED, not clobbered — TUI StatusBar + engine-phase3.test.ts read this
              const a = byName.get(name)!;
              return {
                ...a, cooling: cooling.has(a.name), coolingUntil: cooling.get(a.name) ?? null,
                // Task AUTH-a: additive, mirrors cooling — surfaces per-account auth STATE.
                authExpired: this.supervisor.authExpiredAccounts().has(a.name),
                // ACCOUNT-QUOTA-METERS: additive, mirrors cooling — undefined for any account
                // with no usable rate-limit snapshot yet. The UI renders that as "unknown",
                // never a fake fill.
                quota: this.quotas.get(a.name),
                // QUOTA-ABSENCE-IS-INVISIBLE: WHY there's no quota data (or why the last
                // successful figures might be stale) — undefined only for an account never
                // polled at all (e.g. daemon just started, first tick hasn't fired yet).
                quotaReason: this.quotas.getReason(a.name),
              };
            }),
            peers: this.federation?.peersStatus().map(({ engineId, state, outboxPending }) => ({ engineId, state, outboxPending })) ?? [],   // Phase 5: added alongside accounts
            // WD Stage 1 (coverage B1, spend chip) / D15 unification: today's accumulated
            // result cost, RE-READ from the usage ledger (local-midnight rollover,
            // restart-persistent — see UsageLedger.todayUsd) so the SpendChip can never
            // diverge from usage.query's own totals. Plus the optional config cap (null
            // when config.json sets none; the UI hides/adjusts its meter on null).
            spendTodayUsd: this.usage.todayUsd(),
            dailyCapUsd: this.cfg.dailyCapUsd ?? null,
            // DAEMON-RUNS-FROM-DELETED-WORKTREE: provenance an operator would otherwise have to
            // `ps`/`ls` for by hand — a daemon can outlive the worktree it was started from
            // (Node keeps already-loaded modules in memory), silently running stale code with no
            // in-product signal. codeRootExists is a cheap live fs.existsSync check (one stat
            // call) done fresh on every daemon.status call, not cached at boot.
            codeRoot: this.codeRoot,
            codeRootExists: existsSync(this.codeRoot),
            processStartedAtMs: this.processStartedAtMs,
            // DYNAMIC-CONCURRENCY-CAP: surfaced unconditionally (cheap synchronous read, no
            // sampling here) so the effective admission cap and its live inputs are visible
            // without reading logs — the operator's whole complaint about a static cap was
            // that it's opaque. `ceiling` is registry.maxTotal() either way; `cap`/`explain`
            // read "disabled — static ceiling" when caps.dynamicCap is unset/off.
            agentCap: this.dynamicCap.effectiveCap(this.registry.maxTotal(), this.cfg.caps.dynamicCap),
            // F49.2: read-only projection for the settings screens (app NetworkSection,
            // TUI network section) — never carries a grant's token (McpListenerStatus's own
            // shape has no token field; see mcp-listener.ts's status()).
            // F49.QA-FIX2 (finding #4): an agent-sourced call only sees its own grant row(s);
            // the operator's unfiltered call (no callerAgentId) keeps the full roster.
            mcpListener: (() => {
              const s = this.mcpListener.status();
              return callerAgentId ? { ...s, grants: s.grants.filter((g) => g.agentId === callerAgentId) } : s;
            })(),
            // F01-QA-follow-up: job.status already carries wakeScheduling, but that requires
            // picking a job first. An operator UI with nothing selected had no signal that
            // the machine can't keep a schedule — daemon.status is the one RPC the operator UI polls
            // unconditionally (the store's 2s interval), so it belongs here
            // too, not duplicated per-job on job.list (see job.status's own anti-N-copies note).
            wakeScheduling: await this.jobs.wakeStatus(),
          };
        }
        // D15 (usage ledger, coverage §C17, F19): daemon-side aggregation over usage.jsonl.
        // Local-only by construction (absent from PEER_METHODS) — each engine's usage is
        // its own; a federated rollup isn't in scope.
        case "usage.query":
          return this.usage.query(UsageQueryParams.parse(params));
        // FEATURE-7: daemon-side aggregation over the in-memory OTel span store (otel.ts).
        // Local-only by construction (absent from PEER_METHODS) — mirrors usage.query's own
        // "each engine's own trace data, no federated rollup" scoping.
        case "sli.rollup":
          return this.otel.rollup(SliRollupParamsSchema.parse(params));
        case "accounts.list": {
          const q = z.object({ engine: z.string().optional() }).parse(params ?? {});
          if (q.engine && q.engine !== this.engineId) {
            if (!this.federation) throw rpcError("protocol", "federation is not configured");
            return await this.federation.call(q.engine, "accounts.list", {});
          }
          // ACCOUNT-KEY-PRESENCE: hasKey is a PRESENCE boolean (never the secret) so a
          // freshly-restarted UI can show "set" for a stored-but-untested key instead of
          // "missing" until the operator presses `t` — see accountHasKey's doc comment.
          return await Promise.all(this.registry.list().map(async (a) => ({
            ...a,
            hasKey: await accountHasKey(this.registry.get(a.name).auth, this.keychain, this.oauthTokenStore),
          })));
        }
        // F23-2B (D5/D6): the catalog (packages/core/src/providers/catalog.ts, F23-0D) +
        // per-provider connection state, for the Settings UI's Providers section. Local-only
        // (absent from PEER_METHODS) — a peer never needs our provider catalog. `override`
        // reflects any config providerOverrides entry (effective at the NEXT daemon boot, see
        // ProviderOverrideSchema); `accounts` lists the configured accounts already using this
        // provider so the UI can show "connected" vs. "add a key" per row.
        case "providers.list": {
          const accounts = this.registry.list();
          // CUSTOM-OPENAI-COMPAT: effectiveCatalog appends a synthesized profile per
          // cfg.customProviders entry after PROVIDERS, so a custom provider is listed
          // alongside built-ins through the exact same shape the client already renders.
          return effectiveCatalog(this.cfg).map((p) => {
            const override = this.cfg.providerOverrides?.[p.id] ?? null;
            return {
              id: p.id, label: p.label, kind: p.kind,
              baseUrl: override?.baseUrl ?? p.baseUrl,
              defaultModel: override?.defaultModel ?? p.defaultModel,
              authModes: p.authModes, capabilities: p.capabilities,
              tosNote: p.tosNote ?? null, experimental: p.experimental ?? false,
              override,
              accounts: accounts.filter((a) => a.provider === p.id).map((a) => ({ name: a.name, authType: a.authType })),
              // SPAWN-PROVIDER-MODEL: the catalog's fallback model list, so a client (the
              // spawn form's model select) has something to show before/without a live
              // providers.models probe.
              models: p.models,
              hasLiveModels: !!p.modelsEndpoint,
              custom: p.custom ?? false,
              requiresKey: p.requiresKey ?? true,
            };
          });
        }
        // SPAWN-PROVIDER-MODEL: best-effort LIVE model list for one provider, for the
        // spawn form's dynamic model select. Probes `modelsEndpoint` with the resolved
        // key of an existing account for this provider; falls back to the catalog's
        // static `models[]` whenever there is no account, no resolvable key, no
        // modelsEndpoint, or the probe fails (fetchProviderModels's own fallback) —
        // this RPC never throws for "no live data", only for an unknown provider id.
        //
        // SPAWN-FORM-ACCOUNTS: key resolution goes through the SAME CredentialResolver
        // the supervisor launches agents with (this.credentials.resolve), not a
        // keychain-only shortcut — an env/command/oauth account now also gets a live
        // probe, not just a keychain one. `subscription` accounts resolve to `null`
        // (no key, by design) rather than throwing, so they fall straight through to
        // the next candidate. With no explicit `account`, every account configured for
        // this provider is tried in order (not just the first) until one resolves —
        // e.g. a first `subscription` claude account no longer masks a second
        // apiKey/oauth claude account that COULD serve a live list.
        case "providers.models": {
          // DYNAMIC-MODEL-LISTS: resolution order, each layer falling through on a miss:
          //   1. disk-backed cache   — survives restarts; refreshed for free by any live session
          //   2. provider CLI/SDK    — codex `debug models`; a deliberate prompt-less probe for
          //                            claude (SDK supportedModels) and kimi (ACP configOptions)
          //   3. HTTP /v1/models     — the openai-compat providers, needs a resolvable key
          //   4. static catalog      — last resort, and the ONLY layer that can go stale silently
          // `refresh: true` skips layer 1 so an operator can force a re-probe from a picker.
          const p = z.object({ provider: z.string(), account: z.string().optional(), refresh: z.boolean().optional() }).parse(params);
          // CUSTOM-OPENAI-COMPAT: findEffectiveProvider also resolves a cfg.customProviders id —
          // findProvider alone only sees the built-in PROVIDERS catalog.
          const profile = findEffectiveProvider(p.provider, this.cfg);
          if (!profile) throw rpcError("protocol", `unknown provider "${p.provider}"`);
          const candidates = p.account
            ? [this.requireAccount(p.account)]
            : this.cfg.accounts.filter((a) => a.provider === p.provider);
          const reply = (models: ModelOption[], source: "live" | "cache") => ({
            models: models.map((m) => m.value),
            // The picker shows what the provider CALLS the model next to the id it must SEND —
            // claude's live list is aliases ("opus", "sonnet"), which are meaningless without
            // their display names, and kimi's ids ("kimi-code/k3") without them are worse.
            modelDetails: models,
            defaultModel: profile.defaultModel, source,
          });

          if (!p.refresh) {
            const cached = this.modelLists.get(p.provider);
            if (cached && !this.modelLists.isStale(p.provider)) return reply(cached, "cache");
          }

          // Gated on `candidates.length` (an account for this provider actually exists) so an
          // unconfigured provider never shells out or opens a session for nothing.
          if (candidates.length > 0) {
            let probed: ModelOption[] = [];
            if (p.provider === "codex") {
              const homeDir = candidates.find((a) => a.auth.homeDir)?.auth.homeDir;
              probed = (await this.fetchCodexCliModels(homeDir ? { env: { ...process.env, CODEX_HOME: homeDir } } : {})) ?? [];
            } else if (p.provider === "claude") {
              probed = await this.probeClaudeModels();
            } else if (p.provider === "kimi") {
              probed = await this.probeKimiModels();
            }
            if (probed.length) {
              this.modelLists.set(p.provider, probed);
              return reply(probed, "live");
            }
          }

          let key: string | null = null;
          for (const account of candidates) {
            try {
              const cred = await this.credentials.resolve(account.auth);
              if (cred) { key = cred.value; break; }
            } catch {
              // this account's credential didn't resolve (unset env, failed command,
              // no keychain entry, no oauth token yet) — try the next candidate rather
              // than failing the whole probe.
            }
          }
          // CUSTOM-OPENAI-COMPAT: a custom provider with requiresKey===false (e.g. an
          // unauthenticated local Ollama) has no credential to resolve — probe its
          // modelsEndpoint with an empty key rather than skipping straight to the static
          // fallback, so model discovery still works with no account/key configured.
          if (key || profile.requiresKey === false) {
            const ids = await fetchProviderModels(profile, key ?? "");
            if (ids !== profile.models && ids.length) {
              const models = ids.map((id) => ({ value: id, displayName: id }));
              this.modelLists.set(p.provider, models);
              return reply(models, "live");
            }
          }

          // Every live layer missed. A STALE cache still describes this provider better than the
          // static catalog does (it was observed from the real CLI, just a while ago), so prefer
          // it — the catalog is genuinely last.
          const stale = this.modelLists.get(p.provider);
          if (stale) return reply(stale, "cache");
          return {
            models: profile.models,
            modelDetails: profile.models.map((id) => ({ value: id, displayName: id })),
            defaultModel: profile.defaultModel, source: "catalog",
          };
        }
        case "agent.spawn": {
          const sp = SpawnParams.extend({ engine: z.string().optional() }).parse(params);
          if (sp.engine && sp.engine !== this.engineId) {
            if (!this.federation) throw rpcError("protocol", "federation is not configured (no engine.id in config)");
            const spec = resolveAgentSpec(sp.spec);
            assertFederationSafeSpec(spec);                                     // fail on OUR side too, before the wire
            const deliverTo = spec.deliverTo && parseAgentAddress(spec.deliverTo).engineId === null
              ? formatAgentAddress(this.engineId, spec.deliverTo)               // "local" alias -> concrete id at egress
              : spec.deliverTo;
            const remote = await this.federation.call<Record<string, unknown>>(sp.engine, "agent.spawn", {
              spec: { ...spec, deliverTo }, spawnId: randomUUID(), depth: sp.depth ?? 0, maxDepthCap: sp.maxDepthCap,
            });
            const qualified = { ...remote, agentId: formatAgentAddress(sp.engine, remote["agentId"] as string) };
            this.federation.cacheRecord(qualified.agentId as string, qualified);
            return qualified;
          }
          // LOCAL spawn: forward treeId exactly as Phase 2 Task 3 does — `SpawnParams` already
          // parses `treeId` (P2). Dropping it here detaches recursive chimera-MCP spawns from
          // the caller's tree/budget and fails Phase 2's treeId-passthrough MCP test
          // (CHIMERA_TREE_ID). If Phase 2 has NOT landed, `sp.treeId` is simply `undefined` and
          // the field is inert, so this is safe to keep unconditionally.
          // FEATURE-5: a REAL agent-to-agent nested spawn (sp.parentId set — the caller is
          // itself a live agent, e.g. a Task-tool/agent_spawn nesting) needs its budget
          // ancestor resolved from whatever budget node the PARENT is itself registered
          // under (its own record.budgetNodeId, e.g. a scheduler task id — NOT necessarily
          // the parent's raw agentId), so this child's own maxBudgetUsd (if set) — or an
          // unbudgeted child's cost — nests under the parent's real ancestor chain rather
          // than an unregistered key that silently no-ops admission/cost tracking.
          // supervisor.spawn resolves this itself from opts.parentId; passing parentId here
          // is enough.
          // ROLES-UNIFY §4: resolve sp.role (if set) against the unified role library and
          // merge it under the caller's own spec BEFORE resolveAgentSpec ever sees it —
          // shares resolveRole with scheduler.ts's team-spawn path (spawnForTask) instead of
          // this file's own duplicated mini-merge. This WIDENS what an ad-hoc session role
          // applies from the old curated 4-field subset (model/permissionProfile/plugins/
          // mcpToolAllowlist) to the full RoleSpec — the deliberate point of unification (one
          // role concept spawns the same way everywhere, operator requirement §0). sp.role
          // absent ⇒ spec passes through completely untouched, byte-identical to today.
          let mergedSpec: unknown = sp.spec;
          let sessionRoleOverrides: Record<string, unknown> | undefined;
          if (sp.role) {
            const rawSpec = (typeof sp.spec === "object" && sp.spec !== null) ? sp.spec as Record<string, unknown> : {};
            // UnknownRoleError -> surfaces as a normal RPC error. resolveRole folds the
            // skills-nudge sentence onto instructions itself (see its own comment). `name`/
            // `skills`/`poolSize` are RoleSpec-only fields (not part of AgentSpecSchema.strict())
            // and must not ride into the spawn — mirrors scheduler.ts's identical strip (every
            // resolveTeamRole call site there strips poolSize; this ad-hoc session-role path
            // had missed it, so a role with poolSize set would fail AgentSpecSchema's strict parse).
            const { name: _name, skills: _skills, poolSize: _poolSize, ...resolved } = resolveRole(this.roles, { role: sp.role, overrides: {} }, rawSpec);
            mergedSpec = resolved;
            sessionRoleOverrides = rawSpec; // §3.3: the sparse overrides actually resolved at spawn — a frozen audit record
          }
          return await this.supervisor.spawn(mergedSpec, {
            depth: sp.depth ?? 0, maxDepthCap: sp.maxDepthCap, treeId: sp.treeId, membership: sp.membership,
            parentId: sp.parentId, projectId: sp.projectId,
            // ROLES-TAB S1: stamp the resolved session-role name onto the record/event so the
            // Roles tab's usage join can count live agents per session role. sp.role absent ⇒
            // sessionRole: undefined ⇒ supervisor.spawn's own `!== undefined` guard skips the
            // field entirely — byte-identical to before this existed.
            sessionRole: sp.role,
            // ROLES-UNIFY §3.3: mirrors sessionRole's own stamping discipline exactly —
            // undefined (not just null) when sp.role is absent.
            sessionRoleOverrides,
          });
        }
        // BOOT-LATENCY-AGENT-LIST: `lite` is what the UI stores (app + tui) ask for. It is the
        // SAME full record set — not agent.listSummary's 9-field projection — minus the four
        // fields that are pure bulk text no list view has ever read: spec.instructions,
        // spec.prompt, resultText and lastTurnBillableUsage. On a real fleet (980 records) that
        // is 5.36MB -> ~1.4MB, and the daemon spends ~0.5s of blocked event loop per call
        // serializing+writing the difference, right at the moment a reconnecting UI is trying
        // to paint. Opt-in, so an orchestrator asking for the genuinely full record (the MCP
        // agent_list {full:true} path) is unaffected, and an older client that sends no param
        // keeps today's response byte for byte.
        case "agent.list": {
          const records = this.listAgentRecords();
          return (params as { lite?: boolean })?.lite === true ? records.map((r) => stripListBulkText(r)) : records;
        }
        // F41 / TOOL-SURFACE-MEASURE: pre-spawn token-cost visibility for the chimera MCP grant a
        // spawn would get. Not in RPC_CONTRACT (agent.* isn't) — a local strict schema is enough
        // for one RPC. Deliberately NEVER touches this.mcpStoreConnections (ensure()/tools): a
        // pre-spawn estimate must have zero side effects, so store-direct servers are named from
        // this.mcpStore.list() (pure/sync) but never connected to.
        case "agent.estimateToolSurface": {
          const AgentEstimateToolSurfaceParams = z.object({
            orchestration: z.boolean().default(true),
            autonomy: z.enum(["ask", "full"]).default("ask"),
            conductor: z.boolean().default(false),
            toolTags: z.array(z.string()).optional(),
            settingSources: z.array(z.enum(["user", "project", "local"])).default([]),
            pluginCount: z.number().int().min(0).default(0),
            mcpServers: z.array(z.string()).default([]),
            // F41.QA-FIX (F1): cwd/role let the estimate resolve settingSources/pluginCount/
            // mcpServers SERVER-SIDE instead of trusting a client-guessed value — "auto"
            // settings (spec.loadSettings undefined) resolves against a project's own
            // loadProjectSettings toggle, which only the daemon can see. When either is given
            // they REPLACE the raw settingSources/pluginCount/mcpServers above; those three
            // stay as the direct-value path for callers with no cwd/role context (e.g. the
            // spawn_tool_surface MCP tool used by an agent previewing an ad-hoc spec).
            cwd: z.string().optional(),
            role: z.string().optional(),
          }).strict();
          const p = AgentEstimateToolSurfaceParams.parse(params ?? {});
          const grant = { orchestration: p.orchestration, autonomy: p.autonomy, conductor: p.conductor, toolTags: p.toolTags ?? [] };
          const chimera = p.orchestration
            ? estimateChimeraMcpToolSurface({ autonomy: p.autonomy, conductor: p.conductor, toolTags: p.toolTags })
            : null;
          let effSettingSources: readonly ("user" | "project" | "local")[] = p.settingSources;
          let effPluginCount = p.pluginCount;
          let effMcpServers: readonly string[] = p.mcpServers;
          if (p.cwd !== undefined || p.role !== undefined) {
            // Unknown role name -> treat as no role rather than failing an informational
            // preview row (mirrors SpawnCard's own "never an error state on an informational
            // row" contract for this RPC).
            const roleSpec = p.role ? (() => { try { return resolveRole(this.roles, { role: p.role as string, overrides: {} }); } catch { return undefined; } })() : undefined;
            effPluginCount = roleSpec?.plugins.length ?? 0;
            effMcpServers = roleSpec ? Object.keys(roleSpec.mcpServers) : [];
            effSettingSources = roleSpec?.inherit.settingSources ?? [];
            // Mirrors supervisor.spawn's SPAWN-SETTING-SOURCES undefined-loadSettings branch
            // (:1254-1260) exactly: empty settingSources so far AND cwd resolves to a
            // registered project that already opted into loadProjectSettings.
            if (effSettingSources.length === 0 && p.cwd) {
              const projectId = this.projects.list().find((pr) => isPathUnder(p.cwd as string, pr.path))?.name ?? null;
              const projectLoadSettings = projectId !== null && (this.projects.list().find((pr) => pr.name === projectId)?.loadProjectSettings ?? false);
              if (projectLoadSettings) effSettingSources = ["project", "user"];
            }
          }
          const unpriced: Array<{ source: string; kind: "settings" | "plugins" | "spec-mcp" | "store-direct"; count: number; reason: string }> = [];
          const subprocessReason = "skills, CLAUDE.md and every installed plugin's MCP tools are resolved inside the provider CLI subprocess — chimera's process never sees that catalog";
          if (effSettingSources.length > 0) {
            unpriced.push({ source: `settingSources:${effSettingSources.join(",")}`, kind: "settings", count: effSettingSources.length, reason: subprocessReason });
          }
          if (effPluginCount > 0) {
            unpriced.push({ source: "plugins", kind: "plugins", count: effPluginCount, reason: subprocessReason });
          }
          for (const name of effMcpServers) {
            unpriced.push({ source: `spec.mcpServers:${name}`, kind: "spec-mcp", count: 1, reason: "a raw MCP server config chimera forwards but never connects to" });
          }
          const directStores = this.mcpStore.list().filter((s) => s.direct === true && s.enabled !== false);
          for (const s of directStores) {
            unpriced.push({ source: `mcp-store:${s.name}`, kind: "store-direct", count: 1, reason: "registered as a direct MCP-store server; its tools are synthesised inside the chimera MCP subprocess (mcp-server-factory.ts:57) — pricing them here would require opening a connection" });
          }
          const requestedSources = [...effSettingSources].sort();
          const matches = this.supervisor.list().filter((a) => {
            if (a.toolSurfaceCacheWriteTokens === undefined) return false;
            const recSources = [...(a.spec.inherit?.settingSources ?? [])].sort();
            if (recSources.length !== requestedSources.length || recSources.some((s, i) => s !== requestedSources[i])) return false;
            return (a.spec.conductor === true) === p.conductor;
          });
          let measured: { medianCacheWriteTokens: number; minTokens: number; maxTokens: number; n: number; servers: string[] } | null = null;
          if (matches.length >= 3) {
            const tokens = matches.map((a) => a.toolSurfaceCacheWriteTokens as number).sort((a, b) => a - b);
            const mid = Math.floor(tokens.length / 2);
            const medianCacheWriteTokens = tokens.length % 2 === 0 ? (tokens[mid - 1] + tokens[mid]) / 2 : tokens[mid];
            const servers = new Set<string>();
            for (const a of matches) for (const s of a.toolSurfaceServers ?? []) servers.add(s);
            measured = {
              medianCacheWriteTokens,
              minTokens: tokens[0],
              maxTokens: tokens[tokens.length - 1],
              n: tokens.length,
              servers: [...servers].sort(),
            };
          }
          return { grant, chimera, unpriced, measured, note: TOOL_SURFACE_NOTE };
        }
        // TOKEN-OPT-P1: the DEFAULT an orchestrator should poll instead of agent.list — same
        // merged record set, projected down to {id, name, role, status, model, depth, parentId,
        // costUsd, gitBranch}. Drops spec (incl. any base64 image content), resultText, and
        // every other full-record field. The full record per agent is still reachable via
        // agent.status(agentId).
        case "agent.listSummary":
          return this.listAgentRecords().map((r) => this.toAgentSummary(r));
        // AGENT-LOOKUP-BY-NAME: the actual lookup operation — case-insensitive substring
        // match against displayLabel (primary), id, and accountName (fallback), filtered to
        // live (non-terminal) agents by default. Never guesses: 0 or >1 matches both return
        // the full candidate set plus a `hint` explaining why, so a caller that can't resolve
        // a name is told so explicitly instead of silently spawning a duplicate.
        // SECRET-MANAGER: the operator surface. Deliberately absent from MCP — an agent that could
        // grant itself a secret is not an allowlist, it is a formality. Every one of these is
        // reachable only from the UI/CLI/RPC.
        case "secret.set": {
          const p = SecretSetParams.parse(params);
          const rec = await this.secrets.set(p.name, p.value, p.description);
          this.auditLedger.append({
            agentId: "operator", action: "secret_written", resource: p.name, decision: "recorded",
            reason: `secret "${p.name}" stored in the keychain`,
          });
          return rec;   // never carries the value — see SecretStore.summarize
        }
        case "secret.list":
          return { secrets: this.secrets.list() };
        case "secret.delete": {
          const p = SecretNameParams.parse(params);
          const deleted = await this.secrets.delete(p.name);
          if (deleted) {
            this.auditLedger.append({
              agentId: "operator", action: "secret_written", resource: p.name, decision: "recorded",
              reason: `secret "${p.name}" deleted from the keychain`,
            });
          }
          return { deleted };
        }
        case "secret.grant": {
          const p = SecretGrantParams.parse(params);
          // GRANT-BY-NAME: the operator thinks in agent names, not uuids — and the UI's picker
          // lists live agents by name. Resolved the same way agent_find resolves one: an exact id
          // wins, else a unique name match, and AMBIGUITY REFUSES rather than guessing. Guessing
          // which agent gets a secret is the one place a convenience must never take a chance.
          const { agentId, label } = this.resolveGrantee(p.agent);
          const rec = this.secrets.grant(p.name, agentId, p.mode, label);
          this.auditLedger.append({
            agentId, action: "secret_granted", resource: p.name, decision: "allow",
            reason: `agent ${label ?? agentId} granted "${p.mode}" access to secret "${p.name}"`,
            detail: { mode: p.mode },
          });
          // An inject grant lands in the process ENVIRONMENT, which is fixed at launch — say so
          // rather than letting the operator believe a running agent already has it.
          const live = this.supervisor.list().find((a) => a.agentId === agentId);
          const appliesAtNextStart = p.mode === "inject" && live?.state === "running";
          return { secret: rec, agentId, ...(appliesAtNextStart ? { appliesAtNextStart: true, envVar: secretEnvVar(p.name) } : {}) };
        }
        case "secret.revoke": {
          const p = SecretRevokeParams.parse(params);
          const { agentId } = this.resolveGrantee(p.agent);
          const rec = this.secrets.revoke(p.name, agentId);
          this.auditLedger.append({
            agentId, action: "secret_granted", resource: p.name, decision: "deny",
            reason: `access to secret "${p.name}" revoked for agent ${agentId}`,
          });
          return { secret: rec, agentId };
        }
        // The AGENT surface: what this caller may see, and one value it was granted. Both key
        // strictly on the CALLER's own agentId — never a parameter, so an agent can never ask on
        // another agent's behalf.
        case "secret.listForAgent": {
          const p = SecretForAgentParams.parse(params);
          return { secrets: this.secrets.listFor(p.agentId) };
        }
        case "secret.read": {
          const p = SecretReadParams.parse(params);
          try {
            const value = await this.secrets.read(p.name, p.agentId);
            // Registered for redaction the moment it is handed out: from here the value can appear
            // in the agent's own output, and every event this daemon writes is scrubbed against
            // this list. It does not stop the agent propagating it — nothing can — but it keeps
            // chimera's own logs from becoming a second copy.
            this.supervisor.registerSecret(value);
            this.auditLedger.append({
              agentId: p.agentId, action: "secret_read", resource: p.name, decision: "allow",
              reason: `agent read secret "${p.name}"`,
            });
            return { name: p.name, value };
          } catch (err) {
            this.auditLedger.append({
              agentId: p.agentId, action: "secret_read", resource: p.name, decision: "deny",
              reason: `agent was refused secret "${p.name}"`,
            });
            throw err;
          }
        }
        case "agent.find": {
          const p = AgentFindParamsSchema.parse(params);
          const q = p.q.trim().toLowerCase();
          const live = p.live ?? true;
          const limit = p.limit ?? 20;
          const records = this.listAgentRecords();
          const matched = records.filter((r) => {
            const rec = r as Record<string, unknown>;
            const label = String(rec["displayLabel"] ?? "").toLowerCase();
            const account = String(rec["accountName"] ?? "").toLowerCase();
            const id = String(rec["agentId"] ?? "").toLowerCase();
            if (!label.includes(q) && !account.includes(q) && !id.includes(q)) return false;
            if (live && TERMINAL_AGENT_STATES.has(String(rec["state"] ?? ""))) return false;
            return true;
          });
          const totalMatched = matched.length;
          const truncated = totalMatched > limit;
          const matches = matched.slice(0, limit).map((r) => this.toAgentSummary(r));
          const hint =
            totalMatched === 0
              ? `No ${live ? "live " : ""}agent matches "${p.q}". Do not spawn a substitute without asking — widen with live:false to include terminal agents, or confirm with the operator.`
              : totalMatched > 1
                ? `${totalMatched} agents match "${p.q}" — ambiguous, refusing to guess. Disambiguate by id (see matches[].id) before messaging or handing off work.`
                : null;
          return { query: p.q, live, matches, totalMatched, truncated, hint };
        }
        case "agent.status": {
          const agentId = Id.parse(params).agentId;
          // WD Stage 1 (coverage B12): refresh the record's gitBranch on every status
          // poll — fire-and-forget (a silent no-op for ghosts; status() below still
          // throws for them), so THIS response returns the last-known value and the
          // NEXT one sees the refreshed branch. Never blocks the status call on git.
          this.supervisor.stampGitBranch(agentId);
          return this.supervisor.status(agentId);
        }
        case "agent.result": return this.supervisor.result(Id.parse(params).agentId);
        case "agent.wait": {
          const p = WaitParams.parse(params);
          return await this.supervisor.waitFor(p.agentId, p.timeoutMs);
        }
        case "agent.send": {
          const p = SendParams.parse(params);
          // F09/J5: the RPC is the ONE caller that waits, because it is the one whose answer a
          // human or an agent reads and acts on. promptAck.ackWaitMs is a bounded wait, never a
          // guarantee: "pending" is a legitimate, honest answer, not a failure. Read fresh per
          // call (mirrors leanAgentContext/advisorModel's live-config convention), unlike
          // promptStallMs above which is boot-time-only.
          return await this.supervisor.send(p.agentId, p.text, p.from, p.images, p.slash, p.content, { awaitAckMs: this.cfg.promptAck.ackWaitMs, force: p.force });
        }
        case "agent.kill": {
          const agentId = Id.parse(params).agentId;
          // KILL-REPORTS-TRUTHFULLY: `killed` says whether there was actually something to kill.
          // A terminal agent answers {ok:true, killed:false} plus its state, so a caller can tell
          // "done, it is gone" apart from "nothing happened, it was already finished" — which the
          // bare {ok:true} could not, and which made an unremovable finished row look like a bug
          // in kill rather than the wrong tool for the job (that is `clean up finished`).
          const killed = await this.supervisor.kill(agentId);
          await this.scheduler.tick();   // sweep settles a killed agent's queue task (Task 6/7)
          return { ok: true, killed, state: this.supervisor.status(agentId).state };
        }
        // PARITY WS-H: esc-to-interrupt. Mirrors agent.kill's shape (parse id → supervisor →
        // {ok:true}) but is NON-destructive — it aborts only the in-flight turn, leaving the
        // agent running, so (unlike kill) there is no scheduler.tick() sweep and no queue-task
        // settlement: the agent's own turn_complete{interrupted} event flows through the stream.
        case "agent.interrupt": {
          await this.supervisor.interrupt(Id.parse(params).agentId);
          return { ok: true };
        }
        // OPERATOR-HOLD: stop agents without losing them, and let them go again. Bulk-first
        // because the operator's unit of work here is a set — "hold everything touching this
        // repo while I look" — and doing that one RPC at a time would hold the first agent
        // several turns before the last. Both report per-id outcomes: `held`/`released` names
        // what actually TRANSITIONED, which is not the same as what was asked for (an
        // already-held agent is a no-op, not a failure).
        case "agent.hold": {
          const ids = [...new Set(AgentBulkParamsSchema.parse(params).agentIds)];
          const held: string[] = [];
          const skipped: Array<{ agentId: string; state: string }> = [];
          for (const agentId of ids) {
            try {
              if (await this.supervisor.hold(agentId)) held.push(agentId);
              else skipped.push({ agentId, state: this.supervisor.status(agentId).state });
            } catch (e) {
              skipped.push({ agentId, state: `error: ${String((e as Error).message)}` });
            }
          }
          return { held, skipped };
        }
        case "agent.release": {
          const p = AgentReleaseParamsSchema.parse(params);
          const ids = [...new Set(p.agentIds)];
          const released: string[] = [];
          const skipped: Array<{ agentId: string; state: string }> = [];
          for (const agentId of ids) {
            try {
              if (await this.supervisor.release(agentId, { force: p.force })) released.push(agentId);
              else skipped.push({ agentId, state: this.supervisor.status(agentId).state });
            } catch (e) {
              skipped.push({ agentId, state: `error: ${String((e as Error).message)}` });
            }
          }
          if (released.length > 0) await this.scheduler.tick();   // a released worker may own a queue task again
          return { released, skipped };
        }
        case "agent.interruptMany": {
          const ids = [...new Set(AgentBulkParamsSchema.parse(params).agentIds)];
          const succeeded: string[] = [];
          const failed: Array<{ agentId: string; error: string }> = [];
          for (const agentId of ids) {
            try { await this.supervisor.interrupt(agentId); succeeded.push(agentId); }
            catch (err) { failed.push({ agentId, error: err instanceof Error ? err.message : String(err) }); }
          }
          return { requested: ids.length, succeeded, failed };
        }
        case "agent.rename": {
          const { agentId, displayLabel, self } = AgentRenameParamsSchema.parse(params);
          await this.supervisor.renameAgent(agentId, displayLabel, { byOperator: !self });
          return { ok: true };
        }
        // F47 (fleet seen-state): operator-only, like purgeTerminal/killMany — no MCP
        // tool. An agent that could mark itself seen would erase the very signal the operator
        // triages by.
        case "agent.markSeen": {
          const { agentIds, skipUnknown } = AgentMarkSeenParamsSchema.parse(params);
          // F47.FIX M-2: `count` is now what was actually STAMPED (it used to echo the request
          // size, which under skipUnknown would over-report), and unknownIds names what a sweep
          // skipped so a caller can say so instead of guessing.
          const { marked, unknownIds } = this.supervisor.markSeen(agentIds, { skipUnknown: skipUnknown === true });
          return { ok: true, count: marked, unknownIds };
        }
        // Ad-hoc sessions design §6 "close all sessions" — mirrors agent.kill's own post-kill
        // sweep (scheduler.tick() at :1501) and agent.interruptMany's partial-result shape.
        // PURGE-TERMINAL-SESSIONS: the operator's "I am done with these" broom. agent.killMany
        // ENDS live sessions; this FORGETS finished ones — the record leaves the roster and its
        // on-disk companions go with it. Operator-only (not on the MCP surface, same posture as
        // killMany): an agent deciding to erase its siblings' history is not a thing.
        //
        // What it cannot reclaim, honestly: the event log. Transcripts live in append-only,
        // rotating segments shared by every agent, so a per-agent deletion would mean rewriting
        // sealed segments. Those age out on their own via retention (eventRetention.maxSegments).
        case "agent.purgeTerminal": {
          const purged = this.supervisor.purgeTerminal();
          for (const agentId of purged) {
            this.agentArchive.remove(agentId);
            this.mailboxes.remove(agentId);
          }
          if (purged.length > 0) {
            this.events.append({
              agentId: "supervisor", kind: "status",
              data: { state: "purged_terminal_sessions", count: purged.length },
            });
          }
          return { purged: purged.length };
        }
        // DISMISS-A-FINISHED-AGENT: the single-record counterpart of agent.purgeTerminal.
        // Deliberately a SEPARATE method rather than an optional `agentIds` filter on that one:
        // a daemon predating the filter would silently ignore an unknown field and purge the
        // WHOLE terminal roster, so a harmless version skew here would have cost the operator
        // every finished transcript there. An unknown method fails loudly instead.
        // Terminal-only is enforced by supervisor.purgeTerminal, not re-decided here.
        case "agent.forget": {
          const ids = [...new Set(AgentBulkParamsSchema.parse(params).agentIds)];
          const purged = this.supervisor.purgeTerminal(ids);
          for (const agentId of purged) {
            this.agentArchive.remove(agentId);
            this.mailboxes.remove(agentId);
          }
          // AGENT-FORGET: the event history goes too. "Forget" that left a full event trail behind
          // was only forgetting the agent RECORD — the run itself stayed in the Events list, and in
          // chronicle_search, indefinitely.
          //
          // Scoped deliberately: MEMORY is untouched. A memory record is knowledge somebody chose
          // to write down and addressed to the fleet; the event log is the byproduct of a run.
          // Deleting the first because the second was cleaned up would lose the durable half.
          const forgotten = this.events.forgetAgent(purged);
          const forgottenDocs = this.chronicle?.forgetAgent(purged) ?? 0;
          // TERMINAL-READBACK: the agent is gone, so what its terminals printed goes with it.
          this.terminals.forgetAgent(purged);
          if (purged.length > 0) {
            this.events.append({
              agentId: "eventlog", kind: "status",
              data: { forgotten: purged.length, eventsRemoved: forgotten.removed, chronicleDocsRemoved: forgottenDocs },
            });
          }
          return {
            purged: purged.length, agentIds: purged,
            eventsRemoved: forgotten.removed, chronicleDocsRemoved: forgottenDocs,
          };
        }
        case "agent.killMany": {
          const ids = [...new Set(AgentBulkParamsSchema.parse(params).agentIds)];
          const succeeded: string[] = [];
          const failed: Array<{ agentId: string; error: string }> = [];
          for (const agentId of ids) {
            try { await this.supervisor.kill(agentId); succeeded.push(agentId); }
            catch (err) { failed.push({ agentId, error: err instanceof Error ? err.message : String(err) }); }
          }
          await this.scheduler.tick();
          return { requested: ids.length, succeeded, failed };
        }
        // AGENT-BULK-SEND: the same text to several agents at once. Fans out over the SAME
        // supervisor.send single agent.send uses, so per-agent semantics (busy-hold outbox,
        // permission state, delivery) are identical — this is a loop, not a second delivery path.
        case "agent.sendMany": {
          const p = AgentBulkSendParamsSchema.parse(params);
          const ids = [...new Set(p.agentIds)];
          const succeeded: string[] = [];
          const failed: Array<{ agentId: string; error: string }> = [];
          for (const agentId of ids) {
            try { await this.supervisor.send(agentId, p.text, p.from); succeeded.push(agentId); }
            catch (err) { failed.push({ agentId, error: err instanceof Error ? err.message : String(err) }); }
          }
          return { requested: ids.length, succeeded, failed };
        }
        // AGENT-BULK-RESUME: pick several finished agents back up, each in its OWN worktree and
        // session. Partial success is the norm here — one may be running, another's workdir gone —
        // and the daemon's per-agent refusal is what says which.
        case "agent.resumeMany": {
          const p = AgentBulkResumeParamsSchema.parse(params);
          const ids = [...new Set(p.agentIds)];
          const succeeded: string[] = [];
          const failed: Array<{ agentId: string; error: string }> = [];
          for (const agentId of ids) {
            try {
              await this.supervisor.resume(agentId, {
                prompt: p.prompt,
                ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns } : {}),
                ...(p.turnLimitPolicy !== undefined ? { turnLimitPolicy: p.turnLimitPolicy } : {}),
              });
              succeeded.push(agentId);
            } catch (err) { failed.push({ agentId, error: err instanceof Error ? err.message : String(err) }); }
          }
          return { requested: ids.length, succeeded, failed };
        }
        case "agent.close": {
          await this.supervisor.closeInput(Id.parse(params).agentId);
          return { ok: true };
        }
        case "agent.tail": {
          const p = TailParams.parse(params);
          // SEGMENT-SCAN: the sealed-segment read happens on a worker, so a tail over rotated
          // history no longer freezes every other request while it walks the log.
          return (await this.events.tailAsync(p.agentId ?? null, p.n)).map(capEventForTail);
        }
        // WD Stage 1 (coverage B7, replay bar): seq-ordered range read of the persisted
        // event log (events/events.jsonl — the writer EventLog.append already exists).
        // See ReplayParams for the window semantics and the local-only agentId note.
        case "events.replay": {
          const p = ReplayParams.parse(params ?? {});
          // SEGMENT-SCAN: the transcript's own fetch. This is the call measured at 2.8-13s of a
          // fully blocked daemon for a single click; the segment read is now off-thread.
          return await this.events.replayAsync({ fromSeq: p.fromSeq, toSeq: p.toSeq, agentId: p.agentId ?? null, limit: p.limit });
        }
        case "agent.permissionRespond": {
          const p = RespondParams.parse(params);
          return { handled: this.supervisor.respondPermission(p.requestId, p.allow) };
        }
        case "agent.setPermission": {
          const p = SetPermissionParams.parse(params);
          const { appliedToRunningProcess } = this.supervisor.setPermission(p.agentId, {
            permissionRequest: p.permissionRequest,
            permissionProfile: p.permissionProfile,
          });
          // CODEX-SETPERMISSION-IS-COSMETIC-TO-THE-OPERATOR: tell the CALLER (not just the
          // agent's mailbox) whether this actually re-sandboxed the running process, so an
          // operator lowering a running codex agent's profile to contain it isn't told "ok"
          // and left believing containment happened when it didn't (supervisor.ts comment).
          return { ok: true, appliedToRunningProcess };
        }
        case "agent.setModel": {
          const p = SetModelParams.parse(params);
          return await this.supervisor.setModel(p.agentId, p.model);
        }
        case "agent.setEffort": {
          const p = SetEffortParams.parse(params);
          return await this.supervisor.setEffort(p.agentId, p.effort);
        }
        // SOFT-TURN-LIMIT (live): raise/unbound a running agent's turn budget. Thin
        // parse+dispatch — the no-op short-circuit and the respawn live in supervisor.
        // AGENT-RECONFIGURE: one save, at most one respawn. The live fields are applied FIRST and
        // separately — they need no respawn, and doing them first means a save that touches only
        // those never kills a running turn at all. The spec patch then respawns once for however
        // many settings it changed, instead of once per setting.
        case "agent.reconfigure": {
          const p = AgentReconfigureParamsSchema.parse(params);
          const applied: string[] = [];
          if (p.live.displayLabel !== undefined) {
            await this.supervisor.renameAgent(p.agentId, p.live.displayLabel, { byOperator: true });
            applied.push("name");
          }
          if (p.live.groups !== undefined) {
            await this.supervisor.setAgentGroups(p.agentId, p.live.groups);
            applied.push("groups");
          }
          if (p.live.permissionProfile !== undefined || p.live.permissionRequest !== undefined) {
            await this.supervisor.setPermission(p.agentId, {
              ...(p.live.permissionProfile !== undefined ? { permissionProfile: p.live.permissionProfile } : {}),
              ...(p.live.permissionRequest !== undefined ? { permissionRequest: p.live.permissionRequest } : {}),
            });
            applied.push("permission");
          }
          // cwd LAST among the no-respawn group and before the patch: rebind respawns too, so
          // doing both would cost two — the patch is folded into the rebind's own spec instead.
          let respawned = false;
          if (p.cwd !== undefined && p.cwd !== this.supervisor.status(p.agentId).spec.cwd) {
            await this.supervisor.rebind(p.agentId, { cwd: p.cwd });
            respawned = true;
            applied.push("cwd");
          }
          if (Object.keys(p.patch).length > 0) {
            const before = this.supervisor.status(p.agentId).spec;
            const rec = await this.supervisor.reconfigure(p.agentId, p.patch);
            if (rec.spec !== before) { respawned = true; applied.push(...Object.keys(p.patch)); }
          }
          return { ok: true, applied: [...new Set(applied)], respawned, state: this.supervisor.status(p.agentId).state };
        }
        case "agent.setTurnLimit": {
          const p = SetTurnLimitParams.parse(params);
          return await this.supervisor.setTurnLimit(p.agentId, {
            ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns } : {}),
            ...(p.turnLimitPolicy !== undefined ? { turnLimitPolicy: p.turnLimitPolicy } : {}),
          });
        }
        case "agent.setAccount": {
          const p = SetAccountParams.parse(params);
          return await this.supervisor.setAccount(p.agentId, p.account, p.model, p.acknowledgeCodexFullAccessRisk);
        }
        // CROSS-PROVIDER-HANDOFF: setAccount's cross-provider counterpart — see
        // supervisor.handoff's doc comment for why this can't reuse the kill+resume dance.
        case "agent.handoff": {
          const p = AgentHandoffParams.parse(params);
          return await this.supervisor.handoff(p.agentId, { toAccount: p.toAccount, model: p.model, note: p.note });
        }
        // REBIND: the cwd counterpart of agent.handoff — see supervisor.rebind's own comment
        // for why it carries no isolation:"worktree" guard (unlike handoff).
        case "agent.rebind": {
          const p = AgentRebindParams.parse(params);
          return await this.supervisor.rebind(p.agentId, { cwd: p.cwd, isolation: p.isolation, note: p.note });
        }
        // AGENT-RESUME-TOOLS: recover a TERMINAL agent in its existing worktree + session with a
        // fresh brief. All the record lookup / effective-cwd derivation / running+missing-workdir
        // refusals live in supervisor.resume — this is a thin parse+dispatch, same as setEffort.
        case "agent.resume": {
          const p = ResumeParams.parse(params);
          return await this.supervisor.resume(p.agentId, {
            prompt: p.prompt,
            ...(p.maxTurns !== undefined ? { maxTurns: p.maxTurns } : {}),
            ...(p.turnLimitPolicy !== undefined ? { turnLimitPolicy: p.turnLimitPolicy } : {}),
            ...(p.deliverTo !== undefined ? { deliverTo: p.deliverTo } : {}),
          });
        }
        case "agent.remoteControl": {
          const p = RemoteControlParams.parse(params);
          return await this.supervisor.remoteControl(p.agentId, p.enable, p.name);
        }
        // COMPACTION-OBSERVABILITY: manual context-compaction trigger. supervisor.compact
        // throws CompactionUnsupportedError (surfaced to the caller as a normal RPC error) for
        // a provider whose SDK owns compaction — see that method's own comment.
        case "agent.compact": {
          const p = CompactParams.parse(params);
          return await this.supervisor.compact(p.agentId);
        }
        case "agent.ask": {
          const { agentId, ...q } = AskParams.parse(params);
          return await this.supervisor.ask(agentId, q);
        }
        case "agent.askTeam": {
          const { agentId, team, role, ...q } = AskTeamParams.parse(params);
          this.teams.get(team);   // throws UnknownTeamError for an unknown team
          const members = this.scheduler.membersOf(team, role).filter((m) => m.agentId !== agentId);
          const answers = await Promise.all(members.map((m) =>
            this.supervisor.ask(agentId, { ...q, to: { agentId: m.agentId } })
              .then((r) => ({ agentId: m.agentId, questionId: r.questionId, answer: r.answer }))));
          return { answers };
        }
        case "agent.answerQuestion": {
          const p = AnswerParams.parse(params);
          return { handled: this.supervisor.answerQuestion(p.questionId, p.answer) };
        }
        case "agent.answerDialog": {
          const p = AnswerDialogParams.parse(params);
          return { handled: this.supervisor.answerDialog(p.dialogId, p.decision) };
        }
        // Shared memory (spec §MEMORY): local-only, never in PEER_METHODS. Each case
        // parses its param schema then delegates to the MemoryStore subsystem.
        case "memory.add": {
          const p = MemoryAddParams.parse(params);
          // F34: the stamp. MemoryAddParams is .strict() and has no `scope` key, so this is the
          // ONLY place a scope can come from — a caller can neither supply one nor omit one.
          return this.memory.add({ ...p, scope: this.projectScopeFor(p.author) });
        }
        // D11: "memory.update" is the canonical name (mirrors team.update/queue.update);
        // "memory.edit" stays wired identically for the already-shipped memory_edit MCP
        // tool. `p.author`, when given, re-stamps the record's author to the caller.
        case "memory.edit":
        case "memory.update": {
          const p = MemoryEditParams.parse(params);
          return this.memory.edit(p.id, p, p.author);
        }
        case "memory.delete": return { deleted: this.memory.delete(MemoryDeleteParams.parse(params).id) };
        // MEM-4: mode-aware hybrid/semantic search. Degrades to the exact prior lexical result when
        // there's no query, mode is lexical, or no embedder is live — so defaults change nothing
        // observable until an index exists. Only the query embed is awaited (never blocks on backfill).
        case "memory.search": {
          // F34: `agentId` and `scope` are caller-IDENTITY inputs, not filters — destructured off
          // so neither ever reaches MemorySearchFilters as a narrowing key by accident.
          const { agentId, scope: askedScope, ...rest } = MemorySearchParams.parse(params);
          // An explicit scope wins (including "*", which normalizeScope folds to "no narrowing");
          // otherwise default to the caller's own project. Neither ⇒ unnarrowed, i.e. pre-F34.
          const scope = askedScope ?? this.projectScopeFor(agentId) ?? undefined;
          const hits = await this.memory.searchHybrid({ ...rest, ...(scope !== undefined ? { scope } : {}) });
          // F34.FIX (qa/F34.md §F34-3): a project-default-narrowed empty result used to be
          // silently re-run unnarrowed here (F34.QA-B) — that leaked other-project records
          // through what memory.search's own docs promise is a partition, and this RPC's
          // declared success type (bare ScoredRecord[], consumed by app/tui/client beyond the
          // MCP tool) must stay exactly that: no widening, no wrapper object. The empty-result
          // widening SIGNAL now lives one layer up, in the memory_search MCP tool's postDispatch
          // (mcp-tools.ts) — it probes and reports, it never substitutes hits the caller didn't
          // ask for.
          return rest.excerpt ? hits.map(excerptHit) : hits;
        }
        // MEM-1 (PLAN-MEMORY.md §3-§4): memory.get returns a record with resolved [[links]] +
        // backlinks (agent-facing via the memory_get MCP tool, MEM-3); memory.stats powers the
        // app folder-rail counts. Both local-only, app/agent surface — not in PEER_METHODS.
        case "memory.get":    return this.memory.get(MemoryGetParams.parse(params).id);
        case "memory.stats": { MemoryStatsParams.parse(params ?? {}); return this.memory.stats(); }
        // MEM-2 (PLAN-MEMORY.md §4): memory.graph returns nodes/edges (incl. ghost nodes) for the
        // app's force-directed view and MCP diagnostics; not in PEER_METHODS.
        case "memory.graph":  return this.memory.graph(MemoryGraphParams.parse(params ?? {}));
        // MEM-4: local vector-index status/rebuild. MCP exposes only status, not rebuild;
        // neither action is in PEER_METHODS. `status` resolves the embedder lazily and reports state; with no
        // embedder configured it reports {state:"off"} and search stays lexical — never errors.
        case "memory.index": {
          const p = MemoryIndexParams.parse(params ?? {});
          return p.action === "rebuild" ? this.memory.rebuildIndex() : this.memory.indexStatus();
        }
        // FEATURE-8: queue.create/list/update/delete/push/status/statusSummary/cancelTask
        // moved off this switch onto the RpcContract dispatch (see the `isContractMethod`
        // branch above, and `contractHandlers` below) — TOKEN-OPT-P1's queue.statusSummary
        // doc comment moved there with it. FEATURE-10's evidence.get joined the same dispatch.
        // FEATURE-11: team.create/list/status/dissolve/update joined the same dispatch, their
        // handler bodies now living in packages/core/src/rpc/team-rpc.ts (TeamRpc).
        case "assign": {
          const p = AssignParams.parse(params);
          return await this.scheduler.assign(p.target, p.prompt, p.priority);
        }
        // PLAN-PROJECT-CONDUCTOR-ROUTING D2/§3 (P2-T2): the preference resolver —
        // queue-first → own-team role-match → global team → direct. Local-only
        // (absent from PEER_METHODS): a peer never routes into our queues/teams.
        case "dispatch":
          return await this.dispatch(DispatchParams.parse(params));
        // ---------- D12: task workflows — workflow.* family (coverage C14) ----------
        // FEATURE-11: create/list/update/delete moved onto the RpcContract dispatch, handler
        // bodies now in packages/core/src/rpc/workflow-rpc.ts (WorkflowRpc).
        // ---------- D13: artifact registry — artifact.* family (coverage C15) ----------
        // FEATURE-11: add/list/get moved onto the RpcContract dispatch, handler bodies now in
        // packages/core/src/rpc/artifact-rpc.ts (ArtifactRpc).
        // ---------- D16: checkpoints — checkpoint.* family (coverage §C18, F20) ----------
        // Local-only by construction (absent from PEER_METHODS): a peer never sees or
        // drives our checkpoints. taskId auto-resolves from the caller's CURRENT binding
        // (scheduler.taskFor), same split as artifact.add above — never trusted from params.
        case "checkpoint.status":
          return await this.checkpoints.status(CheckpointCwdParams.parse(params).cwd);
        case "checkpoint.create": {
          const p = CheckpointCreateParams.parse(params);
          const agentId = p.agentId ?? null;
          const taskId = agentId ? this.scheduler.taskFor(agentId) : null;
          return await this.checkpoints.create({ cwd: p.cwd, trigger: p.trigger, agentId, taskId, message: p.message });
        }
        case "checkpoint.list":
          return await this.checkpoints.list(CheckpointCwdParams.parse(params).cwd);
        case "checkpoint.revert": {
          const p = CheckpointRevertParams.parse(params);
          return await this.checkpoints.revert(p.cwd, p.id);
        }
        // ---------- D14: notifications — notify.test (coverage C16) ----------
        // Rule storage/CRUD is the config.notify overlay (config.get/config.patch, D7
        // pattern) — this is the ONE notify-specific RPC: fire a sample through a named
        // rule's channel immediately, bypassing the throttle window. Local-only by
        // construction (absent from PEER_METHODS): a peer never drives our rules.
        case "notify.test":
          return this.notifier.test(NotifyTestParams.parse(params).rule);
        // ---------- D10: scheduled actions — job.* family (coverage C12) ----------
        // Local-only by construction (absent from PEER_METHODS): a peer never sees or
        // drives our schedules.
        case "job.create": {
          const spec = JobCreateParams.parse(params).spec;
          const created = this.jobs.create(spec);
          // SECURITY (sandbox-escape-rce): a command job is arbitrary shell that will run
          // UNATTENDED with the daemon's own privileges, on a schedule, outside the permission
          // profile of whoever asked for it — a readOnly agent that creates one has, in effect,
          // written itself a durable exemption. Agents are permitted to create these by an
          // explicit operator decision, so the answer is not to refuse them: it is that the
          // capability must never be silent. This lands in the hash-chained, never-pruned audit
          // ledger, naming the command and who asked, so "what scheduled shell exists on this
          // daemon and who put it there" is answerable after the fact.
          if ("command" in created.target) {
            this.auditLedger.append({
              agentId: "operator", action: "job_command_created", resource: created.name,
              decision: "recorded",
              reason: `scheduled shell command created for job "${created.name}" — runs unattended with daemon privileges`,
              detail: { command: created.target.command, cwd: created.target.cwd ?? null, schedule: created.schedule },
            });
          }
          return created;
        }
        case "job.list":
          return this.jobs.list();
        case "job.status": {
          const rec = this.jobs.get(JobNameParams.parse(params).name);
          // JOB-WATCH: a supervised job's nextRunTs is null by design, so without this the status
          // of the one job kind that is SUPPOSED to be running all the time would read as "never".
          const watch = this.jobs.watchStatus(rec.name);
          // F01(a): the MACHINE-level capability, alongside the job-level record and never merged
          // into it. Present on every job.status read, available or not — a caller must be able to
          // tell "this schedule is exact" from "this schedule fires whenever the lid opens"
          // without a second call. Deliberately NOT on job.list: N jobs would carry N copies of
          // one machine fact, and the panel that needs it already reads job.status for its row.
          const wakeScheduling = await this.jobs.wakeStatus();
          return { ...rec, ...(watch ? { watch } : {}), wakeScheduling };
        }
        case "job.update": {
          const p = JobUpdateParams.parse(params);
          return this.jobs.update(p.name, p.patch);
        }
        case "job.delete":
          return { ok: this.jobs.delete(JobNameParams.parse(params).name) };
        case "job.runNow":
          return await this.jobs.runNow(JobNameParams.parse(params).name);
        case "job.requeue": {
          const rec = this.jobs.requeue(JobNameParams.parse(params).name);
          // Mirrors job.create's command-job audit entry above: a requeue re-arms a command job
          // to run unattended again, so the same "what ran and who asked" trail applies.
          if ("command" in rec.target) {
            this.auditLedger.append({
              agentId: "operator", action: "job_command_requeued", resource: rec.name, decision: "recorded",
              reason: `dead-lettered scheduled shell command re-armed for job "${rec.name}"`,
              detail: { command: rec.target.command, cwd: rec.target.cwd ?? null, schedule: rec.schedule },
            });
          }
          return rec;
        }
        // ---------- WD Stage 2: project.* family (coverage B12) ----------
        // Local-only by construction (absent from PEER_METHODS). Referenced teams/
        // queues are validated BEFORE anything persists, mirroring team.create's
        // UnknownQueueError ordering.
        case "project.create": {
          const p = ProjectCreateParams.parse(params);
          for (const t of p.teams ?? []) this.teams.get(t);      // UnknownTeamError before persisting
          if (p.queue !== undefined) this.queues.get(p.queue);   // UnknownQueueError likewise
          // PROJECT-CONDUCTOR-ACCOUNT: ConfigError for a ghost account HERE, up with the other
          // pre-side-effect checks — a pin that only blows up at the next conductor spawn would
          // surface as a conductor that silently never starts (JobScheduler.validateTarget's
          // precedent). The MODEL string is deliberately unvalidated (remote-refreshed catalog).
          if (p.conductorAccount !== undefined) this.assertConductorPinSpawnable(p.conductorAccount);
          let path = p.path;
          if (path === undefined) {
            // PROJECT-DEFAULT-DIR: no cwd given — mint a fresh blank project under
            // the configured IMPORT-DIR base (same resolution project.import's clone
            // uses), git-init'd with a seed commit so checkpoints/worktrees work
            // immediately. Name collision checked BEFORE any fs side effect, mirroring
            // project.import's clone-after-validate ordering.
            if (this.projects.has(p.name)) throw new DuplicateProjectError(`project "${p.name}" already exists`);
            const base = resolveProjectBaseDir(this.cfg.projectImportDir, this.home);
            if (!existsSync(base)) mkdirSync(base, { recursive: true });
            path = join(base, p.name);
            let alreadySeeded = false;
            if (existsSync(path)) {
              const entries = readdirSync(path);
              // PROJECT-DEFAULT-DIR-LEFTOVER: a registration-only project.delete
              // (no deleteFiles) leaves this exact dir behind — gitInitSeed's own
              // output is ".git" and nothing else, so that's the ONLY shape we
              // silently adopt. Anything else (real files, worktree state) still
              // hard-fails rather than risk reusing something a user cared about.
              alreadySeeded = entries.length === 1 && entries[0] === ".git";
              if (entries.length > 0 && !alreadySeeded)
                throw new ProjectPathError(
                  `"${path}" already exists and is not empty — it may be left over from a ` +
                  `previously deleted project of this name; remove it, delete the old project ` +
                  `with deleteFiles:true, or pass an explicit path`,
                );
            } else {
              mkdirSync(path, { recursive: true });
            }
            // PROJECT-CREATE-GITINIT-OPTION: default true (unset ⇒ git-init'd, same
            // as before this option existed); false leaves a plain empty directory.
            // Skip re-seeding an adopted leftover repo — it already has the commit.
            if (p.gitInit !== false && !alreadySeeded) await gitInitSeed(path);
          }
          let spec = this.projects.create({
            name: p.name, path, teams: p.teams, queue: p.queue ?? null,
            ...(p.autoConductor !== undefined ? { autoConductor: p.autoConductor } : {}),
            ...(p.permissionProfile !== undefined ? { permissionProfile: p.permissionProfile } : {}),
            ...(p.conductorAccount !== undefined ? { conductorAccount: p.conductorAccount } : {}),
            ...(p.conductorModel !== undefined ? { conductorModel: p.conductorModel } : {}),
          });
          // PROJECT-EAGER-CONDUCTOR: spawn eagerly right here instead of waiting for
          // the first project.status UI focus — same best-effort discipline (a spawn
          // failure must never fail project.create; nothing persists, so the next
          // focus/dispatch simply retries via ensureProjectConductor's idempotent check).
          if (spec.autoConductor && !spec.archived) {
            try {
              await this.ensureProjectConductor(spec.name);
              spec = this.projects.get(spec.name);
            } catch (e) {
              console.error(`chimerad: ensureProjectConductor failed for project "${spec.name}": ${String((e as Error).message)}`);
            }
          }
          spec = this.syncProjectTeamIfPresent(spec);
          return spec;
        }
        case "project.import": {
          const p = ProjectImportParams.parse(params);
          if (p.team) this.teams.get(p.team);                    // validate BEFORE the clone side effect
          if (p.conductorAccount !== undefined) this.assertConductorPinSpawnable(p.conductorAccount);   // ditto, ghost account
          let spec;
          if (isGitSource(p.source)) {
            // git URL (file:// included) → clone into the configured IMPORT-DIR base
            // (config.projectImportDir), falling back to $CHIMERA_HOME/projects when unset.
            // Name collision is checked BEFORE the clone so a duplicate never leaves
            // a stray checkout behind; a failed clone surfaces git's own stderr as a
            // {code:"git"} rpc error (see projects.ts gitClone).
            const name = p.name ?? deriveProjectName(p.source);
            if (this.projects.has(name)) throw new DuplicateProjectError(`project "${name}" already exists`);
            const base = resolveProjectBaseDir(this.cfg.projectImportDir, this.home);
            if (!existsSync(base)) mkdirSync(base, { recursive: true });
            const dest = join(base, name);
            await gitClone(p.source, dest);
            spec = this.projects.create({
              name, path: dest, origin: p.source,
              ...(p.permissionProfile !== undefined ? { permissionProfile: p.permissionProfile } : {}),
              ...(p.conductorAccount !== undefined ? { conductorAccount: p.conductorAccount } : {}),
              ...(p.conductorModel !== undefined ? { conductorModel: p.conductorModel } : {}),
            });
          } else {
            // local path → register in place (origin stays null; create() validates
            // that the path is an absolute existing directory).
            spec = this.projects.create({
              name: p.name ?? deriveProjectName(p.source), path: p.source, origin: null,
              ...(p.permissionProfile !== undefined ? { permissionProfile: p.permissionProfile } : {}),
              ...(p.conductorAccount !== undefined ? { conductorAccount: p.conductorAccount } : {}),
              ...(p.conductorModel !== undefined ? { conductorModel: p.conductorModel } : {}),
            });
          }
          if (p.team) spec = this.projects.assignTeam(spec.name, p.team);
          // PROJECT-EAGER-CONDUCTOR: same eager spawn as project.create above.
          if (spec.autoConductor && !spec.archived) {
            try {
              await this.ensureProjectConductor(spec.name);
              spec = this.projects.get(spec.name);
            } catch (e) {
              console.error(`chimerad: ensureProjectConductor failed for project "${spec.name}": ${String((e as Error).message)}`);
            }
          }
          spec = this.syncProjectTeamIfPresent(spec);
          return spec;
        }
        case "project.list":
          // spec + the LIVE session count (running/paused agents whose cwd is under
          // the project path — the B12 list row's ◐N column).
          return this.projects.list().map((spec) => ({ ...spec, sessions: this.liveSessionsUnder(spec.path, spec.name).length }));
        case "project.status": {
          const name = ProjectNameParams.parse(params).name;
          let spec = this.projects.get(name);
          // PLAN-PROJECT-CONDUCTOR-ROUTING P1-T2 (D1 lazy-declared): a project.status
          // call IS the "UI focus" trigger. Best-effort — a spawn failure (no claude
          // account, guardrail, ...) must never break a plain status read; nothing
          // persists on failure, so the NEXT focus simply retries.
          if (spec.autoConductor && !spec.archived) {
            try {
              await this.ensureProjectConductor(name);
              spec = this.projects.get(name);
            } catch (e) {
              console.error(`chimerad: ensureProjectConductor failed for project "${name}": ${String((e as Error).message)}`);
            }
          }
          // PROJECT-NATIVE-TEAMS T4: re-sync .claude/agents on every focus (no fs
          // watcher) — best-effort, same discipline as ensureProjectConductor above:
          // a sync failure must never break a plain status read.
          try {
            this.syncProjectTeam(name);
            spec = this.projects.get(name);
          } catch (e) {
            console.error(`chimerad: syncProjectTeam failed for project "${name}": ${String((e as Error).message)}`);
          }
          return {
            spec,
            // ALL real agents under the path, any state — the sessions table renders
            // per-row state itself; the boundary check keeps /a/bc out of /a/b.
            sessions: this.supervisor.list().filter((a) => !a.shadow && isPathUnder(a.spec.cwd, spec.path)),
            // team.status-style live counts per assigned team (B12 detail chips).
            teams: spec.teams.map((n) => ({ name: n, running: this.scheduler.runningFor(n) })),
            conductor: this.projectConductorInfo(spec.conductorId),
          };
        }
        case "project.assignTeam": {
          const p = ProjectAssignParams.parse(params);
          this.teams.get(p.team);                                // UnknownTeamError for a ghost team
          return this.projects.assignTeam(p.project, p.team);
        }
        case "project.setLoadProjectSettings": {
          const p = ProjectSetLoadProjectSettingsParams.parse(params);
          return this.projects.setLoadProjectSettings(p.project, p.value);
        }
        // PROJECT-CONDUCTOR-ACCOUNT: pins the account/model the project's NEXT conductor spawn is
        // born on. Deliberately NOT retroactive — it never moves the live conductor, because the
        // whole point of this field is reaching a DIFFERENT provider and the supervisor correctly
        // refuses a cross-provider setAccount/reconfigure. So the reply reports the live conductor
        // and a `restartRequired` flag: true means "project_conductor_stop then
        // project_conductor_start for this to take effect". Cleared pins (account:null) never set
        // the flag — what "auto" resolves to isn't knowable here without routing a spawn.
        case "project.setConductorAccount": {
          const p = ProjectSetConductorAccountParams.parse(params);
          const prev = this.projects.get(p.project);
          const model = p.model === undefined ? prev.conductorModel : p.model;
          const profile = p.permissionProfile === undefined ? prev.permissionProfile : p.permissionProfile;
          if (p.account !== null) this.assertConductorPinSpawnable(p.account);   // ConfigError for a ghost account
          const spec = this.projects.setConductorAccount(p.project, p.account, model, profile);
          const live = this.liveConductorRecord(spec.conductorId);
          return {
            spec,
            conductor: live ? { agentId: live.agentId, state: live.state, account: live.accountName, model: live.spec.model ?? null } : null,
            restartRequired: !!live && (
              (spec.conductorAccount !== null && live.accountName !== spec.conductorAccount) ||
              (spec.conductorModel !== null && (live.spec.model ?? null) !== spec.conductorModel)
            ),
          };
        }
        case "project.setSetupHook": {
          const p = ProjectSetSetupHookParams.parse(params);
          return this.projects.setSetupHook(p.project, p.hook);
        }
        case "project.archive": {
          const name = ProjectNameParams.parse(params).name;
          const spec = this.projects.get(name);
          // Tear down the project's OWN conductor first — its cwd is the project
          // path itself (isolation:"none"), so it always counts as a "live session
          // under the path" and would otherwise make an auto-conductor'd project
          // permanently unarchivable.
          await this.stopOwnConductors(spec);
          // REFUSE ({code:"conflict"}, coverage B12) while any OTHER live agent works
          // under the path — archive must never yank a directory out from under a
          // running/paused (auto-resuming) session.
          const refusal = this.liveSessionRefusal(spec, "archiving");
          if (refusal) throw new ProjectConflictError(refusal);
          return this.projects.archive(name);
        }
        // PROJECT-DEFAULT-DIR-AND-DELETE: archive was a one-way name-trap (no way
        // to delete or restore) — these two close that gap.
        case "project.unarchive":
          return this.projects.unarchive(ProjectNameParams.parse(params).name);
        case "project.delete": {
          const p = ProjectDeleteParams.parse(params);
          const spec = this.projects.get(p.name);
          // Same ordering as archive: tear down the project's OWN conductor first
          // (its cwd == spec.path would otherwise always count as a live session),
          // THEN refuse if any OTHER live agent still works under the path.
          await this.stopOwnConductors(spec);
          const refusal = this.liveSessionRefusal(spec, "deleting");
          if (refusal) throw new ProjectConflictError(refusal);
          // ORPHANED-TEAMS-ON-DELETE: a project's teams and their bound queues OUTLIVE it, and
          // nothing said so. The observed cost: a deleted project's three teams kept draining
          // their queues, but no project claimed those queues any more — so
          // resolveTaskOriginConductor's project branch could never fire, every task fell back to
          // the pusher chain, and its workers rendered under whatever unrelated conductor that
          // chain happened to reach. The work was correct; only its ownership was unattributable,
          // and from the operator's side it just looked like the tree was wrong.
          //
          // Deliberately REPORTED, not cascaded: a team is a first-class object that may be
          // shared or re-pointed at another project (which is what the operator did here), so
          // deleting it with its project would destroy more than was asked for. Naming it hands
          // back the one fact needed to act — reassign or dissolve.
          const orphanedTeams = spec.teams.map((name) => {
            const queue = this.teams.list().find((t) => t.name === name)?.queue ?? null;
            return queue ? { team: name, queue } : { team: name };
          });
          this.projects.delete(p.name);                        // frees the name for a future create/import
          if (orphanedTeams.length > 0) {
            this.events.append({
              agentId: `project:${p.name}`, kind: "status",
              data: { project: p.name, orphanedTeams },
            });
          }
          const orphaned = orphanedTeams.length > 0 ? { orphanedTeams } : {};
          if (p.deleteFiles) {
            try { rmSync(spec.path, { recursive: true, force: true }); }
            catch (e) { console.error(`chimerad: failed to delete project directory ${spec.path}: ${String((e as Error).message)}`); }
            return { deleted: true, ...orphaned };
          }
          // PROJECT-DEFAULT-DIR-LEFTOVER: flag it when this was an auto-minted
          // dir (path == resolveProjectBaseDir/<name>, the exact shape project.create's
          // no-path branch mints) so a caller knows a future pathless create of the
          // same name will adopt or collide with what's left on disk.
          const base = resolveProjectBaseDir(this.cfg.projectImportDir, this.home);
          if (spec.path === join(base, p.name) && existsSync(spec.path)) return { deleted: true, leftoverPath: spec.path, ...orphaned };
          return { deleted: true, ...orphaned };
        }
        case "project.conductor.start":
          // CONDUCTOR-SPAWN-RUNAWAY: an operator asking by name always tries, and clears the
          // brake — the guard protects against a passive read looping, never against a person.
          return await this.ensureProjectConductor(ProjectNameParams.parse(params).name, { explicit: true });
        case "project.conductor.stop": {
          const name = ProjectNameParams.parse(params).name;
          await this.stopProjectConductor(name, this.projects.get(name).conductorId);
          return this.projects.get(name);
        }
        // FEATURE MAIN-CONDUCTOR-PERSISTENT: the daemon-owned MAIN seat's status/ensure
        // pair — mirrors project.conductor.start's shape ({agentId,state}|null / a full
        // AgentRecord on ensure) but for the one global conductor, no project involved.
        case "main.conductor.status":
          return this.mainConductorInfo();
        case "main.conductor.ensure":
          return await this.ensureMainConductor();
        // ---------- FILEBROWSER-T2: fs.list (app's file-browser panel) ----------
        // Local-only by construction (absent from PEER_METHODS, see protocol's comment
        // on FsListParams). listDir does the realpath-both-sides escape guard, the
        // FS_LIST_MAX_ENTRIES cap, and the git-status annotation pass.
        case "fs.list": {
          const p = FsListParams.parse(params);
          const spec = this.projects.get(p.project);          // UnknownProjectError on a ghost project
          return listDir(spec.path, p.path);
        }
        // FILEBROWSER-T3: fs.read — same realpath-both-sides guard as fs.list, reused
        // via readFile's resolveWithinProject call. See fsbrowse.ts for the size
        // cap/binary-sniff/image-detection logic.
        // PATH-LINK-TILDE-AND-SCOPE: `project` omitted ⇒ `p.path` is an absolute (or
        // "~/"-prefixed) path resolved against the WIDENED root set instead of one
        // project's tree — every registered project's root, plus config.projectImportDir
        // (the one extra root this feature adds; NOT the whole home directory). Still
        // the same realpath-both-sides confinement per candidate root, just tried in
        // turn (see readAtWidenedRoot) — a symlink escape is refused exactly as before.
        case "fs.read": {
          const p = FsReadParams.parse(params);
          if (p.project === undefined) {
            const roots = [
              ...this.projects.list().map((spec) => spec.path),
              ...(this.cfg.projectImportDir ? [this.cfg.projectImportDir] : []),
            ];
            return readAtWidenedRoot(p.path, roots);
          }
          const spec = this.projects.get(p.project);          // UnknownProjectError on a ghost project
          return readFile(spec.path, p.path);
        }
        // PATH-LINK-ONE-ROUNDTRIP: the whole candidate walk, server-side. See FsResolveParams.
        case "fs.resolve": {
          const raw = FsResolveParams.parse(params).path;
          const projects = this.projects.list();
          // ABSOLUTE: only the roots that actually contain it, most specific first, so a nested
          // project wins over its ancestor. RELATIVE: every project is a candidate, in order.
          const candidates = raw.startsWith("/")
            ? projects
                .filter((s) => raw === s.path || raw.startsWith(s.path.endsWith("/") ? s.path : `${s.path}/`))
                .sort((a, b) => b.path.length - a.path.length)
                .map((s) => ({ project: s.name, root: s.path, relPath: raw.slice(s.path.length).replace(/^\/+/, "") }))
            : projects.map((s) => ({ project: s.name, root: s.path, relPath: raw }));
          for (const c of candidates) {
            try {
              return { project: c.project, relPath: c.relPath, result: readFile(c.root, c.relPath) };
            } catch {
              continue;   // an expected miss, not an error — this IS the search
            }
          }
          // The same widened-root fallback fs.read offers for `~`/absolute paths, so a path
          // outside every registered project still resolves exactly as it did before.
          if (raw.startsWith("~") || raw.startsWith("/")) {
            const roots = [
              ...projects.map((s) => s.path),
              ...(this.cfg.projectImportDir ? [this.cfg.projectImportDir] : []),
            ];
            try {
              const result = readAtWidenedRoot(raw, roots);
              return { project: null, relPath: result.path, result };
            } catch { /* falls through to the null below, same as any refused candidate */ }
          }
          return null;   // nothing holds it — the caller renders plain text, no error raised
        }
        // ---------- WD Stage 2: plugins family (coverage B13) ----------
        case "plugins.list":
          return this.plugins.list(PluginsListParams.parse(params ?? {}).cwd);
        case "plugins.toggle": {
          const p = PluginsToggleParams.parse(params);
          return this.plugins.toggle(p.id, p.enabled);
        }
        // ---------- WD Stage 2: host tools + policy (coverage B14) ----------
        case "host.tools": {
          // Lazily (re)scans — first call probes, later calls reuse the cache until
          // 15min staleness (the documented refresh choice, see HostToolsScanner).
          const tools = await this.hostTools.tools();
          return { host: this.engineId, tools: this.withPolicy(tools) };
        }
        case "host.setPolicy": {
          const p = HostSetPolicyParams.parse(params);
          // F08/D7 residual: persist to the config.d overlay via configstore (config.json stays
          // user-owned/read-only) — NOT the legacy toolpolicy.json. applyConfig's toolPolicy
          // diff-apply (setConfig) then makes it effective on the very NEXT Bash decision.
          const current = (this.cfg.toolPolicy ?? {}) as ToolPolicy;
          const merged = mergeToolPolicy(current, { [p.tool]: { [p.profile]: p.mode } });
          const { config, changed } = this.configStore.patch({ toolPolicy: merged });
          this.applyConfig(config, changed);
          return { tool: p.tool, policy: this.toolPolicy.policyFor(p.tool) };
        }
        // ---------- MCP-STORE: registry (P1) + dynamic discovery (P2) ----------
        case "mcpstore.list":
          return this.mcpStore.list();
        // Operator RPCs (UI only, like mcpstore.package.*): the built-ins are managed by Chimera, so no
        // agent-facing tool can trigger a multi-hundred-MB download or read install state.
        case "computerUse.builtins.status":
          return { managed: this.builtInCtx !== null, integrations: this.builtInCtx ? builtInStatuses(this.mcpStore, this.builtInCtx, this.home) : [] };
        case "computerUse.builtins.install": {
          BuiltInsInstallParamsSchema.parse(params);
          const ctx = this.builtInCtx;
          if (!ctx) throw rpcError("protocol", "This Chimera build has no bundled integrations to install.");
          if (ctx.manifest.integrations.laya.state !== "managed-download") throw rpcError("protocol", "Laya is not available on this platform.");
          return installLaya({
            home: this.home, ctx, store: this.mcpStore,
            // The spec just changed from "absent" to a live Python entry; any cached connection is stale.
            onReconciled: () => { void this.mcpStoreConnections.closeServer("laya"); },
          });
        }
        // Undo the first-launch migration of a pre-existing (legacy) registration: restores the user's
        // original entry from computer-use/reconcile-backup.json and records the choice so the next
        // start does not migrate it again. Only entries that are still the built-in registration change.
        case "computerUse.builtins.rollback": {
          if (!this.builtInCtx) throw rpcError("protocol", "This Chimera build has no bundled integrations to roll back.");
          let restored;
          try { restored = rollbackBuiltInMigration(this.mcpStore, this.home); }
          catch (err) { throw rpcError("protocol", err instanceof Error ? err.message : String(err)); }
          for (const id of restored) void this.mcpStoreConnections.closeServer(id);
          return { restored };
        }
        // Operator RPC only. No package installer tool is exposed to model callers.
        case "mcpstore.package.inspect":
          return this.mcpPackages.inspect(params);
        case "mcpstore.package.install":
          return this.mcpPackages.install(params);
        case "mcpstore.add": {
          const parsed = McpStoreEntrySchema.parse(params);
          if (parsed.type === "stdio" && parsed.managed) throw rpcError("protocol", "Managed package records can only be created by the package installer.");
          // The built-in marker is the daemon's own provenance claim (it unlocks the "ships with Chimera"
          // presentation and the removal guard); a caller-supplied one would be forgeable.
          if (parsed.type === "stdio" && parsed.builtIn) throw rpcError("protocol", "Built-in integrations are registered by Chimera itself and cannot be added over RPC.");
          // MCP-OAUTH-DISCOVERABILITY: only a caller that supplied NO `auth` at all gets
          // auto-probed — an explicit auth choice (bearer or oauth) is never overridden.
          if (parsed.type === "http" && !parsed.auth) {
            const auth = await this.detectDefaultHttpAuth(parsed.name, parsed.url);
            if (auth) return this.mcpStore.add({ ...parsed, auth });
          }
          return this.mcpStore.add(parsed);
        }
        case "mcpstore.remove": {
          const p = McpStoreRemoveParams.parse(params);
          const target = this.mcpStore.get(p.name);
          if (target?.type === "stdio" && target.builtIn) throw rpcError("protocol", `"${p.name}" ships with Chimera and cannot be uninstalled; disable it instead.`);
          this.mcpRemoving.add(p.name);
          try {
          const original = this.mcpStore.get(p.name);
          // Close the admission gate BEFORE awaiting teardown; an in-flight tools()
          // request must not reconnect while uninstall is moving its executable.
          if (original) this.mcpStore.setEnabled(p.name, false);
          await this.mcpStoreConnections.closeServer(p.name);   // never leave a live child process for a removed entry
          // MCPSTORE-LIFECYCLE-UI: uninstall must purge the Keychain too -- a bearer secret
          // AND an oauth {tokens,clientInfo} blob both live under this SAME service name
          // (mcpStoreAuthService(name), see McpStoreHttpAuthSchema's doc comment) -- leaving
          // it behind after removing the mcpstore.json entry is an orphaned-credential
          // security defect. Idempotent (Keychain.delete never throws on a missing item), so
          // this is safe even for an entry that never had auth set.
          await this.keychain.delete(mcpStoreAuthService(p.name));
          // MCP-AUTH-STATUS: drop this daemon's connect verdict too. `outcomes` is keyed by
          // NAME, so a later re-add of the same name would otherwise inherit the removed
          // server's rejection and show needs-reauth before it had ever been tried.
          this.mcpStoreConnections.clearOutcome(p.name);
          if (original) this.mcpPackages.quarantine({ name: p.name, ...original });
          return this.mcpStore.remove(p.name);
          } finally { this.mcpRemoving.delete(p.name); }
        }
        case "mcpstore.tools": {
          const p = McpStoreToolsParams.parse(params ?? {});
          return { servers: await this.mcpStoreConnections.tools(p.query, p.servers) };
        }
        case "mcpstore.setDirect": {
          const p = McpStoreSetDirectParams.parse(params);
          return this.mcpStore.setDirect(p.name, p.direct);
        }
        // TRUST-TIER: UI->daemon only (same rationale as setDirect/setEnabled -- an
        // administrative toggle, not agent-facing). See McpStoreTrustSchema's doc comment.
        case "mcpstore.setTrust": {
          const p = McpStoreSetTrustParams.parse(params);
          return this.mcpStore.setTrust(p.name, p.trust);
        }
        // MCPSTORE-LIFECYCLE-UI: disable/enable — a temporary off switch (credentials/spec
        // stay intact). Disabling tears down any live connection immediately (mirrors
        // mcpstore.remove's closeServer) so an already-connected agent doesn't keep using it
        // past the click; McpStoreConnectionManager itself also refuses to reconnect while
        // disabled (see mcpstore.ts's ensure()).
        case "mcpstore.setEnabled": {
          const p = McpStoreSetEnabledParams.parse(params);
          const entry = this.mcpStore.setEnabled(p.name, p.enabled);
          if (!p.enabled) await this.mcpStoreConnections.closeServer(p.name);
          return entry;
        }
        // MCP-REMOTE-IMPORT slice 1: UI->daemon ONLY -- deliberately NOT registered as an
        // agent-facing MCP tool (engine-help/tui/app tool registries) because a token passed
        // as a tool argument would land in the agent transcript/logs. The secret goes ONLY to
        // the Keychain (service mcpStoreAuthService(name)); it is never written to
        // mcpstore.json and never echoed in this (or any) response/log — mirrors
        // accounts.setKey's D0 invariant above.
        case "mcpstore.setAuth": {
          const p = McpStoreSetAuthParams.parse(params);
          const entry = this.mcpStore.get(p.name);
          if (!entry) throw rpcError("protocol", `no mcp store server "${p.name}" (add it first via mcpstore.add)`);
          if (entry.type !== "http") throw rpcError("protocol", `mcp store server "${p.name}" is type "${entry.type}", which has no remote auth to set`);
          const trimmedSecret = p.secret.trim();
          if (!trimmedSecret) throw rpcError("protocol", `secret must not be empty`);
          await this.keychain.set(mcpStoreAuthService(p.name), trimmedSecret);
          // MCP-AUTH-STATUS: a bearer secret carries no timestamp, so authStatus cannot tell
          // that this NEW token postdates an earlier 401 the way it can for an oauth grant.
          // Retire the verdict here or the freshly-entered token keeps showing the old one's
          // rejection until something happens to connect again.
          this.mcpStoreConnections.clearOutcome(p.name);
          return { ok: true };
        }
        // MCP-OAUTH-DISCOVERABILITY: read-only, no-secret probe (see mcpstore-oauth-detect.ts's
        // header) — UI->daemon only, same discipline as setAuth above. `url` probes a fresh
        // add/import candidate; `name` probes an already-installed http entry by its stored url.
        case "mcpstore.detectAuth": {
          const p = McpStoreDetectAuthParams.parse(params);
          let url = p.url;
          if (!url) {
            if (!p.name) throw rpcError("protocol", "url or name is required");
            const entry = this.mcpStore.get(p.name);
            if (!entry) throw rpcError("protocol", `unknown mcp store server "${p.name}"`);
            if (entry.type !== "http") throw rpcError("protocol", `mcp store server "${p.name}" is type "${entry.type}", which has no remote url to probe`);
            url = entry.url;
          }
          return await this.mcpStoreDetectAuthFn(url);
        }
        // MCP-OAUTH-DISCOVERABILITY: retrofits an existing http entry's auth.kind (the
        // Authorize button's "detected-OAuth bearer entry" convert-then-authorize path) —
        // `keychainRef` is always re-derived from the name, never caller-supplied.
        case "mcpstore.setAuthKind": {
          const p = McpStoreSetAuthKindParams.parse(params);
          const entry = this.mcpStore.get(p.name);
          if (!entry) throw rpcError("protocol", `no mcp store server "${p.name}" (add it first via mcpstore.add)`);
          if (entry.type !== "http") throw rpcError("protocol", `mcp store server "${p.name}" is type "${entry.type}", which has no remote auth to set`);
          // MCP-OAUTH-FOREIGN-SCOPES: same rule as the add/import probe — an explicit caller
          // list always wins (including `[]`, which the app's "clear the scopes" action sends and
          // which must NOT silently fall back to a gateway catalog), otherwise re-probe this
          // entry's own url so a convert-to-oauth asks for what the server actually advertises.
          let auth: McpStoreHttpAuth;
          if (p.kind !== "oauth") {
            auth = { kind: "bearer", keychainRef: mcpStoreAuthService(p.name) };
          } else {
            let scopes = p.scopes;
            if (scopes === undefined) {
              // Best-effort: a probe failure leaves scopes undefined, i.e. "send no scope",
              // which is the safe end of the fallback ladder rather than a wrong guess.
              const detected = await this.mcpStoreDetectAuthFn(entry.url).catch(() => undefined);
              scopes = resolveDefaultOAuthScopes(entry.url, detected?.scopesSupported, this.cfg.mcpOAuthGateways);
            }
            auth = {
              kind: "oauth", keychainRef: mcpStoreAuthService(p.name),
              ...(scopes && scopes.length > 0 ? { scopes } : {}),
            };
          }
          return this.mcpStore.setAuthKind(p.name, auth);
        }
        // MCP-AUTH-STATUS: "is each installed server's authorization still good?" without a
        // network round-trip -- see McpStoreConnectionManager.authStatus. Read-only and
        // secret-free by construction, which is what lets it be agent-facing
        // (mcp_store_auth_status) while the token-bearing mcpstore.setAuth stays UI-only.
        case "mcpstore.authStatus": {
          const p = McpStoreAuthStatusParams.parse(params);
          return { servers: await this.mcpStoreConnections.authStatus(p.name) };
        }
        case "mcpstore.monitor": {
          McpStoreMonitorParams.parse(params);
          const monitor = this.mcpStoreConnections.monitor();
          return { ...monitor, ownerName: monitor.owner ? this.supervisor.displayLabelOf(monitor.owner) ?? null : null };
        }
        case "mcpstore.session": {
          const p = McpStoreSessionParams.parse(params);
          return this.mcpStoreConnections.session(p.server, p.action, p.agentId ?? null);
        }
        case "mcpstore.call": {
          const p = McpStoreCallParams.parse(params);
          const principal = p.agentId ?? null;
          // FEATURE-6 / TRUST-TIER: the gate runs INSIDE mcpStoreConnections.call, after ensure()
          // has populated real discovery-captured trust/readOnlyHint — decideMcpStoreCall is what
          // turns those into allow/deny/prompt (every call still attributed + audited, same as
          // before this feature). A "prompt" decision means an untrusted server's write-capable
          // tool was called by a real agent principal — route it through the SAME
          // permission_request/TUI/app approval surface Bash/foreign-MCP already use.
          return await this.mcpStoreConnections.call(p.server, p.tool, p.args, async (info) => {
            const { decision, reason } = this.capabilityBroker.decideMcpStoreCall(
              principal, info.server, info.tool, info.trust, info.readOnlyHint,
            );
            if (decision !== "prompt" || principal === null) return { allow: decision === "allow", reason };
            // FAIL CLOSED: any failure of the approval flow itself (unknown/ghost agent, or any
            // other throw) is a denial, never an allow — see requestMcpStoreApproval's doc.
            try {
              const allow = await this.supervisor.requestMcpStoreApproval(principal, { server: info.server, tool: info.tool, reason });
              return { allow, reason: allow ? undefined : `mcp store call to "${info.server}__${info.tool}" was denied by approval` };
            } catch (err) {
              return { allow: false, reason: `mcp store call to "${info.server}__${info.tool}" blocked: approval system unavailable (${(err as Error).message})` };
            }
          }, principal);
        }
        case "mcpstore.importables":
          return { importables: await this.mcpImports.scan() };
        case "mcpstore.import": {
          const p = McpStoreImportParams.parse(params);
          const importable = (await this.mcpImports.scan()).find((i) => i.source === p.source && i.name === p.name);
          if (!importable) throw rpcError("protocol", `no importable mcp server "${p.name}" found from source "${p.source}" (re-scan with mcpstore.importables)`);
          if (importable.notImportableReason) throw rpcError("protocol", importable.notImportableReason);
          const name = p.as ?? sanitizeMcpStoreName(importable.name);
          // MCP-REMOTE-IMPORT slice 2: a remote importable builds an http entry (url +
          // headers) instead of throwing on the missing command. `requiresAuth` is surfaced
          // on the response -- the UI's cue to follow up with mcpstore.setAuth, same as a
          // fresh manual http add.
          // MCP-REMOTE-IMPORT slice 3 fix: an auth-required import must ALSO wire
          // `auth.keychainRef` onto the entry itself here, not just surface `requiresAuth`
          // on the response -- connectTransport (mcpstore.ts) only calls resolveAuthSecret
          // when `spec.auth` is truthy, so without this a UI-issued mcpstore.setAuth right
          // after import would write a keychain secret that's silently NEVER read back.
          if (importable.type === "http") {
            if (!importable.url) throw rpcError("protocol", `"${p.name}" is missing a url`);
            const requiresAuth = importable.requiresAuth ?? false;
            // MCP-OAUTH-DISCOVERABILITY: an importable row carries no oauth-vs-bearer signal
            // of its own (the local claude/codex config it came from predates chimera's oauth
            // kind) — probe it the same as a fresh manual add, defaulting to oauth over the
            // conservative bearer fallback when the remote resolves an authorization server.
            const auth = (await this.detectDefaultHttpAuth(name, importable.url))
              ?? (requiresAuth ? { kind: "bearer" as const, keychainRef: mcpStoreAuthService(name) } : undefined);
            const added = this.mcpStore.add({
              type: "http", name, url: importable.url, headers: importable.headers ?? {}, direct: false, enabled: true, trust: "full",
              ...(auth ? { auth } : {}),
            });
            return { ...added, requiresAuth };
          }
          if (!importable.command) throw rpcError("protocol", `"${p.name}" is not importable`);
          return this.mcpStore.add({ type: "stdio", name, command: importable.command, args: importable.args ?? [], env: importable.env ?? {}, direct: false, enabled: true, trust: "full" });
        }
        // ---------- D7: config management & accounts (coverage C9/C10 · B16) ----------
        // Local-only (absent from PEER_METHODS): a peer can never read the config or the
        // account set beyond the name/provider `accounts.list` already exposes.
        case "config.get":
          // The EFFECTIVE merged config with every credential-bearing value REDACTED.
          return this.configStore.redacted();
        case "config.patch": {
          const p = ConfigPatchParams.parse(params);
          // JSON-merge-patch onto config.d/ui.json, re-validated as the full effective
          // config BEFORE any write. Invalid → ConfigError (→ {code:"protocol"}) and
          // NOTHING is written. Valid → diff-apply + config_changed.
          const { config, changed } = this.configStore.patch(p.patch);
          this.applyConfig(config, changed);
          return { ok: true, changed };
        }
        case "accounts.add": {
          const p = AccountAddParams.parse(params);
          return this.accountsAdd(p.name, p.provider ?? this.cfg.preferredProvider ?? "claude");
        }
        case "accounts.add_subscription": {
          const p = AccountsAddSubscriptionParams.parse(params);
          return this.accountsAddSubscription(p.provider);
        }
        case "providers.addCustom": {
          const p = ProvidersAddCustomParams.parse(params);
          return this.providersAddCustom(p);
        }
        case "accounts.remove": {
          const p = AccountNameParams.parse(params);
          return await this.accountsRemove(p.name);
        }
        // QUOTA-UNCOOL: the operator's override for the evidence path. A person looking at the
        // provider's own usage page has strictly better evidence than the parsed error string
        // that set the hold, and until now had no way to say so — the observed workaround was
        // moving each agent to another account by hand, which silently dropped their team
        // membership. registry.get() first so an unknown account is a ConfigError, not a
        // silent success on a name nobody has.
        case "accounts.uncool": {
          const p = AccountUncoolParamsSchema.parse(params);
          this.registry.get(p.name);
          const { account, wasCooling, clearedUntil, resumed } = this.supervisor.clearAccountCooldown(p.name, "operator");
          // A freed account can make a queued task routable again, exactly like agent.release.
          if (wasCooling || resumed.length > 0) await this.scheduler.tick();
          return { account, wasCooling, clearedUntil, resumed };
        }
        case "accounts.setKey": {
          const p = AccountSetKeyParams.parse(params);
          // The key goes ONLY to the Keychain (service "chimera:<name>"); it is never
          // written to config and never echoed in this (or any) response. Guard the auth
          // type: CredentialResolver reads the keychain ONLY for auth.type==="keychain"
          // (at auth.service), so writing a key for a subscription/env/command account
          // would leave an orphaned chimera:<name> item nothing ever reads — a false
          // success. Reject it instead so the caller learns the account can't hold a key.
          const setKeyAccount = this.requireAccount(p.name);
          if (setKeyAccount.auth.type !== "keychain") {
            throw rpcError("protocol", `account "${p.name}" uses ${setKeyAccount.auth.type} auth, which stores no keychain key`);
          }
          // OAUTH-TOKEN-ACCOUNTS: trim BEFORE storing (not just at read time) — a pasted
          // key with incidental leading/trailing whitespace/newline would otherwise fail
          // its own prefix classification below AND fail every provider's literal-header
          // probe, both misdiagnosed as "bad key" when the key itself was fine.
          const trimmedKey = p.key.trim();
          if (!trimmedKey) throw rpcError("protocol", `key must not be empty`);
          const classified = classifyCredential(setKeyAccount.provider, trimmedKey, setKeyAccount.auth.injectAs);
          await this.keychain.set(accountService(p.name), trimmedKey);
          // Persist the classification onto the account record ONLY when it's actually
          // informative — an oauth token or admin key changes injectAs and/or
          // credentialType away from the ordinary "apiKey + provider-default injectAs"
          // shape. The common case (a plain api key, injectAs unchanged) stays a
          // byte-identical no-op config write — accounts.list/UI already default an
          // absent credentialType to "apiKey", so nothing is lost by not persisting it.
          // This ALSO covers reverting an oauth-token/admin-key account back to a plain
          // key (injectAs differs from the classified default, so the OR still fires).
          const notable = classified.credentialType !== "apiKey" || classified.injectAs !== setKeyAccount.auth.injectAs;
          if (notable) {
            const accounts = this.cfg.accounts.map((a) =>
              a.name === p.name && a.auth.type === "keychain"
                ? { ...a, auth: { ...a.auth, injectAs: classified.injectAs, credentialType: classified.credentialType } }
                : a);
            const { config, changed } = this.configStore.patch({ accounts });
            this.applyConfig(config, changed);
          }
          return { ok: true, name: p.name, credentialType: classified.credentialType, ...(classified.warning ? { warning: classified.warning } : {}) };
        }
        case "accounts.test": {
          const p = AccountNameParams.parse(params);
          const account = this.requireAccount(p.name);
          // A subscription account has NO API key by design — it runs on the
          // provider CLI's ambient login/subscription (the very session the daemon
          // itself uses). The key-based probe would see a null key and falsely
          // report "auth_error"/invalid, so report "ok" WITHOUT probing (a running
          // daemon on this account IS the validation) — the "main" account the
          // whole system runs on must never test as invalid.
          if (account.auth.type === "subscription") return { name: p.name, result: "ok" };
          // Resolve the key from the Keychain only for a keychain-backed account (the
          // shape accounts.add creates); other auth types have no chimera:-service key,
          // so the prober decides best-effort with a null key.
          const rawKey = account.auth.type === "keychain" ? await this.keychain.get(account.auth.service) : null;
          // API-KEY-INVALID: trim defensively on READ too. accounts.setKey already trims
          // before storing, but a key stored by an OLDER daemon (before that fix) can still
          // carry a trailing newline — probing it verbatim would fail the provider's literal
          // header match and mislabel a perfectly good key "invalid". A trimmed-to-empty key
          // is treated as absent. (Spawn-time injection trims at the CredentialResolver too.)
          const trimmed = rawKey?.trim() ?? "";
          const key = trimmed === "" ? null : trimmed;
          // CLASSIFY-ON-TEST: re-derive the classification from the ACTUAL current key on
          // every test, rather than trusting account.auth.credentialType verbatim. That field
          // is only as fresh as the last accounts.setKey call — a key stored by an older
          // daemon build (before OAUTH-TOKEN-ACCOUNTS existed) or otherwise out of sync with
          // the current secret would keep reporting a stale "apiKey" classification forever,
          // silently x-api-key-probing an oauth token into a false "invalid". Self-heals: when
          // the fresh classification differs from what's persisted, patch it (same shape as
          // setKey's own write) so accounts.list/config.get and the next boot are already
          // correct — no need for the operator to re-enter the key.
          let credentialType = account.auth.type === "keychain" ? account.auth.credentialType : undefined;
          if (account.auth.type === "keychain" && key) {
            const classified = classifyCredential(account.provider, key, account.auth.injectAs);
            if (classified.injectAs !== account.auth.injectAs || classified.credentialType !== (account.auth.credentialType ?? "apiKey")) {
              const accounts = this.cfg.accounts.map((a) =>
                a.name === p.name && a.auth.type === "keychain"
                  ? { ...a, auth: { ...a.auth, injectAs: classified.injectAs, credentialType: classified.credentialType } }
                  : a);
              const { config, changed } = this.configStore.patch({ accounts });
              this.applyConfig(config, changed);
            }
            // Match accounts.setKey's own response shape: a plain apiKey stays undefined
            // (never persisted, never echoed) — only the notable classifications surface.
            credentialType = classified.credentialType === "apiKey" ? undefined : classified.credentialType;
          }
          // CUSTOM-OPENAI-COMPAT: pass the effective profile (built-in OR a synthesized
          // cfg.customProviders entry) so the prober can honor a custom provider's own
          // baseUrl/requiresKey instead of falling back to its built-in-only lookup.
          const profile = findEffectiveProvider(account.provider, this.cfg);
          const outcome = await this.prober.probe({ provider: account.provider, key, credentialType, profile });
          return {
            name: p.name,
            result: outcome.result,
            ...(credentialType ? { credentialType } : {}),
            ...(outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
            ...(outcome.detail ? { detail: outcome.detail } : {}),
          };
        }
        // F23-2A: subscription OAuth. accounts.oauth_start kicks off a provider's flow
        // (device-code polling happens server-side in the background); accounts.oauth_finish
        // is polled by the caller until the pending exchange resolves (or is fed a pasted
        // `code` for an authorize-code flow, once one exists).
        case "accounts.oauth_start": {
          const p = AccountsOAuthStartParams.parse(params);
          return await this.accountsOAuthStart(p.provider);
        }
        case "accounts.oauth_finish": {
          const p = AccountsOAuthFinishParams.parse(params);
          return await this.accountsOAuthFinish(p.pendingId, p.code);
        }
        // ---------- D6: network & tailscale (coverage C6 · B15) ----------
        // Local-only (absent from PEER_METHODS): a peer can never probe our network, run
        // `tailscale up`, store an auth key, or touch authorized_keys.
        case "fed.network":
          // `tailscale status --json` (5s-cached); installed:false when the binary is absent.
          return await this.network.status();
        case "fed.network.up":
          // `tailscale up` → {authUrl} (tailscale's interactive-login URL when a login is needed).
          return await this.network.up();
        case "fed.tailscale.setAuthKey": {
          const p = SetAuthKeyParams.parse(params);
          // Keychain ONLY — never echoed, never in config. Auto-join on the NEXT daemon startup.
          await this.network.setAuthKey(p.key);
          return { ok: true };
        }
        case "fed.cloudflare":
          // No API call — reflects the last fed.cloudflare.up outcome (or "never attempted").
          return this.cloudflareStatus ?? {
            installed: false, provisioned: false, hostname: null,
            tunnelHealth: "unknown" as const, selfprobe: "pending" as const, accessTokenExpiry: null,
          };
        case "fed.cloudflare.up": {
          const p = FedCloudflareUpParamsSchema.parse(params);
          const prov = this.cloudflareProvisioner ?? new CloudflareProvisioner({
            engineId: this.engineId, keychain: this.keychain, fetchFn: this.cfFetch,
          });
          this.cloudflareProvisioner = prov;
          const result = await prov.provision({ apiToken: p.apiToken, domain: p.domain });
          if (result.steps.some((s) => !s.ok)) {
            this.cloudflareStatus = {
              installed: true, provisioned: false, hostname: null,
              tunnelHealth: "unknown", selfprobe: "pending", accessTokenExpiry: null,
            };
            return { steps: result.steps, status: this.cloudflareStatus };
          }
          const hostname = `${this.engineId}.${p.domain}`;
          const clientSecret = await this.keychain.get(cloudflareAccessSelfSecretService(this.engineId));
          const selfprobe = clientSecret && result.accessClientId
            ? await selfprobeCloudflareTunnel({
                hostname, clientId: result.accessClientId, clientSecret, probe: this.cfProbe,
                retryWindowMs: this.cfSelfprobeRetryWindowMs, retryIntervalMs: this.cfSelfprobeRetryIntervalMs,
              })
            : "failed";
          if (selfprobe === "passed") this.cloudflareAccessClientId = result.accessClientId ?? undefined;
          this.cloudflareStatus = {
            installed: true, provisioned: selfprobe === "passed", hostname,
            tunnelHealth: selfprobe === "passed" ? "healthy" : "unknown",
            selfprobe, accessTokenExpiry: null,
          };
          return {
            steps: [...result.steps, { step: "start-supervisor", ok: true }, { step: "selfprobe", ok: selfprobe === "passed" }],
            status: this.cloudflareStatus,
          };
        }
        case "fed.sshkey.ensure":
          // ${home}/fed_ssh_key (ed25519, 0600), created via the ssh-keygen seam; returns the pubkey.
          return await ensureFedSshKey({ home: this.home, engineId: this.engineId, exec: this.netExec });
        case "fed.accept": {
          const p = FedAcceptParams.parse(params);
          // Bind the peer's public key with a RESTRICTED authorized_keys line (restrict,
          // port-forwarding). Shape-validated + idempotent (re-accept replaces the engine's line).
          return acceptFedKey({ home: this.home, engineId: p.engineId, publicKey: p.publicKey });
        }
        // ---------- D8: pairing (invite / join / grant) + local peer.status (coverage C7/C8 · B15) ----------
        // All local-only (absent from PEER_METHODS): a peer can never mint/join/grant invites or
        // read our peer table. Federation must be configured (engine.id present) for any of them.
        case "fed.invite.create": {
          this.requireFederated();
          // Cloudflare Plan A gate (spec §3): an endpoint is never published while this
          // engine's own Cloudflare selfprobe is pending/failed — the negative probe not
          // having passed means the hostname might not actually be gated. An engine that
          // never touched fed.cloudflare.up is unaffected (cloudflareStatus is unset).
          if (this.cloudflareStatus && this.cloudflareStatus.selfprobe !== "passed")
            throw rpcError("protocol", "Cloudflare provisioning is not complete (selfprobe has not passed) — refusing to publish the endpoint");
          this.invites.sweepExpired().forEach((rec) => {
            // §13a/f: an unpaired invite's ephemeral key must not outlive its invite.
            if (rec.keyTag) removeFedKey({ home: this.home, tag: rec.keyTag, target: "user", userSshDir: this.userSshDir });
          });
          const p = InviteCreateParams.parse(params ?? {});
          const { id, token, exp } = this.invites.create(p.ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS);
          const endpoint = this.selfEndpoint();
          // §13a/b/d: the ssh-layer credential bootstrap only applies when this invite's
          // endpoint actually carries a remote ssh-reachable transport (Cloudflare Plan A today).
          // A same-host/loopback endpoint (no cloudflareAccess) is byte-identical to pre-§13.
          let inviteKeyPrivate: string | undefined;
          let fedSshPublicKey: string | undefined;
          if (endpoint.cloudflareAccess) {
            const keyTag = `invite-${id}`;
            const kp = await mintInviteKeypair({ exec: this.netExec });
            acceptFedKey({ home: this.home, engineId: keyTag, publicKey: kp.publicKey, target: "user", tag: keyTag, userSshDir: this.userSshDir });
            this.invites.setKeyTag(id, keyTag);
            inviteKeyPrivate = kp.privateKey;
            const { publicKey } = await ensureFedSshKey({ home: this.home, engineId: this.engineId, exec: this.netExec });
            fedSshPublicKey = publicKey;
          }
          // The blob carries the raw token + (when minted) the ephemeral private key + the
          // durable fed_ssh_key.pub ONCE (the operator copies it); only the invite's hash and
          // keyTag are at rest.
          const blob = encodePairBlob({
            card: this.engineCard(), endpoint, inviteToken: token, exp,
            ...(inviteKeyPrivate ? { inviteKeyPrivate } : {}),
            ...(fedSshPublicKey ? { fedSshPublicKey } : {}),
          });
          return { id, blob, exp };
        }
        case "fed.invite.list": {
          this.requireFederated();
          return { invites: this.invites.list() };   // hashes/exp/used — never raw tokens
        }
        case "fed.invite.revoke": {
          this.requireFederated();
          const id = InviteRevokeParams.parse(params).id;
          const rec = this.invites.get(id);   // §13a/f: read the keyTag BEFORE removing the record
          const revoked = this.invites.revoke(id);
          if (revoked && rec?.keyTag) removeFedKey({ home: this.home, tag: rec.keyTag, target: "user", userSshDir: this.userSshDir });
          return { revoked };
        }
        case "fed.join": {
          this.requireFederated();
          return await this.fedJoin(FedJoinParams.parse(params).blob);
        }
        case "fed.peer.grant": {
          this.requireFederated();
          const p = FedGrantParams.parse(params);
          const peers = this.cfg.federation?.peers ?? [];
          const idx = peers.findIndex((x) => x.engineId === p.engineId);
          if (idx < 0) throw rpcError("protocol", `unknown peer "${p.engineId}" — pair before granting`);
          const updated: PeerConfig = {
            ...peers[idx]!,
            ...(p.allowSpawn !== undefined ? { allowSpawn: p.allowSpawn } : {}),
            ...(p.accounts !== undefined ? { accounts: p.accounts } : {}),
            ...(p.maxConcurrent !== undefined ? { maxConcurrent: p.maxConcurrent } : {}),
          };
          const { config, changed } = this.configStore.patch({ federation: { peers: peers.map((x, i) => (i === idx ? updated : x)) } });
          this.applyConfig(config, changed);   // live-apply: the responder reads the new grant on its next call
          return { ok: true, peer: { engineId: updated.engineId, allowSpawn: updated.allowSpawn, accounts: updated.accounts, maxConcurrent: updated.maxConcurrent } };
        }
        // Local peer.status (F08 gap): the peers' last-known snapshots INCLUDING each peer's cached
        // host-tools summary (FederationManager caches it from peer.status exchanges — a peer never
        // triggers local process execution, D4). Distinct from handlePeer's "peer.status" (which
        // serves a REMOTE requester); this is the LOCAL client path the app's ⇅ carriage needs.
        case "peer.status": {
          if (!this.federation) return { peers: [] };
          return { peers: await this.federation.peerStatuses() };
        }
        default:
          throw rpcError("protocol", `unknown method "${method}"`);
      }
    } catch (err) {
      if (err instanceof z.ZodError) throw rpcError("protocol", err.issues.map((i) => i.message).join("; "));
      const e = err as { code?: string; message?: string };
      if (typeof e.code === "string" && typeof e.message === "string") throw rpcError(e.code, e.message);
      throw rpcError("unknown", String((err as Error).message ?? err));
    }
  }

  // ---------- D6: startup tailscale auto-join ----------
  // Called once at daemon boot. If tailscale is not logged in AND a stored auth key exists, run
  // `tailscale up --auth-key`; the key is BURNED on success, a network_error is emitted on failure
  // (message scrubbed of the key). Never throws — a network hiccup must not crash the daemon.
  async autoJoinNetwork(): Promise<void> {
    try { await this.network.autoJoin(); } catch { /* best-effort; never crash-loop boot */ }
  }

  // ---------- D7 helpers: config diff-apply + accounts ----------

  // Apply a validated new effective config to the LIVE subsystems and emit config_changed.
  // The diff decides what to touch (nothing is rebuilt unnecessarily):
  //   accounts/autoOrder/caps → AccountRegistry.reload (the supervisor shares this
  //     registry, so NEW spawns see the new set; running spawn envs are never revisited).
  //   failoverCooldownMinutes → CooldownTracker.setCooldownMs (the supervisor shares this
  //     tracker, so the NEXT stamp uses the new window; no daemon restart). AccountRegistry
  //     has no concept of the cooldown window, so this is a separate live-apply hook.
  //   toolPolicy → ToolPolicyStore.setConfig (immediate: decidePermission reads it fresh).
  //   dailyCapUsd → picked up on the NEXT daemon.status via this.cfg (no action here).
  //   federation.peers → D8: diff the peer set and live-apply to the FederationManager
  //     (add link / teardown link / rebuild on transport change). A grant (policy-only) is a
  //     no-op on the link — the responder reads the new grant from config on its next call.
  //     Running agents are the executor's and are never touched by a link teardown.
  // A5 remote-spawn local-row gap: local supervisor agents are authoritative, but a fresh
  // remote spawn (engine=<peer>) has no local row until a peer-relayed event arrives. Merge
  // the federation record cache ADDITIVELY so the ⇅ @engine row shows on the very first
  // window. Each cached record carries a qualified agentId ("<engine>/<localId>"), which the
  // UI reducer stamps into AgentView.engine. De-dup by agentId (local wins) — records are the
  // peer's own scrubbed replies (D5: account NAMES only, never credentials). Shared by both
  // agent.list and agent.listSummary (TOKEN-OPT-P1) so the merge logic lives in exactly one
  // place.
  private listAgentRecords(): (AgentRecord | Record<string, unknown>)[] {
    const local = this.supervisor.list();
    if (!this.federation) return local;
    const localIds = new Set(local.map((a) => a.agentId));
    const remote = this.federation.cachedRecords()
      // WORKDIR-FEDERATION-GUARD: stamp __federated so downstream projections (agent.listSummary)
      // can tell a peer's raw record apart from a local AgentRecord — a federated record's `spec`
      // carries the PEER's cwd/isolation/workdirKey, which resolveWorkdirPath must never resolve
      // against THIS host's filesystem.
      .map(({ record }): Record<string, unknown> => ({ ...(record as Record<string, unknown>), __federated: true }))
      .filter((r) => typeof r?.agentId === "string" && !localIds.has(r.agentId as string));
    return [...local, ...remote];
  }

  // AGENT-LOOKUP-BY-NAME: extracted from agent.listSummary's old inline .map() so agent.find
  // can project the SAME record shape after filtering, instead of duplicating this mapping.
  // Behavior is unchanged for agent.listSummary — same fields, same omit-when-absent guards,
  // same __federated workdir skip.
  private toAgentSummary(r: AgentRecord | Record<string, unknown>): AgentSummary {
    return {
      id: String(r["agentId"]),
      name: String(r["accountName"] ?? ""),
      role: (r["membership"] as { role?: string } | undefined)?.role ?? null,
      // ROLES-TAB S1: omit entirely (not just null) for a record with no sessionRole —
      // keeps a pre-S1 record's projection byte-identical, matching every other optional
      // field's guard pattern on this record (gitBranch, membership, etc.).
      ...(r["sessionRole"] !== undefined ? { sessionRole: r["sessionRole"] as string | null } : {}),
      status: String(r["state"] ?? "running"),
      model: (r["spec"] as { model?: string } | undefined)?.model ?? null,
      depth: Number(r["depth"] ?? 0),
      parentId: (r["parentId"] as string | null | undefined) ?? null,
      // CROSS-PROVIDER-HANDOFF: same omit-when-absent convention as sessionRole/jobName —
      // only a handoff's two participants ever carry either field.
      ...(r["forkLineage"] !== undefined ? { forkLineage: r["forkLineage"] as import("@chimera/protocol").ForkLineage } : {}),
      ...(r["handoffFrom"] !== undefined ? { handoffFrom: r["handoffFrom"] as string } : {}),
      ...(r["handoffTo"] !== undefined ? { handoffTo: r["handoffTo"] as string } : {}),
      costUsd: Number(r["costUsd"] ?? 0),
      gitBranch: (r["gitBranch"] as string | null | undefined) ?? null,
      // WORKDIR-FEDERATION-GUARD: a federated record's spec is the PEER's own
      // isolation/cwd/workdirKey — resolveWorkdirPath would stat and resolve THIS host's
      // filesystem against a different host's path fragments, which at best returns a
      // meaningless string and at worst (isolation:"worktree" + a coincidentally matching
      // layout) a REAL local directory unrelated to the remote agent. Omit entirely rather
      // than compute a wrong value; __federated is stamped by listAgentRecords() and is
      // absent on genuinely local records.
      ...(r["spec"] !== undefined && (r as Record<string, unknown>)["__federated"] !== true
        ? { workdir: resolveWorkdirPath({
            ...(r["spec"] as Pick<ResolvedAgentSpec, "isolation" | "cwd" | "workdirKey">),
            agentId: String(r["agentId"]),
          }) }
        : {}),
      // BLOCKED-LANDING-NEEDS-A-DATA-FLAG: same omit-when-absent convention as
      // sessionRole above — a sweep's liveness check can now do
      // `agent.landingPermissionDenied === true` instead of parsing resultText prose.
      ...(r["landingPermissionDenied"] === true ? { landingPermissionDenied: true as const } : {}),
      // DENIED-TOOL-CALL-INVISIBLE: same omit-when-absent convention, generalized from
      // landing-Bash-only denials to any host-tool-policy deny.
      ...(r["toolPolicyDenied"] === true ? { toolPolicyDenied: true as const } : {}),
      // F22: computed LIVE from the store, never stamped on the record — a lease handed off via
      // worktree_lease_handoff, or self-pruned because the worktree dir is gone, must disappear
      // from the very next projection rather than linger as a stale boolean.
      // Emitted as a REAL boolean — NOT the omit-when-absent convention of the flags above —
      // because ui-state's reducer reads this field as authoritative-WHEN-PRESENT and treats an
      // absent one as "older daemon, keep the previous value"; omitting `false` therefore froze
      // the chip on forever after a handoff/release/self-prune, the exact opposite of what the
      // paragraph above promises (QA of 01c9bb58). Still omitted for the two rows where a
      // boolean would be noise or a guess: an agent that can never hold a lease
      // (isolation !== "worktree", which keeps TOKEN-OPT-P1's minimal summary byte-identical for
      // the ordinary fleet row) and a federated one, whose lease lives in the PEER's store — the
      // same reason `workdir` is omitted above.
      ...worktreeLeaseHeldField(
        this.worktreeLeases.heldBy(String(r["agentId"])),
        (r["spec"] as { isolation?: string } | undefined)?.isolation,
        (r as Record<string, unknown>)["__federated"] === true,
      ),
      ...(r["worktreeLeaseDenied"] === true ? { worktreeLeaseDenied: true as const } : {}),
      // AGENT-LOOKUP-BY-NAME: the operator-visible label — see AgentSummarySchema's own
      // comment on why this is a SEPARATE field from `name` (accountName) above.
      ...(r["displayLabel"] !== undefined ? { displayLabel: r["displayLabel"] as string } : {}),
      // JOB-FLEET-GROUPING: same omit-when-absent convention as displayLabel above.
      ...(r["jobName"] !== undefined ? { jobName: r["jobName"] as string | null } : {}),
      // AGENT-GROUPS Phase 1: same omit-when-absent convention, sparse (undefined/empty ⇒ omitted).
      ...((r["groups"] as string[] | undefined)?.length ? { groups: r["groups"] as string[] } : {}),
      // F47 (fleet seen-state): same omit-when-absent convention — a pre-F47 record (never
      // stamped) projects byte-identically to before. `unseen` is derived here, once, so every
      // consumer badges and sorts off the SAME verdict instead of re-deriving the comparison.
      ...(r["attentionAt"] !== undefined ? { attentionAt: r["attentionAt"] as number } : {}),
      ...(r["reviewedAt"] !== undefined ? { reviewedAt: r["reviewedAt"] as number } : {}),
      ...(isAgentUnseen({ attentionAt: r["attentionAt"] as number | undefined, reviewedAt: r["reviewedAt"] as number | undefined })
        ? { unseen: true as const } : {}),
      // F09: same omit-when-absent convention — the summary tier carries only the BOOLEAN badge;
      // the delivery id / silence duration live on the full record and in the event log for
      // whoever drills in. A pre-F09 record projects byte-identically to before.
      ...(r["promptStall"] ? { promptStalled: true as const } : {}),
    };
  }

  private applyConfig(cfg: ChimeraConfig, changed: string[]): void {
    if (changed.length === 0) return;
    const oldPeers = this.cfg.federation?.peers ?? [];
    this.cfg = cfg;
    if (changed.some((k) => k === "accounts" || k === "autoOrder" || k === "caps")) {
      this.registry.reload(cfg);
    }
    if (changed.includes("failoverCooldownMinutes")) {
      this.cooldowns.setCooldownMs(cfg.failoverCooldownMinutes * 60_000);
    }
    if (changed.includes("toolPolicy")) this.toolPolicy.setConfig(cfg.toolPolicy ?? {});
    if (changed.includes("federation")) this.applyFederationDiff(oldPeers, cfg.federation?.peers ?? []);
    if (changed.includes("notify")) this.notifier.setRules(cfg.notify);
    if (changed.includes("hooks")) this.hooks.setRules(cfg.hooks);
    if (changed.includes("otel")) this.otel.setConfig(cfg.otel);
    // F36.FIX: a live evictionAlarmAt change re-arms the capacity alarm — otherwise a threshold
    // lowered onto an already-full store stays silent because the old edge was already spent.
    if (changed.includes("memory")) this.memory.setCapacity({ alarmAt: cfg.memory.evictionAlarmAt });
    // HOT-RELOAD-BACKENDS: a new account's provider (or a changed providerOverrides baseUrl/
    // model) must be spawnable WITHOUT a daemon restart. Fire-and-forget — buildBackends is
    // async and applyConfig must stay sync (every other live-apply hook above is sync); errors
    // land as a config_error event, never crash the daemon. Never touches a RUNNING agent: it
    // only ADDS missing Map entries / REPLACES an entry whose own override changed, and
    // AgentSupervisor.launch() only reads backendsRef.get(provider) at (re)launch time, not
    // continuously — see accounts.ts's reload() for the same "next spawn sees it, current
    // spawns don't" contract this mirrors.
    if (changed.some((k) => k === "accounts" || k === "providerOverrides" || k === "customProviders")) this.reconcileBackends(cfg);
    // F49 LOOPBACK-MCP, deliberately one-directional: true->false tears the socket down and
    // revokes every live grant at once (an operator turning it off means NOW). false->true is
    // NOT wired live — the listener object was built with enabled:false at construction and only
    // a daemon restart re-reads it, which is the safe asymmetry: you can always close the door
    // without a restart, you can never open one by accident.
    if (changed.includes("mcpListener") && !(cfg.mcpListener?.enabled ?? false)) {
      void this.mcpListener.disable();
    }
    this.events.append({ agentId: "config", kind: "config_changed", data: { keys: changed } });
  }

  // Chains onto backendReconcileChain so overlapping reconcile runs (two rapid config
  // changes) never race each other's Map writes.
  private reconcileBackends(cfg: ChimeraConfig): void {
    this.backendReconcileChain = this.backendReconcileChain
      .then(() => this.doReconcileBackends(cfg))
      .catch((err) => {
        this.events.append({
          agentId: "config", kind: "config_error",
          data: { message: scrubSecretShapes(`hot-reload backends: ${String((err as Error).message ?? err)}`) },
        });
      });
  }

  private async doReconcileBackends(cfg: ChimeraConfig): Promise<void> {
    const providers = [...new Set(cfg.accounts.map((a) => a.provider))];
    // same override-merge main.ts does at boot (D3/F23-2B), plus CUSTOM-OPENAI-COMPAT's
    // synthesized customProviders profiles — kept in sync here so a live providerOverrides OR
    // customProviders+account edit reaches new spawns exactly like a fresh daemon boot would.
    const catalog = effectiveCatalog(cfg);
    const missing = providers.filter((p) => !this.backendsRef.has(p));
    // ADD-ONLY for providers a running agent may already be using — only an EXPLICIT
    // providerOverrides change for an already-registered provider earns a rebuild (new spawns
    // pick up the new baseUrl/model; a running agent already launched and never re-reads
    // backendsRef mid-flight, so replacing its entry is safe).
    const overrideChanged = providers.filter((p) => {
      if (missing.includes(p)) return false;
      const before = JSON.stringify(this.appliedProviderOverrides?.[p] ?? null);
      const after = JSON.stringify(cfg.providerOverrides?.[p] ?? null);
      return before !== after;
    });
    const customChanged = providers.filter((p) => {
      if (missing.includes(p)) return false;
      const before = JSON.stringify(this.appliedCustomProviders?.[p] ?? null);
      const after = JSON.stringify(cfg.customProviders?.[p] ?? null);
      return before !== after;
    });
    const toBuild = [...new Set([...missing, ...overrideChanged, ...customChanged])];
    this.appliedProviderOverrides = cfg.providerOverrides;
    this.appliedCustomProviders = cfg.customProviders;
    if (toBuild.length === 0) return;
    const built = await this.backendBuilder(catalog, { providers: toBuild, ...this.backendBuildDeps });
    for (const [id, backend] of built) this.backendsRef.set(id, backend);
  }

  // D7/D8: live peer diff-apply. New peer → add+start link; removed → teardown; changed →
  // rebuild only on a transport change (grant-only updates leave the link up). No-op when the
  // engine wasn't federated at boot (federation is null; a restart picks up a new engine.id).
  private applyFederationDiff(oldPeers: PeerConfig[], newPeers: PeerConfig[]): void {
    if (!this.federation) return;
    const prev = new Map(oldPeers.map((p) => [p.engineId, p]));
    const next = new Map(newPeers.map((p) => [p.engineId, p]));
    for (const [id, peer] of next) {
      if (!prev.has(id)) this.federation.addPeer(peer);
      else this.federation.updatePeer(peer);   // no-op unless the transport changed
    }
    for (const id of prev.keys()) if (!next.has(id)) this.federation.removePeer(id);
  }

  // F21/D17: called by the daemon's `subscribe` handler (bypasses engine.handle — see
  // daemon/server.ts) whenever a client's subscribe params carry `clientCaps`. `conn`
  // is an opaque per-connection token (the transport's own socket object); a re-subscribe
  // on the same connection REPLACES its prior declaration (not additive), matching how
  // server.ts already treats a re-subscribe as replacing the event filter.
  declareClientCaps(conn: object, caps: readonly string[]): void {
    this.clientCapsByConn.set(conn, new Set(caps));
  }

  // Called when a subscribed connection closes — a disconnected client's capability no
  // longer counts toward hasClientCap's "any live connection" check.
  releaseClientCaps(conn: object): void {
    this.clientCapsByConn.delete(conn);
  }

  hasClientCap(cap: string): boolean {
    for (const caps of this.clientCapsByConn.values()) if (caps.has(cap)) return true;
    return false;
  }

  // The ConfigWatcher's callback: re-read the effective config; a broken config.json/overlay
  // leaves the OLD config active and emits config_error (the daemon never crashes). A valid
  // change is diff-applied. Idempotent when nothing effectively changed (changed:[]).
  reloadConfig(): void {
    let result: { config: ChimeraConfig; changed: string[] };
    try {
      result = this.configStore.reload();
    } catch (err) {
      this.events.append({
        agentId: "config", kind: "config_error",
        data: { message: scrubSecretShapes(String((err as Error).message ?? err)) },
      });
      return;
    }
    this.applyConfig(result.config, result.changed);
  }

  // Look up an account in the CURRENT effective config, or throw a {code:"protocol"} error.
  private requireAccount(name: string): ChimeraConfig["accounts"][number] {
    const account = this.cfg.accounts.find((a) => a.name === name);
    if (!account) throw rpcError("protocol", `unknown account "${name}"`);
    return account;
  }

  // FEATURE MAIN-CONDUCTOR-PERSISTENT: the seat must exist the moment onboarding
  // completes (accounts 0→1) — before any first client message ever arrives — not
  // just at the next daemon boot. Best-effort/fire-and-forget, mirroring
  // ensureProjectConductor's own discipline elsewhere: a spawn failure here (no
  // usable backend yet, a guardrail, ...) must never fail the accounts.* RPC that
  // triggered it. Called by every account-creation path (accounts.add, .add_subscription,
  // .oauth_finish) with the account count observed BEFORE that path's own patch.
  private triggerMainConductorOnFirstAccount(hadAccounts: boolean): void {
    if (hadAccounts) return;
    // ONBOARDING-GATE fix: applyConfig (called by every caller just before this)
    // already kicked off reconcileBackends for the new account's provider, but
    // that's a fire-and-forget dynamic import()+registration — awaiting THIS
    // reference to backendReconcileChain (reassigned synchronously by
    // reconcileBackends before it returns) closes the race where this spawn
    // attempt would otherwise run before the backend exists ("no backend
    // registered for provider ..."), permanently stranding a fresh install
    // with no main conductor until a client happens to call ensure() itself.
    this.backendReconcileChain
      .then(() => this.ensureMainConductor())
      .catch((e) => {
        console.error(`chimerad: ensureMainConductor failed after first account added: ${String((e as Error).message)}`);
      });
  }

  // accounts.add: register a keychain-backed account in the config.d/ui.json overlay and add
  // it to autoOrder. Arrays are REPLACED by a merge-patch, so we write the FULL new arrays.
  // config carries only {name, provider, auth:{keychain reference}} — the key itself arrives
  // later via accounts.setKey and lives only in the Keychain.
  private accountsAdd(name: string, provider: string): { name: string; provider: string } {
    if (this.cfg.accounts.some((a) => a.name === name)) throw rpcError("conflict", `account "${name}" already exists`);
    // F23-0D: unknown provider → a clean {code:"protocol"} error here (not a crash, not a
    // silently-broken account with no injectAs env var) instead of failing later at spawn.
    const injectAs = defaultInjectAsEffective(provider, this.cfg);
    if (!injectAs) throw rpcError("protocol", `unknown provider "${provider}" (not in the provider catalog)`);
    const newAccount = {
      name, provider,
      auth: { type: "keychain" as const, service: accountService(name), injectAs },
    };
    const hadAccounts = this.cfg.accounts.length > 0;
    const accounts = [...this.cfg.accounts, newAccount];
    const autoOrder = this.cfg.autoOrder.includes(name) ? this.cfg.autoOrder : [...this.cfg.autoOrder, name];
    const { config, changed } = this.configStore.patch({ accounts, autoOrder });
    this.applyConfig(config, changed);
    this.triggerMainConductorOnFirstAccount(hadAccounts);
    return { name, provider };
  }

  // CUSTOM-OPENAI-COMPAT: registers cfg.customProviders[id] — the write path the schema field
  // added in protocol/index.ts needed. Rejects a collision with a built-in PROVIDERS id (never
  // let a custom entry hijack e.g. "openai") or with an existing custom id. baseUrl/defaultModel/
  // label are otherwise free-form (already shape-validated by ProvidersAddCustomParams); no key
  // is written or invented here — requiresKey only controls whether accounts.add later demands
  // one, the actual secret still goes through the same keychain-only accounts.setKey path.
  private providersAddCustom(p: { id: string; label: string; baseUrl: string; defaultModel: string; requiresKey?: boolean }): { id: string } {
    if (PROVIDERS.some((b) => b.id === p.id)) throw rpcError("conflict", `"${p.id}" is a built-in provider id`);
    if (this.cfg.customProviders?.[p.id]) throw rpcError("conflict", `custom provider "${p.id}" already exists`);
    const customProviders = {
      ...this.cfg.customProviders,
      [p.id]: { label: p.label, baseUrl: p.baseUrl, defaultModel: p.defaultModel, requiresKey: p.requiresKey ?? false },
    };
    const { config, changed } = this.configStore.patch({ customProviders });
    this.applyConfig(config, changed);
    return { id: p.id };
  }

  // accounts.add_subscription: register a `subscription` account riding the provider CLI's
  // own ambient login — only agentic-sdk catalog providers (claude, codex, kimi) support this
  // (the openai-compat/native providers have no CLI login of their own, only accounts.add's
  // keychain-key path or F23-2A's oauth flows). codex needs CODEX_HOME to exist before the
  // child process starts (supervisor.ts), so it gets an explicit resolved homeDir here; claude
  // omits homeDir and rides the SDK's own default (CLAUDE_CONFIG_DIR / ~/.claude). kimi ALSO
  // omits homeDir, but not as a "ride the default" convenience like claude — KIMI-BACKEND S0
  // spiked the real installed CLI (v0.29.2) and found it does not honor any config-root
  // override the SDK can deliver (KIMI_SHARE_DIR is silently ignored; the SDK's session-spawn
  // itself can't even reach a live CLI process to exercise the working KIMI_CODE_HOME override
  // found by hand — see docs/superpowers/specs/2026-07-28-kimi-backend-s0-findings.md §a). So
  // there is no per-account config root to isolate a second kimi identity into: every
  // chimera-spawned kimi session reads/writes the single ambient ~/.kimi-code/ tree regardless
  // of which chimera "account" it's attributed to. A second kimi subscription account would
  // therefore silently ALIAS the first (share credentials/session state while APPEARING
  // isolated) rather than fail loudly — worse than an honest rejection (spec §7). Since `name`
  // is always the provider id (no name param — see AccountsAddSubscriptionParams above), the
  // pre-existing name-collision check below already structurally enforces "at most one kimi
  // subscription account"; the branch here exists only to swap the generic
  // "account already exists" message for one that explains WHY, so the operator doesn't read
  // it as an arbitrary naming conflict they could work around.
  private accountsAddSubscription(provider: string): { name: string; provider: string } {
    const profile = findProvider(provider);
    if (!profile || profile.kind !== "agentic-sdk") {
      throw rpcError("protocol", `provider "${provider}" does not support subscription accounts`);
    }
    const name = provider;
    if (this.cfg.accounts.some((a) => a.name === name)) {
      if (provider === "kimi") {
        throw rpcError(
          "conflict",
          `a Kimi subscription account already exists — the Kimi CLI has a single global ambient `
          + `identity (~/.kimi-code) with no working per-account config-root override, so chimera `
          + `cannot isolate a second Kimi subscription account without it silently sharing `
          + `credentials and session state with the first`,
        );
      }
      throw rpcError("conflict", `account "${name}" already exists`);
    }
    const homeDir = provider === "codex" ? join(homedir(), ".codex") : undefined;
    const newAccount = {
      name, provider,
      auth: { type: "subscription" as const, ...(homeDir ? { homeDir } : {}) },
    };
    const hadAccounts = this.cfg.accounts.length > 0;
    const accounts = [...this.cfg.accounts, newAccount];
    const autoOrder = this.cfg.autoOrder.includes(name) ? this.cfg.autoOrder : [...this.cfg.autoOrder, name];
    const { config, changed } = this.configStore.patch({ accounts, autoOrder });
    this.applyConfig(config, changed);
    this.triggerMainConductorOnFirstAccount(hadAccounts);
    return { name, provider };
  }

  // accounts.oauth_start: kick off a provider's subscription-token flow. `providers.
  // experimental` in config gates any catalog entry flagged `experimental` (F23-2A: Copilot,
  // Grok Build — both gray-area/tier-gated third-party reuse per the research doc's TOS-
  // honesty rule) so a fresh install never lights these up without the operator opting in.
  private async accountsOAuthStart(providerId: string): Promise<{
    pendingId: string; authorizeUrl?: string; userCode?: string; verificationUri?: string; tosNote?: string;
  }> {
    const profile = findProvider(providerId);
    if (!profile) throw rpcError("protocol", `unknown provider "${providerId}"`);
    if (!profile.authModes.includes("oauth")) throw rpcError("protocol", `provider "${providerId}" does not support oauth`);
    if (profile.experimental && !this.cfg.providers.experimental) {
      throw rpcError("protocol", `provider "${providerId}" is experimental — set config providers.experimental to connect it`);
    }
    const flow = this.oauthFlows.get(providerId);
    if (!flow) throw rpcError("protocol", `provider "${providerId}" has no oauth flow implemented yet`);

    const { id } = this.pendingOAuth.create(providerId);
    try {
      const result = await flow.start(this.pendingOAuth, id);
      return {
        pendingId: id,
        ...(result.kind === "authorize" ? { authorizeUrl: result.authorizeUrl } : {}),
        ...(result.kind === "device" ? { userCode: result.userCode, verificationUri: result.verificationUri } : {}),
        ...(profile.tosNote ? { tosNote: profile.tosNote } : {}),
      };
    } catch (err) {
      // A synchronous pre-flight failure (bad device-code request, no local Grok CLI creds) —
      // the pending record never got a chance to resolve, so drop it rather than leaving a
      // permanently-"pending" ghost entry.
      this.pendingOAuth.delete(id);
      throw rpcError("protocol", (err as Error).message ?? String(err));
    }
  }

  // accounts.oauth_finish: poll (or complete) a pending exchange. Returns {status:"pending"}
  // for the caller to poll again — this RPC never blocks waiting on a device-code poll (that
  // happens server-side, in the background, started by oauth_start).
  private async accountsOAuthFinish(pendingId: string, code?: string): Promise<
    { status: "pending" } | { status: "connected"; name: string; provider: string } | { status: "error"; message: string }
  > {
    const record = this.pendingOAuth.get(pendingId);
    if (!record) throw rpcError("protocol", `unknown or expired oauth pending id "${pendingId}"`);

    if (record.state.status === "pending" && code) {
      const flow = this.oauthFlows.get(record.provider);
      if (flow?.continueWithCode) {
        try {
          await flow.continueWithCode(this.pendingOAuth, pendingId, code);
        } catch (err) {
          this.pendingOAuth.fail(pendingId, (err as Error).message ?? String(err));
        }
      }
    }

    if (record.state.status === "pending") return { status: "pending" };
    if (record.state.status === "error") {
      const message = record.state.message;
      this.pendingOAuth.delete(pendingId);
      return { status: "error", message };
    }

    // status === "ready": mint the oauth-type account and persist its token under a fresh
    // keychain service name (never colliding with a keychain-auth account's `chimera:<name>`).
    const provider = record.provider;
    const name = this.uniqueAccountName(provider);
    const tokenRef = `chimera-oauth:${name}`;
    await this.oauthTokenStore.save(tokenRef, record.state.token);
    const newAccount = { name, provider, auth: { type: "oauth" as const, provider, tokenRef } };
    const hadAccounts = this.cfg.accounts.length > 0;
    const accounts = [...this.cfg.accounts, newAccount];
    const autoOrder = this.cfg.autoOrder.includes(name) ? this.cfg.autoOrder : [...this.cfg.autoOrder, name];
    const { config, changed } = this.configStore.patch({ accounts, autoOrder });
    this.applyConfig(config, changed);
    this.triggerMainConductorOnFirstAccount(hadAccounts);
    this.pendingOAuth.delete(pendingId);
    return { status: "connected", name, provider };
  }

  // accounts.add lets the caller name the account; oauth_finish has no such param (the
  // provider id IS the natural name), so this dedupes against whatever already exists —
  // "copilot", then "copilot-2", "copilot-3", ...
  private uniqueAccountName(base: string): string {
    if (!this.cfg.accounts.some((a) => a.name === base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!this.cfg.accounts.some((a) => a.name === candidate)) return candidate;
    }
  }

  // accounts.remove: drop the account from accounts + autoOrder (full-array overlay writes)
  // and delete its Keychain item. Removing the last account / last autoOrder entry fails
  // validation (accounts.min(1)/autoOrder.min(1)) → nothing written, a clear error.
  private async accountsRemove(name: string): Promise<{ ok: true; name: string }> {
    this.requireAccount(name);
    const accounts = this.cfg.accounts.filter((a) => a.name !== name);
    const autoOrder = this.cfg.autoOrder.filter((n) => n !== name);
    const { config, changed } = this.configStore.patch({ accounts, autoOrder });
    this.applyConfig(config, changed);
    await this.keychain.delete(accountService(name)); // idempotent; after the config write commits
    return { ok: true, name };
  }

  // ---------- WD Stage 2 helpers ----------

  // coverage B12: LIVE = running|paused (a paused agent auto-resumes, so it still
  // occupies the project); real agents only (shadows are list markers); cwd matched
  // with isPathUnder's boundary check so /a/bc never counts against /a/b.
  // PROJECT-SCOPED-LIVE-SESSIONS: scoped to the project that OWNS the session, not to everything
  // sitting under a directory. Path alone was wrong the moment two projects shared one folder:
  // deleting project A was refused because project B's conductor was running there — a refusal
  // naming a session that demonstrably belonged to someone else, with no way for the operator to
  // act on it short of killing B's work. A record's projectId is resolved from its cwd at spawn
  // (see the projectFor seam), so for the normal one-directory-one-project case (now enforced at
  // registration — see ProjectStore.create's path guard) this counts exactly what it did before.
  //
  // The path check is kept as the FALLBACK for records with no projectId at all: an agent spawned
  // straight into a project's directory without the project context still occupies it, and
  // dropping that would quietly weaken a guard that exists to stop a delete from orphaning live work.
  private liveSessionsUnder(path: string, projectName?: string): AgentRecord[] {
    return this.supervisor.list().filter((a) => {
      if (a.shadow || (a.state !== "running" && a.state !== "paused")) return false;
      if (!isPathUnder(a.spec.cwd, path)) return false;
      const owner = (a as { projectId?: string | null }).projectId ?? null;
      return projectName === undefined || owner === null || owner === projectName;
    });
  }

  // PROJECT-NATIVE-TEAMS T3: materialize/merge/re-sync a project's .claude/agents/*.md
  // (T2's scanClaudeAgents) into its project-native team (T1's TeamSpec.projectNative/
  // discoveredRoles provenance). MERGE, never overwrite: any existing role key NOT
  // listed in the team's discoveredRoles is a chimera-added role and is ALWAYS
  // preserved; fresh discovered keys are added; a discovered role whose backing file
  // vanished is dropped (rebuilt from scratch each sync, not diffed). A NAME COLLISION
  // between a chimera-added role and a freshly discovered one keeps the chimera role
  // and skips the discovered one (logged, never added to discoveredRoles). Idempotent —
  // skips the team.update/assignTeam writes entirely when nothing actually changed.
  private syncProjectTeam(name: string): void {
    const spec = this.projects.get(name);
    const settingSources: SettingSource[] = spec.loadProjectSettings ? ["project", "user"] : [];
    const discovered = scanClaudeAgents(spec.path, { settingSources });
    const discoveredKeys = Object.keys(discovered).sort();

    const existing = this.teams.list().find((t) => t.projectNative === name);
    const priorDiscovered = new Set(existing?.discoveredRoles ?? []);
    const chimeraRoles: TeamSpec["roles"] = {};
    for (const [key, role] of Object.entries(existing?.roles ?? {})) {
      if (!priorDiscovered.has(key)) chimeraRoles[key] = role;
    }

    // ROLES-UNIFY §7 step 4: the owning team's name must be known BEFORE building bindings
    // (a discovered role's library entry is qualified "<team>.<key>", §3.2) — an existing
    // project-native team already has one; a brand-new one is derived the same way
    // team.create below actually names it.
    const teamName = existing?.name ?? foldRoleKey(`${name}-native`);

    const mergedRoles: TeamSpec["roles"] = { ...chimeraRoles };
    const mergedDiscovered: string[] = [];
    for (const key of discoveredKeys) {
      if (key in chimeraRoles) {
        console.error(`[syncProjectTeam] project "${name}": discovered role "${key}" collides with a chimera-added role of the same name — keeping the chimera role`);
        continue;
      }
      const qualifiedName = `${teamName}.${key}`;
      // ROLES-UNIFY §7 step 4: write/overwrite BOTH the library entry AND the binding on
      // EVERY sync — preserves this function's existing "rebuilt from scratch each sync,
      // not diffed" contract, now indirected one level through the library.
      this.roles.upsert({ ...discovered[key]!, name: qualifiedName });
      mergedRoles[key] = { role: qualifiedName, overrides: {} };
      mergedDiscovered.push(key);
    }

    if (!existing) {
      if (mergedDiscovered.length === 0) return;   // nothing discovered yet, no chimera roles either — no team to materialize
      const created = this.teams.create({ name: teamName, roles: mergedRoles, projectNative: name, discoveredRoles: mergedDiscovered });
      this.projects.assignTeam(name, created.name);
      return;
    }

    if (Object.keys(mergedRoles).length === 0) {
      // every discovered role's file vanished and no chimera role exists to keep the
      // team non-empty (TeamSpecSchema requires >=1 role) — leave the team as-is.
      console.error(`[syncProjectTeam] project "${name}": sync would leave team "${existing.name}" with zero roles — skipping`);
      return;
    }

    const rolesChanged = canonicalJson(existing.roles) !== canonicalJson(mergedRoles);
    const discoveredChanged = canonicalJson([...priorDiscovered].sort()) !== canonicalJson(mergedDiscovered);
    if (rolesChanged || discoveredChanged) {
      this.teams.update(existing.name, { roles: mergedRoles, discoveredRoles: mergedDiscovered });
    }
    this.projects.assignTeam(name, existing.name);   // idempotent no-op when already assigned
  }

  // PROJECT-NATIVE-TEAMS T4: create/import call site — only bother invoking
  // syncProjectTeam (and its team.create/update writes) when the project
  // actually ships a non-empty .claude/agents; a project without one gets no
  // project-native team at all (syncProjectTeam itself also no-ops in that
  // case, but checking here skips the readdir+team lookup entirely). Best-
  // effort like the project.status re-sync below — a sync failure must never
  // fail project.create/project.import.
  private syncProjectTeamIfPresent(spec: ProjectSpec): ProjectSpec {
    let hasAgents: boolean;
    try {
      hasAgents = readdirSync(join(spec.path, ".claude", "agents")).length > 0;
    } catch {
      hasAgents = false;   // no .claude/agents dir ⇒ nothing to materialize
    }
    if (!hasAgents) return spec;
    try {
      this.syncProjectTeam(spec.name);
      return this.projects.get(spec.name);
    } catch (e) {
      console.error(`chimerad: syncProjectTeam failed for project "${spec.name}": ${String((e as Error).message)}`);
      return spec;
    }
  }

  // FEATURE MAIN-CONDUCTOR-PERSISTENT: idempotently ensure the ONE daemon-owned MAIN
  // conductor seat is live, spawning/replacing it on first need (or after it went
  // terminal) and reusing it otherwise. Mirrors ensureProjectConductor exactly (same
  // TOCTOU discipline — the live-check and the in-flight-promise check below run with
  // no `await` between them) but for the single global seat, no project involved.
  // Every trigger point (boot, a 0→1 account event, an explicit main.conductor.ensure
  // RPC, and eventually the client's own lazy-spawn path) funnels through here, so a
  // main conductor that crashed into the circuit breaker (state "failed") gets
  // silently replaced — with its prior SDK session resumed — the next time anything
  // reaches for it, never left permanently dead.
  async ensureMainConductor(): Promise<AgentRecord> {
    const live = this.liveConductorRecord(this.mainConductorStore.get());
    if (live) return live;
    if (this.mainConductorSpawn) return this.mainConductorSpawn;
    const spawnPromise = this.spawnMainConductor().finally(() => { this.mainConductorSpawn = null; });
    this.mainConductorSpawn = spawnPromise;
    return spawnPromise;
  }

  private async spawnMainConductor(): Promise<AgentRecord> {
    // Same "carry the prior SDK session into the replacement" rationale as
    // spawnProjectConductor's priorSessionId — found regardless of the prior record's
    // state (including "failed") so a replacement after a crash-loop still resumes.
    const priorId = this.mainConductorStore.get();
    const priorSessionId = priorId
      ? this.supervisor.list().find((a) => a.agentId === priorId)?.sessionId ?? null
      : null;
    // cwd migration note (documented, not "fixed" retroactively): an EXISTING main
    // conductor resumed via reattach keeps whatever cwd it was ORIGINALLY spawned
    // with (possibly the old client-chosen default) — resume:true never touches
    // spec.cwd. This base-dir resolution only takes effect for a FRESH spawn/
    // replacement, exactly like every other cwd decision in this engine.
    const base = resolveProjectBaseDir(this.cfg.projectImportDir, this.home);
    if (!existsSync(base)) mkdirSync(base, { recursive: true });
    const record = await this.supervisor.spawn({
      // resumeOnly:true (resume:null with no prior session) skips pushing this prompt
      // as a first turn — same "fresh but idle" contract spawnProjectConductor relies on.
      prompt: "(auto-created main conductor)",
      cwd: base,
      isolation: "none",
      conductor: true,
      persistent: true,
      orchestration: { allow: true },
      ...CONDUCTOR_TURN_BUDGET,
      // CONDUCTOR-FULL-ACCESS: born "full" (config-overridable) — the main conductor is the
      // user's own orchestrator; under on.permissionRequest "auto" acceptEdits denies Bash and
      // every foreign MCP tool (supervisor.ts autoDecision), so it could not actually drive the
      // repo. The profile stays live-changeable via agent.setPermission (Ctrl-P / palette / app
      // chip), so this is a default, not a lock. Only the FRESH spawn reads config; a resumed
      // record keeps its stored profile (reattach.ts).
      permissionProfile: this.cfg.conductorPermissionProfile,
      resume: priorSessionId,
      resumeOnly: true,
      instructions: MAIN_CONDUCTOR_INSTRUCTIONS,
    });
    this.mainConductorStore.set(record.agentId);
    return record;
  }

  // An agent may search its own events and its descendants' — the agents it is responsible for —
  // never a sibling's or ancestor's. A requested agentIds list can only narrow that set; an empty
  // intersection is an empty agentIds array, which matches nothing rather than everything.
  private scopeChronicleToCaller<T extends { callerAgentId?: string; scope?: ChronicleSearchScope }>(p: T): Omit<T, "callerAgentId"> {
    const { callerAgentId, ...req } = p;
    if (!callerAgentId) return req;
    const visible = new Set([callerAgentId]);
    const records = this.supervisor.list();
    for (let grew = true; grew;) {
      grew = false;
      for (const r of records) {
        if (r.parentId && visible.has(r.parentId) && !visible.has(r.agentId)) { visible.add(r.agentId); grew = true; }
      }
    }
    const requested = req.scope?.agentIds;
    return { ...req, scope: { ...req.scope, agentIds: requested ? requested.filter((id) => visible.has(id)) : [...visible] } };
  }

  private mainConductorInfo(): { agentId: string; state: AgentRecord["state"] } | null {
    const id = this.mainConductorStore.get();
    if (!id) return null;
    const rec = this.supervisor.list().find((a) => a.agentId === id);
    return rec ? { agentId: rec.agentId, state: rec.state } : null;   // stale reference: the agent is gone
  }

  // PLAN-PROJECT-CONDUCTOR-ROUTING P1-T2 (D1 lazy-declared): idempotently ensure
  // a project has a live conductor, spawning one on first need and reusing it
  // afterward. TOCTOU-guarded the same way the app's lazy main-conductor spawn is
  // (commands.agents.ts:869) — the live-check and the in-flight-promise check
  // below run with no `await` between them, so two synchronous callers in the
  // same tick can never both pass the check and double-spawn.
  // CONDUCTOR-SPAWN-RUNAWAY: `explicit` marks an operator asking for a conductor by name
  // (project.conductor.start). Everything else is an AUTOMATIC ensure riding a READ —
  // project.status calls this, and the projects screen refreshes project.status — so a conductor
  // that dies the instant it is born turns a passive screen into a spawn loop. Seen live: 272
  // conductors created in one project directory (183 done, 87 killed) while the operator sat on
  // the projects tab trying to delete it, each delete refused because the loop had just created
  // another "active" agent for the guard to trip over.
  //
  // The brake is deliberately asymmetric. An automatic ensure backs off once spawns start dying
  // on arrival; an explicit start always tries and CLEARS the brake, so the operator is never
  // locked out of the recovery path by a guard meant to protect them.
  async ensureProjectConductor(name: string, opts: { explicit?: boolean } = {}): Promise<AgentRecord> {
    const spec = this.projects.get(name);
    if (spec.archived) throw new ProjectConflictError(`project "${name}" is archived`);
    const live = this.liveConductorRecord(spec.conductorId);
    if (live) return live;
    const inFlight = this.conductorSpawns.get(name);
    if (inFlight) return inFlight;

    // The die-on-arrival signal, read WITHOUT relying on timing: reaching here with a
    // conductorId already set means the conductor this project last pointed at is no longer
    // live. Checking the spawn's own result instead would race — spawnProjectConductor resolves
    // before the backend has had a chance to settle the agent, so a conductor that dies a tick
    // later still looks healthy at that moment. The NEXT ensure is where the death is a fact.
    if (spec.conductorId && !opts.explicit) {
      const prev = this.conductorSpawnBrake.get(name);
      this.conductorSpawnBrake.set(name, { deaths: (prev?.deaths ?? 0) + 1, lastAt: Date.now() });
    }
    const brake = this.conductorSpawnBrake.get(name);
    if (opts.explicit) this.conductorSpawnBrake.delete(name);
    else if (brake && brake.deaths > CONDUCTOR_SPAWN_MAX_DEATHS && Date.now() - brake.lastAt < CONDUCTOR_SPAWN_COOLDOWN_MS) {
      throw new ProjectConflictError(
        `project "${name}" has had ${brake.deaths} conductor spawns die on arrival — not auto-spawning another. ` +
        `Start one explicitly (project.conductor.start) once the cause is fixed.`,
      );
    }

    if (brake && brake.deaths === CONDUCTOR_SPAWN_MAX_DEATHS) {
      // One audit line as the brake engages, not one per refused read — the refusals are the
      // loud part already, and a log that scrolls is a log nobody reads.
      this.events.append({
        agentId: `project:${name}`, kind: "status",
        data: { project: name, conductorAutoSpawnPaused: true, deaths: brake.deaths },
      });
    }
    const spawnPromise = this.spawnProjectConductor(name, spec)
      .finally(() => this.conductorSpawns.delete(name));
    this.conductorSpawns.set(name, spawnPromise);
    return spawnPromise;
  }

  // PLAN-PROJECT-CONDUCTOR-ROUTING D2/§3 (P2-T2): the preference resolver, pure
  // orchestration over EXISTING primitives (queues.push/scheduler.assign/
  // supervisor.spawn+send) — no new scheduling engine. Resolution order (first
  // match wins): 1) queue-first (the project's own queue, else a hinted team's
  // bound queue) 2) own-team role-match (the project's first assigned, queue-
  // bound team whose roles include `role`, or any role when unset — an unbound
  // role-matching team is skipped, not used) 3) config.globalTeam, if bound to a
  // queue 4) direct — the project's own conductor (message it), else a fresh
  // spawn (at the project path, or the daemon's home dir for a project-less
  // dispatch).
  async dispatch(p: DispatchParams): Promise<DispatchResult> {
    let project: ProjectSpec | null = p.projectName ? this.projects.get(p.projectName) : null;

    // A project-scoped dispatch is itself a lazy-conductor trigger point (mirrors
    // project.status's UI-focus trigger) — best-effort, a spawn failure must never
    // block the routing below.
    if (project && project.autoConductor && !project.archived) {
      try { await this.ensureProjectConductor(project.name); project = this.projects.get(project.name); }
      catch (e) { console.error(`chimerad: ensureProjectConductor failed for project "${project.name}": ${String((e as Error).message)}`); }
    }

    // 1) queue-first
    let queueName = project?.queue ?? null;
    if (!queueName && p.teamHint) {
      const hinted = this.teams.list().find((t) => t.name === p.teamHint);
      if (hinted?.queue) queueName = hinted.queue;
    }
    if (queueName) {
      const task = this.queues.push(queueName, { prompt: p.prompt, role: p.role ?? null, priority: p.priority ?? 0, overrides: {},
        originConductorId: project?.conductorId ?? await this.resolveTaskOriginConductor(queueName, null) });
      await this.scheduler.tick();
      return { via: "queue", target: queueName, taskId: task.taskId };
    }

    // 2) own-team role-match
    if (project) {
      for (const teamName of project.teams) {
        const team = this.teams.list().find((t) => t.name === teamName);
        if (!team || !team.queue) continue;                       // unbound: skip, don't use
        if (p.role && !(p.role in team.roles)) continue;           // not a role-match
        const result = await this.scheduler.assign({ team: teamName, role: p.role }, p.prompt, p.priority);
        return { via: "team", target: teamName, taskId: "taskId" in result ? result.taskId : undefined };
      }
    }

    // 3) global team
    const globalTeamName = this.cfg.globalTeam;
    const globalTeam = globalTeamName ? this.teams.list().find((t) => t.name === globalTeamName) : undefined;
    if (globalTeam?.queue) {
      const result = await this.scheduler.assign({ team: globalTeam.name, role: p.role }, p.prompt, p.priority);
      return { via: "global", target: globalTeam.name, taskId: "taskId" in result ? result.taskId : undefined };
    }

    // 4) direct
    if (project) {
      const conductor = this.liveConductorRecord(project.conductorId);
      if (conductor) {
        await this.supervisor.send(conductor.agentId, p.prompt, "dispatch");
        return { via: "direct", target: conductor.agentId };
      }
      const record = await this.supervisor.spawn({ prompt: p.prompt, cwd: project.path, isolation: "none" }, { projectId: project.name });
      return { via: "direct", target: record.agentId };
    }
    const record = await this.supervisor.spawn({ prompt: p.prompt, cwd: this.home, isolation: "none" });
    return { via: "direct", target: record.agentId };
  }

  // Validate the account before persisting a project; full-access consent is
  // applied at the project conductor spawn, not by weakening its profile.
  private assertConductorPinSpawnable(account: string): void {
    this.registry.get(account);
  }

  private async spawnProjectConductor(name: string, spec: ProjectSpec): Promise<AgentRecord> {
    const permissionProfile = spec.permissionProfile ?? this.cfg.conductorPermissionProfile;
    // A prior conductor record for this project (found regardless of state — including
    // "failed" after the health-monitor circuit breaker trips) carries the SDK session this
    // replacement must continue, or a fresh spawn silently drops the conductor's accumulated
    // context/history even though its record still lists the project's prior conductor turns.
    const priorSessionId = spec.conductorId
      ? this.supervisor.list().find((a) => a.agentId === spec.conductorId)?.sessionId ?? null
      : null;
    const record = await this.supervisor.spawn({
      // resumeOnly:true (with resume:null when there's no prior session) skips pushing this
      // prompt as a first turn — same "fresh but idle" contract reattach.ts already relies on
      // for a conductor with no prior session (spawn is required min(1) regardless). With a
      // prior session, resume continues it idle instead of starting blank.
      prompt: `(auto-created conductor for project "${name}")`,
      cwd: spec.path,
      isolation: "none",             // CRITICAL: the conductor works in the REAL project repo
      conductor: true,
      autonomy: "full",
      orchestration: { allow: true },
      ...CONDUCTOR_TURN_BUDGET,
      // CONDUCTOR-FULL-ACCESS / PROJECT-CREATE-PERMISSION-PROFILE: precedence is this
      // project's own permissionProfile (set at project.create/import time) OVER the global
      // config default — an operator who picked "full" for THIS project at creation must get
      // a genuinely prompt-free conductor even if the global default is something else.
      // spec.permissionProfile is null (not merely absent) for every project that never set
      // one, so `??` falls through to the same config-overridable "full" default as the main
      // conductor above. Note there's no per-spawn override at this call site — this IS the
      // fresh-spawn path; a live agent is re-scoped via agent.setPermission instead. Only the
      // fresh spawn reads either of these; reattach.ts keeps a resumed record's stored profile.
      // `on.permissionRequest` is intentionally left unset here (⇒ AgentSpecSchema's own
      // default "auto") — a "full" resolution here is ALREADY prompt-free, unlike the
      // interactive SpawnCard/TUI spawn forms (PERM-READONLY-FALSE-PROMPTS) which explicitly
      // set "tui" and had to be taught to override it back to "auto" for a resolved-full spawn.
      permissionProfile,
      // Creating a full-access project manager grants the matching Codex launch
      // posture too. Ordinary agent spawns retain their explicit opt-in gate.
      acknowledgeCodexFullAccessRisk: permissionProfile === "full",
      // PROJECT-CONDUCTOR-ACCOUNT: same fresh-spawn-only precedence as permissionProfile above —
      // this project's pin OVER the fleet default. "auto" is AgentSpecSchema's own default (first
      // autoOrder entry), so an unpinned project keeps routing exactly as before. The model is
      // spread-conditionally rather than `?? undefined` because an ABSENT model is meaningful
      // downstream (launch() resolves spec.model ?? provider.defaultModel) — writing an explicit
      // undefined would not be the same thing to a strict schema.
      account: spec.conductorAccount ?? "auto",
      ...(spec.conductorModel !== null ? { model: spec.conductorModel } : {}),
      // PROJECT-CONDUCTOR-DEFAULTS: read at the same fresh-spawn seam as permissionProfile above,
      // and with the same "only the fresh spawn reads config" contract — a reattached conductor
      // keeps its stored spec, and a live one is changed via agent_reconfigure (both fields are in
      // RECONFIGURABLE_KEYS). See the config schema for why high/500k rather than the fleet default.
      effort: this.cfg.projectConductorEffort,
      compactionThreshold: this.cfg.projectConductorCompactionThreshold,
      resume: priorSessionId,
      resumeOnly: true,
      instructions: projectConductorInstructions(name),
      // PROJECT-NATIVE-TEAMS T5: ON loads the project's .claude/ (skills/commands/
      // CLAUDE.md/.mcp.json) + global ~/.claude skills, same as a native CLI session
      // in this repo; OFF keeps today's isolation (claude.ts's self-inject-CLAUDE.md
      // fallback then covers the conductor's repo orientation instead).
      inherit: { settingSources: spec.loadProjectSettings ? ["project", "user"] : [] },
    }, {
      // ORPHANED-CONDUCTOR-BLOCKS-DELETE: state the owner rather than letting it be derived from
      // cwd. The derivation resolves ONE project per directory, so with two projects registered
      // at the same path a conductor spawned FOR one of them could be stamped with the other's
      // name — and then teardown skipped it while the blocking check still counted it.
      projectId: name,
    });
    this.projects.setConductorId(name, record.agentId);
    return record;
  }

  // Torn down on project.archive / project.conductor.stop. A conductor mid session-
  // limit HOLD ("paused") still counts as owning the seat — only a terminal state
  // (done/failed/killed) or an unknown id means "nothing to tear down."
  private async stopProjectConductor(name: string, conductorId: string | null): Promise<void> {
    if (!conductorId) return;
    if (this.liveConductorRecord(conductorId)) await this.supervisor.kill(conductorId);
    this.projects.setConductorId(name, null);
  }

  // ORPHANED-CONDUCTOR-BLOCKS-DELETE: archive/delete used to tear down only the conductor the
  // project spec currently POINTS at. Every earlier conductor whose id was overwritten by the
  // next spawn stayed running and blocked the delete forever — the operator was told to "kill or
  // finish" sessions they never created, without being told which, and (before the spawn brake)
  // the very screen they were on kept minting more.
  //
  // The predicate is deliberately derived from liveSessionsUnder rather than written afresh:
  // whatever would BLOCK is what gets torn down, so the two can never disagree, and this can
  // provably not kill anything that wasn't already blocking. A conductor auto-created for this
  // project is the project's own machinery — cleaning it up is this call's job, not the
  // operator's. Anything else live under the path is real work and still refuses.
  private async stopOwnConductors(spec: ProjectSpec): Promise<void> {
    for (const rec of this.liveSessionsUnder(spec.path, spec.name)) {
      if (!rec.spec.conductor) continue;
      await this.supervisor.kill(rec.agentId).catch(() => {});
    }
    this.projects.setConductorId(spec.name, null);
  }

  // The refusal an operator can ACT on: which sessions, by name and id. "has 1 live session(s)"
  // named nothing, in a fleet of ~1000 rows sharing one label.
  private liveSessionRefusal(spec: ProjectSpec, verb: string): string | null {
    const live = this.liveSessionsUnder(spec.path, spec.name);
    if (live.length === 0) return null;
    const named = live.slice(0, 5).map((a) => `${a.displayLabel ?? a.agentId.slice(0, 8)} (${a.agentId.slice(0, 8)}, ${a.state})`).join(", ");
    const more = live.length > 5 ? `, +${live.length - 5} more` : "";
    return `project "${spec.name}" has ${live.length} live session(s) under ${spec.path} — kill or finish them before ${verb}: ${named}${more}`;
  }

  private liveConductorRecord(conductorId: string | null): AgentRecord | undefined {
    if (!conductorId) return undefined;
    return this.supervisor.list().find((a) => a.agentId === conductorId && (a.state === "running" || a.state === "paused"));
  }

  /**
   * Resolve once at queue entry; callers persist the answer on TaskRecord.
   *
   * INSPECTOR-PLACEMENT AUDIT: this used to end with a last-resort fallback that
   * picked "whichever teamless/projectless conductor was created most recently" --
   * a pure guess with no relation to `queue`/`pushedBy` at all. ui-state's
   * treeOrder() splices a task's WHOLE tree under `originConductorId` unconditionally
   * once it resolves to a live record (see reducer.ts's "Queue/workflow ownership"
   * splice), so that guess durably misattributed unrelated teams' workers as children
   * of an arbitrary conductor (reported: a team-queue task with no matching project
   * rendered nested under whatever conductor happened to be newest). Returning null
   * here when neither the pusher chain nor a project match resolves a REAL owner is
   * strictly more correct: the task renders as its own tree (still correctly grouped
   * by membership.team via treeOrder's clustering) instead of a fabricated one.
   */
  private async resolveTaskOriginConductor(queue: string, pushedBy: string | null): Promise<string | null> {
    const records = this.supervisor.list();
    const byId = new Map(records.map((a) => [a.agentId, a]));
    const ownerOf = (id: string | null): string | null => {
      let cur = id;
      let root: string | null = null;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const rec = byId.get(cur);
        if (!rec) break;
        root = rec.agentId;
        if (rec.spec.conductor === true && !rec.membership) return root;
        if (rec.originConductorId) return rec.originConductorId;
        cur = rec.parentId;
      }
      // Ad-hoc sessions can orchestrate teams without the conductor flag.
      return root;
    };
    const pusherOwner = ownerOf(pushedBy);
    if (pusherOwner) return pusherOwner;
    // A queue with a single known team owner has real provenance even when
    // an operator or scheduled job pushes the task. Shared queues stay unowned
    // when their teams disagree; never choose an arbitrary conductor.
    const teamOwners = new Set(this.teams.list().filter(t => t.queue === queue)
      .map(t => ownerOf(t.createdBy ?? null)));
    if (teamOwners.size === 1 && !teamOwners.has(null)) return [...teamOwners][0]!;
    const project = this.projects.list().find((p) => p.queue === queue || p.teams.some((name) => this.teams.list().find((t) => t.name === name)?.queue === queue));
    if (project) {
      if (project.conductorId) return project.conductorId;
      if (project.autoConductor && !project.archived) {
        try { return (await this.ensureProjectConductor(project.name)).agentId; } catch { /* fall through */ }
      }
    }
    return null;
  }

  // F25: a changes_requested decision is the ONE review event an agent cannot poll for — it is
  // filed by a human in the app while the agent sits idle. Reuse the operator-notice path exactly
  // (mailboxes.enqueue + supervisor.wakeMailbox) — no new channel.
  private wakeReviewAuthor(session: ReviewSession): void {
    let agentId: string | null = null;
    // A review session is keyed on any taskId string; it is NOT guaranteed to be a queue task.
    // queues.getTask throws UnknownTaskError — a review decision must never fail because the
    // wake target does not exist.
    try { agentId = this.queues.getTask(session.taskId).agentId; } catch { return; }
    if (!agentId) return;                       // never picked up: nobody to wake
    // F25.QA: wakeMailbox only drains a RUNNING (or revivable-paused) record — for a settled
    // author it returns silently, and a diff is most often reviewed AFTER the task finished, so
    // that is the COMMON case, not the edge. Enqueueing anyway would leave the message rotting
    // forever AND, through the coalescing check below, suppress every later wake for this task.
    // supervisor.ts:1845 states the rule this violated ("never a silent drop"), so mirror
    // checkDeliverTargetSettled's non-resume branch: report it undelivered on the event log,
    // which the app renders as a system transcript line (ui-state/reducer.ts, undeliveredMessage).
    // Deliberately NOT resumeForSignal — respawning a finished agent because a human clicked
    // "request changes" spends a turn nobody asked for.
    let authorState: string | undefined;
    try { authorState = this.supervisor.status(agentId).state; } catch { authorState = undefined; }
    if (authorState !== undefined && authorState !== "running" && authorState !== "paused") {
      this.events.append({
        agentId, kind: "status",
        data: {
          undeliveredMessage: true, count: 1, taskId: session.taskId,
          reason: `review changes_requested arrived after the authoring agent settled (${authorState})`,
        },
      });
      return;
    }
    // Coalesce: one undelivered wake per task is enough — the agent calls review_get for the
    // current state anyway, so a second message only spends context.
    const already = this.mailboxes.pending(agentId).some(
      (m) => m.meta?.["reviewWake"] === true && m.meta?.["taskId"] === session.taskId,
    );
    if (already) return;
    const open = session.findings.filter((f) => f.status === "open");
    const lines = [
      `[review] Your task ${session.taskId} was decided changes_requested (revision ${session.decision?.revision ?? 0}).`,
      session.decision?.summary ?? "",
      open.length ? `${open.length} open finding(s):` : "No open findings — the decision summary is the whole request.",
      ...open.slice(0, 20).map((f) => `- ${f.id} [${f.severity}] ${f.path}${f.hunkId ? `#${f.hunkId}` : ""} — ${f.body.slice(0, 200)}`),
      ...(open.length > 20 ? [`(+${open.length - 20} more — call review_get)`] : []),
      `Fix them, then call review_finding_resolve for each one you filed; a blocking finding filed by someone else stays open until its author or the operator clears it.`,
    ].filter(Boolean);
    this.mailboxes.enqueue(agentId, {
      from: "system", kind: "user_message", text: lines.join("\n"),
      meta: { reviewWake: true, taskId: session.taskId, revision: session.decision?.revision ?? 0 },
    });
    this.events.append({
      agentId, kind: "status",
      data: { reviewWake: true, taskId: session.taskId, revision: session.decision?.revision ?? 0, openFindings: open.length },
    });
    this.supervisor.wakeMailbox(agentId);
  }

  // SECRET-MANAGER / GRANT-BY-NAME: an exact agentId wins; otherwise a unique case-insensitive
  // displayLabel match. More than one match REFUSES and lists them — picking one for the operator
  // would mean handing a secret to an agent they did not name.
  private resolveGrantee(agent: string): { agentId: string; label?: string } {
    const records = this.supervisor.list().filter((a) => !a.shadow);
    const exact = records.find((a) => a.agentId === agent);
    if (exact) return { agentId: exact.agentId, ...(exact.displayLabel ? { label: exact.displayLabel } : {}) };
    const q = agent.trim().toLowerCase();
    const byName = records.filter((a) => (a.displayLabel ?? "").toLowerCase() === q);
    if (byName.length === 1) return { agentId: byName[0]!.agentId, label: byName[0]!.displayLabel! };
    if (byName.length > 1) {
      throw new GuardrailError(
        `"${agent}" names ${byName.length} agents (${byName.map((a) => a.agentId.slice(0, 8)).join(", ")}) — grant by agent id, never a guess`,
      );
    }
    throw new UnknownAgentError(`no live agent "${agent}" — grant by its id, or by an exact display name`);
  }

  // TERMINAL-RETENTION: forget finished agents whose end is older than the window. Goes through
  // the SAME supervisor.purgeTerminal the manual "clean up finished" sweep uses, so the guarantee
  // that matters is inherited rather than restated: terminal-only, decided by state alone, with
  // no heuristic here that could widen it to a running or paused record.
  //
  // Recency is agentRecency (the last attempt's endedAt, falling back to createdAt) — the same
  // key the terminal-record CAP already sorts on, so "oldest" means one thing in this daemon.
  private purgeExpiredTerminal(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    const expired = this.supervisor.list()
      .filter((a) => !a.shadow && TERMINAL_AGENT_STATES.has(a.state) && agentRecency(a) < cutoff)
      .map((a) => a.agentId);
    if (expired.length === 0) return;
    const purged = this.supervisor.purgeTerminal(expired);
    for (const agentId of purged) {
      this.agentArchive.remove(agentId);
      this.mailboxes.remove(agentId);
    }
    if (purged.length > 0) {
      this.events.append({
        agentId: "supervisor", kind: "status",
        data: { state: "purged_expired_terminal", count: purged.length, olderThanMs },
      });
    }
  }

  private projectConductorInfo(conductorId: string | null): { agentId: string; state: AgentRecord["state"] } | null {
    if (!conductorId) return null;
    const rec = this.supervisor.list().find((a) => a.agentId === conductorId);
    return rec ? { agentId: rec.agentId, state: rec.state } : null;   // stale reference: the agent is gone
  }

  // coverage B14: decorate scan rows with their effective per-profile policy map
  // ({} ⇒ no policy configured ⇒ allow everywhere).
  private withPolicy(tools: HostToolInfo[]): Array<HostToolInfo & { policy: Record<string, string> }> {
    return tools.map((t) => ({ ...t, policy: this.toolPolicy.policyFor(t.tool) }));
  }

  // ---------- Phase 5: federation surface (spec §15) ----------

  peerConfig(engineId: string): PeerConfig | undefined {
    return (this.cfg.federation?.peers ?? []).find((p) => p.engineId === engineId);
  }
  peerConfigs(): PeerConfig[] { return this.cfg.federation?.peers ?? []; }

  engineCard(): EngineCard {
    return {
      engineId: this.engineId === "local" ? "unfederated" : this.engineId,   // engineCard is only used when federated
      protocolVersion: PROTOCOL_VERSION,
      features: ["federation.v1"],
      providers: [...this.backendsRef.keys()],
      accounts: this.registry.list().map(({ name, provider }) => ({ name, provider })),
      // D8: our ed25519 public key lets an invite-paired responder TOFU-pin us (not a secret).
      ...(this.identity ? { publicKey: this.identity.publicKey } : {}),
    };
  }

  // D8: how a peer reaches THIS engine. Choice (documented): default to our own federation.sock
  // path — correct for same-host/loopback and every test. Cross-machine invites ride an
  // SSH-forwarded socket; the self-SSH-endpoint isn't in config yet (documented residual), so a
  // cross-machine operator supplies the peer's `ssh` block on the joining side as today.
  private selfEndpoint(): PeerEndpoint {
    const base = { socketPath: join(this.home, "federation.sock") };
    if (!this.cloudflareStatus || this.cloudflareStatus.selfprobe !== "passed" ||
        !this.cloudflareStatus.hostname || !this.cloudflareAccessClientId)
      return base;
    // §13d: carry sshd host-key provenance + the remote login user on every endpoint we hand
    // out once Cloudflare is provisioned — both the invite blob AND the reverse-direction
    // pairing card (`pairingCard()` below) need this so the receiver can materialize
    // known_hosts and keep StrictHostKeyChecking=yes with zero interactive prompts.
    const hostKeyLines = this.readHostKeys();
    return {
      ...base,
      cloudflareAccess: { hostname: this.cloudflareStatus.hostname, clientId: this.cloudflareAccessClientId },
      ...(hostKeyLines.length ? { hostKeyLines } : {}),
      sshUser: process.env["USER"] ?? "chimera",
    };
  }

  // The PAIRING card = engineCard + our endpoint, so the responder can pin a reachable socket for
  // the reverse-direction link when it auto-pins us. Ordinary durable-link cards omit the endpoint.
  private pairingCard(): EngineCard {
    return { ...this.engineCard(), endpoint: this.selfEndpoint() };
  }

  private requireFederated(): FederationManager {
    if (!this.federation || !this.identity)
      throw rpcError("protocol", "federation is not configured (no engine.id in config)");
    return this.federation;
  }

  // ---------- D8: responder-side pairing seams (called by the federation server's handshake) ----------
  // A peer never triggers process execution or config reads beyond these: check peeks the invite
  // ledger; onPeerPaired auto-pins the joiner (config.d overlay write) + burns the token + emits
  // peer_paired. The token GRANTS NOTHING beyond pinning — the new peer starts read-only.
  checkInvite(token: string): boolean {
    return this.invites.check(token);
  }

  onPeerPaired(card: EngineCard, token: string): void {
    // TRUE single-use: burnAndGet() is the atomic claim, taken BEFORE any pin/emit. checkInvite()
    // (at hello, pre-proof) is only a peek and cannot gate concurrency — two connections presenting
    // the same leaked token both peek true, so the race must be closed HERE. burnAndGet() atomically
    // marks the one unburned record used and returns it exactly once; onPeerPaired is fully
    // synchronous (no awaits), so under Node's single thread the two post-proof calls run to
    // completion in turn — the first burns→record and pins, the second burns→undefined and bails
    // with no pin, no peer_paired. This also stops the serial same-attacker replay.
    const rec = this.invites.burnAndGet(token);
    if (!rec) return;   // already burned / unknown → default deny, nothing written
    if (!card.publicKey || !card.endpoint) return;   // pairing card guarantees both (token already spent)
    const peerId = card.engineId;
    // §13a: the invite's ephemeral authorized_keys line is no longer time-boxed to the invite —
    // it is now the durable link's key. Retag it (best-effort; absent if no ssh bootstrap ran).
    if (rec.keyTag) {
      try { retagFedKey({ home: this.home, oldTag: rec.keyTag, newTag: peerId, target: "user", userSshDir: this.userSshDir }); } catch { /* best-effort */ }
    }
    const priorPeers = this.cfg.federation?.peers ?? [];
    const idx = priorPeers.findIndex((p) => p.engineId === peerId);
    const base = idx >= 0 ? priorPeers[idx] : undefined;
    // §13e: onPeerPaired UPSERTS instead of early-returning on an already-pinned peer — a
    // re-pair (fresh endpoint / rotated ssh transport) must actually update the peer's
    // endpoint/transport fields. Identity key and grants (allowSpawn/accounts/maxConcurrent)
    // are deliberately preserved from the PRIOR record, not taken from the (re-)presented card —
    // a re-pair is not re-authorization.
    const newPeer = PeerConfigSchema.parse({
      engineId: peerId, publicKey: base?.publicKey ?? card.publicKey,
      socketPath: card.endpoint.socketPath, ...(card.endpoint.ssh ? { ssh: card.endpoint.ssh } : {}),
      allowSpawn: base?.allowSpawn ?? false, accounts: base?.accounts ?? [],
      ...(base?.maxConcurrent !== undefined ? { maxConcurrent: base.maxConcurrent } : {}),
    });
    const peers = idx >= 0 ? priorPeers.map((p, i) => (i === idx ? newPeer : p)) : [...priorPeers, newPeer];
    const { config, changed } = this.configStore.patch({ federation: { peers } });
    this.applyConfig(config, changed);
    this.events.append({
      agentId: "federation", kind: "peer_paired",
      data: { engineId: peerId, direction: "accepted", upserted: idx >= 0 },
    });
  }

  // ---------- D8: joiner-side fed.join (config → tunnel → handshake → paired, per-step) ----------
  private async fedJoin(blob: string): Promise<FedJoinResult> {
    const fed = this.requireFederated();
    const steps: FedJoinStepResult[] = [];
    const priorPeers = this.cfg.federation?.peers ?? [];

    // step "config": parse+validate the blob (exp) and write the PINNED read-only peer.
    let patched: { config: ChimeraConfig; changed: string[] };
    let peerId: string, socketPath: string, peerPublicKey: string, inviteToken: string;
    let endpoint: PeerEndpoint;
    try {
      const parsed = decodePairBlob(blob);   // throws {code:"protocol"} on a bad blob
      if (parsed.exp <= Date.now()) throw rpcError("protocol", "invite expired");
      if (!parsed.card.publicKey) throw rpcError("protocol", "invite card missing publicKey");
      peerId = parsed.card.engineId;
      if (peerId === this.engineId) throw rpcError("protocol", "cannot pair with self");
      endpoint = parsed.endpoint;
      socketPath = parsed.endpoint.socketPath;
      peerPublicKey = parsed.card.publicKey;
      inviteToken = parsed.inviteToken;
      const newPeer = PeerConfigSchema.parse({
        engineId: peerId, publicKey: peerPublicKey, socketPath,
        ...(parsed.endpoint.ssh ? { ssh: parsed.endpoint.ssh } : {}),
        allowSpawn: false, accounts: [],
      });
      patched = this.configStore.patch({ federation: { peers: [...priorPeers.filter((x) => x.engineId !== peerId), newPeer] } });
      steps.push({ step: "config", ok: true });
    } catch (err) {
      return { steps: [{ step: "config", ok: false, error: stepError(err) }], paired: null };
    }
    // §13a/b/d: joiner-side ssh-layer credential bootstrap — write the shown-once ephemeral
    // identity key, authorize the inviter's durable fed_ssh_key.pub, and materialize its sshd
    // host keys, so the very FIRST ssh -N connection (SshTunnelSupervisor, next step) has
    // something to authenticate with and a pinned host key to check against. Absent on a
    // same-host/loopback invite (no bootstrap fields in the blob) — behavior stays byte-identical.
    let wroteIdentityKey = false, wroteAuthorizedKey = false, wroteKnownHosts = false;
    const bootstrapHostname = endpoint.cloudflareAccess?.hostname ?? endpoint.ssh?.host;
    const parsedAgain = decodePairBlob(blob);   // re-decode to reach the shown-once fields (never stored)
    const needsBootstrap = !!(parsedAgain.inviteKeyPrivate || parsedAgain.fedSshPublicKey || endpoint.hostKeyLines?.length);
    // A same-host/loopback invite carries none of these — skip the step ENTIRELY (no "sshkeys"
    // entry at all) so the steps[] shape stays byte-identical to pre-§13 for every existing test.
    if (needsBootstrap) try {
      if (parsedAgain.inviteKeyPrivate) {
        writeIdentityKeyFile({ home: this.home, peerEngineId: peerId, privateKey: parsedAgain.inviteKeyPrivate });
        wroteIdentityKey = true;
      }
      if (parsedAgain.fedSshPublicKey) {
        acceptFedKey({ home: this.home, engineId: peerId, publicKey: parsedAgain.fedSshPublicKey, target: "user", userSshDir: this.userSshDir });
        wroteAuthorizedKey = true;
      }
      if (endpoint.hostKeyLines?.length && bootstrapHostname) {
        materializeKnownHosts({ home: this.home, hostname: bootstrapHostname, hostKeyLines: endpoint.hostKeyLines });
        wroteKnownHosts = true;
      }
      steps.push({ step: "sshkeys", ok: true });
    } catch (err) {
      steps.push({ step: "sshkeys", ok: false, error: stepError(err) });
      if (wroteIdentityKey) removeIdentityKeyFile({ home: this.home, peerEngineId: peerId });
      if (wroteAuthorizedKey) removeFedKey({ home: this.home, tag: peerId, target: "user", userSshDir: this.userSshDir });
      if (wroteKnownHosts && bootstrapHostname) removeKnownHostsEntries({ home: this.home, hostname: bootstrapHostname });
      try { this.configStore.patch({ federation: { peers: priorPeers } }); } catch { /* best-effort */ }
      return { steps, paired: null };
    }

    // Roll the overlay write back if a later step fails, so a failed join leaves no dangling peer —
    // §13f extends this to the ssh-layer artifacts §13a/b/d just wrote.
    const rollback = () => {
      try { this.configStore.patch({ federation: { peers: priorPeers } }); } catch { /* best-effort */ }
      if (wroteIdentityKey) removeIdentityKeyFile({ home: this.home, peerEngineId: peerId });
      if (wroteAuthorizedKey) removeFedKey({ home: this.home, tag: peerId, target: "user", userSshDir: this.userSshDir });
      if (wroteKnownHosts && bootstrapHostname) removeKnownHostsEntries({ home: this.home, hostname: bootstrapHostname });
    };

    // step "tunnel": probe socket reachability (a dead forward fails here, distinctly).
    try {
      await probeTunnel(socketPath);
      steps.push({ step: "tunnel", ok: true });
    } catch (err) {
      steps.push({ step: "tunnel", ok: false, error: stepError(err) });
      rollback();
      return { steps, paired: null };
    }

    // step "handshake": one-shot pairing handshake carrying the invite token (responder auto-pins us).
    try {
      await runPairingHandshake({
        socketPath, identity: this.identity!, card: this.pairingCard(),
        expectedPeerId: peerId, peerPublicKey, inviteToken,
      });
      steps.push({ step: "handshake", ok: true });
    } catch (err) {
      steps.push({ step: "handshake", ok: false, error: stepError(err) });
      rollback();
      return { steps, paired: null };
    }

    // step "paired": activate the durable link (add via applyConfig) + emit peer_paired.
    this.applyConfig(patched.config, patched.changed);
    void fed;   // link is (re)built by applyFederationDiff above
    this.events.append({ agentId: "federation", kind: "peer_paired", data: { engineId: peerId, direction: "joined" } });
    steps.push({ step: "paired", ok: true });
    return { steps, paired: peerId };
  }

  // handlePeer is the executor-side peer AUTHZ boundary (default deny, spec §3.3).
  // It is intentionally a SEPARATE entrypoint from handle() — never delegate INTO
  // it from handle(), and never widen handle()'s own method table to cover peer
  // traffic. The try/catch below duplicates handle()'s zod/.code error
  // normalization on purpose: handle() itself is Phase 1-4 LOCKED and must stay
  // byte-for-byte untouched (extracting a shared helper would mean editing it).
  async handlePeer(peerEngineId: string, method: string, params: unknown): Promise<unknown> {
    try {
      const peer = this.peerConfig(peerEngineId);
      if (!peer) throw rpcError("peer-auth", `unknown peer "${peerEngineId}"`);
      if (!isPeerMethod(method)) throw rpcError("protocol", `method "${method}" is not available to peers`);

      const requireBare = (agentId: string) => {
        if (parseAgentAddress(agentId).engineId !== null)
          throw rpcError("protocol", "qualified agent ids are not accepted over a peer link (no transitive relay)");
      };
      // Trust-boundary redaction (spec §6, Phase-5 deferred MUST): supervisor.status/result
      // return record.resultText RAW (onEvent only scrubs appended event data, never this
      // field) — every peer-facing response that can carry it MUST be scrubbed against the
      // EXECUTING supervisor's injected credentials before crossing the peer link.
      const scrubRec = (r: AgentRecord): AgentRecord =>
        r.resultText !== undefined ? { ...r, resultText: this.supervisor.redactForPeer(r.resultText) } : r;

      switch (method) {
        case "peer.status": {
          const counts = { running: 0, paused: 0, done: 0, failed: 0, killed: 0 };   // "paused": session-limit HOLD
          for (const a of this.supervisor.list()) if (!a.shadow) counts[a.state]++;   // Task N-SHADOW: real agents only (see daemon.status)
          // WD Stage 2 (coverage B14): ADDITIVE — this engine's own host-tool summary
          // for the requester's read-only remote rows. Served from the LAST COMPLETED
          // local scan only (null before one): a peer must never be able to trigger
          // process execution here. POLICY IS THE EXECUTING ENGINE'S (federation
          // grant rule): the policy maps below are what THIS engine enforces on its
          // own spawns — a requester renders them read-only and cannot edit them.
          const scanned = this.hostTools.cached();
          return {
            engineId: this.engineId, protocolVersion: PROTOCOL_VERSION, agents: counts,
            hostTools: scanned ? { host: this.engineId, tools: this.withPolicy(scanned) } : null,
          };
        }
        case "accounts.list": {
          const names = this.registry.list().map(({ name, provider }) => ({ name, provider }));
          return peer.accounts === "auto" ? names : names.filter((a) => (peer.accounts as string[]).includes(a.name));
        }
        case "agent.spawn": {
          const p = z.object({
            spec: z.unknown(), spawnId: z.string().min(1),
            depth: z.number().int().min(0).optional(), maxDepthCap: z.number().int().positive().optional(),
          }).parse(params);
          if (!peer.allowSpawn) throw rpcError("guardrail", `peer "${peerEngineId}" is not granted spawn (allowSpawn: false)`);
          const cacheKey = `${peerEngineId}:${p.spawnId}`;
          const existing = this.fedSpawnIds.get(cacheKey);
          if (existing) return scrubRec(this.supervisor.status(existing));   // idempotent retry — never double-spawn
          const spec = resolveAgentSpec(p.spec);
          assertFederationSafeSpec(spec);
          const granted = peer.accounts === "auto"
            || (spec.account !== "auto" && (peer.accounts as string[]).includes(spec.account));
          if (!granted) throw rpcError("guardrail", `peer "${peerEngineId}" is not granted account "${spec.account}"`);
          const principal = `peer:${peerEngineId}`;
          const runningForPeer = this.supervisor.list().filter((a) => !a.shadow && a.principal === principal && a.state === "running").length;   // Task N-SHADOW: shadows never count against a peer's concurrency cap
          if (runningForPeer >= peer.maxConcurrent)
            throw rpcError("guardrail", `peer "${peerEngineId}" at maxConcurrent (${peer.maxConcurrent})`);
          // Remote-supplied depth/maxDepthCap are ADVISORY — LOCAL caps stay authoritative
          // (supervisor.spawn's own maxDepthCap guardrail enforces this, unchanged from Phase 1).
          const rec = await this.supervisor.spawn(spec, { depth: p.depth ?? 0, maxDepthCap: p.maxDepthCap, principal });
          this.fedSpawnIds.set(cacheKey, rec.agentId);
          return scrubRec(rec);
        }
        case "mailbox.forward": {
          const p = MailboxForwardParamsSchema.parse(params);
          requireBare(p.agentId);
          if (this.mailboxes.hasMessage(p.agentId, p.message.id)) return { ok: true, deduped: true };
          const bareFrom = parseAgentAddress(p.message.from).localId;
          this.mailboxes.enqueue(p.agentId, {
            ...p.message,
            from: formatAgentAddress(peerEngineId, bareFrom),              // origin authenticated, never claimed
            engineId: peerEngineId,
          });
          // PLAN-HOOKS.md §4.3 gap fix (c): this enqueue used to just sit there until the NEXT
          // natural turn boundary (agent_started/turn_complete) — nothing here ever called
          // deliverPending, so a federated message could wait arbitrarily long for an idle
          // running target it could have woken instantly. this.supervisor.wakeMailbox is a
          // no-op unless `p.agentId` is currently running, same as every other deliverPending call.
          this.supervisor.wakeMailbox(p.agentId);
          return { ok: true };
        }
        case "agent.send": {
          const p = z.object({ agentId: z.string(), text: z.string().min(1), from: z.string().default("caller") }).parse(params);
          requireBare(p.agentId);
          return this.handle("agent.send", { ...p, from: formatAgentAddress(peerEngineId, parseAgentAddress(p.from).localId) });
        }
        case "agent.status": {
          const { agentId } = Id.parse(params);
          requireBare(agentId);
          return scrubRec(await this.handle("agent.status", params) as AgentRecord);
        }
        case "agent.result": {
          const { agentId } = Id.parse(params);
          requireBare(agentId);
          const res = await this.handle("agent.result", params) as { state: string; text?: string; costUsd: number };
          return res.text !== undefined ? { ...res, text: this.supervisor.redactForPeer(res.text) } : res;
        }
        default: {   // agent.kill | agent.tail — nothing sensitive to scrub (kill returns {ok:true}; tail events are already scrubbed at append)
          const agentId = (params as { agentId?: string })?.agentId;
          if (agentId) requireBare(agentId);
          return this.handle(method, params);
        }
      }
    } catch (err) {
      if (err instanceof z.ZodError) throw rpcError("protocol", err.issues.map((i) => i.message).join("; "));
      const e = err as { code?: string; message?: string };
      if (typeof e.code === "string" && typeof e.message === "string") throw rpcError(e.code, e.message);
      throw rpcError("unknown", String((err as Error).message ?? err));
    }
  }
}
