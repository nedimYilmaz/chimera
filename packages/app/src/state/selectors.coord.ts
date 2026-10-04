// W5 — PURE selectors/formatters for the coordination screens (teams/queues/
// events/memory). Same discipline as selectors.ts: plain functions over the
// loosely-typed team.list / queue.status / memory.search payloads (read
// defensively — daemon-side field drift must never crash a pane), no React,
// no store import, fully unit-testable. Data contracts: design/coverage.html
// §B8-B10; visual values: the mock's s_teams/s_queues/s_events/s_memory blocks.
import type { NormalizedEvent } from "@chimera/protocol";
import type { MemoryHit, MemoryScopeSel } from "@chimera/ui-state";
import { memoryEventLine, scopeSearchParam } from "@chimera/ui-state";
// ROLES-BINDING-CORRECTNESS: roleConfig/overridesOf/resolvedRoleBindingSpec/overriddenFieldsOf
// now live in @chimera/ui-state (shared with the TUI's coord.ts) — imported (this file's own
// teamFormValuesFromSpec below needs overridesOf) AND re-exported so every existing import
// site (this file's other callers, tests) is unaffected.
import { roleConfig, overridesOf, resolvedRoleBindingSpec, overriddenFieldsOf, type RoleConfig } from "@chimera/ui-state";
export { roleConfig, type RoleConfig, overridesOf, resolvedRoleBindingSpec, overriddenFieldsOf };

// ---------------------------------------------------------------------------
// shared small helpers
// ---------------------------------------------------------------------------

/** Coordination-screen tone vocabulary → the CSS token each maps to is fixed
 * by coverage B9/B10 (pending:warn, blocked:muted, in_progress:accent,
 * done:success, failed:danger; events: permission_request:human, error:danger,
 * result:info). */
export type CoordTone = "warn" | "muted" | "accent" | "success" | "danger" | "info" | "human";

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Hard cap a one-line summary/prompt cell (the CSS ellipsis handles overflow
 * visually; this cap bounds what we even hand the DOM — coverage B10: "özet 60
 * char'ı aşmaz"). */
export function ellipsize(s: string, max = 60): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  return nl === -1 ? s : s.slice(0, nl);
}

/** Newest-first DISPLAY order for a coord master list (Teams/Queues panels) —
 * reorders the VIEW only. team.list/queue.list items carry no creation
 * timestamp, and both stores append in creation order (TeamManager/QueueStore
 * hold plain insertion-ordered Maps), so "newest on top" is a reverse of the
 * array the daemon hands back. Screens must derive EVERY cursor-indexed lookup
 * (selection, edit/dissolve/delete targets) off this SAME reordering — not
 * just the rendered rows — so ↑↓ tracks what's on screen. Underlying
 * teams.items/queues.items (and therefore drain/priority scheduling, which
 * never reads through this) are untouched. */
export function newestFirst<T>(items: ReadonlyArray<T>): T[] {
  return items.slice().reverse();
}

/** Newest-first DISPLAY order for a queue drill's task list. Unlike team/queue
 * specs, a TaskRecord DOES carry a creation timestamp — sort by pushedAt,
 * falling back to createdAt for older records (the same reader rule
 * TaskInspector already applies, packages/app/src/components/TaskInspector.tsx).
 * View-only, same contract as newestFirst above: scheduler drain order (task
 * priority DESC + FIFO) reads the raw queue.status list, never this. */
export function newestFirstTasks(tasks: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tasks
    .map((t, i) => ({
      t,
      i,
      ts: typeof t["pushedAt"] === "number" ? (t["pushedAt"] as number) : num(t["createdAt"]),
    }))
    .sort((a, b) => b.ts - a.ts || b.i - a.i)
    .map((x) => x.t);
}

// ---------------------------------------------------------------------------
// QUEUE-REORDER: drain-order display + effective position + reorder/retry/deps helpers.
// The T15 incident: an operator's "run this last" constraint lived only in prose, so nothing
// enforced it, and the newest-first display (above) never showed what would actually run next —
// the reorder lever (priority/orderKey) was invisible and therefore unusable. These selectors
// give the Queues screen a SECOND, explicit sort mode (kept alongside newestFirstTasks, not
// replacing it) plus the read models the move/retry/dependsOn affordances need.
// ---------------------------------------------------------------------------

/** Bucket a task falls into for the drain-order view: 0 = will run next (pending/blocked, real
 * scheduling order), 1 = currently running, 2 = terminal (done/failed/dead_letter). Mirrors
 * queues.ts's own ACTIVE-state grouping conceptually, but is a DISPLAY grouping only — it never
 * feeds back into scheduling. */
function drainBucket(state: string): number {
  if (state === "pending" || state === "blocked") return 0;
  if (state === "in_progress") return 1;
  return 2;
}

/** QUEUE-REORDER: the queue's TRUE drain order for display — pending/blocked tasks FIRST, sorted
 * by priority desc then orderKey asc (the EXACT comparator core's queues.ts uses, see
 * compareDrainOrder there), so this view is what will actually run next, not an approximation.
 * in_progress tasks follow (currently running, no "position"), then terminal tasks newest-first
 * (mirrors newestFirstTasks' own tiebreak). A separate, explicit sort MODE — newestFirstTasks
 * stays available and is still the default, so this never silently replaces one opinionated
 * order with another. */
export function drainOrderTasks(tasks: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const ba = drainBucket(str(a.t["state"]));
      const bb = drainBucket(str(b.t["state"]));
      if (ba !== bb) return ba - bb;
      if (ba === 0) {
        const pd = num(b.t["priority"]) - num(a.t["priority"]);
        if (pd !== 0) return pd;
        const kd = num(a.t["orderKey"]) - num(b.t["orderKey"]);
        if (kd !== 0) return kd;
        return a.i - b.i;
      }
      const at = typeof a.t["pushedAt"] === "number" ? (a.t["pushedAt"] as number) : num(a.t["createdAt"]);
      const bt = typeof b.t["pushedAt"] === "number" ? (b.t["pushedAt"] as number) : num(b.t["createdAt"]);
      return bt - at || b.i - a.i;
    })
    .map((x) => x.t);
}

/** taskId -> 1-based rank among pending/blocked tasks in TRUE drain order — the exact position
 * moveTask operates on. Computed and shown regardless of which display sort is currently active
 * (a small "#N" badge on the row), so "where will this actually run" stays visible even from the
 * newest-first view — requirement 1's "effective position... visible for pending+blocked tasks". */
export function drainPositions(tasks: ReadonlyArray<Record<string, unknown>>): Map<string, number> {
  const ranked = tasks
    .filter((t) => { const s = str(t["state"]); return s === "pending" || s === "blocked"; })
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const pd = num(b.t["priority"]) - num(a.t["priority"]);
      if (pd !== 0) return pd;
      const kd = num(a.t["orderKey"]) - num(b.t["orderKey"]);
      if (kd !== 0) return kd;
      return a.i - b.i;
    });
  const positions = new Map<string, number>();
  ranked.forEach((x, idx) => positions.set(str(x.t["taskId"]), idx + 1));
  return positions;
}

