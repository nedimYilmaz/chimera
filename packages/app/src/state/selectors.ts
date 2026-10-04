// W3 — PURE selectors/formatters for the Agents screen. Every derivation the
// components render lives here as a plain function over UiState/AgentView
// (PLAN-TAURI §0: the UI holds a projection, NO ui-side business logic), so it
// is unit-testable without React/DOM. Logic is ported from the TUI's
// AgentList/AgentDetail/FlowPane helpers (the same projections rendered in
// Ink); data shapes come exclusively from @chimera/ui-state.
import { failureCauseLabel, failureNeedsOperator, isUnseen, pauseReasonLabel, qualifiedAgentId, shadowFallbackName } from "@chimera/ui-state";
import type { AgentView, FlowNode, TranscriptItem, TokenUsage, UiState } from "@chimera/ui-state";
import type { AccountQuota, AccountQuotaReason, AccountQuotaWindow, NormalizedEvent } from "@chimera/protocol";
import { DEFAULT_CONTEXT_WINDOW, effectiveContextLimitFor } from "@chimera/protocol";
import { spendTone } from "./commands.system";

// ---------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------

/** Compact token count, mock style: always the "k" form with one decimal under
 * 100k ("0.9k", "5.0k", "18.2k"), integer k to 1M, then M. null/undefined
 * usage renders the em-dash placeholder. Negative/NaN clamps to 0. */
