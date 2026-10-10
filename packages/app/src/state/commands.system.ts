// W6 — System-surface command layer (PLAN §7-W6, coverage B7): the pure logic
// (fuzzy palette scoring, replay paging/turn math, spend thresholds, cooling
// countdowns) + the app-local system store (perf hud, pins, replay, model-card
// open, daemon.status extras the ui-state reducer doesn't fold) + the
// rpc-backed SystemCommands. IMPORT-SAFE for pure unit tests, exactly like
// commands.agents.ts: this module never imports the app store or the rpc
// bridge — App/components hand both in (appStore + rpcCall).
import { useSyncExternalStore } from "react";
import type { McpListenerStatus, NormalizedEvent } from "@chimera/protocol";
import { EffortLevelSchema, type EffortLevel } from "@chimera/protocol";
import type { BudgetResumeResponse } from "@chimera/protocol/contract";
import { ENGINE_TOOL_NAMES, type EngineToolName } from "@chimera/mcp/engine-help";
import { budgetResumeToast, projectHistoricalEvents, type AccountStatus, type PeerStatus, type UiState, type UiStore } from "@chimera/ui-state";
import { TOASTS } from "../copy";
import { overlayTargetAgentId } from "./selectors.workflows";

export type RpcFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

// ---------------------------------------------------------------------------
// system-local store — app-local state the coverage doc marks `ui-state` but
// that @chimera/ui-state (read-only for W6) has no field for. Mirrors
// commands.agents.ts's composerLocal store shape exactly.
// ---------------------------------------------------------------------------

export type Pin = { type: "task" | "agent"; id: string };

export type ReplayLocal = {
  active: boolean;
  loading: boolean;
  /** The full events.jsonl window fetched via events.replay (seq-ordered). */
  events: readonly NormalizedEvent[];
  /** Current turn index (0-based) over turnStarts(events). */
  turn: number;
  /** Exact immutable historical cutoff and its event-derived UI projection. */
  cutoffSeq: number | null;
  projection: UiState | null;
  truncated: boolean;
  sourceAnchor: number | null;
  playing: boolean;
};

export type SystemLocalState = {
  /** daemon.status extras the reducer drops (WD Stage 1 fields, B1). */
  engineId: string | null;
  spendTodayUsd: number | null;
  dailyCapUsd: number | null;
  /** Last measured status-ping RTT (B1 "rtt=periyodik status ping süresi"). */
  rttMs: number | null;
  /** PERF-SPLIT-RTT: rtt alone cannot say WHERE the time went — it is measured around an await in
   * this renderer, so a busy renderer and a busy daemon produce the same number. The daemon stamps
   * these two onto its status reply: how long the engine itself took, and how many bytes were
   * already queued on the shared socket ahead of the reply (events and responses share it, with no
   * backpressure). rtt minus the two is the renderer's own share. Null until a daemon new enough
   * to stamp them answers. */
  serverHandleMs: number | null;
  socketQueuedBytes: number | null;
  perfHudOpen: boolean;
  modelOpen: boolean;
  /** EFFORT: EffortCard open flag, mirrors modelOpen. */
  effortOpen: boolean;
  /** ACCOUNT-SWITCH-LIVE: AccountCard open flag, mirrors modelOpen. */
  accountOpen: boolean;
  /** REMOTE-CONTROL: RemoteControlCard open flag, mirrors modelOpen. */
  remoteControlOpen: boolean;
  pins: readonly Pin[];
  /** Per-peer granted account names (accounts.list {engine}) — AccountsCard
   * federation block; best-effort, {} until the card loads them. */
  peerAccounts: Readonly<Record<string, readonly string[]>>;
  replay: ReplayLocal;
  /** F50.UI: treeId of an airborne budget.resume, else null. Each call writes one audit-ledger
   * record and re-arms the re-pause watermark at whatever is booked at that instant, so a second
   * click is NOT idempotent (QA F50 finding 5b) — the banner's button reads this to disable. */
  budgetResumeInFlight: string | null;
};

const initialReplay: ReplayLocal = { active: false, loading: false, events: [], turn: 0, cutoffSeq: null, projection: null, truncated: false, sourceAnchor: null, playing: false };

const initialSystemLocal: SystemLocalState = {
  engineId: null,
  spendTodayUsd: null,
  dailyCapUsd: null,
  rttMs: null,
  serverHandleMs: null,
  socketQueuedBytes: null,
  perfHudOpen: false,
  modelOpen: false,
  effortOpen: false,
  accountOpen: false,
  remoteControlOpen: false,
  pins: [],
  peerAccounts: {},
  replay: initialReplay,
  budgetResumeInFlight: null,
};

export type SystemLocalStore = {
  getState(): SystemLocalState;
  set(patch: Partial<SystemLocalState>): void;
  subscribe(fn: () => void): () => void;
  reset(): void;
};

export function createSystemLocalStore(): SystemLocalStore {
  let state = initialSystemLocal;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    reset() {
      state = initialSystemLocal;
      for (const fn of listeners) fn();
    },
  };
}

/** The ONE app-wide system-local store (module singleton — pure, no IO). */
export const systemLocal: SystemLocalStore = createSystemLocalStore();

/** React binding — same selector discipline as useStore (read existing refs). */
export function useSystemLocal<T>(selector: (s: SystemLocalState) => T): T {
  return useSyncExternalStore(systemLocal.subscribe, () => selector(systemLocal.getState()));
}

// ---------------------------------------------------------------------------
// REPLAY INTEGRATION SEAM (documented, coverage B7 "replay'de TÜM inputlar
// disabled"): while a replay is active every INPUT-OWNING surface must bow
// out — the Composer disables its textarea/send, decision cards ignore their
// answer chords, kill/spawn actions no-op. W6 ships the seam (these two
// accessors) and wires its OWN surfaces through it; the Composer/decision-card
// owners adopt it by adding `if (isReplayActive()) return;` at their submit/
// answer entry points (or rendering disabled off useReplayActive()). The
// ReplayBar itself owns ←→/space/l via a capture-phase handler while active.
// ---------------------------------------------------------------------------

export function isReplayActive(): boolean {
  return systemLocal.getState().replay.active;
}

export function useReplayActive(): boolean {
  return useSystemLocal((s) => s.replay.active);
}

// ---------------------------------------------------------------------------
// fuzzy subsequence scoring (coverage A7-2: "fuzzy subsequence skoru
// (isim > açıklama)") — pure + unit-tested.
// ---------------------------------------------------------------------------

/** Subsequence score of `query` in `text` (case-insensitive): null when query
 * is NOT a subsequence; otherwise a deterministic integer — +2 per char that
 * starts a word or is consecutive with the previous match, +1 per other
 * matched char, minus the total gap span (so a TIGHT match always beats the
 * same chars scattered across word starts). An empty query scores 0
 * (matches everything). */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0;
  let ti = 0;
  let prev = -2;
  let firstMatch = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi]!, ti);
    if (idx === -1) return null;
    if (idx === 0 || /[\s./_-]/.test(t[idx - 1]!) || idx === prev + 1) score += 2;
    else score += 1;
    if (firstMatch === -1) firstMatch = idx;
    prev = idx;
    ti = idx + 1;
  }
  return score - (prev - firstMatch + 1 - q.length);
}

export type PaletteEntry = {
  /** Stable identity: "builtin:<name>" or the keymap action id. */
  id: string;
  /** Display name — builtins render slash-style ("/kill") per the mock. */
  name: string;
  description: string;
  keyHint?: string;
  kind: "builtin" | "action";
};

/** Rows a palette can show for the keymap table: skip unbound rows, dedupe by
 * action id (first chord wins the hint). Pure — the component passes KEYMAP. */
export function buildPaletteCatalog(
  rows: ReadonlyArray<{ chord: string; action: string; scope: string; label: string; unbound?: boolean }>,
  builtins: ReadonlyArray<{ name: string; description: string; keyHint?: string }>,
): PaletteEntry[] {
  const out: PaletteEntry[] = builtins.map((b) => ({
    id: `builtin:${b.name}`,
    name: `/${b.name}`,
    description: b.description,
    ...(b.keyHint !== undefined ? { keyHint: b.keyHint } : {}),
    kind: "builtin" as const,
  }));
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.unbound || seen.has(r.action)) continue;
    seen.add(r.action);
    out.push({
      id: r.action,
      name: r.action,
      description: r.scope === "global" ? r.label : `${r.label} · ${r.scope}`,
      keyHint: r.chord,
      kind: "action",
    });
  }
  return out;
}

/** Rank the catalog for a live query: name match counts double + a flat name
 * bonus (isim > açıklama), else the description score; non-matches drop.
 * Stable order for ties (original catalog order). */
export function filterPaletteEntries(catalog: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.trim();
  if (!q) return [...catalog];
  const ranked: Array<{ e: PaletteEntry; rank: number; i: number }> = [];
  for (let i = 0; i < catalog.length; i++) {
    const e = catalog[i]!;
    const name = fuzzyScore(q, e.name);
    const desc = fuzzyScore(q, e.description);
    const rank = name !== null ? name * 2 + 100 : desc !== null ? desc : null;
    if (rank !== null) ranked.push({ e, rank, i });
  }
  ranked.sort((a, b) => (b.rank - a.rank) || (a.i - b.i));
  return ranked.map((r) => r.e);
}

// ---------------------------------------------------------------------------
// spend thresholds (B1: "meter renk eşiği: yeşil→sarı %70→kırmızı %90")
// ---------------------------------------------------------------------------

export type SpendTone = "success" | "warn" | "danger";

export function spendTone(spendUsd: number, capUsd: number): SpendTone {
  if (!Number.isFinite(capUsd) || capUsd <= 0) return "success";
  const r = spendUsd / capUsd;
  if (r >= 0.9) return "danger";
  if (r >= 0.7) return "warn";
  return "success";
}

// ---------------------------------------------------------------------------
// cooling countdown math (B7: "cooling countdown saniyede iner")
// ---------------------------------------------------------------------------

/** Remaining cooldown as the AccountsCard's "3m 12s" (mock line 338). Zero or
 * a past deadline reads "0s". */
