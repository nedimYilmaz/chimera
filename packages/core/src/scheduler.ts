import { execFile } from "node:child_process";
import { FanOutArtifactListSchema, PlanArtifactSchema, type AgentSpec, type EventKind, type ErrorClassName, type ExplainCheck, type QueueSpec, type RoleSpec, type RouteCondition, type TaskExplainResult, type TaskRecord, type TaskStepCheckpoint, type TeamSpec, type WorkflowFanOut, type WorkflowGate, type WorkflowRecord, type WorkflowStep, type WorkflowSubWorkflow } from "@chimera/protocol";
import { computeRetryDelayMs } from "@chimera/protocol";
import { resolveAgentSpec, isRevivableHold, type AgentSupervisor } from "./supervisor.js";
import { firstBlocking, type DispatchContext } from "./dispatch-predicates.js";
import type { TeamManager } from "./teams.js";
import { UnknownQueueError, type QueueStore } from "./queues.js";
import type { WorkflowStore } from "./workflows.js";
import type { ArtifactStore } from "./artifacts.js";
import type { EventLog } from "./events.js";
import type { RoleStore } from "./roles-store.js";
import { resolveRole } from "./shared-roles.js";
import { resolveWorkdirPath, branchNameFor, currentWorkdirHeadSha, isShaAncestorOfMain } from "./workdir.js";
import { resumeNoticeFor } from "./reattach.js";
import { defaultEffortForRole, escalatedEffort } from "./effort-policy.js";

// Task C1: mirrors UnknownTeamError's shape — surfaces as a protocol RPC error
// (Engine.handle's catch maps any thrown `.code` string straight through).
export class SchedulerError extends Error {
  code = "protocol" as const;
  name = "SchedulerError";
}

// D12 (task workflows): the `command` gate runner's seam — injectable so tests never
// shell out for real (mirrors JobScheduler's injectable `now`).
// WF-3 (G2): `env` carries the per-task CHIMERA_* vars (see evaluateGate) so gate
// scripts can check per-task evidence; WF-3 (G3): `timeoutMs` overrides the default.
export type GateExecResult = { ok: boolean; message: string };
export type GateExecFn = (
  command: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs?: number,
) => Promise<GateExecResult>;
const GATE_COMMAND_TIMEOUT_MS = 120_000;
// GATE-HANG-HARDENING (2026-08-22 zombie-agent incident): execFile's own `timeout` option only
// SENDS killSignal (SIGTERM) at the deadline — it does NOT guarantee the child actually exits.
// A docker CLI (or any child that spawns its own grandchildren) under contention can ignore or
// be too slow to honor SIGTERM, leaving the child alive and this function's Promise permanently
// unresolved. Root-caused live: two workflow-bound agents' last event was a normal
// `turn_complete`/`result` and then NOTHING for 7.5-8.6 hours — handleWorkflowTurn was paused
// forever at `await this.evaluateGate(...)` (never reaching its own try/finally, which would
// otherwise have cleared `stepTransitioning`), because the docker-backed command gate's exec
// never called back. These two constants make the exec promise settle no matter what the OS
// process does: GATE_KILL_GRACE_MS after the soft timeout, escalate to SIGKILL (a strictly
// stronger signal than the timeout's own SIGTERM); GATE_HARD_CEILING_GRACE_MS after the soft
// timeout, resolve the promise regardless of whether the process has actually exited yet (a
// truly unkillable process — e.g. D-state — is an OS-level condition no signal can fix, but the
// CALLER must never be held hostage to it).
const GATE_KILL_GRACE_MS = 10_000;
const GATE_HARD_CEILING_GRACE_MS = 30_000;

// GATE-FAILURE-DISCARDS-ITS-OWN-DIAGNOSTICS: gate scripts (and tsc/vitest) write their actual
// diagnosis to STDOUT, not stderr — `echo 'GATE FAIL: ...'` and compiler/test output all land
// there. A failure message that only reads stderr is empty in the common case, degrading to
// node's generic "Command failed: <script text>" with zero diagnostic content. Both streams are
// captured, labelled, and truncated per-stream so a populated stderr never hides stdout (or
// vice versa).
const GATE_MESSAGE_STREAM_CAP = 1000;
// tsc's most useful errors come first; `vitest --reporter=dot`'s pass/fail summary comes last —
// a head-only cap loses the vitest verdict, a tail-only cap loses the tsc root cause. Keep both
// ends and say explicitly how much was cut from the middle.
function capStream(s: string, max: number): string {
  if (s.length <= max) return s;
  const headLen = Math.ceil(max * 0.6);
  const tailLen = max - headLen;
  const omitted = s.length - headLen - tailLen;
  return `${s.slice(0, headLen)}\n...[${omitted} chars truncated]...\n${s.slice(s.length - tailLen)}`;
}
function formatGateFailure(stdout: string, stderr: string, fallback: string): string {
  const out = stdout.trim();
  const err = stderr.trim();
  const parts: string[] = [];
  if (out) parts.push(`stdout:\n${capStream(out, GATE_MESSAGE_STREAM_CAP)}`);
  if (err) parts.push(`stderr:\n${capStream(err, GATE_MESSAGE_STREAM_CAP)}`);
  if (!parts.length) parts.push(fallback);
  return parts.join("\n\n");
}
export const defaultGateExec: GateExecFn = (command, args, cwd, env, timeoutMs) => new Promise((resolve) => {
  const bound = timeoutMs ?? GATE_COMMAND_TIMEOUT_MS;
  let settled = false;
  const settleOnce = (result: GateExecResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    clearTimeout(hardTimer);
    resolve(result);
  };
  const child = execFile(command, args, { cwd, env: { ...process.env, ...env }, timeout: bound },
    (err, stdout, stderr) => {
      if (!err) return settleOnce({ ok: true, message: stdout.trim() });
      settleOnce({ ok: false, message: formatGateFailure(stdout, stderr, err.message || "command failed") });
    });
  // GATE-HANG-HARDENING: execFile already sent SIGTERM at `bound`; if the child is still alive
  // shortly after, escalate to SIGKILL — never rely on a single signal alone to end an
  // uncooperative process.
  const killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already dead */ } }, bound + GATE_KILL_GRACE_MS);
  killTimer.unref?.();
  // GATE-HANG-HARDENING: the absolute ceiling — this promise resolves here even if the OS
  // process never actually exits (SIGKILL is not guaranteed against e.g. an uninterruptible
  // D-state process), so the caller (evaluateGate -> handleWorkflowTurn's stepTransitioning
  // lock) can never be wedged by an unkillable child.
  const hardTimer = setTimeout(() => {
    settleOnce({ ok: false, message: `gate command "${command}" did not exit within ${bound + GATE_HARD_CEILING_GRACE_MS}ms of its ${bound}ms timeout (forced) — process may be unkillable (D-state, orphaned docker child, contended host)` });
  }, bound + GATE_HARD_CEILING_GRACE_MS);
  hardTimer.unref?.();
});

// Bounded loops: "gte"/"lte" compare NUMERICALLY (Number() parse; NaN on either side fails
// closed to false — a non-numeric value can never satisfy a numeric comparator). "equals"/
// "notEquals"/"contains" are plain STRING comparisons.
function compareArtifactValue(actual: string, op: "equals" | "notEquals" | "contains" | "gte" | "lte", expected: string): boolean {
  switch (op) {
    case "equals": return actual === expected;
    case "notEquals": return actual !== expected;
    case "contains": return actual.includes(expected);
    case "gte": case "lte": {
      const a = Number(actual), b = Number(expected);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return op === "gte" ? a >= b : a <= b;
    }
  }
}

// F16.1 Phase 3 (WF-9, data handoff): the summarize turn's fixed timeout cap (design
// §3.4) — if the outgoing agent's turn_complete doesn't arrive in time, the switch
// proceeds with an artifacts-only handoff rather than wedging the workflow.
// Injectable via SchedulerDeps.handoffTimeoutMs for tests.
const HANDOFF_TIMEOUT_MS = 120_000;
// The captured summary is bounded (design §3.4: "first 8KB") before it's persisted to
// stepHistory and injected into the next agent's prompt.
const HANDOFF_SUMMARY_CAP_CHARS = 8192;

// STEP-AGENT-ENDS-DONE: a step-boundary switch's outgoing agent already passed its gate —
// closeInput() lets it finish gracefully (state settles "done"), but a hung agent that never
// answers the close (e.g. stuck mid tool-call) must not wedge the switch forever. This bounds
// the grace period before falling back to a hard kill. Injectable via SchedulerDeps for tests.
const STEP_SWITCH_GRACE_MS = 60_000;

// FEATURE-3: the default cap on ONE critic evaluation round (spawn + its single turn) —
// injectable via SchedulerDeps.criticTimeoutMs for tests.
const CRITIC_TIMEOUT_MS = 300_000;
const BACKGROUND_TASK_TIMEOUT_MS = 15 * 60_000;

// GATE-HANG-HARDENING: a second, OUTER ceiling around the entire evaluateGate() call in
// handleWorkflowTurn — defense in depth alongside defaultGateExec's own hardening above. The
// command gate is the one gate kind proven to have hung in production, but `stepTransitioning`
// guards EVERY gate kind (approval/artifact/plan/critic too), and any one of them growing an
// unbounded await in the future would reproduce the exact same wedge. This ceiling makes that
// structurally impossible instead of merely unlikely: whichever gate kind is running, the
// `await` in handleWorkflowTurn always resolves within this bound, so the function always
// reaches its `finally` and releases the lock — a late resolution from the abandoned real gate
// call is simply discarded (evaluateGate has no side effects of its own besides its own return
// value). Set comfortably above the worst legitimate case: a command gate's own timeoutMs is
// schema-capped at 600s (protocol's WorkflowGate) and defaultGateExec's hard ceiling adds at
// most GATE_HARD_CEILING_GRACE_MS on top (~10.5min worst case); a critic round is capped at
// CRITIC_TIMEOUT_MS (5min). Injectable via SchedulerDeps.gateEvalHardCeilingMs for tests.
const GATE_EVAL_HARD_CEILING_MS = 15 * 60_000;

// F16.1 Phase 3 (WF-9): a step-boundary switch's context package for the INCOMING
// agent's first prompt — null for a context:"none" step (no package at all); non-null
// (possibly with summary:null, the artifacts-only fallback) for a context:"handoff" step.
type HandoffPackage = { fromStepIndex: number; summary: string | null };

// The outgoing agent's in-flight summarize turn — armed by beginHandoff, resolved by
// EITHER the agent's own turn_complete (the happy path) or the fixed timeout (fallback).
// In-memory only (design §3.4): a daemon restart naturally clears it, and the still-
// unadvanced task cursor (advanceStep hasn't run yet — see completeHandoff) resumes via
// the ordinary pending-task pickup, redoing the just-passed step from a fresh agent.
type AwaitingHandoff = {
  wf: WorkflowRecord; nextIndex: number; fromStepIndex: number;
  timer: ReturnType<typeof setTimeout>; resolved: boolean; summaryText?: string;
};

export type SchedulerDeps = {
  teams: TeamManager; queues: QueueStore; supervisor: AgentSupervisor; events: EventLog;
  // ROLES-UNIFY §4: the role library resolveRole reads through — every team.roles[key]
  // is now a {role, overrides} reference, not a ready-to-spawn template.
  roles: RoleStore;
  // D12 (task workflows, coverage C14): the step-gate machine's spec store + the
  // command-gate exec seam (defaults to a real execFile — see defaultGateExec above).
  workflows: WorkflowStore; gateExec?: GateExecFn;
  // D13 (artifact registry, coverage C15): the `artifact` gate's registry lookup.
  artifacts: ArtifactStore;
  retickDelayMs?: number;   // guardrail-starvation fallback re-tick (default 30s; injectable for tests)
  // F16.1 Phase 3 (WF-9): the handoff summarize turn's fixed timeout (default 120s — see
  // HANDOFF_TIMEOUT_MS); injectable so tests don't wait out the real cap.
  handoffTimeoutMs?: number;
  // STEP-AGENT-ENDS-DONE: a step-switch's outgoing-agent grace period (default 60s — see
  // STEP_SWITCH_GRACE_MS); injectable so tests don't wait out the real cap.
  stepSwitchGraceMs?: number;
  // FEATURE-3: one critic-gate round's cap (default 300s — see CRITIC_TIMEOUT_MS);
  // injectable so tests don't wait out the real cap.
  criticTimeoutMs?: number;
  // GATE-HANG-HARDENING: the outer evaluateGate() ceiling (default 15min — see
  // GATE_EVAL_HARD_CEILING_MS); injectable so tests don't wait out the real cap.
  gateEvalHardCeilingMs?: number;
  backgroundTaskTimeoutMs?: number;
};

export class QueueScheduler {
  // agentId → task binding. agentId is opaque — never parse it; Phase 5 introduces
  // engine-qualified addressing and qualified ids must fit here unchanged.
  // Task B1: `role` was added so rosterFor() can list a running EPHEMERAL
  // teammate's role (persistent teammates' roles come from poolIndex instead).
  // F16.1 Phase 3 (WF-9): `awaitingHandoff` is set on the OUTGOING agent's binding for
  // the window between "its step's gate passed and a role switch needs a handoff" and
  // "the summary is captured (or the timeout fires)" — see beginHandoff/resolveAwaitingHandoff.
  // TRUNCATION-SURFACE: `truncated` is set from the turn_complete that the generic backend flags
  // when a KEEPALIVE session's turn was cut off at the output ceiling — the session survives, but
  // that turn's output is not a usable task result (see the persistent-worker branch below).
  private tracked = new Map<string, { taskId: string; team: string; role: string; awaitingHandoff?: AwaitingHandoff; truncated?: boolean }>();
  private backgroundWaitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Task A3: per-team/role pool of long-lived persistent workers. A worker is
  // added on persistent spawn, removed on death (settle/onAgentEvent) or team dissolution (retire, Task A4).
  private pool = new Map<string /*team*/, Map<string /*role*/, Set<string /*agentId*/>>>();
  // reverse index for O(1) "is this agentId a persistent pool worker, and for which team/role".
  private poolIndex = new Map<string, { team: string; role: string }>();
  // BUG (team detail roster): per-agent count of tasks/turns completed while bound
  // (settle()'s terminal unbind, or a persistent pool worker's turn_complete unbind) —
  // incremented once per bind→unbind cycle, keyed by agentId so it survives a
  // persistent worker cycling through many tasks over its lifetime. Never reset/pruned
  // (mirrors AgentSupervisor's agents map, which also keeps terminal records forever).
  private runCounts = new Map<string, number>();
  // F16.1 Phase 3 (WF-8): a step-boundary role switch whose next-role spawn hit a
  // guardrail (accounts cooling down etc.) — the task stays in_progress at its
  // (already advanced) stepIndex with NO bound agent, so it will never resurface via
  // queues.nextPending. tick() retries every entry here on every tick (see the top of
  // tick() below), keyed by taskId so a park replaces any earlier one for the same task.
  private parkedSwitches = new Map<string, {
    team: string; roleName: string; wfName: string; wfVersion: number; stepIndex: number;
    // F16.1 Phase 3 (WF-9): the handoff package (if any) resolved BEFORE the spawn
    // guardrailed — carried through so the eventual retry still injects it.
    handoff: HandoffPackage | null;
    // BUG (dead-agent gate-retry drops retry reason): a same-step retry respawn that itself
    // guardrails must still carry the failing gate's reason (or critic's REVISE feedback)
    // through to the eventual retried spawn — otherwise a guardrail delay silently drops it.
    retryReason?: string;
  }>();
  // WORKFLOW-STEP-SURVIVES-AGENT-EXIT: taskIds whose step-boundary decision
  // (handleWorkflowTurn) is currently being worked out — set synchronously the instant
  // handleWorkflowTurn starts (before its first await), cleared when it returns. A
  // one-shot backend (e.g. GENERIC) can reach its own terminal "done" state before this
  // async decision (gate eval, possibly a handoff) finishes; settle()'s matching guard
  // defers to the in-flight call entirely rather than racing it with an unconditional
  // markDone at whatever step the agent happened to die on.
  private stepTransitioning = new Set<string>();
  private ticking = false;
  private tickQueued = false;
  private starved = false;                                     // a guardrail rejection left tasks pending this tick
  private retick: ReturnType<typeof setTimeout> | null = null;
  // RETRY-BACKOFF: taskId -> the epoch-ms this parked (in_progress, no bound agent) task's
  // backoff delay elapses. Populated by settle()'s markFailedAttempt-parked branch and by
  // handleWorkflowTurn's policy-driven retry branch; drained by releaseDueRetries(). Lighter
  // than parkedSwitches above (which carries WF-8-specific role/handoff replay fields it needs
  // to retry a guardrail-blocked spawn identically) — releasing a parked retry just flips the
  // task back to "pending" and lets the ordinary nextPending()/spawnForTask/assignPersistent
  // pickup re-derive everything generically (the same restart-recovery contract already used for
  // "task reverted in_progress -> pending, resume from persisted stepIndex"). In-memory only
  // (mirrors AwaitingHandoff/parkedSwitches) — a daemon restart naturally clears it; the
  // existing constructor sweep in queues.ts reverts ANY in_progress task straight to "pending"
  // on boot regardless, so a restart mid-backoff just skips the remainder of the delay rather
  // than losing the retry.
  private pendingRetries = new Map<string, number>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;

  constructor(private deps: SchedulerDeps) {
    deps.queues.setPrincipalResolver(from => deps.supervisor.principalFor(from));
  }

  attach(): void {
    this.unsub ??= this.deps.events.subscribe((e) => {
      // Task A4: a persistent pool worker is observed even while UNTRACKED (idle,
      // unbound after turn_complete) — its terminal events must reach onAgentEvent
      // so a death while idle removes it from the pool instead of leaking the slot.
      if (!this.tracked.has(e.agentId) && !this.poolIndex.has(e.agentId)) return;
      // F16.1 Phase 3 (WF-9): capture the summarize turn's text SYNCHRONOUSLY (before the
      // setTimeout(0) deferral below) — message_complete always precedes its turn_complete
      // in the same synchronous append, so by the time the deferred turn_complete handling
      // runs (onAgentEvent, further below), the summary is already stashed.
      if (e.kind === "message_complete") {
        const wait = this.tracked.get(e.agentId)?.awaitingHandoff;
        if (wait && !wait.resolved) wait.summaryText = String(e.data["text"] ?? "").slice(0, HANDOFF_SUMMARY_CAP_CHARS);
      }
      // TRUNCATION-SURFACE: stashed SYNCHRONOUSLY for the same reason as the handoff summary
      // above — the turn_complete handling below runs a macrotask later, off the agentId alone,
      // with no access to this event's payload.
      if (e.kind === "turn_complete" && e.data["truncated"] === true) {
        const bound = this.tracked.get(e.agentId);
        if (bound) bound.truncated = true;
      }
      // setTimeout(0): defense-in-depth around append/state ordering (Phase 1 as fixed commits state first).
      // .catch: a settle-triggered tick must NEVER become an unhandled rejection that kills the daemon.
      setTimeout(() => { this.onAgentEvent(e.agentId, e.kind).catch(() => {}); }, 0);
    });
  }