export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 100_000) return `${(v / 1000).toFixed(1)}k`;
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  return v < 10_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${Math.round(v / 1_000_000)}M`;
}

export function fmtCost(usd: number): string {
  return Number.isFinite(usd) ? `$${usd.toFixed(2)}` : "—";
}

/** Wall-clock HH:MM:SS (local time — a desktop app shows the user's clock). */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Whole-second duration for chips ("41s"). */
export function fmtDurationSec(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** Compact elapsed duration, omitting unknown values and trailing zero units. */
export function fmtDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return "0s";

  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (totalSec < 60) return `${seconds}s`;
  if (totalSec < 3600) return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
  return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// naming (ported verbatim from the TUI's AgentList: FNV-1a -> adjective-animal)
// ---------------------------------------------------------------------------

const NAME_ADJECTIVES = [
  "amber", "brisk", "clever", "cosmic", "dapper", "eager", "fuzzy", "gentle",
  "glossy", "jolly", "keen", "lucky", "mellow", "nimble", "plucky", "quiet",
  "rapid", "sly", "spry", "sunny", "swift", "tidy", "vivid", "witty",
  "zesty", "bold", "brave", "crisp", "frosty", "lively", "merry", "wily",
] as const;
const NAME_ANIMALS = [
  "otter", "lynx", "heron", "falcon", "badger", "marten", "ferret", "tapir",
  "gecko", "raven", "finch", "bison", "koala", "panda", "dingo", "civet",
  "lemur", "quokka", "wombat", "narwhal", "ibex", "okapi", "puffin", "walrus",
  "weasel", "yak", "zebu", "stoat", "shrew", "vole", "newt", "krill",
] as const;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function agentName(agentId: string): string {
  const h = fnv1a(agentId);
  const adj = NAME_ADJECTIVES[h % NAME_ADJECTIVES.length]!;
  const animal = NAME_ANIMALS[Math.floor(h / NAME_ADJECTIVES.length) % NAME_ANIMALS.length]!;
  return `${adj}-${animal}`;
}

/** Federation (PP6): a remote agent's store key is "<engineId>/<localId>".
 * Returns the engine id, or null for a local agent. */
export function remoteEngine(key: string): string | null {
  const slash = key.indexOf("/");
  return slash === -1 ? null : key.slice(0, slash);
}

/** The primary row/header label: a custom label wins; otherwise the conductor reads "main"
 * (mock), a shadow shows its friendly label, and everything else uses the deterministic name. */
export function displayName(a: AgentView): string {
  const custom = a.displayLabel?.trim();
  if (custom) return custom;
  // A conductor reads "main" (the top-level session), EXCEPT a per-project
  // conductor (PLAN-PROJECT-CONDUCTOR-ROUTING) — it reads its PROJECT NAME
  // (projectId === ProjectSpec.name) so the auto-spawned project conductor is
  // distinguishable from the real main session instead of a second "main".
  if (a.conductor) return a.projectId ?? "main";
  if (a.shadow) return a.label ?? shadowFallbackName(a.agentId) ?? shortId(a.agentId);
  return agentName(a.agentId);
}

/** A conductor's row name, DISAMBIGUATED across siblings that are actually
 * LIVE. One conductor per project is the norm (the daemon's
 * ensureProjectConductor is idempotent), so this is normally just the
 * project name (or "main" for the top-level session). But if several
 * conductors are simultaneously RUNNING/PAUSED for the same project, the
 * extras get a numeric suffix — "chimera", "chimera-2", "chimera-3", …
 * — ordered by agentId for stability, so two live conductor rows never
 * render identically. A terminal (done/failed/killed) or unknown-state
 * record, or a membership-carrying row (a workflow step scheduler.ts forces
 * conductor:true on — never a real conductor), does NOT count as a sibling:
 * it must not steal the live conductor's bare project name. This mirrors
 * ui-state's buildConductorByProject (reducer.ts), which picks the SAME
 * live, non-membership conductor as canonical per project — kept as a
 * separate check (rather than sharing code across packages) but changes to
 * one should be mirrored in the other. Non-conductors fall through to
 * displayName unchanged.
 *
 * `fallbackProjectName`: belt-and-braces for a reconnect race — a project
 * conductor row can (briefly) be absent from `agents` even though the caller
 * already knows which project it belongs to (e.g. ProjectsScreen's session
 * list is keyed off the open project's own spec). Rendering that known name
 * instead of a bare short id avoids the "b0d0a8fd" regression while the live
 * event stream catches the row up. Omitted ⇒ byte-identical to before. */
export function conductorLabel(agents: Record<string, AgentView>, agentId: string, fallbackProjectName?: string): string {
  const a = agents[agentId];
  if (!a) return fallbackProjectName ?? shortId(agentId);
  const custom = a.displayLabel?.trim();
  if (custom) return custom;
  if (!a.conductor) return displayName(a);
  const base = a.projectId ?? "main";
  const isLive = (x: AgentView): boolean => !x.membership && x.state !== "unknown" && !isTerminalState(x.state);
  const siblings = Object.values(agents)
    .filter((x) => x.conductor && (x.projectId ?? "main") === base && isLive(x))
    .map((x) => x.agentId)
    .sort();
  const idx = siblings.indexOf(agentId);
  return siblings.length <= 1 || idx <= 0 ? base : `${base}-${idx + 1}`;
}

/** The dim secondary tag after the name: "conductor" for the conductor,
 * "@engine" for a remote row, the 8-char short id for a plain agent, nothing
 * for a shadow (its label IS the primary). */
export function secondaryLabel(a: AgentView): string {
  if (a.conductor) return "conductor";
  const engine = remoteEngine(a.agentId);
  if (engine) return `@${engine}`;
  if (a.shadow) return "";
  return shortId(a.agentId);
}

// ---------------------------------------------------------------------------
// state visuals
// ---------------------------------------------------------------------------

export type Tone = "success" | "info" | "warn" | "danger" | "muted";

/** A Tone's CSS custom property — every Tone name IS its token's suffix
 * (tokens.css: --success/--info/--warn/--danger/--muted), so no lookup table
 * is needed. Used wherever a tone drives an inline `style` (a chip dot) rather
 * than a CSS module class (the CI hex guard: no literal hex in components). */
export function toneVar(tone: Tone): string {
  return `var(--${tone})`;
}

/** An agent with a pending question OR a pending native dialog (AskUserQuestion
 * / elicitation — DLG3) is WAITING regardless of its wire state. */
export function derivedState(a: AgentView): string {
  return a.pendingQuestion || a.pendingDialog ? "waiting" : a.state;
}

/** AGENTS-HIDE-DONE: a derivedState value that's reached a final outcome — the
 * set the Agents tab's default filter hides. Everything else (running/idle/
 * waiting/unknown) counts as "active" and stays visible by default. */
export function isTerminalState(state: string): boolean {
  return state === "done" || state === "failed" || state === "killed";
}

/** Mock's state cell glyphs: ◐ running / ⏸ paused / ● done / ◌ waiting / ⊘ killed / ✗ failed.
 * PAUSED-AGENTS-VISIBLE: "paused" used to fall through to the same muted "·" the "unknown"
 * (never-projected) state renders — visually indistinguishable from a stale/placeholder row
 * in a fleet of hundreds. ⏸ + warn now matches the TUI's existing theme2.ts stateTokens.paused
 * glyph/tone exactly, so the two front ends read the same state the same way. */
export function stateVisual(state: string): { glyph: string; tone: Tone } {
  switch (state) {
    case "running": return { glyph: "◐", tone: "success" };
    case "paused": return { glyph: "⏸", tone: "warn" };
    case "done": return { glyph: "●", tone: "info" };
    case "waiting": return { glyph: "◌", tone: "warn" };
    case "killed": return { glyph: "⊘", tone: "warn" };
    case "failed": return { glyph: "✗", tone: "danger" };
    default: return { glyph: "·", tone: "muted" };
  }
}

// PAUSED-AGENTS-VISIBLE: WHY + WHEN for a paused row's badge — the acceptance bar for this
// feature is explicitly "not just a paused dot": an operator idling on dozens of agents needs
// the reason (will it resolve itself, or is it stuck retrying?) and the resume time without
// opening the row. Reuses the shared reason label (ui-state/pause.ts) so app/tui never drift.
// PAUSE-BADGE-NOISE: the two "nobody needed you" holds are the NORMAL resting state — after a
// restart, or after an idle window — and they read IDENTICALLY on every row, so spelling them
// out adds no per-row information at all. They are also long: "daemon restarted — resume to
// continue" wrapped the badge onto a second line and squeezed the agent-NAME column clean off
// the row, which is how a cosmetic label became a "where did all the names go" bug. The ⏸ glyph
// alone carries them; the full sentence still shows wherever there is room for it (the detail
// panel), via pauseReasonLabel directly. The exceptional holds keep their text — that is the
// whole point of PAUSED-AGENTS-VISIBLE: "is this resolving itself or stuck retrying?" is a real
// question for a session limit or a crash loop, and not one for a restart.
const GLYPH_ONLY_HOLDS: ReadonlySet<string> = new Set(["daemon-restart", "idle-timeout"]);

export function pauseSummary(a: Pick<AgentView, "pauseReason" | "resumeAt">): string {
  if (a.pauseReason && GLYPH_ONLY_HOLDS.has(a.pauseReason)) return "";
  const label = pauseReasonLabel(a.pauseReason);
  return a.resumeAt ? `${label} · resumes ${fmtClock(a.resumeAt)}` : label;
}

// F08: unlike a pause, every failure cause is exceptional and each implies a different operator
// action (wait vs retry vs re-authenticate) — no GLYPH_ONLY set here, the badge always carries text.
export function failureSummary(a: Pick<AgentView, "failure">): string {
  return a.failure ? failureCauseLabel(a.failure.cause) : "";
}

/** F08.UI: agents whose death the engine has NO automatic remedy for — the "needs operator"
 * chip's count and its filter set. Fold-insensitive like every other title count. */
export function needsOperatorAgentIds(state: AgentRowsState): string[] {
  const out: string[] = [];
  for (const id of state.agentOrder) {
    const a = state.agents[id];
    if (a && failureNeedsOperator(a.failure)) out.push(id);
  }
  return out;
}

/** TRANSCRIPT-LOADING-STATE: what a single-agent transcript pane should show
 * when it has no rendered blocks yet — "loading" (historyLoadState "loading":
 * a backfill fetch is genuinely in flight), "failed" (historyLoadState
 * "failed": the fetch rejected), or "empty" for everything else — a completed
 * fetch that found no messages, a live agent that simply hasn't spoken, OR
 * "idle" (never fetched — installHistoryBackfill dispatches "loading"
 * SYNCHRONOUSLY the instant selection lands on an eligible agent, before any
 * component can render, so a selected agent reaching render still "idle" only
 * means backfill was never eligible for it in the first place — same as
 * genuinely empty, not a load in progress). Treating bare "idle" as loading
 * would show a skeleton that never resolves for those agents. */
export type TranscriptEmptyState = "loading" | "empty" | "failed";

export function transcriptEmptyState(agent: Pick<AgentView, "historyLoaded" | "historyLoadState" | "transcript">): TranscriptEmptyState {
  if (agent.historyLoaded || agent.transcript.length > 0) return "empty";
  if (agent.historyLoadState === "failed") return "failed";
  if (agent.historyLoadState === "loading") return "loading";
  return "empty";
}

// ---------------------------------------------------------------------------
// agent rows (P3-T3: spawn-lineage-primary, team demoted to a per-row badge —
// PLAN-PROJECT-CONDUCTOR-ROUTING.md §5/D4; ported from the TUI's AgentList)
// ---------------------------------------------------------------------------

/** Exactly the UiState slices the row/summary selectors read — components
 * subscribe to these slices individually (useStore's referential-stability
 * contract) and pass a memoed pick, so a render-time getState() is never
 * needed. A full UiState still satisfies it structurally (keymap callers). */
export type AgentRowsState = Pick<UiState, "agents" | "agentOrder" | "collapsed" | "teams" | "mainConductorId">;

/** "owned by X" — the team creator's display name: a PER-PROJECT conductor
 * (PLAN-PROJECT-CONDUCTOR-ROUTING) reads its project name, the top-level
 * session conductor reads "main", anything else falls back to its short id,
 * null when unknown. Mirrors displayName's conductor rule (`a.projectId ??
 * "main"`) rather than collapsing every conductor to "main" — a team created
 * by a project conductor (e.g. "chimera") must show that project's name, not
 * "main". (The TUI keys off mainConductorId; the app derives from the
 * conductor flag so a snapshot-only load — where mainConductorId is never
 * dispatched — still reads "main".) Used by TeamsScreen's own team-detail
 * surface, independent of AgentList. */
export function ownerLabel(state: AgentRowsState, team: string): string | null {
  const item = state.teams.items.find((t) => t["name"] === team);
  const createdBy = item && typeof item["createdBy"] === "string" ? (item["createdBy"] as string) : null;
  if (createdBy === null) return null;
  const creator = state.agents[createdBy];
  if (createdBy === state.mainConductorId || creator?.conductor) return creator?.projectId ?? "main";
  return shortId(createdBy);
}

// AGENTLIST-CARET-REMOVAL: `hiddenCount` = how many descendant rows a folded
// parent's fold hides, for the render's dim "+N" indicator (no ▾/▸ caret column
// anymore — folding is keyboard-only, exactly like the TUI). 0 on an open row.
export type AgentRow = { kind: "agent"; agentId: string; depth: number; collapsible: boolean; collapsed: boolean; hiddenCount: number; section: "main" | "session" };

/** Display indent depth: pure spawn-tree depth, clamped to [0,4] (P3-T3: no
 * more +1 team bump — team is a badge, not an outer nesting level). */
export function rowIndentDepth(a: AgentView): number {
  return Math.max(0, Math.min(a.displayDepth ?? a.depth ?? 0, 4));
}

/** The GROUPING key for a row's tree — used ONLY to keep related trees
 * contiguous (the straggler-splice in buildDisplayOrder + a future state-sort
 * pass), never to render a header. Prefers the tree root's `projectId` (the
 * per-project conductor's whole spawn tree, and any other tree rooted in the
 * same project, cluster together — the "conductor/project" grouping D4 asks
 * for); falls back to the root's `membership.team` (preserves today's team-
 * adjacency for a team's separately-rooted workers, which carry no projectId
 * until routing/P2 lands); falls back to the tree's own root id (a singleton
 * cluster) when neither is known. */
function groupKey(state: AgentRowsState, agentId: string, hops: Set<string> = new Set()): string {
  const a = state.agents[agentId];
  if (!a) return agentId;
  if (hops.has(agentId)) return `tree:${agentId}`; // cycle guard, same discipline as effectiveGroupOf
  hops.add(agentId);
  const rootId = treeRootOf(state, agentId);
  const root = state.agents[rootId] ?? a;
  // AGENT-TREE: a queue-spawned worker is its OWN tree root but belongs, on screen, to the
  // conductor that owns it. It must therefore key by its owner's key — not by a distinct
  // `owner:<id>` key, which is what split the cluster: the owner keys `project:`/`team:` (it has
  // no originConductorId of its own), so buildDisplayOrder emitted the workers at some OTHER
  // cluster's first occurrence, stranding them under an unrelated conductor. Resolved off the
  // TREE ROOT, not the row: only roots carry originConductorId, so a worker's own children would
  // otherwise fall into a different cluster than their parent.
  const owner = root.originConductorId;
  if (owner && state.agents[owner]) return groupKey(state, owner, hops);
  if (root.projectId) return `project:${root.projectId}`;
  if (root.membership?.team) return `team:${root.membership.team}`;
  return `tree:${rootId}`;
}

/** The topmost present agent of `agentId`'s spawn tree: follows `parentId`, falling back to
 * `treeId` for records that leave parentId unset (test fixtures and older daemon snapshots —
 * same defensive reason parentOfMap reconstructs parents from the order). Cycle-guarded. */
function treeRootOf(state: AgentRowsState, agentId: string): string {
  const seen = new Set<string>();
  let cur = agentId;
  while (!seen.has(cur)) {
    seen.add(cur);
    const a = state.agents[cur];
    if (!a) break;
    const up =
      a.parentId && state.agents[a.parentId]
        ? a.parentId
        : a.treeId && a.treeId !== cur && state.agents[a.treeId]
          ? a.treeId
          : undefined;
    if (up === undefined) break;
    cur = up;
  }
  return cur;
}

/** Every id an agent hangs from, following the SAME two links the tree render treats as
 * lineage: `parentId` (its spawner) and `originConductorId` (the conductor a queue-spawned
 * worker roots under). Cycle-guarded like effectiveGroupOf — a looped chain must never hang a
 * render. Used to decide whether a row may be drawn INSIDE another row (indent, group box). */
export function ancestorIdsOf(agents: Record<string, AgentView>, agentId: string): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  let cur: string | undefined = agentId;
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const a: AgentView | undefined = agents[cur];
    if (!a) break;
    const parent: string | undefined = a.parentId ?? undefined;
    const owner: string | undefined = a.originConductorId ?? undefined;
    if (parent) out.add(parent);
    if (owner) out.add(owner);
    cur = parent ?? owner;
  }
  out.delete(agentId);
  return out;
}

/** SEARCH-AGENTS: free-text predicate for the Agents tab search box — matches
 * the row's displayed name/label, short id, derived state, or team, all
 * case-insensitive substrings (mirrors EventsScreen's `shown` filter). */
export function agentMatchesQuery(a: AgentView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${displayName(a)} ${shortId(a.agentId)} ${derivedState(a)} ${a.membership?.team ?? ""}`.toLowerCase();
  return hay.includes(q);
}

/** Reconstructs each row's immediate PARENT id from `order` alone (a proper
 * DFS-preorder per tree cluster — the same invariant buildAgentRows' own
 * sameTreeChild/skip logic relies on): walk a depth stack, popping until the
 * top is shallower than the current row, same treeId. Avoids depending on the
 * optional/defensive AgentView.parentId field, which test fixtures and older
 * daemon snapshots may leave unset. */
function parentOfMap(state: AgentRowsState, order: readonly string[]): Map<string, string> {
  const depthOf = (id: string): number => state.agents[id]?.displayDepth ?? state.agents[id]?.depth ?? 0;
  const treeOf = (id: string): string => state.agents[id]?.treeId ?? id;
  const parentOf = new Map<string, string>();
  const stack: string[] = [];
  for (const id of order) {
    const agent = state.agents[id];
    const explicitOwner = agent?.parentId && state.agents[agent.parentId] ? agent.parentId : agent?.originConductorId;
    if (explicitOwner && state.agents[explicitOwner]) parentOf.set(id, explicitOwner);
    const d = depthOf(id);
    while (stack.length > 0 && depthOf(stack[stack.length - 1]!) >= d) stack.pop();
    const top = stack[stack.length - 1];
    if (!parentOf.has(id) && top !== undefined && d > 0 && treeOf(top) === treeOf(id)) parentOf.set(id, top);
    stack.push(id);
  }
  return parentOf;
}

