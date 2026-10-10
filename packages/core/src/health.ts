import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { NormalizedEvent, DynamicCapConfig } from "@chimera/protocol";
import { isLiveDependant, type AgentRecord, type AgentState } from "./supervisor.js";
import type { DynamicCapTracker } from "./dynamic-cap.js";
// F09/J4: these two sets used to be declared here. They now live in turn-kinds.ts, unchanged,
// because prompt-ack.ts must answer "is a turn open" with the SAME definition this wedge
// detector uses — a second copy would drift.
import { isTurnOpening, TURN_CLOSING_KINDS } from "./turn-kinds.js";

// ORPHANED-DAEMON-LEAK: a chimerad process discovered by scanning the OS process table, as
// opposed to an AgentRecord (a supervised AGENT the daemon itself spawned — a different thing
// entirely; see the sweep doc comment below on why these are never confused).
export type ChimeradProcess = {
  pid: number;
  ppid: number;
  // CHIMERA_HOME read from the process's own environment; null when it couldn't be determined
  // (process exited between listing and inspection, `ps` unavailable, etc.) — never reapable.
  home: string | null;
  // True when the process carries a launchd/systemd (or equivalent) management marker
  // (XPC_SERVICE_NAME, CHIMERA_LAUNCHD_LABEL, CHIMERA_SYSTEMD_UNIT) — the operator's real,
  // service-managed daemon. Never reapable, regardless of any other signal.
  managed: boolean;
};

// Pure classifier — no I/O — so the exact reap rule is unit-testable without shelling out.
// A process is reapable ONLY when EVERY one of these holds:
//   - it isn't the sweeping daemon itself (pid check)
//   - it isn't launchd/systemd-managed (the operator's real daemon, or a future one)
//   - its CHIMERA_HOME is known AND differs from the sweeping daemon's own home (never touch a
//     peer that's legitimately serving the SAME home — that would mean OUR OWN singleton guard
//     failed, a different bug to fix, not something to paper over by killing it here)
//   - ppid === 1: reparented to init, i.e. genuinely orphaned (whoever spawned it is gone).
//     A live daemon's ORIGINAL launchd/CLI parent may itself legitimately show ppid 1 on macOS —
//     that's exactly why the `managed` and `home` checks above must ALSO pass; ppid alone is
//     deliberately not sufficient.
export function isReapableOrphanChimerad(
  proc: ChimeradProcess,
  self: { pid: number; home: string },
): boolean {
  if (proc.pid === self.pid) return false;
  if (proc.managed) return false;
  if (proc.home === null) return false;
  if (proc.home === self.home) return false;
  if (proc.ppid !== 1) return false;
  return true;
}

// Real process-table scan (macOS/Linux `ps`): finds every chimerad.js process, then inspects
// each candidate's environment for CHIMERA_HOME and management markers. Two `ps` calls per
// candidate (list, then `eww` for env) rather than one big dump — env is only ever needed for
// processes that already matched the binary path, keeping the common case (no strays) cheap.
// Never throws: `ps` failing (unavailable, sandboxed, non-unix) degrades to "found nothing" —
// this is a best-effort cleanup pass, not a boot-critical path.
export function listRunningChimeradProcesses(): ChimeradProcess[] {
  let raw: string;
  try {
    raw = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const out: ChimeradProcess[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, ppidStr, command] = m;
    if (!/daemon[/\\]bin[/\\]chimerad\.js$/.test(command)) continue;
    let env: string;
    try { env = execFileSync("ps", ["eww", pidStr], { encoding: "utf8" }); } catch { continue; } // exited mid-scan
    const homeMatch = env.match(/(?:^|\s)CHIMERA_HOME=(\S+)/);
    const xpc = env.match(/(?:^|\s)XPC_SERVICE_NAME=(\S*)/);
    const managed = (!!xpc && xpc[1] !== "" && xpc[1] !== "0")
      || /(?:^|\s)(CHIMERA_LAUNCHD_LABEL|CHIMERA_SYSTEMD_UNIT)=/.test(env);
    out.push({ pid: Number(pidStr), ppid: Number(ppidStr), home: homeMatch ? homeMatch[1] : null, managed });
  }
  return out;
}