  // Task A3: turn_complete for a still-RUNNING persistent pool worker settles
  // its bound task WITHOUT killing the worker (it stays alive, idle, in the
  // pool, for the next task) — everything else (ephemeral events, and any
  // event once the worker has actually gone terminal) falls through to the
  // existing terminal-state settle().
  // Task A4: an UNTRACKED (idle) pool worker's event is ALSO observed here now
  // (attach()'s guard lets it through) — a terminal state on an idle worker
  // removes it from the pool and re-ticks (frees the slot for a fresh
  // respawn); a non-terminal event on an idle worker is a no-op (it's still
  // alive in the pool, available for reuse).
  private async onAgentEvent(agentId: string, kind: EventKind): Promise<void> {
    // D12: a workflow-bound task owns its ENTIRE multi-step turn_complete lifecycle —
    // intercepted here, BEFORE the persistent-pool-worker (Task A3) branch below, which
    // would otherwise treat a mid-workflow turn_complete as "the bound task is finished
    // and this worker is idle again" (wrong: there may be several more steps to go).
    if (kind === "turn_complete") {
      const bound = this.tracked.get(agentId);
      // F16.1 Phase 3 (WF-9): a summarize turn's own turn_complete is NOT a gate
      // evaluation — resolve the pending handoff instead (design §3.4's "MARK the
      // summarize turn" requirement, keyed on the in-memory awaitingHandoff flag).
      if (bound?.awaitingHandoff) { this.resolveAwaitingHandoff(agentId, false); return; }
      if (bound) {
        let task: TaskRecord | null;
        try { task = this.deps.queues.getTask(bound.taskId); } catch { task = null; }
        if (task?.workflow) { await this.handleWorkflowTurn(agentId, task); return; }
      }
    }
    if (kind === "turn_complete" && this.poolIndex.has(agentId)) {
      const rec = this.deps.supervisor.status(agentId);
      if (rec.state === "running") {
        const t = this.tracked.get(agentId);
        if (!t) return;                          // already unbound by an earlier event on this same agent
        if (t.truncated) {
          // TRUNCATION-SURFACE: the WORKER survives a truncated turn (backends/generic.ts keeps
          // a keepAlive session alive and reports the cut-off as a transcript notice), but its
          // bound TASK must not be marked done on it — the turn was cut off mid-generation, so
          // rec.resultText is either stale or empty and markDone would record that as the task's
          // answer. Retryable, never a cascade: same failAttempt path settle() uses.
          this.failAttempt(t.taskId, 1, "agent turn truncated at the output token ceiling (finish_reason: length)");
        } else if (rec.permissionDenied || rec.toolPolicyDenied) {
          this.failAttempt(t.taskId, 1, rec.toolPolicyDenied
            ? "agent did not complete the task (tool policy denied one or more tool calls)"
            : "agent did not complete the task (permission request was declined or cancelled)");
        } else {
          this.deps.queues.markDone(t.taskId, rec.resultText ?? "", { toolPolicyDenied: rec.toolPolicyDenied });   // accepted v1 simplification: may be "" mid-life
        }
        this.tracked.delete(agentId);             // unbind — worker is now idle in the pool
        this.deps.supervisor.setOriginConductor(agentId, null);
        this.runCounts.set(agentId, (this.runCounts.get(agentId) ?? 0) + 1);
        await this.tick();
        return;
      }
    }
    if (!this.tracked.has(agentId) && this.poolIndex.has(agentId)) {
      const rec = this.deps.supervisor.status(agentId);
      // "paused" is a NON-terminal session-limit HOLD (the worker auto-resumes at its reset),
      // so treat it like "running" here — evicting a paused worker from the pool would leak
      // the slot and orphan the worker when it resumes.
      if (rec.state !== "running" && rec.state !== "paused") {
        const info = this.poolIndex.get(agentId)!;
        this.pool.get(info.team)?.get(info.role)?.delete(agentId);
        this.poolIndex.delete(agentId);
        await this.tick();                 // freed a pool slot → route pending work to a fresh worker
      }
      return;                              // idle worker that's still running/paused emitted a non-terminal event — nothing to do
    }
    await this.settle(agentId);
  }

  // Task A4: close every persistent worker of a (dissolving) team and
  // de-register it from the pool so no further work is routed to it.
  // closeInput is graceful — the worker finishes its current turn then its
  // input ends; retirement must NEVER hard-kill a busy worker. Safe to call
  // for a team with no pool entry (never spawned a persistent worker, or
  // unknown name) — a no-op.
  retire(teamName: string): void {
    const roles = this.pool.get(teamName);
    if (!roles) return;
    for (const set of roles.values()) {
      for (const agentId of set) {
        void this.deps.supervisor.closeInput(agentId).catch(() => {});
        this.poolIndex.delete(agentId);
      }
    }
    this.pool.delete(teamName);
  }

