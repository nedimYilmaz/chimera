import type { AgentSpec, ChimeraMcpCtx, CompactResult, ContentBlock, EventKind, ModelMetadataLookup } from "@chimera/protocol";
import type { McpListenerGrant } from "./mcp-listener.js";

export type { ContentBlock };

export type BackendEvent = { kind: EventKind; data: Record<string, unknown>; raw?: unknown };
export type EventSink = (e: BackendEvent) => void;
export type PermissionRequest = { requestId: string; toolName: string; input: unknown; signal?: AbortSignal };
// WORKTREE-AGENT-WRITES-REACH-MAIN: widened from Promise<boolean> to optionally carry a deny
// REASON. `true` still means allow; `false` still means "deny, generic message" — byte-identical
// to every caller that only ever returned a boolean. A `string` return is a NEW third case:
// deny, and surface this exact text to the agent as the tool-call rejection message, instead of
// a generic "denied by chimera permission policy" that just produces a blind retry against the
// same wrong path. Consumers must check `=== true` (not plain truthiness) to allow, since a
// non-empty string is truthy in JS but means deny.
export type PermissionDecider = (req: PermissionRequest) => Promise<boolean | string>;

// native-CLI-parity Phase 2 (Task DLG1): native interactive dialogs (AskUserQuestion/elicitation),
// mirroring PermissionRequest/PermissionDecider's shape for the blocking dialog round-trip.
export type DialogRequest = { dialogId: string; dialogKind: string; payload: Record<string, unknown>; toolUseId?: string; signal?: AbortSignal };
export type DialogDecision = { behavior: "completed"; result: unknown } | { behavior: "cancelled" };
export type DialogDecider = (req: DialogRequest) => Promise<DialogDecision>;

// IMAGE.PASTE (TUI #7): additive attachment shape threaded through
// AgentHandle.send / AgentSupervisor.send / MailboxMessage / the claude.ts
// content-block builder. Represents one already-base64-encoded image -- the
// SDK's ImageBlockParam has no file:// URL support, so the TUI/mailbox inline
// local files as base64 rather than passing a path through.
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type Image = { mediaType: ImageMediaType; data: string };

// L1-MEASURE (F39): the rungs of the compaction-threshold precedence chain, in priority order —
// the spawn's own value, the account override, the provider override, the shipped per-provider
// default, else "native" (nothing chimera-managed was in force; the backend's own trigger ran).
export type CompactionThresholdSource = "spawn" | "account" | "provider" | "default" | "native";

export type ResolvedAgentSpec = AgentSpec & {
  agentId: string;
  accountName: string;                    // concrete account, after auto-routing
  // F23 D3: widened from "claude" | "codex" — see protocol's AccountConfigSchema.provider
  // for the rationale (runtime registry validation replaces the parse-time enum).
  resolvedProvider: string;
  env: Record<string, string>;            // injected credential + CHIMERA_AGENT_ID + CHIMERA_DEPTH
  depth: number;
  // COMPACTION-THRESHOLD-CONFIG: the effective chimera-managed compaction trigger (tokens)
  // for this spawn's account/provider (AccountRegistry.compactionThresholdFor), or undefined
  // when unset ⇒ every backend's own native/default compaction behavior, unchanged.
  compactionThreshold?: number;
  // L1-MEASURE (F39): WHICH rung of the precedence chain answered for `compactionThreshold`, so a
  // backend can SAY where its trigger came from on the compaction event it emits without
  // re-deriving three levels of config it does not own. Never "native" here: a source is stamped
  // only when a value was resolved, and an unset threshold stamps neither (see supervisor.ts's
  // COMPACTION-THRESHOLD-CLEARED spread) — "native" is the compaction EVENT's value for that case.
  compactionThresholdSource?: CompactionThresholdSource;
  // ADVISOR-TOOL: the resolved advisor model for this spawn (spec, else the daemon default), or
  // undefined for no advisor. claude.ts forwards it as the CLI's --advisor flag.
  advisorModel?: string;
};

// INPROC-CHIMERA-BRIDGE: the minimal surface GenericAgentBackend's in-process MCP bridge needs
// from the Engine — a direct in-process call, bypassing the daemon socket + chimera-mcp child
// process entirely. Structural (not `import type { Engine }`) so this file never depends on
// engine.ts; the real Engine class satisfies it for free via its own handle(method, params).
export interface ChimeraEngineHandle {
  handle(method: string, params: unknown): Promise<unknown>;
  // DYNAMIC-MODEL-METADATA: the layered model-metadata service. Structural (a plain protocol type,
  // no engine.ts import) so the real Engine satisfies it for free via its own getter; lets the
  // boot-time backend accessor in main.ts reach it off the published handle. OPTIONAL so the
  // minimal `{ handle }` test fakes still satisfy the interface — the backend accessor already
  // tolerates undefined (⇒ hardcoded-map fallback).
  readonly modelCatalog?: ModelMetadataLookup;

