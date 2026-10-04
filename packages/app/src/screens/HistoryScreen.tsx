import { useEffect } from "react";
import type { RunHistoryRow, RunKind, RunOutcome } from "@chimera/protocol";
import {
  filterRuns,
  formatRunDuration,
  isRunHistoryFilterActive,
  RUN_HISTORY_BOOKED_NOTE,
  runHistoryClientFilter,
  runHistoryHeaderCounts,
  runHistoryRowDetail,
  runHistoryTeams,
  runHistoryTotalsLine,
  runHistoryTriggerLabel,
  runHistoryTruncationLine,
  type RunCostBasis,
} from "@chimera/ui-state";
import { onRowKeyDown } from "../a11y";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { getRunHistoryCommands, useRunHistoryState, RUN_HISTORY_WINDOWS, type RunHistoryWindow } from "../state/commands.runHistory";
import { Panel, PanelFooter } from "../components/Panel";
import styles from "./HistoryScreen.module.css";

const cost = (n: number) => `$${n.toFixed(2)}`;
const KIND_CHIPS: ReadonlyArray<[label: string, kind: RunKind]> = [["agents", "agent"], ["tasks", "task"], ["jobs", "job"]];
const OUTCOME_CHIPS: readonly RunOutcome[] = ["failed", "running", "done"];
// Plain wording for the cost column's two bases — "rolled-up" is jargon on a chip.
const BASIS_CHIPS: ReadonlyArray<[label: string, basis: RunCostBasis]> = [["billed here", "booked"], ["rolled up ↺", "rolled-up"]];
const WINDOW_WORDS: Record<RunHistoryWindow, string> = { "12h": "the last 12 hours", "24h": "the last 24 hours", "7d": "the last 7 days" };

const when = (ts: number): string => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Where a row can be opened — the two seams commands.runHistory.openRun knows about. */
const runTarget = (r: RunHistoryRow): string | null =>
  r.agentId ? "open this agent" : r.queue ? `open queue ${r.queue}` : null;