/** Shared by filterOrderForQuery/filterOrderForActive: expands `keep` to
 * include every ancestor of a kept id (so a kept deep node stays reachable in
 * its tree instead of appearing orphaned), then returns an order-preserving
 * subsequence of `order`. */
function keepIdsWithAncestors(state: AgentRowsState, order: readonly string[], keep: Set<string>): string[] {
  if (keep.size === 0) return [];
  const parentOf = parentOfMap(state, order);
  for (const id of [...keep]) {
    let cur = parentOf.get(id);
    while (cur !== undefined && !keep.has(cur)) {
      keep.add(cur);
      cur = parentOf.get(cur);
    }
  }
  return order.filter((id) => keep.has(id));
}

/** SEARCH-AGENTS: keeps every agent matching `query` PLUS its full ancestor
 * chain, so a matched deep node stays reachable in its tree instead of
 * appearing orphaned (the tree-preserving choice over a flat matched-rows
 * list — a matched leaf's lineage/team context stays visible). Returns an
 * order-preserving subsequence of `order`. */
function filterOrderForQuery(state: AgentRowsState, order: readonly string[], query: string): string[] {
  const keep = new Set<string>();
  for (const id of order) {
    const a = state.agents[id];
    if (a && agentMatchesQuery(a, query)) keep.add(id);
  }
  return keepIdsWithAncestors(state, order, keep);
}

/** AGENTS-HIDE-DONE: keeps every non-terminal (active) agent PLUS its full
 * ancestor chain, so a running/waiting descendant never gets orphaned by its
 * finished parent being hidden — see isTerminalState.
 *
 * SESSION-CHATS-STAY-VISIBLE: a session-tier chat (`agent.session === true`,
 * ad-hoc sessions design §6) is exempt from the hide-done filter while
 * done/failed — the operator's explicit requirement is that a session's chat
 * row survives until THEY kill it, not until it merely finishes. A killed
 * session is still eligible to hide: that's the dismissal action that keeps
 * the sessions bucket from growing forever. Non-session agents (workers, tree
 * descendants, conductors) are unaffected — showDone still governs them. */
/** F47: keep only agents that want attention (attentionAt newer than reviewedAt), plus the
 * ancestors needed to keep them reachable — an unseen worker must never be orphaned out of the
 * tree by the very filter meant to surface it. */
function filterOrderForUnseen(state: AgentRowsState, order: readonly string[]): string[] {
  const keep = new Set<string>();
  for (const id of order) if (isUnseen(state.agents[id])) keep.add(id);
  return keepIdsWithAncestors(state, order, keep);
}

/** F08.UI: mirrors filterOrderForUnseen exactly — keep the rows that need a human, plus the
 * ancestors that keep them reachable, so a dead worker deep in a tree is never orphaned out of
 * the very filter meant to surface it. */
function filterOrderForNeedsOperator(state: AgentRowsState, order: readonly string[]): string[] {
  const keep = new Set<string>();
  for (const id of order) if (failureNeedsOperator(state.agents[id]?.failure)) keep.add(id);
  return keepIdsWithAncestors(state, order, keep);
}

function filterOrderForActive(state: AgentRowsState, order: readonly string[]): string[] {
  const keep = new Set<string>();
  for (const id of order) {
    const a = state.agents[id];
    if (!a) continue;
    const st = derivedState(a);
    if (!isTerminalState(st)) keep.add(id);
    else if (a.session && st !== "killed") keep.add(id);
  }
  return keepIdsWithAncestors(state, order, keep);
}

/** Splices a STRAGGLER (an agent appended to the tail of agentOrder by a live
 * event, before the next agent.list snapshot re-clusters it via treeOrder —
 * ui-state's reducer.ts) back into its groupKey cluster's first-seen
 * position, so a freshly-spawned agent renders WITH its tree/project/team
 * instead of detached at the very bottom (the user-reported bug, commit
 * 25034d1, preserved here under lineage-primary nesting). Generalized off
 * `groupKey` instead of team — every agent gets SOME group (project, team, or
 * its own tree-root singleton), fixing a latent gap the team-only version had
 * for a project-/team-less straggler (it never clustered with its own
 * tree-mates before). */
function buildDisplayOrder(state: AgentRowsState): string[] {
  const order = state.agentOrder;
  const members = new Map<string, string[]>();
  for (const id of order) {
    if (!state.agents[id]) continue; // defensive: a stale order entry must never blank the pane
    const key = groupKey(state, id);
    const list = members.get(key);
    if (list) list.push(id);
    else members.set(key, [id]);
  }
  const result: string[] = [];
  const emitted = new Set<string>();
  for (const id of order) {
    if (!state.agents[id]) continue;
    const key = groupKey(state, id);
    if (emitted.has(key)) continue; // already spliced in at the group's first occurrence
    emitted.add(key);
    result.push(...members.get(key)!);
  }
  return result;
}

/** The full row list the AgentList renders: every row is a plain agent row
 * (P3-T3: no more team header) with collapsed subtrees skipped, over the
 * display order buildDisplayOrder's straggler-splice produces so a team's/
 * project's members always render together regardless of where the reducer
 * appended them in agentOrder.
 *
 * SEARCH-AGENTS: an optional `query` narrows `order` to matches + ancestors
 * (filterOrderForQuery) BEFORE the fold pass, and — while a query is active —
 * the manual fold-skip is suppressed so a match never hides behind a subtree
 * the user folded before searching (search overrides fold; clearing the query
 * restores it exactly, since `collapsed` itself is never touched here).
 *
 * AGENTS-HIDE-DONE: `showDone` defaults to true (every other caller — keymap
 * nav, etc. — keeps today's unfiltered behavior). The Agents tab passes its
 * own toggle state explicitly; when false and no query is active, terminal
 * agents are dropped via filterOrderForActive. A non-empty query always wins
 * (SEARCH-AGENTS's existing "search reaches everything" contract) — the
 * toggle only governs the query-less default view. */
export function buildAgentRows(state: AgentRowsState, query = "", showDone = true, unseenOnly = false, needsOperatorOnly = false): AgentRow[] {
  const rows: AgentRow[] = [];
  const q = query.trim();
  // F47: the unseen filter defers to a query for the same reason showDone does — "search reaches
  // everything" is the older contract, and a filter that silently ate search hits would be
  // indistinguishable from a broken search.
  // UNSEEN-OUTRANKS-HIDE-DONE: it does NOT compose with showDone. An agent that finished
  // overnight and was never read is precisely what the attention filter exists to surface, so
  // hide-done must not cull it; otherwise the "N new" chip (which counts every unseen agent)
  // would claim 3 while the filtered list showed 1, and an attention filter you cannot trust is
  // worse than none.
  // Native workflow runs remain inspectable from their owner's transcript. They
  // are not separately managed agents and should not accumulate in the fleet.
  const displayOrder = buildDisplayOrder(state).filter(id => !isTranscriptWorkflow(state.agents[id]));
  const unfiltered = showDone ? displayOrder : filterOrderForActive(state, displayOrder);
  // F08.UI: the needs-operator filter sits ahead of the attention filter for the same reason
  // that one outranks hide-done — a death only a human can clear is the most urgent thing the
  // list can say, and it must not be culled by a broader filter that happens to be on too.
  const fullOrder = q
    ? filterOrderForQuery(state, displayOrder, q)
    : needsOperatorOnly
      ? filterOrderForNeedsOperator(state, displayOrder)
      : unseenOnly
        ? filterOrderForUnseen(state, displayOrder)
        : unfiltered;
  // Ad-hoc sessions design §6: sessions bucket separately from project trees. A session's own
  // spawn-tree relationships (parentId/treeId) only ever point at other agents it itself spawned
  // (session does not auto-propagate to children), so partitioning the ALREADY tree-ordered array
  // by each root's own `session` flag preserves each subtree intact.
  // Partition entire families, not individual session flags: spawned children
  // do not inherit spec.session and must still follow their session parent.
  const sessionOf = (id: string): boolean => {
    const seen = new Set<string>();
    let current = id;
    while (!seen.has(current)) {
      seen.add(current);
      const a = state.agents[current];
      const parent = a?.parentId && state.agents[a.parentId] ? a.parentId : a?.originConductorId;
      const next = parent && state.agents[parent] ? parent : treeRootOf(state, current);
      if (next === current) return !!a?.session;
      current = next;
    }
    return !!state.agents[id]?.session;
  };
  const order = [...fullOrder.filter(id => !sessionOf(id)), ...fullOrder.filter(sessionOf)];
  const depthOf = (id: string | undefined): number => (id === undefined ? 0 : state.agents[id]?.displayDepth ?? state.agents[id]?.depth ?? 0);
  const treeOf = (id: string | undefined): string | undefined => (id === undefined ? undefined : state.agents[id]?.treeId ?? id);
  const sameTreeChild = (parent: string, child: string | undefined): boolean =>
    child !== undefined && (ancestorIdsOf(state.agents, child).has(parent) || treeOf(child) === treeOf(parent) && depthOf(child) > depthOf(parent));
  // AGENT-TREE: the rendered indent is derived from the rows actually emitted BEFORE this one,
  // never from the record's own displayDepth alone — a row may only be indented under a row it
  // is genuinely descended from. Without this, a queue-owned worker (displayDepth = depth + 1,
  // the reducer's owner bump) rendered as a "└" child of whatever unrelated row happened to
  // precede it, and selectors.groups.ts then absorbed it into that stranger's group box. A
  // record that declares NO lineage at all (neither parentId nor originConductorId — depth-only
  // test fixtures and older daemon snapshots) keeps today's exact behaviour: its own
  // displayDepth, anchored by a depth stack.
  const indentStack: { id: string; depth: number; base: number }[] = [];
  const indentDepthOf = (agentId: string, a: AgentView): number => {
    const base = rowIndentDepth(a);
    if (a.parentId || a.originConductorId) {
      const anc = ancestorIdsOf(state.agents, agentId);
      // Pop until the top is something this row may legitimately hang from: a declared ancestor,
      // or a SHALLOWER row of the same tree (the invariant's "same-tree ancestor" clause — a
      // shadow folded from an event can carry originConductorId while its parentId is still
      // null, and must nest under its own worker rather than beside it).
      while (indentStack.length > 0) {
        const t = indentStack[indentStack.length - 1]!;
        if (anc.has(t.id) || (t.base < base && treeOf(t.id) === treeOf(agentId))) break;
        indentStack.pop();
      }
      const top = indentStack[indentStack.length - 1];
      return top === undefined ? 0 : Math.min(top.depth + 1, 4);
    }
    while (indentStack.length > 0 && indentStack[indentStack.length - 1]!.base >= base) indentStack.pop();
    return base;
  };
  let skipDepth = -1;
  let skipTree: string | undefined;
  let foldedRow: AgentRow | undefined; // the collapsed row hiding the current subtree; each skipped descendant bumps its hiddenCount
  for (let i = 0; i < order.length; i++) {
    const agentId = order[i]!;
    const a = state.agents[agentId];
    if (!a) continue; // defensive: a stale order entry must never blank the pane
    const d = depthOf(agentId);
    if (!q && skipDepth >= 0) {
      if ((foldedRow && ancestorIdsOf(state.agents, agentId).has(foldedRow.agentId)) || (treeOf(agentId) === skipTree && d > skipDepth)) { if (foldedRow) foldedRow.hiddenCount++; continue; } // count + hide
      skipDepth = -1;
      foldedRow = undefined;
    }
    const collapsible = sameTreeChild(agentId, order[i + 1]);
    const collapsed = collapsible && state.collapsed.has(agentId);
    const indent = indentDepthOf(agentId, a);
    indentStack.push({ id: agentId, depth: indent, base: rowIndentDepth(a) });
    const row: AgentRow = { kind: "agent", agentId, depth: indent, collapsible, collapsed, hiddenCount: 0, section: sessionOf(agentId) ? "session" : "main" };
    rows.push(row);
    if (!q && collapsed) { skipDepth = d; skipTree = treeOf(agentId); foldedRow = row; }
  }
  return rows;
}

