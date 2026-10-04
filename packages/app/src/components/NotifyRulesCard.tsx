import { useEffect, useSyncExternalStore } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { ConfirmCard } from "./ConfirmCard";
import { NotifyRuleFormCard } from "./NotifyRuleFormCard";
import { registerOverlay, type OverlayProps } from "./OverlayOutlet";
import { isEditableTarget, registerActionHandler } from "../keymap";
import { appStore } from "../state/store";
import { rpcCall, onDaemonEvent } from "../rpc/bridge";
import { getNotifyCommands } from "../state/commands.notify";
import styles from "./NotifyRulesCard.module.css";

// W20 (F18 · coverage B22): the notification-rules card (mock showNotifRules,
// lines 1134-1158) — OverlayCard center 640, mounted through the settings
// screen's OverlayOutlet (opened by the "notifications" rail row, mirroring
// how the "tools" section reuses mod+d's HostToolsCard). Rows: event ·
// filter · channel · throttle · ●/○; footer chips are the F15 action-chip
// convention (mod+o new · e edit · space on/off · t test · d delete — "new"
// moved off ctrl+n since "n" is OS-reserved, KEYMAP-REDESIGN rule 5).
// Rule storage is config.notify (config.get/config.patch — D7 overlay
// pattern); notify.test is the ONE bespoke RPC.

const FOOT_NOTE = "a 10-error burst collapses to one delivery ×10";

export function NotifyRulesCard({ bottomInset }: OverlayProps) {
  const cmds = getNotifyCommands(appStore, rpcCall);
  const state = useSyncExternalStore(cmds.subscribe, cmds.getState);

  // the settings-rail opener (mirrors HostToolsCard's "host.toggle").
  useEffect(() => registerActionHandler("notify.toggle", () => cmds.toggle()), [cmds]);

  // self-refresh (F09 pattern): a config.patch elsewhere still reconciles this
  // card's rows the moment `notify` shows up in a config_changed's keys.
  useEffect(() => {
    if (!state.open) return;
    const off = onDaemonEvent((e) => {
      if (e.kind !== "config_changed") return;
      const keys = (e.data as Record<string, unknown> | undefined)?.["keys"];
      if (Array.isArray(keys) && keys.includes("notify")) void cmds.refresh();
    });
    return off;
  }, [state.open, cmds]);

  // capture-phase keys while the table view is open (HostToolsCard pattern) —
  // suspended while the form/confirm gate owns the keys (their own handlers).
  useEffect(() => {
    if (!state.open || state.formOpen || state.confirmDelete !== null) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (isEditableTarget(ev.target)) return;
      const run = (fn: () => void): void => { ev.preventDefault(); ev.stopImmediatePropagation(); fn(); };
      if (ev.key === "ArrowUp") { run(() => cmds.move(-1)); return; }
      if (ev.key === "ArrowDown") { run(() => cmds.move(1)); return; }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "o") { run(() => cmds.openNew()); return; }
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (k === "e") { run(() => cmds.openEdit()); return; }
      if (ev.key === " ") { run(() => void cmds.toggleSelected()); return; }
      if (k === "t") { run(() => void cmds.testSelected()); return; }
      if (k === "d") { run(() => cmds.requestDelete()); return; }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [state.open, state.formOpen, state.confirmDelete, cmds]);

  if (!state.open) return null;

  if (state.formOpen) {
    return (
      <NotifyRuleFormCard
        editing={state.editing}
        draft={state.draft}
        error={state.formError}
        onChange={(patch) => cmds.updateDraft(patch)}
        onSubmit={() => cmds.submitForm()}
        onClose={() => cmds.escape()}
      />
    );
  }

  if (state.confirmDelete !== null) {
    return (
      <ConfirmCard
        title="⚠ delete notify rule"
        meta={state.confirmDelete}
        body={`delete the "${state.confirmDelete}" rule? this cannot be undone.`}
        confirmLabel="confirm delete"
        onConfirm={() => void cmds.confirmDelete()}
        onClose={() => cmds.cancelDelete()}
      />
    );
  }

  const rows = cmds.rows();

  return (
    <OverlayCard width={640} align="center" bottomInset={bottomInset} onClose={() => cmds.escape()}>
      <div data-notify-rules-card>
        <OverlayCardHeader
          title="notification rules"
          hint={<span>click deep-links to the pending surface · badge = pending ⚠+? · esc</span>}
        />
        <div className={styles.colHead}>
          <div className={styles.colRule}>rule</div>
          <div className={styles.colChannel}>channel</div>
          <div className={styles.colThrottle}>throttle</div>
        </div>
        <div className={styles.body}>
          {rows.length === 0 ? (
            <div className={styles.emptyHint}>no notify rules</div>
          ) : (
            rows.map((r, i) => (
              <div
                key={r.name}
                className={i === state.selected ? styles.rowSelected : styles.row}
                onClick={() => cmds.select(i)}
                data-notify-row={r.name}
              >
                <div className={styles.colRule}>
                  <span className={r.enabled ? styles.dotOn : styles.dotOff}>{r.enabled ? "●" : "○"}</span>{" "}
                  {r.kindLabel}
                  {r.filterLabel && <span className={styles.filterHint}> ({r.filterLabel})</span>}
                </div>
                <div className={`${styles.colChannel} ${styles.muted}`}>{r.channelLabel}</div>
                <div className={`${styles.colThrottle} ${styles.muted}`}>{r.throttleLabel}</div>
              </div>
            ))
          )}
        </div>
        <div className={styles.footer}>
          <span className={styles.chip} onClick={() => cmds.openNew()} data-notify-new>
            <span className={styles.chipKey}>ctrl+o</span> new
          </span>
          <span className={styles.chip} onClick={() => cmds.openEdit()} data-notify-edit>
            <span className={styles.chipKey}>e</span> edit
          </span>
          <span className={styles.chip} onClick={() => void cmds.toggleSelected()} data-notify-cycle>
            <span className={styles.chipKey}>space</span> on/off
          </span>
          <span className={styles.chip} onClick={() => void cmds.testSelected()} data-notify-test>
            <span className={styles.chipKey}>t</span> test
          </span>
          <span className={styles.chipDanger} onClick={() => cmds.requestDelete()} data-notify-delete>
            <span className={styles.chipKeyDanger}>d</span> delete
          </span>
          <span className={styles.footSpacer} />
          <span className={styles.footNote}>{FOOT_NOTE}</span>
        </div>
      </div>
    </OverlayCard>
  );
}

registerOverlay("notify-rules", NotifyRulesCard, () => {
  const cmds = getNotifyCommands(appStore, rpcCall);
  if (cmds.getState().open) cmds.toggle();
});
