// F13.1 — pure client-side filter/derive over a history.runs response page. The daemon
// (RunHistoryStore) already filtered the WINDOW and the field filters server-side; this
// module re-filters the returned PAGE for the chips (kind/outcome/unseen/team/basis/text),
// so a chip click never re-issues history.runs. Both the app HistoryScreen and the TUI
// RunHistoryPane call these functions — the seam map's rule (01-chimera-inventory.md §(d)1:
// "a screen that holds its own state is the bug"). The *wording* helpers below live here for
// the same reason: the two surfaces must say the same sentence about the same numbers.
import type { RunHistoryRow, RunKind, RunOutcome, RunTrigger } from "@chimera/protocol";

export type RunCostBasis = RunHistoryRow["costBasis"];

// Shared by both surfaces so "last 24h" means the same window in the app and the TUI.
export type RunHistoryWindow = "12h" | "24h" | "7d";
export const RUN_HISTORY_WINDOWS: Record<RunHistoryWindow, number> = {
  "12h": 12 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};
export const RUN_HISTORY_WINDOW_ORDER: readonly RunHistoryWindow[] = ["12h", "24h", "7d"];
export function nextRunHistoryWindow(w: RunHistoryWindow): RunHistoryWindow {
  const i = RUN_HISTORY_WINDOW_ORDER.indexOf(w);
  return RUN_HISTORY_WINDOW_ORDER[(i + 1) % RUN_HISTORY_WINDOW_ORDER.length]!;
}

export type RunHistoryFilter = {
  kinds: readonly RunKind[]; // empty ⇒ all
  outcome: readonly RunOutcome[]; // empty ⇒ all
  teams: readonly string[]; // empty ⇒ all
  costBasis: readonly RunCostBasis[]; // empty ⇒ all
  unseenOnly: boolean;
  text: string; // matches subject, model, trigger.ref, team, queue, job name and reason
};

export const EMPTY_RUN_HISTORY_FILTER: RunHistoryFilter = {
  kinds: [],
  outcome: [],
  teams: [],
  costBasis: [],
  unseenOnly: false,
  text: "",
};

export function isRunHistoryFilterActive(f: RunHistoryFilter): boolean {
  return (
    f.kinds.length > 0 ||
    f.outcome.length > 0 ||
    f.teams.length > 0 ||
    f.costBasis.length > 0 ||
    f.unseenOnly ||
    f.text.trim() !== ""
  );
}

export function filterRuns(rows: readonly RunHistoryRow[], f: RunHistoryFilter): RunHistoryRow[] {
  const text = f.text.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.kinds.length > 0 && !f.kinds.includes(r.kind)) return false;
    if (f.outcome.length > 0 && !f.outcome.includes(r.outcome)) return false;
    if (f.teams.length > 0 && !(r.team !== null && f.teams.includes(r.team))) return false;
    if (f.costBasis.length > 0 && !f.costBasis.includes(r.costBasis)) return false;
    if (f.unseenOnly && !r.unseen) return false;
    if (text) {
      const haystack = [r.subject, r.model, r.trigger.ref, r.team, r.queue, r.jobName, r.reason]
        .filter((v): v is string => v !== null && v !== undefined)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });
}

/** Team chips are derived from the page — the RPC has no team facet (QA M-3). */
export function runHistoryTeams(rows: readonly RunHistoryRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) if (r.team) seen.add(r.team);
  return [...seen].sort();
}

// costUsd sums ONLY costBasis:"booked" rows — the same triple-counting-prevention rule the
// daemon's own totals.costUsd uses (RunHistoryStore.runs), restated here because the chips
// change which rows are visible and the header must follow suit.
export function runHistoryCounts(rows: readonly RunHistoryRow[]): {
  total: number;
  byKind: Record<RunKind, number>;
  failed: number;
  unseen: number;
  costUsd: number;
} {
  const byKind: Record<RunKind, number> = { agent: 0, task: 0, job: 0 };
  let failed = 0;
  let unseen = 0;
  let costUsd = 0;
  for (const r of rows) {
    byKind[r.kind]++;
    if (r.outcome === "failed") failed++;
    if (r.unseen) unseen++;
    if (r.costBasis === "booked") costUsd += r.costUsd;
  }
  return { total: rows.length, byKind, failed, unseen, costUsd };
}

export type RunHistoryTotals = { runs: number; costUsd: number; failed: number; unseen: number };

/**
 * Which chips this surface still has to apply to the PAGE itself. `kinds`/`outcome` are NOT
 * here: the daemon applies those server-side over the whole window (F13.QA M-3), so re-running
 * them over a capped page would drop matches the server already counted.
 */
export function runHistoryClientFilter(f: RunHistoryFilter): RunHistoryFilter {
  return { ...f, kinds: [], outcome: [] };
}

/** True when a chip narrows the PAGE only — i.e. server totals no longer describe what is shown. */
export function isRunHistoryClientFilterActive(f: RunHistoryFilter): boolean {
  return f.teams.length > 0 || f.costBasis.length > 0 || f.unseenOnly || f.text.trim() !== "";
}

