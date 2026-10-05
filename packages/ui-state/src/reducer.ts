import { ForkLineageSchema } from "@chimera/protocol";
import { mcpListenerTransitions } from "./mcpListener.js";
import { ATTENTION_EVENT_KINDS, parseAgentAddress, ToolOutputImagesSchema, ToolOutputImageWarningsSchema, type ToolOutputImageWarning, type AccountQuotaWindow, type ContentBlock, type NormalizedEvent, type TaskState } from "@chimera/protocol";
import { EVENT_BUFFER_MAX, initialState, NO_PROJECT_CONDUCTOR_KEY, TAB_ORDER, TOOLS_BUFFER_MAX, TRANSCRIPT_BUFFER_MAX, type Action, type AgentQuestion, type AgentRecordLite, type AgentView, type BackgroundTaskItem, type DeepLink, type Image, type McpServerView, type SlashCommandView, type TokenUsage, type TranscriptItem, type UiState } from "./types.js";
import { applyFlowEvent } from "./flow.js";
import { filterOrderForUnseen, isUnseen } from "./seen.js";
import { memoryJumpTargets } from "./memory.js";
import { BUDGET_PAUSE_SCOPE, budgetResumeEffect, budgetSpendSplit, fmtBudgetUsd } from "./budget.js";
import { promptStallClearLine, promptStallOpenLine } from "./promptStall.js";
import { failureLine, failureRecoveredLine, filterOrderForNeedsOperator } from "./failure.js";

