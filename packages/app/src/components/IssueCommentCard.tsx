import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { IssueBoardLink } from "@chimera/protocol";
import type { RpcResponseFor } from "@chimera/protocol/contract";
import { rpcCall } from "../rpc/bridge";
import { dismissRegisteredOverlays, registerOverlay, type OverlayProps } from "./OverlayOutlet";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { ChipButton } from "./ChipButton";
import styles from "./IssueSources.module.css";
let selected: IssueBoardLink | null = null;
const listeners = new Set<() => void>(); const drafts = new Map<string, string>();
const emit = () => { for (const l of listeners) l(); };
export function closeIssueComment() { selected = null; emit(); }
export function openIssueComment(link: IssueBoardLink) { dismissRegisteredOverlays(); selected = link; emit(); }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
function CommentForm({ link }: { link: IssueBoardLink }) {
  const [body, setBody] = useState(drafts.get(link.taskId) ?? link.resultText ?? ""); const [closeIssue, setCloseIssue] = useState(false);
  const [preview, setPreview] = useState<RpcResponseFor<"issues.postComment"> | null>(null);
  const [writeBlocked, setWriteBlocked] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const generation = useRef(0);
  // An obsolete reply must not dismiss the replacement overlay.
  useEffect(() => () => { generation.current++; }, []);
  const invalidate = () => { generation.current++; setPreview(null); setError(null); setWriteBlocked(false); };
  const post = async (confirm: boolean) => {
    if (busy) return; const g = ++generation.current; setBusy(true); setError(null);
    try {
      const result = await rpcCall<RpcResponseFor<"issues.postComment">>("issues.postComment", { taskId: link.taskId, body, closeIssue, phase: confirm ? "confirm" : "preview", ...(confirm ? { previewId: preview?.previewId } : {}) });
      if (g !== generation.current) return;
      if (result.status === "posted") { drafts.delete(link.taskId); closeIssueComment(); }
      else if (result.status === "conflict" || result.status === "partial" || result.status === "uncertain") { setPreview(null); setError(result.message); setWriteBlocked(result.status !== "conflict"); }
      else setPreview(result);
    } catch (e) { if (g === generation.current) setError(typeof e === "object" && e !== null && "message" in e ? String(e.message) : String(e)); }
    finally { setBusy(false); }
  };
  return <OverlayCard width={620} onClose={closeIssueComment} dismissOnReplacement>
    <OverlayCardHeader title={`Post result to ${link.repo}#${link.number}`} />
    <div className={styles.form} data-issue-comment>
      <label>Comment text<textarea autoFocus value={body} disabled={busy} onChange={e => { invalidate(); setBody(e.target.value); drafts.set(link.taskId, e.target.value); }} /></label>
      <label className={styles.row}><input type="checkbox" checked={closeIssue} disabled={busy || link.boardStatus !== "accepted"} onChange={e => { invalidate(); setCloseIssue(e.target.checked); }} />Close issue as completed (accepted review required)</label>
      {preview && <div data-exact-issue-preview><p>Exact operation: comment on {preview.repo}#{preview.number}{preview.closeIssue ? " and close as completed" : " (keep issue state)"}</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{preview.body}</pre><p>{preview.message}</p></div>}
      {error && <p role="alert">{error}</p>}
      <div className={styles.row}>
        <ChipButton disabled={busy || writeBlocked || !body.trim()} onClick={() => { void post(!!preview); }}>{busy ? "Working…" : writeBlocked ? "Inspect issue on GitHub" : preview ? "Confirm exact operation" : "Create preview"}</ChipButton>
        <ChipButton disabled={busy} onClick={closeIssueComment}>Cancel</ChipButton>
      </div>
    </div>
  </OverlayCard>;
}
export function IssueCommentCard({ host }: OverlayProps) {
  const link = useSyncExternalStore(subscribe, () => selected);
  return host === "queues" && link ? <CommentForm key={link.taskId} link={link} /> : null;
}
registerOverlay("issue-comment", IssueCommentCard, closeIssueComment);