/** QUEUE-REORDER: a still-queued task (pending/blocked) is reorderable — the daemon's
 * queue.moveTask refuses anything else (TaskNotEditableError), same gating rule as editing
 * (isTaskEditable above); kept as its own named predicate so a call site reads as "can this be
 * reordered" rather than incidentally reusing the edit one. */
export const isTaskReorderable = isTaskEditable;

/** QUEUE-REORDER: only a terminal-with-error task (failed or dead_letter) is retryable — the
 * daemon's queue.retryTask refuses anything else (TaskNotRetryableError). */
export function isTaskRetryable(raw: Record<string, unknown> | undefined | null): boolean {
  const state = raw ? str(raw["state"]) : "";
  return state === "failed" || state === "dead_letter";
}

export type DependencyRow = { taskId: string; state: string; done: boolean };

/** QUEUE-REORDER: a task's dependencies resolved against its OWN queue's sibling tasks (dependsOn
 * is always same-queue, per DEP1) with their live state — "at minimum: show a task's dependencies
 * and what blocks it" (this is the actual fix for the T15 incident: priority can't express "after
 * these others", dependsOn can). A dependency that has aged out of the loaded task list (evicted
 * terminal history — queues.ts's MAX_TERMINAL_PER_QUEUE) reads state "unknown" rather than
 * crashing; `done` is exactly the depsSatisfied() condition core itself gates on. */
