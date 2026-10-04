import { existsSync, readFileSync } from "node:fs";
import type { TaskStepCheckpoint } from "@chimera/protocol";
import type { AgentRecord } from "./supervisor.js";
import type { AgentSupervisor } from "./supervisor.js";
import type { EventLog } from "./events.js";
// R2 (self-healing supervision): reconstructAgentsFromLog/applyEventToRecord MOVED to
// replay.ts (now a shared fold-from-log primitive, also used by the standalone
// replayAgentsAsOf post-mortem path) — re-exported here so every existing import site
// (reattach.test.ts imports it from "@chimera/core/reattach") keeps compiling unchanged.
import { reconstructAgentsFromLog } from "./replay.js";
export { reconstructAgentsFromLog };

// LAZY-REATTACH: "lazy" (the default) brings prior running agents back as paused, process-less
// records; "eager" is the pre-feature behavior — re-spawn every one of them at boot.
export type ReattachMode = "lazy" | "eager";

// Task CR2: the minimal shape reattachConductors needs from an Engine — a real Engine instance
// satisfies this structurally, but tests can pass a lightweight stub without booting one.
export type ReattachEngine = {
  // reattachPaused: session-limit HOLD restart-survival — rehydrate a prior PAUSED agent and
  // re-arm its auto-resume. reattachTerminal: REATTACH-TERMINAL-RECORDS — rehydrate a prior
  // done/failed/killed agent for display only (no spawn/resume). Both optional so lightweight
  // test stubs can omit them (guarded at the call).
  supervisor: {
    spawn: AgentSupervisor["spawn"];
    reattachPaused?: AgentSupervisor["reattachPaused"];
    reattachTerminal?: AgentSupervisor["reattachTerminal"];
    // LAZY-REATTACH: absent ⇒ the caller is a lightweight test stub, and reattachConductors
    // falls back to the eager re-spawn it always did.
    reattachDormant?: AgentSupervisor["reattachDormant"];
    // R2 (self-healing supervision): OPTIONAL so the existing lightweight `{ spawn }`-only
    // test stubs in reattach.test.ts keep compiling unchanged — a real AgentSupervisor always
    // has it. See reattachConductors' catch below: a failed re-spawn used to just console.error
    // and silently vanish (spawn() itself deletes the just-created record on launch failure);
    // now it's routed through the SAME crash-loop backoff/circuit-breaker recovery path a real
    // backend crash uses, instead of disappearing.
    recoverFromFailedReattach?: AgentSupervisor["recoverFromFailedReattach"];
  };
  // FEATURE-4: `replay` is OPTIONAL so the existing minimal `{ append }` test stubs in
  // reattach.test.ts keep compiling unchanged (and keep their current no-replay behavior) — a
  // real Engine's `events` is a full EventLog, which always has it.
  // R2-DURABLE-LOG: `recoveryReport` is likewise OPTIONAL, same reasoning.
  events: { append: EventLog["append"]; replay?: EventLog["replay"]; recoveryReport?: EventLog["recoveryReport"]; latestAgentStarts?: EventLog["latestAgentStarts"] };
};

