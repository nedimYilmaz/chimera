import type { UsageQueryGroup } from "@chimera/protocol";
import { fmtCost, fmtTokens } from "./selectors";

// W21 (F19 · coverage §B23/§C17) — pure helpers for the usage & cost card.
// Kept separate from commands.usage.ts (the RPC-orchestrating store) so the
// "no drift" shaping logic (top-5 runs, jobs filter, csv rows, the codex
// tokens-not-cost display rule) is unit-testable without a request stub.

/** [from, to) covering the last 7 local days INCLUDING today — the daemon
 * buckets by ITS OWN local calendar day (usage.ts's dayKey), so this range
 * only needs to be wide enough to contain 7 day boundaries; the +1 mirrors
 * UsageLedger.todayUsd()'s exclusive-upper-bound fencepost. */
export function last7DaysRange(now: number): { from: number; to: number } {
  return { from: now - 7 * 24 * 60 * 60 * 1000, to: now + 1 };
}

/** Codex rows carry costUsd:0 with real token counts (D15: no per-token
 * pricing wired for that provider) — showing "$0.00" alone would read as "no
 * usage" rather than "unpriced", so a zero-cost/non-zero-token group renders
 * its tokens instead (F19: "codex rows shown as tokens with $0"). */
export function usageRowValueLabel(g: { costUsd: number; tokensIn: number; tokensOut: number }): string {
  if (g.costUsd === 0 && g.tokensIn + g.tokensOut > 0) {
    return `${fmtTokens(g.tokensIn + g.tokensOut)} tok · $0.00`;
  }
  return fmtCost(g.costUsd);
}

/** Top-5 runs by cost — usage.query{groupBy:"agent"} already returns groups
 * sorted desc by costUsd (core's usage.ts query()), so this is a plain slice,
 * never a client-side re-sort (the "no drift" rule: only the daemon's own
 * ordering is trusted). */
export function topRunsFrom(agentGroups: UsageQueryGroup[]): UsageQueryGroup[] {
  return agentGroups.slice(0, 5);
}

/** The jobs row tags `job:<name>` — rows with no job (groupKeyFor's "none"
 * fallback) are plain agent runs, not job runs, and are dropped here. */
export function jobsFrom(jobGroups: UsageQueryGroup[]): UsageQueryGroup[] {
  return jobGroups.filter((g) => g.key !== "none");
}

function csvField(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The `x` export — exactly the rows the current groupBy bars are showing
 * (F19's "the csv contains the same rows" done-when), never a re-derived or
 * client-summed set. */
export function buildUsageCsv(groupBy: string, rows: UsageQueryGroup[]): string {
  const lines = [`${groupBy},costUsd,tokensIn,tokensOut,count`];
  for (const r of rows) {
    lines.push([csvField(r.key), r.costUsd.toFixed(2), r.tokensIn, r.tokensOut, r.count].map(csvField).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function usageCsvFilename(groupBy: string, now: number): string {
  return `usage-${groupBy}-${now}.csv`;
}
