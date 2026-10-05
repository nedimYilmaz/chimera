import { useEffect, useMemo, useRef, useState } from "react";
import type { GitFile, GitTarget } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { readFileDraft, saveFileDraft, type FileDraft } from "../state/gitDrafts";
import { errorText } from "../state/errorText";
import styles from "./WorkingTreePanel.module.css";
import { FileViewer } from "../screens/FileViewer";

export function WorktreeFileEditor({ target, path, writable, onSaved }: { target: GitTarget; path: string; writable: boolean; onSaved: () => void }) {
  const key = JSON.stringify(target) + ":" + path;
  return <Editor key={key} draftKey={key} target={target} path={path} writable={writable} onSaved={onSaved} />;
}
function Editor({ draftKey, target, path, writable, onSaved }: { draftKey: string; target: GitTarget; path: string; writable: boolean; onSaved: () => void }) {
  const initial = useMemo(() => readFileDraft(draftKey), [draftKey]);
  const [file, setFile] = useState<FileDraft | null>(initial);
  const [editing, setEditing] = useState(!!initial && initial.draft !== initial.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disk, setDisk] = useState<GitFile | null>(null);
  const [cancelChoice, setCancelChoice] = useState(false);
  const [viewer, setViewer] = useState<GitFile | null>(null);
  const active = useRef(true), lock = useRef(false), textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (editing && file?.cursor !== undefined && textarea.current) textarea.current.setSelectionRange(file.cursor, file.cursor); }, [editing]);
  const update = (value: FileDraft) => { saveFileDraft(draftKey, value); if (active.current) setFile(value); };
  const load = async (compare = false) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const data = await rpcCall<GitFile>("worktree.fileRead", { target, path });
      if (!active.current) return;
      if (compare) setDisk(data);
      else { update({ ...data, draft: data.text }); setEditing(true); }
    } catch (err) { if (active.current) setError(errorText(err)); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  };
  const save = async () => {
    if (!file || lock.current || !writable) return;
    lock.current = true; setBusy(true); setError(null);
    const submitted = file;
    try {
      const result = await rpcCall<{ contentVersion: string }>("worktree.fileWrite", { target, path, text: submitted.draft, expectedContentVersion: submitted.contentVersion });
      update({ ...submitted, text: submitted.draft, contentVersion: result.contentVersion });
      if (active.current) { setDisk(null); onSaved(); }
    } catch (err) { if (active.current) setError(errorText(err)); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  };
  const dirty = !!file && file.draft !== file.text;
  return <section className={styles.editor} data-git-editor>
    <button disabled={busy} onClick={() => {
      void rpcCall<GitFile>("worktree.fileRead", { target, path }).then(value => { if (active.current) setViewer(value); }, err => { if (active.current) setError(errorText(err)); });
    }}>View file</button>
    {viewer && <FileViewer selected={{ status: "ok", path, result: { path, encoding: "utf8", content: viewer.text, sizeBytes: viewer.bytes, binary: false, mediaType: null, truncated: false } }} worktree={{ target, path }} onClose={() => setViewer(null)} />}
    {!editing ? <button data-git-edit-load disabled={busy || !writable} onClick={() => file ? setEditing(true) : void load()}>Edit text</button> : file && <>
      <label>Text draft · {path}<textarea ref={textarea} autoFocus aria-label="File text draft" value={file.draft} maxLength={262144} disabled={busy} rows={8} onSelect={e => update({ ...file, cursor: e.currentTarget.selectionStart })} onChange={e => update({ ...file, draft: e.target.value, cursor: e.target.selectionStart })} /></label>
      <span>{dirty ? "Unsaved draft retained for this worktree and file" : "Saved"}</span>
      <div className={styles.actions}><button data-git-edit-save disabled={busy || !dirty || !writable} onClick={() => void save()}>Save text</button><button disabled={busy} onClick={() => dirty ? setCancelChoice(true) : setEditing(false)}>Cancel edit</button></div>
      {cancelChoice && <div role="alert">Keep this unsaved draft?<button onClick={() => { setEditing(false); setCancelChoice(false); }}>Keep draft and close</button><button onClick={() => { update({ ...file, draft: file.text }); setEditing(false); setCancelChoice(false); }}>Discard this draft</button></div>}
    </>}
    {error && <div role="alert">{error}<button disabled={busy} onClick={() => void load(!!file)}>Reload for comparison</button></div>}
    {disk && <details open><summary>Current disk text · draft retained</summary><pre>{disk.text}</pre><button disabled={busy} onClick={() => { if (file) update({ ...disk, draft: file.draft }); setDisk(null); setError(null); }}>Use current disk version as save base</button></details>}
  </section>;
}