export function coolingLong(coolingUntil: number, now: number): string {
  const left = Math.max(0, coolingUntil - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Remaining cooldown as the top-bar chip's ticking "m:ss" (build item 13). */
export function coolingMSS(coolingUntil: number, now: number): string {
  const left = Math.max(0, coolingUntil - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// replay paging + turn stepping (B7 replay bar; WD Stage 1 events.replay)
// ---------------------------------------------------------------------------

/** events.replay pages by `limit`: a FULL batch means more may follow — the
 * next window starts after the batch's last seq. null = exhausted. Pure. */
export function nextReplayPage(batch: ReadonlyArray<{ seq: number }>, limit: number): number | null {
  if (batch.length < limit) return null;
  const last = batch[batch.length - 1];
  return last ? last.seq + 1 : null;
}

/** BACKWARD paging (F05 EventsScreen): to fetch the page of events OLDER than
 * the oldest one currently in view, request a forward window that ENDS just
 * before `oldestSeq`. Returns the {fromSeq, limit} for events.replay, or null
 * when nothing older can exist (oldestSeq ≤ 1, seqs being 1-based). The caller
 * keeps only the returned events with seq < oldestSeq (the window's tail may
 * overlap) and treats an all-overlap/empty result as exhaustion. Pure. */
export function olderPageRequest(oldestSeq: number, limit: number): { fromSeq: number; limit: number } | null {
  if (oldestSeq <= 1) return null;
  return { fromSeq: Math.max(1, oldestSeq - limit), limit };
}

const TURN_BOUNDARY_KINDS = new Set(["result", "turn_complete"]);

/** Start indices of each TURN over the replayed log: a turn ends at every
 * result/turn_complete event (coverage B7: "◀▶ turn-step over result/
 * turn_complete boundaries"). Empty log → []. A trailing boundary closes the
 * final turn without opening an empty one. */
export function turnStarts(events: ReadonlyArray<{ kind: string }>): number[] {
  if (events.length === 0) return [];
  const starts: number[] = [0];
  for (let i = 0; i < events.length - 1; i++) {
    if (TURN_BOUNDARY_KINDS.has(events[i]!.kind)) starts.push(i + 1);
  }
  return starts;
}

export function turnCount(events: ReadonlyArray<{ kind: string }>): number {
  return turnStarts(events).length;
}

/** Clamp-stepped turn index (◀ / ▶ / ◀◀ / ▶▶ share this). */
export function stepTurn(events: ReadonlyArray<{ kind: string }>, turn: number, delta: number): number {
  const count = turnCount(events);
  if (count === 0) return 0;
  return Math.min(count - 1, Math.max(0, turn + delta));
}

/** The [start, end] event-index window of one turn (end inclusive). */
export function turnWindow(events: ReadonlyArray<{ kind: string }>, turn: number): { start: number; end: number } {
  const starts = turnStarts(events);
  if (starts.length === 0) return { start: 0, end: -1 };
  const t = Math.min(starts.length - 1, Math.max(0, turn));
  const start = starts[t]!;
  const end = t + 1 < starts.length ? starts[t + 1]! - 1 : events.length - 1;
  return { start, end };
}

// ---------------------------------------------------------------------------
// MCP tool catalog (PARITY WS-F). There is NO daemon "engine_help" RPC
// (engine_help is a static MCP-server self-description). F07 forbids hand-written
// tool lists: the catalog's membership + order are GENERATED from the shared
// source of truth — ENGINE_TOOL_NAMES in @chimera/mcp/engine-help, the same list
// server.ts serves. Only the per-tool PRESENTATION metadata below is hand-authored
// (kind/fields/rpc/notes), keyed by tool name; a name the engine adds with no
// metadata — or a phantom entry the engine doesn't serve — fails the drift test.
// engine-help.ts is a pure, zero-import subpath, so importing it never connects
// the MCP client (the app must not, and does not, pull in the server wiring).
// ---------------------------------------------------------------------------

export type McpFieldType = "string" | "number" | "boolean" | "enum";

export type McpField = {
  key: string;
  label: string;
  type: McpFieldType;
  required?: boolean;
  integer?: boolean;
  options?: readonly string[];
  hint?: string;
};

export type McpBuildResult = { params?: Record<string, unknown>; error?: string };

export type McpTool = {
  name: string;
  description: string;
  kind: "flat" | "raw" | "none";
  rpc?: string;
  fields?: readonly McpField[];
  rawTemplate?: string;
  note?: string;
  build?: (values: Record<string, string>) => McpBuildResult;
};

const PROFILE_OPTS = ["readOnly", "acceptEdits", "full"] as const;
const ON_PERM_OPTS = ["auto", "poke:caller", "tui"] as const;
// EFFORT-ONE-SOURCE: derived, never restated.
const EFFORT_OPTS: readonly EffortLevel[] = EffortLevelSchema.options;
const TURN_LIMIT_OPTS = ["soft", "fail"] as const;   // AGENT-RESUME-TOOLS: agent_resume turnLimitPolicy
// F25: the three review-finding severities, mirroring the daemon's own enum (protocol
// contract.ts ReviewFindingAddRequestSchema) so the palette rejects a typo before sending.
const REVIEW_SEVERITY_OPTS = ["note", "warning", "blocking"] as const;
const POLICY_MODE_OPTS = ["allow", "ask", "deny"] as const;
const USAGE_GROUP_BY_OPTS = ["team", "agent", "account", "model", "job"] as const;
const USAGE_BUCKET_OPTS = ["day"] as const;
const JOURNAL_OUTCOME_OPTS = ["passed", "failed", "retried", "open"] as const;
const CHECKPOINT_TRIGGER_OPTS = ["task_start", "destructive_bash", "manual"] as const;

// Per-tool PRESENTATION metadata, keyed by the engine tool name — the ONLY
// hand-authored part now. Typed `Record<EngineToolName, …>`, so the COMPILER
// forces an entry for every engine tool and rejects any phantom key; membership +
// order come from ENGINE_TOOL_NAMES. (Kept in lockstep with the TUI's mcpTools.ts.)
type McpPresentation = Omit<McpTool, "name">;

const PRESENTATION: Record<EngineToolName, McpPresentation> = {
  agent_fork_capabilities: { description: "Conversation branch capabilities", kind: "raw", rpc: "agent.forkCapabilities", rawTemplate: '{"agentId":""}' },
  agent_fork: { description: "Branch conversation with a new task", kind: "raw", rpc: "agent.fork", rawTemplate: '{"agentId":"","mode":"snapshot","task":""}' },
  context_link_create: { description: "Share an explicit immutable source snapshot", kind: "raw", rpc: "contextlink.create", rawTemplate: '{"from":{"kind":"agent-summary","ref":""},"toAgentId":""}' },
  canvas_get: { description: "Read project canvas", kind: "flat", rpc: "canvas.get", fields: [{ key: "projectId", label: "project", type: "string", required: true }] },
  context_link_list: { description: "List scoped context snapshots", kind: "raw", rpc: "contextlink.list", rawTemplate: "{}" },
  context_link_get: { description: "Read an allowed snapshot", kind: "flat", rpc: "contextlink.get", fields: [{ key: "id", label: "id", type: "string", required: true }] },
  context_link_revoke: { description: "Revoke a snapshot and delete its shared body", kind: "flat", rpc: "contextlink.revoke", fields: [{ key: "id", label: "id", type: "string", required: true }] },
  issues_source_list: { description: "GitHub issues: sourceList", kind: "raw", rpc: "issues.sourceList", rawTemplate: '{}' },
  issues_source_upsert: { description: "GitHub issues: sourceUpsert", kind: "raw", rpc: "issues.sourceUpsert", rawTemplate: '{"projectId":"","repo":"owner/repo"}' },
  issues_source_remove: { description: "GitHub issues: sourceRemove", kind: "raw", rpc: "issues.sourceRemove", rawTemplate: '{"sourceId":""}' },
  issues_sync: { description: "GitHub issues: sync", kind: "raw", rpc: "issues.sync", rawTemplate: '{"sourceId":""}' },
  issues_link_list: { description: "GitHub issues: linkList", kind: "raw", rpc: "issues.linkList", rawTemplate: '{}' },
  issues_post_comment: { description: "GitHub issues: postComment", kind: "raw", rpc: "issues.postComment", rawTemplate: '{"taskId":"","body":"","phase":"preview"}' },

  voice_room_delete: { description: "Delete an ended room definition; retain agent history", kind: "flat", rpc: "voice.room.delete", fields: [{ key: "roomId", label: "roomId", type: "string", required: true }] },
  voice_room_create: { description: "Prepare a meeting (desktop consent required)", kind: "raw", rpc: "voice.room.create", rawTemplate: '{"name":"Planning","agentIds":[],"agenda":""}' },
  voice_room_list: { description: "List meeting rooms", kind: "flat", rpc: "voice.room.list", fields: [] },
  voice_room_update: { description: "Edit a meeting roster and request renewed consent", kind: "raw", rpc: "voice.room.update", rawTemplate: '{"roomId":"","revision":1,"spec":{"name":"Planning","agentIds":[],"agenda":""}}' },
  voice_room_end: { description: "End meeting audio; keep coding work running", kind: "flat", rpc: "voice.room.end", fields: [{ key: "roomId", label: "roomId", type: "string", required: true }] },
  daemon_status: { description: "Chimera daemon health and agent counts", kind: "flat", rpc: "daemon.status", fields: [] },
  // TOOL-CATALOG-IS-DERIVED: these two existed in MCP_TOOL_TABLE but were absent from the old
  // hand-written ENGINE_TOOL_NAMES, so this palette never listed them. Deriving the name list
  // from the table is what surfaced them — the compiler now refuses a palette that omits a real
  // tool, which is the check that was missing.
  main_conductor_status: { description: "The daemon-owned MAIN conductor's status — the one persistent, project-less orchestrator seat", kind: "flat", rpc: "main.conductor.status", fields: [] },
  main_conductor_ensure: { description: "Ensure the MAIN conductor is running (idempotent; resumes its prior session when known)", kind: "flat", rpc: "main.conductor.ensure", fields: [] },
  accounts_list: { description: "List configured accounts (name/provider/auth type only)", kind: "flat", rpc: "accounts.list", fields: [] },
  providers_list: { description: "List the provider catalog with each provider's connection state", kind: "flat", rpc: "providers.list", fields: [] },
  providers_models: {
    description: "List available models for one provider (live when a usable account exists, else the catalog fallback)",
    kind: "flat", rpc: "providers.models",
    fields: [
      { key: "provider", label: "provider", type: "string", required: true },
      { key: "account", label: "account", type: "string", hint: "(optional — defaults to the first configured account for this provider)" },
    ],
  },
  agent_spawn: {
    description: "Spawn a delegate agent (returns immediately)", kind: "raw", rpc: "agent.spawn",
    rawTemplate: '{"spec":{"prompt":"","cwd":""}}',
    note: "nested spec/orchestration — edit the raw JSON params for the agent.spawn RPC.",
  },
  spawn_tool_surface: {
    description: "Token cost of the chimera MCP tool grant a spawn would get, before spawning it — plus what chimera cannot price (settings, plugins, foreign MCP servers) and the measured first-turn cache write of comparable past spawns. An estimate, never a policy: nothing is dropped and no default changes.",
    kind: "raw", rpc: "agent.estimateToolSurface",
    rawTemplate: '{"orchestration":true,"autonomy":"ask","conductor":false,"settingSources":[],"mcpServers":[],"cwd":"","role":""}',
    note: "mirrors the spawn's own orchestration/autonomy/conductor/settingSources/mcpServers, or pass cwd/role to resolve those server-side the way supervisor.spawn would — edit the raw JSON params for the agent.estimateToolSurface RPC.",
  },
  agent_send_many: {
    description: "Send the same text to several agents at once", kind: "flat", rpc: "agent.sendMany",
    fields: [{ key: "agentIds", label: "agent ids (comma-separated)", type: "string", required: true }, { key: "text", label: "text", type: "string", required: true }],
  },
  agent_resume_many: {
    description: "Resume several finished agents with a shared brief", kind: "flat", rpc: "agent.resumeMany",
    fields: [{ key: "agentIds", label: "agent ids (comma-separated)", type: "string", required: true }, { key: "prompt", label: "brief", type: "string", required: true }],
  },
  agent_resume: {
    description: "Resume a terminal agent in its existing worktree + session with a new brief", kind: "flat", rpc: "agent.resume",
    fields: [
      { key: "agentId", label: "agentId", type: "string", required: true },
      { key: "prompt", label: "prompt", type: "string", required: true },
      { key: "maxTurns", label: "maxTurns", type: "number", integer: true, hint: "(optional)" },
      { key: "turnLimitPolicy", label: "turnLimitPolicy", type: "enum", options: TURN_LIMIT_OPTS, hint: `(optional: ${TURN_LIMIT_OPTS.join("/")}, default soft)` },
      { key: "deliverTo", label: "deliverTo", type: "string", hint: "(optional)" },
    ],
  },
  agent_list: { description: "List all agents", kind: "flat", rpc: "agent.list", fields: [] },
  agent_find: {
    description: "Find agent(s) by displayLabel (name), not account", kind: "flat", rpc: "agent.find",
    fields: [
      { key: "q", label: "q", type: "string", required: true },
      { key: "live", label: "live", type: "boolean", hint: "(optional, default true = running only)" },
      { key: "limit", label: "limit", type: "number", integer: true, hint: "(optional, default 20)" },
    ],
  },
  agent_status: { description: "Status of one agent", kind: "flat", rpc: "agent.status", fields: [{ key: "agentId", label: "agentId", type: "string", required: true }] },
  agent_result: { description: "Final result of one agent", kind: "flat", rpc: "agent.result", fields: [{ key: "agentId", label: "agentId", type: "string", required: true }] },
  agent_wait: {
    description: "Block until the agent finishes (bounded)", kind: "none",
    note: "blocking RPC — would freeze the palette; poll with agent_status / agent_result instead.",
  },
  agent_tail: {
    description: "Recent normalized events", kind: "flat", rpc: "agent.tail",
    fields: [{ key: "agentId", label: "agentId", type: "string", hint: "(optional)" }, { key: "n", label: "n", type: "number", integer: true, hint: "(optional)" }],
  },
  agent_send: {
    description: "Enqueue a message into an agent's mailbox (returns turnStarted/ack)", kind: "flat", rpc: "agent.send",
    fields: [
      { key: "force", label: "force", type: "boolean", hint: "Explicitly steer/interrupt the active turn" },{ key: "agentId", label: "agentId", type: "string", required: true }, { key: "text", label: "text", type: "string", required: true }],
  },
  agent_permission_respond: {
    description: "Answer a pending permission_request", kind: "flat", rpc: "agent.permissionRespond",
    fields: [{ key: "requestId", label: "requestId", type: "string", required: true }, { key: "allow", label: "allow", type: "boolean", required: true, hint: "(true/false)" }],
  },
  agent_set_permission: {
    description: "Change a running agent's permission mode live", kind: "flat", rpc: "agent.setPermission",
    fields: [
      { key: "agentId", label: "agentId", type: "string", required: true },
      { key: "permissionProfile", label: "permissionProfile", type: "enum", options: PROFILE_OPTS, hint: `(optional: ${PROFILE_OPTS.join("/")})` },
      { key: "permissionRequest", label: "permissionRequest", type: "enum", options: ON_PERM_OPTS, hint: `(optional: ${ON_PERM_OPTS.join("/")})` },
    ],
  },
  agent_kill: { description: "Abort a running agent", kind: "flat", rpc: "agent.kill", fields: [{ key: "agentId", label: "agentId", type: "string", required: true }] },
  agent_forget: {
    description: "Forget explicitly named finished agents and their run history; shared memory is preserved", kind: "raw", rpc: "agent.forget",
    rawTemplate: '{"agentIds":[""]}',
    note: "agentIds is a required array of 1–100 local IDs. Live agents are skipped; this never kills an agent. The operator path omits callerAgentId.",
  },
  worktree_lease_list: { description: "List every held single-writer worktree lease", kind: "flat", rpc: "worktree.leaseList", fields: [] },
  worktree_lease_handoff: {
    description: "Hand off the single-writer worktree lease to another agent (refused unless caller is the current holder)", kind: "flat", rpc: "worktree.leaseHandoff",
    fields: [{ key: "workdirKey", label: "workdirKey", type: "string", required: true }, { key: "toAgentId", label: "toAgentId", type: "string", required: true }],
  },
  worktree_lease_release: {
    description: "Release the single-writer worktree lease (refused unless caller is the current holder)", kind: "flat", rpc: "worktree.leaseRelease",
    fields: [{ key: "workdirKey", label: "workdirKey", type: "string", required: true }, { key: "force", label: "force", type: "boolean", hint: "(optional: true/false)" }],
  },
  worktree_explain_write: {
    description: "Dry-run the worktree write gate: would these paths be refused, and why (read-only)", kind: "raw", rpc: "worktree.explainWrite",
    rawTemplate: '{"targets":[""]}',
    note: "targets is an array (max 16) — edit the raw JSON params. Operator path omits callerAgentId, so it asks as a caller owning no worktree: every leased worktree is foreign.",
  },
  agent_set_model: {
    description: "Change a running agent's model (respawns, resuming session)", kind: "flat", rpc: "agent.setModel",
    fields: [{ key: "agentId", label: "agentId", type: "string", required: true }, { key: "model", label: "model", type: "string", required: true }],
  },
  agent_set_effort: {
    description: "Change a running agent's reasoning effort (respawns, resuming session)", kind: "flat", rpc: "agent.setEffort",
    fields: [{ key: "agentId", label: "agentId", type: "string", required: true }, { key: "effort", label: "effort", type: "enum", options: EFFORT_OPTS, required: true }],
  },
  agent_set_turn_limit: {
    description: "Raise/unbound a running agent's turn budget (respawns, resuming session)", kind: "flat", rpc: "agent.setTurnLimit",
    fields: [
      { key: "agentId", label: "agentId", type: "string", required: true },
      { key: "turnLimitPolicy", label: "turnLimitPolicy", type: "enum", options: TURN_LIMIT_OPTS, hint: "(soft = no hard cap, maxTurns becomes a nominal budget)" },
      { key: "maxTurns", label: "maxTurns", type: "number", integer: true, hint: "(optional: new turn budget)" },
    ],
  },
  agent_set_account: {
    description: "Manually change account/model; across providers compact context into a fresh session under the same agent id", kind: "flat", rpc: "agent.setAccount",
    fields: [{ key: "agentId", label: "agentId", type: "string", required: true }, { key: "account", label: "account", type: "string", required: true }, { key: "model", label: "model", type: "string" }, { key: "acknowledgeCodexFullAccessRisk", label: "acknowledge Codex full access risk", type: "boolean" }],
  },
  agent_handoff: {
    description: "Move a running/paused/stranded agent's context to a FRESH agent on a different provider/account — new Chimera identity (agent_set_account keeps the identity); requires isolation:\"worktree\"", kind: "flat", rpc: "agent.handoff",
    fields: [
      { key: "agentId", label: "agentId", type: "string", required: true },
      { key: "toAccount", label: "toAccount", type: "string", required: true },
      { key: "model", label: "model", type: "string", required: true, hint: "must be valid on the target account — no cross-provider model equivalence" },
      { key: "note", label: "note", type: "string", hint: "(optional, folded into the built context package)" },
    ],
  },
  agent_rebind: {
    description: "Move a running/paused/stranded agent to a NEW working directory — same provider/account/model (the cwd counterpart of agent_handoff). Unlike agent_handoff, does NOT require isolation:\"worktree\" — cheap same-agentId respawn if there's no real history yet, else a portable context package + a fresh lineaged agentId.", kind: "flat", rpc: "agent.rebind",
    fields: [
      { key: "agentId", label: "agentId", type: "string", required: true },
      { key: "cwd", label: "cwd", type: "string", required: true },
      { key: "isolation", label: "isolation", type: "enum", options: ["none", "worktree"], hint: "(optional, default none)" },
      { key: "note", label: "note", type: "string", hint: "(optional, folded into the built context package)" },
    ],
  },
  agent_remote_control: {
    description: "Toggle provider Remote Control (claude.ai/code, provider apps) on a running agent's live session", kind: "flat", rpc: "agent.remoteControl",
    fields: [
      { key: "agentId", label: "agentId", type: "string", required: true },
      { key: "enable", label: "enable", type: "boolean", required: true },
      { key: "name", label: "name", type: "string", hint: "(optional, enable only)" },
    ],
  },
  agent_compact: {
    description: "Manually compact a running agent's context now (refuses honestly if the provider's SDK owns compaction)", kind: "flat", rpc: "agent.compact",
    fields: [{ key: "agentId", label: "agentId", type: "string", required: true }],
  },
  ask_human: { description: "Ask your human/orchestrator a question and BLOCK", kind: "none", note: "needs an agent identity (CHIMERA_AGENT_ID) + blocks; invoke from within an agent." },
  ask_agent: { description: "Ask a SPECIFIC other agent and BLOCK", kind: "none", note: "needs an agent identity (CHIMERA_AGENT_ID) + blocks; invoke from within an agent." },
  ask_team: { description: "Ask a whole team (or role) and collect all answers", kind: "none", note: "needs an agent identity (CHIMERA_AGENT_ID) + blocks; invoke from within an agent." },
  answer_question: {
    description: "Answer a pending agent_question", kind: "raw", rpc: "agent.answerQuestion",
    rawTemplate: '{"questionId":"","answer":{"text":""}}',
    note: "nested answer — edit the raw JSON params for the agent.answerQuestion RPC.",
  },
  // HOOK-3: the wait-elimination primitive. subscriberId is stamped from the calling
  // agent's identity by the MCP tool layer (never a caller-supplied arg), same
  // browse-only-here convention as ask_*/memory_add above.
  subscribe: { description: "Subscribe to a topic, get woken by a mailbox signal when it fires (incl. agent.output + contains:\"ERROR\")", kind: "none", note: "needs an agent identity (CHIMERA_AGENT_ID) to stamp subscriberId — invoke from within an agent." },
  unsubscribe: { description: "Remove one of your subscriptions by id", kind: "none", note: "needs an agent identity (CHIMERA_AGENT_ID) — invoke from within an agent." },
  subscriptions_list: { description: "List your own active subscriptions", kind: "none", note: "needs an agent identity (CHIMERA_AGENT_ID) — invoke from within an agent." },
  // HOOK-CRUD-RPC: durable daemon-evaluated rules — subscribe's standing counterpart. hook_list
  // is a plain flat call; the mutators carry nested rule/patch objects, so they are `raw` here
  // for the same reason answer_question/answer_dialog above are.
  hook_list: { description: "List every installed lifecycle hook rule", kind: "flat", rpc: "hook.list", fields: [] },
  hook_create: {
    description: "Install a lifecycle hook rule (on -> actions), evaluated by the daemon", kind: "raw", rpc: "hook.create",
    rawTemplate: '{"rule":{"name":"","on":"task.state","filter":{"tags":[]},"actions":[{"type":"channel","channel":"toast"}]}}',
    note: "nested rule — edit the raw JSON params for the hook.create RPC.",
  },
  hook_update: {
    description: "Sparse edit of one hook rule (re-validated whole; filter:null clears it)", kind: "raw", rpc: "hook.update",
    rawTemplate: '{"name":"","patch":{"enabled":true}}',
    note: "nested patch — edit the raw JSON params for the hook.update RPC.",
  },
  hook_set_enabled: {
    description: "Mute or unmute one hook rule without editing it", kind: "flat", rpc: "hook.setEnabled",
    fields: [
      { key: "name", label: "rule name", type: "string", required: true },
      { key: "enabled", label: "enabled", type: "boolean", required: true },
    ],
  },
  hook_delete: {
    description: "Permanently remove a hook rule", kind: "flat", rpc: "hook.delete",
    fields: [{ key: "name", label: "rule name", type: "string", required: true }],
  },
  answer_dialog: {
    description: "Answer a native interactive dialog an agent is blocked on", kind: "raw", rpc: "agent.answerDialog",
    rawTemplate: '{"dialogId":"","decision":{"behavior":"cancelled"}}',
    note: "nested decision union — edit the raw JSON params for the agent.answerDialog RPC.",
  },
  // MEMORY (spec §MEMORY): the shared cross-agent note store. The MCP tools stamp
  // the author (CHIMERA_AGENT_ID) and run-scope (treeId) from the calling agent's
  // env, which the palette can't replicate, so they are browse-only here.
  memory_add: { description: "Add a note to the shared cross-agent memory (facts/decisions/todos)", kind: "none", note: "authored as the calling agent (CHIMERA_AGENT_ID) + run-scoped — invoke from within an agent." },
  memory_edit: { description: "Edit a shared-memory note by id (text/tags/kind/pinned)", kind: "none", note: "shared cross-agent memory — pin/unpin from the memory pane; full edits from within an agent." },
  memory_search: { description: "Search the shared cross-agent memory (filters + query; defaults to the caller's project + global)", kind: "none", note: "shared cross-agent memory — browse-only here; search from within an agent." },
  // CHRONICLE-SEMANTIC: browse-only here for the same reason as the memory_* pair — the tools
  // default their SCOPE to the calling agent's own tree, which the palette cannot supply.
  skill_search: { description: "Find a written procedure (review checklist, debugging method, repo workflow) by what it does", kind: "none", note: "skills are not preloaded — search, then skill_read the one you want." },
  skill_read: { description: "Load a skill's full instructions by the id skill_search returned", kind: "none", note: "works for skills the SDK's own Skill tool cannot see." },
  terminal_write: { description: "Type into the terminal the operator opened under you in the app", kind: "none", note: "scoped to the calling agent's own terminals — invoke from within an agent." },
  terminal_read: { description: "Read the output of the terminal the operator opened under you in the app", kind: "none", note: "scoped to the calling agent's own terminals — invoke from within an agent." },
  chronicle_search: { description: "Search your own past work semantically — including turns compaction has dropped from context", kind: "none", note: "scope defaults to the calling agent's tree — invoke from within an agent." },
  chronicle_get: { description: "Read the full text of specific past events, by the seqs chronicle_search returned", kind: "none", note: "the expensive half of the search/get pair — invoke from within an agent." },
  // Ad-hoc sessions design §5: renames the CALLING agent (author-stamped, no palette form) —
  // mirrors memory_add's own kind:"none" convention above.
  rename_self: { description: "Set YOUR OWN displayLabel (a session names itself after its first turn)", kind: "none", note: "affects only the calling agent — invoke from within an agent." },
  // memory_get is a pure scalar read (id → record + resolved links + backlinks), so unlike
  // its author-stamping siblings above it IS palette-issuable, like memory_delete.
  memory_get: {
    description: "Fetch a note by id with its resolved links + backlinks", kind: "flat", rpc: "memory.get",
    fields: [{ key: "id", label: "id", type: "string", required: true }],
  },
  engine_help: { description: "List the chimera tools + depth/permission/ask rules", kind: "none", note: "this catalog IS engine_help — the tools you are browsing." },
  // ROLE-TOOLS-FOR-AGENTS: define a role ONCE in the global library, then bind it by name —
  // to a team (roles below), a job's team target, or a one-off agent_spawn.
  role_create: {
    description: "Define a role in the global library (spawn template, AgentSpec minus prompt)", kind: "raw", rpc: "role.create",
    rawTemplate: '{"spec":{"name":""}}',
    note: "name must be plain letters/digits/_/- ; a dotted name is rejected (reserved for team-role migration). Edit the raw JSON params for the role.create RPC.",
  },
  group_list: { description: "List Inspector groups", kind: "flat", rpc: "group.list", fields: [] },
  group_create: { description: "Create an Inspector group", kind: "flat", rpc: "group.create", fields: [{ key: "name", label: "name", type: "string", required: true }, { key: "color", label: "color", type: "enum", options: ["blue", "green", "amber", "purple", "cyan", "magenta", "red", "teal"] }] },
  group_update: { description: "Rename or recolor an Inspector group", kind: "flat", rpc: "group.update", fields: [{ key: "id", label: "id", type: "string", required: true }, { key: "name", label: "name", type: "string" }, { key: "color", label: "color", type: "enum", options: ["blue", "green", "amber", "purple", "cyan", "magenta", "red", "teal"] }] },
  group_delete: { description: "Delete a group registration without stopping agents", kind: "flat", rpc: "group.delete", fields: [{ key: "id", label: "id", type: "string", required: true }] },
  agent_set_groups: { description: "Replace Inspector group memberships without respawning", kind: "raw", rpc: "agent.setGroups", rawTemplate: '{"agentId":"","groups":[]}', note: "[] clears all memberships; maximum 8 group IDs." },
  agent_add_groups: { description: "Atomically add Inspector memberships without respawning", kind: "raw", rpc: "agent.addGroups", rawTemplate: '{"agentId":"","groups":[]}', note: "Preserves other memberships; maximum 8 total." },
  agent_remove_groups: { description: "Atomically remove Inspector memberships without respawning", kind: "raw", rpc: "agent.removeGroups", rawTemplate: '{"agentId":"","groups":[]}', note: "Preserves other memberships." },
  role_list: { description: "List every role in the global library", kind: "flat", rpc: "role.list", fields: [] },
  role_update: {
    description: "Sparse-patch a library role's spawn template by name", kind: "raw", rpc: "role.update",
    rawTemplate: '{"name":"","patch":{}}',
    note: "applies to future resolutions only (team bindings, job targets, spawns) — running agents are unaffected. Edit the raw JSON params for the role.update RPC.",
  },
  team_create: {
    description: "Create a team (roles map team-local keys to library-role bindings + optional queue)", kind: "raw", rpc: "team.create",
    rawTemplate: '{"spec":{"name":"","roles":{}}}',
    note: "nested spec — each roles[key] is {role, overrides} referencing a role_create'd library entry. Edit the raw JSON params for the team.create RPC.",
  },
  team_list: { description: "List teams with running-agent counts", kind: "flat", rpc: "team.list", fields: [] },
  team_status: { description: "One team's spec, running count and live agents", kind: "flat", rpc: "team.status", fields: [{ key: "name", label: "name", type: "string", required: true }] },
  team_dissolve: { description: "Remove a team (running agents finish)", kind: "flat", rpc: "team.dissolve", fields: [{ key: "name", label: "name", type: "string", required: true }] },
  my_team: { description: "Your OWN team, resolved from CHIMERA_TEAM", kind: "none", note: "resolves your team from CHIMERA_TEAM (an agent env) — N/A from the app." },
  queue_create: {
    description: "Create a task queue", kind: "raw", rpc: "queue.create",
    rawTemplate: '{"spec":{"name":""}}',
    note: "nested spec — edit the raw JSON params for the queue.create RPC.",
  },
  queue_push: {
    description: "Push a task onto a queue", kind: "raw", rpc: "queue.push",
    rawTemplate: '{"queue":"","prompt":""}',
    note: "has nested overrides/dependsOn, an optional per-task workflow binding, and tags (labels hooks/subscriptions filter on) — edit the raw JSON params for the queue.push RPC.",
  },
  queue_status: { description: "Queue spec, per-state counts and task records", kind: "flat", rpc: "queue.status", fields: [{ key: "queue", label: "queue", type: "string", required: true }] },
  queue_cancel_task: { description: "Cancel a pending or blocked task", kind: "flat", rpc: "queue.cancelTask", fields: [{ key: "taskId", label: "taskId", type: "string", required: true }] },
  assign: {
    description: "Assign work to an agent (mailbox) OR a team (via its queue)", kind: "flat", rpc: "assign",
    fields: [
      { key: "agentId", label: "agentId", type: "string", hint: "(agentId XOR team)" },
      { key: "team", label: "team", type: "string", hint: "(agentId XOR team)" },
      { key: "role", label: "role", type: "string", hint: "(optional, with team)" },
      { key: "prompt", label: "prompt", type: "string", required: true },
      { key: "priority", label: "priority", type: "number", integer: true, hint: "(optional)" },
    ],
    build: (v) => {
      const agentId = (v["agentId"] ?? "").trim();
      const team = (v["team"] ?? "").trim();
      const role = (v["role"] ?? "").trim();
      const prompt = (v["prompt"] ?? "").trim();
      const priorityRaw = (v["priority"] ?? "").trim();
      if (!prompt) return { error: "prompt is required" };
      if ((agentId ? 1 : 0) + (team ? 1 : 0) !== 1) return { error: "provide exactly one of agentId or team" };
      const target = agentId ? { agentId } : { team, ...(role ? { role } : {}) };
      let priority: number | undefined;
      if (priorityRaw) {
        const n = Number(priorityRaw);
        if (!Number.isInteger(n)) return { error: "priority must be an integer" };
        priority = n;
      }
      return { params: { target, prompt, ...(priority !== undefined ? { priority } : {}) } };
    },
  },
  // PLAN-PROJECT-CONDUCTOR-ROUTING P2-T2: the queue-first → own-team → global →
  // direct preference resolver. Flat scalar params, no nesting to assemble.
  dispatch: {
    description: "Route work per the project-conductor preference (queue-first → own-team role-match → global team → direct)", kind: "flat", rpc: "dispatch",
    fields: [
      { key: "projectName", label: "projectName", type: "string", hint: "(optional)" },
      { key: "prompt", label: "prompt", type: "string", required: true },
      { key: "role", label: "role", type: "string", hint: "(optional)" },
      { key: "priority", label: "priority", type: "number", integer: true, hint: "(optional)" },
      { key: "teamHint", label: "teamHint", type: "string", hint: "(optional, queue-first only)" },
    ],
  },
  team_update: {
    description: "Update a team's maxConcurrent/purpose/queue/roles", kind: "raw", rpc: "team.update",
    rawTemplate: '{"name":"","patch":{}}',
    note: "a roles patch REPLACES the whole roles record (omitting a role removes it). Adding/changing a role is allowed while members run (applies at the next spawn); removing a role is rejected only while that role has running members or a non-terminal task in the bound queue. Edit the raw JSON params for the team.update RPC.",
  },
  queue_list: { description: "List all queues", kind: "flat", rpc: "queue.list", fields: [] },
  queue_update: {
    description: "Update a queue's retryLimit", kind: "raw", rpc: "queue.update",
    rawTemplate: '{"name":"","patch":{}}',
    note: "nested patch — edit the raw JSON params for the queue.update RPC.",
  },
  queue_delete: {
    description: "Delete a queue by name (refused while it holds any non-terminal task)", kind: "flat", rpc: "queue.delete",
    fields: [{ key: "name", label: "name", type: "string", required: true }],
  },
  queue_requeue: {
    description: "Replay a dead-lettered task: resets its retry budget and reverts it to pending", kind: "flat", rpc: "queue.requeue",
    fields: [{ key: "taskId", label: "taskId", type: "string", required: true }],
  },
  queue_pause: {
    description: "Pause a queue's drain: no new agents spawn from it (running agents finish naturally, pending tasks stay pending). Durable.", kind: "flat", rpc: "queue.pause",
    fields: [{ key: "queue", label: "queue", type: "string", required: true }],
  },
  queue_resume: {
    description: "Resume a paused queue — pending tasks immediately flow to its team agents again", kind: "flat", rpc: "queue.resume",
    fields: [{ key: "queue", label: "queue", type: "string", required: true }],
  },
  queue_edit_task: {
    description: "Edit a pending/blocked task in place (prompt/role/priority/overrides/workflow/tags) with version history", kind: "raw", rpc: "queue.editTask",
    rawTemplate: '{"taskId":"","patch":{"prompt":""}}',
    note: "only pending/blocked tasks are editable; sparse patch (only set fields change); appends a version entry. Nested patch — edit the raw JSON params for the queue.editTask RPC.",
  },
  queue_move_task: {
    description: "Move a pending/blocked task one slot within its queue's drain order", kind: "flat", rpc: "queue.moveTask",
    fields: [
      { key: "taskId", label: "taskId", type: "string", required: true },
      { key: "direction", label: "direction", type: "string", required: true, hint: "(up | down)" },
    ],
  },
  queue_retry_task: {
    description: "Recover a failed/dead_letter task by cloning it into a fresh pending task (no retyping the prompt)", kind: "flat", rpc: "queue.retryTask",
    fields: [{ key: "taskId", label: "taskId", type: "string", required: true }],
  },
  queue_add_dependency: {
    description: "Add an ordering constraint: taskId won't run until dependsOnTaskId is done", kind: "flat", rpc: "queue.addDependency",
    fields: [
      { key: "taskId", label: "taskId", type: "string", required: true },
      { key: "dependsOnTaskId", label: "dependsOnTaskId", type: "string", required: true },
    ],
  },
  task_explain: {
    description: "Why is this task not running? Every dispatch predicate with its verdict, and the first blocker",
    kind: "flat", rpc: "queue.explainTask",
    fields: [{ key: "taskId", label: "taskId", type: "string", required: true }],
  },
  // AGENT-INITIATED-REMEDIATION: only valid on a step configured with onFail:"remediate" —
  // rejected otherwise (no budget to draw from). Takes effect at the calling agent's next
  // turn-complete, not immediately.
  queue_request_remediation: {
    description: "Request that a task jump backward to an earlier step with a correction brief, instead of finishing the current step normally", kind: "flat", rpc: "queue.requestRemediation",
    fields: [
      { key: "taskId", label: "taskId", type: "string", required: true },
      { key: "targetStepId", label: "targetStepId", type: "string", required: true },
      { key: "brief", label: "brief", type: "string", required: true },
    ],
  },
  // F25: a palette call carries no agent identity, so unlike the MCP tool, taskId is required
  // here — there is no "my current task" to fall back to.
  review_get: {
    description: "Read the review filed against a task's diff: findings + accept/changes_requested decision", kind: "flat", rpc: "review.get",
    fields: [{ key: "taskId", label: "taskId", type: "string", required: true }],
  },
  review_finding_add: {
    description: "File a structured review finding against a task's diff (path, severity, body)", kind: "flat", rpc: "review.finding.add",
    fields: [
      { key: "taskId", label: "taskId", type: "string", required: true },
      { key: "path", label: "path", type: "string", required: true },
      // The daemon's schema is an enum, so the palette validates against the same three values
      // before it sends — a typo must fail in the form, not come back as a raw zod error.
      { key: "severity", label: "severity", type: "enum", required: true, options: REVIEW_SEVERITY_OPTS },
      { key: "body", label: "body", type: "string", required: true },
      { key: "hunkId", label: "hunkId", type: "string", hint: "(optional)" },
      { key: "parentId", label: "parentId", type: "string", hint: "(optional)" },
    ],
  },
  review_finding_resolve: {
    description: "Resolve a review finding (blocking findings: author or operator only)", kind: "flat", rpc: "review.finding.resolve",
    fields: [
      { key: "taskId", label: "taskId", type: "string", required: true },
      { key: "findingId", label: "findingId", type: "string", required: true },
    ],
  },
  plugins_list: {
    description: "List discovered plugins/commands (optionally scoped to a project cwd)", kind: "flat", rpc: "plugins.list",
    fields: [{ key: "cwd", label: "cwd", type: "string", hint: "(optional)" }],
  },
  plugins_toggle: {
    description: "Enable/disable a discovered plugin by id", kind: "flat", rpc: "plugins.toggle",
    fields: [{ key: "id", label: "id", type: "string", required: true }, { key: "enabled", label: "enabled", type: "boolean", required: true, hint: "(true/false)" }],
  },
  config_get: { description: "The effective merged config, credential-bearing values redacted", kind: "flat", rpc: "config.get", fields: [] },
  config_patch: {
    description: "JSON-merge-patch onto the effective config", kind: "raw", rpc: "config.patch",
    rawTemplate: '{"patch":{}}',
    note: "free-form JSON-merge-patch — re-validated as the full config before any write; edit the raw JSON params for the config.patch RPC. null at a key DELETES it; to SET a key to null pass the string \"$null\".",
  },
  memory_delete: {
    description: "Delete a shared-memory note by id", kind: "flat", rpc: "memory.delete",
    fields: [{ key: "id", label: "id", type: "string", required: true }],
  },
  // Cluster B: scheduling (job.*) + accounts CRUD + the local peer.status snapshot --
  // all salt-additive proxies of RPCs the engine already exposes (engine.ts, no
  // changes there). accounts_set_key's key field is a plain "string" like every
  // other text field here -- the RPC contract (accounts.setKey) already guarantees
  // the key is never echoed back, so there is nothing extra to mask client-side.
  accounts_add: {
    description: "Register a keychain-backed account (name/provider only -- set its key afterwards with accounts_set_key)",
    kind: "flat", rpc: "accounts.add",
    fields: [
      { key: "name", label: "name", type: "string", required: true },
      { key: "provider", label: "provider", type: "string", hint: "(provider id, e.g. codex or openai; configured preference, otherwise claude)" },
    ],
  },
  accounts_remove: { description: "Remove a configured account", kind: "flat", rpc: "accounts.remove", fields: [{ key: "name", label: "name", type: "string", required: true }] },
  accounts_set_key: {
    description: "Set a keychain-backed account's API key (stored in the OS keychain only, never echoed back)",
    kind: "flat", rpc: "accounts.setKey",
    fields: [
      { key: "name", label: "name", type: "string", required: true },
      { key: "key", label: "key", type: "string", required: true },
    ],
  },
  accounts_test: { description: "Probe whether an account's stored credential is accepted by its provider", kind: "flat", rpc: "accounts.test", fields: [{ key: "name", label: "name", type: "string", required: true }] },
  accounts_uncool: {
    description: "Clear an account's cooldown now and resume agents paused on it with reason session-limit",
    kind: "flat", rpc: "accounts.uncool", fields: [{ key: "name", label: "name", type: "string", required: true }],
  },
  // SUBSCRIPTION-CONNECT: subscription (CLI-subscription) accounts -- claude/codex only,
  // rides the provider CLI's own ambient login, no key needed.
  accounts_add_subscription: {
    description: "Connect a CLI-subscription account (claude or codex) -- registers a subscription account riding the provider CLI's own ambient login",
    kind: "flat", rpc: "accounts.add_subscription",
    fields: [{ key: "provider", label: "provider", type: "enum", options: ["claude", "codex"], required: true }],
  },
  // F23-2A: subscription OAuth (Copilot device-code, Grok Build external-CLI creds; both
  // gated behind config providers.experimental). oauth_start returns a pendingId the caller
  // polls with oauth_finish until it reports connected/error instead of pending.
  accounts_oauth_start: {
    description: "Start a subscription OAuth flow for a provider (e.g. copilot, grok-build)",
    kind: "flat", rpc: "accounts.oauth_start",
    fields: [{ key: "provider", label: "provider", type: "string", required: true }],
  },
  accounts_oauth_finish: {
    description: "Poll or complete a pending accounts_oauth_start exchange by pendingId",
    kind: "flat", rpc: "accounts.oauth_finish",
    fields: [
      { key: "pendingId", label: "pendingId", type: "string", required: true },
      { key: "code", label: "code", type: "string", hint: "(optional -- only authorize-code/PKCE flows consume it)" },
    ],
  },
  job_create: {
    description: "Create a scheduled job: spawn, queue a task, or send a prompt to target:{existingAgentId} (resumes paused agents; killed/missing targets disable the job; success means mailbox acceptance)", kind: "raw", rpc: "job.create",
    rawTemplate: '{"spec":{"name":"","schedule":{"cron":"0 * * * *"},"target":{"team":""},"prompt":""}}',
    note: "nested spec (schedule/target unions) -- edit the raw JSON params for the job.create RPC.",
  },
  job_list: { description: "List all scheduled jobs", kind: "flat", rpc: "job.list", fields: [] },
  job_status: { description: "One job's spec, next run time, recent run history, and this machine's wake-scheduling status. A run with trigger \"sleep-wake\" is a SCHEDULED run that fired late after a machine sleep (latenessMs says how late, coalescedOccurrences how many slots were folded in) — it is a real run, not a miss. wakeScheduling.available:false means the daemon cannot ask the Mac to wake, so schedules are kept late-and-coalesced rather than punctually; wakeScheduling.setupHint names the opt-in operator step.", kind: "flat", rpc: "job.status", fields: [{ key: "name", label: "name", type: "string", required: true }] },
  job_update: {
    description: "Sparse merge-patch a job's schedule/tz/target/prompt/overlapPolicy/maxBudgetUsd/enabled/catchUp/catchUpMaxStalenessMs", kind: "raw", rpc: "job.update",
    rawTemplate: '{"name":"","patch":{}}',
    note: "nested patch (schedule/target unions) -- edit the raw JSON params for the job.update RPC.",
  },
  job_delete: { description: "Delete a scheduled job", kind: "flat", rpc: "job.delete", fields: [{ key: "name", label: "name", type: "string", required: true }] },
  job_run_now: { description: "Manually trigger a job's target right now, bypassing its schedule", kind: "flat", rpc: "job.runNow", fields: [{ key: "name", label: "name", type: "string", required: true }] },
  job_requeue: { description: "Revive a dead-lettered job: clears its dead-letter state, resets the retry budget and re-arms its NEXT occurrence (does not re-run the failed one — use job_run_now)", kind: "flat", rpc: "job.requeue", fields: [{ key: "name", label: "name", type: "string", required: true }] },
  peer_status: { description: "Local snapshot of federation peers' last-known status and cached host-tools summary", kind: "flat", rpc: "peer.status", fields: [] },
  // Cluster C: project.* lifecycle. project_create has a `teams` array param —
  // not a plain scalar — so (per the flat/raw split above) it is "raw"; the
  // other five project_* tools are all-scalar and get a real "flat" form.
  project_create: {
    description: "Register a project — path is optional (omit to mint a fresh blank project under the configured import dir)", kind: "raw", rpc: "project.create",
    rawTemplate: '{"name":"","path":""}',
    note: `teams is a string array; path is optional; permissionProfile (optional: ${PROFILE_OPTS.join("/")}) overrides the global conductor default for this project's conductor, and conductorAccount/conductorModel (optional strings) pin the account and model that conductor is born on — edit the raw JSON params for the project.create RPC.`,
  },
  project_import: {
    description: "Import a project (clone a git URL, or register an existing local dir)", kind: "flat", rpc: "project.import",
    fields: [
      { key: "source", label: "source", type: "string", required: true },
      { key: "name", label: "name", type: "string", hint: "(optional, letters/digits/_/-)" },
      { key: "team", label: "team", type: "string", hint: "(optional, assigned after import)" },
      { key: "permissionProfile", label: "permissionProfile", type: "enum", options: PROFILE_OPTS, hint: `(optional: ${PROFILE_OPTS.join("/")} — this project's conductor default)` },
      { key: "conductorAccount", label: "conductorAccount", type: "string", hint: "(optional — the account this project's conductor is born on)" },
      { key: "conductorModel", label: "conductorModel", type: "string", hint: "(optional — the model that conductor is born on)" },
    ],
  },
  project_list: { description: "List all registered projects with their live session counts", kind: "flat", rpc: "project.list", fields: [] },
  project_status: {
    description: "One project's spec, live sessions, per-team running counts and its conductor status — lazily spawns the project's auto-conductor on first focus",
    kind: "flat", rpc: "project.status", fields: [{ key: "name", label: "name", type: "string", required: true }],
  },
  project_assign_team: {
    description: "Assign an existing team to a project", kind: "flat", rpc: "project.assignTeam",
    fields: [{ key: "project", label: "project", type: "string", required: true }, { key: "team", label: "team", type: "string", required: true }],
  },
  project_archive: { description: "Archive a project (rejected if a live agent's cwd is still under its path)", kind: "flat", rpc: "project.archive", fields: [{ key: "name", label: "name", type: "string", required: true }] },
  // PROJECT-DEFAULT-DIR-AND-DELETE: archive was a one-way name-trap — these close it.
  project_unarchive: { description: "Restore an archived project", kind: "flat", rpc: "project.unarchive", fields: [{ key: "name", label: "name", type: "string", required: true }] },
  project_delete: {
    description: "Permanently remove a project's registration, freeing its name (rejected if a live agent's cwd is still under its path)", kind: "flat", rpc: "project.delete",
    fields: [{ key: "name", label: "name", type: "string", required: true }, { key: "deleteFiles", label: "deleteFiles", type: "boolean", hint: "(optional — also wipe the on-disk dir)" }],
  },
  // PLAN-PROJECT-CONDUCTOR-ROUTING P1-T2: explicit start/stop for a project's
  // lazily-declared conductor (project_status already triggers it implicitly).
  project_conductor_start: {
    description: "Ensure a project's conductor is running (idempotent)", kind: "flat", rpc: "project.conductor.start",
    fields: [{ key: "name", label: "name", type: "string", required: true }],
  },
  project_conductor_stop: {
    description: "Tear down a project's conductor and clear its persisted conductorId", kind: "flat", rpc: "project.conductor.stop",
    fields: [{ key: "name", label: "name", type: "string", required: true }],
  },
  // PROJECT-CONDUCTOR-ACCOUNT: nullable fields — an empty account box CLEARS the pin (back to the
  // global default) rather than meaning "unchanged", which is why neither field is `required`.
  project_set_conductor_account: {
    description: "Pin the account (and optionally model/permissionProfile) this project's conductor is born on — takes effect on the next conductor start", kind: "flat", rpc: "project.setConductorAccount",
    fields: [
      { key: "project", label: "project", type: "string", required: true },
      { key: "account", label: "account", type: "string", hint: "blank = clear the pin" },
      { key: "model", label: "model", type: "string", hint: "blank = clear the pin" },
      { key: "permissionProfile", label: "permissionProfile", type: "string", hint: "readOnly|acceptEdits|full — blank = leave as is; full supports Claude and Codex" },
    ],
    // The generic flat builder OMITS a blank optional, but the RPC's `account` is
    // nullable-and-REQUIRED (null is the meaningful "clear the pin" value), so an
    // omitted key would be a zod error instead of a clear. Blank therefore maps to
    // null for account/model here — this form cannot express "leave the model alone",
    // which the RPC still can (by omitting `model` entirely). permissionProfile is the
    // ASYMMETRIC one: it is a pre-existing per-project setting, so a blank box must not
    // wipe an "acceptEdits" from an operator who only came to change the account.
    build: (v) => {
      const project = (v["project"] ?? "").trim();
      if (!project) return { error: "project is required" };
      const account = (v["account"] ?? "").trim();
      const model = (v["model"] ?? "").trim();
      const profile = (v["permissionProfile"] ?? "").trim();
      if (profile && !["readOnly", "acceptEdits", "full"].includes(profile)) {
        return { error: "permissionProfile must be readOnly, acceptEdits or full" };
      }
      return { params: { project, account: account || null, model: model || null, ...(profile ? { permissionProfile: profile } : {}) } };
    },
  },
  host_tools: { description: "Scan (or return the cached, ~15min TTL) host CLI tools with their per-profile policy", kind: "flat", rpc: "host.tools", fields: [] },
  host_set_policy: {
    description: "Set one tool's policy for a profile ('*' = wildcard)", kind: "flat", rpc: "host.setPolicy",
    fields: [
      { key: "tool", label: "tool", type: "string", required: true },
      { key: "profile", label: "profile", type: "string", required: true, hint: "('*' = wildcard)" },
      { key: "mode", label: "mode", type: "enum", options: POLICY_MODE_OPTS, required: true },
    ],
  },
  // PARITY WS-H: non-destructive esc-to-interrupt — aborts only the in-flight
  // turn (no scheduler sweep, agent stays running), unlike agent_kill which
  // terminates the run. Kept flat/invocable here since (unlike agent_wait/
  // ask_*) it does not block and needs no agent identity.
  agent_interrupt: {
    description: "Abort ONLY the agent's in-flight turn (non-destructive — unlike agent_kill, the agent survives and stays addressable)",
    kind: "flat", rpc: "agent.interrupt", fields: [{ key: "agentId", label: "agentId", type: "string", required: true }],
  },
  // OPERATOR-HOLD: `raw` because the palette's form fields are scalars and these take a LIST of
  // agent ids — the real gesture is multi-select in the agent list (which calls the RPC directly),
  // so the palette exposes the RPC honestly rather than pretending one id is the whole feature.
  // AGENT-RECONFIGURE: `raw` because the patch is a free-shaped object over ten optional spec
  // fields — the palette's scalar form cannot express it, and the real surface is the transcript
  // header's ⚙ panel, which sends the RPC directly.
  agent_set_mode: { description: "Change Claude auto/plan/execute mode without restart", kind: "raw", rpc: "agent.reconfigure", rawTemplate: '{"agentId":"","live":{"executionMode":"execute"}}' },
  agent_reconfigure: {
    description: "Change a live agent's settings in one respawn into its own session — context survives, the process restarts",
    kind: "raw", rpc: "agent.reconfigure", rawTemplate: '{"agentId":"","patch":{}}',
  },
  // SECRET-MANAGER: agent-facing reads only. Storing and granting are operator RPCs with no tool.
  secret_list: { description: "List the operator secrets THIS agent has been granted", kind: "flat", rpc: "secret.listForAgent", fields: [{ key: "agentId", label: "agentId", type: "string", required: true }] },
  secret_get: { description: "Read one granted secret (reveal-mode only) — every read is audited", kind: "flat", rpc: "secret.read", fields: [{ key: "name", label: "name", type: "string", required: true }, { key: "agentId", label: "agentId", type: "string", required: true }] },
  agent_hold: {
    description: "Hold running agents: abort the turn, requeue its input, park the session — resumable, not lost",
    kind: "raw", rpc: "agent.hold", rawTemplate: '{"agentIds":[]}',
  },
  voice_conversation_start: { description: "Request native voice (requires microphone consent in the desktop UI)", kind: "flat", rpc: "voice.native.request", fields: [{ key: "agentId", label: "agentId", type: "string", required: true }, { key: "reason", label: "reason", type: "string" }] },
  voice_conversation_stop: { description: "End voice without stopping the agent's coding work", kind: "flat", rpc: "voice.native.end", fields: [{ key: "agentId", label: "agentId", type: "string", required: true }] },
  agent_release: {
    description: "Release an operator hold: resume each session with full context and deliver what queued while held (force:true also releases a session-limit pause)",
    kind: "raw", rpc: "agent.release", rawTemplate: '{"agentIds":[],"force":false}',
  },
  agent_close: { description: "Close a running agent's stdin", kind: "flat", rpc: "agent.close", fields: [{ key: "agentId", label: "agentId", type: "string", required: true }] },
  // D12: workflow.* — named, versioned, gate-enforced step sequences. Nested steps[]
  // (discriminated-union gates) -- same "raw" treatment as job_create/job_update above.
  workflow_create: {
    description: "Create a task workflow: a named, versioned sequence of gated steps", kind: "raw", rpc: "workflow.create",
    rawTemplate: '{"spec":{"name":"","steps":[{"id":"","title":"","gate":{"kind":"none"}}],"onFail":"halt"}}',
    note: "nested steps[] (gate discriminated union: command/artifact/approval/none) -- edit the raw JSON params for the workflow.create RPC.",
  },
  workflow_list: { description: "List all workflows (latest version of each)", kind: "flat", rpc: "workflow.list", fields: [] },
  workflow_update: {
    description: "Sparse merge-patch a workflow's steps/onFail/retryLimit -- appends a new version, pinned running tasks are unaffected", kind: "raw", rpc: "workflow.update",
    rawTemplate: '{"name":"","patch":{}}',
    note: "nested patch.steps[] (gate discriminated union) -- edit the raw JSON params for the workflow.update RPC.",
  },
  workflow_delete: { description: "Delete a workflow (all versions)", kind: "flat", rpc: "workflow.delete", fields: [{ key: "name", label: "name", type: "string", required: true }] },
  // FEATURE WORKFLOW-RUN-P1: design-and-run an ad-hoc workflow — nested steps[] (same
  // discriminated-union gate shape as workflow_create) plus queue-resolution params.
  workflow_run: {
    description: "Design-and-run an ad-hoc workflow: compiles steps into a fresh ephemeral workflow and pushes ONE task bound to it", kind: "raw", rpc: "workflow.run",
    rawTemplate: '{"spec":{"steps":[{"id":"","title":"","gate":{"kind":"none"}}]},"prompt":""}',
    note: "nested spec.steps[] (gate discriminated union), plus optional queue/provision/overrides -- edit the raw JSON params for the workflow.run RPC.",
  },
  // FEATURE WORKFLOW-RUN-P2: plan-and-run -- like workflow_run but takes only a `goal`;
  // an agent designs the steps itself instead of the caller authoring them.
  workflow_plan: {
    description: "Plan-and-run: an agent designs a workflow to achieve `goal`, then it runs under the same gate/checkpoint/budget machinery as workflow_run", kind: "raw", rpc: "workflow.plan",
    rawTemplate: '{"goal":""}',
    note: "optional queue/role/priority/provision/plannerOverrides(model/account/permissionProfile)/overrides -- edit the raw JSON params for the workflow.plan RPC.",
  },
  // D13: artifact.* — register/browse concrete outputs (report/diff/chart/file/link).
  // artifact_add is agent-scoped (stamped by MCP from CHIMERA_AGENT_ID, same treatment
  // as memory_add above) — not UI-issuable; list/get are plain scalar-param reads.
  artifact_add: { description: "Register an artifact against your current task/run (kind: report/diff/chart/file/link)", kind: "none", note: "task/agent scoped — stamped by CHIMERA_AGENT_ID; invoke from within an agent." },
  artifact_list: {
    description: "List registered artifacts, optionally filtered by taskId/agentId", kind: "flat", rpc: "artifact.list",
    fields: [
      { key: "taskId", label: "taskId", type: "string", hint: "(optional)" },
      { key: "agentId", label: "agentId", type: "string", hint: "(optional)" },
    ],
  },
  artifact_get: { description: "Get one artifact record by id", kind: "flat", rpc: "artifact.get", fields: [{ key: "id", label: "id", type: "string", required: true }] },
  events_replay: {
    description: "Seq-ordered range-read of the persisted event log", kind: "flat", rpc: "events.replay",
    fields: [
      { key: "fromSeq", label: "fromSeq", type: "number", integer: true, hint: "(optional)" },
      { key: "toSeq", label: "toSeq", type: "number", integer: true, hint: "(optional)" },
      { key: "agentId", label: "agentId", type: "string", hint: "(optional, bare local id)" },
      { key: "limit", label: "limit", type: "number", integer: true, hint: "(optional, default 500, max 5000)" },
    ],
  },
  // D14: notify.test — fire a sample notification through a named rule's channel,
  // bypassing its throttle window. Plain scalar param, same treatment as workflow_delete.
  notify_test: {
    description: "Fire a sample notification through a named notify rule's channel immediately", kind: "flat", rpc: "notify.test",
    fields: [{ key: "rule", label: "rule", type: "string", required: true }],
  },
  // D15: usage.query — daemon-side cost/token aggregation over the usage ledger.
  usage_query: {
    description: "Aggregate usage-ledger cost/tokens over a time range, grouped by team/agent/account/model/job", kind: "flat", rpc: "usage.query",
    fields: [
      { key: "from", label: "from", type: "number", required: true, hint: "(epoch ms)" },
      { key: "to", label: "to", type: "number", required: true, hint: "(epoch ms)" },
      { key: "groupBy", label: "groupBy", type: "enum", options: USAGE_GROUP_BY_OPTS, required: true },
      { key: "bucket", label: "bucket", type: "enum", options: USAGE_BUCKET_OPTS, hint: "(optional)" },
    ],
  },
  // F11.2: journal.query — durable step journal, survives the 200-terminal-task
  // eviction and daemon restarts (unlike queue_status).
  journal_query: {
    description: "Read the durable step journal: one entry per workflow step attempt, with model/account/attempt/tokens/cost/gate outcome/timings. from/to default to the last 7 days (retention is 12 months) — pass from explicitly for anything older", kind: "flat", rpc: "journal.query",
    fields: [
      { key: "taskId", label: "taskId", type: "string", hint: "(optional)" },
      { key: "agentId", label: "agentId", type: "string", hint: "(optional)" },
      { key: "stepId", label: "stepId", type: "string", hint: "(optional)" },
      { key: "queue", label: "queue", type: "string", hint: "(optional)" },
      { key: "team", label: "team", type: "string", hint: "(optional)" },
      { key: "outcome", label: "outcome", type: "enum", options: JOURNAL_OUTCOME_OPTS, hint: "(optional)" },
      { key: "from", label: "from", type: "number", hint: "(optional, epoch ms)" },
      { key: "to", label: "to", type: "number", hint: "(optional, epoch ms)" },
      { key: "limit", label: "limit", type: "number", hint: "(optional)" },
      { key: "cursor", label: "cursor", type: "string", hint: "(optional, previous reply's nextCursor)" },
    ],
  },
  // F13.1: history.runs — one filterable join over agents/tasks/job firings.
  history_runs: {
    description: "One list of everything the fleet ran — agents, tasks and job firings — with trigger, model, cost, outcome and duration", kind: "flat", rpc: "history.runs",
    fields: [
      { key: "from", label: "from", type: "number", hint: "(optional, epoch ms — default now-24h)" },
      { key: "to", label: "to", type: "number", hint: "(optional, epoch ms — default now)" },
      { key: "queue", label: "queue", type: "string", hint: "(optional)" },
      { key: "jobName", label: "job", type: "string", hint: "(optional)" },
      { key: "limit", label: "limit", type: "number", hint: "(optional, max 500)" },
    ],
  },
  // D16: checkpoint.* — git-plumbing working-tree snapshots, per agent/task cwd.
  // checkpoint_create is agent-scoped (stamped by MCP from CHIMERA_AGENT_ID, same
  // treatment as artifact_add above) — the agentId field is not UI-supplied.
  checkpoint_status: {
    description: "Checkpoint support/count/latest for a cwd (supported:false for a non-git cwd)", kind: "flat", rpc: "checkpoint.status",
    fields: [{ key: "cwd", label: "cwd", type: "string", required: true }],
  },
  checkpoint_create: {
    description: "Snapshot a cwd's full working tree (tracked + untracked) as a checkpoint", kind: "flat", rpc: "checkpoint.create",
    fields: [
      { key: "cwd", label: "cwd", type: "string", required: true },
      { key: "trigger", label: "trigger", type: "enum", options: CHECKPOINT_TRIGGER_OPTS, hint: "(optional, default manual)" },
      { key: "message", label: "message", type: "string", hint: "(optional)" },
    ],
    note: "task/agent scoped — stamped by CHIMERA_AGENT_ID when invoked from within an agent.",
  },
  checkpoint_list: {
    description: "List checkpoints for a cwd, most recent first", kind: "flat", rpc: "checkpoint.list",
    fields: [{ key: "cwd", label: "cwd", type: "string", required: true }],
  },
  checkpoint_revert: {
    description: "Hard-reset a cwd's working tree to a prior checkpoint", kind: "flat", rpc: "checkpoint.revert",
    fields: [
      { key: "cwd", label: "cwd", type: "string", required: true },
      { key: "id", label: "id", type: "string", required: true },
    ],
  },
  // MCP-STORE: a chimera-level MCP registry -- install a stdio server ONCE and every
  // agent on every provider can discover/call it via mcp_store_tools/mcp_store_call.
  mcp_store_list: { description: "List MCP servers installed in the chimera store", kind: "flat", rpc: "mcpstore.list", fields: [] },
  mcp_store_add: {
    description: "Install a stdio or remote HTTP MCP server into the chimera store", kind: "raw", rpc: "mcpstore.add",
    rawTemplate: '{"name":"","command":"","args":[],"env":{}}',
    note: "args/env are non-scalar — edit the raw JSON params for the mcpstore.add RPC; for a remote server use {\"name\":\"\",\"type\":\"http\",\"url\":\"\"}. (The agent-facing mcp_store_add tool only proposes these disabled and untrusted.)",
  },
  mcp_store_remove: {
    description: "Remove an MCP server from the store (tears down its live daemon connection, if any)", kind: "flat", rpc: "mcpstore.remove",
    fields: [{ key: "name", label: "name", type: "string", required: true }],
  },
  mcp_store_tools: {
    description: "Discover MCP-store tools and their schemas (before mcp_store_call or a native MCP fallback). For app-directed typing, pick the app/window from a fresh list_apps/list_windows/get_window_state and use the exact window target, not a title alone. Laya ranks; Laya confidence never authorizes substituting the frontmost app or desktop, so observe and verify. Deliberate desktop tasks may type globally. Guidance, not an enforced target-identity guarantee.", kind: "flat", rpc: "mcpstore.tools",
    fields: [{ key: "query", label: "query", type: "string", hint: "(optional)" }],
  },
  operator_web_status: { description: "Operator panel availability (read only)", kind: "flat", rpc: "operatorweb.operatorStatus", fields: [] },
  worktree_git_status: { description: "Selected isolated worktree git status", kind: "flat", rpc: "worktree.gitStatus", fields: [], note: "Use Changes or Review working-tree controls; raw params require a target and explicit version checks." },
  worktree_git_diff: { description: "Selected isolated worktree git diff", kind: "flat", rpc: "worktree.gitDiff", fields: [], note: "Use Changes or Review working-tree controls; raw params require a target and explicit version checks." },
  worktree_file_read: { description: "Selected isolated worktree file read", kind: "flat", rpc: "worktree.fileRead", fields: [], note: "Use Changes or Review working-tree controls; raw params require a target and explicit version checks." },
  worktree_file_write: { description: "Selected isolated worktree file write", kind: "flat", rpc: "worktree.fileWrite", fields: [], note: "Use Changes or Review working-tree controls; raw params require a target and explicit version checks." },
  worktree_git_stage: { description: "Selected isolated worktree git stage", kind: "flat", rpc: "worktree.gitStage", fields: [], note: "Use Changes or Review working-tree controls; raw params require a target and explicit version checks." },
  worktree_git_commit: { description: "Selected isolated worktree git commit", kind: "flat", rpc: "worktree.gitCommit", fields: [], note: "Use Changes or Review working-tree controls; raw params require a target and explicit version checks." },
  stt_status: { description: "Local transcription availability (read only)", kind: "flat", rpc: "stt.status", fields: [] },
  agent_resources: { description: "Inspect process CPU and OS memory", kind: "flat", rpc: "agent.resources", fields: [{ key: "agentId", label: "agentId", type: "string", required: true }] },
  host_admission: { description: "Inspect host admission", kind: "flat", rpc: "host.admission", fields: [] },
  health_status: { description: "Inspect agent health, crash counts, circuit breakers and pause reasons to diagnose stalled or repeatedly failing agents. Read-only; does not restart agents.", kind: "flat", rpc: "health.status", fields: [] },
  events_search: { description: "Search retained event text, including errors, with agent/task/kind/time filters. Times are epoch milliseconds. Returns bounded snippets and nextCursor; use events_replay for original events.", kind: "raw", rpc: "events.search", rawTemplate: "{\"query\":\"error\",\"limit\":50}" },
  events_search_export: { description: "Return a sanitized Markdown export of matching retained events as filename and content; does not write files. Use scope to narrow an incident and maxResults (at most 500) to bound the export.", kind: "raw", rpc: "events.searchExport", rawTemplate: "{\"query\":\"error\",\"maxResults\":200}" },
  evidence_get: { description: "Read a queued task's evidence: steps, artifacts and provenance. Useful when a queue task failed or its claimed completion needs verification.", kind: "raw", rpc: "evidence.get", rawTemplate: "{\"taskId\":\"\"}" },
  audit_verify: { description: "Verify the local audit hash chain and report integrity failures. Read-only; does not repair or delete audit records.", kind: "flat", rpc: "audit.verify", fields: [] },
  replay_agents_as_of: { description: "Reconstruct agent states from the saved snapshot plus later events. toSeq bounds later events; it cannot rewind the snapshot. Read-only; does not restart agents.", kind: "raw", rpc: "replay.agentsAsOf", rawTemplate: "{}" },
  chronicle_status: { description: "Inspect the semantic conversation index status and coverage to diagnose missing search results. Does not rebuild the index.", kind: "flat", rpc: "chronicle.status", fields: [] },
  sli_rollup: { description: "Read workflow/task performance: latency, tokens, cost, gate failures and error rates. Filter by taskId, workflow or epoch-millisecond from/to; optionally group by team, provider or workflow.", kind: "raw", rpc: "sli.rollup", rawTemplate: "{}" },
  memory_stats: { description: "Read memory counts and folder statistics to diagnose missing or misplaced notes. Does not read full note bodies.", kind: "flat", rpc: "memory.stats", fields: [] },
  memory_graph: { description: "Inspect memory links and dangling references. Narrow by folder, kind or tags for smaller results; semanticEdges includes similarity links only when the vector index is ready. Use memory_get for individual note bodies.", kind: "raw", rpc: "memory.graph", rawTemplate: "{}" },
  memory_index_status: { description: "Inspect vector memory index readiness and errors. This tool only reads status; it cannot rebuild the index.", kind: "raw", rpc: "memory.index", rawTemplate: "{\"action\":\"status\"}" },
  mcp_store_monitor: { description: "Inspect live desktop computer-use activity metadata: lease owner, busy state, target window and recent tool outcomes. Contains no screenshots, typed text or tool arguments. This does not start the desktop service, grant OS permission or open the preview popup; use mcp_store_tools to check connectivity.", kind: "flat", rpc: "mcpstore.monitor", fields: [] },
  mcp_store_session: {
    description: "Acquire, inspect or release exclusive computer-use control. Desktop tools acquire automatically; release after finishing so another agent can use the desktop. Active calls cannot be stolen; an idle lease expires after five minutes. A busy result means wait, then take a fresh snapshot before acting. The lease establishes ownership, not the intended app/window. Before app-directed typing, verify fresh app/window identity and use the exact window target from the live schema; after expiry/release, observe again. Laya confidence never authorizes desktop/frontmost substitution. Deliberate desktop tasks may use desktop-wide typing. Target selection remains the agent's responsibility; the proxy does not enforce task intent.", kind: "flat", rpc: "mcpstore.session",
    fields: [
      { key: "server", label: "server", type: "string", required: true },
      { key: "action", label: "action", type: "enum", options: ["status", "acquire", "release"], required: true },
    ],
  },
  mcp_store_call: {
    description: "Call one tool on one MCP store server, proxied through the shared daemon connection", kind: "raw", rpc: "mcpstore.call",
    rawTemplate: '{"server":"","tool":"","args":{}}',
    note: "args is a free-form object — edit the raw JSON params for the mcpstore.call RPC.",
  },
  mcp_store_importables: {
    description: "Scan this machine's other claude/codex configs for MCP servers eligible to import into the store", kind: "flat", rpc: "mcpstore.importables", fields: [],
  },
  mcp_store_import: {
    description: "Import a server found by mcp_store_importables into the store (rescan first)", kind: "flat", rpc: "mcpstore.import",
    fields: [
      { key: "source", label: "source", type: "enum", options: ["claude", "codex"], required: true },
      { key: "name", label: "name", type: "string", required: true },
      { key: "as", label: "as", type: "string", hint: "(optional rename)" },
    ],
  },
  mcp_store_set_direct: {
    description: "Toggle a store server's direct flag (native tools vs proxy-only)", kind: "flat", rpc: "mcpstore.setDirect",
    fields: [
      { key: "name", label: "name", type: "string", required: true },
      { key: "direct", label: "direct", type: "boolean", required: true },
    ],
  },
  mcp_store_auth_status: {
    description: "Check which store servers are still authorized (no connection made)", kind: "flat", rpc: "mcpstore.authStatus",
    fields: [
      { key: "name", label: "name", type: "string" },
    ],
  },
  mcp_store_reauth: {
    description: "Start a fresh OAuth authorization for a store server; returns a link a human must open", kind: "flat", rpc: "mcpstore.oauth.start",
    fields: [
      { key: "name", label: "name", type: "string", required: true },
    ],
  },
  // TOKEN-OPT-P2: the discover-then-call pair for the "extended" (admin/CRUD) tools -- not
  // proxied RPCs of their own, so browse-only here like the ask_*/memory_* family above.
  chimera_tools: {
    description: "Discover EXTENDED chimera tools (admin/CRUD) not in an agent's default toolset", kind: "none",
    note: "meta-tool for orchestration-enabled agents — not a direct RPC proxy; invoke from within an agent.",
  },
  chimera_call: {
    description: "Call one EXTENDED chimera tool by name (discovered via chimera_tools) with its args", kind: "none",
    note: "meta-tool for orchestration-enabled agents — not a direct RPC proxy; invoke from within an agent.",
  },
};

// GENERATED, not hand-written (F07): the catalog IS the engine's own tool list,
// in engine_help order, each name paired with its presentation metadata above.
export const MCP_TOOLS: readonly McpTool[] = ENGINE_TOOL_NAMES.map((name) => ({ name, ...PRESENTATION[name] }));

/** SAFETY BOUNDARY (TUI parity): the ONLY RPCs the palette may dispatch. */
export const MCP_INVOKE_RPCS: ReadonlySet<string> = new Set(
  MCP_TOOLS.flatMap((t) => (t.rpc ? [t.rpc] : [])),
);

export function buildFlatParams(fields: readonly McpField[], values: Record<string, string>): McpBuildResult {
  const params: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = (values[f.key] ?? "").trim();
    if (!raw) {
      if (f.required) return { error: `${f.label} is required` };
      continue;
    }
    if (f.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: `${f.label} must be a number` };
      if (f.integer && !Number.isInteger(n)) return { error: `${f.label} must be an integer` };
      params[f.key] = n;
    } else if (f.type === "boolean") {
      if (/^(y|yes|true|1)$/i.test(raw)) params[f.key] = true;
      else if (/^(n|no|false|0)$/i.test(raw)) params[f.key] = false;
      else return { error: `${f.label} must be true or false` };
    } else if (f.type === "enum") {
      if (!f.options?.includes(raw)) return { error: `${f.label} must be one of: ${f.options?.join(", ")}` };
      params[f.key] = raw;
    } else {
      params[f.key] = raw;
    }
  }
  return { params };
}

export function buildToolParams(tool: McpTool, values: Record<string, string>): McpBuildResult {
  if (tool.build) return tool.build(values);
  return buildFlatParams(tool.fields ?? [], values);
}

/** Case-insensitive substring filter over "<name> <description>" (TUI parity —
 * the mcp palette is a browse list, deliberately not the fuzzy ranker). */
export function filterTools(tools: readonly McpTool[], query: string): McpTool[] {
  const q = query.trim().toLowerCase();
  if (q === "") return tools.slice();
  return tools.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// SystemCommands — the rpc-backed command layer (deps injected, like
// commands.agents.ts's AgentCommands).
// ---------------------------------------------------------------------------

const REPLAY_PAGE_LIMIT = 500;
const REPLAY_PAGE_CAP = 200; // bounded safety cap; UI reports truncation instead of claiming live

export class SystemCommands {
  constructor(private store: UiStore, private rpc: RpcFn) {}

  /** Errors surface as lastError (the Toast's danger channel), never throw. */
  private async guarded(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      const message = typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
      this.store.dispatch({ type: "commandError", message });
    }
  }

  /** One daemon.status round-trip: refresh the reducer's accounts/peers AND
   * stash the WD Stage 1 extras (spendTodayUsd/dailyCapUsd/engineId) + the
   * measured rtt in systemLocal. The B1 "periyodik status ping" — App's
   * polling effect calls this. */
  refreshStatus(): Promise<void> {
    return this.guarded(async () => {
      const t0 = performance.now();
      const s = await this.rpc<{
        protocolVersion: number;
        engineId?: string;
        agents: UiState["agentCounts"];
        accounts?: AccountStatus[];
        peers?: PeerStatus[];
        spendTodayUsd?: number;
        dailyCapUsd?: number | null;
        serverHandleMs?: number;
        socketQueuedBytes?: number;
        // F49.UI: the loopback-MCP grant roster. The reducer diffs it poll-to-poll into
        // per-agent "client connected/disconnected" system lines — the listener emits no
        // event of its own, so this poll is the only trace an operator can ever see.
        mcpListener?: McpListenerStatus;
      }>("daemon.status", {});
      const rttMs = performance.now() - t0;
      this.store.dispatch({ type: "daemonStatus", status: s });
      systemLocal.set({
        engineId: typeof s.engineId === "string" ? s.engineId : systemLocal.getState().engineId,
        spendTodayUsd: typeof s.spendTodayUsd === "number" ? s.spendTodayUsd : null,
        dailyCapUsd: typeof s.dailyCapUsd === "number" ? s.dailyCapUsd : null,
        rttMs,
        // PERF-SPLIT-RTT: null rather than 0 when the daemon did not stamp them — an older daemon
        // has not measured zero, it has not measured at all, and a HUD reading "0.0ms handle"
        // would be a confident wrong answer about where the latency is.
        serverHandleMs: typeof s.serverHandleMs === "number" ? s.serverHandleMs : null,
        socketQueuedBytes: typeof s.socketQueuedBytes === "number" ? s.socketQueuedBytes : null,
      });
    });
  }

  /** Status-poll loop (5s; skipped while disconnected). Returns a stopper. */
  startPolling(intervalMs = 5000): () => void {
    void this.refreshStatus();
    const id = setInterval(() => {
      if (this.store.getState().connected) void this.refreshStatus();
    }, intervalMs);
    return () => clearInterval(id);
  }

  /** mod+u / chip click — toggle the AccountsCard (B7 toggle rule; not bound
   * on the agents scope, KEYMAP-REDESIGN letter budget — reachable there via
   * the command palette). Opening
   * loads accounts.list + a fresh status + best-effort per-peer grants. */
  toggleAccounts(): void {
    const open = this.store.getState().accountsOpen;
    this.store.dispatch({ type: "accountsOpen", open: !open });
    if (open) return;
    void this.guarded(async () => {
      const items = await this.rpc<Array<Record<string, unknown>>>("accounts.list", {});
      this.store.dispatch({ type: "accountList", items });
    });
    void this.refreshStatus();
    // federation block: each CONNECTED peer's granted account names.
    for (const p of this.store.getState().peers) {
      if (p.state !== "connected") continue;
      void this.rpc<Array<{ name?: string }>>("accounts.list", { engine: p.engineId })
        .then((accounts) => {
          const names = accounts.map((a) => String(a.name ?? "")).filter(Boolean);
          systemLocal.set({ peerAccounts: { ...systemLocal.getState().peerAccounts, [p.engineId]: names } });
        })
        .catch(() => {}); // best-effort — the row renders without the grants
    }
  }

  /** system.result — RETIRED as a dedicated hotkey (KEYMAP-REDESIGN letter
   * budget); still mouse/palette-reachable. Toggles the ResultCard for the
   * SELECTED agent: fetch agent.result
   * + agent.status into the existing resultDetail state path (ui-state's
   * agentResult action), then open. */
  toggleResult(): void {
    const state = this.store.getState();
    if (state.resultOpen) {
      this.store.dispatch({ type: "resultOpen", open: false });
      return;
    }
    const agentId = state.selectedAgentId;
    if (!agentId) return;
    void this.guarded(async () => {
      const [result, status] = await Promise.all([
        this.rpc<{ state: string; text?: string; costUsd: number }>("agent.result", { agentId }),
        this.rpc<Record<string, unknown>>("agent.status", { agentId }),
      ]);
      this.store.dispatch({ type: "agentResult", agentId, detail: { result, status } });
      this.store.dispatch({ type: "resultOpen", open: true });
    });
  }

  /** mod+d — toggle the ModelCard (needs a selected agent). */
  toggleModel(): void {
    const open = systemLocal.getState().modelOpen;
    if (open) {
      systemLocal.set({ modelOpen: false });
      return;
    }
    if (!overlayTargetAgentId(this.store.getState())) return;
    systemLocal.set({ modelOpen: true });
  }

  /** ModelCard enter — agent.setModel; effective NEXT turn (mock note). */
  applyModel(agentId: string, model: string): Promise<void> {
    return this.guarded(async () => {
      await this.rpc("agent.setModel", { agentId, model });
      systemLocal.set({ modelOpen: false });
      this.store.dispatch({ type: "notice", message: TOASTS.modelApplied(model) });
    });
  }

  /** system.effort — RETIRED as a dedicated hotkey (KEYMAP-REDESIGN letter
   * budget); still mouse/palette-reachable. Toggles the EffortCard (needs a
   * selected agent). Mirrors toggleModel. */
  toggleEffort(): void {
    const open = systemLocal.getState().effortOpen;
    if (open) {
      systemLocal.set({ effortOpen: false });
      return;
    }
    if (!overlayTargetAgentId(this.store.getState())) return;
    systemLocal.set({ effortOpen: true });
  }

  /** EffortCard enter — agent.setEffort; effective NEXT turn. Mirrors applyModel. */
  applyEffort(agentId: string, effort: string): Promise<void> {
    return this.guarded(async () => {
      await this.rpc("agent.setEffort", { agentId, effort });
      systemLocal.set({ effortOpen: false });
      this.store.dispatch({ type: "notice", message: TOASTS.effortApplied(effort) });
    });
  }

  /** system.accountSwitch — RETIRED as a dedicated hotkey (KEYMAP-REDESIGN
   * letter budget); still mouse/palette-reachable. Toggles the AccountCard
   * (needs a selected agent). Mirrors toggleModel. */
  toggleAccount(): void {
    const open = systemLocal.getState().accountOpen;
    if (open) {
      systemLocal.set({ accountOpen: false });
      return;
    }
    if (!overlayTargetAgentId(this.store.getState())) return;
    systemLocal.set({ accountOpen: true });
  }

  /** Manual account/model switch, including cross-provider context transfer. */
  applyAccount(agentId: string, account: string, model?: string, acknowledgeCodexFullAccessRisk?: boolean): Promise<void> {
    return this.guarded(async () => {
      await this.rpc("agent.setAccount", { agentId, account, ...(model ? { model } : {}), ...(acknowledgeCodexFullAccessRisk !== undefined ? { acknowledgeCodexFullAccessRisk } : {}) });
      systemLocal.set({ accountOpen: false });
      this.store.dispatch({ type: "notice", message: TOASTS.accountApplied(account) });
    });
  }

  /** system.remoteControl — RETIRED as a dedicated hotkey (KEYMAP-REDESIGN
   * letter budget); still mouse/palette-reachable. Toggles the
   * RemoteControlCard (needs a selected agent). */
  toggleRemoteControl(): void {
    const open = systemLocal.getState().remoteControlOpen;
    if (open) {
      systemLocal.set({ remoteControlOpen: false });
      return;
    }
    if (!this.store.getState().selectedAgentId) return;
    systemLocal.set({ remoteControlOpen: true });
  }

  // REMOTE-CONTROL: RemoteControlCard's enable/disable toggle — agent.remoteControl.
  // Live, no respawn (when the provider supports it): the reducer folds the RPC
  // result's echo (via the daemon's "status" event) onto agent.remoteControl, which
  // is what the card actually renders — this call's own await just drives the toast
  // and surfaces an unsupported-provider rejection (guarded → lastError) instead of
  // silently doing nothing.
  applyRemoteControl(agentId: string, enable: boolean, acknowledgeTransition = false): Promise<void> {
    return this.guarded(async () => {
      const status = await this.rpc<{ sessionUrl?: string; connectionStatus?: string }>("agent.remoteControl", { agentId, enable, ...(acknowledgeTransition ? { acknowledgeTransition: true } : {}) });
      this.store.dispatch({
        type: "notice",
        message: status?.connectionStatus ? `remote control: ${status.connectionStatus}` : enable ? TOASTS.remoteControlEnabled(status?.sessionUrl) : TOASTS.remoteControlDisabled,
      });
    });
  }

  // COMPACTION-OBSERVABILITY: manual trigger — agent.compact. Unlike applyRemoteControl, a
  // provider chimera doesn't own compaction for (claude/codex) throws CompactionUnsupportedError,
  // which `guarded` routes to lastError (the danger toast) with the honest reason verbatim —
  // this never shows a generic "failed" for what is actually "this provider's SDK owns
  // compaction and exposes no manual trigger". A SUPPORTED backend with nothing droppable
  // returns ok:false WITHOUT throwing (a normal outcome, not an error) — that path renders as
  // an ordinary notice toast via TOASTS.compactResult, not lastError.
  applyCompact(agentId: string): Promise<void> {
    return this.guarded(async () => {
      const result = await this.rpc<{ ok: boolean; message?: string; before?: { chars?: number }; after?: { chars?: number } }>("agent.compact", { agentId });
      this.store.dispatch({ type: "notice", message: TOASTS.compactResult(result) });
    });
  }

  // F50.UI BUDGET-RESUME: the banner's release, moved off the component so it gets the two
  // things a raw `void rpcCall(...)` could not have (QA F50 finding 5): a failure path — errors
  // route through `guarded` to lastError, the danger toast, so a rejected release can never look
  // identical to an ignored click — and a single-flight guard, because each accepted call writes
  // its own budget_resumed audit record and re-arms the watermark at whatever is booked right
  // then, i.e. a double fire is two operator intents on the ledger, not one.
  resumeBudget(treeId: string): Promise<void> {
    if (systemLocal.getState().budgetResumeInFlight !== null) return Promise.resolve();
    systemLocal.set({ budgetResumeInFlight: treeId });
    return this.guarded(async () => {
      try {
        const r = await this.rpc<BudgetResumeResponse>("budget.resume", { treeId, principal: "app" });
        this.store.dispatch({ type: "notice", message: TOASTS.budgetResumed(budgetResumeToast(r)) });
      } finally {
        systemLocal.set({ budgetResumeInFlight: null });
      }
    });
  }

  togglePerfHud(): void {
    systemLocal.set({ perfHudOpen: !systemLocal.getState().perfHudOpen });
  }

  /** mod+i — pin/unpin the SELECTED agent (was ctrl+shift+p — "pin" is a
   * rule-3 mutate example, not destroy, so it moved to plain mod+letter,
   * KEYMAP-REDESIGN; the events/queue-row `mod+p`
   * hook is a LATER pass; the store + bar are target-type-agnostic). */
  togglePinSelected(): void {
    const agentId = this.store.getState().selectedAgentId;
    if (!agentId) return;
    this.togglePin({ type: "agent", id: agentId });
  }

  togglePin(pin: Pin): void {
    const pins = systemLocal.getState().pins;
    const without = pins.filter((p) => !(p.type === pin.type && p.id === pin.id));
    systemLocal.set({ pins: without.length === pins.length ? [...pins, pin] : without });
  }

  /** Replay toggle: open ⇒ page the WHOLE events.jsonl via events.replay and
   * land on the LAST turn; close ⇒ back to live. */
  toggleReplay(): void {
    if (systemLocal.getState().replay.active) {
      this.closeReplay();
      return;
    }
    systemLocal.set({ replay: { ...initialReplay, active: true, loading: true } });
    void this.guarded(async () => {
      const events: NormalizedEvent[] = [];
      let fromSeq: number | undefined = undefined;
      let truncated = false;
      for (let page = 0; page < REPLAY_PAGE_CAP; page++) {
        const batch: NormalizedEvent[] = await this.rpc<NormalizedEvent[]>("events.replay", {
          ...(fromSeq !== undefined ? { fromSeq } : {}),
          limit: REPLAY_PAGE_LIMIT,
        });
        events.push(...batch);
        const next = nextReplayPage(batch, REPLAY_PAGE_LIMIT);
        if (next === null) break;
        if (page === REPLAY_PAGE_CAP - 1) truncated = true;
        fromSeq = next;
      }
      if (!systemLocal.getState().replay.active) return; // closed while loading
      const count = turnCount(events);
      const cutoffSeq = events[events.length - 1]?.seq ?? null;
      systemLocal.set({
        replay: { active: true, loading: false, events, turn: Math.max(0, count - 1), cutoffSeq,
          projection: cutoffSeq === null ? projectHistoricalEvents([], 0) : projectHistoricalEvents(events, cutoffSeq), truncated, sourceAnchor: null, playing: false },
      });
    }).then(() => {
      // a failed load must not strand a dead amber bar with inputs locked
      const r = systemLocal.getState().replay;
      if (r.active && r.loading) systemLocal.set({ replay: initialReplay });
    });
  }

  closeReplay(): void {
    systemLocal.set({ replay: initialReplay });
  }

  stepReplay(delta: number): void {
    const r = systemLocal.getState().replay;
    if (!r.active || r.loading) return;
    this.seekReplay(stepTurn(r.events, r.turn, delta));
  }

  seekReplay(turn: number): void {
    const r = systemLocal.getState().replay;
    if (!r.active || r.loading) return;
    const nextTurn = stepTurn(r.events, turn, 0);
    const window = turnWindow(r.events, nextTurn);
    const cutoffSeq = window.end >= 0 ? r.events[window.end]?.seq ?? null : null;
    systemLocal.set({ replay: { ...r, turn: nextTurn, cutoffSeq,
      projection: cutoffSeq === null ? projectHistoricalEvents([], 0) : projectHistoricalEvents(r.events, cutoffSeq), playing: false } });
  }

  seekReplaySeq(seq: number): void {
    const r = systemLocal.getState().replay;
    if (!r.active || r.loading || r.events.length === 0) return;
    const cutoffSeq = r.events.reduce((best, event) => event.seq <= seq ? event.seq : best, r.events[0]!.seq);
    const starts = turnStarts(r.events);
    let turn = 0;
    for (let i = 0; i < starts.length; i++) if (r.events[starts[i]!]!.seq <= cutoffSeq) turn = i;
    systemLocal.set({ replay: { ...r, turn, cutoffSeq, projection: projectHistoricalEvents(r.events, cutoffSeq), playing: false } });
  }

  openReplayAt(seq: number): void {
    if (!systemLocal.getState().replay.active) this.toggleReplay();
    const wait = (): void => {
      const replay = systemLocal.getState().replay;
      if (!replay.active) return;
      if (replay.loading) { setTimeout(wait, 10); return; }
      this.seekReplaySeq(seq);
      systemLocal.set({ replay: { ...systemLocal.getState().replay, sourceAnchor: seq } });
    };
    wait();
  }

  setReplayPlaying(playing: boolean): void {
    const r = systemLocal.getState().replay;
    if (!r.active || r.loading) return;
    systemLocal.set({ replay: { ...r, playing } });
  }

  /** McpToolPalette invoke — allowlisted daemon RPC (TUI mcpInvoke parity). */
  mcpInvoke(rpc: string, params: Record<string, unknown>): Promise<unknown> {
    if (!MCP_INVOKE_RPCS.has(rpc)) {
      return Promise.reject(new Error(`rpc "${rpc}" is not in the tool palette allowlist`));
    }
    return this.rpc(rpc, params);
  }
}

// Module singleton, constructed by the FIRST caller (App) with the app store +
// bridge rpc handed in — this module never imports either.
let instance: SystemCommands | null = null;
export function systemCommands(store: UiStore, rpc: RpcFn): SystemCommands {
  if (!instance) instance = new SystemCommands(store, rpc);
  return instance;
}
export function createSystemCommands(store: UiStore, rpc: RpcFn): SystemCommands {
  return new SystemCommands(store, rpc);
}
