import { useEffect, useSyncExternalStore } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { ConfirmCard } from "./ConfirmCard";
import { HookRuleFormCard } from "./HookRuleFormCard";
import { registerOverlay, type OverlayProps } from "./OverlayOutlet";
import { isEditableTarget, registerActionHandler } from "../keymap";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall, onDaemonEvent } from "../rpc/bridge";
import { getHooksCommands } from "../state/commands.hooks";
import { activityLabel } from "../state/selectors.hooks";
import { fmtClock } from "../state/selectors";
import styles from "./HooksCard.module.css";

// HOOK-6 (PLAN-HOOKS.md §7) — the lifecycle-hooks rules card, cloned from
// NotifyRulesCard. Rows: topic · filter · actions · last-fired/suppressed (folded
// in the ui-state reducer from hook_fired/hook_suppressed). Footer chips are the
// same F15 action-chip convention (mod+o new · e edit · space on/off · d delete
// — "new" moved off ctrl+n since "n" is OS-reserved, KEYMAP-REDESIGN rule 5).
// Rule storage is config.hooks (config.get/config.patch — D7 overlay pattern); there
// is NO per-rule test RPC (hooks fire off real events, unlike notify.test).

const FOOT_NOTE = "hooks are observational · loop-safe (chain depth ≤3, 20/h)";

export function HooksCard({ bottomInset }: OverlayProps) {
  const cmds = getHooksCommands(appStore, rpcCall);
  const state = useSyncExternalStore(cmds.subscribe, cmds.getState);
  // Live-update the activity column: hook_fired/hook_suppressed fold into the app
  // store's `hooks` map, a DIFFERENT store than this card's local one — subscribe to
  // it so a firing rule re-renders the row immediately (cmds.rows() reads it fresh).
  useStore((s) => s.hooks);

  useEffect(() => registerActionHandler("hooks.toggle", () => cmds.toggle()), [cmds]);

  // self-refresh (F09 pattern): a config.patch elsewhere reconciles these rows the
  // moment `hooks` shows up in a config_changed's keys.
  useEffect(() => {
    if (!state.open) return;
    const off = onDaemonEvent((e) => {
      if (e.kind !== "config_changed") return;
      const keys = (e.data as Record<string, unknown> | undefined)?.["keys"];
      if (Array.isArray(keys) && keys.includes("hooks")) void cmds.refresh();
    });
    return off;
  }, [state.open, cmds]);

  // capture-phase keys while the table is open — suspended while the form/confirm
  // gate owns the keys (their own handlers).
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
      if (k === "d") { run(() => cmds.requestDelete()); return; }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [state.open, state.formOpen, state.confirmDelete, cmds]);

  if (!state.open) return null;

  if (state.formOpen) {
    return (
      <HookRuleFormCard
        editing={state.editing}
        draft={state.draft}
        error={state.formError}
        onChange={(patch) => cmds.updateDraft(patch)}
        onAddAction={() => cmds.addAction()}
        onRemoveAction={(i) => cmds.removeAction(i)}
        onUpdateAction={(i, patch) => cmds.updateAction(i, patch)}
        onSubmit={() => cmds.submitForm()}
        onClose={() => cmds.escape()}
      />
    );
  }

  if (state.confirmDelete !== null) {
    return (
      <ConfirmCard
        title="⚠ delete hook rule"
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
    <OverlayCard width={680} align="center" bottomInset={bottomInset} onClose={() => cmds.escape()}>
      <div data-hooks-card>
        <OverlayCardHeader
          title="lifecycle hooks"
          hint={<span>on → actions · config-driven · esc</span>}
        />
        <div className={styles.colHead}>
          <div className={styles.colRule}>on · filter</div>
          <div className={styles.colActions}>actions</div>
          <div className={styles.colActivity}>activity</div>
        </div>
        <div className={styles.body}>
          {rows.length === 0 ? (
            // F46.UI: an in-flight hook.list and a genuinely empty list used to read
            // the same ("no hook rules") — an operator could not tell which.
            <div className={styles.emptyHint}>{state.loaded ? "no hook rules — ctrl+o to add one" : "loading hook rules…"}</div>
          ) : (
            rows.map((r, i) => {
              const when = r.lastFired ?? r.lastSuppressed;
              return (
                <div
                  key={r.name}
                  className={i === state.selected ? styles.rowSelected : styles.row}
                  onClick={() => cmds.select(i)}
                  data-hook-row={r.name}
                >
                  <div className={styles.colRule}>
                    <span className={r.enabled ? styles.dotOn : styles.dotOff}>{r.enabled ? "●" : "○"}</span>{" "}
                    {r.topicLabel}
                    {r.filterLabel && <span className={styles.filterHint}> ({r.filterLabel})</span>}
                  </div>
                  <div className={`${styles.colActions} ${styles.muted}`}>{r.actionsLabel}</div>
                  <div className={`${styles.colActivity} ${styles.muted}`}>
                    {when !== undefined ? (
                      <>
                        <span className={r.lastSuppressed !== undefined && (r.lastFired === undefined || r.lastSuppressed >= r.lastFired) ? styles.suppressed : styles.fired}>
                          {activityLabel(r)}
                        </span>{" "}
                        <span className={styles.ts}>{fmtClock(when)}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div className={styles.footer}>
          <span className={styles.chip} onClick={() => cmds.openNew()} data-hook-new>
            <span className={styles.chipKey}>ctrl+o</span> new
          </span>
          <span className={styles.chip} onClick={() => cmds.openEdit()} data-hook-edit>
            <span className={styles.chipKey}>e</span> edit
          </span>
          <span className={styles.chip} onClick={() => void cmds.toggleSelected()} data-hook-cycle>
            <span className={styles.chipKey}>space</span> on/off
          </span>
          <span className={styles.chipDanger} onClick={() => cmds.requestDelete()} data-hook-delete>
            <span className={styles.chipKeyDanger}>d</span> delete
          </span>
          <span className={styles.footSpacer} />
          <span className={styles.footNote}>{FOOT_NOTE}</span>
        </div>
      </div>
    </OverlayCard>
  );
}

registerOverlay("hooks", HooksCard, () => {
  const cmds = getHooksCommands(appStore, rpcCall);
  if (cmds.getState().open) cmds.toggle();
});