// Daemon startup. RESTART-RESUME widened the CR2 scope: EVERY prior RUNNING agent the daemon
// can meaningfully bring back is re-spawned under its ORIGINAL agentId — resumed into its prior
// SDK session (record.sessionId, kept current on every agent_started and snapshotted per event),
// idle, no re-sent prompt — so a daemon restart preserves whole working sessions, not just
// conductors. (The exported name is historical — kept to avoid churning its call/test sites.)
//
// Deliberately NOT resumed:
//   - scheduler-owned team/queue workers (membership set): their task reverted to pending on
//     boot and the scheduler re-dispatches it fresh — resuming the old worker too would
//     double-execute the task and leak an agent the rebooted scheduler no longer tracks;
//   - shadow rows (synthetic sub-agent/workflow projections — no process/session of their own);
//   - a non-conductor with NO sessionId (nothing to resume into): marked "interrupted" as
//     before. A conductor without one still re-spawns fresh-but-idle (resume:null) — an
//     orchestrator seat is worth keeping even without history.
//
// REATTACH-TERMINAL-RECORDS: a prior done/failed/killed agent is NEVER re-spawned/resumed (it's
// terminal — nothing to resume into) but IS re-registered via reattachTerminal for display, so
// agent_list/team.status keep showing it (transcript still reachable via the persisted event
// log) instead of silently vanishing on restart.
//
// MEMORY-BOUNDED-DISK-COMPLETE: every prior terminal record is re-registered now (no cap) —
// state.json is disk-complete as of this feature (supervisor.ts's snapshotAgents/
// archiveColdTerminalAgents archives-then-lightens instead of truncating), so every row here is
// already either a full hot-terminal record or an inexpensive "light shell" (identity/status
// fields only, AgentRecord.archived === true) whose heavy text rehydrates lazily from
// AgentArchiveStore on the next status()/result()/resume() call. Re-registering all of them
// keeps the roster complete across a restart instead of the old hard cutoff (previously: records
// beyond MAX_TERMINAL_AGENTS_PERSISTED were silently left out of the roster forever).
//
// Re-attach is fire-and-forget with a `.catch`: ONE failed re-spawn (account gone, resume
// error, guardrail, ...) must never crash daemon startup or block the others.
export function reattachConductors(
  engine: ReattachEngine, priorAgents: AgentRecord[], mode: ReattachMode = "lazy",
): void {
  const isTerminal = (a: AgentRecord) => a.state === "done" || a.state === "failed" || a.state === "killed";

  for (const a of priorAgents) {
    if (a.shadow === true) continue;
    // Session-limit HOLD (restart-survival): re-register a prior PAUSED agent and re-arm its
    // auto-resume (or resume now if the reset already passed). Runs BEFORE the running-only
    // guard below — paused is not "running". Same membership guard as the running case.
    if (a.state === "paused") { if (!a.membership) engine.supervisor.reattachPaused?.(a); continue; }
    if (isTerminal(a)) { engine.supervisor.reattachTerminal?.(a); continue; }
    if (a.state !== "running") continue;
    const isConductor = (a.spec as { conductor?: boolean })?.conductor === true;
    const resumable = !a.membership && (isConductor || typeof a.sessionId === "string");
    if (resumable && mode === "lazy" && engine.supervisor.reattachDormant) {
      // LAZY-REATTACH (default): come back PAUSED with the session intact and NO process. The
      // record's `running` state in the snapshot means the same thing whether the daemon exited
      // cleanly (suspendForShutdown deliberately leaves records running + sessionId) or was
      // killed outright — either way there is no live process behind it on this boot, so the
      // honest projection is "paused, resumable", not "running". The process starts on the
      // first action that needs the session (supervisor.send's own revive, or an explicit
      // resume from the UI).
      engine.supervisor.reattachDormant(a, "daemon-restart");
    } else if (resumable) {
      // CONDUCTOR-FULL-ACCESS (deliberate non-migration): a reattached conductor keeps its
      // STORED permissionProfile (`...a.spec`) rather than adopting config.conductorPermissionProfile.
      // Reattach's whole contract is "continue exactly as before" — silently widening a live
      // agent's access on a daemon restart would be a surprising security-relevant change. The
      // new "full" default applies only to a FRESH conductor spawn; an existing one is re-scoped
      // explicitly via agent.setPermission from the UI (now that its profile is visible there).
      // F47.FIX L-1: spawn() builds a FRESH record, so without these two the eager path silently
      // dropped attentionAt/reviewedAt for every running agent — a restart marked the whole fleet
      // read. The lazy paths never had this problem (reattachDormant/Paused/Terminal spread
      // `...prior`).
      void engine.supervisor.spawn(
        { ...a.spec, resume: a.sessionId ?? null, resumeOnly: true },
        { agentId: a.agentId, treeId: a.treeId, depth: a.depth, parentId: a.parentId,
          projectId: a.projectId, originConductorId: a.originConductorId ?? null,
          ...(a.attentionAt !== undefined ? { attentionAt: a.attentionAt } : {}),
          ...(a.reviewedAt !== undefined ? { reviewedAt: a.reviewedAt } : {}) },
      ).catch((e) => {
        const message = String((e as Error).message);
        console.error(`chimerad: re-attach failed for ${a.agentId}: ${message}`);
        engine.supervisor.recoverFromFailedReattach?.(a, message);
      });
    } else {
      engine.events.append({ agentId: a.agentId, kind: "status", data: { state: "interrupted" } });
    }
  }
}

