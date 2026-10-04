// W15 (F14 schedules panel, coverage B19/C12) — PURE selectors/formatters for
// the Queues screen's schedules panel: job.list row projection, the
// ScheduleFormCard's field values/validate/build, and the live next-run
// preview. Same discipline as selectors.coord.ts: plain functions over the
// loosely-typed job.list payload (read defensively), no React, no store
// import, fully unit-testable.
import { JOB_LAST_RUNS_CAP, WAKE_SETUP_HINT, type NormalizedEvent, type JobSchedule } from "@chimera/protocol";
import { COORD_NAME_RE, num, str } from "./selectors.coord";
import { computeNextRunTs } from "./cronPreview";
import { fmtClock, fmtDuration } from "./selectors";

// ---------------------------------------------------------------------------
// job.list row projection
// ---------------------------------------------------------------------------

export type JobRunView = {
  ts: number;
  trigger: string;         // "scheduled" | "manual" | "catchup" | "sleep-wake"
  result: string;          // "ok" | "failed" | "skipped"
  error: string | null;
  agentId: string | null;
  taskId: string | null;
  costUsd: number;
  // F01(c): how late this run fired and how many further occurrences were folded in. Null for
  // every punctual/manual/catchup run, only ever set alongside trigger "sleep-wake".
  latenessMs: number | null;
  coalescedOccurrences: number | null;
  // F04: why this entry has the result it has ("duplicate-occurrence" | "stale-beyond-window" |
  // "overlap" | "missed-restart" | "daemon-crash" | "start-failed"), null for an ordinary run.
  reason: string | null;
  // F04: the slot this run served, null for a manual run that served no slot.
  nominalFireTs: number | null;
};

export type JobRow = {
  name: string;
  enabled: boolean;
  targetKind: "team" | "agent" | "role" | "command" | "existing";
  targetTeam: string | null;
  targetLabel: string;
  scheduleLabel: string;
  nextRunTs: number | null;
  snoozedUntil?: number | null;
  // JOB-WATCH: live process state for a watch job, null for every other kind. A watch job's
  // nextRunTs is null BY DESIGN, so without this the one job kind that is supposed to be running
  // continuously would render exactly like a job that will never run again.
  watch: { running: boolean; pid: number | null } | null;
  lastRun: JobRunView | null;
  // F04: the durable in-flight marker for a crash-recovered/still-running claimed slot, null
  // once the run finishes (or if none has ever claimed a slot).
  inFlight: JobInFlightView | null;
  disabledReason: string | null;
  // F05: mirrors JobRecord.failure — null (healthy), or a retry chain in flight
  // (deadLetterAt: null), or dead-lettered (deadLetterAt set, job stopped).
  failure: {
    deadLetterAt: number | null;
    attempt: number;
    of: number;
    // F05.QA-FIX: WHEN the next attempt fires. Distinct from row.nextRunTs, which is the schedule
    // grid — reading nextRunTs here would label the next GRID slot as "next attempt".
    retryAt: number | null;
    reasons: { ts: number; error: string }[];
  } | null;
  // JOB-UPDATE-DELIVERTO-GUARD: set only when this job USED TO have a deliverTo and a
  // later job_update deliberately dropped it (patch.dropDeliverTo:true) — never set for a
  // job that never had one (that's the ordinary, non-noisy no-delivery-needed case). The
  // narrow, unambiguous "used to deliver, now doesn't" signal — not a general "has no
  // deliverTo" warning, which would fire on every legitimate janitor-style job.
  deliveryDroppedAt: number | null;
};

function unitAbbrev(u: string): string {
  switch (u) {
    case "seconds": return "s";
    case "minutes": return "m";
    case "hours": return "h";
    case "days": return "d";
    default: return u;
  }
}

function scheduleLabelOf(schedule: Record<string, unknown> | undefined): string {
  if (!schedule) return "—";
  if (typeof schedule["cron"] === "string") return `cron ${schedule["cron"]}`;
  const every = schedule["every"];
  if (every && typeof every === "object") {
    const e = every as Record<string, unknown>;
    return `every ${num(e["n"])}${unitAbbrev(str(e["unit"]))}`;
  }
  if (typeof schedule["at"] === "number") return `at ${new Date(schedule["at"]).toLocaleString()}`;
  // JOB-WATCH: supervised, not timed. Named so the row reads as "always on" rather than leaving a
  // reader to infer it from an empty next-run cell.
  if (schedule["watch"] === true) return "watching";
  return "—";
}

// JOB-ROLE-TARGET: a job target is one of three shapes now — {team[, role]},
// {agentSpec}, or {role, overrides} (a global role-library spawn, no team/queue). The
// role-library shape is distinguished from the team shape by having a `role` key but NO
// `team` key (a team target's own pinned role, GAP A, always carries `team` too).
function targetKindOf(target: Record<string, unknown> | undefined): "team" | "agent" | "role" | "command" | "existing" {
  if (!target) return "agent";
  if (typeof target["existingAgentId"] === "string") return "existing";
  if (typeof target["team"] === "string") return "team";
  // JOB-COMMAND-TARGET: checked BEFORE `role` — a {role,...} binding and a {command,...} target
  // share no keys, but ordering the cheap unambiguous test first keeps this readable as the union
  // grows.
  if (typeof target["command"] === "string") return "command";
  if (typeof target["role"] === "string") return "role";
  return "agent";
}

/** A single JobRunEntrySchema entry → the UI's JobRunView shape (shared by
 * jobRow's `lastRun` and jobRunHistory's full list, so both read the same
 * fields the same way). */
function parseJobRun(entry: Record<string, unknown>): JobRunView {
  return {
    ts: num(entry["ts"]),
    trigger: str(entry["trigger"]) || "scheduled",
    result: str(entry["result"]) || "ok",
    error: typeof entry["error"] === "string" ? (entry["error"] as string) : null,
    agentId: typeof entry["agentId"] === "string" ? (entry["agentId"] as string) : null,
    taskId: typeof entry["taskId"] === "string" ? (entry["taskId"] as string) : null,
    costUsd: num(entry["costUsd"]),
    latenessMs: typeof entry["latenessMs"] === "number" ? (entry["latenessMs"] as number) : null,
    coalescedOccurrences: typeof entry["coalescedOccurrences"] === "number" ? (entry["coalescedOccurrences"] as number) : null,
    reason: typeof entry["reason"] === "string" ? (entry["reason"] as string) : null,
    nominalFireTs: typeof entry["nominalFireTs"] === "number" ? (entry["nominalFireTs"] as number) : null,
  };
}

