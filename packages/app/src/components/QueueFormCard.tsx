import { useEffect, useRef, useState } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { ConfirmCard } from "./ConfirmCard";
import { ChipButton } from "./ChipButton";
import {
  buildQueueSpec, buildQueueUpdatePatch, validateQueueForm, type QueueFormValues,
} from "../state/selectors.coord";
import styles from "./QueueFormCard.module.css";

// W16 (F15/D11 CRUD completion, coverage B9) — the create/edit-queue form,
// structurally a copy of TeamFormCard's field-walk convention (OverlayCard
// center 620). Fields: name* (locked once editing — identity field) /
// retryLimit. Create calls queue.create{spec}; edit calls queue.update{patch}
// (only retryLimit is patchable); esc cancels, mod+o re-toggles.

type FieldKey = keyof QueueFormValues;
const FIELD_ORDER: readonly FieldKey[] = ["name", "retryLimit"];

export function QueueFormCard({ mode = "create", initial, onSubmit, onClose }: {
  mode?: "create" | "edit";
  initial?: QueueFormValues;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<QueueFormValues>(initial ?? { name: "", retryLimit: "2" });
  const initialValuesRef = useRef(values);
  const dirty = JSON.stringify(values) !== JSON.stringify(initialValuesRef.current);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = (): void => { if (dirty) setConfirmClose(true); else onClose(); };
  // name (index 0) is locked in edit mode — start the walk on retryLimit.
  const [fieldIndex, setFieldIndex] = useState(() => (mode === "edit" ? 1 : 0));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRefs = useRef<Partial<Record<FieldKey, HTMLInputElement | null>>>({});

  const activeKey = FIELD_ORDER[fieldIndex]!;
  useEffect(() => {
    inputRefs.current[activeKey]?.focus();
  }, [activeKey]);

  const set = (key: FieldKey) => (v: string) => {
    setValues((s) => ({ ...s, [key]: v }));
    if (error) setError(null);
  };

  const editing = mode === "edit";

  const submit = (): void => {
    if (busy) return;
    if (fieldIndex < FIELD_ORDER.length - 1) { setFieldIndex(fieldIndex + 1); return; }
    const invalid = validateQueueForm(values);
    if (invalid) {
      setError(invalid);
      setFieldIndex(invalid.startsWith("name") ? 0 : 1);
      return;
    }
    const payload = editing ? buildQueueUpdatePatch(values) : buildQueueSpec(values);
    setBusy(true);
    void onSubmit(payload).then(onClose).catch((err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err));
    });
  };

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    // Footer buttons invoke their own native click on Enter/Space.  The form
    // field-walk must not reinterpret a focused Cancel as another submit.
    if (typeof Element !== "undefined" && ev.target instanceof Element && ev.target.closest("button")) return;
    if (ev.key === "Enter") { ev.preventDefault(); submit(); return; }
    if (ev.key === "ArrowUp") { ev.preventDefault(); setFieldIndex((i) => Math.max(0, i - 1)); return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); setFieldIndex((i) => Math.min(FIELD_ORDER.length - 1, i + 1)); return; }
    if (ev.key.toLowerCase() === "n" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); requestClose(); }
  };

  const field = (key: FieldKey, label: string, placeholder = "", locked = false) => (
    <div className={styles.field}>
      <span className={key === activeKey ? styles.labelActive : styles.label}>{label}</span>
      <input
        ref={(el) => { inputRefs.current[key] = el; }}
        className={key === activeKey ? styles.inputActive : styles.input}
        value={values[key]}
        placeholder={placeholder}
        disabled={locked}
        onChange={(e) => set(key)(e.target.value)}
        onFocus={() => setFieldIndex(FIELD_ORDER.indexOf(key))}
        data-field={key}
      />
    </div>
  );

  return (
    <OverlayCard width={620} align="center" onClose={requestClose} escGuard={() => confirmClose}>
      <div onKeyDown={onKeyDown}>
        <OverlayCardHeader
          title={editing ? `edit queue · ${values.name}` : "create queue"}
          hint={error ? <span className={styles.error}>{error}</span> : "↑↓ fields · enter next · esc cancel"}
        />
        <div className={styles.fields}>
          {field("name", "name", "", editing)}
          {field("retryLimit", "retry limit")}
        </div>
        <div className={styles.footer}>
          <ChipButton className={styles.submitChip} onClick={submit} disabled={busy} data-queue-submit>
            <span className={styles.submitKey}>enter</span>
            <span className={styles.submitVerb}> {editing ? "save" : "create"}</span>
          </ChipButton>
          <ChipButton className={styles.cancelChip} onClick={requestClose} data-queue-cancel>esc cancel</ChipButton>
        </div>
      </div>
      {confirmClose && <ConfirmCard
        title="⚠ discard changes"
        body={`This ${editing ? "edit" : "queue"} has unsaved edits. Closing now discards them.`}
        note="This cannot be undone."
        confirmLabel="confirm discard"
        onConfirm={onClose}
        onClose={() => setConfirmClose(false)}
      />}
    </OverlayCard>
  );
}
