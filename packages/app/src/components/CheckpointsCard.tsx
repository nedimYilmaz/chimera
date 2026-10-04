import { useEffect, useSyncExternalStore } from "react";
import type { UiState } from "@chimera/ui-state";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { ConfirmCard } from "./ConfirmCard";
import { registerOverlay, type OverlayProps } from "./OverlayOutlet";
import { displayChord, isEditableTarget, registerActionHandler } from "../keymap";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall, checkpointFilesSince } from "../rpc/bridge";
import { getCheckpointsCommands, useFilesSinceMeta } from "../state/commands.checkpoints";
import { checkpointLabel, triggerLabel } from "../state/selectors.checkpoints";
import { displayName, fmtClock } from "../state/selectors";
import styles from "./CheckpointsCard.module.css";

// F20 (W22 · coverage §B24/§C18): the full checkpoints list (mock
// showCheckpoints, design lines 435-452) — every {id, trigger, ts, files-since}
// for the SELECTED agent's repo (D16's checkpoint.list + a per-row Tauri
// git-shell-out for files-since, commands.checkpoints.useFilesSinceMeta),
// opened by clicking the CheckpointStrip (no mock-documented global chord
// opens it — only mod+k create / mod+shift+r revert are bound chords). Revert is
// ALWAYS gated behind the ⚠ ConfirmCard; THIS component renders that gate
// (its confirmId branch takes priority over its own open/closed list view) so
// a press from either the strip or the card's own footer never double-mounts
// the modal.
function CheckpointsCard(_props: OverlayProps) {
  const cmds = getCheckpointsCommands(appStore, rpcCall);
  const state = useSyncExternalStore(cmds.subscribe, cmds.getState);
  const selected = useStore((s: UiState) => (s.selectedAgentId ? s.agents[s.selectedAgentId] : undefined));
  const filesSince = useFilesSinceMeta(state.cwd, state.items, checkpointFilesSince);

  // `mod+shift+r` while the card's list view is open shadows the strip's own binding
  // (registry last-wins, mod+e's TranscriptPanel/PermissionCard precedent):
  // acts on the SELECTED row instead of the strip's latest. Suspended while
  // the confirm gate itself owns the keys.
  useEffect(() => {
    if (!state.open || state.confirmId !== null) return undefined;
    return registerActionHandler("agents.checkpointRevert", () => {
      const row = state.items[state.selected];
      if (row) cmds.requestRevert(row.id);
    });
  }, [state.open, state.confirmId, state.items, state.selected, cmds]);

  // ↑/↓ row nav while the list view is open (HostToolsCard/NotifyRulesCard
  // capture-phase convention — this card has no keymap-table nav rows).
  useEffect(() => {
    if (!state.open || state.confirmId !== null) return undefined;
    const onKey = (ev: KeyboardEvent): void => {
      if (isEditableTarget(ev.target)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key === "ArrowUp") { ev.preventDefault(); ev.stopImmediatePropagation(); cmds.move(-1); return; }
      if (ev.key === "ArrowDown") { ev.preventDefault(); ev.stopImmediatePropagation(); cmds.move(1); }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [state.open, state.confirmId, cmds]);

  if (state.confirmId !== null) {
    return (
      <ConfirmCard
        title="⚠ revert checkpoint"
        meta={checkpointLabel(state.confirmId)}
        body={`revert the working tree to checkpoint ${checkpointLabel(state.confirmId)}? uncommitted changes since are overwritten.`}
        note="refused while any agent is running in this repo — kill it first"
        confirmLabel="confirm revert"
        onConfirm={() => void cmds.confirmRevert()}
        onClose={() => cmds.cancelRevert()}
      />
    );
  }

  if (!state.open) return null;

  return (
    <OverlayCard width={560} align="center" onClose={() => cmds.escape()}>
      <div data-checkpoints-card>
        <OverlayCardHeader
          title="checkpoints"
          meta={<span>{selected ? displayName(selected) : ""} <span className={styles.dim}>{state.cwd ?? ""}</span></span>}
          hint={<span>keeps last 20 · 24h</span>}
        />
        <div className={styles.body}>
          {state.items.length === 0 ? (
            <div className={styles.emptyHint}>no checkpoints yet</div>
          ) : (
            state.items.map((row, i) => (
              <div
                key={row.id}
                className={i === state.selected ? styles.rowSelected : styles.row}
                onClick={() => cmds.select(i)}
                data-checkpoint-row={row.id}
              >
                <span className={styles.mark}>⚑</span>
                <span className={styles.id}>{checkpointLabel(row.id)}</span>
                <span className={styles.trigger}>{triggerLabel(row)}</span>
                <span className={styles.spacer} />
                <span className={styles.filesSince} data-checkpoint-files-since>
                  {filesSince[row.id] === undefined ? "…" : `${filesSince[row.id]} file${filesSince[row.id] === 1 ? "" : "s"}`}
                </span>
                <span className={styles.ts}>{fmtClock(row.ts)}</span>
              </div>
            ))
          )}
        </div>
        <div className={styles.footer}>
          <span
            className={styles.chipDanger}
            onClick={() => {
              const row = state.items[state.selected];
              if (row) cmds.requestRevert(row.id);
            }}
            data-checkpoint-revert
          >
            <span className={styles.chipKeyDanger}>{displayChord("mod+shift+r")}</span> revert to selected
          </span>
          <span
            className={styles.chip}
            onClick={() => {
              if (selected) void cmds.createManual(selected.agentId);
            }}
            data-checkpoint-new
          >
            <span className={styles.chipKey}>{displayChord("mod+k")}</span> checkpoint now
          </span>
          <span className={styles.footSpacer} />
          <span className={styles.footNote}>revert refused while agents run in this repo</span>
        </div>
      </div>
    </OverlayCard>
  );
}

registerOverlay("checkpoints", CheckpointsCard, () => {
  const cmds = getCheckpointsCommands(appStore, rpcCall);
  if (cmds.getState().open || cmds.getState().confirmId !== null) cmds.escape();
});
