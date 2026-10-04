import { useEffect } from "react";
import type { UiState } from "@chimera/ui-state";
import { registerOverlay } from "./OverlayOutlet";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall } from "../rpc/bridge";
import { systemCommands, systemLocal, useSystemLocal } from "../state/commands.system";
import { displayName } from "../state/selectors";
import { isEditableTarget } from "../keymap";
import styles from "./ModelCard.module.css";

// REMOTE-CONTROL: an affordance on the selected agent that toggles the
// provider's native remote-control bridge on its LIVE session — no respawn on the
// claude leg (see docs/superpowers/design-plans/REMOTE-CONTROL.md). Mirrors
// ModelCard's shell/wiring exactly (OverlayCard + systemLocal open flag +
// systemCommands RPC method); the body just reflects agent.remoteControl instead
// of an editable field, since there's nothing for the user to type.
// KEYMAP-REDESIGN: system.remoteControl was retired as a keyboard chord
// (letter-budget trade) — the opener is click-only now (plus the command
// palette, mod+b, on non-agents tabs), so the header hint is just "esc".
export function RemoteControlCard() {
  const open = useSystemLocal((s) => s.remoteControlOpen);
  const agent = useStore((s: UiState) => (s.selectedAgentId ? s.agents[s.selectedAgentId] : undefined));
  const status = agent?.remoteControl;
  const enabled = status?.enabled === true;
  const toggle = (): void => { if (agent) void systemCommands(appStore, rpcCall).applyRemoteControl(agent.agentId, !enabled); };

  // Enter confirms (intercepted window-capture, mirrors ConfirmCard) — no input
  // field to focus here, so OverlayCard's own capture-phase esc listener has
  // nothing to compete with.
  useEffect(() => {
    if (!open || !agent) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (isEditableTarget(ev.target)) return;
      if (ev.key === "Enter") {
        ev.stopPropagation();
        ev.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent, enabled]);

  if (!open || !agent) return null;
  const close = (): void => systemLocal.set({ remoteControlOpen: false });

  return (
    <OverlayCard width={560} align="center" onClose={close}>
      <OverlayCardHeader title="remote control" meta={displayName(agent)} hint="esc" />
      <div className={styles.body}>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>status</span>
          <span>{status?.connectionStatus ?? (enabled ? "on" : "off")}</span>
        </div>
        {enabled && status?.sessionUrl && (
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>attach</span>
            <span data-remote-control-url>{status.sessionUrl}</span>
          </div>
        )}
        {enabled && status?.name && (
          <div className={styles.fieldRow}>
            <span className={styles.fieldLabel}>name</span>
            <span>{status.name}</span>
          </div>
        )}
        {status?.serverName && <div className={styles.fieldRow}><span className={styles.fieldLabel}>server</span><span>{status.serverName}</span></div>}
        {status?.environmentId && <div className={styles.fieldRow}><span className={styles.fieldLabel}>environment</span><span>{status.environmentId}</span></div>}
        <span className={styles.ghost}>
          {agent.provider === "codex"
            ? "Codex app-server remote access (not voice). The connection status and server identity come from Codex; this protocol does not return an attach URL. Requires a supported CLI/account."
            : enabled
            ? "open the attach link on claude.ai/code or the provider's mobile/desktop app"
            : "enabling starts the provider's bridge on this agent's live session"}
        </span>
      </div>
      <div className={styles.footer}>
        <span className={styles.applyChip} onClick={toggle} data-remote-control-toggle>
          <span className={styles.applyKey}>enter</span>
          <span className={styles.applyVerb}> {enabled ? "disable" : "enable"}</span>
        </span>
        <span className={styles.note}>not every provider supports this</span>
      </div>
    </OverlayCard>
  );
}

registerOverlay("system.remoteControl", RemoteControlCard, () => {
  if (systemLocal.getState().remoteControlOpen) systemLocal.set({ remoteControlOpen: false });
});