  // F49 LOOPBACK-MCP: the per-agent grant minter, for a backend whose CLI cannot speak stdio MCP.
  // OPTIONAL and structural for the same reason modelCatalog above is -- an Engine-less test fake
  // simply has none, and the backend then behaves exactly as it does today (withheld, with a
  // reason). Never a raw socket/port: a backend can mint a scoped grant and nothing else.
  readonly mcpListener?: {
    grant(ctx: ChimeraMcpCtx & { agentId: string; provider: string }): Promise<McpListenerGrant | null>;
  };
}

// Lazy accessor, not the handle itself: GenericAgentBackend instances are constructed by
// buildBackends() BEFORE the Engine exists (daemon/src/main.ts builds the backends Map first,
// then constructs Engine from it) — get() is only ever called at spawn time, by which point
// main.ts has published the real Engine into the box this accessor closes over.
export interface ChimeraEngineAccessor {
  get(): ChimeraEngineHandle;
}

// REMOTE-CONTROL: what a provider's live enable/disable round trip hands back. Only
// populated on enable — a disable's response carries nothing to show.
export type RemoteControlHandleResult = Pick<import("@chimera/protocol").RemoteControlStatus, "sessionUrl" | "connectUrl" | "connectionStatus" | "serverName" | "environmentId"> | undefined;

export interface AgentHandle {
  command?(text: string): Promise<string>;
  isTurnActive?(): boolean;
  validateSlash?(text: string): Promise<void>;
  readonly nativeVoice?: NativeVoiceHandle;
  // content: additive (D9) — ordered blocks that, when present, take over building
  // the SDK message content array (images land at their referenced positions
  // instead of bunched after `text`). `text`/`images` stay required/valid on their
  // own for every existing (legacy) caller.
  send(text: string, images?: Image[], content?: ContentBlock[]): Promise<void>;      // deliver one mailbox batch / follow-up turn; images: additive (IMAGE.PASTE)
  interrupt(): Promise<void>;
  steer?(text: string, images?: Image[], content?: ContentBlock[]): Promise<void>;
  kill(): Promise<void>;
  close?(): Promise<void>;                 // Phase 3: gracefully end the input stream (conductor sessions)
  // REMOTE-CONTROL: toggle the provider's native remote-control bridge on THIS live
  // session (claude.ai/code or a provider's mobile/desktop app can then attach to it).
  // Optional and transport-specific: Codex app-server uses its own ephemeral
  // bridge; exec cannot attach a separate `codex remote-control` to its process.
  // `name` is only meaningful when enable:true.
  remoteControl?(enable: boolean, name?: string): Promise<RemoteControlHandleResult>;
  // COMPACTION-OBSERVABILITY: manually trigger context compaction NOW. Optional and
  // transport-specific. Generic providers compact directly; Codex app-server
  // requests native compaction and reports completion asynchronously.
  compact?(): Promise<CompactResult>;
  readonly compactOwner?: "sdk";
  // MANUAL-COMPACT-ANY-PROVIDER: the slash command THIS provider's CLI understands as
  // "compact now", for a backend that owns no compact() of its own. The distinction matters:
  // compact() is chimera performing the compaction; this is chimera ASKING the provider's own
  // agent loop to perform it, the same way an operator typing /compact into the native CLI
  // does. Absent ⇒ nothing to ask, and AgentSupervisor.compact refuses honestly as before.
  // Set by claude.ts (the SDK reports compact_boundary with trigger:"manual", which is exactly
  // this path completing); codex leaves it unset — its compaction is in-binary with no
  // documented exec-mode trigger, and inventing one would produce a silent no-op.
  readonly compactCommand?: string;
}

export interface NativeVoiceHandle {
  planMeeting?(input: string, signal: AbortSignal): Promise<import("@chimera/protocol/meeting-plan").MeetingPlan>;
  start(sdp: string, onState: (state: { transcript?: string; message?: { role: "user" | "assistant"; text: string; final: boolean }; error?: string; closed?: boolean }) => void, context?: import("@chimera/protocol/voice-rooms").VoiceStartContext): Promise<string>;
  text?(text: string, role: "user" | "developer"): Promise<void>;
  stop(): Promise<void>;
}

export interface BackendCapabilities {
  supportsResume: boolean;
  supportsMcpServers: boolean;
  supportsSettingSources: boolean;
  // VOICE S2: mirrors protocol's ProviderCapabilities.realtime. Optional so existing
  // claude/codex/generic/fake capability literals stay untouched — absent means false. S3 sets
  // it explicitly per backend.
  supportsVoiceRealtime?: boolean;
}

export interface AgentBackend {
  readonly provider: string;
  readonly capabilities: BackendCapabilities;
  spawn(spec: ResolvedAgentSpec, sink: EventSink, decidePermission: PermissionDecider, decideDialog?: DialogDecider): AgentHandle;
}