// AGENT-PROCESS-NOT-REAPED: an agent BACKEND process discovered by scanning the OS process
// table — the `claude` CLI subprocess a backends/claude.ts spawn() call started, as opposed to
// the in-memory AgentHandle the daemon holds for it (which a daemon restart, or a bug in the
// handle's own kill path, can lose track of while the OS process lives on). Distinct from
// ChimeradProcess above: that scans for OTHER chimerad DAEMON processes; this scans for AGENT
// backend processes, matched by the real vendored CLI binary path
// (claude-agent-sdk-<platform>/claude) — NOT a bare `claude` on $PATH, and not `bin/claude`,
// the grep pattern that previously and wrongly concluded agent processes weren't a leak at all.
export type AgentOsProcess = {
  pid: number;
  // Process group id. When it equals `pid`, this process is its own group leader (spawned with
  // detached:true — see backends/claude.ts's spawnClaudeCodeProcess) and it is safe to signal
  // the whole group (-pid), which is what actually reaches its MCP server children. When it
  // differs, this is a pre-fix or otherwise non-detached process sharing SOME other process's
  // group (quite possibly the daemon's own) — group-signalling it would be unsafe, so the sweep
  // falls back to a plain single-pid signal (best-effort; won't reach its MCP children).
  pgid: number | null;
  // CHIMERA_AGENT_ID read from the process's own environment (claude.ts always sets it — see
  // supervisor.ts's launch() stamping spec.env before spawn) — null when undetermined, same
  // never-reapable rule as ChimeradProcess.home above.
  agentId: string | null;
  home: string | null;
};

// Pure classifier — mirrors isReapableOrphanChimerad's shape and safety posture. A process is
// reapable ONLY when EVERY one of these holds:
//   - its owning agentId is known (can't verify identity otherwise — never touch)
//   - its CHIMERA_HOME matches THIS daemon's own home (never reap a process serving some other
//     chimera instance/home on the same box)
//   - EITHER it has no owning AgentRecord at all (owningState undefined — the daemon restarted,
//     or was pointed at a fresh event log, and simply has no memory of this agentId), OR its
//     owning record's state is terminal (done/failed/killed) — a "running"/"paused" record's
//     process is exactly the one thing this must never touch.
export function isReapableAgentProcess(
  proc: AgentOsProcess,
  owningState: AgentState | undefined,
  self: { home: string },
): boolean {
  if (proc.agentId === null) return false;
  if (proc.home === null || proc.home !== self.home) return false;
  if (owningState === undefined) return true;
  return owningState !== "running" && owningState !== "paused";
}

// Real process-table scan, same two-pass shape as listRunningChimeradProcesses (list, then
// `eww` for env only on already-matched candidates). `pgid` rides the same `-axo` dump as
// pid/command so no extra `ps` call is needed for it.
export function listRunningAgentProcesses(): AgentOsProcess[] {
  let raw: string;
  try {
    raw = execFileSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const out: AgentOsProcess[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, pgidStr, command] = m;
    if (!/claude-agent-sdk[^/\s]*[/\\]claude(\s|$)/.test(command)) continue;
    let env: string;
    try { env = execFileSync("ps", ["eww", pidStr], { encoding: "utf8" }); } catch { continue; } // exited mid-scan
    const agentIdMatch = env.match(/(?:^|\s)CHIMERA_AGENT_ID=(\S+)/);
    const homeMatch = env.match(/(?:^|\s)CHIMERA_HOME=(\S+)/);
    out.push({
      pid: Number(pidStr), pgid: Number(pgidStr),
      agentId: agentIdMatch ? agentIdMatch[1] : null,
      home: homeMatch ? homeMatch[1] : null,
    });
  }
  return out;
}