function rawRunsOf(raw: Record<string, unknown> | null | undefined): Array<Record<string, unknown>> {
  const runsRaw = raw?.["lastRuns"];
  return Array.isArray(runsRaw) ? (runsRaw as Array<Record<string, unknown>>) : [];
}

export function jobRow(raw: Record<string, unknown>): JobRow {
  const target = raw["target"] as Record<string, unknown> | undefined;
  const targetKind = targetKindOf(target);
  const targetTeam = targetKind === "team" ? str(target!["team"]) : null;
  const targetRole = (targetKind === "team" || targetKind === "role") && typeof target?.["role"] === "string" ? str(target["role"]) : null;
  const agentSpec = targetKind === "agent" && target ? (target["agentSpec"] as Record<string, unknown> | undefined) : undefined;
  const runs = rawRunsOf(raw);
  const last = runs.length > 0 ? runs[runs.length - 1]! : null;
  const targetLabel =
    targetKind === "existing" ? `existing agent · ${str(target?.["existingAgentId"])}`
    : targetKind === "team" ? `team ${targetTeam}${targetRole ? ` · role ${targetRole}` : ""}`
    : targetKind === "role" ? `role · ${targetRole ?? "?"}`
    : `agent · ${agentSpec ? str(agentSpec["cwd"]) : "?"}`;
  return {
    name: str(raw["name"]),
    enabled: raw["enabled"] === true,
    targetKind,
    targetTeam,
    targetLabel,
    scheduleLabel: scheduleLabelOf(raw["schedule"] as Record<string, unknown> | undefined),
    nextRunTs: typeof raw["nextRunTs"] === "number" ? (raw["nextRunTs"] as number) : null,
    ...(typeof raw["snoozedUntil"] === "number" ? { snoozedUntil: raw["snoozedUntil"] } : {}),
    watch: parseWatch(raw["watch"]),
    lastRun: last ? parseJobRun(last) : null,
    inFlight: parseInFlight(raw["inFlight"]),
    disabledReason: typeof raw["disabledReason"] === "string" ? (raw["disabledReason"] as string) : null,
    failure: parseFailure(raw),
    deliveryDroppedAt: typeof raw["deliveryDroppedAt"] === "number" ? (raw["deliveryDroppedAt"] as number) : null,
  };
}

/** F05: JobRecord.failure, object-or-null (defensive: an older daemon's row simply omits
 * it). `of` falls back to RetryPolicySchema's own default(3) when this job carries no
 * retryPolicy — the same number the daemon would use. */
function parseFailure(raw: Record<string, unknown>): JobRow["failure"] {
  const failure = raw["failure"];
  if (!failure || typeof failure !== "object") return null;
  const f = failure as Record<string, unknown>;
  const retryPolicy = raw["retryPolicy"] as Record<string, unknown> | undefined;
  const of = typeof retryPolicy?.["maxAttempts"] === "number" ? (retryPolicy["maxAttempts"] as number) : 3;
  const reasonsRaw = Array.isArray(f["reasons"]) ? (f["reasons"] as unknown[]) : [];
  const reasons = reasonsRaw
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .filter((r) => typeof r["ts"] === "number" && typeof r["error"] === "string")
    .map((r) => ({ ts: r["ts"] as number, error: r["error"] as string }));
  return {
    deadLetterAt: typeof f["deadLetterAt"] === "number" ? (f["deadLetterAt"] as number) : null,
    attempt: num(raw["consecutiveFailures"]),
    of,
    retryAt: typeof f["retryAt"] === "number" ? (f["retryAt"] as number) : null,
    reasons,
  };
}

/** job.status's raw `lastRuns[]` (oldest-first, capped at JOB_LAST_RUNS_CAP
 * entries daemon-side — see jobs.ts) → newest-first rows for the schedule
 * detail pane's run history list. `raw` is null while job.status is still
 * loading (ScheduleDetail's "loading…" case) — returns []. */
export function jobRunHistory(raw: Record<string, unknown> | null): JobRunView[] {
  return rawRunsOf(raw).map(parseJobRun).reverse();
}

/** Honest retention label for the run history section: only claims
 * truncation when the cap was actually hit, so a young job's "3 runs" never
 * implies older runs were dropped. */
export function runRetentionLabel(count: number): string {
  if (count >= JOB_LAST_RUNS_CAP) return `last ${JOB_LAST_RUNS_CAP} runs · older runs not retained`;
  return count === 1 ? "1 run" : `${count} runs`;
}

/** F01(c): the run-history trigger CELL — a 60px grid column (ScheduleDetail.module.css), so it
 *  carries the one-word species only. "slept" says this was a scheduled run the machine was asleep
 *  for; the numbers live in lateRunLabel below, on a full-width sub-row. Never "missed"/"hung": the
 *  run was not lost, it was late. */
export function triggerLabel(run: JobRunView): string {
  // F05.UI: "catchup" is wire jargon — the operator vocabulary is "catch-up". sleep-wake stays the
  // one-word "slept" on purpose: this is a 60px grid column (F01-QA) and the sub-row already spells
  // out "ran late by ... (machine was asleep)". triggerTitle carries the long phrase on hover.
  if (run.trigger === "catchup") return "catch-up";
  if (run.trigger === "sleep-wake") return "slept";
  return run.trigger;
}

/** F05.UI: the hover expansion of the trigger cell — the full sentence that would not fit. */
export function triggerTitle(run: JobRunView): string {
  if (run.trigger === "sleep-wake") return "ran late after sleep";
  if (run.trigger === "catchup") return "catch-up \u2014 a run the daemon owed from while it was down";
  if (run.trigger === "manual") return "manual \u2014 started with run now";
  return "scheduled";
}

/** F05.UI: the run-history outcome cell, index-aligned with `runs` — "ok" / "skipped" /
 *  "failed attempt 2 of 3" / "failed attempt 3 of 3 · dead-lettered".
 *  The attempt number is DERIVED from the leading run of consecutive failed entries rather than
 *  read from JobRunEntry.attempt: F05 FIX-1 (see qa/F05.md) means a backoff re-fire is written as
 *  a NEW occurrence whose `attempt` is 0, so the stored field would render "1 of 3" for every
 *  retry of the chain. The streak is clamped to consecutiveFailures so failed runs belonging to an
 *  older, already-cleared chain can never inflate the count — those keep a plain "failed". */
