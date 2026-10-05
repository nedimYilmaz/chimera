import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { GitStatusSchema, type GitStatus, type GitTarget } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { createLoadStatus, runLoad, useLoadStatus } from "../state/loadStatus";
import { errorText } from "../state/errorText";
import { LoadStatusNote } from "./LoadStatusNote";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { dismissRegisteredOverlays, registerOverlay } from "./OverlayOutlet";
import { WorktreeFileEditor } from "./WorktreeFileEditor";
import styles from "./WorkingTreePanel.module.css";

const selections = new Map<string, string>();
const messages = new Map<string, string>();
export function WorkingTreePanel({ target, taskId, initialPath }: { target: GitTarget; taskId?: string; initialPath?: string }) {
  const targetKey = JSON.stringify(target);
  return <Tree key={targetKey} target={target} taskId={taskId} targetKey={targetKey} initialPath={initialPath} />;
}
function Tree({ target, taskId, targetKey, initialPath }: { target: GitTarget; taskId?: string; targetKey: string; initialPath?: string }) {
  const status = useMemo(createLoadStatus, []), view = useLoadStatus(status);
  const [data, setData] = useState<GitStatus | null>(null);
  const [path, setPath] = useState(initialPath ?? selections.get(targetKey) ?? "");
  const [stagedDiff, setStagedDiff] = useState(false);
  const [diff, setDiff] = useState<{ hunks: string; binary: boolean; truncated: boolean } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), mutationLock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [commitBase, setCommitBase] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState(messages.get(targetKey) ?? "");
  const [result, setResult] = useState<string | null>(null);
  const overlayId = useId();
  const alive = useRef(true), diffGeneration = useRef(0);
  useEffect(() => { if (initialPath) { selections.set(targetKey, initialPath); setPath(initialPath); } }, [initialPath, targetKey]);
  const load = useCallback(() => runLoad(status, async () => GitStatusSchema.parse(await rpcCall<GitStatus>("worktree.gitStatus", { target })), value => { setData(value); setError(null); }, { isUnsupported: e => /unknown.method|unsupported/i.test(errorText(e)) }), [status, targetKey]);
  useEffect(() => {
    alive.current = true; void load();
    let connected = appStore.getState().connected;
    const unsubscribe = appStore.subscribe(() => {
      const next = appStore.getState().connected;
      if (next === connected) return;
      connected = next;
      if (next) void load();
      else { status.interrupt("connection lost; refresh after reconnect"); diffGeneration.current++; setDiffError("connection lost; refresh after reconnect"); }
    });
    return () => { alive.current = false; status.interrupt("closed"); diffGeneration.current++; unsubscribe(); };
  }, [load, status]);
  useEffect(() => registerOverlay(`git-commit-${overlayId}`, () => null, () => setCommitBase(null)), [overlayId]);
  useEffect(() => {
    if (!path) return;
    const generation = ++diffGeneration.current; setDiff(null); setDiffError(null);
    void rpcCall<{ hunks: string; binary: boolean; truncated: boolean }>("worktree.gitDiff", { target, path, staged: stagedDiff, context: 3, maxBytes: 131072 }).then(value => { if (generation === diffGeneration.current) setDiff(value); }, err => { if (generation === diffGeneration.current) setDiffError(errorText(err)); });
    return () => { diffGeneration.current++; };
  }, [targetKey, path, stagedDiff, data]);
  const mutate = async (method: string, params: Record<string, unknown>, base = data) => {
    if (mutationLock.current || !base?.writable || !data?.writable || view.error || view.loading || !appStore.getState().connected) return;
    mutationLock.current = true; setBusy(true); setError(null); setResult(null);
    try {
      const value = await rpcCall<{ sha?: string }>(method, { target, expectedHead: base.head, expectedIndexFingerprint: base.indexFingerprint, ...params });
      if (!alive.current) return;
      if (value.sha) { setResult(`Committed ${value.sha}`); setCommitBase(null); messages.delete(targetKey); setMessage(""); }
      await load();
    } catch (err) { if (alive.current) { setError(errorText(err)); setCommitBase(null); } }
    finally { mutationLock.current = false; if (alive.current) setBusy(false); }
  };
  const writable = !!data?.writable && !busy && !view.loading && !view.error && !view.unsupported;
  const staged = data?.files.filter(f => f.staged) ?? [];
  const pick = (next: string) => { selections.set(targetKey, next); setPath(next); };
  return <section className={styles.panel} data-working-tree>
    <strong>Working tree</strong>{taskId && <span> · task {taskId}</span>}
    <LoadStatusNote status={view} what="working tree" hasRows={!!data} onRetry={() => void load()} />
    {view.unsupported && <p>Working-tree actions unavailable for this target or daemon.</p>}
    {data && <>
      <p data-git-branch>{data.branch ?? "detached HEAD"} · {data.head?.slice(0, 10) ?? "no commits"}</p>
      {!data.writable && <p role="status" data-git-lease>{data.writeReason}</p>}
      <div className={styles.actions}><button data-git-refresh disabled={view.loading || busy} onClick={() => void load()}>Refresh diff and status</button><button data-git-commit-open disabled={!writable || !staged.length} onClick={() => { dismissRegisteredOverlays(); setCommitBase(data); }}>Commit staged ({staged.length})</button></div>
      {!data.files.length && !view.error && <p>Working tree clean</p>}
      {data.truncated && <p>Changed-file list truncated; selected-file actions only</p>}
      <ul className={styles.files} aria-label="Working-tree files">{data.files.map(file => <li key={file.path} className={path === file.path ? styles.selected : undefined}>
        <button aria-pressed={path === file.path} onClick={() => pick(file.path)}>{file.index}{file.worktree} {file.path}</button>
        <button disabled={!writable} aria-label={`Stage ${file.path}`} onClick={() => void mutate("worktree.gitStage", { paths: [file.path], unstage: false })}>Stage file</button>
        {file.staged && <button disabled={!writable} aria-label={`Unstage ${file.path}`} onClick={() => void mutate("worktree.gitStage", { paths: [file.path], unstage: true })}>Unstage file</button>}
      </li>)}</ul>
      {path && <div><strong>{path}</strong><label><input type="checkbox" checked={stagedDiff} onChange={e => setStagedDiff(e.target.checked)} />Staged diff</label>
        {diffError ? <p role="alert">{diffError}</p> : !diff ? <p>Loading selected diff…</p> : <><pre data-git-diff>{diff.binary ? "Binary file — preview unavailable" : diff.hunks || "No tracked diff (new files can be opened with Edit text)"}</pre>{diff.truncated && <p>Diff truncated</p>}</>}
        <WorktreeFileEditor target={target} path={path} writable={writable} onSaved={() => void load()} />
      </div>}
    </>}
    {error && <p role="alert" data-git-error>{error} · Refresh and review before retrying.</p>}{result && <p role="status">{result}</p>}
    {commitBase && <OverlayCard width={560} onClose={() => { if (!busy) setCommitBase(null); }} ariaLabel="Review staged commit" dismissOnReplacement>
      <OverlayCardHeader title="Review staged commit" />
      <div className={styles.panel} data-git-commit><p>{commitBase.branch} · HEAD {commitBase.head?.slice(0, 10) ?? "unborn"}</p><p>Only the reviewed index is committed. Normal signing and hooks apply.</p><ul>{commitBase.files.filter(f => f.staged).map(f => <li key={f.path}>{f.path}</li>)}</ul>
        <label>Commit message<textarea autoFocus aria-label="Commit message" rows={3} value={message} disabled={busy} onChange={e => { setMessage(e.target.value); messages.set(targetKey, e.target.value); }} /></label>
        <div className={styles.actions}><button data-git-commit-submit disabled={busy || !message.trim() || !writable} onClick={() => void mutate("worktree.gitCommit", { message }, commitBase)}>Commit reviewed index</button><button disabled={busy} onClick={() => setCommitBase(null)}>Cancel</button></div>
      </div>
    </OverlayCard>}
  </section>;
}

export function WorkingTreeDisclosure(props: { target: GitTarget; taskId?: string; initialPath?: string }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={e => setOpen(e.currentTarget.open)}><summary>Working-tree actions · drafts retained on close</summary>{open && <WorkingTreePanel {...props} />}</details>;
}
