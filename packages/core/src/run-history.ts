import {
  isAgentUnseen,
  type HistoryRunsRequest, type HistoryRunsResponse,
  type RunHistoryRow, type RunHistoryCoverage, type RunKind, type RunOutcome, type RunTrigger,
  type TaskRecord, type JobRecord, type JobRunEntry, type SliRollupParams, type SliRollupResult, type SliTaskSummary,
} from "@chimera/protocol";
import { agentRecency, type AgentRecord, type AgentState } from "./supervisor.js";
import type { StepJournalQuery, StepJournalQueryResult } from "./step-journal.js";
import { findProvider } from "./providers/catalog.js";

// F13 (unified run history): a READ-ONLY join over data that already exists elsewhere — agent
// records, task records, job run entries, the F11 step journal, and the F12 span rollup. Modelled
// on evidence.ts's "aggregator, never a second source of truth" discipline: this module has no
// fs write API and calls no save()/append() anywhere (enforced by run-history.test.ts's two
// source-guard tests).
//
// THE cost-triple-counting invariant: a job fires a task, a task dispatches an agent — three rows
// can describe the SAME dollar. Only agent rows are "booked" (AgentRecord.costUsd IS the
// supervisor-metered figure); task/job rows are "rolled-up" (a display-only sum over other rows'
// booked dollars) and are NEVER re-added into totals.costUsd. Softening this — e.g. summing every
// row regardless of costBasis — silently multiplies the reported spend by up to 3x.

export const RUN_HISTORY_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
// 100, not 50: the history_runs tool description promises "the last 24 hours, 100 rows" and an
// MCP caller has no way to see a smaller server-side default — it just silently loses rows.
export const RUN_HISTORY_DEFAULT_LIMIT = 100;
export const RUN_HISTORY_JOURNAL_SCAN_MAX = 2000;

const TERMINAL_AGENT_STATES: ReadonlySet<AgentState> = new Set(["done", "failed", "killed"]);

export type RunHistoryDeps = {
  supervisor: { list(): AgentRecord[] };
  queues: { allTasks(): TaskRecord[] };
  jobs: { list(): JobRecord[] };
  journal: { query(params: StepJournalQuery): StepJournalQueryResult };
  rollup: (params: SliRollupParams) => SliRollupResult;
  now?: () => number;
};

type JournalFold = { costUsd: number; models: Set<string>; steps: number; stepFailures: number };

export class RunHistoryStore {
  constructor(private readonly deps: RunHistoryDeps) {}

