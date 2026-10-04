// F50.UI: the ONE place the budget guardrail is put into words. The pause banner, the
// pre-resume confirm card and the system-transcript line exist in three different
// renderers (app CSS banner, Ink band, reducer text) and each previously described the
// same daemon state in its own terms — an operator reading two of them could not tell
// whether they were about the same pause. Same rule as pause.ts's PAUSE_REASON_LABEL:
// shared phrasing, never a second vocabulary.

export interface BudgetFigures {
  totalCostUsd: number;
  estimatedUsd: number;
  maxBudgetUsd: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function fmtBudgetUsd(v: unknown): string {
  return `$${num(v).toFixed(2)}`;
}

/** supervisor.applyCostToNode adds an estimated booking to BOTH estimatedUsd and
 * totalCostUsd on the same path, so estimatedUsd is a SUBSET of the total and the
 * provider-reported share is the difference — clamped, never negative. */
export function budgetMeasuredUsd(f: BudgetFigures): number {
  return Math.max(0, num(f.totalCostUsd) - num(f.estimatedUsd));
}

/** "~$1.20 spent of the $1.00 cap" — the leading ~ is the honest signal that part of the
 * figure that tripped the guardrail was never billed. */
export function budgetSpendHeadline(f: BudgetFigures): string {
  const tilde = num(f.estimatedUsd) > 0 ? "~" : "";
  return `${tilde}${fmtBudgetUsd(f.totalCostUsd)} spent of the ${fmtBudgetUsd(f.maxBudgetUsd)} cap`;
}

/** "$0.90 reported by the provider, ~$0.30 estimated from token counts". The estimated share
 * is what makes a pause arguable, so it is never hidden — and the provider-reported figure
 * comes first because it is the part nobody can dispute. */
export function budgetSpendDetail(f: BudgetFigures): string {
  const est = num(f.estimatedUsd);
  return est > 0
    ? `${fmtBudgetUsd(budgetMeasuredUsd(f))} reported by the provider, ~${fmtBudgetUsd(est)} estimated from token counts`
    : "all of it reported by the provider";
}

/** Headline + detail in one sentence, for surfaces with room for a paragraph (confirm gate,
 * transcript line). Narrow surfaces render the two halves on their own rows instead. */
export function budgetSpendSplit(f: BudgetFigures): string {
  return `${budgetSpendHeadline(f)} — ${budgetSpendDetail(f)}`;
}

/** What a pause actually costs the operator. Says "this tree" deliberately: a budget is
 * per-tree, and an operator who reads it as "the fleet is down" over-reacts. */
export const BUDGET_PAUSE_SCOPE =
  "every agent in this tree is interrupted and new spawns in it are rejected; other trees keep running";

/** What pressing resume will and will NOT do. The cap never moves (core's resumeBudget never
 * writes maxBudgetUsd) and the release is one-shot: the watermark re-arms at whatever is booked
 * the instant it is released, so the guardrail bites again on the next real spend past it. */
export function budgetResumeEffect(f: BudgetFigures): string {
  return `Releasing does not raise the ${fmtBudgetUsd(f.maxBudgetUsd)} cap — it clears this pause once, then re-arms: the guardrail engages again as soon as new spend books past ${fmtBudgetUsd(f.totalCostUsd)}.`;
}

/** The three response facts the daemon's own note does NOT state. */
export interface BudgetResumeOutcome {
  resumed: boolean;
  maxBudgetUsd: number;
  blockedByAncestorNodeId: string | null;
  note: string;
}

/** The daemon's note carries the authoritative figures (the re-pause watermark is whatever was
 * booked server-side at the instant of release, which no UI can know beforehand), so it is
 * always surfaced VERBATIM — this only appends what the operator would otherwise have to guess:
 * that nothing was actually paused, or that an ancestor still holds the subtree down. */
export function budgetResumeToast(r: BudgetResumeOutcome): string {
  if (!r.resumed) {
    // maxBudgetUsd 0 ⇒ engine's "no budget node registered" reply, whose note already says it.
    return r.maxBudgetUsd > 0 ? `${r.note} · nothing was paused, so no pause was released` : r.note;
  }
  const blocked = r.blockedByAncestorNodeId;
  return blocked
    ? `${r.note} · ancestor ${blocked.slice(0, 8)} is still budget-paused — this tree stays blocked until that one is released too`
    : r.note;
}
