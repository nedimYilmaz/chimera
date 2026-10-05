import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { QueueSpecSchema, TaskRecordSchema, type QueueSpec, type TaskRecord, type TaskState, type TaskSummary, type QueueStatusSummary, type TaskStepCheckpoint, type ErrorClassName, type RetryPolicy, type HookCause } from "@chimera/protocol";
import type { EventLog } from "./events.js";
import type { StepJournal } from "./step-journal.js";
import { writeFileDurable } from "./durable-write.js";

const DEFAULT_SUMMARY_PAGE = 25;
const toTaskSummary = (t: TaskRecord): TaskSummary => ({
  id: t.taskId, state: t.state,
  subject: t.prompt.length > 80 ? `${t.prompt.slice(0, 80)}…` : t.prompt,
  // DENIED-TOOL-CALL-INVISIBLE: conditionally spread (never `: false`) — TaskSummarySchema is
  // `.strict()` and token-opt-p1-summary.test.ts asserts an EXACT key set for a plain task, so
  // the key must be OMITTED, not present-and-false, on every task that never hit a denial.
  ...(t.toolPolicyDenied ? { toolPolicyDenied: true } : {}),
  // TASK-TAGS: same conditional-spread discipline as toolPolicyDenied just above — the key is
  // OMITTED, never present-and-empty, so an untagged task's summary keeps its exact prior key set.
  ...(t.tags.length > 0 ? { tags: t.tags } : {}),
});

export class UnknownQueueError extends Error { code = "protocol" as const; name = "UnknownQueueError"; }
export class UnknownTaskError extends Error { code = "protocol" as const; name = "UnknownTaskError"; }
export class DuplicateQueueError extends Error { code = "protocol" as const; name = "DuplicateQueueError"; }
// D11: queue.delete is refused while any non-terminal task remains (pending/in_progress/
// blocked) — the caller must cancel them first rather than silently orphaning them.
export class QueueNotEmptyError extends Error { code = "protocol" as const; name = "QueueNotEmptyError"; }

// D12 (task workflows): `workflow` here is the QUEUE's default binding patch (a raw
// name/null), not the pinned {name,version} a task carries — see TaskPush.workflow.
export type QueueUpdateInput = { retryLimit?: number; workflow?: string | null; retryPolicy?: RetryPolicy };

// WD Stage 1 (coverage B9): `pushedBy` is the calling agent's id when the push came
// through the chimera MCP (stamped from CHIMERA_AGENT_ID at the tool, mirroring how
// team_create stamps TeamSpec.createdBy); absent/null for a direct/human push.
// D12: `workflow` is a per-task OVERRIDE of the queue's own default binding — the raw
// requested name, resolved+pinned to a specific version only at pickup (QueueScheduler).
// WorkflowGraph: `parentTaskId` is engine-internal only (set by scheduler.ts's beginFanOut when
// pushing a fan-out BRANCH task) — never forwarded by engine.ts's queue.push RPC handler literal
// (confirmed by reading it), so a caller can never fabricate a fake parent/child relationship.
// PLAN-HOOKS.md §3.3 (HOOK-4): `cause` is engine-internal only, stamped by HookEngine's `push`
// action — never forwarded by engine.ts's queue.push RPC handler literal (mirrors parentTaskId's
// own convention above), so a caller can never fabricate a fake causation chain.
export type TaskPush = { taskId?: string; prompt: string; tags?: string[]; priority?: number; role?: string | null; overrides?: Record<string, unknown>; dependsOn?: string[]; pushedBy?: string | null; originConductorId?: string | null; workflow?: string | null; parentTaskId?: string; cause?: HookCause | null };

export class UnknownDependencyError extends Error { code = "protocol" as const; name = "UnknownDependencyError"; }
// RETRY-BACKOFF: queue.requeue is the only way out of "dead_letter" — thrown when called on a
// task that isn't currently dead-lettered.
export class TaskNotDeadLetteredError extends Error { code = "protocol" as const; name = "TaskNotDeadLetteredError"; }
// TASK-EDIT-VERSIONING: only pending/blocked tasks are editable — an in_progress/terminal task's
// prompt was already consumed by its assigned agent, so an in-place edit would silently diverge
// from what actually ran. Thrown by editTask() on any other state. QUEUE-REORDER: moveTask() and
// addDependency() below reuse this SAME error/constraint — a task whose prompt was already
// consumed can't have its scheduling position or dependency graph safely rewritten either.
export class TaskNotEditableError extends Error { code = "protocol" as const; name = "TaskNotEditableError"; }
// QUEUE-REORDER: retryTask() is the operator's "don't make me retype the brief" recovery path —
// only a terminal-with-error task (failed or dead_letter) is retryable; a pending/blocked/
// in_progress/done task has nothing to recover from.
export class TaskNotRetryableError extends Error { code = "protocol" as const; name = "TaskNotRetryableError"; }
// QUEUE-REORDER: addDependency() rejects a self-dependency or any dependency whose OWN transitive
// dependsOn chain already reaches back to the task being edited — push() can never construct a
// cycle (a dep must already exist before a task references it), but addDependency is the first
// way to add an edge to an ALREADY-existing task, so the DAG invariant needs an explicit check here.
export class DependencyCycleError extends Error { code = "protocol" as const; name = "DependencyCycleError"; }

// AGENT-INITIATED-REMEDIATION: thrown by setPendingRemediationRequest for the structural checks
// that need no WorkflowStore lookup (task exists, is workflow-bound, and the caller IS the
// task's current step agent) — the workflow-shape checks (policy configured, target step
// order/existence/fanOut) are validated by engine.ts's queue.requestRemediation handler, the
// only caller with WorkflowStore access, which throws this SAME class for consistency.
export class RemediationRequestInvalidError extends Error { code = "protocol" as const; name = "RemediationRequestInvalidError"; }

// TASK-EDIT-VERSIONING: the sparse patch editTask() accepts. `workflow` maps to
// TaskRecord.workflowOverride (matching queue.push's own `workflow` field). Only keys the caller
// explicitly set are present; an absent key is left untouched. dependsOn editing is deliberately
// out of scope (see editTask's note).
export type TaskEditPatch = { prompt?: string; role?: string | null; priority?: number; overrides?: Record<string, unknown>; workflow?: string | null; tags?: string[] };

const MAX_TERMINAL_PER_QUEUE = 200;   // accepted v1 bound: oldest done/failed tasks are evicted on save

// TASK-EDIT-VERSIONING: structural equality for a task's `overrides` bag (JSON-shaped values only —
// object/array/primitive/null, no Dates/functions/cycles, guaranteed by TaskRecordSchema). Used so
// an edit that re-sends an equivalent overrides object isn't recorded as a spurious change. Order-
// independent for object keys; order-sensitive for arrays (list order is meaningful).
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ak = Object.keys(ao), bk = Object.keys(bo);
  return ak.length === bk.length && ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

// QUEUE-REORDER: the exact comparator nextPending uses to decide drain order (priority desc,
// then orderKey asc) — hoisted to module scope so moveTask can compute the SAME ordering when
// finding a task's neighbours. This is the single source of truth for "what order will this
// queue actually drain in"; every drain-order-aware caller (nextPending, moveTask) must go
// through this, never re-derive its own sort.
function compareDrainOrder(a: TaskRecord, b: TaskRecord): number {
  return b.priority - a.priority || a.orderKey - b.orderKey;
}

