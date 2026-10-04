import { useEffect, useMemo } from "react";
import type { UiState } from "@chimera/ui-state";
import { registerActionHandler } from "../keymap";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall } from "../rpc/bridge";
import { getProjectsCommands, projectsLocal, useProjectsLocal } from "../state/commands.projects";
import { a2aFeed, fmtAgo, type A2AExchange } from "../state/selectors.projects";
import { agentName } from "../state/selectors";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { HINTS } from "../copy";
import styles from "./A2ATicker.module.css";

// A2A-UX-OVERHAUL · PART 1 — the pinned ⇄ a2a ticker BAR that used to sit above the
// composer is retired: inter-agent traffic now surfaces as the ephemeral
// live-traffic indicator at the BOTTOM of the AgentList panel (see AgentList), and
// the FULL history is THIS overlay. It opens from the command palette ("a2a
// history") or the keybinding — the action handler is registered UNCONDITIONALLY
// (was gated on a non-empty feed while the bar existed) so the entry point is live
// from the first frame. The component renders ONLY the overlay; it stays mounted in
// AgentsScreen purely to host the overlay + keep that handler registered. An
// exchange row still drills into the RECEIVING agent's transcript.

const HISTORY_MAX = 30;
const KIND_GLYPH = { send: "→→", question: "?→", answer: "↩" } as const;

function nameOf(id: string): string {
  return id === "main" ? "main" : agentName(id);
}

export function A2ATicker() {
  const commands = getProjectsCommands(appStore, rpcCall);
  const events = useStore((s: UiState) => s.events);
  const historyOpen = useProjectsLocal((s) => s.a2aHistoryOpen);
  const history = useMemo(() => (historyOpen ? a2aFeed(events, HISTORY_MAX) : []), [events, historyOpen]);
  const now = Date.now();

  // The keybinding (rows.projects.ts) + the palette command both dispatch through
  // runAction("a2a.history", …); register the handler here, unconditionally, so it
  // survives an empty feed (unlike the old bar which unmounted when idle).
  useEffect(() => registerActionHandler("a2a.history", () => {
    projectsLocal.set({ a2aHistoryOpen: !projectsLocal.getState().a2aHistoryOpen });
  }), []);

  const openTurn = (x: A2AExchange): void => {
    projectsLocal.set({ a2aHistoryOpen: false });
    commands.openSession(x.to);
  };

  if (!historyOpen) return null;
  return (
    <OverlayCard width={560} align="center" onClose={() => projectsLocal.set({ a2aHistoryOpen: false })}>
      <div data-a2a-history>
        <OverlayCardHeader title="⇄ a2a history" meta={`last ${history.length}`} hint={HINTS.a2aHistory} />
        <div className={styles.historyBody}>
          {history.length === 0 ? (
            <div className={styles.historyRow} data-a2a-history-empty>no inter-agent messages yet</div>
          ) : history.map((x) => (
            <div key={x.seq} className={styles.historyRow} onClick={() => openTurn(x)} data-a2a-history-row={x.seq}>
              <span className={styles.age}>{fmtAgo(x.ts, now)}</span>
              <span className={styles.agent}> {nameOf(x.from)} </span>
              <span className={styles.arrowStatic}>{KIND_GLYPH[x.kind]}</span>
              <span className={styles.agent}> {nameOf(x.to)}</span>
              <span className={styles.text}> · {x.text}</span>
            </div>
          ))}
        </div>
      </div>
    </OverlayCard>
  );
}
