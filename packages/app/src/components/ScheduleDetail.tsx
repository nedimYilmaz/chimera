import { catchUpStalenessMs, deadLetterReasonLines, inFlightKeyLabel, inFlightLabel, inFlightRecovered, jobRunHistory, lastResultLabel, lateRunLabel, nextRunLabel, resultTone, retryProgressLabel, runOutcomeLabels, runReasonLabel, triggerTitle, runRetentionLabel, triggerLabel, wakeNotice, WAKE_HOLD_LABEL, type JobRow, type JobRunView } from "../state/selectors.jobs";
import { writeClipboard } from "../state/copyOnSelect";
import { appStore } from "../state/store";
import { MessageBody } from "./MessageBody";
import styles from "./ScheduleDetail.module.css";
import { useState } from "react";
import { filterScheduleRuns } from "../state/schedule-library";

// Same copy-with-receipt contract the invite blob and ResultCard use (writeClipboard +
// a "notice" toast): a click with no visible confirmation reads as a dead button.
function copyWithToast(text: string): void {
  void writeClipboard(text).then((ok) => {
    if (ok) appStore.dispatch({ type: "notice", message: `copied "${text}"` });
  });
}

function toneClassOf(result: string): string {
  const tone = resultTone(result);
  return tone === "success" ? styles.toneSuccess : tone === "danger" ? styles.toneDanger : styles.toneMuted;
}

function runRowClass(result: string): string {
  if (result === "failed") return styles.runRowDanger;
  if (result === "skipped") return styles.runRowMuted;
  return "";
}

function runGlyph(result: string): string {
  return result === "ok" ? "✓" : result === "failed" ? "✗" : "⊘";
}