// WD Stage 1 (coverage B4): the reducer-side mirror of the backends' tool-result
// bound. The claude/codex backends already truncate what they emit in `data.result`,
// but the codex command_execution fallback path below reads `data.output` — a field
// that predates the bound and can carry an arbitrarily large command log — so the
// projection enforces the same ~16k ceiling before the text lands on a TranscriptItem.
const TOOL_RESULT_MAX_CHARS = 16_000;
const CODEX_SLASH_COMMANDS: SlashCommandView[] = [
  { name: "goal", description: "Native goal: objective, edit <objective>, pause, resume, clear; no arguments shows status" },
  { name: "compact", description: "Compact the native Codex context" },
];
function boundToolResult(text: string): string {
  return text.length > TOOL_RESULT_MAX_CHARS
    ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n… [truncated at ${TOOL_RESULT_MAX_CHARS} chars]`
    : text;
}

// TRANSCRIPT-EVICT-OLD: cap + evict the FRONT of `transcript`, once, when
// (a) it's over TRANSCRIPT_BUFFER_MAX and (b) the operator is pinned at the
// bottom (evicting while they're scrolled up would yank rows out from under
// a reader — see the "atBottom" gate at every call site below, never here).
// Recomputes historyMinSeq from the new-oldest row's stamped `seq` (falling
// back to the previous value on the — should-never-happen — chance the new
// front row predates seq-stamping) and bumps historyEvictedAt so history.ts's
// `exhausted` guard gets cleared: eviction just means there IS older content
// again, so a scroll-to-top must re-fetch instead of sitting dead. Also resets
// historyOlderExhausted to false for the same reason — TRANSCRIPT-WINDOWING's
// sticky "beginning of history reached" flag describes the CURRENTLY RESIDENT
// transcript, and eviction just moved "the beginning" further forward, so the
// stale sticky flag from before the eviction must not block a later re-fetch.
function evictTranscriptFront(agent: AgentView): AgentView {
  if (!agent.atBottom || agent.transcript.length <= TRANSCRIPT_BUFFER_MAX) return agent;
  const transcript = agent.transcript.slice(-TRANSCRIPT_BUFFER_MAX);
  const newOldest = transcript[0];
  const historyMinSeq = newOldest?.seq !== undefined ? newOldest.seq : agent.historyMinSeq;
  return { ...agent, transcript, historyMinSeq, historyEvictedAt: agent.historyEvictedAt + 1, historyOlderExhausted: false };
}

/** BACKGROUND-TASK-VISIBILITY: project one task-lifecycle event onto the agent's background list.
 *
 *  Only BACKGROUNDED local work lands here. A foreground local_bash is already on screen as the
 *  tool call that is blocking on it; adding a second row for it would read as two pieces of work.
 *  Sub-agent and workflow tasks are not touched — those become real shadow rows in core. */
function foldBackgroundTask(agent: AgentView, e: { ts: number; data: Record<string, unknown> }): void {
  const taskId = typeof e.data["taskId"] === "string" ? e.data["taskId"] : "";
  if (!taskId) return;
  const existing = agent.backgroundTasks.find((t) => t.taskId === taskId);
  if (e.data["skipTranscript"] === true || e.data["ambient"] === true) return;
  if (!existing && (e.data["isBackgrounded"] !== true || e.data["subagentType"] || e.data["workflowName"]
    || e.data["taskType"] === "local_agent" || e.data["taskType"] === "local_workflow")) return;
  const status = e.data["status"];
  const next: BackgroundTaskItem["status"] =
    status === "completed" ? "done"
    : status === "failed" ? "failed"
    : status === "killed" || status === "stopped" ? "killed"
    : existing?.status ?? "running";
  const description = typeof e.data["description"] === "string" && e.data["description"]
    ? (e.data["description"] as string) : undefined;
  if (existing) {
    // A later progress update carries no description; it must never blank the one we have.
    if (description) existing.description = description;
    existing.status = next;
    if (next !== "running" && existing.endedAt === undefined) existing.endedAt = e.ts;
    if (typeof e.data["error"] === "string") existing.error = e.data["error"] as string;
    syncTaskTranscriptRow(agent, existing);
    return;
  }
  const item: BackgroundTaskItem = {
    taskId, ts: e.ts, description: description ?? taskId,
    ...(typeof e.data["taskType"] === "string" ? { taskType: e.data["taskType"] as string } : {}),
    status: next,
    ...(typeof e.data["error"] === "string" ? { error: e.data["error"] as string } : {}),
    ...(next !== "running" ? { endedAt: e.ts } : {}),
  };
  agent.backgroundTasks.push(item);
  syncTaskTranscriptRow(agent, item);
}

/** Mirror a background task onto the transcript, in place.
 *
 *  In place rather than append-per-update: the row has to READ as one piece of work whose state
 *  changes, the way the script itself is one piece of work. Appending a second row on completion
 *  would show the same script twice and make a long-running one look like it kept restarting. */
function syncTaskTranscriptRow(agent: AgentView, task: BackgroundTaskItem): void {
  const row = {
    role: "task" as const,
    taskId: task.taskId,
    description: task.description,
    ...(task.taskType !== undefined ? { taskType: task.taskType } : {}),
    status: task.status,
    ...(task.error !== undefined ? { error: task.error } : {}),
    ts: task.ts,
  };
  for (let i = agent.transcript.length - 1; i >= 0; i--) {
    const existing = agent.transcript[i]!;
    if (existing.role === "task" && existing.taskId === task.taskId) {
      // Keep the ORIGINAL seq so the row stays where the script was started; re-stamping it would
      // make a finishing task jump to the bottom of a conversation it began minutes ago.
      agent.transcript[i] = { ...row, ...(existing.seq !== undefined ? { seq: existing.seq } : {}) };
      return;
    }
  }
  agent.transcript.push(row);
}

export function emptyAgent(agentId: string): AgentView {
  return { agentId, state: "unknown", displayLabel: undefined, conductor: false, session: false, transcript: [], tools: [], backgroundTasks: [], costUsd: 0, usage: null, lastEventTs: 0, pendingQuestion: null, pendingDialog: null, resultDetail: null, busy: false, busySince: undefined, promptStall: undefined, manualPaused: false, pauseReason: undefined, resumeAt: undefined, failure: undefined, historyLoaded: false, historyLoadState: "idle", historyLoadError: undefined, historyMinSeq: null, historyOlderLoadState: "idle", historyOlderLoadError: undefined, historyOlderExhausted: false, atBottom: true, historyEvictedAt: 0, flowTree: [], slashCommands: [], plugins: [], skills: [], mcpServers: [], treeId: undefined, depth: undefined, membership: undefined, sessionRole: undefined, sessionRoleOverrides: undefined, shadow: undefined, label: undefined, shadowInfo: undefined, compactingConfirmed: undefined, turnBudgetExceeded: undefined, toolSurfaceEstimate: undefined, toolSurfaceCacheWriteTokens: undefined, toolSurfaceServers: undefined, parentId: undefined, projectId: undefined, remoteControl: undefined, resumedFrom: undefined, jobName: undefined, groups: undefined, createdAt: undefined, attentionAt: undefined, reviewedAt: undefined };
}

// P3-T2 (project-conductor routing): derive the per-project conductor map
// wholesale from a fresh agent.list snapshot -- a candidate is any record with
// spec.conductor===true, keyed by its projectId (NO_PROJECT_CONDUCTOR_KEY when
// null/undefined). A RUNNING candidate always wins over a terminal one for the
// same project (mirrors store.ts's own legacy adoption preference for a LIVE
// conductor); ties (same running-ness) break by latest createdAt, so a newer
// conductor replaces a stale one. Pure/deterministic -- no Math.random/Date.now.
function buildConductorByProject(records: AgentRecordLite[]): Record<string, string> {
  const best = new Map<string, AgentRecordLite>();
  for (const r of records) {
    // WORKFLOW-TASK-VIEW-2 (bug B): scheduler.ts forces spec.conductor:true on
    // EVERY workflow-bound task spawn too (D12 — keeps that session's input
    // stream open across steps), a session-liveness hack unrelated to conductor
    // identity. A real conductor never carries team membership; a workflow step
    // (or any other team-queue) agent always does — skip it here so a step
    // agent can never hijack a project's (or the legacy no-project "main")
    // conductor slot.
    if (r.spec?.conductor !== true || r.membership) continue;
    const key = r.projectId ?? NO_PROJECT_CONDUCTOR_KEY;
    const cur = best.get(key);
    if (!cur) { best.set(key, r); continue; }
    const curRunning = cur.state === "running";
    const rRunning = r.state === "running";
    if (rRunning !== curRunning) { if (rRunning) best.set(key, r); continue; }
    if (r.createdAt > cur.createdAt) best.set(key, r);
  }
  const out: Record<string, string> = {};
  for (const [key, r] of best) out[key] = r.agentId;
  return out;
}

// WS-D (parity: surface plugins/skills read-only): normalize one plugin/skill
// entry to its NAME string. The SDK emits skills as plain strings but plugins as
// `{ name, path, ... }` objects, so accept either shape (string verbatim, or an
// object's string `name`); anything else yields "" so the caller drops it. Pure,
// never throws.
function pluginName(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const name = (entry as Record<string, unknown>)["name"];
    if (typeof name === "string") return name;
  }
  return "";
}

// Task STREE + TRUE-NESTING: pure tree-ordering of agent.list records into the
// flat id order AgentList (and agentOrder-driven nav/windowing) renders. Groups
// records by treeId; within a group, the ROOT (agentId === treeId, or -- when no
// member matches, e.g. a treeId whose root fell out of the snapshot -- the
// lowest-depth/earliest-createdAt member) comes first, then its descendants in
// DEPTH-FIRST PRE-ORDER so every child renders directly beneath ITS OWN parent.
// Records with no treeId (an older daemon shape, or simply absent) fall back to a
// SINGLETON tree keyed by their own agentId, so a flat list with no tree data
// orders identically to the pre-STREE plain createdAt sort.
//
// TRUE-NESTING (why DFS, not the old flat (depth,createdAt) sort): the old sort
// placed a depth-2 grandchild AFTER every depth-1 sibling, so it rendered as a
// sibling of its uncle rather than a child of its parent. DFS pre-order instead
// emits [root, childA, childA's kids…, childB, …], so a sub-agent's own children
// (a worker's chimera-spawned reviewers, native shadow rows) sit directly under
// their real parent at the correct indent.
//
// TEAM CLUSTERING (fixes the duplicate-"▸ team" headers): each team spawns its
// workers as SEPARATE depth-0 trees (the scheduler gives each its own treeId), and
// those trees are created over time interleaved with other trees -- so ordering
// trees by root createdAt alone scatters one team's workers, and AgentList
// re-emits the team's header once per non-contiguous run. We instead CLUSTER trees
// by their ROOT's membership.team so every worker of a team is contiguous (one
// header). A clusters is ordered by its earliest root createdAt; teamless trees are
// each their own singleton cluster, so a flat/no-membership list orders exactly as
// the old per-root createdAt sort (every existing test preserved).
//
// PARENT ATTRIBUTION (P3-T2): agent.list now carries a REAL parentId (P3-T1,
// AgentRecordLite.parentId) alongside treeId/depth/createdAt. When a member's
// parentId names another member of the SAME tree, it wins outright -- exact,
// no ambiguity. Only when it's absent (an older daemon that doesn't emit the
// field yet) or doesn't resolve within this tree (unexpected in practice: a
// spawn always inherits its spawner's own treeId, see supervisor.ts) do we
// fall back to the old heuristic: walking a tree's members in createdAt order,
// a node at depth d parents to the most-recently-seen node at depth d-1 (the
// root is pre-seeded at its own depth, so every depth-1 node -- the common
// case, e.g. a root worker's reviewers -- parents to the root exactly). That
// heuristic is correct for one- and two-level trees; its only ambiguous case
// is a DEEP tree (depth>=2) whose sibling was spawned BETWEEN a parent and
// that parent's own child, which would mis-attribute the grandchild to the
// newer sibling -- exactly the case a real parentId now resolves exactly.
export function treeOrder(records: AgentRecordLite[]): string[] {
  const byId = new Map(records.map((r) => [r.agentId, r]));
  // MULTI-LEVEL-NESTING: a record's tree is derived from its ACTUAL parentId chain — walk up
  // to the topmost ancestor present in this record set, then key the group by that ancestor's
  // treeId (or its id). Keying each record by its OWN treeId silently split a family whenever
  // projected lineage was partial/inconsistent between generations: a depth-1 direct spawn seen
  // only via a lineage-less live event (treeId undefined → singleton group) while its depth-2
  // shadows carried the REAL treeId (→ the conductor's group, where their parentId couldn't
  // resolve and the depth heuristic flattened them under the conductor). Chain-walking makes
  // every child share its resolvable parent's group at ANY depth, so the in-group parentId
  // attribution below is exact; a record with no resolvable parent keys exactly as before
  // (treeId ?? own id), so flat lists and fell-out-root trees order identically.
  const rootKeyOf = new Map<string, string>();
  for (const r of records) {
    let cur = r;
    const hops = new Set([cur.agentId]);           // cycle guard: malformed lineage must not hang
    while (typeof cur.parentId === "string") {
      const p = byId.get(cur.parentId);
      if (!p || hops.has(p.agentId)) break;
      hops.add(p.agentId);
      cur = p;
    }
    rootKeyOf.set(r.agentId, typeof cur.treeId === "string" ? cur.treeId : cur.agentId);
  }
  const groups = new Map<string, AgentRecordLite[]>();
  for (const r of records) {
    const key = rootKeyOf.get(r.agentId) ?? r.agentId;
    const members = groups.get(key);
    if (members) members.push(r);
    else groups.set(key, [r]);
  }
  // One entry per tree: its DFS-ordered ids + the root's createdAt/team (for
  // clustering). Built in group-insertion (first-seen) order so ties stay stable.
  const trees: { rootCreatedAt: number; team: string | undefined; ids: string[] }[] = [];
  for (const [key, members] of groups) {
    let root = members.find((m) => m.agentId === key);
    if (!root) {
      root = members.reduce((best, m) => {
        const bestDepth = best.depth ?? 0;
        const mDepth = m.depth ?? 0;
        if (mDepth < bestDepth) return m;
        if (mDepth === bestDepth && m.createdAt < best.createdAt) return m;
        return best;
      });
    }
    const chosenRoot = root;
    const rootDepth = chosenRoot.depth ?? 0;
    // createdAt order (stable) drives BOTH parent attribution and sibling order.
    const byCreated = members.slice().sort((a, b) => a.createdAt - b.createdAt);
    const memberIds = new Set(members.map((m) => m.agentId));
    // parentAgentId -> children, pushed in createdAt order (so DFS visits
    // siblings oldest-first). `lastAtDepth` holds the most-recently-seen id at
    // each depth; pre-seed the root at its own depth so depth-1 nodes attach to
    // it even when the root isn't the earliest by createdAt (fell-out-root case).
    const childrenOf = new Map<string, AgentRecordLite[]>();
    const lastAtDepth = new Map<number, string>([[rootDepth, chosenRoot.agentId]]);
    for (const m of byCreated) {
      if (m === chosenRoot) continue;
      const d = m.depth ?? 0;
      // P3-T2: prefer the real parentId when it resolves within this tree;
      // else fall back to the depth+createdAt heuristic (see the comment above).
      const parentId = typeof m.parentId === "string" && memberIds.has(m.parentId)
        ? m.parentId
        : lastAtDepth.get(d - 1) ?? chosenRoot.agentId; // orphan -> under the root
      const kids = childrenOf.get(parentId);
      if (kids) kids.push(m);
      else childrenOf.set(parentId, [m]);
      lastAtDepth.set(d, m.agentId);
    }
    // DFS pre-order from the root. A `seen` guard + a leftover sweep keep the
    // walk TOTAL even in a defensive edge that left a node unreachable (never
    // expected, since every parent is the root or an already-processed node).
    const ids: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      ids.push(id);
      for (const c of childrenOf.get(id) ?? []) visit(c.agentId);
    };
    visit(chosenRoot.agentId);
    for (const m of byCreated) if (!seen.has(m.agentId)) visit(m.agentId);
    trees.push({ rootCreatedAt: chosenRoot.createdAt, team: chosenRoot.membership?.team, ids });
  }
  // Cluster trees by their ROOT's team so a team's (separately-rooted) workers are
  // contiguous; a teamless tree is its own singleton cluster keyed by its first
  // id, so it never merges with another. A cluster sorts by its earliest root
  // createdAt; within a cluster, trees keep first-seen order (already createdAt-
  // ish from the group map). Map insertion order + Array#sort stability keep it
  // deterministic (no Math.random/Date.now).
  const clusters = new Map<string, { sortValue: number; ids: string[] }>();
  for (const t of trees) {
    const key = t.team !== undefined ? `team:${t.team}` : `tree:${t.ids[0]}`;
    const c = clusters.get(key);
    if (c) {
      c.sortValue = Math.min(c.sortValue, t.rootCreatedAt);
      c.ids.push(...t.ids);
    } else {
      clusters.set(key, { sortValue: t.rootCreatedAt, ids: [...t.ids] });
    }
  }
  const base = [...clusters.values()].sort((a, b) => a.sortValue - b.sortValue).flatMap((c) => c.ids);
  // Queue/workflow ownership crosses real spawn trees. Move each owned root's
  // whole DFS-contiguous tree directly after its persisted conductor owner.
  // Blocks key on the SAME chain-derived root as the grouping above — keying on a
  // record's own treeId here would re-split a family the chain-walk just unified.
  const blocks = new Map<string, string[]>();
  for (const id of base) {
    const root = rootKeyOf.get(id) ?? id;
    const block = blocks.get(root);
    if (block) block.push(id); else blocks.set(root, [id]);
  }
  const owned = new Map<string, string[][]>();
  for (const [root, ids] of blocks) {
    const r = byId.get(root) ?? byId.get(ids[0]!);
    if (!r?.originConductorId || !byId.has(r.originConductorId)) continue;
    const list = owned.get(r.originConductorId);
    if (list) list.push(ids); else owned.set(r.originConductorId, [ids]);
  }
  const emitted = new Set<string>();
  const splicing = new Set<string>();
  const out: string[] = [];
  const emitBlock = (ids: string[]): void => {
    // Cycle guard: an originConductorId chain (A owned by B, B owned by A) must not
    // recurse forever. `emitted` alone doesn't stop it -- the second loop below
    // unconditionally recurses into an owned block even once every id in it is
    // already emitted, so a block re-visited mid-splice needs its own guard.
    const blockKey = ids[0]!;
    if (splicing.has(blockKey)) return;
    splicing.add(blockKey);
    for (const id of ids) {
      if (emitted.has(id)) continue;
      emitted.add(id); out.push(id);
      // Ownership may point to a nested agent, not only the block root.
      // Visit its queue trees before advancing to an unrelated sibling.
      for (const child of owned.get(id) ?? []) emitBlock(child);
    }
  };
  for (const id of base) {
    if (emitted.has(id)) continue;
    const root = rootKeyOf.get(id) ?? id;
    const block = blocks.get(root) ?? [id];
    const owner = (byId.get(root) ?? byId.get(block[0]!))?.originConductorId;
    if (owner && byId.has(owner)) continue;
    emitBlock(block);
  }
  for (const id of base) if (!emitted.has(id)) emitBlock(blocks.get(rootKeyOf.get(id) ?? id) ?? [id]);
  return out;
}

// LINEAGE MISPARENTING FIX: reconcile the live event path's agentOrder through the SAME
// treeOrder the agent.list snapshot uses, so a projected tree matches the daemon records.
// The event path used to APPEND each newly-seen agent to agentOrder's tail, but both UIs
// render the tree POSITIONALLY over agentOrder (buildDisplayOrder + a depth walk) -- so a
// shadow/child whose event arrived AFTER its parent's later-spawned SIBLING collapsed under
// that sibling instead of its own parent (two research agents' deep-research sub-agents both
// rendering under the SECOND research agent), and a queue worker appended far from its
// conductor rendered under a DIFFERENT one. Only the snapshot merge re-ran treeOrder, so the
// desktop app (which never re-polls, see createStore.ts) stayed wrong forever and the TUI was
// wrong until its next poll. Re-deriving here makes both UIs nest by real parentId + the
// owned-tree owner-splice from the live stream.
//
// LIVE-SPAWN-STABILITY: the createdAt handed to treeOrder must be the SAME key the snapshot
// fold used, or the first live event after a snapshot re-derives sibling and cluster order from
// a different key and permutes rows the operator is pointing at (measured on the 372-record
// fixture: ONE lineage-neutral event moved 116 rows). agentOrder is DFS/cluster order, NOT
// createdAt order, so its index is not a substitute -- use the agent's REAL createdAt, which
// both the agent.list snapshot merge and the two first-sight events stamp. An agent not yet
// stamped keeps the first-seen index proxy, offset PAST every stamped one so a newly-seen agent
// sorts last among its siblings (an insert, never a re-sort of the rows already on screen); a
// fully unstamped list degrades to exactly the old index proxy, so a lineage-free event-only
// list still reconciles to an identical order (no churn).
function reconcileAgentOrder(agents: Record<string, AgentView>, order: string[]): string[] {
  const present = order.filter((id) => agents[id]);
  let maxKnown = 0;
  for (const id of present) {
    const c = agents[id]!.createdAt;
    if (typeof c === "number" && c > maxKnown) maxKnown = c;
  }
  const records = present
    .map((id, i): AgentRecordLite => {
      const a = agents[id]!;
      return {
        agentId: id,
        state: a.state,
        accountName: a.account ?? "",
        provider: a.provider ?? "",
        costUsd: a.costUsd ?? 0,
        createdAt: typeof a.createdAt === "number" ? a.createdAt : maxKnown + 1 + i,
        treeId: a.treeId,
        depth: a.depth,
        parentId: a.parentId,
        forkLineage: a.forkLineage,
        originConductorId: a.originConductorId,
        membership: a.membership,
      };
    });
  return treeOrder(records);
}

// T4 (group fold): the `team:<name>` collapse pseudo-id AgentList.teamCollapseKey
// mints and App dispatches on a group-header click. Kept a LOCAL const (the reducer
// can't import from the ink component, same rationale as visibleAgentOrder below);
// its value is locked against teamCollapseKey by the tui tests.
function teamCollapseKey(team: string): string {
  return `team:${team}`;
}

// T4 (group fold): is `id` a member of a COLLAPSED team group? Mirrors
// AgentList.effectiveTeam + teamCollapseKey EXACTLY -- a row's grouping team is the
// team of its TREE ROOT (a team spawns each worker as a depth-0 root; the reviewers/
// shadows it later spawns share its treeId and inherit membership), folded under the
// `team:<name>` pseudo-id. So visibleAgentOrder's fold-aware nav and buildAgentRows'
// team-collapse skip drop precisely the same rows (locked by the tui tests, since
// the reducer stays free of React/ink).
function isTeamFolded(state: UiState, id: string): boolean {
  const a = state.agents[id];
  if (!a) return false;
  const root = state.agents[a.treeId ?? id] ?? a;
  const team = root.membership?.team;
  return team !== undefined && state.collapsed.has(teamCollapseKey(team));
}

// COLLAPSIBLE SUB-AGENTS: the ordered agent ids currently VISIBLE in AgentList --
// agentOrder minus every id folded away inside a collapsed ancestor's subtree OR a
// collapsed team group. MIRRORS buildAgentRows' fold exactly (same treeId + depth-run
// skip, same collapsible gate, AND the same team-collapse membership skip) so keyboard
// ↑/↓ + wheel selection step over precisely the rows the pane draws -- else the
// selection would walk into a hidden row and the pill would vanish. Kept a LOCAL pure
// helper (not imported from the component) so the reducer stays free of React/ink; the
// shared behavior is locked by tests.
function visibleAgentOrder(state: UiState): string[] {
  // F47.UI: the attention-only filter is applied HERE as well as in the TUI's buildAgentRows —
  // this function is what ↑/↓ walks, so a row the pane no longer draws must not be selectable.
  // F08.UI: needs-operator outranks attention-only for the same reason it does in the app —
  // a death only a human can clear is the most urgent thing the list can say.
  const order = state.needsOperatorOnly
    ? filterOrderForNeedsOperator(state, state.agentOrder)
    : state.unseenOnly
      ? filterOrderForUnseen(state, state.agentOrder)
      : state.agentOrder;
  const depthOf = (id: string | undefined): number => (id === undefined ? 0 : state.agents[id]?.depth ?? 0);
  const treeOf = (id: string | undefined): string | undefined => (id === undefined ? undefined : state.agents[id]?.treeId ?? id);
  const out: string[] = [];
  let skipDepth = -1;
  let skipTree: string | undefined;
  for (let i = 0; i < order.length; i++) {
    const id = order[i]!;
    const d = depthOf(id);
    if (skipDepth >= 0) {
      if (treeOf(id) === skipTree && d > skipDepth) continue; // inside the folded subtree
      skipDepth = -1;
    }
    // T4 (group fold): a member of a COLLAPSED team is hidden too -- mirrors
    // buildAgentRows' team-collapse skip (effectiveTeam is stable per agent, so no
    // depth walk is needed; every row whose group is folded is dropped). Placed after
    // the subtree-skip reset so a folded team nested inside a folded subtree still
    // resolves correctly.
    if (isTeamFolded(state, id)) continue;
    out.push(id);
    const next = order[i + 1];
    const collapsible = next !== undefined && treeOf(next) === treeOf(id) && depthOf(next) > d;
    if (collapsible && state.collapsed.has(id)) { skipDepth = d; skipTree = treeOf(id); }
  }
  return out;
}

// T4 (group fold): after a fold hides the selected row, pick the still-visible agent
// nearest it -- the last visible row ABOVE it in agentOrder, else the first visible
// row below, else null (the whole list folded away, matching selectDelta's empty
// guard). Used only for a TEAM fold: the `team:` header isn't a selectable agent, so
// unlike a per-agent subtree fold (which lifts to the still-visible folded node) the
// selection has nowhere to climb to and must snap to a neighbor.
function nearestVisible(order: string[], visible: string[], sel: string): string | null {
  if (visible.length === 0) return null;
  const selPos = order.indexOf(sel);
  let above: string | null = null;
  for (const id of visible) {
    if (order.indexOf(id) < selPos) above = id; // visible preserves order -> last one below selPos
    else break;
  }
  return above ?? visible[0]!;
}

// F47.QA2: where the selection must land once a mark-seen fold evicts the selected row from the
// attention-only view. `agentsUnseenOnly`/`collapse` already snap the selection out of a row the
// filter hides; the row can ALSO leave because its own reviewedAt moved (bare `m` on the selected
// agent), and that path had no snap — leaving the selection on a row the pane does not draw, which
// reducer-unseen-only.test.ts's header names as the exact invariant `unseenOnly` is shared state to
// uphold. Same nearestVisible rule as the toggle, so both ways of hiding a row agree.
function reselectAfterSeenFold(state: UiState): string | null {
  const sel = state.selectedAgentId;
  if (!sel) return null;
  if (isUnseen(state.agents[sel])) return sel;   // still unseen -> still drawn; skip the O(n) walk
  const visible = visibleAgentOrder(state);
  if (visible.includes(sel)) return sel;         // kept as an ancestor of an unseen descendant
  return nearestVisible(state.agentOrder, visible, sel);
}

// COLLAPSIBLE SUB-AGENTS: is `descId` inside `ancestorId`'s subtree? agentOrder is
// DFS pre-order (treeOrder above), so a node's descendants are exactly the run of
// entries AFTER it, IN THE SAME tree, whose depth stays GREATER than its own --
// the first entry back at (or above) that depth OR in a different tree is a
// sibling / the next tree's root. The treeId guard matches buildAgentRows' own
// fold: a "fell-out-root" tree can start at depth>=1, so a bare depth threshold
// would mis-claim it. Used by the "collapse" action to tell when the selection is
// about to be hidden.
function isSubtreeDescendant(state: UiState, ancestorId: string, descId: string): boolean {
  if (ancestorId === descId) return false;
  // Queue ownership crosses spawn-tree IDs; collapsing its owner must also
  // lift a selected worker (or its child) back onto the visible owner row.
  const pending = [descId];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const agent = state.agents[id];
    for (const parent of [agent?.parentId, agent?.originConductorId]) {
      if (parent === ancestorId) return true;
      if (parent) pending.push(parent);
    }
  }
  const order = state.agentOrder;
  const ai = order.indexOf(ancestorId);
  if (ai < 0) return false;
  const aDepth = state.agents[ancestorId]?.depth ?? 0;
  const aTree = state.agents[ancestorId]?.treeId ?? ancestorId;
  for (let i = ai + 1; i < order.length; i++) {
    const id = order[i]!;
    const d = state.agents[id]?.depth ?? 0;
    const tid = state.agents[id]?.treeId ?? id;
    if (tid !== aTree || d <= aDepth) return false; // left the subtree / tree without matching
    if (id === descId) return true;
  }
  return false;
}

// FEATURE 2 (token usage): pull a normalized TokenUsage off a turn_complete /
// result event, or null when the event carries none. Both backends put per-turn
// usage on `turn_complete`, but in different places and field names:
//   * codex → e.data.usage  ({ input_tokens, cached_input_tokens, output_tokens,
//                              reasoning_output_tokens })   (backends/codex.ts)
//   * claude → e.raw.usage   (the raw SDK result message's `usage`:
//                              { input_tokens, output_tokens,
//                                cache_read_input_tokens, cache_creation_input_tokens })
// We read whichever is present (data first — it's the normalized channel) and
// map both onto the one canonical shape. Codex reasoning is already a subset
// of output_tokens, so it must not be added again.
// Returns null when neither location holds a usage object, so the reducer's
// latest-wins assignment leaves a prior tally untouched on a usage-less turn.
// TOKEN-OPT-P0-1: the terminal "result" event now carries TWO scoped fields —
// contextUsage (last-turn-only) is this function's target (the ctx meter needs the
// CURRENT context size, not the whole run's cumulative total — see billableUsage's doc
// comment in protocol/src/index.ts). "usage" / "turn_complete" events are unaffected —
// both backends still sink per-turn usage under the plain `usage` key there, already the
// right scope — so contextUsage is tried FIRST and usage is the fallback for those kinds.
function readUsageObject(e: NormalizedEvent): Record<string, unknown> | null {
  const fromContextUsage = e.data["contextUsage"];
  if (fromContextUsage && typeof fromContextUsage === "object") return fromContextUsage as Record<string, unknown>;
  const fromData = e.data["usage"];
  if (fromData && typeof fromData === "object") return fromData as Record<string, unknown>;
  const raw = e.raw;
  if (raw && typeof raw === "object") {
    const fromRaw = (raw as Record<string, unknown>)["usage"];
    if (fromRaw && typeof fromRaw === "object") return fromRaw as Record<string, unknown>;
  }
  return null;
}

function extractUsageField(e: NormalizedEvent, field: "billableUsage" | "contextUsage" | "sessionUsage"): TokenUsage | null {
  const value = e.data[field];
  return value && typeof value === "object" ? usageFromObject(value as Record<string, unknown>) : null;
}

// R2 (unified cache-aware token/ctx/cost metrics): the two providers' `input_tokens` carry
// DIFFERENT meanings, verified against real SDK/API docs — Anthropic's is fresh-only (its cache
// figures are additive/separate: full prompt = input_tokens + cache_read_input_tokens +
// cache_creation_input_tokens), OpenAI's INCLUDES cached tokens (cached_input_tokens is a SUBSET
// — a real prompt_tokens example stays IDENTICAL whether cached_tokens is 0 or nonzero). The
// presence of the `cached_input_tokens` key is codex's own signature (claude never sets it) —
// used here to detect which shape we're looking at and normalize both to the SAME canonical
// meaning: `input` = fresh/uncached tokens only, for either provider. After normalization,
// `input + cacheRead + cacheCreation` is the full prompt size uniformly across providers.
export function extractUsage(e: NormalizedEvent): TokenUsage | null {
  const u = readUsageObject(e);
  return u ? usageFromObject(u) : null;
}

function usageFromObject(u: Record<string, unknown>): TokenUsage {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const isCodexShaped = "cached_input_tokens" in u;
  const rawInput = num(u["input_tokens"]);
  const cachedInput = num(u["cached_input_tokens"]);
  return {
    input: isCodexShaped ? Math.max(0, rawInput - cachedInput - num(u["cache_write_input_tokens"])) : rawInput,
    output: num(u["output_tokens"]) + (isCodexShaped ? 0 : num(u["reasoning_output_tokens"])),
    // claude splits cache read/creation; codex reports a single cached-input
    // figure (mapped to cacheRead) and has its own write counter.
    cacheRead: isCodexShaped ? cachedInput : num(u["cache_read_input_tokens"]),
    // TOKEN-OPT-P0-1: cache_write_input_tokens is codex's cache-creation counter (pinned SDK
    // 0.145.0's Usage type) — only one of these two keys is ever present on a given
    // provider's raw object, so summing both is safe (the other is 0).
    cacheCreation: num(u["cache_creation_input_tokens"]) + num(u["cache_write_input_tokens"]),
  };
}

// FEATURE 2 / R2: the current-turn input+output token total — `input` is now the fresh/uncached
// figure for BOTH providers (see extractUsage), so this is apples-to-apples across providers.
// cacheRead/cacheCreation are surfaced separately (not folded in here); see the app's
// fullContextTokens (packages/app/src/state/selectors.ts) for the input+cacheRead+cacheCreation
// "how full is the context window" figure the ctx% meter uses instead.
export function totalTokens(u: TokenUsage): number {
  return u.input + u.output;
}

// COVERAGE: clamp a cursor move into [0, len-1] (or 0 for an empty list), so a
// Teams/Queues/task cursor can never point past the last row after a delta.
function clampCursor(cur: number, delta: number, len: number): number {
  if (len <= 0) return 0;
  return Math.min(len - 1, Math.max(0, cur + delta));
}

// Federation pre-provision PP6: agents minted by a remote engine are keyed
// "<engineId>/<agentId>"; local events (engineId absent or "local") keep the bare id.
// Dead weight until Phase 5 — always returns e.agentId today (accepted).
export function qualifiedAgentId(e: { agentId: string; engineId?: string }): string {
  return !e.engineId || e.engineId === "local" ? e.agentId : `${e.engineId}/${e.agentId}`;
}

// WD Stage 1 (coverage B4): `stampTs` (default false — see the "event" Action's doc
// comment) stamps e.ts onto every transcript item this projection CREATES, via the
// `at` spread helper below. Patches that carry an existing item forward (the
// tool_result done-patch, message_complete finalizing a streaming item) preserve the
// item's ORIGINAL ts — a turn's timestamp is when it started streaming, not when its
// last byte landed.
// W7 (coverage B1 row 3): the unseen-badge fold. Pure over (unseen, kind) so both
// projection paths below (agent events AND ':'-namespaced coordination events —
// a queue task's error is exactly as unseen as an agent's) share one counter rule.
// The activeTab gate lives at the CALL sites: an event arriving while the events
// tab is on screen is seen by definition and must not bump anything.
function bumpUnseen(unseen: UiState["unseen"], kind: NormalizedEvent["kind"]): UiState["unseen"] {
  switch (kind) {
    case "permission_request": return { ...unseen, permissions: unseen.permissions + 1 };
    case "agent_question": return { ...unseen, questions: unseen.questions + 1 };
    case "error": return { ...unseen, errors: unseen.errors + 1 };
    default: return unseen;
  }
}

// Coverage B2/A2 (terminal status projection): the daemon's per-agent `status`
// events carry a `state` string, and a TERMINAL one must land as the agent's
// final AgentView.state and stop it looking busy — else a killed/failed agent
// renders "running" forever and the fleet ◐/⊘ counts never move. The set is the
// ACTUAL strings supervisor.ts (+ reattach.ts) emit on `kind:"status"`:
//   * "killed"      — kill()/closeInput() a paused agent (supervisor.ts)   → "killed"
//   * "failed"      — onError reroute-fail / resume-fail / setModel-fail    → "failed"
//   * "interrupted" — reattach on daemon restart marks in-flight agents     → "failed"
// AgentView.state has no "interrupted" member (types.ts: running|done|failed|
// killed|unknown), so interrupted maps onto "failed" (preserving the prior
// interrupted-only behavior byte-for-byte). NON-terminal status states —
// "paused" (session-limit HOLD, auto-resumes) and "running" (resume) — are
// deliberately absent so they never clobber a live projection (agent.list is
// authoritative for those). "done" arrives via the `result` event and "error"
// via the `error` event, NOT a status event, so neither belongs here.
const STATUS_TERMINAL_STATE: Record<string, AgentView["state"]> = {
  killed: "killed",
  failed: "failed",
  interrupted: "failed",
};

// AGENT-DONE-STATE-STALE-UI: an AgentView.state that has reached a final outcome —
// a terminal snapshot must not preserve a stale pendingQuestion/pendingDialog (see
// the agentRecords merge). Mirrors app selectors.ts isTerminalState.
function isTerminalAgentState(state: AgentView["state"]): boolean {
  return state === "done" || state === "failed" || state === "killed";
}

// BUG shadow-live-state: mirrors AgentSupervisor.upsertShadow's status/label derivation
// (packages/core/src/supervisor.ts) — supervisor.ts now emits this SAME agent_task data under
// the shadow's own agentId (in addition to the pre-existing parent-directed copy that feeds
// flowTree below), so the "agent_task" case can project a shadow row's true state/label
// directly from the live stream instead of waiting on the next agent.list snapshot (the desktop
// app, unlike the TUI, only re-fetches that snapshot on connect/reconnect — see createStore.ts).
function shadowTaskState(data: Record<string, unknown>): AgentView["state"] {
  const status = data["status"];
  return status === "completed" ? "done" : status === "failed" ? "failed" : status === "killed" ? "killed" : "running";
}
function shadowTaskLabel(data: Record<string, unknown>): string | null {
  return (typeof data["subagentType"] === "string" && data["subagentType"]) ||
    (typeof data["workflowName"] === "string" && data["workflowName"]) ||
    null;
}

// LINEAGE remainder of the shadow-live-state bug: `shadow:<parentAgentId>:<taskId>` — split
// on the LAST ':' rather than the first, since a federated parent id can itself contain a
// ':' (the "<engineId>/<localId>" qualifier uses '/', but a remote-engine-minted local id is
// not otherwise constrained). Returns null for a malformed id (no ':' left after the prefix).
function parseShadowLineageFromId(agentId: string): { parentId: string; taskId: string } | null {
  if (!agentId.startsWith("shadow:")) return null;
  const rest = agentId.slice("shadow:".length);
  const cut = rest.lastIndexOf(":");
  if (cut <= 0) return null;
  return { parentId: rest.slice(0, cut), taskId: rest.slice(cut + 1) };
}

/** SHADOW-NAME-FALLBACK: what to call a shadow row that has no label yet.
 *
 *  Both UIs fell back to `shortId(agentId)` — the first 8 characters of
 *  `shadow:<parentAgentId>:<taskId>`, which is the literal "shadow:" plus ONE character of the
 *  PARENT's id. That rendered as e.g. "shadow:4": not a name, and worse, it reads like a task
 *  number it has nothing to do with. The task id is the only part of the id that identifies THIS
 *  row, so use that; null for anything that is not a shadow id, leaving the caller's own fallback. */
export function shadowFallbackName(agentId: string): string | null {
  return parseShadowLineageFromId(agentId)?.taskId ?? null;
}

// LINEAGE: fold parentId/treeId/depth/projectId/membership/originConductorId onto a shadow's
// AgentView from a (possibly lineage-carrying) agent_task event, same defensive typeof-guard /
// absent-never-clobbers rule as the agentRecords snapshot merge. When the daemon is old enough to
// omit the new fields, derive parentId from the shadow id's own shape and, if the parent is already
// projected client-side, borrow its treeId/depth/originConductorId (parent.depth + 1) — belt-and-
// braces so a mixed-version daemon (or an event that races the very first lineage-carrying one)
// still nests correctly instead of falling back to a detached singleton cluster.
//
// SHADOW-NESTING-UI: the app's AgentList indents on `displayDepth` (= raw depth + the conductor-
// owned +1 bump, see the agentRecords merge), so a shadow that fell through with displayDepth
// undefined rendered at its RAW depth — one level too shallow, i.e. a SIBLING of its own parent
// worker directly under the conductor (a queue-spawned worker carries originConductorId, so its
// own displayDepth is bumped, but the shadow's wasn't). We therefore (a) fold the shadow's
// originConductorId — event-carried, else inherited from the projected parent, since a shadow's
// owner is exactly its parent's owner (supervisor.upsertShadow sets originConductorId: parent.…) —
// and (b) recompute displayDepth from the SAME formula the snapshot merge uses, so the event-fold
// path and the poll-snapshot path project a shadow's indent identically.
function applyShadowLineage(agent: AgentView, data: Record<string, unknown>, agentId: string, agents: Record<string, AgentView>): void {
  if (typeof data["parentId"] === "string") agent.parentId = data["parentId"];
  if (typeof data["treeId"] === "string") agent.treeId = data["treeId"];
  if (typeof data["depth"] === "number") agent.depth = data["depth"];
  if (data["projectId"] === null || typeof data["projectId"] === "string") agent.projectId = data["projectId"] as string | null;
  if (data["originConductorId"] === null || typeof data["originConductorId"] === "string") agent.originConductorId = data["originConductorId"] as string | null;
  const m = data["membership"];
  if (m && typeof m === "object" && typeof (m as Record<string, unknown>)["team"] === "string") {
    agent.membership = m as { team: string; role: string };
  }
  const derivedParentId = agent.parentId ?? parseShadowLineageFromId(agentId)?.parentId;
  if (agent.parentId === undefined && derivedParentId !== undefined) agent.parentId = derivedParentId;
  const parent = derivedParentId !== undefined ? agents[derivedParentId] : undefined;
  if (parent) {
    if (agent.treeId === undefined) agent.treeId = parent.treeId ?? derivedParentId;
    if (agent.depth === undefined) agent.depth = (parent.depth ?? 0) + 1;
    // A shadow's owner is its parent's owner (they render under the same conductor). Inherit
    // it when the event didn't carry one, so displayDepth's +1 bump matches the worker's.
    if (agent.originConductorId === undefined) agent.originConductorId = parent.originConductorId ?? null;
  }
  // Mirror the agentRecords merge's displayDepth EXACTLY so both projection paths agree.
  if (agent.depth !== undefined) agent.displayDepth = agent.depth + (agent.originConductorId ? 1 : 0);
}

// W7: zeroed counters — selectTab/tabNext/tabPrev landing on "events" resets to
// THIS (fresh object, so a reset from an already-zero state still no-ops via
// reduce()'s identity check only when nothing else changed — selectTab always
// changes activeTab anyway).
const UNSEEN_ZERO: UiState["unseen"] = { permissions: 0, questions: 0, errors: 0 };

// W18 (F16 task workflows): a dim system-line banner for the bound agent's
// transcript at each task_step_advanced/_failed — mirrors the "result:"/
// "error:"/"failover" system banners above (same .system dim style, no new
// TranscriptItem variant needed). Pure/defensive: any missing field renders "?"
// rather than throwing (the daemon's event.data is an unvalidated z.record).
function workflowStepBannerText(e: NormalizedEvent): string {
  const stepNo = typeof e.data["stepIndex"] === "number" ? (e.data["stepIndex"] as number) + 1 : "?";
  const stepId = typeof e.data["stepId"] === "string" ? (e.data["stepId"] as string) : "?";
  if (e.kind === "task_step_failed") {
    const reason = typeof e.data["reason"] === "string" ? (e.data["reason"] as string) : "gate failed";
    const retrying = e.data["willRetry"] === true ? " (retrying)" : "";
    return `step ${stepNo} ${stepId} failed: ${reason}${retrying}`;
  }
  const title = typeof e.data["title"] === "string" ? (e.data["title"] as string) : stepId;
  return `step ${stepNo} → ${title}`;
}

// F01-QA follow-up: a job fired late by the sleep-wake catch-up path spawns its agent AFTER the
// clock_jump line has already been dropped into every agent that was busy at jump time — this one
// was not busy yet, so it would otherwise show no trace of why its very first turn started hours
// after the nominal slot. Same wording as the app/tui events-feed formatter (coord.ts /
// selectors.coord.ts `job_run_started` case) so the two surfaces never say different things about
// the same run; kept in sync by hand since ui-state cannot import from either.
function jobRunStartedBannerText(e: NormalizedEvent): string {
  const job = typeof e.data["job"] === "string" ? (e.data["job"] as string) : "job";
  if (e.data["readopted"] === true) {
    return `${job}: re-adopted a run that was still in flight when the daemon restarted`;
  }
  const latenessMs = e.data["latenessMs"];
  const late = typeof latenessMs === "number" && Number.isFinite(latenessMs) ? fmtGap(Math.abs(latenessMs)) : null;
  const n = typeof e.data["coalescedOccurrences"] === "number" ? (e.data["coalescedOccurrences"] as number) : 0;
  const coal = n > 0 ? ` · ${n} occurrence${n === 1 ? "" : "s"} coalesced` : "";
  return `${job} ran late${late ? ` by ${late}` : ""} (machine was asleep)${coal}`;
}

// F02.UI: a clock jump is a DAEMON-side observation with no agent of its own (agentId "clock"),
// so without a line here it exists only as a raw row in the events feed. The agents that were
// mid-turn when the machine suspended are exactly the ones it misleads: their busy/thinking
// elapsed counters silently absorb the gap, so a 9h suspend reads as a 9h hung turn. Same
// "no new TranscriptItem variant" rule as checkpointCreatedBannerText above.
function clockJumpBannerText(e: NormalizedEvent): string {
  const drift = typeof e.data["driftMs"] === "number" ? Math.abs(e.data["driftMs"] as number) : 0;
  const gap = fmtGap(drift);
  return e.data["direction"] === "backward"
    ? `\u23f1 the system clock stepped back ${gap} \u2014 elapsed times spanning this point are unreliable`
    : `\u23f1 chimera slept ${gap} \u2014 elapsed time on this turn includes the sleep`;
}

// "9h 13m" / "13m" / "45s" — the same shape the app's fmtDuration renders, kept local because
// ui-state has no formatting module and must not depend on packages/app.
function fmtGap(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m`;
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

// F20 (W22, D16 checkpoints): a dim ⚑ system-line banner for the bound
// agent's transcript at each checkpoint_created — same "no new TranscriptItem
// variant" rule as workflowStepBannerText above. checkpoint_reverted carries
// no agentId (a revert is keyed by cwd/ref, not a caller) so it gets no
// banner — only creation does, per F20's "marker rows in the transcript at
// checkpoint creation".
function checkpointCreatedBannerText(e: NormalizedEvent): string {
  const id = typeof e.data["id"] === "string" ? (e.data["id"] as string) : "?";
  const trigger = e.data["trigger"];
  const label = trigger === "manual" ? "manual (ctrl+s)" : trigger === "task_start" ? "task start" : "before a destructive command";
  return `⚑ checkpoint cp-${id} · ${label}`;
}

// COMPACTION-OBSERVABILITY: the ONE place a "compaction" event becomes a visible transcript
// line — previously this was either entirely silent (generic.ts's splice) or buried in an
// unrendered status{compacted} blob (claude.ts) nothing in the reducer ever read. Two distinct
// owners get two distinct, HONEST phrasings: owner:"chimera" reports the exact mechanical
// effect (compaction.ts never summarizes via an LLM call, so "dropped N round(s)" is literally
// true, never "summarized"); owner:"sdk" reports only what the provider's own SDK told us
// (tokens before/after — chimera has no visibility into ITS mechanism, so this never guesses).
function compactionBannerText(e: NormalizedEvent): string {
  // A provider that does not report WHY it compacted must not have "budget" asserted on its
  // behalf — ACP (kimi) carries no trigger field at all, and reading an unknown as the common
  // case is how a guess becomes a displayed fact.
  const trigger = e.data["trigger"];
  const triggerLabel = trigger === "manual" ? "manual" : trigger === "budget" ? "budget" : "trigger unknown";
  const before = e.data["before"] as { messages?: number; chars?: number; tokens?: number } | undefined;
  const after = e.data["after"] as { messages?: number; chars?: number; tokens?: number } | undefined;
  if (e.data["owner"] === "sdk") {
    const size = (s?: { tokens?: number }) => typeof s?.tokens === "number" ? `~${s.tokens.toLocaleString()} tok` : "?";
    return `⇥ context compacted (${triggerLabel}, provider-native): ${size(before)} → ${size(after)}`;
  }
  const droppedRounds = e.data["droppedRounds"];
  const size = (s?: { chars?: number }) => typeof s?.chars === "number" ? `${s.chars.toLocaleString()} chars` : "?";
  return `⇥ context compacted (${triggerLabel}): dropped ${String(droppedRounds ?? "?")} earlier round(s), ${size(before)} → ${size(after)}`;
}

// OWN-TURNS-SURVIVE-RELOAD: a "delivered" status event with from==="tui" fires
// for EVERY send, live or replayed. Live, the sending client already pushed a
// local echo via "userSent" (a plain user turn, no `from`) before the delivered
// event round-trips back — so this dedupes against that echo rather than
// blanket-skipping, which is what silently dropped the user's own turns from
// a rebuilt-from-history transcript after a reload (no echo survives in
// memory across a reload, only the event history does). Search a bounded tail
// window, not just the last item -- the echo may be followed by the
// assistant's streaming reply before the delivered event lands.
// BUDGET-EVENTS-INVISIBLE: the four supervisor budget status events (live-estimate pause,
// booked pause ±afterResume, operator release, auto-reconcile back under the cap) only ever
// reached the pause banner, which renders the CURRENT state and nothing about how the tree got
// there — so a pause that self-cleared, or an operator's release, left no trace anyone could
// read back afterwards. Mirrors the undeliveredMessage/turnLimitStop lines below: same
// already-existing system-transcript surface, no new UI.
export function budgetStatusLine(data: Record<string, unknown>): string | null {
  if (data["reason"] !== "budget") return null;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const f = {
    totalCostUsd: n(data["totalCostUsd"]),
    estimatedUsd: n(data["estimatedUsd"]),
    maxBudgetUsd: n(data["maxBudgetUsd"]),
  };
  if (data["paused"] === true) {
    // The live-estimate pause fires mid-turn off token counts and carries no estimatedUsd —
    // its whole point is that the spend has NOT booked yet, so it must not claim a split.
    if (data["live"] === true) {
      return `budget pause — the in-flight turn would carry this tree past its ${fmtBudgetUsd(f.maxBudgetUsd)} cap (${fmtBudgetUsd(f.totalCostUsd)} booked so far, plus the running turn's estimate) — ${BUDGET_PAUSE_SCOPE}.`;
    }
    const again = data["afterResume"] === true ? " Re-paused after an operator resume — still over the cap." : "";
    return `budget pause — ${budgetSpendSplit(f)} — ${BUDGET_PAUSE_SCOPE}.${again}`;
  }
  if (data["resumed"] === true) {
    return `budget resumed by the operator — ${budgetResumeEffect(f)}`;
  }
  return `budget pause cleared — this tree is back under its ${fmtBudgetUsd(f.maxBudgetUsd)} cap (${fmtBudgetUsd(f.totalCostUsd)} spent).`;
}

const RECENT_ECHO_WINDOW = 8;
function hasRecentUserEcho(transcript: TranscriptItem[], text: string): boolean {
  const start = Math.max(0, transcript.length - RECENT_ECHO_WINDOW);
  for (let i = transcript.length - 1; i >= start; i--) {
    const item = transcript[i]!;
    if (item.role === "user" && item.from === undefined && item.text === text) return true;
  }
  return false;
}

// Reserved system-event agentId namespaces (engine.ts): config_changed/_error,
// network/federation, and capability_decision are appended under these synthetic
// ids, NOT real agents. Like the ':'-namespaced coordination entities below, they
// belong in the global event feed but must NEVER materialize a row in the agent
// list (a config change was spawning a phantom "config" agent). ('job:<name>' and
// 'shadow:<...>' already carry a ':', so they're handled by that branch.)
// HOOK-6: the HookEngine appends hook_fired/hook_error/hook_suppressed under the
// synthetic "hooks" agentId (core/src/hooks.ts) — add it here so a firing hook never
// spawns a phantom "hooks" agent, exactly like "config" above. (signal_delivered
// rides the REAL subscriber agentId, so it belongs in that agent's feed and is NOT
// listed here.)
// PHANTOM-PRINCIPAL-ROWS: notify.ts appends notify/notify_error under the synthetic
// "notify" agentId (a stamp meaning "the notify subsystem emitted this", not an agent
// that exists — a toast/a2a/webhook delivery receipt) and events.ts appends
// event_log_recovery under "eventlog". Both were missing from this set, so each was
// materializing its own phantom AgentView (bare word, no ':', so the coordination-
// entity branch above never caught them) — e.g. the operator-visible "notify" row at
// state "unknown" forever, since no agent.list snapshot ever backs it. The underlying
// conditions these rules watch (permission_request, agent_question, job_run_finished
// failed, budget_warning) already reach the operator through their OWN dedicated
// surfaces (pendingPermissions/pendingQuestion/tasks/SLO breaches — see inbox.ts); the
// "notify" event itself is delivery telemetry, correctly staying in the global event
// feed only, exactly like "config"/"hooks" above.
// F02: JobScheduler appends clock_jump under the synthetic "clock" agentId (same
// system-event namespacing) — without it a suspend/resume would spawn a phantom
// "clock" agent row exactly like the "config"/"hooks" bugs above.
// QUOTA-UNCOOL: "accounts" carries account_cooldown_cleared — an account-level audit event with
// no agent behind it, exactly like "config"/"network"/"clock" above.
// F36.UI: MemoryStore appends memory_pressure and the truncated eviction SUMMARY under
// the synthetic "memory" agentId (the per-record ones use "memory:<id>", which the colon
// rule below already catches) — without it the shared store filling up would spawn a
// phantom "memory" agent row exactly like the "config"/"clock" bugs above.
const SYSTEM_EVENT_AGENT_IDS = new Set(["config", "network", "federation", "capability", "hooks", "notify", "eventlog", "clock", "accounts", "wake", "memory"]);

// HOOK-6: fold a hook_fired / hook_suppressed event into the per-rule status map the
// HooksCard reads. Pure and identity-stable — any other kind returns `prev` unchanged
// so callers can spread it into both projectEvent return paths for free.
function foldHooks(prev: UiState["hooks"], e: NormalizedEvent): UiState["hooks"] {
  if (e.kind !== "hook_fired" && e.kind !== "hook_suppressed") return prev;
  const rule = typeof e.data["rule"] === "string" ? (e.data["rule"] as string) : null;
  if (!rule) return prev;
  const cur = prev[rule] ?? { fireCount: 0, suppressCount: 0 };
  const next = e.kind === "hook_fired"
    ? { ...cur, lastFired: e.ts, fireCount: cur.fireCount + 1 }
    : {
        ...cur,
        lastSuppressed: e.ts,
        suppressCount: cur.suppressCount + 1,
        ...(typeof e.data["reason"] === "string" ? { lastSuppressReason: e.data["reason"] as string } : {}),
      };
  return { ...prev, [rule]: next };
}

// ELAPSED-TIMER: drive an agent busy, stamping busySince (the turn-start ts) ONLY
// on the false→true transition so it marks when the CURRENT turn began, not the
// latest event. Preserved across the turn's remaining busy-keeping events; cleared
// by goIdle on turn_complete/result/error/terminal. See AgentView.busySince — the
// thinking/streaming elapsed counters anchor on this so a transcript opened
// mid-turn shows TRUE elapsed instead of resetting to mount-relative 0.
function goBusy(agent: AgentView, ts: number): void {
  if (!agent.busy) agent.busySince = ts;
  agent.busy = true;
}
/** End-of-turn bookkeeping. `terminal` means the AGENT is finished (done/failed/paused), not just
 *  this turn — which is the difference that decides whether an in-flight compaction survives. */
function goIdle(agent: AgentView, terminal = false): void {
  agent.busy = false;
  agent.busySince = undefined;
  // SLASH-COMMAND-IN-FLIGHT: bound by the turn — the command is done when the turn is, whatever
  // it printed.
  agent.pendingCommand = undefined;
  // COMPACTION-OUTLIVES-THE-TURN: this used to clear `compacting` unconditionally, bounding it by
  // the turn so a provider that quietly ignored a /compact could not leave the indicator spinning
  // forever. But a provider-native compaction genuinely outlives its turn: observed live, the
  // turn_complete landed 3 seconds after the compaction START and its completion arrived 3m11s
  // later — so the app called it finished while ~800k tokens were still being compacted behind it,
  // and the banner turned up after the operator had already sent their next message.
  //
  // The discriminator is who said what. A compaction the PROVIDER announced (phase:"start") is
  // confirmed in flight and is ended only by its own completion/abort. One chimera merely
  // REQUESTED was never confirmed to have begun, so the old turn bound still applies to it.
  // Either way a terminal state clears it: once the agent is gone, no completion is coming.
  if (terminal || !agent.compactingConfirmed) {
    agent.compacting = false;
    agent.compactingConfirmed = undefined;
  }
}

// AGENT-IDENTITY-INVISIBLE-IN-APP: account/provider/permissionProfile/permissionRequest used to
// reach a client ONLY through the agent.list -> `agentRecords` fold, which the desktop app never
// dispatches (it is event-sourced; `agentRecords` appears in packages/app in TESTS ONLY — which is
// exactly why the whole suite stayed green while the app showed no account/permission chip at all).
// Core now stamps all four onto both first-sight events — the registration marker
// (status{registered}) and agent_started — so an event-only client learns them too. Factored
// rather than inlined at both call sites (unlike the lineage folds beside them, whose duplication
// the surrounding comments already flag as debt): four fields that must stay byte-identical across
// two folds are precisely what drifts. Authoritative-when-present, same convention as
// remoteControl/gitBranch — an older daemon omits them and each field keeps whatever the
// agentRecords snapshot or a live permissionChanged event had already set.
function foldAgentIdentity(agent: AgentView, data: Record<string, unknown>): void {
  if (typeof data["accountName"] === "string") agent.account = data["accountName"];
  if (typeof data["provider"] === "string") {
    if (agent.provider !== data["provider"]) agent.slashCommands = [];
    agent.provider = data["provider"];
    if (agent.provider === "codex") agent.slashCommands = [...CODEX_SLASH_COMMANDS];
  }
  if (typeof data["permissionProfile"] === "string") agent.permissionProfile = data["permissionProfile"];
  if (typeof data["permissionRequest"] === "string") agent.permissionRequest = data["permissionRequest"];
  // JOB-FLEET-GROUPING: jobName/createdAt are stamped once at spawn and never change,
  // same authoritative-when-present shape as the four fields above.
  if (typeof data["jobName"] === "string") agent.jobName = data["jobName"];
  if (typeof data["createdAt"] === "number") agent.createdAt = data["createdAt"];
  // AGENT-GROUPS Phase 1: the SPAWN-TIME value only (spec.groups, if the operator assigned one
  // at spawn) — this function runs on both first-sight events, so it covers the initial stamp
  // the same way jobName does. Unlike jobName, membership can change LATER via agent.setGroups;
  // that live re-emit is folded separately in case "status" below (ungated by `registered`,
  // since a rename can arrive on ANY status event, not just the first-sight ones).
  if (Array.isArray(data["groups"])) {
    agent.groups = data["groups"].filter((g): g is string => typeof g === "string");
  }
}

function projectEvent(state: UiState, e: NormalizedEvent, stampTs = false): UiState {
  if (e.seq <= state.lastSeq) return state;                        // dedupe: tail replay vs live subscribe
  // W7 (coverage B1 row 3): fold the unseen badge BEFORE the per-kind projection
  // so both return paths carry it; gated off entirely while the events tab is
  // active. The permission_request case is refined below — a duplicate requestId
  // (already pending) must not double-count, so that kind is bumped inside the
  // switch instead of here.
  let unseen = state.activeTab !== "events" && e.kind !== "permission_request"
    ? bumpUnseen(state.unseen, e.kind)
    : state.unseen;
  // HOOK-6: fold hook_fired/hook_suppressed into the per-rule status map before the
  // per-kind projection so both return paths carry it (a hook_* event has agentId
  // "hooks" and lands in the system branch; the fold is a no-op for every other kind).
  const hooks = foldHooks(state.hooks, e);
  // Id rule (a): ':'-namespaced ids (team:/queue:/task:) are Phase 2 coordination
  // entities, never agents — keep them in the global feed, out of the agent list.
  // R2 (inline sub-agent/workflow surfacing) EXCEPTION: a `shadow:<parentAgentId>:<taskId>`
  // agentId also contains colons, but IS a real (synthetic) agent — supervisor.ts now routes a
  // subagent-tagged message_complete/tool_call/tool_result under exactly this id (see its
  // subagentToolUseIndex) so the shadow gets a real transcript. Without this exemption those
  // events would be silently swallowed by the coordination-entity branch below instead of
  // reaching the per-agent switch (qualifiedAgentId doesn't split on colons — for a local event
  // it returns e.agentId verbatim, so the id round-trips as the `agents` map key unchanged).
  if ((e.agentId.includes(":") && !e.agentId.startsWith("shadow:")) || SYSTEM_EVENT_AGENT_IDS.has(e.agentId)) {
    // W18 (F16 task workflows): task_step_advanced/_failed carry a synthetic
    // `task:<taskId>` agentId (there is no per-step agent), so they'd otherwise
    // be invisible outside the coordination screens' event feed. Resolve the
    // REAL worker agent bound to this task (via the already-loaded queue
    // drill-in, if the daemon supplied one) and drop a dim banner into ITS
    // transcript too — best-effort: no open drill / no bound agent leaves
    // every agent projection untouched, exactly like today.
    let agents = state.agents;
    let tasks = state.tasks;
    let queues = state.queues;
    let queueDetail = state.queueDetail;
    if (e.kind === "task_step_advanced" || e.kind === "task_step_failed") {
      const taskId = e.data["taskId"];
      const task = typeof taskId === "string"
        ? state.queueDetail?.tasks.find((t) => t["taskId"] === taskId)
        : undefined;
      const boundAgentId = task?.["agentId"];
      if (typeof boundAgentId === "string" && agents[boundAgentId]) {
        const prevAgent = agents[boundAgentId]!;
        const at = { seq: e.seq, ...(stampTs ? { ts: e.ts } : {}) };
        const transcript = [...prevAgent.transcript, { role: "system" as const, text: workflowStepBannerText(e), ...at }];
        agents = {
          ...agents,
          // TRANSCRIPT-EVICT-OLD: evictTranscriptFront is a no-op unless the
          // agent is both over the cap AND pinned at the bottom — see its own
          // doc comment (and the primary trim below) for why.
          [boundAgentId]: evictTranscriptFront({ ...prevAgent, transcript }),
        };
      }
    } else if (e.kind === "checkpoint_created") {
      // F20 (D16/W22): the REAL bound agent id rides directly on data.agentId
      // (CheckpointStore.create always resolves it via scheduler.taskFor at
      // create time) — no queueDetail lookup needed, unlike the workflow-step
      // case above. Absent (a caller that omitted agentId) leaves every agent
      // projection untouched, same best-effort rule as task steps.
      const boundAgentId = e.data["agentId"];
      if (typeof boundAgentId === "string" && agents[boundAgentId]) {
        const prevAgent = agents[boundAgentId]!;
        const at = { seq: e.seq, ...(stampTs ? { ts: e.ts } : {}) };
        const transcript = [...prevAgent.transcript, { role: "system" as const, text: checkpointCreatedBannerText(e), ...at }];
        agents = {
          ...agents,
          [boundAgentId]: evictTranscriptFront({ ...prevAgent, transcript }),
        };
      }
    } else if (e.kind === "job_run_started" && e.data["trigger"] === "sleep-wake") {
      // F01-QA follow-up: this agent was not busy at clock_jump time (it did not exist yet), so
      // without this case a late catch-up run's transcript starts cold with no hint that hours
      // passed between the nominal slot and the first turn. Only the agent-spawning targets
      // (agentSpec/role-library) carry data.agentId; team/task and command targets have no
      // AgentView to stamp, same best-effort "absent leaves every projection untouched" rule as
      // the other coordination-entity cases above.
      const boundAgentId = e.data["agentId"];
      if (typeof boundAgentId === "string" && agents[boundAgentId]) {
        const prevAgent = agents[boundAgentId]!;
        const at = { seq: e.seq, ...(stampTs ? { ts: e.ts } : {}) };
        const transcript = [...prevAgent.transcript, { role: "system" as const, text: jobRunStartedBannerText(e), ...at }];
        agents = {
          ...agents,
          [boundAgentId]: evictTranscriptFront({ ...prevAgent, transcript }),
        };
      }
    } else if (e.kind === "clock_jump") {
      // F02.UI: drop the sleep/wake line into the transcript of every agent that was MID-TURN
      // when the gap happened — those are the ones whose elapsed counters absorbed it. An idle
      // fleet gets no lines at all (nothing was misled), so a suspend never spams every
      // transcript; the schedules banner and the events feed carry the fleet-level signal.
      const at = { seq: e.seq, ...(stampTs ? { ts: e.ts } : {}) };
      const text = clockJumpBannerText(e);
      const busyIds = Object.keys(agents).filter((id) => agents[id]!.busy);
      if (busyIds.length > 0) {
        const next = { ...agents };
        for (const id of busyIds) {
          const prevAgent = next[id]!;
          next[id] = evictTranscriptFront({ ...prevAgent, transcript: [...prevAgent.transcript, { role: "system" as const, text, ...at }] });
        }
        agents = next;
      }
    } else if (e.kind === "status" && e.agentId.startsWith("task:")) {
      // FEATURE-9 (attention inbox): fold QueueStore.emitTask's per-transition status
      // event into a live taskId -> TaskLite map, mirroring the agent-status fold below
      // but for tasks (which have no AgentView — id rule (a) intentionally keeps them
      // out of `agents`).
      const taskId = e.data["taskId"];
      const st = e.data["state"];
      if (typeof taskId === "string" && typeof st === "string") {
        tasks = {
          ...tasks,
          [taskId]: {
            taskId, state: st as TaskState,
            queue: typeof e.data["queue"] === "string" ? e.data["queue"] : "",
            agentId: typeof e.data["agentId"] === "string" ? e.data["agentId"] : null,
            attempts: typeof e.data["attempts"] === "number" ? e.data["attempts"] : 0,
            priority: typeof e.data["priority"] === "number" ? e.data["priority"] : 0,
            error: typeof e.data["error"] === "string" ? e.data["error"] : null,
            subject: typeof e.data["subject"] === "string" ? e.data["subject"] : taskId,
            updatedAt: e.ts,
          },
        };
      }
    } else if (e.kind === "queue_paused" || e.kind === "queue_resumed") {
      // QUEUE-PAUSE: fold QueueStore.pause()/resume()'s dedicated event into the master
      // `queues.items` list (a queue.list snapshot loaded once, otherwise never live) AND the
      // open drill-in's spec (if this is the queue currently open) — mirrors task_state_changed's
      // own "keep the loaded snapshot current without a round-trip" convention above.
      const name = e.data["queue"];
      if (typeof name === "string") {
        const paused = e.kind === "queue_paused";
        queues = { ...queues, items: queues.items.map((q) => (q["name"] === name ? { ...q, paused } : q)) };
        if (queueDetail && queueDetail.spec["name"] === name) {
          queueDetail = { ...queueDetail, spec: { ...queueDetail.spec, paused } };
        }
      }
    }
    return { ...state, lastSeq: e.seq, unseen, hooks, agents, tasks, queues, queueDetail, events: [...state.events, e].slice(-EVENT_BUFFER_MAX) };
  }
  // Id rule (b): every per-agent map/selection is keyed by the qualified id (PP6).
  const key = qualifiedAgentId(e);
  const prev = state.agents[key] ?? emptyAgent(key);
  let agent: AgentView = { ...prev, transcript: [...prev.transcript], tools: [...prev.tools], backgroundTasks: prev.backgroundTasks.map(task => ({ ...task })), lastEventTs: e.ts };
  // WD Stage 1 (coverage B4): spread `...at` where a transcript item is born — {} when
  // the dispatcher didn't opt in, so the un-flagged projection stays byte-identical.
  const at = { seq: e.seq, ...(stampTs ? { ts: e.ts } : {}) };
  // WD Stage 1 (coverage B2): a non-"local" event engineId marks this agent as remote —
  // stamp its origin engine (matches the "<engineId>/<localId>" key qualifiedAgentId
  // builds above). Local events leave the field untouched/absent.
  if (e.engineId && e.engineId !== "local") agent.engine = e.engineId;
  // BUG shadow-live-state: the R2 id-rule exception just above lets a `shadow:<parent>:
  // <taskId>` event materialize an AgentView via emptyAgent (shadow: undefined) BEFORE any
  // agent.list snapshot ever reaches this row — a real risk for a client with no polling
  // refresh (the desktop app; see createStore.ts's connectAndLoad). Without this,
  // displayName (selectors.ts) falls through to the hashed-name branch (shadow must be
  // TRUE, not just label-present) and the row reads as a bare FNV name at state "unknown"
  // forever. The `shadow:` namespace is exclusively used for shadow rows (see the id rule
  // exception's own comment), so this is unconditionally correct for every event kind, not
  // just agent_task below.
  if (e.agentId.startsWith("shadow:")) agent.shadow = true;
  // F47: the per-agent mirror of bumpUnseen's global counters — the SAME closed kind set the
  // daemon stamps AgentRecord.attentionAt from (protocol's ATTENTION_EVENT_KINDS, imported
  // rather than restated so the two can never drift). One stamp before the switch covers every
  // attention kind on every projection path; e.ts is the daemon's own event timestamp, so the
  // client's clock never enters the comparison. Shadow rows are excluded to match supervisor's
  // noteAttention (a sub-agent is not a fleet row an operator triages) — and because
  // agent.markSeen cannot clear a shadow, stamping one here would strand it as unseen forever.
  if (agent.shadow !== true && ATTENTION_EVENT_KINDS.has(e.kind)) agent.attentionAt = e.ts;
  let pending = state.pendingPermissions;
  let accounts = state.accounts;

  switch (e.kind) {
    case "agent_started": {
      agent.state = "running";
      // TERMINAL-RUNTIME: this agent runs as a real CLI in a tmux session. Folded from the event
      // rather than from an agent.list snapshot, so the desktop app (which does not poll) knows
      // to render a terminal instead of an empty transcript the moment the agent starts.
      if (e.data["runtime"] === "terminal" && typeof e.data["session"] === "string") {
        agent.terminal = {
          session: e.data["session"] as string,
          attach: typeof e.data["attach"] === "string" ? (e.data["attach"] as string) : `tmux attach -t ${e.data["session"] as string}`,
        };
      }
      // SOFT-TURN-LIMIT: a fresh run starts clean — clears any badge left over
      // from a prior life of this same agentId (e.g. a resumed/respawned agent).
      agent.turnBudgetExceeded = false;
      // F08.QA: same reset-on-recovery contract the daemon already applies to its own record
      // (supervisor.ts's agent_started handler does `delete record.failure` next to
      // `crashCount = 0`) — a crash-restarted or resumed agent that is RUNNING again must not
      // keep the ⚠ badge of the death it recovered from. Without this the desktop app, which
      // takes no snapshot after connect, shows that badge for the rest of the session.
      // F08.UI (QA history gap): the badge is transient by contract, so without this line a
      // flapping agent's recovery erased every trace of what it recovered from — crashCount
      // survived, the cause did not. Gated on a failure actually being present, exactly like
      // promptStallClearLine's `if (cleared)`, so a normal spawn stays silent.
      const priorFailure = agent.failure;
      agent.failure = undefined;
      if (priorFailure) agent.transcript.push({ role: "system", text: failureRecoveredLine(priorFailure), ...at });
      // TOOL-SURFACE-MEASURE: a fresh run's tool surface hasn't been measured yet — clear
      // whatever a prior life of this agentId left behind (mirrors turnBudgetExceeded above).
      agent.toolSurfaceEstimate = undefined;
      agent.toolSurfaceCacheWriteTokens = undefined;
      agent.toolSurfaceServers = undefined;
      const forkLineage = ForkLineageSchema.safeParse(e.data["forkLineage"]);
      if (forkLineage.success) agent.forkLineage = forkLineage.data;
      if (typeof e.data["model"] === "string" && !e.data["model"].startsWith("<")) agent.model = e.data["model"] as string;
      // CTX-METER-LIVE-FORWARD: core stamps the record's current effectiveContextLimit onto
      // every agent_started (see supervisor.ts's onEvent data-enrichment) -- fold it the same
      // authoritative-when-present way as gitBranch/parentId in the agentRecords snapshot fold
      // above, so a freshly spawned agent's ctx meter is correct from its very first event
      // instead of only after the next agent.list refetch (which the desktop app never does).
      if (e.data["codexTransport"] === "exec" || e.data["codexTransport"] === "app-server") {
        agent.codexTransport = e.data["codexTransport"];
        if (agent.codexTransport === "exec") agent.ctxUsage = null;
      }
      if (typeof e.data["effectiveContextLimit"] === "number") agent.effectiveContextLimit = e.data["effectiveContextLimit"];
      if (e.data["contextLimits"] && typeof e.data["contextLimits"] === "object") agent.contextLimits = e.data["contextLimits"] as NonNullable<typeof agent.contextLimits>;
      // EFFORT: spec-sourced (see backends/claude.ts, codex.ts) — present whenever the spawn
      // set spec.effort, absent otherwise. No sentinel-placeholder guard needed (unlike model,
      // which the SDK can echo a "<synthetic>" value for) since this is never SDK-echoed.
      if (typeof e.data["effort"] === "string") agent.effort = e.data["effort"] as AgentView["effort"];
      // Task RS2: the backend emits sessionId on agent_started; on TUI startup the
      // history tail replays it, so a restored historical conductor carries its
      // sessionId too. See AgentView.sessionId's doc comment for the full rationale.
      if (typeof e.data["sessionId"] === "string") agent.sessionId = e.data["sessionId"];
      // RESUMED-AGENT-TRANSCRIPT-CONTINUITY: a respawn-with-resume (self-heal or an operator-
      // driven `resume:<sessionId>` redelivery -- see supervisor.ts) mints a BRAND-NEW agentId
      // whose chimera event log starts empty, even though this sessionId's provider SDK session
      // (the model's real memory) carries over whole -- the app/tui transcript pane otherwise
      // reads "no messages yet" and the ctx meter reads 0% for an agent that is in fact nearly
      // full. Guarded to fire EXACTLY ONCE per agentId: only the very first time this key
      // learns a sessionId (prev.sessionId undefined) with nothing yet accumulated on it
      // (prev.transcript empty) -- so neither a duplicate/replayed agent_started nor a later
      // sessionId change (the "latest-wins" case just above) re-triggers it. The predecessor is
      // resolved by sessionId EQUALITY alone, never a pointer/parent-id chain, so there is
      // nothing to cycle-walk: it's the other agents-map entry sharing this sessionId with the
      // LONGEST transcript, since every earlier generation's own merge already folded its own
      // predecessor in -- a 3+-generation failover chain resolves in one O(1) lookup, not a
      // walk. Seeding transcript/tools/usage/costUsd from it, plus one `role: "system"` boundary
      // banner (a role TranscriptSegment.tsx and tui's AgentDetail.tsx already render distinctly
      // -- see their own "system" banners for compaction/checkpoints/workflow steps), fixes the
      // empty pane AND the misleading ctx% in one projection step with NO packages/app
      // rendering change required. Absent predecessor (the overwhelmingly common
      // non-resume case, or an older daemon that predates sessionId) leaves everything below
      // untouched -- today's behavior exactly.
      if (typeof e.data["sessionId"] === "string" && prev.sessionId === undefined && prev.transcript.length === 0) {
        const resumedSessionId = e.data["sessionId"];
        const predecessor = Object.values(state.agents)
          .filter((a) => a.agentId !== key && a.sessionId === resumedSessionId)
          .sort((a, b) => b.transcript.length - a.transcript.length || (a.agentId < b.agentId ? -1 : 1))[0];
        if (predecessor) {
          const boundary: TranscriptItem = {
            role: "system",
            text: `⤷ resumed session from ${predecessor.displayLabel ?? predecessor.agentId} — carrying ${predecessor.transcript.length} prior message${predecessor.transcript.length === 1 ? "" : "s"} forward`,
            ...at,
          };
          agent.transcript = [...predecessor.transcript, boundary];
          agent.tools = [...predecessor.tools];
          agent.usage = predecessor.usage;
          agent.costUsd = predecessor.costUsd;
          agent.resumedFrom = [...(predecessor.resumedFrom ?? []), predecessor.agentId];
        }
      }
      // TEAMGROUP-LIVE: the supervisor now folds the scheduler-stamped team/role
      // membership onto agent_started (mirroring conductor below), so a team
      // worker spawned AFTER the initial agent.list snapshot groups under its
      // team immediately from the live stream — previously membership arrived
      // ONLY via a snapshot (fetched on connect/reconnect), so a freshly
      // assigned/queued worker rendered teamless & detached at the bottom of
      // AgentList until the next refetch. Defensive projection identical to the
      // agentRecords snapshot merge: an absent/malformed field never clobbers a
      // prior valid membership. Read BEFORE conductor below — WORKFLOW-TASK-
      // VIEW-2 (bug B) gates the conductor flag on it.
      {
        const m = e.data["membership"];
        if (m && typeof m === "object" && typeof (m as Record<string, unknown>)["team"] === "string") {
          agent.membership = m as { team: string; role: string };
        }
      }
      // ROLES-TAB S1/S4 (G1): mirrors membership just above -- the supervisor stamps
      // sessionRole onto agent_started too, so a session-role spawn's usage shows up
      // in the join immediately from the live stream, not just the next agent.list
      // snapshot. Defensive: an absent field (older daemon, non-session-role spawn)
      // never clobbers a prior valid projection.
      if (typeof e.data["sessionRole"] === "string" || e.data["sessionRole"] === null) {
        agent.sessionRole = e.data["sessionRole"] as string | null;
      }
      // ROLES-UNIFY §3.3: mirrors sessionRole just above — supervisor.ts folds
      // sessionRoleOverrides onto agent_started too (only when actually set, per
      // its own spread-if-truthy stamp), so the audit line shows up from the
      // live stream immediately, not just the next agent.list snapshot.
      if (e.data["sessionRoleOverrides"] && typeof e.data["sessionRoleOverrides"] === "object") {
        agent.sessionRoleOverrides = e.data["sessionRoleOverrides"] as Record<string, unknown>;
      }
      // Final-acceptance MAJOR 3 (in-session ◆ marker): the supervisor folds
      // spec.conductor onto agent_started, so a lazy-spawned conductor wears
      // its row marker/tag from the live stream — previously the flag only
      // ever arrived via the agent.list snapshot. Defensive + additive: only
      // an explicit true sets it; an absent field (older daemon, non-conductor
      // spawn) leaves the prior projection untouched.
      // WORKFLOW-TASK-VIEW-2 (bug B): core also forces conductor:true on every
      // WORKFLOW-BOUND task spawn (scheduler.ts D12) purely to keep that
      // session's input stream open across steps — a session-liveness signal
      // with no relation to conductor DISPLAY identity. A real conductor (main
      // / project auto-conductor) never carries team membership; a workflow
      // step (or any other team-queue) agent always does (scheduler stamps
      // membership alongside the forced flag) — so `agent.membership` is the
      // reliable, client-side signal that distinguishes the two conductor:true
      // populations. Gating here means every downstream reader of
      // AgentView.conductor (AgentList's ◆ glyph + conductorLabel/
      // secondaryLabel, TranscriptPanel's header, main-conductor adoption
      // routing in commands.agents.ts) sees the right thing without its own
      // predicate.
      if (e.data["conductor"] === true && !agent.membership) agent.conductor = true;
      foldAgentIdentity(agent, e.data);
      if (typeof e.data["displayLabel"] === "string" && e.data["displayLabel"].trim()) {
        agent.displayLabel = e.data["displayLabel"].trim();
      }
      // MULTI-LEVEL-NESTING: fold the supervisor-stamped lineage (treeId/depth/parentId/
      // projectId) with the agentRecords merge's defensive guards, so a post-connect spawn
      // nests under its real parent from the live stream alone — the desktop app fetches
      // agent.list exactly once at bootstrap, so before this a depth-1 direct spawn
      // (parentId set, originConductorId null — none of the folds around this fire)
      // projected lineage-free forever: reconcileAgentOrder saw a treeId-less singleton
      // and rendered it as a detached TOP-LEVEL row, while its own shadows (whose
      // agent_task events DO carry the real treeId) landed in the conductor's tree where
      // their parentId couldn't resolve. Folded BEFORE the originConductorId block below
      // so its displayDepth recompute uses the folded depth.
      if (typeof e.data["treeId"] === "string") agent.treeId = e.data["treeId"];
      if (typeof e.data["parentId"] === "string") agent.parentId = e.data["parentId"];
      if (typeof e.data["projectId"] === "string") agent.projectId = e.data["projectId"];
      if (typeof e.data["depth"] === "number") {
        const depth = e.data["depth"];
        agent.depth = depth;
        // Same formula as the agentRecords merge — keeps the indent correct even when the
        // event carries no originConductorId (a direct spawn's owner is null and omitted).
        agent.displayDepth = depth + (agent.originConductorId ? 1 : 0);
      }
      if (typeof e.data["originConductorId"] === "string" || e.data["originConductorId"] === null) {
        agent.originConductorId = e.data["originConductorId"] as string | null;
        agent.displayDepth = (agent.depth ?? 0) + (agent.originConductorId ? 1 : 0);
      }
      // Native-CLI-parity Phase 3 (Task SC2): SC1's agent_started carries the
      // slash-command list as bare NAME strings (no descriptions yet -- those
      // arrive later via a commands_changed event, see that case below, which
      // REPLACES this array wholesale). Read defensively: a missing/non-array
      // field leaves the prior value (emptyAgent's `[]`) untouched, and any
      // non-string entry is dropped rather than crashing the projection.
      if (Array.isArray(e.data["slashCommands"])) {
        agent.slashCommands = (e.data["slashCommands"] as unknown[])
          .filter((x): x is string => typeof x === "string")
          .map((name) => ({ name }));
      }
      // WS-D (parity: surface plugins/skills/mcp read-only): fold the SAME
      // agent_started init's plugins/skills/mcpServers alongside slashCommands
      // above, mirroring its defensive contract exactly -- a missing/non-array
      // field leaves the prior value (emptyAgent's `[]`) untouched, and any
      // malformed entry is dropped rather than crashing the projection. These
      // are read-only surfacing fields (no lifecycle here).
      //
      // plugins/skills project to bare NAME strings: the SDK emits skills as
      // plain strings but plugins as `{ name, path, ... }` objects, so `pluginName`
      // accepts either (a string verbatim, or an object's string `name`) and
      // drops anything else -- so a name is always a string in the view.
      if (Array.isArray(e.data["plugins"])) {
        agent.plugins = (e.data["plugins"] as unknown[])
          .map(pluginName)
          .filter((x): x is string => x.length > 0);
      }
      if (Array.isArray(e.data["skills"])) {
        agent.skills = (e.data["skills"] as unknown[])
          .map(pluginName)
          .filter((x): x is string => x.length > 0);
      }
      // mcpServers carries per-server connection health -- keep only entries with
      // a usable string name; a missing/non-string status defaults to "unknown"
      // (AgentDetail maps an unrecognized status onto the neutral/disconnected glyph).
      if (Array.isArray(e.data["mcpServers"])) {
        agent.mcpServers = (e.data["mcpServers"] as unknown[])
          .map((m): McpServerView => {
            const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
            return {
              name: typeof o["name"] === "string" ? o["name"] : "",
              status: typeof o["status"] === "string" ? o["status"] : "unknown",
            };
          })
          .filter((m) => m.name.length > 0);
      }
      break;
    }
    case "message_delta": {
      const text = String(e.data["text"] ?? "");
      const last = agent.transcript[agent.transcript.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        agent.transcript[agent.transcript.length - 1] = { ...last, text: last.text + text };   // spread carries a stamped ts forward
      } else {
        agent.transcript.push({ role: "assistant", text, streaming: true, ...at });
      }
      goBusy(agent, e.ts);
      break;
    }
    case "message_complete": {
      // MODEL-LIVE: an assistant API message carries the model that actually
      // produced it, and the backend forwards it — fold it authoritative-when-
      // present so an IN-SESSION model change (the SDK's own /model command,
      // which never passes through agent.setModel) updates the header chip
      // instead of showing the agent_started-time model forever. Guard against
      // SDK sentinel placeholders (e.g. "<synthetic>" on system-injected
      // notices like the /model confirmation) — a leading "<" never a real id.
      if (typeof e.data["model"] === "string" && e.data["model"] && !e.data["model"].startsWith("<")) agent.model = e.data["model"] as string;
      // CTX-METER-LIVE-FORWARD: mirrors the model fold just above -- core recomputes and stamps
      // effectiveContextLimit onto this SAME event whenever the live model just changed (see
      // supervisor.ts's onEvent), so the ctx meter's denominator tracks an in-session /model
      // change instead of staying pinned to the model that was active at the last agent.list
      // snapshot (the desktop app's one-shot bootstrap fetch -- see createStore.ts).
      if (typeof e.data["effectiveContextLimit"] === "number") agent.effectiveContextLimit = e.data["effectiveContextLimit"];
      if (e.data["contextLimits"] && typeof e.data["contextLimits"] === "object") agent.contextLimits = e.data["contextLimits"] as NonNullable<typeof agent.contextLimits>;
      const text = String(e.data["text"] ?? "");
      // LOCAL-COMMAND-OUTPUT: a provider slash command's own output ("/mcp" listing servers,
      // "/plugins isn't available in this environment") is NOT something the model said — the CLI
      // printed it. claude.ts has marked it role:"system" since it was wired and nothing read the
      // flag, so it rendered as an ordinary assistant turn: the operator saw the agent apparently
      // announcing "25 MCP server(s): 14 connected" in its own voice.
      //
      // Handled BEFORE the finalize branch below: command output is its own message, not the
      // completion of whatever the assistant was mid-stream on.
      if (e.data["role"] === "system") {
        agent.transcript.push({ role: "system", text, ...at });
        break;
      }
      // Search back for the STREAMING assistant item rather than assuming it is the last row. A
      // system line can land between a stream opening and its completion — a local command's
      // output, or a compaction banner — and keying on `last` alone then finalized nothing: the
      // streaming row stayed streaming forever and the finished text was appended as a SECOND
      // assistant row, showing the reply twice. Bounded: a streaming item further back than this
      // is not the one this event completes.
      const FINALIZE_LOOKBACK = 4;
      let lastIdx = -1;
      for (let i = agent.transcript.length - 1; i >= 0 && i > agent.transcript.length - 1 - FINALIZE_LOOKBACK; i--) {
        const row = agent.transcript[i];
        if (row && row.role === "assistant" && row.streaming) { lastIdx = i; break; }
      }
      const last = lastIdx >= 0 ? agent.transcript[lastIdx] : undefined;
      if (last && last.role === "assistant" && last.streaming) {
        // WD Stage 1 (coverage B4): finalizing keeps the STREAMING item's ts (the turn's
        // start) when one was stamped; a streaming item born before the opt-in falls back
        // to this event's ts (or none at all when stamping is off — `at` is {ts?}).
        // TRANSCRIPT-EVICT-OLD: `seq` always comes from the streaming item's own BIRTH
        // seq (last.seq), never this finalizing event's — same "never advance a row's
        // stamped seq" rule evictTranscriptFront() relies on.
        agent.transcript[lastIdx] = { role: "assistant", text, streaming: false, seq: last.seq, completedSeq: e.seq, ...(last.ts !== undefined ? { ts: last.ts } : (at.ts !== undefined ? { ts: at.ts } : {})) };
      } else {
        agent.transcript.push({ role: "assistant", text, streaming: false, completedSeq: e.seq, ...at });
      }
      break;
    }
    // Native-CLI-parity Phase 1 (Task N2): fold a subagent/workflow task
    // lifecycle event into the agent's flowTree only -- NO busy/transcript
    // side effects here (those stay owned by the existing message/tool/turn
    // cases above/below).
    case "background_tasks": {
      // The level signal can precede its terminal notification. Absence means
      // no longer running, not success; a later task event supplies the outcome.
      if (!Array.isArray(e.data["tasks"])) break;
      const live = new Set(
        (Array.isArray(e.data["tasks"]) ? e.data["tasks"] : [])
          .map((t) => String((t as Record<string, unknown>)?.["taskId"] ?? ""))
          .filter(Boolean),
      );
      for (const t of agent.backgroundTasks) {
        if (t.status === "running" && !live.has(t.taskId)) {
          t.status = "ended"; t.endedAt = e.ts;
          syncTaskTranscriptRow(agent, t);
        }
      }
      // A task we have never seen START (the daemon attached mid-run, or the start event was
      // missed) still gets a row — an invisible running script is the bug this whole feature is.
      for (const raw of (Array.isArray(e.data["tasks"]) ? e.data["tasks"] : [])) {
        if (!raw || typeof raw !== "object") continue;
        const t = raw as Record<string, unknown>;
        const taskId = String(t["taskId"] ?? "");
        if (!taskId || agent.backgroundTasks.some((b) => b.taskId === taskId)) continue;
        const adopted: BackgroundTaskItem = {
          taskId, ts: e.ts, description: String(t["description"] ?? taskId),
          ...(typeof t["taskType"] === "string" ? { taskType: t["taskType"] as string } : {}),
          status: "running",
        };
        agent.backgroundTasks.push(adopted);
        syncTaskTranscriptRow(agent, adopted);
      }
      break;
    }
    case "agent_task": {
      agent.flowTree = applyFlowEvent(agent.flowTree, e);
      // BACKGROUND-TASK-VISIBILITY: a backgrounded local script gets a live row here instead of
      // the shadow-agent row core deliberately refuses it. Gated on isBackgrounded: a FOREGROUND
      // local_bash is already visible as the tool call that is blocking on it, and showing it
      // twice would read as two pieces of work.
      foldBackgroundTask(agent, e);
      // BUG shadow-live-state: this event's agentId is the SHADOW's own id only when
      // supervisor.ts's upsertShadow/terminateShadows re-emitted it that way (see their
      // comments) -- the pre-existing parent-directed copy above still only touches
      // flowTree, unchanged. Never downgrade an established strong label (subagentType/
      // workflowName) with a later description-only or bare update, mirroring upsertShadow's
      // own "upgrade only on a strong name" rule.
      if (e.agentId.startsWith("shadow:")) {
        agent.state = shadowTaskState(e.data);
        const strong = shadowTaskLabel(e.data);
        if (strong) agent.label = strong;
        else if (!agent.label && typeof e.data["description"] === "string" && e.data["description"]) {
          agent.label = e.data["description"] as string;
        }
        // LINEAGE: fold parentId/treeId/depth/projectId/membership when supervisor.ts's
        // upsertShadow/terminateShadows supplied them (see their own comments) -- same
        // defensive typeof-guard, absent-never-clobbers rule as the agentRecords snapshot
        // merge below. Without this an event-only shadow (no agent.list snapshot ever
        // dispatched, e.g. the desktop app's no-polling design) had no lineage at all, so
        // selectors.ts's groupKey fell back to a singleton `tree:<ownId>` cluster -- a
        // detached top-level row instead of nested under its parent.
        applyShadowLineage(agent, e.data, e.agentId, state.agents);
      }
      break;
    }
    case "tool_call": {
      const toolName = String(e.data["toolName"] ?? "?");
      const input = e.data["input"];
      // toolId is additive/forward-looking (no current backend emits it yet) —
      // carried onto the transcript item ONLY when the event actually provides
      // one, so it can later disambiguate concurrent in-flight tool calls.
      const nativeToolId = e.data["toolId"] ?? e.data["toolUseId"];
      const toolId = typeof nativeToolId === "string" ? nativeToolId : undefined;
      agent.tools.push({ ts: e.ts, toolName, input, status: "called", ...(toolId !== undefined ? { toolId } : {}) });
      // TURN-COST-VISIBLE: same conditional-spread rule as toolId — a backend that does not report
      // a turn leaves the key off entirely rather than carrying an empty one.
      const turnId = typeof e.data["turnId"] === "string" ? (e.data["turnId"] as string) : undefined;
      agent.transcript.push({
        role: "tool",
        toolName,
        input,
        status: "called",
        ...(toolId !== undefined ? { toolId } : {}),
        ...(turnId !== undefined ? { turnId } : {}),
        ...at,
      });
      goBusy(agent, e.ts);
      // Native-CLI-parity Phase 1 (Task N2): ADDITIVE -- fold the same event into
      // the flowTree AFTER the existing tools/transcript updates above, which
      // must stay byte-identical.
      agent.flowTree = applyFlowEvent(agent.flowTree, e);
      break;
    }
    case "tool_result": {
      const nativeToolId = e.data["toolId"] ?? e.data["toolUseId"];
      const toolId = typeof nativeToolId === "string" ? nativeToolId : undefined;
      const parsedImages = ToolOutputImagesSchema.safeParse(e.data["images"]);
      const parsedWarnings = ToolOutputImageWarningsSchema.safeParse(e.data["imageOutputWarnings"]);
      const imageFields = {
        ...(parsedImages.success && parsedImages.data.length ? { images: parsedImages.data } : {}),
        ...(!parsedImages.success && e.data["images"] !== undefined
          ? { imageOutputWarnings: ["invalid-or-unsupported" as ToolOutputImageWarning] }
          : parsedWarnings.success && parsedWarnings.data.length ? { imageOutputWarnings: parsedWarnings.data } : {}),
      };
      const anonymousImageOutput = toolId === undefined && !!(imageFields.images || imageFields.imageOutputWarnings);
      for (let i = agent.tools.length - 1; i >= 0; i--) {
        if (!anonymousImageOutput && agent.tools[i]!.status === "called" && (toolId === undefined || agent.tools[i]!.toolId === toolId)) {
          agent.tools[i] = { ...agent.tools[i]!, status: "done" };
          break;
        }
      }
      // Find the matching in-flight tool TRANSCRIPT item: by toolId when the
      // result event provides one (a STRICT match — no fallback to "most
      // recent" if the id doesn't correspond to any in-flight item, since that
      // would silently resolve the wrong tool), else the most recent
      // status==="called" item (mirrors the agent.tools search above).
      // WD Stage 1 (coverage B4): `result` is the normalized channel (both backends now
      // emit it, pre-bounded); `output` is the codex command_execution field that carried
      // real output before this task — read it as the fallback (bounded here, since that
      // event's locked wire shape predates the backend-side bound). `result` wins when
      // both exist.
      const rawResult = e.data["result"] !== undefined ? e.data["result"] : e.data["output"];
      const result = rawResult !== undefined ? boundToolResult(String(rawResult)) : undefined;
      let matched = false;
      for (let i = agent.transcript.length - 1; i >= 0; i--) {
        const item = agent.transcript[i]!;
        if (anonymousImageOutput || item.role !== "tool" || item.status !== "called") continue;
        if (toolId !== undefined && item.toolId !== toolId) continue;
        agent.transcript[i] = { ...item, status: "done", ...(result !== undefined ? { result } : {}), ...imageFields };
        matched = true;
        break;
      }
      // A reconnect may load the result without its start (or evict an old start).
      // Only image-bearing results need an orphan row; never attach to another tool.
      if (!matched && (imageFields.images || imageFields.imageOutputWarnings)
        && !agent.transcript.some(item => item.role === "tool" && toolId !== undefined && item.toolId === toolId)) {
        agent.transcript.push({ role: "tool", toolName: String(e.data["toolName"] ?? "image_output"), status: "done", ...(toolId !== undefined ? { toolId } : {}), ...(result !== undefined ? { result } : {}), ...imageFields, ...at });
      }
      // Native-CLI-parity Phase 1 (Task N2): ADDITIVE, after the existing
      // tools/transcript patches above (which must stay byte-identical).
      agent.flowTree = applyFlowEvent(agent.flowTree, e);
      break;
    }
    case "permission_request": {
      const requestId = String(e.data["requestId"]);
      if (!pending.some((p) => p.requestId === requestId)) {
        pending = [...pending, { requestId, agentId: key, toolName: String(e.data["toolName"] ?? "?"), input: e.data["input"], ts: e.ts }];
        // W7 (B1 badge): bump ONLY for a genuinely new request — a replayed/
        // duplicate requestId adds no pending card so it must add no badge.
        if (state.activeTab !== "events") unseen = bumpUnseen(unseen, e.kind);
      }
      break;
    }
    // spec §17 (T5 fold-in): project agent_question into per-agent question
    // state so a later task can render a prompt banner. `default`/`timeoutMs`
    // are projected verbatim (T6) so the TUI can pre-select an option and show
    // a countdown. pendingQuestion is cleared explicitly — via the
    // "questionAnswered" action, a status{questionResolved} event (FEATURE-9:
    // the daemon's own timeout fallback resolving elsewhere — see the "status"
    // case below), or when the agent hits ANY terminal state: done ("result"),
    // error ("error"), or killed/failed/interrupted ("status") — and until then a
    // second agent_question for the same agent simply replaces the first.
    case "agent_question": {
      const questionId = String(e.data["questionId"] ?? "");
      const prompt = String(e.data["prompt"] ?? "");
      const header = typeof e.data["header"] === "string" ? (e.data["header"] as string) : undefined;
      const options = Array.isArray(e.data["options"]) ? (e.data["options"] as AgentQuestion["options"]) : undefined;
      const hasDefault = e.data["default"] !== undefined;
      const hasTimeoutMs = e.data["timeoutMs"] !== undefined;
      const to = typeof e.data["to"] === "string" ? (e.data["to"] as string) : undefined;
      // FEATURE-9 (attention inbox): `gate` is set iff this rode a workflow
      // approval-gate ask() (scheduler.ts's evaluateGate) — see AgentQuestion's doc
      // comment. `ts` is stamped from the event itself, mirroring PendingPermission.ts.
      const gate = e.data["gate"] === "approval" ? "approval" as const : undefined;
      agent.pendingQuestion = {
        questionId,
        prompt,
        ...(header !== undefined ? { header } : {}),
        ...(options !== undefined ? { options } : {}),
        multiSelect: e.data["multiSelect"] === true,
        freeform: e.data["freeform"] === true,
        ...(hasDefault ? { default: e.data["default"] as AgentQuestion["default"] } : {}),
        ...(hasTimeoutMs ? { timeoutMs: e.data["timeoutMs"] as number | null } : {}),
        ...(to !== undefined ? { to } : {}),
        ts: e.ts,
        ...(gate ? { gate } : {}),
      };
      break;
    }
    // Native-CLI-parity Phase 2 (Task DLG3): mirrors the agent_question case just
    // above, but projects DLG1's agent_dialog into pendingDialog instead. `payload`
    // is carried verbatim (loosely typed) -- DialogPanel.tsx does the dialogKind-
    // specific interpretation. A second agent_dialog for the same agent simply
    // replaces the first, same as agent_question.
    case "agent_dialog": {
      agent.pendingDialog = {
        dialogId: String(e.data["dialogId"] ?? ""),
        dialogKind: String(e.data["dialogKind"] ?? ""),
        payload: (e.data["payload"] ?? {}) as Record<string, unknown>,
      };
      break;
    }
    // Native-CLI-parity Phase 3 (Task SC2): the SDK's live slash-command push
    // (SC1's commands_changed event) -- REPLACE semantics, the full current
    // list with descriptions/argumentHints this time, wholesale overwriting
    // whatever agent_started's name-only projection above left in place (a
    // stale name-only entry must not survive alongside a richer one for the
    // same command). Read defensively -- a missing/non-array `commands`, a
    // missing `name`, or a non-string description/argumentHint never throws;
    // an entry with no usable name is simply dropped.
    case "commands_changed": {
      const raw = Array.isArray(e.data["commands"]) ? (e.data["commands"] as unknown[]) : [];
      agent.slashCommands = raw
        .map((c): SlashCommandView => {
          const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
          return {
            name: typeof o["name"] === "string" ? o["name"] : "",
            ...(typeof o["description"] === "string" ? { description: o["description"] } : {}),
            ...(typeof o["argumentHint"] === "string" ? { argumentHint: o["argumentHint"] } : {}),
          };
        })
        .filter((c) => c.name.length > 0);
      break;
    }
    case "usage": {
      // LIVE-CTX-USAGE: a non-terminal in-flight snapshot (Claude SDK's message_start/
      // message_delta) — same latest-wins fold as turn_complete/result below, just without
      // touching busy/state/costUsd (this event carries no turn-boundary signal). A
      // usage-less event (shouldn't happen — the backend only emits this kind WITH a usage
      // payload) leaves the prior tally intact, same discipline as extractUsage's null case.
      const usage = extractUsage(e);
      // CTX-VS-BILLABLE: this kind IS the context baseline channel (LIVE-CTX-USAGE, and the
      // post-compaction reset that rides it), so it writes both — the billable tally and the
      // ctx basis. `result` below deliberately writes only the former.
      if (e.data["contextOnly"] === true) {
        if ("contextUsage" in e.data) agent.ctxUsage = extractUsageField(e, "contextUsage");
        const sessionUsage = extractUsageField(e, "sessionUsage");
        if (sessionUsage) agent.sessionUsage = sessionUsage;
        if (typeof e.data["effectiveContextLimit"] === "number") agent.effectiveContextLimit = e.data["effectiveContextLimit"];
        if (e.data["contextLimits"] && typeof e.data["contextLimits"] === "object") agent.contextLimits = e.data["contextLimits"] as NonNullable<typeof agent.contextLimits>;
      } else if (usage) { agent.usage = usage; agent.usageMeasuredAt = e.ts; agent.ctxUsage = usage; }
      // TOOL-SURFACE-MEASURE: first-only capture, mirroring core/supervisor.ts's own
      // onEvent branch exactly — see AgentView.toolSurfaceCacheWriteTokens's doc comment.
      if (usage && usage.cacheCreation > 0 && agent.toolSurfaceCacheWriteTokens === undefined) {
        agent.toolSurfaceCacheWriteTokens = usage.cacheCreation;
      }
      break;
    }
    case "quota": {
      // ACCOUNT-QUOTA-METERS: mirror core's QuotaTracker.record (failover.ts) client-side —
      // upsert this window by `kind` into the owning account's quota, replacing any prior
      // window of the same kind. Was previously unhandled entirely (dead path: the backend
      // emits this on every SDK rate_limit_event, but the reducer dropped it silently) — today
      // that's masked by daemonStatus's periodic full-accounts refresh, but this event kind is
      // the ONLY live signal for a quota update within a poll interval. `agent.account` (stamped
      // by the agentRecords snapshot) attributes it; no-op if that hasn't landed yet.
      const window = e.data["window"] as AccountQuotaWindow | undefined;
      if (window && agent.account) {
        const idx = accounts.findIndex((a) => a.name === agent.account);
        if (idx >= 0) {
          const prevAcc = accounts[idx]!;
          const windows = [...(prevAcc.quota?.windows ?? []).filter((w) => w.kind !== window.kind), window];
          accounts = accounts.map((a, i) => (i === idx ? { ...a, quota: { account: agent.account!, windows, fetchedAt: e.ts } } : a));
        }
      }
      break;
    }
    case "turn_complete": {
      if (typeof e.data["totalCostUsd"] === "number") agent.costUsd = e.data["totalCostUsd"];
      else if (typeof e.data["turnCostUsd"] === "number") agent.costUsd = e.data["turnCostUsd"] as number;
      // FEATURE 2 (token usage): latest-wins, mirroring costUsd above — a
      // usage-less turn (extractUsage → null) leaves the prior tally intact.
      const usage = extractUsageField(e, "billableUsage") ?? extractUsage(e);
      // Old exec events incorrectly tagged the cumulative session total as context.
      // Replay must not resurrect that meter even before a fresh measurement arrives.
      const legacyExec = (agent.codexTransport === "exec" || (agent.provider === "codex" && !agent.codexTransport))
        && e.data["contextUsageSource"] !== "rollout" && e.data["contextUsageSource"] !== "app-server";
      const contextUsage = legacyExec ? null : extractUsageField(e, "contextUsage");
      if (usage) { agent.usage = usage; agent.usageMeasuredAt = e.ts; }
      if (contextUsage || legacyExec || e.data["contextUsage"] === null) agent.ctxUsage = contextUsage;
      goIdle(agent);
      break;
    }
    case "result": {
      agent.state = "done";
      goIdle(agent, true);   // terminal: no completion event is coming
      if (typeof e.data["totalCostUsd"] === "number") agent.costUsd = e.data["totalCostUsd"];
      else if (typeof e.data["costUsd"] === "number") agent.costUsd = e.data["costUsd"] as number;
      // FEATURE 2: codex's `result` carries the run's cumulative usage (claude's
      // does not) — take it when present so a codex agent's final tally is the
      // authoritative total rather than just its last turn.
      const usage = extractUsageField(e, "billableUsage") ?? extractUsage(e);
      // Old exec events incorrectly tagged the cumulative session total as context.
      // Replay must not resurrect that meter even before a fresh measurement arrives.
      const legacyExec = (agent.codexTransport === "exec" || (agent.provider === "codex" && !agent.codexTransport))
        && e.data["contextUsageSource"] !== "rollout" && e.data["contextUsageSource"] !== "app-server";
      const contextUsage = legacyExec ? null : extractUsageField(e, "contextUsage");
      if (usage) { agent.usage = usage; agent.usageMeasuredAt = e.ts; }
      if (contextUsage || legacyExec || e.data["contextUsage"] === null) agent.ctxUsage = contextUsage;
      // The assistant's final text is already shown via message_complete/streaming.
      // Only surface the result text when NO assistant turn rendered it (e.g. a
      // tool-only turn, or a backend that emits result without message_complete),
      // so a normal chat answer isn't echoed a second time as "result: …".
      const resultText = String(e.data["text"] ?? "");
      const lastAssistant = [...agent.transcript].reverse().find((t) => t.role === "assistant");
      if (resultText && lastAssistant?.text !== resultText) {
        agent.transcript.push({ role: "system", text: `result: ${resultText}`, ...at });
      }
      pending = pending.filter((p) => p.agentId !== key);
      // AGENT-DONE-STATE-STALE-UI: `result` is the ONLY terminal fold that reaches
      // "done" (STATUS_TERMINAL_STATE covers killed/failed via `status`, "error" via
      // its own case), and it was the ONLY terminal path that left the banners set.
      // derivedState (app selectors.ts / TUI AgentList) renders "waiting" whenever
      // pendingQuestion||pendingDialog is set REGARDLESS of state, so a question/dialog
      // still outstanding when the agent completed masked "done" as "waiting" forever
      // (the desktop app never re-polls agent.list). A done agent can't act on an
      // answer, so clear them — mirrors the "error"/status-terminal cases below.
      agent.pendingQuestion = null;
      agent.pendingDialog = null;
      break;
    }
    case "error": {
      agent.state = "failed";
      goIdle(agent, true);   // terminal: no completion event is coming
      agent.transcript.push({ role: "system", text: `error: ${String(e.data["message"] ?? "")}`, ...at });
      pending = pending.filter((p) => p.agentId !== key);
      agent.pendingQuestion = null;   // an errored turn must not leave a stale question banner
      agent.pendingDialog = null;     // Task DLG3: mirrors pendingQuestion above
      break;
    }
    case "failover": {
      agent.transcript.push({ role: "system", text: `failover ${String(e.data["from"])} → ${String(e.data["to"])}`, ...at });
      // FAILOVER-ACCOUNT-LIVE: supervisor updates record.accountName/provider the instant a
      // reroute happens, but AgentView.account/provider were only ever folded once from the
      // one-shot agent.list snapshot (never re-fetched by the desktop app) -- account/model
      // dialogs (AccountCard/ModelCard) kept reading the stale pre-failover provider forever.
      // Auto-failover events (onError) carry `toProvider`; the manual account-switch event
      // (applyAccount) carries `provider` instead -- accept either shape.
      if (typeof e.data["to"] === "string") agent.account = e.data["to"];
      const toProvider = e.data["toProvider"] ?? e.data["provider"];
      if (typeof toProvider === "string") agent.provider = toProvider;
      break;
    }
    case "worktree_setup": {
      // F26: the whole transcript story for the setup hook, shared by tui and app — neither
      // client has its own rendering for this event kind.
      const phase = e.data["phase"];
      if (phase === "start") agent.transcript.push({ role: "system", text: "worktree setup: running project bootstrap hook…", ...at });
      else if (phase === "chunk") {
        const t = String(e.data["text"] ?? "").trimEnd();
        if (t) agent.transcript.push({ role: "system", text: t, ...at });
      } else if (phase === "ok") agent.transcript.push({ role: "system", text: `worktree setup: ok (${e.data["durationMs"]}ms)`, ...at });
      else if (phase === "fail") {
        // F26.UI (QA gap 1): exitCode is null on BOTH the timeout ladder (SIGTERM/SIGKILL end in
        // close(null), indistinguishable from any other signal death) and the spawn-error path
        // (ENOENT never reaches close at all) — the old text printed a literal "exit null" for the
        // two failures an operator is most likely to hit. Branch on the `timedOut` flag the fail
        // event carries and name the command when the child never started, so the transcript alone
        // says why nothing launched.
        const exitCode = e.data["exitCode"];
        const command = typeof e.data["command"] === "string" ? (e.data["command"] as string) : "";
        const reason =
          e.data["timedOut"] === true
            ? `timed out after ${Math.max(1, Math.round(Number(e.data["durationMs"] ?? 0) / 1000))}s`
            : typeof exitCode === "number"
              ? `exit ${exitCode}`
              : command
                ? `could not start ${command}`
                : "could not start";
        // Forward-compatible tail: the hook's own output reaches the transcript as `chunk` events,
        // and the fail event carries no captured output today (FIX-NEEDED — the ENOENT path emits
        // zero chunks, so its reason exists nowhere in the UI). Render a tail the moment the daemon
        // starts sending one rather than inventing one here.
        const tailRaw = e.data["stderrTail"] ?? e.data["message"];
        const tail = typeof tailRaw === "string" ? tailRaw.trim() : "";
        const truncated = e.data["truncated"] === true ? " · earlier output truncated" : "";
        agent.transcript.push({ role: "system", text: `worktree setup FAILED (${reason}) — spawn refused${truncated}${tail ? `\n${tail}` : ""}`, ...at });
        // The supervisor DELETES the agent record when the hook refuses the spawn, so no status
        // event ever arrives for this id — without this the row sits at "unknown" forever next to a
        // FAILED transcript line (QA gap 2: the refusal must read as a failed agent, not a ghost).
        agent.state = "failed";
      }
      break;
    }
    case "circuit_breaker_tripped": {
      // CIRCUIT-BREAKER-VISIBLE: supervisor.scheduleCrashRestart appends this event
      // (immediately followed by a paired status{failed} event, handled below by the
      // generic STATUS_TERMINAL_STATE fold) the moment a crash-looping agent exceeds
      // its restart budget. Previously the reducer had no case for this event kind at
      // all, so a repeatedly-crashing agent rendered identically to one that failed
      // once cleanly — no crash count, no reason, nothing to distinguish "keeps dying"
      // from "failed once". Mirrors the "error" case's system transcript line so the
      // explanation is visible in the same place a user already looks for failures.
      const crashCount = e.data["crashCount"];
      agent.transcript.push({
        role: "system",
        text: `crash-looped after ${String(crashCount ?? "?")} attempts, giving up: ${String(e.data["reason"] ?? "")}`,
        ...at,
      });
      break;
    }
    case "compaction": {
      // COMPACTION-IN-PROGRESS: a phase-tagged event brackets a compaction that is HAPPENING,
      // rather than only reporting one that already finished. Absent phase ⇒ "end", which is
      // every pre-existing emitter (both backends' own boundary events), so this branch changes
      // nothing for them.
      const phase = e.data["phase"];
      if (phase === "start") {
        agent.compacting = true;
        agent.compactingConfirmed = true;   // the provider said it BEGAN — see goIdle
        break;
      }
      agent.compacting = false;
      agent.compactingConfirmed = undefined;
      // A trigger that failed is not a compaction — no banner, no count, just release the
      // in-progress state so nothing stays pinned on it.
      if (phase === "aborted") {
        if (typeof e.data["error"] === "string") agent.transcript.push({ role: "system", text: `Compaction stopped: ${e.data["error"]}`, ...at });
        break;
      }
      agent.transcript.push({ role: "system", text: compactionBannerText(e), ...at });
      // COMPACTION-VISIBLE-STATE: the banner above is a point-in-time transcript LINE — it
      // scrolls away, so it can never answer "has this agent ever compacted?" or "when last?"
      // at a glance, which is exactly what an operator watching a context meter climb wants to
      // know. Keep it as durable per-agent state too, so the ctx meter and the fleet dashboard
      // can show it without anyone scrolling a transcript to find out.
      if (agent.codexTransport === "exec" || agent.codexTransport === "app-server") agent.ctxUsage = null;
      agent.compactions = (agent.compactions ?? 0) + 1;
      agent.lastCompactedAt = e.ts;
      break;
    }
    case "agent_prompt_stalled": {
      // F09: a message was delivered to an idle agent and no turn-opening event followed
      // within core's PROMPT_STALL_MS. Mirrors the undeliveredMessage treatment above — same
      // existing system-transcript surface, no new UI primitive.
      const from = String(e.data["from"] ?? "");
      const sinceMs = Number(e.data["sinceMs"] ?? 0);
      // F09.UI: remember WHAT was delivered, so both cockpits can offer a one-key resend with no
      // daemon change (the plan's OUT list forbids AUTOMATIC re-delivery, not an operator-driven
      // one). The event carries no text, but the delivery itself was already folded as this
      // agent's last user turn a moment ago — read it back from there. Absent (history never
      // loaded / evicted) is expected and handled by the UIs, never faked.
      const lastUser = [...agent.transcript].reverse().find((t): t is Extract<TranscriptItem, { role: "user" }> => t.role === "user" && typeof t.text === "string" && t.text.length > 0);
      agent.promptStall = {
        deliveryId: String(e.data["deliveryId"] ?? ""),
        from,
        sinceTs: Number(e.data["sinceTs"] ?? e.ts),
        sinceMs,
        ...(lastUser?.text ? { text: lastUser.text } : {}),
      };
      agent.transcript.push({
        role: "system",
        text: promptStallOpenLine(from, sinceMs),
        ...at,
      });
      break;
    }
    // F22.UI — a refused worktree write. supervisor.ts's decideWorktreeWrite deny path emits
    // this with reason "worktree_lease_foreign_write"; a DIFFERENT policy_denied
    // ("worktree_main_source_write") rides the same kind, hence the exact-reason gate.
    // Folding it live matters twice over: it is the only place the refusal becomes a
    // transcript line, and worktreeLeaseDenied/lastWorktreeLeaseDenial were until now
    // snapshot-only fields — the desktop app takes exactly one agent.list at bootstrap, so
    // the ⚠ chip could never light there during a session.
    case "policy_denied": {
      if (e.data["reason"] !== "worktree_lease_foreign_write") break;
      const tool = typeof e.data["tool"] === "string" ? e.data["tool"] : "write";
      const target = typeof e.data["target"] === "string" ? e.data["target"] : "";
      const workdirKey = typeof e.data["workdirKey"] === "string" ? e.data["workdirKey"] : "";
      const owner = typeof e.data["owner"] === "string" ? e.data["owner"] : "";
      const ownerState = e.data["ownerState"] === "retained" ? "retained" : "active";
      agent.worktreeLeaseDenied = true;
      // A refusal only happens in enforce mode — the observed-mode signal (see AgentView).
      agent.worktreeLeaseMode = "enforce";
      agent.lastWorktreeLeaseDenial = {
        tool,
        workdirKey,
        owner,
        ownerState,
        target,
        requestId: typeof e.data["requestId"] === "string" ? e.data["requestId"] : "",
        at: e.ts,
      };
      // The exact command is NOT available: core scrubs the argv deliberately (it can echo an
      // injected credential) and forwards only tool + target. Naming both is the most precise
      // line we can honestly write.
      agent.transcript.push({
        role: "system",
        text:
          `⌂ worktree write refused — ${tool}${target ? ` → ${target}` : ""}` +
          `${workdirKey ? ` · key ${workdirKey}` : ""}` +
          ` · lease held by ${owner ? owner.slice(0, 8) : "unknown"}${ownerState === "retained" ? " (retained)" : ""}` +
          ` · hand off with worktree_lease_handoff`,
        ...at,
      });
      break;
    }
    // F22.UI — warn mode. The broker emits capability_decision for BOTH outcomes; on deny the
    // supervisor's policy_denied above already owns the line, so only the allow (= warn) branch
    // prints, and the deny branch just records the observed mode.
    case "capability_decision": {
      if (e.data["action"] !== "worktree_write") break;
      if (e.data["decision"] !== "allow") {
        agent.worktreeLeaseMode = "enforce";
        break;
      }
      agent.worktreeLeaseMode = "warn";
      const owner = typeof e.data["owner"] === "string" ? e.data["owner"] : "";
      const workdirKey = typeof e.data["workdirKey"] === "string" ? e.data["workdirKey"] : "";
      agent.transcript.push({
        role: "system",
        text:
          `⌂ worktree write allowed with a warning (lease mode: warn)` +
          `${workdirKey ? ` · key ${workdirKey}` : ""}` +
          ` · lease held by ${owner ? owner.slice(0, 8) : "unknown"}`,
        ...at,
      });
      break;
    }
    case "status": {
      const forkLineage = ForkLineageSchema.safeParse(e.data["forkLineage"]);
      if (forkLineage.success) agent.forkLineage = forkLineage.data;
      // Older daemons persisted completion only in raw catch-all events. Replaying
      // that evidence repairs existing running rows without rewriting history.
      if (e.data["sdkEvent"] === "task_notification" && e.raw && typeof e.raw === "object") {
        const raw = e.raw as Record<string, unknown>;
        if (raw["subtype"] === "task_notification" && ["completed", "failed", "stopped"].includes(String(raw["status"]))) {
          foldBackgroundTask(agent, { ts: e.ts, data: { taskId: raw["task_id"], status: raw["status"],
            ...(raw["status"] === "failed" ? { error: raw["summary"] } : {}) } });
        }
      }
      if (e.data["commandComplete"] === true && e.data["turnActive"] === false) goIdle(agent);
      if (typeof e.data["nativeGoalSummary"] === "string") agent.transcript.push({ role: "system", text: e.data["nativeGoalSummary"], ...at });
      if (e.data["resumeFallback"] === "stale-session" && e.data["contextLost"] === true) {
        agent.transcript.push({ role: "system", text: "The previous Codex session is unavailable. Continuing in a new session; earlier conversation context could not be restored.", ...at });
      }
      if (e.data["turnStarted"] === true) goBusy(agent, e.ts);
      const progress = e.data["toolProgress"] as { toolId?: unknown; text?: unknown } | undefined;
      if (typeof progress?.toolId === "string" && typeof progress.text === "string") {
        for (let i = agent.transcript.length - 1; i >= 0; i--) {
          const item = agent.transcript[i]!;
          if (item.role === "tool" && item.toolId === progress.toolId && item.status === "called") {
            const text = (item.result ?? "") + progress.text;
            agent.transcript[i] = { ...item, result: text.length > TOOL_RESULT_MAX_CHARS ? `… [earlier live output omitted]\n${text.slice(-TOOL_RESULT_MAX_CHARS)}` : text };
            break;
          }
        }
      }
      if (e.data["providerSwitch"] === "compacting") {
        agent.transcript.push({ role: "system", text: `Provider switch: compacting ${String(e.data["fromProvider"])} context for ${String(e.data["toProvider"])}…`, ...at });
      } else if (e.data["providerSwitch"] === "completed") {
        foldAgentIdentity(agent, e.data);
        if (typeof e.data["model"] === "string") agent.model = e.data["model"];
        if (typeof e.data["displayLabel"] === "string") agent.displayLabel = e.data["displayLabel"];
        if (typeof e.data["costUsd"] === "number") agent.costUsd = e.data["costUsd"];
        const transfer = e.data["contextTransfer"] as { mode?: string; reason?: string; archive?: string } | undefined;
        agent.transcript.push({ role: "system", text: `Provider switch completed: ${String(e.data["provider"])}/${String(e.data["model"])}. ${transfer?.mode === "source-compaction" ? "Source context compacted." : `History fallback (source compaction unavailable): ${transfer?.reason ?? "unknown reason"}`}${transfer?.archive ? ` Context archive: ${transfer.archive}` : ""}`, ...at });
      }
      // PROJECT-CONDUCTOR-VISIBILITY: supervisor.spawn now announces every freshly REGISTERED
      // record via this marker, BEFORE the backend has emitted anything of its own — a resumeOnly
      // project conductor pushes no first turn (see backends/claude.ts), so agent_started may
      // never arrive, and the app (connectAndLoad fetches agent.list exactly once at bootstrap,
      // see createStore.ts) would otherwise never materialize this row until the next reconnect.
      // Mirrors agent_started's own conductor/membership projection (WORKFLOW-TASK-VIEW-2 bug B:
      // membership must win over a forced conductor:true) plus stamps projectId, which
      // agent_started itself never carries (that only ever arrived via the agent.list snapshot).
      if (e.data["registered"] === true) {
        agent.state = "running";
        const m = e.data["membership"];
        if (m && typeof m === "object" && typeof (m as Record<string, unknown>)["team"] === "string") {
          agent.membership = m as { team: string; role: string };
        }
        if (e.data["conductor"] === true && !agent.membership) agent.conductor = true;
        foldAgentIdentity(agent, e.data);
        if (typeof e.data["displayLabel"] === "string" && e.data["displayLabel"].trim()) {
          agent.displayLabel = e.data["displayLabel"].trim();
        }
        if (typeof e.data["projectId"] === "string") agent.projectId = e.data["projectId"];
        // REGISTRATION-EVENT-MISSING-LINEAGE: this marker is the app's FIRST sight of a
        // queue-spawned worker (agent_started arrives 8+ events later) — fold the same
        // treeId/depth/parentId lineage agent_started folds above (MULTI-LEVEL-NESTING),
        // folded BEFORE the originConductorId block below so its displayDepth recompute
        // uses the folded depth.
        if (typeof e.data["treeId"] === "string") agent.treeId = e.data["treeId"];
        if (typeof e.data["parentId"] === "string") agent.parentId = e.data["parentId"];
        if (typeof e.data["depth"] === "number") {
          const depth = e.data["depth"];
          agent.depth = depth;
          agent.displayDepth = depth + (agent.originConductorId ? 1 : 0);
        }
      }
      // REBIND-LINEAGE: AgentSupervisor.setOriginConductor (scheduler.ts idle-reuse binds a
      // long-lived pool worker to a DIFFERENT task's conductor) appends a bare `status` event
      // carrying ONLY { originConductorId } -- no `registered` flag, since the worker already
      // exists client-side. That field went unread here, so a worker reused across projects
      // (e.g. released back to an idle pool by project A's conductor, then reassigned to
      // project B's) kept rendering under project A's conductor forever on the live path —
      // the daemon's own AgentRecord was already correct (rebound to B), but only a fresh
      // agent.list snapshot (which the desktop app never re-polls after connect, see
      // createStore.ts) would have corrected the client. Mirrors agent_started's identical
      // fold (case "agent_started" above) so a rebind is authoritative here too.
      if (typeof e.data["originConductorId"] === "string" || e.data["originConductorId"] === null) {
        agent.originConductorId = e.data["originConductorId"] as string | null;
        agent.displayDepth = (agent.depth ?? 0) + (agent.originConductorId ? 1 : 0);
      }
      // UNDELIVERED-MESSAGE-EVENTS-DROPPED: supervisor.ts emits an explicit
      // undeliveredMessage status event on every path where a queued message can't
      // actually reach its target (auto-resume failure, wake/resume of a killed or
      // sessionless agent, a deliverTo target that already settled) -- its own comment
      // says "never a silent drop". But this reducer never read the field, so the
      // message vanished from the user's view with zero feedback anyway. Mirrors the
      // "error"/circuit_breaker_tripped cases' system transcript line so it renders
      // through the same already-existing surface.
      if (e.data["undeliveredMessage"] === true) {
        agent.transcript.push({
          role: "system",
          text: `message not delivered: ${String(e.data["reason"] ?? "")}`,
          ...at,
        });
      }
      // KIMI-CAPABILITY-NOTICE-INVISIBLE (QA of c7c2bff1): backends/kimi.ts emits
      // status{capabilityNotice:{lines,...}} for every capability it could NOT honor on a spawn,
      // and its own comment justifies the event as the half that is "operator-visible ... in a UI
      // transcript/tail" and "the ONLY signal at all on a resumeOnly reattach" — but no reducer,
      // selector or view ever read the field, so the event reached nothing a human looks at. That
      // became load-bearing when the stdio-MCP fix started withholding the chimera grant from
      // EVERY kimi spawn: an agent silently missing memory/ask_agent/queue with no operator-side
      // trace at all. The prompt-side copy is not a substitute — kimi's first turn goes straight
      // to session.prompt() and is never sunk as a user event, so it renders nowhere. Render the
      // backend's OWN `lines` rather than re-deriving text here: the wording (and the reason
      // split behind it) belongs to the backend that knows what it withheld and why. Mirrors the
      // undeliveredMessage line above — same already-existing system-transcript surface, no new UI.
      const capabilityNotice = e.data["capabilityNotice"];
      if (capabilityNotice && typeof capabilityNotice === "object") {
        const lines = (capabilityNotice as Record<string, unknown>)["lines"];
        if (Array.isArray(lines)) {
          for (const line of lines) {
            if (typeof line === "string" && line.trim()) {
              agent.transcript.push({ role: "system", text: `capability notice: ${line}`, ...at });
            }
          }
        }
      }
      // TURN-LIMIT-SILENT-STOP: backends/claude.ts names the SDK's error_max_turns stop —
      // a "fail"-policy agent whose turn was ended AT the cap, which for a conductor is not
      // terminal (it stays "running", just idle mid-task). Mirrors the undeliveredMessage
      // line above: same already-existing system-transcript surface, no new UI.
      if (e.data["turnLimitStop"] === true) {
        const done = String(e.data["turnsCompleted"] ?? "?");
        const budget = String(e.data["turnBudget"] ?? "?");
        agent.transcript.push({
          role: "system",
          text: `turn limit reached (${done}/${budget}) — the SDK ended this turn. Raise it with agent_set_turn_limit (turnLimitPolicy "soft" = no hard cap).`,
          ...at,
        });
      }
      const budgetLine = budgetStatusLine(e.data);
      if (budgetLine) agent.transcript.push({ role: "system", text: budgetLine, ...at });
      // F09: the turn-opening event that finally arrived (or a terminal/hold transition)
      // clears the badge set by the agent_prompt_stalled case above.
      if (e.data["promptStallCleared"] === true) {
        // F09.UI: the clear used to only null the field — the badge vanished and NOTHING recorded
        // that the prompt was eventually picked up, so an operator who looked away could not tell
        // a resolved stall from one they had imagined. Guarded on a stall actually being present
        // so a replayed/duplicate clear can never print a phantom ack.
        const cleared = agent.promptStall;
        agent.promptStall = null;
        if (cleared) {
          const reported = Number(e.data["ackMs"]);
          const ackMs = Number.isFinite(reported) && reported > 0
            ? reported
            : cleared.sinceTs > 0 ? Math.max(0, e.ts - cleared.sinceTs) : null;
          agent.transcript.push({ role: "system", text: promptStallClearLine(cleared.from, ackMs), ...at });
        }
      }
      if (e.data["denied"] === true) {
        const toolName = String(e.data["toolName"] ?? "?");
        agent.tools.push({ ts: e.ts, toolName, status: "denied" });
        // The denial is now represented as a tool TranscriptItem in the flow
        // (consistent with the called/done model), not a separate "denied: X"
        // system line.
        agent.transcript.push({ role: "tool", toolName, status: "denied", ...at });
      }
      // Coverage B2/A2: apply a TERMINAL daemon status state (killed/failed/
      // interrupted — see STATUS_TERMINAL_STATE) as the agent's final state and
      // clear busy, so a killed/failed agent stops rendering "running"/◐ forever.
      // Generalizes the former interrupted-only branch: interrupted still maps to
      // "failed" and still clears the banners, and a dead agent (killed/failed)
      // must likewise not strand a stale pendingQuestion/pendingDialog (mirrors
      // the "error" case). Non-terminal states (paused/running) are absent from
      // the map, so this is a no-op for them — agent.list stays authoritative.
      const terminalState = STATUS_TERMINAL_STATE[String(e.data["state"] ?? "")];
      if (terminalState) {
        agent.state = terminalState;
        goIdle(agent, true);   // terminal: no completion event is coming
        agent.pendingQuestion = null;   // a terminal turn must not leave a stale question banner
        agent.pendingDialog = null;     // Task DLG3: mirrors pendingQuestion above
      }
      // SOFT-TURN-LIMIT: the backend crossed a turnLimitPolicy:"soft" agent's
      // nominal maxTurns — flag it for AgentList/AgentDetail's warn-toned badge.
      // Deliberately does NOT touch agent.state (stays "running").
      if (e.data["turnBudgetExceeded"] === true) agent.turnBudgetExceeded = true;
      // renameAgent emits a bare status, including self-renames after registration.
      if (typeof e.data["displayLabel"] === "string" && e.data["displayLabel"].trim()) {
        agent.displayLabel = e.data["displayLabel"].trim();
      }
      // AGENT-GROUPS Phase 1: setAgentGroups emits a bare status{state, groups} on EVERY
      // membership change (not a one-shot like displayLabel/rename_self) — fold it live,
      // ungated by `registered` (unlike foldAgentIdentity's spawn-time stamp above), so a
      // re-file into a different group updates the row without waiting for a reconnect.
      if (Array.isArray(e.data["groups"])) {
        agent.groups = e.data["groups"].filter((g): g is string => typeof g === "string");
      }
      // F47: agent.markSeen emits a bare status{state, reviewedAt} per agent — fold it live and
      // ungated by `registered`, exactly like the groups re-emit above, so the badge clears on
      // the other surface immediately instead of at the next snapshot (the desktop app never
      // takes one after bootstrap).
      if (typeof e.data["reviewedAt"] === "number") agent.reviewedAt = e.data["reviewedAt"];
      // F22.UI (QA gap): supervisor.launch() swallows the lease acquire() GuardrailError and
      // re-emits it only as this string on a bare status event — before this fold it was
      // projected nowhere and rendered nowhere, so "another agent tried to write your worktree"
      // was invisible to the operator. Sticky (a past fact) + one transcript line, so it is
      // visible both in the header chip and in the scrollback where it happened.
      if (typeof e.data["worktreeLeaseContended"] === "string" && e.data["worktreeLeaseContended"].length > 0) {
        const msg = e.data["worktreeLeaseContended"];
        agent.worktreeLeaseContended = { message: msg, at: e.ts };
        agent.transcript.push({ role: "system", text: `⌂ worktree lease contended — ${msg}`, ...at });
      }
      // PAUSED-AGENTS-VISIBLE: supervisor.ts's parkPaused emits an AUTHORITATIVE
      // status{state:"paused", paused:true, reason, resumeScheduledAt} the instant it
      // parks a record — fold it live so a paused agent's row updates immediately instead
      // of only at the next agent.list snapshot (a reconnect/connect-only fetch for the
      // desktop app — see createStore.ts — which could otherwise show a paused agent as
      // "running" for the rest of the session). Keyed on `paused===true` specifically (not
      // the bare `state==="paused"` string the STATUS_TERMINAL_STATE comment above already
      // treats as ambiguous/no-op-safe) so only the real parkPaused event shape triggers
      // this, never a synthetic/partial status payload.
      if (e.data["paused"] === true && agent.state !== "killed") {
        agent.state = "paused";
        goIdle(agent, true);   // terminal: no completion event is coming
        agent.pauseReason = typeof e.data["reason"] === "string" ? (e.data["reason"] as AgentView["pauseReason"]) : undefined;
        agent.resumeAt = typeof e.data["resumeScheduledAt"] === "number" ? e.data["resumeScheduledAt"] as number : undefined;
      }
      // F08: markFailed's status{state:"failed", error, failure} is the authoritative "why did
      // this die" signal — fold it live so a failed row names its cause immediately instead of
      // only at the next agent.list snapshot (a connect-only fetch for the desktop app, see
      // createStore.ts). Keyed on the `failure` object's own presence, mirroring the pause fold
      // above, so no synthetic/partial status payload can trigger it.
      {
        const f = e.data["failure"];
        if (f && typeof f === "object" && typeof (f as Record<string, unknown>)["cause"] === "string") {
          agent.failure = f as AgentView["failure"];
          // F08.UI: markFailed's status is the ONLY moment the disposition is decided, and it
          // pushes no transcript line of its own (unlike kind:"error") — the classified cause
          // lived exclusively on a row badge a restart then wiped. One system line, in the place
          // an operator already reads a run's story. The crash-loop breaker's own
          // circuit_breaker_tripped line is disjoint from this one (restart budget vs. cause), so
          // the two are complementary rather than a repeat.
          agent.transcript.push({ role: "system", text: failureLine(agent.failure as NonNullable<AgentView["failure"]>), ...at });
        } else if (e.data["state"] === "failed") {
          // F08.QA: markFailed's status payload REPLACES "why this died" — 10 of its 12 call
          // sites (rerouted launch, resume, setModel, handoff, rebind, ...) never ran the
          // classifier and carry no `failure` key at all, so an absent key on a state:"failed"
          // status means "this death has no classified cause", not "keep the last one". Without
          // this branch a second death wears the FIRST incident's badge. Gated on the terminal
          // state so the bare status re-emits above (groups, reviewedAt, paused) never clear it.
          agent.failure = undefined;
        }
      }
      // PAUSED-AGENTS-VISIBLE: mirrors the pause fold above — resumePaused's own
      // status{state:"running", resumed:true} is the authoritative "no longer paused"
      // signal, so clear the pause badge live instead of waiting for the next snapshot.
      // Keyed on `resumed===true` (not the bare "running" string) for the same
      // no-ambiguous-trigger reason as the pause fold.
      if (e.data["resumed"] === true) {
        agent.state = "running";
        agent.pauseReason = undefined;
        agent.resumeAt = undefined;
        // PAUSED-CONDUCTOR: a wake nobody asked for out loud (mail or an ask_agent arriving for a
        // dormant agent revives it) is otherwise invisible — the row just flips back to running
        // with no trace. One system line records who woke it and out of which hold. Gated on
        // `resumedBy` so an operator-driven resume (no such key) stays exactly as it renders today.
        if (typeof e.data["resumedBy"] === "string") {
          const from = typeof e.data["from"] === "string" ? ` from ${e.data["from"]}` : "";
          const hold = typeof e.data["resumedFromPause"] === "string" ? ` (was ${e.data["resumedFromPause"]})` : "";
          agent.transcript.push({ role: "system", text: `⏵ resumed by ${e.data["resumedBy"]}${from}${hold}`, ...at });
        }
      }
      // TOOL-SURFACE-MEASURE: mirrors turnBudgetExceeded's own live-event capture just above —
      // see AgentView.toolSurfaceEstimate's doc comment.
      if (e.data["toolSurface"] && typeof e.data["toolSurface"] === "object") {
        // F41.UI: the grant itself is otherwise invisible — the estimate only ever surfaced in the
        // detail panel's metadata row, so an operator watching the transcript never learned that
        // this spawn just paid for a chimera MCP tool catalog. One system line, pushed on the FIRST
        // estimate only (status re-emits must not stack duplicates), same idiom as `⏵ resumed by`.
        const est = e.data["toolSurface"] as NonNullable<AgentView["toolSurfaceEstimate"]>;
        if (agent.toolSurfaceEstimate === undefined && typeof est.approxTokens === "number") {
          const rows = Array.isArray(est.bySource)
            ? est.bySource.map((r) => `${r.source.replace(/^chimera-/, "")} ${r.toolCount}`).join(" + ")
            : "";
          agent.transcript.push({
            role: "system",
            text: `⚙ tool surface: chimera MCP ~${est.approxTokens} tok · ${est.toolCount} tools${rows ? ` (${rows})` : ""}`
              + " — estimate, written once at spawn; settings/plugins/store servers not counted",
            ...at,
          });
        }
        agent.toolSurfaceEstimate = est;
      }
      // Native-CLI-parity Phase 2 (Task DLG3): DLG1's dialog-timeout/resolution
      // record, mirroring "permissionResolved" just below -- clears the banner
      // (checked against the CURRENT pendingDialog's own id, since -- unlike the
      // permission queue -- there's only one pendingDialog slot per agent, and a
      // stale/out-of-order resolution for an already-replaced dialog must not
      // clear a newer one).
      if (e.data["dialogResolved"] === true && agent.pendingDialog && String(e.data["dialogId"]) === agent.pendingDialog.dialogId) {
        agent.pendingDialog = null;
      }
      // FEATURE-9 (attention inbox bug fix): the daemon's timeout-fallback record for
      // ask(), mirroring "permissionResolved"/"dialogResolved" just above/below -- clears
      // a stale question/approval banner (checked against the CURRENT pendingQuestion's
      // own id, same stale-resolution guard as dialogResolved) so a fail-closed gate
      // timeout or a resolution the human never saw doesn't strand a phantom "Needs you
      // now" inbox row forever.
      if (e.data["questionResolved"] === true && agent.pendingQuestion && String(e.data["questionId"]) === agent.pendingQuestion.questionId) {
        agent.pendingQuestion = null;
      }
      // SLASH-COMMAND-IN-FLIGHT: remember WHICH command this turn is running, so the transcript
      // can name it instead of showing a bare spinner. Set before the delivered-turn fold below,
      // which may return early for a locally-echoed turn.
      if (e.data["delivered"] === true && e.data["slash"] === true && typeof e.data["text"] === "string") {
        agent.pendingCommand = e.data["text"];
      }
      if (e.data["delivered"] === true) {
        // Task 4's mailbox-delivery record: render user turns from OTHER clients;
        // a LIVE send from THIS client is already locally echoed (userSent), so
        // it must not duplicate. DELIVERY.MARK: coalesce a missing OR empty
        // origin to "?" (not just nullish — an empty string is falsy in the
        // renderer's marker check, so storing "" would silently degrade the
        // turn back to a plain "you"). A real deliverTo `from` is always a
        // non-empty agent id.
        const from = e.data["from"] ? String(e.data["from"]) : "?";
        const text = String(e.data["text"] ?? "");
        // Thread the STRUCTURED origin (`from`) onto the turn so the renderer
        // marks it as an incoming agent delivery (distinct label + color), never
        // string-matching a text prefix. A genuine user turn from a human cockpit
        // surface (from === "tui" OR "app") carries no `from` -- see
        // OWN-TURNS-SURVIVE-RELOAD above for why this dedupes rather than
        // blanket-skips. Both surfaces locally echo their own sends, so both must
        // dedupe here or the sending client renders every own turn twice (and
        // mislabeled as an inbound "[from app]" delivery).
        // D9: the daemon mirrors `images`/`content` on this event now (previously
        // text-only), so a delivered turn from another client replays with the
        // same attachments/block order instead of losing them after a reload.
        const deliveredImages = Array.isArray(e.data["images"]) ? (e.data["images"] as Image[]) : undefined;
        const deliveredContent = Array.isArray(e.data["content"]) ? (e.data["content"] as ContentBlock[]) : undefined;
        const extra = {
          ...(deliveredImages && deliveredImages.length > 0 ? { images: deliveredImages } : {}),
          ...(deliveredContent && deliveredContent.length > 0 ? { content: deliveredContent } : {}),
        };
        if (from === "tui" || from === "app") {
          if (!hasRecentUserEcho(agent.transcript, text)) {
            agent.transcript.push({ role: "user", text, ...extra, ...at });
          }
        } else {
          agent.transcript.push({ role: "user", text, from, ...extra, ...at });
        }
      }
      if (e.data["permissionResolved"] === true && typeof e.data["requestId"] === "string") {
        // Task 4's timeout-fallback record: the daemon already resolved this request —
        // clear the banner so y/n keys are never hijacked by a stale prompt.
        pending = pending.filter((p) => p.requestId !== e.data["requestId"]);
      }
      // REMOTE-CONTROL: AgentSupervisor.remoteControl appends the full RemoteControlStatus
      // on every toggle — fold it verbatim (authoritative-when-present, like gitBranch)
      // so AgentDetail's remote-control affordance reflects the live enable/disable state
      // and attach URL without a separate poll.
      if (e.data["remoteControl"] && typeof e.data["remoteControl"] === "object") {
        agent.remoteControl = e.data["remoteControl"] as AgentView["remoteControl"];
      }
      // CONDUCTOR-FULL-ACCESS: AgentSupervisor.setPermission appends a `permissionChanged`
      // status event carrying whichever of permissionProfile/permissionRequest was patched —
      // fold each authoritative-when-present (like remoteControl above) so the AgentDetail
      // permission chip reflects a live agent.setPermission the instant it lands, with no wait
      // for the next agent.list snapshot (the app polls agent.list only once at bootstrap).
      if (e.data["permissionChanged"] === true) {
        if (typeof e.data["permissionProfile"] === "string") agent.permissionProfile = e.data["permissionProfile"] as string;
        if (typeof e.data["permissionRequest"] === "string") agent.permissionRequest = e.data["permissionRequest"] as string;
        // CODEX-SETPERMISSION-IS-COSMETIC-TO-THE-OPERATOR: fold whether THIS change actually
        // reached the running process, same authoritative-when-present pattern as the fields above.
        if (typeof e.data["appliedToRunningProcess"] === "boolean")
          agent.permissionAppliedToRunningProcess = e.data["appliedToRunningProcess"] as boolean;
      }
      break;
    }
  }

  // TUI-008 (MAJOR): bound tools' length AND (since the NEXT event's clone at the
  // top of this function clones whatever size prev.tools already is) the
  // per-event clone cost -- otherwise it grows unboundedly over a long-lived
  // conductor's session, unlike the global `events` ring buffer above. Not
  // gated on atBottom/historyMinSeq like transcript below — the per-tool-call
  // detail card ToolLogItem backs isn't reachable via older-page paging the
  // way transcript rows are, so there's no "operator opted into more of it"
  // case to preserve.
  if (agent.tools.length > TOOLS_BUFFER_MAX) agent.tools = agent.tools.slice(-TOOLS_BUFFER_MAX);

  // TRANSCRIPT-EVICT-OLD: cap the LIVE transcript too, same rule as the two
  // banner-injection sites above — evictTranscriptFront no-ops unless BOTH the
  // agent is over TRANSCRIPT_BUFFER_MAX and the operator is pinned at the
  // bottom (agent.atBottom), so a reader scrolled up mid-history never has
  // rows yanked from under them; the front just keeps growing until they
  // return to the tail (transcriptAtBottom case below re-runs eviction then).
  // Formerly skipped entirely once historyMinSeq was set (a deliberately-
  // extended, paged-in transcript) — evictTranscriptFront supersedes that by
  // recomputing historyMinSeq from the new-oldest row instead of leaving
  // growth unbounded, which is the whole point of this task.
  agent = evictTranscriptFront(agent);

  const nextAgents = { ...state.agents, [key]: agent };
  // LINEAGE MISPARENTING FIX (see reconcileAgentOrder): keep agentOrder in the snapshot's
  // DFS-by-parentId + owner-splice order so an event-born child/shadow nests under its OWN
  // parent, not a later-spawned sibling. Reconcile only when this event could have moved
  // lineage/membership -- a newly-seen agent (agentOrder grew) OR an agent_started/agent_task
  // that carries parentId/treeId/originConductorId/membership -- so a per-token message_delta
  // leaves agentOrder's identity untouched (no needless AgentList re-sort/re-render).
  // REBIND-LINEAGE: a bare `status` rebind (setOriginConductor, see its case "status" fold
  // above) changes originConductorId on an ALREADY-seen agent -- `appended` alone misses it
  // (agentOrder didn't grow), so without this the field updates in `state.agents` but the
  // worker's POSITION in agentOrder (what both UIs actually render off) never moves.
  const appended = state.agentOrder.includes(key) ? state.agentOrder : [...state.agentOrder, key];
  const rebindEvent =
    e.kind === "status" && (typeof e.data["originConductorId"] === "string" || e.data["originConductorId"] === null);
  const lineageEvent = e.kind === "agent_started" || e.kind === "agent_task" || e.kind === "status" && e.data["registered"] === true || rebindEvent;
  const agentOrder =
    appended !== state.agentOrder || lineageEvent ? reconcileAgentOrder(nextAgents, appended) : state.agentOrder;
  const selected = state.selectedAgentId ?? key;
  // F47.QA2: only the reviewedAt fold can hide a row this way, so no other event pays for the
  // visible-order walk (a per-token message_delta must stay allocation-cheap).
  const selectedAgentId =
    state.unseenOnly && e.kind === "status" && typeof e.data["reviewedAt"] === "number"
      ? reselectAfterSeenFold({ ...state, agents: nextAgents, agentOrder, selectedAgentId: selected })
      : selected;
  return {
    ...state,
    lastSeq: e.seq,
    unseen,
    hooks,
    agents: nextAgents,
    agentOrder,
    events: [...state.events, e].slice(-EVENT_BUFFER_MAX),
    pendingPermissions: pending,
    accounts,
    selectedAgentId,
  };
}

/** Dismiss every ephemeral surface without disturbing the tab's durable
 * selection, cursors, drill-ins, or fetched payloads. */
export function closeTransientOverlays(state: UiState): UiState {
  return {
    ...state,
    workflowStudio: { ...initialState.workflowStudio },
    reviewRoom: {
      ...state.reviewRoom,
      openTaskId: null,
      loading: false,
      error: null,
      sessionError: null,
    },
    mode: "normal",
    pushQueue: null,
    editTask: null,
    versionsOpen: false,
    taskDetailOpen: false,
    accountsOpen: false,
    helpOpen: false,
    a2aHistoryOpen: false,
    paletteOpen: false,
    paletteQuery: "",
    mcpPaletteOpen: false,
    resultOpen: false,
    confirm: null,
  };
}

export function reduce(state: UiState, action: Action): UiState {
  switch (action.type) {
    case "event": {
      const before = state.agents[action.event.agentId]?.transcript.length ?? 0;
      const next = projectEvent(state, action.event, action.stampTs === true);
      const after = next.agents[action.event.agentId]?.transcript.length ?? 0;
      if (after <= before) return next;
      return {
        ...next,
        liveboardLanes: next.liveboardLanes.map((lane) =>
          lane.agentId === action.event.agentId && !lane.follow
            ? { ...lane, unread: lane.unread + (after - before) }
            : lane,
        ),
      };
    }
    case "connected":
      return { ...state, connected: action.connected };
    case "reconnecting":                                    // TUI-007
      return { ...state, reconnecting: action.reconnecting };
    case "liveboardLaneAdd":
      if (state.liveboardLanes.length >= 4 || state.liveboardLanes.some((l) => l.agentId === action.agentId)) return state;
      return { ...state, liveboardLanes: [...state.liveboardLanes, { agentId: action.agentId, follow: true, unread: 0 }] };
    case "liveboardLaneRemove":
      return { ...state, liveboardLanes: state.liveboardLanes.filter((l) => l.agentId !== action.agentId) };
    case "liveboardLaneFollow":
      return { ...state, liveboardLanes: state.liveboardLanes.map((l) => l.agentId === action.agentId ? { ...l, follow: action.follow, unread: action.follow ? 0 : l.unread } : l) };
    case "liveboardLaneRead":
      return { ...state, liveboardLanes: state.liveboardLanes.map((l) => l.agentId === action.agentId ? { ...l, unread: 0 } : l) };
    case "daemonStatus": {
      // F49.UI: the loopback MCP listener emits no event when a client connects or
      // drops -- the grant roster in daemon.status is the only trace. Diff it against
      // the previous poll and write the change into the owning agent's transcript,
      // otherwise a kimi agent reaching chimera tools is invisible to the operator.
      const { transitions, agentIds } = mcpListenerTransitions(state.mcpListenerGrantAgents, action.status.mcpListener);
      let agents = state.agents;
      for (const t of transitions) {
        const prevAgent = agents[t.agentId];
        if (!prevAgent) continue;   // a grant for an agent this UI has no record of has nowhere to render
        if (agents === state.agents) agents = { ...agents };
        agents[t.agentId] = evictTranscriptFront({
          ...prevAgent,
          transcript: [...prevAgent.transcript, { role: "system" as const, text: t.text }],
        });
      }
      return {
        ...state,
        connected: true,
        protocolVersion: action.status.protocolVersion,
        agentCounts: action.status.agents,
        accounts: action.status.accounts ?? state.accounts,
        // FC-2 (F4-display): unlike accounts, peers does NOT fall back to the prior
        // value when omitted -- a status without peers means none right now.
        peers: action.status.peers ?? [],
        mcpListenerGrantAgents: agentIds,
        // F01-QA-follow-up: falls back to the prior value when omitted, like accounts —
        // an older daemon that doesn't send the field must not blank out an already-known
        // degraded state.
        wakeScheduling: action.status.wakeScheduling ?? state.wakeScheduling,
        agents,
      };
    }
    case "agentRecords": {
      // Authoritative merge: the daemon's agent.list snapshot WINS over any
      // event-derived state (e.g. "killed" only ever arrives via this path) —
      // every AgentView is built through emptyAgent() so the required
      // pendingQuestion field can never be missing from a records-only agent.
      const agents = { ...state.agents };
      // Task STREE: TREE-ORDER, not a plain createdAt sort -- see treeOrder's
      // own doc comment. A flat (no-treeId) records list orders identically
      // to the old plain sort, so this is a behavior-preserving swap.
      const order = treeOrder(action.records);
      for (const r of action.records) {
        const prev = agents[r.agentId] ?? emptyAgent(r.agentId);
        // Task TEAMGROUP: computed once, ahead of the object below — WORKFLOW-
        // TASK-VIEW-2 (bug B) reuses it to gate `conductor` (see there).
        const membership =
          r.membership && typeof r.membership === "object" && typeof r.membership.team === "string"
            ? r.membership
            : prev.membership;
        // LINEAGE: compute the MERGED owner/depth once so displayDepth's +1 owner-bump uses the
        // value that actually lands on the view. The old inline form bumped on the INCOMING
        // r.originConductorId, so a snapshot that omitted the field (older daemon / a poll that
        // raced ahead of the stamp) kept prev.originConductorId but dropped its indent bump --
        // a conductor-owned worker briefly un-nested. (Also flagged as latent debt.)
        const mergedOwner = r.originConductorId !== undefined ? r.originConductorId : prev.originConductorId;
        const mergedDepth = typeof r.depth === "number" ? r.depth : prev.depth ?? 0;
        agents[r.agentId] = {
          ...prev,
          state: r.state,
          // PAUSED-AGENTS-VISIBLE: keyed on the SNAPSHOT's own state, not "present -> keep,
          // absent -> prev" like the authoritative-when-present fields below — the daemon
          // deletes AgentRecord.pauseReason/resumeAt the moment it resumes a record (see
          // supervisor.ts's resumePaused), so an absent field here means "no longer paused,"
          // not "unknown, keep whatever we had." Falling back to `...prev` on an absent field
          // would leave a stale reason/resumeAt on the view forever after a real resume.
          pauseReason: r.state === "paused" ? (r.pauseReason ?? prev.pauseReason) : undefined,
          resumeAt: r.state === "paused" ? (r.resumeAt ?? prev.resumeAt) : undefined,
          // F08 + F08.QA: keyed on the SNAPSHOT's own state for exactly the PAUSED-AGENTS-VISIBLE
          // reason above — the daemon deletes AgentRecord.failure the moment the agent starts
          // running again (supervisor.ts's agent_started handler), so a non-failed record means
          // "recovered", never "unknown, keep the badge". The `?? prev` fallback survives only
          // WITHIN the failed state, where it covers the connect race: createStore.ts subscribes
          // BEFORE it fetches agent.list, so a live-folded disposition can arrive while the
          // snapshot is still in flight and must not be erased by that older view.
          failure: r.state === "failed" ? (r.failure ?? prev.failure) : undefined,
          account: r.accountName,
          provider: r.provider,
          slashCommands: r.provider === "codex" ? [...CODEX_SLASH_COMMANDS] : r.provider === prev.provider ? prev.slashCommands : [],
          costUsd: r.costUsd || prev.costUsd,
          displayLabel:
            typeof r.displayLabel === "string" && r.displayLabel.trim()
              ? r.displayLabel.trim()
              : typeof r.spec?.displayLabel === "string" && r.spec.displayLabel.trim()
                ? r.spec.displayLabel.trim()
                : prev.displayLabel,
          // WORKFLOW-TASK-VIEW-2 (bug B): mirrors the agent_started gate above —
          // r.spec.conductor is forced true for a workflow step agent too (D12
          // session-liveness hack), so only trust it as DISPLAY identity when
          // this record carries no team membership.
          conductor: r.spec?.conductor === true && !membership,
          // Ad-hoc sessions design §1/§6: unlike conductor, session has exactly one
          // producer (an explicit spawn-time flag) — no membership guard needed.
          session: r.spec?.session === true,
          // Task T1: a daemon poll snapshot must never reset a still-RUNNING busy agent
          // (busy is projected from the event stream), BUT a terminal snapshot (killed/
          // done/failed — 'killed' ONLY ever arrives via this path) must clear busy, or a
          // dead agent lingers busy:true and F1/F6 misread it as a live working agent.
          // busy is projected exclusively from the event stream (message_delta/
          // tool_call/turn_complete/result/error/interrupted), not agent.list.
          busy: r.state === "running" ? prev.busy : false,
          // ELAPSED-TIMER: busySince rides busy — a still-running snapshot preserves
          // the event-derived turn-start; a terminal one clears it (mirrors busy).
          busySince: r.state === "running" ? prev.busySince : undefined,
          // AGENT-DONE-STATE-STALE-UI: same reasoning as busy just above — a
          // terminal snapshot (done/killed/failed) must not preserve a stale
          // pendingQuestion/pendingDialog from `prev`, or a reconnecting client
          // that had a banner stranded on this agent re-derives "waiting" for a
          // finished agent (agent.list carries no pending* fields, so an absent
          // one would otherwise leave the prior banner untouched via ...prev).
          pendingQuestion: isTerminalAgentState(r.state) ? null : prev.pendingQuestion,
          pendingDialog: isTerminalAgentState(r.state) ? null : prev.pendingDialog,
          // Task STREE: defensive typeof guards -- a malformed/absent wire
          // value never clobbers a PRIOR valid projection with undefined; it
          // simply leaves the prior value in place (mirrors the rest of this
          // merge's "authoritative when present" shape).
          treeId: typeof r.treeId === "string" ? r.treeId : prev.treeId,
          depth: typeof r.depth === "number" ? r.depth : prev.depth,
          originConductorId: mergedOwner,
          displayDepth: mergedDepth + (mergedOwner ? 1 : 0),
          // Task TEAMGROUP: defensive typeof guard, mirroring treeId/depth above --
          // a malformed/absent membership never clobbers a prior valid projection.
          membership,
          // ROLES-TAB S1/S4: authoritative-when-present, mirroring treeId/depth above --
          // an older daemon (or a plain non-session spawn) omits the field, in which case
          // the prior projection is kept rather than clobbered with undefined.
          sessionRole: r.sessionRole !== undefined ? r.sessionRole : prev.sessionRole,
          // ROLES-UNIFY §3.3: same authoritative-when-present discipline as sessionRole
          // just above — a FROZEN audit record stamped once at spawn, never re-derived.
          sessionRoleOverrides: r.sessionRoleOverrides !== undefined ? r.sessionRoleOverrides : prev.sessionRoleOverrides,
          // JOB-FLEET-GROUPING: authoritative-when-present, same discipline as sessionRole —
          // stamped once at spawn, never re-derived.
          jobName: r.jobName !== undefined ? r.jobName : prev.jobName,
          // AGENT-GROUPS Phase 1: authoritative-when-present, same discipline as jobName —
          // unlike jobName this CAN change post-spawn (agent.setGroups), but a full
          // agent.list snapshot is always the freshest truth, so "present -> use it, absent
          // -> keep prev" is still correct (an older daemon predating this field is the only
          // real "absent" case in practice).
          groups: r.groups !== undefined ? r.groups : prev.groups,
          // F47: authoritative-when-present, same discipline as groups above. Both fields can
          // change post-spawn (an attention event, a markSeen), and a full agent.list snapshot
          // is always the freshest truth, so present => use it, absent => keep prev (an older
          // daemon predating these fields is the only real "absent" case).
          attentionAt: r.attentionAt !== undefined ? r.attentionAt : prev.attentionAt,
          reviewedAt: r.reviewedAt !== undefined ? r.reviewedAt : prev.reviewedAt,
          createdAt: typeof r.createdAt === "number" ? r.createdAt : prev.createdAt,
          // Task N-SHADOW: defensive projection (mirrors treeId/depth/membership) --
          // marks this row as a native sub-agent/workflow shadow and carries its
          // friendly label, which AgentList renders in place of the shortId.
          shadow: r.shadow === true ? true : prev.shadow,
          label: typeof r.label === "string" ? r.label : prev.label,
          // Task SHADOW-ACT: authoritative-when-present, mirroring the fields above --
          // a snapshot carrying a fresh shadowInfo updates the live activity panel; an
          // absent one (real agent, or a poll before the first rich agent_task) leaves
          // the prior value untouched so the panel never flickers empty mid-run.
          shadowInfo:
            r.shadowInfo && typeof r.shadowInfo === "object" ? r.shadowInfo : prev.shadowInfo,
          // WD Stage 1 (coverage B12): authoritative-when-present, mirroring treeId/depth —
          // a snapshot without the field (older daemon, probe not landed) keeps the prior value.
          gitBranch: typeof r.gitBranch === "string" ? r.gitBranch : prev.gitBranch,
          // IN-APP-TERMINAL: authoritative-when-present, mirroring gitBranch above — an
          // older daemon (or a summary predating the field) omits it and the prior value
          // (or undefined, pre-first-poll) is kept.
          workdir: r.workdir !== undefined ? r.workdir : prev.workdir,
          // SOFT-TURN-LIMIT: sticky like shadow above — once a snapshot reports it
          // true, keep it true even if a later poll omits the field.
          turnBudgetExceeded: r.turnBudgetExceeded === true ? true : prev.turnBudgetExceeded,
          // TOOL-SURFACE-MEASURE: authoritative-when-present, mirroring gitBranch — the
          // backend record only ever sets these once populated and never reverts them to
          // undefined, so "present wins" and "sticky" are equivalent here in practice.
          toolSurfaceEstimate: r.toolSurfaceEstimate !== undefined ? r.toolSurfaceEstimate : prev.toolSurfaceEstimate,
          toolSurfaceCacheWriteTokens: r.toolSurfaceCacheWriteTokens !== undefined ? r.toolSurfaceCacheWriteTokens : prev.toolSurfaceCacheWriteTokens,
          toolSurfaceServers: r.toolSurfaceServers !== undefined ? r.toolSurfaceServers : prev.toolSurfaceServers,
          // P3-T2: authoritative-when-PRESENT (not just when truthy) — a real
          // `null` (an actual "no parent"/"no project" value) must overwrite a
          // prior value; only a genuinely absent field (older daemon) falls back.
          parentId: r.parentId !== undefined ? r.parentId : prev.parentId,
          forkLineage: r.forkLineage ?? prev.forkLineage,
          projectId: r.projectId !== undefined ? r.projectId : prev.projectId,
          // WD Stage 1 (coverage B2): a remote record's id is engine-qualified
          // ("<engineId>/<localId>", the same key qualifiedAgentId builds on the event
          // path) — derive the origin engine from it; a bare local id parses to null and
          // keeps the prior (event-stamped or absent) value.
          engine: parseAgentAddress(r.agentId).engineId ?? prev.engine,
          // R2 (ctx meter effective-limit): authoritative-when-PRESENT, mirroring gitBranch/
          // parentId above (NOT sticky-once-set like turnBudgetExceeded) -- a later snapshot
          // with a DIFFERENT value (e.g. a live config.patch changed compactionThreshold and
          // the agent respawned) must win over a stale prior one; an absent field (older
          // daemon / a snapshot that raced ahead of the stamp) leaves the prior value alone.
          contextLimits: r.contextLimits ?? prev.contextLimits,
          effectiveContextLimit: typeof r.effectiveContextLimit === "number" ? r.effectiveContextLimit : prev.effectiveContextLimit,
          // CONDUCTOR-FULL-ACCESS: authoritative-when-present, mirroring gitBranch above — a
          // snapshot carrying the spec updates the live permission scope; an absent field (older
          // daemon's summary path that drops spec) keeps the prior value so the chip never blanks.
          permissionProfile: typeof r.spec?.permissionProfile === "string" ? r.spec.permissionProfile : prev.permissionProfile,
          permissionRequest: typeof r.spec?.on?.permissionRequest === "string" ? r.spec.on.permissionRequest : prev.permissionRequest,
          // DENIED-TOOL-CALL-INVISIBLE: sticky like turnBudgetExceeded above — once a snapshot
          // reports a denial, keep the warning even if a later poll races ahead of the event.
          toolPolicyDenied: r.toolPolicyDenied === true ? true : prev.toolPolicyDenied,
          lastToolPolicyDenial: r.lastToolPolicyDenial ?? prev.lastToolPolicyDenial,
          // F22: worktreeLeaseHeld is authoritative-when-present, mirroring gitBranch/workdir
          // above (NOT sticky) — a lease legitimately released via worktree_lease_release or
          // handed off must clear the chip on the very next snapshot, not linger like a denial.
          // worktreeLeaseDenied/lastWorktreeLeaseDenial are sticky, mirroring toolPolicyDenied
          // above, for the same reason: the refusal stays visible even if a later poll races
          // ahead of the event.
          worktreeLeaseHeld: r.worktreeLeaseHeld !== undefined ? r.worktreeLeaseHeld : prev.worktreeLeaseHeld,
          worktreeLeaseDenied: r.worktreeLeaseDenied === true ? true : prev.worktreeLeaseDenied,
          lastWorktreeLeaseDenial: r.lastWorktreeLeaseDenial ?? prev.lastWorktreeLeaseDenial,
          // F09: r.promptStalled is a boolean-only projection (AgentSummary tier split) — true
          // keeps whatever detail the event stream already folded, false/absent clears it, so a
          // reconnect can never resurrect a badge the daemon has already cleared server-side.
          // A FRESH client has no prior event fold, so `prev.promptStall` is undefined and the row
          // would show no badge at all until that agent was selected and its history loaded — the
          // one case where the snapshot is the only evidence. Fall back to a `partial` stall: real
          // enough to warn, honest enough to omit the duration and sender it cannot know.
          promptStall: r.promptStalled
            ? (prev.promptStall ?? { deliveryId: "", from: "", sinceTs: 0, sinceMs: 0, partial: true })
            : null,
        };
      }
      const extras = state.agentOrder.filter((id) => !order.includes(id));
      return {
        ...state,
        agents,
        agentOrder: [...order, ...extras],
        selectedAgentId: state.selectedAgentId ?? order[0] ?? null,
        // P3-T2: rebuilt wholesale from this snapshot, like treeOrder above —
        // see buildConductorByProject's own doc comment.
        conductorByProject: buildConductorByProject(action.records),
      };
    }
    case "teams":
      return { ...state, teams: { available: action.available, items: action.items } };
    case "queues":
      return { ...state, queues: { available: action.available, items: action.items } };
    case "roles":
      return { ...state, roles: { available: action.available, items: action.items } };
    case "groups":
      return { ...state, groups: { available: action.available, items: action.items } };
    case "setActiveGroup":
      return { ...state, activeGroupId: action.groupId };
    case "workflowStudioOpen": {
      const next = closeTransientOverlays(state);
      return { ...next, workflowStudio: { open: true, mode: action.mode, queue: action.queue ?? null, taskId: action.taskId ?? null, version: action.version ?? null, baseline: action.document, draft: action.document, selectedNodeId: action.document.nodeOrder[0] ?? null, dirty: false, saving: false, error: null, failedOnly: action.failedOnly === true } };
    }
    case "workflowStudioClose":
      return { ...state, workflowStudio: { ...initialState.workflowStudio } };
    case "workflowStudioDraft":
      return { ...state, workflowStudio: { ...state.workflowStudio, draft: action.document, dirty: JSON.stringify(action.document) !== JSON.stringify(state.workflowStudio.baseline), error: null } };
    case "workflowStudioSelect":
      return { ...state, workflowStudio: { ...state.workflowStudio, selectedNodeId: action.nodeId } };
    case "workflowStudioSaving":
      return { ...state, workflowStudio: { ...state.workflowStudio, saving: action.saving, error: action.error === undefined ? state.workflowStudio.error : action.error } };
    case "workflowStudioSaved":
      return { ...state, workflowStudio: { ...state.workflowStudio, baseline: action.document, draft: action.document, version: action.version ?? state.workflowStudio.version, dirty: false, saving: false, error: null } };
    case "reviewRoomOpen": {
      const next = closeTransientOverlays(state);
      const evidence = next.reviewRoom.evidenceByTask[action.taskId];
      const first = evidence?.provenance.flatMap((p) => p.diff.available ? p.diff.patches : [])[0];
      return { ...next, reviewRoom: { ...next.reviewRoom, openTaskId: action.taskId, error: null, sessionError: null, selectedPath: first?.path ?? next.reviewRoom.selectedPath, selectedHunkId: first?.hunks[0]?.id ?? next.reviewRoom.selectedHunkId } };
    }
    case "reviewRoomClose": return { ...state, reviewRoom: { ...state.reviewRoom, openTaskId: null, loading: false, error: null, sessionError: null } };
    case "reviewRoomLoading": return state.reviewRoom.openTaskId === action.taskId ? { ...state, reviewRoom: { ...state.reviewRoom, loading: true, error: null, sessionError: null } } : state;
    case "reviewRoomLoaded": {
      if (state.reviewRoom.openTaskId !== action.taskId) return state;
      const patches = action.evidence.provenance.flatMap((p) => p.diff.available ? p.diff.patches : []);
      const selected = patches.find((p) => p.path === state.reviewRoom.selectedPath) ?? patches[0] ?? null;
      const hunk = selected?.hunks.find((h) => h.id === state.reviewRoom.selectedHunkId) ?? selected?.hunks[0] ?? null;
      // review.get may have failed (older daemon, unknown method) while evidence.get
      // succeeded — action.session is null in that case; don't fake a session into
      // sessionsByTask, just surface action.sessionError for the rail.
      const sessionsByTask = action.session
        ? { ...state.reviewRoom.sessionsByTask, [action.taskId]: action.session }
        : state.reviewRoom.sessionsByTask;
      return { ...state, reviewRoom: { ...state.reviewRoom, loading: false, error: null, evidenceByTask: { ...state.reviewRoom.evidenceByTask, [action.taskId]: action.evidence }, sessionsByTask, sessionError: action.sessionError ?? null, selectedPath: selected?.path ?? null, selectedHunkId: hunk?.id ?? null } };
    }
    case "reviewRoomFailed": return state.reviewRoom.openTaskId === action.taskId ? { ...state, reviewRoom: { ...state.reviewRoom, loading: false, error: action.error, sessionError: null } } : state;
    case "reviewRoomEvidenceRefreshed": {
      if (state.reviewRoom.openTaskId !== action.taskId) return state;
      const patches = action.evidence.provenance.flatMap((p) => p.diff.available ? p.diff.patches : []);
      const selected = patches.find((p) => p.path === state.reviewRoom.selectedPath) ?? patches[0] ?? null;
      const hunk = selected?.hunks.find((h) => h.id === state.reviewRoom.selectedHunkId) ?? selected?.hunks[0] ?? null;
      return { ...state, reviewRoom: { ...state.reviewRoom, evidenceByTask: { ...state.reviewRoom.evidenceByTask, [action.taskId]: action.evidence }, selectedPath: selected?.path ?? null, selectedHunkId: hunk?.id ?? null } };
    }
    case "reviewRoomSession": {
      const prior = state.reviewRoom.sessionsByTask[action.session.taskId];
      if (prior && prior.revision > action.session.revision) return state;
      return { ...state, reviewRoom: { ...state.reviewRoom, sessionsByTask: { ...state.reviewRoom.sessionsByTask, [action.session.taskId]: action.session } } };
    }
    case "reviewRoomSelect": return { ...state, reviewRoom: { ...state.reviewRoom, selectedPath: action.path === undefined ? state.reviewRoom.selectedPath : action.path, selectedHunkId: action.hunkId === undefined ? state.reviewRoom.selectedHunkId : action.hunkId, selectedFindingId: action.findingId === undefined ? state.reviewRoom.selectedFindingId : action.findingId } };
    case "reviewRoomFocus": return { ...state, reviewRoom: { ...state.reviewRoom, focus: action.focus } };
    case "selectTab": {
      // W7 (coverage B1 row 3): landing on the events tab marks everything seen.
      const next = closeTransientOverlays(state);
      return { ...next, activeTab: action.tab, unseen: action.tab === "events" ? UNSEEN_ZERO : state.unseen };
    }
    case "navigate": {
      const next = closeTransientOverlays(state);
      const requestId = state.navigation.requestId + 1;
      const target: DeepLink = action.target;
      let activeTab = state.activeTab;
      let selectedAgentId = state.selectedAgentId;
      let teamCursor = state.teamCursor;
      let queueCursor = state.queueCursor;
      let taskCursor = state.taskCursor;
      if (target.kind === "tab") activeTab = target.tab;
      else if (target.kind === "agent") { activeTab = "agents"; selectedAgentId = target.agentId; }
      else if (target.kind === "project") activeTab = "projects";
      else if (target.kind === "team") {
        activeTab = "teams";
        const i = state.teams.items.findIndex((x) => x["name"] === target.name);
        if (i >= 0) teamCursor = i;
      } else if (target.kind === "queue") {
        activeTab = "queues";
        const i = state.queues.items.findIndex((x) => x["name"] === target.name);
        if (i >= 0) queueCursor = i;
      } else if (target.kind === "task") {
        activeTab = "queues";
        const queue = target.queue ?? state.tasks[target.taskId]?.queue;
        const qi = queue ? state.queues.items.findIndex((x) => x["name"] === queue) : -1;
        if (qi >= 0) queueCursor = qi;
        const ti = state.queueDetail?.tasks.findIndex((x) => x["taskId"] === target.taskId) ?? -1;
        if (ti >= 0) taskCursor = ti;
      } else if (target.kind === "event") activeTab = "events";
      else if (target.kind === "memory") activeTab = "memory";
      else if (target.kind === "artifact") activeTab = target.agentId ? "agents" : "queues";
      else if (target.kind === "workflow") activeTab = "queues";
      else if (target.kind === "settings" || target.kind === "mcpTool") activeTab = "settings";
      return {
        ...next, activeTab, selectedAgentId, teamCursor, queueCursor, taskCursor,
        unseen: activeTab === "events" ? UNSEEN_ZERO : state.unseen,
        navigation: { requestId, target },
      };
    }
    case "navigationConsumed":
      return action.requestId === state.navigation.requestId
        ? { ...state, navigation: { ...state.navigation, target: null } }
        : state;
    case "tabNext":
    case "tabPrev": {
      const i = TAB_ORDER.indexOf(state.activeTab);
      const d = action.type === "tabNext" ? 1 : -1;
      const tab = TAB_ORDER[(i + d + TAB_ORDER.length) % TAB_ORDER.length]!;
      // W7: same landed-on-events reset as selectTab — any path onto the tab counts.
      const next = closeTransientOverlays(state);
      return { ...next, activeTab: tab, unseen: tab === "events" ? UNSEEN_ZERO : state.unseen };
    }
    case "selectDelta": {
      // COLLAPSIBLE SUB-AGENTS: step over the VISIBLE (fold-aware) order, not the
      // raw agentOrder -- else ↑/↓ (and the wheel, which dispatches this too) would
      // walk the selection into a folded-away descendant and the pill would vanish
      // into a hidden row. For a flat/unfolded list visibleAgentOrder === agentOrder,
      // so historical behavior is unchanged.
      const visible = visibleAgentOrder(state);
      if (visible.length === 0) return state;
      const cur = state.selectedAgentId ? Math.max(0, visible.indexOf(state.selectedAgentId)) : 0;
      const next = Math.min(visible.length - 1, Math.max(0, cur + action.delta));
      return { ...state, selectedAgentId: visible[next]! };
    }
    case "setMode": {
      if (action.mode === "normal") return closeTransientOverlays(state);
      const next = closeTransientOverlays(state);
      return {
        ...next,
        mode: action.mode,
        // These targets are seeded immediately before setMode by the form
        // openers; preserve only the target owned by the newly-opened form.
        pushQueue: action.mode === "pushForm" ? state.pushQueue : null,
        editTask: action.mode === "editForm" ? state.editTask : null,
        confirm: action.mode === "confirm" ? state.confirm : null,
      };
    }
    case "permissionAnswered":
      return { ...state, pendingPermissions: state.pendingPermissions.filter((p) => p.requestId !== action.requestId) };
    case "questionAnswered": {
      const prev = state.agents[action.agentId];
      if (!prev || prev.pendingQuestion?.questionId !== action.questionId) return state;
      return {
        ...state,
        agents: { ...state.agents, [action.agentId]: { ...prev, pendingQuestion: null } },
      };
    }
    // Native-CLI-parity Phase 2 (Task DLG3): unlike questionAnswered, this action
    // carries no agentId (store.answerDialog doesn't look one up) -- find whichever
    // agent's pendingDialog matches action.dialogId (mirrors firstPendingDialog's
    // own agentOrder scan) and clear just that one. A no-op if no agent's
    // pendingDialog matches (e.g. it was already cleared by a race with a
    // dialogResolved status event).
    case "dialogAnswered": {
      for (const id of state.agentOrder) {
        const prev = state.agents[id];
        if (prev?.pendingDialog?.dialogId === action.dialogId) {
          return { ...state, agents: { ...state.agents, [id]: { ...prev, pendingDialog: null } } };
        }
      }
      return state;
    }
    case "commandError":
      return { ...state, lastError: action.message };
    case "agentLeaseHeld": {
      const prev = state.agents[action.agentId];
      if (!prev) return state;
      return { ...state, agents: { ...state.agents, [action.agentId]: { ...prev, worktreeLeaseHeld: action.held } } };
    }
    // F22.UI — see the action's doc comment. No-op for an unknown agent (a row that has since
    // vanished), never materializing a phantom AgentView.
    case "agentSystemLine": {
      const prev = state.agents[action.agentId];
      if (!prev) return state;
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.agentId]: evictTranscriptFront({ ...prev, transcript: [...prev.transcript, { role: "system" as const, text: action.text }] }),
        },
      };
    }
    case "notice":                                          // TUI-042: independent of lastError
      return { ...state, notice: action.message };
    case "mainConductorId":
      return { ...state, mainConductorId: action.agentId };
    case "permissionMode":
      return { ...state, permissionMode: action.mode };
    // AGENT-MARK: the batch set. Marks of agents that have since vanished are dropped on read
    // (selectors), not here — a record can reappear across a reconnect snapshot, and pruning
    // eagerly would silently unmark rows the operator ticked moments earlier.
    case "toggleAgentMark": {
      const marked = state.markedAgentIds.includes(action.agentId)
        ? state.markedAgentIds.filter((id) => id !== action.agentId)
        : [...state.markedAgentIds, action.agentId];
      return { ...state, markedAgentIds: marked };
    }
    case "clearAgentMarks":
      if (state.markedAgentIds.length === 0) return state;   // no-op dispatch stays a no-op
      return { ...state, markedAgentIds: [] };
    case "selectAgent":
      // NO-OP-DISPATCH-IS-A-NO-OP: selecting what is already selected must not produce a new state
      // object. It did, and every subscriber saw a fresh snapshot for a change that never
      // happened — which is what let AgentList's selection-clamp effect spin: it re-dispatched the
      // same fallback id, the store handed back a new state, the effect re-ran on it, and round it
      // went. Reported as the UI looping when a paste landed in the search box.
      if (state.selectedAgentId === action.agentId) return state;
      return { ...state, selectedAgentId: action.agentId };
    // COLLAPSIBLE SUB-AGENTS: a pure same-target toggle of a node's fold. When
    // FOLDING (the id wasn't collapsed), if the current selection is about to be
    // hidden, keep the pill on a still-visible row -- else it strands on a row the
    // pane no longer draws (reducer.ts's visibleAgentOrder note). Two hide paths:
    //   * a per-agent SUBTREE fold -> lift the selection up to the toggled node
    //     (still visible, renders the ▸ affordance);
    //   * a T4 TEAM fold (`team:<name>` pseudo-id, action.agentId isn't a real
    //     agent so isSubtreeDescendant's order.indexOf never matches) -> the header
    //     isn't selectable, so snap to the nearest still-visible agent.
    // The team case is detected generically against the fold-aware visibleAgentOrder
    // of the POST-fold state, so it also covers any other future fold that hides the
    // selection without an ancestor to climb to. Expanding never hides anything, so
    // it leaves the selection alone.
    case "collapse": {
      const collapsed = new Set(state.collapsed);
      if (collapsed.has(action.agentId)) {
        collapsed.delete(action.agentId);
        return { ...state, collapsed };
      }
      collapsed.add(action.agentId);
      const next: UiState = { ...state, collapsed };
      const sel = state.selectedAgentId;
      if (!sel) return next;
      if (isSubtreeDescendant(state, action.agentId, sel)) return { ...next, selectedAgentId: action.agentId };
      const visible = visibleAgentOrder(next);
      if (visible.includes(sel)) return next;
      return { ...next, selectedAgentId: nearestVisible(state.agentOrder, visible, sel) };
    }
    // COVERAGE: list-cursor moves, each clamped against its own list length.
    case "teamCursor":
      return { ...state, teamCursor: clampCursor(state.teamCursor, action.delta, state.teams.items.length) };
    case "queueCursor":
      return { ...state, queueCursor: clampCursor(state.queueCursor, action.delta, state.queues.items.length) };
    // ROLES-TAB S5: the master list mixes session roles + team roles (a join
    // the reducer doesn't compute), so unlike teamCursor/queueCursor this only
    // floors at 0 -- the screen re-clamps against its own rendered row count
    // (same "clamp on render" pattern TeamsScreen uses for its search filter).
    case "roleCursor":
      return { ...state, roleCursor: Math.max(0, state.roleCursor + action.delta) };
    // MEMORY TAB: swap the record list (a fresh memory.search reply) and clamp the
    // cursor against the NEW length so a shorter result set can't strand it past the
    // last row; set the live search query; or move the cursor (clamped like the
    // teams/queues cursors above).
    case "memory": {
      const cursor = Math.max(0, Math.min(state.memoryCursor, action.items.length - 1));
      // MEM-8: a fresh search reply closes any open detail — its adjacency belonged to the
      // previous result set and would be stale against the new list.
      return { ...state, memory: { ...state.memory, items: action.items }, memoryCursor: cursor, memoryDetail: null, memoryDetailCursor: 0 };
    }
    case "memoryQuery":
      // MEM-8: editing the query closes the detail region (you're back to browsing).
      return { ...state, memory: { ...state.memory, query: action.query }, memoryDetail: null, memoryDetailCursor: 0 };
    case "memoryCursor":
      return { ...state, memoryCursor: clampCursor(state.memoryCursor, action.delta, state.memory.items.length) };
    // MEM-8: open/close the bottom detail region (memory.get reply); the jump cursor resets
    // to the first target each time. `null` closes it.
    case "memoryDetail":
      return { ...state, memoryDetail: action.detail, memoryDetailCursor: 0 };
    case "memoryDetailCursor":
      return { ...state, memoryDetailCursor: clampCursor(state.memoryDetailCursor, action.delta, memoryJumpTargets(state.memoryDetail).length) };
    case "memoryCursorSet":
      return { ...state, memoryCursor: Math.max(0, Math.min(action.index, state.memory.items.length - 1)) };
    // MEM-5: the search mode + folder selection are pure filter state — set them
    // and let the screen re-issue memory.search with the new params (the reply's
    // "memory" action then swaps + re-clamps the list, exactly like a query edit).
    case "memoryMode":
      return { ...state, memory: { ...state.memory, mode: action.mode } };
    case "memoryFolder":
      return { ...state, memory: { ...state.memory, folder: action.folder } };
    // F34.UI: same pure-filter contract for the scope axis (the screen re-issues
    // memory.search + re-applies its post-filter), plus the stats payload the
    // scope summary line reads.
    case "memoryScope":
      return { ...state, memory: { ...state.memory, scope: action.scope } };
    case "memoryStats":
      return { ...state, memoryStats: action.stats };
    case "taskCursor":
      return { ...state, taskCursor: clampCursor(state.taskCursor, action.delta, state.queueDetail?.tasks.length ?? 0) };
    // COVERAGE (team.status): opening a drill resets the (unused-for-teams) task
    // cursor is unnecessary; just swap the payload. Closing sets it null.
    case "teamDetail":
      return { ...state, teamDetail: action.detail };
    // COVERAGE (queue.status): opening a drill resets taskCursor to the top so a
    // stale index from a previously-opened, longer queue can't point past the end.
    case "queueDetail":
      return { ...state, queueDetail: action.detail, taskCursor: 0 };
    case "pushQueue":
      return { ...state, pushQueue: action.queue };
    // TASK-EDIT-VERSIONING: set/clear the edit-form target (mirrors pushQueue).
    case "editTask":
      return { ...state, editTask: action.target };
    // TASK-EDIT-VERSIONING: toggle the read-only version-history overlay.
    case "versionsOpen": {
      const next = action.open ? closeTransientOverlays(state) : state;
      return { ...next, versionsOpen: action.open };
    }
    // TASK-DETAIL: toggle the read-only result/dependsOn overlay.
    case "taskDetailOpen": {
      const next = action.open ? closeTransientOverlays(state) : state;
      return { ...next, taskDetailOpen: action.open };
    }
    case "accountsOpen": {
      const next = action.open ? closeTransientOverlays(state) : state;
      return { ...next, accountsOpen: action.open };
    }
    case "accountList":
      return { ...state, accountList: action.items };
    // F47.UI: the attention-only fleet filter (TUI `u`). Toggling it can hide the selected row,
    // so the selection snaps to the nearest still-visible agent — the same rule a team fold uses.
    case "agentsUnseenOnly": {
      const next = { ...state, unseenOnly: action.only };
      const sel = next.selectedAgentId;
      if (!sel) return next;
      const visible = visibleAgentOrder(next);
      if (visible.includes(sel)) return next;
      return { ...next, selectedAgentId: nearestVisible(next.agentOrder, visible, sel) };
    }
    // F08.UI: the needs-operator fleet filter (TUI `x`) — same selection-snap rule as the
    // attention filter above, for the same reason.
    case "agentsNeedsOperatorOnly": {
      const next = { ...state, needsOperatorOnly: action.only };
      const sel = next.selectedAgentId;
      if (!sel) return next;
      const visible = visibleAgentOrder(next);
      if (visible.includes(sel)) return next;
      return { ...next, selectedAgentId: nearestVisible(next.agentOrder, visible, sel) };
    }
    case "helpOpen": {
      const next = action.open ? closeTransientOverlays(state) : state;
      return { ...next, helpOpen: action.open };
    }
    case "a2aHistoryOpen": {
      const next = action.open ? closeTransientOverlays(state) : state;
      return { ...next, a2aHistoryOpen: action.open };
    }
    // PARITY WS-C: toggling the palette open OR closed resets the fuzzy query so
    // it always starts empty (the whole catalog shown) -- mirrors how a fresh
    // slash popup starts unfiltered. The highlighted-row cursor is App-local.
    case "paletteOpen": {
      const next = action.open ? closeTransientOverlays(state) : state;
      return { ...next, paletteOpen: action.open, paletteQuery: "" };
    }
    case "paletteQuery":
      return { ...state, paletteQuery: action.query };
    // PARITY WS-F: the MCP tool palette is a self-owned modal -- the reducer only
    // tracks whether it is open; its list-filter/form state is component-local.
    case "mcpPaletteOpen": {
      const next = action.open ? closeTransientOverlays(state) : state;
      return { ...next, mcpPaletteOpen: action.open };
    }
    case "resultOpen": {
      const next = action.open ? closeTransientOverlays(state) : state;
      return { ...next, resultOpen: action.open };
    }
    case "confirm": {
      const next = action.confirm ? closeTransientOverlays(state) : state;
      return { ...next, confirm: action.confirm };
    }
    // COVERAGE (agent.status + agent.result): stash the fetched detail on the agent
    // view. Upserts (emptyAgent fallback) so a result fetched for an id the event
    // stream hasn't seeded yet is never dropped.
    case "agentResult": {
      const prev = state.agents[action.agentId] ?? emptyAgent(action.agentId);
      return { ...state, agents: { ...state.agents, [action.agentId]: { ...prev, resultDetail: action.detail } } };
    }
    // HOOK-7: fold a `sub.list` reply onto ONE agent's view (store.loadSubscriptions,
    // fired on select + refreshed on poll for the selected agent). Off the hot event
    // path — latest-wins replace, exactly like agentResult above.
    case "subscriptions": {
      const prev = state.agents[action.agentId] ?? emptyAgent(action.agentId);
      return { ...state, agents: { ...state.agents, [action.agentId]: { ...prev, subscriptions: action.subscriptions } } };
    }
    // FEATURE 1 (startup history backfill): fold a per-agent agent.tail reply
    // into ONE agent's view. The historical events carry LOW seqs (already below
    // the live watermark), so replaying them through the normal "event" action
    // would drop every one via projectEvent's `e.seq <= state.lastSeq` dedupe —
    // the exact reason a fresh TUI can't see a long-finished agent's transcript.
    // Instead we replay the events into a SCRATCH state (lastSeq 0, so nothing is
    // deduped), reusing projectEvent verbatim so the rebuilt transcript/tools/
    // cost/usage are byte-identical to the live path, then graft only that one
    // agent's derived fields onto the real state — never touching the global
    // events ring, lastSeq, selection, or pendingPermissions.
    case "backfillHistory": {
      const prev = state.agents[action.agentId] ?? emptyAgent(action.agentId);
      // Idempotent, and never clobber an agent that already has live transcript
      // content (a running agent the user has been chatting with) — a tui-origin
      // user echo isn't in the persisted event log, so a rebuild would silently
      // drop it. Only the empty case (a done-before-start agent) is rebuilt.
      if (prev.historyLoaded || prev.transcript.length > 0) {
        return { ...state, agents: { ...state.agents, [action.agentId]: { ...prev, historyLoaded: true, historyLoadState: "loaded", historyLoadError: undefined } } };
      }
      let scratch: UiState = initialState;
      for (const e of action.events) scratch = projectEvent(scratch, e, action.stampTs === true);   // WD Stage 1 (B4)
      const built = scratch.agents[action.agentId];
      const terminal = prev.state !== "running";
      const merged: AgentView = {
        ...prev,
        transcript: built?.transcript ?? prev.transcript,
        tools: built?.tools ?? prev.tools,
        // agent.list (agentRecords) is authoritative for cost/state — keep those;
        // only adopt the event-derived cost when the record hadn't reported one.
        costUsd: prev.costUsd || built?.costUsd || 0,
        usage: built?.usage ?? prev.usage,
        usageMeasuredAt: built?.usageMeasuredAt ?? prev.usageMeasuredAt,
        // A live telemetry sample can arrive before the first transcript page.
        sessionUsage: prev.sessionUsage ?? built?.sessionUsage,
        ctxUsage: prev.ctxUsage !== undefined ? prev.ctxUsage : built?.ctxUsage,
        model: prev.model ?? built?.model,
        effort: prev.effort ?? built?.effort,
        lastEventTs: built?.lastEventTs ?? prev.lastEventTs,
        // A terminal agent must not resurface a stale question banner from its
        // history (a questionResolved event mid-history is already folded into
        // `built` by the scratch replay above, but a still-open question at the
        // end of a now-terminal agent's history was never resolved at all). A
        // non-terminal agent keeps whichever question is live (prefer the
        // history-derived one, else whatever was already pending) — never nulled.
        pendingQuestion: terminal ? null : built?.pendingQuestion ?? prev.pendingQuestion,
        historyLoaded: true,
        historyLoadState: "loaded",
        historyLoadError: undefined,
        // TRANSCRIPT-TAIL-FIRST: this batch is the NEWEST page (history.ts fetches
        // it first) — its lowest seq is the baseline prependHistory dedupes older
        // pages against. Absent events ⇒ nothing to anchor yet, stays null.
        historyMinSeq: action.events.length > 0 ? Math.min(...action.events.map((e) => e.seq)) : prev.historyMinSeq,
      };
      return { ...state, agents: { ...state.agents, [action.agentId]: merged } };
    }
    // TRANSCRIPT-LOADING-STATE: the fetch lifecycle either side of backfillHistory
    // above — see historyLoadState's own doc comment in types.ts for the four
    // states and why historyLoaded alone couldn't tell them apart.
    case "historyLoadStarted": {
      const prev = state.agents[action.agentId] ?? emptyAgent(action.agentId);
      return { ...state, agents: { ...state.agents, [action.agentId]: { ...prev, historyLoadState: "loading" } } };
    }
    case "historyLoadFailed": {
      const prev = state.agents[action.agentId] ?? emptyAgent(action.agentId);
      return { ...state, agents: { ...state.agents, [action.agentId]: { ...prev, historyLoadState: "failed", historyLoadError: action.message } } };
    }
    // TRANSCRIPT-TAIL-FIRST: fold one OLDER page (history.ts's background
    // backward walk, fired AFTER the newest page has already painted via
    // backfillHistory above) onto the FRONT of the transcript. Deliberately
    // narrow versus backfillHistory:
    //  - TRANSCRIPT ROWS ONLY. Every other derived field (state/costUsd/usage/
    //    model/effort/pendingQuestion/tools/...) is left exactly as `prev` had
    //    it — an older batch must never roll a live agent's current state
    //    backwards (e.g. a `done` agent flipping back to `running` because an
    //    old `agent_started` got replayed last). backfillHistory's own guard
    //    and full-rebuild semantics are untouched; this is a separate action
    //    for a separate case (prepending to an agent that already has content),
    //    not a variant of it.
    //  - IDEMPOTENT / ORDERING-SAFE: `historyMinSeq` (set by backfillHistory's
    //    newest page, advanced here after every older page) is the low-water
    //    mark of what's already folded in. Only events strictly below it are
    //    folded — a retried or duplicate page re-delivery is a no-op, and a
    //    partially-overlapping page only contributes its genuinely-new tail.
    //  - Replayed into its OWN scratch state (like backfillHistory) so the
    //    batch's rows are byte-identical to the live projection, then prepended
    //    ahead of whatever transcript already existed.
    case "prependHistory": {
      const prev = state.agents[action.agentId] ?? emptyAgent(action.agentId);
      const fresh = prev.historyMinSeq === null
        ? action.events
        : action.events.filter((e) => e.seq < prev.historyMinSeq!);
      if (fresh.length === 0) return state;
      const sorted = [...fresh].sort((a, b) => a.seq - b.seq);
      let scratch: UiState = initialState;
      for (const e of sorted) scratch = projectEvent(scratch, e, action.stampTs === true);
      const rows = scratch.agents[action.agentId]?.transcript ?? [];
      const minSeq = Math.min(prev.historyMinSeq ?? Infinity, sorted[0]!.seq);
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.agentId]: {
            ...prev,
            transcript: rows.length > 0 ? [...rows, ...prev.transcript] : prev.transcript,
            historyMinSeq: minSeq,
          },
        },
      };
    }
    // TRANSCRIPT-TAIL-FIRST: the background older-page walk's own fetch
    // lifecycle — sibling to historyLoadStarted/historyLoadFailed above but
    // for historyOlderLoadState (see its doc comment in types.ts). Fired by
    // history.ts's walk, never by backfillHistory/prependHistory themselves.
    case "historyOlderLoadStarted": {
      const prev = state.agents[action.agentId] ?? emptyAgent(action.agentId);
      return { ...state, agents: { ...state.agents, [action.agentId]: { ...prev, historyOlderLoadState: "loading" } } };
    }
    case "historyOlderLoadFailed": {
      const prev = state.agents[action.agentId] ?? emptyAgent(action.agentId);
      return { ...state, agents: { ...state.agents, [action.agentId]: { ...prev, historyOlderLoadState: "failed", historyOlderLoadError: action.message } } };
    }
    case "historyOlderLoadFinished": {
      const prev = state.agents[action.agentId] ?? emptyAgent(action.agentId);
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.agentId]: {
            ...prev,
            historyOlderLoadState: "loaded",
            historyOlderLoadError: undefined,
            // TRANSCRIPT-WINDOWING: sticky once true — a later page can never un-exhaust it.
            historyOlderExhausted: prev.historyOlderExhausted || action.exhausted,
          },
        },
      };
    }
    // TRANSCRIPT-EVICT-OLD: sync the operator's at-bottom pin (see AgentView's
    // doc comment). Becoming true is also the ONLY other trigger (besides a
    // live "event" dispatch) that can evict — an agent that piled up rows
    // while the operator was scrolled up must catch up the instant they
    // return to the tail, not wait for the next live event to arrive.
    case "transcriptAtBottom": {
      const prev = state.agents[action.agentId] ?? emptyAgent(action.agentId);
      if (prev.atBottom === action.atBottom) return state;
      const next = evictTranscriptFront({ ...prev, atBottom: action.atBottom });
      return { ...state, agents: { ...state.agents, [action.agentId]: next } };
    }
    case "userSent": {
      // FIX-B3 tolerant upsert (TUI-022 follow-up): sendToMain's lazy-spawn branch
      // dispatches this for a conductor id that may not be in state.agents yet (the
      // daemon's agent.list hasn't caught up). Mirror the "agentRecords" case's own
      // emptyAgent() fallback instead of silently dropping the echo. The upserted
      // placeholder is seeded with state "running" (NOT emptyAgent's default
      // "unknown") on purpose: sendToMain's own noLongerRunning check and store.ts's
      // cyclePermissionMode (FC-1) both key off `agents[id]?.state === "running"` to
      // decide "presumed still alive" for an id with no daemon-confirmed record yet.
      // Seeding "unknown" here would flip both to "no longer running" the moment this
      // dispatches -- reintroducing a double-spawn race and a permission-chip flicker.
      const prev = state.agents[action.agentId] ?? { ...emptyAgent(action.agentId), state: "running" };
      return {
        ...state,
        agents: {
          ...state.agents,
          // Task T1: a message the user just sent puts the target agent into the
          // working state (F1's outbox holds the NEXT message on this) -- applies
          // both to an existing agent and to the emptyAgent() upsert fallback above.
          // IMAGE.SHOW: attach any image(s) that rode along so they persist on the
          // turn (empty/omitted arrays are normalized away, keeping a plain text
          // turn byte-identical to before this feature).
          [action.agentId]: {
            ...prev,
            transcript: [
              ...prev.transcript,
              {
                role: "user", text: action.text,
                ...(action.images && action.images.length > 0 ? { images: action.images } : {}),
                ...(action.content && action.content.length > 0 ? { content: action.content } : {}),
                ...(action.forced ? { forced: true } : {}),
              },
            ],
            busy: true,
          },
        },
      };
    }
    // Task T2 (F1 outbox): plain FIFO append/filter, keyed by the item's own id.
    case "outboxAdd":
      return { ...state, outbox: [...state.outbox, action.item] };
    case "outboxRemove":
      return { ...state, outbox: state.outbox.filter((o) => o.id !== action.id) };
    // IN-APP-TERMINAL Task 4 / TERMINAL-DOCK-PER-AGENT: open a tab and make it active AND
    // visible immediately, but only within its OWNING agent's slice -- a tab with
    // agentId:null is deliberately left out of both maps (see TerminalState's doc comment),
    // so it's added to `tabs` (kept mounted) but unreachable via any agent's dock.
    case "terminalOpened": {
      const agentId = action.tab.agentId;
      return {
        ...state,
        terminals: {
          ...state.terminals,
          tabs: [...state.terminals.tabs, action.tab],
          activeByAgent: agentId === null ? state.terminals.activeByAgent : { ...state.terminals.activeByAgent, [agentId]: action.tab.id },
          openByAgent: agentId === null ? state.terminals.openByAgent : { ...state.terminals.openByAgent, [agentId]: true },
        },
      };
    }
    // IN-APP-TERMINAL Task 4: remove the tab and hand activation to the nearest
    // neighbour (previous, else next, else null) so closing a middle tab never
    // strands the dock with no active pane.
    case "terminalClosed":
      return { ...state, terminals: closeTerminalTab(state.terminals, action.id) };
    // TERMINAL-DOCK-PER-AGENT: derive the owning agent from the tab itself rather than taking
    // one on the action -- the dock only ever activates a tab it's already showing, so the
    // agent is implied. A null-agentId (unreachable) tab is a no-op.
    case "terminalActivated": {
      const tab = state.terminals.tabs.find((t) => t.id === action.id);
      if (!tab || tab.agentId === null) return state;
      return {
        ...state,
        terminals: { ...state.terminals, activeByAgent: { ...state.terminals.activeByAgent, [tab.agentId]: action.id } },
      };
    }
    // TERMINAL-NAMES: tabs are how both the operator AND an agent address a terminal (terminal_read
    // / terminal_write take a name), so a name is not decoration — it is the handle. Trimmed, and
    // an empty rename is ignored rather than producing an unaddressable tab.
    case "terminalRenamed": {
      const title = action.title.trim();
      if (!title) return state;
      return {
        ...state,
        terminals: {
          ...state.terminals,
          tabs: state.terminals.tabs.map((t) => (t.id === action.id ? { ...t, title } : t)),
        },
      };
    }
    // IN-APP-TERMINAL Task 4: a clean (code 0) exit behaves like a close -- the
    // operator has nothing to inspect. A non-zero exit KEEPS the tab and records
    // the code so the failure stays visible instead of vanishing with the pane.
    case "terminalExited":
      if (action.code === 0) return { ...state, terminals: closeTerminalTab(state.terminals, action.id) };
      return {
        ...state,
        terminals: {
          ...state.terminals,
          tabs: state.terminals.tabs.map((t) => (t.id === action.id ? { ...t, exited: { code: action.code } } : t)),
        },
      };
    // TERMINAL-DOCK-PER-AGENT: dockOpen is now per-agent -- toggling agent A's dock never
    // touches agent B's.
    case "terminalDockToggled":
      return {
        ...state,
        terminals: {
          ...state.terminals,
          openByAgent: { ...state.terminals.openByAgent, [action.agentId]: !state.terminals.openByAgent[action.agentId] },
        },
      };
    case "terminalDockResized":
      return { ...state, terminals: { ...state.terminals, dockHeight: Math.max(120, Math.min(1200, action.height)) } };
  }
}