export function runOutcomeLabels(row: JobRow, runs: JobRunView[]): string[] {
  const chain = row.failure?.attempt ?? 0;
  let streak = 0;
  while (streak < runs.length && runs[streak]!.result === "failed") streak += 1;
  streak = Math.min(streak, chain);
  const deadLettered = row.failure?.deadLetterAt != null;
  return runs.map((run, i) => {
    if (run.result !== "failed") return run.result;
    if (i >= streak) return "failed";
    const label = `failed attempt ${streak - i} of ${row.failure!.of}`;
    return i === 0 && deadLettered ? `${label} · dead-lettered` : label;
  });
}

/** F01(c): the full-width sub-row under a late run — "ran late by 9h 13m (machine was asleep) ·
 *  3 occurrences coalesced". null for a punctual run, so callers render nothing.
 *  "coalesced", never "missed": the folded-in slots were deliberately collapsed into this one run
 *  (the scheduler tests one timestamp per job, not a count), which is a different thing from
 *  F02's job_skipped clusters where runs genuinely did not happen. */
export function lateRunLabel(run: JobRunView): string | null {
  if (run.trigger !== "sleep-wake") return null;
  const late = run.latenessMs !== null ? `ran late by ${fmtDuration(run.latenessMs)} (machine was asleep)` : "ran late (machine was asleep)";
  const n = run.coalescedOccurrences;
  if (n === null || n <= 0) return late;
  return `${late} · ${n} occurrence${n === 1 ? "" : "s"} coalesced`;
}

/** F01(a)+(b): job.status's `wakeScheduling` → the wake block ScheduleDetail shows above the run
 *  history. Never claims punctuality it cannot deliver — that is the whole point of the card.
 *  `command` is the operator's one setup step, rendered as a copy control rather than a string to
 *  retype. `holding` is the live caffeinate assertion (F01(b)), which is machine-wide, not
 *  per-job — the wording must not promise otherwise. */
export type WakeNotice = {
  text: string;
  tone: "muted" | "warn";
  /** Setup step to run, as a copyable command. null when nothing is required. */
  command: string | null;
  /** A caffeinate assertion is held right now because some job run is in flight. */
  holding: boolean;
  /** job.status has not landed yet — render the line as a placeholder, not as fact. */
  loading: boolean;
};
export function wakeNotice(spec: Record<string, unknown> | null, _now: number): WakeNotice | null {
  // The fetch is in flight: say so rather than rendering nothing, or the block silently pops into
  // existence a beat after the rest of the pane and reads as a state change that just happened.
  if (spec === null) {
    return { text: "checking wake scheduling\u2026", tone: "muted", command: null, holding: false, loading: true };
  }
  const ws = spec["wakeScheduling"];
  // Absent entirely = a daemon too old to report it. Stay silent: an invented "unavailable" here
  // would tell the operator to run a setup step that this daemon would not read.
  if (!ws || typeof ws !== "object") return null;
  const w = ws as Record<string, unknown>;
  const holding = w["holdingAwake"] === true;
  if (w["available"] !== true) {
    const reason = typeof w["reason"] === "string" && w["reason"] !== "" ? ` (${w["reason"] as string})` : "";
    return {
      text: `wake scheduling off \u2014 this Mac will not be woken for a schedule${reason}. Runs due during sleep still happen, late and coalesced, at the next wake.`,
      tone: "warn",
      command: typeof w["setupHint"] === "string" ? (w["setupHint"] as string) : WAKE_SETUP_HINT,
      holding,
      loading: false,
    };
  }
  const scheduledFor = typeof w["scheduledFor"] === "number" ? (w["scheduledFor"] as number) : null;
  const text = scheduledFor !== null
    ? `wake scheduling enabled \u2014 next wake at ${fmtClock(scheduledFor)}`
    : "wake scheduling enabled \u2014 no wake needed yet";
  return { text, tone: "muted", command: null, holding, loading: false };
}

/** F01(b): the caffeinate hold, in the operator's words. Machine-wide by construction
 *  (jobs.ts keys the assertion on inFlight.size across ALL jobs), so it says "a job run", not
 *  "this run" \u2014 a line on job A's pane must not claim job A is what is running. */
export const WAKE_HOLD_LABEL = "keeping the machine awake \u2014 a job run is in flight";

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

/** "in 4m" / "3h ago" / "now" — whole-unit relative label, minute resolution. */
export function relativeLabel(deltaMs: number): string {
  const past = deltaMs <= 0;
  const abs = Math.abs(deltaMs);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return "now";
  const unit = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return past ? `${unit} ago` : `in ${unit}`;
}

function parseWatch(raw: unknown): { running: boolean; pid: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  return { running: w["running"] === true, pid: typeof w["pid"] === "number" ? (w["pid"] as number) : null };
}

/** F05.UI (QA UI-2): `failure.attempt` is consecutiveFailures — failures SO FAR. Every badge that
 *  says "retry n of m" means the attempt that is about to run, so it must name the NEXT one, or a
 *  job one failure from dead-letter reads as comfortably mid-chain. Clamped at `of`: the moment
 *  the last attempt is spent the job is dead-lettered and this label is not rendered at all. */
function nextAttemptOf(failure: NonNullable<JobRow["failure"]>): number {
  return Math.min(failure.attempt + 1, failure.of);
}

/** F05.UI: the schedule detail's retry line, in the same words as the list badge. The final
 *  attempt is called out — it is the operator's last chance to intervene before dead-letter. */
export function retryProgressLabel(row: JobRow, now: number): string | null {
  if (!row.failure || row.failure.deadLetterAt != null) return null;
  const next = nextAttemptOf(row.failure);
  const last = next === row.failure.of ? " · last attempt before dead-letter" : "";
  // retryAt, not nextRunTs: since F05.QA-FIX the two are different instants and nextRunTs is the grid.
  // Falls back for an older daemon that has no retryAt, where nextRunTs WAS the backoff instant.
  const at = row.failure.retryAt ?? row.nextRunTs;
  return `retry ${next} of ${row.failure.of} — next attempt ${nextRunLabel(at, now)}${last}`;
}

/** F05.UI: the post-requeue toast. core's requeue() emits NO event (see FIX-NEEDED in the F05.UI
 *  report), so this client-side notice is the ONLY confirmation an operator gets that the press
 *  landed — same contract as runNowNoticeLabel. It names the next run, because "requeued" alone
 *  does not say whether the job is actually armed again. */
export function requeueNoticeLabel(name: string, nextRunTs: number | null, now: number): string {
  return `requeued ${name} — next run ${nextRunLabel(nextRunTs, now)}`;
}

/** F04.UI: the claimed-slot marker as the UI reads it. `kind` and `idempotencyKey` ride along
 * because they are the only way to tell a pre-spawn claim from a running one, and a grid-slot
 * run from a `manual-` one. */
