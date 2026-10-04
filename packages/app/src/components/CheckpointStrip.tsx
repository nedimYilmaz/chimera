import { useEffect, useState } from "react";
import type { UiState } from "@chimera/ui-state";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall } from "../rpc/bridge";
import { displayChord, registerActionHandler } from "../keymap";
import { getCheckpointsCommands } from "../state/commands.checkpoints";
import { checkpointLabel, latestCheckpointSeq, triggerLabel } from "../state/selectors.checkpoints";
import { fmtClock } from "../state/selectors";
import styles from "./CheckpointStrip.module.css";

// F20 (W22 · coverage §B24/§C18) — the ⚑ checkpoint marker row above the
// composer (mock showCheckpoints, composer-area block lines 610-611): the
// SELECTED agent's latest checkpoint (D16's checkpoint.status), same
// always-mounted convention as ArtifactsStrip so mod+k/mod+shift+r stay live
// whenever the agents screen is up. Hidden entirely for a non-git cwd
// (status.supported:false) or before any checkpoint exists — F20's "non-git
// cwd stays dark" rule. Click opens the full CheckpointsCard; the chips
// mirror the mock's inline "mod+shift+r revert"/"mod+k new" hints.
export function CheckpointStrip() {
  const cmds = getCheckpointsCommands(appStore, rpcCall);
  const [state, setState] = useState(cmds.getState());
  useEffect(() => cmds.subscribe(() => setState(cmds.getState())), [cmds]);

  const selectedId = useStore((s: UiState) => s.selectedAgentId);
  const events = useStore((s: UiState) => s.events);
  const seq = latestCheckpointSeq(events);

  // P3-T4 (PLAN-PROJECT-CONDUCTOR-ROUTING.md): resolved PROJECT-scoped, not the
  // selected agent's raw spec.cwd — cmds.refreshForAgent prefers the agent's
  // projectId (P3-T2) → project.path (so a worktree agent still shows its
  // PROJECT's checkpoints, and the home-dir main session's non-project cwd no
  // longer needs to be a repo), falling back to spec.cwd exactly like before
  // when no projectId resolves. Re-resolved on every selection change AND on
  // every checkpoint_created/reverted event, since either can flip
  // supported/latest for the SAME cwd.
  useEffect(() => {
    void cmds.refreshForAgent(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, seq, cmds]);

  // `mod+k` (F20: manual checkpoint keybinding, always live on this screen).
  useEffect(() => registerActionHandler("agents.checkpoint", () => {
    if (selectedId) void cmds.createManual(selectedId);
  }), [cmds, selectedId]);

  // `mod+shift+r` — the strip's own revert-latest binding; CheckpointsCard shadows this
  // (registry last-wins) with its own selected-row version while it's open.
  useEffect(() => registerActionHandler("agents.checkpointRevert", () => {
    if (state.latest) cmds.requestRevert(state.latest.id);
  }), [cmds, state.latest]);

  if (!state.supported || !state.latest) return null;
  const latest = state.latest;

  return (
    <div className={styles.strip} data-checkpoint-strip onClick={() => cmds.toggle()}>
      <span className={styles.mark}>⚑</span>
      <span className={styles.id}>checkpoint {checkpointLabel(latest.id)}</span>
      <span className={styles.trigger}>{triggerLabel(latest)}</span>
      <span className={styles.rule} />
      <span className={styles.ts}>{fmtClock(latest.ts)}</span>
      <span
        className={styles.chip}
        onClick={(ev) => {
          ev.stopPropagation();
          cmds.requestRevert(latest.id);
        }}
        data-checkpoint-revert
      >
        <span className={styles.chipKey}>{displayChord("mod+shift+r")}</span> revert
      </span>
      <span
        className={styles.chip}
        onClick={(ev) => {
          ev.stopPropagation();
          if (selectedId) void cmds.createManual(selectedId);
        }}
        data-checkpoint-new
      >
        <span className={styles.chipKey}>{displayChord("mod+k")}</span> new
      </span>
    </div>
  );
}