// Task REATTACHTEST: the daemon-startup BOOT GLUE — read the prior state.json snapshot and hand its
// `agents` list to reattachConductors. Extracted out of main.ts (behavior-preserving) so it's testable
// with injected fakes instead of requiring a booted daemon. A crash mid-snapshot can leave a
// torn/partial state.json — tolerate it (return, no throw) rather than crash-loop the daemon on the
// very restart this file exists to support.
//
// FEATURE-4: state.json is no longer rewritten on every event (SnapshotScheduler debounces it),
// so the snapshot on disk can be stale by up to its cadence window as of the crash. Every
// snapshot now also records `lastSeq` — the event-log position it's valid as of — so the gap
// [lastSeq+1, current] can be replayed and folded onto `agents` BEFORE deciding what to
// reattach. A pre-feature state.json has no `lastSeq` (was always exactly current at write
// time, by construction) — replay is skipped entirely, identical to today's behavior.
export function reattachFromState(
  engine: ReattachEngine,
  stateFilePath: string,
  readFile: typeof readFileSync = readFileSync,
  exists: typeof existsSync = existsSync,
  mode: ReattachMode = "lazy",
): void {
  if (!exists(stateFilePath)) return;
  let prior: { agents?: AgentRecord[]; lastSeq?: number };
  try {
    prior = JSON.parse(String(readFile(stateFilePath, "utf8"))) as { agents?: AgentRecord[]; lastSeq?: number };
  } catch {
    console.error("chimerad: ignoring unreadable/torn state.json from a prior crash");
    return;
  }
  // BOOT-LATENCY-EVENTLOG: with the default deferred integrity scan, a real EventLog's report
  // is still empty at this point in the boot (the sweep runs after the socket is up, and logs
  // its own summary from engine.ts when it completes) — so in practice this branch now only
  // fires for a sync-mode log. Kept because the summary is genuinely about THIS restart's
  // replay and stays correct whenever the report is already populated.
  // R2-DURABLE-LOG: an unconditional summary, tied to this same boot-recovery moment — does NOT
  // attempt to reason about whether the quarantined range actually overlaps the [lastSeq+1,
  // currentSeq] gap replayed below (that precision is a documented follow-up); "recovery
  // happened at all" is signal enough for an operator watching boot logs.
  const recovery = engine.events.recoveryReport?.();
  if (recovery && (recovery.quarantined.length > 0 || recovery.seqGaps.length > 0)) {
    console.error(`chimerad: event log recovery affected this restart — ${recovery.quarantined.length} segment(s) quarantined, ${recovery.seqGaps.length} seq gap(s) found`);
  }
  const agents = prior.agents ?? [];
  // Upgrade old Codex snapshots whose normalized starts carried threadId only.
  // Recover ONLY the latest attempt, with matching provider/account/record identity,
  // and only through the snapshot watermark. Never borrow another attempt's thread
  // or replay historical lifecycle/cost events onto an already-current snapshot.
  if (typeof prior.lastSeq === "number" && engine.events.latestAgentStarts) {
    const candidates = agents.filter(a => a.provider === "codex" && !a.sessionId && !a.shadow && !a.archived);
    const since = new Map<string, number>();
    for (const a of candidates) {
      const start = a.attempts.at(-1)?.startedAt;
      if (typeof start === "number" && Number.isFinite(start)) since.set(a.agentId, Math.max(start, a.createdAt));
    }
    const starts = engine.events.latestAgentStarts(since, prior.lastSeq);
    for (const a of candidates) {
      const e = starts.get(a.agentId);
      if (e?.data["provider"] !== "codex" || e.data["accountName"] !== a.accountName || e.data["createdAt"] !== a.createdAt) continue;
      const id = e.data["threadId"];
      if (typeof id === "string" && id) a.sessionId = id;
    }
  }
  if (typeof prior.lastSeq === "number" && engine.events.replay) {
    const gap = engine.events.replay({ fromSeq: prior.lastSeq + 1, limit: Number.MAX_SAFE_INTEGER });
    reconstructAgentsFromLog(agents, gap);
  }
  reattachConductors(engine, agents, mode);
}

// FEATURE-2 (durable checkpoint-resume): renders the resume notice injected into a workflow
// step's prompt/instructions whenever a checkpoint already exists for the step about to
// (re-)start (scheduler.ts's maybeResumeNotice decides WHEN — a genuine first attempt at a step
// never sees this). Lives here rather than in scheduler.ts because THIS file is where
// crash-recovery semantics are owned; scheduler.ts only decides when to surface it. Pure — no
// I/O — so it's trivially unit-testable on its own.
//
// A boot-time pass that actively VERIFIES a checkpoint's commitSha is still reachable in its
// worktree (rather than just rendering a notice) was considered and deliberately NOT built this
// slice: reattachConductors/reattachFromState only ever see AgentRecords from state.json, with
// no access to TaskRecords (a separate store, queues.json) or to the owning team's
// AgentSpec.cwd (needed to reconstruct a worktree path from a bare workdirKey) — wiring that
// through would need a new cross-store query surface for a check that never changes dispatch
// behavior (the workdirKey-stability fix in scheduler.ts is what actually makes resume work;
// git itself is what durably preserves the commits). Left as an explicit follow-up.
export function resumeNoticeFor(cp: TaskStepCheckpoint): string {
  const at = cp.commitSha ? `${cp.branch ?? "unknown branch"}@${cp.commitSha.slice(0, 8)}` : "no prior commit recorded";
  return `[resume notice — idempotency key ${cp.idempotencyKey}] A previous attempt at this step already ran in this worktree (last known state: ${at}). Before redoing work, run \`git log --oneline -5\` here and check for existing commits/files — do not repeat side effects (commits, external calls, file writes) already reflected in the worktree.`;
}