  detach(): void {
    this.unsub?.(); this.unsub = null;
    if (this.retick) { clearTimeout(this.retick); this.retick = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    for (const timer of this.backgroundWaitTimers.values()) clearTimeout(timer);
    this.backgroundWaitTimers.clear();
  }

  agentsFor(team: string): string[] {
    return [...this.tracked.entries()]
      .filter(([agentId, t]) => t.team === team && this.deps.supervisor.status(agentId).state === "running")
      .map(([agentId]) => agentId);
  }

  // Task D2: ALL currently-running members of `teamName` (optionally filtered
  // to a single `role`) — unlike agentsFor/team.status (TRACKED/busy only),
  // this ALSO includes idle persistent pool workers (unbound after
  // turn_complete). Persistent members come from `pool`; ephemeral members
  // come from `tracked`, skipping anything already counted via poolIndex so a
  // busy persistent worker (present in both `pool` and `tracked`) isn't
  // listed twice. A live view (unlike rosterFor's spawn-time snapshot) — each
  // entry's running-state is re-checked here rather than trusted from map
  // presence, since pool/tracked cleanup for a just-died agent is deferred
  // (attach()'s event handler runs on a separate macrotask).
  // Every caller is a DELIVERY path (agent.askTeam, hook notify targets) — none of them size
  // capacity — so a member whose process was merely reclaimed (idle-reap) or left dormant by a
  // daemon restart is still a member: delivering to it is what wakes it (send()'s revive step).
  // Listing only "running" here silently dropped exactly those members from ask_team, which
  // for a parked conductor meant its team could no longer reach it at all.
  membersOf(teamName: string, role?: string): Array<{ agentId: string; role: string }> {
    const out: Array<{ agentId: string; role: string }> = [];
    const reachable = (id: string): boolean => {
      const rec = this.deps.supervisor.status(id);
      return rec.state === "running" || isRevivableHold(rec);
    };
    const roles = this.pool.get(teamName);
    if (roles) for (const [r, set] of roles) {
      if (role && r !== role) continue;
      for (const id of set) if (reachable(id)) out.push({ agentId: id, role: r });
    }
    for (const [id, t] of this.tracked) {
      if (t.team !== teamName || this.poolIndex.has(id)) continue;    // pool workers already counted
      if (role && t.role !== role) continue;
      if (reachable(id)) out.push({ agentId: id, role: t.role });
    }
    return out;
  }

  runningFor(team: string): number { return this.agentsFor(team).length; }

  // D13 (artifact registry): the CURRENT task a tracked agent is bound to, if any —
  // artifact.add uses this to auto-scope a registration to the caller's in-flight task
  // without requiring the agent to know/pass its own taskId. null for an untracked
  // agent (not currently bound to any task) or a direct/human call with no agentId.
  taskFor(agentId: string): string | null { return this.tracked.get(agentId)?.taskId ?? null; }

  // Task (team detail roster): tasks/turns this agentId has completed while bound
  // (see runCounts above) — 0 for an agent that never finished a bound task.
  runCountFor(agentId: string): number { return this.runCounts.get(agentId) ?? 0; }

  // Task C1: direct assignment. agentId target → deliver straight to that
  // agent's mailbox (supervisor.send propagates UnknownAgentError/
  // AgentNotRunningError unchanged). team target → push onto the team's bound
  // queue (with the role) and drain via the EXISTING tick() routing — reuses
  // all of Phase A's pool/spawn logic rather than duplicating it here.
  async assign(
    target: { agentId: string } | { team: string; role?: string },
    prompt: string, priority?: number, callerAgentId?: string,
  ): Promise<{ delivered: true; agentId: string } | TaskRecord> {
    if ("agentId" in target) {
      await this.deps.supervisor.send(target.agentId, prompt, callerAgentId ?? "operator");
      return { delivered: true, agentId: target.agentId };
    }
    const team = this.deps.teams.get(target.team);   // throws UnknownTeamError
    if (!team.queue) throw new SchedulerError(`team "${target.team}" has no queue to assign into`);
    const task = this.deps.queues.push(team.queue, {
      prompt, role: target.role ?? null, priority: priority ?? 0, overrides: {}, author: this.deps.supervisor.principalFor(callerAgentId ?? "operator"), pushedBy: callerAgentId ?? null,
    });
    await this.tick();
    return task;
  }

  async tick(): Promise<void> {
    if (this.retick) { clearTimeout(this.retick); this.retick = null; }   // an explicit tick supersedes the fallback
    if (this.ticking) { this.tickQueued = true; return; }
    this.ticking = true;
    this.starved = false;
    try {
      // sweep: settle tracked agents that reached a terminal state WITHOUT an event
      // (AgentSupervisor.kill and the failover-relaunch-failure path emit nothing)
      for (const agentId of [...this.tracked.keys()])
        if (this.deps.supervisor.status(agentId).state !== "running") await this.settle(agentId);

      // F16.1 Phase 3 (WF-8): retry any step-role switch parked on a guardrail rejection.
      // This task never reverted to "pending" (see switchStepAgent) so queues.nextPending
      // below will never surface it — this is the ONLY path that retries it.
      for (const [taskId, park] of [...this.parkedSwitches]) {
        let task: TaskRecord;
        try { task = this.deps.queues.getTask(taskId); } catch { this.parkedSwitches.delete(taskId); continue; }
        if (task.state !== "in_progress") { this.parkedSwitches.delete(taskId); continue; }   // resolved some other way
        const team = this.deps.teams.list().find((t) => t.name === park.team);
        if (!team) { this.deps.queues.markFailed(taskId, `team "${park.team}" no longer exists`); this.parkedSwitches.delete(taskId); continue; }
        let wf: WorkflowRecord;
        try { wf = this.deps.workflows.get(park.wfName, park.wfVersion); }
        catch (err) { this.deps.queues.markFailed(taskId, (err as Error).message); this.parkedSwitches.delete(taskId); continue; }
        if (await this.spawnStepAgent(team, park.roleName, task, wf, park.stepIndex, park.handoff, park.retryReason)) this.parkedSwitches.delete(taskId);
      }

      // WorkflowGraph (bounded fan-out): admit the next wave for any fan-out parent whose
      // current wave just fully settled (state flipped back to "pending" via
      // reconcileDependents in queues.ts, triggered by a branch's markDone/markFailed — always
      // immediately followed by a tick(), per settle()'s own tail) but still has un-admitted
      // item-chunks waiting (queues.ts's fanOutRemaining). Runs BEFORE the per-team pickup loop
      // below so a parent with remaining waves never reaches nextPending() for its join step
      // while items are still outstanding — mirrors why the parkedSwitches loop above also runs
      // early. Unlike parkedSwitches, this is sourced from DURABLE TaskRecord state (not an
      // in-memory map) — see queues.ts's fanOutRemaining doc comment for why that matters (a
      // daemon restart must not silently drop the un-admitted tail).
      for (const task of this.deps.queues.pendingFanOuts()) {
        if (!task.workflow) { this.deps.queues.markFailed(task.taskId, "fan-out parent has no pinned workflow"); continue; }
        let wf: WorkflowRecord;
        try { wf = this.deps.workflows.get(task.workflow.name, task.workflow.version); }
        catch (err) { this.deps.queues.markFailed(task.taskId, (err as Error).message); continue; }
        // task.stepIndex currently equals the JOIN step's index (blockOnChildren set it there
        // and it hasn't advanced past it yet) — find the fan-out step that targets it.
        // validateWorkflowGraph's joinOwner uniqueness check guarantees at most one step claims
        // a given joinStep id, so this reverse lookup is unambiguous.
        const joinStepId = wf.steps[task.stepIndex]?.id;
        const fanOutIndex = wf.steps.findIndex((s) => s.fanOut?.joinStep === joinStepId);
        if (fanOutIndex < 0) { this.deps.queues.markFailed(task.taskId, "fan-out parent's step no longer matches a fanOut step"); continue; }
        const step = wf.steps[fanOutIndex]!;
        const fanOut = step.fanOut!;
        const window = fanOut.maxParallel ? task.fanOutRemaining.slice(0, fanOut.maxParallel) : task.fanOutRemaining;
        const rest = task.fanOutRemaining.slice(window.length);
        // No outgoing-agent fallback past wave 1 — beginFanOut's currentRole only exists at the
        // step-boundary transition into the fan-out step itself; later waves are driven by a
        // branch settling, not a step transition, so they fall back straight to task.role.
        const branchRole = step.role ?? task.role ?? null;
        const branchIds = window.map((chunk) => this.deps.queues.push(task.queue, {
          prompt: this.fanOutBranchPrompt(step, chunk, task.prompt),
          role: branchRole, priority: task.priority, parentTaskId: task.taskId, originConductorId: task.originConductorId,
        }).taskId);
        this.deps.queues.setFanOutRemaining(task.taskId, rest);
        this.deps.queues.extendChildren(task.taskId, branchIds);   // flips back to "blocked" unless this was the final wave
        this.emitFanOutBatchAdmitted(task, wf, fanOutIndex, task.stepIndex, branchIds, rest.length);
      }

      // F15-DISPATCH-FENCE:BEGIN
      // Every reason a pending task does NOT start lives in DISPATCH_PREDICATES
      // (dispatch-predicates.ts) — the same array queue.explainTask replays, so a predicate can
      // never exist in dispatch without being explainable. The ONLY decision this region makes
      // for itself is `switch (outcome)` below; a source-guard test
      // (test/scheduler-dispatch-predicates.test.ts) fails the moment an inline markFailed/break
      // reappears here instead of moving into the array.
      for (const team of this.deps.teams.list()) {
        // teamBound's live site is structural, not a predicate evaluation: with no queue there
        // is no task to build a DispatchContext from. The predicate still exists and still
        // fails on the explain path, where the TASK (not the team) is the input.
        if (!team.queue) continue;
        const queueName = team.queue;
        try {
          // QUEUE-PAUSE: a paused queue drains NO new agents — the queueNotPaused predicate
          // returns "teamSkipped" below, so already-running/tracked agents are entirely
          // untouched (they finish naturally) and pending tasks stay pending. nextPending() is
          // a pure read and runs first now, so a paused-AND-missing queue still throws
          // UnknownQueueError into the handler below, same as before. queue.resume ticks
          // immediately (see engine.ts), so this re-admits pending work the instant a queue is
          // un-paused rather than waiting for the next tick.
          // Task A3: persistent and ephemeral roles in the same team's queue each drain under
          // their OWN gate — persistent by pool size (workerCapacity), ephemeral by
          // runningFor(team) (teamConcurrency) — so neither role starves the other's progress.
          drain: for (
            let task = this.deps.queues.nextPending(queueName);
            task;
            task = this.deps.queues.nextPending(queueName)
          ) {
            // F16.1 Phase 3 (WF-8): a workflow-bound task routes to its CURRENT step's role
            // (not the task's own push-time role) so a per-step role correctly picks the
            // persistent-vs-ephemeral branch below, even on the very first (step 0) pickup.
            const roleName = this.routingRoleFor(team, task);
            const template = this.resolveTeamRole(team, roleName);
            const ctx = this.buildDispatchContext(task, team, roleName, template, task);
            const { blocked, result } = firstBlocking(ctx, "loop");
            // specValid/supervisorAdmission are liveSite:"spawn" — the spawn call below IS their
            // live evaluation, and its own try/catch maps a guardrail denial to `false`
            // (drainStops) and anything else to markFailed, exactly as it did before F15.
            const dispatched = blocked !== null ? false : (ctx.persistent
              ? await this.assignPersistent(team, roleName, template!, task, ctx.workflow)
              : await this.spawnForTask(team, task, roleName, template!, ctx.workflow));
            switch (blocked === null ? (dispatched ? "dispatched" : "drainStops") : blocked.onFail) {
              case "dispatched":
                continue drain;
              case "taskFails":
                this.deps.queues.markFailed(task.taskId, result!.failMessage ?? result!.detail);
                continue drain;                                  // permanent — move on to the next task
              default:
                break drain;   // teamSkipped / notSelected / drainStops: retry on a later tick
            }
          }
        } catch (err) {
          if (!(err instanceof UnknownQueueError)) throw err;
          // a (persisted) team bound to a missing queue must not poison the tick or the daemon startup
          this.deps.events.append({
            agentId: `team:${team.name}`, kind: "status",
            data: { team: team.name, state: "queue-missing", queue: team.queue },
          });
        }
      }
      // F15-DISPATCH-FENCE:END
    } finally {
      this.ticking = false;
      // guardrail starvation (e.g. every account cooling down) with no running agent left would
      // otherwise stall forever: arm exactly ONE fallback re-tick, cleared by any explicit tick
      if (this.starved && !this.tickQueued) this.armStarvationRetick();
      if (this.tickQueued) { this.tickQueued = false; await this.tick(); }
    }
  }

  // F16.1 Phase 3 (WF-8): factored out of tick()'s finally block so switchStepAgent can also
  // arm it directly when a step-role switch parks OUTSIDE of a tick() cycle (it's driven by
  // onAgentEvent's turn_complete handling, not by tick()'s own drain loop).
  private armStarvationRetick(): void {
    if (this.retick) return;
    this.retick = setTimeout(() => { this.retick = null; this.tick().catch(() => {}); },
                             this.deps.retickDelayMs ?? 30_000);
    this.retick.unref?.();
  }

  // RETRY-BACKOFF: park taskId for a delayed retry (see pendingRetries' own comment above).
  private scheduleRetry(taskId: string, delayMs: number): void {
    this.pendingRetries.set(taskId, Date.now() + Math.max(0, delayMs));
    this.armRetryTimer();
  }

  private armRetryTimer(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.pendingRetries.size === 0) return;
    const soonest = Math.min(...this.pendingRetries.values());
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.releaseDueRetries(); },
                                  Math.max(0, soonest - Date.now()));
    this.retryTimer.unref?.();
  }

  private async releaseDueRetries(): Promise<void> {
    const now = Date.now();
    const due = [...this.pendingRetries].filter(([, readyAt]) => readyAt <= now).map(([id]) => id);
    for (const id of due) {
      this.pendingRetries.delete(id);
      try { this.deps.queues.releaseForRetry(id); } catch { /* task gone (e.g. queue deleted) */ }
    }
    this.armRetryTimer();   // re-arm for whatever's left
    if (due.length > 0) await this.tick();
  }

  // F15: the ONE DispatchContext builder. The drain loop and explainTask both go through it, so
  // "what the predicates see" can never diverge between explaining and dispatching. Pure: every
  // read is a Map/array lookup or an already-pure helper — nothing here spawns, ticks, mutates a
  // task or appends an event. `head` is passed in by the drain loop (which already holds
  // nextPending's answer) and looked up by explainTask.
  private buildDispatchContext(
    task: TaskRecord, team: TeamSpec | null, roleName: string | null, template: RoleSpec | null,
    head?: TaskRecord | null,
  ): DispatchContext {
    let workflow: WorkflowRecord | null = null;
    let workflowError: string | null = null;
    if (team) {
      try { workflow = this.resolveWorkflow(team, task); }
      catch (err) { workflowError = (err as Error).message; }
    }
    let queue: QueueSpec | null = null;
    try { queue = this.deps.queues.get(task.queue); } catch { /* queueExists reports it */ }
    const persistent = template?.persistent === true;
    // poolFor() CREATES the team/role maps on demand — never call it from a read-only path.
    const pool = (team && roleName ? this.pool.get(team.name)?.get(roleName) : undefined) ?? null;
    const parkedAt = this.pendingRetries.get(task.taskId);
    const park = this.parkedSwitches.get(task.taskId);
    let memoSpec: { ok: boolean; error: string | null } | null = null;
    let memoAdmission: ExplainCheck[] | null = null;
    return {
      task, team, queue, roleName, template, persistent, workflow, workflowError,
      headOfQueue: head !== undefined ? head : this.safeNextPending(task.queue),
      maxConcurrent: team?.maxConcurrent ?? 0,
      poolSize: pool?.size ?? 0,
      poolCap: template?.poolSize ?? team?.maxConcurrent ?? 0,
      // UNTRUNCATED on purpose: taskPending defers to dependenciesSatisfied only when it can
      // SEE an unmet dep here, so a push-order cap made a >64-dep join whose first 64 are done
      // report the useless "state is blocked, not pending" and never name the deps that block
      // it. DispatchContext is internal (the 64 cap is a wire bound, applied in explainTask);
      // nextPending's depsSatisfied already walks every dep, so this costs nothing new.
      depStates: task.dependsOn.map((taskId) => {
        try { return { taskId, state: this.deps.queues.getTask(taskId).state }; }
        catch { return { taskId, state: null }; }
      }),
      parkedRetryMsRemaining: parkedAt === undefined ? null : Math.max(0, parkedAt - Date.now()),
      parkedSwitch: park ? { roleName: park.roleName, stepIndex: park.stepIndex } : null,
      runningForTeam: () => (team ? this.runningFor(team.name) : 0),
      hasIdleWorker: () => (team && roleName ? this.idleWorker(team.name, roleName) !== null : false),
      spec: () => (memoSpec ??= this.probeSpec(task, template, workflow)),
      admission: () => (memoAdmission ??= this.probeAdmission(task, template, workflow)),
      // exposed for explainTask's `admission` field: [] when no predicate ever reached it
      admissionEvaluated: () => memoAdmission ?? [],
    };
  }

  private safeNextPending(queueName: string): TaskRecord | null {
    try { return this.deps.queues.nextPending(queueName); } catch { return null; }
  }

  // F15 (Risk R2 — the plan's one accepted approximation): the spec the drain loop WOULD hand to
  // supervisor.spawn, APPROXIMATED in two directions, not one. It SUBTRACTS the fields no
  // admission check reads (the roster/workflow instruction header, workdirKey — the shared-
  // worktree key), and it ADDS back the fields the live paths set outside the template spread
  // (`persistent`, `conductor`, the workflow step's `model` override) because resolveAgentSpec
  // VALIDATES them: omitting them could make explain report an invalid spec for a task that
  // spawns fine. The additions must mirror whichever live path this task would actually take —
  // see probeAgentSpec, which is pinned to that by scheduler-probe-spec-parity.test.ts.
  private probeSpec(task: TaskRecord, template: RoleSpec | null, wf: WorkflowRecord | null): { ok: boolean; error: string | null } {
    if (!template) return { ok: false, error: "no role template to build a spec from" };
    try { this.probeAgentSpec(task, template, wf); return { ok: true, error: null }; }
    catch (err) { return { ok: false, error: (err as Error).message }; }
  }

  private probeAgentSpec(task: TaskRecord, template: RoleSpec, wf: WorkflowRecord | null): AgentSpec {
    const { poolSize: _poolSize, name: _name, skills: _skills, ...agentTemplate } = template;
    const baseInstr = typeof task.overrides.instructions === "string" ? task.overrides.instructions : agentTemplate.instructions;
    const stepModel = wf?.steps[task.stepIndex]?.model;
    return resolveAgentSpec({
      ...agentTemplate, ...task.overrides,
      ...(template.persistent ? { persistent: true } : {}),
      // A persistent template NEVER reaches spawnForTask: buildDispatchContext sets
      // ctx.persistent from template.persistent and drain routes it to assignPersistent, which
      // sets `persistent: true` and deliberately NOT `conductor` (its D12 comment: persistent
      // already keeps the input stream open across turns). So the probe must not add conductor
      // for a persistent template either, or it would validate a spec no live path builds.
      ...(wf && !template.persistent ? { conductor: true } : {}),
      ...(stepModel ? { model: stepModel } : {}),
      ...(baseInstr !== undefined ? { instructions: baseInstr } : {}),
      prompt: task.prompt,
    });
  }

  // F15: replays the supervisor's OWN admission array (never a re-derivation) against the spec
  // this task would spawn with. treeId is synthetic-but-stable: a fresh task spawn always gets a
  // brand-new tree, so no explain call can ever report a paused one it would not actually get.
  private probeAdmission(task: TaskRecord, template: RoleSpec | null, wf: WorkflowRecord | null): ExplainCheck[] {
    if (!template) return [];
    let spec: AgentSpec;
    try { spec = this.probeAgentSpec(task, template, wf); } catch { return []; }
    return this.deps.supervisor.explainAdmission({
      spec, depth: 0, treeId: `explain:${task.taskId}`,
      ...(task.parentTaskId ? { budgetParentId: task.parentTaskId } : {}),
    });
  }

  /** F15 (queue.explainTask). Pure: evaluates DISPATCH_PREDICATES against the SAME context the
   *  drain loop builds, without spawning, ticking, or mutating anything. Throws UnknownTaskError
   *  for an unknown id (queues.getTask's own error, already mapped by the RPC layer). */
  explainTask(taskId: string): TaskExplainResult {
    const task = this.deps.queues.getTask(taskId);
    const team = this.teamForQueue(task.queue);
    const roleName = team ? this.routingRoleFor(team, task) : null;
    const template = team && roleName ? this.resolveTeamRole(team, roleName) : null;
    const ctx = this.buildDispatchContext(task, team, roleName, template);
    const { blocked, result, checks } = firstBlocking(ctx);
    // A6: the bound agent's OWN recorded cost — never an estimate, and never an event scan.
    let costUsd: number | null = null;
    if (task.agentId) { try { costUsd = this.deps.supervisor.status(task.agentId).costUsd; } catch { costUsd = null; } }
    return {
      taskId: task.taskId, queue: task.queue, team: team?.name ?? null, role: roleName,
      dispatchable: blocked === null,
      blockedBy: blocked?.name ?? null,
      // The 240 cap is the WIRE schema's (TaskExplainResultSchema.detail) — and a zod .max() is
      // not a runtime guard here, since validateRpcResponse is opt-in, so the producer truncates.
      // Matches the sibling slices on every other detail we put on this field.
      detail: blocked === null ? null : (checks.find((c) => c.name === blocked.name)?.detail ?? result!.detail).slice(0, 240),
      checks,
      admission: ctx.admissionEvaluated(),
      context: {
        state: task.state, agentId: task.agentId, costUsd,
        attempts: task.attempts, stepIndex: task.stepIndex,
        stepId: ctx.workflow?.steps[task.stepIndex]?.id ?? null,
        stepAttempts: task.stepAttempts,
        error: task.error === null ? null : task.error.slice(0, 400),
        // TaskExplainContextSchema caps this at 64 while TaskRecord.dependsOn is unbounded, so
        // the wire truncation happens HERE — unmet first, because an unmet dep IS the answer to
        // "why is this not running" and must never be the entry that falls off the end.
        dependsOn: [
          ...ctx.depStates.filter((d) => d.state !== "done"),
          ...ctx.depStates.filter((d) => d.state === "done"),
        ].slice(0, 64),
        recentSteps: task.stepHistory.slice(-3),
      },
      evaluatedAt: Date.now(),
    };
  }

  // F15: `roleName`/`template`/`wf` are resolved ONCE by the drain loop's DispatchContext and
  // handed in — the roleKnown and workflowResolvable predicates own those two failures now (both
  // markFailed with the exact messages this method used to throw), so re-resolving here would
  // either duplicate the work or let resolveWorkflow throw straight into tick()'s outer catch,
  // which rethrows anything that is not an UnknownQueueError and would poison the whole tick.
  private async spawnForTask(
    team: TeamSpec, task: TaskRecord, roleName: string, template: RoleSpec, wf: WorkflowRecord | null,
  ): Promise<boolean> {
    try {
      // strip role-level-only fields — not part of AgentSpec, so they must not ride into
      // the strict spawn merge: poolSize (Task A1), and ROLES-UNIFY's own `name`/`skills`
      // (RoleSpec's two fields beyond the old RoleTemplate's shape — `skills` is folded
      // into `instructions` by resolveRole already, so dropping the raw array here is
      // not a loss). `persistent` IS a valid AgentSpec field (Task A2) and must flow
      // through so the backend sees it and keeps the input stream open across turns.
      const { poolSize: _poolSize, name: _name, skills: _skills, ...agentTemplate } = template;
      // Task B1: membership + a snapshotted teammate roster ride on EVERY team
      // spawn (ephemeral here, persistent below) — set AFTER the overrides spread
      // so a per-task override can never silently drop the roster header.
      // preserve a per-task instructions OVERRIDE (not just the role template's) after the roster header
      const baseInstr = typeof task.overrides.instructions === "string" ? task.overrides.instructions : agentTemplate.instructions;
      let instructions = this.instructionsHeader(team, roleName, baseInstr);
      // D12: an ephemeral (non-persistent) spawn normally closes its input after one
      // idle turn (backends/claude.ts) — force `conductor:true` so a workflow-bound
      // task's session stays open across steps; we close it ourselves once the last
      // step's gate passes (or kill it on a halting gate failure).
      // WorkflowGraph: non-undefined only when this task just fanned out and stepIndex now
      // points at the join step (restart-recovery case — see queues.ts blockOnChildren) —
      // undefined (a no-op trailing arg) for every task that never fanned out.
      // FEATURE-2: combined with a resume notice when a checkpoint already exists at this
      // stepIndex (a crash-restart re-dispatch, or a same-step retry) — undefined for a
      // genuine first attempt, exactly like mergeSummaryText's own no-op default.
      if (wf) instructions = this.workflowInstructions(wf, task.stepIndex, agentTemplate.provider, instructions, this.combineHandoffNotes(this.mergeSummaryText(task), this.maybeResumeNotice(task, task.stepIndex)), task);
      // FEATURE-2: every workflow-bound task now shares ONE task-stable worktree from step 0,
      // regardless of step roles/critic gates — this IS the durable-resume fix. Previously this
      // was gated to `hasStepRoles(wf) || hasCriticGate(wf)`, so the COMMON case (a single-role
      // workflow with no critic gate) left workdirKey undefined, keying the worktree on the
      // (changing, per-crash) agentId instead — a crash-recovered respawn got a brand-new
      // worktree/branch, silently abandoning whatever the crashed agent had already committed.
      // ensureWorkdir (workdir.ts) already reuses an existing worktree by key when one exists —
      // the fix is purely this key's stability, not a missing mechanism.
      const workdirKey = wf ? this.sharedWorkdirKey(task.taskId) : undefined;
      // TOKEN-OPT-P5: step 0's own model override (later steps get theirs via
      // spawnStepAgent's identical modelOverride) — spread LAST so it wins over both
      // the role template's model and any task-level override.
      const stepModel = wf?.steps[task.stepIndex]?.model;
      const rec = await this.deps.supervisor.spawn(
        {
          ...agentTemplate, ...task.overrides, ...(wf ? { conductor: true } : {}), ...(workdirKey ? { workdirKey } : {}),
          ...(stepModel ? { model: stepModel } : {}), prompt: task.prompt, instructions,
        },
        // FEATURE-5: register this task's root budget node (if maxBudgetUsd is set, via
        // task.overrides/JobSpec) under the STABLE task.taskId rather than this spawn's own
        // ephemeral agentId — so a later role-switch respawn (spawnStepAgent) can nest a
        // step-level ceiling under it via budgetParentId. A no-op when no maxBudgetUsd is set.
        // Dynamic Planner: a parented task (a fan-out branch OR a plan-dispatch child)
        // additionally climbs its PARENT task's own budget node — so a runaway planner (or
        // fan-out) can't escape an ancestor's ceiling even when it declares no ceiling of
        // its own. A no-op (identical spawn options) for the overwhelming majority of tasks,
        // which have no parentTaskId.
        {
          membership: { team: team.name, role: roleName }, budgetNodeId: task.taskId,
          originConductorId: task.originConductorId, promptFrom: task.author?.from ?? task.pushedBy ?? "operator", promptAuthor: task.author,
          ...(task.parentTaskId ? { budgetParentId: task.parentTaskId } : {}),
        },
      );
      this.tracked.set(rec.agentId, { taskId: task.taskId, team: team.name, role: roleName });
      this.deps.queues.markInProgress(task.taskId, rec.agentId);
      if (wf && task.workflow === null) this.deps.queues.pinWorkflow(task.taskId, { name: wf.name, version: wf.version });
      if (wf) {
        this.emitStepAdvanced(task.taskId, task.queue, wf, task.stepIndex);
        this.deps.queues.startStep(task.taskId, task.stepIndex, wf.steps[task.stepIndex]!.id, rec.agentId);
      }
      // FEATURE-10 fix: capture unconditionally, not just for workflow-bound tasks —
      // EvidenceStore needs this per-task git marker (commitSha/workdirKey/capturedAt) to
      // bound a diff to exactly THIS task's own commits, even for a plain (non-workflow)
      // task later reused off a persistent pool worker's shared worktree/branch (see
      // evidence.ts's candidateKeys/resolveOne).
      this.captureStepCheckpoint(task.taskId, task.stepIndex, task.stepAttempts, rec.agentId);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "guardrail") {   // caps/cooldowns full: stay pending, zero attempts
        this.starved = true;
        return false;
      }
      this.deps.queues.markFailed(task.taskId, (err as Error).message);    // unknown account, invalid merged spec etc. — permanent
      return true;
    }
  }

  // F16.1 Phase 3 (WF-8): the shared task-worktree key (design §3.2, "Option A") — every
  // workflow-bound task keys its worktree on the TASK, not the (changing) agentId, so
  // successive step agents (role switches, retries, crash-restart re-dispatches) all land in
  // the same workspace. FEATURE-2: this is now unconditional for ANY workflow-bound task (was
  // previously gated to step-roles/critic-gate workflows only — see spawnForTask's comment).
  private sharedWorkdirKey(taskId: string): string { return `task-${taskId}`; }

  // FEATURE-2: deterministic per-(task, step) idempotency key — stable across any number of
  // retries/crash-restarts of the SAME step, distinct once stepIndex advances. This is the
  // idempotency semantic for this slice; full tool-call-level side-effect dedup is a follow-up
  // — this key is the stable handle a resumed agent (or a gate script, via CHIMERA_IDEMPOTENCY_
  // KEY below) uses to recognize "this exact step attempt has run before."
  private stepIdempotencyKey(taskId: string, stepIndex: number): string { return `${taskId}:step-${stepIndex}`; }

  // FEATURE-2: best-effort durable-resume checkpoint, captured right after EVERY fresh agent
  // bind to a step. Reads the ACTUAL resolved spec back off the supervisor (mirrors
  // evaluateGate's G1 pattern) rather than trusting locally-computed variables, so the
  // checkpoint can never drift from what was really spawned. `stepIndex`/`gateAttempts` are
  // passed explicitly by each call site rather than re-read off a (possibly stale, or
  // differently-shaped for spawnStepAgent's callers) `task` object. Wrapped so a git/fs
  // hiccup here degrades to "no checkpoint this round," never a failed step.
  // FEATURE-10 fix: ALSO called for a persistent pool worker's idle-reuse bind (assignPersistent)
  // now — that's precisely the "same worktree/branch handed to a new task" moment EvidenceStore
  // needs a fresh marker for, to keep an earlier task's diff from swallowing a later task's
  // commits on the shared branch (see evidence.ts's candidateKeys/resolveOne). No new workdir is
  // created there, but the EXISTING one still needs a per-task boundary stamped on it.
  private captureStepCheckpoint(taskId: string, stepIndex: number, gateAttempts: number, agentId: string): void {
    try {
      const spec = this.deps.supervisor.status(agentId).spec;
      // isolation:"none" has no worktree at all — ensureWorkdir ignores workdirKey entirely
      // for it (always returns spec.cwd), so recording one here would be misleading. All
      // three of workdirKey/branch/commitSha stay null together in that case (the checkpoint
      // itself is still recorded — its stepIndex/idempotencyKey/capturedAt remain meaningful
      // for durable-resume regardless of isolation). Otherwise mirror worktreeKey()'s own
      // `workdirKey ?? agentId` fallback (workdir.ts) exactly — a plain (non-workflow) task
      // never sets an explicit workdirKey, so its REAL key is its agentId; recording `null`
      // here would silently break any resolveOne() lookup keyed on it.
      const workdirKey = spec.isolation === "worktree" ? (spec.workdirKey ?? agentId) : null;
      const cwd = resolveWorkdirPath({ isolation: spec.isolation, cwd: spec.cwd, agentId, workdirKey: spec.workdirKey });
      const commitSha = spec.isolation === "worktree" ? currentWorkdirHeadSha(cwd) : null;
      const checkpoint: TaskStepCheckpoint = {
        stepIndex, gateAttempts, capturedAt: Date.now(),
        idempotencyKey: this.stepIdempotencyKey(taskId, stepIndex),
        workdirKey, branch: workdirKey ? branchNameFor(workdirKey) : null, commitSha,
        // REVIEW-ROOM-UNBOUND-TASKS: the repo this task's branch will land into (spec.cwd — the
        // worktree is <cwd>/.chimera/worktrees/<key>). EvidenceStore needs this durably to derive
        // a landed diff after the agent is gone; only meaningful when a branch exists (worktree).
        mainRepo: spec.isolation === "worktree" ? spec.cwd : null,
      };
      this.deps.queues.checkpointStep(taskId, checkpoint);
    } catch { /* diagnostic-only capture — never fail a workflow step over this */ }
  }

  // FEATURE-2: a checkpoint whose stepIndex matches the step about to (re-)start means an
  // earlier attempt at THIS exact step already ran (a same-step dead-agent retry, OR a
  // crash-restart re-dispatch — both cases are "you may not be starting from empty," so both
  // get the same notice). undefined on a genuine first attempt (no prior checkpoint at this
  // index) — never fabricates a false "resume" signal.
  private maybeResumeNotice(task: TaskRecord, stepIndex: number): string | undefined {
    const cp = task.checkpoint;
    return cp && cp.stepIndex === stepIndex ? resumeNoticeFor(cp) : undefined;
  }

  // FEATURE-2: WorkflowGraph's mergeSummaryText (fan-out join) and maybeResumeNotice above both
  // feed the SAME single optional trailing-text param workflowInstructions/workflowStepText
  // already use for handoff (WF-9) — joins whichever are present, drops the rest. undefined
  // when neither applies (the overwhelming common case), so every non-fanOut, non-resumed step
  // is provably byte-identical to before this feature.
  private combineHandoffNotes(...notes: (string | undefined)[]): string | undefined {
    const present = notes.filter((n): n is string => n !== undefined);
    return present.length ? present.join("\n\n") : undefined;
  }

  // ROLES-UNIFY §4: resolve a team-local role key to its full RoleSpec (library defaults +
  // the binding's own overrides — NOT any per-task callerOverrides, mirroring what
  // `team.roles[roleName]` used to BE pre-migration: a materialized template, fixed at
  // attach time). Returns null for an unknown key OR a binding whose library entry has
  // since vanished — every call site below already treats a null template as "unknown
  // role" and fails the task/gate the same way it did before this existed.
  private resolveTeamRole(team: TeamSpec, roleName: string): RoleSpec | null {
    const binding = team.roles[roleName];
    if (!binding) return null;
    try { return resolveRole(this.deps.roles, binding); }
    catch { return null; }
  }

  // F16.1 Phase 3 (WF-8): which role the drain loop should route `task` to — the CURRENT
  // step's role when the task is workflow-bound and that step names one, else the task's
  // own (push-time) role, else the team's first role (today's default). An unresolvable
  // workflow binding here just falls back to the task's own role; F15 moved the permanent
  // failure to the shared `workflowResolvable` predicate (onFail: "taskFails"), which runs
  // before any spawn — spawnForTask/assignPersistent now RECEIVE the already-resolved `wf`
  // and no longer re-resolve it themselves.
  // Public so team.update's role-removal guard (team-rpc.ts) can ask the SAME question the
  // drain loop will — a null-role/default task effectively spawns from the first role and a
  // workflow task from its step's role, so a literal task.role compare there would miss them.
  routingRoleFor(team: TeamSpec, task: TaskRecord): string {
    const defaultRole = Object.keys(team.roles)[0]!;
    try {
      const wf = this.resolveWorkflow(team, task);
      if (wf) return wf.steps[task.stepIndex]?.role ?? task.role ?? defaultRole;
    } catch { /* handled properly inside spawnForTask/assignPersistent */ }
    return task.role ?? defaultRole;
  }

  // Role instructions are separate from task bodies. Live membership is available
  // through my_team; never snapshot the whole roster into each assignment.
  private instructionsHeader(team: TeamSpec, roleName: string, original?: string): string {
    const role = this.resolveTeamRole(team, roleName);
    const hasTools = role?.orchestration?.allow === true;
    const base = `You are a member of team "${team.name}" acting as role "${roleName}".`;
    const coordination = hasTools
      ? " Use my_team for the live roster; agent_send teammates about file overlap and landing order."
      : "";
    // Ephemeral workers cannot leave verification running after their turn ends.
    const lifecycle = " Verify touched packages in the foreground (tsc and env-scrubbed vitest); read results before ending your turn. Commit before long checks. Use dev/test seams for UI verification; never launch, kill or relaunch the operator's desktop app.";
    const header = base + (team.purpose ? ` Team purpose: ${team.purpose}.` : "") + coordination + lifecycle;
    return original ? `${header}\n${original}` : header;
  }

  // ---------- D12: task workflows — resolution, prompt injection, gate machine ----------

  // Resolves this task's workflow binding: an already-PINNED task (workflow !== null —
  // a restart-recovered in_progress-reverted-to-pending task) resolves against its exact
  // pinned version; a fresh task resolves the per-task override (if any) else the
  // queue's own default binding. Returns null when the task isn't workflow-bound at all.
  // May throw UnknownWorkflowError — callers decide how that maps onto their own
  // success/starved/permanent-failure return convention (mirrors unknown-role handling).
  // WorkflowGraph: a fan-out BRANCH task (parentTaskId !== null) with NO explicit workflow
  // override is NEVER workflow-bound — checked ahead of the queue's own default binding.
  // Without this, a branch pushed (deliberately with no workflow override of its own) into
  // the SAME queue as its workflow-bound parent would silently inherit the queue's default
  // workflow at pickup (today's exact pre-existing fallback, D12) and get pinned to step 0
  // of it — exactly the "plain task" invariant beginFanOut's branches depend on, broken.
  // Dynamic Planner: the pinned-workflow check now runs FIRST regardless of parentTaskId
  // (a restart-recovered, already-pinned branch task should always resolve its pin), and
  // the parentTaskId guard only suppresses the QUEUE-DEFAULT fallback — a parented task
  // with an EXPLICIT workflowOverride (beginPlanDispatch's compiled-plan child) still
  // resolves it. Verified safe: every existing beginFanOut branch push sets no `workflow`
  // field, so workflowOverride stays null and the guard fires exactly as before for it.
  private resolveWorkflow(team: TeamSpec, task: TaskRecord): WorkflowRecord | null {
    if (task.workflow !== null) return this.deps.workflows.get(task.workflow.name, task.workflow.version);
    if (task.parentTaskId !== null && task.workflowOverride === null) return null;
    const name = task.workflowOverride ?? this.deps.queues.get(team.queue!).workflow;
    return name ? this.deps.workflows.get(name) : null;
  }

  private teamForQueue(queueName: string): TeamSpec | null {
    for (const t of this.deps.teams.list()) if (t.queue === queueName) return t;
    return null;
  }

  // TASK-TAGS: the owning task's tags, for the gate.verdict topic payload (topics.ts). Looked up
  // rather than threaded through every emit site's signature — the task always exists at these
  // points (we are mid-transition on it), so the fallback is defensive only, and "no tags" is the
  // correct degraded answer either way.
  private tagsOf(taskId: string): string[] {
    try { return this.deps.queues.getTask(taskId).tags; } catch { return []; }
  }

  private emitStepAdvanced(taskId: string, queue: string, wf: WorkflowRecord, stepIndex: number): void {
    const step = wf.steps[stepIndex]!;
    this.deps.events.append({
      agentId: `task:${taskId}`, kind: "task_step_advanced",
      data: { taskId, queue, workflow: wf.name, version: wf.version, stepIndex, stepId: step.id, title: step.title,
              tags: this.tagsOf(taskId) },
    });
  }

  // BUG FIX: the same "gate failed, try again" note workflowStepText's own retryReason
  // param renders, but shaped for combineHandoffNotes' join (no leading space) so it can
  // also reach the INSTRUCTIONS channel (spawnStepAgent's fresh-spawn branches), which has
  // no retryReason param of its own.
  private retryNoteText(retryReason?: string): string | undefined {
    return retryReason ? `Your previous attempt at this step did not pass its gate: ${retryReason} — try again.` : undefined;
  }

  // The step-scope text delivered as a NEW TURN (supervisor.send) — used both for the
  // idle-pool-worker reuse path (no instructions channel available) and for every
  // subsequent step after the first (an already-open session's system prompt can't be
  // changed mid-session).
  private workflowStepText(wf: WorkflowRecord, stepIndex: number, retryReason?: string, handoff?: string): string {
    const step = wf.steps[stepIndex]!;
    const retryNote = retryReason ? ` Your previous attempt at this step did not pass its gate: ${retryReason} — try again.` : "";
    const instructions = step.instructions ? ` ${step.instructions}` : "";
    const base = `[workflow "${wf.name}" v${wf.version} — step ${stepIndex + 1}/${wf.steps.length}: "${step.title}"]${retryNote}${instructions} Complete ONLY this step, then end your turn — chimera evaluates the gate and delivers the next step automatically; you cannot advance by declaring a later step done.`;
    // F16.1 Phase 3 (WF-9): the previous step's handoff package (summary + artifact
    // list), when this step is the incoming side of a role switch with context:"handoff".
    return handoff ? `${base}\n\n${handoff}` : base;
  }

  // The step-scope injected into INSTRUCTIONS (system prompt) at spawn time — a
  // claude-native engine carries the FULL plan (native plan support), a non-native
  // engine gets only the CURRENT step's scope (spec's own distinction).
  private workflowInstructions(
    wf: WorkflowRecord, stepIndex: number, provider: string | undefined, original?: string, handoff?: string,
    task?: TaskRecord,
  ): string {
    const step = wf.steps[stepIndex]!;
    const isNative = provider === undefined || provider === "claude";
    let header = isNative
      ? `This task follows workflow "${wf.name}" v${wf.version}. Chimera enforces each step's gate — you cannot advance by self-declaring a step done. Full step plan:\n${wf.steps.map((s, i) => `${i + 1}. ${s.title}`).join("\n")}\nYou are on step ${stepIndex + 1}/${wf.steps.length}: "${step.title}". Chimera delivers the next step once the current one's gate passes.`
      : `This task follows workflow "${wf.name}" v${wf.version}, step ${stepIndex + 1}/${wf.steps.length}: "${step.title}". Chimera enforces this step's gate (you cannot advance by self-declaring it done) and will deliver the next step once it passes.`;
    if (step.instructions) header += `\n${step.instructions}`;
    // AGENT-INITIATED-REMEDIATION: gated on the SAME condition engine.ts's queue.requestRemediation
    // handler enforces (a critic gate is exempt; onFail must resolve to "remediate" with a
    // configured policy) — so this paragraph is entirely ABSENT for every step that hasn't opted
    // into remediate (every currently-live workflow, per D12's own onFail default of "halt"/
    // "retry"), meaning today's workflows pay NOTHING extra in spawn-time tool-surface tokens for
    // this feature. `task` is optional only so a caller with no live TaskRecord in scope (there is
    // none today — kept this way for signature stability) degrades to omitting the paragraph
    // rather than crashing.
    const onFailResolved = step.onFail ?? wf.onFail;
    const remediatePolicy = step.gate.kind !== "critic" && onFailResolved === "remediate" ? (step.remediate ?? wf.remediate) : undefined;
    if (remediatePolicy && task) {
      const sameAnchor = task.remediationGateStep === stepIndex;
      const roundsSoFar = sameAnchor ? task.remediationRounds : 0;
      const remaining = Math.max(0, remediatePolicy.maxRounds - roundsSoFar);
      header += `\n\nThis step can also be corrected BACKWARD: if you discover an EARLIER step (not this one) actually caused the problem, call queue_request_remediation (taskId, targetStepId, brief) to route this task back there with your diagnosis, instead of finishing this step and hoping its gate catches it. ${remaining} round(s) remain in this step's remediation budget (shared with any gate-triggered remediation, not a separate one). Only use this for a genuine root-cause finding in an earlier step — a real blocker that needs a human is not a remediation candidate; call ask_human instead.`;
    }
    // F16.1 Phase 3 (WF-9): see workflowStepText's identical handoff param.
    if (handoff) header += `\n\n${handoff}`;
    return original ? `${header}\n${original}` : header;
  }

  // F16.1 Phase 3 (WF-9): renders a HandoffPackage into the block injected after the step
  // scope/instructions — "[handoff from step N (role)]: <summary>" (or an explicit
  // artifacts-only note when no summary was captured) plus the artifact list (id/kind/
  // label) of every artifact registered for this task at or before `fromStepIndex`.
  private handoffText(taskId: string, wf: WorkflowRecord, pkg: HandoffPackage): string {
    const fromStep = wf.steps[pkg.fromStepIndex]!;
    const summaryLine = pkg.summary
      ? `[handoff from step ${pkg.fromStepIndex + 1} (${fromStep.role ?? "agent"})]: ${pkg.summary}`
      : `[handoff from step ${pkg.fromStepIndex + 1} (${fromStep.role ?? "agent"})]: no summary was captured — proceeding with artifacts only.`;
    const artifacts = this.deps.artifacts.list({ taskId })
      .filter((a) => a.stepIndex !== undefined && a.stepIndex <= pkg.fromStepIndex)
      .map((a) => `- ${a.id} (${a.kind}): ${a.label}`)
      .join("\n");
    return `${summaryLine}\nArtifacts so far:${artifacts ? `\n${artifacts}` : " none."}`;
  }

  // Called for EVERY turn_complete of a workflow-bound tracked task (see onAgentEvent's
  // interception, ahead of the persistent-pool-worker branch). Evaluates the CURRENT
  // step's gate and drives the task to its next state — advance (send the next step),
  // retry (re-send the same step), or finalize (fail the task; success finalizes itself
  // naturally via closeInput -> the ordinary settle() path, see below).
  private async handleWorkflowTurn(agentId: string, task: TaskRecord): Promise<void> {
    // RE-ENTRANCY GUARD (HOOK-8 suspend/resume landing): a settled worker emits BOTH a
    // turn_complete and a `result` in the same tick, dispatched onto separate setTimeout(0)
    // macrotasks (attach()). Either can reach here for this step: turn_complete via onAgentEvent
    // directly, `result` via settle()'s open-step branch. settle() already defers when a
    // transition is in flight, but the turn_complete path did NOT — so if settle() won the race
    // and started a SLOW gate (a real tsc+vitest `command` gate takes seconds), the turn_complete
    // path would run the same gate AGAIN. stepTransitioning is the lock; whichever arrives first
    // owns this step boundary. Check-and-set is safe because the add below is synchronous (before
    // any await), so the second arrival always sees the flag.
    if (this.stepTransitioning.has(task.taskId)) return;
    // WORKFLOW-STEP-SURVIVES-AGENT-EXIT: captured NOW, before any await — a racing
    // settle() for a one-shot backend that terminates before evaluateGate below resolves
    // must never be able to delete this binding out from under us (see the lock immediately
    // following, and settle()'s matching guard, which defers to us entirely instead).
    const currentRole = this.tracked.get(agentId)?.role;
    this.stepTransitioning.add(task.taskId);
    try {
      const binding = task.workflow!;
      let wf: WorkflowRecord;
      try { wf = this.deps.workflows.get(binding.name, binding.version); }
      catch (err) {
        // the pinned version vanished (workflow.delete underneath a live task) — fail
        // safe rather than leave the agent hanging on a step that can never be evaluated.
        this.deps.queues.markFailed(task.taskId, (err as Error).message);
        this.finishWorkflowTask(agentId);
        return;
      }
      const step = wf.steps[task.stepIndex]!;
      // AGENT-INITIATED-REMEDIATION: a queue.requestRemediation call THIS turn takes priority
      // over the step's own gate — running a possibly expensive/side-effecting gate command just
      // to discard its verdict would be wasted work, and the agent's own diagnosis is often the
      // ONLY usable one (a failing gate's own fixBrief is truncated/stderr-only — see
      // defaultGateExec — while the agent that triggered this had full context). Re-validated
      // here (never trusted from the RPC's own point-in-time checks) in case the workflow spec
      // or step index moved between the request and this turn ending; a request that's gone
      // stale falls through to the step's OWN gate evaluation exactly as if none had been made.
      const pending = task.pendingRemediationRequest;
      if (pending) {
        this.deps.queues.clearPendingRemediationRequest(task.taskId);
        const onFailResolved = step.onFail ?? wf.onFail;
        const remediatePolicy = step.gate.kind !== "critic" && onFailResolved === "remediate" ? (step.remediate ?? wf.remediate) : undefined;
        const targetIndex = wf.steps.findIndex((s) => s.id === pending.targetStepId);
        const targetStep = targetIndex >= 0 ? wf.steps[targetIndex] : undefined;
        const stillValid = remediatePolicy !== undefined && targetStep !== undefined && targetIndex < task.stepIndex
          && !targetStep.fanOut && !targetStep.subWorkflow;
        if (stillValid) {
          const agentAlive = this.deps.supervisor.status(agentId).state === "running";
          // GATE-REMEDIATION-LOOP: the SAME anchor/budget the gate-triggered path uses (never a
          // second, independent counter) — anchored to THIS step (the one the request came
          // from), exactly like handleWorkflowTurn's own gate-failure branch below.
          const sameAnchor = task.remediationGateStep === task.stepIndex;
          const roundsSoFar = sameAnchor ? task.remediationRounds : 0;
          const willRemediate = roundsSoFar + 1 < remediatePolicy!.maxRounds;
          this.deps.events.append({
            agentId: `task:${task.taskId}`, kind: "task_step_failed",
            data: { taskId: task.taskId, queue: task.queue, workflow: wf.name, version: wf.version,
                    stepIndex: task.stepIndex, stepId: step.id, tags: task.tags,
                    reason: `agent-requested remediation (by ${pending.requestedBy ?? "unknown"}): ${pending.brief}`,
                    willRetry: willRemediate, remediate: true, agentInitiated: true },
          });
          if (willRemediate) {
            this.deps.queues.closeStep(task.taskId, "retried", `agent-requested remediation: ${pending.brief}`);
            this.deps.queues.incrementRemediationRounds(task.taskId, task.stepIndex);
            const fixBrief = `Agent-requested correction from step "${step.title}": ${pending.brief}\n\nFix the root cause, then end your turn.`;
            await this.beginRemediation(agentId, task, wf, targetIndex, agentAlive, currentRole, fixBrief);
            return;
          }
          this.deps.queues.closeStep(task.taskId, "failed", "agent-requested remediation exhausted budget");
          this.deps.queues.markFailed(task.taskId,
            `step "${step.id}" — agent ${pending.requestedBy ?? "unknown"} requested remediation to step "${pending.targetStepId}" (${pending.brief.slice(0, 200)}) but ${remediatePolicy!.maxRounds} remediation round(s) were already spent on step "${step.title}"`);
          this.finishWorkflowTask(agentId);
          return;
        }
        // stale/invalid request (workflow edited, step moved, or policy removed underneath the
        // agent since it called queue.requestRemediation) — never silently apply an invalid
        // jump; fall through to this step's own gate as if no request had been made.
      }
      // GATE-HANG-HARDENING: race evaluateGate against the outer hard ceiling — see its doc
      // comment. Whichever settles first wins; a late resolution from an abandoned real gate
      // call is discarded (evaluateGate has no side effects beyond its return value).
      const gateCeilingMs = this.deps.gateEvalHardCeilingMs ?? GATE_EVAL_HARD_CEILING_MS;
      const outcome = await Promise.race([
        this.evaluateGate(step.gate, agentId, task, wf),
        new Promise<{ ok: false; reason: string }>((resolve) => {
          const t = setTimeout(() => resolve({
            ok: false,
            reason: `gate evaluation exceeded the ${gateCeilingMs}ms hard ceiling without resolving — forcing failure rather than wedging this task's step lock`,
          }), gateCeilingMs);
          t.unref?.();
        }),
      ]);
      // WORKFLOW-STEP-SURVIVES-AGENT-EXIT: a one-shot backend (e.g. GENERIC) can have
      // already reached its own terminal state while the gate above was evaluating — settle()
      // deferred that terminal event to us (the lock), so from here on WE alone decide this
      // agent's fate. A dead agent has no live session left to `send()` a next turn to or ask
      // for a handoff summary — every branch below falls back to a fresh respawn instead.
      const agentAlive = this.deps.supervisor.status(agentId).state === "running";
      if (outcome.ok) {
        // F16.1 Phase 2 (WF-4/G4): close the just-evaluated step's history entry BEFORE
        // deciding advance-vs-finish — both paths agree the gate passed.
        this.deps.queues.closeStep(task.taskId, "passed", outcome.note);
        // GATE-REMEDIATION-LOOP: clear the anchor ONLY when the ANCHORED gate step itself is
        // the one that just passed — NOT unconditionally on every passing gate. The
        // remediation step's own gate passing (e.g. "implement"'s trivial `none` gate) is a
        // NECESSARY, expected part of the loop on the way back to re-evaluating the anchored
        // gate; clearing the anchor there would silently wipe remediationRounds mid-loop and
        // defeat maxRounds entirely (incrementRemediationRounds would see a null anchor next
        // time and treat every subsequent failure as round 1 forever).
        if (task.remediationGateStep === task.stepIndex) this.deps.queues.resetRemediation(task.taskId);
        // Dynamic Planner: a `plan`-gated step's gate compiled a fresh ephemeral workflow —
        // dispatch it as a single nested child task instead of the normal resolveNextStep
        // advance (the real successor is only knowable once that child joins).
        if (outcome.plan) {
          await this.beginPlanDispatch(agentId, task, wf, task.stepIndex, outcome.plan, currentRole);
          return;
        }
        // WorkflowGraph: resolveNextStep replaces the old inline `stepIndex + 1` /
        // `>= steps.length` check — it degenerates to EXACTLY that when this step sets
        // neither `next` nor `fanOut`, so every existing linear workflow runs through this
        // same call, not a separate legacy path.
        const resolution = this.resolveNextStep(wf, task);
        if (resolution.kind === "unrouted") {
          // A `next` route with edges was set but none matched at gate-pass time (e.g. an
          // artifact-based condition that never became true) — a spec-valid but
          // runtime-unsatisfiable route is a task failure, not a silent finish.
          this.deps.queues.markFailed(task.taskId, `step "${step.id}" — no "next" condition matched`);
          this.finishWorkflowTask(agentId);
          return;
        }
        if (resolution.kind === "terminal") {
          if (agentAlive) {
            // Last step passed — end the conductor session gracefully. The resulting
            // terminal event (a real backend still emits ONE final `result` after input
            // closes) flows through the ORDINARY settle() path below — correct
            // resultText, correct markDone — exactly like a non-workflow task.
            await this.deps.supervisor.closeInput(agentId).catch(() => {});
            return;
          }
          // Already dead: no further terminal event will ever arrive for this agent to
          // finalize the task via the ordinary settle() path — finalize it ourselves now.
          await this.finalizeDeadWorkflowAgent(agentId, task.taskId);
          return;
        }
        // Bounded loops: consume one round of the loop-back edge's budget the INSTANT we
        // decide to take it — mirrors incrementStepAttempts' placement (right before the
        // respawn/resend it gates), so a crash between this line and the dispatch below is
        // diagnostically visible as "counter advanced, step never (re)started" rather than
        // silently re-granting the round on restart-recovery.
        if (resolution.loopFrom !== undefined) this.deps.queues.incrementLoopIterations(task.taskId, resolution.loopFrom);
        const nextIndex = resolution.index;
        const nextStep = wf.steps[nextIndex]!;
        if (nextStep.fanOut) { await this.beginFanOut(agentId, task, wf, nextIndex, agentAlive, currentRole); return; }
        if (nextStep.subWorkflow) { await this.beginSubWorkflow(agentId, task, wf, nextIndex, currentRole); return; }
        await this.advanceToIndex(agentId, task, wf, nextIndex, agentAlive, currentRole);
        return;
      }
      // F16.1 Phase 2 (WF-5/G6): a step's own onFail/retryLimit override the workflow's,
      // falling back to the workflow-level policy when the step leaves either unset.
      // FEATURE-3: a critic gate's own maxRounds is the ONLY retry policy while it loops —
      // independent of onFail/retryLimit (the critic spec has no onFail override; see
      // runCritic). stepAttempts counts rounds already consumed (0 on the first attempt),
      // so `stepAttempts + 1 < maxRounds` is "there's still budget after this failing
      // round" — exhausting it falls through to the SAME closeStep("failed")/markFailed
      // tail every other exhausted gate already takes below (no separate halt-vs-retry-
      // exhausted distinction exists there either).
      // RETRY-BACKOFF: a configured retryPolicy's maxAttempts SUPERSEDES step/workflow
      // retryLimit for the budget check (still gated by onFail:"retry" — a policy never
      // overrides an explicit onFail:"halt"), using the SAME "stepAttempts + 1 < N" formula
      // maxRounds already established above — absent a policy, `(retryLimit ?? wf.retryLimit)
      // + 1` reduces this to the historical `stepAttempts < retryLimit` check, byte-identical.
      // GATE-REMEDIATION-LOOP: a third onFail policy alongside "retry"/"halt" — routes the
      // gate's own failure text to a (usually different, earlier) step instead of resending
      // THIS step or halting. Checked BEFORE the existing retry/critic logic below and returns
      // early either way, so onFail:"retry"/"halt" and the critic gate's own independent loop
      // are completely untouched by this branch (critic gates are explicitly exempt — they
      // keep their own maxRounds loop regardless of what onFail says, same as today).
      const onFailResolved = step.onFail ?? wf.onFail;
      const remediatePolicy = step.gate.kind !== "critic" && onFailResolved === "remediate"
        ? (step.remediate ?? wf.remediate) : undefined;
      if (remediatePolicy) {
        const sameAnchor = task.remediationGateStep === task.stepIndex;
        const roundsSoFar = sameAnchor ? task.remediationRounds : 0;
        const willRemediate = roundsSoFar + 1 < remediatePolicy.maxRounds;
        this.deps.events.append({
          agentId: `task:${task.taskId}`, kind: "task_step_failed",
          data: { taskId: task.taskId, queue: task.queue, workflow: wf.name, version: wf.version,
                  stepIndex: task.stepIndex, stepId: step.id, tags: task.tags, reason: outcome.reason,
                  willRetry: willRemediate, remediate: true },
        });
        if (willRemediate) {
          this.deps.queues.closeStep(task.taskId, "retried", outcome.reason);
          this.deps.queues.incrementRemediationRounds(task.taskId, task.stepIndex);
          const remediateIndex = this.resolveRemediateStepIndex(wf, task, remediatePolicy.remediateStep);
          const fixBrief = `The "${step.title}" gate failed with: ${outcome.reason}\n\nFix the root cause, then end your turn.`;
          await this.beginRemediation(agentId, task, wf, remediateIndex, agentAlive, currentRole, fixBrief);
          return;
        }
        this.deps.queues.closeStep(task.taskId, "failed", outcome.reason);
        this.deps.queues.markFailed(task.taskId, `step "${step.id}" gate failed after ${remediatePolicy.maxRounds} remediation round(s): ${outcome.reason}`);
        this.finishWorkflowTask(agentId);
        return;
      }
      const retryPolicyForWillRetry = step.retryPolicy ?? wf.retryPolicy;
      const maxAttemptsEquivalent = retryPolicyForWillRetry?.maxAttempts ?? (step.retryLimit ?? wf.retryLimit) + 1;
      const willRetry = step.gate.kind === "critic"
        ? task.stepAttempts + 1 < step.gate.spec.maxRounds
        : (step.onFail ?? wf.onFail) === "retry" && task.stepAttempts + 1 < maxAttemptsEquivalent;
      this.deps.events.append({
        agentId: `task:${task.taskId}`, kind: "task_step_failed",
        data: { taskId: task.taskId, queue: task.queue, workflow: wf.name, version: wf.version, stepIndex: task.stepIndex, stepId: step.id, tags: task.tags, reason: outcome.reason, willRetry },
      });
      if (willRetry) {
        this.deps.queues.closeStep(task.taskId, "retried", outcome.reason);
        this.deps.queues.incrementStepAttempts(task.taskId);
        // RETRY-BACKOFF: a step/workflow retryPolicy replaces the instant resend/respawn below
        // with a delayed re-dispatch. task.stepAttempts already reflects incrementStepAttempts'
        // mutation (TaskRecord objects are shared-by-reference from QueueStore's Map — see the
        // identical assumption in advanceToIndex's fromStepIndex capture comment below).
        if (retryPolicyForWillRetry) {
          // Tear down whatever agent is bound now (alive or not — a fresh session spawns once
          // the backoff elapses either way, so there's no value in holding a live one idle for
          // the delay) via the SAME unbind/kill/pool-idle logic the exhaustion path below uses.
          this.finishWorkflowTask(agentId);
          this.scheduleRetry(task.taskId, computeRetryDelayMs(retryPolicyForWillRetry, task.stepAttempts));
          return;
        }
        if (agentAlive) {
          this.deps.queues.startStep(task.taskId, task.stepIndex, step.id, agentId);
          await this.deps.supervisor.send(agentId, this.workflowStepText(wf, task.stepIndex, outcome.reason), "scheduler");
          return;
        }
        // dead agent: the retry needs a FRESH session for the same step/role (nothing to
        // resend to) — reuse the respawn machinery even though the step index is unchanged.
        // replaceStepAgent's own spawnStepAgent call opens the fresh stepHistory entry (with
        // the NEW agentId) — do not also open one here, or a stray duplicate is left dangling.
        // BUG FIX: thread outcome.reason through so the respawned worker sees the failing
        // gate's reason / critic's REVISE feedback — the ALIVE branch above already gets this
        // for free via workflowStepText's own retryReason param; this dead-agent path went
        // through spawnStepAgent instead, which previously had no such channel at all.
        await this.replaceStepAgent(agentId, task, wf, task.stepIndex, step.role ?? currentRole!, task.stepIndex, null, outcome.reason);
        return;
      }
      this.deps.queues.closeStep(task.taskId, "failed", outcome.reason);
      // RETRY-BACKOFF: exhaustion routes to "dead_letter" (cascade-guarded, replayable via
      // queue.requeue) instead of "failed" (cascade-fails dependents) whenever a retryPolicy is
      // configured for this step/workflow — absent, exactly today's behavior.
      {
        const msg = `step "${step.id}" gate failed: ${outcome.reason}`;
        if (retryPolicyForWillRetry) this.deps.queues.markDeadLetter(task.taskId, msg);
        else this.deps.queues.markFailed(task.taskId, msg);
      }
      this.finishWorkflowTask(agentId);
    } finally {
      this.stepTransitioning.delete(task.taskId);
    }
  }

  // WorkflowGraph: extracted out of handleWorkflowTurn's `outcome.ok` branch — "I know the next
  // step index, go run it," regardless of how that index was decided (implicit stepIndex+1,
  // an explicit `next` route, or a zero-item fan-out standing in for its join step directly).
  // F16.1 Phase 3 (WF-8): the next step names a DIFFERENT role than the one currently bound → a
  // step-boundary agent switch. No role, or the SAME role as today → the pre-existing
  // single-agent advance (consecutive same-role steps never respawn) — but ONLY while the
  // session is still alive; a dead agent has nothing to send() to.
  private async advanceToIndex(
    agentId: string, task: TaskRecord, wf: WorkflowRecord, nextIndex: number, agentAlive: boolean, currentRole?: string,
  ): Promise<void> {
    const nextStep = wf.steps[nextIndex]!;
    if (agentAlive && (nextStep.role === undefined || nextStep.role === currentRole)) {
      this.deps.queues.advanceStep(task.taskId, nextIndex);
      this.emitStepAdvanced(task.taskId, task.queue, wf, nextIndex);
      this.deps.queues.startStep(task.taskId, nextIndex, nextStep.id, agentId);
      // FEATURE-2 bugfix: without this, checkpoint.stepIndex goes stale at the last
      // fresh-spawn step, so a crash-restart re-dispatch of THIS (already-advanced) step
      // fails maybeResumeNotice's exact-match check and silently redoes its side effects.
      this.captureStepCheckpoint(task.taskId, nextIndex, 0, agentId);
      await this.deps.supervisor.send(agentId, this.workflowStepText(wf, nextIndex), "scheduler");
      return;
    }
    if (!agentAlive) {
      // No live session to continue (same role) or summarize (different role) — go
      // straight to a fresh respawn, with an artifacts-only handoff package standing in
      // for the (impossible) live summarize turn, unless the step opted out entirely.
      const fromStepIndex = task.stepIndex;
      this.deps.queues.advanceStep(task.taskId, nextIndex);
      this.emitStepAdvanced(task.taskId, task.queue, wf, nextIndex);
      const handoff = nextStep.context === "none" ? null : { fromStepIndex, summary: null };
      await this.replaceStepAgent(agentId, task, wf, nextIndex, nextStep.role ?? currentRole!, fromStepIndex, handoff);
      return;
    }
    // F16.1 Phase 3 (WF-9): a switch into a context:"none" step skips the whole handoff
    // package (no summarize turn) — the pre-existing WF-8 switch, unchanged. The default
    // ("handoff") first collects the outgoing agent's summary via beginHandoff; the
    // switch itself only runs once that resolves (see completeHandoff).
    if (nextStep.context === "none") {
      await this.switchStepAgent(agentId, task, wf, nextIndex, null);
      return;
    }
    await this.beginHandoff(agentId, wf, nextIndex, task.stepIndex);
  }

  // GATE-REMEDIATION-LOOP: resolves a "remediate" policy's target step index. Explicit
  // remediateStep wins (existence/fanOut-subWorkflow already guaranteed valid by
  // validateWorkflowGraph). Otherwise the nearest PRECEDING step whose id OR role is
  // "implement" (the literal step id in feature-qa's own plan -> implement -> qa-verify ->
  // land shape, and the conventional role name elsewhere). Falls back to the SAME step index
  // (bounce-to-self) when neither applies — the single-agent-workflow default.
  private resolveRemediateStepIndex(wf: WorkflowRecord, task: TaskRecord, remediateStepId?: string): number {
    if (remediateStepId) {
      const idx = wf.steps.findIndex((s) => s.id === remediateStepId);
      if (idx >= 0) return idx;
    }
    for (let i = task.stepIndex - 1; i >= 0; i--) {
      if (wf.steps[i]!.id === "implement" || wf.steps[i]!.role === "implement") return i;
    }
    return task.stepIndex;
  }

  // GATE-REMEDIATION-LOOP: routes a gate failure's captured output (`fixBrief`) to the
  // resolved remediation step and resumes execution there — mirrors advanceToIndex's alive/
  // dead + same-role/different-role branching, but (a) always threads `fixBrief` as
  // `retryReason` and (b) deliberately skips the beginHandoff/summarize detour entirely: the
  // concrete gate-failure text is a strictly better handoff than an LLM-generated summary, and
  // skipping it means zero changes to AwaitingHandoff/completeHandoff/switchStepAgent.
  // `replaceStepAgent` already tears down the outgoing agent (alive or dead) and resolves the
  // SAME workdirKey the failing step was using — this is the "resume the shared worktree" seam.
  private async beginRemediation(
    agentId: string, task: TaskRecord, wf: WorkflowRecord, remediateIndex: number,
    agentAlive: boolean, currentRole: string | undefined, fixBrief: string,
  ): Promise<void> {
    const remediateStep = wf.steps[remediateIndex]!;
    if (remediateIndex === task.stepIndex) {
      // bounce-to-self (single-agent default, or an explicit remediateStep === the gate step)
      if (agentAlive) {
        this.deps.queues.startStep(task.taskId, task.stepIndex, remediateStep.id, agentId);
        await this.deps.supervisor.send(agentId, this.workflowStepText(wf, task.stepIndex, fixBrief), "scheduler");
        return;
      }
      await this.replaceStepAgent(agentId, task, wf, task.stepIndex, remediateStep.role ?? currentRole!, task.stepIndex, null, fixBrief);
      return;
    }
    // route BACK to an earlier (or, in principle, another) step
    const fromStepIndex = task.stepIndex;
    this.deps.queues.advanceStep(task.taskId, remediateIndex);   // direction-agnostic despite its name/comments
    this.emitStepAdvanced(task.taskId, task.queue, wf, remediateIndex);
    if (agentAlive && (remediateStep.role === undefined || remediateStep.role === currentRole)) {
      this.deps.queues.startStep(task.taskId, remediateIndex, remediateStep.id, agentId);
      this.captureStepCheckpoint(task.taskId, remediateIndex, 0, agentId);
      await this.deps.supervisor.send(agentId, this.workflowStepText(wf, remediateIndex, fixBrief), "scheduler");
      return;
    }
    await this.replaceStepAgent(agentId, task, wf, remediateIndex, remediateStep.role ?? currentRole!, fromStepIndex, null, fixBrief);
  }

  // WorkflowGraph: replaces the old inline `nextIndex = stepIndex + 1` / `>= steps.length`
  // check. Degenerates to EXACTLY that when the step sets neither `next` nor `fanOut` — every
  // existing linear workflow runs through this same function, not a separate legacy path.
  // Bounded loops: an edge's own `loopBack.maxIterations` is checked BEFORE `when` — once
  // exhausted the edge is treated as though it never matched (regardless of `when`), so a
  // trailing fallback edge (or "unrouted" if there is none) decides what happens next.
  // `loopFrom` (set only when the CHOSEN edge is a loopBack one) tells the caller which step's
  // counter to increment — the mutation itself happens in handleWorkflowTurn, not here (this
  // function stays a pure read of `wf`/`task`, mirroring the rest of this file's "resolve here,
  // mutate at the call site" convention already established by incrementStepAttempts).
  private resolveNextStep(wf: WorkflowRecord, task: TaskRecord):
    { kind: "advance"; index: number; loopFrom?: string } | { kind: "terminal" } | { kind: "unrouted" } {
    const step = wf.steps[task.stepIndex]!;
    if (step.next === undefined) {
      const idx = task.stepIndex + 1;
      return idx < wf.steps.length ? { kind: "advance", index: idx } : { kind: "terminal" };
    }
    for (const edge of step.next) {
      if (edge.loopBack && (task.loopIterations[step.id] ?? 0) >= edge.loopBack.maxIterations) continue;
      if (!this.routeConditionMatches(edge.when, task)) continue;
      // findIndex is guaranteed to succeed — validateWorkflowGraph rejects a dangling `to`
      // at workflow create/update time, before any task can ever pin this version.
      const index = wf.steps.findIndex((s) => s.id === edge.to);
      return edge.loopBack ? { kind: "advance", index, loopFrom: step.id } : { kind: "advance", index };
    }
    return step.next.length === 0 ? { kind: "terminal" } : { kind: "unrouted" };
  }

  // WorkflowGraph: narrow on `cond.kind` FIRST — never read `cond.spec` (a union-only field)
  // before every other arm has already returned. `cond` undefined == "always" (an edge with no
  // `when` unconditionally matches).
  private routeConditionMatches(cond: RouteCondition | undefined, task: TaskRecord): boolean {
    if (!cond || cond.kind === "always") return true;
    if (cond.kind === "artifactValue") {
      const { artifactId, scope, kind, op, value } = cond.spec;
      const rec = this.deps.artifacts.findLatestForTask(task.taskId, { artifactId, scope, stepIndex: task.stepIndex, kind });
      if (!rec) return false;
      return compareArtifactValue(this.deps.artifacts.readContent(rec.id).trim(), op, value);
    }
    const { artifactId, kind } = cond.spec;
    return this.deps.artifacts.existsForTask(task.taskId, { artifactId, scope: "task", stepIndex: task.stepIndex, kind });
  }

  // WorkflowGraph: resolves this fan-out's item list. "list" is pure/can't fail (the schema
  // already guarantees a non-empty string array). "artifactList" mirrors evaluatePlanGate's own
  // artifact-read pattern below — same "most-recently-registered match" convention, same
  // read/parse/validate failure shape — surfaced by the caller (beginFanOut) as an ordinary
  // structural task failure, not a retryable gate failure (there's no gate/agent to retry
  // against here). Narrows on `source.kind` FIRST, mirroring routeConditionMatches's "never read
  // a union-only field before every other arm has already returned" discipline.
  private resolveFanOutItems(
    source: WorkflowFanOut["source"], task: TaskRecord,
  ): { ok: true; items: string[] } | { ok: false; reason: string } {
    if (source.kind === "list") return { ok: true, items: source.items };
    const { artifactId, scope } = source.spec;
    const candidates = this.deps.artifacts.list({ taskId: task.taskId }).filter((a) =>
      a.kind !== "link" && (!artifactId || a.id === artifactId) &&
      (scope !== "step" || a.stepIndex === task.stepIndex));
    const rec = candidates[candidates.length - 1];
    if (!rec) {
      return {
        ok: false,
        reason: artifactId
          ? `fan-out artifact "${artifactId}" not registered for this task`
          : "no fan-out list artifact registered for this task",
      };
    }
    let raw: string;
    try { raw = this.deps.artifacts.readContent(rec.id); }
    catch (err) { return { ok: false, reason: `fan-out artifact "${rec.id}" content unavailable: ${(err as Error).message}` }; }
    let json: unknown;
    try { json = JSON.parse(raw); }
    catch (err) { return { ok: false, reason: `fan-out artifact "${rec.id}" is not valid JSON: ${(err as Error).message}` }; }
    const parsed = FanOutArtifactListSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: `fan-out artifact "${rec.id}" must be a non-empty JSON array of strings` };
    return { ok: true, items: parsed.data };
  }

  // WorkflowGraph (bounded fan-out): groups `items` into chunkSize-sized branch chunks
  // (chunkSize 1 -> today's exact one-item-per-branch shape).
  private chunkFanOutItems(items: string[], chunkSize: number): string[][] {
    const chunks: string[][] = [];
    for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
    return chunks;
  }

  // WorkflowGraph (bounded fan-out): renders one branch task's prompt for its item chunk —
  // shared by beginFanOut's first wave and tick()'s admission loop for later waves, so every
  // wave produces byte-identical prompt shapes for the same chunk.
  private fanOutBranchPrompt(step: WorkflowStep, chunk: string[], taskPrompt: string): string {
    const itemsText = chunk.length === 1 ? `Item: ${chunk[0]}` : `Items:\n${chunk.map((i) => `- ${i}`).join("\n")}`;
    return `${step.instructions ?? step.title}\n\n${itemsText}\n\n${taskPrompt}`;
  }

  private emitFanOutStarted(
    task: TaskRecord, wf: WorkflowRecord, fanOutIndex: number, joinIndex: number,
    branchTaskIds: string[], totalItems: number, totalBranches: number,
  ): void {
    this.deps.events.append({
      agentId: `task:${task.taskId}`, kind: "task_fan_out",
      data: { taskId: task.taskId, queue: task.queue, workflow: wf.name, version: wf.version,
              stepIndex: fanOutIndex, stepId: wf.steps[fanOutIndex]!.id, joinStepIndex: joinIndex,
              branchTaskIds, totalItems, totalBranches },
    });
  }

  // WorkflowGraph (bounded fan-out): mirrors emitFanOutStarted's shape for a LATER wave admitted
  // by tick()'s admission loop (maxParallel-bounded fan-outs only).
  private emitFanOutBatchAdmitted(
    task: TaskRecord, wf: WorkflowRecord, fanOutIndex: number, joinIndex: number,
    branchTaskIds: string[], remaining: number,
  ): void {
    this.deps.events.append({
      agentId: `task:${task.taskId}`, kind: "task_fan_out_batch",
      data: { taskId: task.taskId, queue: task.queue, workflow: wf.name, version: wf.version,
              stepIndex: fanOutIndex, stepId: wf.steps[fanOutIndex]!.id, joinStepIndex: joinIndex,
              branchTaskIds, remaining },
    });
  }

  // WorkflowGraph: `fanOutIndex` is reached — no agent ever runs FOR this step. Resolves the
  // item source, splits it into chunkSize-sized branch chunks, pushes a BOUNDED first wave
  // (maxParallel chunks, or every chunk when maxParallel is unset — today's exact "push
  // everything at once" shape), persists any remainder (queues.ts's fanOutRemaining) for
  // tick()'s admission loop to drain in later waves, tears down the outgoing agent (this task no
  // longer has one while blocked), then blocks the parent on the first wave via
  // queues.blockOnChildren (DEP1 reuse). `currentRole` is the role of the agent whose gate JUST
  // passed — used as the branch role fallback for THIS first wave only (see the admission loop's
  // own note on why later waves can't reuse it).
  private async beginFanOut(
    agentId: string, task: TaskRecord, wf: WorkflowRecord, fanOutIndex: number, agentAlive: boolean, currentRole?: string,
  ): Promise<void> {
    const step = wf.steps[fanOutIndex]!;
    const fanOut = step.fanOut!;
    const joinIndex = wf.steps.findIndex((s) => s.id === fanOut.joinStep);   // guaranteed valid
    const resolved = this.resolveFanOutItems(fanOut.source, task);
    if (!resolved.ok) {
      // Structural failure — mirrors resolveNextStep's "unrouted" path above: permanent, no
      // gate/agent to retry against.
      this.deps.queues.startStep(task.taskId, fanOutIndex, step.id, null);
      this.deps.queues.closeStep(task.taskId, "failed", resolved.reason);
      this.deps.queues.markFailed(task.taskId, resolved.reason);
      this.finishWorkflowTask(agentId);
      return;
    }
    const items = resolved.items;
    // audit-trail parity with a normal step attempt (F16.1's "one entry per step ATTEMPT"
    // convention), even though no agent ever ran for this step — agentId:null is diagnostic.
    this.deps.queues.startStep(task.taskId, fanOutIndex, step.id, null);
    this.deps.queues.closeStep(task.taskId, "passed", `fanned out into ${items.length} branch(es)`);
    if (items.length === 0) {
      // Unreachable for a "list" source (schema requires items.min(1)); kept as defense-in-depth
      // for an "artifactList" source (FanOutArtifactListSchema also requires .min(1), so this
      // isn't a designed path either — just cheap insurance against a future looser source).
      await this.advanceToIndex(agentId, task, wf, joinIndex, agentAlive, currentRole);
      return;
    }
    const chunks = this.chunkFanOutItems(items, fanOut.chunkSize);
    const window = fanOut.maxParallel ? chunks.slice(0, fanOut.maxParallel) : chunks;
    const remaining = fanOut.maxParallel ? chunks.slice(fanOut.maxParallel) : [];
    const branchRole = step.role ?? currentRole ?? task.role ?? null;
    const branchIds = window.map((chunk) => this.deps.queues.push(task.queue, {
      prompt: this.fanOutBranchPrompt(step, chunk, task.prompt),
          role: branchRole, priority: task.priority, parentTaskId: task.taskId, originConductorId: task.originConductorId,
    }).taskId);
    await this.teardownStepAgent(agentId);
    this.deps.queues.blockOnChildren(task.taskId, branchIds, joinIndex);
    if (remaining.length > 0) this.deps.queues.setFanOutRemaining(task.taskId, remaining);
    this.emitFanOutStarted(task, wf, fanOutIndex, joinIndex, branchIds, items.length, chunks.length);
    await this.tick();   // branches were pushed directly via queues.push (bypassing the RPC
                          // handler's own post-push tick()) — drain them now, same as assign().
  }

  // WorkflowGraph: renders the join step's incoming context — reuses the SAME optional
  // trailing-text param workflowInstructions/workflowStepText already use for handoff (WF-9),
  // just with fan-out's own content. undefined whenever branchChildren is empty (every
  // non-fan-out task), so this is provably a no-op everywhere else.
  //
  // Paged reduce (bounded fan-out): NO hard trailing slice — a byte-boundary cut silently drops
  // whole branches (and can chop a line mid-character) once the branch count grows. Instead,
  // every branch is either individually listed or accounted for in an explicit "+N more" line,
  // so listed-count + omitted-count always equals branchChildren.length. Failures/other
  // non-"done" states are the actionable minority — listed FIRST, at full budget; "done"
  // branches are summarized more aggressively once numerous. The two independent per-bucket caps
  // already bound output size deterministically regardless of total branch count.
  private mergeSummaryText(task: TaskRecord): string | undefined {
    if (task.branchChildren.length === 0) return undefined;
    const MERGE_SUMMARY_MAX_LISTED = 50;
    const MERGE_SUMMARY_LINE_CHARS = 300;
    const records = task.branchChildren.map((id) => {
      try { return { id, rec: this.deps.queues.getTask(id) as TaskRecord | null }; }
      catch { return { id, rec: null as TaskRecord | null }; }
    });
    const nonDone = records.filter((r) => r.rec?.state !== "done");
    const done = records.filter((r) => r.rec?.state === "done");
    const renderBucket = (bucket: typeof records, cap: number): string[] => {
      const shown = bucket.slice(0, cap).map(({ id, rec }) => {
        if (!rec) return `- ${id.slice(0, 8)}: (task record missing)`;
        const outcome = rec.state === "done" ? (rec.resultText ?? "").slice(0, MERGE_SUMMARY_LINE_CHARS) : (rec.error ?? rec.state);
        return `- ${id.slice(0, 8)} [${rec.state}]: ${outcome}`;
      });
      const omitted = bucket.length - shown.length;
      return omitted > 0 ? [...shown, `- ...and ${omitted} more (see branchChildren for full ids)`] : shown;
    };
    const lines = [...renderBucket(nonDone, MERGE_SUMMARY_MAX_LISTED), ...renderBucket(done, MERGE_SUMMARY_MAX_LISTED)];
    const header = `[fan-out results: ${task.branchChildren.length} branch(es) — ${done.length} done, ${nonDone.length} failed/other]`;
    return `${header}\n${lines.join("\n")}`;
  }

  // Dynamic Planner: `planIndex` is the just-passed `plan`-gated step — dispatches its
  // compiled ephemeral workflow as a SINGLE nested child task (a fan-out of one), then
  // blocks the parent on it via the SAME queues.blockOnChildren (DEP1 reuse) beginFanOut
  // uses. `resumeStep` (statically validated by validateWorkflowGraph) names the step the
  // parent resumes at once the child joins — mirrors beginFanOut's joinStep exactly.
  private async beginPlanDispatch(
    agentId: string, task: TaskRecord, wf: WorkflowRecord, planIndex: number, plan: WorkflowRecord, currentRole?: string,
  ): Promise<void> {
    const step = wf.steps[planIndex]!;
    const resumeStepId = (step.gate as Extract<WorkflowGate, { kind: "plan" }>).spec.resumeStep;
    const joinIndex = wf.steps.findIndex((s) => s.id === resumeStepId);   // guaranteed valid — validateWorkflowGraph
    const childId = this.deps.queues.push(task.queue, {
      prompt: task.prompt,
      // fallback only — the compiled plan's OWN step 0 `role` (if set) wins at pickup,
      // exactly like beginFanOut's identical branchRole fallback chain.
      role: step.role ?? currentRole ?? task.role ?? null,
      priority: task.priority, parentTaskId: task.taskId, workflow: plan.name, originConductorId: task.originConductorId,
    }).taskId;
    await this.teardownStepAgent(agentId);
    this.deps.queues.blockOnChildren(task.taskId, [childId], joinIndex);
    this.emitPlanDispatched(task, wf, planIndex, joinIndex, plan, childId);
    await this.tick();   // child was pushed directly via queues.push — drain it now, mirrors beginFanOut's identical tail
  }

  private emitPlanDispatched(task: TaskRecord, wf: WorkflowRecord, planIndex: number, joinIndex: number, plan: WorkflowRecord, childTaskId: string): void {
    this.deps.events.append({
      agentId: `task:${task.taskId}`, kind: "task_plan_dispatched",
      data: { taskId: task.taskId, queue: task.queue, workflow: wf.name, version: wf.version,
              stepIndex: planIndex, stepId: wf.steps[planIndex]!.id, joinStepIndex: joinIndex,
              planWorkflow: plan.name, planVersion: plan.version, planStepCount: plan.steps.length, childTaskId },
    });
  }

  // Nested sub-workflows: `subIndex` is a reached (not gate-evaluated) subWorkflow step — no
  // agent ever ran for it, mirrors beginFanOut's audit-trail handling exactly (unlike the
  // plan-gate case, whose step WAS gate-evaluated and already closed by handleWorkflowTurn's
  // unconditional closeStep("passed") before the outcome.plan branch). Resolves the named
  // recipe into a concrete ephemeral WorkflowRecord (WorkflowStore.instantiateRecipe),
  // dispatches it as a SINGLE nested child task (a fan-out of one), and blocks the parent on
  // it via the SAME queues.blockOnChildren beginFanOut/beginPlanDispatch use. resolveWorkflow
  // needs no change for this child — Dynamic Planner already carved out the parentTaskId
  // guard for any parented task with an explicit workflowOverride.
  private async beginSubWorkflow(
    agentId: string, task: TaskRecord, wf: WorkflowRecord, subIndex: number, currentRole?: string,
  ): Promise<void> {
    const step = wf.steps[subIndex]!;
    const sub = step.subWorkflow!;
    const joinIndex = wf.steps.findIndex((s) => s.id === sub.joinStep);   // guaranteed valid — validateWorkflowGraph
    this.deps.queues.startStep(task.taskId, subIndex, step.id, null);
    let child: WorkflowRecord;
    try {
      child = this.deps.workflows.instantiateRecipe(sub.name, sub.inputs, { taskId: task.taskId, stepIndex: subIndex, version: sub.version });
    } catch (err) {
      // Bad recipe ref / unresolvable params — flows through the ordinary permanent-failure
      // path, mirrors evaluatePlanGate's {ok:false} -> handleWorkflowTurn's exhausted-retry tail.
      this.deps.queues.closeStep(task.taskId, "failed", (err as Error).message);
      this.deps.queues.markFailed(task.taskId, `step "${step.id}" sub-workflow dispatch failed: ${(err as Error).message}`);
      this.finishWorkflowTask(agentId);
      return;
    }
    this.deps.queues.closeStep(task.taskId, "passed", `dispatched sub-workflow "${sub.name}" v${child.version}`);
    const childId = this.deps.queues.push(task.queue, {
      prompt: task.prompt,
      role: step.role ?? currentRole ?? task.role ?? null,   // fallback chain mirrors beginFanOut/beginPlanDispatch
      priority: task.priority, parentTaskId: task.taskId, workflow: child.name, originConductorId: task.originConductorId,
    }).taskId;
    await this.teardownStepAgent(agentId);
    this.deps.queues.blockOnChildren(task.taskId, [childId], joinIndex);
    this.emitSubWorkflowDispatched(task, wf, subIndex, joinIndex, sub, child, childId);
    await this.tick();   // child was pushed directly via queues.push — drain it now, mirrors beginFanOut/beginPlanDispatch's identical tail
  }

  private emitSubWorkflowDispatched(
    task: TaskRecord, wf: WorkflowRecord, subIndex: number, joinIndex: number,
    sub: WorkflowSubWorkflow, child: WorkflowRecord, childTaskId: string,
  ): void {
    this.deps.events.append({
      agentId: `task:${task.taskId}`, kind: "task_sub_workflow_dispatched",
      data: { taskId: task.taskId, queue: task.queue, workflow: wf.name, version: wf.version,
              stepIndex: subIndex, stepId: wf.steps[subIndex]!.id, joinStepIndex: joinIndex,
              recipeName: sub.name, recipeVersion: sub.version ?? null,
              childWorkflow: child.name, childVersion: child.version, childTaskId },
    });
  }

  // Unbind a workflow-finalized (failed) agent from scheduler tracking. A persistent
  // pool worker is left ALIVE and idle for reuse (ticked so pending work can claim it
  // immediately); an ephemeral (conductor-forced) worker is killed outright — nothing
  // else will ever end its session, since forcing conductor:true suppressed the
  // backend's normal one-shot auto-close.
  private finishWorkflowTask(agentId: string): void {
    const wasAlive = this.deps.supervisor.status(agentId).state === "running";
    this.tracked.delete(agentId);
    this.runCounts.set(agentId, (this.runCounts.get(agentId) ?? 0) + 1);
    if (this.poolIndex.has(agentId)) {
      if (wasAlive) this.deps.supervisor.setOriginConductor(agentId, null);
      if (!wasAlive) {
        // A DEAD pool worker can never serve another idle pick — free its slot rather than
        // leaking pool capacity forever (mirrors settle()'s identical dead-pool-worker cleanup).
        const info = this.poolIndex.get(agentId)!;
        this.pool.get(info.team)?.get(info.role)?.delete(agentId);
        this.poolIndex.delete(agentId);
      }
      void this.tick();
      return;
    }
    if (wasAlive) void this.deps.supervisor.kill(agentId).catch(() => {});
  }

  // WORKFLOW-STEP-SURVIVES-AGENT-EXIT: the outgoing agent already terminated (a one-shot
  // backend can die before handleWorkflowTurn's gate evaluation for its LAST step resolves) —
  // no further terminal event will ever arrive to finalize the task via the ordinary settle()
  // path, so finalize it here directly.
  // DELIBERATELY NOT settle()'s "done" branch: this is only reached from handleWorkflowTurn's
  // `terminal` resolution, i.e. the LAST step's gate already PASSED. settle()'s
  // EMPTY-RESULT-NOT-DONE guard treats an empty resultText as "the agent produced nothing" --
  // here a passing artifact/command gate is the real evidence the work happened, and an empty
  // final text is a legitimate shape for it (nothing asked the agent to narrate). Applying the
  // guard here would fail workflows whose own gate just certified them.
  private async finalizeDeadWorkflowAgent(agentId: string, taskId: string): Promise<void> {
    const rec = this.deps.supervisor.status(agentId);
    this.tracked.delete(agentId);
    this.runCounts.set(agentId, (this.runCounts.get(agentId) ?? 0) + 1);
    const poolInfo = this.poolIndex.get(agentId);
    if (poolInfo) {
      this.pool.get(poolInfo.team)?.get(poolInfo.role)?.delete(agentId);
      this.poolIndex.delete(agentId);
    }
    this.deps.queues.markDone(taskId, rec.resultText ?? "", { toolPolicyDenied: rec.toolPolicyDenied });
    await this.tick();
  }

  // F16.1 Phase 3 (WF-9): the outgoing agent's step gate just passed and the next step
  // wants a handoff — send it ONE summarize turn before the actual switch (design §3.4).
  // Armed on the tracked binding as `awaitingHandoff` so onAgentEvent's turn_complete
  // interception routes the summary back here (resolveAwaitingHandoff) instead of
  // treating it as another gate evaluation; a fixed timeout is the artifacts-only
  // fallback if the turn never completes. NOTE: the step cursor does NOT advance until
  // the handoff resolves (completeHandoff) — see AwaitingHandoff's restart-recovery note.
  private async beginHandoff(agentId: string, wf: WorkflowRecord, nextIndex: number, fromStepIndex: number): Promise<void> {
    const bound = this.tracked.get(agentId);
    if (!bound) return;   // settled/unbound underneath us — nothing to summarize for
    const nextStep = wf.steps[nextIndex]!;
    // TOKEN-OPT-P5: best-effort route THIS summarize turn to the configured fast/cheap
    // model (caps.fastModel) — pure summarization of the outgoing agent's own session,
    // no capability risk, and the resumed session keeps full context. Skipped for a
    // persistent pool worker (poolIndex) — the unbind/rebind below would otherwise race
    // onAgentEvent's separate pool-idle branch, which reacts to poolIndex membership
    // independently of `tracked`. Unbind BEFORE the swap (mirrors replaceStepAgent's
    // identical ordering) so trySwitchToFastModel's internal kill()+respawn (a real
    // terminal event, then a fresh agent_started, both under the same agentId) can
    // never reach onAgentEvent while this agentId is tracked — every interim event
    // lands on an agentId that's in neither `tracked` nor `poolIndex` and is silently
    // ignored (attach()'s top guard). No-op (agentId/bound unchanged) when no fast
    // model is configured, the backend can't resume a session, or the respawn fails —
    // falls straight through to sending the prompt at whatever model the agent is
    // already on, exactly today's behavior. runCounts is deliberately NOT touched here
    // (unlike replaceStepAgent's unbind) — this is an internal respawn, not a completed
    // bind→unbind task cycle.
    if (!this.poolIndex.has(agentId)) {
      this.tracked.delete(agentId);
      await this.deps.supervisor.trySwitchToFastModel(agentId).catch(() => {});
      this.tracked.set(agentId, bound);
    }
    const timer = setTimeout(() => this.resolveAwaitingHandoff(agentId, true), this.deps.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS);
    timer.unref?.();
    bound.awaitingHandoff = { wf, nextIndex, fromStepIndex, timer, resolved: false };
    const prompt = `Step ${fromStepIndex + 1} ("${wf.steps[fromStepIndex]!.title}") is complete. Write a concise handoff for the next agent (role "${nextStep.role}", step: "${nextStep.title}"): what you did, key files touched, what state the worktree is in, and anything unfinished or risky. End your turn after the summary.`;
    try { await this.deps.supervisor.send(agentId, prompt, "scheduler"); }
    catch { this.resolveAwaitingHandoff(agentId, true); }   // agent already gone — fall back immediately
  }

  // F16.1 Phase 3 (WF-9): resolves an armed handoff exactly once — via the outgoing
  // agent's own turn_complete (forceArtifactsOnly:false, uses whatever summaryText the
  // message_complete capture in attach() stashed, possibly none) or the fixed timeout
  // (forceArtifactsOnly:true, always artifacts-only regardless of a late-arriving summary).
  private resolveAwaitingHandoff(agentId: string, forceArtifactsOnly: boolean): void {
    const bound = this.tracked.get(agentId);
    const wait = bound?.awaitingHandoff;
    if (!wait || wait.resolved) return;
    wait.resolved = true;
    clearTimeout(wait.timer);
    const summary = forceArtifactsOnly ? null : (wait.summaryText ?? null);
    void this.completeHandoff(agentId, bound!.taskId, wait, summary);
  }

  // F16.1 Phase 3 (WF-9): the handoff is resolved (summary captured, or artifacts-only) —
  // persist the summary onto the just-passed step's stepHistory entry, then run the
  // actual switch (unbind/teardown/advanceStep/spawn — unchanged from WF-8) carrying the
  // resolved HandoffPackage through to the incoming agent's prompt.
  private async completeHandoff(agentId: string, taskId: string, wait: AwaitingHandoff, summary: string | null): Promise<void> {
    let task: TaskRecord;
    try { task = this.deps.queues.getTask(taskId); } catch { return; }   // task vanished — nothing left to switch
    if (summary) this.deps.queues.setStepHandoffSummary(taskId, wait.fromStepIndex, summary);
    await this.switchStepAgent(agentId, task, wait.wf, wait.nextIndex, { fromStepIndex: wait.fromStepIndex, summary });
  }

  private emitStepHandoff(
    task: TaskRecord, wf: WorkflowRecord, fromStepIndex: number, nextIndex: number,
    fromAgentId: string, toAgentId: string | null, pkg: HandoffPackage | null,
  ): void {
    this.deps.events.append({
      agentId: `task:${task.taskId}`, kind: "task_step_handoff",
      data: {
        taskId: task.taskId, queue: task.queue, workflow: wf.name, version: wf.version,
        fromStepIndex, toStepIndex: nextIndex, fromAgentId, toAgentId,
        role: wf.steps[nextIndex]!.role, summaryBytes: pkg?.summary?.length ?? 0,
      },
    });
  }

  // F16.1 Phase 3 (WF-8/WF-9) + WORKFLOW-STEP-SURVIVES-AGENT-EXIT: unbinds and gracefully ends
  // `agentId` — extracted out of replaceStepAgent's tail so WorkflowGraph's beginFanOut can
  // reuse the EXACT same teardown for a fan-out step's outgoing agent (it too is "no longer
  // bound to anything," same as a role-switch's outgoing agent). Unbind BEFORE teardown —
  // mirrors finishWorkflowTask's ordering so settle()'s event-driven path (onAgentEvent's
  // tracked/poolIndex guard) can never mis-finalize this task once the outgoing agent's
  // kill/terminal event fires.
  private async teardownStepAgent(agentId: string): Promise<void> {
    const wasPoolWorker = this.poolIndex.has(agentId);
    const wasAlive = this.deps.supervisor.status(agentId).state === "running";
    this.tracked.delete(agentId);
    this.runCounts.set(agentId, (this.runCounts.get(agentId) ?? 0) + 1);
    if (wasPoolWorker && !wasAlive) {
      // A DEAD pool worker (unlike the live-reassignment case below) can never serve another
      // idle pick — free its slot rather than leaking pool capacity forever.
      const info = this.poolIndex.get(agentId)!;
      this.pool.get(info.team)?.get(info.role)?.delete(agentId);
      this.poolIndex.delete(agentId);
    }
    // AWAITED (not fire-and-forget): the supervisor's own maxAgentsTotal/per-account caps
    // key off its real agent-state map, independent of the scheduler's `tracked` — spawning
    // the next role's agent before the outgoing one's teardown call resolves could spuriously
    // guardrail-reject it (both counted as "running" for one tick). tracked.delete above already
    // makes settle()/onAgentEvent safe regardless of this await's timing (see the comment above).
    // A dead agent's kill() is a harmless no-op (already terminal).
    // STEP-AGENT-ENDS-DONE: this agent's step gate already PASSED — it finished its work
    // honorably, so its terminal state should read "done", not "killed" (which reads as an
    // operator abort). A still-alive agent gets closeInput's graceful teardown (finishes its
    // current turn, then its input ends and the backend settles it naturally — mirrors
    // retire()'s identical treatment of a persistent worker); closeInput itself resolves
    // quickly (it only signals the close, same AWAITED reasoning as above) so a bounded grace
    // timer backstops an agent that never actually ends afterward with a hard kill, so a switch
    // can never wedge forever on an unresponsive outgoing agent. An already-dead agent has no
    // live session to close — kill() there is the pre-existing harmless no-op cleanup.
    if (!wasPoolWorker) {
      if (wasAlive) {
        await this.deps.supervisor.closeInput(agentId).catch(() => {});
        const graceTimer = setTimeout(() => {
          try { if (this.deps.supervisor.status(agentId).state === "running") void this.deps.supervisor.kill(agentId).catch(() => {}); }
          catch { /* agent record gone — nothing to fall back on */ }
        }, this.deps.stepSwitchGraceMs ?? STEP_SWITCH_GRACE_MS);
        graceTimer.unref?.();
      } else {
        await this.deps.supervisor.kill(agentId).catch(() => {});
      }
    }
    // else: a still-alive persistent pool worker is left alive/idle in the pool — untracked
    // now, available for idleWorker() reuse by this task's next role (if it matches) or any
    // other task's assignment.
  }

  // F16.1 Phase 3 (WF-8/WF-9): a step-boundary role switch — the outgoing agent's step gate
  // just passed, but the NEXT step names a different role. Tears down the outgoing agent
  // and binds the next role's agent directly (not via queue drain — the task stays
  // in_progress throughout, never reverting to "pending"). `handoff` is null for a
  // context:"none" step; otherwise the resolved HandoffPackage from beginHandoff/
  // completeHandoff (possibly with summary:null — the artifacts-only fallback).
  private async switchStepAgent(
    agentId: string, task: TaskRecord, wf: WorkflowRecord, nextIndex: number, handoff: HandoffPackage | null,
  ): Promise<void> {
    const nextStep = wf.steps[nextIndex]!;
    const roleName = nextStep.role!;
    // `task` is a MUTABLE reference (QueueStore hands out the live record) — advanceStep
    // below mutates task.stepIndex in place, so the "from" index must be captured now.
    const fromStepIndex = task.stepIndex;
    this.deps.queues.advanceStep(task.taskId, nextIndex);
    this.emitStepAdvanced(task.taskId, task.queue, wf, nextIndex);
    await this.replaceStepAgent(agentId, task, wf, nextIndex, roleName, fromStepIndex, handoff);
  }

  // F16.1 Phase 3 (WF-8/WF-9) + WORKFLOW-STEP-SURVIVES-AGENT-EXIT: the shared teardown-and-
  // respawn tail of a step-boundary transition — tears down `agentId` (the outgoing agent,
  // whether it's a still-live session being switched away from, or already dead) and binds a
  // fresh agent at (stepIndex, roleName). Caller owns any stepIndex-changing bookkeeping
  // (advanceStep/emitStepAdvanced) BEFORE calling this — switchStepAgent above does so for a
  // genuine step advance; a same-step retry respawn (handleWorkflowTurn, dead agent) calls
  // this directly with stepIndex left unchanged.
  private async replaceStepAgent(
    agentId: string, task: TaskRecord, wf: WorkflowRecord, stepIndex: number, roleName: string,
    fromStepIndex: number, handoff: HandoffPackage | null, retryReason?: string,
  ): Promise<void> {
    await this.teardownStepAgent(agentId);
    const team = this.teamForQueue(task.queue);
    if (!team) {
      this.deps.queues.markFailed(task.taskId, `queue "${task.queue}" has no bound team`);
      this.emitStepHandoff(task, wf, fromStepIndex, stepIndex, agentId, null, handoff);
      return;
    }
    const freshTask = this.deps.queues.getTask(task.taskId);   // advanceStep (if any) already landed
    const spawned = await this.spawnStepAgent(team, roleName, freshTask, wf, stepIndex, handoff, retryReason);
    // F16.1 Phase 3 (WF-9): emit unconditionally, even when parked (toAgentId stays null,
    // mirroring task_step_advanced's identical parked case).
    this.emitStepHandoff(task, wf, fromStepIndex, stepIndex, agentId, spawned ? freshTask.agentId : null, handoff);
    if (!spawned) {
      // Guardrail (e.g. every account cooling down): park the task — it stays in_progress
      // at stepIndex with NO bound agent. tick()'s parkedSwitches retry loop (armed via the
      // starvation retick, set by spawnStepAgent below) picks it back up: the workflow
      // position is never lost, only the agent binding is momentarily absent.
      this.parkedSwitches.set(task.taskId, { team: team.name, roleName, wfName: wf.name, wfVersion: wf.version, stepIndex, handoff, retryReason });
      // An open (agentId:null) stepHistory entry is the persisted "awaiting step-agent"
      // marker — mirrors the existing crash-mid-step diagnostic convention (left open
      // until a later attempt actually starts the step; see closeDanglingStep).
      this.deps.queues.startStep(task.taskId, stepIndex, wf.steps[stepIndex]!.id, null);
      // This switch runs OUTSIDE tick() (driven by onAgentEvent's turn_complete handling),
      // so tick()'s own finally-block arming never sees it — arm the fallback retick directly.
      this.armStarvationRetick();
    }
  }

  // F16.1 Phase 3 (WF-8): binds the CURRENT step's role-agent for a task that is ALREADY
  // in_progress — called by switchStepAgent (a live step-boundary switch) and by tick()'s
  // parkedSwitches retry loop (a switch that guardrailed and is being retried). Unlike
  // spawnForTask/assignPersistent this never touches task.state or stepIndex (the caller
  // already advanced those) — only agentId/stepHistory. Mirrors their spawn-vs-reuse-vs-
  // guardrail split; workdirKey is ALWAYS the task's shared workspace (this path only ever
  // runs for a workflow that uses step roles).
  private async spawnStepAgent(
    team: TeamSpec, roleName: string, task: TaskRecord, wf: WorkflowRecord, stepIndex: number,
    handoff: HandoffPackage | null = null,
    // BUG FIX: the failing gate's reason (or critic's REVISE feedback) for a same-step
    // dead-agent retry (replaceStepAgent, handleWorkflowTurn's willRetry branch) — folded
    // into whichever instructions channel the branch below uses, mirroring the ALIVE
    // retry's workflowStepText(..., outcome.reason) threading.
    retryReason?: string,
  ): Promise<boolean> {
    const template = this.resolveTeamRole(team, roleName);
    if (!template) {
      this.deps.queues.markFailed(task.taskId, `unknown role "${roleName}" in team "${team.name}"`);
      return true;                                             // permanent — nothing left to retry
    }
    const workdirKey = this.sharedWorkdirKey(task.taskId);
    // F16.1 Phase 3 (WF-9): rendered once — null for a context:"none" switch (no package at
    // all), else the handoff block injected into whichever prompt/instructions channel
    // this branch uses (idle-reuse text vs. fresh-spawn instructions).
    const handoffText = handoff ? this.handoffText(task.taskId, wf, handoff) : undefined;
    // TOKEN-OPT-P5: a step-level model override (opt-in, e.g. a cheap model for a
    // mechanical step) — only applies to a FRESH spawn below; an idle persistent
    // worker's model was fixed at its own original spawn and send() has no channel to
    // change it (see the idle-reuse comment just below).
    const step = wf.steps[stepIndex]!;
    const modelOverride = step.model ? { model: step.model } : {};
    // FEATURE-5: a step-level budget ceiling (opt-in, mirrors modelOverride exactly) —
    // only applies to a FRESH spawn below, same idle-persistent-worker-reuse limitation
    // documented on WorkflowStepSchema.budgetUsd. budgetParentId nests this step's own
    // node (registered only when budgetOverride is non-empty) under the task-root node
    // registered at task.taskId by spawnForTask/assignPersistent — a no-op when the task
    // has no root ceiling (checkBudgetAdmission climbs to an unregistered id and stops).
    const budgetOverride = step.budgetUsd != null ? { maxBudgetUsd: step.budgetUsd } : {};
    // W2-8 EFFORT-POLICY (escalate-on-evidence): retryReason is set ONLY when this fresh
    // spawn exists because the previous attempt's gate rejected it (handleWorkflowTurn's
    // willRetry branch, or the remediation loop below) — never for an ordinary step
    // advance (replaceStepAgent's other two callers pass no retryReason). Bump the role's
    // own configured effort exactly one tier so the task pays for more reasoning only once
    // it has already proven the cheaper tier wasn't enough; a role with no explicit
    // baseline effort has nothing to escalate FROM in this implementation — note the backend default
    // is 'high' (SDK-documented), not max, so there is headroom above it this deliberately does not
    // use; escalating an unset baseline would mean inventing one, which is a policy change, not a
    // comment fix.
    // EFFORT-ESCALATE-NOOP fix: template.effort is only ever set for an EXPLICIT spec.effort
    // — the name-heuristic default (defaultEffortForRole, e.g. "fixer"/"eng"/"hotfix") is
    // applied separately inside supervisor.spawn and never written back onto the template
    // this reads. Re-resolve the same heuristic here so both paths agree on the baseline
    // instead of the retry path silently seeing "undefined" and never escalating.
    const baseEffort = template.effort ?? defaultEffortForRole(roleName);
    const escalated = retryReason !== undefined ? escalatedEffort(baseEffort) : undefined;
    const effortOverride = escalated !== undefined ? { effort: escalated } : {};
    if (template.persistent) {
      const idle = this.idleWorker(team.name, roleName);
      if (idle) {
        // idle pool worker's instructions/system-prompt were fixed at ITS OWN original
        // spawn — send() has no channel to change them, so the step scope rides in the
        // message text instead (mirrors assignPersistent's identical idle-reuse path).
        const prompt = `${this.workflowStepText(wf, stepIndex, retryReason, handoffText)}\n\n${task.prompt}`;
        this.deps.supervisor.setOriginConductor(idle, task.originConductorId);
        await this.deps.supervisor.send(idle, prompt, task.author?.from ?? task.pushedBy ?? "operator", undefined, false, undefined, { author: task.author, taskId: task.taskId });
        this.tracked.set(idle, { taskId: task.taskId, team: team.name, role: roleName });
        this.deps.queues.markInProgress(task.taskId, idle);
        this.deps.queues.startStep(task.taskId, stepIndex, wf.steps[stepIndex]!.id, idle);
        return true;
      }
      const pool = this.poolFor(team.name, roleName);
      const cap = template.poolSize ?? team.maxConcurrent;
      if (pool.size >= cap) { this.starved = true; return false; }
      try {
        const { poolSize: _poolSize, name: _name, skills: _skills, ...agentTemplate } = template;
        const baseInstr = typeof task.overrides.instructions === "string" ? task.overrides.instructions : agentTemplate.instructions;
        // FEATURE-2: fresh spawn (not the idle-reuse path above) — mirrors spawnForTask's
        // identical resume-notice threading.
        const instructions = this.workflowInstructions(
          wf, stepIndex, agentTemplate.provider, this.instructionsHeader(team, roleName, baseInstr),
          this.combineHandoffNotes(handoffText, this.retryNoteText(retryReason), this.maybeResumeNotice(task, stepIndex)),
          task,
        );
        const rec = await this.deps.supervisor.spawn(
          { ...agentTemplate, ...task.overrides, ...modelOverride, ...budgetOverride, ...effortOverride, persistent: true, workdirKey, prompt: task.prompt, instructions },
          { membership: { team: team.name, role: roleName }, budgetParentId: task.taskId, originConductorId: task.originConductorId, promptFrom: task.author?.from ?? task.pushedBy ?? "operator", promptAuthor: task.author },
        );
        pool.add(rec.agentId);
        this.poolIndex.set(rec.agentId, { team: team.name, role: roleName });
        this.tracked.set(rec.agentId, { taskId: task.taskId, team: team.name, role: roleName });
        this.deps.queues.markInProgress(task.taskId, rec.agentId);
        this.deps.queues.startStep(task.taskId, stepIndex, wf.steps[stepIndex]!.id, rec.agentId);
        this.captureStepCheckpoint(task.taskId, stepIndex, task.stepAttempts, rec.agentId);
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === "guardrail") { this.starved = true; return false; }
        this.deps.queues.markFailed(task.taskId, (err as Error).message);
        return true;
      }
    }
    try {
      const { poolSize: _poolSize, name: _name, skills: _skills, ...agentTemplate } = template;
      const baseInstr = typeof task.overrides.instructions === "string" ? task.overrides.instructions : agentTemplate.instructions;
      // FEATURE-2: mirrors the persistent-pool fresh-spawn branch's identical threading above.
      const instructions = this.workflowInstructions(
        wf, stepIndex, agentTemplate.provider, this.instructionsHeader(team, roleName, baseInstr),
        this.combineHandoffNotes(handoffText, this.retryNoteText(retryReason), this.maybeResumeNotice(task, stepIndex)),
        task,
      );
      const rec = await this.deps.supervisor.spawn(
        { ...agentTemplate, ...task.overrides, ...modelOverride, ...budgetOverride, ...effortOverride, conductor: true, workdirKey, prompt: task.prompt, instructions },
        { membership: { team: team.name, role: roleName }, budgetParentId: task.taskId, originConductorId: task.originConductorId, promptFrom: task.author?.from ?? task.pushedBy ?? "operator", promptAuthor: task.author },
      );
      this.tracked.set(rec.agentId, { taskId: task.taskId, team: team.name, role: roleName });
      this.deps.queues.markInProgress(task.taskId, rec.agentId);
      this.deps.queues.startStep(task.taskId, stepIndex, wf.steps[stepIndex]!.id, rec.agentId);
      this.captureStepCheckpoint(task.taskId, stepIndex, task.stepAttempts, rec.agentId);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "guardrail") { this.starved = true; return false; }
      this.deps.queues.markFailed(task.taskId, (err as Error).message);
      return true;
    }
  }

  private async evaluateGate(
    gate: WorkflowGate, agentId: string, task: TaskRecord, wf: WorkflowRecord,
  ): Promise<{ ok: true; plan?: WorkflowRecord; note?: string } | { ok: false; reason: string }> {
    if (gate.kind === "none") return { ok: true };
    if (gate.kind === "command") {
      const rec = this.deps.supervisor.status(agentId);
      const exec = this.deps.gateExec ?? defaultGateExec;
      // G1: resolve through the SAME derivation ensureWorkdir uses at spawn — with
      // default isolation:"worktree" the agent's real work lives in
      // .chimera/worktrees/<workdirKey ?? agentId>, not rec.spec.cwd (the main repo).
      const cwd = resolveWorkdirPath({ isolation: rec.spec.isolation, cwd: rec.spec.cwd, agentId, workdirKey: rec.spec.workdirKey });
      // GATE-CANNOT-TELL-LANDED-FROM-EMPTY: preempt the command gate ONLY for the case it
      // structurally cannot get right — a branch that received a real commit and was ALREADY
      // merged to main (CLAUDE.md's land-on-main doctrine merges mid-step, before this gate
      // ever runs) reads to a `git log main..HEAD`-style script as empty, indistinguishable
      // from "nothing was done." The checkpoint captured right after THIS step's spawn
      // (captureStepCheckpoint) already carries the fork-point sha the gate script itself
      // cannot see — use it to tell the two apart BEFORE running the script, not instead of
      // it. Deliberately narrow: if the branch tip equals the checkpoint's commitSha (truly no
      // commits), or the tip isn't an ancestor of main (real unlanded work), fall straight
      // through to the exact same exec() below as before this fix — a no-commits branch still
      // fails the gate exactly as today, and the NO-OP PROTOCOL's empty commit still keeps it
      // out of this preempt (its tip differs from commitSha and isn't merged yet either).
      const cp = task.checkpoint;
      if (cp && cp.stepIndex === task.stepIndex && cp.branch && cp.commitSha && cp.mainRepo) {
        const branchTip = currentWorkdirHeadSha(cwd);
        if (branchTip && branchTip !== cp.commitSha && isShaAncestorOfMain(cp.mainRepo, branchTip)) {
          return { ok: true, note: `branch "${cp.branch}" was already merged to main (commit ${branchTip.slice(0, 12)}) — nothing left to verify, treating as passed` };
        }
      }
      // G2: per-task evidence a gate script can check (e.g. "diff not empty",
      // "commit exists since step start").
      const env: Record<string, string> = {
        CHIMERA_TASK_ID: task.taskId, CHIMERA_STEP_ID: wf.steps[task.stepIndex]!.id,
        CHIMERA_STEP_INDEX: String(task.stepIndex), CHIMERA_AGENT_ID: agentId,
        CHIMERA_WORKFLOW: wf.name, CHIMERA_WORKFLOW_VERSION: String(wf.version),
        // FEATURE-2: idempotency key threaded through dispatch reaching gate scripts too — a
        // command gate can check a marker file named after the key to skip already-done work.
        CHIMERA_IDEMPOTENCY_KEY: this.stepIdempotencyKey(task.taskId, task.stepIndex),
      };
      const res = await exec(gate.spec.command, gate.spec.args, cwd, env, gate.spec.timeoutMs);
      return res.ok ? { ok: true } : { ok: false, reason: res.message || `"${gate.spec.command}" exited non-zero` };
    }
    if (gate.kind === "approval") {
      const team = this.teamForQueue(task.queue);
      const ownerId = team?.createdBy ?? null;
      let to: { agentId: string } | undefined;
      if (ownerId) {
        try { if (this.deps.supervisor.status(ownerId).state === "running") to = { agentId: ownerId }; }
        catch { /* owner unknown/not running — still ask, just without mailbox delivery */ }
      }
      const { answer } = await this.deps.supervisor.ask(agentId, {
        prompt: gate.spec.prompt ?? `Approve step ${task.stepIndex + 1}/${wf.steps.length} ("${wf.steps[task.stepIndex]!.title}") of workflow "${wf.name}"?`,
        options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
        default: { optionIds: ["reject"] },   // fail-closed on timeout
        gate: "approval",   // FEATURE-9: lets the attention inbox label this distinctly
        ...(to ? { to } : {}),
      });
      return answer.optionIds?.includes("approve")
        ? { ok: true } : { ok: false, reason: "approval rejected (or timed out)" };
    }
    if (gate.kind === "artifact") {
      // artifact (D13): "an artifact matching spec exists" — spec.artifactId (optional)
      // pins a SPECIFIC artifact id registered against this task; omitted means "any
      // artifact at all" registered for this task passes. F16.1 Phase 2 (WF-4/G5):
      // scope:"step" (default "task") additionally requires it registered while THIS
      // stepIndex was current; an optional kind pin further narrows the match.
      const { artifactId, scope, kind } = gate.spec;
      if (this.deps.artifacts.existsForTask(task.taskId, { artifactId, scope, stepIndex: task.stepIndex, kind })) {
        return { ok: true };
      }
      const scopeNote = scope === "step" ? " in this step" : "";
      const kindNote = kind ? ` of kind "${kind}"` : "";
      return {
        ok: false,
        reason: artifactId
          ? `artifact "${artifactId}" not registered for this task${scopeNote}`
          : `no artifact${kindNote} registered for this task${scopeNote} yet`,
      };
    }
    if (gate.kind === "plan") return this.evaluatePlanGate(gate, task);
    // gate.kind === "critic" (the only remaining member) — see runCritic.
    return this.runCritic(gate, agentId, task, wf);
  }

  // Dynamic Planner: reuses the artifact gate's existence check (existsForTask's own query
  // shape — artifactId/scope), then goes further: reads the matched artifact's content,
  // validates it against PlanArtifactSchema (the SAME validateWorkflowGraph cycle/dangling/
  // step-count checks a hand-authored workflow.create call gets), and compiles it into a
  // fresh ephemeral WorkflowRecord. Any failure (missing/unreadable/unparseable/invalid/
  // cyclic/oversize) is an ORDINARY gate failure — flows through the EXISTING unmodified
  // onFail/retryLimit policy in handleWorkflowTurn, no critic-style special retry rule
  // needed. Synchronous (no agent spawn), unlike runCritic.
  private evaluatePlanGate(
    gate: Extract<WorkflowGate, { kind: "plan" }>, task: TaskRecord,
  ): { ok: true; plan: WorkflowRecord } | { ok: false; reason: string } {
    const { artifactId, scope } = gate.spec;
    const scopeNote = scope === "step" ? " in this step" : "";
    const candidates = this.deps.artifacts.list({ taskId: task.taskId }).filter((a) =>
      a.kind !== "link" &&
      (!artifactId || a.id === artifactId) &&
      (scope !== "step" || a.stepIndex === task.stepIndex));
    const rec = candidates[candidates.length - 1];   // most-recently-registered match
    if (!rec) {
      return {
        ok: false,
        reason: artifactId
          ? `plan artifact "${artifactId}" not registered for this task${scopeNote}`
          : `no plan artifact registered for this task${scopeNote} yet`,
      };
    }
    let raw: string;
    try { raw = this.deps.artifacts.readContent(rec.id); }
    catch (err) { return { ok: false, reason: `plan artifact "${rec.id}" content unavailable: ${(err as Error).message}` }; }
    let json: unknown;
    try { json = JSON.parse(raw); }
    catch (err) { return { ok: false, reason: `plan artifact "${rec.id}" is not valid JSON: ${(err as Error).message}` }; }
    const parsed = PlanArtifactSchema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, reason: `plan artifact "${rec.id}" failed validation: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    }
    const plan = this.deps.workflows.instantiate(parsed.data, { ephemeral: true, taskId: task.taskId, stepIndex: task.stepIndex });
    return { ok: true, plan };
  }

  // FEATURE-3: one evaluator-optimizer ROUND — spawns a fresh, untracked, one-shot
  // critic agent sharing the worker's worktree (workdirKey), waits for its single
  // turn, and parses its verdict. A "revise" is returned as an ORDINARY gate failure
  // ({ok:false, reason: <critic's feedback>}) — handleWorkflowTurn's existing
  // onFail:"retry" plumbing (a critic-specific willRetry override, see there) resends
  // that feedback to the SAME worker and re-evaluates this gate on its next
  // turn_complete, so the worker↔critic loop needs no new tracked-agent state
  // machine (contrast with beginHandoff/awaitingHandoff, which exists only to
  // intercept a turn_complete BEFORE the ordinary gate-eval path — not needed here
  // since each round's critic is a separate agent, evaluated synchronously in one
  // evaluateGate call). Deliberately NOT added to `this.tracked`: if it were, its
  // own turn_complete would wrongly re-enter handleWorkflowTurn as if it were the
  // worker's.
  private async runCritic(
    gate: Extract<WorkflowGate, { kind: "critic" }>, workerAgentId: string, task: TaskRecord, wf: WorkflowRecord,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const team = this.teamForQueue(task.queue);
    if (!team) return { ok: false, reason: "critic: queue has no bound team" };
    const step = wf.steps[task.stepIndex]!;
    const roleName = gate.spec.criticRole ?? step.role ?? this.tracked.get(workerAgentId)?.role ?? Object.keys(team.roles)[0]!;
    const template = this.resolveTeamRole(team, roleName);
    if (!template) return { ok: false, reason: `critic: unknown role "${roleName}" in team "${team.name}"` };
    const { poolSize: _poolSize, name: _name, skills: _skills, ...agentTemplate } = template;
    // MUST match the worker's own key (see spawnForTask/assignPersistent's
    // hasStepRoles || hasCriticGate widening) or the critic reviews an empty/wrong worktree.
    const workdirKey = this.sharedWorkdirKey(task.taskId);
    const prompt = `You are reviewing step "${step.title}" of workflow "${wf.name}" against these criteria:\n${gate.spec.criteria}\n\n` +
      `Task: ${task.prompt}\n\nInspect the actual work in this worktree (cwd) — read the relevant files, ` +
      `run \`git diff\`/tests if useful. End your final message with exactly one line: ` +
      `"GATE: PASS" if the criteria are met, or "GATE: REVISE" followed by one or more lines of concrete, ` +
      `actionable feedback for the worker if they are not.`;
    let spawned;
    try {
      spawned = await this.deps.supervisor.spawn(
        { ...agentTemplate, workdirKey, conductor: false, persistent: false, prompt },
        { membership: { team: team.name, role: roleName }, budgetParentId: task.taskId, originConductorId: task.originConductorId, promptFrom: task.author?.from ?? task.pushedBy ?? "operator", promptAuthor: task.author },
      );
    } catch (err) {
      // Fails CLOSED to "revise" (consumes one round) rather than hard-failing the task on a
      // transient guardrail — the next round's retry-send naturally re-attempts the spawn.
      return { ok: false, reason: `critic could not be spawned: ${(err as Error).message}` };
    }
    let finalRec;
    try {
      finalRec = await this.deps.supervisor.waitFor(spawned.agentId, this.deps.criticTimeoutMs ?? CRITIC_TIMEOUT_MS);
    } catch (err) {
      void this.deps.supervisor.kill(spawned.agentId).catch(() => {});
      return { ok: false, reason: `critic timed out without a verdict: ${(err as Error).message}` };
    }
    return this.parseCriticVerdict(finalRec.resultText ?? "");
  }

  private parseCriticVerdict(text: string): { ok: true } | { ok: false; reason: string } {
    const m = /GATE:\s*(PASS|REVISE)\b([\s\S]*)$/i.exec(text);
    if (!m) return { ok: false, reason: `critic gave no parseable verdict: ${text.slice(0, 500)}` };
    if (m[1]!.toUpperCase() === "PASS") return { ok: true };
    const feedback = m[2]!.trim();
    return { ok: false, reason: feedback || "critic requested revisions with no further detail" };
  }

  // Task A3 pool helpers — deterministic, no timers/randomness.
  private poolFor(team: string, role: string): Set<string> {
    let byRole = this.pool.get(team);
    if (!byRole) { byRole = new Map(); this.pool.set(team, byRole); }
    let set = byRole.get(role);
    if (!set) { set = new Set(); byRole.set(role, set); }
    return set;
  }

  // First pool worker that is still running per the supervisor AND not
  // currently bound to an in-progress task (i.e. genuinely idle).
  private idleWorker(team: string, role: string): string | null {
    for (const agentId of this.poolFor(team, role))
      if (!this.tracked.has(agentId) && this.deps.supervisor.status(agentId).state === "running") return agentId;
    return null;
  }

  // Task A3 persistent-role branch of the drain loop: reuse an idle pool
  // worker via send(), else spawn a fresh one under the pool-size cap, else
  // signal the caller to stop draining this team (pool full — a later
  // turn_complete/death frees a slot and re-ticks). Mirrors spawnForTask's
  // guardrail-vs-permanent-failure split for the spawn path.
  private async assignPersistent(
    team: TeamSpec, roleName: string, template: RoleSpec, task: TaskRecord, wf: WorkflowRecord | null,
  ): Promise<boolean> {
    // F15: `wf` is resolved once by the drain loop's DispatchContext — see spawnForTask's
    // identical comment for why re-resolving here would poison the tick.
    const idle = this.idleWorker(team.name, roleName);
    if (idle) {
      // D12: an idle pool worker's instructions/system-prompt were fixed at ITS OWN
      // original spawn (possibly for an unrelated, unbound task) — send() has no
      // channel to change them, so the step scope rides in the message text instead.
      // WorkflowGraph: mergeSummaryText is a no-op (undefined) unless this task just
      // fanned out — see spawnForTask's identical comment.
      const prompt = wf ? `${this.workflowStepText(wf, task.stepIndex, undefined, this.mergeSummaryText(task))}\n\n${task.prompt}` : task.prompt;
      this.deps.supervisor.setOriginConductor(idle, task.originConductorId);
      await this.deps.supervisor.send(idle, prompt, task.author?.from ?? task.pushedBy ?? "operator", undefined, false, undefined, { author: task.author, taskId: task.taskId });
      this.tracked.set(idle, { taskId: task.taskId, team: team.name, role: roleName });
      this.deps.queues.markInProgress(task.taskId, idle);
      if (wf && task.workflow === null) this.deps.queues.pinWorkflow(task.taskId, { name: wf.name, version: wf.version });
      if (wf) {
        this.emitStepAdvanced(task.taskId, task.queue, wf, task.stepIndex);
        this.deps.queues.startStep(task.taskId, task.stepIndex, wf.steps[task.stepIndex]!.id, idle);
      }
      // FEATURE-10 fix: see captureStepCheckpoint's comment — this idle-reuse bind is
      // exactly the "same worker, new task, same physical worktree/branch" moment that
      // needs a fresh per-task marker so EvidenceStore can scope this task's diff correctly.
      this.captureStepCheckpoint(task.taskId, task.stepIndex, task.stepAttempts, idle);
      return true;
    }
    const pool = this.poolFor(team.name, roleName);
    const cap = template.poolSize ?? team.maxConcurrent;
    if (pool.size >= cap) return false;           // pool full — break the drain loop, retry on a later tick
    try {
      // strip role-level scheduling metadata (poolSize only), mirroring spawnForTask
      // (Task A1/A2) — `persistent` IS a valid AgentSpec field and must flow through.
      const { poolSize: _poolSize, name: _name, skills: _skills, ...agentTemplate } = template;
      // parity with spawnForTask: apply per-task overrides on the SPAWN of a persistent
      // worker (they cannot be applied on later reuse via send(), which has no override
      // channel — an accepted asymmetry: overrides bind the first assignment only).
      // Task B1: membership + roster (see spawnForTask's identical comment above).
      const baseInstr = typeof task.overrides.instructions === "string" ? task.overrides.instructions : agentTemplate.instructions;
      let instructions = this.instructionsHeader(team, roleName, baseInstr);
      // D12: a genuine fresh spawn (not a reuse) — the step scope rides in
      // instructions, same as spawnForTask; `persistent:true` already keeps the input
      // stream open across turns (no need to also force conductor here).
      // FEATURE-2: mirrors spawnForTask's identical resume-notice threading.
      if (wf) instructions = this.workflowInstructions(wf, task.stepIndex, agentTemplate.provider, instructions, this.combineHandoffNotes(this.mergeSummaryText(task), this.maybeResumeNotice(task, task.stepIndex)), task);
      // FEATURE-2: mirrors spawnForTask's identical unconditional workdirKey fix — see there
      // for the full root-cause explanation.
      const workdirKey = wf ? this.sharedWorkdirKey(task.taskId) : undefined;
      // TOKEN-OPT-P5: mirrors spawnForTask's identical step 0 model override.
      const stepModel = wf?.steps[task.stepIndex]?.model;
      const rec = await this.deps.supervisor.spawn(
        {
          ...agentTemplate, ...task.overrides, persistent: true, ...(workdirKey ? { workdirKey } : {}),
          ...(stepModel ? { model: stepModel } : {}), prompt: task.prompt, instructions,
        },
        // FEATURE-5: mirrors spawnForTask's identical task.taskId-keyed root registration.
        // Dynamic Planner: mirrors spawnForTask's identical budgetParentId inheritance.
        {
          membership: { team: team.name, role: roleName }, budgetNodeId: task.taskId,
          originConductorId: task.originConductorId, promptFrom: task.author?.from ?? task.pushedBy ?? "operator", promptAuthor: task.author,
          ...(task.parentTaskId ? { budgetParentId: task.parentTaskId } : {}),
        },
      );
      pool.add(rec.agentId);
      this.poolIndex.set(rec.agentId, { team: team.name, role: roleName });
      this.tracked.set(rec.agentId, { taskId: task.taskId, team: team.name, role: roleName });
      this.deps.queues.markInProgress(task.taskId, rec.agentId);
      if (wf && task.workflow === null) this.deps.queues.pinWorkflow(task.taskId, { name: wf.name, version: wf.version });
      if (wf) {
        this.emitStepAdvanced(task.taskId, task.queue, wf, task.stepIndex);
        this.deps.queues.startStep(task.taskId, task.stepIndex, wf.steps[task.stepIndex]!.id, rec.agentId);
      }
      // FEATURE-10 fix: mirrors spawnForTask's identical unconditional capture — see there.
      this.captureStepCheckpoint(task.taskId, task.stepIndex, task.stepAttempts, rec.agentId);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "guardrail") {   // caps/cooldowns full: stay pending, zero attempts
        this.starved = true;
        return false;
      }
      this.deps.queues.markFailed(task.taskId, (err as Error).message);    // unknown account, invalid merged spec etc. — permanent
      return true;
    }
  }

  private async settle(agentId: string): Promise<void> {
    const t = this.tracked.get(agentId);
    if (!t) return;
    // WORKFLOW-STEP-SURVIVES-AGENT-EXIT: a one-shot backend (e.g. GENERIC) can reach its own
    // terminal state before handleWorkflowTurn's async step-boundary decision (kicked off by
    // the PRECEDING turn_complete event, still in flight) has finished — that call owns this
    // task's fate entirely; markDone/markFailed-ing it here regardless of remaining steps
    // would finalize the task at whatever step it happened to die on. Defer completely.
    if (this.stepTransitioning.has(t.taskId)) return;
    const rec = this.deps.supervisor.status(agentId);
    // "paused" (session-limit HOLD) is NON-terminal: the worker keeps its bound task and pool
    // slot and auto-resumes at its reset. Settling it here would spuriously mark the task a
    // failed attempt (consuming a retry / duplicating work) even though the agent will finish it.
    if (rec.state === "running" || rec.state === "paused") return;
    // Hoisted out of the "done" branch below: the EMPTY-RESULT-NOT-DONE guard further down needs
    // the SAME task record to see whether a workflow gate already certified this agent's work.
    let task: TaskRecord | null;
    try { task = this.deps.queues.getTask(t.taskId); } catch { task = null; }
    // A foreground result is not completion while provider-native background work is active.
    // The opt-out is deliberately explicit and per-contract; ordinary queue work stays
    // conservative. Keep the binding intact so a late task notification/result re-enters here.
    const allowDurableBackgroundTasks = rec.spec.providerOptions["allowDurableBackgroundTasks"] === true;
    if (!allowDurableBackgroundTasks && rec.backgroundTaskFailure) {
      const timer = this.backgroundWaitTimers.get(agentId);
      if (timer) clearTimeout(timer);
      this.backgroundWaitTimers.delete(agentId);
      this.tracked.delete(agentId);
      this.failAttempt(t.taskId, Math.max(1, rec.attempts.length), rec.backgroundTaskFailure);
      await this.tick();
      return;
    }
    if (!allowDurableBackgroundTasks && rec.backgroundTaskAwaitingFinal) {
      const timeoutMs = this.deps.backgroundTaskTimeoutMs ?? BACKGROUND_TASK_TIMEOUT_MS;
      const elapsed = Date.now() - (rec.backgroundTaskBarrierStartedAt ?? Date.now());
      if (elapsed >= timeoutMs) {
        this.backgroundWaitTimers.delete(agentId);
        this.tracked.delete(agentId);
        this.failAttempt(t.taskId, Math.max(1, rec.attempts.length), "provider background task timed out before a follow-up final result");
        await this.tick();
      } else if (!this.backgroundWaitTimers.has(agentId)) {
        const timer = setTimeout(() => {
          this.backgroundWaitTimers.delete(agentId);
          void this.settle(agentId).catch(() => {});
        }, timeoutMs - elapsed);
        timer.unref?.();
        this.backgroundWaitTimers.set(agentId, timer);
      }
      return;
    }
    const backgroundTimer = this.backgroundWaitTimers.get(agentId);
    if (backgroundTimer) clearTimeout(backgroundTimer);
    this.backgroundWaitTimers.delete(agentId);
    if (rec.state === "done") {
      // An OPEN (outcome:null) stepHistory entry means this step's gate was never evaluated —
      // turn_complete either never fired for this agent or hasn't reached handleWorkflowTurn
      // yet. Agent-terminal is just as valid a step boundary as turn_complete — evaluate it
      // now (handleWorkflowTurn re-derives "agent already dead" itself) rather than falling
      // through to the plain markDone below, which would finalize the task wherever it stands.
      if (task?.workflow && task.stepHistory[task.stepHistory.length - 1]?.outcome === null) {
        await this.handleWorkflowTurn(agentId, task);
        return;
      }
    }
    // WF-9: a summarize-turn agent that errors/crashes (no turn_complete, so
    // resolveAwaitingHandoff never runs) instead of finishing normally would otherwise leave
    // its timer dangling — clear it now rather than let it fire (harmlessly, but late) against
    // an already-unbound agentId.
    if (t.awaitingHandoff && !t.awaitingHandoff.resolved) {
      t.awaitingHandoff.resolved = true;
      clearTimeout(t.awaitingHandoff.timer);
    }
    this.tracked.delete(agentId);
    this.runCounts.set(agentId, (this.runCounts.get(agentId) ?? 0) + 1);
    // Task A3: a persistent worker that reaches THIS point is dead (settle only
    // runs for non-running state) — remove it from its pool before failing/
    // reverting its task, so idleWorker never hands out a dead agent and the
    // pool's size frees up for a respawn.
    const poolInfo = this.poolIndex.get(agentId);
    if (poolInfo) {
      this.pool.get(poolInfo.team)?.get(poolInfo.role)?.delete(agentId);
      this.poolIndex.delete(agentId);
    }
    if (rec.state === "done") {
      // EMPTY-RESULT-NOT-DONE: a backend can reach state "done" (a clean "result" event, no
      // "error") with an EMPTY text AND no structured output -- observed 2026-09-02 on the
      // generic/openai-compat backend, where a finish_reason the provider reported as clean was
      // actually a truncated turn (see backends/generic.ts's TRUNCATION-SURFACE). Silently
      // markDone-ing that leaves the operator staring at a task marked "done" with nothing in
      // it. A spec.resultSchema is the one legitimate case an empty text is fine: the caller
      // asked for machine-shaped output, not prose, and structuredResult (validated separately
      // by the backend before it ever reaches "done") is the real payload here.
      // GATE-CERTIFIED-EXEMPT: the SAME exemption the resultSchema case gets, for the same
      // reason -- prose is not this task's payload. A workflow whose LAST step's gate already
      // closed "passed" has had its real work verified by the gate (tests, a command, a critic);
      // its final agent's chat text is decoration. Without this, an identical run landed `done`
      // or `failed` purely on WHO WON A RACE: finalizeDeadWorkflowAgent (the agent was already
      // dead when the gate passed) markDone's unconditionally, while a still-alive agent's
      // closeInput routes the very same task through this guard. A closed "passed" entry is
      // only ever the LAST entry post-terminal -- advanceToIndex opens a fresh outcome:null
      // entry for every next step, so a mid-workflow settle never matches here.
      const gateCertified = Boolean(task?.workflow) && task!.stepHistory[task!.stepHistory.length - 1]?.outcome === "passed";
      const resultText = rec.resultText ?? "";
      if ((rec.permissionDenied || rec.toolPolicyDenied) && !gateCertified) {
        // A terminal backend result only proves the conversation ended. A structured denial
        // proves the requested implementation was blocked, even when the model emitted polished
        // non-empty prose afterward. Keep dependents blocked and let the queue retry policy run.
        this.failAttempt(t.taskId, Math.max(1, rec.attempts.length), rec.toolPolicyDenied
          ? "agent did not complete the task (tool policy denied one or more tool calls)"
          : "agent did not complete the task (permission request was declined or cancelled)");
      } else if (rec.spec.resultSchema && rec.structuredResult === undefined) {
        // RESULT-SCHEMA-MISSING: the backends validate structured output, but the scheduler is
        // the final task-state boundary and must not turn a broken/misbehaving backend's plain
        // text into success when the caller explicitly required machine-shaped output.
        this.failAttempt(t.taskId, Math.max(1, rec.attempts.length), "agent produced no structured result for resultSchema");
      } else if (resultText.trim() === "" && rec.structuredResult === undefined && !gateCertified) {
        // TOOL-POLICY-IN-EMPTY-RESULT: the failure text carries the denied-tool-policy fact
        // (markFailedAttempt has no toolPolicyDenied option the way markDone does), and a denied
        // tool policy is the OTHER common way an agent finishes clean with nothing -- without it
        // the operator cannot tell a truncated turn from a permission wall from the task record.
        // RETRYABLE, NOT CASCADE-FATAL: an empty result is a TRANSIENT symptom (a truncated
        // turn, a provider hiccup), so it takes the same markFailedAttempt path every other
        // settle() failure takes -- markFailed here doomed every dependent task in the subtree
        // (queues.ts markFailed cascades) on one bad round-trip, with no retry at all.
        this.failAttempt(t.taskId, Math.max(1, rec.attempts.length), rec.toolPolicyDenied
          ? "agent produced no result (tool policy denied one or more tool calls)"
          : "agent produced no result");
      } else {
        this.deps.queues.markDone(t.taskId, resultText, { toolPolicyDenied: rec.toolPolicyDenied });
      }
    } else if (rec.state === "killed") {
      // resolved decision 7: a kill is a deliberate operator cancel, not a retryable failure —
      // agent_kill is the documented way to stop an in-flight task.
      // RESUMED-STEP-REVERIFIES-LANDED-WORK: EXCEPT when the kill lands on an agent whose
      // worktree branch is already merged into main — kill()/reportUnresponsive() (the two
      // reap paths) both call stampWorktreeLanding synchronously BEFORE this settle() ever
      // runs, so rec.worktreeUnlanded === false here is a durable, race-free fact: this
      // agent's real work is already sitting on main, whatever it was doing when reaped.
      // Recording that as "failed" isn't conservative, it's false — and it previously sent a
      // task all the way back to "pending" for the same (now-merged, so gate-empty) branch to
      // be re-verified and fail loudly. undefined (no worktree, isolation:"none", or the
      // check couldn't confirm) falls through to the exact prior behavior.
      if (rec.worktreeUnlanded === false) {
        this.deps.queues.markDone(t.taskId, rec.resultText ?? "agent killed after its work was already merged to main", { toolPolicyDenied: rec.toolPolicyDenied });
      } else {
        this.deps.queues.markFailed(t.taskId, "agent killed");
      }
    } else if (rec.state === "failed" && rec.worktreeUnlanded === false) {
      // RESUMED-STEP-REVERIFIES-LANDED-WORK, same fact source, other reap path: reportUnresponsive
      // (liveness probe) also calls stampWorktreeLanding before handing off to scheduleCrashRestart,
      // which trips the circuit breaker straight to state:"failed" (not "killed") once retries are
      // exhausted. The "killed" branch above already treats worktreeUnlanded===false as proof the
      // work landed before the reap; a crash-loop-exhausted agent reaped on an already-merged branch
      // is the exact same fact pattern and was falling through to markFailedAttempt below, re-queuing
      // (or burning a retry on) work that had already succeeded.
      this.deps.queues.markDone(t.taskId, rec.resultText ?? "agent failed after its work was already merged to main", { toolPolicyDenied: rec.toolPolicyDenied });
    } else {
      const attemptsConsumed = Math.max(1, rec.attempts.length);     // failover attempts count as retries (spec §4)
      const lastClass = rec.attempts[rec.attempts.length - 1]?.errorClass as ErrorClassName | undefined;
      this.failAttempt(t.taskId, attemptsConsumed, `agent ${rec.state}${lastClass ? ` (${lastClass})` : ""}${rec.failureMessage ? `: ${rec.failureMessage}` : ""}`, lastClass);
    }
    await this.tick();
  }

  // Single funnel for every RETRYABLE task failure the scheduler decides on. markFailedAttempt
  // (not markFailed) is the contract: it honours the queue's retryLimit/retryPolicy and only
  // cascades to dependents once those are exhausted, whereas markFailed dooms the whole
  // dependent subtree immediately on a single, possibly transient, failure.
  private failAttempt(taskId: string, attemptsConsumed: number, error: string, errorClass?: ErrorClassName): void {
    const result = this.deps.queues.markFailedAttempt(taskId, attemptsConsumed, error, errorClass);
    // RETRY-BACKOFF: "in_progress" here means markFailedAttempt PARKED it (a retryPolicy is
    // configured and it's neither exhausted nor poisoned) rather than reverting straight to
    // "pending" — schedule the delayed release ourselves.
    if (result.state === "in_progress") {
      const policy = this.deps.queues.get(result.queue).retryPolicy!;
      this.scheduleRetry(taskId, computeRetryDelayMs(policy, result.attempts));
    }
  }
}