// R2 (self-healing supervision): periodic liveness probe over running agents — mirrors
// JobScheduler's shape (own file, injectable `now`, exposed `tick()` for deterministic tests, a
// single unref'd timer re-armed after each tick). A running, non-shadow agent that has produced
// no event for longer than `staleMs` is reported to the supervisor's crash-loop recovery path
// (reportUnresponsive) exactly as if it had crashed — one recovery primitive for crash, wedge,
// and failed-reattach alike.
export type HealthMonitorDeps = {
  supervisor: {
    list(): AgentRecord[];
    reportUnresponsive(agentId: string, idleMs: number, thresholdMs: number): void;
    // IDLE-REAP: OPTIONAL so every existing lightweight supervisor stub in the health tests keeps
    // compiling (and keeps its current behavior — no idleReapMs, no reaping). A real
    // AgentSupervisor always has it.
    parkIdle?(agentId: string, idleMs: number): Promise<void>;
    maintainRemoteControl?(agentId: string): Promise<void>;
    // PAUSED-CONDUCTOR: same OPTIONAL convention as parkIdle above — absent on the health tests'
    // lightweight stubs (which then reap as before). True ⇒ this agent still owns live
    // sub-agents and must not be parked out from under them.
    hasLiveDependants?(agentId: string): boolean;
  };
  // `append` is OPTIONAL (existing callers/tests that stub only `subscribe` are unaffected) —
  // see ZOMBIE-TURN-COMPLETE below: when present, a detected settle-never-happened wedge is
  // logged as a durable event too, not just to stderr.
  events: { subscribe(fn: (e: NormalizedEvent) => void): () => void; append?(e: { agentId: string; kind: NormalizedEvent["kind"]; data: Record<string, unknown> }): void };
  now?: () => number;
  // Generous default (15 min) — a coarse liveness signal (ANY event resets the clock) risks a
  // false positive on one legitimately very long single tool/gate call with no incremental
  // output; a shorter threshold is left as a follow-up (special-casing known-long-running tool
  // names, or a backend-emitted mid-turn heartbeat). Interactive conductors (spec `conductor:
  // true`) and persistent role workers (spec `persistent: true`) are idle-by-design BETWEEN
  // turns while awaiting input — they may sit "running" indefinitely with no open turn. For
  // them tick() exempts on a real turn-in-flight signal (`midTurn`): an idle-capable agent is
  // reported ONLY while a turn is actually open, because a genuine wedge can only happen
  // mid-turn. This deliberately does NOT key off the LAST event kind: any between-turn event —
  // a mailbox delivery, a usage snapshot, a post-crash-restart resume marker (all kind
  // "status") — arrives after `turn_complete` without opening a new turn, and a last-event
  // heuristic would silently drop the exemption on the next such event and misfire staleMs
  // later (LIVENESS-IDLE-CONDUCTOR: an idling conductor was crash-looped to a tripped circuit
  // breaker exactly this way). Ordinary (non-conductor, non-persistent) workers get no such
  // grace beyond the between-turns `turn_complete` exemption they always had.
  staleMs?: number;
  intervalMs?: number;   // default 60s
  // IDLE-REAP: how long an agent may sit idle BETWEEN TURNS before its process is released
  // (record + session kept; it resumes on the next message or on mail landing in its box).
  // 0/absent ⇒ disabled. Fed from config.idleReap by the Engine.
  idleReapMs?: number;
  // TERMINAL-RETENTION: forget finished agents older than this. Injected as a hook rather than
  // done here, because purging a record also has to drop its archived copy and its mailbox —
  // stores this monitor has no business knowing about (engine.ts owns them, and already does
  // exactly this for the manual sweep). Absent ⇒ nothing is ever forgotten, byte-identical to
  // before this existed.
  purgeExpiredTerminal?: (olderThanMs: number) => void;
  terminalRetentionMs?: number;
  // ZOMBIE-TURN-COMPLETE (2026-08-22 incident backstop): an ORDINARY (non-conductor,
  // non-persistent) worker's `turn_complete` used to be an UNCONDITIONAL, permanent exemption
  // here — "idle right after finishing a turn is fine" assumed settle()/handleWorkflowTurn
  // would act on it almost immediately. That assumption breaks exactly when the scheduler's
  // step-transition lock wedges (see scheduler.ts's GATE_EVAL_HARD_CEILING_MS doc comment for
  // the proven root cause): the agent sits at turn_complete with NOTHING further ever
  // happening, and the old exemption hid it from this probe forever. This grace window bounds
  // that exemption instead of removing it — set well above scheduler.ts's own
  // GATE_EVAL_HARD_CEILING_MS (15min) so no legitimately-slow gate is ever caught here; only an
  // agent that is GENUINELY stuck (the lock-wedge scenario, or an unknown future one like it)
  // survives past it. Default 20min.
  turnCompleteGraceMs?: number;
  // DAEMON-RUNS-FROM-DELETED-WORKTREE: absent ⇒ no check (existing callers, e.g. tests that
  // construct HealthMonitor directly, are unaffected). When set, this timer — already running
  // unconditionally — doubles as the cheap periodic existence probe for the daemon's own code
  // root, rather than standing up a second timer just for this.
  codeRoot?: string;
  existsSync?: (path: string) => boolean;
  // ORPHANED-DAEMON-LEAK: absent ⇒ no sweep (existing callers, e.g. tests that construct
  // HealthMonitor directly, are unaffected — mirrors codeRoot's own opt-in above). When set,
  // this timer — already running unconditionally — doubles as the periodic orphan-chimerad
  // reaper too, rather than standing up a second timer just for this.
  listChimeradProcesses?: () => ChimeradProcess[];
  killChimeradProcess?: (pid: number, signal: NodeJS.Signals) => void;
  selfPid?: number;
  selfHome?: string;
  // AGENT-PROCESS-NOT-REAPED: absent ⇒ no sweep (same opt-in shape as listChimeradProcesses
  // above — existing callers/tests unaffected). When set, this same timer also reconciles
  // AGENT backend processes (the `claude` CLI subprocess + its process group) against their
  // owning AgentRecord's state, terminating anything terminal or ownerless. Reuses selfHome
  // above (not a separate field) — the safety check is identical in shape to the chimerad
  // sweep's own home cross-check.
  listAgentProcesses?: () => AgentOsProcess[];
  killAgentProcess?: (pid: number, signal: NodeJS.Signals) => void;
  // DYNAMIC-CONCURRENCY-CAP: absent ⇒ no probe (same opt-in shape as listChimeradProcesses/
  // listAgentProcesses above — existing callers/tests unaffected). When both are set, this
  // same already-running timer also samples CPU/memory pressure once per tick (see
  // dynamic-cap.ts's own header for why this rides HealthMonitor's tick rather than a new
  // timer) and updates the tracker's EWMA/hysteresis state. `dynamicCapConfig` is read FRESH
  // every tick (mirrors engine.ts's own live-config-read closures, e.g. cloudMutationGate) so
  // a config.patch to caps.dynamicCap takes effect on the very next tick, no daemon restart.
  dynamicCap?: DynamicCapTracker;
  dynamicCapConfig?: () => DynamicCapConfig | undefined;
};