export type JobInFlightView = {
  startedAt: number;
  trigger: string;
  nominalFireTs: number | null;
  kind: string;
  idempotencyKey: string | null;
  // F04.QA-A: the daemon re-adopted this run at boot. On the record, so a client with an empty
  // event feed still knows — see inFlightRecovered.
  readopted: boolean;
};

// F04: JobRecord.inFlight — the durable claimed-slot marker. Parsed the same defensive way as
// parseWatch so a daemon on an older protocol version (field absent) renders "no in-flight run"
// rather than throwing.
function parseInFlight(raw: unknown): JobInFlightView | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  return {
    startedAt: num(f["startedAt"]),
    trigger: str(f["trigger"]) || "scheduled",
    nominalFireTs: typeof f["nominalFireTs"] === "number" ? (f["nominalFireTs"] as number) : null,
    // F04.UI: `kind` separates the pre-spawn "starting" claim from a live agent/task/command run —
    // the two states look identical without it, and only the first one can strand an occurrence.
    // Empty, never a guessed default: an older daemon omits `kind`, and defaulting to "starting"
    // there would invent a pre-spawn state — inFlightLabel then keeps its pre-F04.UI wording.
    kind: str(f["kind"]),
    idempotencyKey: str(f["idempotencyKey"]) || null,
    // Strict === true: an older daemon omits the field entirely, and "not re-adopted" is the
    // honest reading of its absence.
    readopted: f["readopted"] === true,
  };
}

// F02.UI: how far a next-run slot may sit in the past before the cell says so out loud. Above
// the scheduler's own 60s hop bound (MAX_HOP_MS), so an ordinary tick that is a few seconds late
// never flags — only a slot the machine genuinely slept through.
export const OVERDUE_THRESHOLD_MS = 90_000;

export function nextRunLabel(nextRunTs: number | null, now: number, watch?: { running: boolean } | null): string {
  // A watch job is asked a different question: not "when next" but "is it up". Reporting "—" for it
  // would say the same thing as an expired one-shot, which is the opposite of the truth.
  if (watch) return watch.running ? "running" : "down";
  if (nextRunTs === null) return "—";
  // F02.UI: a slot deep in the past is the machine having slept, not a stuck job. "9h ago" in a
  // "next run" column reads as a hung schedule; "overdue by 9h" names the scheduler's lateness,
  // which is what the sleep banner above the rows is simultaneously explaining.
  if (now - nextRunTs > OVERDUE_THRESHOLD_MS) return `overdue by ${relativeLabel(nextRunTs - now).replace(/ ago$/, "")}`;
  return relativeLabel(nextRunTs - now);
}

// F05: the next-run cell's state ladder — dead-letter and retry-in-flight both pre-empt the
// ordinary schedule/disabled/next-run reading, since a job stuck retrying or stopped by the
// daemon is not meaningfully described by "in 4m"/"disabled" anymore.
export function jobStateLabel(row: JobRow, now: number): string {
  if (row.failure?.deadLetterAt != null) return "⚠ dead-letter";
  if (row.enabled && row.snoozedUntil != null && row.snoozedUntil > now) return `snoozed · ${nextRunLabel(row.snoozedUntil, now)}`;
  if (row.failure !== null) return `↻ retry ${nextAttemptOf(row.failure)}/${row.failure.of}`;
  if (!row.enabled) return "disabled";
  return nextRunLabel(row.nextRunTs, now, row.watch);
}

/** Newest-first "in 4m · connection reset" lines for the dead-letter block's reason list —
 * `reasons` itself is stored oldest-first (JobFailureStateSchema: "newest LAST"). */
export function deadLetterReasonLines(row: JobRow, now: number): string[] {
  if (!row.failure) return [];
  return row.failure.reasons
    .map((r) => `${relativeLabel(r.ts - now)} · ${r.error}`)
    .reverse();
}

export type ResultTone = "success" | "danger" | "muted";

export function resultTone(result: string): ResultTone {
  return result === "ok" ? "success" : result === "failed" ? "danger" : "muted";
}

// F04: plain-English gloss for a job_skipped reason — the schedules panel's operators asked "why"
// when they saw a bare "⊘ skipped", not "which enum value". Missing on purpose for any reason this
// selector doesn't know about (a newer daemon): lastResultLabel falls back to the bare "skipped"
// rather than leaking the raw enum string.
const SKIP_REASON_LABEL: Record<string, string> = {
  "duplicate-occurrence": "duplicate occurrence — already run for this slot",
  "stale-beyond-window": "too late to catch up",
  "overlap": "previous run still going",
  "retry-pending": "a retry of an earlier run is still pending",
  "missed-restart": "missed while the daemon was down",
  "daemon-crash": "daemon restarted mid-run",
  // F04.QA-A: distinct from the above precisely because the slot was NOT consumed — the catch-up
  // sweep may still serve it, and the operator should not read this as "the run happened".
  "daemon-crash-prespawn": "daemon restarted before the run started",
  // Reached only when the target threw with an empty message: lastResultLabel prefers the real
  // error text, which a start failure almost always has.
  "start-failed": "could not be started",
};

// F04.UI: reasons the DAEMON authored on the operator's behalf (no target ever produced them), so
// the gloss is strictly more informative than the accompanying error string.
const DAEMON_VOICE_REASONS = new Set(["daemon-crash", "daemon-crash-prespawn", "start-failed"]);

/** F04.UI: the run-history sub-row under a skipped/failed run — the same full-width muted line
 * F01(c)'s lateRunLabel uses, so "why did nothing happen at 09:00" is answered in the list itself
 * instead of only in the "last run" field. null when there is nothing to explain.
 *
 * `maxStalenessMs` comes from the job SPEC, not the run entry: the run row records the reason but
 * not the bound it lost to, and quoting the bound is the difference between "too stale" and an
 * operator knowing whether to widen it. */
export function runReasonLabel(run: JobRunView, maxStalenessMs?: number | null): string | null {
  if (!run.reason) return null;
  if (run.reason === "duplicate-occurrence") {
    // A manual refusal is the one an operator CAUSED and is waiting on, so it gets its own words.
    return run.trigger === "manual"
      ? "duplicate manual run refused — this slot has already run"
      : "duplicate fire — this slot was already claimed";
  }
  if (run.reason === "stale-beyond-window") {
    const bound = typeof maxStalenessMs === "number" && maxStalenessMs > 0 ? ` (catch-up limit ${fmtDuration(maxStalenessMs)})` : "";
    return `too stale to catch up${bound}`;
  }
  const gloss = SKIP_REASON_LABEL[run.reason];
  return gloss ?? null;
}