export class QueueStore {
  private queues = new Map<string, QueueSpec>();
  private tasks = new Map<string, TaskRecord>();     // Map preserves insertion order → stable FIFO
  private file: string;
  // QUEUE-REORDER: monotonically increasing, seeded post-load (below) from the highest orderKey
  // already on disk — every push() stamps the next value, guaranteeing orderKey is unique across
  // the WHOLE store (not just per-queue; simpler, and correctness only needs uniqueness within a
  // queue, which a global counter trivially provides too).
  private orderCounter = 0;
  private maxTerminalPerQueue: number;
  // F11: optional on purpose — the journal is pure observability, so every existing
  // `new QueueStore(dir, events)` call site (tests, tools) keeps working unjournalled.
  private journal?: StepJournal;

  constructor(dir: string, private events: EventLog, opts?: { maxTerminalPerQueue?: number; journal?: StepJournal }) {
    this.maxTerminalPerQueue = opts?.maxTerminalPerQueue ?? MAX_TERMINAL_PER_QUEUE;
    this.journal = opts?.journal;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "queues.json");
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as { queues: unknown[]; tasks: unknown[] };
        for (const qs of raw.queues) { const s = QueueSpecSchema.parse(qs); this.queues.set(s.name, s); }
        for (const t of raw.tasks) { const r = TaskRecordSchema.parse(t); this.tasks.set(r.taskId, r); }
      } catch (err) {
        // AUDIT-2: unlike teams.json/toolpolicy.json (security-relevant, fail-fast on
        // purpose), queues.json is operational state — crash-looping the daemon over a
        // torn/corrupt file would just make things worse. Quarantine it (rename with a
        // timestamp so it's preserved for inspection) and boot with an empty store,
        // mirroring events.ts's tolerant handling of torn lines.
        this.queues.clear();
        this.tasks.clear();
        const quarantined = `${this.file}.corrupt-${Date.now()}`;
        renameSync(this.file, quarantined);
        console.warn(`chimerad: corrupt coordination state in ${this.file}: ${(err as Error).message} — quarantined to ${quarantined}, booting with an empty queue store`);
      }
    }
    // QUEUE-REORDER: normalize orderKey once at boot — every task (per queue) gets a fresh
    // sequential value, assigned in the order its PRE-normalization sort already implies
    // (priority desc, orderKey asc, then original insertion/array order as the final
    // tiebreak — the exact old Array.sort-stability behavior). This is a fixed point for
    // already-normalized data (reassigning sequential values in the same relative order
    // can't reorder anything); its real job is a one-time migration for tasks persisted
    // before this field existed, which all parse to the schema default (0) and would
    // otherwise collide — a moveTask() swap on two same-0 tasks would silently no-op.
    // In-memory only (no forced save()): the next boot recomputes the identical result.
    for (const name of this.queues.keys()) {
      const ordered = [...this.tasks.values()]
        .map((t, i) => ({ t, i }))
        .filter((x) => x.t.queue === name)
        .sort((a, b) => compareDrainOrder(a.t, b.t) || a.i - b.i)
        .map((x) => x.t);
      for (const t of ordered) t.orderKey = this.orderCounter++;
    }
    let reverted = false;
    for (const t of this.tasks.values()) {
      if (t.state !== "in_progress") continue;
      const prevState = t.state;
      t.state = "pending"; t.agentId = null; reverted = true;   // spec §3: interrupted tasks revert to pending
      this.emitTask(t, { reason: "daemon-restart" }, prevState);
    }
    // Task DEP1: heal any blocked task whose dependencies resolved while the daemon
    // was down (a crash between markDone/markFailed and its dependent reconcile would
    // otherwise leave the dependent parked forever). Snapshot first — markFailed
    // mutates the map via cascade.
    for (const t of [...this.tasks.values()]) {
      if (t.state !== "blocked") continue;
      if (this.anyDepFailed(t)) { this.markFailed(t.taskId, "dependency failed"); reverted = true; }
      else if (this.depsSatisfied(t)) {
        const prevState = t.state;
        t.state = "pending"; reverted = true; this.emitTask(t, { unblocked: true }, prevState);
      }
    }
    if (reverted) this.save();
  }

  private prune(): void {
    // BUG FIX (WorkflowGraph join): a terminal task can still be a live dependency —
    // an uneven fan-out's fast branch goes "done" while its join parent stays
    // "blocked" waiting on a slower sibling. Evicting the fast branch in the meantime
    // makes depsSatisfied() see a MISSING dep (treated as unsatisfied) instead of a
    // done one, so the join would never unblock. Exclude anything a live
    // (non-terminal) task's dependsOn still points at.
    const referenced = new Set<string>();
    for (const t of this.tasks.values()) {
      if (t.state === "done" || t.state === "failed") continue;
      for (const depId of t.dependsOn) referenced.add(depId);
    }
    for (const name of this.queues.keys()) {
      const terminal = [...this.tasks.values()].filter(
        (t) => t.queue === name && (t.state === "done" || t.state === "failed") && !referenced.has(t.taskId),
      );
      for (const evict of terminal.slice(0, Math.max(0, terminal.length - this.maxTerminalPerQueue)))
        this.tasks.delete(evict.taskId);           // insertion order → slice(0, overflow) is the oldest
    }
  }

  private save(): void {
    this.prune();
    const tmp = `${this.file}.tmp`;                // write-to-temp-then-rename: no torn writes on power loss
    writeFileSync(tmp, JSON.stringify({ queues: [...this.queues.values()], tasks: [...this.tasks.values()] }, null, 2));
    renameSync(tmp, this.file);
  }

  // FEATURE-2: checkpoint persistence specifically routes through FEATURE-4's crash-safe
  // writeFileDurable (temp write + fsync + atomic rename + fsync the containing dir) instead of
  // the plain save() above. A checkpoint's whole POINT is surviving a crash that lands between
  // "captured" and whatever the next ordinary save happens to be — unlike routine task-state
  // saves (which already tolerate an in_progress -> pending revert on restart, see the
  // constructor above), silently losing a just-captured checkpoint to a torn rename would
  // defeat this feature. Deliberately NOT applied to every save() — that would add two fsyncs
  // to EVERY task mutation (push/markInProgress/markDone/...), exactly the write-amplification
  // FEATURE-4's SnapshotScheduler was built to avoid for AgentRecord snapshots; checkpoint
  // writes are comparatively rare (once per fresh step-agent bind, not once per event).
  private saveDurable(): void {
    this.prune();
    writeFileDurable(this.file, JSON.stringify({ queues: [...this.queues.values()], tasks: [...this.tasks.values()] }, null, 2));
  }

  // PLAN-HOOKS.md §5 (HOOK-1): `prevState` — pass the task's state as it was BEFORE this
  // transition's mutation (or `null` for a freshly created task) to also emit
  // `task_state_changed` (+ `queue_drained` when this transition is the one that empties the
  // queue of pending/in_progress/blocked work). Omitted (undefined, the default) for the sites
  // that call emitTask without t.state having actually changed (editTask's edited:true) — no
  // state-change event fires for those.
  private emitTask(t: TaskRecord, extra: Record<string, unknown> = {}, prevState?: TaskState | null): void {
    this.events.append({
      agentId: `task:${t.taskId}`, kind: "status",
      // FEATURE-9 (attention inbox): `error`/`subject` ride every transition (not just
      // failures) so a client never needs a second queue.status round-trip to explain a
      // failed/blocked row — `subject` reuses toTaskSummary's own truncation, `error` is
      // TaskRecord.error verbatim (null outside a failure). Additive: ignored by every
      // pre-existing loose-record consumer.
      data: { queue: t.queue, taskId: t.taskId, state: t.state, attempts: t.attempts,
              priority: t.priority, agentId: t.agentId, error: t.error,
              subject: toTaskSummary(t).subject, tags: t.tags, ...extra },
    });
    // code-review A1: some call sites (markFailedAttempt's parked retry, blockOnChildren/
    // extendChildren's recomputeDepState) can land back on the SAME state (e.g. in_progress ->
    // in_progress, blocked -> blocked) — skip the no-op so a future subscriber never sees a
    // "transition" that didn't transition.
    if (prevState === undefined || prevState === t.state) return;
    this.events.append({
      agentId: `task:${t.taskId}`, kind: "task_state_changed",
      // TASK-TAGS: `tags` rides EVERY state change because this is the event topics.ts turns
      // into the `task.state` payload a hook/subscription filter reads — without it,
      // `filter: {tags:[...]}` matched nothing at all (TopicFilterSchema has declared the field
      // since HOOK-1; only memory.added ever produced one).
      data: { queue: t.queue, taskId: t.taskId, state: t.state, prevState, tags: t.tags,
              ...(t.state === "done" ? { resultPreview: t.resultText?.slice(0, 2000) ?? null } : {}) },
    });
    // queue_drained: only relevant when this transition is the one crossing OUT of the
    // "active" set (pending/in_progress/blocked) — a task that was already inactive, or one
    // that stays active, can never be the transition that empties the queue. dead_letter tasks
    // don't count as active (PLAN-HOOKS.md §5 verbatim) — they survive independently of drain
    // status until queue.requeue.
    const ACTIVE: TaskState[] = ["pending", "in_progress", "blocked"];
    const wasActive = prevState !== null && ACTIVE.includes(prevState);
    const isActive = ACTIVE.includes(t.state);
    if (wasActive && !isActive) {
      const stillActive = [...this.tasks.values()].some((x) => x.queue === t.queue && ACTIVE.includes(x.state));
      if (!stillActive) this.events.append({ agentId: `queue:${t.queue}`, kind: "queue_drained", data: { queue: t.queue } });
    }
  }

  private task(taskId: string): TaskRecord {
    const t = this.tasks.get(taskId);
    if (!t) throw new UnknownTaskError(`unknown task ${taskId}`);
    return t;
  }

  create(input: unknown): QueueSpec {
    const spec = QueueSpecSchema.parse(input);
    if (this.queues.has(spec.name)) throw new DuplicateQueueError(`queue "${spec.name}" already exists`);
    this.queues.set(spec.name, spec);
    this.save();
    this.events.append({ agentId: `queue:${spec.name}`, kind: "status", data: { queue: spec.name, state: "created", retryLimit: spec.retryLimit } });
    return spec;
  }

  get(name: string): QueueSpec {
    const q = this.queues.get(name);
    if (!q) throw new UnknownQueueError(`unknown queue "${name}"`);
    return q;
  }

  list(): QueueSpec[] { return [...this.queues.values()]; }

  // F11: every task still resident in the store, for the boot-time journal backfill —
  // list()/summary() are queue- and page-scoped, the backfill needs the whole set.
  allTasks(): TaskRecord[] { return [...this.tasks.values()]; }

  update(name: string, patch: QueueUpdateInput): QueueSpec {
    const existing = this.get(name);   // throws UnknownQueueError
    const spec = QueueSpecSchema.parse({
      ...existing,
      ...(patch.retryLimit !== undefined ? { retryLimit: patch.retryLimit } : {}),
      ...(patch.workflow !== undefined ? { workflow: patch.workflow } : {}),
      ...(patch.retryPolicy !== undefined ? { retryPolicy: patch.retryPolicy } : {}),
    });
    this.queues.set(name, spec);
    this.save();
    this.events.append({ agentId: `queue:${name}`, kind: "status", data: { queue: name, state: "updated", retryLimit: spec.retryLimit } });
    return spec;
  }

  // QUEUE-PAUSE: pause/resume a queue's drain — persisted in QueueSpec.paused (same
  // temp+rename snapshot as every other spec mutation, so a daemon restart reloads it) and
  // enforced by scheduler.ts's tick(): nextPending still runs first, but the queueNotPaused
  // predicate then stops the drain for that queue — running agents finish naturally, pending
  // tasks stay pending. Unconditional (always saves +
  // emits, even re-pausing an already-paused queue), mirroring update()'s own convention — the
  // caller gets a fresh confirmed snapshot either way, and a duplicate event is harmless.
  pause(name: string): QueueSpec {
    const spec = { ...this.get(name), paused: true };   // throws UnknownQueueError
    this.queues.set(name, spec);
    this.save();
    this.events.append({ agentId: `queue:${name}`, kind: "queue_paused", data: { queue: name } });
    return spec;
  }

  resume(name: string): QueueSpec {
    const spec = { ...this.get(name), paused: false };   // throws UnknownQueueError
    this.queues.set(name, spec);
    this.save();
    this.events.append({ agentId: `queue:${name}`, kind: "queue_resumed", data: { queue: name } });
    return spec;
  }

  // Idempotent: deleting an already-gone queue returns false, not an error. A queue
  // with any non-terminal task is refused outright — done/failed tasks are dropped
  // from the store (their history survives in the append-only events log).
  delete(name: string): boolean {
    if (!this.queues.has(name)) return false;
    const active = [...this.tasks.values()].some((t) => t.queue === name && t.state !== "done" && t.state !== "failed");
    if (active) throw new QueueNotEmptyError(`queue "${name}" has pending or in-progress tasks — cancel them first`);
    for (const t of [...this.tasks.values()]) if (t.queue === name) this.tasks.delete(t.taskId);
    this.queues.delete(name);
    this.save();
    this.events.append({ agentId: `queue:${name}`, kind: "status", data: { queue: name, state: "deleted" } });
    return true;
  }

  push(queueName: string, input: TaskPush): TaskRecord {
    this.get(queueName);
    // Reserved deterministic IDs are an internal import seam, never a public push option.
    if (input.taskId !== undefined && !/^gh-[a-f0-9]{64}$/.test(input.taskId)) throw new UnknownTaskError("invalid import task identity");
    const dependsOn = input.dependsOn ?? [];
    // DEP1: every dependency must reference an EXISTING task in the SAME queue. This
    // also makes cycles structurally impossible (a task can only depend on tasks that
    // already exist, and dependsOn is fixed at creation).
    for (const depId of dependsOn) {
      const dep = this.tasks.get(depId);
      if (!dep || dep.queue !== queueName)
        throw new UnknownDependencyError(`unknown dependency "${depId}" in queue "${queueName}"`);
    }
    if (input.taskId && this.tasks.has(input.taskId)) {
      const existing = this.task(input.taskId);
      const expected = { queue: queueName, prompt: input.prompt, tags: input.tags ?? [], role: input.role ?? null,
        overrides: input.overrides ?? {}, priority: input.priority ?? 0, dependsOn,
        pushedBy: input.pushedBy ?? null, originConductorId: input.originConductorId ?? null,
        workflowOverride: input.workflow ?? null, parentTaskId: input.parentTaskId ?? null, cause: input.cause ?? null };
      const actual = Object.fromEntries(Object.keys(expected).map(k => [k, existing[k as keyof TaskRecord]]));
      if (!deepEqual(actual, expected)) throw new UnknownTaskError("import identity belongs to a different task or queue");
      return existing;
    }
    // Initial state from the deps' current states: any already-failed dep → the new
    // task is dead on arrival (cascade at creation); not-all-done → blocked; else the
    // normal pending. A task with no deps is always pending — unchanged behavior.
    const anyFailed = dependsOn.some((id) => this.tasks.get(id)!.state === "failed");
    const allDone = dependsOn.every((id) => this.tasks.get(id)!.state === "done");
    const state: TaskState = anyFailed ? "failed" : allDone ? "pending" : "blocked";
    // WD Stage 1 (coverage B9): one Date.now() feeds BOTH createdAt and pushedAt — the
    // "defaulted to createdAt semantics" contract, made literal at the only stamp site.
    const now = Date.now();
    const task = TaskRecordSchema.parse({
      taskId: input.taskId ?? randomUUID(), queue: queueName, prompt: input.prompt,
      tags: input.tags ?? [],
      role: input.role ?? null, overrides: input.overrides ?? {},
      priority: input.priority ?? 0, orderKey: this.orderCounter++, createdAt: now,
      pushedBy: input.pushedBy ?? null, originConductorId: input.originConductorId ?? null, pushedAt: now,
      dependsOn, state, ...(anyFailed ? { error: "dependency failed" } : {}),
      workflowOverride: input.workflow ?? null,
      parentTaskId: input.parentTaskId ?? null,
      cause: input.cause ?? null,
    });
    this.tasks.set(task.taskId, task);
    // The issue reservation must never outlive an unflushed task after a power loss.
    if (input.taskId) this.saveDurable(); else this.save();
    this.emitTask(task, {}, null);
    return task;
  }

  nextPending(queueName: string): TaskRecord | null {
    this.get(queueName);
    // DEP1: `state === "pending"` already excludes blocked tasks; the depsSatisfied
    // check is belt-and-suspenders against any state drift (a pending task must never
    // be dequeued while a dependency is unfinished).
    const pending = [...this.tasks.values()].filter(
      (t) => t.queue === queueName && t.state === "pending" && this.depsSatisfied(t),
    );
    pending.sort(compareDrainOrder);
    return pending[0] ?? null;
  }

  // DEP1 helpers. A missing dep id can't occur for a live blocked/pending task:
  // push validates existence, and prune() (above) refuses to evict any terminal task
  // still named in a non-terminal task's dependsOn — so a still-unresolved dep is
  // always present, even across uneven fan-out timing (see prune()'s comment).
  private depsSatisfied(t: TaskRecord): boolean {
    return t.dependsOn.every((id) => this.tasks.get(id)?.state === "done");
  }
  private anyDepFailed(t: TaskRecord): boolean {
    return t.dependsOn.some((id) => this.tasks.get(id)?.state === "failed");
  }

  // A dependency reached "done": promote any blocked dependent whose deps are now ALL
  // satisfied to "pending" so the scheduler picks it up on the next tick.
  private reconcileDependents(doneId: string): void {
    for (const t of [...this.tasks.values()]) {
      if (t.state !== "blocked" || !t.dependsOn.includes(doneId)) continue;
      if (this.depsSatisfied(t)) {
        const prevState = t.state;
        t.state = "pending"; this.save(); this.emitTask(t, { unblocked: true }, prevState);
      }
    }
  }

  // A dependency reached terminal "failed": cascade-fail every not-yet-terminal
  // dependent (transitively, since markFailed re-enters here for each). Snapshot the
  // dependents first — markFailed mutates (and save→prune may delete) the task map.
  private cascadeFailDependents(failedId: string): void {
    const dependents = [...this.tasks.values()].filter(
      (t) => t.dependsOn.includes(failedId) && (t.state === "blocked" || t.state === "pending"),
    );
    for (const t of dependents) this.markFailed(t.taskId, `dependency ${failedId.slice(0, 8)} failed`);
  }

  markInProgress(taskId: string, agentId: string): TaskRecord {
    const t = this.task(taskId);
    const prevState = t.state;
    t.state = "in_progress"; t.agentId = agentId;
    // TASK-STAMPS: first pickup only — a retry re-entering markInProgress must not
    // clobber the original startedAt (queue-latency = startedAt - pushedAt would
    // otherwise be silently overwritten by the LAST attempt instead of the first).
    if (t.startedAt === undefined) t.startedAt = Date.now();
    this.save(); this.emitTask(t, {}, prevState);
    return t;
  }

  getTask(taskId: string): TaskRecord { return this.task(taskId); }

  // D12 (task workflows): PIN a resolved {name, version} onto a task the moment it's
  // picked up — never called again for that task afterward (see WorkflowStore's "editing
  // a workflow never mutates running tasks" contract). Resets the step cursor to 0.
  pinWorkflow(taskId: string, workflow: TaskRecord["workflow"]): TaskRecord {
    const t = this.task(taskId);
    t.workflow = workflow; t.stepIndex = 0; t.stepAttempts = 0;
    this.save();
    return t;
  }

  // A step's gate PASSED: move the cursor forward and reset the per-step retry counter.
  // Also clears branchChildren — it's only meaningful for the join step's OWN pickup
  // (scheduler.ts's mergeSummaryText); once we advance past that step, a stale non-empty
  // branchChildren would otherwise get read by mergeSummaryText again on a re-dispatch of
  // whatever step comes next (retry after a failed attempt, or a daemon-restart resume).
  // fanOutRemaining is cleared for the same stale-state-hygiene reason — provably always []
  // by the time the join step's gate evaluates (a windowed fan-out only reverts to "pending"
  // once every wave is admitted — see pendingFanOuts()/extendChildren below), but explicit
  // beats implicit.
  advanceStep(taskId: string, stepIndex: number): TaskRecord {
    const t = this.task(taskId);
    t.stepIndex = stepIndex; t.stepAttempts = 0; t.branchChildren = []; t.fanOutRemaining = [];
    this.save();
    return t;
  }

  // A step's gate FAILED and onFail:"retry" is re-running it — consume one retry.
  incrementStepAttempts(taskId: string): TaskRecord {
    const t = this.task(taskId);
    t.stepAttempts += 1;
    this.save();
    return t;
  }

  // Bounded loops (iterate-until gate): consumes one round of a SPECIFIC loop-back edge's
  // maxIterations budget — keyed by the edge's OWNING step id (mirrors incrementStepAttempts'
  // "consume one retry" role, but a fully orthogonal counter — see TaskRecordSchema.
  // loopIterations).
  incrementLoopIterations(taskId: string, stepId: string): TaskRecord {
    const t = this.task(taskId);
    t.loopIterations = { ...t.loopIterations, [stepId]: (t.loopIterations[stepId] ?? 0) + 1 };
    this.save();
    return t;
  }

  // GATE-REMEDIATION-LOOP: consume one remediation ROUND for `gateStepIndex`'s current
  // fail-remediate-refail loop — resets the counter first if this is a DIFFERENT gate step
  // than the one currently anchored (a fresh loop, not a continuation of a stale one).
  incrementRemediationRounds(taskId: string, gateStepIndex: number): TaskRecord {
    const t = this.task(taskId);
    if (t.remediationGateStep !== gateStepIndex) { t.remediationRounds = 0; t.remediationGateStep = gateStepIndex; }
    t.remediationRounds += 1;
    this.save();
    return t;
  }

  // GATE-REMEDIATION-LOOP: called on every passing gate — clears a completed/abandoned
  // remediation loop's anchor. No-op (no save) when nothing is anchored, the common case.
  resetRemediation(taskId: string): TaskRecord {
    const t = this.task(taskId);
    if (t.remediationGateStep !== null) { t.remediationGateStep = null; t.remediationRounds = 0; this.save(); }
    return t;
  }

  // AGENT-INITIATED-REMEDIATION: records a step agent's mid-turn request (engine.ts's
  // queue.requestRemediation handler has already resolved the workflow-shape checks — policy
  // configured, target step exists/earlier/not-a-dispatch-node — before calling this). Only the
  // checks that need NO WorkflowStore lookup live here: the task must be workflow-bound and
  // in_progress under the REQUESTING agent specifically — a null `requestedBy` (direct/human/
  // operator call) is exempted from the latter, mirroring editTask's own editedBy:null convention.
  setPendingRemediationRequest(
    taskId: string, req: { targetStepId: string; brief: string; requestedBy: string | null },
  ): TaskRecord {
    const t = this.task(taskId);
    if (t.workflow === null) throw new RemediationRequestInvalidError(`task ${taskId} is not workflow-bound`);
    if (t.state !== "in_progress") throw new RemediationRequestInvalidError(`task ${taskId} is not in_progress (state: ${t.state})`);
    if (req.requestedBy !== null && t.agentId !== req.requestedBy) {
      throw new RemediationRequestInvalidError(`only task ${taskId}'s current step agent (${t.agentId ?? "none"}) may request remediation, not ${req.requestedBy}`);
    }
    t.pendingRemediationRequest = req;
    this.save();
    return t;
  }

  // AGENT-INITIATED-REMEDIATION: consumed by scheduler.ts's handleWorkflowTurn the instant this
  // turn completes, whether the request converts into an actual jump or is found stale
  // (workflow/step moved underneath the agent since it called queue.requestRemediation) — a
  // pending request is a ONE-SHOT signal, never left to leak into a later, unrelated turn.
  clearPendingRemediationRequest(taskId: string): TaskRecord {
    const t = this.task(taskId);
    if (t.pendingRemediationRequest !== null) { t.pendingRemediationRequest = null; this.save(); }
    return t;
  }

  // WorkflowGraph: a fan-out step's PARENT task is blocked on its just-pushed branch children,
  // reusing DEP1's dependsOn AND-join/cascade-fail verbatim (anyDepFailed/depsSatisfied,
  // reconcileDependents on a branch's markDone, cascadeFailDependents on a branch's markFailed
  // — all pre-existing, untouched below). stepIndex is set to the JOIN step's index NOW (not
  // when the join actually resumes) — mirrors how a fresh push()'s stepIndex already points at
  // whatever step will run once dependsOn clears; this is why spawnForTask/assignPersistent
  // (which already resolve wf.steps[task.stepIndex] generically, including on restart-recovery)
  // need no changes beyond scheduler.ts's mergeSummaryText threading to correctly resume the
  // join step once this task reverts to "pending". `childIds` is always non-empty in v1 (the
  // fanOut schema requires items.min(1)) but the state computation below is written generically
  // rather than hardcoded to "blocked" so it stays correct if a future caller passes
  // already-terminal child ids.
  blockOnChildren(taskId: string, childIds: string[], resumeStepIndex: number): TaskRecord {
    const t = this.task(taskId);
    const prevState = t.state;
    t.dependsOn = [...t.dependsOn, ...childIds];
    t.branchChildren = childIds;
    t.stepIndex = resumeStepIndex;
    t.stepAttempts = 0;
    t.agentId = null;
    this.recomputeDepState(t);
    this.save();
    this.emitTask(t, {}, prevState);
    if (t.state === "failed") this.cascadeFailDependents(taskId);
    return t;
  }

  // Shared by blockOnChildren above and extendChildren below — both append to `dependsOn` and
  // then need the SAME anyDepFailed/depsSatisfied -> state ternary; factored out so the two
  // call sites can't silently drift.
  private recomputeDepState(t: TaskRecord): void {
    t.state = this.anyDepFailed(t) ? "failed" : this.depsSatisfied(t) ? "pending" : "blocked";
    if (t.state === "failed") t.error = "dependency failed";
  }

  // WorkflowGraph (bounded fan-out): admit ADDITIONAL branch children onto an ALREADY blocked/
  // pending fan-out parent — mirrors blockOnChildren's dependsOn/branchChildren append + state
  // recompute, but does NOT touch stepIndex/stepAttempts/agentId (those were already set by the
  // ORIGINAL blockOnChildren call for this fan-out; a later wave is not a fresh block). Called
  // by scheduler.ts's tick() admission loop each time a new wave of branch tasks is pushed for a
  // task whose fanOutRemaining wasn't empty yet — see pendingFanOuts() below for the query that
  // finds those tasks.
  extendChildren(taskId: string, childIds: string[]): TaskRecord {
    const t = this.task(taskId);
    for (const depId of childIds) {
      const dep = this.tasks.get(depId);
      if (!dep || dep.queue !== t.queue) throw new UnknownDependencyError(`unknown dependency "${depId}" in queue "${t.queue}"`);
    }
    const prevState = t.state;
    t.dependsOn = [...t.dependsOn, ...childIds];
    t.branchChildren = [...t.branchChildren, ...childIds];
    this.recomputeDepState(t);
    this.save();
    this.emitTask(t, {}, prevState);
    if (t.state === "failed") this.cascadeFailDependents(taskId);
    return t;
  }

  // WorkflowGraph (bounded fan-out): tasks whose current wave has fully settled (state flipped
  // back to "pending" via reconcileDependents, below) but still have un-admitted item-chunks
  // waiting — scheduler.ts's tick() admission loop drains this every tick, BEFORE the ordinary
  // nextPending()/pickup loop can dispatch the join step against an incomplete fan-out.
  pendingFanOuts(): TaskRecord[] {
    return [...this.tasks.values()].filter((t) => t.state === "pending" && t.fanOutRemaining.length > 0);
  }

  // WorkflowGraph (bounded fan-out): persist the item-chunks not yet pushed as branch tasks —
  // durable (not scheduler in-memory state) so a daemon restart mid-fan-out resumes admitting
  // the remaining waves instead of silently dropping them (see fanOutRemaining's own doc
  // comment, protocol/src/index.ts).
  setFanOutRemaining(taskId: string, remaining: string[][]): TaskRecord {
    const t = this.task(taskId);
    t.fanOutRemaining = remaining;
    this.save();
    return t;
  }

  // F16.1 Phase 2 (WF-4/G4): open a fresh stepHistory entry for a step ATTEMPT that is
  // about to start running — called at every site a step starts (fresh spawn, idle-pool
  // reuse, workflow advance, workflow retry). No emit of its own: callers already emit
  // task_step_advanced/task_step_failed for the same transition (mirrors advanceStep's
  // save-without-emit discipline — the domain event belongs to the caller).
  startStep(taskId: string, stepIndex: number, stepId: string, agentId: string | null): TaskRecord {
    const t = this.task(taskId);
    t.stepHistory.push({ stepIndex, stepId, agentId, startedAt: Date.now(), endedAt: null, outcome: null });
    // F11: AFTER the push — the journal's "open" row reuses that entry's startedAt as the
    // half of the entryId that pairs it with the matching "close" row.
    this.journal?.open(t, stepIndex, stepId, agentId);
    this.save();
    return t;
  }

  // Closes the most recently opened stepHistory entry with its gate outcome —
  // "passed" (advancing/finishing), "retried" (same step re-attempted), or "failed"
  // (task halted). A crash-mid-step entry is left open forever (diagnostic: visible
  // proof nothing ever closed it) rather than guessed-closed on restart.
  closeStep(taskId: string, outcome: "passed" | "failed" | "retried", reason?: string): TaskRecord {
    const t = this.task(taskId);
    this.closeDanglingStep(t, outcome, reason);
    this.save();
    return t;
  }

  private closeDanglingStep(t: TaskRecord, outcome: "passed" | "failed" | "retried", reason?: string): void {
    // F11: journalled HERE, not in closeStep — markDone() closes a dangling step too (the
    // settle() race documented there), and journalling only closeStep would leave every
    // such final step permanently "open" in the journal. Must run BEFORE endedAt is
    // stamped: StepJournal.close() ignores an entry that already ended (its own
    // double-close guard), which is also what makes the closeStep→markDone pair safe.
    this.journal?.close(t, outcome, reason);
    const entry = t.stepHistory[t.stepHistory.length - 1];
    if (entry && entry.endedAt === null) {
      entry.endedAt = Date.now();
      entry.outcome = outcome;
      if (reason !== undefined) entry.reason = reason;
    }
  }

  // F16.1 Phase 3 (WF-9): stamp a captured handoff summary onto the (already closed,
  // "passed") stepHistory entry for `stepIndex` — searches backward since a retried step
  // can leave multiple entries at the same stepIndex; the most recent "passed" one is
  // always the one a live switch just closed via closeStep.
  setStepHandoffSummary(taskId: string, stepIndex: number, summary: string): TaskRecord {
    const t = this.task(taskId);
    for (let i = t.stepHistory.length - 1; i >= 0; i--) {
      const entry = t.stepHistory[i]!;
      if (entry.stepIndex === stepIndex && entry.outcome === "passed") { entry.handoffSummary = summary; break; }
    }
    this.save();
    return t;
  }

  // FEATURE-2: persist a fresh durable-resume checkpoint for taskId's CURRENT step. Called by
  // scheduler.ts's captureStepCheckpoint at every fresh agent bind to a step (first attempt,
  // retry respawn, crash-restart re-dispatch alike) — best-effort, never throws on its own (the
  // caller already resolved workdirKey/branch/commitSha via non-throwing helpers).
  checkpointStep(taskId: string, checkpoint: TaskStepCheckpoint): TaskRecord {
    const t = this.task(taskId);
    t.checkpoint = checkpoint;
    this.saveDurable();
    this.events.append({ agentId: `task:${taskId}`, kind: "workflow_step_checkpoint", data: { taskId, ...checkpoint } });
    return t;
  }

  // FEATURE-10 fix: every OTHER task whose most recently captured checkpoint shares this
  // workdirKey — i.e. every task that has ever occupied the SAME physical worktree/branch
  // (a persistent pool worker reused across tasks keys every checkpoint on its one fixed
  // agentId-derived workdirKey; see scheduler.ts's captureStepCheckpoint). EvidenceStore uses
  // this to find the immediate successor of a given task on a shared branch, so an earlier
  // task's diff can be bounded to stop before a later task's commits land on it.
  tasksByCheckpointWorkdir(workdirKey: string, excludeTaskId: string): TaskRecord[] {
    return [...this.tasks.values()].filter((t) => t.taskId !== excludeTaskId && t.checkpoint?.workdirKey === workdirKey);
  }

  // DENIED-TOOL-CALL-INVISIBLE: `opts.toolPolicyDenied` (the terminal agent's own
  // AgentRecord.toolPolicyDenied, threaded through by every scheduler.ts markDone call site —
  // it already has `rec` in scope at each one) stamps TaskRecord.toolPolicyDenied so a "done"
  // task that hid a give-up is flagged as DATA, not left to a downstream reader parsing
  // resultText prose — the exact gap Failure 2 in the task brief describes ("a task marked done
  // can have landed nothing"). Absent/false ⇒ byte-identical to before this parameter existed.
  markDone(taskId: string, resultText: string, opts?: { toolPolicyDenied?: boolean }): TaskRecord {
    const t = this.task(taskId);
    // F16.1 Phase 2 (WF-4/G4): a workflow-bound task can reach "done" via the ordinary
    // settle() path without its LAST step's own turn_complete ever separately reaching
    // the scheduler's gate evaluation (a real backend's terminal `result` can race ahead
    // of a still-in-flight prior event) — the task's own "done" state IS the evidence
    // that step passed, so close any still-open entry here rather than leaving it
    // open (which would misleadingly read as "never finished" for a task that did).
    this.closeDanglingStep(t, "passed");
    const prevState = t.state;
    t.state = "done"; t.resultText = resultText; t.endedAt = Date.now();
    if (opts?.toolPolicyDenied) t.toolPolicyDenied = true;
    this.save(); this.emitTask(t, opts?.toolPolicyDenied ? { toolPolicyDenied: true } : {}, prevState);
    this.reconcileDependents(taskId);   // DEP1: unblock dependents now that this is done
    return t;
  }

  markFailed(taskId: string, error: string): TaskRecord {
    const t = this.task(taskId);
    const prevState = t.state;
    t.state = "failed"; t.error = error; t.agentId = null; t.endedAt = Date.now();
    this.save(); this.emitTask(t, {}, prevState);
    this.cascadeFailDependents(taskId);   // DEP1: a failed dep dooms its dependents
    return t;
  }

  // RETRY-BACKOFF: terminal but PRESERVED — unlike markFailed's "failed" (which cascade-fails
  // every dependent via cascadeFailDependents), a dead-lettered task's dependents are left
  // exactly where they are (blocked/pending) so a poisoned or retry-exhausted task doesn't take
  // its whole dependency subtree down with it. Deliberately does NOT call
  // cascadeFailDependents. The only way out is requeue() below (replay).
  markDeadLetter(taskId: string, error: string): TaskRecord {
    const t = this.task(taskId);
    const prevState = t.state;
    t.state = "dead_letter"; t.error = error; t.agentId = null;
    this.save(); this.emitTask(t, { deadLettered: true }, prevState);
    return t;
  }

  markFailedAttempt(taskId: string, attemptsConsumed: number, error: string, errorClass?: ErrorClassName): TaskRecord {
    const t = this.task(taskId);
    t.attempts += attemptsConsumed;
    const policy = this.get(t.queue).retryPolicy;
    if (!policy) {
      if (t.attempts > this.get(t.queue).retryLimit) return this.markFailed(taskId, error);
      const prevState = t.state;
      t.state = "pending"; t.agentId = null; t.error = error;
      this.save(); this.emitTask(t, { retrying: true }, prevState);
      return t;
    }
    // RETRY-BACKOFF: a classified error outside the policy's allow-list is treated as poison —
    // dead-letter immediately regardless of attempts remaining (retrying it won't help).
    const poisoned = errorClass !== undefined && policy.retryableClasses !== undefined
      && !policy.retryableClasses.includes(errorClass);
    if (poisoned || t.attempts >= policy.maxAttempts) return this.markDeadLetter(taskId, error);
    // PARKED (not reverted to pending yet) — the caller (scheduler.ts settle()) computes the
    // backoff delay via computeRetryDelayMs and calls releaseForRetry() once it elapses. Mirrors
    // the parkedSwitches "in_progress, no bound agent" pattern used elsewhere in scheduler.ts.
    const prevState = t.state;
    t.state = "in_progress"; t.agentId = null; t.error = error;
    this.save(); this.emitTask(t, { retrying: true, parked: true }, prevState);
    return t;
  }

  // RETRY-BACKOFF: called by scheduler.ts once a parked task's computed backoff delay elapses
  // (see markFailedAttempt above, and the workflow-retry path in scheduler.ts). Only acts on
  // "in_progress" (parked) — a task that resolved some other way in the meantime (cancelled,
  // requeued) is left alone, so a stale timer can never resurrect/duplicate it.
  releaseForRetry(taskId: string): TaskRecord {
    const t = this.task(taskId);
    if (t.state !== "in_progress") return t;
    const prevState = t.state;
    t.state = "pending"; t.agentId = null;
    this.save(); this.emitTask(t, { retrying: true }, prevState);
    return t;
  }

  // RETRY-BACKOFF: the only way out of "dead_letter" today (besides cancel(), which doesn't
  // accept dead_letter — see cancel()'s own note below). Resets the retry/step-attempt budget to
  // fresh and reverts to "pending" — a workflow-bound task resumes from its persisted
  // stepIndex/checkpoint via the ordinary pickup path (same restart-recovery contract
  // releaseForRetry above relies on), a plain task just re-runs its prompt. Does NOT touch
  // stepHistory (the audit trail of the earlier failed run(s) is preserved) or checkpoint.
  requeue(taskId: string): TaskRecord {
    const t = this.task(taskId);
    if (t.state !== "dead_letter") throw new TaskNotDeadLetteredError(`task ${taskId} is not dead-lettered (state: ${t.state})`);
    const prevState = t.state;
    t.state = "pending"; t.agentId = null; t.error = null; t.attempts = 0; t.stepAttempts = 0;
    this.save(); this.emitTask(t, { requeued: true }, prevState);
    return t;
  }

  // QUEUE-REORDER (operator recovery — the T15 incident): clone a terminal-with-error task
  // (failed OR dead_letter) into a FRESH pending task with the same prompt/role/overrides/
  // dependsOn/workflow binding — the operator's literal ask was "don't make me retype the
  // brief; sometimes it should be solvable by reordering". Deliberately a CLONE, not an
  // in-place revive like requeue() above:
  //  - dead_letter already has an in-place revive (requeue()) precisely BECAUSE dead-lettered
  //    tasks were never cascade-failed (RETRY-BACKOFF's own documented choice) — reviving them
  //    in place is safe, their dependents were never touched.
  //  - a "failed" task, by contrast, already cascade-failed every dependent the moment it
  //    failed (markFailed -> cascadeFailDependents). Reviving THAT task in place would not
  //    resurrect those already-terminal dependents — routing both states through one shared
  //    "revive in place" path would produce a confusing half-fixed dependency graph. Cloning
  //    sidesteps that: the original failed record (and whatever it cascaded) stays exactly as
  //    it was, for audit; the new task is an independent fresh start the operator can push,
  //    inspect, and reposition (moveTask) exactly like any other pending task.
  // RETRY BUDGET: fresh — push()'s ordinary TaskRecordSchema defaults (attempts:0,
  // stepAttempts:0). The operator can never inherit an exhausted attempts counter, silently or
  // otherwise, because the clone is a BRAND NEW TaskRecord, not the same one with fields reset.
  // If `dependsOn` still names a task that is itself failed, push() re-runs the ordinary
  // anyFailed/allDone evaluation a brand-new task would get — the clone lands right back in
  // "failed" rather than escaping a genuinely broken dependency chain; no special-casing here.
  retryTask(taskId: string): TaskRecord {
    const original = this.task(taskId);
    if (original.state !== "failed" && original.state !== "dead_letter")
      throw new TaskNotRetryableError(`task ${taskId} is not retryable (state: ${original.state}) — only failed or dead_letter tasks can be retried`);
    return this.push(original.queue, {
      prompt: original.prompt, priority: original.priority, role: original.role,
      overrides: original.overrides, dependsOn: original.dependsOn,
      pushedBy: original.pushedBy, originConductorId: original.originConductorId,
      workflow: original.workflowOverride,
    });
  }

  // QUEUE-REORDER: move a pending/blocked task one slot within its queue's drain order
  // (compareDrainOrder, module scope above — the exact comparator nextPending uses, extended
  // here to also cover "blocked" tasks so the operator can position a task before it's even
  // dependency-eligible). Implemented as an ADJACENT SWAP of the full (priority, orderKey)
  // tuple with whichever task currently sits in the neighbouring drain-order slot — NOT a
  // gap-insertion. That sidesteps the "no integer gap between adjacent neighbours" problem
  // entirely: there is no gap to find, because nothing is ever inserted BETWEEN two existing
  // values — the two tuples are exchanged outright. Since orderKey is unique per task (the
  // boot-time normalization + push()'s monotonic counter both guarantee this), a swap ALWAYS
  // changes both tasks' rank; the only genuine no-op is the boundary (already first/last in
  // the queue's drain order), where there's nothing to swap with — that's correct behavior,
  // never a "the button did nothing" bug in the middle of the list.
  moveTask(taskId: string, direction: "up" | "down"): TaskRecord {
    const t = this.task(taskId);
    if (t.state !== "pending" && t.state !== "blocked")
      throw new TaskNotEditableError(`task ${taskId} is not reorderable (state: ${t.state}) — only pending or blocked tasks can be reordered`);
    const siblings = [...this.tasks.values()]
      .filter((x) => x.queue === t.queue && (x.state === "pending" || x.state === "blocked"))
      .sort(compareDrainOrder);
    const idx = siblings.findIndex((x) => x.taskId === taskId);
    const neighborIdx = direction === "up" ? idx - 1 : idx + 1;
    if (neighborIdx < 0 || neighborIdx >= siblings.length) return t;   // already at the boundary — nothing to swap with
    const neighbor = siblings[neighborIdx]!;
    const tPriority = t.priority, tOrderKey = t.orderKey;
    t.priority = neighbor.priority; t.orderKey = neighbor.orderKey;
    neighbor.priority = tPriority; neighbor.orderKey = tOrderKey;
    this.save();
    this.emitTask(t, { reordered: true, direction, swappedWith: neighbor.taskId });
    this.emitTask(neighbor, { reordered: true, direction: direction === "up" ? "down" : "up", swappedWith: t.taskId });
    return t;
  }

  // QUEUE-REORDER: add a dependency to an ALREADY-existing pending/blocked task — the T15
  // incident's real fix (see queues.ts module doc / PLAN note): "run last, after everything
  // else" is an ORDERING CONSTRAINT, not a priority tiebreak, and dependsOn is the mechanism
  // that expresses it. push()'s own dependsOn can never form a cycle (a dependency must
  // already exist before a task can reference it, so the graph can only grow "backwards" in
  // creation order) — addDependency is the FIRST way to add an edge to a task that already
  // exists, so it's also the first place a cycle becomes reachable (this task could easily
  // predate the one it's about to depend on), hence the explicit transitivelyDependsOn check.
  addDependency(taskId: string, dependsOnId: string): TaskRecord {
    const t = this.task(taskId);
    if (t.state !== "pending" && t.state !== "blocked")
      throw new TaskNotEditableError(`task ${taskId} is not editable (state: ${t.state}) — only pending or blocked tasks can be edited`);
    if (dependsOnId === taskId) throw new DependencyCycleError(`task ${taskId} cannot depend on itself`);
    const dep = this.tasks.get(dependsOnId);
    if (!dep || dep.queue !== t.queue) throw new UnknownDependencyError(`unknown dependency "${dependsOnId}" in queue "${t.queue}"`);
    if (t.dependsOn.includes(dependsOnId)) return t;   // already a dependency — no-op
    if (this.transitivelyDependsOn(dep, taskId))
      throw new DependencyCycleError(`adding "${dependsOnId}" as a dependency of ${taskId} would create a cycle`);
    const prevState = t.state;
    t.dependsOn = [...t.dependsOn, dependsOnId];
    this.recomputeDepState(t);
    this.save();
    this.emitTask(t, { dependencyAdded: dependsOnId }, prevState);
    if (this.tasks.get(taskId)!.state === "failed") this.cascadeFailDependents(taskId);
    return t;
  }

  private transitivelyDependsOn(start: TaskRecord, targetId: string): boolean {
    const seen = new Set<string>();
    const stack = [...start.dependsOn];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === targetId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const next = this.tasks.get(id);
      if (next) stack.push(...next.dependsOn);
    }
    return false;
  }

  // TASK-EDIT-VERSIONING: edit a still-queued task's prompt/role/priority/overrides/workflow
  // binding IN PLACE, appending an entry to versions[] and emitting task_edited. Preserves taskId,
  // dependsOn (both directions — dependents keep pointing at it), createdAt, pushedBy: none of them
  // are touched here. A priority change naturally re-orders the pending queue (nextPending sorts by
  // priority each tick) but does NOT otherwise reset queue position. The next spawn (when the queue
  // drains this task) reads the LIVE head fields, so a later retry re-runs the CURRENT prompt —
  // exactly the "fix the brief, let the retry use it" operating rule.
  //
  // Only pending/blocked are editable — in_progress/terminal throw TaskNotEditableError (the agent
  // already consumed the prompt). Sparse: only fields present in `patch` AND actually different are
  // recorded/applied; if nothing changes, it's a no-op (no version bump, no event) and the task is
  // returned unchanged. dependsOn editing is out of scope for this slice: it would need dep-existence/
  // cycle validation plus a blocked/pending recompute + reconcile, none of which the version
  // bookkeeping makes cheap — deliberately omitted (TaskEditPatch has no dependsOn key).
  editTask(taskId: string, patch: TaskEditPatch, editedBy: string | null): TaskRecord {
    const t = this.task(taskId);
    if (t.state !== "pending" && t.state !== "blocked")
      throw new TaskNotEditableError(`task ${taskId} is not editable (state: ${t.state}) — only pending or blocked tasks can be edited`);
    const changedFields: string[] = [];
    const prior: Record<string, unknown> = {};
    // prompt/role/priority: primitive compare. overrides: structural compare (a fresh object that
    // deep-equals the current one is not a change). workflow patch → workflowOverride live field.
    if (patch.prompt !== undefined && patch.prompt !== t.prompt) { changedFields.push("prompt"); prior.prompt = t.prompt; t.prompt = patch.prompt; }
    if (patch.role !== undefined && patch.role !== t.role) { changedFields.push("role"); prior.role = t.role; t.role = patch.role; }
    if (patch.priority !== undefined && patch.priority !== t.priority) { changedFields.push("priority"); prior.priority = t.priority; t.priority = patch.priority; }
    if (patch.overrides !== undefined && !deepEqual(patch.overrides, t.overrides)) { changedFields.push("overrides"); prior.overrides = t.overrides; t.overrides = patch.overrides; }
    if (patch.workflow !== undefined && patch.workflow !== t.workflowOverride) { changedFields.push("workflowOverride"); prior.workflowOverride = t.workflowOverride; t.workflowOverride = patch.workflow; }
    // TASK-TAGS: whole-value REPLACEMENT with a structural compare, exactly like `overrides` —
    // re-sending the identical list is not an edit, and replacement is the only semantics that
    // can express removing a tag.
    if (patch.tags !== undefined && !deepEqual(patch.tags, t.tags)) { changedFields.push("tags"); prior.tags = t.tags; t.tags = patch.tags; }
    if (changedFields.length === 0) return t;   // no-op edit — nothing to version or emit
    const version = t.versions.length + 1;
    t.versions = [...t.versions, { version, editedAt: Date.now(), editedBy, changedFields, prior }];
    this.save();
    this.emitTask(t, { edited: true, version, changedFields });
    return t;
  }

  cancel(taskId: string): boolean {
    const t = this.task(taskId);
    // DEP1: a blocked task is also cancellable (and cancelling it cascade-fails its
    // own dependents via markFailed) — only genuinely started/terminal tasks can't be.
    // RETRY-BACKOFF: a dead-lettered task is NOT accepted here — requeue() is the only
    // documented exit today (see requeue's own comment); giving up on one permanently is a
    // follow-up (see PLAN.md §8).
    if (t.state !== "pending" && t.state !== "blocked") return false;
    this.markFailed(taskId, "cancelled");
    return true;
  }

  status(queueName: string): { spec: QueueSpec; counts: Record<TaskState, number>; tasks: TaskRecord[] } {
    const spec = this.get(queueName);
    const tasks = [...this.tasks.values()].filter((t) => t.queue === queueName);
    const counts: Record<TaskState, number> = { pending: 0, in_progress: 0, done: 0, failed: 0, blocked: 0, dead_letter: 0 };
    for (const t of tasks) counts[t.state]++;
    return { spec, counts, tasks };
  }

  // TOKEN-OPT-P1: the summary projection of status() an orchestrator should poll instead —
  // every non-terminal task (pending/in_progress/blocked, normally few) is always included,
  // but done/failed tasks (up to MAX_TERMINAL_PER_QUEUE=200) are PAGED, most-recently-created
  // first, `limit` per page (cursor is an opaque offset string). Each task is projected down
  // to {id, state, subject} — no full prompt/resultText/stepHistory.
  summary(queueName: string, opts: { limit?: number; cursor?: string } = {}): QueueStatusSummary {
    const { spec, counts, tasks } = this.status(queueName);
    const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_SUMMARY_PAGE;
    const offset = opts.cursor ? Number.parseInt(opts.cursor, 10) || 0 : 0;
    const nonTerminal = tasks.filter((t) => t.state !== "done" && t.state !== "failed");
    const terminal = tasks.filter((t) => t.state === "done" || t.state === "failed")
      .sort((a, b) => b.createdAt - a.createdAt);
    const page = terminal.slice(offset, offset + limit);
    const nextCursor = offset + limit < terminal.length ? String(offset + limit) : null;
    return { spec, counts, tasks: [...nonTerminal, ...page].map(toTaskSummary), nextCursor };
  }
}