const DEFAULT_STALE_MS = 15 * 60_000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TURN_COMPLETE_GRACE_MS = 20 * 60_000;

export class HealthMonitor {
  private lastActivity = new Map<string, number>();
  // The agent's most recent event kind. Ordinary (non-conductor, non-persistent) workers key
  // their between-turns exemption off this literal `turn_complete` (unchanged, long-standing
  // behavior); it is also carried for idle-capable agents purely as the diagnostic reported in
  // tick() when one is flagged, so a future post-mortem can see what it was doing at the wedge.
  private lastEventKind = new Map<string, NormalizedEvent["kind"]>();
  // Whether a turn is actually in flight for an idle-capable (conductor/persistent) agent — the
  // ONLY signal that makes such an agent wedge-eligible (see the staleMs doc comment). Folded
  // from the event stream: opened by any TURN_OPENING_KINDS event, cleared by a turn close or a
  // fresh-session marker. Absent/false ⇒ idle-by-design ⇒ exempt. Not consulted for ordinary
  // workers.
  private midTurn = new Map<string, boolean>();
  private unsub: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // DAEMON-RUNS-FROM-DELETED-WORKTREE: edge-triggered so the warning fires once when the code
  // root vanishes, not every tick for the remaining life of the process.
  private codeRootMissingWarned = false;
  // AGENT-PROCESS-NOT-REAPED: pid -> agentId for every process this sweep already SIGTERM'd on
  // a prior tick. A pid seen here again next tick escalates straight to SIGKILL — but ONLY if
  // its live CHIMERA_AGENT_ID env still matches the value recorded here; a reused pid whose new
  // occupant carries a different (or no) agentId fails that match and is treated as first-seen
  // instead, which is the pid-reuse guard (identity is re-verified fresh every tick from the
  // OS, never assumed from a remembered pid alone).
  private termedAgentPids = new Map<number, string>();