  runs(req: HistoryRunsRequest): HistoryRunsResponse {
    const now = this.deps.now?.() ?? Date.now();
    const to = req.to ?? now;
    const from = req.from ?? to - RUN_HISTORY_DEFAULT_WINDOW_MS;

    const { fold: journalFold, entriesScanned, truncated: journalTruncated } = scanJournal(this.deps.journal, from, to);
    const rollup = this.deps.rollup({ from, to });
    // F12 is the ONLY cost left after QueueStore.prune() evicts a task and the journal window
    // rolls past it — without this fallback a pruned task renders $0.00 next to its agent's
    // real spend, which reads as "this task was free" rather than "not in the journal".
    const spansByTask = new Map(rollup.tasks.map((t) => [t.taskId, t] as const));

    const agents = this.deps.supervisor.list().filter((a) => a.shadow !== true);
    const tasks = this.deps.queues.allTasks();
    const jobs = this.deps.jobs.list();

    const agentById = new Map(agents.map((a) => [a.agentId, a] as const));
    const taskByAgentId = new Map<string, TaskRecord>();
    for (const t of tasks) if (t.agentId) taskByAgentId.set(t.agentId, t);
    const jobRunByTaskId = new Map<string, JobRecord>();
    for (const j of jobs) for (const r of j.lastRuns) if (r.taskId) jobRunByTaskId.set(r.taskId, j);

    const rows: RunHistoryRow[] = [
      ...agentRows(agents, taskByAgentId),
      ...taskRows(tasks, agentById, jobRunByTaskId, journalFold, spansByTask),
      ...jobRows(jobs, agentById),
    ];

    const overlapping = rows.filter((r) => rowOverlapsWindow(r, from, to));
    const filtered = overlapping.filter((r) => matchesFilters(r, req));

    filtered.sort((a, b) => (b.startedAt - a.startedAt) || a.id.localeCompare(b.id));

    // F13.QA M-4: failed/unseen are folded HERE, over every matched row, because a UI that
    // reduces over the returned PAGE undercounts as soon as matched > rows.length. costUsd
    // still sums booked rows only — the triple-counting invariant at the top of this file.
    const totals = filtered.reduce(
      (acc, r) => ({
        runs: acc.runs + 1,
        costUsd: r.costBasis === "booked" ? acc.costUsd + r.costUsd : acc.costUsd,
        failed: r.outcome === "failed" ? acc.failed + 1 : acc.failed,
        unseen: r.unseen ? acc.unseen + 1 : acc.unseen,
      }),
      { runs: 0, costUsd: 0, failed: 0, unseen: 0 },
    );

    const limit = req.limit ?? RUN_HISTORY_DEFAULT_LIMIT;
    // A cursor can go stale between pages: `to` defaults to now, so an un-pinned window slides
    // and the cursor row can drop out of it. findIndex would return -1 and hand back page 1
    // again — an MCP caller paging in a loop would never terminate. Empty terminal page instead.
    const cursorIdx = req.cursor ? filtered.findIndex((r) => r.id === req.cursor) : -1;
    const startIdx = req.cursor ? (cursorIdx < 0 ? filtered.length : cursorIdx + 1) : 0;
    const page = filtered.slice(startIdx, startIdx + limit);
    const nextCursor = page.length === limit && startIdx + limit < filtered.length ? page[page.length - 1]!.id : null;

    const coverage: RunHistoryCoverage = {
      agentsScanned: agents.length,
      tasksScanned: tasks.length,
      jobRunsScanned: jobs.reduce((n, j) => n + j.lastRuns.length, 0),
      journalEntries: entriesScanned,
      journalTruncated,
      spanRollupReplayed: rollup.coverage?.replayed ?? false,
      spanRollupTruncated: rollup.coverage?.truncated ?? false,
    };

    return { rows: page, nextCursor, matched: filtered.length, from, to, totals, coverage };
  }
}

