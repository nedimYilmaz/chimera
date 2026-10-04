import { useEffect, useSyncExternalStore } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { SeriesChart } from "./MessageBody";
import { registerOverlay } from "./OverlayOutlet";
import { isEditableTarget, registerActionHandler } from "../keymap";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { exportCsv, rpcCall } from "../rpc/bridge";
import { getUsageCommands, type UsageBarsGroupBy } from "../state/commands.usage";
import { usageRowValueLabel } from "../state/selectors.usage";
import { fmtCost, spendMeter, totalSpendUsd } from "../state/selectors";
import { spendTone, useSystemLocal } from "../state/commands.system";
import styles from "./UsageCard.module.css";

// W21 (F19 · coverage §B23/§C17) — the usage & cost card, opened from the
// SpendChip: today meter (F01 cap-color thresholds, SAME spendToday/cap
// source as SpendChip so the two numbers can never drift), 7-day trend (the
// F12/W14 SeriesChart renderer, reused verbatim), groupBy bars (team/account/
// model), top-5 runs by cost, a job:<name> tag row, `x` csv export. Every
// displayed number traces back to one of the THREE usage.query calls
// commands.usage.ts's refresh() fires per open/groupBy-change — nothing here
// re-sums or re-derives a total client-side.

const GROUP_BYS: readonly UsageBarsGroupBy[] = ["team", "account", "model"];

function UsageCard() {
  const cmds = getUsageCommands(appStore, rpcCall, exportCsv);
  const state = useSyncExternalStore(cmds.subscribe, cmds.getState);

  // identical computation to TopBarChips' SpendChip (selectors.ts/
  // commands.system.ts) — the done-when rule is literal equality, not "close
  // enough", so this must be the SAME expression, not a re-derivation.
  const sessionSpend = useStore(totalSpendUsd);
  const spendToday = useSystemLocal((s) => s.spendTodayUsd);
  const dailyCap = useSystemLocal((s) => s.dailyCapUsd);
  const spend = spendToday ?? sessionSpend;
  const cap = dailyCap ?? 10;
  const meter = spendMeter(spend, cap);
  const tone = spendTone(spend, cap);
  const toneClass = tone === "danger" ? styles.meterDanger : tone === "warn" ? styles.meterWarn : styles.meterOk;

  // the SpendChip's opener / re-toggle (mirrors notify.toggle's self-owned
  // registration — this card is Tauri-only, so it doesn't join a keymap row).
  useEffect(() => registerActionHandler("system.usage", () => cmds.toggle()), [cmds]);

  // `x` while the card is open (HostToolsCard/NotifyRulesCard capture-phase
  // convention) — suspended over editable targets so it never fires mid-typing.
  useEffect(() => {
    if (!state.open) return undefined;
    const onKey = (ev: KeyboardEvent): void => {
      if (isEditableTarget(ev.target)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key.toLowerCase() === "x") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        void cmds.exportSelectedCsv();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [state.open, cmds]);

  if (!state.open) return null;

  const maxGroupCost = Math.max(1, ...state.groups.map((g) => g.costUsd));

  return (
    <OverlayCard width={620} align="center" onClose={() => cmds.escape()}>
      <div data-usage-card>
        <OverlayCardHeader title="usage & cost" hint={<span>x export csv · esc close</span>} />

        <div className={styles.section}>
          <div className={styles.sectionLabel}>today</div>
          <div className={styles.meterRow} data-usage-today-meter>
            <span className={toneClass}>{fmtCost(spend)}</span>
            <span className={styles.faint}>/{Number.isInteger(cap) ? cap : cap.toFixed(2)}</span>
            <span className={toneClass}>{meter.fill}</span>
            <span className={styles.meterEmpty}>{meter.empty}</span>
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>7-day trend</div>
          {state.trend.length > 0 ? (
            <SeriesChart
              chartType="line"
              labels={state.trend.map((b) => b.day.slice(5))}
              series={[{ name: "spend", points: state.trend.map((b) => b.costUsd) }]}
              unit="$"
            />
          ) : (
            <div className={styles.emptyHint}>{state.loading ? "loading…" : "no usage in the last 7 days"}</div>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.groupHead}>
            <span className={styles.sectionLabel}>by</span>
            {GROUP_BYS.map((g) => (
              <span
                key={g}
                className={g === state.groupBy ? styles.groupChipActive : styles.groupChip}
                onClick={() => cmds.setGroupBy(g)}
                data-usage-groupby={g}
              >
                {g}
              </span>
            ))}
            <span className={styles.footSpacer} />
            <span className={styles.faint} data-usage-total>total {fmtCost(state.totalCostUsd)}</span>
          </div>
          <div className={styles.rows} data-usage-groups>
            {state.groups.length === 0 ? (
              <div className={styles.emptyHint}>{state.loading ? "loading…" : "no usage in the last 7 days"}</div>
            ) : (
              state.groups.map((g) => (
                <div key={g.key} className={styles.barRow}>
                  <span className={styles.barLabel} title={g.key}>{g.key}</span>
                  <span className={styles.barTrack}>
                    <span className={styles.barFill} style={{ width: `${(g.costUsd / maxGroupCost) * 100}%` }} />
                  </span>
                  <span className={styles.barValue}>{usageRowValueLabel(g)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>top 5 runs</div>
          <div className={styles.rows} data-usage-top-runs>
            {state.topRuns.length === 0 ? (
              <div className={styles.emptyHint}>no runs in the last 7 days</div>
            ) : (
              state.topRuns.map((r) => (
                <div key={r.key} className={styles.runRow}>
                  <span className={styles.runLabel} title={r.key}>{r.key}</span>
                  <span className={styles.runValue}>{usageRowValueLabel(r)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>jobs</div>
          <div className={styles.jobsRow} data-usage-jobs>
            {state.jobs.length === 0 ? (
              <span className={styles.emptyHint}>no job runs in the last 7 days</span>
            ) : (
              state.jobs.map((j) => (
                <span key={j.key} className={styles.jobTag} data-usage-job={j.key}>
                  job:{j.key} <span className={styles.faint}>{usageRowValueLabel(j)}</span>
                </span>
              ))
            )}
          </div>
        </div>

        <div className={styles.footer}>
          <span className={styles.chip} onClick={() => void cmds.exportSelectedCsv()} data-usage-export>
            <span className={styles.chipKey}>x</span> export csv
          </span>
          <span className={styles.chip} onClick={() => { cmds.escape(); appStore.dispatch({ type: "selectTab", tab: "slo" }); }} data-usage-open-slo>
            fleet SLO →
          </span>
          <span className={styles.footSpacer} />
          <span className={styles.footNote}>every number traces to one usage.query response</span>
        </div>
      </div>
    </OverlayCard>
  );
}

registerOverlay("system.usage", UsageCard, () => {
  const cmds = getUsageCommands(appStore, rpcCall, exportCsv);
  if (cmds.getState().open) cmds.escape();
});