/** F04.UI: the toast for a "run now" the daemon REFUSED. Pressing run-now and seeing nothing
 * happen is indistinguishable from a dead button, and the refusal is silent everywhere else: the
 * skip row only appears after the next job.list, and the operator has already looked away. null
 * when the run actually started (the row updating IS the receipt). */
export function runNowNoticeLabel(name: string, res: { started?: boolean; reason?: string } | null | undefined): string | null {
  if (!res || res.started !== false) return null;
  if (res.reason === "duplicate-occurrence") return `"${name}" not run — this slot has already run (duplicate refused)`;
  if (res.reason === "overlap") return `"${name}" not run — the previous run is still going`;
  return res.reason ? `"${name}" not run — ${SKIP_REASON_LABEL[res.reason] ?? res.reason}` : `"${name}" was not started`;
}

/** F04.UI: `catchUpMaxStalenessMs` off a raw job.status spec, for runReasonLabel. */
export function catchUpStalenessMs(spec: Record<string, unknown> | null): number | null {
  const v = spec?.["catchUpMaxStalenessMs"];
  return typeof v === "number" && v > 0 ? v : null;
}

/** "✓ ok" / "✗ failed: oops" / "⊘ skipped" / "⊘ skipped · duplicate occurrence — already run for
 * this slot" — the schedules panel's last-result cell (ago-time rendered alongside it by the
 * caller). A failed run's `error` always wins over `reason` (F04's own "daemon-crash" failure
 * carries a human error string already, so the reason map would just repeat it). */
export function lastResultLabel(run: JobRunView | null): string {
  if (!run) return "—";
  const glyph = run.result === "ok" ? "✓" : run.result === "failed" ? "✗" : "⊘";
  // F04.UI: a daemon-written failure reason wins over the raw error text — `daemon-crash` and
  // `start-failed` are the daemon's own words for a run nobody watched, and the error string
  // ("daemon crashed while the run was in flight") is the same sentence in machine voice. Every
  // other failure keeps error-first: that text came from the target and says more than any gloss.
  if (run.result === "failed" && run.reason && DAEMON_VOICE_REASONS.has(run.reason)) {
    return `${glyph} failed · ${SKIP_REASON_LABEL[run.reason]}`;
  }
  if (run.result === "failed" && run.error) return `${glyph} failed: ${run.error}`;
  const reasonLabel = run.reason ? SKIP_REASON_LABEL[run.reason] : null;
  return reasonLabel ? `${glyph} ${run.result} · ${reasonLabel}` : `${glyph} ${run.result}`;
}

/** "● running since 4m ago · scheduled slot 09:00" / "● running since 4m ago · manual" — the
 * schedule detail's in-flight row, so a crash-recovered or still-running claimed slot is visible
 * even though the run hasn't produced a lastRun entry yet. null when nothing is claimed. */
export function inFlightLabel(row: JobRow, now: number): string | null {
  if (row.inFlight === null) return null;
  const since = relativeLabel(row.inFlight.startedAt - now);
  // HH:MM, not fmtClock's HH:MM:SS — a slot label names the minute it was due, not the instant.
  const slot = row.inFlight.nominalFireTs !== null ? `scheduled slot ${fmtClock(row.inFlight.nominalFireTs).slice(0, 5)}` : "manual";
  // F04.UI: "starting" is the claim written BEFORE anything was spawned — the one state that can
  // strand an occurrence if the daemon dies here. Saying "running" for it would tell an operator
  // a run exists to go look at when none does.
  const head = row.inFlight.kind === "starting" ? `◌ starting since ${since}` : `● running since ${since}`;
  return `${head} · ${slot}`;
}

/** F04.UI: the in-flight claim's idempotency key, for the detail row — a `manual-` suffix is how an
 * operator tells a run they pressed from one the grid fired. null when the daemon sent no key. */
export function inFlightKeyLabel(row: JobRow): string | null {
  return row.inFlight?.idempotencyKey ?? null;
}

/** F04.UI: true when the in-flight claim was RE-ADOPTED across a daemon restart rather than started
 * in this process — without this the row silently reads as a run the current daemon started.
 *
 * F04.QA-A: the durable `inFlight.readopted` flag answers this on its own, so an app that connects
 * after the restart with no event backlog still shows the marker. The event scan below is kept as
 * the fallback for a daemon older than that flag, which announces the fact only as
 * `job_run_started … readopted: true`. */
export function inFlightRecovered(events: ReadonlyArray<{ kind: string; data?: Record<string, unknown> | null }>, row: JobRow): boolean {
  if (row.inFlight?.readopted === true) return true;
  const key = row.inFlight?.idempotencyKey;
  if (!key) return false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "job_run_started") continue;
    if (e.data?.["idempotencyKey"] !== key) continue;
    return e.data?.["readopted"] === true;
  }
  return false;
}

/** The newest seq among job-scheduler events (D10, coverage C12) — the
 * schedules panel's refresh trigger. 0 when none. */
export function latestJobSeq(events: ReadonlyArray<Pick<NormalizedEvent, "seq" | "kind">>): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const k = events[i]!.kind;
    if (k === "job_run_started" || k === "job_run_finished" || k === "job_skipped" || k === "job_disabled" || k === "job_dead_letter") return events[i]!.seq;
  }
  return 0;
}

// F02: the schedules panel's suspend/resume banner window — a clock_jump older than this is
// stale operator history, not something worth a persistent notice above the schedule rows.
export const CLOCK_JUMP_NOTICE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The newest clock_jump still inside the notice window, or null (none yet, or the only one is
 * stale). Split out so the banner and its consequence clause read the SAME jump. */
function newestClockJump<E extends Pick<NormalizedEvent, "kind" | "ts" | "data">>(
  events: ReadonlyArray<E>, now: number,
): E | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "clock_jump") continue;
    return now - e.ts > CLOCK_JUMP_NOTICE_WINDOW_MS ? null : e;
  }
  return null;
}

/** "⏱ slept 9h 13m at 09:13:07 — schedules re-armed" (forward) / "⏱ clock stepped back 12m at
 * 09:13:07 — schedules re-armed" (backward) for the newest clock_jump inside the notice window,
 * null otherwise (none yet, or the only one is stale). */