/**
 * The header numbers. Server totals win whenever they still describe the visible list, because
 * they cover every matched run and the page is capped (F13.QA M-4). The moment a client-only
 * chip (team/basis/text/new) narrows the page, falling back to page-derived counts is the honest
 * answer — "500 runs" above 3 visible rows is a lie the operator cannot debug.
 */
export function runHistoryHeaderCounts(
  totals: RunHistoryTotals | null,
  visibleRows: readonly RunHistoryRow[],
  filter: RunHistoryFilter,
): { total: number; costUsd: number; failed: number; unseen: number } {
  if (totals !== null && !isRunHistoryClientFilterActive(filter)) {
    return { total: totals.runs, costUsd: totals.costUsd, failed: totals.failed, unseen: totals.unseen };
  }
  const counts = runHistoryCounts(visibleRows);
  return { total: counts.total, costUsd: counts.costUsd, failed: counts.failed, unseen: counts.unseen };
}

/**
 * The one totals sentence both surfaces render. "booked" is IN the line, not only in a
 * footnote: the number excludes rolled-up task/job dollars, and an operator who adds the
 * cost column by hand gets a bigger number than this one on purpose (QA M-6).
 */
export function runHistoryTotalsLine(counts: { total: number; costUsd: number; failed: number; unseen: number }): string {
  return `${counts.total} runs · $${counts.costUsd.toFixed(2)} booked · ${counts.failed} failed · ${counts.unseen} new`;
}

export const RUN_HISTORY_BOOKED_NOTE =
  "totals count booked agent spend only — a ↺ cost is rolled up from this run's agents";

/**
 * "showing 500 of 812" — the page cap is silent otherwise (QA M-5). `matched` counts the
 * server-side window, so it is only comparable to the UNFILTERED page length.
 *
 * QA M-5 offered two ways out: page with `nextCursor`, or state the cap. This STATES THE CAP.
 * `matched > pageRows` can only happen on a full page, so `pageRows` IS the request's `limit`
 * — the sentence names the cap by naming the number. Cursor paging was declined: the server
 * totals already describe the full matched set, so paging would buy more rows to scroll and
 * no new number, at the price of cursor state and a "load more" affordance in two surfaces.
 *
 * The advice names the KIND/OUTCOME chips specifically. They are the only facets applied
 * server-side (M-3); team/basis/text/new re-filter this page, so telling an operator to
 * "narrow the filters" with one of those would send them after rows that can never arrive.
 */
export function runHistoryTruncationLine(pageRows: number, matched: number): string | null {
  if (matched <= pageRows) return null;
  return `showing ${pageRows} of ${matched} — narrow the window or the kind/outcome filters to see the rest`;
}

/** Compact "what is currently narrowing this list" line for the TUI header. */
export function runHistoryFilterSummary(f: RunHistoryFilter): string {
  const parts: string[] = [];
  if (f.kinds.length > 0) parts.push(f.kinds.join("+"));
  if (f.outcome.length > 0) parts.push(f.outcome.join("+"));
  if (f.teams.length > 0) parts.push(`team ${f.teams.join("+")}`);
  if (f.costBasis.length > 0) parts.push(f.costBasis.join("+"));
  if (f.unseenOnly) parts.push("new only");
  if (f.text.trim()) parts.push(`"${f.text.trim()}"`);
  return parts.length === 0 ? "no filters" : parts.join(" · ");
}

export function formatRunDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export function runHistoryTriggerLabel(t: RunTrigger): string {
  switch (t.kind) {
    // A job RUN row: `detail` is why the scheduler fired it (F13.QA M-1) — "scheduled
    // nightly-digest" reads differently from "manual nightly-digest", and that difference is
    // the whole reason the field exists. Never invent one: a null detail says "schedule".
    case "schedule":
      return t.detail ? (t.ref ? `${t.detail} ${t.ref}` : t.detail) : (t.ref ? `schedule ${t.ref}` : "schedule");
    case "job":
      return t.ref ? `job ${t.ref}` : "job";
    case "task":
      return t.ref ? `task ${t.ref}` : "task";
    case "agent":
      return t.ref ? `agent ${t.ref}` : "agent";
    case "operator":
      return "operator";
    case "unknown":
      return "—";
  }
}

/**
 * One-line "what else is known about this run" for a selected row — the fields the row
 * grid has no column for (reason, steps, team, queue). Never fabricates: a row with none
 * of them says so.
 */
export function runHistoryRowDetail(r: RunHistoryRow): string {
  const parts: string[] = [];
  if (r.team) parts.push(`team ${r.team}`);
  if (r.queue) parts.push(`queue ${r.queue}`);
  if (r.steps !== null && r.steps !== undefined) {
    parts.push(r.stepFailures ? `${r.steps} steps (${r.stepFailures} failed)` : `${r.steps} steps`);
  }
  if (r.reason) parts.push(r.reason);
  return parts.length === 0 ? "no further detail recorded" : parts.join(" · ");
}
