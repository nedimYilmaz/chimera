import { useState } from "react";
import { appStore } from "../state/store";
import { rpcCall } from "../rpc/bridge";
import { getSloCommands, useSloState } from "../state/commands.slo";
import { fmtMs, formatMetricValue, metricLabel, taskDeepLink, SLO_WINDOWS } from "../state/selectors.slo";
import { Panel, PanelFooter } from "../components/Panel";
import { ConfirmCard } from "../components/ConfirmCard";
import { CONFIRMS } from "../copy";
import styles from "./SloScreen.module.css";

const commands = getSloCommands(rpcCall);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const cost = (n: number) => `$${n.toFixed(2)}`;

export function SloScreen() {
  const state = useSloState((s) => s);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const sli = state.sli;
  const usage = state.usage;
  const gateN = (sli?.totals.gatePasses ?? 0) + (sli?.totals.gateFailures ?? 0);
  const oldest = sli ? Math.max(0, ...sli.tasks.map((t) => t.activeAgeMs ?? 0)) : null;
  const tiles = [
    ["throughput", sli ? `${sli.totals.completedTasks}` : "—", "completed tasks"],
    ["p95 latency", fmtMs(sli?.totals.p95DurationMs ?? null), `${sli?.totals.latencySamples ?? 0} samples`],
    ["oldest active", oldest === null ? "—" : fmtMs(oldest), `${sli?.totals.activeTasks ?? 0} active`],
    ["turn errors", sli ? pct(sli.totals.errorRate) : "—", `${sli?.totals.errorCount ?? 0}/${sli?.totals.turnCount ?? 0}`],
    ["gate failures", sli && gateN ? pct(sli.totals.gateFailures / gateN) : "—", `${sli?.totals.gateFailures ?? 0}/${gateN}`],
    ["tokens", sli ? `${(sli.totals.tokensIn + sli.totals.tokensOut).toLocaleString()}` : "—", "input + output"],
    ["spend", usage ? cost(usage.totalCostUsd) : "—", state.window],
  ];
  const tasks = [...(sli?.tasks ?? [])].sort((a, b) => (b.activeAgeMs ?? b.durationMs ?? 0) - (a.activeAgeMs ?? a.durationMs ?? 0)).slice(0, 12);
  return <Panel label={<>fleet SLO & spend <span className={styles.muted}>· {state.loading ? "refreshing…" : state.lastUpdated ? "live" : "waiting"}</span></>} className={styles.panel}>
    <div className={styles.toolbar}>
      {Object.keys(SLO_WINDOWS).map((w) => <button key={w} className={state.window === w ? styles.active : ""} onClick={() => commands.setWindow(w as keyof typeof SLO_WINDOWS)}>{w}</button>)}
      <span className={styles.spacer}/>
      {(["team", "provider", "workflow"] as const).map((g) => <button key={g} className={state.groupBy === g ? styles.active : ""} onClick={() => commands.setGroupBy(g)}>{g}</button>)}
      <button onClick={() => void commands.refresh()}>refresh</button>
    </div>
    {state.error && <div className={styles.error}>{state.error}</div>}
    <div className={styles.body}>
      <div className={styles.tiles}>{tiles.map(([label, value, detail]) => <div className={styles.tile} key={label}><div className={styles.muted}>{label}</div><strong>{value}</strong><small>{detail}</small></div>)}</div>
      <div className={styles.grid}>
        <section><h3>by {state.groupBy}</h3><div className={styles.table}>
          {(sli?.breakdown ?? []).map((r) => <div className={styles.row} key={r.key}><b>{r.key}</b><span>{r.taskCount} tasks</span><span>{pct(r.turnCount ? r.errorCount / r.turnCount : 0)} errors</span><span>{cost(r.costUsd)}</span></div>)}
          {!sli?.breakdown.length && <div className={styles.empty}>no SLI samples in this window</div>}
        </div></section>
        <section><h3>task outliers</h3><div className={styles.table}>
          {tasks.map((t) => <button className={styles.task} key={t.taskId} onClick={() => appStore.dispatch({ type: "navigate", target: taskDeepLink(t) })}>
            <b>{t.taskId.slice(0, 12)}</b><span>{t.workflow ?? "unbound"}</span><span>{t.activeAgeMs !== null ? `active ${fmtMs(t.activeAgeMs)}` : fmtMs(t.durationMs)}</span><span>{pct(t.errorRate)}</span>
          </button>)}
        </div></section>
      </div>
      <section><h3>workflow step heatmap</h3><div className={styles.heatmap}>
        {(sli?.tasks.flatMap((t) => t.steps.map((s) => ({ ...s, taskId: t.taskId }))).slice(0, 40) ?? []).map((s) => <span key={`${s.taskId}:${s.stepIndex}`} title={`${s.taskId} · ${fmtMs(s.durationMs)} · ${s.gateFailures} gate failures`} style={{ opacity: Math.max(.3, Math.min(1, s.durationMs / 60_000)) }}>{s.stepId ?? `step ${s.stepIndex + 1}`} {s.gateFailures ? `×${s.gateFailures}` : "✓"}</span>)}
      </div></section>
      <section><h3>saved thresholds</h3><div className={styles.thresholds}>
        {state.thresholds.map((t) => <span key={t.id}>{metricLabel(t.metric)} &gt; {formatMetricValue(t.metric, t.limit)} · {t.window}
          <button aria-label={`delete ${t.id}`} onClick={() => setConfirmDeleteId(t.id)}>×</button></span>)}
        <button onClick={() => void commands.saveThresholds([...state.thresholds, { id: `p95-${Date.now()}`, metric: "p95_latency_ms", limit: 300_000, window: state.window, enabled: true }])}>+ p95 &gt; 5m</button>
        <button onClick={() => void commands.saveThresholds([...state.thresholds, { id: `errors-${Date.now()}`, metric: "error_rate", limit: .1, window: state.window, enabled: true }])}>+ errors &gt; 10%</button>
      </div></section>
    </div>
    <PanelFooter>time-windowed daemon rollups · click a task to inspect transcript and evidence</PanelFooter>
    {confirmDeleteId !== null && (() => {
      const hit = state.thresholds.find((t) => t.id === confirmDeleteId);
      const label = hit ? `${metricLabel(hit.metric)} > ${formatMetricValue(hit.metric, hit.limit)}` : confirmDeleteId;
      return <ConfirmCard
        title="⚠ delete threshold"
        meta={confirmDeleteId}
        body={CONFIRMS.deleteThreshold(label).body}
        note={CONFIRMS.deleteThreshold(label).note}
        confirmLabel="confirm delete"
        onConfirm={() => {
          const id = confirmDeleteId;
          setConfirmDeleteId(null);
          void commands.saveThresholds(state.thresholds.filter((x) => x.id !== id));
        }}
        onClose={() => setConfirmDeleteId(null)}
      />;
    })()}
  </Panel>;
}