// Schedule detail pane (user request: clicking a schedule shows its full detail
// on the right, like a queue does). Renders the JobRow the schedules panel
// already has PLUS the full job.status spec (prompt + precise schedule/tz),
// fetched by QueuesScreen when a schedule is focused. `spec` is null while the
// fetch is in flight — the summary fields (and the run history below) still
// render immediately from `row`/loading state.
export function ScheduleDetail({ row, spec, now, events, onOpenRun, error, onRetry }: {
  row: JobRow;
  spec: Record<string, unknown> | null;
  now: number;
  error?: string | null;
  onRetry?: () => void;
  /** F04.UI: the event feed, read ONLY to tell a re-adopted in-flight claim from a fresh one
   * (`job_run_started … readopted: true`). Optional so a caller without events still renders. */
  events?: ReadonlyArray<{ kind: string; data?: Record<string, unknown> | null }>;
  /** Click-through for a history row's agentId (defaults to the last run when
   * omitted by a caller that doesn't wire history navigation). */
  onOpenRun?: (run: JobRunView) => void;
}) {
  const toneClass = row.lastRun ? toneClassOf(row.lastRun.result) : styles.toneMuted;
  const tz = spec && typeof spec["tz"] === "string" ? (spec["tz"] as string) : null;
  const prompt = spec && typeof spec["prompt"] === "string" ? (spec["prompt"] as string) : null;
  const schedule = spec && typeof spec["schedule"] === "object" && spec["schedule"] !== null ? (spec["schedule"] as Record<string, unknown>) : null;
  const isCron = !!schedule && typeof schedule["cron"] === "string";
  // job.list's row already carries the newest run (JobRow.lastRun) — the full
  // history only needs the job.status fetch, so it renders as soon as `spec`
  // lands rather than waiting on a second round-trip.
  const runs = spec ? jobRunHistory(spec) : null;
  const wake = wakeNotice(spec, now);
  const inFlight = inFlightLabel(row, now);
  const inFlightKey = inFlightKeyLabel(row);
  const recovered = events ? inFlightRecovered(events, row) : false;
  const stalenessMs = catchUpStalenessMs(spec);
  const deadLettered = row.failure?.deadLetterAt != null;
  // F05.UI: one vocabulary for the outcome cell, computed once for the whole list because the
  // attempt number of a row depends on the failed runs newer than it.
  const outcomes = runs ? runOutcomeLabels(row, runs) : [];
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const visibleRuns = runs ? filterScheduleRuns(runs, filter, query) : null;

  return (
    <>
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <span className={row.enabled ? styles.enabled : styles.disabled}>{row.enabled ? "● enabled" : "○ disabled"}</span>
          <span className={styles.spacer} />
          <span className={styles.timeMeta}>{row.scheduleLabel}</span>
        </div>
        {/* QA UI-1: core's deadLetter() routes through disable(), so disabledReason carries the
            SAME sentence the failure block already spells out — showing both printed the reason
            twice. The dead-letter block wins; disabledReason only speaks for an ordinary disable. */}
        {row.disabledReason && !deadLettered ? <div className={styles.disabledReason}>{row.disabledReason}</div> : null}
        {deadLettered ? (
          <div className={styles.deadLetter}>
            <div className={styles.deadLetterHead}>
              ⚠ dead-lettered after {row.failure!.attempt} failed attempt{row.failure!.attempt === 1 ? "" : "s"} — schedule stopped · space requeues the next occurrence
            </div>
            <ul className={styles.deadLetterList}>
              {deadLetterReasonLines(row, now).map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          </div>
        ) : retryProgressLabel(row, now) ? (
          <div className={styles.disabledReason}>{retryProgressLabel(row, now)}</div>
        ) : null}
        {row.deliveryDroppedAt !== null ? (
          <div className={styles.disabledReason}>
            delivery removed {nextRunLabel(row.deliveryDroppedAt, now)} — this job still runs and bills, but its results go nowhere
          </div>
        ) : null}
      </div>

      <div className={styles.body}>
        {error && <div role="alert">Unable to load schedule details: {error} {onRetry && <button type="button" onClick={onRetry}>retry</button>}</div>}
        <dl className={styles.fields}>
          <dt>schedule</dt>
          <dd>{row.scheduleLabel}{isCron && tz ? <span className={styles.faint}> · {tz}</span> : null}</dd>

          <dt>next run</dt>
          <dd>{nextRunLabel(row.nextRunTs === null ? null : Math.max(row.nextRunTs, row.snoozedUntil ?? 0), now, row.watch)}</dd>
          {typeof spec?.snoozedUntil === "number" && spec.snoozedUntil > now && <><dt>snoozed until</dt><dd>{new Date(spec.snoozedUntil).toLocaleString()} — automatic delivery deferred; Run now overrides snooze</dd></>}

          {inFlight ? (
            <>
              <dt>in flight</dt>
              <dd>
                {inFlight}
                {recovered ? <span className={styles.recovered}> · recovered after restart</span> : null}
                {inFlightKey ? <div className={styles.faint}>{inFlightKey}</div> : null}
              </dd>
            </>
          ) : null}

          <dt>target</dt>
          <dd>{row.targetLabel}<span className={styles.faint}> · {row.targetKind}</span></dd>

          {row.targetKind === "existing" ? <>
            <dt>delivery</dt>
            <dd>Success means the prompt was accepted into the pinned agent's mailbox, not that the task finished. Uses its existing context, model and budget. Paused agents resume automatically; killed or missing agents disable the job.</dd>
          </> : null}

          <dt>last run</dt>
          <dd>
            <span className={toneClass}>{lastResultLabel(row.lastRun)}</span>
            {row.lastRun ? <span className={styles.faint}> · {nextRunLabel(row.lastRun.ts, now)}</span> : null}
          </dd>
        </dl>

        {wake ? (
          <div className={styles.wakeBlock}>
            <div className={wake.tone === "warn" ? styles.wakeNoticeWarn : styles.faint}>{wake.text}</div>
            {wake.command ? (
              <div className={styles.wakeSetup}>
                <code className={styles.wakeCmd}>{wake.command}</code>
                <button type="button" className={styles.wakeCopy} onClick={() => copyWithToast(wake.command!)} data-wake-copy title="copy the setup command">
                  copy
                </button>
              </div>
            ) : null}
            {wake.holding ? <div className={styles.wakeHold}>☕ {WAKE_HOLD_LABEL}</div> : null}
          </div>
        ) : null}
        <div className={styles.sectionHead}>
          <div className={styles.promptLabel}>run history</div>
          {runs !== null ? <span className={styles.faint}>{runRetentionLabel(runs.length)}</span> : null}
        </div>
        <div>
          <select aria-label="run outcome filter" value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="all">all outcomes</option><option value="ok">successful</option><option value="failed">failed</option><option value="skipped">skipped</option>
          </select>
          <input aria-label="search run history" placeholder="agent, error, trigger…" value={query} onChange={e => setQuery(e.target.value)} />
          {runs && <span>{visibleRuns?.length} / {runs.length} retained runs</span>}
        </div>
        {runs === null ? (
          <div className={`${styles.faint} ${styles.runList}`}>{error ? "history unavailable" : "loading…"}</div>
        ) : runs.length === 0 ? (
          <div className={`${styles.faint} ${styles.runList}`}>no runs yet</div>
        ) : visibleRuns?.length === 0 ? (
          <div className={`${styles.faint} ${styles.runList}`}>no runs match these filters</div>
        ) : (
          <ul className={styles.runList}>
            {visibleRuns!.map((run, i) => (
              <li key={`${run.ts}-${i}-${run.taskId ?? run.agentId ?? ""}`} className={`${styles.runRow} ${runRowClass(run.result)} ${run.trigger === "sleep-wake" ? styles.runRowLate : ""}`}>
                <span className={styles.runWhen}>{nextRunLabel(run.ts, now)}</span>
                <span className={styles.runTrigger} title={triggerTitle(run)}>{triggerLabel(run)}</span>
                <span className={toneClassOf(run.result)}>{runGlyph(run.result)} {outcomes[runs.indexOf(run)]}</span>
                <span className={styles.runCost}>${run.costUsd.toFixed(2)}</span>
                {run.agentId ? (
                  <button type="button" className={styles.runAgent} onClick={() => onOpenRun?.(run)} title="open agent">
                    {run.agentId}
                  </button>
                ) : run.taskId ? (
                  // QA UI-4: a team-target run has no agentId at all (the task fans out to the
                  // team), so the history row used to dead-end. The taskId is the only handle back
                  // into that run — copyable, since there is no task route to open.
                  <button type="button" className={styles.runAgent} onClick={() => copyWithToast(run.taskId!)} title="copy task id">
                    task {run.taskId}
                  </button>
                ) : null}
                {lateRunLabel(run) ? <div className={styles.runLate}>{lateRunLabel(run)}</div> : null}
                {runReasonLabel(run, stalenessMs) ? <div className={styles.runReason}>{runReasonLabel(run, stalenessMs)}</div> : null}
                {run.error ? <div className={styles.runError} title={run.error}>{run.error}</div> : null}
              </li>
            ))}
          </ul>
        )}

        <div className={styles.promptLabel}>prompt</div>
        {prompt !== null ? (
          <MessageBody text={prompt} done rawView={false} />
        ) : (
          <div className={styles.faint}>loading…</div>
        )}
      </div>
    </>
  );
}
