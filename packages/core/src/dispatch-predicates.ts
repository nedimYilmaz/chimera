import type { ExplainCheck, QueueSpec, RoleSpec, TaskRecord, TaskState, TeamSpec, WorkflowRecord } from "@chimera/protocol";

// F15 (task_explain): the ONE ordered, named array of reasons a pending task does not start.
// The scheduler's drain loop and queue.explainTask both evaluate THIS array — never a copy —
// so a predicate can never exist in dispatch without being explainable (the verdict's
// non-negotiable parity requirement; test/f15-parity.test.ts is its guard).

/** What the drain loop does when a predicate fails — each value is the action the live path
 *  ALREADY took at that predicate's site before this array existed. */
export type DispatchOutcome =
  | "teamSkipped"    // the drain loop never visits this task's queue this tick
  | "notSelected"    // nextPending would not return it
  | "taskFails"      // markFailed — permanent
  | "drainStops";    // break / return false — retried on a later tick (starved)

/** Where the LIVE path evaluates this predicate. "loop" ⇒ the drain loop evaluates it from the
 *  context directly. "spawn" ⇒ the supervisor.spawn call IS its live evaluation (resolveAgentSpec
 *  throwing / a GuardrailError), so the drain loop must NOT re-run it: the explain path's probe
 *  spec is a projection (see scheduler.ts's admissionProbe) and deciding live off an
 *  approximation would change behaviour, on top of doing the work twice per drain iteration.
 *  A "spawn" predicate is also inapplicable when the live path reaches NO spawn call at all —
 *  see firstBlocking's idle-reuse skip. */
export type DispatchLiveSite = "loop" | "spawn";

/** `failMessage` carries the UNTRUNCATED text a "taskFails" outcome must pass to markFailed —
 *  `detail` is capped at 240 chars because it rides an MCP result, and a truncated task error
 *  would silently lose the diagnosis. Same split the supervisor's admission array makes. */
export type DispatchEvaluation = { ok: boolean; skipped?: boolean; detail: string; failMessage?: string };

export type DispatchPredicate = {
  readonly name: string;
  readonly onFail: DispatchOutcome;
  readonly liveSite: DispatchLiveSite;
  /** Pure. No mutation, no spawn, no event append. Returns skipped:true when the predicate does
   *  not apply on this branch (teamConcurrency for a persistent role, workerCapacity for an
   *  ephemeral one). */
  evaluate(ctx: DispatchContext): DispatchEvaluation;
};

/** Everything a predicate may read. Built ONCE per evaluation by
 *  QueueScheduler.buildDispatchContext. The O(n) reads are thunks, not values: the drain loop
 *  builds one context per task per tick and must not pay for a roster scan (runningForTeam),
 *  a pool probe (hasIdleWorker) or a whole spec/admission replay (spec/admission, "spawn"-site
 *  predicates the loop never evaluates) that its branch does not reach. */
export type DispatchContext = {
  task: TaskRecord;
  team: TeamSpec | null;
  queue: QueueSpec | null;
  roleName: string | null;
  template: RoleSpec | null;
  persistent: boolean;                 // template?.persistent === true — picks the branch below
  workflow: WorkflowRecord | null;
  workflowError: string | null;        // resolveWorkflow's thrown message, or null
  headOfQueue: TaskRecord | null;      // queues.nextPending(task.queue)
  maxConcurrent: number;
  poolSize: number; poolCap: number;
  depStates: { taskId: string; state: TaskState | null }[];
  parkedRetryMsRemaining: number | null;                          // scheduler's pendingRetries
  parkedSwitch: { roleName: string; stepIndex: number } | null;   // scheduler's parkedSwitches
  runningForTeam: () => number;
  hasIdleWorker: () => boolean;
  spec: () => { ok: boolean; error: string | null };
  admission: () => ExplainCheck[];
  /** The memoized result of `admission()` WITHOUT forcing it — [] when no predicate ever reached
   *  supervisorAdmission. TaskExplainResult.admission is exactly this (the schema's "empty when
   *  an earlier predicate already blocked"). */
  admissionEvaluated: () => ExplainCheck[];
};

// ExplainCheck.detail is schema-bounded at 240 (it rides an MCP tool result).
const DETAIL_CAP = 240;
function capDetail(s: string): string { return s.length > DETAIL_CAP ? `${s.slice(0, DETAIL_CAP - 3)}...` : s; }

function describeState(t: { taskId: string; state: TaskState | null }): string {
  return `${t.taskId} is ${t.state ?? "missing"}`;
}

