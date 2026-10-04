import { useState, type ReactNode } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import type { HookAction } from "@chimera/protocol";
import type { ChannelKind, HookActionDraft, HookFormDraft } from "../state/commands.hooks";
import {
  HOOK_TOPICS, hookFilterKeysFor, hookDraftFilterIssue, hookFilterLabel, hookFilterWarning, topicLabel,
} from "../state/selectors.hooks";
import styles from "./HookRuleFormCard.module.css";

// HOOK-6 (PLAN-HOOKS.md §7) — the hook-rule create/edit form, cloned from
// NotifyRuleFormCard's plain-fields shape and extended with the action editor: a
// rule owns 1–4 actions, each of the 5 §3.2 types (notify/push/spawn/run/channel)
// with its own field set. Field styling is borrowed 1:1 from the notify form so the
// two read as one system.

const ACTION_TYPES: readonly HookAction["type"][] = ["notify", "push", "spawn", "run", "channel"];
const CHANNELS: readonly ChannelKind[] = ["toast", "os", "webhook", "a2a"];

export function HookRuleFormCard({ editing, draft, error, onChange, onAddAction, onRemoveAction, onUpdateAction, onSubmit, onClose }: {
  editing: string | null;
  draft: HookFormDraft;
  error: string | null;
  onChange: (patch: Partial<HookFormDraft>) => void;
  onAddAction: () => void;
  onRemoveAction: (i: number) => void;
  onUpdateAction: (i: number, patch: Partial<HookActionDraft>) => void;
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
  const enterSaves = (e: { key: string }): void => { if (e.key === "Enter") void submit(); if (e.key === "Escape") onClose(); };
  const filterIssue = hookDraftFilterIssue(draft.topic, draft.filterKey, draft.filterValue);
  const filterWarning = hookFilterWarning(draft.filterKey);
  const extraFilter = hookFilterLabel(draft.extraFilter);
  const filterRequired = draft.filterKey === "contains" || hookFilterKeysFor(draft.topic, "")[0] === "contains";

  return (
    <OverlayCard width={620} align="center" onClose={onClose}>
      <div data-hook-form>
        <OverlayCardHeader
          title={editing ? `edit hook · ${editing}` : "new hook rule"}
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
              onKeyDown={enterSaves}
              data-hook-name
            />
          </label>
          <label className={styles.formRow}>
            <span className={styles.formLabel}>on (topic)</span>
            <select
              className={styles.select}
              value={draft.topic}
              onChange={(e) => onChange({ topic: e.target.value as HookFormDraft["topic"] })}
              data-hook-topic
            >
              {HOOK_TOPICS.map((t) => <option key={t} value={t}>{topicLabel(t)}</option>)}
            </select>
          </label>
          <div className={styles.formRow}>
            <span className={styles.formLabel}>{filterRequired ? "filter · required" : "filter"}</span>
            <select
              className={styles.inputSmall}
              value={draft.filterKey}
              onChange={(e) => onChange({ filterKey: e.target.value })}
              data-hook-filter-key
            >
              {/* a content topic has exactly one legal key and MUST carry it — offering
                  "— none —" there would only offer a rule the daemon refuses. */}
              {!filterRequired && <option value="">— none —</option>}
              {hookFilterKeysFor(draft.topic, draft.filterKey).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input
              className={styles.inputSmall}
              value={draft.filterValue}
              placeholder={draft.filterKey === "contains" ? "text to match (3–64 chars)" : "value"}
              disabled={!draft.filterKey}
              onChange={(e) => onChange({ filterValue: e.target.value })}
              onKeyDown={enterSaves}
              data-hook-filter-value
            />
          </div>
          {/* F46/QA finding E: the topic/filter contract is enforced server-side; showing its
              verdict HERE means the operator never learns about it from a red save. */}
          {/* F46.UI: an agent-installed rule usually carries a second key (agentId) beside the
              needle. The pair above can only show one, so name the rest here — otherwise the
              operator reads a fleet-wide watch where a per-agent one is saved. */}
          {extraFilter && (
            <div className={styles.actionsHint} data-hook-filter-extra>
              also filtered on {extraFilter} · kept as-is when you save
            </div>
          )}
          {(filterIssue ?? filterWarning) && (
            <div className={filterIssue ? styles.errorLine : styles.actionsHint} data-hook-filter-hint>
              {filterIssue ?? filterWarning}
            </div>
          )}

          <div className={styles.actionsHead}>
            <span className={styles.formLabel}>actions</span>
            <span className={styles.actionsHint}>1–4 · run sequentially on match</span>
            <span className={styles.spacer} />
            {draft.actions.length < 4 && (
              <button type="button" className={styles.addBtn} onClick={onAddAction} data-hook-add-action>+ action</button>
            )}
          </div>
          {draft.actions.map((a, i) => (
            <div key={i} className={styles.actionCard} data-hook-action={i}>
              <div className={styles.actionRow}>
                <select
                  className={styles.actionType}
                  value={a.type}
                  onChange={(e) => onUpdateAction(i, { type: e.target.value as HookActionDraft["type"] })}
                  data-hook-action-type={i}
                >
                  {ACTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                {draft.actions.length > 1 && (
                  <button type="button" className={styles.removeBtn} onClick={() => onRemoveAction(i)} data-hook-remove-action={i}>✕</button>
                )}
              </div>
              <ActionFields action={a} onUpdate={(patch) => onUpdateAction(i, patch)} onKeyDown={enterSaves} />
            </div>
          ))}

          <label className={styles.checkRowStandalone}>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => onChange({ enabled: e.target.checked })}
              data-hook-enabled
            />
            <span>enabled</span>
          </label>
        </div>
        {error && <div className={styles.errorLine} data-hook-form-error>{error}</div>}
        <div className={styles.actionsFoot}>
          <button className={styles.primaryBtn} disabled={busy || filterIssue !== null} onClick={() => void submit()} data-hook-save>
            {editing ? "save" : "create"}
          </button>
          <button className={styles.ghostBtn} onClick={onClose}>cancel</button>
        </div>
      </div>
    </OverlayCard>
  );
}

/** The type-specific input set for one action row (the 5 §3.2 shapes). */
function ActionFields({ action, onUpdate, onKeyDown }: {
  action: HookActionDraft;
  onUpdate: (patch: Partial<HookActionDraft>) => void;
  onKeyDown: (e: { key: string }) => void;
}) {
  const field = (label: string, node: ReactNode) => (
    <label className={styles.actionField}>
      <span className={styles.actionLabel}>{label}</span>
      {node}
    </label>
  );
  const text = (key: keyof HookActionDraft, placeholder: string) => (
    <input
      className={styles.input}
      value={String(action[key] ?? "")}
      placeholder={placeholder}
      onChange={(e) => onUpdate({ [key]: e.target.value } as Partial<HookActionDraft>)}
      onKeyDown={onKeyDown}
    />
  );
  switch (action.type) {
    case "notify":
      return (
        <>
          {field("to", text("to", "<agentId> · @conductor · @team:x/role"))}
          {field("text", text("text", "message (supports {{topic}} templates)"))}
        </>
      );
    case "push":
      return (
        <>
          {field("queue", text("queue", "queue name"))}
          {field("prompt", text("prompt", "task prompt"))}
          {field("role", text("role", "role (optional)"))}
        </>
      );
    case "spawn":
      return (
        <>
          {field("prompt", text("prompt", "agent prompt"))}
          {field("role", text("role", "role template (optional)"))}
        </>
      );
    case "run":
      return (
        <>
          {field("command", text("command", "shell command"))}
          {field("timeout", (
            <input
              className={styles.inputSmall}
              value={action.timeoutSec}
              placeholder="sec"
              onChange={(e) => onUpdate({ timeoutSec: e.target.value })}
              onKeyDown={onKeyDown}
            />
          ))}
        </>
      );
    case "channel":
      return (
        <>
          {field("channel", (
            <select className={styles.select} value={action.channel} onChange={(e) => onUpdate({ channel: e.target.value as ChannelKind })}>
              {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ))}
          {action.channel === "webhook" && field("webhook url", text("webhookUrl", "https://…"))}
        </>
      );
  }
}
