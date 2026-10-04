import { useEffect, useState } from "react";
import type { UiState } from "@chimera/ui-state";
import { registerOverlay } from "./OverlayOutlet";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall } from "../rpc/bridge";
import { cycleValue } from "../state/commands.agents";
import { systemCommands, systemLocal, useSystemLocal } from "../state/commands.system";
import { displayName } from "../state/selectors";
import { overlayTargetAgentId } from "../state/selectors.workflows";
import styles from "./ModelCard.module.css";

// ACCOUNT-SWITCH-LIVE: near-verbatim mirror of ModelCard.tsx/EffortCard.tsx — same
// overlay/card shell and live account chips. Cross-provider selection creates a fresh
// native session with portable context; same-provider selection uses native resume.
// KEYMAP-REDESIGN: system.accountSwitch was retired as a keyboard chord (letter-budget
// trade) — the opener is click-only now (plus the command palette, mod+b, on non-agents
// tabs), so the header hint is just "esc".
export function AccountCard() {
  const open = useSystemLocal((s) => s.accountOpen);
  // WORKFLOW-HEADER-CHIPS-DEAD: see ModelCard's overlayTargetAgentId comment — a task-row
  // selection resolves to its live step agent (null once that step ends), not s.agents[id].
  const agent = useStore((s: UiState) => { const id = overlayTargetAgentId(s); return id ? s.agents[id] : undefined; });
  const accounts = useStore((s: UiState) => s.accounts);
  const [account, setAccount] = useState("");
  const [model, setModel] = useState("");
  const [acknowledgeRisk, setAcknowledgeRisk] = useState(false);
  const [busy, setBusy] = useState(false);

  const sameProvider = accounts.map((a) => a.name);
  const targetProvider = accounts.find((a) => a.name === account)?.provider;
  const crossProvider = !!targetProvider && targetProvider !== agent?.provider;
  const chooseAccount = (value: string): void => { setAccount(value); setModel(""); setAcknowledgeRisk(false); };

  // seed the field from the agent's CURRENT account on every open, AND
  // whenever the selected agent changes while the card stays mounted — the
  // AgentList lives in the left rail, outside this overlay's scrim
  // (OverlayCard: "the left rail is never covered"), so a row click while
  // this card is open re-targets `agent` without unmounting the card.
  // Without keying off agent.agentId too, a stale account string from the
  // PREVIOUS agent would apply to the newly selected one on Enter.
  useEffect(() => {
    if (open) { chooseAccount(agent?.account ?? sameProvider[0] ?? ""); setBusy(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent?.agentId]);

  if (!open || !agent) return null;
  const commands = systemCommands(appStore, rpcCall);
  const close = (): void => systemLocal.set({ accountOpen: false });
  const apply = (): void => {
    if (account.trim() && !busy) {
      setBusy(true);
      void commands.applyAccount(agent.agentId, account.trim(), model.trim() || undefined, acknowledgeRisk || undefined).finally(() => setBusy(false));
    }
  };

  return (
    <OverlayCard width={560} align="center" onClose={close}>
      <OverlayCardHeader title="change account / model" meta={displayName(agent)} hint="esc" />
      <div className={styles.body}>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>account</span>
          <input
            className={styles.input}
            value={account}
            autoFocus
            spellCheck={false}
            disabled={busy}
            onChange={(e) => chooseAccount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                e.preventDefault();
                if (sameProvider.length > 0) chooseAccount(cycleValue(sameProvider, account, e.shiftKey));
              } else if (e.key === "Enter") {
                e.preventDefault();
                apply();
              }
              // KEYMAP-REDESIGN: no opener chord re-toggles this card anymore
              // (system.accountSwitch's dedicated hotkey was retired — mouse/
              // palette only), so there's nothing left to re-check here.
            }}
            data-account-input
          />
        </div>
        <div className={styles.chips}>
          {sameProvider.map((name) => (
            <span
              key={name}
              className={name === account ? styles.chipActive : styles.chip}
              onClick={() => { if (!busy) chooseAccount(name); }}
              data-account-chip={name}
            >
              {name} · {accounts.find((a) => a.name === name)?.provider}
            </span>
          ))}
          <span className={styles.ghost}>all providers · tab cycle · click</span>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>model</span>
          <input className={styles.input} value={model} disabled={busy} spellCheck={false} placeholder={crossProvider ? "target provider default" : "keep current model"} onChange={(e) => setModel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") apply(); }} data-account-model />
        </div>
        {crossProvider && <p className={styles.note}>New provider session, same agent and working directory. Source context is compacted first (up to 90s); retained history is used if compaction is unavailable. This may use source-account tokens. Provider-specific options and plugins are reset.</p>}
        {crossProvider && targetProvider === "codex" && agent.permissionProfile === "full" && <label className={styles.note}><input type="checkbox" checked={acknowledgeRisk} disabled={busy} onChange={(e) => setAcknowledgeRisk(e.target.checked)} /> I acknowledge Codex full access runs without its sandbox.</label>}
      </div>
      <div className={styles.footer}>
        <span className={styles.applyChip} onClick={apply} data-account-apply>
          <span className={styles.applyKey}>enter</span>
          <span className={styles.applyVerb}>{busy ? " transferring…" : " apply"}</span>
        </span>
        <span className={styles.note}>interrupts the current turn</span>
      </div>
    </OverlayCard>
  );
}

registerOverlay("system.accountSwitch", AccountCard, () => {
  if (systemLocal.getState().accountOpen) systemLocal.set({ accountOpen: false });
});
