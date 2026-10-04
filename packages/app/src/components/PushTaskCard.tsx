import { useEffect, useRef, useState } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { buildPushParams, validatePushForm, type PushFormValues } from "../state/selectors.coord";
import styles from "./PushTaskCard.module.css";

// W5 — the push-task form (mock showPushForm, s_queues 694-712): OverlayCard
// center 620 in the queues DETAIL pane host, header "push task → <queue>".
// Fields prompt* / priority / role; final enter submits queue.push {queue,
// prompt*, priority, role}; errors inline. esc cancels, mod+o re-toggles.
// W18 (F16 task workflows): a `workflow` field overrides the queue's own
// default binding for THIS task only (empty ⇒ inherit at pickup).

type FieldKey = keyof PushFormValues;
// TASK-TAGS: last, after workflow — an optional routing label, not part of the core brief.
const FIELD_ORDER: readonly FieldKey[] = ["prompt", "priority", "role", "workflow", "tags"];

export function PushTaskCard({ queue, defaultRole, defaultWorkflow, onSubmit, onClose }: {
  queue: string;
  defaultRole?: string;
  /** The queue's own default workflow binding (queue.spec.workflow), shown as
   * placeholder text — typing here OVERRIDES it for this one task. */
  defaultWorkflow?: string | null;
  onSubmit: (params: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<PushFormValues>({ prompt: "", priority: "5", role: defaultRole ?? "", workflow: "", tags: "" });
  const [fieldIndex, setFieldIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRefs = useRef<Partial<Record<FieldKey, HTMLInputElement | null>>>({});

  const activeKey = FIELD_ORDER[fieldIndex]!;
  useEffect(() => {
    inputRefs.current[activeKey]?.focus();
  }, [activeKey]);

  const set = (key: FieldKey) => (v: string) => {
    setValues((s) => ({ ...s, [key]: v }));
    if (error) setError(null);
  };

  const submit = (): void => {
    if (fieldIndex < FIELD_ORDER.length - 1) { setFieldIndex(fieldIndex + 1); return; }
    const invalid = validatePushForm(values);
    if (invalid) {
      setError(invalid);
      const focusKey: FieldKey = invalid.startsWith("prompt") ? "prompt" : invalid.startsWith("workflow") ? "workflow" : "priority";
      setFieldIndex(FIELD_ORDER.indexOf(focusKey));
      return;
    }
    void onSubmit(buildPushParams(queue, values)).then(onClose).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err));
    });
  };

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (ev.key === "Enter") { ev.preventDefault(); submit(); return; }
    if (ev.key === "ArrowUp") { ev.preventDefault(); setFieldIndex((i) => Math.max(0, i - 1)); return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); setFieldIndex((i) => Math.min(FIELD_ORDER.length - 1, i + 1)); return; }
    if (ev.key.toLowerCase() === "n" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); onClose(); }
  };

  const field = (key: FieldKey, label: string, placeholder = "") => (
    <div className={styles.field}>
      <span className={key === activeKey ? styles.labelActive : styles.label}>{label}</span>
      <input
        ref={(el) => { inputRefs.current[key] = el; }}
        className={key === activeKey ? styles.inputActive : styles.input}
        value={values[key]}
        placeholder={placeholder}
        onChange={(e) => set(key)(e.target.value)}
        onFocus={() => setFieldIndex(FIELD_ORDER.indexOf(key))}
        data-field={key}
      />
    </div>
  );

  return (
    <OverlayCard width={620} align="center" onClose={onClose}>
      <div onKeyDown={onKeyDown}>
        <OverlayCardHeader
          title="push task"
          meta={`→ ${queue}`}
          hint={error ? <span className={styles.error}>{error}</span> : "esc cancel"}
        />
        <div className={styles.fields}>
          {field("prompt", "prompt")}
          <div className={styles.pair}>
            {field("priority", "priority")}
            {field("role", "role")}
          </div>
          {field("workflow", "workflow", defaultWorkflow ? `override "${defaultWorkflow}" (queue default)` : "optional — inherits the queue's binding")}
          {field("tags", "tags", "comma-separated, e.g. gate:coverage, area:core — hooks filter on these")}
        </div>
        <div className={styles.footer}>
          <span className={styles.submitChip} onClick={submit}>
            <span className={styles.submitKey}>enter</span>
            <span className={styles.submitVerb}> push</span>
          </span>
          <span className={styles.cancelChip} onClick={onClose}>esc cancel</span>
        </div>
      </div>
    </OverlayCard>
  );
}
