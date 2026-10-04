import { useEffect, useId, useRef, useState } from "react";
import { buildMemoryUpdateParams, validateMemoryForm, type MemoryFormValues } from "../state/selectors.coord";
import { MessageBody } from "./MessageBody";
import { useWikiAutocomplete, WikiAutocompletePopup } from "./WikiAutocomplete";
import styles from "./MemoryNoteEditor.module.css";

// In-place note editor (user request: "edit dedigimde alan rich text editore
// donusmeli"). Replaces the whole memory detail body when editing: a full-pane
// markdown editor with a Write/Preview toggle so you edit the source AND see it
// formatted through the SAME MessageBody renderer the read view uses — the
// "rich" part without a heavyweight WYSIWYG. ctrl/cmd+enter saves, esc cancels.
//
// MEM-5: gains a title field + a folder field (datalist of known folders) and a
// `[[` title-autocomplete over the body textarea (§8).
const KINDS = ["note", "decision", "fact", "todo", "question"] as const;

export function MemoryNoteEditor({ noteId, initial, titles = [], folders = [], onSave, onClose }: {
  noteId: string;
  initial: MemoryFormValues;
  titles?: string[];
  folders?: string[];
  onSave: (params: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<MemoryFormValues>(initial);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const folderListId = useId();

  // Focus the body on open (edit is a text-first action), caret at the end.
  useEffect(() => {
    const el = textRef.current;
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }, []);

  const set = <K extends keyof MemoryFormValues>(key: K, v: string): void => {
    setValues((s) => ({ ...s, [key]: v }));
    if (error) setError(null);
  };

  const wiki = useWikiAutocomplete({ titles, elRef: textRef, onChange: (next) => set("text", next) });

  const save = (): void => {
    if (saving) return;
    const invalid = validateMemoryForm(values);
    if (invalid) { setError(invalid); setPreview(false); textRef.current?.focus(); return; }
    setSaving(true);
    void onSave(buildMemoryUpdateParams(noteId, values, "app"))
      .then(onClose)
      .catch((err: unknown) => {
        setSaving(false);
        setError(err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err));
      });
  };

  // ctrl/cmd+enter saves from anywhere in the editor; esc cancels. (A bare Enter
  // in the textarea inserts a newline — this is multi-line markdown.) The `[[`
  // autocomplete gets first crack at Enter/Esc/arrows while its popup is open.
  // CRITICAL: every branch that acts MUST stopPropagation — the textarea sits
  // inside the editor <div> which also carries onShellKeyDown (for the title/
  // folder/tags inputs), so without this the same keydown bubbles up and runs
  // twice: ctrl+Enter would fire two memory.update RPCs, and an Escape that only
  // meant to dismiss the [[ popup would bubble to onShellKeyDown and discard the
  // whole edit.
  const onBodyKeyDown = (ev: React.KeyboardEvent): void => {
    if (wiki.onKeyDown(ev)) { ev.stopPropagation(); return; }
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); ev.stopPropagation(); save(); return; }
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); onClose(); }
  };
  const onShellKeyDown = (ev: React.KeyboardEvent): void => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(); return; }
    if (ev.key === "Escape") { ev.preventDefault(); onClose(); }
  };

  return (
    <div className={styles.editor} onKeyDown={onShellKeyDown}>
      <input
        className={styles.title}
        value={values.title}
        onChange={(e) => set("title", e.target.value)}
        placeholder="title (optional)"
        aria-label="title"
        maxLength={120}
      />
      <div className={styles.toolbar}>
        <select
          className={styles.kind}
          value={values.kind}
          onChange={(e) => set("kind", e.target.value)}
          aria-label="kind"
        >
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input
          className={styles.folder}
          value={values.folder}
          onChange={(e) => set("folder", e.target.value)}
          placeholder="folder (a/b/c)"
          aria-label="folder"
          list={folderListId}
        />
        <datalist id={folderListId}>
          {folders.map((f) => <option key={f} value={f} />)}
        </datalist>
        <input
          className={styles.tags}
          value={values.tags}
          onChange={(e) => set("tags", e.target.value)}
          placeholder="tags (comma-separated)"
          aria-label="tags"
        />
        <span className={styles.spacer} />
        <div className={styles.toggle}>
          <button type="button" className={!preview ? styles.tabActive : styles.tab} onClick={() => setPreview(false)}>Write</button>
          <button type="button" className={preview ? styles.tabActive : styles.tab} onClick={() => setPreview(true)}>Preview</button>
        </div>
      </div>

      <div className={styles.body}>
        {preview ? (
          <MessageBody text={values.text} done rawView={false} />
        ) : (
          <div className={styles.textWrap}>
            <textarea
              ref={textRef}
              className={styles.textarea}
              value={values.text}
              onChange={(e) => { set("text", e.target.value); wiki.refresh(); }}
              onKeyUp={wiki.refresh}
              onClick={wiki.refresh}
              onKeyDown={onBodyKeyDown}
              placeholder="note (markdown supported · [[ links a note)"
              aria-label="note text"
              spellCheck={false}
            />
            {wiki.showing && (
              <WikiAutocompletePopup candidates={wiki.candidates} active={wiki.active} onPick={wiki.insert} placement="above" />
            )}
          </div>
        )}
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}
      <div className={styles.actions}>
        <span className={styles.hint}>⌘↵ save · esc cancel</span>
        <span className={styles.spacer} />
        <button type="button" className={styles.cancel} onClick={onClose} disabled={saving}>cancel</button>
        <button type="button" className={styles.save} onClick={save} disabled={saving}>{saving ? "saving…" : "save"}</button>
      </div>
    </div>
  );
}