function scanJournal(
  journal: RunHistoryDeps["journal"],
  from: number,
  to: number,
): { fold: Map<string, JournalFold>; entriesScanned: number; truncated: boolean } {
  const fold = new Map<string, JournalFold>();
  let entriesScanned = 0;
  let truncated = false;
  let cursor: string | null | undefined = undefined;
  for (;;) {
    const page = journal.query({ from, to, cursor: cursor ?? undefined, limit: 500 });
    for (const e of page.entries) {
      if (entriesScanned >= RUN_HISTORY_JOURNAL_SCAN_MAX) { truncated = true; break; }
      entriesScanned++;
      let f = fold.get(e.taskId);
      if (!f) { f = { costUsd: 0, models: new Set(), steps: 0, stepFailures: 0 }; fold.set(e.taskId, f); }
      f.costUsd += e.costUsd ?? 0;
      if (e.model) f.models.add(e.model);
      f.steps++;
      if (e.outcome === "failed") f.stepFailures++;
    }
    if (truncated || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { fold, entriesScanned, truncated };
}

// A9: "default" is a SPEC placeholder meaning "whatever the provider picks", never a model id —
// usage.ts:59-65 hard-throws if asked to record it. Treat it as absent so the row shows the
// provider default (or null) instead of leaking the placeholder into the history list.
const realModel = (m: string | null | undefined): string | null => (m == null || m === "default" ? null : m);

function resolveAgentModel(a: AgentRecord): string | null {
  return realModel(a.actualModel) ?? realModel(a.spec.model) ?? findProvider(a.provider)?.defaultModel ?? null;
}

/** RunHistoryRowSchema caps `reason` at 200 chars — a longer TaskRecord.error would fail
 *  response validation and take the whole query down with it. */
const truncateReason = (e: string | null | undefined): string | null =>
  e == null ? null : e.length > 200 ? e.slice(0, 200) : e;

function normalizeAgentOutcome(state: AgentState): RunOutcome {
  switch (state) {
    case "done": return "done";
    case "failed": return "failed";
    case "killed": return "killed";
    case "paused": return "running";
    case "running": return "running";
    default: return "running";
  }
}

function normalizeTaskOutcome(state: TaskRecord["state"]): RunOutcome {
  switch (state) {
    case "pending": return "pending";
    case "in_progress": return "running";
    case "done": return "done";
    case "failed": return "failed";
    case "dead_letter": return "failed";
    case "blocked": return "running";
    default: return "running";
  }
}

function normalizeJobOutcome(result: JobRunEntry["result"]): RunOutcome {
  switch (result) {
    case "ok": return "done";
    case "failed": return "failed";
    case "skipped": return "skipped";
    default: return "done";
  }
}

// An agent/task DISPATCHED by a job is triggered by that job ({kind:"job"}); only the job-run
// row itself is the schedule firing and carries `detail` (see jobRows). detail:null everywhere
// here is a fact, not a gap: nothing but the fire path knows why the scheduler fired.
function agentTrigger(a: AgentRecord, taskByAgentId: Map<string, TaskRecord>): RunTrigger {
  if (a.jobName) return { kind: "job", ref: a.jobName, detail: null };
  const task = taskByAgentId.get(a.agentId);
  if (task) return { kind: "task", ref: task.taskId, detail: null };
  if (a.parentId) return { kind: "agent", ref: a.parentId, detail: null };
  if (a.depth === 0) return { kind: "operator", ref: null, detail: null };
  return { kind: "unknown", ref: null, detail: null };
}

function taskTrigger(t: TaskRecord, agentById: Map<string, AgentRecord>, jobRunByTaskId: Map<string, JobRecord>): RunTrigger {
  const job = jobRunByTaskId.get(t.taskId);
  if (job) return { kind: "job", ref: job.name, detail: null };
  if (t.pushedBy && agentById.has(t.pushedBy)) return { kind: "agent", ref: t.pushedBy, detail: null };
  if (t.pushedBy) return { kind: "operator", ref: t.pushedBy, detail: null };
  return { kind: "unknown", ref: null, detail: null };
}

function agentRows(agents: AgentRecord[], taskByAgentId: Map<string, TaskRecord>): RunHistoryRow[] {
  return agents.map((a) => {
    const terminal = TERMINAL_AGENT_STATES.has(a.state);
    const endedAt = terminal ? agentRecency(a) : null;
    const lastAttempt = a.attempts[a.attempts.length - 1];
    return {
      id: `agent:${a.agentId}`,
      kind: "agent" as RunKind,
      subject: a.displayLabel ?? a.agentId,
      trigger: agentTrigger(a, taskByAgentId),
      model: resolveAgentModel(a),
      costUsd: a.costUsd,
      costBasis: "booked" as const,
      outcome: normalizeAgentOutcome(a.state),
      reason: terminal && a.state !== "done" ? (lastAttempt?.errorClass ?? null) : null,
      startedAt: a.createdAt,
      endedAt,
      durationMs: endedAt !== null ? endedAt - a.createdAt : null,
      unseen: isAgentUnseen(a),
      queue: null,
      team: a.membership?.team ?? null,
      jobName: a.jobName ?? null,
      agentId: a.agentId,
      taskId: taskByAgentId.get(a.agentId)?.taskId ?? null,
      steps: null,
      stepFailures: null,
    };
  });
}

function taskRows(
  tasks: TaskRecord[],
  agentById: Map<string, AgentRecord>,
  jobRunByTaskId: Map<string, JobRecord>,
  journalFold: Map<string, JournalFold>,
  spansByTask: Map<string, SliTaskSummary>,
): RunHistoryRow[] {
  return tasks.map((t) => {
    const boundAgent = t.agentId ? agentById.get(t.agentId) : undefined;
    const fold = journalFold.get(t.taskId);
    const models = fold ? [...fold.models] : [];
    return {
      id: `task:${t.taskId}`,
      kind: "task" as RunKind,
      subject: t.prompt.length > 80 ? `${t.prompt.slice(0, 80)}…` : t.prompt,
      trigger: taskTrigger(t, agentById, jobRunByTaskId),
      model: models.length === 1 ? models[0]! : null,
      // F13.QA M-2: MAX, never a sum. The journal fold, the F12 span rollup and the bound
      // agent's booked figure are three finer/coarser views of the SAME dollars, so adding
      // them inflates the displayed roll-up; max only guarantees a task never reads BELOW the
      // agent it is bound to (the reported "$2.50 agent under a $0.00 ↺ task"). Only the
      // directly bound agent counts — a descendant sub-agent may be bound to another task and
      // would then be attributed twice. Still costBasis:"rolled-up", so totals exclude it.
      costUsd: Math.max(fold?.costUsd ?? spansByTask.get(t.taskId)?.costUsd ?? 0, boundAgent?.costUsd ?? 0),
      costBasis: "rolled-up" as const,
      outcome: normalizeTaskOutcome(t.state),
      reason: truncateReason(t.error),
      startedAt: t.startedAt ?? t.createdAt,
      endedAt: t.endedAt ?? null,
      durationMs: t.endedAt !== undefined && t.startedAt !== undefined ? t.endedAt - t.startedAt : null,
      unseen: boundAgent ? isAgentUnseen(boundAgent) : false,
      queue: t.queue,
      team: boundAgent?.membership?.team ?? null,
      jobName: jobRunByTaskId.get(t.taskId)?.name ?? null,
      agentId: t.agentId ?? null,
      taskId: t.taskId,
      steps: fold?.steps ?? null,
      stepFailures: fold?.stepFailures ?? null,
    };
  });
}

function jobRows(jobs: JobRecord[], agentById: Map<string, AgentRecord>): RunHistoryRow[] {
  const rows: RunHistoryRow[] = [];
  for (const job of jobs) {
    for (const run of job.lastRuns) {
      const boundAgent = run.agentId ? agentById.get(run.agentId) : undefined;
      rows.push({
        id: `job:${job.name}:${run.ts}:${run.attempt}`,
        kind: "job",
        subject: job.name,
        // F13.QA M-1: a job row IS the schedule firing, so it answers WHY it fired —
        // JobRunEntry.trigger already records scheduled/manual/catchup/sleep-wake, and
        // {kind:"job"} threw that away.
        trigger: { kind: "schedule", ref: job.name, detail: run.trigger },
        model: boundAgent ? resolveAgentModel(boundAgent) : null,
        costUsd: run.costUsd,
        costBasis: "rolled-up",
        outcome: normalizeJobOutcome(run.result),
        reason: run.error ?? null,
        startedAt: run.ts,
        endedAt: run.ts,
        durationMs: null,
        unseen: false,
        queue: null,
        team: boundAgent?.membership?.team ?? null,
        jobName: job.name,
        agentId: run.agentId,
        taskId: run.taskId,
        steps: null,
        stepFailures: null,
      });
    }
  }
  return rows;
}

function rowOverlapsWindow(r: RunHistoryRow, from: number, to: number): boolean {
  const rowEnd = r.endedAt ?? Number.POSITIVE_INFINITY;
  return r.startedAt <= to && rowEnd >= from;
}

/** Canonical name first, then the back-compat scalar alias; a scalar widens to a 1-element set. */
const asSet = <T,>(many: readonly T[] | undefined, one: T | undefined): ReadonlySet<T> | null => {
  const list = many ?? (one === undefined ? undefined : [one]);
  return list && list.length > 0 ? new Set(list) : null;
};

function matchesFilters(r: RunHistoryRow, req: HistoryRunsRequest): boolean {
  // F13.QA M-3: kinds/outcome are multi-select and applied HERE, over the whole window —
  // a UI re-filtering the returned page would silently drop matches beyond `limit`.
  const kinds = asSet(req.kinds, req.kind);
  const outcomes = asSet(Array.isArray(req.outcome) ? req.outcome : undefined, Array.isArray(req.outcome) ? undefined : req.outcome);
  const job = req.job ?? req.jobName;
  if (kinds && !kinds.has(r.kind)) return false;
  if (outcomes && !outcomes.has(r.outcome)) return false;
  if (req.queue && r.queue !== req.queue) return false;
  if (job && r.jobName !== job) return false;
  if (req.team && r.team !== req.team) return false;
  if (req.model && r.model !== req.model) return false;
  if (req.unseenOnly && !r.unseen) return false;
  return true;
}
