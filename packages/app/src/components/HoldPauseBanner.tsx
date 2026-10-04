import { useEffect, useState } from "react";
import { useStore } from "../state/useStore";
import { holdPauseForSelected } from "../state/selectors.system";
import { relativeLabel } from "../state/selectors.jobs";
import { BANNERS } from "../copy";
import styles from "./HoldPauseBanner.module.css";

// idea-backlog "pause reasons invisible in UI": supervisor.ts's session-limit HOLD,
// crash-loop backoff, and reattach-recovery pauses all render as a bare "paused"
// state word (AgentList/Liveboard) with no reason and no ETA — the user has to go
// dig through the transcript/daemon logs to find out why an agent stopped and
// when (if ever) it'll come back. Mirrors BudgetPauseBanner's mechanics (same
// SystemStrips slot, same useStore primitive-key idiom) but for the THREE
// reasons that auto-resume, so this one also shows a live countdown to resume.
export function HoldPauseBanner() {
  const pauseKey = useStore((s) => {
    const p = holdPauseForSelected(s);
    return p ? `${p.reason}|${p.resumeScheduledAt ?? ""}|${p.detail ?? ""}` : null;
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pauseKey === null) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [pauseKey]);

  if (pauseKey === null) return null;
  const [reason, resumeScheduledAtStr, detail] = pauseKey.split("|");
  const resumeScheduledAt = resumeScheduledAtStr ? Number(resumeScheduledAtStr) : null;
  const label = BANNERS.holdPauseLabel[reason ?? ""] ?? reason;
  const eta = resumeScheduledAt ? relativeLabel(resumeScheduledAt - now) : null;

  return (
    <div className={styles.banner} data-hold-pause>
      ▮ <b>{label}</b> — agent paused{eta ? <> · resumes {eta}</> : null}
      {detail ? <span className={styles.dim}> · {detail}</span> : null}
    </div>
  );
}