export function clockJumpNotice(events: ReadonlyArray<Pick<NormalizedEvent, "kind" | "ts" | "data">>, now: number): string | null {
  const e = newestClockJump(events, now);
  if (e === null) return null;
  // driftMs, NOT observedGapMs: the drift is the wall time nothing accounts for, while the gap
  // also contains the hop the scheduler MEANT to sleep. It is what system.woke publishes as
  // sleptMs (core/topics.ts), so the banner and a woken agent cannot disagree. Magnitude, not the
  // raw signed value: a backward jump's driftMs is negative and fmtDuration floors anything below
  // 1000ms to "0s" — which is how "clock stepped back 0s" shipped.
  const gap = fmtDuration(Math.abs(num(e.data["driftMs"])));
  const at = fmtClock(e.ts);
  return e.data["direction"] === "backward"
    ? `⏱ clock stepped back ${gap} at ${at} — schedules re-armed`
    : `⏱ slept ${gap} at ${at} — schedules re-armed`;
}

/** F02.UI: the consequence clause the banner was missing — "did my hourly job miss 9 runs?" was
 * unanswerable from any screen even though `job_skipped {reason:"missed-restart"}` has carried
 * `missedOccurrences` since F02. Counted from the skip cluster of ONE reconcileBoot pass (it reads
 * `now` once, so its skips share a ts — ±1s of slack), so an older restart's skips are never
 * folded into this one. Null when nothing was skipped. */
export function missedRunsClause(
  events: ReadonlyArray<Pick<NormalizedEvent, "kind" | "ts" | "data">>, clusterTs: number,
): string | null {
  const perJob = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== "job_skipped" || Math.abs(e.ts - clusterTs) > RESTART_CLUSTER_SLACK_MS) continue;
    if (e.data["reason"] !== "missed-restart") continue;
    const job = str(e.data["job"]);
    if (!job) continue;
    // The skip event IS one missed run; missedOccurrences counts the further occurrences the
    // re-arm stepped over. An older daemon omits it — floor at 1 rather than report 0 runs.
    perJob.set(job, (perJob.get(job) ?? 0) + Math.max(1, num(e.data["missedOccurrences"])));
  }
  if (perJob.size === 0) return null;
  let runs = 0;
  for (const n of perJob.values()) runs += n;
  const plural = runs === 1 ? "run" : "runs";
  if (perJob.size === 1) return `${[...perJob.keys()][0]} missed ${runs} ${plural}`;
  return `${runs} ${plural} missed across ${perJob.size} schedules`;
}

// reconcileBoot reads `now` once and emits every missed-restart skip against it, so one restart's
// skips share a timestamp. The slack only absorbs a slow loop, never a second restart.
export const RESTART_CLUSTER_SLACK_MS = 1_000;

export type ScheduleGapBanner = {
  text: string;
  /** "muted" for a completed sleep or restart — explanatory, not a fault. "warn" only for a clock
   *  that stepped BACKWARD, which is a genuine anomaly (NTP step / VM rollback). */
  tone: "muted" | "warn";
};

/** The schedules panel's gap banner: whichever of the two gap signals is newer inside the notice
 * window. They are mutually exclusive by construction, not merely by convention:
 *
 * - A suspend the daemon LIVED THROUGH produces `clock_jump` (observeTick) and then simply fires
 *   the late job — no `job_skipped`, and `advanceSchedule`'s `missed` count is discarded.
 * - A daemon RESTART produces the `job_skipped {missed-restart}` cluster from `reconcileBoot`,
 *   which runs at construction BEFORE any armTimer — so `armedAtMs` is null and observeTick can
 *   never report a jump for it (core's A10).
 *
 * So the sleep sentence can never carry a skip count, and the restart line is the only place the
 * count exists. Sourcing both is why the panel can answer "what happened while I was away"
 * whichever way the gap happened. (FIX-NEEDED, core/F01(c): emit `missed` on the live-suspend late
 * fire too — this selector would then show the count on that path with no change here.) */
export function scheduleGapBanner(
  events: ReadonlyArray<Pick<NormalizedEvent, "kind" | "ts" | "data">>, now: number,
): ScheduleGapBanner | null {
  const jump = newestClockJump(events, now);
  let restartTs: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "job_skipped" || e.data["reason"] !== "missed-restart") continue;
    if (now - e.ts > CLOCK_JUMP_NOTICE_WINDOW_MS) break;
    restartTs = e.ts;
    break;
  }
  if (jump !== null && (restartTs === null || jump.ts >= restartTs)) {
    const text = clockJumpNotice(events, now);
    if (text === null) return null;
    return { text, tone: jump.data["direction"] === "backward" ? "warn" : "muted" };
  }
  if (restartTs === null) return null;
  const missed = missedRunsClause(events, restartTs);
  if (missed === null) return null;
  // downtimeMs is null when the previous process never persisted a lastTickMs (an older daemon, or
  // one that died inside its first LAST_TICK_PERSIST_MS window) — say only what is known.
  const downtime = downtimeOfCluster(events, restartTs);
  const head = downtime === null
    ? `⏱ restarted at ${fmtClock(restartTs)}`
    : `⏱ back after ${fmtDuration(downtime)} down at ${fmtClock(restartTs)}`;
  return { text: `${head} — ${missed}`, tone: "muted" };
}