// IN-APP-TERMINAL Task 4 / TERMINAL-DOCK-PER-AGENT: shared close-and-reactivate logic for
// both an explicit terminalClosed and a clean (code 0) terminalExited. The neighbour search is
// scoped to the closed tab's OWN agent's tabs -- picking a global neighbour would hand
// activation to a different agent's tab. A null-agentId (unreachable) tab has nothing to
// update beyond removal from `tabs`.
function closeTerminalTab(terminals: UiState["terminals"], id: string): UiState["terminals"] {
  const idx = terminals.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return terminals;
  const agentId = terminals.tabs[idx]!.agentId;
  const tabs = terminals.tabs.filter((t) => t.id !== id);
  if (agentId === null) return { ...terminals, tabs };

  const siblings = terminals.tabs.filter((t) => t.agentId === agentId);
  const siblingIdx = siblings.findIndex((t) => t.id === id);
  const activeByAgent = { ...terminals.activeByAgent };
  if (activeByAgent[agentId] === id) {
    activeByAgent[agentId] = siblings[siblingIdx - 1]?.id ?? siblings[siblingIdx + 1]?.id ?? null;
  }
  const openByAgent = tabs.some((t) => t.agentId === agentId)
    ? terminals.openByAgent
    : { ...terminals.openByAgent, [agentId]: false };
  return { ...terminals, tabs, activeByAgent, openByAgent };
}

/** Rebuild a historical UI from persisted events only. Current snapshots,
 * optimistic user echoes and live mutations are intentionally not inputs. */
export function projectHistoricalEvents(events: readonly NormalizedEvent[], cutoffSeq: number): UiState {
  const ordered = [...events]
    .filter((event) => event.seq <= cutoffSeq)
    .sort((a, b) => a.seq - b.seq || a.engineId.localeCompare(b.engineId));
  let state: UiState = initialState;
  const seen = new Set<string>();
  for (const event of ordered) {
    const key = `${event.engineId}:${event.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    state = projectEvent(state, event, true);
  }
  return state;
}
