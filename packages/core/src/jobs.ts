import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { redact } from "./credentials.js";
import {
  JobSpecSchema, JobRecordSchema, JOB_LAST_RUNS_CAP, JOB_FAILURE_REASONS_CAP, computeRetryDelayMs, cronFormatter,
  type JobSpec, type JobRecord, type JobSchedule, type JobRunEntry, type JobTarget,
  type JobDispatch, type JobTrigger, type JobInFlight, type RetryPolicy,
  type WakeScheduling,
} from "@chimera/protocol";
import { describeDispatch, evaluateTrigger, renderTriggerPrompt, type TriggerInput } from "./job-trigger.js";
import type { EventLog } from "./events.js";
import type { TeamManager } from "./teams.js";
import type { QueueStore } from "./queues.js";
import type { AgentSupervisor } from "./supervisor.js";
import type { QueueScheduler } from "./scheduler.js";
import { resolveRole, type RoleLibrary } from "./shared-roles.js";
import { spawnWatchProcess, type WatchHandle, type WatchSpawner } from "./job-watch.js";
import { MAX_TIMER_DELAY_MS } from "./timers.js";
import {
  NOOP_WAKE_SCHEDULER, WAKE_PROBE_TTL_MS, WAKE_RESCHEDULE_EPSILON_MS,
  type SleepHold, type WakeCapability, type WakeScheduler,
} from "./wake.js";

export { MAX_TIMER_DELAY_MS };

export function renderScheduledPrompt(job: Pick<JobSpec, "name" | "prompt" | "promptTemplate" | "target">, ts: number): string {
  const prompt = job.prompt ?? "";
  if (!job.promptTemplate) return prompt;
  const values: Record<string, string> = { job: job.name, ts: String(ts), iso: new Date(ts).toISOString(), agentId: "existingAgentId" in job.target ? job.target.existingAgentId : "" };
  return prompt.replace(/\{\{(job|ts|iso|agentId)\}\}/g, (match, key: string) => values[key] ?? match);
}

// F02: each hop is bounded so a clock jump is NOTICED within a minute instead of never — a timer
// armed for 30 days is ONE observation, and a machine that slept through it looks identical to one
// that did not. MAX_TIMER_DELAY_MS (timers.ts:6) stays the OUTER clamp: it is a Node correctness
// floor, this is an observability budget, and a test that injects a huge maxHopMs must still not
// overflow setTimeout.
export const MAX_HOP_MS = 60_000;
// Well above any plausible in-process stall (a long GC pause, a debugger breakpoint, heavy swap)
// AND above MAX_HOP_MS itself, so a frozen/very slow clock cannot read as a backward jump — which
// is exactly what the fixed injected clock in this repo's job tests looks like.
export const CLOCK_JUMP_THRESHOLD_MS = 120_000;
// lastTickMs is only ever READ at boot, so it does not need per-tick durability. Flushed at most
// this often (plus on every save() the fire path already does, plus detach()). Do NOT "simplify"
// this to a per-tick save(): save() rewrites jobs.json in full, including up to 20 command runs of
// 8 000 chars of output per job.
export const LAST_TICK_PERSIST_MS = 900_000;
// Bounds the re-arm walk: an `every: {seconds:1}` schedule across a 9h suspend would otherwise
// step 32 400 occurrences. On cap-out advanceOccurrence falls back to a from-now occurrence.
export const MAX_OCCURRENCE_SKIPS = 10_000;
// F01(c): defined BY REFERENCE to F02's threshold, not as its own literal. A run labelled
// "sleep-wake" and the clock_jump event that explains the same gap must never disagree; if
// someone tunes one, both move. 120s (not the catalog's proposed 60s) because a laptop under
// heavy swap can stall past 60s and would then report a suspend that never happened.
export const LATE_FIRE_THRESHOLD_MS = CLOCK_JUMP_THRESHOLD_MS;
// F01(a): only the fallback for deps.wakeLeadMs — engine.ts always supplies config.wake.leadMs,
// whose default is this same value. Enough for a suspended Mac to finish resuming and for the
// daemon's own timer to re-arm before the job is actually due.
export const DEFAULT_WAKE_LEAD_MS = 120_000;
// F05: absent job.retryPolicy ⇒ exactly today's rule (settleRun/fire's failure path) — three
// consecutive failed runs stop the job, with NO delayed re-fire armed. Only the terminal state's
// SHAPE changes, so an existing jobs.json keeps its timing behaviour verbatim.
export const DEFAULT_JOB_MAX_ATTEMPTS = 3;
// A reason is operator-facing, not a log. jobs.json is rewritten in full on every save() and read
// back on every boot; five untruncated stack tails would be the same mistake COMMAND_OUTPUT_MAX
// already exists to prevent.
export const JOB_FAILURE_REASON_MAX = 500;
// F05.QA-FIX2: a retry's fire() can be REFUSED (overlap/duplicate-occurrence) instead of run.
// tick() has already cleared failure.retryAt by the time it learns that, so a refusal needs its
// own short fixed re-check rather than the exponential computeRetryDelayMs — the attempt never
// happened, so it is not a new failure and must not consume backoff. One MAX_HOP_MS tick is
// enough: the timer already wakes that often for grid due-checks, so this rides the same hop.
export const RETRY_REFUSED_REARM_MS = MAX_HOP_MS;

export class JobError extends Error { code = "protocol" as const; name = "JobError"; }
export class UnknownJobError extends Error { code = "protocol" as const; name = "UnknownJobError"; }
export class DuplicateJobError extends Error { code = "protocol" as const; name = "DuplicateJobError"; }
export class JobNotDeadLetteredError extends Error { code = "protocol" as const; name = "JobNotDeadLetteredError"; }

// ---------- cron parsing + next-run computation (minute resolution, tz-aware) ----------

type CronField = "*" | Set<number>;
export type ParsedCron = {
  minute: CronField; hour: CronField; dom: CronField; month: CronField; dow: CronField;
  domRestricted: boolean; dowRestricted: boolean;
};

function parseCronField(expr: string, min: number, max: number, label: string): CronField {
  if (expr === "*") return "*";
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new JobError(`invalid cron ${label} field "${part}"`);
    const [, rangeStr, stepStr] = m;
    const step = stepStr ? Number(stepStr) : 1;
    if (step <= 0) throw new JobError(`invalid cron ${label} step "${part}"`);
    let lo: number, hi: number;
    if (rangeStr === "*") { lo = min; hi = max; }
    else if (rangeStr!.includes("-")) {
      const [a, b] = rangeStr!.split("-").map(Number);
      lo = a!; hi = b!;
    } else { lo = hi = Number(rangeStr); }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi)
      throw new JobError(`cron ${label} field "${part}" out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new JobError(`cron ${label} field parsed empty`);
  return out;
}

// Standard 5-field cron (minute hour day-of-month month day-of-week). Parsed AT
// job.create/update TIME (see validateSchedule) — a malformed expression is rejected
// inline and never persisted.
export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new JobError(`cron expression must have 5 fields (minute hour dom month dow), got "${expr}"`);
  const [mi, hr, dom, mon, dow] = parts;
  return {
    minute: parseCronField(mi!, 0, 59, "minute"),
    hour: parseCronField(hr!, 0, 23, "hour"),
    dom: parseCronField(dom!, 1, 31, "day-of-month"),
    month: parseCronField(mon!, 1, 12, "month"),
    dow: parseCronField(dow!, 0, 6, "day-of-week"),
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

function fieldHas(f: CronField, v: number): boolean { return f === "*" || f.has(v); }

// The tz's UTC offset (minutes, tz-time minus utc-time) AT instant `ms`, via Intl —
// no timezone-database dependency needed.
function tzOffsetMinutes(ms: number, tz: string): number {
  const dtf = cronFormatter(tz);
  const parts = dtf.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (asUtc - ms) / 60_000;
}

// Wall-clock (y, mon 1-12, d, h, mi) IN `tz` -> epoch ms. Overflowing fields (day 32,
// hour 24, month 13, ...) are accepted and normalized by Date.UTC's own carry
// semantics — computeNextCron relies on this to walk "next day"/"next month" without
// hand-rolled calendar math. Two-pass offset refinement (good enough across a DST edge).
function wallToUtc(y: number, mon: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mon - 1, d, h, mi, 0);
  const offset1 = tzOffsetMinutes(guess, tz);
  const refined = guess - offset1 * 60_000;
  const offset2 = tzOffsetMinutes(refined, tz);
  return guess - offset2 * 60_000;
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };
function zonedParts(ms: number, tz: string): ZonedParts {
  const dtf = cronFormatter(tz);
  const parts = dtf.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const year = get("year"), month = get("month"), day = get("day"), hour = get("hour"), minute = get("minute");
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();   // calendar weekday from the wall-clock date
  return { year, month, day, hour, minute, weekday };
}

// POSIX cron semantics: when BOTH dom and dow are restricted, a day matches if EITHER
// matches (OR, not AND); when only one is restricted, only that one gates.
function domDowMatch(f: ParsedCron, p: ZonedParts): boolean {
  if (!f.domRestricted && !f.dowRestricted) return true;
  if (f.domRestricted && f.dowRestricted) return fieldHas(f.dom, p.day) || fieldHas(f.dow, p.weekday);
  if (f.domRestricted) return fieldHas(f.dom, p.day);
  return fieldHas(f.dow, p.weekday);
}

// ~a multi-year search horizon; a cap-out rejects a structurally-unsatisfiable
// expression (e.g. day 31 in a month set that's Feb-only) instead of looping forever.
const MAX_CRON_ITERS = 6000;

const MAX_DAYS_BY_MONTH: Record<number, number> = {
  1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31,
};

// Analytical short-circuit for the one shape where the day-of-month walk in computeNextCron's
// loop is unsatisfiable for every candidate, not just slow to find one: dom-restricted with no
// dow relief (domDowMatch reduces to plain fieldHas(dom, day)), and no value in the dom set fits
// within any month the month field allows (e.g. day 30 in a Feb-only month set). Without this,
// that case walks the full MAX_CRON_ITERS — each iteration Intl-heavy — before returning null.
function domCanEverOccur(cron: ParsedCron): boolean {
  if (!cron.domRestricted || cron.dowRestricted || cron.dom === "*") return true;
  const dom = cron.dom;
  const months = cron.month === "*" ? Object.keys(MAX_DAYS_BY_MONTH).map(Number) : Array.from(cron.month);
  for (const m of months) {
    const maxDay = MAX_DAYS_BY_MONTH[m]!;
    for (const d of dom) if (d <= maxDay) return true;
  }
  return false;
}

// Next fire strictly AFTER `fromMs`, at minute resolution, in `tz`. Returns null when no
// occurrence is found inside MAX_CRON_ITERS's horizon (the expression can never fire).
export function computeNextCron(cron: ParsedCron, tz: string, fromMs: number): number | null {
  if (!domCanEverOccur(cron)) return null;
  let candidate = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < MAX_CRON_ITERS; i++) {
    const p = zonedParts(candidate, tz);
    if (!fieldHas(cron.month, p.month)) { candidate = wallToUtc(p.year, p.month + 1, 1, 0, 0, tz); continue; }
    if (!domDowMatch(cron, p)) { candidate = wallToUtc(p.year, p.month, p.day + 1, 0, 0, tz); continue; }
    if (!fieldHas(cron.hour, p.hour)) { candidate = wallToUtc(p.year, p.month, p.day, p.hour + 1, 0, tz); continue; }
    if (!fieldHas(cron.minute, p.minute)) { candidate = wallToUtc(p.year, p.month, p.day, p.hour, p.minute + 1, tz); continue; }
    return candidate;
  }
  return null;
}

const EVERY_UNIT_MS: Record<"seconds" | "minutes" | "hours" | "days", number> = {
  seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000,
};

// Dispatches on the schedule's exactly-one-of {cron|every|at|watch} shape. Returns null when the
// schedule can never fire again (an unsatisfiable cron, a one-shot `at` already in the past
// relative to `fromMs`) — and, for `watch`, because there is no next time at all.
export function computeNextRunTs(schedule: JobSchedule, tz: string, fromMs: number): number | null {
  if ("cron" in schedule) return computeNextCron(parseCron(schedule.cron), tz, fromMs);
  if ("every" in schedule) { const { unit, n } = schedule.every; return fromMs + n * EVERY_UNIT_MS[unit]; }
  // JOB-WATCH: supervised, not scheduled. `null` here is what keeps it out of the timer entirely —
  // the watcher's lifecycle is start/restart/stop, and "when does it next run" is the wrong
  // question to ask about a process that is supposed to be running the whole time.
  if ("watch" in schedule) return null;
  return schedule.at > fromMs ? schedule.at : null;
}

/** The next occurrence strictly after `nowMs` on the grid ANCHORED AT `nominalMs` — the fix for a
 *  suspend sliding an `every` schedule's phase (`computeNextRunTs(..., now)` re-phases it to the
 *  wake instant, so an hourly job served at 09:13 re-arms to 10:13 instead of 10:00). `missed`
 *  counts the occurrences STRICTLY BETWEEN the anchor and `nowMs` that were stepped over — the
 *  anchor slot itself is the one just served/skipped and is not counted. F02 does not act on
 *  `missed`; it is F01(c)'s coalescing input and F04's staleness input. */
export function advanceOccurrence(
  schedule: JobSchedule, tz: string, nominalMs: number, nowMs: number,
): { next: number | null; missed: number } {
  let next = computeNextRunTs(schedule, tz, nominalMs);
  let missed = 0;
  for (let i = 0; i < MAX_OCCURRENCE_SKIPS && next !== null && next <= nowMs; i++) {
    const step = computeNextRunTs(schedule, tz, next);
    if (step === null || step <= next) break;   // unsatisfiable / non-advancing: stop rather than spin
    missed++;
    next = step;
  }
  // Any exit still in the past (cap-out, or a grid too fine to walk) must NOT be armed: tick()
  // re-fires everything with nextRunTs <= now, so an in-the-past re-arm is a fire storm.
  if (next !== null && next <= nowMs) next = computeNextRunTs(schedule, tz, nowMs);
  return { next, missed };
}

/** F04: the most recent occurrence at or before `nowMs`, walking the grid forward from a missed
 *  anchor. Catch-up serves ONE occurrence, and this is the one worth serving — yesterday's report
 *  is superseded by today's. Returns the anchor itself for a one-shot `at` (or any grid that
 *  cannot advance), which is then judged on its own age like any other slot.
 *
 *  F04.QA-C: null means "slots elapsed, but the newest one cannot be named" — the walk hit
 *  MAX_OCCURRENCE_SKIPS, reachable by an every-minute job after ~7 days down. The two cheaper
 *  exits are both WRONG, for reasons that mirror advanceOccurrence's fire-storm guard:
 *    - returning the stale anchor hands back the OLDEST missed slot, which ages with the OUTAGE.
 *      Judging it makes catchUpMaxStalenessMs a bound on downtime again — the exact thing the
 *      design rejected (see reconcileBoot) — so a minutely job down 8 days is refused as stale
 *      when its true newest slot is under a minute old.
 *    - re-deriving from now (advanceOccurrence's own escape) is the fire-storm hazard inverted:
 *      computeNextRunTs(now) is strictly AFTER now, so catching up on it consumes the occurrence
 *      key of a real FUTURE slot, and the grid's own fire minutes later is refused as a
 *      duplicate — a lost occurrence instead of a repeated one.
 *  So the caller is told the truth and falls back; see reconcileBoot. */
export function latestOccurrenceAtOrBefore(
  schedule: JobSchedule, tz: string, anchorMs: number, nowMs: number,
): number | null {
  let last = anchorMs;
  for (let i = 0; i < MAX_OCCURRENCE_SKIPS; i++) {
    const step = computeNextRunTs(schedule, tz, last);
    if (step === null || step <= last || step > nowMs) return last;
    last = step;
  }
  return null;
}

/** JOB-WATCH: is this job supervised rather than scheduled? */
export function isWatchJob(job: { schedule: JobSchedule; target: unknown }): boolean {
  return "watch" in job.schedule;
}

// Eagerly validates a schedule (throws JobError on a bad cron / a past `at` / an
// expression that structurally can never fire) — called at job.create/update time so a
// broken schedule is rejected inline and never persisted.
export function validateSchedule(schedule: JobSchedule, tz: string, fromMs: number): number | null {
  const next = computeNextRunTs(schedule, tz, fromMs);
  // JOB-WATCH: null is CORRECT here, not a rejection — a supervised process has no next run. This
  // is the one schedule for which "cannot compute a next time" means "working as intended".
  if ("watch" in schedule) return null;
  if (next === null) {
    if ("at" in schedule) throw new JobError(`schedule.at (${new Date(schedule.at).toISOString()}) is not in the future`);
    throw new JobError("cron schedule can never fire (checked a multi-year horizon)");
  }
  return next;
}

/** F04: the occurrence key. Deterministic and built-in, never operator-supplied — the point is
 *  that two paths serving the same grid slot compute the SAME string without talking to each
 *  other. Deliberately its own namespace, distinct from scheduler.ts's step key
 *  (`${taskId}:step-${stepIndex}`): a job occurrence and a workflow step are not interchangeable.
 *  F04.QA-B: `attempt` is the third component and is ALWAYS suffixed, even at 0 — a key whose
 *  shape depends on its value is a key two paths can disagree about. Attempt N+1 of one slot is a
 *  distinct key (so F05's backoff re-fire is admitted) while the catch-up/wake/manual three-way
 *  race still collapses to one, because all three legs compute the same attempt for the slot. */
export function jobOccurrenceKey(name: string, nominalFireTs: number, attempt = 0): string {
  return `job:${name}:${nominalFireTs}#${attempt}`;
}

