import { useEffect, useState } from "react";
import type { UiState } from "@chimera/ui-state";
import { registerOverlay } from "./OverlayOutlet";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall } from "../rpc/bridge";
import { cycleValue, KNOWN_EFFORTS } from "../state/commands.agents";
import { systemCommands, systemLocal, useSystemLocal } from "../state/commands.system";
import { displayName } from "../state/selectors";
import { overlayTargetAgentId } from "../state/selectors.workflows";
import { CAPABILITY_NOTES } from "../copy";
import styles from "./ModelCard.module.css";

// EFFORT: near-verbatim mirror of ModelCard.tsx — same overlay/card shell, tab-cycling chip
// row, and "takes effect next turn" footer note, swapped to the closed KNOWN_EFFORTS
// vocabulary and agent.setEffort. Reuses ModelCard's CSS module (styling is identical; no
// reason to duplicate it for a cosmetic clone). KEYMAP-REDESIGN: system.effort was retired
// as a keyboard chord (letter-budget trade) — the opener is click-only now (plus the command
// palette, mod+b, on non-agents tabs), so the header hint is just "esc".
export function EffortCard() {
  const open = useSystemLocal((s) => s.effortOpen);
  // WORKFLOW-HEADER-CHIPS-DEAD: see ModelCard's overlayTargetAgentId comment — a task-row
  // selection resolves to its live step agent (null once that step ends), not s.agents[id].
  const agent = useStore((s: UiState) => { const id = overlayTargetAgentId(s); return id ? s.agents[id] : undefined; });
  const [effort, setEffort] = useState("");

  // seed the field from the agent's CURRENT effort on every open, AND
  // whenever the selected agent changes while the card stays mounted — the
  // AgentList lives in the left rail, outside this overlay's scrim
  // (OverlayCard: "the left rail is never covered"), so a row click while
  // this card is open re-targets `agent` without unmounting the card.
  // Without keying off agent.agentId too, a stale effort string from the
  // PREVIOUS agent would apply to the newly selected one on Enter.
  useEffect(() => {
    if (open) setEffort(agent?.effort ?? KNOWN_EFFORTS[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent?.agentId]);

  if (!open || !agent) return null;
  const commands = systemCommands(appStore, rpcCall);
  const close = (): void => systemLocal.set({ effortOpen: false });
  const apply = (): void => {
    if (effort.trim()) void commands.applyEffort(agent.agentId, effort.trim());
  };

  return (
    <OverlayCard width={560} align="center" onClose={close}>
      <OverlayCardHeader title="change effort" meta={displayName(agent)} hint="esc" />
      <div className={styles.body}>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>effort</span>
          <input
            className={styles.input}
            value={effort}
            autoFocus
            spellCheck={false}
            onChange={(e) => setEffort(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                e.preventDefault();
                setEffort(cycleValue(KNOWN_EFFORTS, effort, e.shiftKey));
              } else if (e.key === "Enter") {
                e.preventDefault();
                apply();
              }
              // KEYMAP-REDESIGN: no opener chord re-toggles this card anymore
              // (system.effort's dedicated hotkey was retired — mouse/palette
              // only), so there's nothing left to re-check here.
            }}
            data-effort-input
          />
        </div>
        <div className={styles.chips}>
          {KNOWN_EFFORTS.map((lvl) => (
            <span
              key={lvl}
              className={lvl === effort ? styles.chipActive : styles.chip}
              onClick={() => setEffort(lvl)}
              data-effort-chip={lvl}
            >
              {lvl}
            </span>
          ))}
          <span className={styles.ghost}>tab cycle · click</span>
        </div>
        {agent.provider === "kimi" && (
          <div className={styles.downgradeNote} data-kimi-effort-note>{CAPABILITY_NOTES.kimiEffortDowngrade}</div>
        )}
      </div>
      <div className={styles.footer}>
        <span className={styles.applyChip} onClick={apply} data-effort-apply>
          <span className={styles.applyKey}>enter</span>
          <span className={styles.applyVerb}> apply</span>
        </span>
        <span className={styles.note}>takes effect next turn</span>
      </div>
    </OverlayCard>
  );
}

registerOverlay("system.effort", EffortCard, () => {
  if (systemLocal.getState().effortOpen) systemLocal.set({ effortOpen: false });
});