  private remoteChecks = new Map<string, { at: number; pending: boolean }>();

  constructor(private readonly deps: HealthMonitorDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private staleMs(): number { return this.deps.staleMs ?? DEFAULT_STALE_MS; }
  // IDLE-REAP: 0/absent ⇒ disabled (every existing test/caller unaffected).
  private idleReapMs(): number { return this.deps.idleReapMs ?? 0; }
  private intervalMs(): number { return this.deps.intervalMs ?? DEFAULT_INTERVAL_MS; }
  private turnCompleteGraceMs(): number { return this.deps.turnCompleteGraceMs ?? DEFAULT_TURN_COMPLETE_GRACE_MS; }

  // Seeds lastActivity from "now", NOT record.createdAt — a just-reattached agent can carry a
  // createdAt from hours/days before this daemon boot, which would misfire as stale the instant
  // monitoring begins. Only currently-running, non-shadow agents are tracked (mirrors the same
  // filter tick() itself applies). Neither lastEventKind nor midTurn is seeded here: a reattached
  // conductor/persistent agent with no midTurn entry reads as "no turn open" in tick(), which is
  // exactly the correct exemption for an idle reattach (no new events to come — resumeOnly
  // reattach pushes no prompt). An ordinary (non-conductor, non-persistent) reattached worker
  // with no lastEventKind entry is stale-eligible exactly as before this exemption existed, gated
  // by the lastActivity-from-now grace window above.
  start(): void {
    const now = this.now();
    for (const a of this.deps.supervisor.list()) {
      if (a.state === "running" && !a.shadow) this.lastActivity.set(a.agentId, now);
    }
    this.unsub = this.deps.events.subscribe((e) => {
      this.lastActivity.set(e.agentId, this.now());
      this.lastEventKind.set(e.agentId, e.kind);
      // Fold the turn-in-flight signal for idle-capable agents. A fresh-session marker restores
      // the idle exemption: supervisor.spawn's registration (status/registered:true) and
      // resumePaused's post-crash-restart resume (status/resumed:true) both mean "new session,
      // no turn opened yet" — clearing midTurn here is what stops the crash-loop from
      // re-tripping every staleMs (LIVENESS-IDLE-CONDUCTOR self-reinforcing loop). Ordinary
      // between-turn status noise (mailbox delivery, undeliveredMessage) is neither open nor
      // close: it leaves midTurn untouched, so it can never spuriously drop the exemption.
      if (e.kind === "status" && (e.data["registered"] === true || e.data["resumed"] === true)) {
        this.midTurn.set(e.agentId, false);
      } else if (isTurnOpening(e.kind, e.data)) {
        this.midTurn.set(e.agentId, true);
      } else if (TURN_CLOSING_KINDS.has(e.kind)) {
        this.midTurn.set(e.agentId, false);
      }
    });
    this.arm();
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  // Exposed (mirrors QueueScheduler.tick()/JobScheduler.tick()) so tests can advance an injected
  // clock and drive a probe deterministically instead of waiting on the real interval.
  tick(): void {
    // DAEMON-RUNS-FROM-DELETED-WORKTREE: rides this already-running timer instead of a new one.
    if (this.deps.codeRoot && !this.codeRootMissingWarned) {
      const exists = (this.deps.existsSync ?? existsSync)(this.deps.codeRoot);
      if (!exists) {
        this.codeRootMissingWarned = true;
        console.error(`chimerad: WARNING — this process's code root (${this.deps.codeRoot}) no longer exists on disk. Continuing to run on already-loaded modules; any code path not yet loaded will fail unpredictably from here on. Restart from a live checkout.`);
      }
    }
    const staleMs = this.staleMs();
    const now = this.now();
    // TERMINAL-RETENTION: swept once per tick, before the per-agent walk — it operates on records
    // the walk below skips entirely (it only ever looks at "running"), so the two never contend.
    const retentionMs = this.deps.terminalRetentionMs ?? 0;
    if (retentionMs > 0) this.deps.purgeExpiredTerminal?.(retentionMs);
    const records = this.deps.supervisor.list();
    const remoteCandidate = (a: AgentRecord) => !a.shadow && a.remoteControlIntent?.enabled
      && (a.state === "running" || a.state === "paused" && (a.pauseReason === "idle-timeout" || a.pauseReason === "daemon-restart"));
    const remoteIds = new Set(records.filter(remoteCandidate).map(a => a.agentId));
    for (const id of this.remoteChecks.keys()) if (!remoteIds.has(id)) this.remoteChecks.delete(id);

    // IDLE-REAP-PARENT: an agent that live work still reports INTO is not idle, it is waiting.
    // Every non-settled child (spawned under it, dispatched by it, or told to deliverTo it) will
    // land mail in its box, and the parked→revive round trip that mail would trigger costs a
    // full session relaunch per child result — and until then any ask_agent aimed at it is a
    // hard failure from the child's side. Cheaper and correct to simply not park it while
    // dependents are alive; the moment the last one settles, the ordinary window applies.
    // Which records count is isLiveDependant — the SAME rule AgentSupervisor.hasLiveDependants
    // applies inside parkIdle, so the two layers cannot drift apart.
    const awaitedBy = new Set<string>();
    for (const r of records) {
      if (!isLiveDependant(r)) continue;
      if (r.parentId) awaitedBy.add(r.parentId);
      if (r.originConductorId) awaitedBy.add(r.originConductorId);
      if (r.spec.deliverTo) awaitedBy.add(r.spec.deliverTo);
    }
    for (const a of records) {
      if (a.shadow || a.state !== "running" && !remoteCandidate(a)) continue;
      if (remoteCandidate(a)) {
        let check = this.remoteChecks.get(a.agentId);
        if (!check) { check = { at: a.state === "paused" ? now - 60 * 60_000 : now, pending: false }; this.remoteChecks.set(a.agentId, check); }
        if (!check.pending && now - check.at >= 60 * 60_000) {
          check.at = now; check.pending = true;
          const owned = check;
          void Promise.resolve().then(() => this.deps.supervisor.maintainRemoteControl?.(a.agentId))
            .catch(() => {}).finally(() => { owned.pending = false; });
        }
        // A quiet remote session may be awaiting phone input. Do not reap or report it
        // as wedged; active turns still retain their normal error/liveness protection.
        if (a.state !== "running" || this.midTurn.get(a.agentId) !== true) continue;
      }
      const idleCapable = a.spec.conductor === true || a.spec.persistent === true;
      const last = this.lastActivity.get(a.agentId) ?? now;
      const idle = now - last;
      // IDLE-REAP: release the process of an agent that has done nothing for the configured
      // window. `midTurn` is the load-bearing guard and the reason this is safe: it is folded
      // from the event stream for EVERY agent (tool_call/tool_result are turn-OPENING kinds),
      // so an agent sitting quiet inside a long tool call reads as mid-turn and is never
      // reaped — only one that is genuinely parked between turns is. The record and its session
      // survive; the next message (or mail landing in its box) resumes it.
      const idleReapMs = this.idleReapMs();
      if (idleReapMs > 0 && idle > idleReapMs && this.midTurn.get(a.agentId) !== true) {
        // IDLE-REAP-PARENT / PAUSED-CONDUCTOR: an agent live work still reports INTO is waiting,
        // not idle — exempt it silently, and WITHOUT touching lastActivity, so the tick right
        // after its last dependent settles reaps it on its real idle age. The `continue` also
        // skips the wedge checks below on purpose: between turns with no dependants this agent
        // would have been parked here anyway, so "idle parent waiting on its workers" must not
        // become a settle-wedge alarm. hasLiveDependants is the supervisor's own (lineage-aware)
        // answer; awaitedBy is the same rule computed from the records this tick already holds.
        if (awaitedBy.has(a.agentId) || this.deps.supervisor.hasLiveDependants?.(a.agentId) === true) continue;
        this.lastActivity.set(a.agentId, now);   // don't re-flag while parkIdle settles asynchronously
        void this.deps.supervisor.parkIdle?.(a.agentId, idle).catch(() => {});
        continue;
      }
      if (idleCapable) {
        // A conductor/persistent worker is idle-by-design between turns — exempt it UNLESS a
        // turn is actually in flight. Only a genuine mid-turn wedge is reportable.
        if (this.midTurn.get(a.agentId) !== true) continue;
        if (idle <= staleMs) continue;
        // Bump lastActivity BEFORE reporting — reportUnresponsive's kill()+scheduleCrashRestart
        // moves the record to "paused" asynchronously; without this, every tick between now and
        // that settling would re-flag the same still-"running" record as freshly stale again.
        this.lastActivity.set(a.agentId, now);
        // Diagnostic (LIVENESS-IDLE-CONDUCTOR): an idle-capable agent should only reach here
        // mid-turn — surface what it was doing so a future false positive is traceable.
        console.warn(`chimerad: liveness probe flagging idle-capable agent ${a.agentId} as unresponsive after ${idle}ms mid-turn (last event: ${this.lastEventKind.get(a.agentId) ?? "none"})`);
        this.deps.supervisor.reportUnresponsive(a.agentId, idle, staleMs);
        continue;
      }
      const justFinishedTurn = this.lastEventKind.get(a.agentId) === "turn_complete";
      if (justFinishedTurn) {
        // ZOMBIE-TURN-COMPLETE: bounded exemption, not the old permanent one — see
        // turnCompleteGraceMs's doc comment. Past the grace window this is a settle-never-
        // happened backstop, deliberately conservative: unlike the branches above/below, this
        // does NOT call reportUnresponsive (which kills the agent process and force-restarts
        // its task). scheduler.ts's handleWorkflowTurn may still be legitimately mid-flight
        // (e.g. a slow step past the gate but before finally releases stepTransitioning) with
        // in-memory state a same-process kill+restart could race against and corrupt — a risk
        // this probe cannot rule out from the outside. A loud, correct alarm beats a silent-or-
        // wrong kill: this only ever reports, an operator (or a future agent) decides the fix.
        if (idle <= this.turnCompleteGraceMs()) continue;
        this.lastActivity.set(a.agentId, now);
        console.error(`chimerad: liveness probe — agent ${a.agentId} has been idle ${idle}ms since its last event (turn_complete) with no further activity; this task's step transition may be wedged (settle-never-happened). NOT auto-killing — investigate and settle manually.`);
        this.deps.events.append?.({
          agentId: a.agentId, kind: "status",
          data: { settleWedgeDetected: true, idleMs: idle, lastEventKind: "turn_complete" },
        });
        continue;
      }
      // Ordinary worker, anything else: stale past the threshold is a wedge.
      if (idle <= staleMs) continue;
      this.lastActivity.set(a.agentId, now);
      this.deps.supervisor.reportUnresponsive(a.agentId, idle, staleMs);
    }
    this.sweepOrphanChimerads();
    this.sweepTerminalAgentProcesses();
    this.sampleDynamicCap();
  }

  // DYNAMIC-CONCURRENCY-CAP: the resource probe. cfg is read fresh every tick so a live
  // config.patch to caps.dynamicCap applies without a daemon restart. Absent enabled config
  // (the default) still calls sample() — it no-ops cheaply (dynamic-cap.ts's own enabled
  // check) rather than being skipped here, so flipping enabled live doesn't need this loop
  // to notice the transition specially.
  private sampleDynamicCap(): void {
    if (!this.deps.dynamicCap || !this.deps.dynamicCapConfig) return;
    this.deps.dynamicCap.sample(this.deps.dynamicCapConfig());
  }

  // ORPHANED-DAEMON-LEAK: the operator's explicit ask — periodically reconcile chimerad
  // processes on the machine against live ownership and terminate anything with none. Distinct
  // from the AgentRecord loop above: that reconciles this daemon's OWN supervised agents
  // (claude/codex/kimi subprocesses) against their records; this reconciles OTHER chimerad
  // DAEMON processes (a different binary entirely) against isReapableOrphanChimerad's safety
  // rule. See that function's doc comment for exactly what can and cannot be killed — in short,
  // never this process, never a launchd/systemd-managed one, never one sharing this daemon's own
  // home, and only ever one already reparented to init (ppid 1, its real spawner long gone).
  private sweepOrphanChimerads(): void {
    if (!this.deps.listChimeradProcesses) return;
    const self = { pid: this.deps.selfPid ?? process.pid, home: this.deps.selfHome ?? "" };
    const kill = this.deps.killChimeradProcess ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    for (const proc of this.deps.listChimeradProcesses()) {
      if (!isReapableOrphanChimerad(proc, self)) continue;
      console.warn(`chimerad: orphan sweep reaping unmanaged orphaned chimerad pid ${proc.pid} (home=${proc.home}, ppid=${proc.ppid})`);
      try { kill(proc.pid, "SIGTERM"); }
      catch (err) { console.warn(`chimerad: orphan sweep failed to signal pid ${proc.pid}: ${(err as Error).message}`); }
    }
  }

  // AGENT-PROCESS-NOT-REAPED: the operator's explicit ask — "any agent NOT in running/idle or
  // running/busy must have its process closed, and there must be a system that regularly
  // verifies it." This is that system: it reconciles `claude` CLI subprocesses on the machine
  // against their owning AgentRecord's state (via isReapableAgentProcess's safety rule — never
  // this daemon, never a running/paused agent, never a foreign chimera home) and terminates
  // anything terminal or ownerless. Distinct from backends/claude.ts's own kill()/finally-block
  // termination: THAT is the primary, immediate mechanism, driven by the in-memory AgentHandle
  // the instant an agent goes terminal; THIS is the backstop for when that mechanism was bypassed
  // entirely — e.g. a daemon restart drops every in-memory handle while the OS processes from
  // the prior process generation live on with no handle left to ever kill them again.
  //
  // Escalates SIGTERM -> SIGKILL across ticks (termedAgentPids), not within one tick — this
  // reuses the already-running interval instead of a per-process timer, and doubles as the
  // pid-reuse guard: escalation only fires when the SAME pid is seen reapable again on a LATER
  // tick with the SAME live CHIMERA_AGENT_ID env re-read fresh from the OS, never from a cached
  // pid assumption.
  private sweepTerminalAgentProcesses(): void {
    if (!this.deps.listAgentProcesses) return;
    const home = this.deps.selfHome ?? "";
    const kill = this.deps.killAgentProcess ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    const states = new Map(this.deps.supervisor.list().map((r) => [r.agentId, r.state]));
    const stillTermed = new Map<number, string>();
    for (const proc of this.deps.listAgentProcesses()) {
      const owningState = proc.agentId !== null ? states.get(proc.agentId) : undefined;
      if (!isReapableAgentProcess(proc, owningState, { home })) continue;
      // Only a genuine process-group leader (pgid === pid — see backends/claude.ts's
      // spawnClaudeCodeProcess) is safe to negative-pid signal; anything else falls back to a
      // plain single-pid signal, which won't reach MCP children but never risks hitting some
      // OTHER process's group (quite possibly the daemon's own).
      const target = proc.pgid === proc.pid ? -proc.pid : proc.pid;
      const escalate = this.termedAgentPids.get(proc.pid) === proc.agentId;
      const signal: NodeJS.Signals = escalate ? "SIGKILL" : "SIGTERM";
      console.warn(`chimerad: terminal-agent sweep ${escalate ? "force-" : ""}reaping agent ${proc.agentId} process pid ${proc.pid} (owning state: ${owningState ?? "none"})`);
      try { kill(target, signal); }
      catch (err) { console.warn(`chimerad: terminal-agent sweep failed to signal pid ${proc.pid}: ${(err as Error).message}`); }
      if (proc.agentId !== null) stillTermed.set(proc.pid, proc.agentId);
    }
    this.termedAgentPids = stillTermed;
  }

  private arm(): void {
    const timer = setTimeout(() => { this.tick(); this.arm(); }, this.intervalMs());
    timer.unref?.();
    this.timer = timer;
  }
}