export const DISPATCH_PREDICATES: readonly DispatchPredicate[] = [
  {
    name: "teamBound", onFail: "teamSkipped", liveSite: "loop",
    evaluate: (ctx) => {
      const ok = ctx.team !== null;
      return { ok, detail: ok
        ? `queue "${ctx.task.queue}" is bound to team "${ctx.team!.name}"`
        : `queue "${ctx.task.queue}" is not bound to any team — no drain loop ever visits it` };
    },
  },
  {
    name: "queueExists", onFail: "teamSkipped", liveSite: "loop",
    evaluate: (ctx) => {
      const ok = ctx.queue !== null;
      return { ok, detail: ok ? `queue "${ctx.task.queue}" exists` : `queue "${ctx.task.queue}" no longer exists` };
    },
  },
  {
    name: "queueNotPaused", onFail: "teamSkipped", liveSite: "loop",
    evaluate: (ctx) => {
      const ok = ctx.queue?.paused !== true;
      return { ok, detail: ok ? `queue "${ctx.task.queue}" is not paused` : `queue "${ctx.task.queue}" is paused — it drains no new agents` };
    },
  },
  {
    // R6: the two in-memory parks (retry backoff, guardrailed role switch) are DIAGNOSED here,
    // inside this predicate's detail — never as predicates of their own. Both maps are cleared
    // by a daemon restart, so a stale read must never be able to change `dispatchable`.
    name: "taskPending", onFail: "notSelected", liveSite: "loop",
    evaluate: (ctx) => {
      const t = ctx.task;
      if (t.state === "pending") return { ok: true, detail: "task is pending and eligible for pickup" };
      // A dependency-blocked task is "blocked" BECAUSE of its deps (queues.ts reconcileDependents
      // owns that state) — reporting taskPending as the blocker would name the symptom and hide
      // the cause, so defer to dependenciesSatisfied, which names each unfinished dep. Skipped,
      // not ok: the next predicate still fails, so `dispatchable` is unchanged.
      if (t.state === "blocked" && ctx.depStates.some((d) => d.state !== "done"))
        return { ok: false, skipped: true, detail: "blocked purely by unmet dependencies — see dependenciesSatisfied" };
      if (ctx.parkedRetryMsRemaining !== null)
        return { ok: false, detail: `parked for retry backoff, ~${Math.ceil(ctx.parkedRetryMsRemaining / 1000)}s remaining` };
      if (ctx.parkedSwitch !== null)
        return { ok: false, detail: `parked on a guardrailed role switch to "${ctx.parkedSwitch.roleName}" at step ${ctx.parkedSwitch.stepIndex}` };
      if (t.state === "failed" || t.state === "dead_letter")
        return { ok: false, detail: `task is ${t.state} after ${t.attempts} attempt(s): ${t.error ?? "no error recorded"}` };
      return { ok: false, detail: `task state is "${t.state}", not "pending"` };
    },
  },
  {
    name: "dependenciesSatisfied", onFail: "notSelected", liveSite: "loop",
    evaluate: (ctx) => {
      const unmet = ctx.depStates.filter((d) => d.state !== "done");
      return { ok: unmet.length === 0, detail: unmet.length === 0
        ? (ctx.depStates.length === 0 ? "no dependencies" : `all ${ctx.depStates.length} dependencies are done`)
        : `waiting on ${unmet.length} of ${ctx.depStates.length} dependencies: ${unmet.map(describeState).join("; ")}` };
    },
  },
  {
    // R5: a non-front task is genuinely not dispatchable, but "false" alone is useless — name
    // the task that actually drains first so the operator's next explain call is obvious.
    name: "headOfDrainOrder", onFail: "notSelected", liveSite: "loop",
    evaluate: (ctx) => {
      const head = ctx.headOfQueue;
      const ok = head !== null && head.taskId === ctx.task.taskId;
      return { ok, detail: ok ? "task is at the front of its queue's drain order"
        : head === null ? "queue has no dispatchable task at all"
        : `${head.taskId} drains first (priority ${head.priority} vs ${ctx.task.priority})` };
    },
  },
  {
    name: "roleKnown", onFail: "taskFails", liveSite: "loop",
    evaluate: (ctx) => {
      if (ctx.template !== null) return { ok: true, detail: `routes to role "${ctx.roleName}"` };
      // byte-identical to spawnForTask's pre-F15 markFailed message
      const message = `unknown role "${ctx.roleName}" in team "${ctx.team?.name ?? ""}"`;
      return { ok: false, detail: message, failMessage: message };
    },
  },
  {
    name: "teamConcurrency", onFail: "drainStops", liveSite: "loop",
    evaluate: (ctx) => {
      if (ctx.persistent) return { ok: true, skipped: true, detail: "not applicable: persistent role (gated by workerCapacity)" };
      const running = ctx.runningForTeam();
      const ok = running < ctx.maxConcurrent;
      return { ok, detail: `${running} of ${ctx.maxConcurrent} team slots in use` };
    },
  },
  {
    name: "workflowResolvable", onFail: "taskFails", liveSite: "loop",
    evaluate: (ctx) => {
      if (ctx.workflowError !== null)
        return { ok: false, detail: ctx.workflowError, failMessage: ctx.workflowError };
      return { ok: true, detail: ctx.workflow
        ? `workflow "${ctx.workflow.name}" v${ctx.workflow.version} resolves at step ${ctx.task.stepIndex}`
        : "task is not workflow-bound" };
    },
  },
  {
    name: "workerCapacity", onFail: "drainStops", liveSite: "loop",
    evaluate: (ctx) => {
      if (!ctx.persistent) return { ok: true, skipped: true, detail: "not applicable: ephemeral role (gated by teamConcurrency)" };
      // An idle pool worker is reused via send() — the pool cap only gates a FRESH spawn,
      // exactly as assignPersistent orders these two checks.
      if (ctx.hasIdleWorker()) return { ok: true, detail: `an idle "${ctx.roleName}" worker is available for reuse` };
      const ok = ctx.poolSize < ctx.poolCap;
      return { ok, detail: `pool "${ctx.roleName}": ${ctx.poolSize} of ${ctx.poolCap} workers, none idle` };
    },
  },
  {
    name: "specValid", onFail: "taskFails", liveSite: "spawn",
    evaluate: (ctx) => {
      const r = ctx.spec();
      return r.ok ? { ok: true, detail: "the merged role+overrides spec is valid" }
        : { ok: false, detail: r.error ?? "invalid spec", failMessage: r.error ?? "invalid spec" };
    },
  },
  {
    name: "supervisorAdmission", onFail: "drainStops", liveSite: "spawn",
    evaluate: (ctx) => {
      const checks = ctx.admission();
      const denied = checks.find((c) => !c.ok && !c.skipped);
      return { ok: denied === undefined, detail: denied ? `${denied.name}: ${denied.detail}` : "all six spawn-admission checks pass" };
    },
  },
];