/** The ordered agent ids currently VISIBLE (fold-aware, query-aware) — what
 * ↑/↓ step over; pass the same `query`/`showDone` the pane is filtering by so
 * keyboard selection never desyncs from the filtered rows on screen. */
export function visibleAgentIds(state: AgentRowsState, query = "", showDone = true, unseenOnly = false, needsOperatorOnly = false): string[] {
  const out: string[] = [];
  for (const r of buildAgentRows(state, query, showDone, unseenOnly, needsOperatorOnly)) if (r.kind === "agent") out.push(r.agentId);
  return out;
}

function isTranscriptWorkflow(agent: AgentView | undefined): boolean {
  return agent?.shadow === true && !!agent.shadowInfo?.workflowName;
}

/** AGENTS-HIDE-DONE: how many terminal agents the default (query-less,
 * showDone=false) filter currently hides — the header chip's count. Excludes
 * a terminal agent kept visible as an ancestor of an active descendant (it
 * isn't actually hidden). Independent of any in-progress search text — the
 * count describes what the toggle itself controls. */
export function hiddenTerminalAgentCount(state: AgentRowsState): number {
  const order = buildDisplayOrder(state).filter(id => !isTranscriptWorkflow(state.agents[id]));
  const shown = new Set(filterOrderForActive(state, order));
  let count = 0;
  for (const id of state.agentOrder) {
    const a = state.agents[id];
    if (a && !isTranscriptWorkflow(a) && isTerminalState(derivedState(a)) && !shown.has(id)) count++;
  }
  return count;
}

export type FleetSummary = { total: number; running: number; paused: number; done: number; waiting: number; killed: number; failed: number; unseen: number; needsOperator: number; costUsd: number };

/** Panel-title counts over EVERY real agent record (waiting = pendingQuestion
 * or pendingDialog set — see derivedState). Deliberately fold-INSENSITIVE:
 * folding a team hides rows, it doesn't
 * shrink the fleet — the title's totals/cost must keep counting the whole
 * fleet (adversarial-review finding 8).
 * PAUSED-AGENTS-VISIBLE: `paused` used to fall through uncounted (no branch matched the
 * "paused" state string), so a fleet with paused agents showed the SAME header chips as one
 * with none — zero signal that anything needed attention. */
export function fleetSummary(state: Pick<UiState, "agents" | "agentOrder">): FleetSummary {
  const s: FleetSummary = { total: 0, running: 0, paused: 0, done: 0, waiting: 0, killed: 0, failed: 0, unseen: 0, needsOperator: 0, costUsd: 0 };
  for (const id of state.agentOrder) {
    const a = state.agents[id];
    if (!a || isTranscriptWorkflow(a)) continue;
    s.total++;
    s.costUsd += a.costUsd;
    if (isUnseen(a)) s.unseen++;   // F47: fold-insensitive like every other title count
    if (failureNeedsOperator(a.failure)) s.needsOperator++;   // F08.UI: ditto
    const st = derivedState(a);
    if (st === "running") s.running++;
    else if (st === "paused") s.paused++;
    else if (st === "done") s.done++;
    else if (st === "waiting") s.waiting++;
    else if (st === "killed") s.killed++;
    else if (st === "failed") s.failed++;
  }
  return s;
}

/** The nearest SAME-TREE ancestor row (depth-1) preceding a shadow in
 * agentOrder — "shadow of {parent}". null when it can't be resolved. */
export function shadowParent(state: UiState, key: string): AgentView | null {
  const a = state.agents[key];
  if (!a) return null;
  const tree = a.treeId ?? key;
  const depth = a.depth ?? 0;
  const idx = state.agentOrder.indexOf(key);
  for (let i = idx - 1; i >= 0; i--) {
    const cand = state.agents[state.agentOrder[i]!];
    if (!cand) continue;
    if ((cand.treeId ?? cand.agentId) !== tree) return null; // left the tree
    if ((cand.depth ?? 0) === depth - 1) return cand;
  }
  return null;
}

// ---------------------------------------------------------------------------
// F22 (W24) — agent references: @mention resolution + spawn lineage. Both
// ride the SAME agentOrder/treeId/depth reconstruction shadowParent above
// uses (F02's "no parentId on the wire" heuristic) — no new daemon/event work.
// ---------------------------------------------------------------------------

export type MentionInfo = { agentId: string; tone: Tone; dimmed: boolean };

/** Every LIVE agent's mention forms → its chip info, for the @chip tokenizer's
 * renderer: the bare display name ("frosty-lynx", "main") and, for a remote
 * row, the engine-qualified form ("studio/frosty-lynx") both resolve. A name
 * collision (two agents hashing to the same adjective-animal, or two remote
 * engines sharing one) keeps the LAST agentOrder entry — same last-wins
 * discipline the rest of this file uses (e.g. costUsd/state folds). "dimmed":
 * a finished agent's chip dims but keeps working (F22 acceptance). */
export function agentMentions(state: Pick<UiState, "agents" | "agentOrder">): Map<string, MentionInfo> {
  const idx = new Map<string, MentionInfo>();
  for (const id of state.agentOrder) {
    const a = state.agents[id];
    if (!a) continue;
    const st = derivedState(a);
    const info: MentionInfo = { agentId: id, tone: stateVisual(st).tone, dimmed: st === "done" || st === "failed" || st === "killed" };
    idx.set(displayName(a), info);
    const engine = remoteEngine(a.agentId);
    if (engine) idx.set(`${engine}/${displayName(a)}`, info);
  }
  return idx;
}

/** Agents SPAWNED directly by `parentId` — the forward mirror of shadowParent's
 * backward scan. `agentOrder` is a DFS pre-order (treeOrder, reducer.ts), so a
 * parent's direct children are exactly the depth === parent.depth+1 entries
 * between the parent and the point the scan leaves its tree or backs up to the
 * parent's own level (a sibling or an ancestor) — a grandchild is reached
 * through ITS OWN parent's line, not counted here. */
export function spawnedChildren(state: Pick<UiState, "agents" | "agentOrder">, parentId: string): AgentView[] {
  const parent = state.agents[parentId];
  if (!parent) return [];
  const tree = parent.treeId ?? parentId;
  const depth = parent.depth ?? 0;
  const idx = state.agentOrder.indexOf(parentId);
  if (idx === -1) return [];
  const kids: AgentView[] = [];
  for (let i = idx + 1; i < state.agentOrder.length; i++) {
    const cand = state.agents[state.agentOrder[i]!];
    if (!cand) continue;
    if ((cand.treeId ?? cand.agentId) !== tree) break; // left the tree
    const d = cand.depth ?? 0;
    if (d <= depth) break; // back to a sibling/ancestor level — no more descendants
    if (d === depth + 1) kids.push(cand);
  }
  return kids;
}

/** Whitespace-collapsed, ellipsis-truncated excerpt (F22's "prompt excerpt
 * ≤60" spawn-lineage rule; also reused nowhere else — quote excerpts are
 * verbatim, NOT truncated, per the doc's "quotes its result verbatim"). */