/** F04.QA-B: already claimed (in flight) or already served (in history)? The dedupe horizon is
 *  JOB_LAST_RUNS_CAP entries, not forever — bounded on purpose, since jobs.json is not a ledger.
 *  Pure and exported so the (slot, attempt) matrix is testable without driving the whole scheduler.
 *
 *  History compares `>=`, not `===`: attempt numbers come from job-wide `consecutiveFailures`
 *  [F05], so they can skip values, and a stale attempt-0 leg arriving after attempts 1..N already
 *  ran must still be refused even once the attempt-0 row has aged out of the 20-entry ring.
 *  `inFlight` compares the SLOT ALONE at any attempt: a run in flight means the slot is being
 *  worked right now, and letting a higher attempt fall through to the overlap guard would park it
 *  as a slot-less pendingRerun — a retry silently downgraded to an untracked rerun. */
export function occurrenceServed(job: Pick<JobRecord, "inFlight" | "lastRuns">, nominalFireTs: number, attempt: number): boolean {
  if (job.inFlight?.nominalFireTs === nominalFireTs) return true;
  return job.lastRuns.some((r) => r.nominalFireTs === nominalFireTs && r.attempt >= attempt);
}

/** F05.QA-FIX: the pending retry instant of a LIVE chain, or null. A dead-lettered chain keeps its
 *  reasons and nominalRunTs for the UI but is finished, so it must never arm anything — reading
 *  `failure.retryAt` raw anywhere would resurrect it. This is the only accessor the scheduler uses. */
export function retryArmedAt(job: Pick<JobRecord, "failure">): number | null {
  const f = job.failure;
  if (!f || f.deadLetterAt !== null) return null;
  return f.retryAt;
}

/** Guards the `null` arm so the two clocks in tick() read identically. */
function dueAt(ts: number | null, now: number): boolean { return ts !== null && ts <= now; }

export type CatchUpDecision =
  | { fire: true }
  | { fire: false; reason: "missed-restart" }
  | { fire: false; reason: "stale-beyond-window"; lateMs: number; maxStalenessMs: number };

/** F04: whether a missed occurrence is still worth firing at boot. Staleness is measured on the
 *  OCCURRENCE (now - nominalTs), not on daemon downtime: "6h" means "a report more than six hours
 *  late is noise", which is a fact about the slot, not about why we were down. */
export function decideCatchUp(
  job: Pick<JobRecord, "catchUp" | "catchUpMaxStalenessMs">, nominalTs: number, now: number,
): CatchUpDecision {
  if (!job.catchUp) return { fire: false, reason: "missed-restart" };
  const max = job.catchUpMaxStalenessMs;
  if (max === null) return { fire: true };   // unset — pre-F04 behaviour: catch up however late
  const lateMs = now - nominalTs;
  return lateMs > max
    ? { fire: false, reason: "stale-beyond-window", lateMs, maxStalenessMs: max }
    : { fire: true };
}

// ---------- JobScheduler ----------

export type JobSchedulerDeps = {
  home: string; teams: TeamManager; queues: QueueStore; supervisor: AgentSupervisor;
  scheduler: QueueScheduler; events: EventLog;
  // JOB-ROLE-TARGET GAP B: the same global role library scheduler.ts/engine.ts resolve
  // team/session roles against — narrowed to RoleLibrary (not the concrete RoleStore) so
  // this stays trivially testable, mirroring shared-roles.ts's own seam.
  roles: RoleLibrary;
  now?: () => number;   // injectable clock (mirrors CooldownTracker/AgentSupervisor's own seam) — tests drive `tick()` off it
  // F05: computeRetryDelayMs's `rand` seam. Injected for the SAME reason `now` is — a jitter test
  // must assert an exact armed delay, not a range. Production omits it (defaults to Math.random),
  // so engine.ts's construction needs no change.
  rand?: () => number;
  // JOB-COMMAND-TARGET: runs a shell command to completion. Injected (not imported) for the same
  // reason `now` is — it is the one genuinely side-effecting, slow, environment-dependent thing
  // this scheduler does, and a test must be able to drive a job's whole lifecycle without
  // spawning a real process. Defaults to the real implementation below.
  runCommand?: CommandRunner;
  // JOB-WATCH: the long-running-process seam, mirroring runCommand's role for the scheduled path —
  // a test drives a watcher's whole lifecycle (lines, exit, restart) with no real process.
  spawnWatch?: WatchSpawner;
  // F02: the hop bound and the divergence threshold, injected for the SAME reason `now` is — a
  // test must be able to prove clock-jump detection without sleeping through a real hop.
  maxHopMs?: number;
  clockJumpThresholdMs?: number;
  // F01(c): how late a scheduled fire must be to be reported as trigger "sleep-wake". Injectable
  // for the same reason `now` is — a test must be able to prove a 9h suspend in 0ms.
  lateFireThresholdMs?: number;
  // F01(b)/(a): the OS power seam — the sleep assertion and the RTC wake wrapper behind one
  // injectable interface, for the same
  // reason runCommand is injected: it is slow, privileged and environment-dependent, and every
  // branch must be provable with no real process. ABSENT means the no-op scheduler, i.e. today's
  // behaviour exactly — which is also how engine.ts expresses "the operator turned this off".
  wake?: WakeScheduler;
  wakeLeadMs?: number;   // F01(a) — how far before nextRunTs to ask the OS to wake
};

/** The result of a scheduled shell run. `exitCode: null` means the command never produced one —
 * it was killed on timeout, or the shell could not start it — and `error` says which. */
export type CommandRunResult = { exitCode: number | null; output: string; error?: string };
export type CommandRunner = (target: { command: string; cwd?: string; env?: Record<string, string>; timeoutMs: number }) => Promise<CommandRunResult>;

// JOB-COMMAND-TARGET: bounded on purpose. A scheduled command that prints megabytes (a verbose
// build, a `find /`) would otherwise put all of it into jobs.json, which is rewritten in full on
// every save and read back on every boot. The TAIL is kept rather than the head: when a command
// fails, what it said last is what says why.
const COMMAND_OUTPUT_MAX = 8_000;

export function tailOutput(text: string, max = COMMAND_OUTPUT_MAX): string {
  return text.length <= max ? text : `… [${text.length - max} earlier chars dropped]\n${text.slice(-max)}`;
}