export const DISPATCH_PREDICATE_NAMES: readonly string[] = DISPATCH_PREDICATES.map((p) => p.name);

/** Which predicates to actually evaluate. "loop" runs only the liveSite:"loop" ones (the drain
 *  loop; the rest are evaluated by the spawn call itself). "all" runs every one (explainTask)
 *  EXCEPT on a branch whose live path never spawns — see firstBlocking's idle-reuse skip. */
export type DispatchScope = "loop" | "all";

export type FirstBlockingResult = {
  blocked: DispatchPredicate | null;
  result: DispatchEvaluation | null;   // the blocking predicate's own evaluation
  checks: ExplainCheck[];              // ALWAYS one entry per predicate, in array order
};

/** The ONE evaluator both paths use. Stops EVALUATING at the first non-skipped ok:false, but
 *  still emits a check row for every remaining predicate so `checks` deep-equals
 *  DISPATCH_PREDICATE_NAMES no matter where it stopped (parity criterion A9). */
export function firstBlocking(ctx: DispatchContext, scope: DispatchScope = "all"): FirstBlockingResult {
  const checks: ExplainCheck[] = [];
  let blocked: DispatchPredicate | null = null;
  let result: DispatchEvaluation | null = null;
  // A persistent role with an idle pool worker dispatches through assignPersistent's
  // supervisor.send() reuse branch, which never calls supervisor.spawn — so on THIS task's path
  // the "spawn"-site predicates have no live site to mirror. Replaying them anyway invented a
  // blocker for a task that dispatches on the very next tick (a saturated globalCap made explain
  // answer blockedBy:"supervisorAdmission", and specValid — onFail:"taskFails" — could even name
  // a permanent failure). Only the explain scope pays the hasIdleWorker() roster scan here; the
  // drain loop skips these predicates on the `scope === "loop"` branch regardless.
  const reusesIdleWorker = scope === "all" && ctx.persistent && ctx.hasIdleWorker();
  for (const p of DISPATCH_PREDICATES) {
    if (blocked !== null) {
      checks.push({ name: p.name, ok: false, skipped: true, detail: capDetail(`not evaluated: ${blocked.name} blocked first`) });
      continue;
    }
    if (p.liveSite === "spawn" && (scope === "loop" || reusesIdleWorker)) {
      // ok:true+skipped:true is the "not applicable on this branch" shape (as teamConcurrency /
      // workerCapacity use); ok:false+skipped:true is "not evaluated". Neither ever blocks.
      checks.push(scope === "loop"
        ? { name: p.name, ok: false, skipped: true, detail: "not evaluated: the spawn call itself is this check's live site" }
        : { name: p.name, ok: true, skipped: true, detail: capDetail(`not applicable: an idle "${ctx.roleName}" worker is reused via send(), which never spawns`) });
      continue;
    }
    const r = p.evaluate(ctx);
    checks.push({ name: p.name, ok: r.ok, skipped: r.skipped ?? false, detail: capDetail(r.detail) });
    if (!r.ok && r.skipped !== true) { blocked = p; result = r; }
  }
  return { blocked, result, checks };
}
