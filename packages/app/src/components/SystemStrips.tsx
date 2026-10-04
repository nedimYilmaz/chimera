import type { OverlayProps } from "./OverlayOutlet";
import { registerOverlay } from "./OverlayOutlet";
import { BudgetPauseBanner } from "./BudgetPauseBanner";
import { HoldPauseBanner } from "./HoldPauseBanner";
import { ReplayBar } from "./ReplayBar";
import styles from "./SystemStrips.module.css";

// W6 — the right-column system STRIPS (mock: showBudgetPause + showReplay sit
// between the transcript and the composer band). Mounted through the shared
// OverlayOutlet like the cards (never editing a screen file); positioned
// absolutely at the pane bottom, lifted above the composer band by the
// outlet's bottomInset. One wrapper renders both so they stack in mock order
// (budget banner above the replay bar). Each child returns null when closed.
// HoldPauseBanner (idea-backlog "pause reasons invisible in UI") sits beside
// BudgetPauseBanner — the two are mutually exclusive per agent (budget vs.
// session-limit/crash-loop/reattach), so at most one ever renders at once.
function SystemStrips({ bottomInset }: OverlayProps) {
  return (
    <div className={styles.strips} style={{ bottom: bottomInset }} data-system-strips>
      <BudgetPauseBanner />
      <HoldPauseBanner />
      <ReplayBar />
    </div>
  );
}

registerOverlay("system.strips", SystemStrips);
