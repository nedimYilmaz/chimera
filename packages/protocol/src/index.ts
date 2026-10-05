import { z } from "zod";
import { VoiceLimitsSchema } from "./voice-rooms.js";

export const PROTOCOL_VERSION = 1;

/** Bounded target set and partial-result envelope for fleet mutations. */
export const AgentBulkParamsSchema = z.object({
  agentIds: z.array(z.string().min(1)).min(1).max(100),
}).strict();
export type AgentBulkParams = z.infer<typeof AgentBulkParamsSchema>;
export const AgentBulkResultSchema = z.object({
  requested: z.number().int().nonnegative(),
  succeeded: z.array(z.string()),
  failed: z.array(z.object({ agentId: z.string(), error: z.string() }).strict()),
}).strict();
export type AgentBulkResult = z.infer<typeof AgentBulkResultSchema>;

// AGENT-BULK-SEND / AGENT-BULK-RESUME: the two fan-out operations the batch surface was missing.
// hold/release already take an agentIds array, and killMany/interruptMany already exist — so
// "pause, kill and interrupt several at once" worked while "tell several the same thing" and
// "pick several up again" did not, which is the pair an operator returning to a stopped fleet
// actually needs.
//
// Same {requested, succeeded, failed} result as the other two: PARTIAL SUCCESS is the normal
// outcome of a fan-out (one agent is terminal, another's workdir is gone), and a call that threw
// on the first refusal would leave the operator with no idea which of the rest went through.
export const AgentBulkSendParamsSchema = z.object({
  agentIds: z.array(z.string().min(1)).min(1).max(100),
  text: z.string().min(1),
  from: z.string().optional(),
}).strict();
export type AgentBulkSendParams = z.infer<typeof AgentBulkSendParamsSchema>;

export const AgentBulkResumeParamsSchema = z.object({
  agentIds: z.array(z.string().min(1)).min(1).max(100),
  prompt: z.string().min(1),
  maxTurns: z.number().int().positive().optional(),
  turnLimitPolicy: z.enum(["fail", "soft"]).optional(),
}).strict();
export type AgentBulkResumeParams = z.infer<typeof AgentBulkResumeParamsSchema>;

// QUOTA-UNCOOL: agent.release's own params — a superset of AgentBulkParams (which stays
// `.strict()` and shared with agent.hold, so `force` could not simply be added there).
// `force` is the EXPLICIT override for a "session-limit" pause: the default refusal exists
// because resuming such an agent early normally restarts it into the very limit that parked it,
// but an operator who has just seen the account's window roll knows better than the parsed error
// string that set the hold. Deliberately narrow — it does NOT release a crash-backoff pause
// (nothing about a quota reading says a crashing agent stopped crashing) and it does NOT touch
// the account cooldown (accounts_uncool is the account-level verb).
export const AgentReleaseParamsSchema = z.object({
  agentIds: z.array(z.string().min(1)).min(1).max(100),
  force: z.boolean().default(false),
}).strict();
export type AgentReleaseParams = z.infer<typeof AgentReleaseParamsSchema>;

// QUOTA-UNCOOL: the operator's account-level "the quota is actually back, stop avoiding this
// account" verb. Clears the failover/session-limit cooldown stamp AND resumes every agent parked
// with pauseReason "session-limit" on that account — the two halves have to happen together, or
// the account becomes routable again while the agents that were holding for it stay parked.
export const AccountUncoolParamsSchema = z.object({
  name: z.string().min(1),
}).strict();
export type AccountUncoolParams = z.infer<typeof AccountUncoolParamsSchema>;
export const AccountUncoolResultSchema = z.object({
  account: z.string(),
  // false when the account was not cooling at all — NOT an error (the desired end state already
  // held), and `resumed` can still be non-empty: a paused agent outlives a cooldown stamp across
  // a daemon restart (CooldownTracker is in-memory, AgentRecord.resumeAt is persisted).
  wasCooling: z.boolean(),
  clearedUntil: z.number().nullable(),   // the cooldown deadline that was dropped, for the audit trail
  resumed: z.array(z.string()),
}).strict();
export type AccountUncoolResult = z.infer<typeof AccountUncoolResultSchema>;

// Ad-hoc sessions design §5: rename a live agent's user-facing identity post-spawn (a session
// names itself after its first turn, using its own topic — never the raw URL/question it started
// from). Trims the same way AgentSpecSchema.displayLabel does; agentId is stamped from ctx by the
// MCP tool layer (rename_self), never accepted as a caller-controlled arg through that path — this
// schema itself stays a plain RPC params shape since the daemon-RPC layer has no such convention.
// AGENT-RECONFIGURE: one sparse patch over an agent's settings, applied in ONE respawn into its
// own session. `live` fields beside it are applied without any respawn at all — the engine routes
// them to their existing live setters, so a save that only touches a permission or a name never
// interrupts a running turn.
export const AgentReconfigureParamsSchema = z.object({
  agentId: z.string().min(1),
  // Loose on purpose: the reconfigurable set is an allowlist in core (RECONFIGURABLE_KEYS), and
  // restating it here as a second schema is exactly the kind of parallel list this codebase has
  // twice been bitten by. core validates and names the offending key.
  patch: z.record(z.string(), z.unknown()).default({}),
  // The no-respawn half, each already served by its own live setter.
  live: z.object({
    permissionProfile: z.enum(["readOnly", "acceptEdits", "full"]).optional(),
    permissionRequest: z.enum(["auto", "poke:caller", "tui"]).optional(),
    groups: z.array(z.string()).optional(),
    displayLabel: z.string().trim().min(1).optional(),
  }).default({}),
  // Moving the agent's workspace is its own operation (worktree handling, history check) — routed
  // to rebind rather than duplicated, but accepted here so one save can do everything.
  cwd: z.string().min(1).optional(),
}).strict();
export type AgentReconfigureParams = z.infer<typeof AgentReconfigureParamsSchema>;

// SECRET-MANAGER: the operator surface (never exposed over MCP) plus the two agent-facing reads,
// which are keyed on the CALLER's own agentId by the engine — never on a parameter, so an agent
// can never ask on another agent's behalf.
export const SecretNameParams = z.object({ name: z.string().min(1) }).strict();
export const SecretSetParams = z.object({
  name: z.string().min(1),
  // The ONLY place a value crosses this boundary. It goes straight to the keychain; no response,
  // event, log line or error message ever carries it back.
  value: z.string().min(1),
  description: z.string().nullable().optional(),
}).strict();
export const SecretGrantModeSchema = z.enum(["inject", "reveal"]);
export type SecretGrantMode = z.infer<typeof SecretGrantModeSchema>;
export const SecretGrantParams = z.object({
  name: z.string().min(1),
  // An agent id OR an exact display name — the operator thinks in names and the UI picker lists
  // live agents by name. Ambiguity is refused, never guessed.
  agent: z.string().min(1),
  mode: SecretGrantModeSchema,
}).strict();
export const SecretRevokeParams = z.object({ name: z.string().min(1), agent: z.string().min(1) }).strict();
export const SecretForAgentParams = z.object({ agentId: z.string().min(1) }).strict();
export const SecretReadParams = z.object({ name: z.string().min(1), agentId: z.string().min(1) }).strict();

export const AgentRenameParamsSchema = z.object({
  agentId: z.string().min(1),
  displayLabel: z.string().trim().min(1),
  // OPERATOR-RENAME: which side is asking. `true` marks the AGENT renaming itself (rename_self,
  // the only MCP caller) and keeps the one-shot: an agent gets exactly one free name and can
  // never overwrite one a person chose. Absent — every operator surface, and the only shape a
  // human-facing UI/CLI ever sends — always applies. Defaults to the operator, so a caller that
  // omits it is never silently treated as an agent and denied a rename it is entitled to.
  self: z.boolean().default(false),
});
export type AgentRenameParams = z.infer<typeof AgentRenameParamsSchema>;

// F21/D17: client capability strings a `subscribe` call may declare via its optional
// `clientCaps` param, so the daemon can tailor what it injects into a fresh spawn's
// system prompt to what the connected client can actually render. Currently just one
// (the F21 output-component vocabulary cheatsheet, see core/output-components.ts) —
// unrecognized strings are ignored by the daemon (forward-compatible allowlist, no
// protocol version bump needed to add a future capability).
export const CLIENT_CAP_UI_COMPONENTS = "ui.components";

// ---------- agent addressing (federation pre-provision) ----------
// "/" is RESERVED as the engine-qualifier separator in every id-valued field
// (agentId, deliverTo, ...). Phase 1 ids never contain "/"; Phase 5 federation
// introduces "<engineId>/<localId>" addresses. agentId is opaque otherwise —
// never parse it except through parseAgentAddress.

export function parseAgentAddress(id: string): { engineId: string | null; localId: string } {
  const slash = id.indexOf("/");                    // split on the FIRST "/"; null engineId = local
  if (slash === -1) return { engineId: null, localId: id };
  return { engineId: id.slice(0, slash), localId: id.slice(slash + 1) };
}

export function formatAgentAddress(engineId: string | null, localId: string): string {
  return engineId === null ? localId : `${engineId}/${localId}`;
}

// ---------- accounts / config ----------
// F23-0D: widened from a closed enum (the 5 claude/codex-specific names) to any
// non-empty env-var-shaped string — the F23-0D provider catalog (packages/core/src/
// providers/catalog.ts) assigns each of its ~17 providers its own conventional key env
// var (XAI_API_KEY, DEEPSEEK_API_KEY, ...), none of which fit the old fixed set. Purely
// additive: every existing literal value is still a valid non-empty string, so old
// configs parse byte-identically.
const InjectAs = z.string().min(1);
const HomeDir = z.string().min(1).optional();   // provider config dir (CODEX_HOME / CLAUDE_CONFIG_DIR)
// F23 D4 (subscription tokens): tokenRef is the keychain SERVICE NAME holding the token
// JSON at rest — { accessToken, refreshToken?, expiresAt, accountMeta? } — NEVER the token
// itself (mirrors the "keychain" variant's service-name-not-secret shape above). Resolved by
// CredentialResolver's "oauth" case (packages/core/src/credentials.ts) via an OAuthTokenStore
// (F23-0D), which also handles refresh-before-expiry; F23-0A only stubs that case to throw.
// SUBSCRIPTION-CONNECT: the "default-login" auth type (the provider CLI's own ambient
// login) is user-facing-named "subscription" — renamed at the wire/config level too, not
// just display. MIGRATION: a preprocess step maps the legacy literal "default-login" (every
// config on disk before this change, e.g. the "main" claude account) to "subscription"
// BEFORE the discriminated union validates, so old configs keep parsing byte-identically —
// they just come out the other side already migrated. ConfigStore persists the migrated
// value back to disk on the next write (ordinary patch/save path); nothing here rewrites
// config.json itself (this schema has no filesystem access).
// OAUTH-TOKEN-ACCOUNTS: what KIND of secret a "keychain" account's stored value is —
// distinct from AccountAuth's own "oauth"/"keychain" TYPE discriminant (that's the
// STORAGE/refresh mechanism; this is the credential's SHAPE within the plain-keychain
// path). A user can paste any of three Anthropic key shapes into accounts.setKey:
//   apiKey     — sk-ant-api03-... (or any other provider's plain bearer key). Injected
//                as ANTHROPIC_API_KEY (x-api-key header at the API).
//   oauthToken — sk-ant-oat01-... (a `claude setup-token` Pro/Max OAuth access token,
//                the SAME token the Claude Code CLI accepts via CLAUDE_CODE_OAUTH_TOKEN —
//                see AUTH_VARS in backends/claude.ts). Injected as CLAUDE_CODE_OAUTH_TOKEN,
//                NOT ANTHROPIC_API_KEY — the two env vars gate different auth paths and
//                the CLI's own precedence order puts ANTHROPIC_API_KEY ahead of it, so
//                misclassifying an oauth token as an apiKey silently defeats it.
//   adminKey   — sk-ant-admin-... (an Organization Admin API key). This can manage the
//                org/workspace but CANNOT call the Messages API — an account holding one
//                will always fail to spawn agents. Flagged explicitly (not silently
//                treated as apiKey) so the UI can warn instead of showing a bare "invalid".
// Absent on an old/pre-existing keychain account (nothing ever classified its key) —
// callers default that case to "apiKey", the historical unconditional behavior.
export const CredentialTypeSchema = z.enum(["apiKey", "oauthToken", "adminKey"]);
export type CredentialType = z.infer<typeof CredentialTypeSchema>;

const AccountAuthUnion = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscription"), homeDir: HomeDir }).strict(),
  z.object({ type: z.literal("keychain"), service: z.string().min(1), injectAs: InjectAs, homeDir: HomeDir, credentialType: CredentialTypeSchema.optional() }).strict(),
  z.object({ type: z.literal("env"), var: z.string().min(1), injectAs: InjectAs, homeDir: HomeDir }).strict(),
  z.object({ type: z.literal("command"), run: z.string().min(1), injectAs: InjectAs, homeDir: HomeDir }).strict(),
  z.object({ type: z.literal("oauth"), provider: z.string().min(1), tokenRef: z.string().min(1), homeDir: HomeDir }).strict(),
]);
export const AccountAuthSchema = z.preprocess((val) => {
  if (val && typeof val === "object" && (val as { type?: unknown }).type === "default-login") {
    return { ...(val as object), type: "subscription" };
  }
  return val;
}, AccountAuthUnion);
export type AccountAuth = z.infer<typeof AccountAuthUnion>;

export const AccountConfigSchema = z.object({
  name: z.string().min(1),
  // F23 D3: widened from z.enum(["claude","codex"]) — any non-empty provider id now
  // parses; the finite set of KNOWN providers becomes a runtime registry lookup
  // (F23-0D's catalog/registry) instead of a parse-time constraint, so adding a new
  // provider never needs a protocol change again. An unrecognized id still parses
  // cleanly and fails LATER as a clean spawn-time error rather than a Zod rejection
  // far from the actual mistake. `.default("claude")` unchanged — old configs parse
  // byte-identically.
  provider: z.string().min(1).default("claude"),
  auth: AccountAuthSchema,
  // COMPACTION-THRESHOLD-CONFIG: optional per-ACCOUNT override of the per-provider
  // compactionThreshold below (ProviderOverrideSchema) — takes precedence over the
  // provider-level value when set. Optional with no default so old configs parse
  // byte-identically. Explicit `null` means "this account uses the backend's NATIVE
  // compaction" and short-circuits the whole chain (it does NOT fall through to the
  // provider rung or the fleet default) — see ProviderOverrideSchema.compactionThreshold
  // for the full semantics and the config-file caveat that null carries.
  compactionThreshold: z.number().int().positive().nullable().optional(),
}).strict();
export type AccountConfig = z.infer<typeof AccountConfigSchema>;

// ---------- account quota meters (ACCOUNT-QUOTA-METERS) ----------
// Claude subscription/OAuth accounts expose quota data through the Agent SDK's
// SDKRateLimitEvent (rate_limit_info: SDKRateLimitInfo, sdk.d.ts)
// reports ONE window (rateLimitType: 'five_hour' | 'seven_day'/'seven_day_opus'/
// 'seven_day_sonnet'/'seven_day_overage_included' | 'overage') per event, with `utilization`
// and `resetsAt`. Phase 0 found this event fires only near a limit (empirically: not once
// across an entire multi-agent wave under normal use), so Phase 1 added a PULL source —
// quota-poll.ts's QuotaPoller hits Claude Code's own `GET /api/oauth/usage` on a timer and
// feeds the SAME tracker. `usedFraction` is a 0..1 fraction STORED here, but every UPSTREAM
// source (both the SDK event's `utilization` and the REST poll's `five_hour`/`seven_day`
// `.utilization`) reports 0..100 PERCENT — verified live by cross-referencing the REST
// response's `five_hour.utilization: 1.0` against its own `limits[].percent: 1` for the same
// window (see claude.ts's normalizeClaudeRateLimit and quota-poll.ts's normalizeClaudeUsagePoll,
// which both divide by 100 unconditionally before this schema ever sees the value). Codex's
// exec-JSON event stream has no equivalent, so quota-poll.ts queries the CLI's read-only
// `account/rateLimits/read` app-server method in a short-lived side process and normalizes its
// `usedPercent`/`windowDurationMins`/`resetsAt` snapshot into this same shape. `windowStartedAt`
// is DERIVED (resetsAt - known window length: 5h for "session", 7d for "weekly") since none of
// the upstream sources report a window-start field directly.
export const AccountQuotaWindowSchema = z.object({
  kind: z.enum(["session", "weekly"]),
  usedFraction: z.number().min(0).max(1),
  windowStartedAt: z.number(),
  resetsAt: z.number(),
  // WEEKLY-QUOTA-VARIANT-KEYS: the provider can report MULTIPLE simultaneous weekly buckets for
  // one account (e.g. seven_day_opus AND seven_day_sonnet on a plan with model-split weekly
  // limits) — normalizeClaudeUsagePoll picks the most-constraining one (highest utilization, the
  // safest default for a meter that exists to warn about running out) and names it here so the
  // UI never shows an unlabelled percentage that could be misread as blended usage. Absent for
  // the ordinary single-bucket case and always absent on "session" (five_hour has no variant).
  variant: z.string().min(1).optional(),
}).strict();
export type AccountQuotaWindow = z.infer<typeof AccountQuotaWindowSchema>;

// One per account; windows accumulate as rate_limit_event messages trickle in across a
// session (the SDK reports one window kind at a time) — see core's QuotaTracker.
// EXTRA-USAGE-VISIBILITY: the SECOND allowance. When a plan's rolling window is exhausted, an
// account may still be able to continue on extra usage (overage) — a SPEND-CREDIT budget, not a
// rolling time window, which is exactly why it cannot live in `windows[]` and why the event path
// used to drop it on the floor. Dropping it meant chimera held an agent until reset while unable
// to say whether that hold was even necessary, and the operator had no view of the allowance the
// provider's own UI shows them.
//
// OBSERVABILITY ONLY, deliberately. The SDK exposes no way to ENABLE extra usage (it is an
// account/org setting) and no priority-tier control at all — Claude Code's own `/low-priority` is
// a CLI feature with no Agent SDK counterpart at 0.3.246. So this records what the provider says
// and never infers what it would do: whether a `rejected` primary window plus an `allowed`
// overage means a retry would succeed is provider behaviour we have not observed, and inventing
// it is precisely the mistake QUOTA-METER-WRONG-BY-100X (backends/claude.ts) documents.
export const AccountOverageSchema = z.object({
  // The provider's own verdict on whether overage may be used right now.
  status: z.enum(["allowed", "allowed_warning", "rejected"]).nullable(),
  // Why it may NOT be, when it may not — the difference between "out of credits" and "your org
  // turned it off", which are the same blocked state with completely different remedies.
  disabledReason: z.string().nullable(),
  // True while the account is ACTIVELY billing against overage rather than its included quota.
  inUse: z.boolean().nullable(),
  resetsAt: z.number().nullable(),
  // Credit budget, when the provider reports it (the usage control channel, not the event path).
  monthlyLimit: z.number().nullable(),
  usedCredits: z.number().nullable(),
  usedFraction: z.number().min(0).max(1).nullable(),
  currency: z.string().nullable(),
  observedAt: z.number(),
}).strict();
export type AccountOverage = z.infer<typeof AccountOverageSchema>;

export const AccountQuotaSchema = z.object({
  account: z.string(),
  windows: z.array(AccountQuotaWindowSchema),
  fetchedAt: z.number(),   // wall-clock ms of the last window update — staleness check
  // Absent for every account that has never reported one (API key, Bedrock, Vertex, or a plan
  // without extra usage). Absent is NOT "disabled" — it is "unknown", and the UI must say so
  // rather than render a confident zero.
  overage: AccountOverageSchema.nullish(),
}).strict();
export type AccountQuota = z.infer<typeof AccountQuotaSchema>;

// QUOTA-ABSENCE-IS-INVISIBLE: an account with no quota WINDOWS (no AccountQuota, or one with an
// empty `windows` array) is otherwise indistinguishable in the UI from "this auth type has no
// limits", "the poll is failing", and "the poll just hasn't run yet" — all three render as
// nothing. This is the per-account WHY, recorded by QuotaTracker.recordReason alongside (never
// instead of) the real windows, so a persistent failure stays honestly visible without ever
// fabricating a quota figure:
//   - "unsupported": resolveUsageToken (quota-poll.ts) found no credential path for this
//     account's provider/auth-type combination — polling was never attempted, nothing is wrong.
//     `detail` names the SPECIFIC branch (wrong provider, wrong credentialType, homeDir
//     override, non-darwin host, keychain read/parse failure, ...) so the UI can distinguish
//     "we don't support this" from "we tried and failed" instead of collapsing both to a dash.
//   - "rate_limited": the endpoint answered 429 — the credential is fine, back off (see
//     QuotaPoller's rateLimitedUntil), don't mark the account broken.
//   - "http_error": any other non-2xx (401/403 = bad/expired credential, etc) — carries the
//     real status code, never a guessed one.
//   - "network_error": fetch itself failed (timeout/DNS/ECONNRESET) before a status existed.
//   - "empty": the request succeeded but the response carried no five_hour/seven_day windows
//     (e.g. an API-key-only account) — success, just nothing to show.
//   - "ok": the request succeeded and produced at least one window — the UI prefers rendering
//     the actual bars over this line, so it's mostly a marker for tests/debugging.
//   - "implausible": QuotaTracker.record (failover.ts) rejected a window whose resetsAt/
//     windowStartedAt resolve outside a sane epoch-ms range (e.g. near 1970 — the signature of a
//     seconds value propagated where milliseconds were expected; see QUOTA-METER-WRONG-BY-100X
//     in claude.ts) — a garbled window is NEVER stored (the tracker keeps its last good value for
//     that kind), `detail` names which check failed. Extends the "never fabricate" policy
//     (quota-poll.ts) to "never propagate a provably impossible value" into routing/backpressure.
export const AccountQuotaReasonSchema = z.object({
  kind: z.enum(["unsupported", "rate_limited", "http_error", "network_error", "empty", "ok", "implausible"]),
  httpStatus: z.number().optional(),
  detail: z.string().optional(),   // network_error's error message, or "unsupported"'s specific
                                    // decline reason — never a credential value in either case
  at: z.number(),                  // wall-clock ms of this attempt (or non-attempt classification)
  // "rate_limited" ONLY: wall-clock ms of the next poll attempt (server's Retry-After when the
  // 429 carried one, else the poller's own backoff floor) — lets the UI say "retrying at HH:MM"
  // instead of only "last tried HH:MM", which told the user nothing actionable. Optional so
  // every other kind, and any 429 without a parseable Retry-After, is unaffected.
  nextRetryAt: z.number().optional(),
}).strict();
export type AccountQuotaReason = z.infer<typeof AccountQuotaReasonSchema>;

// ---------- provider catalog (F23 D3/D4) ----------
// One ProviderProfile per LLM provider the daemon knows how to drive — the "1 catalog
// entry = 1 supported provider" seam (packages/core/src/providers/catalog.ts,registry.ts,
// F23-0D). `kind` picks the driver family: "agentic-sdk" (claude/codex — untouched
// existing wrapper backends), "openai-compat" (fetch+SSE ChatClient, F23-0B, covers ~10
// providers off one implementation), "native" (a provider-specific ChatClient, e.g.
// Gemini's v1beta). `models` is a fallback list used when `modelsEndpoint` isn't queried
// (or fails) — never the sole source of truth once a live model list is available.
// `authModes` declares which AccountAuth variants this provider accepts; "oauth" entries
// carry a matching `oauth` sub-profile (PKCE/device-code details, F23-2A). `capabilities`
// feeds the providers.list RPC (D5) for Settings UI capability chips + the spawn-time
// vision guard. `tosNote` surfaces subscription-flow terms-of-service caveats in the UI
// (D4's "TOS honesty rule") — some subscription flows are official, some gray-area; the
// operator decides, chimera just discloses.
export const OAuthProfileSchema = z.object({
  authorizeUrl: z.string().min(1).optional(),   // absent for device-code-only flows
  tokenUrl: z.string().min(1).optional(),
  deviceCodeUrl: z.string().min(1).optional(),  // present for device-code flows (e.g. Copilot, Qwen)
  scopes: z.array(z.string()).default([]),
  clientId: z.string().min(1).optional(),
}).strict();
export type OAuthProfile = z.infer<typeof OAuthProfileSchema>;

export const ProviderCapabilitiesSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  streaming: z.boolean(),
  // VOICE S2: realtime full-duplex speech (OpenAI Realtime-family only; Claude has no native
  // speech API — see docs/superpowers/specs/2026-07-24-voice-agents-design.md §R2b/§8). Optional
  // so existing catalog entries stay untouched; absent means false. S3 sets it explicitly per
  // provider.
  realtime: z.boolean().optional(),
}).strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ProviderProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["agentic-sdk", "openai-compat", "native"]),
  baseUrl: z.string().min(1),
  chatPath: z.string().min(1).optional(),
  authHeader: z.string().min(1).optional(),     // header name override; default "Authorization" (Bearer) at the ChatClient
  defaultModel: z.string().min(1),
  models: z.array(z.string().min(1)).default([]),
  modelsEndpoint: z.string().min(1).optional(),
  authModes: z.array(z.enum(["apiKey", "oauth"])).min(1),
  oauth: OAuthProfileSchema.optional(),
  capabilities: ProviderCapabilitiesSchema,
  extraHeaders: z.record(z.string(), z.string()).optional(),
  tosNote: z.string().optional(),
  // F23-1B: per-provider request timeout override, milliseconds. Most providers are fine
  // with the fetch default; moonshot documents a 2h request timeout (long agentic turns are
  // expected) so its catalog entry sets this generously instead of the transport's implicit
  // per-fetch behavior. Threaded through OpenAICompatConfig.timeoutMs (registry.ts).
  timeoutMs: z.number().int().positive().optional(),
  // F23-0D: the conventional env var this provider's API key/bearer token is injected
  // as — both accounts.add's keychain-account `injectAs` default AND CredentialResolver's
  // "oauth" case's `{envVar, value}` return use this so every provider (not just
  // claude/codex) gets a sensible env var name with zero per-provider special-casing.
  envVar: z.string().min(1).optional(),
  // F23-0D (research doc §G): true for a catalog entry that's listed for discoverability
  // but has no working auth path yet (e.g. copilot's device-code flow is FAZ-2A scope) —
  // Settings (F23-2B) gates these behind a flag/warning instead of hiding them outright.
  experimental: z.boolean().optional(),
  // CUSTOM-OPENAI-COMPAT: absent (built-in catalog entries) means "requires a key", same as
  // today. A synthesized profile for an operator's customProviders entry sets this to false
  // when the operator declared no key is needed (e.g. a local Ollama with no auth in front of
  // it) — this must never be defaulted to true/false by guessing; it's carried verbatim from
  // CustomProviderSchema.requiresKey so the prober/UI never invent a dummy key.
  requiresKey: z.boolean().optional(),
  // CUSTOM-OPENAI-COMPAT: marks a profile synthesized from cfg.customProviders (vs. a static
  // PROVIDERS catalog entry) — lets call sites (providers.list, accounts.add) tell the two
  // apart without a separate id-set lookup.
  custom: z.boolean().optional(),
}).strict();
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

// ---------- federation config surface (spec §15, Phase 5) ----------
// Defined ahead of ChimeraConfigSchema (rather than appended at file end like the
// rest of the federation block) purely because ChimeraConfigSchema's new optional
// `engine`/`federation` fields reference these schemas — const bindings can't be
// forward-referenced. No Phase 1-4 logic below is touched.
// "local" is the permanent alias for "this engine"; a concrete engineId may never claim it.
export const EngineIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/)
  .refine((id) => id !== "local", { error: '"local" is a reserved engine id' });

// Cloudflare Access reference (hostname + client id) — the Access secret is NEVER part of
// this shape; it rides the Keychain / the invite blob's own sibling field only.
export const CloudflareAccessRefSchema = z.object({
  hostname: z.string().min(1),
  clientId: z.string().min(1),
}).strict();
export type CloudflareAccessRef = z.infer<typeof CloudflareAccessRefSchema>;

export const PeerSshConfigSchema = z.object({
  host: z.string().min(1),                                  // ssh destination (~/.ssh/config alias fine)
  remoteSocket: z.string().min(1).default(".chimera/federation.sock"),  // relative to remote $HOME
  identityFile: z.string().optional(),                      // dedicated restricted federation key
  knownHostsFile: z.string().optional(),                    // pinned host keys (StrictHostKeyChecking=yes)
  cloudflareAccess: CloudflareAccessRefSchema.optional(),   // present → forward via cloudflared access ssh instead of plain ssh
}).strict();
export type PeerSshConfig = z.infer<typeof PeerSshConfigSchema>;

// D8 pairing: how a peer reaches THIS engine — carried in an invite blob and in a
// pairing card so the joiner (and, via TOFU, the responder) can pin a reachable
// socket. Same shape a PeerConfig's transport half needs (socketPath + optional ssh).
export const PeerEndpointSchema = z.object({
  socketPath: z.string().min(1),                            // LOCAL unix socket reaching the engine (SSH-forwarded in prod, direct in tests)
  ssh: PeerSshConfigSchema.optional(),                      // present → the joiner supervises the forward creating socketPath
  cloudflareAccess: CloudflareAccessRefSchema.optional(),   // present → this endpoint is also reachable via a Cloudflare Access tunnel
  // §13d (SSH-layer credential bootstrap addendum): sender's sshd host public key lines
  // ("<type> <blob>", no hostname prefix — the receiver prefixes its own hostname when
  // materializing ~/.chimera/federation/known_hosts) plus the remote login user. Both
  // ADDITIVE + optional — an endpoint/card without them (every pre-addendum fixture) parses
  // and behaves byte-identically. Never a secret (sshd host keys are world-readable).
  hostKeyLines: z.array(z.string().min(1)).optional(),
  sshUser: z.string().min(1).optional(),
}).strict();
export type PeerEndpoint = z.infer<typeof PeerEndpointSchema>;

export const PeerConfigSchema = z.object({
  engineId: EngineIdSchema,
  publicKey: z.string().min(1),                             // peer ed25519 public key, base64 SPKI/DER
  socketPath: z.string().min(1),                            // LOCAL unix socket reaching the peer (SSH-forwarded in prod, direct in tests)
  ssh: PeerSshConfigSchema.optional(),                      // present → chimerad supervises the forward creating socketPath
  allowSpawn: z.boolean().default(false),                   // default deny: links start read-only
  accounts: z.union([z.literal("auto"), z.array(z.string())]).default([]),  // account NAMES this peer may spawn under
  maxConcurrent: z.number().int().positive().default(4),    // per-peer principal cap (on top of global/per-account caps)
}).strict();
export type PeerConfig = z.infer<typeof PeerConfigSchema>;

export const FederationConfigSchema = z.object({
  peers: z.array(PeerConfigSchema).default([]),
}).strict();
export type FederationConfig = z.infer<typeof FederationConfigSchema>;

// ---------- host tool policy (WD Stage 2, coverage B14) ----------
// Defined ahead of ChimeraConfigSchema (same forward-reference constraint as the
// federation block above): ChimeraConfigSchema's new optional `toolPolicy` field
// references these schemas. Per-tool, per-profile access modes for HOST CLI tools
// (kubectl/aws/gcloud/gh/...) invoked through an agent's Bash calls:
//   allow → untouched (today's behavior), ask → force the standard
//   permission_request flow even when the agent would auto-allow, deny → the call
//   is rejected outright and a `policy_denied` event is emitted.
// The inner record's key is a profile/context name, with "*" as the wildcard
// catch-all; a profile-specific mode always beats the wildcard.
//
// FOREIGN MCP TOOLS reuse this same shape, with two differences (see
// ToolPolicyStore.modeForMcpMaybe + CapabilityBroker.decideMcpTool): the outer key is
// either the EXACT tool name "mcp__<server>__<tool>" (wins) OR the server key
// "mcp__<server>" (applies to every tool of that server), and the inner map only ever
// uses "*" (an MCP call carries no CLI profile). Crucially the DEFAULT differs: an unset
// foreign-MCP tool resolves to "ask" (surface a permission card), NOT "allow" — the
// opposite of an unlisted host tool — so ungoverned host MCP access is grantable from the
// UI instead of being silently denied. mcp__chimera__* is never governed here (auto-allowed).
export const ToolPolicyModeSchema = z.enum(["allow", "ask", "deny"]);
export type ToolPolicyMode = z.infer<typeof ToolPolicyModeSchema>;

export const ToolPolicySchema = z.record(z.string(), z.record(z.string(), ToolPolicyModeSchema));
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

// ---------- capability broker / Policy Decision Point (FEATURE-6) ----------
// The unified decision shape emitted as the `capability_decision` event's `data` (see
// EventKindSchema below) by core's CapabilityBroker — the single choke point host-tool
// (Bash), foreign-MCP-tool, and MCP-store-call authorization all route through. `principal`
// is the acting agentId when known, else null (e.g. an RPC caller that didn't thread one
// through). `resource` is a stable human-readable key: "<tool>:<profile>" (or bare "<tool>"
// when no profile was detected) for host_tool, the full "mcp__<server>__<tool>" name for
// mcp_tool, "<server>:<tool>" for mcp_store_call. Types only (not a zod schema) — matches
// every other EventKind's data payload in this file, which stays a loose z.record and is
// documented, not runtime-validated.
// GATED-BUT-ALLOWED-INVISIBLE: "cloud_mutation_gated" joins the action union for the
// classifyCloudMutation/cloudMutationGate bypass (supervisor.ts) — a state-changing cloud
// CLI verb that a full+auto agent would otherwise hit a human approval card for, silently
// auto-allowed because cloudMutationGate config is "off"/acknowledgeCloudMutationRisk is set.
// Reuses the SAME name AuditActionSchema below already uses for this exact fact (the
// auditLedger has recorded "cloud_mutation_gated" since CLOUD-MUTATION-GATE shipped) — the
// capability_decision event added here is a NEW transcript-visible sibling of that existing
// audit entry, not a competing taxonomy.
// F22: a write (Bash argv, redirection, or an Edit-family tool call) whose resolved target is
// inside a worktree leased to a DIFFERENT agent. Same name in AuditActionSchema below — one
// fact, one name, exactly as cloud_mutation_gated does.
export type CapabilityAction = "host_tool" | "mcp_tool" | "mcp_store_call" | "cloud_mutation_gated" | "worktree_write";
export type CapabilityDecisionKind = "allow" | "deny" | "prompt";
export type CapabilityDecisionEvent = {
  principal: string | null;
  action: CapabilityAction;
  resource: string;
  decision: CapabilityDecisionKind;
  reason: string;
  tool?: string;
  profile?: string | null;
  command?: string;
  server?: string;
  mcpTool?: string;
  // GATED-BUT-ALLOWED-INVISIBLE: true when an "allow" decision passed through a REAL gate —
  // an explicit toolPolicy row matched (host_tool: ToolPolicyStore.hasExplicitPolicy), a
  // foreign MCP tool (every mcp_tool decision — chimera's own tools never reach this broker
  // at all, so there's no "ungated noise" case to exclude), or a would-be-prompting gate that
  // was bypassed (cloud_mutation). False/absent means "allow" fell through to the hardcoded
  // default with NO policy configured at all — e.g. `head`/`wc` picked up as argv-parsing
  // noise by parseBashTargets. Distinguishing these is the whole point of this field: 5
  // minutes of production events showed 818 capability_decision/allow events, almost all
  // noise — coloring every one would make the signal worthless. Only meaningful when
  // decision === "allow" (a deny/prompt can ONLY be reached via an explicit policy row in
  // the first place, since the hardcoded default is unconditionally "allow").
  explicitPolicy?: boolean;
  // F22: set only on action "worktree_write". `workdirKey` is the lease key (workdir.ts's
  // `workdirKey ?? agentId`), `owner` the leaseholder's agentId, `ownerState` "active" (owner
  // live) or "retained" (owner terminal, worktree still on disk).
  workdirKey?: string;
  owner?: string;
  ownerState?: "active" | "retained";
};

// F49 LOOPBACK-MCP: what the app/TUI settings screen renders for the loopback MCP listener.
// `listening` is not a config echo — it is "a socket is bound RIGHT NOW", which is true exactly
// while at least one grant is live, because the listener binds on first grant and closes on last
// revoke. `grants` never carries a token (see LoopbackMcpListener).
export type McpListenerGrantStatus = { agentId: string; provider: string; since: number };
export type McpListenerStatus = {
  enabled: boolean;
  listening: boolean;
  address: string | null;
  grants: readonly McpListenerGrantStatus[];
};

// F22: ONE writer per worktree. `workdirKey` is the same identifier ensureWorkdir keys the
// worktree directory on (workdir.ts's worktreeKey/worktreePath) — NOT a path string, so a lease
// survives a path spelled with a symlink, `..`, or a different absolute prefix. `worktreeDir` is
// the resolved absolute directory, stored so a lookup can prove the path is really this lease's
// (a key alone could collide across two main checkouts) and so an existsSync on it can prune a
// lease whose worktree was removed. There is NO ttl/heartbeat field on purpose: liveness is
// DERIVED at decision time from the owner's supervisor state, never stored, so a lease can never
// be stale in the "expired but still recorded" sense.
export const WorktreeLeaseSchema = z.object({
  workdirKey: z.string().min(1),
  worktreeDir: z.string().min(1),
  ownerAgentId: z.string().min(1),
  acquiredAt: z.number(),
  // BOUNDED at 8: an audit breadcrumb for "who had this worktree before me", not a history log.
  handoffs: z.array(z.object({
    from: z.string(), to: z.string(), at: z.number(), by: z.enum(["rpc", "relaunch"]),
  }).strict()).max(8).default([]),
}).strict();
export type WorktreeLease = z.infer<typeof WorktreeLeaseSchema>;

// F22: the projection worktree.leaseList returns — the stored record plus the two facts that are
// only knowable at read time (is the owner still live, and what is it called).
export const WorktreeLeaseViewSchema = WorktreeLeaseSchema.extend({
  ownerState: z.enum(["active", "retained"]),
  ownerDisplayLabel: z.string().nullable(),
}).strict();
export type WorktreeLeaseView = z.infer<typeof WorktreeLeaseViewSchema>;

// F22: the write gate's enforcement mode, named ONCE so the config field (ChimeraConfigSchema
// below) and worktree.explainWrite's answer can never drift apart on the vocabulary.
export const WorktreeLeaseModeSchema = z.enum(["enforce", "warn", "off"]);
export type WorktreeLeaseMode = z.infer<typeof WorktreeLeaseModeSchema>;

// ---------- audit ledger (tamper-evident hash chain) ----------
// A dedicated, append-only, NEVER-pruned record of authorization-relevant facts — separate
// from the general EventLog (which rotates + prunes old segments, see events.ts). Each record
// carries prevHash (the previous record's `hash`, or AUDIT_GENESIS_HASH for the first record)
// and a self `hash` (sha256 over every other field, computed by core's AuditLedger) so any
// insertion/deletion/mutation breaks the chain and is detectable by walking it (audit.verify RPC).
export const AuditActionSchema = z.enum([
  "host_tool", "mcp_tool", "mcp_store_call", "destructive_bash_checkpoint", "credential_resolution",
  "cloud_mutation_gated",
  // F22: a write refused (or, in "warn" mode, merely recorded) because its target sits inside a
  // worktree leased to a different agent. Same name as CapabilityAction's member above.
  "worktree_write",
  // JOB-COMMAND-TARGET: a scheduled shell command was created. It will run UNATTENDED with the
  // daemon's own privileges, on a schedule, outside the permission profile of whoever asked for
  // it — so an agent that creates one has written itself a durable exemption. Creating them is an
  // operator-permitted capability, which is exactly why it belongs in the hash-chained ledger:
  // "what scheduled shell exists here, and who put it there" has to stay answerable afterwards.
  "job_command_created",
  // F05.1: mirrors job_command_created — a requeue re-arms a dead-lettered command job to run
  // unattended again, so the same "what ran here and who re-armed it" trail applies.
  "job_command_requeued",
  // F50 BUDGET-RESUME: releasing a budget pause is the ONLY release valve on the fleet's hardest
  // guardrail, and it is deliberately not reachable by an agent. "Who released this tree's cap and
  // when" must stay answerable after the event log's ~3-day prune, which is what the never-pruned
  // hash chain is for. Recorded even when the release turns out to be a no-op release of a
  // reversible over-estimate — an operator cannot tell the two apart at the moment they click.
  "budget_resumed",
  // SECRET-MANAGER: the three facts worth being able to prove afterwards — a value was stored or
  // removed, an agent was given or denied access, and an agent actually read one. The read entry
  // is the load-bearing one: an allowlist you cannot audit is a claim, not a control.
  "secret_written", "secret_granted", "secret_read",
  // F26 (worktree bootstrap): a project's trusted setup hook ran in AgentSupervisor.launch(),
  // BEFORE backend.spawn(), with the daemon's own privileges and no agent permission profile —
  // same reasoning as job_command_created above: "what ran here and who configured it" must stay
  // answerable. decision "recorded" on exit 0, "deny" on any failure (non-zero exit, timeout,
  // spawn error) — the runner throws in that case, so `launch()` never proceeds to backend.spawn.
  "worktree_setup_ran",
  // F49 LOOPBACK-MCP: a per-agent bearer grant on the loopback MCP listener was minted, revoked,
  // or presented and REJECTED. The rejection entry is the load-bearing one: an inbound surface
  // whose failed authentications are invisible is a claim, not a control. `resource` is
  // "mcp-listener:<grantId>"; `detail` NEVER carries the token (see LoopbackMcpListener).
  "mcp_listener_grant",
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

// "recorded" covers facts that aren't an allow/deny/prompt gate decision (destructive_bash
// detection, credential resolution) — they still belong in the ledger but have no "decision".
export const AuditDecisionSchema = z.enum(["allow", "deny", "prompt", "recorded"]);
export type AuditDecision = z.infer<typeof AuditDecisionSchema>;

export const AUDIT_GENESIS_HASH = "0".repeat(64);

export const AuditLedgerRecordSchema = z.object({
  seq: z.number().int().positive(),
  ts: z.number(),
  agentId: z.string().nullable(),
  action: AuditActionSchema,
  resource: z.string(),
  decision: AuditDecisionSchema,
  reason: z.string(),
  // caller-redacted before append — the ledger itself performs no redaction (spec §6 convention:
  // scrubbing happens at the call site that knows the live secrets, same as EventLog callers).
  detail: z.record(z.string(), z.unknown()).optional(),
  prevHash: z.string(),
  hash: z.string(),
}).strict();
export type AuditLedgerRecord = z.infer<typeof AuditLedgerRecordSchema>;

export const AuditDivergenceSchema = z.object({
  seq: z.number().int().nullable(),
  kind: z.enum(["hash_mismatch", "seq_gap", "malformed_record", "checkpoint_mismatch"]),
  detail: z.string(),
}).strict();
export type AuditDivergence = z.infer<typeof AuditDivergenceSchema>;

export const AuditVerifyResultSchema = z.object({
  ok: z.boolean(),
  recordCount: z.number().int(),
  headSeq: z.number().int(),
  headHash: z.string(),
  checkpoint: z.object({ seq: z.number().int(), hash: z.string(), ts: z.number() }).nullable(),
  firstDivergence: AuditDivergenceSchema.nullable(),
}).strict();
export type AuditVerifyResult = z.infer<typeof AuditVerifyResultSchema>;

// ---------- notifications (D14, config overlay, coverage C16, F18) ----------
// Defined ahead of ChimeraConfigSchema (same forward-reference constraint as
// federation/toolPolicy above): a NOTIFY RULE watches the event stream for a matching
// `kind` (+ optional shallow `filter` against the event's `data`, e.g. {result:"failed"}
// for job_run_finished) and delivers through one `channel`: os/toast are rendered by the
// UI off a `notify` event the daemon emits; a2a relays the sample to the tree's depth-0
// agent via agent.send; webhook POSTs `{rule, event, agent, ts}` (3 retries) and emits
// `notify_error` on exhaustion — no channel is ever allowed to block the event stream.
// `on.kind` is a bare string (not EventKindSchema) so a rule can reference a kind this
// protocol version doesn't know about yet without a schema bump — the evaluator simply
// never matches it. `throttleSec` bounds a per-rule delivery window: every match within
// the window collapses into the ONE delivery that fires at window-close, carrying a
// `count` (the "×N" burst counter) — see core's NotifyEvaluator.
export const NotifyRuleSchema = z.object({
  name: z.string().min(1),
  on: z.object({
    kind: z.string().min(1),
    filter: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  channel: z.enum(["os", "toast", "a2a", "webhook"]),
  webhookUrl: z.string().min(1).optional(),   // required (checked at delivery time) when channel === "webhook"
  throttleSec: z.number().int().positive().default(60),
  enabled: z.boolean().default(true),
}).strict();
export type NotifyRule = z.infer<typeof NotifyRuleSchema>;

export const SloThresholdSchema = z.object({
  id: z.string().min(1),
  metric: z.enum(["p95_latency_ms", "active_age_ms", "error_rate", "gate_failure_rate", "spend_usd"]),
  limit: z.number().positive(),
  window: z.enum(["1h", "6h", "24h", "7d"]),
  enabled: z.boolean().default(true),
}).strict();
export type SloThreshold = z.infer<typeof SloThresholdSchema>;

// The 5 shipped defaults (F18): permission pending, question pending, job failed, budget
// ≥80%, peer partitioned — every new/reset config gets these via ChimeraConfigSchema's
// `notify` default below. All ship on the "toast" channel (daemon-rendered, no external
// endpoint required); an operator upgrades any of them to os/a2a/webhook via config.patch.
export const DEFAULT_NOTIFY_RULES: NotifyRule[] = [
  { name: "permission-pending", on: { kind: "permission_request" }, channel: "toast", throttleSec: 60, enabled: true },
  { name: "question-pending", on: { kind: "agent_question" }, channel: "toast", throttleSec: 60, enabled: true },
  { name: "job-failed", on: { kind: "job_run_finished", filter: { result: "failed" } }, channel: "toast", throttleSec: 60, enabled: true },
  { name: "budget-80", on: { kind: "budget_warning" }, channel: "toast", throttleSec: 60, enabled: true },
  { name: "peer-partitioned", on: { kind: "peer_partitioned" }, channel: "toast", throttleSec: 60, enabled: true },
];

// F23-2B: a per-PROVIDER (not per-account) override of the catalog's baseUrl/defaultModel —
// the Settings UI's "base-URL + default-model override" inputs (D6). Keyed by ProviderProfile
// id. Applied at daemon boot when merging PROVIDERS into buildBackends (packages/daemon/src/
// main.ts) and echoed back by providers.list so the UI shows the EFFECTIVE value; like the
// registry's per-account-key gap already documented in providers/registry.ts, a change here
// takes effect on the next daemon boot, not live (no backend hot-swap yet).
export const ProviderOverrideSchema = z.object({
  baseUrl: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  // COMPACTION-THRESHOLD-CONFIG: a chimera-managed context-compaction trigger, in TOKENS,
  // enforced uniformly across every backend kind for this provider. Absent/undefined ⇒ the
  // provider's DEFAULT_COMPACTION_THRESHOLD entry if it has one (L1-DEFAULT-THRESHOLD in
  // pricing.ts — since F39 that is `claude: 120_000`, so an untouched config compacts claude at
  // 120k, NOT at the model's native window), else each backend's own native behavior (codex: the
  // CLI's own native auto-compaction per CODEX-COMPACTION-GAP; generic/openai-compat: the
  // existing DEFAULT_COMPACTION_CHAR_BUDGET default). Setting a NUMBER here replaces the fleet
  // default; setting explicit `null` is the documented rollback — it resolves to the backend's
  // NATIVE behavior and short-circuits the chain, so a null here is not "unset" falling through
  // to the 120k default, it IS the answer.
  // CAVEAT (RFC 7396): a null only survives in the BASE ~/.chimera/config.json, which is parsed
  // directly. Overlays (config.d/*.json, and anything written by the config.patch RPC) are applied
  // as JSON Merge Patch, where null DELETES the key — a null written there vanishes at load time
  // and resolution falls back to DEFAULT_COMPACTION_THRESHOLD instead of native.
  // When SET to a number, the value IS the trigger point — the
  // operator must pick it BELOW the model's real context window (e.g. 90000 for a ~100k-token
  // window) so there is headroom left to actually run compaction; this is operator
  // responsibility, not validated here (a provider's true context window isn't known to this
  // schema). Optional per-ACCOUNT override lives on AccountConfigSchema.compactionThreshold.
  compactionThreshold: z.number().int().positive().nullable().optional(),
}).strict();
export type ProviderOverride = z.infer<typeof ProviderOverrideSchema>;

// CUSTOM-OPENAI-COMPAT: an operator-defined openai-compat provider (local Ollama/LM Studio/
// vLLM/etc.), keyed by its OWN id in ChimeraConfigSchema.customProviders — deliberately
// disjoint from the built-in PROVIDERS catalog (accounts.add rejects an id collision with a
// built-in, so a custom entry can never hijack e.g. "openai"). requiresKey defaults to false
// (most local servers run with no auth in front of them) — chimera never invents a dummy key
// when it's false; when true, the account still goes through the SAME keychain-only credential
// path every built-in provider uses (no plaintext key ever lands in config).
export const CustomProviderSchema = z.object({
  label: z.string().min(1),
  baseUrl: z.string().min(1),
  defaultModel: z.string().min(1),
  requiresKey: z.boolean().default(false),
}).strict();
export type CustomProvider = z.infer<typeof CustomProviderSchema>;

// FEATURE-7 (OTel GenAI tracing + SLI rollup + redaction): span-attribute redaction policy,
// applied ONLY at export time (packages/core/src/otel.ts's buildOtlpTracePayload) — the
// in-memory span store (used for the local SLI rollup) always keeps the raw values, since
// SLI numbers never surface prompt/tool text. "Before export" is the brief's own wording.
export const OtelRedactionSchema = z.object({
  redactPrompts: z.boolean().default(true),   // gen_ai.output.text (bounded turn completion text)
  redactToolIO: z.boolean().default(true),    // gen_ai.tool.call.arguments / gen_ai.tool.call.result
  extraKeys: z.array(z.string().min(1)).default([]),   // additional exact attribute keys to strip
}).strict();
export type OtelRedaction = z.infer<typeof OtelRedactionSchema>;

// OTLP/HTTP JSON traces endpoint (e.g. "http://localhost:4318/v1/traces"). null (the default)
// means NO exporter runs — span emission + the local SLI rollup still work fully offline; only
// the network POST is skipped. Keeps the local-first "nothing breaks offline" invariant.
export const OtelConfigSchema = z.object({
  endpoint: z.string().url().nullable().default(null),
  serviceName: z.string().min(1).default("chimera"),
  redaction: OtelRedactionSchema.default({ redactPrompts: true, redactToolIO: true, extraKeys: [] }),
  // Bound on in-memory finished-span retention backing the SLI rollup RPC (oldest pruned
  // first) — mirrors EventLog's own segment-rotation bound philosophy (an accepted, not
  // tuned, number).
  maxFinishedSpans: z.number().int().positive().default(20000),
}).strict();
export type OtelConfig = z.infer<typeof OtelConfigSchema>;

// R2-DURABLE-LOG (durable event log + corruption recovery): defined ahead of ChimeraConfigSchema
// (same forward-reference constraint as OtelConfigSchema above). Governs BOTH EventLog and
// MailboxStore's append-durability (one shared knob, not two independent ones — both are
// append-only recovery-critical logs with identical needs). "group-commit" (the default) never
// fsyncs per-append (would tank throughput on a busy log); it batches an fsync after
// groupCommitMs elapses OR groupCommitMaxBatch unflushed appends accrue, whichever first —
// bounding the worst-case durability-lag window on an unclean shutdown without paying a
// per-append fsync cost. "fsync-always" fsyncs synchronously on every single append (max
// durability, lower throughput) for operators who want zero lag window.
export const EventLogDurabilityConfigSchema = z.object({
  mode: z.enum(["fsync-always", "group-commit"]).default("group-commit"),
  groupCommitMs: z.number().int().positive().default(25),
  groupCommitMaxBatch: z.number().int().positive().default(200),
}).strict();
export type EventLogDurabilityConfig = z.infer<typeof EventLogDurabilityConfigSchema>;

// EVENT-LOG-RETENTION: how many events EventLog keeps on disk before hard-deleting the oldest.
// Independent knobs — segment size (rotation granularity) and segment count (how many rotated
// segments survive pruning) — because a segment rotates on either wall-clock activity, so only
// their PRODUCT (maxSegments * maxEventsPerSegment) determines how much history survives, not
// either alone. Defaults measured against a real machine's event rate (~1.14 events/sec busy —
// 19,333 events / 4.7h on 2026-07-28): 5000 * 60 ≈ 300,000 events ≈ 3 days of history at that
// rate, versus the prior 5000 * 4 ≈ 20,000 events (five to six hours) that silently ate a user's
// prior-day conversation. At ~13-17MB per 5000-event segment (measured), 60 segments costs
// roughly 800MB-1GB on disk — an explicit budget, not a hidden one. This bounds the EventLog's
// windowed cache/replay store ONLY; it has no relationship to audit-ledger.ts's separate,
// NEVER-pruned authorization ledger.
export const EventLogRetentionConfigSchema = z.object({
  maxEventsPerSegment: z.number().int().positive().default(5000),
  maxSegments: z.number().int().positive().default(60),
}).strict();
export type EventLogRetentionConfig = z.infer<typeof EventLogRetentionConfigSchema>;

// DYNAMIC-MODEL-METADATA: default remote catalog source. LiteLLM's community-maintained
// model_prices_and_context_window.json — a flat {modelId: {...}} map with per-token costs
// (input_cost_per_token, output_cost_per_token, cache_read_input_token_cost) and context
// windows (max_input_tokens/max_tokens), MIT-licensed, refreshed multiple times weekly with
// broad claude/gpt/codex coverage. Overridable via config so an operator can pin a mirror.
export const LITELLM_CATALOG_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// DYNAMIC-MODEL-METADATA (layer 1, config override): user-pinned per-model context window and/or
// pricing that WINS over the cached remote catalog, provider API, and the hardcoded fallback map.
// Protocol-first, per-MTok pricing shape (matches ModelPricing in pricing.ts) so an operator edits
// the same figures the cost math consumes. Either field may be omitted — an override that pins
// only contextWindow leaves pricing to fall through to the lower layers, and vice versa.
export const ModelCatalogPricingSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cachedInputPerMTok: z.number().nonnegative(),
  // W2-2 CACHE-WRITE-TTL: optional per-TTL cache-write rates ($/MTok, pricing.ts's ModelPricing
  // shape) — lets an operator override (or the LiteLLM-sourced remote cache) express Anthropic's
  // distinct 5-minute/1-hour cache-write rates instead of falling through to pricing.ts's
  // unresolved-TTL default. Optional so an old config/cache entry with neither field still parses.
  cacheWrite5mPerMTok: z.number().nonnegative().optional(),
  cacheWrite1hPerMTok: z.number().nonnegative().optional(),
}).strict();
export const ModelCatalogEntrySchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  pricing: ModelCatalogPricingSchema.optional(),
  // TRUNCATION-SURFACE: an operator-pinned output-token ceiling, same override precedence as
  // contextWindow/pricing (layer 1, wins over the cached remote catalog and hardcoded fallback).
  // Lets an operator correct a provider whose real output cap the remote catalog under- or
  // never-reports (e.g. GLM/Kimi/Fireworks — see model-catalog.ts's PERMANENT COVERAGE GAP).
  maxOutputTokens: z.number().int().positive().optional(),
}).strict();
export const ModelCatalogConfigSchema = z.object({
  // Layer 1: exact-model-id → override entry. Defaulted to {} so old configs parse unchanged.
  overrides: z.record(z.string(), ModelCatalogEntrySchema).default({}),
  // Layer 2 remote-fetch policy. `enabled:false` disables the network entirely (only the
  // persisted stale cache, if any, plus layers 1/4 are consulted). ttlHours drives the daemon's
  // boot/refresh cadence; a fetch failure never throws — the last good cache (or nothing) is
  // served, so an offline daemon always boots.
  remote: z.object({
    enabled: z.boolean().default(true),
    url: z.string().url().default(LITELLM_CATALOG_URL),
    ttlHours: z.number().positive().default(24),
  }).strict().default({ enabled: true, url: LITELLM_CATALOG_URL, ttlHours: 24 }),
}).strict();
export type ModelCatalogConfig = z.infer<typeof ModelCatalogConfigSchema>;

// MEM-4 (PLAN-MEMORY.md §6): local semantic-search embedder config (see ChimeraConfigSchema.memory).
// `embedder`: "auto" (transformers.js → Ollama → lexical), "off" (lexical only), or force one path.
// ollamaHost/ollamaModel apply only to the Ollama provider (default model nomic-embed-text, 768-dim).
export const MemoryEmbedderSchema = z.enum(["auto", "off", "transformers", "ollama"]);
export type MemoryEmbedder = z.infer<typeof MemoryEmbedderSchema>;
export const MemoryConfigSchema = z.object({
  embedder: MemoryEmbedderSchema.default("auto"),
  ollamaHost: z.string().default("http://127.0.0.1:11434"),
  ollamaModel: z.string().default("nomic-embed-text"),
  // F36: the fill fraction at which the store alarms BEFORE it evicts anything. 0.9 of the 2,000
  // cap = 1,800 records; at the measured ~37 records/day (2026-09-02) that is ~5 days of warning.
  // 0 disables the alarm. Eviction events are NOT configurable — a deletion is always announced.
  evictionAlarmAt: z.number().min(0).max(1).default(0.9),
}).strict();
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

// ---------- F01: sleep/wake scheduling ----------
// One block, one off switch per slice, so any slice can be turned off without a revert.
// Boot-time only (like `snapshot`/`durability`/`reattach`): a config.patch takes effect on the
// NEXT daemon restart. Defaulted (not optional) so every existing config.json parses
// byte-identically — an untouched config simply has no `wake` key and gets these values.
export const WakeConfigSchema = z.object({
  // F01(b): hold `caffeinate -i -m -w <daemon pid>` while a job run is in flight. darwin only.
  holdAwakeDuringRuns: z.boolean().default(true),
  // F01(a): ask the OS to wake before nextRunTs. Inert unless the root wrapper is installed —
  // this switch exists so an operator who installed it can turn it off without uninstalling.
  scheduleWake: z.boolean().default(true),
  // F01(a): how far BEFORE nextRunTs to wake, so the daemon is up and warm when the job is due.
  leadMs: z.number().int().positive().default(120_000),
  // F01(c): how late a scheduled fire must be to be reported as trigger "sleep-wake". Mirrors
  // core's CLOCK_JUMP_THRESHOLD_MS so the run label and the clock_jump event that explains the
  // same gap can never disagree about what counts as a gap.
  lateFireThresholdMs: z.number().int().positive().default(120_000),
}).strict();
export type WakeConfig = z.infer<typeof WakeConfigSchema>;

// ---------- proactive hooks — protocol groundwork (PLAN-HOOKS.md §2.1-2.2, §3.1-3.2, HOOK-1)
// ----------
// Defined ahead of ChimeraConfigSchema (same forward-reference constraint as MemoryConfigSchema
// etc. above): the CURATED topic vocabulary both agent-facing subscriptions (§2) and
// config-driven lifecycle hooks (§3) share — ONE table, two consumers, never two divergent
// copies. Raw EventKinds are never subscribable/hookable directly; the daemon maps each topic to
// its underlying kind(s) + predicate (core's shared topic module, HOOK-2/HOOK-4).
export const TopicSchema = z.enum([
  "agent.settled", "agent.spawned", "task.state", "gate.verdict", "queue.drained",
  "repo.landed", "memory.added", "permission.pending", "question.pending", "budget.warning",
  "system.woke",
  // F09/J3: a delivered message that never opened a turn. Subscribable because "my message
  // vanished" is exactly the condition a conductor must react to, and polling for its absence
  // is what the topic vocabulary exists to replace.
  "agent.promptStalled",
  // F46: the ONE content topic — a byte-capped projection of an agent's OWN output
  // (message_complete + tool_result, never message_delta), matched ONLY through the literal
  // `filter.contains`. Every other topic is a lifecycle signal whose payload carries no text.
  "agent.output",
  // F05: the retry policy is spent and the job is stopped (job_disabled fires alongside it) —
  // the structured "why" for the 60s-throttled toast nobody saw at 03:00.
  "job.dead_letter",
  // F36.FIX: the memory lifecycle, which until now was feed-only — an operator could SEE a note
  // leave in the transcript but could not be woken by it. memory.pressure is the warning that
  // arrives before any loss; memory.evicted is the loss itself (per record; the over-cap
  // {truncated,total} summary carries no record and is deliberately NOT this topic).
  "memory.pressure",
  "memory.evicted",
]);
export type Topic = z.infer<typeof TopicSchema>;

// §2.1/§3.1: a shallow, field-specific match against a topic's payload — the SAME semantics
// NotifyEvaluator's matchesFilter already implements (notify.ts:31-41): a scalar value must
// equal the payload field exactly; an array value matches if the payload field is included in
// it ("includes-any"). Kept as a typed subset (not NotifyRuleSchema's raw `filter?:
// z.record(...)`) because subscriptions/hooks match against the CURATED topic payloads (§2.2's
// table), not arbitrary event data. Matching itself is applied by the future SubscriptionRegistry
// (HOOK-2) / HookEngine (HOOK-4) — this is shape-only groundwork.
// F46/QA: a needle must be plain printable text. Control characters are rejected for two
// load-bearing reasons: (1) topics.ts elides a huge scan window down to head+NUL+tail, so a
// NUL-bearing needle matches ACROSS that joiner — a phantom hit on text the agent never
// emitted; (2) narrowContentPayload delivers the matched LINE, so a needle containing a
// newline resolves to a line boundary and delivers an empty string. Scanned by char code,
// never a regex — the whole point of `contains` is that no pattern engine ever touches a
// subscriber-supplied needle.
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}
export const CONTAINS_CONTROL_CHAR_MSG =
  "filter.contains must not contain control characters";

export const TopicFilterSchema = z.object({
  agentId: z.union([z.string(), z.array(z.string())]).optional(),
  treeId: z.union([z.string(), z.array(z.string())]).optional(),
  taskId: z.union([z.string(), z.array(z.string())]).optional(),
  queue: z.union([z.string(), z.array(z.string())]).optional(),
  team: z.union([z.string(), z.array(z.string())]).optional(),
  state: z.union([z.string(), z.array(z.string())]).optional(),
  tags: z.array(z.string()).optional(),
  repo: z.union([z.string(), z.array(z.string())]).optional(),
  // F46: a LITERAL, case-insensitive substring needle — never a regex, so a subscriber can
  // never hand the daemon a catastrophically-backtracking pattern that runs on every output
  // event in the fleet. Min 3 chars because a 1-2 char needle matches essentially everything.
  contains: z.string().min(3).max(64)
    .refine((v) => !hasControlChars(v), { message: CONTAINS_CONTROL_CHAR_MSG })
    .optional(),
}).strict();
export type TopicFilter = z.infer<typeof TopicFilterSchema>;

// §2.1: an agent's standing request to be pushed a compact "signal" (via the mailbox, new
// MailboxMessage kind:"signal") the moment a matching topic fires — the wait-elimination
// primitive. `id`/`subscriberId` are stamped server-side (subscriberId from the MCP ctx, never
// trusted from caller args — mirrors TeamSpec.createdBy's stamping convention); protocol only
// declares the shape. `coalesceMs` has NO static default here — the intended default (0 for
// once:true, 5000ms for once:false) depends on the SIBLING `once` field, which z.default() can't
// express; the future SubscriptionRegistry (HOOK-2) applies that conditional default at create
// time, not this schema. `expiresAt` is likewise required-in-practice-but-not-schema for
// once:false (max 7d out) — enforced by the registry, not a cross-field refinement, to keep this
// slice pure protocol/event groundwork (NO subscription engine yet, per the HOOK-1 brief).
export const SubscriptionSchema = z.object({
  id: z.string().min(1),
  subscriberId: z.string().min(1),
  topic: TopicSchema,
  filter: TopicFilterSchema.optional(),
  once: z.boolean().default(true),
  expiresAt: z.number().int().positive().optional(),
  coalesceMs: z.number().int().nonnegative().optional(),
  wake: z.enum(["deliver", "resume", "drop"]).default("deliver"),
  note: z.string().max(200).optional(),
}).strict();
export type Subscription = z.infer<typeof SubscriptionSchema>;

// F46: the topics whose payload carries matchable text. Deliberately a plain exported FUNCTION
// rather than a `.superRefine` on SubscriptionSchema: that schema is `.omit({id:true})`-ed at
// both contract.ts's SubCreateRequestSchema and core's SubscriptionRegistry.create, and whether
// a zod-v4 refinement survives `.omit()` is not a contract we want to depend on. Callers apply
// it explicitly where the shape is final.
export const CONTENT_TOPICS: readonly Topic[] = ["agent.output"];

/** The refusal reason for a topic/filter/once combination, or null when it is legal. */
export function contentFilterIssue(
  topic: Topic,
  filter?: TopicFilter,
  opts?: { once?: boolean },
): string | null {
  const isContent = CONTENT_TOPICS.includes(topic);
  if (isContent && !filter?.contains) {
    return `topic "${topic}" requires filter.contains (3-64 chars) — an unfiltered content subscription fires on every line of output in the fleet`;
  }
  if (!isContent && filter?.contains !== undefined) {
    return `filter.contains is only supported on content topics (${CONTENT_TOPICS.join(", ")}) — "${topic}" carries no output text to match`;
  }
  // A standing content subscription has no rate limit of its own, so it would re-fire on every
  // matching line forever. Hooks are exempt (they carry maxFiresPerHour) — hence the opt-in arg.
  if (isContent && opts?.once === false) {
    return `topic "${topic}" requires once:true — a standing content subscription has no rate limit of its own`;
  }
  return null;
}

// F46/QA finding C: `treeId`/`team` are accepted by TopicFilterSchema but NO topic's projector
// (TOPIC_TABLE, packages/core/src/topics.ts) ever populates either field on any payload — a
// subscription/hook filtered on either key silently matches nothing, forever, with no error at
// create time. Declared here as a static list (not derived from TOPIC_TABLE, which lives in
// core, layered above protocol) and guarded by a core-side test asserting every topic's payload
// keys exclude these two, so this can't silently drift back into "satisfiable" without the test
// forcing an update here too. Kept as a plain function for the same reason as contentFilterIssue
// (see its own note): callers apply it explicitly where the shape is final, not via a schema
// refinement that may or may not survive `.omit()`.
export const UNSATISFIABLE_FILTER_KEYS: readonly (keyof TopicFilter)[] = ["treeId", "team"];

/** The refusal reason for a filter using a declared-but-never-emitted key, or null when legal. */
export function scopeFilterIssue(filter?: TopicFilter): string | null {
  if (!filter) return null;
  const bad = UNSATISFIABLE_FILTER_KEYS.find((k) => filter[k] !== undefined);
  if (!bad) return null;
  return `filter.${bad} is accepted by the schema but no topic's payload ever carries it — such a filter would never match (also unsatisfiable: ${UNSATISFIABLE_FILTER_KEYS.filter((k) => k !== bad).join(", ")})`;
}

// §3.2: one action a HookRule runs on a match, sequentially per firing. Templates
// (`text`/`prompt`) are deliberately PLAIN STRINGS here — the mustache-lite `{{topic}}`/
// `{{data.state}}` substitution is a HookEngine (HOOK-4) runtime concern, not a protocol-level
// one; an unrendered template still round-trips validly. `to`/`channel`/`spec` shapes mirror
// their existing runtime counterparts (notify.ts's a2a routing, AgentSpecSchema) but are kept
// deliberately minimal — additive fields can follow in the slice that actually consumes them.
export const HookActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("notify"),
    // "<agentId>" | "@conductor" (the source tree's depth-0 agent) | "@team:<team>[/<role>]"
    to: z.string().min(1),
    text: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal("push"),
    queue: z.string().min(1),
    prompt: z.string().min(1),
    role: z.string().min(1).optional(),
    priority: z.number().int().optional(),
    // chain the pushed task's `dependsOn` onto the triggering task when the cause is itself a
    // task in the same queue (§3.2) — a HookEngine (HOOK-4) runtime concern.
    dependsOnCause: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal("spawn"),
    // Subset template: enough to spawn (prompt, an existing role's template OR inline
    // overrides, deliverTo?) without re-declaring the whole AgentSpecSchema surface.
    spec: z.object({
      prompt: z.string().min(1),
      role: z.string().min(1).optional(),
      team: z.string().min(1).optional(),
      cwd: z.string().min(1).optional(),
      model: z.string().optional(),
      permissionProfile: z.enum(["readOnly", "acceptEdits", "full"]).optional(),
      deliverTo: z.string().min(1).optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("run"),
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    timeoutSec: z.number().int().positive().max(600),
  }).strict(),
  z.object({
    type: z.literal("channel"),
    channel: z.enum(["toast", "os", "webhook", "a2a"]),
    webhookUrl: z.string().min(1).optional(),   // required (checked at delivery time) when channel === "webhook"
  }).strict(),
]);
export type HookAction = z.infer<typeof HookActionSchema>;

// §3.1: a declarative `on -> actions` lifecycle rule, evaluated by the future HookEngine
// (HOOK-4, sibling of NotifyEvaluator) in config-array order. Hooks are OBSERVATIONAL ONLY —
// they never veto/block the triggering transition (blocking stays with workflow gates,
// evaluateGate). `name` is the loop-safety guards' own key (causation self-cause suppression,
// per-rule rate limit) — uniqueness is enforced by the future config-apply path, not this
// schema, mirroring NotifyRuleSchema's own unforced-uniqueness convention.
export const HookRuleSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  on: TopicSchema,
  filter: TopicFilterSchema.optional(),
  actions: z.array(HookActionSchema).min(1).max(4),
  maxChainDepth: z.number().int().positive().default(3),
  maxFiresPerHour: z.number().int().positive().default(20),
}).strict().superRefine((rule, ctx) => {
  // F46: `once` is deliberately NOT passed — a hook on a content topic MAY stand, because
  // maxFiresPerHour already bounds it. Only the contains-required/contains-misplaced rules apply.
  const issue = contentFilterIssue(rule.on, rule.filter) ?? scopeFilterIssue(rule.filter);
  if (issue) ctx.addIssue({ code: "custom", message: issue, path: ["filter"] });
});
export type HookRule = z.infer<typeof HookRuleSchema>;

// §3.3 (HOOK-4): the provenance stamp a HookEngine firing leaves on whatever it creates
// (a pushed TaskRecord, a spawned AgentSpec) — the loop-safety guards' own memory. `chain` is
// the causation depth (1 = caused directly by an uncaused event; N = caused by something
// itself at depth N-1) — inherited through RECORDS (TaskRecord.cause / AgentSpec.cause), not
// re-derived from the event log, so it survives exactly as long as the artifact does.
export const HookCauseSchema = z.object({
  rule: z.string().min(1),
  eventSeq: z.number().int().nonnegative(),
  chain: z.number().int().positive(),
}).strict();
export type HookCause = z.infer<typeof HookCauseSchema>;

// DYNAMIC-CONCURRENCY-CAP: resource-aware admission cap config, nested under caps.dynamicCap
// below. Named/exported (mirrors FederationConfigSchema/ModelCatalogConfigSchema's own
// pattern) because packages/core's resource sampler and admission check both need the type,
// not just ChimeraConfigSchema's consumers.
export const DynamicCapConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // Hard floor (ACCEPTANCE #5): the effective cap can never fall below this, however
  // severe the sampled pressure — a machine loaded by something OTHER than chimera must
  // not deadlock the fleet to zero admissions.
  floor: z.number().int().positive().default(2),
  // Schmitt-trigger watermarks (hysteresis) over the EWMA-smoothed 1-min-load/core-count
  // ratio: pressure engages once the ratio rises above cpuHighWatermark, and only
  // disengages once it falls back below cpuLowWatermark — an input oscillating between
  // the two thresholds never flips the cap every tick. cpuCriticalRatio is the ratio at
  // or above which the CPU-derived cap has fully collapsed to `floor`.
  cpuHighWatermark: z.number().positive().default(0.9),
  cpuLowWatermark: z.number().positive().default(0.7),
  cpuCriticalRatio: z.number().positive().default(1.5),
  // Same Schmitt-trigger shape, inverted for AVAILABLE memory (GB): pressure engages once
  // EWMA'd available memory drops below memLowWatermarkGb, disengages once it rises back
  // above memHighWatermarkGb. memCriticalGb is the available-memory floor at which the
  // memory-derived cap has fully collapsed to `floor`. "Available" means reclaimable cache
  // counts as available (dynamic-cap.ts's readAvailableMemGb — vm_stat free+inactive+
  // speculative+purgeable on macOS, /proc/meminfo MemAvailable on Linux), NOT os.freemem(),
  // which macOS keeps near zero permanently regardless of real pressure (MACOS-FREEMEM-BUG,
  // 15b1bfbb: that bug had these same numbers effectively always-critical, throttling a
  // 40-agent fleet to floor on a healthy 48GB box). These defaults were left unchanged after
  // that fix, not re-derived: this machine's measured ~230MB/agent means 40 agents costs
  // ~9GB, so on any box with double-digit GB of RAM these watermarks are close to never-fire
  // under the corrected signal — CPU (cpuHighWatermark et al., above) is the binding
  // constraint at realistic fleet sizes, and memory pressure exists to catch a FOREIGN
  // process eating the box's memory, not chimera's own fleet.
  memLowWatermarkGb: z.number().nonnegative().default(2),
  memHighWatermarkGb: z.number().nonnegative().default(4),
  memCriticalGb: z.number().nonnegative().default(0.5),
  // EWMA smoothing factor for both raw samples (load1, freeMemGb) — closer to 1 tracks
  // the instantaneous sample more closely, closer to 0 smooths harder. 0.3 is a moderate
  // default: a sustained spike shows up within a few ticks without one noisy sample
  // flapping the effective cap.
  emaAlpha: z.number().min(0).max(1).default(0.3),
}).strict();
export type DynamicCapConfig = z.infer<typeof DynamicCapConfigSchema>;

// MCP-OAUTH-GATEWAYS: an operator-configured MCP OAuth gateway — one authorization server
// fronting several downstream MCP servers, each gated by its own scope. Its scope names are
// private to that deployment, so they live in config, never in code (see
// resolveDefaultOAuthScopes for why a foreign server must never receive them). A `hosts` entry
// is a bare hostname: "gw.example.com" matches exactly that host, ".example.com" matches any
// SUBDOMAIN of it (not the apex) — the leading-dot form keeps "notexample.com" out without a
// regex. Validated as a hostname so a pasted url ("https://gw.example.com/mcp") fails at load
// instead of silently never matching. `optionalScopes` are offered by the app's add-remote form
// but left unchecked, for scopes that should stay a deliberate click (e.g. production access).
const McpOAuthGatewayHostSchema = z.string().min(1)
  .regex(/^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/i, "a hostname (\"gw.example.com\") or a leading-dot suffix (\".example.com\"), not a url");
export const McpOAuthGatewaySchema = z.object({
  hosts: z.array(McpOAuthGatewayHostSchema).min(1),
  defaultScopes: z.array(z.string().min(1)),
  optionalScopes: z.array(z.string().min(1)).optional(),
}).strict();
export type McpOAuthGateway = z.infer<typeof McpOAuthGatewaySchema>;

export const ChimeraConfigSchema = z.object({
  nativeVoice: VoiceLimitsSchema.default({ maxRooms: 32, maxSessions: 16, maxParticipants: 8 }),
  // ONBOARDING-PROVIDER: a brand-new $CHIMERA_HOME has no config.json and no accounts yet
  // (the daemon must still boot cleanly so the app can show a "connect a provider" first-run
  // screen) — both default to [] instead of requiring ≥1 entry. agent.spawn on an empty
  // account set fails with a clean protocol error (supervisor.ts's routeAccount), not a crash.
  accounts: z.array(AccountConfigSchema).default([]),
  autoOrder: z.array(z.string()).default([]),
  // Opt-in only: existing installations retain their account ordering.
  preferredProvider: z.string().min(1).optional(),
  failoverCooldownMinutes: z.number().int().positive().default(30),
  // CLOUD-MUTATION-GATE-OPTOUT: the CLOUD-MUTATION-GATE (supervisor.ts) forces a human
  // approval card on every state-changing kubectl/aws/gcloud/gh call, even for a full+auto
  // agent — "prompt" (default) preserves that byte-for-byte. "off" lets the operator declare
  // their full+auto grant actually means full access; the audit ledger still records every
  // cloud mutation regardless (decision: "allow" with a reason naming this setting), so
  // turning the card off never loses the trail, only the interruption. Per-spec
  // acknowledgeCloudMutationRisk overrides this per agent (see AgentSpecSchema).
  cloudMutationGate: z.enum(["prompt", "off"]).default("prompt"),
  // F22 (single-writer worktree lease): the enforcement mode of the worktree-write gate
  // (core/broker.ts decideWorktreeWrite). "enforce" (default, per the card's verdict) refuses a
  // write into a worktree leased to ANOTHER agent; "warn" runs the identical evaluation and
  // records the identical capability_decision event with decision "allow", refusing nothing —
  // that is the two-stage rollback: observe on the real ledger what enforce WOULD refuse before
  // turning it on, and drop back to it without a redeploy if a false denial ever appears. "off"
  // skips the evaluation entirely (no write-target extraction, no event), which is byte-identical
  // to every deployment from before this feature. Read fresh per permission check, so a
  // config.patch applies to the very next tool call rather than only to new spawns.
  worktreeLease: WorktreeLeaseModeSchema.default("enforce"),
  caps: z.object({
    maxAgentsTotal: z.number().int().positive().default(12),
    perAccount: z.record(z.string(), z.number().int().positive()).default({}),   // zod 4: key schema is REQUIRED
    // WS-OPT (model tiering): the cheap model programmatically stamped onto any
    // depth>0 spawn whose spec.model is unset (supervisor.ts), so opus is spent
    // only on the depth-0 primary. OPTIONAL with no default — omitted ⇒ no
    // override, so old configs and un-tiered deployments behave byte-identically.
    // Recommended value when tiering is desired: "claude-sonnet-5".
    // .min(1): a present-but-empty value is an operator mistake (it would parse,
    // then silently no-op at the stamp site) — fail fast instead.
    subAgentModel: z.string().min(1).optional(),
    // TOKEN-OPT-P5: per-provider "fast"/cheap model for mechanical, low-capability-risk
    // work — the default consumer is the workflow handoff-summary turn (scheduler.ts,
    // pure summarization of an outgoing agent's own session), and a workflow step may
    // opt in explicitly via WorkflowStepSchema.model. Keyed by provider id (e.g.
    // "claude" -> "claude-haiku-4-5"). Defaulted to {} (not optional) so every config
    // has a concrete value to read; an absent entry for a given provider ⇒ no override,
    // so old configs and un-tiered deployments behave byte-identically.
    fastModel: z.record(z.string(), z.string().min(1)).default({}),
    // DYNAMIC-CONCURRENCY-CAP: OPTIONAL resource-aware admission cap that narrows the
    // OPERATING POINT below maxAgentsTotal (the ceiling — unchanged, still the operator's
    // declared max) when the machine is under real CPU/memory pressure. Absent (every
    // existing config, and any config that never touches this block) ⇒ admission behaves
    // byte-identically to today (supervisor.ts falls back to the static maxAgentsTotal
    // ceiling with no probe). DynamicCapConfigSchema's own `enabled` additionally defaults
    // false even when this block IS present but doesn't set it, so a bare `{}` patch stays a
    // no-op — a deliberate double off-by-default, since a probe misfire under a mis-tuned
    // watermark would refuse legitimate admissions on a feature the operator never
    // explicitly opted into. Mirrors subAgentModel's own "OPTIONAL, no top-level default"
    // shape immediately above, not caps' own scalar-default shape — this is a compound
    // block, not a single knob.
    dynamicCap: DynamicCapConfigSchema.optional(),
  }).default({ maxAgentsTotal: 12, perAccount: {}, fastModel: {} }),
  // Phase 5: both optional — old configs parse unchanged. `engine.id` is this daemon's
  // own identity as seen by peers; `federation.peers` is the trusted-peer allowlist.
  engine: z.object({ id: EngineIdSchema }).strict().optional(),
  federation: FederationConfigSchema.optional(),
  // F49 LOOPBACK-MCP: the ONE switch this feature has, and the ONE rollback. OFF BY DEFAULT —
  // this is the first inbound network surface in this daemon's history, even loopback-only.
  // There is deliberately NO bind-host, port or interface field: mcp-listener.ts hard-codes the
  // loopback address and an OS-assigned port, so a non-loopback bind is not reachable by
  // configuration at all, and the inner .strict() turns an operator's hopeful `bind` key into a
  // parse error rather than a silently ignored one. Enabling takes effect on the NEXT daemon
  // restart; DISABLING is applied live by reloadConfig.
  mcpListener: z.object({ enabled: z.boolean().default(false) })
    .strict().default({ enabled: false }),
  // WD Stage 1 (coverage B1, spend chip): an OPTIONAL daily USD spend ceiling the UI
  // renders a meter against. ADVISORY/display-only in this stage — nothing daemon-side
  // enforces it (no spawn refusal at the cap; that's a deliberate product decision to
  // revisit with the orchestration-model thread). Optional with no default so every
  // existing config parses byte-identically; daemon.status surfaces it as
  // `dailyCapUsd` (null when unset) next to the accumulated `spendTodayUsd`.
  dailyCapUsd: z.number().positive().optional(),
  // WD Stage 2 (coverage B14): OPTIONAL per-tool/per-profile host-tool access policy
  // (see ToolPolicySchema above). Optional with no default so every existing config
  // parses byte-identically. config.json is user-owned by this codebase's convention
  // (nothing daemon-side ever writes it), so host.setPolicy persists to the
  // $CHIMERA_HOME/toolpolicy.json OVERLAY instead — precedence is documented on
  // core's ToolPolicyStore: profile-specific beats wildcard; within the same
  // specificity the overlay beats this config field.
  toolPolicy: ToolPolicySchema.optional(),
  // D14 (notifications, coverage C16): rule storage lives in the overlay like every other
  // daemon-owned section — defaulted (not optional) so every config, old or new, always
  // has the 5 shipped defaults until an operator edits them via config.patch({notify:[...]}).
  notify: z.array(NotifyRuleSchema).default(DEFAULT_NOTIFY_RULES),
  // PLAN-HOOKS.md §3 (HOOK-1 groundwork): declarative lifecycle-hook rules, hot-reloaded like
  // `notify` (engine.ts's changed.includes("hooks") pattern, HOOK-4). Defaulted to [] (not
  // optional) so every existing config.json parses byte-identically — an untouched config never
  // grows a hook. NO engine evaluates this array yet in this slice; it is pure schema+config
  // surface, wired up by HOOK-4.
  hooks: z.array(HookRuleSchema).default([]),
  // LAZY-REATTACH: what a daemon restart does with the prior run's still-"running" agents.
  // "lazy" (default) brings each back PAUSED with its session intact but NO process — the
  // process starts on the first action that needs the session. "eager" restores the previous
  // behavior (re-spawn all of them at boot), which on a real fleet meant a burst of provider
  // CLI processes at exactly the moment a reconnecting UI was loading its first snapshot.
  // Boot-time only, like `snapshot`/`durability`: a change takes effect on the NEXT restart.
  reattach: z.enum(["lazy", "eager"]).default("lazy"),
  // IDLE-REAP: release the OS process of an agent that has sat idle BETWEEN TURNS this long,
  // keeping its record and session so the next message (or mail landing in its box) resumes it
  // exactly where it left off. This is what stops a large fleet's dormant-but-open sessions from
  // holding CPU/RAM indefinitely. An agent with a turn actually in flight is NEVER reaped — a
  // long, quiet tool call still reads as mid-turn (see HealthMonitor's `midTurn` fold), which is
  // the distinction that makes this safe. Evaluated on the health monitor's existing tick.
  idleReap: z.object({
    enabled: z.boolean().default(true),
    idleMinutes: z.number().int().positive().default(60),
  }).default({ enabled: true, idleMinutes: 60 }),
  // TERMINAL-RETENTION: how long a FINISHED agent's row stays before the daemon forgets it.
  // Distinct from idleReap above, which is often mistaken for this: idleReap releases a RUNNING
  // agent's process and KEEPS its record (the agent is still there, resumable); this removes the
  // record of an agent that already ended. Nothing before it aged terminal records out at all —
  // MAX_TERMINAL_AGENTS_PERSISTED lightens them past 200, but the row itself stayed forever, so a
  // long-lived daemon accumulated a fleet list nobody could read.
  //
  // Only ever terminal (done/failed/killed): running and paused records — including every hold —
  // are never touched by it, which is the guarantee the manual sweep already makes and this
  // inherits by going through the same terminal-only purge.
  // DEFAULT OFF, deliberately. This was added on a misread of "shouldn't finished agents
  // disappear after a while?" — which meant the UI's hide-done fold, not deletion. Deleting an
  // operator's finished transcripts, archived records and mailboxes is not a reasonable default
  // for a question about a list filter, and a default that silently destroys history is the wrong
  // way round: someone who wants it can say so, someone who doesn't should never have to discover
  // it by finding work missing.
  terminalRetention: z.object({
    enabled: z.boolean().default(false),
    hours: z.number().positive().default(24),
  }).default({ enabled: false, hours: 24 }),
  // Fleet SLO: daemon-persisted configuration, evaluated by the desktop command center.
  sloThresholds: z.array(SloThresholdSchema).default([]),
  // PLAN-PROJECT-CONDUCTOR-ROUTING P2-T1 (D3, config-designated global team): names the
  // reserved project-agnostic team the dispatch resolver (P2-T2) falls back to when no
  // project queue/team fits. OPTIONAL, default null — unset means the resolver simply skips
  // that step. NOT validated against team_list at set-time: the resolver tolerates a
  // globalTeam that doesn't (yet) exist, treating "no global" as its own direct-spawn
  // fallback. Reserved default name for the team itself (not enforced here): "team-global".
  globalTeam: z.string().min(1).nullable().default(null),
  // IMPORT-DIR: configurable base directory for git-imported projects (Settings-editable
  // via a PathPicker). OPTIONAL, default null — null means engine.ts's project.import falls
  // back to today's hardcoded $CHIMERA_HOME/projects, so every existing config keeps
  // cloning to the same place until an operator opts in.
  projectImportDir: z.string().nullable().default(null),
  // CONDUCTOR-FULL-ACCESS: the permissionProfile the auto-created MAIN conductor and each
  // auto-created per-project conductor are BORN with (engine.ts's spawnMainConductor /
  // spawnProjectConductor). Default "full" — a conductor is the user's OWN orchestrator
  // working in the REAL project repo, so under on.permissionRequest "auto" it must be able
  // to run Bash / foreign MCP tools (autoDecision denies those for acceptEdits). Defaulted
  // (not optional) so every config, old or new, always has a concrete value — an old config
  // that predates this key simply parses to "full". Only affects FRESH conductor spawns; an
  // already-persisted conductor keeps its stored profile on daemon-restart reattach (see
  // reattach.ts) and is re-scoped live via agent.setPermission from the UI instead.
  conductorPermissionProfile: z.enum(["readOnly", "acceptEdits", "full"]).default("full"),
  // PROJECT-CONDUCTOR-DEFAULTS: what a FRESH per-project conductor is born with, alongside the
  // permissionProfile above and read at the same seam (engine.ts's spawnProjectConductor). Both
  // follow that key's contract exactly: defaulted rather than optional so every config old or new
  // parses to a concrete value, and read only on a fresh spawn — a conductor that already exists
  // keeps its stored spec across a daemon restart (reattach.ts) and is changed live via
  // agent_reconfigure, which accepts both of these fields (supervisor's RECONFIGURABLE_KEYS).
  //
  // "high" because a project conductor's job is routing and verification, not bulk edits: it is
  // the agent whose bad decision costs a whole fleet of workers a wasted run. Deliberately not
  // "max" — the tier above buys deliberation this role rarely needs and pays for it on every turn.
  projectConductorEffort: EffortLevelSchema.default("high"),
  // A conductor accumulates the whole project's routing history, so it hits its window far sooner
  // than a worker does, and each compaction costs it exactly the delegation context it exists to
  // hold. 500k trades tokens for continuity on the one agent where continuity is the product.
  // Wins over the account/provider default the same way any per-spawn value does
  // (supervisor.resolveCompactionThreshold: "the right window is a property of the workload").
  projectConductorCompactionThreshold: z.number().int().positive().default(500_000),
  // LEAN-AGENT-CONTEXT (token economy): default ON. When true, a fresh NON-conductor claude
  // spawn is given strictMcpConfig — the SDK loads ONLY chimera's own injected MCP server, not
  // the machine's foreign MCP catalog (claude.ai connectors, EKB, atlassian, etc.), which
  // otherwise embeds hundreds of tool definitions in every spawn's context. Agents reach a
  // foreign MCP tool on demand via chimera's mcp_store_tools/mcp_store_call proxy instead. The
  // discovery-pointer instruction (supervisor capabilityBlock) names the lazy-load paths.
  // Escape hatch: set false to restore the old full-catalog behavior. Read fresh per launch.
  leanAgentContext: z.boolean().default(true),
  // LEAN-AGENT-SKILLS: the skills a lean spawn may still use. Empty = none.
  //
  // An allowlist rather than an off switch, because the SDK's `skills` is "a context filter, not a
  // sandbox: unlisted skills are hidden from the model's listing AND REJECTED BY THE SKILL TOOL".
  // So unlike foreign MCP tools (reachable on demand via mcp_store_tools) or chimera's own deferred
  // tools (chimera_tools), an unlisted skill is not deferred — it is refused. Turning them all off
  // would silently take a capability away rather than making it lazy.
  //
  // The list is short in practice: measured over ~47k model calls, 348 skills were loaded into
  // every prompt and exactly 5 were ever invoked. Naming those 5 keeps essentially all of the
  // saving and breaks nothing.
  leanAgentSkills: z.array(z.string()).default([]),
  // ADVISOR-TOOL: the fleet-wide default for AgentSpec.advisorModel — what a spawn that names no
  // advisor gets. Empty means no advisor tool at all, which is the CLI's own default.
  advisorModel: z.string().optional(),
  // F23-2A: subscription OAuth flows for providers where third-party reuse is only
  // gray-area/tier-gated (GitHub Copilot device flow, xAI Grok Build) are gated behind this
  // flag so they never light up silently on an upgrade — the operator opts in per the
  // research doc's TOS-honesty rule. `.default({experimental:false})` on the WHOLE object
  // (not `.optional()`) so old configs parse byte-identically (the key is simply absent)
  // while every effective config always has a concrete value to read.
  providers: z.object({
    experimental: z.boolean().default(false),
  }).strict().default({ experimental: false }),
  // MCP-OAUTH-GATEWAYS (see McpOAuthGatewaySchema): optional, no default — an untouched config
  // parses byte-identically and no url ever matches a gateway. Read fresh at each use (engine.ts
  // via this.cfg, the app via config.get), so a config.patch applies to the next add/convert.
  mcpOAuthGateways: z.array(McpOAuthGatewaySchema).optional(),
  // F23-2B (D6): optional per-provider baseUrl/defaultModel overrides, keyed by catalog
  // provider id. Optional with no default — old configs parse byte-identically.
  providerOverrides: z.record(z.string(), ProviderOverrideSchema).optional(),
  // CUSTOM-OPENAI-COMPAT: keyed by the custom provider's own id (must not collide with a
  // built-in PROVIDERS id — enforced at accounts.add/config-write time, not here, so an old
  // config that somehow had one is never rejected at load). Optional, no default — an untouched
  // config parses byte-identically, same convention as providerOverrides above.
  customProviders: z.record(z.string(), CustomProviderSchema).optional(),
  // FEATURE-4 (snapshot durability + write-amp fix): state.json is no longer rewritten on
  // every event — a durable snapshot fires after `maxEvents` events or `maxIntervalMs`
  // elapsed (whichever first), plus immediately whenever a new agent/shadow row appears (see
  // packages/core/src/snapshot.ts). Boot-time-only, like providerOverrides — a config.patch
  // takes effect on the NEXT daemon restart. Defaulted (not optional) so every config has a
  // concrete value; old configs parse byte-identically since the key is simply absent.
  snapshot: z.object({
    maxEvents: z.number().int().positive().default(50),
    maxIntervalMs: z.number().int().positive().default(2000),
  }).strict().default({ maxEvents: 50, maxIntervalMs: 2000 }),
  // FEATURE-7: OTel GenAI-shaped control-plane tracing. Defaulted (not optional) so every
  // config, old or new, always has a concrete value — old configs parse byte-identically
  // (endpoint stays null ⇒ exporter is a no-op) until an operator opts in via config.patch.
  otel: OtelConfigSchema.default({
    endpoint: null, serviceName: "chimera",
    redaction: { redactPrompts: true, redactToolIO: true, extraKeys: [] },
    maxFinishedSpans: 20000,
  }),
  // R2-DURABLE-LOG: fsync/group-commit durability policy for EventLog + MailboxStore's append
  // path (see EventLogDurabilityConfigSchema). Defaulted (not optional) so every config, old or
  // new, always has a concrete value — old configs parse byte-identically. Boot-time-only, same
  // restriction as `snapshot`/`providerOverrides` — a config.patch takes effect on the NEXT
  // daemon restart.
  durability: EventLogDurabilityConfigSchema.default({ mode: "group-commit", groupCommitMs: 25, groupCommitMaxBatch: 200 }),
  // EVENT-LOG-RETENTION: how much EventLog history survives pruning (see
  // EventLogRetentionConfigSchema). Defaulted (not optional) so every config, old or new, always
  // has a concrete value — old configs parse to the new, larger defaults automatically rather
  // than staying frozen at the old 20,000-event bound. Boot-time-only, same restriction as
  // durability/snapshot/providerOverrides above — a config.patch takes effect on the NEXT daemon
  // restart.
  eventRetention: EventLogRetentionConfigSchema.default({ maxEventsPerSegment: 5000, maxSegments: 60 }),
  // DYNAMIC-MODEL-METADATA: layered per-model context-window + pricing metadata (config override >
  // cached remote catalog > provider API > hardcoded fallback). Defaulted (not optional) so every
  // config, old or new, always has a concrete value — an old config that predates this key parses
  // to {overrides:{}, remote:{enabled,url,ttlHours}}, i.e. remote fetch on. Boot-time-only for the
  // fetch policy (a config.patch to `remote` takes effect on the NEXT restart, same as snapshot/
  // durability); `overrides` are read live via the service on every resolution.
  modelCatalog: ModelCatalogConfigSchema.default({
    overrides: {}, remote: { enabled: true, url: LITELLM_CATALOG_URL, ttlHours: 24 },
  }),
  // MEM-4 (PLAN-MEMORY.md §6): local-only semantic-search embedder selection. NO third-party
  // inference APIs ever — only a local process (Ollama) or a one-time, skippable local model
  // download (transformers.js) is contacted. `auto` resolves transformers.js → Ollama probe →
  // lexical-only; `off` keeps search purely lexical (today's exact behavior). Defaulted (not
  // optional) so every config, old or new, parses byte-identically. Boot-time-only for provider
  // selection (a config.patch takes effect on the NEXT daemon restart, same as snapshot/
  // durability). The embedder is NEVER a hard dependency (docs/RELEASE-BUNDLING.md — the compiled
  // single-binary daemon carries no native modules); an absent embedder simply degrades to lexical.
  memory: MemoryConfigSchema.default({
    embedder: "auto", ollamaHost: "http://127.0.0.1:11434", ollamaModel: "nomic-embed-text",
    evictionAlarmAt: 0.9,
  }),
  // F01: sleep/wake behaviour for scheduled jobs. Defaulted (not optional) so an old config.json
  // parses to exactly today's behaviour plus the default-on caffeinate hold. Boot-time-only.
  wake: WakeConfigSchema.default({
    holdAwakeDuringRuns: true, scheduleWake: true, leadMs: 120_000, lateFireThresholdMs: 120_000,
  }),
  // F09 QA (item 1): DERIVED, NOT GUESSED, and now config-backed instead of a source literal an
  // operator can't override. Source: docs/superpowers/measurements/2026-09-02-prompt-ack-latency.json,
  // produced by scripts/prompt-ack-latency.mjs (recommend(), scripts/prompt-ack-lib.mjs) over
  // 302 869 events / 61 segments of ~/.chimera/events (window 2026-08-27 → 2026-09-02, read
  // 2026-09-02 — see that file's `window` block; ~44h older than the plan's original read, see F4
  // note in docs/superpowers/research/harness-2026-09/qa/F09.md). Policy: stallMs = smallest
  // COVERAGE_THRESHOLDS_MS entry with idle.coverage >= 0.98 (45000, false-signal 2.0%); ackWaitMs =
  // idle.p90 rounded to the nearest second (8708 -> 9000). Re-derive by re-running the script over
  // a fresh window; do not tune by feel. Defaulted (not optional) so every config, old or new,
  // parses byte-identically. Boot-time-only, same restriction as snapshot/durability/wake above — a
  // config.patch takes effect on the NEXT daemon restart.
  promptAck: z.object({
    ackWaitMs: z.number().int().positive().default(9_000),
    stallMs: z.number().int().positive().default(45_000),
  }).strict().default({ ackWaitMs: 9_000, stallMs: 45_000 }),
}).strict();
export type ChimeraConfig = z.infer<typeof ChimeraConfigSchema>;

// ---------- plugins (native-CLI-parity WS-E: load-from-spec) ----------
// Mirrors the Claude Agent SDK's SdkPluginConfig verbatim: a local plugin
// DIRECTORY the engine loads commands/agents/skills/hooks from — and, unless
// skipMcpDiscovery is set, that plugin's own MCP servers too. "local" is the only
// type the SDK supports today. Threaded straight into the claude backend's
// options.plugins (backends/claude.ts). .strict() so a typo'd/extra key fails fast
// rather than silently loading nothing.
export const PluginConfigSchema = z.object({
  type: z.literal("local"),
  path: z.string().min(1),                 // absolute or cwd-relative plugin directory
  skipMcpDiscovery: z.boolean().optional(),  // load the plugin's skills/hooks/agents/commands but NOT its .mcp.json
}).strict();
export type PluginConfig = z.infer<typeof PluginConfigSchema>;

// D9 (F13 composer wire): ordered content blocks for a prompt/turn, additive
// alongside the plain-string `prompt`/`text` fields — lets a caller interleave
// images at exact mid-sentence positions instead of bunching them after the text.
export const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1) }).strict(),
  z.object({
    type: z.literal("image"),
    mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    data: z.string().min(1),
  }).strict(),
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// ---------- reasoning effort (EFFORT) ----------
// EFFORT-ONE-SOURCE lives in its own module so it can be imported by mcp-tools.ts WITHOUT a cycle:
// this barrel re-exports mcp-tools, so anything in here that mcp-tools needs at module-evaluation
// time is read before initialization. Learned the hard way — deriving the tool schema from the
// enum was right, importing it through the barrel was not.
export * from "./effort.js";
// Also imported by NAME: several schemas below reference it directly, and `export *` alone does
// not bring it into this module's own scope.
import { EffortLevelSchema } from "./effort.js";

// ---------- agent groups (operator-defined wrapper boxes) ----------
// AGENT-GROUPS Phase 1: an ad-hoc, operator-named container ("sprint", "daily") an agent can
// be placed into — purely a UI/list-placement concept (core/src/groups.ts's GroupStore never
// touches spawn/scheduling). Reuses ui-state/teamIcon.ts's existing 8 semantic colour ids
// verbatim rather than inventing a second palette; protocol can't import ui-state, so the set
// is mirrored here as a literal tuple — ui-state carries a typetest asserting the two stay in
// lockstep (TeamColorId is the source of truth; this list must never drift from it).
export const AGENT_GROUP_COLORS = ["blue", "green", "amber", "purple", "cyan", "magenta", "red", "teal"] as const;
export const AgentGroupColorSchema = z.enum(AGENT_GROUP_COLORS);
export type AgentGroupColor = z.infer<typeof AgentGroupColorSchema>;

// Slug id (what AgentSpec.groups / AgentRecord actually carry) — distinct from the operator-
// facing `name`, which may carry spaces/case. Lowercase alnum/dash/underscore, 1-32 chars,
// must start alnum.
export const AgentGroupIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
export type AgentGroupId = z.infer<typeof AgentGroupIdSchema>;

export const AgentGroupSchema = z.object({
  id: AgentGroupIdSchema,
  name: z.string().trim().min(1).max(48),
  // Operator-pickable; absent ⇒ the client defaults to hashTeam(id)'s pick (ui-state/
  // teamIcon.ts) so a group is never colourless without persisting a redundant "was this
  // ever explicitly set" bit.
  color: AgentGroupColorSchema.optional(),
  createdAt: z.number(),
  order: z.number(),
}).strict();
export type AgentGroup = z.infer<typeof AgentGroupSchema>;

export const GroupCreateParamsSchema = z.object({
  name: z.string().trim().min(1).max(48),
  color: AgentGroupColorSchema.optional(),
}).strict();
export type GroupCreateParams = z.infer<typeof GroupCreateParamsSchema>;

export const GroupUpdateParamsSchema = z.object({
  id: AgentGroupIdSchema,
  name: z.string().trim().min(1).max(48).optional(),
  color: AgentGroupColorSchema.optional(),
}).strict();
export type GroupUpdateParams = z.infer<typeof GroupUpdateParamsSchema>;

export const GroupDeleteParamsSchema = z.object({
  id: AgentGroupIdSchema,
}).strict();
export type GroupDeleteParams = z.infer<typeof GroupDeleteParamsSchema>;

export const GroupListResultSchema = z.object({
  groups: z.array(AgentGroupSchema),
}).strict();
export type GroupListResult = z.infer<typeof GroupListResultSchema>;

// A membership naming a group the registry no longer has is resolve-or-ignore at READ time
// (ui-state), never validated away here — the daemon accepts any well-formed id so a delete
// race (list fetched, then the group deleted, then this call lands) never fails a caller that
// did nothing wrong.
export const AgentSetGroupsParamsSchema = z.object({
  agentId: z.string().min(1),
  groups: z.array(AgentGroupIdSchema).max(8),
}).strict();
export type AgentSetGroupsParams = z.infer<typeof AgentSetGroupsParamsSchema>;

// F47 (fleet seen-state): the closed set of event kinds that mean "a human needs to look at this
// agent". Deliberately excludes the high-frequency streaming kinds (message_delta,
// message_complete, tool_call, tool_result, usage, turn_complete) — an agent that is merely busy
// is not an agent that is waiting, and stamping on those would make every running agent unseen
// forever.
// F09 QA (item 3): a stalled prompt is exactly the same "needs a human" signal as a timeout — the
// agent went idle and nothing woke it — so it belongs in this set too. Without it, a stall never
// re-marks the agent row `new` and a conductor's fan-out silently drops a delivery from view.
export const ATTENTION_EVENT_KINDS: ReadonlySet<string> = new Set([
  "result", "error", "turn_timeout", "permission_request", "agent_question", "agent_prompt_stalled",
]);

// The single shared predicate for "this agent has attention the operator has not acknowledged".
// `attentionAt === reviewedAt` is SEEN: mark-seen is stamped after the attention event it
// acknowledges, so a tie means the operator's action was the later one.
export function isAgentUnseen(a: { attentionAt?: number | undefined; reviewedAt?: number | undefined }): boolean {
  return a.attentionAt !== undefined && a.attentionAt > (a.reviewedAt ?? 0);
}

// Bulk by design: the fleet views mark a whole visible page seen in one call. Validate-all-then-
// mutate on the core side — one unknown id fails the call and stamps nothing.
// Exported so the fleet views can SPLIT an oversized sweep instead of having the whole call
// rejected: validate-all-then-mutate means one call over the cap stamps nothing at all.
export const AGENT_MARK_SEEN_MAX_IDS = 500;
export const AgentMarkSeenParamsSchema = z.object({
  agentIds: z.array(z.string().min(1)).min(1).max(AGENT_MARK_SEEN_MAX_IDS),
  // F47.FIX M-2: the FLEET-WIDE sweep opts out of validate-all-then-reject. Strict validation is
  // right for a single-agent mark (a purged id is news the operator wants), but a sweep is chunked
  // across several calls, so one id the daemon no longer knows would fail chunk N and leave chunks
  // 1..N-1 already stamped — a half-marked fleet with no rollback. With this set the daemon stamps
  // every id it knows and REPORTS the rest (`unknownIds`), so the sweep is "every stampable agent
  // got stamped" instead of a silent prefix. Absent ⇒ strict, byte-identical to before.
  skipUnknown: z.boolean().optional(),
}).strict();
export type AgentMarkSeenParams = z.infer<typeof AgentMarkSeenParamsSchema>;

// ---------- agent spec (spec §5) ----------
export const AgentSpecSchema = z.object({
  // TERMINAL-RUNTIME: HOW this agent runs, not WHAT it is. The provider/account/model are
  // unchanged either way — "terminal" only means the same CLI runs on a real PTY (in a detached
  // tmux session) instead of headless under the Agent SDK.
  //
  // What that buys: the CLI's interactive surface, which it refuses when headless (measured: the
  // refusal has its own telemetry class, `cmd_unavailable_headless`), and an agent an operator can
  // sit down at with `tmux attach`. What it costs: no structured event stream, so no per-token
  // deltas, no tool_call/tool_result rows, and no permission callback — permissions are answered
  // in the terminal by whoever is watching it.
  //
  // Absent ⇒ "sdk", byte-identical to every spawn before this existed.
  runtime: z.enum(["sdk", "terminal"]).default("sdk"),
  prompt: z.string().min(1),
  // D9: additive ordered content blocks for the initial spawn prompt (optional —
  // omitted entirely leaves every existing spec byte-for-byte unaffected). When
  // present, the backend builds the SDK message from these blocks instead of
  // bunching `prompt` then images; `prompt` is still required as the flattened
  // text fallback/display value.
  content: z.array(ContentBlockSchema).optional(),
  cwd: z.string().min(1),
  // Optional user-facing identity. Deliberately distinct from account/accountName (the
  // credential account that runs the agent) and from shadow labels. Omitted keeps the
  // deterministic client-side animal name unchanged.
  displayLabel: z.string().trim().min(1).optional(),
  account: z.string().default("auto"),
  // F23 D3: widened from z.enum(["claude","codex"]) — see AccountConfigSchema.provider above
  // for the rationale (runtime registry validation replaces the parse-time enum).
  provider: z.string().min(1).optional(),      // defaults from the account at resolve time
  isolation: z.enum(["none", "worktree"]).default("worktree"),
  // WF-7 (workflows v2 Phase 3): generic worktree-key override, not workflow-specific — when
  // set, ensureWorkdir keys the worktree/branch on THIS value instead of agentId, letting
  // multiple agents (spawned sequentially, e.g. across a workflow's step-role switches) share
  // one task worktree. Absent → today's per-agentId behavior, byte-for-byte.
  workdirKey: z.string().min(1).optional(),
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
  instructions: z.string().optional(),
  // W2-1 STRUCTURED-RETURNS: a JSON Schema (object form) the agent's terminal result MUST
  // validate against, in place of today's freeform prose. Enforcement lives in the backend, not
  // here: claude.ts wires this to the SDK's own outputFormat (which retries and reports
  // error_max_structured_output_retries on failure — that surfaces as a terminal `error` event,
  // never a silently-wrong "success"); codex.ts wires it to runStreamed's outputSchema and,
  // since the Codex SDK does not self-validate, chimera confirms the response at least PARSES as
  // JSON (full structural conformance would need a JSON-Schema validator, not currently a
  // dependency anywhere in this repo — out of scope here). Omitted ⇒ today's free-text result,
  // byte-identical.
  resultSchema: z.record(z.string(), z.unknown()).optional(),
  permissionProfile: z.enum(["readOnly", "acceptEdits", "full"]).default("acceptEdits"),
  // AGENT-AUTONOMY: "full" means the agent gets no human to ask, ever — it silences the
  // ask_human/ask_agent/ask_team MCP tools (not just registered-but-refusing: absent, so the
  // model's own tool list never advertises a capability it doesn't have) and omits
  // supportedDialogKinds so AskUserQuestion/elicitation dialogs fail closed (see claude.ts).
  // Deliberately ORTHOGONAL to permissionProfile/on.permissionRequest: it does NOT touch the
  // CLOUD-MUTATION-GATE, host toolPolicy "ask" gate, or foreign-MCP "prompt" gate — those put a
  // human in front of a SPECIFIC dangerous action regardless of autonomy, a different concern
  // than "stop asking my opinion". Default "ask" keeps every existing spec byte-identical.
  autonomy: z.enum(["ask", "full"]).default("ask"),
  // CODEX-GATE-EXPOSURE: codex has no decidePermission equivalent (backends/codex.ts) — for
  // "full" that means sandboxMode "danger-full-access" AND chimera's own policies (cloud
  // mutation gate, worktree/node_modules write guards, destructive-bash checkpoint) never run.
  // A "full" codex spawn is refused (supervisor.ts launch()) unless this is explicitly set,
  // naming the exact risk instead of silently granting it. No effect on claude spawns, where
  // decidePermission still enforces every policy regardless of this field.
  acknowledgeCodexFullAccessRisk: z.boolean().default(false),
  // CLOUD-MUTATION-GATE-OPTOUT: per-spec override of the config-level cloudMutationGate
  // default, mirroring acknowledgeCodexFullAccessRisk's naming-the-risk idiom. Optional
  // (unset) ⇒ defer to the daemon's cloudMutationGate config; true ⇒ this agent's
  // state-changing cloud CLI calls auto-allow even if the config default is "prompt"; false ⇒
  // this agent always gets the card even if the config default is "off". The audit ledger
  // records the mutation either way.
  acknowledgeCloudMutationRisk: z.boolean().optional(),
  maxTurns: z.number().int().positive().default(40),
  // SOFT-TURN-LIMIT: "fail" (default) preserves today's behavior byte-for-byte —
  // the backend enforces maxTurns as a hard cap and the agent ends in a terminal
  // (failed) state once it's reached. "soft" opts a spawn (or a team role
  // template, via RoleSpecSchema below) INTO running past maxTurns: the
  // backend tracks it as a nominal budget instead of a hard cap, emits a
  // `status` event with `turnBudgetExceeded: true` the first time the agent
  // crosses it, but keeps `state: "running"` — the agent only stops on natural
  // completion, the maxBudgetUsd tree-budget guard, or an explicit kill.
  turnLimitPolicy: z.enum(["fail", "soft"]).default("fail"),
  // R2-TURN-LIFECYCLE: per-spawn override for TurnController's stream-idle and hard
  // max-duration watchdogs (packages/core/src/turn-controller.ts). Undefined ⇒ that timer is
  // never armed — identical to today's unbounded behavior. Deliberately NOT defaulted to a
  // number: a sane universal default doesn't exist (a legitimate ask_human wait or a slow
  // build can validly outlast any fixed idle window — see turn-controller.ts's header
  // comment), so this ships opt-in rather than guessing a value that breaks someone's turn.
  idleTimeoutMs: z.number().int().positive().optional(),
  maxTurnDurationMs: z.number().int().positive().optional(),
  inherit: z.object({
    settingSources: z.array(z.enum(["user", "project", "local"])).default([]),
    // WS-E: the old `plugins: boolean` here was parsed-but-never-read dead weight.
    // Removed in favor of the first-class, explicit `plugins` field below (the SDK's
    // SdkPluginConfig[] shape) — one obvious source of truth. A meaningful
    // "child inherits the parent's resolved plugins" flag would need supervisor
    // spawn-resolution plumbing, which is out of this workstream's protocol+backend
    // scope; revisit there if/when parent→child capability inheritance is added.
  }).default({ settingSources: [] }),
  // SPAWN-SETTING-SOURCES: the friendly on/off surface for `inherit.settingSources` above —
  // that raw array is faithful to the SDK's own --setting-sources vocabulary but was
  // reachable ONLY by hand-authoring a role (no agent_spawn field, no app/TUI control), which
  // is exactly why a plugin-dependent agent spawned ad hoc could never see its plugin's MCP
  // tools. true/false here always win outright, overwriting `inherit.settingSources` with
  // ["project","user"] / [] respectively — a caller who wants a CUSTOM source list (e.g. just
  // "user", or "local") still sets `inherit.settingSources` directly and leaves this unset.
  // Tri-state via plain `.optional()` (no `.default()`): undefined reliably means "no opinion"
  // post-parse, the same trick resolveAgentSpec's own isolation/readOnly resolution already
  // relies on — supervisor.spawn() reads that absence as license to fall back to a spawn's
  // resolved PROJECT's own loadProjectSettings toggle (see supervisor.ts SPAWN-SETTING-SOURCES)
  // rather than silently defaulting every agent everywhere, which would inflate the token cost
  // of the entire fleet (see backends/claude.ts's TOKEN-EFF-2/LEAN-AGENT-MCPS). Omitted ⇒
  // byte-identical to every spec/role that predates this field.
  loadSettings: z.boolean().optional(),
  mcpServers: z.record(z.string(), z.unknown()).default({}),
  // W2-4 PER-AGENT-TOOL-ALLOWLIST: a CLOSED-WORLD MCP grant keyed by server name, with
  // each value using that server's native (unprefixed) tool names. Optional with NO default:
  // omitted preserves every server-level enabled_tools/disabled_tools setting byte-for-byte.
  // When present, codex.ts intersects each listed value with the server's configured
  // enabled_tools (if any), gives an unlisted server an empty enabled_tools list, and preserves
  // disabled_tools as a final deny. The pinned Claude SDK has no equivalent positive MCP
  // availability filter (allowedTools is auto-approval, tools covers built-ins), so Claude
  // deliberately leaves this Codex-only capability unapplied rather than faking parity.
  mcpToolAllowlist: z.record(
    z.string().min(1),
    z.array(z.string().min(1)),
  ).optional(),
  // LEAN-AGENT-MCPS: the first-class, per-role/per-spec toggle for the SDK's own
  // --strict-mcp-config (SettingSource-independent — decouples from `inherit.settingSources`
  // above, which governs skills/CLAUDE.md only). Optional with NO default: omitted defers
  // entirely to the daemon's leanAgentContext config default (see supervisor.ts's LEAN-AGENT-
  // CONTEXT block), byte-identical to before this field existed. true ⇒ claude.ts passes the
  // SDK's strictMcpConfig:true, so ONLY `mcpServers` above (plus the always-injected `chimera`
  // server — see claude.ts, never droppable regardless of this flag) loads; every project
  // .mcp.json/user-settings/plugin/subagent-frontmatter MCP server is ignored. false pins the
  // spec OFF regardless of the daemon default (the same "a spec that set it is never overridden"
  // escape hatch `providerOptions.strictMcpConfig` already gave — this is the typed, discoverable
  // front door to the identical mechanism, not a second one). Claude-only: verified against the
  // pinned SDK's own sdk.d.ts (strictMcpConfig on Options); codex has no equivalent knob.
  strictMcpConfig: z.boolean().optional(),
  // WS-E (native-CLI-parity: load plugins from spec): native plugins to load for
  // this agent, forwarded to the SDK's options.plugins. Optional + defaulted to []
  // so every existing spec is byte-for-byte unaffected (empty → the key is omitted
  // from SDK options, see backends/claude.ts).
  plugins: z.array(PluginConfigSchema).default([]),
  // LEAN-AGENT-SKILLS: which skills this agent may see. The SDK's `skills` option is a separate
  // control from settingSources, and its default is the trap: "omitted ⇒ no SDK auto-configuration.
  // The CLI's own defaults still apply, so this is NOT skills off." chimera never passed it, and
  // measured the consequence — agents spawning with settingSources:[] still carried ~348 skills in
  // every prompt, re-read on every call.
  //
  // Tri-state, the same shape as loadSettings above: undefined means "no opinion", so the daemon's
  // leanAgentContext default decides; [] means none; a list is an allowlist. NOT a sandbox — the
  // SDK hides unlisted skills from the model and refuses them at the Skill tool, but the files stay
  // readable on disk.
  skills: z.array(z.string()).optional(),
  // ADVISOR-TOOL: the model backing the CLI's server-side advisor tool (`--advisor <model>`, alias
  // or full id). A second, usually stronger model the agent can consult mid-task; the CLI only
  // offers the tool when a model is configured, and refuses one that does not support it.
  //
  // Per SPAWN, because "who should this agent be able to ask" is a property of the work: a cheap
  // worker draining a queue and a conductor deciding an architecture want different answers, or
  // none. Unset falls back to the daemon-wide default (config.advisorModel), so an operator who
  // wants it fleet-wide sets it once and every spawn inherits.
  advisorModel: z.string().optional(),
  // COMPACTION-THRESHOLD-PER-AGENT: the context window this agent compacts against, in tokens.
  // Unset inherits the account/provider default, which inherits the model's native window — and for
  // a 1M model that means compacting only near 1M. Measured, cost is roughly turns x average
  // context, so a conversation allowed to reach 900k pays for 900k on every remaining turn.
  //
  // Per agent because the right window is a property of the WORKLOAD: a long research run needs the
  // room, a queue worker doing bounded tasks never will. The CLI compacts at ~90% of this (measured:
  // a 1M window peaked at 896k), so 500_000 here lands compaction near 450k. Clamped to the SDK's
  // valid range at the backend, which reports when it clamps.
  //
  // NULLABLE so agent_reconfigure can CLEAR it: absent means "unchanged" in a sparse patch, which
  // leaves no way to say "drop my override and go back to the account/provider default" — the
  // same reason maxBudgetUsd beside it is nullable. Null and absent resolve identically at spawn
  // (supervisor's `??`), so null never reaches a backend.
  compactionThreshold: z.number().int().positive().nullable().optional(),
  orchestration: z.object({
    allow: z.boolean().default(false),
    maxDepth: z.number().int().positive().default(2),
  }).default({ allow: false, maxDepth: 2 }),
  crossProviderFailover: z.boolean().default(false),
  // "/" rejected today (fail-fast: a qualified deliverTo would silently write a
  // mailbox file into a nonexistent subdirectory). Phase 5 RELAXES this regex —
  // widening accepted input is never breaking.
  deliverTo: z.string().regex(/^[^/]+(\/[^/]+)?$/).nullable().default(null),   // Phase 5: at most one engine qualifier
  // PLAN-HOOKS.md §4.3 (HOOK-2 gap fix b): a deliverTo target that already settled before this
  // child's result arrives used to drop the mail silently (deliverPending's running-only guard,
  // supervisor.ts's afterResult). Opt-in per-CHILD (not per-target — the target may have many
  // children with different needs): "resume" wakes the settled target the same way
  // checkPendingOnSettle resumes a stuck user_message; omitted (the default) surfaces an explicit
  // undeliveredMessage status event instead of silence, never a silent drop.
  deliverWake: z.enum(["resume"]).optional(),
  // spec §7: budget ceiling for this spawn's own subtree. FEATURE-5: no longer root-only —
  // ANY spawn (root or descendant) may declare its own bounded allocation; supervisor.spawn
  // admits it only if it fits within every ANCESTOR's remaining budget too (hierarchical,
  // pre-flight), and cost booked against a descendant propagates up to every ancestor node
  // that also has one registered.
  maxBudgetUsd: z.number().positive().nullable().default(null),
  conductor: z.boolean().default(false),   // Phase 3: hosted session, input stream stays open across turns
  // Ad-hoc sessions design §1/§7: marks this spawn as a SESSION-tier agent (a transient
  // investigation, not a project conductor) — purely a UI/list-bucketing + batch-close marker,
  // no behavior change to spawn/scheduling itself. Additive default false: every existing spawn
  // (including every conductor/team-role spawn) is unaffected.
  session: z.boolean().default(false),
  // AGENT-GROUPS Phase 1: operator-defined wrapper-box membership (group.list/agent.setGroups)
  // — a spawn silently inherits the operator's currently-focused group, if any (app-local, not
  // a protocol concept). Additive default []: every existing spec/role parses byte-identical.
  // Array (not a single id) costs nothing now and avoids a schema migration for the deferred
  // Phase-2 multi-assign gesture, even though Phase 1's own UI only ever sets/shows one.
  groups: z.array(AgentGroupIdSchema).max(8).default([]),
  persistent: z.boolean().default(false),  // Task A2: long-lived worker, input stream stays open across turns (mirrors conductor)
  on: z.object({
    permissionRequest: z.enum(["auto", "poke:caller", "tui"]).default("auto"),
  }).default({ permissionRequest: "auto" }),
  providerOptions: z.record(z.string(), z.unknown()).default({}),
  resume: z.string().nullable().default(null),   // Task RS1: SDK session id to resume, or null for a fresh session
  // Task CR1: with `resume` set, resume the session but do NOT push the original prompt as an
  // initial message — the agent resumes idle and waits for the first `send` (used to re-attach a
  // persistent conductor after a daemon restart).
  resumeOnly: z.boolean().default(false),
  // PLAN-HOOKS.md §3.3 (HOOK-4): set when a HookEngine `spawn` action created this agent — null
  // for every ordinary spawn. Sparse-parse-compatible default null — every pre-existing spec
  // parses unchanged.
  cause: HookCauseSchema.nullable().default(null),
}).strict();
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

// PLAN-PROJECT-CONDUCTOR-ROUTING P1-T1: the out-of-band team/role/project side-channel
// carried alongside a spawn (core's engine.ts SpawnParams.membership) and stamped onto the
// resulting AgentRecord (core's supervisor.ts AgentRecord.membership) — NEVER on the strict
// AgentSpecSchema itself (a plain agent.spawn has no membership at all, so this always rides
// beside the spec, not inside it). `projectId` is additive/optional: existing {team, role}
// callers are unaffected, and a spawn with no project context simply omits/nulls it.
export const AgentMembershipSchema = z.object({
  team: z.string().min(1),
  role: z.string().min(1),
  projectId: z.string().nullable().default(null),
}).strict();
export type AgentMembership = z.infer<typeof AgentMembershipSchema>;

// PLAN-PROJECT-CONDUCTOR-ROUTING P3-T1: two further AgentRecord fields, RECORD-LEVEL
// (not nested in `membership` above, and not schema-enforced here — AgentRecord itself is a
// plain TS type in core's supervisor.ts, never a zod schema, same treatment as gitBranch/
// turnBudgetExceeded; it rides the agent.list wire snapshot verbatim).
//   - `parentId: string | null` — the id of the agent that CALLED agent.spawn to create this
//     one (captured at spawn time from an explicit caller-supplied param), or null for a
//     spawn with no live spawning agent (scheduler/UI/reattach-originated). Replaces the
//     reducer's depth+createdAt parent-reconstruction heuristic (ui-state/reducer.ts
//     treeOrder) with an exact edge.
//   - `projectId: string | null` — the owning project's name, either explicit or derived at
//     spawn time via `isPathUnder(spec.cwd, project.path)`. Independent of (and may duplicate)
//     `membership.projectId` above: a project conductor carries `projectId` with no
//     `membership` at all, so the two can't be merged into one carrier.
// Both are additive/optional on the wire — an older daemon's records simply omit them, and
// UI consumers (P3-T2/P3-T3) fall back to the existing heuristic when absent.

// ---------- normalized events (spec §5) ----------
export const EventKindSchema = z.enum([
  "agent_started", "message_delta", "message_complete", "tool_call", "tool_result",
  // R2 (inline sub-agent/workflow surfacing): `message_complete`/`tool_call`/`tool_result` gain an
  // OPTIONAL `parentToolUseId?: string` field, present only when the Claude Agent SDK tagged the
  // underlying message with a non-null `parent_tool_use_id` — i.e. it originated inside a
  // subagent's own turn (a native Task/Agent-tool sub-agent or inline workflow), not the top-level
  // agent. `tool_call` already carried this (native-CLI-parity Phase 1); `message_complete`/
  // `tool_result` now do too. ADDITIVE — a top-level message's `parent_tool_use_id` is `null`, so
  // this field is simply absent for the overwhelming majority of events (byte-identical to
  // before). The supervisor resolves it against the originating `agent_task`'s `toolUseId` (see
  // below) to re-emit the event under a synthetic shadow agentId instead of the real parent's —
  // see supervisor.ts's `upsertShadow`/`subagentToolUseIndex`.
  "permission_request", "agent_question", "turn_complete", "result", "error", "failover", "status",
  // native-CLI-parity Phase 1 (Task N1): subagent/workflow task lifecycle, mapped from the
  // Claude Agent SDK's system task_started/task_progress/task_updated messages. ADDITIVE — data
  // stays a loose z.record; documented (not schema-enforced) shape: { taskId, toolUseId?,
  // parentToolUseId?, subagentType?, taskType?, workflowName?, description?, status?, usage?,
  // lastToolName?, summary?, error?, skipTranscript? } — all optional except taskId.
  // R2: `taskId`+`toolUseId` are now load-bearing beyond the shadow row's label/identity — the
  // supervisor indexes `toolUseId -> shadow agentId` off them so a LATER `message_complete`/
  // `tool_call`/`tool_result` carrying that same `toolUseId` as its `parentToolUseId` (above) can
  // be routed into this task's own shadow transcript instead of leaking into the parent's.
  "agent_task",
  // native-CLI-parity Phase 2 (Task DLG1): native interactive dialogs (AskUserQuestion /
  // elicitation), provider-agnostic — mirrors agent_question's ask→answer round-trip but for
  // dialogs the backend itself blocks on (decideDialog), not the ask_human MCP tool. ADDITIVE —
  // data stays a loose z.record; documented (not schema-enforced) shape: { dialogId, dialogKind,
  // payload, toolUseId? }.
  "agent_dialog",
  // native-CLI-parity Phase 3 (Task SC1): the SDK's live slash-command list push
  // (SDKCommandsChangedMessage, subtype:"commands_changed") — REPLACE semantics, the full
  // current list. ADDITIVE — data stays a loose z.record; documented (not schema-enforced)
  // shape: { commands: SlashCommand[] } where SlashCommand = { name, description,
  // argumentHint, aliases? }.
  "commands_changed",
  // WD Stage 2 (coverage B14, host tool policy): emitted by the supervisor's
  // decidePermission gate when a Bash call names a host tool whose effective
  // toolPolicy mode is "deny" — the call is rejected outright (no permission
  // round-trip) and this event is the audit record. ADDITIVE — data stays a loose
  // z.record; documented (not schema-enforced) shape: { tool, profile?, command,
  // requestId } where `tool` is the denied CLI (e.g. "kubectl"), `profile` the
  // detected context/profile when one was parsed from argv/env, `command` the full
  // (scrubbed) Bash command string.
  "policy_denied",
  // FEATURE-6 (capability broker / Policy Decision Point): emitted by CapabilityBroker on
  // EVERY decision (allow/deny/prompt), for BOTH host-tool (Bash) and mcp_store_call
  // actions — the unified audit trail unifying authorization was supposed to produce.
  // ADDITIVE — data stays a loose z.record; documented (not schema-enforced) shape is
  // CapabilityDecisionEvent (see its definition above ToolPolicySchema): { principal,
  // action, resource, decision, reason, tool?, profile?, command?, server?, mcpTool? }.
  // agentId on the event envelope is `principal` when known (so it lands in that agent's
  // own tail, next to policy_denied/permission_request), else the system namespace
  // "capability" (mirrors "config"/"network"/"federation").
  "capability_decision",
  // D7 (config management & hot-reload, coverage C9/C10 · B16): the config watcher's
  // diff-apply signals. ADDITIVE — data stays a loose z.record; documented (not
  // schema-enforced) shapes:
  //   config_changed { keys: string[] } — the changed top-level config keys of a
  //     SUCCESSFUL application (a config.patch RPC or a hot-reload of config.json /
  //     config.d/*). The UI refreshes itself off this (no refresh button).
  //   config_error { message: string } — a broken config.json/overlay was seen by the
  //     watcher; the OLD config stays active and the daemon never crashes. The message
  //     is scrubbed of secret-shaped substrings before it is emitted (D0 invariant).
  // Both carry agentId "config" (mirrors the "project:"/"team:" system-event namespacing).
  "config_changed",
  "config_error",
  // QUOTA-UNCOOL: an account's failover/session-limit cooldown was dropped BEFORE its stamped
  // deadline, because something proved the deadline wrong. Carries agentId "accounts" (mirrors
  // the "config"/"network"/"federation" system-event namespacing; registered in ui-state's
  // SYSTEM_EVENT_AGENT_IDS so it never materialises an agent row). ADDITIVE — data stays a loose
  // z.record; documented (not schema-enforced) shape:
  //   account_cooldown_cleared { account, clearedBy: "quota-poll"|"operator", clearedUntil,
  //     resumed: string[], evidence?: { usedFraction, windowStartedAt, resetsAt, rolled } }
  // `clearedUntil` is the deadline that was dropped and `evidence` the quota reading that
  // disproved it — together they are the whole audit answer to "why did this account come back
  // early?", which a bare status event could not give.
  "account_cooldown_cleared",
  // D6 (Network & tailscale, coverage C6 · B15 · F09/F10): the NetworkManager's signals.
  // ADDITIVE — data stays a loose z.record; documented (not schema-enforced) shapes:
  //   network_changed { installed, loggedIn, ip4, magicDNS, tailscaleSSH } — the freshly-probed
  //     tailscale state, emitted whenever it differs from the last emitted state (the fed.network
  //     5s-cached probe, `fed.network.up`, or a successful startup auto-join drive this). The UI
  //     refreshes the network block + IP chip off it. Carries NO secret (it is the same shape
  //     fed.network returns).
  //   network_error { message } — a startup auto-join (`tailscale up --auth-key`) failed. The
  //     message is SCRUBBED of secret-shaped substrings before it is emitted so the auth key
  //     (tskey-…) can never reach the log (D0). The daemon never crashes on a failed join.
  // Both carry agentId "network" (mirrors the "config"/"project:" system-event namespacing).
  "network_changed",
  "network_error",
  // D8 (pairing + multi-peer mesh, coverage C7 · B15 · F10): emitted when a new peer is
  // PINNED into the config.d overlay — on the RESPONDER when an unknown peer presents a
  // valid unburned invite token (TOFU auto-pin + token burn), and on the JOINER when
  // fed.join completes. ADDITIVE — data stays a loose z.record; documented (not
  // schema-enforced) shape: { engineId, direction: "joined"|"accepted" }. Carries NO
  // secret — the invite token NEVER appears here (only its hash ever touches disk).
  // agentId "federation" (mirrors the "config"/"network" system-event namespacing).
  "peer_paired",
  // D10 (scheduled actions, coverage C12): the JobScheduler's signals, all carrying
  // agentId `job:<name>` (mirrors the "config"/"network"/"federation" system-event
  // namespacing). ADDITIVE — data stays a loose z.record; documented (not
  // schema-enforced) shapes:
  //   job_run_started  { job, agentId?|taskId?, trigger, latenessMs?, coalescedOccurrences? }
  //     — a run actually kicked off. F01(c) adds the last two, present together or not at all and
  //     only when trigger is "sleep-wake". F04 adds { nominalFireTs, idempotencyKey }, always
  //     carried (nominalFireTs null for a manual run that served no slot), and `readopted: true`
  //     when reconcileBoot re-adopted a still-live run at boot. F01-QA follow-up adds
  //     { jobName, runId }, always carried: jobName mirrors AgentRecord.jobName so a client can
  //     attribute this event to the agent it spawned without cross-referencing the `job` field's
  //     string against a separate job-lookup; runId is idempotencyKey when non-null, else the same
  //     `job:<name>:manual-<now>` fallback the in-flight marker persists for a manual run, so
  //     runId (unlike idempotencyKey) is never null.
  //   job_run_finished { job, agentId?|taskId?, result: "ok"|"failed", costUsd, error? }
  //     — F04: `result:"failed"` may now carry `reason: "daemon-crash"` (a re-adopted-but-gone
  //     in-flight marker found at boot) or `reason: "daemon-crash-prespawn"` (a marker that never
  //     reached a target, so its slot stays unserved and the catch-up sweep may re-fire it).
  //   job_skipped      { job, reason: "overlap"|"missed-restart"|"duplicate-occurrence"
  //     |"stale-beyond-window" } — overlapPolicy "skip" no-op'd against a still-running previous
  //     run; a schedule missed while the daemon was down (catchUp:false); F04: a second fire for an
  //     occurrence already served ({nominalFireTs, idempotencyKey, trigger} also carried); or a
  //     catch-up occurrence older than catchUpMaxStalenessMs ({nominalFireTs, lateMs,
  //     maxStalenessMs} also carried).
  //   job_disabled     { job, reason } — 3 consecutive failed runs auto-disabled the
  //     job (the UI re-arms it via job.update({enabled:true}), see W15/"space").
  //   JOB-OUTPUT-TRIGGER / JOB-WATCH:
  //   job_trigger_fired     { job, dispatch, matched, agentId?|taskId? } — a command's output met
  //     its trigger condition and woke an agent. `matched` is bounded and redacted like `output`.
  //   job_trigger_throttled { job, sinceLastMs, minIntervalMs } — it matched, but too soon after
  //     the last one. Emitted rather than dropped silently: a watch job that looks idle because it
  //     is being throttled is indistinguishable from one whose condition never matches.
  //   job_trigger_failed    { job, error } — matched, but the dispatch itself could not start.
  //   job_watch_started     { job, pid }        — the supervised process is up.
  //   job_watch_exited      { job, code, restartInMs } — it died; restartInMs is when we retry.
  "job_run_started",
  "job_run_finished",
  "job_skipped",
  "job_disabled",
  //   job_dead_letter  { job, attempts, maxAttempts, nominalRunTs, reasons: [{ts, error}] }
  //     — F05: the retry policy is spent; the job is STOPPED and its occurrence quarantined.
  //     job_requeue is the INTENDED exit, but not the only one — job_update{enabled:true} takes
  //     the same `reenabled` branch (jobs.ts update()) and clears the dead-letter state just as
  //     thoroughly, so a consumer must not treat this event as "stopped until a requeue arrives".
  //     Emitted ALONGSIDE job_disabled (never instead of it): the
  //     coarse "it stopped" every existing consumer already handles stays exactly as it was, and
  //     this carries the structured why. Carries no command string and no prompt — `reasons` is
  //     the same text already persisted in JobRunEntry.error, redacted upstream by fire()'s clean().
  "job_dead_letter",
  // F02 (bounded timer hops / clock-jump detection): the JobScheduler noticed that a timer hop
  // returned far from when it armed it — a machine suspend, a VM pause, an NTP step, a DST-driven
  // clock move. agentId "clock" (mirrors the "config"/"network"/"federation" system-event
  // namespacing; registered in ui-state's SYSTEM_EVENT_AGENT_IDS so it never materialises an agent
  // row). ADDITIVE — data stays a loose z.record; documented (not schema-enforced) shape:
  //   { driftMs, observedGapMs, expectedGapMs, thresholdMs,
  //     direction: "forward"|"backward", source: "jobs" }
  // driftMs = observedGapMs - expectedGapMs, signed. It says a gap HAPPENED and how big it was;
  // it says nothing about what any late job should do — that disposition is F01(c)'s.
  "clock_jump",
  // F01(a) (RTC wake before the next run, opt-in): agentId "wake" (a synthetic system namespace
  // like "clock"/"config"; registered in ui-state's SYSTEM_EVENT_AGENT_IDS so it never
  // materialises an agent row). ADDITIVE — data stays a loose z.record; documented (not
  // schema-enforced) shapes:
  //   job_wake_scheduled { atMs, forJob, leadMs } — an OS wake was scheduled for atMs so that job
  //     `forJob` (the soonest one) is served on time. At most ONE is outstanding at a time.
  //   job_wake_failed    { atMs, reason } — the wake wrapper refused or is not installed. The
  //     schedule itself is unaffected: F01(c) still fires the job late and labels it "sleep-wake".
  // NEITHER carries a command, a prompt or a path — same audit rule as job_run_started.
  "job_wake_scheduled",
  "job_wake_failed",
  // F01-QA-follow-up: the wake CAPABILITY (not a single schedule attempt) changing — the first
  // time a probe reports unavailable, and again only if availability flips either way. Unlike
  // job_wake_scheduled/job_wake_failed this is not per-hop (armTimer would otherwise spam it
  // every ~60s forever on the common machine that never opted in), and it exists because
  // wakeScheduling is a job.status field: a TUI-only operator with no job selected had no signal
  // at all that the machine can't keep a schedule. agentId "wake". ADDITIVE — data stays a loose
  // z.record; documented shape: { available, reason, setupHint }.
  "job_wake_capability",
  // BACKGROUND-TASK-VISIBILITY: an agent's OWN backgrounded shell work (`taskType: "local_bash"`),
  // which upsertShadow deliberately refuses to turn into a fake sub-agent row — correctly, since it
  // is not an agent, but the consequence was that a script an agent kicked off was invisible
  // everywhere. This carries the AUTHORITATIVE live set after every change (SDK
  // `background_tasks_changed`, REPLACE semantics): { tasks: [{ taskId, taskType, description }] }.
  // `ambient` housekeeping tasks are filtered out at the backend — the SDK explicitly says hosts
  // should keep them out of activity indicators.
  "background_tasks",
  "job_trigger_fired",
  "job_trigger_throttled",
  "job_trigger_failed",
  "job_watch_started",
  "job_watch_exited",
  // D12 (task workflows, coverage C14): the step-gate machine's signals, carrying
  // agentId `task:<taskId>` (mirrors the ordinary `status` task-lifecycle event's own
  // namespacing — a workflow-bound task still emits the normal status{state:...} events
  // alongside these; a step-advance to the FINAL step's passed gate is immediately
  // followed by status{state:"done"}, not a separate "workflow complete" event).
  // ADDITIVE — data stays a loose z.record; documented (not schema-enforced) shapes:
  //   task_step_advanced { taskId, queue, workflow, version, stepIndex, stepId, title }
  //     — the step at `stepIndex`'s gate PASSED (0-based; this event fires for step 0 too,
  //     the moment the task is picked up).
  //   task_step_failed { taskId, queue, workflow, version, stepIndex, stepId, reason,
  //     willRetry } — the step at `stepIndex`'s gate FAILED; willRetry:true means
  //     onFail:"retry" is re-running the SAME step (stepAttempts < retryLimit); false
  //     means this is the final, halting failure (immediately followed by
  //     status{state:"failed"}).
  "task_step_advanced",
  "task_step_failed",
  // F16.1 Phase 3 (WF-9, data handoff): fired by the scheduler at EVERY step-boundary
  // role switch (switchStepAgent), whether or not a handoff summary was actually
  // collected — agentId `task:<taskId>` (mirrors task_step_advanced's namespacing).
  // ADDITIVE — data stays a loose z.record; documented (not schema-enforced) shape:
  //   task_step_handoff { taskId, queue, workflow, version, fromStepIndex, toStepIndex,
  //     fromAgentId, toAgentId, role, summaryBytes } — toAgentId is null when the switch
  //     parked on a spawn guardrail (see task_step_advanced's identical parked case);
  //     summaryBytes is 0 for a context:"none" step or an artifacts-only fallback
  //     (summarize turn failed/timed out) — see StepHistoryEntry.handoffSummary.
  "task_step_handoff",
  // WorkflowGraph: emitted once by beginFanOut when a fan-out step spawns its FIRST wave of
  // branch tasks (bounded fan-out: branchTaskIds is just this wave's ids, not necessarily every
  // item — see task_fan_out_batch below for later waves; totalItems/totalBranches cover the
  // full fan-out). ADDITIVE — data stays a loose z.record; documented (not schema-enforced)
  // shape: task_fan_out { taskId, queue, workflow, version, stepIndex, stepId, joinStepIndex,
  //     branchTaskIds: string[], totalItems, totalBranches }.
  "task_fan_out",
  // WorkflowGraph (bounded fan-out): emitted by the scheduler's tick() admission loop each time
  // a LATER wave of branch tasks is admitted (maxParallel-bounded fan-outs only — an unbounded
  // fan-out never emits this, its one wave is the task_fan_out above). ADDITIVE — data stays a
  // loose z.record; documented (not schema-enforced) shape: task_fan_out_batch { taskId, queue,
  //     workflow, version, stepIndex, stepId, joinStepIndex, branchTaskIds: string[],
  //     remaining: number }.
  "task_fan_out_batch",
  // Dynamic Planner: emitted once by beginPlanDispatch when a `plan`-gated step's compiled
  // ephemeral WorkflowRecord is dispatched as a single nested child task. ADDITIVE — data
  // stays a loose z.record; documented (not schema-enforced) shape:
  //   task_plan_dispatched { taskId, queue, workflow, version, stepIndex, stepId,
  //     joinStepIndex, planWorkflow, planVersion, planStepCount, childTaskId }.
  "task_plan_dispatched",
  // Nested sub-workflows: emitted once by beginSubWorkflow when a `subWorkflow` step
  // dispatches its resolved recipe as a single nested child task. ADDITIVE — data stays a
  // loose z.record; documented (not schema-enforced) shape:
  //   task_sub_workflow_dispatched { taskId, queue, workflow, version, stepIndex, stepId,
  //     joinStepIndex, recipeName, recipeVersion, childWorkflow, childVersion, childTaskId }.
  "task_sub_workflow_dispatched",
  // FEATURE-2 (durable checkpoint-resume): emitted by queues.ts's checkpointStep() every time a
  // fresh durable-resume checkpoint is captured for a workflow-bound task's current step. NOT
  // the same concept as D16's checkpoint_created/checkpoint_reverted below (those are agent-
  // requested git-ref snapshots) — this is engine-internal durable-execution bookkeeping.
  // ADDITIVE — data stays a loose z.record; documented (not schema-enforced) shape:
  //   workflow_step_checkpoint { taskId, stepIndex, idempotencyKey, workdirKey, branch,
  //     commitSha, gateAttempts, capturedAt } (mirrors TaskStepCheckpoint verbatim).
  "workflow_step_checkpoint",
  // D13 (artifact registry, coverage C15): fired by ArtifactStore.add — carries agentId
  // `artifact:<id>` (mirrors the "task:"/"workflow:" system-event namespacing). ADDITIVE —
  // data stays a loose z.record; documented (not schema-enforced) shape:
  //   artifact_added { id, kind, label, agentId, taskId, sizeBytes } — sizeBytes is null
  //   for a "link" artifact (no snapshot taken).
  "artifact_added",
  // D8 residual (peer link liveness, coverage C16/F18): emitted by FederationManager whenever a
  // peer's link transitions INTO "partitioned" (PeerLink.setState only calls onStateChange on
  // an ACTUAL state change — the initial "connecting" boot never fires this). A still-dead peer
  // cycling connecting→partitioned on each failed reconnect attempt DOES re-fire it every time;
  // the notify rule's own throttle window is what collapses a chatty/flapping peer into one
  // delivery, not this event itself. ADDITIVE — data stays a loose z.record; documented shape:
  // { engineId }. agentId "federation" (mirrors peer_paired's system-event namespacing).
  "peer_partitioned",
  // spec §7 residual (tree budget warning, coverage C16/F18): emitted by the supervisor's
  // trackTreeCost the FIRST time a tree's accumulated cost crosses 80% of its maxBudgetUsd
  // ceiling (fires at most once per tree — the 100% breach still pauses the tree via the
  // existing `status{reason:"budget"}` event, unchanged). ADDITIVE — data stays a loose
  // z.record; documented shape: { treeId, totalCostUsd, maxBudgetUsd, pct }. agentId is the
  // treeId (mirrors the pause event's own namespacing).
  // F50: `estimatedUsd` rides both budget_warning and status{reason:"budget"} — the share of
  // totalCostUsd that was DERIVED from token counts rather than reported by a provider. 0 means
  // every dollar was measured. An operator surface must never present a total containing a
  // non-zero estimatedUsd as a measurement (banner copy prefixes it with "~").
  // `afterResume: true` on a status{paused:true} means this node had been released by
  // budget.resume and re-breached — it is a SECOND breach, not the first.
  "budget_warning",
  // FEATURE-5 (hierarchical budget governor): a PRE-FLIGHT admission denial — distinct from
  // budget_warning (post-hoc 80% crossing) and status{reason:"budget"} (post-hoc 100% breach
  // pause). Emitted by supervisor.spawn() when a spawn's requested maxBudgetUsd would exceed
  // an ancestor node's remaining budget, OR that ancestor is already exhausted, BEFORE the
  // spawn is admitted (no state mutated on the denied ancestor). ADDITIVE — data stays a loose
  // z.record; documented shape: { nodeId, parentId, treeId, requestedUsd, remainingUsd,
  // maxBudgetUsd }. agentId is nodeId (the ancestor budget node that would have been
  // exceeded), mirroring budget_warning's own agentId=treeId namespacing. requestedUsd is
  // null when the denial is "ancestor already exhausted" rather than "this spawn's own
  // ceiling doesn't fit".
  "budget_denied",
  // D14 (notifications, coverage C16, F18): the rule evaluator's own signals, both carrying
  // agentId "notify" (mirrors the "config"/"network" system-event namespacing). ADDITIVE —
  // data stays a loose z.record; documented shapes:
  //   notify       { ruleId, kind, channel, agentId, count } — a rule's throttle window
  //     closed and delivery happened (os/toast render off this; a2a/webhook append it too,
  //     alongside their own success, so the UI has one place to show "delivered").
  //   notify_error { ruleId, channel, message, attempts? } — delivery failed (a2a: no
  //     resolvable target; webhook: all retries exhausted) — logged only, never blocks
  //     the event stream and never retried again for that window.
  "notify",
  "notify_error",
  // D16 (checkpoints, coverage §C18, F20): CheckpointStore's own signals, carrying
  // agentId `checkpoint:<id>` for a creation (mirrors "artifact:<id>" namespacing) or the
  // repo's resolved toplevel path for a revert (no single id — a revert is keyed by the
  // ref reverted TO, already in `data.id`). ADDITIVE — data stays a loose z.record;
  // documented (not schema-enforced) shapes:
  //   checkpoint_created  { id, ref, trigger, ts, agentId, taskId, cwd }
  //   checkpoint_reverted { id, ref, cwd }
  "checkpoint_created",
  "checkpoint_reverted",
  // LIVE-CTX-USAGE: an in-flight, non-terminal usage snapshot — backends emit this as soon
  // as a turn's real context size is known (Claude SDK stream's message_start) and again as
  // output tokens tick up (message_delta), so the ctx meter/tokens column advance DURING a
  // turn instead of jumping only at turn_complete/result. ADDITIVE — data stays a loose
  // z.record; documented (not schema-enforced) shape: { usage: {...} } in the SAME raw
  // per-provider field names extractUsage() already reads off turn_complete/result (claude:
  // input_tokens/output_tokens/cache_read_input_tokens/cache_creation_input_tokens). The
  // reducer folds it latest-wins, same as turn_complete/result — never additive, and
  // turn_complete/result stay authoritative for the final value.
  // L1-MEASURE (F39): two additive, documented-only markers a spend/context audit needs to read
  // this stream WITHOUT guessing. `synthetic?: "compaction-baseline"` — this event is NOT an API
  // call: claude.ts sinks one after a compact_boundary purely to reset the live ctx meter to the
  // SDK's post_tokens, and a ledger that sums `usage` would bill those tokens at the full
  // fresh-input rate (measured 2026-09-02: 7 such events, 103,480 phantom input tokens), an error
  // that grows with exactly what a lower compaction threshold produces. `afterCompaction?: true`
  // — this is the FIRST real turn after a compact boundary, i.e. the call that pays the full
  // prefix-cache REWRITE the compaction actually cost (the boundary event itself is free);
  // stamped on the message_start snapshot only, never on the message_delta re-emissions of the
  // same turn, so counting it counts calls rather than deltas.
  "usage",
  // R2-DURABLE-LOG (durable event log + corruption recovery): emitted at most once per daemon
  // boot, into the FRESH active segment, iff EventLog's constructor-time integrity scan found
  // something — a sealed segment whose checksum/seq-continuity no longer matches its sidecar
  // (quarantined into events/quarantine/ rather than silently served with a skipped line) or a
  // seq-continuity gap across segments. agentId "eventlog" (system namespace, mirrors
  // "config"/"network"/"federation"/"capability"). ADDITIVE — data stays a loose z.record;
  // documented (not schema-enforced) shape: { quarantined: {file:string; reason:string}[],
  // seqGaps: {afterSeq:number; nextSeq:number}[] }.
  "event_log_recovery",
  // R2-TURN-LIFECYCLE: a backend-detected hang on the CURRENT turn's LLM/SDK stream call —
  // no activity for idleTimeoutMs, or the turn exceeded maxTurnDurationMs, whichever fired
  // first. Supervisor.onEvent routes this through the SAME onError/classifyError disposition
  // as a crashed backend (see failover.ts's "turn timed out" CRASH pattern) instead of
  // leaving the agent silently stalled. ADDITIVE — data stays a loose z.record; documented
  // (not schema-enforced) shape: { reason: "idle" | "max-duration", elapsedMs: number,
  // idleTimeoutMs?: number, maxTurnDurationMs?: number }.
  "turn_timeout",
  // R2 (self-healing supervision): AgentSupervisor.scheduleCrashRestart's terminal
  // disposition — a backend-crash-classified error (or a liveness-probe-reported wedge, or a
  // failed reattach) whose consecutive crashCount exceeds the configured CrashLoopPolicy.
  // Audit-trail-only, mirroring job_disabled's own dedicated-kind-alongside-generic-status
  // convention — replay/reattach never depend on THIS event; they depend on the paired
  // status{state:"failed", circuitOpen:true} event that always immediately follows it (every
  // other record.state="failed" transition in supervisor.ts is already paired with a status
  // event for that same FEATURE-4 replay-durability reason). ADDITIVE — data stays a loose
  // z.record; documented (not schema-enforced) shape: { crashCount: number; reason: string }.
  "circuit_breaker_tripped",
  // R2 (self-healing supervision): HealthMonitor's periodic liveness probe found a running,
  // non-shadow agent with no observed event for longer than its configured staleMs threshold.
  // Raised once per probe hit, immediately before AgentSupervisor.reportUnresponsive routes the
  // agent into the SAME crash-loop recovery path (scheduleCrashRestart) a real backend crash
  // uses. ADDITIVE — data stays a loose z.record; documented (not schema-enforced) shape:
  // { idleMs: number; thresholdMs: number }.
  "agent_unresponsive",
  // Collaborative review session mutation; data carries taskId, revision and decision.
  "review_changed",
  // PLAN-HOOKS.md §5 (HOOK-1): new push-based event sources for the proactive-hooks plan. All
  // ADDITIVE — data stays a loose z.record; documented (not schema-enforced) shapes below.
  //   task_state_changed { queue, taskId, state, prevState, resultPreview? } — emitted by
  //     QueueStore at EVERY t.state transition site (push, markInProgress, markDone,
  //     markFailed, markDeadLetter, markFailedAttempt, releaseForRetry, requeue,
  //     reconcileDependents, cascadeFailDependents (via markFailed), blockOnChildren,
  //     extendChildren, and the daemon-restart in_progress/blocked revert). `prevState` is
  //     null for a freshly pushed task (no prior state); `resultPreview` (≤2k chars) rides
  //     alongside a transition INTO "done", mirroring agent.settled's own resultPreview
  //     convention. Also fixes a UI gap — queue views previously had to poll queue_status for
  //     task-level state changes.
  "task_state_changed",
  //   queue_drained { queue } — emitted by QueueStore whenever a task_state_changed transition
  //     leaves its queue with zero "pending"/"in_progress"/"blocked" tasks (a "dead_letter" task
  //     does NOT count as active for this purpose — it survives independently of drain status
  //     until an operator calls queue.requeue).
  "queue_drained",
  //   memory_added { id, kind, tags, author } — MemoryStore.add() stays snapshot-silent (see its
  //     own class-comment amplification rationale: add() is comparatively frequent, and every
  //     event nudges SnapshotScheduler's event-count cadence) but now emits this ONE event so a
  //     subscriber/hook can react to new notes; edit()/delete() keep their pre-existing `status`
  //     events, unchanged.
  "memory_added",
  //   memory_pressure { total, limit, fill, threshold, nextToEvict:{id,title}|null } — F36:
  //     MemoryStore.checkPressure() emits this once when fill crosses evictionAlarmAt (edge-
  //     triggered, hysteresis 0.05 band to re-arm), ALWAYS before the store evicts anything —
  //     the alarm exists so an operator/subscriber sees loss coming, not after it happened.
  //     F36.FIX: it also re-arms every PRESSURE_REARM_EVICTIONS evicted records and on a
  //     `memory` config change, so a store parked at the cap (where fill can never fall back
  //     under the hysteresis band) still announces each subsequent pressure episode.
  "memory_pressure",
  //   memory_evicted { id, title, kind, author, folder, scope, value, inbound, pinned, archived }
  //     — F36: emitted per record when MemoryStore.prune() removes it to stay under capacity.
  //     A pass past MAX_EVICTION_EVENTS_PER_PASS emits one extra { truncated, total, archived }
  //     SUMMARY instead of the remaining per-record events. F36.FIX: `archived` says whether the
  //     pre-delete write to memory-evicted.jsonl actually SUCCEEDED, so a UI can say "archived,
  //     not lost" from the event rather than from the contract (an archive write is best-effort
  //     by design — a full disk must never break an add).
  "memory_evicted",
  //   repo_head_moved { repo, branch, from, to } — HOOK-5's RepoWatcher (debounced fs.watch on a
  //     known mainRepo's .git/refs/heads + packed-refs) will emit this on merge-to-main; the
  //     event kind is registered here so this slice's round-trip/contract tests are complete
  //     before that watcher exists. No emitter in THIS slice.
  "repo_head_moved",
  //   hook_fired { rule, eventSeq, chain, actions: [{type, ok, detail}] } / hook_error { rule,
  //     eventSeq, error } — HookEngine's (HOOK-4) own audit trail for a rule's actions running
  //     sequentially per firing. No emitter in THIS slice.
  "hook_fired",
  "hook_error",
  //   hook_suppressed { rule, reason, eventSeq } — HookEngine's (HOOK-4) audit record for the
  //     three loop-safety guards (causation chain depth, per-rule rate limit, self-cause
  //     suppression) declining to fire a rule — "every suppression is audited, never silent". No
  //     emitter in THIS slice.
  "hook_suppressed",
  //   signal_delivered { subscriptionId, eventSeq, topic } — one per fired subscription, emitted
  //     by the future SubscriptionRegistry (HOOK-2) alongside the mailbox `kind:"signal"` push.
  //     No emitter in THIS slice.
  "signal_delivered",
  // QUEUE-PAUSE: queue_paused { queue } / queue_resumed { queue } — emitted by QueueStore's
  // pause()/resume() on every call (even a no-op re-pause), mirroring queue.create/update/
  // delete's own unconditional `status` event convention. A dedicated kind (not a generic
  // `status`) so a UI/subscriber can react to the specific transition without inspecting data —
  // the app QueuesScreen and TUI Queues view fold these into their live paused badge.
  "queue_paused",
  "queue_resumed",
  // VOICE S2 (docs/superpowers/specs/2026-07-24-voice-agents-design.md §6): app-driven push-to-
  // talk/TTS event kinds. ADDITIVE — data stays a loose z.record per house style; no emitter in
  // THIS slice (S4 taps message_delta/message_complete to emit these; S5/S6 consume them).
  //   voice_partial_transcript { sessionId, text } — an in-progress (non-final) STT transcript
  //     chunk for the current push-to-talk capture.
  //   voice_tts_chunk { sessionId, text, final } — one sentence-chunked slice of agent output
  //     text destined for TTS playback; `final:true` on the last chunk of a turn.
  //   voice_session_state { sessionId, state } — the mic/session lifecycle, e.g.
  //     "listening" | "transcribing" | "speaking" | "idle" | "error".
  "voice_partial_transcript",
  "voice_tts_chunk",
  "voice_session_state",
  "voice_native_message",
  "voice_diagnostic",
  // ACCOUNT-QUOTA-METERS: a backend's live rate-limit snapshot for its own account. Today
  // claude.ts emits this from the SDK; Codex is populated by quota-poll.ts's app-server pull
  // source rather than a backend event. ADDITIVE — data stays a loose z.record;
  // documented (not schema-enforced) shape: { window: AccountQuotaWindow }.
  "quota",
  // LEDGER-UNCLEAN-EXIT: a ledger-only accounting event — supervisor.ts's settleUnrecordedUsage
  // emits this when a record settles to "killed"/"failed" WITHOUT ever producing a "result" (a
  // reap, a crash-loop circuit-breaker trip, a rerouted-launch failure, ...), using the last
  // cost/usage a "turn_complete" reported. ADDITIVE — data stays a loose z.record; documented
  // (not schema-enforced) shape mirrors "result"'s cost fields: { costUsd, billableUsage?,
  // model? }. Never carries `text`/state — it exists purely so usage.ts's ledger (which else
  // only listens for "result") can book spend that genuinely happened on a run that ended badly,
  // instead of silently recording $0. No consumer other than UsageLedger reads this today.
  "usage_settle",
  // COMPACTION-OBSERVABILITY: fires the moment context compaction actually runs — either
  // chimera's own mechanical compaction (backends/compaction.ts, generic/openai-compat only)
  // or a signal the backend's agentic SDK gave us that ITS native auto-compact just ran
  // (claude.ts's compact_boundary; codex's SDK exposes no such signal today — see
  // CODEX-COMPACTION-GAP in codex.ts, so codex never emits this). Previously this was
  // either entirely silent (generic.ts's splice) or buried in a bare status{compacted:true}
  // blob (claude.ts) — this is the first-class, cross-backend normalized version, the
  // transcript-rendered fact of "compaction happened, here is its real effect". ADDITIVE —
  // data stays a loose z.record; documented (not schema-enforced) shape: { trigger:
  // "budget"|"manual", owner: "chimera"|"sdk", budgetSource?: "operator"|"catalog"|
  // "hardcoded"|"default" (chimera-owned only — see compaction.ts's resolveCompactionBudget),
  // before: { messages?, chars?, tokens? }, after: { messages?, chars?, tokens? },
  // droppedRounds?: number (chimera-owned only), phase?: "start"|"aborted" }. COMPACTION-IN-
  // PROGRESS: `phase` brackets a compaction that is HAPPENING — "start" when one is triggered,
  // "aborted" when the trigger itself failed, and ABSENT for a completion (so every backend
  // emitter that predates this stays a completion event with no change). A UI folds "start" into
  // a live indicator; nothing counts a compaction until the phase-less completion arrives. `owner:"sdk"` never carries messages/chars
  // (the SDK reports pre/post TOKENS only) and never droppedRounds — the mechanism inside the
  // SDK's own compaction is opaque to chimera, so nothing here claims to know it "summarized"
  // vs "dropped" content; chimera's OWN compaction (owner:"chimera") mechanically collapses
  // oldest history (never an LLM summarization call, see compaction.ts's header) so its
  // droppedRounds count is exact, not a guess.
  // L1-MEASURE (F39): every emitter additionally documents WHAT THIS FIRED AGAINST, so an audit
  // never has to re-derive the trigger from a spawn record that may already have been pruned:
  // { thresholdInForce: number|null, thresholdSource: "spawn"|"account"|"provider"|"default"|
  // "native", model?: string, provider?: string, costUsd?: number }. `thresholdInForce` is
  // explicitly NULL (never an omitted key) when no chimera-managed threshold was in force and
  // the backend's own native trigger fired — an omitted key is indistinguishable from an event
  // written before this field existed. `thresholdSource` names WHICH rung of spawn > account >
  // providerOverrides > default answered ("native" ⇒ none did). `model` is the model the BACKEND
  // reported, not the one the spawn requested (supervisor.onEvent sniffs `data.model` on every
  // event kind to keep actualModel/the ctx-meter denominator live — a requested alias here would
  // silently overwrite the served model). `costUsd` is emitted only where it is a FACT, not an
  // estimate: generic.ts's chimera-owned compaction is a deterministic collapse and never an LLM
  // call, so it reports 0; an SDK-owned compaction's real price is invisible here (it is the
  // cache rewrite on the next call — see the `usage` afterCompaction marker above).
  "compaction",
  // TERMINAL-WRITE: an agent typing into its own terminal. The daemon cannot reach the PTY (it
  // lives in the desktop app), so the write travels as an event the app performs — the mirror of
  // terminal.append, which is how the output travels back.
  "terminal_input",
  // F26 (worktree bootstrap): the project's trusted setup hook running in AgentSupervisor.launch()
  // immediately before backend.spawn(), under the spawning agent's own agentId. ADDITIVE — data
  // stays a loose z.record; documented (not schema-enforced) shape: { phase: "start"|"chunk"|
  // "ok"|"fail", project, command, text?, exitCode?, durationMs?, truncated? }. "start" fires once;
  // "chunk" is line-buffered stdout+stderr flushed at most every 500ms; exactly one of "ok"/"fail"
  // is terminal.
  "worktree_setup",
  // F09 (prompt-effect verification): a message was DELIVERED to an idle agent and no
  // turn-opening event followed within the measured threshold (core's PROMPT_STALL_MS, derived
  // from docs/superpowers/measurements/2026-09-02-prompt-ack-latency.json). Data:
  // { deliveryId, from, sinceTs, sinceMs, lastSeq, messageCount, thresholdMs }. This is a
  // REPORT, never an action — nothing re-delivers, retries or touches the mailbox because of
  // it. A mid-turn delivery never produces this event (the message legitimately joins the
  // in-flight turn); the watch is armed only for a between-turns idle agent.
  "agent_prompt_stalled",
  // F49.QA-FIX2: the loopback MCP listener rejected a past-the-grant-id-gate request (401
  // bearer-reject, or either DNS-rebinding 403) — same AC-10 boundary as the mcp_listener_grant
  // audit-ledger append this event is emitted alongside (mcp-listener.ts's auditReject()); the
  // pre-gate 404/405s never emit, matching the ledger's own flood-guard. Data: { grantId,
  // agentId: string | null, reason }. `reason` is always one of the fixed literal strings
  // auditReject() passes — never the raw header value — so this event, like the ledger record,
  // is safe to render verbatim.
  "mcp_listener_rejected",
]);
export type EventKind = z.infer<typeof EventKindSchema>;

// ---------- D6 network & tailscale (coverage C6 · B15) ----------
// The `fed.network` RPC response + the `network_changed` event payload: the probed tailscale
// state. `installed:false` is the machine-has-no-tailscale case (the UI shows the install
// command). No field carries a secret — a tailscale AUTH KEY lives only in the Keychain.
export type TailscaleNetworkStatus = {
  installed: boolean;      // the `tailscale` binary is present (false ⇒ ENOENT on probe)
  loggedIn: boolean;       // BackendState === "Running" (authenticated + data-plane up)
  ip4: string | null;      // the node's tailnet IPv4 (Self.TailscaleIPs), null when not up
  magicDNS: boolean;       // MagicDNS enabled on the tailnet
  tailscaleSSH: boolean;   // Tailscale SSH advertised for this node ⇒ KEYLESS pairing
};

// `fed.network.up` response: tailscale's interactive-login URL when a login is needed
// (the UI displays it), else null (already logged in). Never carries the raw command output.
export type NetworkUpResult = { authUrl: string | null };

// ---------- interactive agent dialogs (native-CLI-parity Phase 2, Task DLG1) ----------
// The dialog→decision round-trip for native interactive dialogs (AskUserQuestion/elicitation),
// mirrors QuestionAnswer/agent.answerQuestion's correlation shape but for agent.answerDialog.
export const DialogDecisionSchema = z.discriminatedUnion("behavior", [
  z.object({ behavior: z.literal("completed"), result: z.unknown() }).strict(),
  z.object({ behavior: z.literal("cancelled") }).strict(),
]);
export type DialogDecision = z.infer<typeof DialogDecisionSchema>;

export const AnswerDialogParams = z.object({
  dialogId: z.string().min(1),
  decision: DialogDecisionSchema,
}).strict();
export type AnswerDialogParams = z.infer<typeof AnswerDialogParams>;

// ---------- agent.setModel (Task MDL-a) ----------
// Change a running agent's model by respawn-with-resume under the SAME agentId
// (CR1's opts.agentId + AgentSpec.resume/resumeOnly). A model is fixed once the
// SDK session is created, so "changing" it means: kill the current query, then
// respawn the spec (with model swapped) resuming the prior session id.
export const SetModelParams = z.object({ agentId: z.string().min(1), model: z.string().min(1) }).strict();
export type SetModelParams = z.infer<typeof SetModelParams>;

// ---------- agent.setEffort (mirrors agent.setModel / Task MDL-a) ----------
// Change a running agent's reasoning effort by the SAME respawn-with-resume dance setModel
// uses. `effort` validates against the closed EffortLevelSchema enum (unlike model's open
// z.string().min(1) catalog) since effort is a small fixed vocabulary, not a free catalog.
export const SetEffortParams = z.object({ agentId: z.string().min(1), effort: EffortLevelSchema }).strict();
export type SetEffortParams = z.infer<typeof SetEffortParams>;

// ---------- agent.setTurnLimit (SOFT-TURN-LIMIT, live) ----------
// Raise (or unbound) a RUNNING agent's turn budget without losing its session. The claude
// SDK bakes maxTurns into the query at creation (backends/claude.ts — either spec.maxTurns
// or the SOFT_TURN_CAP sentinel under "soft"), so a live query can never be re-capped in
// place: core's supervisor.setTurnLimit uses the SAME respawn-with-resume dance setModel
// uses. At least one of the two fields must be present — an empty patch would be a respawn
// that changes nothing.
export const SetTurnLimitParams = z.object({
  agentId: z.string().min(1),
  maxTurns: z.number().int().positive().optional(),
  turnLimitPolicy: z.enum(["fail", "soft"]).optional(),
}).strict().refine(
  (p) => p.maxTurns !== undefined || p.turnLimitPolicy !== undefined,
  { message: "setTurnLimit needs at least one of maxTurns / turnLimitPolicy" },
);
export type SetTurnLimitParams = z.infer<typeof SetTurnLimitParams>;

// ---------- agent.setAccount (mirrors agent.setModel / Task MDL-a) ----------
// Same-provider changes resume; cross-provider changes compact context into a fresh
// native session while keeping the Chimera agent identity. Always manually requested.
export const SetAccountParams = z.object({ agentId: z.string().min(1), account: z.string().min(1), model: z.string().min(1).optional(), acknowledgeCodexFullAccessRisk: z.boolean().optional() }).strict();
export type SetAccountParams = z.infer<typeof SetAccountParams>;

// ---------- agent.handoff (CROSS-PROVIDER-HANDOFF) ----------
// The cross-provider counterpart setAccount explicitly refuses (its own comment names the
// gap): move a running/paused/stranded agent's CONTEXT to a fresh agent on a different
// provider/account, since a Claude session id is meaningless to Codex/Kimi/GLM and there is
// no resume across that boundary. `model` is REQUIRED — chimera has no cross-provider
// model-equivalence table, so silently carrying over the source's model string would just
// fail late on the target provider; the caller names a valid target model explicitly.
// `note` is optional free-text folded into the built context package (e.g. "prioritize
// finishing the migration, skip the doc update").
export const AgentHandoffParams = z.object({
  agentId: z.string().min(1), toAccount: z.string().min(1), model: z.string().min(1),
  note: z.string().optional(),
}).strict();
export type AgentHandoffParams = z.infer<typeof AgentHandoffParams>;

// ---------- agent.rebind (REBIND — cwd axis) ----------
// The cwd counterpart of agent.handoff: move a running/paused/stranded agent to a NEW
// working directory, same provider/account/model throughout (unlike handoff, which changes
// provider/account and requires isolation:"worktree" to vouch disk state survived). rebind
// deliberately carries NO such isolation requirement — its own motivating case is exactly an
// isolation:"none" ad-hoc chat session (spawned with no path bound yet) that turns out to be
// about something real and needs relocating. See supervisor.rebind's own comment for the two
// paths (cheap same-agentId respawn when the agent has no real history yet, vs a portable
// context package + fresh lineaged agentId once it does — mechanically identical to handoff
// on the history-exists path, just never claiming to carry forward on-disk state at the OLD
// cwd, only the conversation narrative).
export const AgentRebindParams = z.object({
  agentId: z.string().min(1), cwd: z.string().min(1),
  isolation: z.enum(["none", "worktree"]).optional(),
  note: z.string().optional(),
}).strict();
export type AgentRebindParams = z.infer<typeof AgentRebindParams>;

// ---------- agent.remoteControl (REMOTE-CONTROL) ----------
// Toggle a provider's native Remote Control bridge on a running agent's LIVE session —
// e.g. Claude Code's undocumented-but-real `enableRemoteControl` control request hands
// back a claude.ai/code session_url with no respawn needed. Provider-specific: a
// backend with no live control surface for it (Codex exec) rejects with a protocol
// error rather than silently no-opping. `name` only applies when enable:true; omitted
// it defaults to `chimera-<agentId prefix>` (see AgentSupervisor.remoteControl).
export const RemoteControlParams = z.object({
  agentId: z.string().min(1),
  enable: z.boolean(),
  name: z.string().min(1).optional(),
}).strict();
export type RemoteControlParams = z.infer<typeof RemoteControlParams>;

export type RemoteControlStatus = {
  agentId: string;
  provider: string;
  enabled: boolean;
  name?: string;
  sessionUrl?: string;
  connectUrl?: string;
  connectionStatus?: "disabled" | "connecting" | "connected" | "errored";
  serverName?: string;
  environmentId?: string;
};

// ---------- agent.compact (COMPACTION-OBSERVABILITY) ----------
// Request compaction now. Generic providers compact directly; Claude uses its slash
// channel and Codex app-server uses thread/compact/start. Native completion is
// asynchronous and arrives through compaction events; exec remains unsupported.
export const CompactParams = z.object({ agentId: z.string().min(1) }).strict();
export type CompactParams = z.infer<typeof CompactParams>;

const CompactSizeSchema = z.object({
  messages: z.number().int().nonnegative().optional(),
  chars: z.number().int().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
}).strict();

export const CompactResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  before: CompactSizeSchema.optional(),
  after: CompactSizeSchema.optional(),
  // MANUAL-COMPACT-ANY-PROVIDER: set when chimera did not perform the compaction itself but
  // ASKED the provider's own agent loop to (the slash command its CLI understands). before/after
  // are then deliberately absent — the provider reports the real effect through its own
  // compaction event, and reporting sizes chimera never measured would be a guess dressed as a
  // measurement. `ok` means the request was delivered, not that compaction has finished.
  via: z.literal("provider-command").optional(),
  command: z.string().optional(),
}).strict();
export type CompactResult = z.infer<typeof CompactResultSchema>;

// ---------- interactive agent questions (spec §17) ----------
// The ask→structured-answer round-trip, provider-agnostic. `agent_question`
// rides the locked NormalizedEvent shape; QuestionAnswer is the correlation
// payload echoed by agent.answerQuestion (mirrors permission_request/respond).
export const QuestionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
}).strict();
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const QuestionDefaultSchema = z.object({
  optionIds: z.array(z.string()).optional(),
  text: z.string().optional(),
}).strict();
export type QuestionDefault = z.infer<typeof QuestionDefaultSchema>;

export const QuestionAnswerSchema = z.object({
  optionIds: z.array(z.string()).optional(),
  text: z.string().optional(),
}).strict();
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

export const NormalizedEventSchema = z.object({
  ts: z.number(),
  seq: z.number().int(),
  // origin engine (federation pre-provision): defaulted, so every existing
  // parse call keeps succeeding; Phase 5 peers stamp their own engineId.
  engineId: z.string().regex(/^[A-Za-z0-9._-]+$/).default("local"),
  agentId: z.string(),
  kind: EventKindSchema,
  data: z.record(z.string(), z.unknown()),
  raw: z.unknown().optional(),
}).strict();
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

// R2 Fleet Chronicle: daemon-backed search anchors always point at one persisted
// normalized event. Snippets are bounded/redacted server-side; clients never need
// raw event payloads to render or export search results.
// CHRONICLE-SEMANTIC (chronicle.*): semantic search over DISTILLED event history — the durable
// half of the Chronicle. `events.search` is lexical over the events the log still RETAINS (~3 days);
// this searches a distilled corpus that outlives pruning, so an agent whose context was compacted
// away can still find what it did. The two-step shape is deliberate: `chronicle.search` returns
// snippets under a bounded cost, `chronicle.get` returns whole documents only for the seqs the
// caller actually wants. A single fat search would re-flood the very context it was called to repair.
export const ChronicleScopeSchema = z.object({
  agentIds: z.array(z.string()).nonempty().optional(),
  treeIds: z.array(z.string()).nonempty().optional(),
  teams: z.array(z.string()).nonempty().optional(),
  kinds: z.array(EventKindSchema).nonempty().optional(),
  fromTs: z.number().optional(),
  toTs: z.number().optional(),
}).strict();
export type ChronicleScope = z.infer<typeof ChronicleScopeSchema>;

export const ChronicleSemanticSearchParamsSchema = z.object({
  query: z.string().min(1),
  scope: ChronicleScopeSchema.optional(),
  limit: z.number().int().min(1).max(50).default(10),
}).strict();

export const ChronicleSemanticHitSchema = z.object({
  seq: z.number().int(),
  ts: z.number(),
  engineId: z.string(),
  agentId: z.string(),
  kind: EventKindSchema,
  score: z.number(),
  snippet: z.string(),
  // The raw event has been pruned; only the distilled document survives. Callers must not offer to
  // fetch the full event for these.
  distilledOnly: z.boolean(),
}).strict();

export const ChronicleSemanticSearchResultSchema = z.object({
  hits: z.array(ChronicleSemanticHitSchema),
  searched: z.number().int(),
  // false ⇒ the ranking was lexical only (no embedder warm yet, or embedding is off). Reported
  // rather than hidden: "semantic search returned nothing" and "semantic search never ran" are
  // different answers and the caller should be able to tell them apart.
  semantic: z.boolean(),
  indexed: z.boolean(),
  retained: z.object({ firstSeq: z.number().int(), lastSeq: z.number().int() }).strict(),
}).strict();

export const ChronicleGetParamsSchema = z.object({
  seqs: z.array(z.number().int()).min(1).max(25),
}).strict();

export const ChronicleDocSchema = z.object({
  seq: z.number().int(),
  ts: z.number(),
  engineId: z.string(),
  agentId: z.string(),
  kind: EventKindSchema,
  text: z.string(),
  treeId: z.string().nullable(),
  team: z.string().nullable(),
}).strict();

export const ChronicleGetResultSchema = z.object({
  docs: z.array(ChronicleDocSchema),
  missing: z.array(z.number().int()),
}).strict();

export const ChronicleIndexStatusSchema = z.object({
  enabled: z.boolean(),
  docs: z.number().int(),
  embedded: z.number().int(),
  pending: z.number().int(),
  segments: z.number().int(),
  model: z.string().nullable(),
  maxDocs: z.number().int(),
  error: z.string().nullable(),
  oldestTs: z.number().nullable(),
}).strict();

export const ChronicleReindexResultSchema = z.object({
  indexed: z.number().int(),
  enabled: z.boolean(),
}).strict();

export const ChronicleMatchFieldSchema = z.enum([
  "kind", "agent", "transcript", "tool_name", "tool_input", "tool_result",
  "task", "workflow", "gate", "evidence", "artifact", "data",
]);
export type ChronicleMatchField = z.infer<typeof ChronicleMatchFieldSchema>;

export const ChronicleSearchScopeSchema = z.object({
  agentIds: z.array(z.string().min(1)).optional(),
  engineIds: z.array(z.string().min(1)).optional(),
  kinds: z.array(EventKindSchema).optional(),
  taskIds: z.array(z.string().min(1)).optional(),
  workflowNames: z.array(z.string().min(1)).optional(),
  fromTs: z.number().optional(), toTs: z.number().optional(),
  fromSeq: z.number().int().positive().optional(), toSeq: z.number().int().positive().optional(),
}).strict();
export type ChronicleSearchScope = z.infer<typeof ChronicleSearchScopeSchema>;

export const ChronicleSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(500),
  scope: ChronicleSearchScopeSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
  // Set only by the MCP layer, from the caller's own ctx.agentId (unforgeable). Present ⇒ the
  // engine confines hits to the caller and its descendants: event text includes tool_input and
  // tool_result, so an unscoped agent-facing search is a fleet-wide read of other agents' output.
  // Absent ⇒ the operator's own UI/RPC call, which legitimately searches everything.
  callerAgentId: z.string().min(1).optional(),
}).strict();
export type ChronicleSearchRequest = z.infer<typeof ChronicleSearchRequestSchema>;

export const ChronicleCorrelationSchema = z.object({
  taskId: z.string().nullable(), workflow: z.string().nullable(), stepId: z.string().nullable(),
  toolId: z.string().nullable(), artifactId: z.string().nullable(), traceId: z.string().nullable(),
  spanId: z.string().nullable(), parentAgentId: z.string().nullable(),
}).strict();
export const ChronicleSearchHitSchema = z.object({
  engineId: z.string(), seq: z.number().int(), ts: z.number(), agentId: z.string(), kind: EventKindSchema,
  score: z.number(), fields: z.array(ChronicleMatchFieldSchema), snippet: z.string().max(600),
  correlation: ChronicleCorrelationSchema,
}).strict();
export type ChronicleSearchHit = z.infer<typeof ChronicleSearchHitSchema>;
export const ChronicleSearchResponseSchema = z.object({
  hits: z.array(ChronicleSearchHitSchema), nextCursor: z.string().nullable(),
  retained: z.object({ firstSeq: z.number().int().nullable(), lastSeq: z.number().int().nullable() }).strict(),
}).strict();
export type ChronicleSearchResponse = z.infer<typeof ChronicleSearchResponseSchema>;
export const ChronicleExportRequestSchema = ChronicleSearchRequestSchema.omit({ cursor: true }).extend({
  maxResults: z.number().int().min(1).max(500).default(200),
}).strict();
export const ChronicleExportResponseSchema = z.object({ filename: z.string(), content: z.string() }).strict();
export type ChronicleExportRequest = z.infer<typeof ChronicleExportRequestSchema>;
export type ChronicleExportResponse = z.infer<typeof ChronicleExportResponseSchema>;

// ---------- RPC frames ----------
// Frame ids are globally unique (UUID). Phase 5 federation extends frames with
// seq/idempotencyKey — treat unknown envelope fields as ignorable.
export type RpcRequest = { id: string; type: "request"; method: string; params?: unknown };
export type RpcResponse = { id: string; type: "response"; ok: boolean; result?: unknown; error?: { code: string; message: string } };
export type RpcEventFrame = { type: "event"; event: NormalizedEvent };
export type RpcFrame = RpcRequest | RpcResponse | RpcEventFrame;

const cronFormatters = new Map<string, Intl.DateTimeFormat>();
/** Bounded cache: constructing an ICU formatter for every cron candidate can
 * freeze the schedule editor and block the daemon during sparse cron searches. */
export function cronFormatter(tz: string): Intl.DateTimeFormat {
  const cached = cronFormatters.get(tz);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  if (cronFormatters.size >= 32) cronFormatters.delete(cronFormatters.keys().next().value!);
  cronFormatters.set(tz, formatter);
  return formatter;
}

export function encodeFrame(frame: RpcFrame): string {
  return JSON.stringify(frame) + "\n";
}

export function decodeFrames(buffer: string): { frames: RpcFrame[]; rest: string } {
  const frames: RpcFrame[] = [];
  let rest = buffer;
  for (;;) {
    const nl = rest.indexOf("\n");
    if (nl === -1) break;
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (line.length === 0) continue;
    // A torn/garbage complete line must never throw here: this runs inside a raw
    // socket 'data' handler in both client.ts and daemon/server.ts, with no
    // surrounding try/catch, so an uncaught JSON.parse would crash the whole
    // process over a single bad frame. Skip it instead (mirrors federation.ts's
    // decodePeerFrames, which already had to learn this the hard way for peer ingress).
    try {
      const parsed: unknown = JSON.parse(line);
      // JSON scalars are valid JSON, but not protocol frames. In particular
      // `null` used to escape here and crash async dispatch on req.type.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frames.push(parsed as RpcFrame);
    } catch {
      continue;
    }
  }
  return { frames, rest };
}

// ---------- teams / queues / tasks (spec §4, Phase 2) ----------
// "/" is reserved as the engine-qualifier separator (spec §15); CoordName must never admit it
const CoordName = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ and - only");

// ROLES-UNIFY §2: one library entry, letters/digits/_/- with AT MOST ONE `.` qualifier reserved
// for automatic team-migration/discovery names (`<team>.<key>`, §3.2) — never hand-typed, so a
// user-authored role.create name can never accidentally shadow a team-qualified one.
export const RoleNameSchema = z.string().min(1)
  .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?$/, "letters, digits, _, -, at most one . qualifier");

// ROLES-UNIFY §2: one schema replaces both the old RoleTemplateSchema (team-role) and
// SessionRoleSpecSchema (ad-hoc-session role) — every role, team or session, spawns off the
// same full-fat shape now. `cwd` widens required -> optional: a library role must serve both a
// team binding (always has a concrete cwd) and an ad-hoc session binding (cwd is the workspace
// root, not fixed per-role, ad-hoc-sessions design §2). The "a team-role BINDING must resolve to
// a cwd-complete spec" invariant is enforced at bind time (team.attachRole/updateRoleBinding,
// core), never here and never at spawn time — a library role legitimately having no cwd (a pure
// session role) must still parse.
export const RoleSpecSchema = AgentSpecSchema.omit({ prompt: true, content: true }).extend({
  name: RoleNameSchema,                      // library identity — every entry is named
  cwd: z.string().min(1).optional(),         // WIDENED: required -> optional, see above
  persistent: z.boolean().default(false),    // long-lived, idle-capable worker for this role
  poolSize: z.number().int().min(1).optional(),   // caps persistent workers for this role, independent of maxConcurrent
  // AWARENESS: team workers default to orchestration ON (unlike plain AgentSpec's
  // false) — a worker without the chimera MCP cannot answer ask_team, report via
  // ask_human, or touch shared memory, which made teams-as-collaborators fictional.
  orchestration: z.object({
    allow: z.boolean().default(true),
    maxDepth: z.number().int().positive().default(2),
  }).default({ allow: true, maxDepth: 2 }),
  // Folded in from the old SessionRoleSpecSchema: `skills` has no structural home on AgentSpec
  // (the SDK only wires a Skill(...) DENY-list) — carried here as plugin-qualified ids folded
  // into the merged spec's `instructions` text at spawn (engine.ts), a prompt-level nudge, not a
  // structural grant.
  skills: z.array(z.string()).default([]),
}).strict();
export type RoleSpec = z.infer<typeof RoleSpecSchema>;

// ROLES-UNIFY §3.1: a team slot no longer holds a materialized copy of a role — it holds a
// reference (`role`, the library entry this slot resolves against) plus a sparse override patch.
// The RESOLVED, merged result (computed live at read/spawn time via resolveRole, core S2) is what
// has to satisfy RoleSpecSchema/AgentSpecSchema — never this binding itself.
export const RoleBindingSchema = z.object({
  role: RoleNameSchema,
  overrides: z.record(z.string(), z.unknown()).default({}),   // sparse — see §4's merge order
}).strict();
export type RoleBinding = z.infer<typeof RoleBindingSchema>;

// Ad-hoc sessions design §4: the four predefined roles. User-extensible (role.create/update) —
// these are SEED data only, re-applied for any name missing from the store, never force-reset
// on top of a user's edit to one of these four names (see RoleStore).
export const BUILTIN_ROLES: RoleSpec[] = [
  RoleSpecSchema.parse({
    name: "aws",
    permissionProfile: "full",
    instructions:
      "Cloud debugging session. Prefer read verbs (describe/get/list/logs/--dry-run) — these run " +
      "without a prompt on every account including production. When your permission hook is " +
      "enforced (any claude spawn, or a codex spawn NOT using permissionProfile \"full\"), " +
      "mutating verbs (create/update/delete/apply/scale/restart/terminate/put/set) are gated by " +
      "chimera's own cloud-mutation gate (classifyCloudMutation, packages/core/src/hosttools.ts) " +
      "regardless of what this prompt says — it will ask the operator to approve each one by " +
      "name. If you are a codex agent running permissionProfile \"full\", that gate CANNOT fire — " +
      "codex has no permission hook in full-access mode (see CODEX-GATE-EXPOSURE) — so mutating " +
      "verbs execute immediately with no approval step; treat every one as if the operator were " +
      "watching over your shoulder. Never tell the operator a mutation was applied before that " +
      "approval actually happens (or, running full-access codex, before you are certain it is " +
      "what the operator wants).",
    skills: [],
  }),
  RoleSpecSchema.parse({
    name: "review",
    permissionProfile: "acceptEdits",
    instructions:
      "PR review session. Use `gh` to fetch the PR (diff, description, existing comments) before " +
      "commenting. Prefer the installed review skills over ad-hoc reading.",
    skills: ["code-review:ai-review-agentic", "security-reviewer:review"],
  }),
  RoleSpecSchema.parse({
    name: "triage",
    permissionProfile: "readOnly",
    instructions:
      "Slack/Jira triage session. Read-only against any repo you land in — this role never " +
      "edits code. Use the Slack/EKB/Atlassian MCPs (if connected) to gather context before " +
      "answering.",
    skills: [],
  }),
  RoleSpecSchema.parse({ name: "blank" }),
];

// ROLES-UNIFY §3.1/§2: `roles[key]` is now a RoleBindingSchema reference (`{role, overrides}`),
// not a materialized AgentSpec-shaped copy — a two-field reference satisfies the "cannot carry an
// extra marker key" constraint trivially, since a binding no longer has to itself be a strict
// AgentSpec. `sharedRoles` is REMOVED: once every slot is a binding, "shared" is derivable (two
// bindings referencing the same library `role`) rather than a separately-stored marker list.
export const TeamSpecSchema = z.object({
  name: CoordName,
  roles: z.record(z.string(), RoleBindingSchema).refine((r) => Object.keys(r).length > 0, { error: "team needs at least one role" }),
  maxConcurrent: z.number().int().positive().default(4),
  queue: z.string().nullable().default(null),
  createdBy: z.string().nullable().default(null),   // spec §9/T9d: MCP team_create stamps the caller's agent id
  // PURPOSE: why this team exists / what it's for — the field orchestrators pick
  // a team by (surfaced in team_list/team_status and the TUI detail pane).
  purpose: z.string().nullable().default(null),
  // PROJECT-NATIVE-TEAMS T1: provenance for teams materialized from a project's
  // .claude/agents directory. Tracked at the TEAM level (not per-role) — unchanged type/meaning
  // under ROLES-UNIFY; what those keys' bindings point at changes, not the marker itself.
  discoveredRoles: z.array(z.string()).default([]),   // role keys materialized from .claude/agents
  projectNative: z.string().nullable().default(null), // project name this team was materialized for; lets re-sync find it + prevents double-create
}).strict();
export type TeamSpec = z.infer<typeof TeamSpecSchema>;

// RETRY-BACKOFF: canonical error-class taxonomy — failover.ts's classifyError() (a pure regex
// classifier over agent-failure messages) is the ONLY producer of this value; RetryPolicy.
// retryableClasses (below) is the ONLY consumer besides AgentRecord.attempts[].errorClass
// (supervisor.ts, kept as a loose `string` there — unchanged, out of scope). Hoisted here so
// core's failover.ts imports the union instead of re-declaring it, avoiding drift.
export const ErrorClassSchema = z.enum(["rate-limit", "credential", "backend-crash", "protocol", "guardrail", "unknown"]);
export type ErrorClassName = z.infer<typeof ErrorClassSchema>;

// FAILURE-DISPOSITION: the closed set of *causes* a failure message can be attributed to.
// ErrorClassSchema above stays exactly as-is because it is a persisted, operator-authored config
// surface (RetryPolicy.retryableClasses); this enum is the finer-grained internal axis the
// supervisor branches on. Several causes deliberately collapse onto one errorClass (account-cap
// and provider-rate-limit are both "rate-limit") — the class says what an operator configured,
// the cause says what the engine must DO about it.
export const FailureCauseSchema = z.enum([
  "account-cap",         // this account's own plan window is spent — another account can still run
  "provider-rate-limit", // the provider is throttling; the same account works again after backoff
  "provider-capacity",   // model-wide saturation — retry the same model/account after backoff
  "provider-stream",     // malformed provider event stream — resume and reconcile completed work
  "transient-network",   // crash/stream fault/hang — a restart in place is the right move
  "bad-request",         // the request itself is invalid; retrying it verbatim can never succeed
  "credential",          // auth material is wrong/expired — only a human can fix it
  "output-truncated",    // hit maxOutputTokens mid-generation — a fresh attempt can still succeed
  "context-overflow",    // backend transport frame/context blew its size ceiling — resume is poisoned, a fresh native session can still succeed
  "unclassified",        // no rule matched; deliberately inert (fail loud, change nothing)
]);
export type FailureCause = z.infer<typeof FailureCauseSchema>;

// FAILURE-DISPOSITION: the single record every failure decision is made from. The four booleans
// are the WHOLE decision surface — callers must branch on these, never re-derive intent by
// re-matching the message or comparing cause/errorClass strings, or the taxonomy forks again.
// `evidence` names the RULE that matched (e.g. "429", "handshake-phase"), NEVER provider text:
// failure messages routinely carry keys, prompts and customer data, and this record is persisted
// and surfaced in the UI.
export const FailureDispositionSchema = z.object({
  cause: FailureCauseSchema,
  errorClass: ErrorClassSchema,
  retryable: z.boolean(),       // re-running the same request on the same account can succeed
  failoverAccount: z.boolean(), // another account may succeed right now
  holdForReset: z.boolean(),    // park this account until its window resets, don't just back off
  restartInPlace: z.boolean(),  // respawn the backend process and continue the same agent
  evidence: z.string().min(1).max(80), // rule name that matched — never message-derived
  at: z.number().int().nonnegative(),
}).strict();
export type FailureDisposition = z.infer<typeof FailureDispositionSchema>;

export const RetryBackoffKindSchema = z.enum(["fixed", "exponential"]);
export type RetryBackoffKind = z.infer<typeof RetryBackoffKindSchema>;

// RETRY-BACKOFF: a per-queue/workflow/step retry policy. Absent everywhere it's consulted (see
// queues.ts markFailedAttempt, scheduler.ts handleWorkflowTurn) means BYTE-IDENTICAL today's
// behavior — zero-delay revert-to-pending, cascade-fail on exhaustion. Present, it: (a) delays
// re-dispatch per computeRetryDelayMs below instead of an instant revert, (b) routes exhaustion
// (and, for the plain-task path only — see queues.ts — a classified non-retryable error) to the
// "dead_letter" TaskState instead of "failed", which does NOT cascade-fail dependents.
// maxAttempts is TOTAL attempts allowed (mirrors the critic gate's maxRounds convention:
// `stepAttempts + 1 < maxAttempts` is "there's budget for another attempt after this failure") —
// distinct from the legacy retryLimit fields' "N retries after the first attempt" framing.
export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(20).default(3),
  backoff: RetryBackoffKindSchema.default("fixed"),
  baseMs: z.number().int().min(0).default(1000),
  // hard ceiling on any single computed delay — keeps "exponential" from growing unbounded
  // (maxAttempts=20 + exponential would otherwise reach multi-day delays). Absent ⇒ uncapped.
  maxDelayMs: z.number().int().min(0).optional(),
  jitter: z.boolean().default(false),
  // Only consulted by the plain-task (agent-failure) retry path (queues.ts markFailedAttempt),
  // where a REAL ErrorClassName is available from AgentSupervisor.attempts — a gate failure's
  // free-text reason has no reliable classification, so the workflow step-gate retry path
  // (scheduler.ts handleWorkflowTurn) applies maxAttempts/backoff/jitter but does NOT consult
  // this field (follow-up: heuristically classify gate-failure reasons via classifyError() if
  // that proves useful in practice). Absent ⇒ every error class is retryable (today's behavior).
  retryableClasses: z.array(ErrorClassSchema).optional(),
}).strict();
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

// Shared by queues.ts (plain-task retry) and scheduler.ts (workflow-step retry) so there is ONE
// backoff formula, not two independently-drifting ones. attemptNumber is 1-based: the Nth failed
// attempt that JUST consumed a retry — computeRetryDelayMs(policy, 1) is the delay before the
// 2nd attempt. `rand` is injectable for deterministic tests (defaults to Math.random).
export function computeRetryDelayMs(policy: RetryPolicy, attemptNumber: number, rand: () => number = Math.random): number {
  const raw = policy.backoff === "exponential" ? policy.baseMs * 2 ** (attemptNumber - 1) : policy.baseMs;
  const capped = policy.maxDelayMs !== undefined ? Math.min(raw, policy.maxDelayMs) : raw;
  return policy.jitter ? Math.round(capped * (0.5 + rand())) : capped;   // jitter ⇒ 0.5x–1.5x
}

export const QueueSpecSchema = z.object({
  name: CoordName,
  retryLimit: z.number().int().min(0).default(2),   // N retries; failover attempts count as retries (spec §4)
  // D12 (task workflows, coverage C14): the DEFAULT workflow name new tasks in this
  // queue are gated by (a per-task `workflow` override at push wins — see
  // QueuePushParams). null (the default) ⇒ tasks in this queue are plain, ungated.
  workflow: z.string().nullable().default(null),
  // RETRY-BACKOFF: optional, additive. Unset ⇒ retryLimit's existing instant-revert/cascade-fail
  // behavior, byte-identical. Set ⇒ supersedes retryLimit entirely for markFailedAttempt's
  // exhaustion/backoff decision (retryLimit itself is left untouched/unused in that case, not
  // removed — no back-compat break for callers still reading retryLimit off QueueSpec).
  retryPolicy: RetryPolicySchema.optional(),
  // QUEUE-PAUSE: durable pause flag — while true, the scheduler's per-team drain
  // loop (scheduler.ts tick()) skips this queue's `nextPending` entirely, so no
  // NEW agent spawns/drains from it. Already-running agents are untouched (they
  // finish naturally); pending tasks simply stay pending. Persisted in
  // queues.json (same temp+rename snapshot as every other QueueSpec field) so a
  // daemon restart loads it and the scheduler keeps honoring it. Default false —
  // an old queues.json with no `paused` key parses to false (sparse-compat).
  paused: z.boolean().default(false),
}).strict();
export type QueueSpec = z.infer<typeof QueueSpecSchema>;

// "blocked" (dep-gate, Task DEP1): a task with unsatisfied `dependsOn` is parked in
// "blocked" and is NOT eligible for dequeue until every dependency reaches "done"
// (→ "pending"); if any dependency reaches a terminal "failed", the dependent is
// cascade-failed. blocked is non-terminal (like pending) — never pruned.
// RETRY-BACKOFF: "dead_letter" is a SECOND terminal state alongside "failed" — reached only via
// a configured RetryPolicy's exhaustion/poison path (queues.ts markDeadLetter). Unlike "failed",
// it does NOT cascade-fail dependents (they stay blocked/pending, quarantined-not-killed) and is
// NEVER pruned by QueueStore.prune() (which only evicts done/failed) — it survives until an
// operator calls queue.requeue (replay) to bring it back to "pending".
export const TaskStateSchema = z.enum(["pending", "in_progress", "done", "failed", "blocked", "dead_letter"]);
export type TaskState = z.infer<typeof TaskStateSchema>;

// ---------- direct assignment (spec §17 T4 sibling / Phase C Task C1) ----------
// `assign` hands work to a target either directly (a specific agent's mailbox)
// or via a team (routed through the team's bound queue to a free/idle worker).
export const AssignParams = z.object({
  target: z.union([
    z.object({ agentId: z.string().min(1) }).strict(),
    z.object({ team: z.string().min(1), role: z.string().min(1).optional() }).strict(),
  ]),
  prompt: z.string().min(1),
  priority: z.number().int().optional(),
}).strict();
export type AssignParams = z.infer<typeof AssignParams>;

// ---------- dispatch preference resolver (PLAN-PROJECT-CONDUCTOR-ROUTING D2/§3, P2-T2) ----------
// `dispatch` picks a routing mechanism FOR the caller instead of making them choose
// between queue.push/assign/agent.spawn: queue-first (a queue already bound to the
// project, or to teamHint) → own-team role-match (a project-assigned, queue-bound
// team whose roles include `role`) → config.globalTeam (if bound to a queue) →
// direct (the project's own conductor, or a fresh spawn). Pure orchestration over
// those existing primitives — no new scheduling engine.
export const DispatchParams = z.object({
  projectName: z.string().min(1).optional(),
  prompt: z.string().min(1),
  role: z.string().min(1).optional(),
  priority: z.number().int().optional(),
  // an explicit team to consult for its bound queue when no project queue applies
  // (step 1 only — NOT consulted for the own-team role-match step, which is
  // strictly the project's own assigned teams).
  teamHint: z.string().min(1).optional(),
}).strict();
export type DispatchParams = z.infer<typeof DispatchParams>;

export const DispatchResultSchema = z.object({
  via: z.enum(["queue", "team", "global", "direct"]),
  target: z.string().min(1),   // queue/team name, or the direct agentId
  taskId: z.string().optional(),
}).strict();
export type DispatchResult = z.infer<typeof DispatchResultSchema>;

// ---------- artifact registry kind (D13) — hoisted above TaskRecordSchema/WorkflowGateSchema,
// both of which need to reference it (task workflows' artifact gate pins a kind; the
// registry proper — ArtifactRecordSchema etc. — stays defined further down). ----------
export const ArtifactKindSchema = z.enum(["report", "diff", "chart", "file", "link"]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

// F16.1 Phase 2 (WF-4/G4): one entry per step ATTEMPT a workflow-bound task makes —
// opened the moment that attempt starts running (fresh spawn, idle-pool reuse, workflow
// advance, and workflow retry all count as a fresh attempt), closed the moment its gate
// is evaluated. endedAt/outcome stay null while the attempt is in flight; a crash-mid-step
// entry is left open forever — itself diagnostic (visible proof nothing ever closed it).
// `reason` mirrors the gate's failure reason (absent on outcome:"passed"). `handoffSummary`
// (F16.1 Phase 3, WF-9) is stamped on a "passed" entry when its step's outgoing agent's
// summarize turn actually captured text — absent for a context:"none" step, an
// artifacts-only fallback (summarize failed/timed out), or any step that isn't a
// role-switch boundary at all (see scheduler.ts's completeHandoff).
export const StepHistoryEntrySchema = z.object({
  stepIndex: z.number().int().min(0),
  stepId: z.string().min(1),
  agentId: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable().default(null),
  outcome: z.enum(["passed", "failed", "retried"]).nullable().default(null),
  reason: z.string().optional(),
  handoffSummary: z.string().optional(),
}).strict();
export type StepHistoryEntry = z.infer<typeof StepHistoryEntrySchema>;

// FEATURE-2 (durable checkpoint-resume): a snapshot of a workflow-bound task's DURABLE resume
// state, captured on every fresh agent bind to a step (first attempt, retry respawn, and
// crash-restart re-dispatch alike — see scheduler.ts's captureStepCheckpoint, called from its 4
// fresh-spawn sites). NOT the same concept as D16's checkpoint.create (a git-ref snapshot an
// AGENT explicitly asks for) — this is engine-internal durable-execution bookkeeping, never
// agent-visible as its own RPC. `workdirKey`/`branch`/`commitSha` are all independently
// nullable: isolation:"none" tasks have no worktree at all (workdirKey/branch/commitSha all
// null); a git-read failure at capture time (diagnostic-only, never fails the step) also leaves
// commitSha null even when workdirKey/branch are set.
export const TaskStepCheckpointSchema = z.object({
  stepIndex: z.number().int().min(0),
  // stable for the SAME (taskId, stepIndex) across any number of retries/crash-restarts —
  // "taskId:step-N" (scheduler.ts's stepIdempotencyKey) — changes only when stepIndex advances.
  // This IS the idempotency semantic for this slice: a resumed agent can compare it against
  // whatever it finds already committed to recognize "I've been here before."
  idempotencyKey: z.string().min(1),
  workdirKey: z.string().min(1).nullable(),
  branch: z.string().nullable(),
  commitSha: z.string().nullable(),
  // REVIEW-ROOM-UNBOUND-TASKS: the project repo the task's branch lands into (= the spawned
  // agent's spec.cwd; the worktree lives at <mainRepo>/.chimera/worktrees/<workdirKey>). Captured
  // durably here so EvidenceStore can still derive a landed plain-task's diff AFTER its agent
  // has terminated — evidence.get's live-agent cwd lookup (resolveAgentCwd) returns null for a
  // done/pruned agent or across a daemon restart. null for isolation:"none" (no branch to land)
  // and, sparse-parse-compatibly, for every pre-existing checkpoint row.
  mainRepo: z.string().nullable().default(null),
  // mirrors TaskRecord.stepAttempts AT CAPTURE TIME — "gate progress" for this step.
  gateAttempts: z.number().int().min(0),
  capturedAt: z.number(),
}).strict();
export type TaskStepCheckpoint = z.infer<typeof TaskStepCheckpointSchema>;

// TASK-EDIT-VERSIONING: one entry per in-place edit of a still-queued (pending/blocked) task.
// The task record's LIVE fields are always the head (latest) — this history exists only to show
// what changed and to undo/audit. `version` is 1-based (the first edit is v1; an un-edited task
// has versions:[] and is "v0" by UI convention). `changedFields` lists exactly the TaskRecord
// keys that changed in THIS edit (e.g. "prompt","role","priority","overrides","workflowOverride");
// `prior` holds their PRE-edit values (keyed by the same field names) so a reader can reconstruct
// any earlier state by unwinding the head. `editedBy` is the editing agent's principal (stamped
// from CHIMERA_AGENT_ID at the MCP seam, mirroring pushedBy), null for a direct/human edit.
// Sparse-parse-compatible default [] — every pre-existing queues.json row parses unchanged.
export const TaskVersionSchema = z.object({
  version: z.number().int().positive(),
  editedAt: z.number(),
  editedBy: z.string().nullable().default(null),
  changedFields: z.array(z.string()),
  prior: z.record(z.string(), z.unknown()),
}).strict();
export type TaskVersion = z.infer<typeof TaskVersionSchema>;

// F15 (task_explain): ONE check in an ordered, named predicate array. `name` is a stable machine
// id — UI/agents key off it, never off `detail`, which is a human sentence and may be reworded.
// `skipped` marks a predicate that does not apply on this branch (e.g. teamConcurrency for a
// persistent role, or accountCap when account routing already failed and there is no account to
// cap) — distinct from ok:false, which means it was evaluated and blocked.
export const ExplainCheckSchema = z.object({
  name: z.string().min(1).max(48),
  ok: z.boolean(),
  skipped: z.boolean().default(false),
  // BOUNDED: this rides an MCP tool result. Producers TRUNCATE to fit — so `detail` is a
  // display string and must never be re-thrown as an error message (a truncated
  // `dynamic cap N of M reached (…)` would silently stop matching the live guardrail text).
  detail: z.string().max(240),
}).strict();
export type ExplainCheck = z.infer<typeof ExplainCheckSchema>;

// F15: the supervisor's spawn-admission array, evaluated WITHOUT spawning. Exported as its own
// shape because F51 (spawn_estimate) returns exactly this alongside its estimate — it is the
// "dry-run seam" the verdict promised it, and it must not be re-derived there.
export const AdmissionExplainSchema = z.array(ExplainCheckSchema).max(8);
export type AdmissionExplain = z.infer<typeof AdmissionExplainSchema>;

// F22 (QA of F15/F22): what worktree.explainWrite answers — the SAME ExplainCheck array the write
// gate evaluates (worktree-lease.ts's evaluateWrite), produced WITHOUT acting. `mode` and
// `wouldRefuse` are what make the dry-run honest: a failing check means "this target is inside
// another agent's worktree", but only "enforce" turns that into a refusal, so a caller running
// under "warn"/"off" must not read ok:false as a deny.
export const WorktreeExplainWriteResultSchema = z.object({
  mode: WorktreeLeaseModeSchema,
  wouldRefuse: z.boolean(),
  // The RESOLVED absolute targets the checks were evaluated against: a relative path is resolved
  // against the caller agent's exec cwd (not the daemon's), exactly as the live gate does, so
  // echoing them back is the only way the caller can confirm which file the answer is about.
  targets: z.array(z.string()).max(16),
  checks: AdmissionExplainSchema,
}).strict();
export type WorktreeExplainWriteResult = z.infer<typeof WorktreeExplainWriteResultSchema>;

// F15: read-only diagnosis context. EVERY field is read directly off the TaskRecord the caller
// already owns, plus ONE O(1) supervisor.status() lookup for costUsd — no event scan, no join,
// no new persistence. `recentSteps` is the LAST 3 stepHistory entries, tail-sliced so a 200-step
// task costs the same as a 1-step one.
export const TaskExplainContextSchema = z.object({
  state: TaskStateSchema,
  agentId: z.string().nullable(),
  costUsd: z.number().nullable(),        // bound agent's AgentRecord.costUsd; null when unbound
  attempts: z.number().int().min(0),
  stepIndex: z.number().int().min(0),
  stepId: z.string().nullable(),         // null when the task is not workflow-bound
  stepAttempts: z.number().int().min(0),
  error: z.string().max(400).nullable(),
  dependsOn: z.array(z.object({ taskId: z.string(), state: TaskStateSchema.nullable() }).strict()).max(64),
  recentSteps: z.array(StepHistoryEntrySchema).max(3),
}).strict();
export type TaskExplainContext = z.infer<typeof TaskExplainContextSchema>;

// F15: the whole answer to "why is this task not running?" in one bounded payload —
// checks ≤ 24, admission ≤ 8, detail ≤ 240 chars, recentSteps ≤ 3, dependsOn ≤ 64, so a
// 400-task queue with a 500-step workflow returns the same payload size as a trivial one.
export const TaskExplainResultSchema = z.object({
  taskId: z.string().min(1),
  queue: z.string().min(1),
  team: z.string().nullable(),            // null when no team is bound to this queue
  role: z.string().nullable(),            // the role the drain loop WOULD route to
  dispatchable: z.boolean(),              // true iff every non-skipped check is ok
  blockedBy: z.string().nullable(),       // ExplainCheck.name of the FIRST failing check
  detail: z.string().max(240).nullable(), // that check's detail, hoisted for one-line reading
  checks: z.array(ExplainCheckSchema).max(24),
  admission: AdmissionExplainSchema,      // empty when an earlier predicate already blocked
  context: TaskExplainContextSchema,
  evaluatedAt: z.number(),
}).strict();
export type TaskExplainResult = z.infer<typeof TaskExplainResultSchema>;

// TASK-TAGS: the ONE tag-list shape — reused by TaskRecordSchema below, queue.push/queue.editTask
// (contract.ts) and the queue_push MCP tool, so the bound can never drift between them.
export const TaskTagsSchema = z.array(z.string().min(1).max(64)).max(16).default([]);

export const TaskRecordSchema = z.object({
  taskId: z.string().min(1),
  queue: z.string().min(1),
  prompt: z.string().min(1),
  role: z.string().nullable().default(null),          // null → team's first role
  // SPARSE by design: only the keys the caller explicitly set. (RoleSpecSchema.partial()
  // is NOT sparse — zod fills each field's inherited AgentSpec .default(), so the scheduler's
  // {...roleTemplate, ...overrides} merge would clobber role values with defaults.) Override
  // key/value validity is enforced downstream at spawn via the strict AgentSpecSchema.
  overrides: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().default(0),              // higher drains first; FIFO within a priority
  // QUEUE-REORDER: the secondary drain-order sort key, tie-breaking `priority` —
  // stamped from a monotonically increasing per-store counter at push() so the
  // default ordering is exactly the old Array.sort-stability FIFO. Unlike `priority`
  // (an operator-meaningful tier the caller sets), `orderKey` has no meaning on its
  // own — QueueStore.moveTask is the only thing that ever changes it after creation,
  // by SWAPPING it (with `priority`) against a neighbour's tuple, never by inserting
  // a value between two others — see moveTask's own comment for why that sidesteps
  // the "no integer gap between adjacent neighbours" problem entirely.
  orderKey: z.number().default(0),
  state: TaskStateSchema.default("pending"),
  // Task DEP1: taskIds (in the SAME queue) this task waits on. It stays "blocked"
  // until every listed task is "done"; if any goes "failed" it cascade-fails. Empty
  // (the default) → the pre-existing no-dependency behavior, unchanged.
  dependsOn: z.array(z.string()).default([]),
  // TASK-TAGS: free-form operator labels (conventionally namespaced — "gate:coverage",
  // "area:core"). These are the PRODUCER half of TopicFilterSchema.tags, which HOOK-1 declared
  // and topics.ts's matchesTopicFilter has implemented since day one but nothing on the task
  // path ever populated — a hook or subscription filtering task work by tag matched nothing at
  // all. Bounded (16 x 64 chars) because they ride every task_state_changed event: a filter key
  // is not a place to stash prose. Defaulted, so every pre-existing persisted task parses
  // byte-identically.
  tags: TaskTagsSchema,
  attempts: z.number().int().min(0).default(0),       // spawn attempts consumed by failed runs (incl. failover)
  createdAt: z.number(),
  // WD Stage 1 (coverage B9, task inspector "pushed by"): provenance stamps, both
  // ADDITIVE. `pushedBy` is the calling agent's id when the push arrived through the
  // chimera MCP's queue_push (stamped from CHIMERA_AGENT_ID, mirroring TeamSpec.createdBy);
  // null for a direct/human push. `pushedAt` is stamped by QueueStore.push with the SAME
  // Date.now() as createdAt; it is OPTIONAL (not defaulted) so pre-existing persisted
  // tasks parse byte-identically — readers treat an absent pushedAt as createdAt.
  pushedBy: z.string().nullable().default(null),
  // Durable conductor ownership resolved when the task enters the queue. Unlike
  // pushedBy (the immediate caller), this is the transitive inspector-tree owner.
  originConductorId: z.string().nullable().default(null),
  pushedAt: z.number().optional(),
  // TASK-STAMPS: task-level timing, the other half of pushedAt (which only covers
  // queue → pickup). `startedAt` is stamped by QueueStore.markInProgress on the FIRST
  // pickup only (a retry re-entering markInProgress must not clobber it — that would
  // erase queue-latency history). `endedAt` is stamped by markDone/markFailed. Both
  // OPTIONAL (not defaulted) so every pre-existing persisted task row parses byte-
  // identically; readers treat an absent value as "not yet known", never as 0/now.
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  agentId: z.string().nullable().default(null),       // current/last agent working the task
  resultText: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  // DENIED-TOOL-CALL-INVISIBLE: stamped by QueueStore.markDone from the terminal agent's
  // AgentRecord.toolPolicyDenied — see TaskSummarySchema's mirror of this field for the full
  // rationale. Optional (not defaulted): absent means either "no denial happened" or "this task
  // predates the field", both of which read identically as "nothing to flag", which is correct
  // (a pre-existing persisted task was never scored against this signal, and treating its
  // absence as false is the only sound backward-compatible default).
  toolPolicyDenied: z.boolean().optional(),
  // D12 (task workflows, coverage C14): the workflow NAME requested at push — overrides
  // the queue's own `workflow` binding for THIS task only. null (the default) ⇒ inherit
  // the queue's binding at pickup. Raw/unresolved; see `workflow` below for the pinned,
  // version-locked binding.
  workflowOverride: z.string().nullable().default(null),
  // PINNED at pickup (QueueScheduler.spawnForTask/assignPersistent, D12): the exact
  // {name, version} this task's step sequence is locked to for its entire lifetime, even
  // if workflow.update appends a newer version afterward — "editing a workflow never
  // mutates running tasks". null ⇒ this task is not workflow-bound (ordinary task).
  workflow: z.object({ name: z.string().min(1), version: z.number().int().positive() }).strict().nullable().default(null),
  stepIndex: z.number().int().min(0).default(0),      // index into the PINNED workflow's steps[]
  // gate-failure retries CONSUMED for the CURRENT step (stepIndex) — reset to 0 whenever
  // stepIndex advances; checked against the pinned workflow's retryLimit under onFail:"retry".
  stepAttempts: z.number().int().min(0).default(0),
  // GATE-REMEDIATION-LOOP: total ROUNDS consumed by the CURRENT gate-fail -> remediate ->
  // re-gate loop, anchored to the GATE step that started it (remediationGateStep) — distinct
  // from stepAttempts (see WorkflowRemediateSchema's doc comment for why: stepAttempts resets
  // to 0 on every advanceStep, including the very stepIndex changes this loop itself makes).
  // Reset to 0/null by queues.ts's resetRemediation the moment ANY step's gate passes
  // (scheduler.ts's handleWorkflowTurn, outcome.ok branch) — a cheap unconditional safety
  // net, not just the anchored step's own pass, so a stale anchor can never linger.
  // Sparse-parse-compatible (defaults 0/null) — every pre-existing queues.json row parses
  // unchanged.
  remediationRounds: z.number().int().min(0).default(0),
  remediationGateStep: z.number().int().min(0).nullable().default(null),
  // AGENT-INITIATED-REMEDIATION: a step agent's mid-turn `queue.requestRemediation` call,
  // recorded here (structurally validated by that RPC handler) and consumed the moment this
  // turn completes — scheduler.ts's handleWorkflowTurn checks this BEFORE evaluating the
  // current step's own gate, so a deliberate agent diagnosis pre-empts (never coexists with) the
  // gate's own verdict. Draws on the SAME remediationRounds/remediationGateStep budget above —
  // no separate counter — via the identical incrementRemediationRounds(taskId, task.stepIndex)
  // call the gate-triggered path already uses. Sparse-parse-compatible default null — every
  // pre-existing queues.json row parses unchanged.
  pendingRemediationRequest: z.object({
    targetStepId: z.string().min(1),
    brief: z.string().min(1),
    requestedBy: z.string().min(1).nullable(),
  }).strict().nullable().default(null),
  // F16.1 Phase 2 (WF-4/G4): audit trail of every step attempt this task has made.
  // default [] so pre-existing queues.json rows (with no history at all) parse
  // unchanged (sparse-parse-compatible). Appended to by the scheduler at every step
  // start and closed at every gate evaluation; survives daemon restart (persisted).
  stepHistory: z.array(StepHistoryEntrySchema).default([]),
  // WorkflowGraph: set on a fan-out BRANCH task (queues.ts push, engine-internal only — never
  // forwarded by engine.ts's queue.push RPC handler literal). null for every ordinary task,
  // including the fan-out's own PARENT task.
  parentTaskId: z.string().nullable().default(null),
  // WorkflowGraph: set on the PARENT task by blockOnChildren() to exactly the branch task ids
  // it fanned out into — deliberately a SEPARATE field from `dependsOn` (which blockOnChildren
  // also appends these ids into, to reuse the AND-join/cascade-fail machinery verbatim) so
  // mergeSummaryText's branch lookup can never be confused by an unrelated caller-supplied dep.
  branchChildren: z.array(z.string()).default([]),
  // WorkflowGraph (bounded fan-out): branch item-CHUNKS not yet pushed as branch tasks, in wave
  // order — each element is one future branch task's item group (pre-split by
  // WorkflowFanOut.chunkSize at fan-out start, so admitting a later wave never re-reads/
  // re-chunks anything). Empty once every wave has been admitted (including for an unbounded
  // fan-out, i.e. no maxParallel, which admits its one and only wave immediately — the
  // pre-existing, common case). Durable (NOT scheduler in-memory state) so a daemon restart
  // mid-fan-out doesn't silently drop the un-admitted tail — see queues.ts's pendingFanOuts()/
  // scheduler.ts's tick() admission loop.
  fanOutRemaining: z.array(z.array(z.string().min(1))).default([]),
  // Bounded conditional loops (iterate-until gate): per-loop-edge iteration counter, keyed by
  // the OWNING step id of whichever loopBack edge has been taken (mirrors stepAttempts'
  // "consumed budget" role but is a fully orthogonal counter — see WorkflowEdgeSchema.loopBack
  // above). Sparse-parse-compatible default {} — every pre-existing queues.json row (no loops
  // anywhere) parses unchanged. Never reset once incremented (not touched by advanceStep,
  // releaseForRetry, or requeue — mirrors stepHistory/checkpoint's own "preserve the audit
  // trail" convention) — a true lifetime total for the task, not a per-round value.
  loopIterations: z.record(z.string(), z.number().int().min(0)).default({}),
  // FEATURE-2: the most recently captured durable-resume checkpoint for this task's CURRENT
  // step. null until the task's first fresh agent bind ever completes. Sparse-parse-compatible
  // (default null) — every pre-existing queues.json row parses unchanged.
  checkpoint: TaskStepCheckpointSchema.nullable().default(null),
  // TASK-EDIT-VERSIONING: append-only history of in-place edits (see TaskVersionSchema). The
  // live fields above are always the head; versions[N-1].version === N. Empty for an un-edited
  // task. Sparse-parse-compatible default [] — every pre-existing queues.json row parses unchanged.
  versions: z.array(TaskVersionSchema).default([]),
  // PLAN-HOOKS.md §3.3 (HOOK-4): set by QueueStore.push when a HookEngine `push` action created
  // this task — null for every ordinary (human/agent-pushed) task. Sparse-parse-compatible
  // default null — every pre-existing queues.json row parses unchanged.
  cause: HookCauseSchema.nullable().default(null),
}).strict();
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

// Delivery intent must survive the RPC boundary: ordinary mail never implies interruption.
export const AgentSendOptionsSchema = z.object({ force: z.boolean().optional() });

// F09: what agent.send answers instead of a bare {ok:true}. `turnStarted` is the simple read;
// `ack` carries WHY, because "did a turn start" has no honest boolean answer for a message
// delivered mid-turn (it joins the turn already running and opens no new one — measured at
// p50 2 306 ms / p95 151 183 ms for mid-turn vs p50 585 ms for idle, see the measurement
// artifact named on core's PROMPT_STALL_MS).
//   started  — a turn-opening event arrived within PROMPT_ACK_WAIT_MS. ackMs is the measured ms.
//   mid_turn — accepted while busy; may remain queued until the next boundary. NOT a stall,
//              and no stall watch is armed.
//   pending  — idle agent, nothing yet within PROMPT_ACK_WAIT_MS. The stall watch IS armed and
//              will emit agent_prompt_stalled at stallThresholdMs if the turn never opens.
//              This is an honest "not yet", not a failure.
//   held     — the agent is under an operator-hold; the message sits in its mailbox undelivered
//              (supervisor.ts's OPERATOR-HOLD branch) and is delivered in order on release.
//   command  — a native control request completed; no prompt-turn acknowledgement is expected.
export const SendAckSchema = z.enum(["started", "mid_turn", "pending", "held", "command"]);
export type SendAck = z.infer<typeof SendAckSchema>;

export const AgentSendResultSchema = z.object({
  ok: z.literal(true),                    // kept so every pre-F09 caller reading `.ok` is unaffected
  delivered: z.boolean(),                 // false for held or still queued in the mailbox
  turnStarted: z.boolean(),               // true iff ack === "started"
  ack: SendAckSchema,
  ackMs: z.number().int().min(0).nullable(),        // measured ms, non-null only for "started"
  deliveryId: z.string().min(1),          // the MailboxMessage.id — the evidence key
  stallThresholdMs: z.number().int().positive(),    // PROMPT_STALL_MS, so a caller can size its own wait
}).strict();
export type AgentSendResult = z.infer<typeof AgentSendResultSchema>;

// F09: the durable half — what agent.status(agentId).promptStall carries while a delivery is
// unacknowledged. Non-null ONLY between a fired agent_prompt_stalled and the turn-opening event
// (or terminal transition) that clears it.
export const PromptStallSchema = z.object({
  deliveryId: z.string().min(1),
  from: z.string(),
  sinceTs: z.number().int(),              // epoch ms of the delivery
  sinceMs: z.number().int().min(0),       // ms unacknowledged when the stall fired
  lastSeq: z.number().int().min(0),       // the event seq the agent was parked at
  messageCount: z.number().int().min(1),  // messages in the coalesced delivery group
}).strict();
export type PromptStall = z.infer<typeof PromptStallSchema>;

// ---------- TOKEN-OPT-P1: lightweight projections for agent.listSummary / queue.statusSummary
// ----------
// A full AgentRecord (core/supervisor.ts) embeds the entire spec (prompt/instructions/content
// with UNBOUNDED base64 images, mcpServers) plus resultText, verbatim, per agent — an
// orchestrator polling agent.list over a 20+ agent tree pays for all of it every time.
// AgentSummarySchema is what agent.listSummary returns instead; the full record per agent is
// still reachable via agent.status(agentId).
export const AgentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  status: z.string(),
  model: z.string().nullable(),
  depth: z.number().int().min(0),
  parentId: z.string().nullable(),
  costUsd: z.number(),
  gitBranch: z.string().nullable(),
  // IN-APP-TERMINAL: the agent's EFFECTIVE working directory (core's resolveWorkdirPath —
  // its worktree when one exists, else spec.cwd), so a client can open a shell there without
  // re-deriving the .chimera/worktrees/<key> layout. Optional/nullable + omitted-when-absent,
  // same additive convention as sessionRole above.
  workdir: z.string().nullable().optional(),
  // ROLES-TAB S1: the ad-hoc session role (agent.spawn's `role` param, resolved against the
  // session-role registry) this agent was spawned with — distinct from `role` above, which is
  // the TEAM membership role. Optional/nullable: absent for a pre-S1 client's projection,
  // null for a spawn that named no session role, additive otherwise.
  sessionRole: z.string().nullable().optional(),
  // ROLES-UNIFY §3.3: the sparse overrides actually resolved at spawn time for sessionRole
  // above — a FROZEN audit record (agent-side bindings are spawn-time only, no post-hoc edit
  // RPC), not a live template. Mirrors sessionRole's own optional/nullable + additive-default
  // convention so a pre-ROLES-UNIFY client's projection stays byte-identical.
  sessionRoleOverrides: z.record(z.string(), z.unknown()).nullable().optional(),
  // CROSS-PROVIDER-HANDOFF: the reverse edge from parentId above — parentId means "who
  // called agent.spawn to create me"; handoffFrom means "which agent's context was I built
  // from" (core's supervisor.handoff). handoffTo is the forward pointer, stamped on the
  // SOURCE record once it settles "done" via a handoff (never both set on the same record —
  // a record is either a handoff's target or its source, never both). Optional/omitted
  // (not null-always-present like parentId) since only a tiny fraction of records are ever
  // party to a handoff — same sparse convention as jobName/sessionRole above.
  handoffFrom: z.string().optional(),
  handoffTo: z.string().optional(),
  // BLOCKED-LANDING-NEEDS-A-DATA-FLAG: mirrors AgentRecord.landingPermissionDenied
  // (core/supervisor.ts) verbatim — true once a landing-class (git merge/worktree
  // remove/branch -D) permission request was denied or timed out unanswered for this
  // agent. Optional/omitted (not just false) for the common case, same convention as
  // sessionRole above, so a pre-existing client's projection stays byte-identical.
  landingPermissionDenied: z.boolean().optional(),
  // DENIED-TOOL-CALL-INVISIBLE: mirrors AgentRecord.toolPolicyDenied (core/supervisor.ts)
  // verbatim — generalizes landingPermissionDenied above from ONE denial class (landing Bash)
  // to ANY host-tool-policy deny (Bash toolPolicyGate or foreign-MCP mcpPolicyGate). Same
  // optional/omitted-when-absent convention. Deliberately boolean-only here (not the richer
  // lastToolPolicyDenial detail core carries) — token discipline: a summary consumer only needs
  // enough to decide "does this agent need a closer look"; full detail (tool/profile/
  // profileUnresolved) is reachable via agent.status, same tier split every other
  // summary-boolean-vs-status-detail field in this schema already uses.
  toolPolicyDenied: z.boolean().optional(),
  // F22: true while this agent holds the worktree lease for its own workdirKey (the live answer
  // from WorktreeLeaseStore.heldBy, never a stamped record field — an RPC handoff must be visible
  // in the very next projection, and a self-pruned lease must disappear from it). Unlike the two
  // flags above this is ALWAYS sent, true or false: consumers read it as authoritative-when-
  // present and an absent field means "pre-F22 daemon, keep what you had", so omitting `false`
  // would pin the chip on forever. `.optional()` remains only for those pre-F22 producers.
  worktreeLeaseHeld: z.boolean().optional(),
  // F22: true once this agent was refused a write into ANOTHER agent's leased worktree — the
  // lease analogue of toolPolicyDenied, sticky for the rest of the record's life. The summary
  // carries only the boolean; which worktree/owner/target is on agent.status
  // (lastWorktreeLeaseDenial), same summary-boolean-vs-status-detail tier split.
  worktreeLeaseDenied: z.boolean().optional(),
  // AGENT-LOOKUP-BY-NAME: the operator-visible identity (agent_spawn's `displayLabel` /
  // rename_self) — `name` above is actually the ACCOUNT name (e.g. "claude"/"claude-pers"),
  // not anything a human would recognize as this agent's name. That misnomer is why an
  // operator saying "hand it to the PROJ-1234 agent" was unresolvable: every agent in the
  // list came back with name:"claude". `name` is kept verbatim (renaming it is a breaking
  // projection change every consumer would need updating for) — an agent resolving a
  // human-given label must read `displayLabel`, never `name`. Optional/omitted-when-absent,
  // same additive convention as sessionRole/workdir above.
  displayLabel: z.string().optional(),
  // JOB-FLEET-GROUPING: the scheduled job that spawned this agent (JobRecord.name), or
  // omitted for a spawn with no owning job — supervisor.spawn's `jobName` opt (core), stamped
  // ONLY by JobScheduler.fire's agent-target spawn call sites (jobs.ts); a team-target job's
  // worker is still correlated via team membership, not this field. Durable/record-level (rides
  // AgentRecord.jobName), unlike the prior job attribution path (JobScheduler.jobForAgent), which
  // was a transient in-flight map cleared the instant a run settled — that's why usage.query's
  // groupBy:"job" collapsed every row to "none" (engine.ts's resolveContext queried it after
  // settlement more often than not). Optional/omitted-when-absent, same additive convention as
  // displayLabel above; null is a real "no job" answer only once record-level omission isn't used
  // (mirrors sessionRole's optional+nullable pair, kept here purely for wire-shape consistency).
  jobName: z.string().nullable().optional(),
  // AGENT-GROUPS Phase 1: mirrors jobName's sparse convention — omitted for the overwhelming
  // majority of agents (no group assigned), present only when non-empty.
  groups: z.array(z.string()).optional(),
  // F47 (fleet seen-state): same sparse omit-when-absent convention as groups/jobName — a
  // pre-F47 record (never stamped, never marked seen) projects byte-identically to before.
  // `unseen` is the derived isAgentUnseen() verdict, carried on the wire so every consumer
  // sorts/badges off ONE computation instead of each re-deriving the comparison.
  attentionAt: z.number().optional(),
  reviewedAt: z.number().optional(),
  unseen: z.boolean().optional(),
  // F09: true while this agent has a delivered-but-unacknowledged message (AgentRecord
  // .promptStall non-null). Boolean-only here, same summary-boolean-vs-status-detail tier split
  // as toolPolicyDenied above — the full PromptStall record is on agent.status.
  promptStalled: z.boolean().optional(),
}).strict();
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

// AGENT-LOOKUP-BY-NAME: agent.find's request/response shape. A pure filter over the same
// record set agent.listSummary projects — case-insensitive substring match against
// displayLabel (primary), id, and the account name (fallback, in case an operator names an
// account instead of a label). live:true (the default) excludes terminal agents (done/
// failed/killed) since a lookup-by-name almost always means "message it" or "hand off work
// to it", which only makes sense for a running/paused agent — live:false widens to include
// terminal ones without ever hiding them by default the other way. Never guesses: 0 or >1
// matches both return every candidate (empty or full) plus a `hint` explaining why, instead
// of picking one — the exact failure this tool exists to prevent (a caller silently spawning
// a duplicate because it couldn't resolve a name).
export const AgentFindParamsSchema = z.object({
  q: z.string().trim().min(1),
  live: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional(),
}).strict();
export type AgentFindParams = z.infer<typeof AgentFindParamsSchema>;

export const AgentFindResultSchema = z.object({
  query: z.string(),
  live: z.boolean(),
  matches: z.array(AgentSummarySchema),
  totalMatched: z.number().int().min(0),
  truncated: z.boolean(),
  hint: z.string().nullable(),
}).strict();
export type AgentFindResult = z.infer<typeof AgentFindResultSchema>;

// Same problem, queue side: queue.status returns every TaskRecord for the queue (up to
// MAX_TERMINAL_PER_QUEUE=200 terminal ones), each carrying a full prompt/resultText plus a
// stepHistory[] where every entry can carry an ~8KB handoffSummary. TaskSummarySchema drops
// all of that to an id/state/truncated-subject triple; queue.status still returns the full
// record set unchanged for callers that need stepHistory/full prompt (e.g. TaskInspector).
export const TaskSummarySchema = z.object({
  id: z.string(),
  state: TaskStateSchema,
  subject: z.string(),   // task.prompt, truncated to ~80 chars
  // DENIED-TOOL-CALL-INVISIBLE (Failure 2 — "a task that produced nothing marked done"): true
  // when the agent bound to this task at markDone time had AgentRecord.toolPolicyDenied set —
  // i.e. it hit at least one host-tool-policy deny during its run. Deliberately NOT "the task
  // failed" or "the task produced nothing": a task can still genuinely succeed after working
  // around a denial, and this stays true regardless — it's a WARNING flag ("this run hit a
  // policy wall, look closer"), not a verdict. Never set for a task whose agent made no denied
  // calls at all, so a legitimate no-op (a scout that correctly finds nothing, a NO-OP: commit
  // per the documented protocol) is never flagged — no policy call, no denial, no flag. Optional/
  // omitted-when-absent, same convention as every other additive summary field.
  toolPolicyDenied: z.boolean().optional(),
  // TASK-TAGS: the task's labels, so a coordination audit can read the tag routing off the
  // cheap summary instead of pulling every full record. OPTIONAL and omitted when empty — same
  // strict-schema/exact-key-set discipline as toolPolicyDenied just above.
  tags: z.array(z.string()).optional(),
}).strict();
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

// FEATURE-8 (RpcContract): shared by QueueStatusSummarySchema below and contract.ts's
// QueueStatusSchema (the `queue.status` response) — both project QueueStore.status()'s
// per-state task counts, previously defined inline twice.
export const QueueCountsSchema = z.object({
  pending: z.number().int().min(0), in_progress: z.number().int().min(0),
  done: z.number().int().min(0), failed: z.number().int().min(0), blocked: z.number().int().min(0),
  dead_letter: z.number().int().min(0),   // RETRY-BACKOFF: 6th TaskState member
});
export type QueueCounts = z.infer<typeof QueueCountsSchema>;

export const QueueStatusSummarySchema = z.object({
  spec: QueueSpecSchema,
  counts: QueueCountsSchema,
  tasks: z.array(TaskSummarySchema),
  // Only the terminal (done/failed) slice of `tasks` is paginated — non-terminal tasks
  // (pending/in_progress/blocked) are always included in full since a queue rarely has many
  // in flight at once. null once every terminal task has been paged through.
  nextCursor: z.string().nullable(),
}).strict();
export type QueueStatusSummary = z.infer<typeof QueueStatusSummarySchema>;

// ---------- task workflows (D12, coverage C14) ----------
// A WORKFLOW is a named, versioned sequence of steps a bound task walks IN ORDER —
// chimera (not the engine's own self-report) evaluates each step's GATE before
// advancing. Persisted at ${home}/workflows.json (core's WorkflowStore). workflow.update
// never mutates an existing version in place — it APPENDS a new one; a task pins
// {name, version} the moment it's picked up (see TaskRecordSchema.workflow above), so a
// running task always finishes against the exact step sequence it started with.
export const WorkflowGateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    // WF-3 (G3): optional per-gate override of the default 120s exec timeout, for
    // real test suites that run longer. Absent ⇒ defaultGateExec's 120s default.
    spec: z.object({
      command: z.string().min(1), args: z.array(z.string()).default([]),
      timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("artifact"),
    spec: z.object({
      artifactId: z.string().min(1).optional(),
      // F16.1 Phase 2 (WF-4/G5): "task" (default, current behavior) accepts any
      // artifact registered anywhere in the task's lifetime; "step" requires one
      // registered while THIS gate's stepIndex was the task's current step — closes
      // the self-declare-able hole where an artifact from an EARLIER step (or a
      // decoy registered ahead of time) satisfies a later step's gate.
      scope: z.enum(["task", "step"]).default("task"),
      // optional pin: the artifact must also match this ArtifactKind.
      kind: ArtifactKindSchema.optional(),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("approval"),
    spec: z.object({ prompt: z.string().min(1).optional() }).strict(),
  }).strict(),
  // FEATURE-3: evaluator-optimizer loop — a SEPARATE critic agent judges the step's
  // output against `criteria`; "revise" resends the critic's feedback to the SAME
  // worker as an ordinary gate-failure retry (scheduler.ts's handleWorkflowTurn),
  // bounded by `maxRounds` rather than the step/workflow onFail/retryLimit policy.
  z.object({
    kind: z.literal("critic"),
    spec: z.object({
      criteria: z.string().min(1),
      // Team role to spawn the critic as (that role's own model/permissions/tools).
      // Absent ⇒ falls back to the step's own `role`, else the worker's current
      // role, else the team's first role (scheduler.ts's runCritic).
      criticRole: z.string().min(1).optional(),
      // Hard cap on total critic evaluation ROUNDS for this step (a "pass" or a
      // "revise" both count as one round).
      maxRounds: z.number().int().min(1).max(20).default(3),
    }).strict(),
  }).strict(),
  // Dynamic Planner: the step's agent registers a STRUCTURED plan artifact (a "file"-kind
  // artifact, registered via the existing artifact_add tool) instead of doing the work
  // itself. This gate reuses the artifact-gate's existence check above, then goes further:
  // it reads the matched artifact's content, validates it against PlanArtifactSchema (see
  // below — the SAME validateWorkflowGraph cycle/dangling-edge/step-uniqueness checks a
  // hand-authored workflow.create gets, plus a hard step-count cap), and compiles it into a
  // fresh EPHEMERAL WorkflowRecord (WorkflowStore.instantiate) that a single nested child
  // task runs to completion under the full existing gate/checkpoint/budget machinery —
  // exactly like a hand-authored workflow (scheduler.ts's evaluatePlanGate/beginPlanDispatch).
  z.object({
    kind: z.literal("plan"),
    spec: z.object({
      artifactId: z.string().min(1).optional(),
      scope: z.enum(["task", "step"]).default("step"),
      // The step THIS workflow resumes at once the compiled plan's child task joins.
      // REQUIRED — mirrors WorkflowFanOutSchema.joinStep below. Unlike an ordinary step
      // (whose successor is resolvable via resolveNextStep/`next` the instant its gate
      // passes), a plan step's real "next" is only knowable after the DYNAMICALLY-
      // generated plan has actually run — so it needs a fixed, statically-validated
      // landing step instead of resolveNextStep's terminal/unrouted semantics.
      resumeStep: z.string().min(1),
    }).strict(),
  }).strict(),
  z.object({ kind: z.literal("none"), spec: z.object({}).strict().optional() }).strict(),
]);
export type WorkflowGate = z.infer<typeof WorkflowGateSchema>;

// GATE-REMEDIATION-LOOP: onFail's third policy, alongside "halt"/"retry" — instead of
// resending THIS step (retry) or stopping the workflow (halt), a gate failure is routed to a
// (usually different, earlier) step with the gate's own failure output as a fix-brief, then
// the workflow re-advances forward through the gate. Bounded by maxRounds — mirrors the
// critic gate's maxRounds convention (a pass or a fail-then-remediate both count as a round)
// but tracked on its OWN counter (TaskRecord.remediationRounds below), not stepAttempts:
// stepAttempts resets to 0 on every advanceStep, including the very stepIndex changes this
// loop itself makes bouncing between the gate step and the remediation step.
export const WorkflowRemediateSchema = z.object({
  // Step id to route this gate's failure output to. Absent ⇒ scheduler.ts's
  // resolveRemediateStepIndex default: the nearest PRECEDING step whose id or role is
  // "implement", else the SAME step (bounced back to itself — same effective target as
  // onFail:"retry", but governed by maxRounds instead of retryLimit/retryPolicy; this is the
  // single-agent-workflow case).
  remediateStep: z.string().min(1).optional(),
  maxRounds: z.number().int().min(1).max(20).default(3),
}).strict();
export type WorkflowRemediate = z.infer<typeof WorkflowRemediateSchema>;

export const WorkflowOnFailSchema = z.enum(["halt", "retry", "remediate"]);
export type WorkflowOnFail = z.infer<typeof WorkflowOnFailSchema>;

// ---------- WorkflowGraph (routing + fan-out/map-reduce) ----------
// RouteCondition: evaluated only AFTER a step's own gate has passed (routing never overrides
// onFail/retry — a failed gate is unaffected by `next`). "always" is the unconditional/default
// edge; "artifact" reuses the artifact-gate's existence check (ArtifactStore.existsForTask),
// scoped to the task (not step) for v1 — a step-scoped routing condition is a follow-up.
export const RouteConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }).strict(),
  z.object({
    kind: z.literal("artifact"),
    spec: z.object({ artifactId: z.string().min(1).optional(), kind: ArtifactKindSchema.optional() }).strict(),
  }).strict(),
  // Bounded loops (iterate-until gate): compares an artifact's actual SNAPSHOTTED CONTENT
  // (not just existence, unlike "artifact" above) against `value` — the mechanism an
  // iterate-until-condition-met loop uses to decide "keep looping" vs "fall through".
  // Resolves the MOST RECENTLY registered matching artifact (ArtifactStore.list preserves
  // insertion order — "the latest round's self-reported value wins"); a "link"-kind artifact
  // never matches (nothing snapshotted to read) — same fail-closed-to-false philosophy as no
  // match at all.
  z.object({
    kind: z.literal("artifactValue"),
    spec: z.object({
      artifactId: z.string().min(1).optional(),
      scope: z.enum(["task", "step"]).default("task"),
      kind: ArtifactKindSchema.optional(),
      op: z.enum(["equals", "notEquals", "contains", "gte", "lte"]).default("equals"),
      value: z.string().min(1),
    }).strict(),
  }).strict(),
]);
export type RouteCondition = z.infer<typeof RouteConditionSchema>;

// A step's next-successors as explicit edges, evaluated in ARRAY ORDER — first matching
// `when` wins (absent `when` == "always", so it's always a match — put unconditional
// fallback edges LAST). `to` is a step id, validated by validateWorkflowGraph below.
export const WorkflowEdgeSchema = z.object({
  to: z.string().min(1),
  when: RouteConditionSchema.optional(),
  // Bounded conditional loops (iterate-until gate): marks this edge as an intentional
  // BACKWARD edge — `to` MUST reference a step at a STRICTLY EARLIER index than this edge's
  // own step (validateWorkflowGraph below enforces it; a self-loop or a forward "loopBack" is
  // rejected — retrying/advancing a SINGLE step already has onFail:"retry" and the critic
  // gate for that). maxIterations is MANDATORY the instant loopBack is present — an unbounded
  // loop can never be expressed. Counted per-edge on TaskRecord.loopIterations, keyed by this
  // edge's OWNING step id (scheduler.ts's resolveNextStep/QueueStore.incrementLoopIterations)
  // — once the count reaches maxIterations the edge stops matching regardless of `when`,
  // falling through to whatever edge comes after it (an author-supplied "give up" edge) or to
  // "unrouted" (task failure) if there is none.
  loopBack: z.object({ maxIterations: z.number().int().min(1).max(1000) }).strict().optional(),
}).strict();
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

// fan-out source: "list" is a STATIC list authored directly in the spec (items.min(1) — an
// empty static fan-out is a nonsensical spec, rejected at the schema level, not the
// scheduler). "artifactList" is resolved at runtime from a registered "file" artifact (a JSON
// array of strings) — mirrors the `plan` gate's artifactId/scope lookup pair. Now a REAL
// discriminated union (it started as a single-arm plain object deliberately, to avoid a
// premature narrowing bug on a union with only one live arm) — scheduler.ts's
// resolveFanOutItems follows the SAME "read the payload only after the `kind` check"
// discipline routeConditionMatches (scheduler.ts) already established for RouteCondition.
const FanOutSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), items: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({
    kind: z.literal("artifactList"),
    spec: z.object({ artifactId: z.string().min(1).optional(), scope: z.enum(["task", "step"]).default("task") }).strict(),
  }).strict(),
]);
export const WorkflowFanOutSchema = z.object({
  source: FanOutSourceSchema,
  // the step id every branch converges back to; validateWorkflowGraph requires it to exist
  // and to come strictly AFTER this step (fan-out edges are always forward-only — see below).
  joinStep: z.string().min(1),
  // Bounded concurrency: chunkSize groups N items into ONE branch task's prompt (default 1 —
  // today's one-item-per-branch shape); maxParallel caps how many branch tasks are in flight
  // at once across ALL waves of this fan-out (default: unbounded — every chunk pushed in a
  // single wave, today's exact "push everything at once" behavior). Both optional/defaulted so
  // every pre-existing fan-out spec parses byte-identically. See scheduler.ts's beginFanOut /
  // tick()'s admission loop for how a fan-out with a bounded maxParallel drains in waves.
  chunkSize: z.number().int().positive().default(1),
  maxParallel: z.number().int().positive().optional(),
}).strict();
export type WorkflowFanOut = z.infer<typeof WorkflowFanOutSchema>;

// Dynamic Planner precedent: PlanArtifactSchema (below) validates a registered artifact's JSON
// payload for the `plan` gate; this is the same idea for an "artifactList" fan-out source's
// payload — a plain non-empty array of strings, nothing more structured needed.
export const FanOutArtifactListSchema = z.array(z.string().min(1)).min(1);

// Nested sub-workflows: this step is a SUB-WORKFLOW node, not an execution node — no agent
// ever runs FOR this step index (mirrors WorkflowFanOutSchema exactly). Reaching it
// resolves `name`[/`version`] as a recipe via WorkflowStore.instantiateRecipe (binding
// `inputs` against the recipe's own declared `params`), pushes the resulting concrete,
// ephemeral, single-version WorkflowRecord as ONE workflow-bound child task
// (parentTaskId set), blocks the parent on it via queues.blockOnChildren (the SAME
// dependsOn AND-join beginFanOut/beginPlanDispatch reuse), then resumes at `joinStep` once
// the child finishes. Mutually exclusive with `next`/`fanOut` and with a `plan` gate (all
// four are alternative ways of deciding this step's successor — see validateWorkflowGraph).
// Forbidden on steps[0], same reasoning as fanOut: spawnForTask spawns an agent
// unconditionally for wf.steps[0], which a no-agent dispatch node can never be.
export const WorkflowSubWorkflowSchema = z.object({
  name: z.string().min(1),
  // Pins a specific recipe version; absent ⇒ latest at dispatch time (re-resolved on
  // every dispatch, unlike a task's own {name,version} pin — deliberate: "always run the
  // current recipe" is the more useful default for a shared, iterated-on building block;
  // pin explicitly when you need reproducibility).
  version: z.number().int().positive().optional(),
  // Args bound to the target recipe's own `params` — every key must match a declared
  // param name (instantiateRecipe rejects unknown keys); a param with no `default` MUST
  // appear here. Values are static literals authored into THIS spec — not interpolated
  // against the outer workflow's own params (see PLAN.md follow-ups).
  inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  // The step THIS workflow resumes at once the sub-workflow's single child task joins.
  // REQUIRED, mirrors WorkflowFanOutSchema.joinStep exactly.
  joinStep: z.string().min(1),
}).strict();
export type WorkflowSubWorkflow = z.infer<typeof WorkflowSubWorkflowSchema>;

export const WorkflowStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  gate: WorkflowGateSchema,
  // optional (not defaulted-null) so previously persisted workflows.json parse
  // byte-identically — absent means "no extra instructions for this step", same as today.
  instructions: z.string().min(1).optional(),
  // F16.1 Phase 2 (WF-5/G6): per-step override of the workflow-level onFail/retryLimit —
  // a cheap lint step and an expensive review step shouldn't have to share one policy.
  // Both optional/undefined (not defaulted) so pre-existing steps parse byte-identically;
  // the scheduler resolves step-level ?? workflow-level at every gate evaluation.
  onFail: WorkflowOnFailSchema.optional(),
  retryLimit: z.number().int().min(0).optional(),
  // RETRY-BACKOFF: per-step override of the workflow-level retryPolicy (mirrors onFail/
  // retryLimit's existing step-overrides-workflow pattern). Both optional/undefined so
  // pre-existing steps parse byte-identically.
  retryPolicy: RetryPolicySchema.optional(),
  // GATE-REMEDIATION-LOOP: per-step override of the workflow-level `remediate` policy —
  // mirrors retryPolicy's step-overrides-workflow pattern. Only consulted when this step's
  // resolved onFail (step.onFail ?? wf.onFail) is "remediate"; ignored by a critic gate
  // (which has its own independent maxRounds loop, see WorkflowGateSchema's critic kind).
  remediate: WorkflowRemediateSchema.optional(),
  // F16.1 Phase 3 (WF-8): the TEAM role that must run this step. Absent → the step runs
  // on whatever agent is already bound (exactly today's single-agent behavior). When two
  // consecutive steps name the SAME role, the scheduler keeps the same agent (no respawn);
  // a DIFFERENT role triggers a step-boundary agent switch (scheduler.ts handleWorkflowTurn).
  role: z.string().min(1).optional(),
  // TOKEN-OPT-P5: OPTIONAL per-step model override for mechanical/low-risk work
  // (formatting, single-file edits, gate/lint fixes) — resolved in the scheduler
  // (spawnStepAgent) at THIS step's spawn and threaded straight into the spawned
  // agent's spec.model, taking precedence over the role template's own model and any
  // task-level override. Absent ⇒ today's behavior (role template / task override /
  // account default), so every existing workflow parses and runs byte-identically.
  // Opt-in only — never applied automatically to a step that doesn't set it.
  model: z.string().min(1).optional(),
  // F16.1 Phase 3 (WF-9): whether THIS step's incoming agent (on a role-switch boundary)
  // receives the previous step's handoff package (summary + artifact list — see
  // scheduler.ts's beginHandoff/completeHandoff). Defaulted (not optional) since every
  // role-switch benefits from context by default; "none" opts a step out entirely (the
  // agent gets scope + instructions + task prompt only, exactly today's behavior). A
  // step with no `role` (no switch possible) never reads this field.
  context: z.enum(["handoff", "none"]).default("handoff"),
  // FEATURE-5: OPTIONAL per-step budget ceiling — mirrors `model`'s override pattern above.
  // Threaded into that step's fresh spawn as spec.maxBudgetUsd, registered as its OWN budget
  // node (child of the task/root node) by supervisor.spawn's hierarchical admission check.
  // Absent ⇒ today's behavior (no step-level ceiling), so every existing workflow parses and
  // runs byte-identically. Does not apply to idle-persistent-worker reuse (send() has no
  // budget channel), same limitation `model` already documents above.
  budgetUsd: z.number().positive().optional(),
  // WorkflowGraph: explicit successors by step id, evaluated once this step's OWN gate has
  // passed. ABSENT (undefined) == today's exact implicit `stepIndex + 1` fallthrough. PRESENT
  // (even `[]`) opts this step OUT of implicit fallthrough: `[]` is an explicit terminal step
  // (workflow ends here, same as falling off the end of steps[]); a non-empty array routes
  // among its edges, first `when` match wins — no match is a task failure ("unrouted"), not a
  // silent finish. Mutually exclusive with `fanOut` (validateWorkflowGraph rejects both set).
  next: z.array(WorkflowEdgeSchema).optional(),
  // WorkflowGraph: this step is a FAN-OUT node, not an execution node — no agent ever runs FOR
  // this step index. Reaching it spawns one plain (non-workflow) branch task per fan-out item,
  // blocks the task on all of them (queues.ts blockOnChildren, reusing DEP1's dependsOn AND-
  // join/cascade-fail verbatim), then resumes at `fanOut.joinStep` once every branch is done (or
  // fails the task the instant any branch fails — cascade, not a per-branch workflow retry; see
  // PLAN.md follow-ups). Mutually exclusive with `next`; forbidden on steps[0] (see below).
  fanOut: WorkflowFanOutSchema.optional(),
  // Nested sub-workflows: see WorkflowSubWorkflowSchema above.
  subWorkflow: WorkflowSubWorkflowSchema.optional(),
}).strict();
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

// Recipe templating: a typed parameter a WorkflowSpec declares so WorkflowStore.
// instantiateRecipe can bind caller-supplied `args` and interpolate them into the spec's
// own steps (see workflows.ts). A param with no `default` is REQUIRED — instantiateRecipe
// throws if `args` omits it; one WITH a default is optional. No separate `required`
// boolean (would let default+required contradict each other) — presence of `default` IS
// the optionality signal, same convention as an ordinary JS/TS default parameter.
export const WorkflowParamSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean"]).default("string"),
  description: z.string().min(1).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict().refine((p) => p.default === undefined || typeof p.default === p.type,
  { message: "default must match type", path: ["default"] });
export type WorkflowParam = z.infer<typeof WorkflowParamSchema>;

const WorkflowSpecObject = z.object({
  name: CoordName,
  steps: z.array(WorkflowStepSchema).min(1),
  onFail: WorkflowOnFailSchema.default("halt"),
  // number of GATE-FAILURE retries of the SAME step onFail:"retry" attempts before
  // giving up and halting anyway (0 ⇒ no retries, indistinguishable in effect from "halt").
  retryLimit: z.number().int().min(0).default(0),
  // RETRY-BACKOFF: workflow-level default, overridable per-step (WorkflowStepSchema.retryPolicy
  // above) — mirrors onFail/retryLimit's own step-overrides-workflow pattern.
  retryPolicy: RetryPolicySchema.optional(),
  // GATE-REMEDIATION-LOOP: workflow-level default `remediate` policy, overridable per-step
  // (WorkflowStepSchema.remediate above) — mirrors retryPolicy's own step-overrides-workflow
  // pattern. Absent ⇒ every existing workflow parses byte-identically; only consulted when a
  // step's resolved onFail is "remediate".
  remediate: WorkflowRemediateSchema.optional(),
  // Recipe templating: declared params this spec's steps may reference as `${paramName}`
  // in any string field (title/instructions/gate spec strings/etc — see workflows.ts's
  // JSON-round-trip interpolation). Defaulted [] ⇒ every existing WorkflowSpec/
  // WorkflowRecord parses byte-identically; a spec with no params behaves exactly as
  // today. Only meaningful for a spec later resolved via WorkflowStore.instantiateRecipe —
  // an ordinary hand-run workflow with params declared but never instantiated as a recipe
  // just carries inert metadata.
  params: z.array(WorkflowParamSchema).default([]),
}).strict();

// WorkflowGraph: shared by WorkflowSpecSchema and WorkflowRecordSchema below — applied to EACH
// separately (never chained extend-then-refine or refine-then-extend) to sidestep any zod-
// version-specific uncertainty about whether .extend() preserves a prior .superRefine()'s
// checks. SKIPS ENTIRELY when no step sets `next`/`fanOut` — a pure-linear spec pays zero extra
// validation cost and cannot newly fail parsing that succeeded before this feature existed.
// `ctx` is typed `any`: zod ^4.4.3 has no unprefixed `z.RefinementCtx` export to name here.
function validateWorkflowGraph(
  spec: { steps: WorkflowStep[]; params?: WorkflowParam[]; onFail?: WorkflowOnFail; remediate?: WorkflowRemediate },
  ctx: any,
): void {
  // Recipe templating: duplicate param names — runs UNCONDITIONALLY (not gated behind
  // `graphish` below), since this has nothing to do with graph topology.
  const paramNames = new Set<string>();
  for (const p of spec.params ?? []) {
    if (paramNames.has(p.name)) ctx.addIssue({ code: "custom", message: `duplicate param "${p.name}"`, path: ["params"] });
    paramNames.add(p.name);
  }
  // GATE-REMEDIATION-LOOP: runs UNCONDITIONALLY (not gated behind `graphish` below) — a
  // purely linear workflow with no next/fanOut/plan/subWorkflow at all (e.g. plan ->
  // implement -> qa-verify -> land) is exactly the common case for onFail:"remediate", so
  // gating this behind `graphish` would silently skip it for the workflows most likely to use
  // this feature. Builds `idOf` (last-write-wins on a duplicate id) unconditionally too, since
  // remediateStep's existence check needs it here — but deliberately does NOT emit the
  // "duplicate step id" issue itself outside `graphish` (see that check further below): a
  // plain-linear spec's step ids are purely cosmetic labels when nothing routes by id, and a
  // pre-existing test pins that a duplicate id is allowed in that case.
  const idOf = new Map<string, number>();
  spec.steps.forEach((s, i) => idOf.set(s.id, i));
  spec.steps.forEach((s, i) => {
    const resolvedOnFail = s.onFail ?? spec.onFail;
    if (resolvedOnFail !== "remediate" || s.gate.kind === "critic") return;
    const policy = s.remediate ?? spec.remediate;
    if (!policy) {
      ctx.addIssue({ code: "custom", message: `step "${s.id}" resolves onFail:"remediate" but has no remediate policy (step or workflow level)`, path: ["steps", i, "remediate"] });
      return;
    }
    if (policy.remediateStep) {
      const j = idOf.get(policy.remediateStep);
      if (j === undefined) {
        ctx.addIssue({ code: "custom", message: `step "${s.id}" remediate.remediateStep references unknown step "${policy.remediateStep}"`, path: ["steps", i, "remediate", "remediateStep"] });
      } else if (spec.steps[j]!.fanOut || spec.steps[j]!.subWorkflow) {
        ctx.addIssue({ code: "custom", message: `step "${s.id}" remediate.remediateStep "${policy.remediateStep}" cannot be a fanOut/subWorkflow step (no agent runs for it)`, path: ["steps", i, "remediate", "remediateStep"] });
      }
    }
  });
  // Dynamic Planner: a `plan`-gated step has a dynamic successor (its gate.spec.resumeStep)
  // just like a fanOut step's joinStep — needs the same graph checks below. Nested
  // sub-workflows: a `subWorkflow` step is a fourth instance of the same pattern.
  const graphish = spec.steps.some((s) =>
    s.next !== undefined || s.fanOut !== undefined || s.gate.kind === "plan" || s.subWorkflow !== undefined);
  if (!graphish) return;
  const seenIds = new Set<string>();
  spec.steps.forEach((s, i) => {
    if (seenIds.has(s.id)) ctx.addIssue({ code: "custom", message: `duplicate step id "${s.id}"`, path: ["steps", i, "id"] });
    seenIds.add(s.id);
  });
  spec.steps.forEach((s, i) => {
    // Nested sub-workflows: a step may set AT MOST ONE of next/fanOut/subWorkflow —
    // replaces the old pairwise next+fanOut check with a 3-way count.
    const controlKinds = [s.next !== undefined, s.fanOut !== undefined, s.subWorkflow !== undefined].filter(Boolean).length;
    if (controlKinds > 1) ctx.addIssue({ code: "custom", message: `step "${s.id}" cannot combine more than one of next/fanOut/subWorkflow`, path: ["steps", i] });
    // Dynamic Planner: a plan gate's resumeStep already decides this step's successor —
    // an explicit `next` would be ambiguous (which one wins?), mirrors the next+fanOut check.
    if (s.gate.kind === "plan" && s.next !== undefined)
      ctx.addIssue({ code: "custom", message: `step "${s.id}" cannot combine a "plan" gate with next`, path: ["steps", i, "next"] });
    // Nested sub-workflows: a plan gate's resumeStep and a subWorkflow's joinStep are the
    // same class of conflict as plan+next above — both claim to decide this step's successor.
    if (s.gate.kind === "plan" && s.subWorkflow !== undefined)
      ctx.addIssue({ code: "custom", message: `step "${s.id}" cannot combine a "plan" gate with subWorkflow`, path: ["steps", i, "subWorkflow"] });
    s.next?.forEach((e, ei) => {
      if (!idOf.has(e.to)) ctx.addIssue({ code: "custom", message: `step "${s.id}" next[${ei}].to references unknown step "${e.to}"`, path: ["steps", i, "next", ei, "to"] });
      // Bounded loops: a loopBack edge's whole point is jumping BACKWARD to re-run a prior
      // phase — `to` must resolve to a step at a STRICTLY EARLIER index. Independent of the
      // cycle DFS below (this is a per-edge structural property, not a graph-shape one).
      if (e.loopBack) {
        const j = idOf.get(e.to);
        if (j !== undefined && j >= i) ctx.addIssue({ code: "custom", message: `step "${s.id}" next[${ei}] is a loopBack edge but "${e.to}" is not an earlier step`, path: ["steps", i, "next", ei, "loopBack"] });
      }
    });
    if (s.fanOut) {
      if (i === 0) ctx.addIssue({ code: "custom", message: `step 0 ("${s.id}") cannot be a fanOut step`, path: ["steps", i, "fanOut"] });
      const j = idOf.get(s.fanOut.joinStep);
      if (j === undefined) ctx.addIssue({ code: "custom", message: `step "${s.id}" fanOut.joinStep references unknown step "${s.fanOut.joinStep}"`, path: ["steps", i, "fanOut", "joinStep"] });
      else if (j <= i) ctx.addIssue({ code: "custom", message: `step "${s.id}" fanOut.joinStep must come after this step`, path: ["steps", i, "fanOut", "joinStep"] });
    }
    // Nested sub-workflows: same dangling/forward-only check as fanOut.joinStep, and step-0
    // forbidden for the same reason (spawnForTask spawns unconditionally for step 0).
    if (s.subWorkflow) {
      if (i === 0) ctx.addIssue({ code: "custom", message: `step 0 ("${s.id}") cannot be a subWorkflow step`, path: ["steps", i, "subWorkflow"] });
      const j = idOf.get(s.subWorkflow.joinStep);
      if (j === undefined) ctx.addIssue({ code: "custom", message: `step "${s.id}" subWorkflow.joinStep references unknown step "${s.subWorkflow.joinStep}"`, path: ["steps", i, "subWorkflow", "joinStep"] });
      else if (j <= i) ctx.addIssue({ code: "custom", message: `step "${s.id}" subWorkflow.joinStep must come after this step`, path: ["steps", i, "subWorkflow", "joinStep"] });
    }
    // Dynamic Planner: resumeStep gets the SAME dangling/forward-only check as fanOut.joinStep.
    if (s.gate.kind === "plan") {
      const j = idOf.get(s.gate.spec.resumeStep);
      if (j === undefined) ctx.addIssue({ code: "custom", message: `step "${s.id}" plan gate resumeStep references unknown step "${s.gate.spec.resumeStep}"`, path: ["steps", i, "gate", "spec", "resumeStep"] });
      else if (j <= i) ctx.addIssue({ code: "custom", message: `step "${s.id}" plan gate resumeStep must come after this step`, path: ["steps", i, "gate", "spec", "resumeStep"] });
    }
  });
  // Nested sub-workflows: fold subWorkflow.joinStep into the SAME dedup map as
  // fanOut.joinStep — two dispatch-style steps (any mix of fanOut/subWorkflow) can't
  // claim the same join step.
  const joinOwner = new Map<string, string>();
  for (const s of spec.steps) {
    const j = s.fanOut?.joinStep ?? s.subWorkflow?.joinStep;
    if (!j) continue;
    const prior = joinOwner.get(j);
    if (prior) ctx.addIssue({ code: "custom", message: `joinStep "${j}" claimed by both "${prior}" and "${s.id}"` });
    else joinOwner.set(j, s.id);
  }
  // uniform successors() lets one DFS catch cycles from EITHER next-edges or fanOut->joinStep
  // edges (or a mix) — fanOut edges are already forward-only (checked above) so they can never
  // themselves close a cycle, but folding them into the same successors() keeps the DFS one
  // honest function instead of two special cases. Bounded loops: a `loopBack`-marked edge is
  // EXCLUDED here — it is a deliberate, bounded (maxIterations-capped, schema-enforced)
  // backward edge, not part of the graph's forward-DAG shape, so it can never itself close a
  // cycle in this walk. Any OTHER edge that happens to point backward (or any combination of
  // edges that closes a cycle without ever routing through a loopBack edge) is still rejected
  // exactly as before — only an edge EXPLICITLY marked loopBack gets the carve-out, never the
  // step or the graph as a whole.
  const successors = (i: number): number[] => {
    const s = spec.steps[i]!;
    if (s.fanOut) { const j = idOf.get(s.fanOut.joinStep); return j === undefined ? [] : [j]; }
    if (s.subWorkflow) { const j = idOf.get(s.subWorkflow.joinStep); return j === undefined ? [] : [j]; }
    if (s.gate.kind === "plan") { const j = idOf.get(s.gate.spec.resumeStep); return j === undefined ? [] : [j]; }
    if (s.next !== undefined) return s.next.filter((e) => !e.loopBack).map((e) => idOf.get(e.to)).filter((j): j is number => j !== undefined);
    return i + 1 < spec.steps.length ? [i + 1] : [];
  };
  const state: number[] = new Array(spec.steps.length).fill(0);   // 0 unvisited, 1 visiting, 2 done
  const visit = (i: number): boolean => {
    if (state[i] === 1) return true;
    if (state[i] === 2) return false;
    state[i] = 1;
    for (const j of successors(i)) if (visit(j)) return true;
    state[i] = 2;
    return false;
  };
  for (let i = 0; i < spec.steps.length; i++) {
    if (state[i] === 0 && visit(i)) {
      ctx.addIssue({ code: "custom", message: "workflow graph contains a cycle" });
      break;
    }
  }
}

export const WorkflowSpecSchema = WorkflowSpecObject.superRefine(validateWorkflowGraph);
export type WorkflowSpec = z.infer<typeof WorkflowSpecObject>;

export const WorkflowRecordSchema = WorkflowSpecObject.extend({
  version: z.number().int().positive(),
  createdAt: z.number(),
  // Dynamic Planner: true for a `plan`-gate-compiled, scheduler-synthesized WorkflowRecord
  // (WorkflowStore.instantiate) — excluded from workflow.list/the authoring UI
  // (WorkflowStore.list filters these out) but otherwise a completely normal, persisted,
  // versioned WorkflowRecord so a bound task resolves/restarts exactly like any
  // hand-authored workflow. Defaulted false ⇒ every existing WorkflowRecord parses
  // byte-identically.
  ephemeral: z.boolean().default(false),
}).strict().superRefine(validateWorkflowGraph);
export type WorkflowRecord = z.infer<typeof WorkflowRecordSchema>;

// Dynamic Planner: the JSON payload a `plan`-gated step's agent registers as a "file"-kind
// artifact — literally a WorkflowSpec minus `name` (the ephemeral WorkflowRecord's name is
// synthesized server-side by WorkflowStore.instantiate, never agent-supplied, so two
// concurrent/retried plan runs can never collide). Reuses validateWorkflowGraph verbatim —
// a dynamically-generated plan gets the EXACT same cycle/dangling-edge/step-uniqueness
// checks a hand-authored workflow.create call does. `.max(PLAN_MAX_STEPS)` is the hard cap
// on runtime-generated step count — a runaway/misbehaving planner cannot describe an
// unbounded amount of work.
export const PLAN_MAX_STEPS = 20;
export const PlanArtifactSchema = z.object({
  steps: z.array(WorkflowStepSchema).min(1).max(PLAN_MAX_STEPS),
  onFail: WorkflowOnFailSchema.default("halt"),
  retryLimit: z.number().int().min(0).default(0),
}).strict().superRefine(validateWorkflowGraph);
export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;

// FEATURE WORKFLOW-RUN-P1: the ad-hoc spec shape workflow_run compiles straight into an
// ephemeral WorkflowRecord (WorkflowStore.instantiateAdHoc) — PlanArtifactSchema's shape
// (steps/onFail/retryLimit, same PLAN_MAX_STEPS cap and validateWorkflowGraph checks) plus
// retryPolicy, since a caller driving a dynamic workflow directly (not via a `plan` gate) can
// set the same per-run retry backoff any hand-authored WorkflowSpec can.
export const WorkflowRunSpecSchema = z.object({
  steps: z.array(WorkflowStepSchema).min(1).max(PLAN_MAX_STEPS),
  onFail: WorkflowOnFailSchema.default("halt"),
  retryLimit: z.number().int().min(0).default(0),
  retryPolicy: RetryPolicySchema.optional(),
}).strict().superRefine(validateWorkflowGraph);
export type WorkflowRunSpec = z.infer<typeof WorkflowRunSpecSchema>;

// workflow.update {name, patch} — a sparse merge-patch over the mutable subset of a
// WorkflowSpec; applying it APPENDS a new version (WorkflowStore.update) rather than
// mutating the version any in-flight task has pinned.
export const WorkflowUpdateParams = z.object({
  name: z.string().min(1),
  patch: z.object({
    steps: z.array(WorkflowStepSchema).min(1).optional(),
    onFail: WorkflowOnFailSchema.optional(),
    retryLimit: z.number().int().min(0).optional(),
    retryPolicy: RetryPolicySchema.optional(),
    // GATE-REMEDIATION-LOOP: lets the workflow-level remediate default be edited via
    // workflow.update, same append-a-new-version semantics as every other patchable field.
    remediate: WorkflowRemediateSchema.optional(),
    // Recipe templating: lets a recipe's declared params be edited via workflow.update,
    // same APPEND-a-new-version semantics as every other patchable field.
    params: z.array(WorkflowParamSchema).optional(),
  }).strict(),
}).strict();
export type WorkflowUpdateParams = z.infer<typeof WorkflowUpdateParams>;

// ---------- artifact registry (D13, coverage C15, F17) ----------
// An ARTIFACT is a concrete output an agent registers against its run/task — a report,
// diff, chart, arbitrary file, or an external link. "report"/"diff"/"chart"/"file" snapshot
// the given repo-local path into ${home}/artifacts/<id> at registration time (core's
// ArtifactStore) so it survives the source file changing/disappearing later, capped at
// 10MB (an oversize registration is REFUSED — nothing is written — with an
// agent-visible error); "link" stores the given url as a bare reference, no snapshot.
// This is also the registry the D12 workflow `artifact` gate (WorkflowGateSchema above)
// checks against: "does an artifact matching spec exist for this task".
// ArtifactKindSchema is defined earlier (before WorkflowGateSchema, which pins it in the
// artifact gate's spec.kind).
// Snapshot ids are single path components on every supported OS. Keep legacy
// alphanumeric ids valid while rejecting traversal in restored metadata too.
export const ArtifactIdSchema = z.string().regex(/^[A-Za-z0-9-]+$/, "invalid artifact id");
export const ArtifactRecordSchema = z.object({
  id: ArtifactIdSchema,
  kind: ArtifactKindSchema,
  label: z.string().min(1),
  // task/agent scoping (D13): agentId is the registering agent (stamped from
  // CHIMERA_AGENT_ID by the MCP tool, null for a direct/human call — mirrors
  // TaskRecord.pushedBy); taskId is auto-resolved server-side from whatever task that
  // agent was bound to AT REGISTRATION TIME (null if it wasn't bound to one).
  agentId: z.string().nullable(),
  taskId: z.string().nullable(),
  createdAt: z.number(),
  sizeBytes: z.number().int().min(0).nullable(),   // null for a "link" artifact
  path: z.string().nullable(),                     // the ORIGINAL source path (file kinds only; null for "link")
  url: z.string().nullable(),                      // "link" kind only; null otherwise
  // F16.1 Phase 2 (WF-4/G5): the task's step cursor AT the moment this artifact was
  // added — stamped server-side from the scheduler's live task binding (never
  // client-supplied). Absent when the caller had no bound task (untracked agent or a
  // direct/human call with no agentId), or against pre-existing records. Backs the
  // artifact gate's scope:"step" pin above.
  stepIndex: z.number().int().min(0).optional(),
}).strict();
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

// ---------- Changes & Evidence Review (FEATURE-10) ----------
// A read-only aggregation over data that ALREADY exists elsewhere (TaskRecord.stepHistory,
// ArtifactStore, git itself) — evidence.get never mutates anything. See core/src/evidence.ts
// for how `provenance`/`diff` are resolved: keyed on this repo's own `chimera/<worktreeKey>`
// branch-naming plus the task's own captured checkpoint (base commit + mainRepo). A landed
// task's diff is found by scanning main for the merge commit whose SECOND parent descends from
// that base — message-agnostic, since workers write arbitrary merge messages (REVIEW-ROOM-
// UNBOUND-TASKS); a legacy task with no checkpoint falls back to the `Merge branch '<branch>'`
// commit-message convention. There is no persisted per-diff field anywhere to read instead.
export const EvidenceStepSchema = z.object({
  stepIndex: z.number().int().min(0),
  stepId: z.string(),
  title: z.string().nullable(),
  agentId: z.string().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  outcome: z.enum(["passed", "failed", "retried"]).nullable(),
  reason: z.string().nullable(),
  handoffSummary: z.string().nullable(),
  // The step's STATIC gate definition (what would run), resolved from the pinned
  // WorkflowRecord — not captured output (a passing gate's stdout/stderr is discarded by
  // the scheduler today, see PLAN.md's "what's missing" section). null for a task with no
  // matching WorkflowStep (e.g. the pinned workflow version was since deleted).
  gate: z.object({ kind: z.string(), spec: z.record(z.string(), z.unknown()) }).nullable(),
}).strict();
export type EvidenceStep = z.infer<typeof EvidenceStepSchema>;

export const EvidenceFileChangeSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  insertions: z.number().int().min(0),
  deletions: z.number().int().min(0),
}).strict();
export type EvidenceFileChange = z.infer<typeof EvidenceFileChangeSchema>;

export const EvidenceDiffLineSchema = z.object({
  kind: z.enum(["context", "addition", "deletion", "meta"]),
  oldLine: z.number().int().positive().nullable(),
  newLine: z.number().int().positive().nullable(),
  text: z.string(),
}).strict();
export type EvidenceDiffLine = z.infer<typeof EvidenceDiffLineSchema>;

export const EvidenceHunkSchema = z.object({
  id: z.string().min(1), header: z.string(),
  oldStart: z.number().int().min(0), oldLines: z.number().int().min(0),
  newStart: z.number().int().min(0), newLines: z.number().int().min(0),
  lines: z.array(EvidenceDiffLineSchema),
}).strict();
export type EvidenceHunk = z.infer<typeof EvidenceHunkSchema>;

export const EvidenceFilePatchSchema = z.object({
  path: z.string().min(1), oldPath: z.string().min(1).nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  language: z.string().nullable(), binary: z.boolean(), truncated: z.boolean(),
  hunks: z.array(EvidenceHunkSchema),
}).strict();
export type EvidenceFilePatch = z.infer<typeof EvidenceFilePatchSchema>;

// discriminated on `available`: a `true` diff always has real git data; a `false` diff is a
// best-effort miss (worktree removed AND no matching merge commit found, or the recording
// agent's cwd is unknown) — never an error, always a human-readable `reason`.
export const EvidenceDiffSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    source: z.enum(["live", "merged"]),
    baseSha: z.string().min(1),
    headSha: z.string().min(1),
    mergeCommitSha: z.string().nullable(),
    files: z.array(EvidenceFileChangeSchema),
    patches: z.array(EvidenceFilePatchSchema).default([]),
    patchTruncated: z.boolean().default(false),
    statText: z.string(),
    truncated: z.boolean(),
    // live only: count of uncommitted files in the worktree at the moment this diff was
    // computed — their content IS included in `files`/`patches` above (the live diff covers
    // committed history since base PLUS whatever's currently uncommitted/untracked), this is
    // just a quick indicator. Null for a "merged" diff, or for a live diff superseded by a
    // later task's reuse of the same worktree (that worktree's current dirty state isn't ours).
    dirty: z.number().int().min(0).nullable(),
  }).strict(),
  z.object({ available: z.literal(false), reason: z.string() }).strict(),
]);
export type EvidenceDiff = z.infer<typeof EvidenceDiffSchema>;

export const EvidenceProvenanceEntrySchema = z.object({
  worktreeKey: z.string().min(1),
  branch: z.string().min(1),
  mainRepo: z.string().nullable(),
  agentIds: z.array(z.string()),
  diff: EvidenceDiffSchema,
}).strict();
export type EvidenceProvenanceEntry = z.infer<typeof EvidenceProvenanceEntrySchema>;

export const TaskEvidenceSchema = z.object({
  taskId: z.string().min(1),
  queue: z.string().min(1),
  state: TaskStateSchema,
  workflow: z.object({ name: z.string().min(1), version: z.number().int().positive() }).nullable(),
  steps: z.array(EvidenceStepSchema),
  artifacts: z.array(ArtifactRecordSchema),
  provenance: z.array(EvidenceProvenanceEntrySchema),
}).strict();
export type TaskEvidence = z.infer<typeof TaskEvidenceSchema>;

export const ReviewFindingSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1), path: z.string().min(1),
  hunkId: z.string().min(1).nullable(), parentId: z.string().min(1).nullable(),
  authorAgentId: z.string().min(1).nullable(), severity: z.enum(["note", "warning", "blocking"]),
  body: z.string().min(1), status: z.enum(["open", "resolved"]),
  createdAt: z.number(), updatedAt: z.number(),
  // F25.QA F4: who cleared it — null for a still-open finding, the operator, or a pre-change
  // record loaded from disk (the default keeps an old reviews.json line parseable).
  resolvedBy: z.string().min(1).nullable().default(null),
}).strict();
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export const ReviewDecisionSchema = z.object({
  status: z.enum(["accepted", "changes_requested"]), actorAgentId: z.string().min(1).nullable(),
  summary: z.string(), revision: z.number().int().positive(), decidedAt: z.number(),
}).strict();
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;
export const ReviewSessionSchema = z.object({
  taskId: z.string().min(1), findings: z.array(ReviewFindingSchema), decision: ReviewDecisionSchema.nullable(),
  revision: z.number().int().min(0), updatedAt: z.number(),
}).strict();
export type ReviewSession = z.infer<typeof ReviewSessionSchema>;

// ---------- scheduled actions / jobs (D10, coverage C12) ----------
// A JOB is a persistent, cron/interval/one-shot schedule that either pushes a task into
// a team's queue or spawns a standalone agent, on a timer the daemon itself arms
// (core's JobScheduler, ${home}/jobs.json) — no polling loop. Persisted as STATE (not
// config) so a daemon restart recovers next-run times unchanged (no drift, no
// double-fire); a bad schedule is rejected at job.create/update time, never persisted.
export const JobCronSchema = z.object({ cron: z.string().min(1) }).strict();
export const JobEverySchema = z.object({
  every: z.object({ unit: z.enum(["seconds", "minutes", "hours", "days"]), n: z.number().int().positive() }).strict(),
}).strict();
export const JobAtSchema = z.object({ at: z.number().int().positive() }).strict();   // one-shot epoch-ms
// JOB-WATCH: a job with NO clock. The command is started ONCE and supervised — it stays alive and
// its output is read as it arrives, so a long-running monitor (tail -F, a log follower, a `kubectl
// get -w`) can drive the fleet without an agent burning turns polling it. Restarted with backoff
// if it exits. `nextRun` is null for these: there is no next time, only "is it up".
export const JobWatchSchema = z.object({ watch: z.literal(true) }).strict();
export const JobScheduleSchema = z.union([JobCronSchema, JobEverySchema, JobAtSchema, JobWatchSchema]);
export type JobSchedule = z.infer<typeof JobScheduleSchema>;

export const JobOverlapPolicySchema = z.enum(["skip", "queue"]);
export type JobOverlapPolicy = z.infer<typeof JobOverlapPolicySchema>;

// A job's agent target omits `prompt` — the job's own top-level `prompt` supplies it at
// spawn time (mirrors RoleSpecSchema's identical omission for a team role).
export const JobAgentTargetSchema = AgentSpecSchema.omit({ prompt: true });

// JOB-OUTPUT-TRIGGER: what a command job dispatches to when its output says something worth acting
// on. Deliberately the SAME three agent-bearing shapes a job target already accepts, so "who runs
// this" means one thing across the whole job surface rather than two similar-but-different unions.
export const JobDispatchSchema = z.union([
  z.object({ team: z.string().min(1), role: z.string().min(1).optional() }).strict(),
  z.object({ agentSpec: JobAgentTargetSchema }).strict(),
  RoleBindingSchema,
]);
export type JobDispatch = z.infer<typeof JobDispatchSchema>;

// WHEN the output is worth acting on. One of these, never several: a condition that could be read
// two ways is one an operator will read the wrong way at 3am.
export const JobTriggerWhenSchema = z.union([
  // A JS regex over the output (or, for a watch job, over the single line). Capture groups are
  // available to the prompt as {{1}}, {{2}}, … and named groups as {{name}}.
  z.object({ matches: z.string().min(1), flags: z.string().max(8).optional() }).strict(),
  z.object({ contains: z.string().min(1) }).strict(),
  // Exit code. Scheduled commands only — a watch process has no exit code until it dies.
  z.object({ exitCode: z.number().int() }).strict(),
  // Fires only when the output DIFFERS from the previous run's. The condition for "tell me when
  // something changed", which a plain match cannot express without the agent re-deriving it.
  z.object({ changed: z.literal(true) }).strict(),
  z.object({ always: z.literal(true) }).strict(),
]);
export type JobTriggerWhen = z.infer<typeof JobTriggerWhenSchema>;

export const JobTriggerSchema = z.object({
  when: JobTriggerWhenSchema,
  dispatch: JobDispatchSchema,
  // The prompt the triggered agent receives. Placeholders are substituted from the run that fired
  // it — {{output}} (whole captured output, or the matching line for a watch job), {{line}},
  // {{exitCode}}, {{match}} (the matched text), {{1}}…{{9}} and {{name}} for regex capture groups,
  // {{job}}, {{ts}}. An unknown placeholder is left AS WRITTEN rather than replaced with an empty
  // string: a prompt that silently loses the value it was built around is worse than one that
  // visibly still has a {{typo}} in it.
  prompt: z.string().min(1),
  // Ceiling for the spawned agent's tree, exactly as JobSpec.maxBudgetUsd is for a scheduled spawn.
  maxBudgetUsd: z.number().positive().nullable().default(null),
  // A watch process that emits a matching line every second must not spawn an agent every second.
  // The default is not "no limit" for that reason.
  minIntervalMs: z.number().int().min(0).max(24 * 60 * 60_000).default(60_000),
}).strict();
export type JobTrigger = z.infer<typeof JobTriggerSchema>;
export const JobTargetSchema = z.union([
  // Fixed Chimera identity; enqueue a prompt, resume if paused, never create a replacement.
  z.object({ existingAgentId: z.string().min(1), maxPendingMessages: z.number().int().min(1).max(1000).optional() }).strict(),
  // JOB-ROLE-TARGET GAP A: `role` optionally pins WHICH of the team's role keys the
  // pushed task routes to (queues.ts TaskPush.role -> scheduler.ts routingRoleFor) — a
  // job no longer needs its own dedicated team just to land on a specific role. Absent
  // (every job persisted before this) behaves exactly as before: the queue resolves its
  // own default role, byte-identical.
  z.object({ team: z.string().min(1), role: z.string().min(1).optional() }).strict(),
  z.object({ agentSpec: JobAgentTargetSchema }).strict(),
  // JOB-ROLE-TARGET GAP B: spawn directly off a GLOBAL role-library entry (RoleStore /
  // resolveRole, ROLES-UNIFY §4) — no team, no queue needed just to pin a role. Reuses
  // RoleBindingSchema verbatim (not a redeclared {role, overrides} shape) so a job's role
  // reference is structurally identical to a team's role-slot binding; core dispatches it
  // through the SAME resolveRole merge a team role slot uses, never a second merge path.
  RoleBindingSchema,
  // JOB-COMMAND-TARGET: a scheduled job with NO agent — a plain shell command the daemon runs on
  // the same cron/every/at schedules, with the same overlap policy, failure counting and
  // auto-disable-after-3 every other target gets. The recurring operational chores around a fleet
  // (renewing a cloud login, pruning worktrees, rotating a log) do not need a model to read their
  // output; spending an agent turn on them buys nothing and costs tokens.
  //
  // Unlike every other variant this one is SYNCHRONOUS: it starts nothing and waits for nothing
  // external — it runs to completion and settles its own run entry.
  z.object({
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    // Merged OVER the daemon's own environment, never replacing it — a scheduled command that
    // lost PATH would fail in a way that looks like the command is missing.
    //
    // SECURITY (env-injection): these values are PERSISTED IN CLEARTEXT to jobs.json and returned
    // by job_status to anyone who may read the job. Reference the daemon's existing environment
    // (`$AWS_PROFILE`, a credential file, a keychain lookup inside the command) rather than
    // embedding a secret here. What chimera does guarantee is that a value put here is redacted
    // out of the run's captured output and error text before either is stored or shown — see
    // jobs.ts — so a command echoing its own environment cannot leak it into the run history.
    //
    // These land in the child's environment, so they can also change how the command resolves and
    // loads (PATH, LD_PRELOAD, NODE_OPTIONS). That is not a new capability: the `command` beside
    // this field is already arbitrary shell, so anything reachable by injecting an env var is
    // reachable by writing it in the command. The exposure that matters is the one above.
    env: z.record(z.string(), z.string()).optional(),
    // A command with no timeout that never exits holds the job's in-flight slot forever, and
    // under the default "skip" overlap policy that silences the job permanently. Bounded by
    // default for exactly that reason.
    timeoutMs: z.number().int().positive().max(6 * 60 * 60_000).default(10 * 60_000),
    // JOB-OUTPUT-TRIGGER: the command stops being a dead end. Without this, a command job can
    // detect something and then do nothing about it — the operator has to be watching, or an agent
    // has to poll on a schedule, which is the cost this whole target existed to avoid. With it, the
    // cheap thing (a shell command) does the watching and the expensive thing (an agent) is woken
    // only when there is something to act on.
    //
    // Absent ⇒ byte-identical to before: run, record, done.
    trigger: JobTriggerSchema.optional(),
    // JOB-WATCH: with `schedule: {watch:true}` the process is started once and SUPERVISED rather
    // than run to completion — `timeoutMs` does not apply, output is read line by line as it
    // arrives, and each line is evaluated against `trigger.when`. Restarted with backoff if it
    // exits, because a monitor that quietly died is indistinguishable from one reporting nothing.
    restartBackoffMs: z.number().int().min(1000).max(60 * 60_000).default(5_000),
  }).strict(),
]);
export type JobTarget = z.infer<typeof JobTargetSchema>;

export const JobSpecSchema = z.object({
  name: CoordName,
  // Automatic runs wait until this timestamp; Run now remains an explicit override.
  snoozedUntil: z.number().int().nonnegative().nullable().optional(),
  // Opt-in so existing prompts containing literal {{...}} remain byte-identical.
  promptTemplate: z.boolean().optional(),
  schedule: JobScheduleSchema,
  tz: z.string().min(1).default("UTC"),          // IANA zone; applies to `cron` only (`every`/`at` are zone-agnostic)
  target: JobTargetSchema,
  // JOB-COMMAND-TARGET: optional at the SCHEMA level, required per-target in jobs.ts's
  // validateTarget — a command job has nothing to prompt. Kept as a plain object field (rather
  // than a schema-level refinement) because JobRecordSchema extends this, and a refined schema
  // is no longer extendable.
  prompt: z.string().min(1).optional(),
  overlapPolicy: JobOverlapPolicySchema.default("skip"),
  maxBudgetUsd: z.number().positive().nullable().default(null),   // maps to the spawn's tree budget (spec §7)
  enabled: z.boolean().default(true),
  // Opts into an at-most-one catch-up run for a schedule missed while the daemon was
  // down. Default (false): every missed run is SKIPPED and the schedule resumes from
  // the next future occurrence.
  catchUp: z.boolean().default(false),
  // F05: the SAME RetryPolicySchema queues and workflow steps already use, consumed through the
  // SAME computeRetryDelayMs — one backoff formula in this repo, not two. Absent ⇒ byte-identical
  // to today: three consecutive failures stop the job (see DEFAULT_JOB_MAX_ATTEMPTS in jobs.ts)
  // and NO delayed re-fire is ever armed. `retryableClasses` is NOT consulted on the job path — a
  // job failure has no reliable ErrorClassName, the same reason the workflow-step path skips it
  // too. Classifying job failures is F08's disposition, not this field's.
  retryPolicy: RetryPolicySchema.optional(),
  // F04 (folds the catalog's F03): a bound on HOW LATE a missed occurrence may be and still be
  // caught up. Only consulted when `catchUp` is true; null (the default) is today's unbounded
  // behaviour, so every persisted job parses and behaves unchanged. Measured against the
  // OCCURRENCE's own age (now - nominalFireTs), not against daemon downtime: the operator's
  // question is "is this 03:00 report still worth sending at 08:37?" (yes) versus "after a
  // two-week holiday?" (no) — a bound on downtime would answer neither.
  catchUpMaxStalenessMs: z.number().int().positive().nullable().default(null),
}).strict();
export type JobSpec = z.infer<typeof JobSpecSchema>;

// JOB-WATCH: live process state, present ONLY on a watch job. Not persisted — it describes what is
// running right now, and a stale "running: true" read back from disk after a crash would be a lie.
export const JobWatchStateSchema = z.object({
  running: z.boolean(),
  pid: z.number().int().nullable(),
}).strict();

export const JobRunResultSchema = z.enum(["ok", "failed", "skipped"]);
export type JobRunResult = z.infer<typeof JobRunResultSchema>;

export const JobRunEntrySchema = z.object({
  ts: z.number(),
  // F01(c): "sleep-wake" is a SCHEDULED run that was late, not a missed one — the fire path
  // classifies it when the served occurrence is more than lateFireThresholdMs in the past
  // (jobs.ts classifyFire). launchd's own StartCalendarInterval contract is the precedent:
  // "launchd will start the job the next time the computer wakes up… multiple intervals …
  // coalesced into one event" (launchd.plist(5), read 2026-09-02).
  trigger: z.enum(["scheduled", "manual", "catchup", "sleep-wake"]),
  result: JobRunResultSchema,
  agentId: z.string().nullable().default(null),
  taskId: z.string().nullable().default(null),
  costUsd: z.number().default(0),
  error: z.string().nullable().default(null),
  // JOB-COMMAND-TARGET: what a shell run actually produces. Without these a failed command job
  // reports "failed" and nothing else, which is not enough to act on — the exit code and the tail
  // of its output ARE the result. Null for every agent/team/role run, which produce neither.
  exitCode: z.number().int().nullable().default(null),
  output: z.string().nullable().default(null),
  // F01(c): how late this run was, in ms (firedAt - the occurrence it serves). NULL — not 0 —
  // for every punctual/manual/catchup run, so "we did not measure" is distinguishable from
  // "it was on time". Only ever set alongside trigger "sleep-wake".
  latenessMs: z.number().nullable().default(null),
  // F01(c): how many FURTHER occurrences of this job elapsed inside the same gap and were folded
  // into this one fire (advanceOccurrence().missed [F02]). 0 means "late, but only one slot was
  // missed"; null means not measured.
  coalescedOccurrences: z.number().int().min(0).nullable().default(null),
  // F04: WHY this entry has the result it has, when the result alone is not enough to act on.
  // "duplicate-occurrence" | "stale-beyond-window" | "overlap" | "missed-restart" |
  // "daemon-crash" | "daemon-crash-prespawn" | "start-failed". null for an ordinary ok/failed run
  // and for every entry written before F04.
  reason: z.string().nullable().default(null),
  // F04: the schedule grid slot this entry SERVES — the second component of the occurrence key
  // {jobId, nominalFireTs, attempt}. null for a manual run that served no slot (see
  // nominalFireTsFor). These entries ARE the durable occurrence ledger: the dedupe window is
  // exactly the last JOB_LAST_RUNS_CAP (below) runs, so no second store and no second pruning
  // discipline exists.
  nominalFireTs: z.number().nullable().default(null),
  // F04.QA-B: WHICH attempt at that slot this entry is — the third component of the occurrence
  // key, and the reason a retry is not a duplicate. Without it the ledger is result-blind: a
  // FAILED run stamps its slot and the slot is then refused for the whole JOB_LAST_RUNS_CAP
  // horizon, so F05's backoff re-fire could never be admitted. Defaulted so a jobs.json written
  // before this reads as attempt 0 (the first, and until F05 the only, attempt).
  attempt: z.number().int().min(0).default(0),
}).strict();
export type JobRunEntry = z.infer<typeof JobRunEntrySchema>;

export const JOB_LAST_RUNS_CAP = 20;

// F04: the DURABLE claim on one occurrence, written to jobs.json BEFORE the target's side effect
// starts and cleared when the run settles. Its presence at boot means "the daemon died between
// spawn and completion" — the case that used to be invisible. Mirrors the shape already proven
// for workflow steps (TaskStepCheckpointSchema.idempotencyKey): a deterministic string key plus
// enough context to recognise what it refers to. Deliberately a SEPARATE namespace from the step
// key ("job:" vs "<taskId>:step-") — two subsystems, one shape, no shared mutable state.
export const JobInFlightSchema = z.object({
  idempotencyKey: z.string().min(1),                       // `job:${name}:${nominalFireTs}#${attempt}`
  nominalFireTs: z.number().nullable(),                    // null for an out-of-band manual run
  // F04.QA-B: the attempt component of the key this claim holds — see JobRunEntry.attempt.
  attempt: z.number().int().min(0).default(0),
  trigger: z.enum(["scheduled", "manual", "catchup", "sleep-wake"]),
  startedAt: z.number(),
  // "starting" is the state between the durable claim and the spawn returning — the window a
  // crash used to make invisible, and the window a concurrent fire used to slip through.
  kind: z.enum(["starting", "agent", "task", "command", "message"]),
  agentId: z.string().nullable().default(null),
  taskId: z.string().nullable().default(null),
  // F04.QA-A: reconcileBoot re-adopted this still-live run after a daemon restart. The fact lives
  // on the DURABLE record, not only on the job_run_started event, so a client that connects after
  // the restart with no event backlog can still tell "re-adopted" from "started normally".
  // Defaulted so a jobs.json written before this reads as a normal start.
  readopted: z.boolean().default(false),
}).strict();
export type JobInFlight = z.infer<typeof JobInFlightSchema>;

// F05: WHY a job stopped, in the job's own record — the answer to "why is my 03:00 job off" at
// 08:00, when the 60s-throttled job-failed toast is long gone. ONE field carries both live
// states, the way a task carries one `state` rather than a pair of booleans:
//   failure === null              → healthy
//   failure.deadLetterAt === null → a retry chain is in flight (attempt `consecutiveFailures`)
//   failure.deadLetterAt !== null → dead-lettered; the job is stopped (enabled:false)
export const JOB_FAILURE_REASONS_CAP = 5;
export const JobFailureStateSchema = z.object({
  // The grid occurrence this whole retry chain serves (null for a manual/catch-up run, which
  // serves no slot). LOAD-BEARING as of F05.QA-FIX: the backoff re-fire is dispatched with THIS
  // as its nominalFireTs, so every attempt of a chain keys the same F04 occurrence
  // (`job:<name>:<nominalRunTs>#<attempt>`) instead of inventing a fresh one at the backoff
  // instant — which is what stops a retry from re-phasing an `every` schedule.
  nominalRunTs: z.number().nullable().default(null),
  // F05.QA-FIX: WHEN the next attempt of this chain fires. Deliberately NOT nextRunTs: that field
  // is the schedule GRID and only advanceSchedule moves it. Folding the two together made a retry
  // a new occurrence at a drifted slot (an 02:00 `every` job resumed at 03:05 and stayed there)
  // and hid the grid slot the chain swallowed. The scheduler arms at min(nextRunTs, retryAt).
  // null = no attempt pending (healthy, dead-lettered, or a no-retryPolicy "wait").
  retryAt: z.number().nullable().default(null),
  // Newest LAST, capped at JOB_FAILURE_REASONS_CAP. `error` is deliberately NOT length-capped at
  // the schema level: JobRecordSchema.parse runs on every jobs.json load and a z.string().max()
  // rejection there would trip the corrupt-file throw — the whole daemon refusing to boot over an
  // observability string. jobs.ts truncates at the WRITE site instead (JOB_FAILURE_REASON_MAX).
  reasons: z.array(z.object({ ts: z.number(), error: z.string() }).strict()).default([]),
  deadLetterAt: z.number().nullable().default(null),
}).strict();
export type JobFailureState = z.infer<typeof JobFailureStateSchema>;

export const JobRecordSchema = JobSpecSchema.extend({
  createdAt: z.number(),
  nextRunTs: z.number().nullable().default(null),
  lastRuns: z.array(JobRunEntrySchema).default([]),
  consecutiveFailures: z.number().int().min(0).default(0),
  disabledReason: z.string().nullable().default(null),
  failure: JobFailureStateSchema.nullable().default(null),
  // JOB-UPDATE-DELIVERTO-GUARD (postmortem chimera/slack, 20-08-2026): stamped the moment a
  // job.update patch DELIBERATELY removes a deliverTo the job used to have (see
  // JobUpdateParams.patch.dropDeliverTo below) — never set for a job that never had one
  // (that's the ordinary, non-noisy "no delivery needed" case, e.g. a janitor job). Cleared
  // back to null the moment the job's target carries a deliverTo again. This is the narrow,
  // unambiguous "used to deliver, now doesn't" signal job_status/the app/tui surface — NOT a
  // general "has no deliverTo" warning, which would fire on every legitimate no-delivery job.
  deliveryDroppedAt: z.number().nullable().default(null),
  // JOB-WATCH: present only for a watch job, and only on a LIVE read (job.status/job.list) — it is
  // stripped before persisting, because "running: true" restored from disk after a crash would
  // assert a process that is not there.
  watch: JobWatchStateSchema.nullish(),
  // F04: non-null ⇒ a run is in flight right now, or WAS when the daemon died. reconcileBoot
  // re-adopts it if its agent/task is still alive and records a "daemon-crash" run if not.
  // Unlike `watch` (deliberately stripped before persisting) this one IS persisted — that is
  // the whole point.
  inFlight: JobInFlightSchema.nullable().default(null),
}).strict();
export type JobRecord = z.infer<typeof JobRecordSchema>;

// F01(a): the honest answer to "will this schedule actually be kept while the Mac sleeps".
// Returned by job.status ALONGSIDE the JobRecord and never merged into it — a JobRecord describes
// one job, this describes one machine. `available:false` is the DEFAULT state of every install:
// slice (a) is opt-in and the operator may never run it. Both surfaces must render the degraded
// case rather than implying the schedule is exact.
/** F01-QA-3: the ONE spelling of the operator's opt-in step. It lives here, not in core, because
 *  every surface that must print it verbatim reaches protocol and only the daemon reaches core:
 *  core/wake.ts publishes it as `setupHint`, and the app renders it as the copyable fallback for a
 *  daemon too old to send one. Three hand-typed copies had already drifted apart once. */
export const WAKE_SETUP_HINT = "./scripts/install.sh --enable-wake";

export const WakeSchedulingSchema = z.object({
  available: z.boolean(),
  platform: z.string(),                                    // process.platform
  reason: z.string().nullable().default(null),             // why not, when unavailable
  setupHint: z.string().nullable().default(null),          // WAKE_SETUP_HINT, or null on a platform with no path to it
  scheduledFor: z.number().nullable().default(null),       // epoch ms of the one outstanding wake
  holdingAwake: z.boolean().default(false),                // F01(b): an assertion is held right now
}).strict();
export type WakeScheduling = z.infer<typeof WakeSchedulingSchema>;

// job.update {name, patch} — a sparse merge-patch over the mutable subset of a JobSpec.
// A `schedule`/`tz` change recomputes nextRunTs from now; `enabled: true` on a
// failure-disabled job resets consecutiveFailures/disabledReason (the "space" re-arm
// the UI drives — D10 emits job_disabled, W15 wires the key to this RPC).
export const JobUpdateParams = z.object({
  name: z.string().min(1),
  patch: z.object({
    snoozedUntil: z.number().int().nonnegative().nullable().optional(),
    promptTemplate: z.boolean().optional(),
    schedule: JobScheduleSchema.optional(),
    tz: z.string().min(1).optional(),
    target: JobTargetSchema.optional(),
    prompt: z.string().min(1).optional(),
    overlapPolicy: JobOverlapPolicySchema.optional(),
    maxBudgetUsd: z.number().positive().nullable().optional(),
    enabled: z.boolean().optional(),
    catchUp: z.boolean().optional(),
    catchUpMaxStalenessMs: z.number().int().positive().nullable().optional(),
    // F05: nullable, unlike every sibling: `null` REMOVES the policy (JobSpec.retryPolicy is
    // optional), `undefined` leaves it alone. Without the null case an operator could add a
    // policy but never take one off without deleting and recreating the job.
    retryPolicy: RetryPolicySchema.nullable().optional(),
    // JOB-UPDATE-DELIVERTO-GUARD: `target` is a discriminated-union WHOLE-OBJECT replace,
    // never deep-merged (see JobTargetSchema's own comment) — a patch that restates `target`
    // for an unrelated reason (schedule/budget/etc, exactly what triggered the postmortem)
    // silently drops `overrides.deliverTo`/`agentSpec.deliverTo` while the job keeps running
    // and billing with nowhere to deliver, and NOTHING about a successful run says so.
    // jobs.ts's update() now REJECTS a target patch that would drop an existing deliverTo
    // unless this is explicitly true — an honest, discoverable "I mean it" rather than ever
    // guessing intent or silently deep-merging a genuinely ambiguous union shape.
    dropDeliverTo: z.boolean().optional(),
  }).strict(),
}).strict();
export type JobUpdateParams = z.infer<typeof JobUpdateParams>;

// ---------- usage ledger (D15, coverage §C17, F19) ----------
// One row per result/turn, appended to `${home}/usage/usage.jsonl` (monthly rotation —
// sealed months rename to `usage.<YYYY-MM>.jsonl`, mirroring EventLog's seal-on-rotate
// discipline). `team`/`job` are null when the producing agent had no team membership /
// wasn't a job run (plain agent.spawn). costUsd is 0 for codex rows (no per-token
// pricing wired yet) — tokens are still recorded so usage.query totals aren't silently
// dropped for that provider.
// TOKEN-OPT-P0-1: usage carries TWO distinct scopes that must never be conflated again — a
// row that pairs a whole-run cost with a last-request token snapshot silently undercounts
// cache-read by however many turns the run actually made (measured ~71x on a long session).
//   billableUsage — CUMULATIVE for the whole run; the SAME totals costUsd was computed
//     over (billableUsage × pricing reproduces costUsd within rounding tolerance).
//   contextUsage  — the LAST request/turn only; the scope the ctx-window meter needs
//     (cumulative cache-read grows unbounded across a long session and would read far past
//     the context window if used there — see claude.ts's CTX-BASIS-PERTURN).
// Both required (not .optional()) — a row that can only supply one scope isn't a valid usage
// row. UsageLedger.onEvent parses through UsageRowSchema before appending (safeParse — a
// malformed row is dropped, never crash-loops the daemon over observability data), and
// readRows' per-line parse means an OLD single-`usage`-field row (pre-split ledger segment)
// no longer parses — it's silently skipped like any other corrupt line, never misread as
// one scope or the other.
export const UsageScopeSchema = z.object({
  input: z.number(), output: z.number(),
  cacheRead: z.number().default(0), cacheCreation: z.number().default(0),
}).strict();
export type UsageScope = z.infer<typeof UsageScopeSchema>;

export const UsageRowSchema = z.object({
  ts: z.number(),
  agent: z.string().min(1),
  team: z.string().nullable().default(null),
  job: z.string().nullable().default(null),
  account: z.string().min(1),
  provider: z.string().min(1).default("unknown"),
  model: z.string().min(1),
  billableUsage: UsageScopeSchema,
  contextUsage: UsageScopeSchema,
  costUsd: z.number(),
}).strict();
export type UsageRow = z.infer<typeof UsageRowSchema>;

// F11 (durable step journal): ONE append-only row. Two rows exist per step attempt —
// phase:"open" written when the attempt starts, phase:"close" when its gate is evaluated —
// sharing an entryId. An entryId with only an "open" row is a crash-mid-step, exactly the
// diagnostic queues.ts's closeDanglingStep deliberately preserves in stepHistory today.
//
// WHY the file and not TaskRecord.stepHistory: QueueStore.prune() evicts terminal tasks past
// MAX_TERMINAL_PER_QUEUE=200 oldest-first and takes their whole history with them. stepHistory
// stays as-is and stays the live-task source; this outlives the prune.
//
// costUsd/usage are CUMULATIVE AGENT COUNTERS AT THIS ROW'S MOMENT, not per-step deltas —
// the delta is the reader's subtraction (foldRows). A writer-side delta would need an
// in-memory baseline a restart mid-step silently zeroes.
//
// NOTHING here carries prompt text: inputDigest is a one-way truncated sha256 and `reason`
// (capped at 500) is the only free-text field, so the journal can never become a prompt store.
export const StepJournalRowSchema = z.object({
  entryId: z.string().min(1),
  ts: z.number(),                                   // when THIS ROW was appended
  phase: z.enum(["open", "close"]),
  source: z.enum(["live", "backfill"]).default("live"),
  taskId: z.string().min(1),
  queue: z.string().min(1),
  stepIndex: z.number().int().min(0),
  stepId: z.string().min(1),
  attempt: z.number().int().min(0),
  agentId: z.string().nullable(),
  model: z.string().nullable(),                     // actualModel ?? spec.model; never "default"
  account: z.string().nullable(),
  provider: z.string().nullable(),
  team: z.string().nullable(),
  inputDigest: z.string().regex(/^sha256:[0-9a-f]{32}$/).nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable().default(null),     // close rows only
  outcome: z.enum(["passed", "failed", "retried"]).nullable().default(null),
  reason: z.string().max(500).nullable().default(null),
  costUsdCumulative: z.number().nullable(),         // AgentRecord.costUsd at this row's moment
  usageCumulative: UsageScopeSchema.nullable(),     // AgentRecord.billableTokens, same moment
}).strict();
export type StepJournalRow = z.infer<typeof StepJournalRowSchema>;

// F11: the FOLDED view — one object per step attempt, what every reader (and F13) consumes.
// costUsd/usage are this attempt's DELTAS (close minus open, clamped at >= 0); null when the
// open row's counters are unknown (a backfilled entry, or an agent gone before it was read).
export const StepJournalEntrySchema = z.object({
  entryId: z.string().min(1),
  source: z.enum(["live", "backfill"]),
  taskId: z.string().min(1),
  queue: z.string().min(1),
  stepIndex: z.number().int().min(0),
  stepId: z.string().min(1),
  attempt: z.number().int().min(0),
  agentId: z.string().nullable(),
  model: z.string().nullable(),
  account: z.string().nullable(),
  provider: z.string().nullable(),
  team: z.string().nullable(),
  inputDigest: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  durationMs: z.number().nullable(),                // endedAt - startedAt; null while open
  outcome: z.enum(["passed", "failed", "retried"]).nullable(),
  reason: z.string().nullable(),
  costUsd: z.number().nullable(),
  usage: UsageScopeSchema.nullable(),
  // true when no close row exists: the daemon died mid-step, or the step is in flight NOW.
  open: z.boolean(),
}).strict();
export type StepJournalEntry = z.infer<typeof StepJournalEntrySchema>;

export const UsageGroupBySchema = z.enum(["team", "agent", "account", "provider", "model", "job"]);
export type UsageGroupBy = z.infer<typeof UsageGroupBySchema>;

// usage.query {from, to, groupBy, bucket?} aggregates DAEMON-SIDE over the ledger — the
// UI (W21) never sums rows itself, so every number on the usage card traces back to one
// response (the "no drift" rule). `bucket:"day"` buckets rows into LOCAL calendar days
// (local-midnight rollover, same convention UsageLedger.todayUsd() uses — not UTC)
// alongside the groupBy split.
// JOB-FLEET-GROUPING: from/to are epoch MILLISECONDS (matches UsageLedger row.ts, itself
// Date.now()-stamped) — a second-precision range isn't rejected, it just silently matches
// zero rows (row.ts >= from is false for basically everything). No runtime guard added
// (a plausible-looking ms value and a plausible-looking s value overlap for some ranges,
// so a heuristic reject would sometimes be wrong); documenting the unit here is the fix.
export const UsageQueryParams = z.object({
  from: z.number(),
  to: z.number(),
  groupBy: UsageGroupBySchema,
  bucket: z.literal("day").optional(),
}).strict();
export type UsageQueryParams = z.infer<typeof UsageQueryParams>;

// TOKEN-OPT-P4: cacheReadTokens/cacheCreationTokens surface the prompt-cache split
// per group (e.g. groupBy:"agent") — a cache-read-heavy agent is riding the ~90%-off
// cached prefix; an agent whose cacheCreationTokens keeps climbing turn over turn is
// silently busting the cache (see claude.ts's stable systemPrompt/mcpServers guard).
// TOKEN-OPT-P0-1: every figure here is summed from each row's billableUsage (the
// cost-scope, cumulative-per-run field) — contextUsage (last-turn-only) is a live/UI
// concern (the agent view's ctx meter), not a historical-query aggregate; summing "last
// turn of run A" + "last turn of run B" across independent runs isn't a coherent number.
export type UsageQueryGroup = {
  key: string; costUsd: number; tokensIn: number; tokensOut: number;
  cacheReadTokens: number; cacheCreationTokens: number; count: number;
};
export type UsageQueryDayBucket = {
  day: string; costUsd: number; tokensIn: number; tokensOut: number;
  cacheReadTokens: number; cacheCreationTokens: number; count: number;
};
export type UsageQueryResult = {
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  count: number;
  groups: UsageQueryGroup[];
  buckets?: UsageQueryDayBucket[];   // present only when bucket:"day" was requested
};

// ---------- FEATURE-7 (OTel GenAI tracing + SLI rollup + redaction) ----------
// sli.rollup aggregates the daemon's in-memory span store (packages/core/src/otel.ts) per
// task, with a per-step breakdown — LOCAL-ONLY (absent from PEER_METHODS, mirrors usage.query:
// each engine's own trace data, no federated rollup in scope). Filtering by `workflow` selects
// which tasks are included (not a separate cross-task aggregate row — see PLAN.md's follow-ups).
export const SliRollupParamsSchema = z.object({
  taskId: z.string().min(1).optional(),
  workflow: z.string().min(1).optional(),
  from: z.number().optional(),   // inclusive span-start-time lower bound (ms epoch)
  to: z.number().optional(),     // inclusive span-start-time upper bound (ms epoch)
  bucketMs: z.number().int().positive().optional(),
  groupBy: z.enum(["team", "provider", "workflow"]).optional(),
}).strict();
export type SliRollupParams = z.infer<typeof SliRollupParamsSchema>;

export type SliStepSummary = {
  stepIndex: number; stepId: string | null;
  durationMs: number; tokensIn: number; tokensOut: number; costUsd: number;
  gatePasses: number; gateFailures: number; turnCount: number; errorCount: number; errorRate: number;
};
export type SliTaskSummary = {
  taskId: string; workflow: string | null; version: number | null;
  startedAt: number; endedAt: number | null; activeAgeMs: number | null;
  agentIds: string[]; team: string | null; provider: string | null; queue: string | null;
  durationMs: number | null;   // null while the task's root span is still open (not yet terminal)
  tokensIn: number; tokensOut: number; costUsd: number;
  gatePasses: number; gateFailures: number; turnCount: number; errorCount: number;
  errorRate: number;   // errorCount / turnCount, 0 when turnCount is 0
  steps: SliStepSummary[];
};
export type SliBucketSummary = {
  from: number; to: number; completedTasks: number; activeTasks: number;
  durationMs: number; latencySamples: number; tokensIn: number; tokensOut: number; costUsd: number;
  gatePasses: number; gateFailures: number; turnCount: number; errorCount: number;
};
export type SliBreakdownSummary = {
  key: string; taskCount: number; completedTasks: number; activeTasks: number;
  p50DurationMs: number | null; p95DurationMs: number | null;
  tokensIn: number; tokensOut: number; costUsd: number;
  gatePasses: number; gateFailures: number; turnCount: number; errorCount: number;
};
// F12 (span-store-replay-on-startup): what the in-memory span store was rebuilt FROM after a
// daemon restart. Present so a rollup can never silently imply a window it did not read —
// `truncated` means the replay bound stopped short of the oldest retained event, and anything
// older than `fromSeq`/`fromTs` is absent by construction, not silently missing.
export type SliRollupCoverage = {
  replayed: boolean; events: number; spans: number;
  fromSeq: number | null; fromTs: number | null; truncated: boolean;
};
export type SliRollupResult = {
  tasks: SliTaskSummary[];
  buckets: SliBucketSummary[];
  breakdown: SliBreakdownSummary[];
  totals: {
    durationMs: number; tokensIn: number; tokensOut: number; costUsd: number;
    gatePasses: number; gateFailures: number; turnCount: number; errorCount: number; errorRate: number;
    completedTasks: number; activeTasks: number; latencySamples: number;
    p50DurationMs: number | null; p95DurationMs: number | null;
  };
  coverage?: SliRollupCoverage;
};

// ---------- history.runs (F13, unified run history) ----------
// A "run" is one paid unit of work: an agent, the task that dispatched it, or the job that
// fired it. All three can describe the SAME dollar — the cost-triple-counting invariant this
// whole feature exists to prevent is `costBasis`: only "booked" rows (agents, whose costUsd IS
// the supervisor-metered figure) are summed into totals.costUsd; "rolled-up" rows (tasks/jobs,
// whose costUsd is a display-only sum over other rows' booked dollars) are shown but never
// re-added.
export const RunKindSchema = z.enum(["agent", "task", "job"]);
export type RunKind = z.infer<typeof RunKindSchema>;

// One six-value vocabulary across agent/task/job state so a caller filters once. Mapping:
//   agent: running->running, paused->running, done->done, failed->failed, killed->killed
//   task:  pending->pending, in_progress->running, done->done, failed->failed,
//          dead_letter->failed, blocked->running (unrecognised default)
//   job run entry: ok->done, failed->failed, skipped->skipped
// killed stays distinct from failed (an operator kill is not a task failure); an unrecognised
// state never throws — it maps to "running" for an agent/task row and "done" for a job row.
export const RunOutcomeSchema = z.enum(["done", "failed", "killed", "running", "pending", "skipped"]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

// Precedence chain for "why did this run happen", never a guessed/fabricated answer —
// {kind:"unknown", ref:null, detail:null} is a valid, expected result when nothing upstream
// explains a run.
// "schedule" vs "job" is the F13.QA M-1 distinction and it is NOT cosmetic: a `job` row IS the
// scheduled firing, so its own trigger carries WHY the scheduler fired it (detail) — while an
// agent/task that a job merely dispatched is triggered BY that job ({kind:"job", ref:<name>}).
// `detail` is required-nullable rather than optional on purpose: every construction site must
// answer it, so a new trigger source can't silently ship as "no reason recorded".
export const RunTriggerSchema = z.object({
  kind: z.enum(["job", "task", "agent", "operator", "schedule", "unknown"]),
  ref: z.string().nullable(),
  // Derived from JobRunEntry.trigger rather than re-typed, so a new fire classification
  // (F01(c) added "sleep-wake") reaches the history row without a second edit site.
  detail: JobRunEntrySchema.shape.trigger.nullable(),
}).strict();
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

export const RunHistoryRowSchema = z.object({
  id: z.string().min(1),
  kind: RunKindSchema,
  subject: z.string().min(1),
  trigger: RunTriggerSchema,
  model: z.string().nullable(),
  costUsd: z.number(),
  costBasis: z.enum(["booked", "rolled-up"]),
  outcome: RunOutcomeSchema,
  // Capped: a run row is a LIST entry, and a stack-trace-length TaskRecord.error would blow the
  // width of every TUI/app row. RunHistoryStore truncates to the same 200 before it builds the row.
  reason: z.string().max(200).nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  unseen: z.boolean(),
  queue: z.string().nullable(),
  team: z.string().nullable(),
  jobName: z.string().nullable(),
  agentId: z.string().nullable(),
  taskId: z.string().nullable(),
  steps: z.number().int().min(0).nullable(),
  stepFailures: z.number().int().min(0).nullable(),
}).strict();
export type RunHistoryRow = z.infer<typeof RunHistoryRowSchema>;

// Mirrors SliRollupCoverage's honesty discipline: a caller must be able to tell "we scanned
// everything in the window" from "we hit a cap and stopped" rather than silently under-reporting.
export const RunHistoryCoverageSchema = z.object({
  agentsScanned: z.number().int().min(0),
  tasksScanned: z.number().int().min(0),
  jobRunsScanned: z.number().int().min(0),
  journalEntries: z.number().int().min(0),
  journalTruncated: z.boolean(),
  spanRollupReplayed: z.boolean(),
  spanRollupTruncated: z.boolean(),
}).strict();
export type RunHistoryCoverage = z.infer<typeof RunHistoryCoverageSchema>;

// history.runs request/response (F13) — defined here rather than contract.ts so core's
// RunHistoryStore can import the inferred types from the flat "@chimera/protocol" barrel;
// contract.ts imports these schemas back for its RPC_CONTRACT wiring (see contract.ts's
// top-of-file note on why request/response building blocks live in index.ts, not the reverse).
// MULTI-SELECT IS SERVER-SIDE (F13.QA M-3). `kinds`/`outcome[]`/`job` are the canonical
// names; the scalar `kind`/`jobName` are back-compat aliases kept because the MCP tool
// surface and existing callers already ship them. A UI must NOT re-filter kind/outcome over
// the returned page: the page is TRUNCATED at `limit`, so a client-side pass silently drops
// matches that never made it into the page — wrong results, not merely slow ones.
export const HistoryRunsRequestSchema = z.object({
  from: z.number().optional(),
  to: z.number().optional(),
  kinds: z.array(RunKindSchema).min(1).optional(),
  /** @deprecated back-compat alias for `kinds: [kind]`. */
  kind: RunKindSchema.optional(),
  outcome: z.union([RunOutcomeSchema, z.array(RunOutcomeSchema).min(1)]).optional(),
  queue: z.string().min(1).optional(),
  job: z.string().min(1).optional(),
  /** @deprecated back-compat alias for `job`. */
  jobName: z.string().min(1).optional(),
  team: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  unseenOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
}).strict();
export type HistoryRunsRequest = z.infer<typeof HistoryRunsRequestSchema>;
export const HistoryRunsResponseSchema = z.object({
  rows: z.array(RunHistoryRowSchema),
  nextCursor: z.string().nullable(),
  matched: z.number().int().min(0),
  from: z.number(),
  to: z.number(),
  // Computed over the FULL matched set, never the returned page (F13.QA M-4): with
  // matched > rows.length a page-derived header undercounts failures and unseen runs.
  // `runs` === `matched`; it rides in totals so a header renders from one object.
  totals: z.object({
    runs: z.number().int().min(0),
    costUsd: z.number(),
    failed: z.number().int().min(0),
    unseen: z.number().int().min(0),
  }).strict(),
  coverage: RunHistoryCoverageSchema,
}).strict();
export type HistoryRunsResponse = z.infer<typeof HistoryRunsResponseSchema>;

// ---------- checkpoints (D16, coverage §C18, F20) ----------
// A CHECKPOINT is a git-PLUMBING-only snapshot of an agent/task cwd's full working-tree
// state (tracked + untracked, excluding .gitignore'd paths), captured as a commit object
// under `refs/chimera/checkpoints/<n>` in that repo — HEAD/index/history are never
// touched, so a checkpoint commit is unreachable from any branch and invisible to a
// normal `git log` (only `git log --all`/`for-each-ref` see it). Metadata (trigger/
// agentId/taskId) rides the commit message as trailer lines — no separate coordination
// file, so a checkpoint's lifetime is exactly its ref's lifetime (core's CheckpointStore
// gc's old refs directly). `id` is the ref's numeric suffix, as a string.
export const CheckpointTriggerSchema = z.enum(["task_start", "destructive_bash", "manual"]);
export type CheckpointTrigger = z.infer<typeof CheckpointTriggerSchema>;

export const CheckpointRecordSchema = z.object({
  id: z.string().min(1),
  ref: z.string().min(1),
  trigger: CheckpointTriggerSchema,
  ts: z.number(),
  agentId: z.string().nullable(),
  taskId: z.string().nullable(),
  message: z.string(),
}).strict();
export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>;

// checkpoint.status {cwd}: `supported:false` (non-git cwd) is the ONLY case count/latest
// are absent — the feature is dark for that cwd (F20's "non-git cwd stays dark").
export const CheckpointStatusSchema = z.object({
  supported: z.boolean(),
  cwd: z.string(),
  count: z.number().int().min(0).optional(),
  latest: CheckpointRecordSchema.nullable().optional(),
}).strict();
export type CheckpointStatus = z.infer<typeof CheckpointStatusSchema>;

export const CheckpointCwdParams = z.object({ cwd: z.string().min(1) }).strict();
export type CheckpointCwdParams = z.infer<typeof CheckpointCwdParams>;

// checkpoint.create: `agentId` is stamped by the caller (MCP/TUI) same optional
// convention as artifact.add — taskId is auto-resolved server-side (scheduler.taskFor),
// never trusted from the caller. `trigger` defaults to "manual" (the ctrl+s path);
// the daemon's own auto-triggers (task start / destructive Bash) always pass it explicitly.
export const CheckpointCreateParams = z.object({
  cwd: z.string().min(1),
  trigger: CheckpointTriggerSchema.default("manual"),
  agentId: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
}).strict();
export type CheckpointCreateParams = z.infer<typeof CheckpointCreateParams>;

export const CheckpointRevertParams = z.object({ cwd: z.string().min(1), id: z.string().min(1) }).strict();
export type CheckpointRevertParams = z.infer<typeof CheckpointRevertParams>;

// ---------- memory (shared structured note store, WS-SCHEMA) ----------
// A local-only structured MEMORY store (~/.chimera/memory.json): agents memory_add
// decisions/facts/todos and memory_search them back. Parsed on both write and load,
// like TaskRecordSchema. `author` is stamped from CHIMERA_AGENT_ID; `treeId`/`taskId`
// scope a record to the run that produced it. Intentionally NOT federated — memory.*
// is absent from PEER_METHODS, so peers can never touch local memory.
export const MemoryKindSchema = z.enum(["note", "decision", "fact", "todo", "question"]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemoryRecordSchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1),              // agentId, stamped from CHIMERA_AGENT_ID
  text: z.string().min(1),
  // MEM-1 (PLAN-MEMORY.md §2-§3): optional knowledge-system fields, both defaulted to
  // null so every already-persisted record parses unchanged (additive, zero-migration).
  title: z.string().max(120).nullable().default(null),   // short human name + [[Title]] link target
  folder: z.string().nullable().default(null),           // materialized path (a/b/c); folders exist by reference, like tags
  // F34: the project this note was written FROM, stamped server-side from the writing agent's own
  // AgentRecord.projectId (core/supervisor.ts) — never from a parameter, so it cannot be defeated
  // by omission the way `folder` can (450 of 1,570 live records carry no folder). null = GLOBAL:
  // every record written before F34 parses unchanged and stays visible to every caller, exactly
  // the way title/folder were added above (additive, zero-migration).
  // Ranking and defaults only — NOT an access boundary (README §limitations).
  scope: z.string().nullable().default(null),
  // F36: eviction override. Additive and defaulted like title/folder/scope above, so every
  // already-persisted record parses unchanged and loads unpinned (zero migration). A pin is the
  // heaviest EVICTION weight, not an exemption and not a ranking signal — a pinned record is still
  // evictable when a store is nothing but pins (memory.ts memoryValue), and search never sees it.
  pinned: z.boolean().default(false),
  tags: z.array(z.string()).default([]),  // structured filter dimension
  kind: MemoryKindSchema.default("note"),
  treeId: z.string().nullable().default(null),   // scope: which run produced it
  taskId: z.string().nullable().default(null),
  // F35: the supersession link. `supersedes` is caller-supplied (add() only — MemoryEditParams has
  // no such field, see below); `supersededBy` is STORE-STAMPED on the OLD record the moment a
  // successor names it and is never a caller-writable field on any params schema — that asymmetry
  // is what makes "which record is current" a fact the store owns, not one a client can spoof.
  // Additive and defaulted like title/folder/scope/pinned above: every already-persisted record
  // parses unchanged (zero migration).
  supersedes: z.string().nullable().default(null),
  supersededBy: z.string().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

// Param schemas mirror SetModelParams so engine.ts and mcp import one source.
export const MemoryAddParams = z.object({
  author: z.string().min(1),
  text: z.string().min(1),
  // MEM-1: optional; omitted ⇒ null so every existing memory_add call is byte-identical.
  title: z.string().max(120).nullable().default(null),
  folder: z.string().nullable().default(null),   // normalized store-side (§2)
  // F34: there is deliberately NO `scope` here. The schema is .strict(), so a caller can neither
  // supply a scope nor omit one — the engine stamps it from the author's own project binding.
  // A folder is a hint an agent can forget; a scope is not.
  // F36: there is deliberately NO `pinned` here either. A note is pinned once it has PROVED
  // durable, which is an edit rather than a birth property — and memory_add is a CORE-tier tool
  // whose input schema is billed on every agent spawn (mcp-tools.ts CORE_TOOL_NAMES).
  tags: z.array(z.string()).default([]),
  kind: MemoryKindSchema.default("note"),
  treeId: z.string().nullable().default(null),
  taskId: z.string().nullable().default(null),
  // F35: the id of the record this note replaces. Omitted ⇒ null, a plain add — byte-identical to
  // pre-F35 callers. When present, the store resolves it to the chain's current tip, stamps the
  // NEW record's `supersedes` and the OLD tip's `supersededBy`, and demotes the old record in
  // ranking (memory-search.ts) rather than deleting it — the note stays reachable by id/backlink.
  supersedes: z.string().nullable().default(null),
  // MEMORY-NO-DUPLICATES: an add that would create a second copy of an existing note is REFUSED
  // (the refusal names the record to edit instead). This is the deliberate escape for a caller
  // that has seen the collision and means a genuinely distinct note — default false, so a
  // duplicate can only ever be created on purpose.
  allowDuplicate: z.boolean().default(false),
}).strict();
export type MemoryAddParams = z.infer<typeof MemoryAddParams>;

export const MemoryEditParams = z.object({
  id: z.string().min(1),
  text: z.string().min(1).optional(),
  // MEM-1: nullable+optional — undefined leaves the field untouched, explicit null clears it.
  title: z.string().max(120).nullable().optional(),
  folder: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  kind: MemoryKindSchema.optional(),
  // F36: set/clear the eviction pin. Capped per scope (memory.ts MAX_PINS_PER_SCOPE) — a bounded
  // store must not be makeable unbounded by pinning, so the refusal names the cap.
  pinned: z.boolean().optional(),
  // F35: there is deliberately NO `supersedes` here. Supersession is a birth-time relationship
  // established once via memory_add (like `scope`, but caller-declared rather than server-stamped)
  // — an edit changing which record a note replaces would let the "no forks" chain invariant be
  // rewritten after the fact instead of walked, so the relation is add-only.
  // D11: the editing agent's id, re-stamped onto the record's `author` so the note
  // reflects who last touched it (matches memory_add's CHIMERA_AGENT_ID stamp). Absent
  // on a standalone/direct call leaves the original author untouched.
  author: z.string().min(1).optional(),
}).strict();
export type MemoryEditParams = z.infer<typeof MemoryEditParams>;

// D11: idempotent delete — an unknown id returns {deleted:false}, not an error.
export const MemoryDeleteParams = z.object({ id: z.string().min(1) }).strict();
export type MemoryDeleteParams = z.infer<typeof MemoryDeleteParams>;

// The search mode selects the ranking strategy. `hybrid` (default) is RRF fusion of BM25 +
// cosine once an embedder is live (MEM-4); until then hybrid ≡ semantic ≡ lexical, so the
// default changes nothing observable. MEM-1 parses `mode` but ignores it.
export const MemorySearchModeSchema = z.enum(["lexical", "semantic", "hybrid"]);
export type MemorySearchMode = z.infer<typeof MemorySearchModeSchema>;

// `query` optional so a pure tag-filter listing works; `tags` AND-match all listed tags.
export const MemorySearchParams = z.object({
  query: z.string().optional(),
  tags: z.array(z.string()).optional(),
  author: z.string().optional(),
  kind: MemoryKindSchema.optional(),
  treeId: z.string().optional(),
  folder: z.string().optional(),   // MEM-1: prefix filter — "ops" matches "ops" and "ops/protocols"
  // F34: the CALLING agent's id, stamped by the memory_search tool from ctx.agentId the same way
  // memory_add stamps `author`. NOT a filter (that is `author` above) — the engine reads it only
  // to resolve the DEFAULT retrieval scope. Absent (the app, the TUI, a direct RPC, a test) ⇒ no
  // scope narrowing at all, which is byte-identical to pre-F34.
  agentId: z.string().optional(),
  // F34: explicit scope. "*" = every scope (the documented escape, and today's behaviour); any
  // other value = that scope PLUS global. Omitted ⇒ the caller's own project scope, or unnarrowed
  // when it has none. Never (scope) alone: a cross-project lesson filed globally must never be
  // hidden by a default.
  scope: z.string().optional(),
  // F34-SCOPE-FILTER: exact-membership narrowing, orthogonal to `scope`'s "that scope PLUS
  // global" widening above. Undefined/"all" ⇒ unchanged widening behaviour (backward compatible —
  // every caller before this field existed gets byte-identical results). "global" ⇒ ONLY unscoped
  // records, regardless of `scope`. "project" ⇒ records with a non-null scope, narrowed to `scope`'s
  // value when given. This is what lets a UI ask the server for "@global only" / "@myproj only"
  // instead of over-fetching the union and post-filtering the page (which breaks paging/limit math).
  scopeMode: z.enum(["global", "project", "all"]).optional(),
  mode: MemorySearchModeSchema.default("hybrid"),   // MEM-1: accepted+ignored until MEM-4
  limit: z.number().int().min(1).max(100).default(20),
  // TOKEN-OPT-SEARCH-EXCERPT: return each hit's text as an EXCERPT instead of in full. Set by
  // the agent-facing memory_search tool, left off by the app's Memory tab (which renders whole
  // records and would have to re-fetch every one of them). Nothing is lost either way — the full
  // body is one memory_get away, by the id the hit already carries.
  excerpt: z.boolean().default(false),
}).strict();
export type MemorySearchParams = z.infer<typeof MemorySearchParams>;

// ---------- memory knowledge system: get + stats (MEM-1, PLAN-MEMORY.md §3-§4) ----------
// memory.get {id} → the record plus its resolved outbound [[links]] and inbound backlinks.
// App-only + agent-facing via the memory_get MCP tool (added in MEM-3). Local-only, absent
// from PEER_METHODS like the rest of memory.*.
export const MemoryGetParams = z.object({ id: z.string().min(1) }).strict();
export type MemoryGetParams = z.infer<typeof MemoryGetParams>;

// One resolved outbound link. Dangling is encoded WITHOUT a separate status field:
//   resolvedId != null                        → resolved (points at a live record)
//   resolvedId == null && resolvedTitle != null → GHOST  (a [[Title]] with no note yet — intent)
//   resolvedId == null && resolvedTitle == null → MISSING (a [[id]] to an evicted/deleted note — debris)
export const MemoryLinkSchema = z.object({
  target: z.string(),                    // raw [[target]] as written (alias form's display text stripped), trimmed
  resolvedId: z.string().nullable(),
  resolvedTitle: z.string().nullable(),
}).strict();
export type MemoryLink = z.infer<typeof MemoryLinkSchema>;

// One inbound backlink: the linking record's identity + a ±80-char snippet around its mention.
export const MemoryBacklinkSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  kind: MemoryKindSchema,
  folder: z.string().nullable(),
  snippet: z.string(),
}).strict();
export type MemoryBacklink = z.infer<typeof MemoryBacklinkSchema>;

export const MemoryGetResult = z.object({
  record: MemoryRecordSchema,
  links: z.array(MemoryLinkSchema),
  backlinks: z.array(MemoryBacklinkSchema),
}).strict();
export type MemoryGetResult = z.infer<typeof MemoryGetResult>;

// memory.stats {} → totals for the folder rail counts + the "N of M" fix (M was capped at 100
// by a limit:100 search, commands.coord.ts). App-only surface. byFolder counts records DIRECTLY
// in each exact folder path (null = the virtual "unfiled"); hierarchical roll-up is a client concern.
export const MemoryStatsParams = z.object({}).strict();
export type MemoryStatsParams = z.infer<typeof MemoryStatsParams>;

export const MemoryFolderCountSchema = z.object({
  folder: z.string().nullable(),   // null ⇒ unfiled
  count: z.number().int().min(0),
}).strict();
export type MemoryFolderCount = z.infer<typeof MemoryFolderCountSchema>;

// F34: mirrors MemoryFolderCountSchema. This is the only way to see whether stamping is working
// at all, and it is the per-scope count F36's pin cap reads.
export const MemoryScopeCountSchema = z.object({
  scope: z.string().nullable(),   // null ⇒ global (every pre-F34 record)
  count: z.number().int().min(0),
}).strict();
export type MemoryScopeCount = z.infer<typeof MemoryScopeCountSchema>;

// F36: one record on the eviction frontier — what the store would lose next, ranked by
// memoryValue(). Surfaced so an operator can see WHICH notes are cheap before they go, not just
// that the store is full.
export const MemoryEvictionCandidateSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  kind: MemoryKindSchema,
  value: z.number(),
  inbound: z.number().int().min(0),
  pinned: z.boolean(),
}).strict();
export type MemoryEvictionCandidate = z.infer<typeof MemoryEvictionCandidateSchema>;

// F36: the capacity block of memory.stats — the alarm's steady-state twin. memory_pressure fires
// once per threshold crossing; this answers "where am I now?" at any moment without an event.
export const MemoryCapacitySchema = z.object({
  limit: z.number().int().positive(),
  total: z.number().int().min(0),
  fill: z.number().min(0),          // total/limit — may exceed 1 between a load and the next save()
  alarmAt: z.number().min(0).max(1),
  alarming: z.boolean(),
  pinned: z.number().int().min(0),
  nextToEvict: z.array(MemoryEvictionCandidateSchema),   // <= 5, ascending value (cheapest first)
}).strict();
export type MemoryCapacity = z.infer<typeof MemoryCapacitySchema>;

export const MemoryTagCountSchema = z.object({
  tag: z.string(),
  count: z.number().int().min(0),
}).strict();
export type MemoryTagCount = z.infer<typeof MemoryTagCountSchema>;

export const MemoryStatsResult = z.object({
  total: z.number().int().min(0),
  byKind: z.record(z.string(), z.number().int().min(0)),
  byFolder: z.array(MemoryFolderCountSchema),
  // F34-5: defaulted (not bare-required like its siblings above) — F34 added this field after
  // MemoryStatsResult already had consumers; a daemon/protocol version skew where an older core
  // sends a stats payload without it must still parse instead of throwing.
  byScope: z.array(MemoryScopeCountSchema).default([]),
  topTags: z.array(MemoryTagCountSchema),
  // F36: REQUIRED, not optional — core is the only producer of this result and always fills it,
  // so an optional field would just push a `?? fallback` into every UI consumer for a case that
  // cannot happen. UIs talking to an older daemon read the wire object defensively instead.
  capacity: MemoryCapacitySchema,
}).strict();
export type MemoryStatsResult = z.infer<typeof MemoryStatsResult>;

// ---------- memory knowledge system: graph (MEM-2, PLAN-MEMORY.md §4) ----------
// memory.graph serves the app and MCP diagnostics. Narrow filters before reading the
// global topology; memory_get remains the smaller one-hop recall path. Local-only,
// absent from PEER_METHODS like the rest of memory.*.
export const MemoryGraphParams = z.object({
  folder: z.string().optional(),         // prefix filter, mirrors memory.search narrowing
  kind: MemoryKindSchema.optional(),
  tags: z.array(z.string()).optional(),  // AND-match
  // MEM-7 adds top-neighbor cosine "similarity" edges when the vector index is ready; accepted
  // now, returns none until then — and NEVER errors when the index is off.
  semanticEdges: z.boolean().optional(),
}).strict();
export type MemoryGraphParams = z.infer<typeof MemoryGraphParams>;

// One graph node. Record nodes carry the record's identity + attributes. GHOST nodes (ghost:true)
// stand in for a dangling [[Title]] link that has no note yet (Obsidian-style intent) — they have
// a synthetic id (`ghost:<lowercased-title>`) and NO record attributes (kind/updatedAt null,
// folder null, tags []). `label` is server-computed (title ?? first-line excerpt) so the app
// never needs full note texts for the graph. `degree` counts incident INCLUDED edges.
export const MemoryGraphNodeSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  label: z.string(),
  kind: MemoryKindSchema.nullable(),   // null on ghost nodes
  folder: z.string().nullable(),
  tags: z.array(z.string()),
  degree: z.number().int().min(0),
  updatedAt: z.number().nullable(),    // null on ghost nodes
  ghost: z.literal(true).optional(),   // present (and always true) only on ghost nodes
}).strict();
export type MemoryGraphNode = z.infer<typeof MemoryGraphNodeSchema>;

export const MemoryGraphEdgeKindSchema = z.enum(["link", "semantic"]);
export type MemoryGraphEdgeKind = z.infer<typeof MemoryGraphEdgeKindSchema>;

// source/target are node ids (record ids or `ghost:*` ids). For "link" edges `weight` is the
// mention count (a note that references the same target twice ⇒ one edge, weight 2); for
// "semantic" edges (MEM-7) it is the cosine similarity.
export const MemoryGraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  kind: MemoryGraphEdgeKindSchema,
  weight: z.number(),
}).strict();
export type MemoryGraphEdge = z.infer<typeof MemoryGraphEdgeSchema>;

export const MemoryGraphResult = z.object({
  nodes: z.array(MemoryGraphNodeSchema),
  edges: z.array(MemoryGraphEdgeSchema),
}).strict();
export type MemoryGraphResult = z.infer<typeof MemoryGraphResult>;

// ---------- memory knowledge system: local vector index (MEM-4, PLAN-MEMORY.md §6) ----------
// memory.index drives the local, sidecar-persisted embedding index that powers hybrid/semantic
// search. MCP exposes status for diagnostics; index rebuild remains operator-owned.
// `status` reports the current state;
// `rebuild` discards every vector and re-embeds from scratch in the background. Local-only, absent
// from PEER_METHODS. The index is ALWAYS optional: with no embedder it reports {state:"off"} and
// search stays byte-identical to today's lexical behavior.
export const MemoryIndexActionSchema = z.enum(["status", "rebuild"]);
export type MemoryIndexAction = z.infer<typeof MemoryIndexActionSchema>;
export const MemoryIndexParams = z.object({
  action: MemoryIndexActionSchema.default("status"),
}).strict();
export type MemoryIndexParams = z.infer<typeof MemoryIndexParams>;

// off = no embedder resolved (lexical only); building = embedder live, records still embedding;
// ready = every record has a current vector; error = the embedder failed after being selected.
export const MemoryIndexStateSchema = z.enum(["off", "building", "ready", "error"]);
export type MemoryIndexState = z.infer<typeof MemoryIndexStateSchema>;
export const MemoryIndexResult = z.object({
  state: MemoryIndexStateSchema,
  provider: z.string().nullable(),   // "transformers" | "ollama" | null (off)
  model: z.string().nullable(),      // e.g. "bge-small-en-v1.5" | null (off)
  dim: z.number().int().min(0),      // vector dimension (0 when off)
  embedded: z.number().int().min(0), // records with a current vector
  total: z.number().int().min(0),    // total records
  pending: z.number().int().min(0),  // records queued for (re)embed
  // A semantic/hybrid query issued RIGHT NOW would fall back to lexical (index not ready). Lets the
  // app show a "semantic off / indexing" hint (§8) without inferring it from state.
  degraded: z.boolean(),
  error: z.string().nullable(),      // last embedder error (state === "error")
}).strict();
export type MemoryIndexResult = z.infer<typeof MemoryIndexResult>;

// ---------- filesystem browsing (PROJECT-FILE-BROWSER, FILEBROWSER-T1) ----------
// fs.list/fs.read back the app's file-browser panel over a project's working tree.
// `path` is always RELATIVE to the project root ("" = root) — the daemon resolves
// and bounds it against the project's absolute path; protocol itself stays fs-free.
// LOCAL-ONLY like memory.* — absent from PEER_METHODS, never federated, no MCP-tool
// entry (app-only surface, not agent-callable in v1).
export const FsListParams = z.object({
  project: z.string().min(1),
  path: z.string(),
}).strict();
export type FsListParams = z.infer<typeof FsListParams>;

export const FsEntryKindSchema = z.enum(["file", "dir", "symlink"]);
export type FsEntryKind = z.infer<typeof FsEntryKindSchema>;

export const FsGitStatusSchema = z.enum(["modified", "staged", "untracked", "ignored"]);
export type FsGitStatus = z.infer<typeof FsGitStatusSchema>;

export const FsEntrySchema = z.object({
  name: z.string().min(1),
  kind: FsEntryKindSchema,
  sizeBytes: z.number().int().min(0).nullable(),
  gitStatus: FsGitStatusSchema.nullable(),
}).strict();
export type FsEntry = z.infer<typeof FsEntrySchema>;

export const FsListResult = z.object({
  path: z.string(),
  entries: z.array(FsEntrySchema),
  truncated: z.boolean(),
}).strict();
export type FsListResult = z.infer<typeof FsListResult>;

// PATH-LINK-TILDE-AND-SCOPE: `project` is OPTIONAL — when omitted, `path` is
// itself an absolute (or "~/"-prefixed) path resolved against the WIDENED root
// set (every registered project's root, plus config.projectImportDir), not a
// registered project's tree. Same realpath-both-sides confinement either way
// (see fsbrowse.ts's readAtWidenedRoot, which reuses readFile/resolveWithinProject
// unchanged) — this never opens up the filesystem or the home directory at
// large, only those specific, already-configured roots.
export const FsReadParams = z.object({
  project: z.string().min(1).optional(),
  path: z.string(),
  maxBytes: z.number().int().positive().optional(),
}).strict();
export type FsReadParams = z.infer<typeof FsReadParams>;

// PATH-LINK-ONE-ROUNDTRIP: resolve a path MENTIONED in a transcript to the project it belongs to,
// in one call. The client used to do this itself by probing each registered project with its own
// fs.read and taking the first that answered — N sequential round trips per rendered link, N-1 of
// them expected failures. Measured on an operator's machine: 10 projects, so 10 RPCs per link and
// 9 logged errors, at 305 failures/minute; each one queued on the daemon's single thread behind
// (and ahead of) every other request, which is what turned "the app is slow" into 30s timeouts.
//
// The walk belongs here because it is a FILESYSTEM question: the daemon answers it with local
// stat calls in microseconds, where the client paid a full round trip per candidate. `null` means
// no registered root holds it — the caller's "render as plain text" case, not an error.
export const FsResolveParams = z.object({ path: z.string().min(1) }).strict();
export type FsResolveParams = z.infer<typeof FsResolveParams>;

export const FsReadEncodingSchema = z.enum(["utf8", "base64"]);
export type FsReadEncoding = z.infer<typeof FsReadEncodingSchema>;

export const FsReadResult = z.object({
  path: z.string(),
  encoding: FsReadEncodingSchema,
  content: z.string(),
  sizeBytes: z.number().int().min(0),
  binary: z.boolean(),
  mediaType: z.string().nullable(),
  truncated: z.boolean(),
}).strict();
export type FsReadResult = z.infer<typeof FsReadResult>;

// ---------- projects (WD Stage 2, coverage B12) ----------
// A PROJECT is a registered working directory (imported git clone or a registered
// local path) that teams/sessions are grouped under. Persisted by core's
// ProjectStore at $CHIMERA_HOME/projects.json (same discipline as teams.json).
// `path` must be an ABSOLUTE directory — enforced by ProjectStore.create, not here,
// so this schema stays fs-free (protocol never touches the filesystem).

// F26: the ONE trusted per-project worktree bootstrap command. Deliberately NOT on AgentSpec and
// deliberately not readable from a repo file: a repo file is agent-writable, so committing one
// would be arbitrary daemon-privileged execution on every subsequent spawn. It is set only by the
// operator-facing project.setSetupHook RPC (no MCP tool — see mcp-parity's exclusion list).
// `command` is split without a shell (hooks.ts:splitCommand): no pipes/redirects/expansion.
export const WorktreeSetupHookSchema = z.object({
  command: z.string().min(1).max(2000),
  // 300s covers a cold `pnpm install`; 900 is the ceiling because a hook holds the spawn open and
  // a spawn nobody can complete is worse than a bootstrap nobody finished.
  timeoutSec: z.number().int().min(1).max(900).default(300),
  enabled: z.boolean().default(true),
}).strict();
export type WorktreeSetupHook = z.infer<typeof WorktreeSetupHookSchema>;

export const ProjectSpecSchema = z.object({
  name: CoordName,
  path: z.string().min(1),                        // absolute project directory
  origin: z.string().nullable().default(null),    // git URL for imported projects; null for a registered local path
  teams: z.array(z.string()).default([]),         // assigned team names (project.assignTeam dedupes)
  queue: z.string().nullable().default(null),
  createdAt: z.number(),
  archived: z.boolean().default(false),           // project.archive refuses while live sessions run under `path`
  // Per-project conductor (PLAN-PROJECT-CONDUCTOR-ROUTING D1): autoConductor stamps INTENT
  // only — the daemon spawns the conductor lazily (first dispatch/focus), never eagerly at
  // project.create/import time. conductorId is the live/last conductor agentId this project's
  // ensureProjectConductor persisted, null until one has been spawned. Both default so every
  // existing persisted projects.json row parses byte-identically.
  autoConductor: z.boolean().default(true),
  conductorId: z.string().nullable().default(null),
  // PROJECT-CREATE-PERMISSION-PROFILE: per-project override of config.conductorPermissionProfile
  // (index.ts:896), read by engine.ts's spawnProjectConductor for a FRESH conductor spawn only —
  // precedence there is explicit > this field > global config. null (the default, not merely
  // "optional") means "no override, fall through to global config" — a real profile value would
  // be indistinguishable from an explicit choice, so this stays nullable rather than optional,
  // mirroring `origin`/`queue`/`globalTeam` above. Defaults so every existing persisted row
  // parses byte-identically. Scoped to the CONDUCTOR only, not project-native team-role spawns —
  // those go through scheduler.ts's spawnForTask/assignPersistent, which has no project context
  // threaded through today (a team can serve multiple projects); a role's OWN permissionProfile
  // already rides through there unchanged. Same non-migration discipline as the global default:
  // a reattached conductor keeps its stored profile regardless of this field (reattach.ts).
  permissionProfile: z.enum(["readOnly", "acceptEdits", "full"]).nullable().default(null),
  // PROJECT-CONDUCTOR-ACCOUNT: pin which ACCOUNT (and optionally which model) this project's
  // conductor is born on — the only way to get a project conductor onto a non-claude provider,
  // because AgentSpecSchema's `account` defaults to "auto" (the first autoOrder entry, i.e.
  // claude) and neither agent_set_account nor agent_reconfigure will cross providers
  // (supervisor.ts setAccount's GuardrailError), nor can agent_handoff move an isolation:"none"
  // conductor. Read at exactly the same FRESH-spawn seam as permissionProfile above (engine.ts's
  // spawnProjectConductor) and with the same non-migration discipline: a REATTACHED conductor
  // keeps its stored spec (reattach.ts), and a LIVE one is changed via agent_reconfigure
  // (`account`/`model` are both in RECONFIGURABLE_KEYS) — but reconfigure refuses a
  // cross-provider account too, so the real path for a live claude conductor is
  // project_conductor_stop → project_conductor_start. null (the default, not merely "optional")
  // means "no pin, fall through to the global default", and both default so every existing
  // persisted projects.json row parses byte-identically. The account NAME is validated against
  // the account registry by the engine at create/set time (an unknown account must fail loudly
  // there, not silently at the next spawn); the MODEL string deliberately is not — there is no
  // cross-provider model equivalence table and the catalog is remote-refreshed.
  conductorAccount: z.string().nullable().default(null),
  conductorModel: z.string().nullable().default(null),
  // PROJECT-NATIVE-TEAMS T1: when true, project-scoped agents (the conductor +
  // project-native team roles) load this project's .claude/ plus global ~/.claude
  // skills via settingSources ["project","user"]; false keeps today's isolation
  // (settingSources []). Defaults true so existing persisted rows opt in.
  loadProjectSettings: z.boolean().default(true),
  // F26: null (the default, not merely optional) = no hook, so every persisted projects.json row
  // parses byte-identically — same non-migration discipline as permissionProfile above.
  worktreeSetup: WorktreeSetupHookSchema.nullable().default(null),
}).strict();
export type ProjectSpec = z.infer<typeof ProjectSpecSchema>;

// ---------- plugins catalog (WD Stage 2, coverage B13) ----------
// One row of plugins.list's global catalog: claude-native skills (~/.claude/skills),
// installed plugins (~/.claude/plugins/installed_plugins.json), and per-project
// slash commands (.claude/commands/*.md under the RPC's {cwd} param). `id` is the
// stable "<kind>:<name>" key plugins.toggle persists against ($CHIMERA_HOME/
// plugins.json); toggles apply to NEW spawns via the supervisor's spawn resolution.
export const PluginEntryKindSchema = z.enum(["skill", "plugin", "command"]);
export type PluginEntryKind = z.infer<typeof PluginEntryKindSchema>;

export const PluginCatalogEntrySchema = z.object({
  id: z.string().min(1),
  kind: PluginEntryKindSchema,
  name: z.string().min(1),
  source: z.string().min(1),                      // on-disk origin (directory or file)
  enabled: z.boolean(),
}).strict();
export type PluginCatalogEntry = z.infer<typeof PluginCatalogEntrySchema>;

// ---------- MCP-STORE (chimera-level MCP registry + dynamic discovery) ----------
// Install an MCP server ONCE into the store and every agent on every provider can
// discover/call it via chimera's own mcp_store_tools/mcp_store_call meta-tools
// (packages/mcp) -- no per-provider config, no upfront tool-list bloat (agents
// discover servers/tools on demand, same deferred-tools pattern as ToolSearch).
// Supports stdio packages plus remote http/sse servers. Persisted at
// $CHIMERA_HOME/mcpstore.json by
// core's McpStoreRegistry -- deliberately NOT a ChimeraConfigSchema field: config.json
// is user-owned and read-only to the daemon (see configstore.ts's header comment);
// this is a daemon-owned registry like plugins.json/toolpolicy.json, mutated via
// mcpstore.add/remove RPCs.
export const McpStoreNameSchema = z.string().min(1).max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and - only, starting with a letter or digit");

// MCP-STORE-DIRECT-TOGGLE: `direct` (default false, so every existing entry is
// byte-for-byte unaffected) opts a store server INTO being surfaced as first-class
// native tools (server-prefixed, e.g. `chrome-devtools__navigate_page`) on every
// orchestration-enabled agent's chimera MCP grant, in addition to staying reachable
// via the mcp_store_tools/mcp_store_call proxy either way (additive, never exclusive).
// MCPSTORE-LIFECYCLE-UI: `enabled` (default true, so every existing entry parses byte-
// identically) is the disable/enable lifecycle flag -- a disabled entry keeps its persisted
// spec/credentials but is never connected (McpStoreConnectionManager) and never surfaced to
// agents (mcpstore.tools/call, direct-tool injection). It is a temporary off switch, not an
// uninstall -- see mcpstore.remove for the credential-purging uninstall path.
// TRUST-TIER: "full" (default — today's unconditional-allow behavior, byte-identical for every
// existing install) vs "untrusted" (an admin's explicit signal that this server's DATA cannot be
// trusted, even though the daemon trusts the connection itself enough to have installed it) —
// see broker.decideMcpStoreCall for what "untrusted" actually gates. `.catch("untrusted")` is
// the FAIL-CLOSED half of the pair with `.default`: `.default` only fires for an ABSENT key
// (missing ⇒ full, safe because that's every pre-existing entry); `.catch` fires for a PRESENT
// but unparseable value (a typo like "untrusted " or "Full" must never silently disable gating
// by falling back to the permissive default — it must fail toward the SAFER tier instead).
export const McpStoreTrustSchema = z.enum(["full", "untrusted"]).default("full").catch("untrusted");

// Managed installs are separate from provider config imports and arbitrary commands.
// Only exact public npm versions are accepted; git, file, URL and tag specs are not.
export const McpPackageNameSchema = z.string().max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
export const McpPackageVersionSchema = z.string().max(128)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
export const McpManagedPackageSchema = z.object({
  id: z.string().uuid(),
  ecosystem: z.literal("npm"),
  packageName: McpPackageNameSchema,
  version: McpPackageVersionSchema,
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
  bin: z.string().min(1).max(214),
}).strict();
export const McpPackageInspectParams = z.object({
  packageName: McpPackageNameSchema, version: McpPackageVersionSchema,
}).strict();
export const McpPackageReviewSchema = z.object({
  reviewId: z.string().uuid(), packageName: McpPackageNameSchema,
  version: McpPackageVersionSchema, integrity: z.string(),
  bins: z.array(z.string()), hasInstallScripts: z.boolean(),
  license: z.string().optional(), expiresAt: z.number(),
}).strict();
export type McpPackageReview = z.infer<typeof McpPackageReviewSchema>;
export const McpPackageInstallParams = z.object({
  reviewId: z.string().uuid(), name: McpStoreNameSchema,
  bin: z.string().min(1).max(214),
  args: z.array(z.string().max(8192)).max(128).default([]),
}).strict();
export type McpPackageInstall = z.infer<typeof McpPackageInstallParams>;

// Browser sessions are isolated per agent; desktop control is a shared leased resource.
export const McpStoreSessionModeSchema = z.enum(["shared", "agent", "exclusive"]);
export const McpStoreSessionParams = z.object({
  server: McpStoreNameSchema,
  action: z.enum(["status", "acquire", "release"]),
  agentId: z.string().min(1).optional(),
}).strict();
// Read-only, in-memory activity metadata for the operator and agent diagnostics. Never includes typed text, tool
// arguments, screenshots or tool results in persistent events.
export const McpStoreMonitorParams = z.object({}).strict();
export const McpStoreMonitorSchema = z.object({
  held: z.boolean(), owner: z.string().nullable(), ownerName: z.string().nullable().optional(), busy: z.boolean(),
  windowId: z.number().int().positive().nullable(), desktop: z.boolean().optional(),
  activities: z.array(z.object({
    id: z.number().int(), ts: z.number(), agentId: z.string().nullable(), tool: z.string(),
    state: z.enum(["waiting", "running", "succeeded", "failed"]),
  })),
});
export type McpStoreMonitor = z.infer<typeof McpStoreMonitorSchema>;

export const McpStoreImageSchema = z.object({
  type: z.literal("image"),
  data: z.string().max(8 * 1024 * 1024),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
}).strict();
export const McpStoreCallResultSchema = z.object({
  text: z.string(), isError: z.boolean().optional(),
  images: z.array(McpStoreImageSchema).max(8).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type McpStoreCallResult = z.infer<typeof McpStoreCallResultSchema>;

// Provenance marker for the integrations Chimera itself ships. A name or command shape is not
// proof of origin (a user can register their own `laya`), so reconcile only ever updates an entry
// that carries this marker. It is stamped by the daemon from the runtime manifest and rejected on
// `mcpstore.add`, so an agent or import cannot forge it.
export const McpBuiltInIdSchema = z.enum(["laya", "chimera-browser", "chimera-desktop"]);
export type McpBuiltInId = z.infer<typeof McpBuiltInIdSchema>;
export const McpBuiltInSchema = z.object({ id: McpBuiltInIdSchema, version: z.string().min(1).max(64) }).strict();
export type McpBuiltIn = z.infer<typeof McpBuiltInSchema>;

// Operator-facing status of the Chimera-managed computer-use integrations. `provisioning` says HOW the
// tool reaches the machine so the UI never implies Laya's model assets ship in the installer:
// "managed-download" means the app fetches them on first use and reports progress here.
export const BuiltInStateSchema = z.enum(["ready", "not-installed", "installing", "failed", "unsupported-platform", "unavailable", "name-taken"]);
export type BuiltInState = z.infer<typeof BuiltInStateSchema>;
export const BuiltInStatusSchema = z.object({
  id: McpBuiltInIdSchema,
  state: BuiltInStateSchema,
  provisioning: z.enum(["bundled", "managed-download"]),
  version: z.string().max(64).optional(),
  reason: z.string().max(500).optional(),
  modelAssets: z.literal("downloaded-on-first-use").optional(),
}).strict();
export type BuiltInStatus = z.infer<typeof BuiltInStatusSchema>;
// `managed:false` = this daemon is not running from a packaged runtime (dev checkout): there is no
// manifest, so there is nothing to report and nothing is registered automatically.
export const BuiltInsStatusResultSchema = z.object({ managed: z.boolean(), integrations: z.array(BuiltInStatusSchema) }).strict();
export type BuiltInsStatusResult = z.infer<typeof BuiltInsStatusResultSchema>;
export const BuiltInsInstallParamsSchema = z.object({ id: z.literal("laya") }).strict();
export type BuiltInsInstallParams = z.infer<typeof BuiltInsInstallParamsSchema>;

export const McpStoreStdioSpecSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  direct: z.boolean().default(false),
  enabled: z.boolean().default(true),
  trust: McpStoreTrustSchema,
  sessionMode: McpStoreSessionModeSchema.optional(),
  managed: McpManagedPackageSchema.optional(),
  builtIn: McpBuiltInSchema.optional(),
}).strict();
// MCP-REMOTE-IMPORT slice 1: optional keychain-backed auth for a remote (http) server.
// Mirrors AccountAuth's tokenRef pattern above (~line 84-97) -- `keychainRef` is a
// KEYCHAIN SERVICE NAME (e.g. "chimera:mcp:<name>"), NEVER the secret itself. Written by
// the UI-only `mcpstore.setAuth` RPC (core/engine.ts), never by an agent-facing tool.
// `header`/`scheme` are left optional here (no schema default) so callers can distinguish
// "unset" from "explicitly the default" -- consumers default to header "Authorization",
// scheme "Bearer" when building the outgoing request.
// MCP-OAUTH slice 1: `kind` discriminates a static bearer credential from an OAuth 2.1
// (auth-code + PKCE + DCR) grant. `.default("bearer")` means every pre-existing entry
// (persisted before this field existed, so it has no `kind` key at all) parses BYTE-
// IDENTICALLY as kind:"bearer" -- see index.test.ts's back-compat-parse test. `keychainRef`
// stays the ONE field for both kinds: for "bearer" it names a raw-token keychain entry
// (unchanged); for "oauth" it names an entry whose payload is a JSON blob of
// `{tokens, clientInfo}` (written by mcpstore.oauth.finish in slice 2/3) -- never a bare
// secret either way. `scopes` is oauth-only in practice (the requested scope list for the
// authorize request) but left available on the schema rather than a nested oauth-only
// sub-object, so a bearer entry that never sets it stays untouched.
export const McpStoreHttpAuthSchema = z.object({
  kind: z.enum(["bearer", "oauth"]).default("bearer"),
  header: z.string().min(1).optional(),
  scheme: z.string().min(1).optional(),
  keychainRef: z.string().min(1),
  scopes: z.array(z.string()).optional(),
}).strict();
export type McpStoreHttpAuth = z.infer<typeof McpStoreHttpAuthSchema>;

// MCP-OAUTH-FOREIGN-SCOPES: an operator-configured gateway's scope catalog (config
// `mcpOAuthGateways`) describes THAT gateway's downstreams. It used to be stamped onto every
// oauth-kind http entry, including foreign servers that have never heard of those scope names —
// which is why connecting Cloudflare came back Unauthorized.
//
// This is the one rule both core (auto-probe on add/import) and the app (add-remote form) resolve
// scopes through, so the two can never drift:
//   1. the server's OWN advertised scopes_supported, when the probe resolved any;
//   2. the matched gateway's defaultScopes, ONLY for a url on one of that gateway's hosts;
//   3. undefined — ask for no scope at all and let the authorization server apply its default.
// (3) is deliberate: RFC 6749 §3.3 makes `scope` optional, while an unknown scope is an outright
// error on most servers, so "no opinion" is strictly safer than "wrong opinion".
export function findMcpOAuthGateway(url: string, gateways: readonly McpOAuthGateway[] | undefined): McpOAuthGateway | undefined {
  if (!gateways || gateways.length === 0) return undefined;
  let host: string;
  try {
    // Parsed-hostname comparison, never a substring match: "gw.example.com.evil.tld" and a
    // query string carrying the gateway's name must not pass.
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;   // an unparseable url is not a gateway; caller falls through to (3)
  }
  return gateways.find((gw) => gw.hosts.some((entry) => {
    const h = entry.toLowerCase();
    return h.startsWith(".") ? host.endsWith(h) : host === h;
  }));
}

export function resolveDefaultOAuthScopes(
  url: string,
  scopesSupported: readonly string[] | undefined,
  gateways: readonly McpOAuthGateway[] | undefined,
): string[] | undefined {
  if (scopesSupported && scopesSupported.length > 0) return [...scopesSupported];
  const gateway = findMcpOAuthGateway(url, gateways);
  if (gateway && gateway.defaultScopes.length > 0) return [...gateway.defaultScopes];
  return undefined;
}

export const McpStoreHttpSpecSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  direct: z.boolean().default(false),
  enabled: z.boolean().default(true),
  auth: McpStoreHttpAuthSchema.optional(),
  trust: McpStoreTrustSchema,
  sessionMode: McpStoreSessionModeSchema.optional(),
}).strict();
const withStdioDefault = (v: unknown) =>
  v && typeof v === "object" && !("type" in v) ? { type: "stdio", ...v } : v;
export const McpStoreServerSpecSchema = z.preprocess(
  withStdioDefault,
  z.discriminatedUnion("type", [McpStoreStdioSpecSchema, McpStoreHttpSpecSchema]),
);
export type McpStoreServerSpec = z.infer<typeof McpStoreServerSpecSchema>;

export const McpStoreEntrySchema = z.preprocess(withStdioDefault, z.discriminatedUnion("type", [
  McpStoreStdioSpecSchema.extend({ name: McpStoreNameSchema }).strict(),
  McpStoreHttpSpecSchema.extend({ name: McpStoreNameSchema }).strict(),
]));
export type McpStoreEntry = z.infer<typeof McpStoreEntrySchema>;

export const McpStoreAddParams = McpStoreEntrySchema;
export type McpStoreAddParamsT = z.infer<typeof McpStoreAddParams>;

export const McpStoreRemoveParams = z.object({ name: McpStoreNameSchema }).strict();

// MCP-STORE-DIRECT-TOGGLE: flips one server's `direct` flag (persisted in mcpstore.json).
export const McpStoreSetDirectParams = z.object({ name: McpStoreNameSchema, direct: z.boolean() }).strict();

// MCPSTORE-LIFECYCLE-UI: flips one server's `enabled` flag (persisted in mcpstore.json) --
// see McpStoreStdioSpecSchema's doc comment for what disabled means.
export const McpStoreSetEnabledParams = z.object({ name: McpStoreNameSchema, enabled: z.boolean() }).strict();

// TRUST-TIER: flips one server's `trust` (persisted in mcpstore.json), same UI-only shape as
// setDirect/setEnabled -- see McpStoreTrustSchema's doc comment for what each tier gates.
export const McpStoreSetTrustParams = z.object({ name: McpStoreNameSchema, trust: McpStoreTrustSchema }).strict();

// MCP-REMOTE-IMPORT slice 1: writes a remote server's bearer credential to the OS
// keychain (service "chimera:mcp:<name>"), the same UI-only shape as accounts.setKey
// (~AccountSetKeyParams in engine.ts) -- NEVER an agent-facing MCP tool, since a token
// passed as a tool argument would land in the agent transcript/logs. `secret` never
// appears in the RPC's response.
export const McpStoreSetAuthParams = z.object({ name: McpStoreNameSchema, secret: z.string().min(1) }).strict();

// MCP-OAUTH-DISCOVERABILITY: read-only, no-secret probe for whether a remote MCP server
// implements OAuth 2.1 -- RFC9728 protected-resource metadata (or a 401 WWW-Authenticate
// pointing at one) resolving to an authorization server is the signal. UI-only (same
// discipline as the other mcpstore auth RPCs above): a fresh add/import candidate is probed
// by `url`; an already-installed http entry is probed by `name` (core resolves its stored
// url) -- exactly one of the two is required, enforced in the handler, not the schema.
export const McpStoreDetectAuthParams = z.object({
  url: z.string().url().optional(),
  name: McpStoreNameSchema.optional(),
}).strict();
export const McpStoreDetectAuthResultSchema = z.object({
  oauth: z.boolean(),
  authorizationServers: z.array(z.string()).optional(),
  scopesSupported: z.array(z.string()).optional(),
}).strict();
export type McpStoreDetectAuthResult = z.infer<typeof McpStoreDetectAuthResultSchema>;

// MCP-OAUTH-DISCOVERABILITY: retrofits an EXISTING http entry's auth.kind -- the Authorize
// button's "detected-OAuth bearer entry" path converts it to "oauth" (with a default scope
// set, see resolveDefaultOAuthScopes) before the usual oauth.start/finish flow runs.
// `keychainRef` is always re-derived from `name` server-side, never caller-supplied -- same
// invariant mcpstore.setAuth/import already rely on.
export const McpStoreSetAuthKindParams = z.object({
  name: McpStoreNameSchema,
  kind: z.enum(["bearer", "oauth"]),
  scopes: z.array(z.string()).optional(),
}).strict();

// MCP-AUTH-STATUS: "is this server's authorization still good?", answered WITHOUT a network
// round-trip -- the store page renders one row per installed server on every open, and eagerly
// connecting each one just to colour a chip would be a connect storm for a glance.
//
// The states are deliberately coarse, because the underlying truth is coarse:
//   none          -- nothing to authorize (stdio, or an http entry with no auth at all)
//   bearer        -- a static keychain token; it has no expiry chimera can observe
//   never         -- oauth-kind, but no tokens have ever been stored (Authorize was never run)
//   authorized    -- oauth tokens present and believed live
//   needs-reauth  -- oauth tokens present but DEAD: either the last real connect was rejected
//                    for auth reasons, or the access token is past expiry with no refresh_token
//                    left to renew it
//
// What is NOT here, on purpose: "expired". An access token past `expires_in` is the normal
// steady state -- the SDK's authProvider refreshes it reactively on the next connect -- so a
// server holding a live refresh_token stays `authorized`. Only a refresh that CANNOT happen
// (no refresh_token) or one that demonstrably FAILED (a 401/invalid_grant on a real attempt)
// is honest grounds for "needs-reauth". Painting every hour-old token red would flag servers
// that connect perfectly well.
export const McpStoreAuthStateSchema = z.enum(["none", "bearer", "never", "authorized", "needs-reauth"]);
export type McpStoreAuthState = z.infer<typeof McpStoreAuthStateSchema>;

// Never carries a token, a client_secret, or any part of one -- only timestamps, the granted
// scope list, and a human one-liner. This crosses into an agent transcript via
// mcp_store_auth_status, so "no secret material" is a hard contract, not a preference.
export const McpStoreAuthStatusSchema = z.object({
  name: z.string(),
  state: McpStoreAuthStateSchema,
  detail: z.string(),
  // epoch ms the tokens were last written by a completed authorize/refresh; absent for a
  // grant minted before this field existed (old keychain payloads have no stamp).
  authorizedAt: z.number().int().nonnegative().optional(),
  // epoch ms of the last REAL connect attempt this daemon made. Absent means "never probed
  // since the daemon started" -- which is why `authorized` is a belief, not an observation.
  lastCheckedAt: z.number().int().nonnegative().optional(),
  scopes: z.array(z.string()).optional(),
}).strict();
export type McpStoreAuthStatus = z.infer<typeof McpStoreAuthStatusSchema>;

export const McpStoreAuthStatusParams = z.object({ name: McpStoreNameSchema.optional() }).strict();
export const McpStoreAuthStatusResultSchema = z.object({
  servers: z.array(McpStoreAuthStatusSchema),
}).strict();

// P2 dynamic discovery: mcpstore.tools lazily connects every (or query-filtered)
// store server and returns its live tool list; mcpstore.call proxies one tool
// invocation through the shared daemon connection. `servers` (MCP-STORE-DIRECT-TOGGLE)
// restricts which registered servers are even considered — used by the chimera MCP
// grant's direct-tool synthesis so a non-direct server is never connected just to
// build the native tool set (an omitted `servers` keeps today's "every server" scan,
// e.g. for the mcp_store_tools discovery tool).
export const McpStoreToolsParams = z.object({
  query: z.string().min(1).optional(),
  servers: z.array(z.string()).optional(),
}).strict();

export const McpStoreCallParams = z.object({
  server: McpStoreNameSchema,
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  // FEATURE-6: the calling agent's id, when known — threaded through from the chimera MCP
  // grant's ctx.agentId (mcp-tools.ts's mcp_store_call resolve / mcp-server-factory.ts's
  // direct-tool dispatch) so CapabilityBroker's audit event can attribute a principal.
  // Optional: a raw/UI-originated RPC call has no agentId to give.
  agentId: z.string().optional(),
}).strict();

export const McpStoreToolInfoSchema = z.object({
  server: z.string(),
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  // TRUST-TIER: captured at discovery (mcpstore.ts) from the tool's MCP `annotations.
  // readOnlyHint`. Absent whenever the server didn't advertise a boolean readOnlyHint — the
  // caller-side gate (broker.decideMcpStoreCall) fails closed on absence (treats as
  // write-capable), so `undefined` here is meaningful and must never default to `false`.
  readOnlyHint: z.boolean().optional(),
}).strict();
export type McpStoreToolInfo = z.infer<typeof McpStoreToolInfoSchema>;

// P3: a local stdio MCP server discovered on this machine's claude/codex config,
// eligible (or not) to be copied into the store. `command` is absent exactly when
// `notImportableReason` is set (e.g. a claude.ai-managed remote connector -- auth
// lives in the claude.ai session, not bridgeable; see McpImportScanner).
// MCP-REMOTE-IMPORT slice 1: `type`/`url`/`headers`/`requiresAuth` are ADDITIVE and
// optional so a remote row can be represented too (a future scanner slice populates
// them for an http-transport entry found in claude/codex config) -- every existing
// stdio importable (the only kind produced today) omits them and is unaffected.
// `requiresAuth` flags an importable remote whose upstream config already implies
// credentials are needed, so the UI can prompt for mcpstore.setAuth before/after import.
export const McpStoreImportableSchema = z.object({
  source: z.enum(["claude", "codex"]),
  name: z.string().min(1),
  type: z.enum(["stdio", "http"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  requiresAuth: z.boolean().optional(),
  notImportableReason: z.string().optional(),
}).strict();
export type McpStoreImportable = z.infer<typeof McpStoreImportableSchema>;

export const McpStoreImportParams = z.object({
  source: z.enum(["claude", "codex"]),
  name: z.string().min(1),                 // the importable's original name -- re-scanned at import time
  as: McpStoreNameSchema.optional(),        // optional rename into the store; defaults to a sanitized `name`
}).strict();

// ---------- federation (spec §15, Phase 5) ----------
// (EngineIdSchema, PeerSshConfigSchema, PeerConfigSchema, FederationConfigSchema live
// above, next to ChimeraConfigSchema, which references them — see comment there.)

export const EngineCardSchema = z.object({                  // A2A-aligned signed-card concept; JWS optional later
  engineId: EngineIdSchema,
  protocolVersion: z.number().int(),
  features: z.array(z.string()),                            // ["federation.v1"]
  providers: z.array(z.string()),
  accounts: z.array(z.object({ name: z.string().min(1), provider: z.string().min(1) }).strict()),  // NAMES ONLY
  // D8 pairing (both OPTIONAL — additive; normal handshake cards omit them and parse unchanged):
  //   publicKey — this engine's ed25519 SPKI base64. Lets an invite-paired RESPONDER TOFU-pin
  //     the joiner it has never seen (the invite token is the bearer authorization; the key it
  //     signs with is pinned on first contact). NOT a secret — a public key.
  //   endpoint  — how to reach this engine. Present on a PAIRING card so the responder can pin a
  //     reachable socket for the reverse-direction link; absent on ordinary durable-link cards.
  publicKey: z.string().min(1).optional(),
  endpoint: PeerEndpointSchema.optional(),
}).strict();
export type EngineCard = z.infer<typeof EngineCardSchema>;

// handshake: hello(A) -> challenge(B, proves B first) -> auth(A, proves A) -> welcome(B)
export const FedHelloSchema = z.object({
  fed: z.literal("hello"), engineId: EngineIdSchema, protocolVersion: z.number().int(),
  nonce: z.string().min(16),
  // D8 pairing (OPTIONAL — additive; ordinary handshakes omit it): a single-use invite token
  // the JOINER presents so an unknown-peer RESPONDER can TOFU-admit it (default deny otherwise).
  // The token itself GRANTS NOTHING beyond pinning — the new peer starts read-only.
  inviteToken: z.string().min(1).optional(),
}).strict();
export const FedChallengeSchema = z.object({
  fed: z.literal("challenge"), engineId: EngineIdSchema, protocolVersion: z.number().int(),
  nonce: z.string().min(16), signature: z.string().min(1),
}).strict();
export const FedAuthSchema = z.object({
  fed: z.literal("auth"), signature: z.string().min(1), card: EngineCardSchema,
}).strict();
export const FedWelcomeSchema = z.object({ fed: z.literal("welcome"), card: EngineCardSchema }).strict();
export const FedErrorSchema = z.object({ fed: z.literal("error"), code: z.string(), message: z.string() }).strict();
export const FedFrameSchema = z.discriminatedUnion("fed", [
  FedHelloSchema, FedChallengeSchema, FedAuthSchema, FedWelcomeSchema, FedErrorSchema,
]);
export type FedHelloFrame = z.infer<typeof FedHelloSchema>;
export type FedChallengeFrame = z.infer<typeof FedChallengeSchema>;
export type FedAuthFrame = z.infer<typeof FedAuthSchema>;
export type FedWelcomeFrame = z.infer<typeof FedWelcomeSchema>;
export type FedErrorFrame = z.infer<typeof FedErrorSchema>;
export type FedFrame = z.infer<typeof FedFrameSchema>;

export function challengePayload(nonceA: string, nonceB: string, initiatorId: string, responderId: string): Buffer {
  return Buffer.from([nonceA, nonceB, initiatorId, responderId].join("\n"), "utf8");
}

// peer subprotocol allowlist — everything else is local-only forever
export const PEER_METHODS = [
  "peer.status", "accounts.list", "agent.spawn", "agent.status", "agent.result",
  "agent.send", "agent.kill", "agent.tail", "mailbox.forward",
] as const;
export type PeerMethod = (typeof PEER_METHODS)[number];
export function isPeerMethod(method: string): method is PeerMethod {
  return (PEER_METHODS as readonly string[]).includes(method);
}

export const MailboxWireMessageSchema = z.object({
  id: z.string().min(1),                                    // sender-assigned — the effectively-once story
  ts: z.number(),
  from: z.string().min(1),                                  // qualified sender address
  // AGENT-FAILURE-REACHES-CONDUCTOR: "child_failed" is deliverTo's failure counterpart to
  // "child_result" — a distinct kind (not a meta flag on child_result) so an older consumer
  // that only ever expected success payloads can't misread failure meta as a result, and a
  // conductor can filter/branch on kind without string-sniffing text.
  kind: z.enum(["child_result", "child_failed", "user_message", "signal"]),
  text: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
  engineId: z.string().min(1),                              // origin tag — cross-engine messages are untrusted input
}).strict();
export type MailboxWireMessage = z.infer<typeof MailboxWireMessageSchema>;

export const MailboxForwardParamsSchema = z.object({
  agentId: z.string().min(1),                               // LOCAL id on the receiving engine (no transitive relay)
  message: MailboxWireMessageSchema,
}).strict();

// Words that are unambiguously credential-shaped: substring-match them within each
// segment (not exact-equality) so glued-lowercase compounds with no camelCase/
// snake_case/kebab-case boundary (e.g. "apikey", "authtoken", "accesstoken",
// "clientsecret", "sessiontoken", "bearertoken") and plural forms (e.g. "apiKeys",
// "accessTokens") are still caught. This is the brief's own
// /auth|token|key|secret|credential/i matcher applied in full — including
// "token" — rather than narrowed to an exact-segment match (fix for review
// finding: an exact-match carve-out for "token" alone let accesstoken/
// sessiontoken/accessTokens/xtoken/bearertoken bypass the guard).
// Reserved credential words matched against the WHOLE key (not split on camelCase),
// so a straddling word like "keYchain" cannot evade the guard.
const RESERVED_CREDENTIAL_WORD = /auth|token|key|secret|credential/i;

// SAFE allowlist: keys whose name trips RESERVED_CREDENTIAL_WORD yet carry no credential
// material (e.g. "maxThinkingTokens" contains "token"). Add one only when verified safe.
const SAFE_PROVIDER_OPTION_KEYS = new Set<string>(["maxThinkingTokens"]);

/** Guardrail for federated spawns: no env injection, no auth-shaped providerOptions, and no
 *  plugins can cross an engine boundary. */
export function assertFederationSafeSpec(spec: { providerOptions: Record<string, unknown>; plugins?: readonly unknown[] }): void {
  // WS-E: `plugins` names local directories the EXECUTOR engine loads and RUNS code from
  // (a plugin's skills/hooks/agents/commands, plus its .mcp.json subprocesses unless
  // skipMcpDiscovery). Letting a spawn-granted peer set it is cross-engine code-execution
  // smuggling — the exact class of capability this guardrail exists to block. Reject any
  // non-empty plugins on a federated spec; the default empty list passes untouched, so
  // plugin-less federated spawns are unaffected.
  if (spec.plugins && spec.plugins.length > 0) {
    throw { code: "guardrail", message: "federated spawn rejects plugins (executor-side code-load capability)" };
  }
  for (const k of Object.keys(spec.providerOptions)) {
    if (SAFE_PROVIDER_OPTION_KEYS.has(k)) continue;
    // WS-E: providerOptions is spread LAST into the backend's SDK options (backends/claude.ts),
    // so `providerOptions.plugins` reaches the SAME executor-side code-load sink as the
    // first-class spec.plugins guarded above — close that second channel too. (The broader
    // escape-hatch risk that ANY SDK option — mcpServers, canUseTool, hooks — is injectable via
    // providerOptions on a federated spec predates WS-E and is left to a dedicated hardening pass.)
    if (k === "env" || k === "plugins" || RESERVED_CREDENTIAL_WORD.test(k)) {
      throw { code: "guardrail", message: `federated spawn rejects providerOptions.${k} (credential- or code-load-capable field)` };
    }
  }
}

// ---------- D8: pairing (invite / join / grant) + the pairing blob ----------
// The invite blob an operator copies from engine A into engine B's join field:
//   chimera-pair:v1;base64(JSON{ card, endpoint, inviteToken, exp })
// `card`   — A's EngineCard (identity + publicKey so B can pin A).
// `endpoint` — how B reaches A (A's federation.sock, or an ssh forward spec).
// `inviteToken` — 128-bit single-use bearer secret; only its SHA-256 hash is stored on A
//   (invites.json). It is present in this blob because the operator must transport it once;
//   it NEVER appears in any RPC response other than fed.invite.create, in any event, or at rest.
// `exp` — epoch-ms expiry (TTL enforced at join and at responder-side token check).
export const PAIR_BLOB_PREFIX = "chimera-pair:v1;";

export const PairBlobSchema = z.object({
  card: EngineCardSchema,
  endpoint: PeerEndpointSchema,
  inviteToken: z.string().min(1),
  exp: z.number().int(),
  cloudflareAccessSecret: z.string().min(1).optional(),     // transported once, like inviteToken; never at rest in PeerEndpointSchema
  // §13 addendum — both ADDITIVE + optional; old blobs (fields absent) parse unchanged:
  //   inviteKeyPrivate — the per-invite ephemeral ed25519 PRIVATE key (§13a). Shown-once, same
  //     bearer-secret class as inviteToken/cloudflareAccessSecret: present only in this blob,
  //     never persisted by the inviter, never in any RPC response, event, or error message.
  //   fedSshPublicKey  — the inviter's DURABLE fed_ssh_key.pub (§13b). Public, not a secret; the
  //     joiner authorizes it during fed.join so the inviter's reverse link works with a key it
  //     already has.
  inviteKeyPrivate: z.string().min(1).optional(),
  fedSshPublicKey: z.string().min(1).optional(),
}).strict();
export type PairBlob = z.infer<typeof PairBlobSchema>;

// Isomorphic UTF-8 <-> base64. The pairing blob crosses a Node<->browser boundary: the daemon
// (Node) mints it via fed.invite.create; the operator pastes it into the app's webview (browser)
// join field. `Buffer` is undefined in the webview, so we route through globalThis.btoa/atob and
// TextEncoder/TextDecoder. base64 is computed over the UTF-8 byte stream (via a latin1 binary
// string), so it is byte-for-byte identical to Node's Buffer.from(s,"utf8").toString("base64") —
// the two sides interop, and arbitrary unicode JSON round-trips.
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodePairBlob(payload: PairBlob): string {
  return PAIR_BLOB_PREFIX + utf8ToBase64(JSON.stringify(payload));
}

/** Parse+validate a pairing blob. Throws {code:"protocol"} on a bad prefix, bad base64,
 *  bad JSON, or a shape violation — the fed.join "config" step reports this failure. */
export function decodePairBlob(blob: string): PairBlob {
  if (typeof blob !== "string" || !blob.startsWith(PAIR_BLOB_PREFIX))
    throw { code: "protocol", message: "not a chimera-pair:v1 invite blob" };
  const b64 = blob.slice(PAIR_BLOB_PREFIX.length);
  let json: unknown;
  try {
    json = JSON.parse(base64ToUtf8(b64));
  } catch {
    throw { code: "protocol", message: "invite blob is not valid base64 JSON" };
  }
  const parsed = PairBlobSchema.safeParse(json);
  if (!parsed.success)
    throw { code: "protocol", message: `invite blob shape invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  return parsed.data;
}

// fed.invite.create {ttlSeconds?} → { blob, id, exp } (blob shown ONCE — carries the raw token).
export const InviteCreateParams = z.object({
  ttlSeconds: z.number().int().positive().max(30 * 24 * 3600).optional(),   // default applied engine-side (24h)
}).strict();
export type InviteCreateParams = z.infer<typeof InviteCreateParams>;

// fed.invite.revoke {id}
export const InviteRevokeParams = z.object({ id: z.string().min(1) }).strict();
export type InviteRevokeParams = z.infer<typeof InviteRevokeParams>;

// An invites.json / fed.invite.list row — HASH, never the raw token.
export type InviteListEntry = { id: string; hash: string; exp: number; used: boolean; createdAt: number };

// fed.join {blob} → { steps: [{step, ok, error?}], paired?: engineId }
export const FedJoinParams = z.object({ blob: z.string().min(1) }).strict();
export type FedJoinParams = z.infer<typeof FedJoinParams>;
// §13 addendum: "sshkeys" (between "config" and "tunnel") — the joiner-side ssh-layer credential
// bootstrap (identity key + authorized inviter key + known_hosts). ADDITIVE to the existing
// progression; consumers that render steps generically (a list of {step, ok, error?}) are
// unaffected, and a same-host/loopback join (no bootstrap fields in the blob) never reports it.
export const FED_JOIN_STEPS = ["config", "sshkeys", "tunnel", "handshake", "paired"] as const;
export type FedJoinStep = (typeof FED_JOIN_STEPS)[number];
export type FedJoinStepResult = { step: FedJoinStep; ok: boolean; error?: string };

// fed.cloudflare / fed.cloudflare.up — Plan A of the Cloudflare federation design
// (docs/superpowers/plans/2026-07-28-cloudflare-federation.md). Provisioning-only; the
// consuming side (ssh config generation, CF_ACCESS_CLIENT_* env injection) is Plan B.
export const CloudflareProvisionStatusSchema = z.object({
  installed: z.boolean(),
  provisioned: z.boolean(),
  hostname: z.string().nullable(),
  tunnelHealth: z.enum(["inactive", "degraded", "healthy", "down", "unknown"]),
  selfprobe: z.enum(["passed", "failed", "pending"]),
  accessTokenExpiry: z.number().nullable(),
}).strict();
export type CloudflareProvisionStatus = z.infer<typeof CloudflareProvisionStatusSchema>;

export const FedCloudflareUpParamsSchema = z.object({
  apiToken: z.string().min(1).optional(),   // omitted on a re-run once already in the Keychain
  domain: z.string().min(1),
}).strict();
export type FedCloudflareUpParams = z.infer<typeof FedCloudflareUpParamsSchema>;

export const FED_CLOUDFLARE_UP_STEPS = [
  "verify-token", "resolve-zone", "create-tunnel", "fetch-tunnel-token",
  "set-ingress", "dns", "access-service-token", "access-app", "start-supervisor", "selfprobe",
] as const;
export type FedCloudflareUpStep = (typeof FED_CLOUDFLARE_UP_STEPS)[number];
export type FedCloudflareUpStepResult = { step: FedCloudflareUpStep; ok: boolean; error?: string };
export type FedCloudflareUpResult = { steps: FedCloudflareUpStepResult[]; status: CloudflareProvisionStatus };
export type FedJoinResult = { steps: FedJoinStepResult[]; paired: string | null };

// fed.peer.grant {engineId, allowSpawn?, accounts?, maxConcurrent?} — an operator action; overlay write.
export const FedGrantParams = z.object({
  engineId: EngineIdSchema,
  allowSpawn: z.boolean().optional(),
  accounts: z.union([z.literal("auto"), z.array(z.string())]).optional(),
  maxConcurrent: z.number().int().positive().optional(),
}).strict();
export type FedGrantParams = z.infer<typeof FedGrantParams>;

// ---------------------------------------------------------------------------
// CONDUCTOR PLAYBOOK — the shared instruction base every conductor spawn uses
// (the app/tui main-session conductor AND engine.ts's per-project conductor).
// Written from real orchestration experience: it teaches a conductor what
// chimera can actually do and the operating rules that make multi-agent work
// reliable (queue-first, never block-wait, deliverTo mailboxes, dependsOn
// chains, answering agent questions, worktree hygiene). ONE source of truth so
// every conductor surface stays in sync.
// ---------------------------------------------------------------------------
export const CONDUCTOR_PLAYBOOK =
  "You are a Chimera conductor: route work to agents, verify outcomes, report back. Goal-focused, results-driven, zero tolerance for bugs — anything you discover broken becomes a briefed task immediately, never left. Never claim success without verification; confirm destructive/outward-facing actions first.\n" +
  "\n" +
  "TOOLS: agent_spawn/agent_send/ask_agent/agent_status/agent_result/agent_tail/agent_interrupt/agent_kill (delegates); role_create (define a role ONCE in the global library) then bind it — team_list/team_create/team_update's roles, job_create's team target, or a one-off agent_spawn's role param, overrides at the binding site — + queue_push (queues auto-drain); workflow_* (gated multi-step); job_* (schedules); dispatch {projectName,prompt,role?} (project routing); subscribe (wake on a topic instead of polling); hook_create/hook_list (standing rules the daemon runs with no agent in the loop); memory_search/memory_add (shared store); ask_human (escalate); answer_question (agents' pending questions); artifact_*/checkpoint_*/usage_query/providers_list/accounts_*. chimera_tools lists the rest — a tool named here that you cannot see is DEFERRED, not missing: chimera_tools finds it, chimera_call runs it with the same args. Never work around a chimera tool by driving its daemon socket or RPC layer directly.\n" +
  "\n" +
  "RULES (one line each):\n" +
  "- MEMORY WHEN YOU NEED IT: memory_search whenever you need something the work in front of you can't tell you — a past decision's why, another system's behaviour, a prior root cause — before the web or a guess. Not a startup ritual: searching out of habit costs the whole fleet for answers most agents never needed. memory_add (decision|fact) every durable decision or lesson, with a title. NEVER a second copy: memory_add refuses a restatement and names the record to memory_edit instead — that refusal is the expected path, not an error.\n" +
  "- GROUND TRUTH ONLY: never state as fact anything you have not read from real data (a file, a command's output, a real tool/API result) or a confirmed memory — and never let an agent you briefed do it either. \"I don't know, here is how to find out\" is a correct answer; a plausible invention written into shared memory becomes the whole fleet's wrong answer.\n" +
  "- QUEUE-FIRST: hand real work to a purpose-fit team via queue_push/assign; spawn ad-hoc only for quick one-offs.\n" +
  "- NEVER BLOCK-WAIT: set deliverTo:<your agentId> so results push to your mailbox; keep serving the user, don't sit in agent_wait.\n" +
  "- SUBSCRIBE, DON'T POLL: for any other daemon-visible state (gate verdict, task done, queue drained, memory added), subscribe {topic, filter, once:true} and end your turn — the mailbox signal wakes you; never poll in a loop.\n" +
  "- AUTOMATE THE RECURRING: a subscription wakes YOU once; a hook_create rule is standing automation the daemon runs forever with no agent in the loop. Tag tasks you intend to route or audit (queue_push tags:[\"gate:coverage\"]) — tags are what a hook/subscription filter matches on.\n" +
  "- PARALLELIZE independent tasks; SERIALIZE dependent ones with dependsOn — never push a dependent task unchained.\n" +
  "- ON FAILURE: read agent_result/agent_status for the ROOT CAUSE, fix the brief, re-push with the same dependsOn — never blindly retry.\n" +
  "- BRIEFS = scope + ground truth (files/lines) + acceptance + verify steps. Nothing else.\n" +
  "- TOKEN ECONOMY — minimum talk, maximum work, minimum deliberation: decide and act instead of narrating options you will not take, and never re-derive what you already know. Briefs, reports and agent-to-agent messages lead with the outcome and carry detail only where it changes the reader's next action; never restate context the recipient can memory_search. Ask the operator only what you genuinely cannot decide yourself.\n" +
  "- PROPAGATE THAT DISCIPLINE: token economy, memory-first and ground-truth-only are not yours alone. Every role you role_create, every team you team_create and every brief you push inherits them — write them into the role's instructions rather than hoping. An agent you spawned that talks more than it works, re-derives what memory already held, or reports a guess as a finding is your bug, not its own.\n" +
  "- ROLE-FIRST, NEVER A NEAR-DUPLICATE: role_list BEFORE you write instructions inline or role_create anything. If a library role is close, BIND it and override the difference — you can override any spec field at the binding: model, effort, permissionProfile, isolation, cwd, account, maxTurns, and instructions itself. All three binding sites take the same {role, overrides} shape: agent_spawn's `role` + the spec fields you set, a team's roles map, and a job target. role_create only when nothing in the library is close — a second \"frontend\" role that differs by a model and one prompt line is the library rotting, and every copy drifts from the others the moment one is edited.\n" +
  "- DIRECT COORDINATION: for live overlap between concurrent agents, agent_send the teammate directly (file overlap, landing order) — memory is for durable facts, not live coordination.\n" +
  "- WORKTREE HYGIENE: workers land on main themselves; never run manual `git worktree` cleanup while agents are live.";

// ---------------------------------------------------------------------------
// INSTANT-DEFAULT-SPAWN: the shared prompt/instructions for the app+tui "+ spawn" plain-
// click / "new" palette verb — a running agent on defaults, no form. ONE source of truth
// (same rationale as CONDUCTOR_PLAYBOOK above) so app's commands.agents.ts and tui's
// store.ts spawn byte-identical specs, not two copies that drift.
//
// The placeholder prompt is never actually SENT as a turn (resumeOnly:true + resume:null —
// same "fresh but idle" contract core/engine.ts's spawnMainConductor already relies on for
// the one main-conductor seat); it exists only so AgentSpecSchema's non-empty prompt
// validation passes.
export const DEFAULT_SESSION_PLACEHOLDER_PROMPT = "(new chat session — waiting for the operator's first message)";

// A fixed, spec-setting-shaped string (no per-instance-unique cwd/branch/sha baked in) —
// same SAFE-1 cache-prefix-safety reasoning AGENT-AUTONOMY's instruction line already
// established: every default-spawned agent gets the byte-identical prompt, so it's still a
// shared cache prefix across the fleet. Tells the agent to spend rename_self's one allowed
// move (renameAgent is one-shot — see supervisor.ts's displayLabelPinned) once it actually
// knows what the conversation is about, not before.
//
// LIVE-PROOF FINDING (this task, real claude-sonnet-5 spawn against a scratch cwd): the
// original phrasing here ("once your first reply makes clear... call rename_self") was
// treated as a skippable afterthought — a real model asked a concrete question (a Lisbon
// itinerary) just answered it and never called the tool, `num_turns:1, stop_reason:"end_turn"`,
// no tool_use block at all. A default agent is NOT persistent — it gets exactly one turn to
// self-name in, so "call it after replying" loses to "just answer the question" every time.
// Fixed by making the call a MANDATORY FIRST STEP of the turn (not a post-hoc courtesy) and
// naming the concrete cost of skipping it. Re-verified live after this change.
export const DEFAULT_SESSION_INSTRUCTIONS =
  "You are a fresh, ad-hoc chat session with a generic placeholder name (e.g. \"witty-walrus\") — no path bound yet. " +
  "REQUIRED FIRST STEP, before you do anything else: as soon as the operator's first message tells you what this " +
  "conversation is about, call rename_self with a short, descriptive name for it — do this before writing your " +
  "reply, not after. This is not optional or a courtesy: skip it and the operator is stuck looking at a random " +
  "generated name (like \"witty-walrus\") in their fleet list forever, since you only get ONE chance at this — you " +
  "are not a persistent session. rename_self is a one-shot move: call it exactly once, right at the start, and " +
  "never again — it silently no-ops if the operator already gave you an explicit name or you already renamed " +
  "yourself, so if you're unsure whether you already did it, it's always safe to call again. If this conversation " +
  "turns out to need a real project directory, tell the operator you can be relocated there (agent_rebind) instead " +
  "of trying to work around the missing path yourself.";

// SKILL-DISCOVERY — finding and loading a skill at the moment it is needed.
//
// Skills are the one capability that lean context cannot simply defer: the SDK's `skills` option is
// a context filter that REJECTS an unlisted skill at the Skill tool, unlike foreign MCP tools
// (mcp_store_tools) or chimera's own deferred tools (chimera_tools), which stay callable. So
// chimera reads the SKILL.md itself — the Skill tool's whole job is to put that text in front of
// the model, and reading a file is something the daemon can do without the allowlist's permission.
export const SkillSearchRequestSchema = z.object({
  query: z.string().min(1),
  /** The calling agent, so the daemon can also index its PROJECT's own skills. Resolved to a cwd
   *  server-side rather than taken as a path: a caller does not get to point the index anywhere. */
  agentId: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
}).strict();

export const SkillSearchResponseSchema = z.object({
  skills: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    source: z.string(),
  })),
  /** How many skills exist in total — so a caller with no hits can tell "none match" from
   *  "nothing is indexed", which are different problems. */
  indexed: z.number().int(),
}).strict();

export const SkillReadRequestSchema = z.object({
  skill: z.string().min(1),
  agentId: z.string().optional(),
}).strict();

export const SkillReadResponseSchema = z.object({
  found: z.boolean(),
  id: z.string().nullable(),
  name: z.string().nullable(),
  /** The SKILL.md, verbatim. Null on a miss — never a nearest match, which would silently run the
   *  wrong instructions. */
  text: z.string().nullable(),
}).strict();

// TERMINAL-READBACK — the agent reading the terminal you opened under it.
//
// The PTY lives in the DESKTOP APP (src-tauri/pty.rs), not the daemon, so an agent had no path to
// it at all. The view forwards what it receives here instead: the app is already handed every
// chunk to draw, so the tee costs nothing extra and needs no Rust change.
//
// Text, not bytes. What is stored is what was on the screen — ANSI stripped, control sequences
// gone — because the consumer is a model reading output, not a renderer replaying it.
export const TerminalAppendRequestSchema = z.object({
  agentId: z.string().min(1),
  termId: z.string().min(1),
  title: z.string().max(200).optional(),
  /** Decoded PTY text, escape sequences and all. The app owns DECODING (it has the bytes);
   *  the daemon owns stripping, since it owns what is stored and who reads it. */
  text: z.string(),
}).strict();

export const TerminalAppendResponseSchema = z.object({ ok: z.literal(true) }).strict();

// TERMINAL-WRITE — an agent typing into the terminal the operator opened under it.
//
// The daemon cannot reach the PTY (it lives in the app), so this does not write anything itself:
// it validates and scopes the request, then EMITS it, and the app — which is already subscribed to
// the event stream and already owns the PTY — performs the write. The same asymmetry as the read
// side, in the other direction.
// TERMINAL-TABSTATE — what the app knows about a tab and the daemon cannot see.
//
// Two such facts, and they arrive the same way so they stay one channel rather than two nearly
// identical RPCs: which tab the operator is LOOKING at (a write with no explicit target goes
// there, and guessing wrong types a command into the wrong shell), and what the tab is CALLED.
//
// The name matters more than it looks. It used to reach the daemon only as a field on
// terminal.append, carried from the title captured when the session was created — so renaming a
// tab never reached the daemon at all, and an agent told "write to Deneme-123" could not find it
// while still seeing the old generated name.
//
// UI-only: an agent never calls this. Being able to claim focus would let it redirect its own
// default write target, and being able to rename tabs would let it move another name out from
// under the operator.
export const TerminalTabStateRequestSchema = z.object({
  agentId: z.string().min(1),
  termId: z.string().min(1),
  /** Present when this tab is the one on screen. */
  active: z.boolean().optional(),
  title: z.string().min(1).max(200).optional(),
}).strict();
export const TerminalTabStateResponseSchema = z.object({ ok: z.literal(true) }).strict();

export const TerminalWriteRequestSchema = z.object({
  agentId: z.string().min(1),
  /** A term id or a tab NAME. Omitted targets the agent's ACTIVE tab, which is what "the terminal"
   *  means when the operator is looking at one. */
  terminal: z.string().min(1).optional(),
  /** Sent to the PTY verbatim. No newline is appended — use `key: "enter"` to press Return. */
  text: z.string().max(10_000).optional(),
  /** A NAMED keystroke ("enter", "ctrl-c", "up", "escape", …), sent after `text` when both are
   *  given so one call can type a command and run it.
   *
   *  Named rather than encoded because a model cannot reliably put a raw control byte inside
   *  tool-call JSON: observed live, an agent's Ctrl-C arrived as an empty string and was rejected
   *  for being empty, which reads as the tool being broken rather than the encoding being
   *  impossible. */
  key: z.string().max(32).optional(),
}).strict().refine((v) => (v.text !== undefined && v.text.length > 0) || v.key !== undefined, {
  message: "terminal.write needs text, key, or both",
});

export const TerminalWriteResponseSchema = z.object({
  /** Which terminal it was routed to, resolved from `terminal` or the active tab. Null when the
   *  agent has none open — a write with nowhere to go is reported, never silently dropped. */
  termId: z.string().nullable(),
  delivered: z.boolean(),
}).strict();

export type TerminalWriteRequest = z.infer<typeof TerminalWriteRequestSchema>;

export const TerminalReadRequestSchema = z.object({
  /** Whose terminals. Omitted means the CALLING agent's, which is the only thing an agent may ask
   *  for — see the mcp handler; a UI caller passes it explicitly. */
  agentId: z.string().min(1).optional(),
  /** One terminal, or every terminal this agent has when omitted. */
  termId: z.string().min(1).optional(),
  /** Characters from the END of each terminal — the tail is what "what just happened" means. */
  limit: z.number().int().min(200).max(200_000).default(20_000),
}).strict();

export const TerminalReadResponseSchema = z.object({
  terminals: z.array(z.object({
    termId: z.string(),
    title: z.string().nullable(),
    /** The tail, oldest line first. */
    text: z.string(),
    /** True when output older than `text` was dropped — either by the tail limit or by the
     *  per-terminal cap. Stated rather than silently implied: a model reasoning about a build log
     *  needs to know it is looking at the end of one. */
    truncated: z.boolean(),
    startedAt: z.number(),
    lastAt: z.number(),
  })),
}).strict();

export type TerminalAppendRequest = z.infer<typeof TerminalAppendRequestSchema>;
export type TerminalReadRequest = z.infer<typeof TerminalReadRequestSchema>;
export type TerminalReadResponse = z.infer<typeof TerminalReadResponseSchema>;

export * from "./mcp-tools.js";
export * from "./pricing.js";
export * from "./config-patch.js";
