// W15 (F14 schedules panel) — client-side next-run PREVIEW for ScheduleFormCard.
// The app package cannot depend on @chimera/core (Node-only, e.g. node:fs) —
// only @chimera/protocol + @chimera/ui-state are allowed — so this is a pure
// port of @chimera/core's jobs.ts cron/every/at math (computeNextRunTs and its
// helpers), kept algorithmically identical so the live preview never disagrees
// with the daemon's own JobScheduler.create/update result. The daemon's reply
// (job.create/update's nextRunTs) is always the authoritative value; this is
// ONLY for the inline "next run: …" line while the user is still typing.
import { cronFormatter, type JobSchedule } from "@chimera/protocol";

type CronField = "*" | Set<number>;
type ParsedCron = {
  minute: CronField; hour: CronField; dom: CronField; month: CronField; dow: CronField;
  domRestricted: boolean; dowRestricted: boolean;
};

function parseCronField(expr: string, min: number, max: number, label: string): CronField {
  if (expr === "*") return "*";
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`invalid cron ${label} field "${part}"`);
    const [, rangeStr, stepStr] = m;
    const step = stepStr ? Number(stepStr) : 1;
    if (step <= 0) throw new Error(`invalid cron ${label} step "${part}"`);
    let lo: number, hi: number;
    if (rangeStr === "*") { lo = min; hi = max; }
    else if (rangeStr!.includes("-")) {
      const [a, b] = rangeStr!.split("-").map(Number);
      lo = a!; hi = b!;
    } else { lo = hi = Number(rangeStr); }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi)
      throw new Error(`cron ${label} field "${part}" out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`cron ${label} field parsed empty`);
  return out;
}

function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error(`cron expression must have 5 fields (minute hour dom month dow), got "${expr}"`);
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

function tzOffsetMinutes(ms: number, tz: string): number {
  const dtf = cronFormatter(tz);
  const parts = dtf.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (asUtc - ms) / 60_000;
}

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
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, weekday };
}

function domDowMatch(f: ParsedCron, p: ZonedParts): boolean {
  if (!f.domRestricted && !f.dowRestricted) return true;
  if (f.domRestricted && f.dowRestricted) return fieldHas(f.dom, p.day) || fieldHas(f.dow, p.weekday);
  if (f.domRestricted) return fieldHas(f.dom, p.day);
  return fieldHas(f.dow, p.weekday);
}

const MAX_CRON_ITERS = 6000;

function computeNextCron(cron: ParsedCron, tz: string, fromMs: number): number | null {
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

/** Mirrors core's jobs.ts computeNextRunTs exactly. Throws on a malformed cron
 * expression (the form surfaces the message inline); returns null when the
 * schedule can never fire again (unsatisfiable cron / a past `at`) — or, for a
 * `watch` schedule, because there is no next time: it is supervised, not timed. */
export function computeNextRunTs(schedule: JobSchedule, tz: string, fromMs: number): number | null {
  if ("cron" in schedule) return computeNextCron(parseCron(schedule.cron), tz, fromMs);
  if ("every" in schedule) { const { unit, n } = schedule.every; return fromMs + n * EVERY_UNIT_MS[unit]; }
  if ("watch" in schedule) return null;
  return schedule.at > fromMs ? schedule.at : null;
}
