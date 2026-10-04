import { budgetMeasuredUsd } from "@chimera/ui-state";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { useSystemLocal } from "../state/commands.system";
import { budgetPauseForSelected } from "../state/selectors.system";
import { fmtCost } from "../state/selectors";
import { BANNERS } from "../copy";
import styles from "./BudgetPauseBanner.module.css";

// W6 build item 8 — the BudgetPauseBanner (mock showBudgetPause, lines
// 446-448; coverage A6-3): the danger strip shown when the SELECTED agent's
// tree breached its maxBudgetUsd — the supervisor emits ONE status event
// {paused:true, reason:"budget", treeId, totalCostUsd, maxBudgetUsd} and
// interrupts the tree's runners. F50: a genuine over-cap pause is released
// only by the operator-only budget.resume RPC (this banner's button); the
// derived (token-only) share of the spend is disclosed via estimatedUsd.
// F50.UI: the strip answers all four operator questions in reading order —
// what is paused, what that costs (booked vs estimated), what the cap is, and
// what releasing does — and the button OPENS THE CONFIRM instead of releasing:
// budget.resume is audited and re-arms the watermark at release time, so the
// release itself must be a deliberate second act (QA F50 finding 5).
export function BudgetPauseBanner() {
  // useStore's referential-stability contract: select a PRIMITIVE key (the
  // selector builds a fresh object per call), parse it after.
  const pauseKey = useStore((s) => {
    const p = budgetPauseForSelected(s);
    return p ? `${p.treeId}|${p.maxBudgetUsd}|${p.totalCostUsd}|${p.estimatedUsd}|${p.afterResume}` : null;
  });
  // The confirm card is rendered by AgentsScreen (SystemStrips, this banner's host, is an
  // absolutely-positioned overlay — a card opened from here would mis-position), so the
  // button's own "already asked / already firing" state comes from the store, not local state.
  const confirmOpen = useStore((s) => s.confirm?.kind === "resumeBudget");
  const inFlight = useSystemLocal((s) => s.budgetResumeInFlight !== null);
  if (pauseKey === null) return null;
  const [treeId, maxBudgetUsdStr, totalCostUsdStr, estimatedUsdStr, afterResumeStr] = pauseKey.split("|");
  const maxBudgetUsd = Number(maxBudgetUsdStr);
  const totalCostUsd = Number(totalCostUsdStr);
  const estimatedUsd = Number(estimatedUsdStr);
  const afterResume = afterResumeStr === "true";
  const busy = inFlight || confirmOpen;

  const askResume = (): void => {
    if (busy) return;
    appStore.dispatch({
      type: "confirm",
      confirm: {
        kind: "resumeBudget",
        treeId: treeId ?? "",
        label: (treeId ?? "").slice(0, 8),
        totalCostUsd,
        estimatedUsd,
        maxBudgetUsd,
      },
    });
  };

  return (
    <div className={styles.banner} data-budget-pause>
      {estimatedUsd > 0 ? "▮ tree spent ~" : "▮ tree spent "}
      <b>{fmtCost(totalCostUsd)}</b> of <b>{fmtCost(maxBudgetUsd)}</b> budget —{" "}
      <b>tree paused</b>{" "}
      <span className={styles.dim}>
        {BANNERS.budgetPauseDetail}
        {/* estimatedUsd is a SUBSET of totalCostUsd, so the booked share is the difference —
            the split is what makes an arguable pause auditable from the strip alone. */}
        {estimatedUsd > 0 ? ` ${BANNERS.budgetMeasuredDetail(fmtCost(budgetMeasuredUsd({ totalCostUsd, estimatedUsd, maxBudgetUsd })))}` : ""}
        {estimatedUsd > 0 ? ` ${BANNERS.budgetEstimatedDetail(fmtCost(estimatedUsd))}` : ""}
        {afterResume ? ` ${BANNERS.budgetRePaused}` : ""}
      </span>
      <button type="button" className={styles.action} onClick={askResume} disabled={busy} aria-busy={inFlight}>
        {inFlight ? BANNERS.budgetResumeInFlight : BANNERS.budgetResumeAction}
      </button>
    </div>
  );
}