function downtimeOfCluster(
  events: ReadonlyArray<Pick<NormalizedEvent, "kind" | "ts" | "data">>, clusterTs: number,
): number | null {
  for (const e of events) {
    if (e.kind !== "job_skipped" || Math.abs(e.ts - clusterTs) > RESTART_CLUSTER_SLACK_MS) continue;
    if (typeof e.data["downtimeMs"] === "number") return e.data["downtimeMs"] as number;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ScheduleFormCard values + validate/build (unit-tested; the card stays thin)
// ---------------------------------------------------------------------------

export type ScheduleFormValues = {
  name: string;
  targetKind: "team" | "agent" | "role" | "command" | "existing";
  existingAgentId: string;
  maxPendingMessages?: string;
  promptTemplate?: boolean;
  // Preserve advanced target settings that this compact form does not edit.
  agentSpecExtras?: Record<string, unknown>;
  commandExtras?: Record<string, unknown>;
  team: string;
  // team-target only (GAP A): optionally pins WHICH of the team's role keys the pushed
  // task routes to. Blank ⇒ omitted from target — the queue resolves its own default role.
  teamRole: string;
  // role-target only (GAP B): a global role-library entry name (RoleStore) to spawn
  // directly from, no team/queue involved. Overrides aren't editable from this form yet —
  // the role's own library defaults apply as-is (still reachable via job_update's raw
  // payload for the advanced case).
  role: string;
  // JOB-ROLE-OVERRIDES: the {role, overrides} target's own override patch — the piece
  // ScheduleFormCard's header used to admit was "not editable from this form yet", so a
  // scheduled run could BIND a library role but never adjust it, forcing a near-duplicate role
  // for every "same role, different model/effort" schedule. Same sparse `{field: value}` shape a
  // team slot's binding carries; empty ⇒ the library role's own defaults, exactly as before.
  roleOverrides: Record<string, unknown>;
  // JOB-COMMAND-TARGET: a scheduled job with no agent — a plain shell command. `cwd` is shared
  // with the agent target (both mean "where does this run"); the rest is command-only.
  command: string;
  commandTimeoutSec: string;
  cwd: string;
  model: string;
  // agent-target only: worktree isolation needs a git repo at cwd (else the run
  // fails with "isolation …"); "none" runs the agent directly in cwd. Defaults
  // to "none" so a scheduled agent job just works in any cwd.
  isolation: "none" | "worktree";
  prompt: string;
  scheduleKind: "cron" | "every" | "at";
  cron: string;
  everyN: string;
  everyUnit: "seconds" | "minutes" | "hours" | "days";
  at: string;
  tz: string;
  overlapPolicy: "skip" | "queue";
  // F04.UI: catch-up — whether a slot the daemon slept/was-down through still runs once it comes
  // back, and how old that slot may be before it is dropped instead. Blank bound ⇒ no bound (any
  // age catches up), which is exactly the protocol's `null`.
  catchUp: boolean;
  catchUpMaxStalenessMin: string;
  maxBudgetUsd: string;
  enabled: boolean;
};

/** F04.UI: the one-line explanation rendered under the catch-up controls. Says what the machine
 * DOES, not what the field is named — "catch-up" alone reads as jargon to an operator deciding
 * whether a 03:00 report should still run at 08:37. */
export const CATCH_UP_HELP =
  "if the Mac was asleep or the daemon was down at the scheduled time, run the missed slot once on the way back — but only while it is younger than this limit (blank = any age).";

export const LOCAL_TZ = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export function defaultScheduleFormValues(): ScheduleFormValues {
  return {
    existingAgentId: "",
    name: "", targetKind: "team", team: "", teamRole: "", role: "", roleOverrides: {}, command: "", commandTimeoutSec: "", cwd: "", model: "", isolation: "none",
    prompt: "", scheduleKind: "cron", cron: "0 * * * *", everyN: "30", everyUnit: "minutes",
    at: "", tz: LOCAL_TZ(), overlapPolicy: "skip", catchUp: false, catchUpMaxStalenessMin: "",
    maxBudgetUsd: "", enabled: true,
  };
}

export type SchedulePreview = { nextRunTs: number | null; error: string | null };

/** Live next-run preview, tolerant of a still-empty field (returns no error,
 * just no preview) — only a genuinely malformed value surfaces an error, so
 * the card doesn't flash red before the user finishes typing. */
export function computeSchedulePreview(
  v: Pick<ScheduleFormValues, "scheduleKind" | "cron" | "everyN" | "everyUnit" | "at" | "tz">,
  now = Date.now(),
): SchedulePreview {
  const tz = v.tz.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return { nextRunTs: null, error: `invalid timezone "${tz}"` };
  }
  let schedule: JobSchedule;
  if (v.scheduleKind === "cron") {
    if (!v.cron.trim()) return { nextRunTs: null, error: null };
    schedule = { cron: v.cron.trim() };
  } else if (v.scheduleKind === "every") {
    const n = Number(v.everyN);
    if (!v.everyN.trim() || !Number.isInteger(n) || n <= 0) return { nextRunTs: null, error: null };
    schedule = { every: { unit: v.everyUnit, n } };
  } else {
    if (!v.at.trim()) return { nextRunTs: null, error: null };
    const ts = Date.parse(v.at);
    if (Number.isNaN(ts)) return { nextRunTs: null, error: "invalid date/time" };
    schedule = { at: ts };
  }
  try {
    const next = computeNextRunTs(schedule, tz, now);
    if (next === null) return { nextRunTs: null, error: "at" in schedule ? "scheduled time is not in the future" : "cron schedule can never fire" };
    return { nextRunTs: next, error: null };
  } catch (err) {
    return { nextRunTs: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** First validation error for the create-schedule form, or null when
 * submittable. Mirrors protocol constraints (JobSpecSchema) client-side so the
 * inline error is instant — an invalid cron is NEVER silently accepted. */
export function validateScheduleForm(v: ScheduleFormValues): string | null {
  if (!v.name.trim()) return "name is required";
  if (!COORD_NAME_RE.test(v.name.trim())) return "name: letters, digits, _ and - only";
  if (v.targetKind === "team" && !v.team.trim()) return "team is required";
  if (v.targetKind === "agent" && !v.cwd.trim()) return "cwd is required";
  if (v.targetKind === "role" && !v.role.trim()) return "role is required";
  if (v.targetKind === "existing" && !v.existingAgentId.trim()) return "existing agent is required";
  if (v.targetKind !== "command" && !v.prompt.trim()) return "prompt is required";
  if (v.targetKind === "existing" && v.maxPendingMessages?.trim() && (!Number.isInteger(Number(v.maxPendingMessages)) || Number(v.maxPendingMessages) < 1 || Number(v.maxPendingMessages) > 1000)) return "pending message limit must be 1–1000";
  if (v.scheduleKind === "cron" && !v.cron.trim()) return "cron expression is required";
  if (v.scheduleKind === "every" && (!v.everyN.trim() || !Number.isInteger(Number(v.everyN)) || Number(v.everyN) <= 0))
    return "every: n must be a positive integer";
  if (v.scheduleKind === "at" && !v.at.trim()) return "date/time is required";
  const preview = computeSchedulePreview(v);
  if (preview.error) return preview.error;
  if (v.catchUpMaxStalenessMin.trim() && !(Number.isInteger(Number(v.catchUpMaxStalenessMin)) && Number(v.catchUpMaxStalenessMin) > 0))
    return "catch-up limit: minutes must be a positive integer";
  if (v.targetKind !== "existing" && v.maxBudgetUsd.trim() && !(Number(v.maxBudgetUsd) > 0)) return "budget must be a positive number";
  return null;
}

/** job.create spec (protocol JobSpecSchema — schedule is exactly one of
 * cron/every/at; target is exactly one of team/agentSpec). */
export function buildJobSpec(v: ScheduleFormValues): Record<string, unknown> {
  const schedule =
    v.scheduleKind === "cron" ? { cron: v.cron.trim() }
    : v.scheduleKind === "every" ? { every: { unit: v.everyUnit, n: Number(v.everyN) } }
    : { at: Date.parse(v.at) };
  const target =
    v.targetKind === "existing" ? { existingAgentId: v.existingAgentId.trim(), ...(v.maxPendingMessages?.trim() ? { maxPendingMessages: Number(v.maxPendingMessages) } : {}) }
    : v.targetKind === "team"
      ? { team: v.team.trim(), ...(v.teamRole.trim() ? { role: v.teamRole.trim() } : {}) }
      : v.targetKind === "role"
      // JOB-ROLE-OVERRIDES: emitted only when non-empty so a job with no overrides serialises
      // byte-identically to before this field existed (RoleBindingSchema defaults it to {}).
      ? { role: v.role.trim(), ...(Object.keys(v.roleOverrides).length > 0 ? { overrides: v.roleOverrides } : {}) }
      : v.targetKind === "command"
      ? {
          ...v.commandExtras,
          command: v.command.trim(),
          ...(v.cwd.trim() ? { cwd: v.cwd.trim() } : {}),
          ...(v.commandTimeoutSec.trim() ? { timeoutMs: Number(v.commandTimeoutSec) * 1000 } : {}),
        }
      : { agentSpec: { ...v.agentSpecExtras, cwd: v.cwd.trim(), isolation: v.isolation, ...(v.model.trim() ? { model: v.model.trim() } : {}) } };
  // JOB-COMMAND-TARGET: a command job carries neither a prompt (its command IS the instruction)
  // nor a budget (it spends no tokens) — the daemon rejects both, so the form must not send them.
  const isCommand = v.targetKind === "command";
  return {
    name: v.name.trim(),
    schedule,
    tz: v.tz.trim() || "UTC",
    target,
    ...(isCommand ? {} : { prompt: v.prompt.trim() }),
    ...(v.promptTemplate !== undefined ? { promptTemplate: v.promptTemplate } : {}),
    catchUp: v.catchUp,
    // Explicit null, never omitted: buildJobUpdatePatch reuses this object, and a dropped key
    // would leave a previously-set bound in place when the operator cleared the field.
    catchUpMaxStalenessMs: v.catchUpMaxStalenessMin.trim() ? Number(v.catchUpMaxStalenessMin) * 60_000 : null,
    overlapPolicy: v.overlapPolicy,
    ...(v.targetKind === "existing" ? { maxBudgetUsd: null } : !isCommand && v.maxBudgetUsd.trim() ? { maxBudgetUsd: Number(v.maxBudgetUsd) } : {}),
    enabled: v.enabled,
  };
}

/** job.update patch — the SAME buildJobSpec output minus the immutable `name`
 * key (W16/F15/D11: the schedules "e" edit chip). */
export function buildJobUpdatePatch(v: ScheduleFormValues): Record<string, unknown> {
  const { name: _name, ...patch } = buildJobSpec(v);
  return patch;
}

function toDatetimeLocalValue(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** job.status/job.list raw spec → the ScheduleFormCard's field shape, for the
 * "e" edit prefill (W16/F15/D11). */
export function scheduleFormValuesFromSpec(raw: Record<string, unknown>): ScheduleFormValues {
  const target = raw["target"] as Record<string, unknown> | undefined;
  const targetKind = targetKindOf(target);
  const agentSpec = targetKind === "agent" && target ? (target["agentSpec"] as Record<string, unknown> | undefined) : undefined;
  const schedule = raw["schedule"] as Record<string, unknown> | undefined;
  const scheduleKind: "cron" | "every" | "at" =
    schedule && typeof schedule["cron"] === "string" ? "cron"
    : schedule && typeof schedule["every"] === "object" && schedule["every"] !== null ? "every"
    : "at";
  const every = scheduleKind === "every" ? (schedule!["every"] as Record<string, unknown>) : undefined;
  const maxBudgetUsd = raw["maxBudgetUsd"];
  const extras = (record: Record<string, unknown> | undefined, controlled: string[]): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => !controlled.includes(key)));
  return {
    name: str(raw["name"]),
    targetKind,
    existingAgentId: targetKind === "existing" ? str(target?.["existingAgentId"]) : "",
    maxPendingMessages: targetKind === "existing" && typeof target?.["maxPendingMessages"] === "number" ? String(target.maxPendingMessages) : "",
    ...(typeof raw.promptTemplate === "boolean" ? { promptTemplate: raw.promptTemplate } : {}),
    ...(agentSpec ? { agentSpecExtras: extras(agentSpec, ["cwd", "model", "isolation"]) } : {}),
    ...(targetKind === "command" ? { commandExtras: extras(target, ["command", "cwd", "timeoutMs"]) } : {}),
    team: targetKind === "team" ? str(target?.["team"]) : "",
    teamRole: targetKind === "team" && typeof target?.["role"] === "string" ? str(target["role"]) : "",
    role: targetKind === "role" && typeof target?.["role"] === "string" ? str(target["role"]) : "",
    roleOverrides: targetKind === "role" && target?.["overrides"] && typeof target["overrides"] === "object"
      ? (target["overrides"] as Record<string, unknown>) : {},
    // JOB-COMMAND-TARGET: `cwd` is shared — an agent target carries it inside agentSpec, a
    // command target carries it at the top level, and both mean "where does this run".
    command: targetKind === "command" ? str(target?.["command"]) : "",
    commandTimeoutSec: targetKind === "command" && typeof target?.["timeoutMs"] === "number"
      ? String(Math.round((target["timeoutMs"] as number) / 1000)) : "",
    cwd: targetKind === "agent" ? str(agentSpec?.["cwd"]) : targetKind === "command" ? str(target?.["cwd"]) : "",
    model: targetKind === "agent" ? str(agentSpec?.["model"]) : "",
    isolation: targetKind === "agent" && agentSpec?.["isolation"] === "worktree" ? "worktree" : "none",
    prompt: str(raw["prompt"]),
    scheduleKind,
    cron: scheduleKind === "cron" ? str(schedule?.["cron"]) : "0 * * * *",
    everyN: every ? String(num(every["n"])) : "30",
    everyUnit: (every?.["unit"] as ScheduleFormValues["everyUnit"] | undefined) ?? "minutes",
    at: scheduleKind === "at" && typeof schedule?.["at"] === "number" ? toDatetimeLocalValue(schedule["at"] as number) : "",
    tz: str(raw["tz"]) || LOCAL_TZ(),
    overlapPolicy: (raw["overlapPolicy"] as ScheduleFormValues["overlapPolicy"] | undefined) ?? "skip",
    catchUp: raw["catchUp"] === true,
    catchUpMaxStalenessMin: typeof raw["catchUpMaxStalenessMs"] === "number"
      ? String(Math.round((raw["catchUpMaxStalenessMs"] as number) / 60_000)) : "",
    maxBudgetUsd: typeof maxBudgetUsd === "number" ? String(maxBudgetUsd) : "",
    enabled: raw["enabled"] !== false,
  };
}
