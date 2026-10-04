import { useEffect, useRef, useState } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { buildEditPatch, validateEditForm, type EditTaskFormValues } from "../state/selectors.coord";
import styles from "./PushTaskCard.module.css";

// TASK-EDIT-VERSIONING — the edit-task form: PushTaskCard's silhouette (shared
// CSS module), but PREFILLED from the still-queued task's current head fields
// and submitting a queue.editTask patch. Only the scalar fields (prompt/
// priority/role) are here; overrides & the workflow binding are editable ONLY
// via the queue_edit_task command-palette tool — a JSON editor doesn't belong
// in this form, so a footer note points there instead. esc cancels; final
// enter submits.

type FieldKey = keyof EditTaskFormValues;
// TASK-TAGS: emptying this field REMOVES every tag — the patch is a whole-value replacement.
const FIELD_ORDER: readonly FieldKey[] = ["prompt", "priority", "role", "tags"];

export function EditTaskCard({ taskId, queue, initial, onSubmit, onClose }: {
  taskId: string;
  queue: string;
  /** The task's current head fields (selectors.coord.editFormValuesFromTask). */
  initial: EditTaskFormValues;
  onSubmit: (patch: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<EditTaskFormValues>(initial);
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
    const invalid = validateEditForm(values);
    if (invalid) {
      setError(invalid);
      setFieldIndex(FIELD_ORDER.indexOf(invalid.startsWith("prompt") ? "prompt" : "priority"));
      return;
    }
    void onSubmit(buildEditPatch(values)).then(onClose).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err));
    });
  };

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (ev.key === "Enter") { ev.preventDefault(); submit(); return; }
    if (ev.key === "ArrowUp") { ev.preventDefault(); setFieldIndex((i) => Math.max(0, i - 1)); return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); setFieldIndex((i) => Math.min(FIELD_ORDER.length - 1, i + 1)); return; }
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
          title="edit task"
          meta={`${taskId} → ${queue}`}
          hint={error ? <span className={styles.error}>{error}</span> : "esc cancel"}
        />
        <div className={styles.fields}>
          {field("prompt", "prompt")}
          <div className={styles.pair}>
            {field("priority", "priority")}
            {field("role", "role", "optional — clears the per-task override")}
          </div>
          {field("tags", "tags", "comma-separated — emptying this removes every tag")}
          <div className={styles.field}>
            <span className={styles.label} />
            <span className={styles.note}>overrides &amp; workflow binding: edit via the command palette (queue_edit_task)</span>
          </div>
        </div>
        <div className={styles.footer}>
          <span className={styles.submitChip} onClick={submit}>
            <span className={styles.submitKey}>enter</span>
            <span className={styles.submitVerb}> save</span>
          </span>
          <span className={styles.cancelChip} onClick={onClose}>esc cancel</span>
        </div>
      </div>
    </OverlayCard>
  );
}