export const runShellCommand: CommandRunner = async (target) => {
  const { spawn } = await import("node:child_process");
  return await new Promise<CommandRunResult>((resolve) => {
    // A LOGIN shell: a scheduled command is written the way an operator would type it, and the
    // tools those commands reach for (aws, gcloud, kubectl, nvm-managed node) live on a PATH the
    // daemon's own non-interactive environment usually does not have.
    const child = spawn(target.command, {
      shell: process.env["SHELL"] ?? "/bin/sh",
      cwd: target.cwd ?? homedir(),
      env: { ...process.env, ...(target.env ?? {}) },
      // Its own process group, so a timeout kills the whole tree rather than just the shell and
      // leaving its children orphaned and running.
      detached: true,
    });
    let out = "";
    const take = (chunk: Buffer): void => { out += chunk.toString(); if (out.length > COMMAND_OUTPUT_MAX * 4) out = out.slice(-COMMAND_OUTPUT_MAX * 2); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, target.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: tailOutput(out), error: `could not start command: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ exitCode: null, output: tailOutput(out), error: `timed out after ${target.timeoutMs}ms` });
      resolve({
        exitCode: code,
        output: tailOutput(out),
        ...(code === 0 ? {} : { error: `exited ${code}` }),
      });
    });
  });
};

type InFlight =
  | { kind: "message"; agentId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "task"; taskId: string }
  | { kind: "command" }
  // F04: the state between the durable claim and the target reporting its id. Nothing ever settles
  // a "starting" run — it exists so the occurrence is occupied for the whole spawn round trip,
  // which is precisely the window qa/F01 §3 recorded as re-servable by a second path.
  | { kind: "starting" };

/** F04: what fire() did. Only runNow reads it — every other call site is `void this.fire(...)`. */
type FireOutcome = "started" | "overlap" | "duplicate-occurrence" | "start-failed";
// F01(c): derived from the protocol enum rather than re-listed, so adding a trigger member is one
// edit and not two that can drift apart.
type Trigger = JobRunEntry["trigger"];

export class JobScheduler {
  private jobs = new Map<string, JobRecord>();
  private file: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // one in-flight run tracked per job name — the overlap-detection state.
  private inFlight = new Map<string, InFlight>();
  // "queue" overlap policy: at most one parked re-run per job, drained when the current run settles.
  private pendingRerun = new Set<string>();
  private lastTrigger = new Map<string, Trigger>();
  private unsub: (() => void) | null = null;
  private lastTickMs: number | null = null;        // persisted in jobs.json; last time a tick ran
  private persistedTickMs: number | null = null;   // what is actually on disk, for the flush bound
  private armedAtMs: number | null = null;         // when armTimer last armed, and for how long —
  private armedHopMs: number | null = null;        //   the expectation a tick is measured against
  // F02 SEAM (F01/F04 build on this): job -> the grid slot the in-flight run serves. F01 computes
  // latenessMs from it, F04 keys {jobId, nominalFireTs} on it. There is no JobRecord.nominalRunTs.
  private lastNominal = new Map<string, number>();
  // F01(c): what settleRun needs that only fire() knows — lateness is measured at FIRE time, but
  // the JobRunEntry is written at SETTLE time, which for an agent target is minutes later. Keyed
  // and cleared exactly like lastNominal / lastTrigger.
  private lastLateness = new Map<string, { latenessMs: number; coalescedOccurrences: number }>();
  // F01(b): the single outstanding sleep assertion. Its source of truth is inFlight.size, never a
  // refcount — a refcount that leaks by one pins the operator's Mac awake until the daemon
  // restarts, and inFlight is already the authoritative "is a job-spawned run happening" set.
  private sleepHold: SleepHold | null = null;
  // F01(a): the epoch ms of the one outstanding chimera-owned OS wake event. Persisted in
  // jobs.json (a sibling key of `jobs`/`lastTickMs`, not a JobRecord field) because cancelling
  // needs an EXACT-MATCH timestamp and a restarted daemon must still be able to cancel — or
  // supersede — what the previous process scheduled.
  private wakeScheduledFor: number | null = null;
  // F01(a): true for exactly the first maybeScheduleWake after a boot that READ a timestamp off
  // disk. detach() cancels the outstanding wake but deliberately leaves the timestamp persisted
  // (it cannot await), so what the next boot reads is a claim, not a fact — and the debounce below
  // would otherwise honour that claim and never schedule anything again. The first pass therefore
  // skips the debounce and re-cancels before scheduling fresh.
  private wakeNeedsResync = false;
  // F01(a): armTimer fires this and never awaits it, so two hops could otherwise overlap and leave
  // two outstanding OS events with only one of them cancellable.
  private wakeBusy = false;
  // Set when a release is asked for while a wrapper round trip is already in flight: cancelling
  // the timestamp we can see would miss the one that round trip is about to persist.
  private wakeReleasePending = false;
  // F01(a): the target a schedule attempt last FAILED on. Debounced exactly like a successful one:
  // armTimer runs once per bounded hop, so without this a wrapper that is installed (probe says
  // available) but refuses a schedule would retry and emit job_wake_failed every minute, forever —
  // the same event spam the unavailable branch returns silently to avoid. A target that MOVES
  // still retries, which is what makes this a debounce rather than a permanent giving-up.
  private wakeFailedFor: number | null = null;
  private wakeProbe: { at: number; cap: WakeCapability } | null = null;
  // F01-QA-follow-up: last capability.available this scheduler OBSERVED and told an operator
  // about via an event — null until the first probe. A TUI-only operator (no job selected, so
  // job.status's per-job wakeScheduling never reaches them) would otherwise have no signal that
  // the machine can't keep a schedule. null->false and any later flip emit once; null->true and
  // an unchanged value stay silent, matching wakeStatus()'s own "state read when asked" doctrine
  // for the overwhelmingly common machine that never opted in.
  private wakeLastAvailable: boolean | null = null;

  constructor(private deps: JobSchedulerDeps) {
    mkdirSync(deps.home, { recursive: true });
    this.file = join(deps.home, "jobs.json");
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as { jobs: unknown[]; lastTickMs?: unknown; wakeScheduledFor?: unknown };
        for (const j of raw.jobs) { const r = JobRecordSchema.parse(j); this.jobs.set(r.name, r); }
        // Sibling key of `jobs`, not a JobRecord field and not a second file. A pre-F02 jobs.json
        // has no such key and reads as null, which every consumer already handles.
        this.lastTickMs = typeof raw.lastTickMs === "number" ? raw.lastTickMs : null;
        this.persistedTickMs = this.lastTickMs;
        this.wakeScheduledFor = typeof raw.wakeScheduledFor === "number" ? raw.wakeScheduledFor : null;
        this.wakeNeedsResync = this.wakeScheduledFor !== null;
      } catch (err) {
        // defined corrupt-file behavior: fail fast, name the file, say how to recover
        throw new Error(`corrupt coordination state in ${this.file}: ${(err as Error).message} — fix or remove the file and restart chimerad`);
      }
    }
    this.attach();
    this.reconcileBoot();
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private save(): void {
    const tmp = `${this.file}.tmp`;   // write-to-temp-then-rename: no torn writes on power loss
    writeFileSync(tmp, JSON.stringify({ jobs: [...this.jobs.values()], lastTickMs: this.lastTickMs, wakeScheduledFor: this.wakeScheduledFor }, null, 2));
    renameSync(tmp, this.file);
    this.persistedTickMs = this.lastTickMs;
  }

  private attach(): void {
    this.unsub = this.deps.events.subscribe((e) => {
      if (e.kind === "status" && e.data["state"] === "killed") {
        let changed = false;
        for (const job of this.jobs.values()) {
          if (job.enabled && "existingAgentId" in job.target && job.target.existingAgentId === e.agentId) {
            this.disable(job, `pinned agent ${e.agentId} was killed`);
            changed = true;
          }
        }
        if (changed) { this.save(); this.armTimer(); }
      }
      for (const [name, run] of this.inFlight) {
        if (run.kind === "agent" && run.agentId === e.agentId) {
          void this.checkAgentSettle(name, run.agentId).catch(() => {});
        } else if (run.kind === "task" && e.kind === "status" && e.agentId === `task:${run.taskId}`) {
          const state = e.data["state"];
          if (state === "done" || state === "failed") {
            const agentId = typeof e.data["agentId"] === "string" ? e.data["agentId"] as string : null;
            const costUsd = agentId ? this.safeCost(agentId) : 0;
            void this.settleRun(name, state === "done", state === "failed" ? "task failed" : undefined, costUsd).catch(() => {});
          }
        }
      }
    });
  }

  /** The ONE place a run entry is appended and JOB_LAST_RUNS_CAP applied. Defaults spell out the
   *  "not measured" columns so each call site states only what it actually knows. */
  private appendRun(job: JobRecord, entry: Partial<JobRunEntry> & Pick<JobRunEntry, "ts" | "trigger" | "result">): void {
    job.lastRuns = [...job.lastRuns, {
      agentId: null, taskId: null, costUsd: 0, error: null, exitCode: null, output: null,
      latenessMs: null, coalescedOccurrences: null, reason: null, nominalFireTs: null, attempt: 0,
      ...entry,
    }].slice(-JOB_LAST_RUNS_CAP);
  }

  /** F04: the in-memory run map and the DURABLE claim move together. A marker that disagrees with
   *  `inFlight` is exactly the state recoverInFlight cannot reason about at the next boot, so the
   *  claim is rebuilt from the caller's own locals rather than read back off the record. */
  private markInFlight(job: JobRecord, claim: JobInFlight, run: InFlight): void {
    this.inFlight.set(job.name, run);
    job.inFlight = {
      ...claim, kind: run.kind,
      agentId: run.kind === "agent" || run.kind === "message" ? run.agentId : null,
      taskId: run.kind === "task" ? run.taskId : null,
    };
    this.save();
  }

  /** F04: the slot a fire serves, for keying. A manual run is assigned a slot ONLY while the job
   *  is still due for it — an out-of-band `job_run` gets null and is never deduped, so "run it
   *  now" is never refused because a scheduled run already served today. */
  private nominalFireTsFor(job: JobRecord, trigger: Trigger, nominalTs: number | null, now: number): number | null {
    if (nominalTs !== null) return nominalTs;
    if (trigger === "manual" && job.nextRunTs !== null && job.nextRunTs <= now) return job.nextRunTs;
    return null;
  }

  private safeCost(agentId: string): number {
    try { return this.deps.supervisor.status(agentId).costUsd; } catch { return 0; }
  }

  private async checkAgentSettle(name: string, agentId: string): Promise<void> {
    let rec;
    try { rec = this.deps.supervisor.status(agentId); } catch { return; }
    if (rec.state === "running" || rec.state === "paused") return;
    await this.settleRun(name, rec.state === "done", rec.state !== "done" ? `agent ${rec.state}` : undefined, rec.costUsd);
  }

  private async settleRun(name: string, ok: boolean, error: string | undefined, costUsd: number,
    extra?: { exitCode: number | null; output: string | null }): Promise<void> {
    const job = this.jobs.get(name);
    const run = this.inFlight.get(name);
    if (!job || !run) return;   // job deleted mid-flight, or already settled
    // F04: read the durable claim BEFORE clearing it — a run still in its "starting" window carries
    // its ids only there, and the occurrence key it served is what the entry has to record.
    const marker = job.inFlight;
    this.inFlight.delete(name);
    job.inFlight = null;
    this.syncSleepHold();
    const trigger = this.lastTrigger.get(name) ?? "scheduled";
    this.lastTrigger.delete(name);
    // F04: the finished entry carries the slot it served, and that is what keeps the occurrence
    // deduped after the run leaves inFlight — the marker is gone, history is the only record left.
    // Prefer the durable marker: lastNominal is in-memory only and empty after a boot adoption.
    const nominalFireTs = marker?.nominalFireTs ?? this.lastNominal.get(name) ?? null;
    this.lastNominal.delete(name);
    const late = this.lastLateness.get(name);
    this.lastLateness.delete(name);
    const entry: JobRunEntry = {
      ts: this.now(), trigger, result: ok ? "ok" : "failed",
      agentId: run.kind === "agent" ? run.agentId : marker?.agentId ?? null,
      taskId: run.kind === "task" ? run.taskId : marker?.taskId ?? null,
      costUsd, error: error ?? null,
      exitCode: extra?.exitCode ?? null, output: extra?.output ?? null,
      latenessMs: late?.latenessMs ?? null,
      coalescedOccurrences: late?.coalescedOccurrences ?? null,
      // F04.QA-B: from the durable marker — a FAILED entry at attempt N is what lets F05 admit
      // attempt N+1 of the same slot instead of being refused as a duplicate.
      reason: null, nominalFireTs, attempt: marker?.attempt ?? 0,
    };
    this.appendRun(job, entry);
    this.deps.events.append({
      agentId: `job:${name}`, kind: "job_run_finished",
      data: { job: name, agentId: entry.agentId, taskId: entry.taskId, result: entry.result, costUsd },
    });
    if (ok) { job.consecutiveFailures = 0; job.failure = null; }
    else this.onRunFailed(job, error ?? "run failed", nominalFireTs);
    this.save();
    // F04: a parked rerun is an EXTRA run the overlap policy promised, not a grid occurrence — it
    // must not be refused as a duplicate of the slot that just finished, nor claim one itself.
    if (this.pendingRerun.delete(name) && job.enabled) void this.fire(job, "manual", null, null, { rerun: true }).catch(() => {});
    this.armTimer();
  }

  // F05: the ONE place a job failure is counted and dispositioned, shared by settleRun (a run
  // failed) and fire (a run never STARTED) so the two paths can never diverge on when a retry is
  // armed vs when the job is dead-lettered.
  private onRunFailed(job: JobRecord, error: string, nominalTs: number | null): "retry" | "dead-letter" | "wait" {
    const now = this.now();
    job.consecutiveFailures += 1;
    const prev = job.failure;
    job.failure = {
      nominalRunTs: prev?.nominalRunTs ?? nominalTs,
      reasons: [...(prev?.reasons ?? []), { ts: now, error: error.slice(0, JOB_FAILURE_REASON_MAX) }]
        .slice(-JOB_FAILURE_REASONS_CAP),
      deadLetterAt: null,
      retryAt: null,
    };
    const policy = job.retryPolicy;
    const maxAttempts = policy?.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS;
    if (job.consecutiveFailures >= maxAttempts) { this.deadLetter(job, maxAttempts); return "dead-letter"; }
    if (!policy) return "wait";
    // F05.QA-FIX: the backoff instant goes on failure.retryAt and NOWHERE ELSE. It used to
    // overwrite nextRunTs, which made the retry a NEW occurrence at a drifted slot: an `every`
    // schedule re-phased permanently, and from attempt 2 (where the old `prev === null` ceiling
    // stopped applying) the next real grid slot was swallowed with no run row and no event. The
    // grid is now untouched by failure — tick() arms both clocks and reports the collision.
    job.failure.retryAt = now + computeRetryDelayMs(policy, job.consecutiveFailures, this.deps.rand ?? Math.random);
    return "retry";
  }

  // F05: routes through disable() so job_disabled keeps firing exactly as today — job_dead_letter
  // is an ADDITIONAL structured event alongside it, never a replacement.
  private deadLetter(job: JobRecord, maxAttempts: number): void {
    const reasons = job.failure?.reasons ?? [];
    const last = reasons[reasons.length - 1]?.error ?? "unknown";
    const n = job.consecutiveFailures;
    // retryAt cleared with the same write that terminates the chain: a dead-lettered job has no
    // next attempt, and a leftover instant would keep arming the timer for a run that can't happen.
    job.failure = { nominalRunTs: job.failure?.nominalRunTs ?? null, reasons, deadLetterAt: this.now(), retryAt: null };
    this.disable(job, `dead-letter after ${n} attempt${n === 1 ? "" : "s"}: ${last}`);
    this.deps.events.append({
      agentId: `job:${job.name}`, kind: "job_dead_letter",
      data: { job: job.name, attempts: n, maxAttempts, nominalRunTs: job.failure.nominalRunTs, reasons },
    });
  }

  private disable(job: JobRecord, reason: string): void {
    job.enabled = false; job.disabledReason = reason; job.nextRunTs = null;
    // F05.QA-FIX: nextRunTs is no longer the only armed clock — a chain's pending retryAt has to
    // be dropped here too, or a job disabled mid-chain comes back armed the moment it re-enables.
    if (job.failure) job.failure.retryAt = null;
    this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_disabled", data: { job: job.name, reason } });
    // A disabled WATCH job whose process kept running would go on firing triggers after the job
    // was turned off — the disable would appear to do nothing.
    this.reconcileWatchers();
  }

  // Fires every enabled job whose nextRunTs is due (as of the injected clock), then
  // re-arms the single timer. Exposed (mirrors QueueScheduler.tick()) so tests can
  // advance the injected clock and drive a fire deterministically instead of waiting on
  // the real setTimeout.
  async tick(): Promise<void> {
    const now = this.now();
    // BEFORE the due-job loop, so a clock_jump precedes the job_run_started events it explains.
    this.observeTick(now);
    // The `nextRunTs <= now` filter IS the coalescer: it tests ONE timestamp per job, not a count
    // of occurrences, so N slots elapsed inside a suspend still produce exactly one entry here.
    // F01(c) does not change that — it only measures it (fire()'s coalescedOccurrences).
    // F05.QA-FIX: two clocks, one due-filter. A job is due for its grid slot, for the next attempt
    // of a retry chain, or (when a chain has outlived a slot) for both in the same tick.
    const due = [...this.jobs.values()].filter((j) => j.enabled && (j.snoozedUntil == null || j.snoozedUntil <= now)
      && ((j.nextRunTs !== null && j.nextRunTs <= now) || dueAt(retryArmedAt(j), now)));
    for (const job of due) {
      // Both clocks read BEFORE either branch mutates them: skipForRetry advances the grid and the
      // retry branch clears retryAt, so a re-read mid-loop would misread the other half.
      const retryPending = retryArmedAt(job) !== null;
      const gridDue = job.nextRunTs !== null && job.nextRunTs <= now;
      const retryDue = dueAt(retryArmedAt(job), now);
      if (gridDue) {
        // The retry chain owns the target until it settles: this grid occurrence is genuinely not
        // run, so it is REPORTED (skip row + job_skipped) rather than silently swallowed — the
        // exact hole F05.QA found once the chain reached attempt 2.
        if (retryPending) this.skipForRetry(job, job.nextRunTs!, now);
        else {
          const nominal = job.nextRunTs;   // [F02] the grid slot this run serves
          const { trigger, latenessMs } = this.classifyFire(nominal, now);
          await this.fire(job, trigger, nominal, latenessMs);
        }
      }
      // Ordered AFTER the grid branch on purpose: firing the retry first clears retryAt, and the
      // grid check that follows would then see a healthy job and fire the slot into the overlap
      // guard — an honest-looking skip for the wrong reason.
      const failure = job.failure;
      if (retryDue && job.enabled && failure && failure.retryAt !== null) {
        // Cleared BEFORE the await: the attempt now running re-writes the chain when it settles,
        // and a retryAt left standing across the dispatch re-arms the very run in flight.
        failure.retryAt = null;
        // The F04 key of the ORIGINAL occurrence at a distinct attempt — `job:<name>:<slot>#N`.
        const outcome = await this.fire(job, "scheduled", failure.nominalRunTs, null,
          { attempt: job.consecutiveFailures, retry: true });
        // F05.QA-FIX2: fire() can REFUSE the attempt (overlap/duplicate-occurrence) rather than run
        // it — no dispatch happened, so nothing will ever settle to re-arm or dead-letter this
        // chain. retryAt is already null above, so left alone the chain goes silently idle until
        // the next grid slot happens to revive it. Re-arm a short fixed re-check instead of the
        // exponential backoff: the attempt never ran, so it must not count as a further failure
        // (consecutiveFailures is untouched). fire() itself already appended the run row + event
        // for the refusal (reason "overlap"/"duplicate-occurrence"), so the operator sees why.
        if ((outcome === "overlap" || outcome === "duplicate-occurrence")
          && job.enabled && job.failure && job.failure.deadLetterAt === null) {
          job.failure.retryAt = this.now() + RETRY_REFUSED_REARM_MS;
          this.save();
          this.armTimer();
        }
      }
    }
    this.armTimer();
  }

  /** F05.QA-FIX: record a grid occurrence that a live retry chain swallowed. Before this the slot
   *  just vanished — no run row, no event, nothing for the operator to see. Advances the grid
   *  itself, exactly like every other branch that consumes a due slot without firing it. */
  private skipForRetry(job: JobRecord, nominalFireTs: number | null, now: number): void {
    this.appendRun(job, { ts: now, trigger: "scheduled", result: "skipped", reason: "retry-pending", nominalFireTs });
    this.deps.events.append({
      agentId: `job:${job.name}`, kind: "job_skipped",
      data: { job: job.name, reason: "retry-pending", nominalFireTs, attempt: job.consecutiveFailures },
    });
    this.advanceSchedule(job, now);
  }

  /** F01(c): the ONLY place `"sleep-wake"` is ever produced. Pure over its arguments — a fire is
   *  "late" purely as a function of the slot it serves and the clock, never of how the daemon got
   *  here, which is why reconcileBoot (daemon was down) and runNow (a human asked) never reach it. */
  private classifyFire(nominalTs: number | null, now: number): { trigger: Trigger; latenessMs: number | null } {
    const threshold = this.deps.lateFireThresholdMs ?? LATE_FIRE_THRESHOLD_MS;
    if (nominalTs === null || now - nominalTs < threshold) return { trigger: "scheduled", latenessMs: null };
    return { trigger: "sleep-wake", latenessMs: now - nominalTs };
  }

  private wake(): WakeScheduler { return this.deps.wake ?? NOOP_WAKE_SCHEDULER; }

  /** F01(b): the whole of "keep the Mac awake while a job runs", in one place. The hold's source
   *  of truth is inFlight.size — NOT a counter. A refcount that leaks by one pins the operator's
   *  machine awake until the daemon restarts, and there are five places a run can leave inFlight
   *  (settle, start-error, delete, overlap-park drain, detach). Everything here is best-effort:
   *  a power assertion that cannot be taken or released must never fail the run it was taken for. */
  private syncSleepHold(): void {
    const want = this.inFlight.size > 0;
    if (want && this.sleepHold === null) {
      try { this.sleepHold = this.wake().holdAwake(); } catch { this.sleepHold = null; }
    } else if (!want && this.sleepHold !== null) {
      const hold = this.sleepHold;
      this.sleepHold = null;
      try { hold.release(); } catch { /* the assertion is already gone; -w <pid> is the backstop */ }
    }
  }

  /** Measure this tick against the hop armTimer actually armed, and report a divergence once.
   *  The expectation is CONSUMED (nulled) whether or not it fires: a manual tick()/runNow must not
   *  be measured against a stale arming. */
  private observeTick(now: number): void {
    const armedAt = this.armedAtMs, hop = this.armedHopMs;
    this.armedAtMs = null; this.armedHopMs = null;

    this.lastTickMs = now;
    if (this.persistedTickMs === null || now - this.persistedTickMs >= LAST_TICK_PERSIST_MS) this.save();

    if (armedAt === null || hop === null) return;
    const observedGapMs = now - armedAt;
    const driftMs = observedGapMs - hop;
    const thresholdMs = this.deps.clockJumpThresholdMs ?? CLOCK_JUMP_THRESHOLD_MS;
    if (driftMs < thresholdMs && driftMs > -thresholdMs) return;
    this.deps.events.append({
      agentId: "clock", kind: "clock_jump",
      data: {
        driftMs, observedGapMs, expectedGapMs: hop, thresholdMs,
        direction: driftMs > 0 ? "forward" : "backward", source: "jobs",
      },
    });
  }

  /** The ONE place nextRunTs is recomputed after a served occurrence. Returns the number of
   *  occurrences stepped over. F04 hooks its staleness bound here, F01 its late-fire disposition. */
  private advanceSchedule(job: JobRecord, now: number): number {
    const anchor = job.nextRunTs ?? now;
    const { next, missed } = advanceOccurrence(job.schedule, job.tz, anchor, now);
    job.nextRunTs = next;
    return missed;
  }

  /** When this daemon was last alive, ± LAST_TICK_PERSIST_MS. Reported as job_skipped's
   *  downtimeMs; F04's catchUpMaxStalenessMs deliberately does NOT measure against it (it ages the
   *  occurrence, not the outage). Not exposed over RPC in F02. */
  lastTickAt(): number | null { return this.lastTickMs; }

  /** The one slot the timer and the OS wake both key off: the earliest thing any enabled job is
   *  waiting for. F05.QA-FIX: that is min(grid slot, pending retry instant) — two independent
   *  clocks since the backoff stopped living on nextRunTs. */
  private soonestArmed(): { ts: number; job: string } | null {
    let best: { ts: number; job: string } | null = null;
    for (const j of this.jobs.values()) {
      if (!j.enabled) continue;
      for (const ts of [j.nextRunTs, retryArmedAt(j)]) {
        if (ts === null) continue;
        const effective = Math.max(ts, j.snoozedUntil ?? 0);
        if (best === null || effective < best.ts) best = { ts: effective, job: j.name };
      }
    }
    return best;
  }

  private armTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const armed = this.soonestArmed();
    const soonest = armed?.ts ?? null;
    const soonestJob = armed?.job ?? "";
    if (soonest === null) {
      // Nothing armed means nothing to measure: leaving a stale expectation here would make the
      // next tick after a long idle report a phantom jump.
      this.armedAtMs = null; this.armedHopMs = null;
      // F01(a): and nothing armed also means the OS event we asked for is now for a job that no
      // longer exists — the Mac would power on at 03:00 for a schedule the operator deleted, and
      // no later re-arm would ever cancel it (the cancel below only runs when a NEW target
      // replaces the old one). This is the one exit from armTimer that must hand the event back.
      void this.releaseWake().catch(() => {});
      return;
    }
    const now = this.now();
    const delay = Math.max(0, soonest - now);
    // Node's timers coerce any delay > 2^31-1 ms (~24.8 days) to 1 ms, which would turn a
    // far-out schedule (a next-month `at`, a yearly cron) into a busy loop. Clamp to
    // MAX_TIMER_DELAY_MS and re-arm on wake — tick() re-filters by nextRunTs <= now, so an
    // early wake is a harmless no-op re-arm, not a spurious fire.
    // F02 nests a second, much tighter bound inside that one: MAX_HOP_MS is observability, not
    // overflow — a hop we never wake from is a clock jump we can never detect. `delay` itself is
    // unrounded, so the FINAL hop still lands exactly on nextRunTs rather than on a 60s boundary.
    const hop = Math.min(delay, this.deps.maxHopMs ?? MAX_HOP_MS, MAX_TIMER_DELAY_MS);
    // F02-QA-5: an RPC re-arm (create/update) can land here between an overdue wake and the
    // pending timer callback. Overwriting armedAtMs/armedHopMs unconditionally would reset the
    // expectation to "now", so the next observeTick() measures ~0 drift and a real clock jump
    // goes unreported. Only take the new expectation when the previous one is unset or has not
    // yet elapsed — an overdue expectation is left standing for the next tick()'s observeTick.
    if (this.armedAtMs === null || now - this.armedAtMs < this.armedHopMs!) {
      this.armedAtMs = now; this.armedHopMs = hop;
    }
    this.timer = setTimeout(() => { void this.tick(); }, hop);
    // A 60s heartbeat that held the process open would be a regression.
    this.timer.unref?.();
    // F01(a): fire-and-forget BY CONSTRUCTION, and only after the timer above is armed. armTimer is
    // synchronous and sits on the fire path; awaiting a privileged round trip here would put a
    // multi-second subprocess between one run settling and the next one arming. An unavailable or
    // failing wrapper changes nothing about the timer that was just armed — it only means the job
    // will be served late, which F01(c) already labels honestly.
    void this.maybeScheduleWake(soonest, soonestJob).catch(() => {});
  }

  /** F01(a): ask the OS to be awake `wakeLeadMs` BEFORE the soonest run, so the daemon is up and
   *  warm when the job is actually due. Never throws — every failure mode resolves. */
  private async maybeScheduleWake(soonest: number, forJob: string): Promise<void> {
    const wake = this.deps.wake;
    if (!wake || this.wakeBusy) return;
    const leadMs = this.deps.wakeLeadMs ?? DEFAULT_WAKE_LEAD_MS;
    const target = soonest - leadMs;
    // The run is due inside the lead window: the machine is awake right now (we are executing), so
    // there is nothing to schedule and an event in the past would be rejected by the wrapper.
    if (target <= this.now()) return;
    const outstanding = this.wakeScheduledFor;
    // A previously failed target debounces the same way a live one does — see wakeFailedFor.
    const settled = outstanding ?? this.wakeFailedFor;
    if (!this.wakeNeedsResync && settled !== null
        && Math.abs(target - settled) < WAKE_RESCHEDULE_EPSILON_MS) return;
    this.wakeBusy = true;
    try {
      const cap = await this.wakeCapability();
      // F01-QA-follow-up: unlike job_wake_scheduled/job_wake_failed below (deliberately silent
      // on the common path), a capability OBSERVATION is worth one event — the first time it's
      // unavailable, and again only if it flips — so a TUI-only operator (see wakeLastAvailable's
      // doc comment) gets a transcript signal without armTimer's once-per-hop cadence turning it
      // into spam. The null->true case (nothing yet reported as broken) stays silent by design.
      if (this.wakeLastAvailable === null ? !cap.available : this.wakeLastAvailable !== cap.available) {
        this.wakeLastAvailable = cap.available;
        this.deps.events.append({
          agentId: "wake", kind: "job_wake_capability",
          data: { available: cap.available, reason: cap.reason, setupHint: cap.setupHint },
        });
      } else {
        this.wakeLastAvailable = cap.available;
      }
      // SILENTLY, on purpose: armTimer runs once per bounded hop for as long as any job is
      // scheduled, so emitting here would put a job_wake_failed in the event log every minute
      // forever on the overwhelmingly common machine that never opted in. The degraded state is
      // reported by wakeStatus() — a state, read when asked, not a stream.
      if (!cap.available) return;
      if (outstanding !== null) {
        // Cancel by exact match FIRST, and forget the timestamp before scheduling the new one: a
        // crash in between must leave nothing on disk claiming to be cancellable, not a stale
        // event we would try to cancel twice.
        await wake.cancelWake(outstanding).catch(() => ({ ok: false }));
        this.wakeScheduledFor = null;
        this.save();
      }
      this.wakeNeedsResync = false;
      const r = await wake.scheduleWake(target);
      if (r.ok) {
        this.wakeScheduledFor = target;
        this.wakeFailedFor = null;
        this.save();
        this.deps.events.append({ agentId: "wake", kind: "job_wake_scheduled", data: { atMs: target, forJob, leadMs } });
      } else {
        // NOT persisted: a failure is this process's knowledge, and a restart should get one fresh
        // attempt rather than inherit a grudge. wakeScheduledFor stays null — there is nothing to
        // cancel, so nothing may claim there is.
        this.wakeFailedFor = target;
        this.deps.events.append({ agentId: "wake", kind: "job_wake_failed", data: { atMs: target, reason: r.error ?? "unknown" } });
      }
    } finally {
      this.wakeBusy = false;
      this.drainWakeRelease();
    }
  }

  /** F01(a): hand the outstanding OS wake back because nothing wants it any more (the last job was
   *  deleted or disabled). NOT the same as detach(), which deliberately leaves the timestamp on
   *  disk: there the daemon is only going away and the wake is still wanted at the next boot. */
  private async releaseWake(): Promise<void> {
    if (this.wakeBusy) { this.wakeReleasePending = true; return; }
    // A failed attempt was never armed, but it must still stop debouncing a job that is gone.
    this.wakeFailedFor = null;
    const outstanding = this.wakeScheduledFor;
    if (outstanding === null) return;
    this.wakeBusy = true;
    try {
      // Forget it BEFORE the round trip, exactly as the re-schedule path does: a crash in between
      // must leave nothing on disk claiming to be cancellable, not an event we cancel twice.
      this.wakeScheduledFor = null;
      this.save();
      await this.wake().cancelWake(outstanding).catch(() => ({ ok: false }));
    } finally {
      this.wakeBusy = false;
      this.drainWakeRelease();
      // A job created while this cancel was in flight found wakeBusy set and gave up; without this
      // re-check its wake would not be asked for until the next 60s hop. Re-checked here rather
      // than via armTimer() so F02's hop measurement (armedAtMs) is not reset mid-hop.
      const armed = this.soonestArmed();
      if (armed !== null && !this.wakeBusy) void this.maybeScheduleWake(armed.ts, armed.job).catch(() => {});
    }
  }

  private drainWakeRelease(): void {
    if (!this.wakeReleasePending) return;
    this.wakeReleasePending = false;
    void this.releaseWake().catch(() => {});
  }

  /** F01(a): the probe is a privileged round trip with a timeout, and job_status may be polled —
   *  so it is cached for WAKE_PROBE_TTL_MS against the injected clock, and invalidated the moment
   *  the operator touches a job (their next action right after running the installer). */
  private async wakeCapability(): Promise<WakeCapability> {
    const now = this.now();
    if (this.wakeProbe !== null && now - this.wakeProbe.at < WAKE_PROBE_TTL_MS) return this.wakeProbe.cap;
    const cap = await this.wake().probe();
    this.wakeProbe = { at: now, cap };
    return cap;
  }

  /** Drops the cached probe so the very next status read re-checks — called from create/update,
   *  which is what an operator does immediately after installing the wrapper. */
  invalidateWakeProbe(): void { this.wakeProbe = null; }

  /** F01(a): whether this machine can actually keep the schedule, reported by job.status beside
   *  the record. `scheduledFor` is suppressed when the capability is gone: a timestamp we can no
   *  longer cancel or trust is worse than no timestamp. */
  async wakeStatus(): Promise<WakeScheduling> {
    const cap = await this.wakeCapability();
    return {
      ...cap,
      scheduledFor: cap.available ? this.wakeScheduledFor : null,
      holdingAwake: this.sleepHold !== null,
    };
  }

  // Missed-while-down reconciliation, run once at construction. A job whose persisted
  // nextRunTs already elapsed is SKIPPED by default (job_skipped, reason
  // "missed-restart") and its schedule resumes from now; catchUp:true instead fires
  // it once (fire-and-forget — spawning is async) before resuming from now.
  private reconcileBoot(): void {
    const now = this.now();
    this.recoverInFlight(now);
    for (const job of this.jobs.values()) {
      if (!job.enabled || job.nextRunTs === null || job.nextRunTs > now || (job.snoozedUntil != null && job.snoozedUntil > now)) continue;
      // Read BEFORE advanceSchedule, and never after observeTick has run: lastTickMs is still the
      // previous process's last tick here, which is exactly the downtime being reported.
      const downtimeMs = this.lastTickMs !== null ? now - this.lastTickMs : null;
      // F04: the NEWEST elapsed slot, captured before advanceSchedule overwrites nextRunTs — it is
      // both the occurrence a catch-up fire serves (and keys on) and the one whose age the bound
      // judges. Deliberately not the oldest missed one: the bound is on the AGE OF THE OCCURRENCE,
      // and the oldest missed slot ages with the OUTAGE, which would silently turn
      // catchUpMaxStalenessMs back into the bound-on-downtime the design rejected — a daily 03:00
      // report would stop being caught up at 08:37 purely because the outage began three days ago.
      const nominal = latestOccurrenceAtOrBefore(job.schedule, job.tz, job.nextRunTs, now);
      // F05.QA-FIX: a retry chain that outlived the restart still owns this job. Catching the
      // elapsed slot up here would run the target twice — once at attempt 0 now, once when the
      // persisted retryAt fires on the first tick — so the slot is reported as swallowed instead.
      if (retryArmedAt(job) !== null) { this.skipForRetry(job, nominal, now); continue; }
      const missedOccurrences = this.advanceSchedule(job, now);
      // F04.QA-C: an unnameable slot cannot be caught up — every downstream consumer (the
      // occurrence key, the staleness bound, the ledger row) is defined in terms of the slot's
      // timestamp. Report it as swallowed by the restart, with nominalFireTs null meaning exactly
      // "slots were missed, the newest could not be named", rather than fire on a wrong one.
      const decision = nominal === null
        ? { fire: false, reason: "missed-restart" } as const
        : decideCatchUp(job, nominal, now);
      if (decision.fire) {
        // F02-QA-6: downtimeMs/missedOccurrences were already computed above for the job_skipped
        // paths below — a catch-up fire is no less late, so job_run_started must carry the same
        // numbers, reusing latenessMs/coalescedOccurrences rather than inventing parallel fields.
        void this.fire(job, "catchup", nominal, downtimeMs, { coalesced: missedOccurrences }).catch(() => {});
      } else if (decision.reason === "stale-beyond-window") {
        this.appendRun(job, { ts: now, trigger: "catchup", result: "skipped", reason: "stale-beyond-window", nominalFireTs: nominal });
        this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_skipped", data: { job: job.name, reason: "stale-beyond-window", nominalFireTs: nominal, lateMs: decision.lateMs, maxStalenessMs: decision.maxStalenessMs, missedOccurrences, downtimeMs } });
      } else {
        // reconcileBoot is deliberately NOT a sleep-wake site (F01(c)): the daemon was DOWN, which the
        // job_skipped event already reports as downtimeMs/missedOccurrences. Nulls here mean
        // "not measured", which is the honest answer.
        this.appendRun(job, { ts: now, trigger: "scheduled", result: "skipped", reason: "missed-restart", nominalFireTs: nominal });
        this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_skipped", data: { job: job.name, reason: "missed-restart", missedOccurrences, downtimeMs } });
      }
    }
    this.save();
    this.armTimer();
    this.reconcileWatchers();
  }

  /** F04: adopt or bury the runs the previous process left claimed. Runs FIRST at boot, before the
   *  missed-occurrence sweep, so a job whose previous run is still alive is seen as in-flight by
   *  everything downstream (overlap policy, the sleep hold, the duplicate guard) instead of being
   *  fired a second time into a target that is already working. */
  private recoverInFlight(now: number): void {
    for (const job of this.jobs.values()) {
      const marker = job.inFlight;
      if (!marker) continue;
      let adopted: InFlight | null = null;
      if (marker.kind === "message" && marker.agentId && this.deps.supervisor.hasScheduledMessage(marker.agentId, `${marker.idempotencyKey.replace(/#\d+$/, "")}:message`)) {
        this.inFlight.set(job.name, { kind: "message", agentId: marker.agentId });
        this.lastTrigger.set(job.name, marker.trigger);
        void this.settleRun(job.name, true, undefined, 0, { exitCode: null, output: "Scheduled prompt accepted by the agent mailbox (recovered)." });
        continue;
      }
      if (marker.kind === "agent" && marker.agentId !== null) {
        // Adopt whenever the supervisor still KNOWS the agent, whatever its state — a terminal
        // record means the run finished while we were down, and checkAgentSettle below writes its
        // REAL result. Adopting only "running" would bury a successful run as a crash.
        try { this.deps.supervisor.status(marker.agentId); adopted = { kind: "agent", agentId: marker.agentId }; }
        catch { adopted = null; }
      } else if (marker.kind === "task" && marker.taskId !== null) {
        try {
          const task = this.deps.queues.getTask(marker.taskId);
          if (task.state === "pending" || task.state === "in_progress" || task.state === "blocked") adopted = { kind: "task", taskId: marker.taskId };
        } catch { adopted = null; }
      }
      // "starting" and "command" are never adoptable: the first never got far enough to name
      // anything to re-attach to, and the second lived entirely inside the dead process.
      if (adopted) {
        // F04.QA-A: the re-adoption is recorded on the DURABLE record too, not only on the event
        // below — a client that connects after the restart with an empty event feed would
        // otherwise show a plain in-flight row with no sign the run was recovered.
        job.inFlight = { ...marker, readopted: true };
        this.inFlight.set(job.name, adopted);
        this.lastTrigger.set(job.name, marker.trigger);
        if (marker.nominalFireTs !== null) this.lastNominal.set(job.name, marker.nominalFireTs);
        this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_run_started", data: { job: job.name, jobName: job.name, runId: marker.idempotencyKey, agentId: marker.agentId, taskId: marker.taskId, trigger: marker.trigger, nominalFireTs: marker.nominalFireTs, idempotencyKey: marker.idempotencyKey, readopted: true } });
        if (adopted.kind === "agent") void this.checkAgentSettle(job.name, adopted.agentId).catch(() => {});
      } else {
        // The run is unrecoverable, but it is NOT counted toward consecutiveFailures: the daemon
        // died, the job did not misbehave, and auto-disabling a healthy job after three crashes
        // would be the outage outliving itself.
        //
        // F04.QA-A: a "starting" marker died BEFORE the target ran, so its slot was never served
        // and must stay claimable — the burial is written with nominalFireTs null so
        // occurrenceServed() (a pure slot lookup, deliberately kept that way) does not read it as
        // service and refuse the boot catch-up sweep that exists to recover exactly this. The
        // discriminator is `kind`, NOT "agentId and taskId are both null": a "command" marker also
        // has both null, yet its command DID launch inside the dead process, and re-firing that
        // would repeat a half-finished side effect. Accepted residual: a crash inside
        // `supervisor.spawn` after the child exists but before markInFlight persists its id now
        // yields a DUPLICATE rather than a lost run — the deliberate trade, do not "fix" it back.
        const prespawn = marker.kind === "starting";
        const reason = prespawn ? "daemon-crash-prespawn" : "daemon-crash";
        const error = prespawn
          ? "daemon crashed before the run was spawned"
          : "daemon crashed while the run was in flight";
        job.inFlight = null;
        this.appendRun(job, { ts: now, trigger: marker.trigger, result: "failed", error, reason, nominalFireTs: prespawn ? null : marker.nominalFireTs, attempt: marker.attempt, agentId: marker.agentId, taskId: marker.taskId });
        this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_run_finished", data: { job: job.name, agentId: marker.agentId, taskId: marker.taskId, result: "failed", costUsd: 0, error, reason } });
      }
    }
    // F01(b): the power assertion tracks inFlight — adopted runs need it back.
    this.syncSleepHold();
  }

  // --- JOB-WATCH: supervised processes -----------------------------------

  private watchers = new Map<string, { handle: WatchHandle; restart: ReturnType<typeof setTimeout> | null }>();

  /** Bring the running watch processes in line with the job records. Called from every place job
   *  state can change (boot, create, update, delete) rather than from each of them individually:
   *  "start it here, stop it there" is how a watcher gets orphaned or double-started. */
  reconcileWatchers(): void {
    for (const [name, w] of this.watchers) {
      const job = this.jobs.get(name);
      if (!job || !job.enabled || !isWatchJob(job)) {
        w.handle.stop();
        if (w.restart) clearTimeout(w.restart);
        this.watchers.delete(name);
      }
    }
    for (const job of this.jobs.values()) {
      if (!job.enabled || !isWatchJob(job) || this.watchers.has(job.name)) continue;
      if (!("command" in job.target)) continue;   // schema-guarded at create; belt and braces
      this.startWatcher(job);
    }
  }

  private startWatcher(job: JobRecord): void {
    if (!("command" in job.target)) return;
    const t = job.target;
    // Same redaction contract as the scheduled path: values this job supplied through `env` are the
    // one set of secrets we provably know, and a monitor echoing its environment must not leak them
    // into a triggered agent's prompt.
    const secrets = Object.values(t.env ?? {}).filter((v) => v.length > 0);
    const spawner = this.deps.spawnWatch ?? spawnWatchProcess;
    const handle = spawner(
      { command: t.command, ...(t.cwd !== undefined ? { cwd: t.cwd } : {}), ...(t.env !== undefined ? { env: t.env } : {}) },
      (line) => {
        if (!t.trigger) return;   // a watch with no trigger is just a supervised process
        const clean = redact(line, secrets);
        void this.runTrigger(job, t.trigger, {
          output: clean, exitCode: null, previousOutput: this.lastOutput.get(job.name) ?? null,
        }).catch(() => {});
        this.lastOutput.set(job.name, clean);
      },
      (code) => {
        const entry = this.watchers.get(job.name);
        if (!entry) return;   // we stopped it; not a death
        const backoffMs = t.restartBackoffMs;
        this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_watch_exited",
          data: { job: job.name, code, restartInMs: backoffMs } });
        // Restart rather than count a failure toward auto-disable: a monitor exiting is normal for
        // plenty of tools (a `kubectl -w` dropping its connection), and disabling after three would
        // silently turn the alert off exactly when the cluster is unhealthy.
        const timer = setTimeout(() => {
          this.watchers.delete(job.name);
          const live = this.jobs.get(job.name);
          if (live?.enabled && isWatchJob(live)) this.startWatcher(live);
        }, backoffMs);
        timer.unref?.();
        entry.restart = timer;
      },
    );
    this.watchers.set(job.name, { handle, restart: null });
    this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_watch_started", data: { job: job.name, pid: handle.pid } });
  }

  /** Which watch jobs are up right now — what job_status reports instead of a meaningless nextRun. */
  watchStatus(name: string): { running: boolean; pid: number | null } | null {
    const job = this.jobs.get(name);
    if (!job || !isWatchJob(job)) return null;
    const w = this.watchers.get(name);
    return { running: Boolean(w), pid: w?.handle.pid ?? null };
  }

  /** Start whatever a dispatch target names, and say what it started. ONE implementation of "how a
   *  job turns into work", shared by a job's own scheduled fire and by an output trigger — two
   *  copies of the spawn-shape construction would drift the first time a spawn field is added. */
  private async dispatch(
    d: JobDispatch, prompt: string, maxBudgetUsd: number | null, principal: string, jobName: string,
  ): Promise<{ agentId?: string; taskId?: string }> {
    const budget = maxBudgetUsd !== null ? { maxBudgetUsd } : {};
    if ("team" in d) {
      const team = this.deps.teams.get(d.team);   // throws UnknownTeamError if it vanished since create
      if (!team.queue) throw new JobError(`team "${d.team}" has no queue to run job "${jobName}" into`);
      const task = this.deps.queues.push(team.queue, { prompt, role: d.role ?? null, overrides: budget, pushedBy: principal });
      await this.deps.scheduler.tick();
      return { taskId: task.taskId };
    }
    if ("agentSpec" in d) {
      const rec = await this.deps.supervisor.spawn({ ...d.agentSpec, prompt, ...budget }, { principal, jobName });
      return { agentId: rec.agentId };
    }
    // A global role-library entry. resolveRole is the SAME merge a team/session role goes through;
    // name/skills/poolSize are RoleSpec-only fields with no place on AgentSpecSchema.strict().
    const { name: _name, skills: _skills, poolSize: _poolSize, ...resolved } = resolveRole(this.deps.roles, d);
    const rec = await this.deps.supervisor.spawn({ ...resolved, prompt, ...budget }, { principal, jobName });
    return { agentId: rec.agentId };
  }

  /** JOB-OUTPUT-TRIGGER: a command run said something worth acting on — wake an agent about it.
   *  Never throws into the run's own settle path: a trigger that cannot dispatch is recorded as a
   *  trigger failure, because failing the COMMAND for it would misreport a command that ran fine. */
  private async runTrigger(job: JobRecord, t: JobTrigger, input: TriggerInput): Promise<void> {
    const match = evaluateTrigger(t.when, input);
    if (!match) return;
    // A watch process emitting a matching line every second must not spawn an agent every second.
    const last = this.lastTriggerFire.get(job.name) ?? 0;
    const now = this.now();
    if (t.minIntervalMs > 0 && now - last < t.minIntervalMs) {
      this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_trigger_throttled",
        data: { job: job.name, sinceLastMs: now - last, minIntervalMs: t.minIntervalMs } });
      return;
    }
    this.lastTriggerFire.set(job.name, now);
    const prompt = renderTriggerPrompt(t.prompt, {
      job: job.name, ts: now, output: input.output, exitCode: input.exitCode, match,
    });
    try {
      const started = await this.dispatch(t.dispatch, prompt, t.maxBudgetUsd, `job:${job.name}`, job.name);
      this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_trigger_fired",
        data: { job: job.name, dispatch: describeDispatch(t.dispatch), matched: match.match.slice(0, 200), ...started } });
    } catch (err) {
      this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_trigger_failed",
        data: { job: job.name, error: (err as Error).message ?? String(err) } });
    }
  }

  /** Last output each job produced — the only state `when: {changed:true}` needs. Memory-only on
   *  purpose: after a restart the first run has nothing to compare against and does not fire, which
   *  is the same "no phantom alert on boot" rule evaluateTrigger applies to a first run. */
  private lastOutput = new Map<string, string>();
  private lastTriggerFire = new Map<string, number>();

  private async fire(job: JobRecord, trigger: Trigger, nominalTs: number | null = null, latenessMs: number | null = null,
    opts: { rerun?: boolean; attempt?: number; coalesced?: number; retry?: boolean } = {}): Promise<FireOutcome> {
    const now = this.now();
    // F04: the slot this fire serves, resolved ONCE. Every event, entry and claim below uses these
    // two locals — recomputing them after an await is how two legs of the same occurrence end up
    // with different keys.
    const nominalFireTs = opts.rerun ? null : this.nominalFireTsFor(job, trigger, nominalTs, now);
    // F04.QA-B: which attempt at that slot this fire is — the seam F05's backoff re-fire uses to
    // key a DIFFERENT occurrence at the SAME slot. Wired as of F05.QA-FIX: tick() dispatches a
    // retry with nominal = failure.nominalRunTs and attempt = consecutiveFailures, so the chain
    // keys job:<name>:<slot>#1, #2 … and F04 admits each one instead of refusing it as a duplicate.
    const attempt = opts.attempt ?? 0;
    const idempotencyKey = nominalFireTs !== null ? jobOccurrenceKey(job.name, nominalFireTs, attempt) : null;
    // F01-QA follow-up: job_run_started must carry a non-null run identifier so a late-spawned
    // agent's transcript stamp (ui-state reducer) can be traced back to this exact fire even for a
    // manual run, where idempotencyKey itself is null — same fallback the in-flight marker persists.
    const runId = idempotencyKey ?? `job:${job.name}:manual-${now}${"existingAgentId" in job.target ? `-${randomUUID()}` : ""}`;
    // F01(c): how many FURTHER occurrences elapsed inside the gap this fire is serving. Computed
    // HERE, before dispatch, because job_run_started must carry it and that event is appended long
    // before the tail re-arm that actually moves nextRunTs. `advanceOccurrence` is pure, so this is
    // a read, not a second re-arm; it is guarded to late fires because the walk is O(missed slots)
    // and a punctual fire has nothing to count. `opts.coalesced` lets a caller that already walked
    // this gap (reconcileBoot, anchored on job.nextRunTs) pass its own count instead of this
    // re-deriving one anchored on `nominalTs` — the two anchors can disagree on how many slots were
    // missed, and reconcileBoot's is the one that matches the downtimeMs it reports alongside it.
    const coalesced = opts.coalesced ?? (latenessMs !== null
      ? advanceOccurrence(job.schedule, job.tz, nominalTs ?? this.now(), this.now()).missed
      : null);
    // Present together or not at all: an operator reading "9 slots folded in" with no lateness, or
    // the reverse, would have to guess which half is missing.
    const lateData = latenessMs !== null ? { latenessMs, coalescedOccurrences: coalesced } : {};

    // F04: the occurrence guard, BEFORE the overlap guard — the two answer different questions.
    // Overlap is "this job is busy" (policy: skip or queue a rerun); a duplicate is "this SLOT was
    // already served", which no policy should re-run. qa/F01 §3 window 1: a catch-up fire, a
    // sleep-wake fire and a manual run can all reach the same slot; exactly one may spawn.
    if (nominalFireTs !== null && occurrenceServed(job, nominalFireTs, attempt)) {
      // Recorded at most ONCE per occurrence: three racing paths (and an operator pressing
      // run-now repeatedly, which never advances the schedule) would otherwise push a skip row
      // each into a 20-entry ring and evict the real runs the history exists to explain.
      // F04.QA-B: at most once per (slot, attempt) — a refused retry is a different fact from a
      // refused first fire and must not be swallowed by the first one's row.
      if (!job.lastRuns.some((r) => r.nominalFireTs === nominalFireTs && r.attempt === attempt && r.reason === "duplicate-occurrence"))
        this.appendRun(job, { ts: now, trigger, result: "skipped", latenessMs, coalescedOccurrences: coalesced, reason: "duplicate-occurrence", nominalFireTs, attempt });
      this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_skipped", data: { job: job.name, reason: "duplicate-occurrence", nominalFireTs, idempotencyKey, trigger } });
      // Same re-arm as the overlap branch and the tail: a scheduled/sleep-wake fire refused as a
      // duplicate must still move the schedule, or it stays due and re-fires on every 60s hop.
      // F05.QA-FIX: except a retry re-fire, which serves an OLD slot the grid already moved past —
      // advancing here would step the grid a second time and drop a real future occurrence.
      if ((trigger === "scheduled" || trigger === "sleep-wake") && job.enabled && !opts.retry) this.advanceSchedule(job, this.now());
      this.save();
      this.armTimer();
      return "duplicate-occurrence";
    }

    // F05: no retry-budget interaction here, and none needed. The retry budget is consumed by
    // FAILURES, never by fires, and at the moment this branch runs there is provably no run in
    // flight to fail — the job is busy with a DIFFERENT run. Skip vs queue behave exactly as
    // before; neither touches consecutiveFailures or failure.
    if (this.inFlight.has(job.name)) {
      // F05.QA-FIX2: a retry attempt is NEVER parked in pendingRerun, even under overlapPolicy
      // "queue" — the drain (`this.fire(job, "manual", null, null, { rerun: true })`) fires with
      // no nominalFireTs/attempt/retry, which would silently downgrade the retry into an
      // untracked manual rerun (losing the F04 occurrence key and the retry disposition). tick()
      // re-arms failure.retryAt on this outcome instead, so the chain survives the refusal.
      if (job.overlapPolicy === "queue" && !opts.retry) {
        this.pendingRerun.add(job.name);   // park until the in-flight run settles
      } else {
        this.appendRun(job, { ts: this.now(), trigger, result: "skipped", latenessMs, coalescedOccurrences: coalesced, reason: "overlap", nominalFireTs, attempt });
        this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_skipped", data: { job: job.name, reason: "overlap" } });
      }
      // F01(c): "sleep-wake" IS a scheduled fire, so it must move the schedule here too — the
      // overlap branch has the same infinite-refire failure as the tail below if it does not.
      // F05.QA-FIX: a retry re-fire is exempt for the same reason as the duplicate branch above.
      if ((trigger === "scheduled" || trigger === "sleep-wake") && !opts.retry) this.advanceSchedule(job, this.now());
      this.save();
      this.armTimer();
      return "overlap";
    }

    this.lastTrigger.set(job.name, trigger);
    if (nominalTs !== null) this.lastNominal.set(job.name, nominalTs);
    // Set BEFORE the dispatch, exactly like lastTrigger: a team target awaits scheduler.tick(),
    // which can settle the run before fire() ever reaches its tail — a lateness stashed at the
    // tail would be written too late for the very entry it belongs to.
    if (latenessMs !== null) this.lastLateness.set(job.name, { latenessMs, coalescedOccurrences: coalesced ?? 0 });
    // F04: CLAIM THE OCCURRENCE BEFORE THE SPAWN, and persist it. Two reasons it cannot wait for
    // the target to hand back an id: (1) `supervisor.spawn` is awaited, and a second path reaching
    // fire() inside that await would see an empty inFlight and spawn a twin; (2) a crash between
    // the spawn and the first settle must leave evidence on disk for recoverInFlight to adopt,
    // not an invisible run. The kind is refined to the real target by markInFlight below.
    const claim: JobInFlight = {
      // A run that serves no slot gets a DELIBERATELY different shape: `job:<name>:<ts>#<attempt>`
      // is the grid-slot key, so reusing it here would advertise a phantom occurrence to every
      // key -> slot reader (F05's retry keying, the transcript, an operator grepping events).
      idempotencyKey: runId,
      nominalFireTs, attempt, trigger, startedAt: now, kind: "starting", agentId: null, taskId: null,
      readopted: false,
    };
    this.markInFlight(job, claim, { kind: "starting" });
    let startError: string | null = null;
    try {
      if ("existingAgentId" in job.target) {
        const agentId = job.target.existingAgentId;
        this.markInFlight(job, claim, { kind: "message", agentId });
        this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_run_started", data: { job: job.name, runId, agentId, trigger, nominalFireTs, idempotencyKey, deliveryOnly: true, ...lateData } });
        await this.deps.supervisor.sendScheduled(agentId, renderScheduledPrompt(job, nominalFireTs ?? now), `job:${job.name}`, `${claim.idempotencyKey.replace(/#\d+$/, "")}:message`, job.target.maxPendingMessages);
        await this.settleRun(job.name, true, undefined, 0, { exitCode: null, output: "Scheduled prompt accepted by the agent mailbox; task completion is not tracked by this job." });
      } else if ("team" in job.target) {
        const team = this.deps.teams.get(job.target.team);   // throws UnknownTeamError if it vanished since create
        if (!team.queue) throw new JobError(`team "${job.target.team}" has no queue to run job "${job.name}" into`);
        const overrides = job.maxBudgetUsd !== null ? { maxBudgetUsd: job.maxBudgetUsd } : {};
        // GAP A: forward the pinned role key (if any) onto the pushed task — routingRoleFor
        // (scheduler.ts) falls back to the team's first role exactly as before when absent.
        const task = this.deps.queues.push(team.queue, { prompt: renderScheduledPrompt(job, nominalFireTs ?? now), role: job.target.role ?? null, overrides, pushedBy: `job:${job.name}` });
        this.markInFlight(job, claim, { kind: "task", taskId: task.taskId });
        this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_run_started", data: { job: job.name, jobName: job.name, runId, taskId: task.taskId, trigger, nominalFireTs, idempotencyKey, ...lateData } });
        await this.deps.scheduler.tick();
      } else if ("agentSpec" in job.target) {
        const spec = {
          ...job.target.agentSpec, prompt: renderScheduledPrompt(job, nominalFireTs ?? now),
          ...(job.maxBudgetUsd !== null ? { maxBudgetUsd: job.maxBudgetUsd } : {}),
        };
        const rec = await this.deps.supervisor.spawn(spec, { principal: `job:${job.name}`, jobName: job.name });
        this.markInFlight(job, claim, { kind: "agent", agentId: rec.agentId });
        this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_run_started", data: { job: job.name, jobName: job.name, runId, agentId: rec.agentId, trigger, nominalFireTs, idempotencyKey, ...lateData } });
      } else if ("command" in job.target) {
        // JOB-COMMAND-TARGET: the only SYNCHRONOUS target. The other three start something and
        // settle later off an external signal (a task finishing, an agent going terminal); this
        // one runs to completion here and settles itself. It still registers in `inFlight` first
        // so the overlap policy sees a run in progress for its whole duration.
        this.markInFlight(job, claim, { kind: "command" });
        // SECURITY (sensitive-to-observability): the raw command string is deliberately NOT in
        // this event. A scheduled command can carry a credential inline (`curl -H "Authorization:
        // Bearer ..."`), and events are the widest-read surface in the system — persisted to the
        // rotating log and readable by any agent via agent_tail/events.search. The command is
        // already on the job record, which job_status returns to whoever may read the job; putting
        // it in the event stream too widens exposure and buys nothing the job name doesn't give.
        this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_run_started", data: { job: job.name, jobName: job.name, runId, trigger, nominalFireTs, idempotencyKey, ...lateData } });
        const t = job.target;
        // Deliberately NOT awaited inside this try: a command's own non-zero exit is a RUN
        // failure (settleRun), not a failure to START the run (startError) — conflating them
        // would report a command that ran and returned 1 as if the job could not be launched.
        // SECURITY (sensitive-to-observability): a command's OUTPUT is captured into the run
        // history and shown wherever runs are shown — and a command handed secrets through `env`
        // routinely echoes them back (a failing `aws` prints the profile it used; a shell tracing
        // with `set -x` prints every expansion). The values this job supplied are the one set of
        // secrets we provably know, so they are redacted out of both the output and the error text
        // before either is persisted. Uses the same redact() every other subsystem scrubs with.
        const secrets = Object.values(t.env ?? {}).filter((v) => v.length > 0);
        const clean = (text: string | undefined): string | undefined =>
          text === undefined ? undefined : redact(text, secrets);
        void (this.deps.runCommand ?? runShellCommand)(t)
          .then(async (r) => {
            const output = clean(r.output) ?? "";
            // JOB-OUTPUT-TRIGGER: evaluated BEFORE settleRun, against the same REDACTED output the
            // run history stores — a triggered agent must not receive through its prompt what the
            // run history was careful not to record.
            if (t.trigger) {
              await this.runTrigger(job, t.trigger, {
                output, exitCode: r.exitCode, previousOutput: this.lastOutput.get(job.name) ?? null,
              });
              this.lastOutput.set(job.name, output);
            }
            // A command's own non-zero exit is a RUN failure, not a failure to start one.
            this.settleRun(job.name, r.exitCode === 0, r.exitCode === 0 ? undefined : clean(r.error), 0,
              { exitCode: r.exitCode, output: output || null });
          })
          .catch((e) => this.settleRun(job.name, false, clean(String((e as Error).message)), 0, { exitCode: null, output: null }));
      } else {
        // GAP B: spawn directly off a global role-library entry — resolveRole is the SAME
        // merge implementation scheduler.ts/engine.ts use for a team/session role, applied
        // here with the job's own prompt/budget as the final (caller) override layer. `name`/
        // `poolSize`/`skills` are RoleSpec-only fields with no place on AgentSpecSchema.strict()
        // — stripped exactly like engine.ts's identical ad-hoc-session-role spawn does.
        const { name: _name, skills: _skills, poolSize: _poolSize, ...resolved } = resolveRole(this.deps.roles, job.target);
        const spec = {
          ...resolved, prompt: renderScheduledPrompt(job, nominalFireTs ?? now),
          ...(job.maxBudgetUsd !== null ? { maxBudgetUsd: job.maxBudgetUsd } : {}),
        };
        const rec = await this.deps.supervisor.spawn(spec, { principal: `job:${job.name}`, jobName: job.name });
        this.markInFlight(job, claim, { kind: "agent", agentId: rec.agentId });
        this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_run_started", data: { job: job.name, jobName: job.name, runId, agentId: rec.agentId, trigger, nominalFireTs, idempotencyKey, ...lateData } });
      }
    } catch (err) {
      this.inFlight.delete(job.name);
      job.inFlight = null;   // F04: release the claim — nothing was spawned, so there is nothing to recover
      this.lastTrigger.delete(job.name);
      this.lastNominal.delete(job.name);
      this.lastLateness.delete(job.name);   // settleRun never runs for a start error — do not leak it into the NEXT run
      startError = (err as Error).message ?? String(err);
    }

    let disposition: "retry" | "dead-letter" | "wait" | null = null;
    if (startError !== null) {
      // A run that was late AND failed to start says both: settleRun never runs for this one, so
      // the entry has to carry the lateness itself.
      // F04: the slot is stamped even though nothing ran — a failed START has served the
      // occurrence, and re-firing it from another path would double-spawn on the retry that works.
      this.appendRun(job, { ts: this.now(), trigger, result: "failed", error: startError, latenessMs, coalescedOccurrences: coalesced, reason: "start-failed", nominalFireTs, attempt });
      this.deps.events.append({ agentId: `job:${job.name}`, kind: "job_run_finished", data: { job: job.name, result: "failed", costUsd: 0, error: startError } });
      disposition = this.onRunFailed(job, startError, nominalFireTs);
      // A dead/missing identity can never serve this pin. Do not keep retrying
      // or replace it, including when the kill happened while resuming.
      if ("existingAgentId" in job.target) {
        let unavailable = false;
        try { unavailable = this.deps.supervisor.status(job.target.existingAgentId).state === "killed"; }
        catch { unavailable = true; }
        if (unavailable) this.disable(job, `pinned agent ${job.target.existingAgentId} was killed or is missing`);
      }
    }
    // Advance the schedule after a SCHEDULED fire (whether the run started fine or
    // failed to start) so the same due slot never refires; manual/catchup runs never
    // move the schedule.
    // F01(c), THE one line that can break the scheduler: "sleep-wake" must be in this guard.
    // It is a scheduled fire that was merely late, and a late fire that does not advance its
    // schedule stays due — so tick() re-fires the same slot on every 60s hop [F02], forever.
    // F05.QA-FIX: a FAILED scheduled fire now advances the grid like any other — the retry it
    // armed lives on failure.retryAt, not here, so holding the grid back would re-fire the served
    // slot on the next hop. Only the retry re-fire itself is exempt: it serves a slot the grid
    // already stepped past, and advancing again would drop a real future occurrence.
    if ((trigger === "scheduled" || trigger === "sleep-wake") && job.enabled && !opts.retry) this.advanceSchedule(job, this.now());
    this.syncSleepHold();
    this.save();
    this.armTimer();
    return startError !== null ? "start-failed" : "started";
  }


  list(): JobRecord[] { return [...this.jobs.values()]; }

  get(name: string): JobRecord {
    const j = this.jobs.get(name);
    if (!j) throw new UnknownJobError(`unknown job "${name}"`);
    return j;
  }

  create(input: unknown): JobRecord {
    const spec = JobSpecSchema.parse(input);
    if (this.jobs.has(spec.name)) throw new DuplicateJobError(`job "${spec.name}" already exists`);
    this.validateTarget(spec.target);   // UnknownTeamError/UnknownRoleError BEFORE anything persists
    this.validatePrompt(spec);
    if (isWatchJob(spec) && spec.snoozedUntil != null) throw new JobError("snooze is only supported for timed schedules, not watch processes");
    const now = this.now();
    const nextRunTs = spec.enabled ? validateSchedule(spec.schedule, spec.tz, now) : null;
    const record = JobRecordSchema.parse({
      ...spec, createdAt: now, nextRunTs, lastRuns: [], consecutiveFailures: 0, disabledReason: null,
      failure: null,
      deliveryDroppedAt: null,
    });
    this.jobs.set(record.name, record);
    this.invalidateWakeProbe();
    this.save();
    this.armTimer();
    this.reconcileWatchers();
    return record;
  }

  // Rejects a target that can never fire, inline, BEFORE anything persists — mirrors the
  // pre-existing team check (throws UnknownTeamError) and extends it: a team target's
  // OPTIONAL pinned role key must already exist on that team's roles, and a role-library
  // target's role name must already exist in the library (UnknownRoleError). An agentSpec
  // target needs no extra check here — its shape is already fully validated by
  // JobSpecSchema.parse (JobAgentTargetSchema === AgentSpecSchema minus prompt).
  private validateTarget(target: JobSpec["target"]): void {
    if ("existingAgentId" in target) {
      this.deps.supervisor.status(target.existingAgentId);
    } else if ("team" in target) {
      const team = this.deps.teams.get(target.team);
      if (target.role !== undefined && !(target.role in team.roles))
        throw new JobError(`team "${target.team}" has no role "${target.role}"`);
    } else if ("command" in target) {
      // Nothing to resolve — the shell decides at run time whether the command exists. The
      // dispatch it may trigger, though, IS resolvable now, and a trigger pointing at a team or
      // role that does not exist would otherwise surface only when the thing it watches for finally
      // happens: the worst possible moment to discover the alert goes nowhere.
      if (target.trigger) this.validateTarget(target.trigger.dispatch as JobSpec["target"]);
      return;
    } else if (!("agentSpec" in target)) {
      this.deps.roles.get(target.role);
    }
  }

  // JOB-COMMAND-TARGET: `prompt` is schema-optional because a command job has nothing to prompt,
  // so the "required for everything else" half lives here, beside the other target validation and
  // before anything persists. Without it an agent-targeted job could be created with no prompt and
  // would only fail at its first fire — hours later, as a mysterious run failure.
  private validatePrompt(spec: { target: JobTarget; prompt?: string; maxBudgetUsd?: number | null }): void {
    if ("existingAgentId" in spec.target && spec.maxBudgetUsd != null) throw new JobError("existing-agent jobs use the agent's own budget; maxBudgetUsd cannot be set on this job");
    const isCommand = "command" in spec.target;
    if (!isCommand && (spec.prompt === undefined || spec.prompt.length === 0))
      throw new JobError("prompt is required for a team/agentSpec/role/existingAgentId job — it is what the agent is asked to do");
    if (isCommand && spec.prompt !== undefined)
      throw new JobError("a command job takes no prompt — its `command` is the whole instruction");
  }

  // JOB-UPDATE-DELIVERTO-GUARD: reads whichever shape the union variant carries its
  // deliverTo in. A `team` target routes results through the queue/conductor, not
  // deliverTo — it never has one, so it's never a "drop" (nothing to lose).
  private targetDeliverTo(target: JobTarget): string | null {
    if ("existingAgentId" in target) return null;
    if ("team" in target) return null;
    if ("agentSpec" in target) return target.agentSpec.deliverTo ?? null;
    if ("command" in target) return null;   // a command delivers nothing to anyone — nothing to lose
    const v = target.overrides["deliverTo"];
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  // F05: retryPolicy is carried OUTSIDE the Partial<JobSpec> shape, like dropDeliverTo — JobSpec's
  // own retryPolicy is optional-not-nullable (undefined ⇒ "no policy" at create time), but a PATCH
  // needs a third state: null ⇒ "remove the existing policy", undefined ⇒ "leave it alone".
  update(name: string, patch: Partial<Omit<JobSpec, "name" | "retryPolicy">> & { dropDeliverTo?: boolean; retryPolicy?: RetryPolicy | null }): JobRecord {
    const job = this.get(name);
    let deliveryDroppedAt = job.deliveryDroppedAt;
    if (patch.target) {
      this.validateTarget(patch.target);
      // JOB-UPDATE-DELIVERTO-GUARD: `target` is whole-object replaced below (never deep-
      // merged — see JobTargetSchema's comment; merging a discriminated union correctly
      // across a variant switch is genuinely subtle, see the postmortem). Reject a patch
      // that would silently drop an existing deliverTo instead of guessing intent — this
      // is the exact incident: a schedule/budget-only patch restated `target` and
      // `overrides.deliverTo` vanished while the job kept running and billing.
      const before = this.targetDeliverTo(job.target);
      const after = this.targetDeliverTo(patch.target);
      if (before !== null && after === null) {
        if (!patch.dropDeliverTo) {
          throw new JobError(
            `job "${name}"'s target patch would silently drop its deliverTo ("${before}") — the ` +
            `job would keep running and billing with nowhere to deliver results. Restate deliverTo ` +
            `in the new target to keep delivering, or pass patch.dropDeliverTo:true to remove ` +
            `delivery intentionally.`,
          );
        }
        deliveryDroppedAt = this.now();
      } else if (after !== null) {
        deliveryDroppedAt = null;   // delivery kept or (re)gained — clear any prior warning
      }
    }
    const wasDisabled = job.enabled === false;
    const merged: JobSpec = {
      name: job.name,
      snoozedUntil: patch.snoozedUntil !== undefined ? patch.snoozedUntil : job.snoozedUntil,
      promptTemplate: patch.promptTemplate ?? job.promptTemplate,
      schedule: patch.schedule ?? job.schedule,
      tz: patch.tz ?? job.tz,
      target: patch.target ?? job.target,
      // A target switch to a command explicitly replaces the instruction. Do not
      // retain an agent prompt that a command job is forbidden to carry.
      prompt: patch.prompt ?? (patch.target && "command" in patch.target ? undefined : job.prompt),
      overlapPolicy: patch.overlapPolicy ?? job.overlapPolicy,
      maxBudgetUsd: patch.maxBudgetUsd !== undefined ? patch.maxBudgetUsd : job.maxBudgetUsd,
      enabled: patch.enabled ?? job.enabled,
      catchUp: patch.catchUp ?? job.catchUp,
      catchUpMaxStalenessMs: patch.catchUpMaxStalenessMs !== undefined ? patch.catchUpMaxStalenessMs : job.catchUpMaxStalenessMs,
      // null REMOVES the policy; undefined LEAVES it. Omitting this line makes any unrelated
      // job_update (a schedule tweak, a budget change) silently delete the job's retry policy.
      retryPolicy: patch.retryPolicy === null ? undefined : (patch.retryPolicy ?? job.retryPolicy),
    };
    this.validatePrompt(merged);
    if (isWatchJob(merged) && merged.snoozedUntil != null) throw new JobError("snooze is only supported for timed schedules, not watch processes");
    const scheduleChanged = patch.schedule !== undefined || patch.tz !== undefined;
    const reenabled = wasDisabled && merged.enabled === true;
    let nextRunTs: number | null = job.nextRunTs;
    if (!merged.enabled) nextRunTs = null;
    else if (scheduleChanged || reenabled || nextRunTs === null) nextRunTs = validateSchedule(merged.schedule, merged.tz, this.now());
    const updated = JobRecordSchema.parse({
      ...merged, createdAt: job.createdAt, nextRunTs, lastRuns: job.lastRuns,
      consecutiveFailures: reenabled ? 0 : job.consecutiveFailures,
      disabledReason: reenabled ? null : job.disabledReason,
      failure: reenabled ? null : job.failure,
      deliveryDroppedAt,
      inFlight: job.inFlight,
    });
    this.jobs.set(name, updated);
    this.invalidateWakeProbe();
    this.save();
    this.armTimer();
    this.reconcileWatchers();
    return updated;
  }

  delete(name: string): boolean {
    this.get(name);   // throws UnknownJobError for a ghost name
    this.jobs.delete(name);
    this.inFlight.delete(name);
    this.syncSleepHold();
    this.pendingRerun.delete(name);
    this.lastTrigger.delete(name);
    // Same hygiene as lastTrigger: a job recreated under the SAME name must not inherit the
    // lateness of the run that was in flight when its predecessor was deleted.
    this.lastNominal.delete(name);
    this.lastLateness.delete(name);
    this.save();
    this.armTimer();
    this.reconcileWatchers();
    return true;
  }

  // run-now: immediate regardless of schedule. Still subject to the job's overlap
  // policy against a currently in-flight run — "immediate" bypasses the SCHEDULE, not
  // the overlap guardrail.
  async runNow(name: string): Promise<{ started: boolean; skipped?: boolean; reason?: string; agentId?: string; taskId?: string }> {
    const job = this.get(name);
    const wasInFlight = this.inFlight.has(name);
    const outcome = await this.fire(job, "manual");
    // F04: refused because the SLOT was already served, not because the job is busy — reported with
    // a reason rather than silently dropped, so "why did nothing happen?" has an answer.
    if (outcome === "duplicate-occurrence") return { started: false, skipped: true, reason: "duplicate-occurrence" };
    if (wasInFlight) return { started: false, skipped: job.overlapPolicy === "skip" };
    // Mailbox delivery settles before fire returns, so there is intentionally no
    // in-flight record left. Report acceptance rather than a false non-start.
    if ("existingAgentId" in job.target && outcome === "started") return { started: true, agentId: job.target.existingAgentId };
    const run = this.inFlight.get(name);
    if (!run) return { started: false };
    if (run.kind === "agent") return { started: true, agentId: run.agentId };
    if (run.kind === "task") return { started: true, taskId: run.taskId };
    return { started: true };   // a command run reports its outcome through the job's run history

  }

  // F05: the operator's one-call exit from dead-letter — QueueStore.requeue's shape verbatim: reset
  // the budget, clear the terminal state, re-arm. Does NOT touch lastRuns, exactly as queues.ts
  // preserves stepHistory — the audit trail of the failed runs is the point. Throws rather than
  // no-op'ing on a healthy job, so a script that requeues the wrong name finds out.
  requeue(name: string): JobRecord {
    const job = this.get(name);
    if (job.failure === null || job.failure.deadLetterAt === null) {
      throw new JobNotDeadLetteredError(`job "${name}" is not dead-lettered`);
    }
    this.clearFailure(job);
    this.jobs.set(name, job);
    this.invalidateWakeProbe();
    this.save();
    this.armTimer();
    this.reconcileWatchers();
    return job;
  }

  // ONE definition of "this job gets a fresh start" — update()'s re-enable branch clears the same
  // three fields inline (via JobRecordSchema.parse) rather than calling this, since it's rebuilding
  // the whole record anyway; keep the two in sync if either changes.
  private clearFailure(job: JobRecord): void {
    // Re-arm FIRST, mutate second. get() hands back the LIVE record, so a validateSchedule throw
    // after these writes leaves the job enabled with its dead-letter evidence erased in memory
    // while disk still says dead-lettered — and the next unrelated save() persists that half-apply.
    // Nothing here can fail once nextRunTs is in hand, so the requeue is all-or-nothing.
    // The re-worded throw is the plan's: "not in the future" alone does not tell the operator that
    // the exit is job_update, and a dead-lettered one-shot is exactly where they hit it.
    let nextRunTs: number | null;
    try {
      nextRunTs = validateSchedule(job.schedule, job.tz, this.now());
    } catch (e) {
      throw new JobError(`job "${job.name}" cannot be requeued: ${(e as Error).message} — job_update it with a new schedule first`);
    }
    job.failure = null;
    job.consecutiveFailures = 0;
    job.disabledReason = null;
    job.enabled = true;
    job.nextRunTs = nextRunTs;
  }

  detach(): void {
    // A clean shutdown should leave an accurate lastTickMs, not one up to LAST_TICK_PERSIST_MS stale.
    this.save();
    // F01(b): released DIRECTLY, not through syncSleepHold — at shutdown inFlight is still
    // populated, so "sync to inFlight.size" would keep the assertion alive. `caffeinate -w <our
    // pid>` is only the backstop for the paths that never reach here (SIGKILL, panic).
    const hold = this.sleepHold;
    this.sleepHold = null;
    try { hold?.release(); } catch { /* already gone */ }
    // F01(a): best-effort and un-awaitable — detach() is synchronous and shutdown will not wait on
    // a privileged subprocess. The timestamp deliberately STAYS on disk: if this cancel loses the
    // race with process exit, the next boot reads it back, re-cancels and schedules fresh
    // (wakeNeedsResync), so the worst case is one superfluous wake, never a lost one.
    if (this.wakeScheduledFor !== null) void this.deps.wake?.cancelWake(this.wakeScheduledFor).catch(() => {});
    this.unsub?.(); this.unsub = null;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // JOB-WATCH: a supervised process outliving the daemon that supervises it is an orphan nothing
    // will ever stop — the exact leak `detached: true` makes possible.
    for (const [, w] of this.watchers) { w.handle.stop(); if (w.restart) clearTimeout(w.restart); }
    this.watchers.clear();
  }
}
