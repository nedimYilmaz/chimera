import { ctxPct, fmtTokens } from "../state/selectors";
import styles from "./ContextRing.module.css";

/** Prompt occupancy, never cumulative/billable token usage. */
export function ContextRing({ used, limit, compacting, compactions, lastCompactedAt, onCompact, pending, disabled }: {
  used: number | null; limit: number; compacting?: boolean; compactions?: number; lastCompactedAt?: number; onCompact?: () => void; pending?: boolean; disabled?: boolean;
}) {
  const known = used !== null && limit > 0;
  const percent = known ? ctxPct(used, limit) : null;
  const tone = compacting ? "compacting" : percent === null ? "unknown" : percent >= 90 ? "danger" : percent >= 70 ? "warning" : "normal";
  const title = `Current prompt: ${used === null ? "unknown" : fmtTokens(used)} / effective limit: ${limit > 0 ? fmtTokens(limit) : "unknown"}. Includes cached input, not cumulative usage.${compacting ? " Compacting context…" : ""}${compactions ? ` Compacted ${compactions}×${lastCompactedAt ? `; last ${new Date(lastCompactedAt).toLocaleTimeString()}` : ""}.` : ""}`;
  const meter = <div className={styles.ring} data-context-ring data-tone={tone}
    role="meter" aria-label="Context usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
    aria-valuetext={known ? `${percent}%${compacting ? ", compacting" : ""}` : "Context unknown"} aria-busy={!!compacting} title={title}>
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <circle className={styles.track} cx="20" cy="20" r="17" />
      <circle className={styles.fill} cx="20" cy="20" r="17" pathLength="100" strokeDasharray={`${percent ?? 0} 100`} transform="rotate(-90 20 20)" />
      {compacting && <circle className={styles.spinner} cx="20" cy="20" r="17" pathLength="100" strokeDasharray="20 80" />}
    </svg>
    <span className={styles.percent}>{known ? `${percent}%` : "?"}</span>
    {!known && <span className={styles.srOnly}>unknown</span>}
    {!!compactions && <span key={compactions} className={styles.count} data-compactions={compactions} aria-label={`Compacted ${compactions} times`}>{compactions}</span>}
  </div>;
  return onCompact ? <button type="button" className={styles.action} aria-label="compact context now"
    title={compacting || pending ? "Compacting context — wait for completion" : "Compact context now"}
    disabled={!!(disabled || compacting || pending)} aria-busy={!!(compacting || pending)} data-active={!!(compacting || pending)}
    data-transcript-action="system.compact" onClick={onCompact}>{meter}</button> : meter;
}