export function truncateExcerpt(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…` : t;
}

// `childName` is the SAME key agentMentions() would store this child under —
// callers resolve the chip's live state via resolveMention(childName) instead
// of a second id→info lookup, so there is exactly ONE place (agentMentions)
// that turns an AgentView into chip info.
export type SpawnLineageEntry = { childId: string; childName: string; excerpt: string };

/** Maps a PARENT's own transcript index (of each `mcp__chimera__agent_spawn`
 * tool call) to the child it spawned + a truncated prompt excerpt — the
 * source for F22's spawn-lineage dim line. Correlates the Nth spawn CALL in
 * this transcript to the Nth entry of spawnedChildren (both are in creation/
 * call order) — a best-effort positional match, same "acceptable per the
 * design note" heuristic shadowParent/treeOrder already rely on (no parentId
 * rides the wire); a child not yet visible in agentOrder (agent.list hasn't
 * polled since the spawn) simply has no entry yet, not a wrong one. */
export function spawnLineageMap(
  transcript: readonly TranscriptItem[],
  state: Pick<UiState, "agents" | "agentOrder">,
  parentId: string,
): Map<number, SpawnLineageEntry> {
  const map = new Map<number, SpawnLineageEntry>();
  const children = spawnedChildren(state, parentId).filter(child => !child.shadow);
  const nativeRuns = new Map<string, AgentView>();
  const visit = (nodes: readonly FlowNode[]): void => {
    for (const node of nodes) {
      const shadow = state.agents[`shadow:${parentId}:${node.taskId ?? node.id}`];
      if (shadow?.shadow) nativeRuns.set(node.id, shadow);
      visit(node.children);
    }
  };
  visit(state.agents[parentId]?.flowTree ?? []);
  let childIdx = 0;
  transcript.forEach((item, i) => {
    if (item.role !== "tool") return;
    const native = item.toolId ? nativeRuns.get(item.toolId) : undefined;
    if (native) {
      map.set(i, { childId: native.agentId, childName: displayName(native), excerpt: truncateExcerpt(native.shadowInfo?.description ?? "", 60) });
      return;
    }
    if (item.toolName !== "mcp__chimera__agent_spawn") return;
    const child = children[childIdx];
    childIdx++;
    if (!child) return;
    const input = item.input as { spec?: { prompt?: unknown } } | undefined;
    const prompt = typeof input?.spec?.prompt === "string" ? input.spec.prompt : "";
    map.set(i, { childId: child.agentId, childName: displayName(child), excerpt: truncateExcerpt(prompt, 60) });
  });
  return map;
}

// ---------------------------------------------------------------------------
// flow pane (ported from the TUI's FlowPane flatten + status visuals)
// ---------------------------------------------------------------------------

export type FlowRowView = { node: FlowNode; depth: number; hasChildren: boolean; collapsed: boolean; isLast: boolean };

export function flattenFlow(tree: FlowNode[], collapsed: ReadonlySet<string>): FlowRowView[] {
  const rows: FlowRowView[] = [];
  const walk = (nodes: FlowNode[], depth: number): void => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const hasChildren = node.children.length > 0;
      const isCollapsed = collapsed.has(node.id);
      rows.push({ node, depth, hasChildren, collapsed: isCollapsed, isLast: i === nodes.length - 1 });
      if (hasChildren && !isCollapsed) walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return rows;
}

/** Mock node icons: root ◆, pending ▸, file-ish labels ✎ (edit), else ⚙. */
export function flowIcon(node: FlowNode, depth: number): string {
  if (depth === 0) return "◆";
  if (node.status === "pending") return "▸";
  if (/\.\w+$/.test(node.label)) return "✎";
  return "⚙";
}

/** Status glyph per mock: ✓ success, ✗ danger, ◐ warn pulsing; null = none
 * (pending nodes show their meta word instead). */
export function flowStatusVisual(status: string): { glyph: string; tone: Tone; pulse: boolean } | null {
  switch (status) {
    case "completed":
    case "done":
      return { glyph: "✓", tone: "success", pulse: false };
    case "failed":
    case "killed":
    case "denied":
      return { glyph: "✗", tone: "danger", pulse: false };
    case "running":
    case "called":
      return { glyph: "◐", tone: "warn", pulse: true };
    default:
      return null;
  }
}

/** The dim meta suffix: subLabel wins, else a compact usage summary. */
export function flowMeta(node: FlowNode): string {
  if (node.subLabel) return node.subLabel;
  const u = node.usage;
  if (!u) return "";
  const parts: string[] = [];
  if (u.durationMs !== undefined) parts.push(fmtDurationSec(u.durationMs));
  if (u.totalTokens !== undefined) parts.push(`${fmtTokens(u.totalTokens)} tok`);
  if (u.toolUses !== undefined) parts.push(`${u.toolUses} tools`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// context meter + sparkline
// ---------------------------------------------------------------------------

/** The nominal context-window budget the ctx meter fills against when no model is known —
 * the TUI's AgentDetail CONTEXT_BUDGET_TOKENS (no hard ceiling rides the wire). Re-exported
 * from protocol's DEFAULT_CONTEXT_WINDOW so both stay in lockstep. */
export const CONTEXT_BUDGET_TOKENS = DEFAULT_CONTEXT_WINDOW;

// R2 (unified cache-aware token/ctx/cost metrics): "how full is the context window for THIS
// turn" — input+cacheRead+cacheCreation is the full prompt size, uniform across providers now
// that TokenUsage.input is normalized to fresh/uncached-only (see ui-state's extractUsage).
// Deliberately excludes `output` (the tokens the model is generating THIS turn, not yet part
// of the context it was given).
export function fullContextTokens(u: Pick<TokenUsage, "input" | "cacheRead" | "cacheCreation">): number {
  return u.input + u.cacheRead + u.cacheCreation;
}

// R2 (ctx meter effective-limit): resolves the ctx meter's denominator for a given agent — its
// Codex uses its provider-reported session window. Other providers use the
// already-resolved effectiveContextLimit (daemon-computed at spawn/setModel, an operator-
// configured compactionThreshold when set) when present, else falls back to the model's native
// window. One place both TranscriptPanel.tsx's header and AgentDetailPanel.tsx's usage row call,
// so the two can never resolve the limit differently.
// The daemon's effective limit is authoritative. Usage can be absent or malformed, and must
// never rewrite the denominator to make a cumulative counter look like context occupancy.
export function effectiveContextLimitForAgent(
  agent: Pick<AgentView, "model" | "effectiveContextLimit"> & Partial<Pick<AgentView, "ctxUsage" | "usage" | "provider" | "contextLimits">>,
): number {
  // Codex API capacities and configured compaction thresholds are not the
  // active session window. Until Codex reports that window, keep it unknown.
  if (agent.provider === "codex") return agent.contextLimits?.sessionWindow ?? 0;
  return effectiveContextLimitFor(agent.model, agent.effectiveContextLimit);
}

// R2 (ctx meter effective-limit): `limit` is the EFFECTIVE denominator — resolve it via
// effectiveContextLimitFor(model, agent.effectiveContextLimit) at the call site, NOT a bare
// model string, so a configured compactionThreshold (not just the model's native window) drives
// the percentage. Defaults to DEFAULT_CONTEXT_WINDOW (byte-identical to the old fixed-200k
// behavior) when the caller passes nothing, so every existing no-second-arg caller/test is
// unaffected. This function itself stays a pure percentage — no model-table knowledge of its own.
export function ctxPct(fullContext: number, limit: number = DEFAULT_CONTEXT_WINDOW): number {
  if (!Number.isFinite(fullContext) || fullContext <= 0) return 0;
  const denom = limit > 0 ? limit : DEFAULT_CONTEXT_WINDOW;
  return Math.min(100, Math.floor((fullContext / denom) * 100));
}

/** Fixed-size sample ring (newest last): push and clip to `size` slots. */
export function pushRing(ring: readonly number[], value: number, size = 8): number[] {
  return [...ring, value].slice(-size);
}

const SPARK_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇"] as const;

/** Map samples onto ▁—▇ normalized to the ring max ("" when no samples). */
export function sparkline(samples: readonly number[]): string {
  if (samples.length === 0) return "";
  const max = Math.max(...samples, 1);
  return samples
    .map((v) => SPARK_GLYPHS[Math.min(SPARK_GLYPHS.length - 1, Math.max(0, Math.floor((v / max) * SPARK_GLYPHS.length - 1e-9)))]!)
    .join("");
}

// ---------------------------------------------------------------------------
// transcript blocks + windowing
// ---------------------------------------------------------------------------

export type ToolItem = Extract<TranscriptItem, { role: "tool" }>;
type NonToolItem = Exclude<TranscriptItem, ToolItem>;
export type TranscriptBlock =
  | { kind: "single"; item: NonToolItem; index: number }
  | { kind: "tools"; items: ToolItem[]; startIndex: number; itemIndices?: number[] };

/** A maximal run of visible tool items collapses into ONE block (the
 * ToolStrip), including runs separated by empty assistant items. Ported from the TUI's
 * AgentDetail groupBlocks. */
export function groupTranscriptBlocks(transcript: readonly TranscriptItem[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let i = 0;
  while (i < transcript.length) {
    const item = transcript[i]!;
    // Providers open assistant items before producing text, including turns
    // that only call tools. Keep their indices for deltas/quotes, but do not
    // create a named message card until there is visible content.
    if (item.role === "assistant" && !item.text.trim()) { i++; continue; }
    if (item.role === "tool") {
      const startIndex = i;
      const items: ToolItem[] = [item];
      const itemIndices = [i];
      let j = i + 1;
      while (j < transcript.length) {
        const next = transcript[j]!;
        if (next.role === "assistant" && !next.text.trim()) { j++; continue; }
        if (next.role !== "tool") break;
        items.push(next);
        itemIndices.push(j++);
      }
      // Spawn lineage and detail keys refer to the original transcript, even
      // when an invisible assistant item sits between two calls.
      const hasGaps = itemIndices.some((index, offset) => index !== startIndex + offset);
      blocks.push({ kind: "tools", items, startIndex, ...(hasGaps ? { itemIndices } : {}) });
      i = j;
    } else {
      blocks.push({ kind: "single", item, index: i });
      i++;
    }
  }
  return blocks;
}

/** How many model turns a strip's calls were spread over.
 *
 *  TURN-COST-VISIBLE: the strip collapses a maximal run of consecutive tool calls, regardless of
 *  which assistant message produced them — so "Bash ×3" reads as one step and is usually three.
 *  Measured across the event log: 91% of multi-tool strips span several turns, and each extra turn
 *  is another full re-read of the whole context, which is where the money goes.
 *
 *  Returns 0 when no call reports a turn (an older daemon, or a backend that does not emit one),
 *  which the renderer treats as "say nothing" rather than guessing. */
export function toolRunTurns(items: readonly ToolItem[]): number {
  const turns = new Set<string>();
  for (const it of items) if (it.turnId) turns.add(it.turnId);
  return turns.size;
}

export type ToolSegment = { name: string; count: number; status: ToolItem["status"] };
const STATUS_SEVERITY: Record<ToolItem["status"], number> = { done: 0, called: 1, denied: 2 };

/** Fold consecutive same-name calls into "Name ×N" segments, worst status
 * winning (ported from the TUI's summarizeRun). */
export function summarizeToolRun(run: readonly ToolItem[]): ToolSegment[] {
  const segments: ToolSegment[] = [];
  for (const t of run) {
    const last = segments[segments.length - 1];
    if (last && last.name === t.toolName) {
      last.count++;
      if (STATUS_SEVERITY[t.status] > STATUS_SEVERITY[last.status]) last.status = t.status;
    } else {
      segments.push({ name: t.toolName, count: 1, status: t.status });
    }
  }
  return segments;
}

export type WindowRange = { start: number; end: number; padTop: number; padBottom: number };

/** Simple index-window over a uniform row-height ESTIMATE: which slice of
 * `total` rows to mount for the given scroll position, plus the pad heights
 * that keep the scroll geometry stable. Pure math (PLAN §7-W3 virtualization).
 *
 * NOTE: superseded for the live transcript by windowRangeMeasured (below),
 * which handles VARIABLE block heights; retained for the estimate-only
 * geometry helpers and its unit coverage. */
export function windowRange(total: number, scrollTop: number, viewportH: number, estRowH: number, overscan: number): WindowRange {
  if (total <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const est = Math.max(1, estRowH);
  const start = Math.max(0, Math.floor(scrollTop / est) - overscan);
  const end = Math.min(total, Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportH)) / est) + overscan);
  return { start, end, padTop: start * est, padBottom: (total - end) * est };
}

export type MeasuredWindow = WindowRange & { totalH: number };

/** Variable-height virtualization window via a PREFIX SUM over per-block
 * heights (heights[i] = block i's measured offsetHeight where known, else the
 * uniform estimate). Because the content height is exactly Σ heights, the
 * scroll geometry is STABLE across window shifts — no estimate/real mismatch to
 * re-clamp against (kills the overflow-anchor oscillation) — and padTop places
 * the first mounted block at its TRUE pixel offset (kills the vertical jump as
 * blocks mount at real heights). `totalH` is that stable content height so the
 * caller can reason about it without a second pass. Pure math.
 *
 *  • start = the block STRADDLING scrollTop (last block whose top offset ≤ top),
 *    then pulled back by `overscan` blocks.
 *  • end   = one past the last block whose top edge is above scrollTop+viewportH
 *    (exclusive), then pushed out by `overscan` blocks; always ≥ start+1 so the
 *    block under the viewport top is mounted even for a zero-height viewport. */
export function windowRangeMeasured(
  heights: readonly number[],
  scrollTop: number,
  viewportH: number,
  overscan: number,
): MeasuredWindow {
  const total = heights.length;
  if (total <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, totalH: 0 };
  // offsets[i] = Σ heights[0..i-1]; offsets[total] = total content height.
  const offsets = new Array<number>(total + 1);
  offsets[0] = 0;
  for (let i = 0; i < total; i++) {
    const h = heights[i]!;
    offsets[i + 1] = offsets[i]! + (Number.isFinite(h) && h > 0 ? h : 0);
  }
  const totalH = offsets[total]!;
  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewportH);
  // start: last block whose top offset ≤ top (the block containing `top`).
  let start = 0;
  while (start + 1 < total && offsets[start + 1]! <= top) start++;
  // end: first block whose top offset ≥ bottom (exclusive upper bound).
  let end = start;
  while (end < total && offsets[end]! < bottom) end++;
  if (end <= start) end = Math.min(total, start + 1);
  const os = Math.max(0, overscan);
  const wStart = Math.max(0, start - os);
  const wEnd = Math.min(total, end + os);
  return { start: wStart, end: wEnd, padTop: offsets[wStart]!, padBottom: totalH - offsets[wEnd]!, totalH };
}

/** TranscriptPanel's follow-tail latch — a single shared threshold so the
 * onScroll handler and the post-measurement re-latch (TUI-UX P0 autoscroll
 * fix) can never disagree about what counts as "at the bottom". Widened from
 * an earlier hardcoded 8px: during a fast fling the mounted window's height
 * cache is still converging (unmeasured blocks landing at their real height
 * over a few commits), so scrollHeight keeps shifting by a few px per commit
 * WITHOUT a native "scroll" event ever firing — an 8px eşik never re-trips
 * mid-convergence and follow-tail silently stays disengaged. */
export const NEAR_BOTTOM_PX = 32;

export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, thresholdPx: number = NEAR_BOTTOM_PX): boolean {
  return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}

// TRANSCRIPT-LAZY-OLDER: the scroll-to-top trigger threshold for paging in one
// older history page — mirrors NEAR_BOTTOM_PX's shape for the opposite edge.
export const NEAR_TOP_PX = 32;

export function isNearTop(scrollTop: number, thresholdPx: number = NEAR_TOP_PX): boolean {
  return scrollTop <= thresholdPx;
}

/** Composer's auto-size geometry (P0 fix) — pure so it's unit-testable — jsdom
 * never lays out `scrollHeight`, so Composer.tsx's DOM effect feeds this the
 * measured values and only the arithmetic is under test here. Driven by the
 * textarea's OWN scrollHeight (Composer.tsx resets it to "auto" first so a
 * shrink is measured too), not composeText.split("\n").length — that only
 * counted explicit newlines, so a long wrapped line stayed a single "row" and
 * hid its overflow. Capped at `maxRows` lines; past that the box stops
 * growing and scrolls internally. `rows` is the box's own height in row
 * units, rounded, for the "N/8 lines" hint display only — the actual textarea
 * height rides `heightPx` directly (sub-pixel accurate, not rows-quantized). */
export function autosizeInput(
  scrollHeight: number,
  lineHeightPx: number,
  maxRows: number,
): { heightPx: number; scroll: boolean; rows: number } {
  const lh = Number.isFinite(lineHeightPx) && lineHeightPx > 0 ? lineHeightPx : 20;
  const maxH = lh * maxRows;
  const scroll = scrollHeight > maxH + 0.5;
  const heightPx = Math.max(lh, Math.min(scrollHeight, maxH));
  const rows = Math.max(1, Math.min(maxRows, Math.round(heightPx / lh)));
  return { heightPx, scroll, rows };
}

export type ScrollHint = { above: number; below: number };

/** The transcript's "↑ N more · ↓ M more" hint counts, ported from the TUI's
 * AgentDetail pairing (AgentDetail.tsx TUI-039/ROW-SCROLL): `above` = rows
 * hidden ABOVE the viewport (scrolled distance / row estimate — shown even at
 * the tail, exactly like the mock's "↑ 59 more" on a live-following pane),
 * `below` = rows hidden BELOW (only >0 while scrolled up; the same ≤8px
 * epsilon the tail-follow logic uses counts as bottom). Pure math over the
 * measured scroll geometry so both directions stay unit-testable. */
export function scrollHintCounts(scrollTop: number, viewportH: number, contentH: number, estRowH: number): ScrollHint {
  const est = Math.max(1, estRowH);
  const above = Math.max(0, Math.floor(Math.max(0, scrollTop) / est));
  const distance = contentH - scrollTop - viewportH;
  const below = distance <= 8 ? 0 : Math.max(1, Math.ceil(distance / est));
  return { above, below };
}

// ---------------------------------------------------------------------------
// transcript timestamps (persisted event ts on projected rows, reconciled
// against the live event ring)
// ---------------------------------------------------------------------------

/** Best-effort per-item creation timestamps for one agent's transcript,
 * using each projected item's authoritative persisted `ts`, with legacy gaps correlated to the
 * event ring by mirroring the reducer's item-creating transitions
 * (message_delta extends an open stream; everything else that pushes gets the
 * event's ts). Older rows can outlive the bounded event ring, so discarding
 * their persisted timestamp here makes every time-windowed workflow section
 * keep them as "unattributable" and duplicate them across steps. A genuinely
 * unstamped local echo stays undefined. Legacy rows require a unique sequence,
 * tool identity or content match; role/order alone cannot identify a row after
 * ring eviction. Ambiguous legacy rows remain unattributable.
 * Signature takes the two slices it reads (events ring + the agent's own
 * transcript) rather than the whole UiState, so the component-side memo can
 * be keyed honestly on exactly those inputs (review finding 6). */
export function transcriptTimestamps(
  events: readonly NormalizedEvent[],
  transcript: readonly TranscriptItem[],
  key: string,
): Array<number | undefined> {
  const t = transcript;
  const ts: Array<number | undefined> = t.map((item) => item.ts);
  let cursor = 0;
  const claim = (role: TranscriptItem["role"], event: NormalizedEvent): void => {
    const candidates: number[] = [];
    const sequenceMatches: number[] = [];
    for (let j = cursor; j < t.length; j++) {
      const item = t[j]!;
      if (item.role !== role) continue;
      if (item.seq === event.seq) sequenceMatches.push(j);
      // A stamped row must participate in correlation, otherwise its event can
      // be misassigned to an older unstamped row with the same text.
      if (item.seq !== undefined && item.seq !== event.seq && item.ts === undefined) continue;
      let matches = false;
      if (item.role === "tool") {
        const toolId = event.data["toolId"] ?? event.data["toolUseId"];
        matches = typeof toolId === "string" ? item.toolId === toolId
          : typeof event.data["toolName"] === "string" && item.toolName === event.data["toolName"];
      } else if ("text" in item) {
        let text = event.data["text"];
        if (event.kind === "error") text = `error: ${String(event.data["message"] ?? "")}`;
        if (event.kind === "failover") text = `failover ${String(event.data["from"])} → ${String(event.data["to"])}`;
        if (event.kind === "result") text = `result: ${String(text ?? "")}`;
        matches = typeof text === "string" && (event.kind === "message_delta"
          ? text.length > 0 && item.text.startsWith(text)
          : item.text === text);
        if (item.role === "user") matches = matches && item.from === event.data["from"];
      }
      if (matches) candidates.push(j);
    }
    const matches = sequenceMatches.length > 0 ? sequenceMatches : candidates;
    if (matches.length !== 1) return;
    const index = matches[0]!;
    if (ts[index] === undefined) ts[index] = event.ts;
    cursor = index + 1;
  };
  let lastRole: TranscriptItem["role"] | null = null;
  let streamOpen = false;
  let lastAssistantText = "";
  for (const e of events) {
    if (qualifiedAgentId(e) !== key) continue;
    switch (e.kind) {
      case "message_delta": {
        if (!(lastRole === "assistant" && streamOpen)) {
          claim("assistant", e);
          lastRole = "assistant";
          streamOpen = true;
          lastAssistantText = "";
        }
        lastAssistantText += String(e.data["text"] ?? "");
        break;
      }
      case "message_complete": {
        if (!(lastRole === "assistant" && streamOpen)) {
          claim("assistant", e);
          lastRole = "assistant";
        }
        streamOpen = false;
        lastAssistantText = String(e.data["text"] ?? "");
        break;
      }
      case "tool_call":
        claim("tool", e);
        lastRole = "tool";
        streamOpen = false;
        break;
      case "status": {
        if (e.data["denied"] === true) {
          claim("tool", e);
          lastRole = "tool";
          streamOpen = false;
        }
        if (e.data["delivered"] === true && e.data["from"] !== "tui" && e.data["from"] !== "app") {
          claim("user", e);
          lastRole = "user";
          streamOpen = false;
        }
        break;
      }
      case "result": {
        const text = String(e.data["text"] ?? "");
        if (text && text !== lastAssistantText) {
          claim("system", e);
          lastRole = "system";
        }
        streamOpen = false;
        break;
      }
      case "error":
      case "failover":
        claim("system", e);
        lastRole = "system";
        streamOpen = false;
        break;
      default:
        break;
    }
  }
  return ts;
}

// ---------------------------------------------------------------------------
// W4 — tool detail card derivations (all pure; ToolDetailCard renders them)
// ---------------------------------------------------------------------------

/** The full input block for the permission/tool-detail cards: a string input
 * renders VERBATIM, an object as JSON — pretty (indent 2) or raw (compact),
 * toggled by mod+e. NEVER truncated (TUI-015: 40-char kesme YASAK). */
export function formatToolInput(input: unknown, pretty: boolean): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return input;
  try {
    return pretty ? JSON.stringify(input, null, 2) : JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/** The dim path/arg hint after a call-list row's name (mock: "· packages/…").
 * Best-effort over the common tool input shapes; "" when nothing usable. */
export function toolPathHint(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["file_path", "path", "command", "pattern", "url", "query"]) {
    if (typeof o[k] === "string" && (o[k] as string).length > 0) return o[k] as string;
  }
  return "";
}

export type EditDiff = { file: string; minus: string[]; plus: string[] };

/** DiffPreview derivation for an Edit-tool input: the FIRST changed hunk's
 * ± lines (≤2 each side, coverage B4 "structuredPatch ilk ±2"), computed from
 * old_string/new_string by stripping the common leading/trailing lines. null
 * when the input isn't an Edit-shaped object or nothing actually changed. */
export function deriveEditDiff(input: unknown): EditDiff | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const oldS = o["old_string"];
  const newS = o["new_string"];
  if (typeof oldS !== "string" || typeof newS !== "string") return null;
  const a = oldS.split("\n");
  const b = newS.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const minus = a.slice(start, endA).slice(0, 2);
  const plus = b.slice(start, endB).slice(0, 2);
  if (minus.length === 0 && plus.length === 0) return null;
  const file = typeof o["file_path"] === "string" ? (o["file_path"] as string).split("/").pop() ?? "" : "";
  return { file, minus, plus };
}

// ---------------------------------------------------------------------------
// W4 — local-echo timestamps (the W3 "local echo has no timestamp" gap)
// ---------------------------------------------------------------------------

/** Merge Date.now()-stamped echo timestamps (recorded by commands.agents.ts at
 * userSent dispatch) into the event-ring-derived list: every user turn with no
 * `from` is by construction a local echo (the reducer dedupes delivered
 * from:"tui"/from:"app" own-surface turns; transcriptTimestamps never claims
 * them), so they pair with
 * the recorded echo stamps IN ORDER. Non-mutating; unattributable items stay
 * undefined exactly as before. */
export function mergeEchoTimestamps(
  ts: ReadonlyArray<number | undefined>,
  transcript: readonly TranscriptItem[],
  echoTs: readonly number[],
): Array<number | undefined> {
  const out = [...ts];
  let claim = 0;
  for (let i = 0; i < transcript.length && claim < echoTs.length; i++) {
    const item = transcript[i]!;
    if (item.role === "user" && item.from === undefined && out[i] === undefined) {
      out[i] = echoTs[claim++];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// top-bar chips
// ---------------------------------------------------------------------------

/** Σ costUsd over every known agent record — the spend chip's number. */
export function totalSpendUsd(state: UiState): number {
  let sum = 0;
  for (const id of state.agentOrder) sum += state.agents[id]?.costUsd ?? 0;
  return sum;
}

/** The spend chip's ▓/░ meter: `slots` glyphs, filled by spend/cap (capped). */
export function spendMeter(spendUsd: number, capUsd = 10, slots = 8): { fill: string; empty: string } {
  const ratio = capUsd > 0 ? Math.min(1, Math.max(0, spendUsd / capUsd)) : 0;
  const filled = Math.min(slots, Math.round(ratio * slots));
  return { fill: "▓".repeat(filled), empty: "░".repeat(slots - filled) };
}

/** Account identity CSS var (mirrors the TUI's accountColor: "main" is always
 * success; every other name FNV-hash-slots into the --acct-1..6 palette). */
export function accountToneVar(name: string): string {
  if (name === "main") return "--success";
  return `--acct-${(fnv1a(name) % 6) + 1}`;
}

// ---------------------------------------------------------------------------
// account quota meters (ACCOUNT-QUOTA-METERS) — pure geometry/formatting only;
// TopBarChips/AccountsCard read these and never recompute a fraction/tone/countdown
// themselves. NODE-env safe (no DOM), `now` always injected so countdown math and
// staleness are deterministic under test.
// ---------------------------------------------------------------------------

/** Looks up one window kind off an (possibly absent) AccountQuota — the one lookup every
 * quota-rendering component uses instead of hand-rolling .find(). */
export function quotaWindow(q: AccountQuota | undefined, kind: AccountQuotaWindow["kind"]): AccountQuotaWindow | undefined {
  return q?.windows.find((w) => w.kind === kind);
}

export type QuotaWindowState = "unknown" | "stale" | "live";

/** "unknown": no window data ever received for this kind (every codex account, always — see
 * claude.ts's normalizeClaudeRateLimit; or a claude account before its first turn). "stale":
 * the reported window's resetsAt has already passed — a new window has silently begun and the
 * last known usedFraction no longer describes it, so rendering it would be a plausible-looking
 * LIE, not just an old number. "live": safe to render usedFraction as-is. Both non-live states
 * degrade the same way in the UI (dim/no fill) — kept as distinct values so tests and
 * data-quota-state hooks can tell "never had data" apart from "had data, now expired". */
export function quotaWindowState(w: AccountQuotaWindow | undefined, now: number): QuotaWindowState {
  if (!w) return "unknown";
  return now >= w.resetsAt ? "stale" : "live";
}

/** Fraction of the window's quota consumed — the fill's extent. Clamped defensively (the
 * source already clamps, but this is a general-purpose pure fn, not just claude.ts's caller). */
export function quotaFillFraction(w: AccountQuotaWindow): number {
  return Math.min(1, Math.max(0, w.usedFraction));
}

/** Fraction of the window's TIME elapsed since it started — the pace marker/notch position.
 * A zero-or-negative-length window (windowStartedAt >= resetsAt — shouldn't happen with a real
 * provider payload, but a real boundary a degenerate one can hit) reads as fully elapsed
 * instead of dividing by zero. Clamped to [0,1] — a window not yet started or already past its
 * reset reads as 0 or 1 respectively, never negative or >1. */
export function quotaElapsedFraction(w: AccountQuotaWindow, now: number): number {
  const span = w.resetsAt - w.windowStartedAt;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now - w.windowStartedAt) / span));
}

/** True when quota is being consumed FASTER than the window replenishes — "will I make it",
 * the question the pace marker exists to answer (fill past the notch). */
export function quotaOverPace(w: AccountQuotaWindow, now: number): boolean {
  return quotaFillFraction(w) > quotaElapsedFraction(w, now);
}

export type QuotaTone = "success" | "warn" | "danger";

/** Reuses spendTone's EXACT 70%/90% threshold scale (usedFraction as a 0..1 "spend" against a
 * fixed "1.0 cap") — no second threshold scale, per the design doc. Quota EXHAUSTION (>=90%
 * used) always wins over an over-pace warning: exhaustion is the harder state (the account is
 * close to/at its limit right now), over-pace is only a trend toward it — so over-pace can only
 * ever surface as "warn", never upgrade past a "danger" exhaustion already in effect. */
export function quotaTone(w: AccountQuotaWindow, now: number): QuotaTone {
  const exhaustion = spendTone(quotaFillFraction(w), 1);
  if (exhaustion === "danger") return "danger";
  return quotaOverPace(w, now) ? "warn" : exhaustion;
}

/** "1h 47m" / "2d 6h" / "12m 3s" / "0s" — day-granular, mirrors commands.system.ts's
 * coolingLong m/s pair but extended with a d/h pair (a weekly window can be days out). A
 * past-or-at reset clamps to "0s" rather than a negative duration. */
export function quotaRelativeCountdown(resetsAt: number, now: number): string {
  const left = Math.max(0, resetsAt - now);
  const days = Math.floor(left / 86_400_000);
  if (days > 0) return `${days}d ${Math.floor((left % 86_400_000) / 3_600_000)}h`;
  const hours = Math.floor(left / 3_600_000);
  if (hours > 0) return `${hours}h ${Math.floor((left % 3_600_000) / 60_000)}m`;
  const mins = Math.floor(left / 60_000);
  if (mins > 0) return `${mins}m ${Math.floor((left % 60_000) / 1000)}s`;
  return `${Math.floor(left / 1000)}s`;
}

/** Absolute reset time — "14:32" for a session window (same/next day, time alone reads fine),
 * "Mon 03:00" for a weekly window (typically days out — the weekday disambiguates). `kind`
 * picks the format; mirrors the AccountsCard design mockup exactly. Local time, like every
 * other wall-clock surface in this app. */
const QUOTA_WEEKDAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function quotaAbsoluteReset(resetsAt: number, kind: AccountQuotaWindow["kind"]): string {
  const d = new Date(resetsAt);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return kind === "weekly" ? `${QUOTA_WEEKDAY_ABBR[d.getDay()]} ${hhmm}` : hhmm;
}

/** The top-bar chip's hover title — states the top-border=session / bottom-border=weekly
 * mapping EXPLICITLY (a two-border encoding with no legend anywhere is a puzzle, not a UI),
 * plus each window's used%/reset, or "no data yet" when nothing has arrived (every codex
 * account, always). Independent of cooling: cooling suppresses quota's TONE in the border
 * rendering (see TopBarChips.tsx) but the underlying numbers still surface here. */
export function quotaChipTitle(quota: AccountQuota | undefined, now: number): string {
  const session = quotaWindow(quota, "session");
  const weekly = quotaWindow(quota, "weekly");
  if (!session && !weekly) return "quota: no data yet";
  const line = (label: string, w: AccountQuotaWindow | undefined): string => {
    if (!w) return `${label}: no data`;
    const pct = Math.round(quotaFillFraction(w) * 100);
    const stale = quotaWindowState(w, now) === "stale" ? " (stale)" : "";
    // WEEKLY-QUOTA-VARIANT-KEYS: names which bucket won the multi-variant selection (e.g.
    // "weekly (opus)") — see AccountsCard.tsx's quotaLabelText for the same convention.
    const labelText = w.variant ? `${label} (${w.variant})` : label;
    return `${labelText}: ${pct}% used, resets ${quotaRelativeCountdown(w.resetsAt, now)}${stale}`;
  };
  return `top border = session, bottom border = weekly -- ${line("session", session)} -- ${line("weekly", weekly)}`;
}

/** QUOTA-ABSENCE-IS-INVISIBLE: one dim caption line for an account whose quota block is
 * otherwise empty (AccountQuotaBlock renders nothing when there's no window at all) — WHY
 * there's nothing to show, never a fabricated figure. Returns null only when there is truly
 * nothing to say yet (no reason recorded — the account has never been polled, e.g. daemon just
 * started). "ok"/"empty" with windows already present is never reached here in practice since
 * the caller only calls this when the quota block is empty, but is handled defensively anyway. */
export function quotaReasonLabel(reason: AccountQuotaReason | undefined): string | null {
  if (!reason) return null;
  const lastTried = `last tried ${fmtClock(reason.at)}`;
  switch (reason.kind) {
    case "unsupported": return reason.detail ? `no quota source: ${reason.detail}` : "no quota source for this auth type";
    case "rate_limited": {
      const retry = reason.nextRetryAt != null ? ` · retrying at ${fmtClock(reason.nextRetryAt)}` : "";
      return `quota poll rate-limited (429) · ${lastTried}${retry}`;
    }
    case "http_error": return `quota poll failed (${reason.httpStatus ?? "unknown status"}) · ${lastTried}`;
    case "network_error": return `quota poll failed (network error) · ${lastTried}`;
    case "empty": return `no quota windows reported · ${lastTried}`;
    case "implausible": return reason.detail ? `quota reading rejected: ${reason.detail}` : `quota reading rejected as implausible · ${lastTried}`;
    case "ok": return null;
  }
}

// ---------------------------------------------------------------------------
// B3 (coverage §B3): the transcript-header skills/mcp summary line —
// "skills 12 · mcp ● chimera". `skills` renders a COUNT; each mcp server renders
// a health glyph + name. Glyphs mirror the theme connection set (the TUI's
// AgentDetail.mcpHealth port): ● connected · ◌ pending/connecting · ○ everything
// else (failed/needs-auth/unknown) — the conservative "down" default so an
// unrecognized status never falsely reads as connected. Pure/DOM-free.
// ---------------------------------------------------------------------------

export function mcpStatusGlyph(status: string): { glyph: string; tone: "success" | "warn" | "muted" } {
  if (status === "connected") return { glyph: "●", tone: "success" }; // ●
  if (status === "pending" || status === "connecting") return { glyph: "◌", tone: "warn" }; // ◌
  return { glyph: "○", tone: "muted" }; // ○
}

export type SkillMcpServer = { glyph: string; tone: "success" | "warn" | "muted"; name: string };
export type SkillMcpSummary = { skillCount: number; servers: SkillMcpServer[] };

/** The B3 header summary, or null when the agent advertises neither skills nor
 * mcp servers (a plain agent renders nothing — header layout unchanged). */
export function skillMcpSummary(agent: AgentView): SkillMcpSummary | null {
  const skills = agent.skills ?? [];
  const servers = agent.mcpServers ?? [];
  if (skills.length === 0 && servers.length === 0) return null;
  return {
    skillCount: skills.length,
    servers: servers.map((s) => {
      const h = mcpStatusGlyph(s.status);
      return { glyph: h.glyph, tone: h.tone, name: s.name };
    }),
  };
}

// ---------------------------------------------------------------------------
// AGENT-INFO-PANEL — the TranscriptPanel header-click inspector. AgentView
// already carries state/model/skills/mcpServers/membership/depth/treeId/cost/
// usage; cwd/permissionProfile/isolation/instructions/on.permissionRequest
// live only in the raw `agent.status` AgentRecord (fetched on demand, see
// commands.agents.ts's useAgentStatus). `status: null` (not yet fetched, or
// an older daemon build) reads every status-only field as null/"—" rather
// than crashing — same defensive-read discipline as specLine/roleConfig
// (selectors.coord.ts).
// ---------------------------------------------------------------------------

export type AgentDetailView = {
  state: string;
  /** "ne yapıyor" — the last logged tool call while busy, or "thinking…"
   * before the first one lands; the most recent tool once idle. */
  activity: string;
  model: string | null;
  effort: string | null;
  /** Which backend ran this agent (record-level `provider` — always stamped)
   * and under which configured account — the user couldn't tell a codex/glm
   * agent from a claude one in the detail panel without these. */
  provider: string | null;
  account: string | null;
  permissionProfile: string | null;
  isolation: string | null;
  permissionRequestMode: string | null;
  cwd: string | null;
  skills: string[];
  mcpServers: string[];
  /** The role/system instructions the agent was spawned with (spec.instructions). */
  rolePrompt: string | null;
  /** The task/spawn prompt this agent is running (spec.prompt). */
  taskPrompt: string | null;
  membership: string | null;
  depth: number | null;
  treeId: string | null;
  /** ROLES-UNIFY §3.3/§6.3: which library role (if any) this agent was spawned
   * from as a session role, plus the sparse overrides actually resolved at
   * spawn time — a FROZEN audit record, never a live/editable template (§9.2:
   * there is no reusable binding to write back to on the agent side). */
  sessionRole: string | null;
  sessionRoleOverrides: Record<string, unknown> | null;
};

export function agentDetailView(agent: AgentView, status: Record<string, unknown> | null): AgentDetailView {
  const spec = status?.["spec"] && typeof status["spec"] === "object" ? (status["spec"] as Record<string, unknown>) : undefined;
  const on = spec?.["on"] && typeof spec["on"] === "object" ? (spec["on"] as Record<string, unknown>) : undefined;
  const lastTool = agent.tools.length > 0 ? agent.tools[agent.tools.length - 1]! : null;
  const activity = agent.busy
    ? lastTool ? `${lastTool.toolName} (${lastTool.status})` : "thinking…"
    : lastTool ? `last: ${lastTool.toolName} (${lastTool.status})` : "—";
  return {
    state: derivedState(agent),
    activity,
    model: typeof spec?.["model"] === "string" ? (spec["model"] as string) : agent.model ?? null,
    effort: typeof spec?.["effort"] === "string" ? (spec["effort"] as string) : agent.effort ?? null,
    provider:
      typeof status?.["provider"] === "string" ? (status["provider"] as string)
      : typeof spec?.["provider"] === "string" ? (spec["provider"] as string)
      : agent.provider ?? null,
    account: typeof status?.["accountName"] === "string" ? (status["accountName"] as string) : agent.account ?? null,
    permissionProfile: typeof spec?.["permissionProfile"] === "string" ? (spec["permissionProfile"] as string) : null,
    isolation: typeof spec?.["isolation"] === "string" ? (spec["isolation"] as string) : null,
    permissionRequestMode: typeof on?.["permissionRequest"] === "string" ? (on["permissionRequest"] as string) : null,
    cwd: typeof spec?.["cwd"] === "string" ? (spec["cwd"] as string) : null,
    skills: agent.skills ?? [],
    mcpServers: (agent.mcpServers ?? []).map((s) => s.name),
    rolePrompt: typeof spec?.["instructions"] === "string" && (spec["instructions"] as string).length > 0 ? (spec["instructions"] as string) : null,
    taskPrompt: typeof spec?.["prompt"] === "string" && (spec["prompt"] as string).length > 0 ? (spec["prompt"] as string) : null,
    membership: agent.membership ? `${agent.membership.team} · ${agent.membership.role}` : null,
    depth: typeof agent.depth === "number" ? agent.depth : typeof status?.["depth"] === "number" ? (status["depth"] as number) : null,
    treeId: agent.treeId ?? (typeof status?.["treeId"] === "string" ? (status["treeId"] as string) : null),
    sessionRole: agent.sessionRole ?? null,
    sessionRoleOverrides: agent.sessionRoleOverrides ?? null,
  };
}
