import { useState } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import type { NotifyRule } from "@chimera/protocol";
import type { NotifyFormDraft } from "../state/commands.notify";
import styles from "./NotifyRuleFormCard.module.css";

const CHANNELS: readonly NotifyRule["channel"][] = ["os", "toast", "a2a", "webhook"];

// W20 (F18 · coverage B22) — the notify-rule create/edit form (mod+o new · e
// edit, PREFILLED per the W16 edit convention: title "edit rule · <name>").
// Mirrors AddProviderForm's plain-fields shape (no arrow-key field walker —
// the rule's field count doesn't warrant ScheduleFormCard's machinery).
export function NotifyRuleFormCard({ editing, draft, error, onChange, onSubmit, onClose }: {
  editing: string | null;
  draft: NotifyFormDraft;
  error: string | null;
  onChange: (patch: Partial<NotifyFormDraft>) => void;
  onSubmit: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit();
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayCard width={560} align="center" onClose={onClose}>
      <div data-notify-form>
        <OverlayCardHeader
          title={editing ? `edit rule · ${editing}` : "new notify rule"}
          hint={<span>enter save · esc cancel</span>}
        />
        <div className={styles.formGrid}>
          <label className={styles.formRow}>
            <span className={styles.formLabel}>name</span>
            <input
              className={styles.input}
              value={draft.name}
              autoFocus
              onChange={(e) => onChange({ name: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); if (e.key === "Escape") onClose(); }}
              data-notify-name
            />
          </label>
          <label className={styles.formRow}>
            <span className={styles.formLabel}>event kind</span>
            <input
              className={styles.input}
              value={draft.kind}
              placeholder="permission_request · job_run_finished · …"
              onChange={(e) => onChange({ kind: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); if (e.key === "Escape") onClose(); }}
              data-notify-kind
            />
          </label>
          <div className={styles.formRow}>
            <span className={styles.formLabel}>filter</span>
            <input
              className={styles.inputSmall}
              value={draft.filterKey}
              placeholder="key (optional)"
              onChange={(e) => onChange({ filterKey: e.target.value })}
              data-notify-filter-key
            />
            <input
              className={styles.inputSmall}
              value={draft.filterValue}
              placeholder="value"
              onChange={(e) => onChange({ filterValue: e.target.value })}
              data-notify-filter-value
            />
          </div>
          <label className={styles.formRow}>
            <span className={styles.formLabel}>channel</span>
            <select
              className={styles.select}
              value={draft.channel}
              onChange={(e) => onChange({ channel: e.target.value as NotifyRule["channel"] })}
              data-notify-channel
            >
              {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {draft.channel === "webhook" && (
            <label className={styles.formRow}>
              <span className={styles.formLabel}>webhook url</span>
              <input
                className={styles.input}
                value={draft.webhookUrl}
                placeholder="https://…"
                onChange={(e) => onChange({ webhookUrl: e.target.value })}
                data-notify-webhook-url
              />
            </label>
          )}
          <label className={styles.formRow}>
            <span className={styles.formLabel}>throttle (sec)</span>
            <input
              className={styles.inputSmall}
              value={draft.throttleSec}
              onChange={(e) => onChange({ throttleSec: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); if (e.key === "Escape") onClose(); }}
              data-notify-throttle
            />
            <label className={styles.checkRow}>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => onChange({ enabled: e.target.checked })}
                data-notify-enabled
              />
              <span>enabled</span>
            </label>
          </label>
        </div>
        {error && <div className={styles.errorLine} data-notify-form-error>{error}</div>}
        <div className={styles.actions}>
          <button className={styles.primaryBtn} disabled={busy} onClick={() => void submit()} data-notify-save>
            {editing ? "save" : "create"}
          </button>
          <button className={styles.ghostBtn} onClick={onClose}>cancel</button>
        </div>
      </div>
    </OverlayCard>
  );
}
