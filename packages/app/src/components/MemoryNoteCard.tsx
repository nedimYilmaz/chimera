import { useEffect, useId, useRef, useState } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { buildMemoryAddParams, buildMemoryUpdateParams, validateMemoryForm, type MemoryFormValues } from "../state/selectors.coord";
import { useWikiAutocomplete, WikiAutocompletePopup } from "./WikiAutocomplete";
import styles from "./MemoryNoteCard.module.css";

// W5 — the add-memory-note form (mock showMemoryForm, s_memory 777-798):
// OverlayCard center 620 in the memory panel host. enter walks + submits
// memory.add; errors inline; footer carries the mock's shared-pool note. esc
// cancels, mod+o re-toggles.
//
// W16 (F15/D11): the SAME card doubles as "edit note" — `initial` prefills
// the fields and submit calls memory.update instead of memory.add.
//
// MEM-5: title + folder join the field set (order title · text · tags · kind ·
// folder), folder offers a datalist of known folders, and the text field gets
// the `[[` title-autocomplete popup (§8).

type FieldKey = keyof MemoryFormValues;
const FIELD_ORDER: readonly FieldKey[] = ["title", "text", "tags", "kind", "folder"];
const EMPTY: MemoryFormValues = { title: "", text: "", tags: "", kind: "note", folder: "" };

export function MemoryNoteCard({ mode = "create", initial, noteId, titles = [], folders = [], onSubmit, onClose }: {
  mode?: "create" | "edit";
  initial?: MemoryFormValues;
  noteId?: string;   // required when mode==="edit"
  titles?: string[];
  folders?: string[];
  onSubmit: (params: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<MemoryFormValues>(initial ?? EMPTY);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRefs = useRef<Partial<Record<FieldKey, HTMLInputElement | null>>>({});
  const textRef = useRef<HTMLInputElement | null>(null);
  const folderListId = useId();

  const activeKey = FIELD_ORDER[fieldIndex]!;
  useEffect(() => {
    inputRefs.current[activeKey]?.focus();
  }, [activeKey]);

  const set = (key: FieldKey) => (v: string) => {
    setValues((s) => ({ ...s, [key]: v }));
    if (error) setError(null);
  };

  const wiki = useWikiAutocomplete({ titles, elRef: textRef, onChange: (next) => set("text")(next) });

  const submit = (): void => {
    if (fieldIndex < FIELD_ORDER.length - 1) { setFieldIndex(fieldIndex + 1); return; }
    const invalid = validateMemoryForm(values);
    if (invalid) {
      setError(invalid);
      setFieldIndex(FIELD_ORDER.indexOf("text"));
      return;
    }
    const params = mode === "edit" && noteId ? buildMemoryUpdateParams(noteId, values, "app") : buildMemoryAddParams(values, "app");
    void onSubmit(params).then(onClose).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err));
    });
  };

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    // While the `[[` popup is open over the text field, it owns Enter/Esc/arrows.
    // stopPropagation so an Escape that only dismissed the popup doesn't bubble to
    // the OverlayCard's own Escape→onClose and tear down the whole card.
    if (activeKey === "text" && wiki.onKeyDown(ev)) { ev.stopPropagation(); return; }
    if (ev.key === "Enter") { ev.preventDefault(); submit(); return; }
    if (ev.key === "ArrowUp") { ev.preventDefault(); setFieldIndex((i) => Math.max(0, i - 1)); return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); setFieldIndex((i) => Math.min(FIELD_ORDER.length - 1, i + 1)); return; }
    if (ev.key.toLowerCase() === "n" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); onClose(); }
  };

  const field = (key: FieldKey, label: string) => {
    const isText = key === "text";
    const isFolder = key === "folder";
    return (
      <div className={styles.field}>
        <span className={key === activeKey ? styles.labelActive : styles.label}>{label}</span>
        <div className={styles.inputWrap}>
          <input
            ref={(el) => { inputRefs.current[key] = el; if (isText) textRef.current = el; }}
            className={key === activeKey ? styles.inputActive : styles.input}
            value={values[key]}
            onChange={(e) => { set(key)(e.target.value); if (isText) wiki.refresh(); }}
            onFocus={() => setFieldIndex(FIELD_ORDER.indexOf(key))}
            onKeyUp={isText ? wiki.refresh : undefined}
            onClick={isText ? wiki.refresh : undefined}
            data-field={key}
            list={isFolder ? folderListId : undefined}
            maxLength={key === "title" ? 120 : undefined}
          />
          {isText && wiki.showing && (
            <WikiAutocompletePopup candidates={wiki.candidates} active={wiki.active} onPick={wiki.insert} />
          )}
        </div>
        {isFolder && (
          <datalist id={folderListId}>
            {folders.map((f) => <option key={f} value={f} />)}
          </datalist>
        )}
      </div>
    );
  };

  return (
    <OverlayCard width={620} align="center" onClose={onClose} escGuard={() => wiki.showing}>
      <div onKeyDown={onKeyDown}>
        <OverlayCardHeader
          title={mode === "edit" ? "edit note" : "add memory note"}
          hint={error ? <span className={styles.error}>{error}</span> : "↑↓ fields · esc cancel"}
        />
        <div className={styles.fields}>
          {field("title", "title")}
          {field("text", "text")}
          <div className={styles.pair}>
            {field("tags", "tags")}
            {field("kind", "kind")}
          </div>
          {field("folder", "folder")}
        </div>
        <div className={styles.footer}>
          <span className={styles.submitChip} onClick={submit}>
            <span className={styles.submitKey}>enter</span>
            <span className={styles.submitVerb}> save</span>
          </span>
          <span className={styles.cancelChip} onClick={onClose}>esc cancel</span>
          <span className={styles.spacer} />
          <span className={styles.poolNote}>agents see the same notes via memory_* MCP tools</span>
        </div>
      </div>
    </OverlayCard>
  );
}