export function dependencyRows(
  raw: Record<string, unknown>,
  siblingTasks: ReadonlyArray<Record<string, unknown>>,
): DependencyRow[] {
  const ids = Array.isArray(raw["dependsOn"])
    ? (raw["dependsOn"] as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const byId = new Map(siblingTasks.map((t) => [str(t["taskId"]), t] as const));
  return ids.map((id) => {
    const dep = byId.get(id);
    const state = dep ? str(dep["state"]) || "unknown" : "unknown";
    return { taskId: id, state: state || "unknown", done: state === "done" };
  });
}

/** SURFACE-QUEUE-LATENCY — derives the wait (pushedAt → startedAt) and run
 * (startedAt → endedAt) durations from a raw TaskRecord. startedAt/endedAt
 * (TASK-STAMPS) are absent on records that predate that change and on tasks
 * still queued (no startedAt yet) or still running (no endedAt yet) — every
 * field here is `number | null`, never a fabricated 0 or NaN, so callers must
 * render an explicit empty state rather than compute a duration from a
 * missing stamp. */
export interface TaskTiming {
  startedAt: number | null;
  endedAt: number | null;
  waitMs: number | null; // pushedAt -> startedAt
  runMs: number | null; // startedAt -> endedAt
}

export function taskTiming(raw: Record<string, unknown>): TaskTiming {
  const pushedAt =
    typeof raw["pushedAt"] === "number" ? (raw["pushedAt"] as number) : num(raw["createdAt"]) || null;
  const startedAt = typeof raw["startedAt"] === "number" ? (raw["startedAt"] as number) : null;
  const endedAt = typeof raw["endedAt"] === "number" ? (raw["endedAt"] as number) : null;
  return {
    startedAt,
    endedAt,
    waitMs: pushedAt !== null && startedAt !== null ? Math.max(0, startedAt - pushedAt) : null,
    runMs: startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
  };
}

/** SEARCH-QUEUES free-text filter over the queue master list: matches the
 * queue's name, case-insensitive. An empty/blank query always matches. */
export function matchesQueueQuery(item: Record<string, unknown>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return str(item["name"]).toLowerCase().includes(q);
}

// ---------------------------------------------------------------------------
// teams (B8) — team.list items are TeamSpec & { running } (engine.ts stamps
// running via scheduler.runningFor on the list reply)
// ---------------------------------------------------------------------------

export type TeamListRow = {
  name: string;
  owner: string | null;        // createdBy verbatim (display mapping happens at the call site)
  roleCount: number;
  roles: string[];
  running: number;
  maxConcurrent: number;
  queue: string | null;
  purpose: string | null;
  // TEAM-STATS: total completed runs across every agent EVER tagged with this
  // team (team.list's totalRuns) — 0 for a real team with no runs yet, never
  // absent/undefined; num() below already degrades a missing/older-daemon
  // field to 0 the same honest way.
  totalRuns: number;
};

export function teamListRow(item: Record<string, unknown>): TeamListRow {
  const roles = item["roles"] && typeof item["roles"] === "object" ? Object.keys(item["roles"] as object) : [];
  return {
    name: str(item["name"]),
    owner: typeof item["createdBy"] === "string" ? (item["createdBy"] as string) : null,
    roleCount: roles.length,
    roles,
    running: num(item["running"]),
    maxConcurrent: num(item["maxConcurrent"]) || 1,
    queue: typeof item["queue"] === "string" ? (item["queue"] as string) : null,
    purpose: typeof item["purpose"] === "string" ? (item["purpose"] as string) : null,
    totalRuns: num(item["totalRuns"]),
  };
}

/** The one-line spec summary the AgentInspector renders (mock 605:
 * "claude-fable-5 · acceptEdits · engine local (mbp) · tree budget $2.00 ·
 * deliverTo main") — only the fields the spec actually carries are joined. */
export function specLine(spec: Record<string, unknown> | undefined): string {
  if (!spec) return "—";
  const parts: string[] = [];
  if (typeof spec["model"] === "string") parts.push(spec["model"] as string);
  if (typeof spec["permissionProfile"] === "string") parts.push(spec["permissionProfile"] as string);
  const engine = typeof spec["engine"] === "string" ? (spec["engine"] as string) : "local";
  parts.push(`engine ${engine}`);
  const budget = spec["maxBudgetUsd"];
  if (typeof budget === "number" && Number.isFinite(budget)) parts.push(`tree budget $${budget.toFixed(2)}`);
  if (typeof spec["deliverTo"] === "string") parts.push(`deliverTo ${spec["deliverTo"]}`);
  if (typeof spec["cwd"] === "string") parts.push(`cwd ${spec["cwd"]}`);
  return parts.join(" · ");
}

/** PROJTEAM-T7: whether a role in the team detail is DISCOVERED (materialized
 * from the project's .claude/agents by PROJTEAM-T3's syncProjectTeam) rather
 * than chimera-added. Driven off TeamSpec.discoveredRoles — the only place
 * provenance lives (RoleTemplateSchema itself can't carry a marker; it feeds
 * the strict AgentSpecSchema at spawn). */
export function isDiscoveredRole(spec: Record<string, unknown>, roleName: string): boolean {
  const discovered = spec["discoveredRoles"];
  return Array.isArray(discovered) && discovered.includes(roleName);
}

export type AddMemberFormValues = { role: string; cwd: string };

/** First validation error for the project-native team detail's "add member"
 * mini-form, or null when submittable. The role must be NEW: team.update
 * replaces `roles` wholesale (D11), so colliding with an existing key —
 * discovered or chimera-added — would silently overwrite its template rather
 * than adding a member. */
export function validateAddMemberForm(spec: Record<string, unknown>, v: AddMemberFormValues): string | null {
  if (!v.role.trim()) return "role is required";
  if (!COORD_NAME_RE.test(v.role.trim())) return "role: letters, digits, _ and - only";
  const roles = spec["roles"] && typeof spec["roles"] === "object" ? (spec["roles"] as Record<string, unknown>) : {};
  if (v.role.trim() in roles) return `role "${v.role.trim()}" already exists`;
  if (!v.cwd.trim()) return "cwd is required";
  return null;
}

/** team.update patch that ADDS a chimera role to a project-native team without
 * touching any existing role (discovered or chimera-added) — the existing
 * `roles` map is spread in verbatim (each already a ROLES-UNIFY `{role,
 * overrides}` binding, untouched) since team.update replaces it wholesale.
 * discoveredRoles is untouched (TeamUpdateParams doesn't expose it at the RPC
 * layer — see engine.ts/teams.ts), so the new role is, by construction, NOT
 * discovered and survives the next re-sync untouched (PROJTEAM-T3: chimera
 * roles always win collisions and are never in the discoveredRoles layer).
 *
 * FLAT-SHAPE-SWEEP: the new entry is a `{role, overrides}` BINDING, not the
 * old inline `{cwd, ...}` template — RoleBindingSchema is `.strict()`, so the
 * old shape no longer parses at all (same bug class as buildTeamSpec's, fixed
 * in ROLES-BINDING-CORRECTNESS). `v.role` doubles as both the team-local key
 * AND the library role name it references, same direct-construction
 * convention as buildTeamSpec/buildTeamUpdatePatch — there is no `prev` to
 * diff against for a brand-new binding. The caller (TeamsScreen's
 * submitAddMember) is responsible for role_create-ing a library role of this
 * exact name before sending this patch, so the reference actually resolves. */
export function buildAddMemberPatch(spec: Record<string, unknown>, v: AddMemberFormValues): Record<string, unknown> {
  const roles = spec["roles"] && typeof spec["roles"] === "object" ? (spec["roles"] as Record<string, unknown>) : {};
  const role = v.role.trim();
  return { roles: { ...roles, [role]: { role, overrides: { cwd: v.cwd.trim() } } } };
}

/** The team-detail agent row's activity cell (coverage B8: "resultText ilk
 * satırı"); a still-running worker has no resultText yet, so its task prompt
 * (the spec's prompt) is the honest fallback. */
export function agentActivity(record: Record<string, unknown>): string {
  const result = record["resultText"];
  if (typeof result === "string" && result.trim().length > 0) return ellipsize(firstLine(result.trim()));
  const spec = record["spec"];
  const prompt = spec && typeof spec === "object" ? (spec as Record<string, unknown>)["prompt"] : undefined;
  if (typeof prompt === "string" && prompt.length > 0) return ellipsize(firstLine(prompt));
  return "—";
}

/** Coverage B8: the team-detail agents table is fed from team.status.agents, which
 * the scheduler scopes to RUNNING workers only (scheduler.agentsFor) — a member
 * that has since finished (done/failed/killed) vanishes with no history. Merge the
 * live running rows (authoritative) with the app's own agents map filtered to this
 * team's membership, so a recently-drained member with a terminal state still shows
 * (mirroring how AgentList keeps team workers grouped). Live rows win on agentId
 * collisions; merged-in rows are mapped into the SAME loose record shape the table
 * reads (AgentView.account → accountName, resultDetail's result text → resultText),
 * so the row renderer + agentActivity stay unchanged. */
export function mergeTeamAgents(
  live: ReadonlyArray<Record<string, unknown>>,
  appAgents: ReadonlyArray<Record<string, unknown>>,
  teamName: string,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (const rec of live) {
    const id = str(rec["agentId"]);
    if (id) seen.add(id);
    rows.push(rec);
  }
  for (const av of appAgents) {
    const membership = av["membership"];
    const team = membership && typeof membership === "object" ? (membership as Record<string, unknown>)["team"] : undefined;
    if (team !== teamName || teamName === "") continue;
    const id = str(av["agentId"]);
    if (id && seen.has(id)) continue;   // a live row for this agent is authoritative
    if (id) seen.add(id);
    rows.push(agentViewToTeamRow(av));
  }
  return rows;
}

/** Project an AgentView-shaped record into the loose team.status agent-row shape
 * (defensive reads only — field drift never crashes the table). */
function agentViewToTeamRow(av: Record<string, unknown>): Record<string, unknown> {
  const resultDetail = av["resultDetail"];
  const result = resultDetail && typeof resultDetail === "object" ? (resultDetail as Record<string, unknown>)["result"] : undefined;
  const text = result && typeof result === "object" ? (result as Record<string, unknown>)["text"] : undefined;
  return {
    agentId: av["agentId"],
    state: av["state"],
    membership: av["membership"],
    accountName: av["account"],
    costUsd: av["costUsd"],
    ...(typeof text === "string" ? { resultText: text } : {}),
  };
}

/** The member agent ids currently belonging to a team (app agents map filtered
 * by membership.team) — the Teams search box's "member ids" match field draws
 * from this, so a query on a running worker's id finds its team even when the
 * name/purpose/role text doesn't mention it. */
export function teamMemberIds(appAgents: ReadonlyArray<Record<string, unknown>>, teamName: string): string[] {
  const ids: string[] = [];
  for (const av of appAgents) {
    const membership = av["membership"];
    const team = membership && typeof membership === "object" ? (membership as Record<string, unknown>)["team"] : undefined;
    if (team === teamName) ids.push(str(av["agentId"]));
  }
  return ids;
}

/** Teams search box predicate ("search everything in it"): free-text match
 * over the team's name, purpose, role names, and current member ids —
 * case-insensitive substring, empty query always matches. */
export function matchesTeamQuery(row: TeamListRow, memberIds: readonly string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [row.name, row.purpose ?? "", ...row.roles, ...memberIds].join(" ").toLowerCase();
  return haystack.includes(q);
}

/** The task record currently/last bound to an agent (queue.status tasks[] →
 * AgentInspector's "queue → task tX · try n/m" line). in_progress wins over a
 * settled binding so a re-used persistent worker points at its LIVE task. */
export function taskForAgent(
  tasks: ReadonlyArray<Record<string, unknown>>,
  agentId: string,
): Record<string, unknown> | null {
  let settled: Record<string, unknown> | null = null;
  for (const t of tasks) {
    if (t["agentId"] !== agentId) continue;
    if (t["state"] === "in_progress") return t;
    settled = t;
  }
  return settled;
}

// ---------------------------------------------------------------------------
// queues (B9)
// ---------------------------------------------------------------------------

/** Fixed count vocabulary + tone contract (coverage B9: "renk sözleşmesi sabit"). */
export const TASK_STATES = ["pending", "blocked", "in_progress", "done", "failed"] as const;

export function countTone(state: string): CoordTone {
  switch (state) {
    case "pending": return "warn";
    case "blocked": return "muted";
    case "in_progress": return "accent";
    case "done": return "success";
    case "failed": return "danger";
    default: return "muted";
  }
}

/** Backlog fill ratio = (pending+blocked)/Σcounts (coverage B9 — "meter oranı
 * counts'tan hesapla birebir"). 0 for an empty/absent counts record. */
export function backlogRatio(counts: Record<string, number> | undefined | null): number {
  if (!counts) return 0;
  let total = 0;
  for (const v of Object.values(counts)) total += num(v);
  if (total <= 0) return 0;
  return (num(counts["pending"]) + num(counts["blocked"])) / total;
}

/** Whole-percent backlog label ("18%"). */
export function backlogPct(counts: Record<string, number> | undefined | null): number {
  return Math.round(backlogRatio(counts) * 100);
}

export type TaskRowView = {
  taskId: string;
  state: string;
  role: string;
  agentId: string | null;
  attempts: number;
  priority: number;
  prompt: string;
  error: string | null;
  // TASK-TAGS: the labels hook/subscription `filter: {tags:[...]}` routes on. Read defensively
  // like every other field here — a task record is an untyped payload off the wire, and one
  // pushed before tags existed simply has none.
  tags: string[];
};

export function taskRowView(t: Record<string, unknown>): TaskRowView {
  return {
    taskId: str(t["taskId"]),
    state: str(t["state"]) || "pending",
    role: typeof t["role"] === "string" ? (t["role"] as string) : "—",
    agentId: typeof t["agentId"] === "string" ? (t["agentId"] as string) : null,
    attempts: num(t["attempts"]),
    priority: num(t["priority"]),
    prompt: str(t["prompt"]),
    error: typeof t["error"] === "string" ? (t["error"] as string) : null,
    tags: Array.isArray(t["tags"]) ? (t["tags"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
  };
}

/** SEARCH-QUEUES free-text filter over a queue drill's task list: matches
 * taskId, role, agent, or prompt, case-insensitive. An empty/blank query
 * always matches. */
export function matchesTaskQuery(t: TaskRowView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${t.taskId} ${t.role} ${t.agentId ?? ""} ${t.prompt} ${t.tags.join(" ")}`.toLowerCase().includes(q);
}

/** TaskInspector policy line, derived from the queue's retryLimit + the team
 * spec bound to this queue (mock 707: "retry 0/2 · drained by team tui-crew
 * (max 2) · role template applies on assignment: cwd ~/code/chimera · acceptEdits").
 * FLAT-SHAPE-SWEEP: `team.roles[roleName]` is a ROLES-UNIFY `{role, overrides}`
 * BINDING — reading its `cwd`/`permissionProfile` fields directly (as this used
 * to) always reads undefined, since a binding's own fields live under
 * `overrides`/the library role it references (same bug class as roleConfig's,
 * see ui-state/roles.ts). Resolve against the library instead; `library`
 * defaults to `[]` so a caller that hasn't loaded role.list yet still degrades
 * to the plain retry/team text instead of throwing. */
export function policyLine(
  task: Pick<TaskRowView, "attempts" | "role">,
  retryLimit: number,
  team: Record<string, unknown> | null,
  library: ReadonlyArray<Record<string, unknown>> = [],
): string {
  const parts = [`retry ${task.attempts}/${retryLimit}`];
  if (team) {
    const row = teamListRow(team);
    parts.push(`drained by team ${row.name} (max ${row.maxConcurrent})`);
    const roles = team["roles"];
    const roleName = task.role !== "—" ? task.role : row.roles[0] ?? null;
    const binding =
      roles && typeof roles === "object" && roleName !== null
        ? ((roles as Record<string, unknown>)[roleName] as Record<string, unknown> | undefined)
        : undefined;
    if (binding && typeof binding === "object") {
      const template = resolvedRoleBindingSpec(binding, library);
      const bits: string[] = [];
      if (typeof template["cwd"] === "string") bits.push(`cwd ${template["cwd"]}`);
      if (typeof template["permissionProfile"] === "string") bits.push(template["permissionProfile"] as string);
      if (bits.length > 0) parts.push(`role template applies on assignment: ${bits.join(" · ")}`);
    }
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// events (B10)
// ---------------------------------------------------------------------------

/** kind → tone per coverage B10 (everything else renders plain). W8 adds
 * policy_denied (B14: a deny'd tool policy rejects the Bash call and emits
 * this kind — the events table tints it danger). */
export function eventKindTone(kind: string): CoordTone | null {
  switch (kind) {
    case "permission_request": return "human";
    case "error": return "danger";
    case "result": return "info";
    case "policy_denied": return "danger";
    // F36.UI: the eviction machinery is silent otherwise — a note leaves and nothing
    // said it would. Pressure and a drop both read warn (data is going away), never
    // danger: eviction is normal, designed behaviour and everything is archived first.
    case "memory_pressure": return "warn";
    case "memory_evicted": return "warn";
    // HOOK-6 (PLAN-HOOKS.md §7): the new lifecycle-hook / subscription event kinds
    // get their own row treatment — a fired hook reads success, a suppressed one
    // (loop-guard / rate-limit) reads warn, a delivered signal reads accent.
    case "hook_fired": return "success";
    case "hook_error": return "danger";
    case "hook_suppressed": return "warn";
    case "signal_delivered": return "accent";
    // F02.UI: a suspend/resume is consequential context for every row after it (late runs, long
    // elapsed times) but is not a fault — the same informational tone `result` carries.
    case "clock_jump": return "info";
    // F01.UI: an armed wake is quiet good news; a failed arm means a schedule will slip.
    case "job_wake_scheduled": return "info";
    case "job_wake_failed": return "warn";
    // F05.UI: a dead-letter is the terminal failure of a schedule — the one job event that reads
    // danger. The job_disabled that core fires alongside it stays warn: a disable on its own is a
    // deliberate act, not a fault.
    case "job_dead_letter": return "danger";
    case "job_disabled": return "warn";
    // F26: base tone for a bootstrap-hook run; a failed run is upgraded to danger in
    // eventRowTone below (this function has no `data`, so it can't see the phase).
    case "worktree_setup": return "info";
    default: return null;
  }
}

// GATED-BUT-ALLOWED-INVISIBLE: capability_decision/allow is mostly noise (818 events in one
// observed 5-minute production window, largely argv-parsing junk like tool "1"/"head" from a
// piped command) — a kind-level tone would drown the signal. Only an "allow" that ALSO carries
// `explicitPolicy: true` (core's CapabilityBroker: an explicit toolPolicy row matched, a
// foreign MCP tool, or a would-be-prompting gate — e.g. cloud_mutation_gated — silently
// bypassed) is the consequential case the owner asked for: "only the allowed commands/
// operations that WOULD normally be asked about, but were auto-allowed" should stand out. A
// deny/prompt is already visible via policy_denied/permission_request; this only adds a
// distinct signal for the previously-invisible auto-allowed-but-gated case.
export function isGatedAutoAllow(kind: string, data: Record<string, unknown> | undefined | null): boolean {
  return kind === "capability_decision" && !!data && data["decision"] === "allow" && data["explicitPolicy"] === true;
}

/** Tone for an event row, folding isGatedAutoAllow (warn — "bypassed friction, look twice")
 * IN FRONT of the plain kind-based eventKindTone above. Call sites that need the row tone
 * (EventsScreen) should use this, not eventKindTone directly, or the gated-allow case renders
 * untoned like ordinary noise. */
export function eventRowTone(kind: string, data: Record<string, unknown> | undefined | null): CoordTone | null {
  if (isGatedAutoAllow(kind, data)) return "warn";
  if (kind === "worktree_setup" && !!data && data["phase"] === "fail") return "danger";
  return eventKindTone(kind);
}

// F02.UI: `clock_jump` is the one event kind whose raw k=v summary is unreadable to anyone who
// has not read jobs.ts — `driftMs=33180000 · observedGapMs=33240000 · expectedGapMs=60000 · …`,
// truncated at 60 chars before the `direction` that gives it meaning. Rendered as the sentence
// the schedules banner uses instead. Any other kind falls through to the generic summary.
export function clockJumpSummary(data: Record<string, unknown> | undefined | null): string | null {
  if (!data || typeof data !== "object") return null;
  const raw = data["driftMs"];
  const drift = typeof raw === "number" ? Math.abs(raw) : 0;
  const totalSec = Math.floor(drift / 1000);
  const gap = totalSec < 60 ? `${totalSec}s`
    : totalSec < 3600 ? `${Math.floor(totalSec / 60)}m`
    : `${Math.floor(totalSec / 3600)}h${Math.floor((totalSec % 3600) / 60) ? ` ${Math.floor((totalSec % 3600) / 60)}m` : ""}`;
  return data["direction"] === "backward"
    ? `clock stepped back ${gap} \u2014 schedules re-armed`
    : `slept ${gap} \u2014 schedules re-armed`;
}

/** Compact `k=v · k=v` summary of an event's TOP-LEVEL primitive data fields;
 * nested objects/arrays elide to {…}/[…]; whole line capped at 60 chars.
 * Ported from the TUI EventsPane's summarizeData (pure, circular-safe). */
export function summarizeEventData(data: Record<string, unknown> | undefined | null): string {
  if (data === undefined || data === null || typeof data !== "object") return "";
  const parts = Object.entries(data).map(([k, v]) => {
    const val =
      v === null ? "null"
      : typeof v === "string" ? v
      : typeof v === "number" || typeof v === "boolean" ? String(v)
      : Array.isArray(v) ? "[…]"
      : typeof v === "object" ? "{…}"
      : String(v);
    return `${k}=${val}`;
  });
  return ellipsize(parts.join(" · "), 60);
}

export function isRemoteEvent(e: Pick<NormalizedEvent, "engineId">): boolean {
  return e.engineId !== "local";
}

/** `f` cycles: all → each kind PRESENT in the buffer (sorted) → all. Keyed on
 * the live buffer so the cycle never offers a dead filter. */
export function nextKindFilter(current: string | null, events: ReadonlyArray<Pick<NormalizedEvent, "kind">>): string | null {
  const kinds: string[] = [...new Set<string>(events.map((e) => e.kind))].sort();
  if (kinds.length === 0) return null;
  if (current === null) return kinds[0]!;
  const i = kinds.indexOf(current);
  return i === -1 || i === kinds.length - 1 ? null : kinds[i + 1]!;
}

/** The newest seq among coordination-relevant events (status/result; W18 (F16
 * task workflows) adds task_step_advanced/_failed so a gate pass/fail refetches
 * the queue drill immediately — the reconcile half of the step meter's
 * optimistic render) — the teams/queues screens' refresh trigger (refresh on
 * relevant events, NO polling timers). 0 when none. */
export function latestCoordSeq(events: ReadonlyArray<Pick<NormalizedEvent, "seq" | "kind">>): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const k = events[i]!.kind;
    if (k === "status" || k === "result" || k === "task_step_advanced" || k === "task_step_failed") return events[i]!.seq;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// memory (B10)
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Mock's memory time cell ("Jul 14"): month + day, local time. */
export function fmtMemDate(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export type MemoryRowView = { id: string; ts: number; kind: string; author: string; tags: string; text: string; title: string | null; folder: string | null; scope: string | null; label: string };

/** The list/detail label: the note's title when set, else its first non-blank
 * text line truncated to ~48 chars (MEM-5 §8 "title column + first-line
 * fallback"; mirrors the server-side memory.graph label rule). */
export function memoryLabel(title: string | null, text: string): string {
  if (title && title.trim()) return title.trim();
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
}

export function memoryRowView(hit: MemoryHit): MemoryRowView {
  const r = hit.record;
  return {
    id: r.id,
    ts: r.updatedAt,
    kind: r.kind,
    author: r.author,
    tags: r.tags.join(","),
    text: r.text,
    title: r.title,
    folder: r.folder,
    scope: r.scope,
    label: memoryLabel(r.title, r.text),
  };
}

/** "tui, selection" → ["tui","selection"] (form tags field). */
export function parseTags(s: string): string[] {
  return s.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// form spec builders (unit-tested; the cards stay thin)
// ---------------------------------------------------------------------------

/** protocol CoordName rule (TeamSpecSchema/QueueSpecSchema): letters, digits,
 * _ and - only ("/" is the engine-qualifier separator, never admitted). */
export const COORD_NAME_RE = /^[A-Za-z0-9_-]+$/;

// TEAM-FORM: model/persistent/instructions are RoleTemplateSchema fields
// (AgentSpecSchema minus prompt/content) previously only reachable via the
// raw team.create/team.update RPC — same reachability class as 52db09a.
// persistent is a tri-state string ("" = unset/schema default, "true"/
// "false" = explicit) so a create form can omit it and an edit form can
// still show/toggle a daemon-stamped false.
export type TeamFormValues = {
  name: string; role: string; maxConcurrent: string; cwd: string; queue: string; purpose: string;
  model: string; persistent: string; instructions: string;
};

/** First validation error for the create-team form, or null when submittable.
 * Mirrors protocol constraints client-side so the inline error is instant. */
export function validateTeamForm(v: TeamFormValues): string | null {
  if (!v.name.trim()) return "name is required";
  if (!COORD_NAME_RE.test(v.name.trim())) return "name: letters, digits, _ and - only";
  if (!v.cwd.trim()) return "cwd is required";
  if (v.maxConcurrent.trim() && !(Number.isInteger(Number(v.maxConcurrent)) && Number(v.maxConcurrent) > 0))
    return "max concurrent must be a positive integer";
  return null;
}

/** team.create spec (protocol TeamSpecSchema: `roles[key]` is a ROLES-UNIFY §3.1
 * `{role, overrides}` BINDING — a reference into the role library, not a materialized
 * template — RoleBindingSchema is `.strict()`, so the old inline {cwd, model, ...} shape
 * no longer parses at all. `v.role` doubles as both the binding's team-local key AND the
 * library role name it references (§6.5's picker fills it from role.list; team.create
 * itself now validates the reference exists — ROLES-BINDING-CORRECTNESS). cwd is always
 * sent as an override (the §2 bind-time invariant: a binding must resolve to a
 * cwd-complete spec, and the picked library role may have none of its own). Same direct
 * construction shape as the TUI's store.ts createTeam — no ui-state builder applies here
 * (those are sparse DIFF builders for editing an existing binding; this is a fresh
 * binding with no "prev" to diff against). */
export function buildTeamSpec(v: TeamFormValues): Record<string, unknown> {
  const role = v.role.trim() || "dev";
  const persistent = v.persistent.trim().toLowerCase();
  return {
    name: v.name.trim(),
    roles: {
      [role]: {
        role,
        overrides: {
          cwd: v.cwd.trim(),
          ...(v.model.trim() ? { model: v.model.trim() } : {}),
          ...(persistent === "true" || persistent === "false" ? { persistent: persistent === "true" } : {}),
          ...(v.instructions.trim() ? { instructions: v.instructions.trim() } : {}),
        },
      },
    },
    ...(v.maxConcurrent.trim() ? { maxConcurrent: Number(v.maxConcurrent) } : {}),
    ...(v.queue.trim() ? { queue: v.queue.trim() } : {}),
    ...(v.purpose.trim() ? { purpose: v.purpose.trim() } : {}),
  };
}

/** team.list/status spec → the create-card's field shape, for the "e" edit
 * prefill (F15/D11). Only the FIRST role shows — the form (like create) only
 * ever edits a single role template. Reads the binding's OWN overrides (never
 * its top-level fields, which live under `overrides` post-ROLES-UNIFY — same
 * bug class as roleConfig's, see ui-state/roles.ts). */
export function teamFormValuesFromSpec(spec: Record<string, unknown>): TeamFormValues {
  const roles = spec["roles"] && typeof spec["roles"] === "object" ? (spec["roles"] as Record<string, unknown>) : {};
  const roleName = Object.keys(roles)[0] ?? "dev";
  const binding = roles[roleName];
  const t = overridesOf(binding as Record<string, unknown> | undefined);
  return {
    name: str(spec["name"]),
    role: roleName,
    maxConcurrent: String(num(spec["maxConcurrent"]) || 1),
    cwd: str(t["cwd"]),
    queue: typeof spec["queue"] === "string" ? (spec["queue"] as string) : "",
    purpose: typeof spec["purpose"] === "string" ? (spec["purpose"] as string) : "",
    model: str(t["model"]),
    persistent: typeof t["persistent"] === "boolean" ? String(t["persistent"]) : "",
    instructions: str(t["instructions"]),
  };
}

/** team.update patch (D11: only maxConcurrent/purpose/queue/roles are
 * patchable — name is immutable). `includeRoles` is false while the team has
 * any running member (the engine refuses a roles patch outright in that
 * case) — omitting the key entirely lets a maxConcurrent-only edit go through
 * even while workers are busy, instead of always tripping the running guard.
 * Same `{role, overrides}` binding shape as buildTeamSpec — see its comment. */
export function buildTeamUpdatePatch(v: TeamFormValues, includeRoles: boolean): Record<string, unknown> {
  const role = v.role.trim() || "dev";
  const persistent = v.persistent.trim().toLowerCase();
  return {
    ...(v.maxConcurrent.trim() ? { maxConcurrent: Number(v.maxConcurrent) } : {}),
    purpose: v.purpose.trim() || null,
    queue: v.queue.trim() || null,
    ...(includeRoles
      ? {
          roles: {
            [role]: {
              role,
              overrides: {
                cwd: v.cwd.trim(),
                ...(v.model.trim() ? { model: v.model.trim() } : {}),
                ...(persistent === "true" || persistent === "false" ? { persistent: persistent === "true" } : {}),
                ...(v.instructions.trim() ? { instructions: v.instructions.trim() } : {}),
              },
            },
          },
        }
      : {}),
  };
}

export type QueueFormValues = { name: string; retryLimit: string };

/** First validation error for the create/edit-queue form, or null when
 * submittable (protocol QueueSpecSchema). */
export function validateQueueForm(v: QueueFormValues): string | null {
  if (!v.name.trim()) return "name is required";
  if (!COORD_NAME_RE.test(v.name.trim())) return "name: letters, digits, _ and - only";
  if (v.retryLimit.trim() && !(Number.isInteger(Number(v.retryLimit)) && Number(v.retryLimit) >= 0))
    return "retry limit must be a non-negative integer";
  return null;
}

/** queue.create spec. */
export function buildQueueSpec(v: QueueFormValues): Record<string, unknown> {
  return {
    name: v.name.trim(),
    ...(v.retryLimit.trim() ? { retryLimit: Number(v.retryLimit) } : {}),
  };
}

/** queue.update patch (D11: only retryLimit is patchable). */
export function buildQueueUpdatePatch(v: QueueFormValues): Record<string, unknown> {
  return { retryLimit: Number(v.retryLimit.trim() || "0") };
}

/** queue.list item → the create-card's field shape, for the "e" edit prefill. */
export function queueFormValuesFromSpec(spec: Record<string, unknown>): QueueFormValues {
  return { name: str(spec["name"]), retryLimit: String(num(spec["retryLimit"])) };
}

// W18 (F16 task workflows): `workflow` is the per-task override of the queue's
// own default binding (engine QueuePushParams.workflow, optional) — empty
// string means "inherit the queue's binding at pickup" (null override).
// TASK-TAGS: `tags` is a comma-separated list in the form (the same convention the hook form's
// tag filter uses) — free-form labels, conventionally namespaced ("gate:coverage").
export type PushFormValues = { prompt: string; priority: string; role: string; workflow: string; tags: string };

/** TASK-TAGS: the form's comma-separated tag string → the wire's string[]. Trimmed, blanks
 * dropped; an all-blank input yields [] so the caller can omit the field entirely. */
export function parseTagList(raw: string): string[] {
  return raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
}

export function validatePushForm(v: PushFormValues): string | null {
  if (!v.prompt.trim()) return "prompt is required";
  if (v.priority.trim() && !Number.isInteger(Number(v.priority))) return "priority must be an integer";
  if (v.workflow.trim() && !COORD_NAME_RE.test(v.workflow.trim())) return "workflow: letters, digits, _ and - only";
  return null;
}

/** queue.push params (engine QueuePushParams: queue, prompt, priority?, role?,
 * workflow?). */
export function buildPushParams(queue: string, v: PushFormValues): Record<string, unknown> {
  return {
    queue,
    prompt: v.prompt.trim(),
    ...(v.priority.trim() ? { priority: Number(v.priority) } : {}),
    ...(v.role.trim() ? { role: v.role.trim() } : {}),
    ...(v.workflow.trim() ? { workflow: v.workflow.trim() } : {}),
    ...(parseTagList(v.tags).length > 0 ? { tags: parseTagList(v.tags) } : {}),
  };
}

// TASK-EDIT-VERSIONING: the scalar edit form for a still-queued task — only
// prompt/priority/role (the daemon's queue.editTask patch also takes overrides
// + workflow binding, but those stay in the command-palette raw tool, never in
// this form). Mirrors PushFormValues minus the workflow field.
export type EditTaskFormValues = { prompt: string; priority: string; role: string; tags: string };

// TASK-EDIT-VERSIONING: only a still-queued task (pending/blocked) is editable in
// place — an in_progress/terminal task already had its prompt consumed by its
// agent, so the daemon's queue.editTask refuses it (TaskNotEditableError). The UI
// gates the edit affordance on this same predicate to avoid opening a form that
// would only fail on submit. Missing/unknown state → not editable (safe default).
export function isTaskEditable(raw: Record<string, unknown> | undefined | null): boolean {
  const state = raw ? str(raw["state"]) : "";
  return state === "pending" || state === "blocked";
}

export function validateEditForm(v: EditTaskFormValues): string | null {
  if (!v.prompt.trim()) return "prompt is required";
  if (v.priority.trim() && !Number.isInteger(Number(v.priority))) return "priority must be an integer";
  return null;
}

/** The task's current head fields → the edit-card prefill (raw record → form). */
export function editFormValuesFromTask(raw: Record<string, unknown>): EditTaskFormValues {
  const t = taskRowView(raw);
  return { prompt: t.prompt, priority: String(t.priority), role: t.role === "—" ? "" : t.role, tags: t.tags.join(", ") };
}

/** queue.editTask patch from the scalar form (engine QueueEditTaskParams.patch —
 * an empty role clears the per-task role override back to null). */
export function buildEditPatch(v: EditTaskFormValues): Record<string, unknown> {
  return {
    prompt: v.prompt.trim(),
    priority: Number(v.priority.trim() || "0"),
    role: v.role.trim() ? v.role.trim() : null,
    // TASK-TAGS: unconditionally present, unlike the optional fields on the PUSH form. The
    // daemon's patch replaces the whole list, so an emptied field must arrive as [] — omitting
    // it on empty would leave the operator no way to remove a tag at all.
    tags: parseTagList(v.tags),
  };
}

// TASK-EDIT-VERSIONING: the read-only version-history rows (TaskRecord.versions,
// TaskVersionSchema). Head = versions.length ("v0" when empty); each entry is an
// append-only snapshot of what changed and the PRIOR values. Read defensively —
// an older record with no versions field renders none.
export type TaskVersionRow = { version: number; editedAt: number; changedFields: string[]; prior: Record<string, unknown> };

export function taskVersionRows(raw: Record<string, unknown>): TaskVersionRow[] {
  const versions = raw["versions"];
  if (!Array.isArray(versions)) return [];
  return versions.map((v) => {
    const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    return {
      version: num(r["version"]),
      editedAt: num(r["editedAt"]),
      changedFields: Array.isArray(r["changedFields"])
        ? (r["changedFields"] as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      prior: r["prior"] && typeof r["prior"] === "object" ? (r["prior"] as Record<string, unknown>) : {},
    };
  });
}

// MEM-5: title + folder join the note form (§8). Both optional (empty ⇒ the
// note stays untitled / unfiled — the store's null); text stays the one required
// field. Field order in the cards: title · text · tags · kind · folder.
export type MemoryFormValues = { title: string; text: string; tags: string; kind: string; folder: string };

export function validateMemoryForm(v: MemoryFormValues): string | null {
  if (!v.text.trim()) return "text is required";
  if (v.title.trim().length > 120) return "title: 120 chars max";
  return null;
}

/** memory.add params (protocol MemoryAddParams; author stamped by the caller).
 * title/folder are sent ONLY when non-empty so an untitled/unfiled note is
 * byte-identical to a pre-MEM-5 add (omitted ⇒ server default null). */
export function buildMemoryAddParams(v: MemoryFormValues, author: string): Record<string, unknown> {
  return {
    author,
    text: v.text.trim(),
    ...(v.title.trim() ? { title: v.title.trim() } : {}),
    ...(v.folder.trim() ? { folder: v.folder.trim() } : {}),
    ...(parseTags(v.tags).length > 0 ? { tags: parseTags(v.tags) } : {}),
    ...(v.kind.trim() ? { kind: v.kind.trim() } : {}),
  };
}

/** a memory.search hit's record → the note-card's field shape, for the "e" edit prefill. */
export function memoryFormValuesFromRecord(r: MemoryHit["record"]): MemoryFormValues {
  return { title: r.title ?? "", text: r.text, tags: r.tags.join(", "), kind: r.kind, folder: r.folder ?? "" };
}

/** memory.update params (D11 MemoryEditParams; author is re-stamped to the
 * editing caller). title/folder are ALWAYS sent (nullable-to-clear): an empty
 * field means "clear it" on edit, so we pass explicit null rather than omitting
 * (omitting would leave the old value — wrong for a user who blanked the field). */
export function buildMemoryUpdateParams(id: string, v: MemoryFormValues, author: string): Record<string, unknown> {
  return {
    id,
    author,
    text: v.text.trim(),
    title: v.title.trim() ? v.title.trim() : null,
    folder: v.folder.trim() ? v.folder.trim() : null,
    tags: parseTags(v.tags),
    ...(v.kind.trim() ? { kind: v.kind.trim() } : {}),
  };
}

// ---------------------------------------------------------------------------
// MEM-5 folder rail (§8) — the folder tree derived from memory.stats.byFolder.
// ---------------------------------------------------------------------------

export type MemoryFolderNode = { path: string; name: string; depth: number; count: number; hasChildren: boolean };

/** memory.stats.byFolder ([{folder, count}], null = unfiled, counts DIRECT per
 * exact path) → a pre-order flat folder tree. Ancestor paths absent from the
 * stats (a note filed only in "ops/protocols" with none directly in "ops") are
 * synthesized so the rail still shows the "ops" parent; each node's `count` is
 * the ROLL-UP (the folder itself + everything under it) so a parent reads the
 * total a click-to-filter would surface (folder prefix filter is inclusive). */
export function buildFolderTree(byFolder: Array<{ folder: string | null; count: number }>): MemoryFolderNode[] {
  const direct = new Map<string, number>();
  for (const e of byFolder) if (e.folder) direct.set(e.folder, (direct.get(e.folder) ?? 0) + e.count);
  const paths = new Set<string>();
  for (const p of direct.keys()) {
    const segs = p.split("/");
    for (let i = 1; i <= segs.length; i++) paths.add(segs.slice(0, i).join("/"));
  }
  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  return sorted.map((path) => {
    const segs = path.split("/");
    let count = 0;
    for (const [fp, c] of direct) if (fp === path || fp.startsWith(`${path}/`)) count += c;
    const hasChildren = sorted.some((o) => o.startsWith(`${path}/`) && o.split("/").length === segs.length + 1);
    return { path, name: segs[segs.length - 1]!, depth: segs.length - 1, count, hasChildren };
  });
}

/** The count of unfiled (folder === null) records, for the rail's virtual
 * "unfiled" entry. */
export function unfiledCount(byFolder: Array<{ folder: string | null; count: number }>): number {
  return byFolder.find((e) => e.folder === null)?.count ?? 0;
}

/** The rail's fold filter: hide any node whose ANY ancestor path is collapsed.
 * The tree is pre-order so an ancestor always precedes its descendants; a
 * prefix test against each collapsed path is sufficient. A collapsed node
 * itself stays visible (only its subtree hides). */
export function visibleFolderNodes(tree: MemoryFolderNode[], collapsed: ReadonlySet<string>): MemoryFolderNode[] {
  if (collapsed.size === 0) return tree;
  return tree.filter((n) => {
    for (const c of collapsed) if (n.path !== c && n.path.startsWith(`${c}/`)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// MEM-5 search params — the (query, mode, folder-selection) → memory.search
// mapping, pure so the seq-guard command wrapper and its tests share one truth.
// ---------------------------------------------------------------------------

export type MemoryFolderSelPure = { kind: "all" } | { kind: "unfiled" } | { kind: "folder"; path: string };

/** Build the memory.search params for the current UI filter state. The RPC's
 * `folder` param is an inclusive PREFIX match with no "is-null" form, so the
 * virtual "unfiled" folder can't be expressed server-side — it returns
 * `unfiledOnly: true` for the caller to post-filter the reply to null-folder
 * records. "all" sends no folder param; a real folder sends it as the prefix. */
export function buildMemorySearchParams(
  query: string | undefined,
  mode: string,
  folder: MemoryFolderSelPure,
  scope: MemoryScopeSel = { kind: "all" },
  limit?: number,
): { params: Record<string, unknown>; unfiledOnly: boolean; scope: MemoryScopeSel } {
  const q = query?.trim();
  return {
    params: {
      ...(q ? { query: q } : {}),
      // "hybrid" is the protocol default, so omit it — an unfiltered default-mode
      // search stays byte-identical to the pre-MEM-5 call; only an explicit
      // lexical/semantic selection adds `mode`.
      ...(mode && mode !== "hybrid" ? { mode } : {}),
      ...(folder.kind === "folder" ? { folder: folder.path } : {}),
      // F34.UI: a named scope narrows the PAGE server-side, but memory.search
      // widens it to (scope ∪ global) and has no is-null form — the caller always
      // post-filters with scopeMatches to make the chip's label truthful.
      ...scopeSearchParam(scope),
      ...(limit != null ? { limit } : {}),
    },
    unfiledOnly: folder.kind === "unfiled",
    scope,
  };
}

// F01.UI: the sleep-wake event kinds are as unreadable raw as clock_jump was — `atMs=1756...` is a
// number an operator cannot date, and a late `job_run_started` renders `latenessMs=33180000` with
// no hint that the machine was asleep. Same treatment: one sentence, same words the schedules pane
// uses, so the two surfaces agree. Any other kind falls through to the generic k=v summary.
function wakeClock(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function wakeGap(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const totalSec = Math.floor(Math.abs(ms) / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m`;
  const m = Math.floor((totalSec % 3600) / 60);
  return `${Math.floor(totalSec / 3600)}h${m ? ` ${m}m` : ""}`;
}

/** The event feed's humanized summary for the kinds whose raw data is meaningless, or null to fall
 *  back to the generic k=v line. This is the TUI's ONLY sleep-wake surface (it has no schedules
 *  view), so the late-run sentence here must match ScheduleDetail's word for word. */
export function eventSummaryOverride(kind: string, data: Record<string, unknown> | undefined | null): string | null {
  if (kind === "clock_jump") return clockJumpSummary(data);
  if (!data || typeof data !== "object") return null;
  // F36.UI: memory_pressure / memory_evicted carry no curated topic, so the feed is
  // the ONLY place they surface; memoryEventLine is shared with ui-state so the app
  // and the TUI never describe the same eviction differently.
  const mem = memoryEventLine(kind, data);
  if (mem) return mem;
  const job = typeof data["job"] === "string" ? (data["job"] as string) : null;
  if (kind === "job_wake_scheduled") {
    const at = wakeClock(data["atMs"]);
    const forJob = typeof data["forJob"] === "string" ? (data["forJob"] as string) : null;
    if (!at) return null;
    return `this Mac will be woken at ${at}${forJob ? ` for ${forJob}` : ""}`;
  }
  if (kind === "job_wake_failed") {
    const at = wakeClock(data["atMs"]);
    const reason = typeof data["reason"] === "string" ? (data["reason"] as string) : "unknown";
    return `could not arm a wake${at ? ` for ${at}` : ""} \u2014 a run due during sleep will fire late: ${reason}`;
  }
  // F05.UI: a dead-letter is the one job event that STOPS a schedule for good, and without a line
  // here it reaches the feed as a bare kind + raw k=v. job_disabled fires alongside it (core's
  // deadLetter() routes through disable() on purpose), so that kind is folded into one short line
  // rather than repeating this sentence — the reason prefix core writes is the discriminator.
  // Word-for-word identical to the app copy of this function.
  if (kind === "job_dead_letter") {
    const n = typeof data["attempts"] === "number" ? (data["attempts"] as number) : null;
    const max = typeof data["maxAttempts"] === "number" ? (data["maxAttempts"] as number) : null;
    const reasons = Array.isArray(data["reasons"]) ? (data["reasons"] as Array<Record<string, unknown>>) : [];
    const last = reasons.length > 0 && typeof reasons[reasons.length - 1]?.["error"] === "string"
      ? (reasons[reasons.length - 1]!["error"] as string) : null;
    const count = n !== null ? ` after ${n}${max !== null ? ` of ${max}` : ""} failed attempt${n === 1 ? "" : "s"}` : "";
    return `${job ?? "job"}: dead-lettered${count} \u2014 the schedule is stopped until it is requeued${last ? `: ${last}` : ""}`;
  }
  if (kind === "job_disabled") {
    const reason = typeof data["reason"] === "string" ? (data["reason"] as string) : null;
    if (reason && reason.startsWith("dead-letter after")) return `${job ?? "job"}: schedule stopped (dead-lettered)`;
    return `${job ?? "job"}: schedule disabled${reason ? ` \u2014 ${reason}` : ""}`;
  }
  // F04.UI: the daemon refuses a duplicate fire, drops a too-stale catch-up and re-adopts a claim
  // across a restart entirely on its own. Without these lines the feed shows a bare kind and raw
  // k=v, and the TUI — which has no schedules view — has NO other place to read the catch-up bound
  // the daemon judged against. Word-for-word identical to the app copy of this function.
  if (kind === "job_skipped") {
    const reason = typeof data["reason"] === "string" ? (data["reason"] as string) : null;
    const slot = wakeClock(data["nominalFireTs"]);
    const at = slot ? ` for the ${slot} slot` : "";
    if (reason === "duplicate-occurrence") {
      const manual = data["trigger"] === "manual";
      return `${job ?? "job"}: ${manual ? "manual run" : "duplicate fire"} refused${at} \u2014 that slot has already run`;
    }
    if (reason === "stale-beyond-window") {
      const late = wakeGap(data["lateMs"]);
      const limit = wakeGap(data["maxStalenessMs"]);
      return `${job ?? "job"}: catch-up skipped${at} \u2014 ${late ? `${late} late` : "too late"}${limit ? `, past the ${limit} catch-up limit` : ""}`;
    }
    if (reason === "missed-restart") return `${job ?? "job"}: missed${at} while the daemon was down \u2014 not caught up`;
    if (reason === "overlap") return `${job ?? "job"}: skipped${at} \u2014 the previous run is still going`;
    // F05.QA-FIX: the grid slot was real but a retry chain from an earlier failure still owns the
    // target. Narrated because this is exactly the case that used to vanish with no row and no event.
    if (reason === "retry-pending") return `${job ?? "job"}: skipped${at} \u2014 a retry of an earlier run is still pending`;
    return null;
  }
  if (kind === "job_run_started" && data["readopted"] === true) {
    return `${job ?? "job"}: re-adopted a run that was still in flight when the daemon restarted`;
  }
  if (kind === "job_run_started" && data["trigger"] === "sleep-wake") {
    const late = wakeGap(data["latenessMs"]);
    const n = typeof data["coalescedOccurrences"] === "number" ? (data["coalescedOccurrences"] as number) : 0;
    const coal = n > 0 ? ` \u00b7 ${n} occurrence${n === 1 ? "" : "s"} coalesced` : "";
    return `${job ?? "job"} ran late${late ? ` by ${late}` : ""} (machine was asleep)${coal}`;
  }
  return null;
}