export function HistoryScreen() {
  // Resolved per render, not at module scope: the store is a module singleton, and a
  // test that drops it (__resetRunHistoryCommands) must get a live one back on the
  // next mount rather than a captured, stopped instance.
  const commands = getRunHistoryCommands(rpcCall, appStore);
  const state = useRunHistoryState((s) => s);
  // One history.runs on mount plus the 30s poll. The kind/outcome chips DO re-issue it
  // (F13.QA M-3 — those facets are server-side); every other chip is a free page re-filter.
  useEffect(() => { commands.start(); return () => commands.stop(); }, [commands]);
  // Newest first is the screen's own contract — a page is rendered in that order
  // whatever order the transport handed it back in.
  // kinds/outcome are stripped: the daemon already applied them over the whole window, and
  // re-applying them to this capped page would drop matches the totals still count.
  const rows = filterRuns(state.rows, runHistoryClientFilter(state.filter)).slice().sort((a, b) => b.startedAt - a.startedAt);
  // Header numbers come from the SERVER fold over every matched run (F13.QA M-4) and fall
  // back to the page only when a client-only chip narrows what is visible.
  const counts = runHistoryHeaderCounts(state.totals, rows, state.filter);
  const unseenAll = state.totals?.unseen ?? state.rows.reduce((n, r) => n + (r.unseen ? 1 : 0), 0);
  const teams = runHistoryTeams(state.rows);
  const filtered = isRunHistoryFilterActive(state.filter);
  // `matched` counts the server-side window, so it is only comparable to the whole page.
  const truncation = runHistoryTruncationLine(state.rows.length, state.matched);
  const chip = (active: boolean) => (active ? `${styles.chip} ${styles.active}` : styles.chip);
  return <Panel label={<>Run history <span className={styles.muted}>· {state.loading ? "refreshing…" : state.lastUpdated ? "live" : "waiting"}</span></>} className={styles.panel}>
    <div className={styles.subhead}>what the fleet did — agents, tasks and scheduled jobs, newest first</div>
    <div className={styles.toolbar}>
      {(Object.keys(RUN_HISTORY_WINDOWS) as RunHistoryWindow[]).map((w) => (
        <button key={w} className={chip(state.window === w)} onClick={() => commands.setWindow(w)}>{w}</button>
      ))}
      <span className={styles.sep} />
      {KIND_CHIPS.map(([label, kind]) => (
        <button key={kind} className={chip(state.filter.kinds.includes(kind))} onClick={() => commands.toggleKind(kind)}>{label}</button>
      ))}
      <span className={styles.sep} />
      {OUTCOME_CHIPS.map((o) => (
        <button key={o} className={chip(state.filter.outcome.includes(o))} onClick={() => commands.toggleOutcome(o)}>{o}</button>
      ))}
      <span className={styles.sep} />
      {BASIS_CHIPS.map(([label, basis]) => (
        <button key={basis} className={chip(state.filter.costBasis.includes(basis))} onClick={() => commands.toggleCostBasis(basis)}
          title={basis === "booked" ? "runs whose dollars the total counts" : "task/job rows restating their agents' dollars"}>{label}</button>
      ))}
      {teams.length > 0 && <span className={styles.sep} />}
      {teams.map((t) => (
        <button key={t} className={chip(state.filter.teams.includes(t))} onClick={() => commands.toggleTeam(t)} data-run-team={t}>{t}</button>
      ))}
      <span className={styles.spacer} />
      <input className={styles.search} value={state.filter.text} placeholder="search runs…" aria-label="search runs"
        onChange={(e) => commands.setText(e.target.value)} data-run-search="" />
      <button className={chip(state.filter.unseenOnly)} onClick={() => commands.toggleUnseenOnly()}>{`${unseenAll} new`}</button>
      {filtered && <button className={styles.chip} onClick={() => commands.clearFilters()} data-run-clear="">clear filters</button>}
      <button className={styles.chip} onClick={() => void commands.refresh()}>refresh</button>
    </div>
    <div className={styles.totals} data-run-totals="">{runHistoryTotalsLine(counts)}</div>
    {truncation && <div className={styles.banner} data-run-truncated="">{truncation}</div>}
    {state.error && (
      <div className={styles.error} data-run-error="">
        {`couldn't load run history — ${state.error}`}
        <button className={styles.chip} onClick={() => void commands.refresh()}>try again</button>
      </div>
    )}
    {state.coverage?.journalTruncated && (
      <div className={styles.banner} data-run-banner="">partial — the step journal was cut off at 2000 entries, so step counts and task costs are incomplete</div>
    )}
    <div className={styles.body}>
      <div className={styles.head}>when · what · triggered by · model · cost · took · outcome</div>
      <div className={styles.table}>
        {rows.map((r: RunHistoryRow) => {
          const target = runTarget(r);
          const failed = r.outcome === "failed" || r.outcome === "killed";
          return <div className={target ? `${styles.row} ${styles.clickable}` : styles.row} key={r.id}
            data-run-kind={r.kind} data-run-outcome={r.outcome} data-run-open={target ? "" : undefined}
            role={target ? "button" : undefined} tabIndex={target ? 0 : undefined} title={target ?? undefined}
            onClick={target ? () => void commands.openRun(r) : undefined}
            onKeyDown={target ? onRowKeyDown(() => void commands.openRun(r)) : undefined}>
            <span className={styles.muted}>{when(r.startedAt)}</span>
            <b>{r.subject}</b>
            <span className={styles.muted}>{runHistoryTriggerLabel(r.trigger)}</span>
            <span className={styles.muted}>{r.model ?? "—"}</span>
            <span title={r.costBasis === "rolled-up" ? "rolled up from this run's agents — not added to the total" : undefined}>
              {r.costBasis === "rolled-up" ? `${cost(r.costUsd)} ↺` : cost(r.costUsd)}
            </span>
            <span className={styles.muted}>{formatRunDuration(r.durationMs)}</span>
            <span>{r.outcome}</span>
            {/* A failed run with no visible WHY is the screen's worst state — the row
                grid has no column for it, so it gets its own line under the row. */}
            {failed && <span className={styles.reason} data-run-reason="">{runHistoryRowDetail(r)}</span>}
          </div>;
        })}
        {rows.length === 0 && !state.loaded && <div className={styles.empty} data-run-loading="">loading run history…</div>}
        {/* "nothing matched" is keyed off the FILTER, not off the page being empty (F13.QA
            M-3): a kind/outcome chip is applied server-side now, so an active filter can
            legitimately return zero rows — calling that "nothing ran" would be a lie. The
            "N ran" count only appears when the page still holds the unfiltered runs. */}
        {rows.length === 0 && state.loaded && filtered && (
          <div className={styles.empty} data-run-empty="">
            {state.rows.length > 0
              ? `no runs match these filters — ${state.rows.length} ran in ${WINDOW_WORDS[state.window]}`
              : `no runs match these filters in ${WINDOW_WORDS[state.window]}`}
            <button className={styles.chip} onClick={() => commands.clearFilters()}>clear filters</button>
          </div>
        )}
        {rows.length === 0 && state.loaded && !filtered && <div className={styles.empty} data-run-empty="">nothing ran in this window</div>}
      </div>
    </div>
    <PanelFooter>{RUN_HISTORY_BOOKED_NOTE}</PanelFooter>
  </Panel>;
}
