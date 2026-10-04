import { useMemo, useState } from "react";
import type { UiState } from "@chimera/ui-state";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { agentCommands } from "../state/commands.agents";
import { rpcCall } from "../rpc/bridge";
import { fmtCost, fmtTokens, isTerminalState } from "../state/selectors";
import { fleetRows, fleetSummary, groupFleetRows, queuePressure, type FleetGroupBy, type FleetRow } from "../state/selectors.fleet";
import styles from "./FleetDashboard.module.css";

export function FleetDashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const state = useStore((s: UiState) => s);
  const [groupBy, setGroupBy] = useState<FleetGroupBy>("team");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // R2 UI REWORK: which groups' collapsed "+N done" tail is expanded, keyed
  // by `${groupBy}:${group.key}` — the SAME group key can appear under a
  // different groupBy dimension (a team and a project sharing a name), so the
  // groupBy prefix avoids an accidental cross-dimension collision.
  const [expandedDone, setExpandedDone] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => fleetRows(state, Date.now()), [state]);
  const groups = useMemo(() => groupFleetRows(rows, groupBy), [rows, groupBy]);
  const pressure = useMemo(() => queuePressure(state), [state]);
  const summary = useMemo(() => fleetSummary(rows, state), [rows, state]);
  const commands = useMemo(() => agentCommands(appStore, rpcCall), []);
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleDone = (key: string) => setExpandedDone((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const renderRow = (row: FleetRow) => <div key={row.agentId} className={row.attention ? styles.rowAttention : styles.row}>
    <input aria-label={`select ${row.agentId}`} type="checkbox" checked={selected.has(row.agentId)} onChange={() => toggle(row.agentId)} />
    <button className={styles.name} onClick={() => onOpen(row.agentId)}>{row.agent.conductor ? row.agent.projectId ?? "main" : row.agentId.slice(0, 8)}</button>
    <span>{row.state}{row.stalled ? " · stalled" : ""}</span><span>{row.queue ?? "—"}</span><span>{fmtCost(row.costUsd)}</span><span>{fmtTokens(row.tokens)}</span>
  </div>;
  return <section className={styles.root} aria-label="fleet dashboard">
    <div className={styles.main}>
      <header className={styles.toolbar}>
        <strong>fleet command</strong>
        {(["project", "team", "workflow", "tree", "engine"] as const).map((g) => <button key={g} className={g === groupBy ? styles.active : ""} onClick={() => setGroupBy(g)}>{g}</button>)}
        <span className={styles.spacer} />
        <span>{rows.filter((r) => r.agent.busy).length}/{rows.filter((r) => r.agent.state === "running").length} utilized</span>
        <span>{fmtCost(rows.reduce((n, r) => n + r.costUsd, 0))}</span>
      </header>
      <div className={styles.subtitle}>live fleet operations — agents grouped by {groupBy}; select rows to pause/interrupt</div>
      {pressure.length > 0 && <div className={styles.pressure}>queue pressure · {pressure.map((q) => `${q.queue} ${q.pending}p/${q.blocked}b/${q.inProgress}r`).join(" · ")}</div>}
      <div className={styles.columnHeader}><span /><span /><span>state</span><span>queue</span><span>cost</span><span>tokens</span></div>
      <div className={styles.legend}>group: busy/running · utilization% · ⚠ stalled · cost · tokens</div>
      <div className={styles.body}>
        {groups.map((group) => {
          const groupKey = `${groupBy}:${group.key}`;
          const active = group.rows.filter((r) => !isTerminalState(r.state));
          const done = group.rows.filter((r) => isTerminalState(r.state));
          const doneOpen = expandedDone.has(groupKey);
          return <div key={group.key} className={styles.group}>
            <div className={styles.groupHead}><strong>{group.key}</strong><span>{group.busy}/{group.running} · {Math.round(group.utilization * 100)}%</span><span>{group.stalled ? `⚠ ${group.stalled}` : ""}</span><span>{fmtCost(group.costUsd)} · {fmtTokens(group.tokens)}</span></div>
            {active.map(renderRow)}
            {done.length > 0 && <button className={styles.doneToggle} aria-expanded={doneOpen} onClick={() => toggleDone(groupKey)}>{doneOpen ? "hide done" : `+${done.length} done`}</button>}
            {doneOpen && done.map(renderRow)}
          </div>;
        })}
      </div>
      {/* OPERATOR-HOLD: "hold" and "release" are a pair and read as one — hold stops the selection
          without losing it, release puts it back to work. "interrupt" stays beside them because it
          is a genuinely different act: abort this turn and let the agent carry on. */}
      {selected.size > 0 && <div className={styles.bulk} aria-live="polite">
        <strong>{selected.size} selected</strong>
        <button onClick={() => void commands.bulkPause([...selected])} title="abort the turn, requeue its input, park the session — resumable, nothing lost">hold</button>
        <button onClick={() => void commands.bulkRelease([...selected])} title="resume held agents with full context and deliver what queued while they were held">release</button>
        <button onClick={() => void commands.bulkInterrupt([...selected])} title="abort only the in-flight turn — the agent keeps running">interrupt</button>
        <button onClick={() => setSelected(new Set())}>clear</button>
      </div>}
    </div>
    <aside className={styles.summary} aria-label="fleet summary">
      <div className={styles.summaryHeading}>fleet summary · {summary.total} agents</div>
      <div className={styles.summarySection}>
        {Object.entries(summary.byState).map(([st, n]) => <div key={st} className={styles.summaryRow}><span>{st}</span><span>{n}</span></div>)}
      </div>
      <div className={styles.summaryRow}>{summary.busy}/{summary.running} running busy · {Math.round(summary.utilization * 100)}% utilization</div>
      <div className={styles.summaryRow}>{summary.stalled > 0 ? `⚠ ${summary.stalled} stalled` : "no stalled agents"}</div>
      <div className={styles.summarySection}>
        <div className={styles.summaryHeading}>cost · {fmtCost(summary.costUsd)}</div>
        {summary.costByProvider.map((p) => <div key={p.key} className={styles.summaryRow}><span>{p.key}</span><span>{fmtCost(p.costUsd)}</span></div>)}
      </div>
      <div className={styles.summarySection}>
        <div className={styles.summaryHeading}>top queues</div>
        {summary.topQueues.length === 0 ? <div className={styles.summaryRow}>no queue pressure</div> : summary.topQueues.map((q) => <div key={q.queue} className={styles.summaryRow}><span>{q.queue}</span><span>{q.pending}p/{q.blocked}b/{q.inProgress}r</span></div>)}
      </div>
      <div className={styles.summarySection}>
        <div className={styles.summaryHeading}>by team</div>
        {summary.byTeam.map((t) => <div key={t.key} className={styles.summaryRow}><span>{t.key}</span><span>{t.count} · {fmtCost(t.costUsd)}</span></div>)}
      </div>
      <div className={styles.summarySection}>
        <div className={styles.summaryHeading}>by project</div>
        {summary.byProject.map((p) => <div key={p.key} className={styles.summaryRow}><span>{p.key}</span><span>{p.count} · {fmtCost(p.costUsd)}</span></div>)}
      </div>
    </aside>
  </section>;
}
