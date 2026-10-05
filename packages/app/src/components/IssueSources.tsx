import { useState } from "react";
import type { IssueSource } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { getCoordCommands } from "../state/commands.coord";
import { newestFirst } from "../state/selectors.coord";
import { useQueueIssues } from "../state/commands.issues";
import { ChipButton } from "./ChipButton";
import { LoadStatusNote } from "./LoadStatusNote";
import { openInlineLinkUrl } from "./linkUrl";
import { openIssueComment } from "./IssueCommentCard";
import styles from "./IssueSources.module.css";
const message = (e: unknown) => typeof e === "object" && e !== null && "message" in e ? String(e.message) : String(e);

export function IssueSources({ queue, onCreated }: { queue: string; onCreated?: () => void }) {
  const { sources, status, refresh } = useQueueIssues(queue);
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); const [setup, setSetup] = useState(false);
  const [projectId, setProjectId] = useState(""); const [repo, setRepo] = useState(""); const [labels, setLabels] = useState("");
  const [state, setState] = useState<"open" | "all">("open"); const [bindExisting, setBindExisting] = useState(false); const [allowRunningQueue, setAllowRunningQueue] = useState(false);
  const act = async (id: string, action: () => Promise<void>) => { if (busy) return; setBusy(id); setError(null); setNotice(null); try { await action(); } catch (e) { setError(message(e)); } finally { setBusy(null); } };
  const sync = (source: IssueSource) => act(source.id, async () => {
    const r = await rpcCall<{ ghState: string; imported: number; updated: number; truncated: boolean; retryAfterMs: number }>("issues.sync", { sourceId: source.id });
    setNotice(r.ghState === "missing" ? "gh is missing. Install gh outside Chimera, then retry." : r.ghState === "unauthenticated" ? "gh is unauthenticated. Run gh auth login outside Chimera, then retry." : r.retryAfterMs ? `Rate limited: retry in ${Math.ceil(r.retryAfterMs / 1000)} seconds.` : `${r.imported} imported · ${r.updated} updated${r.truncated ? " · more issues remain (bounded sync)" : ""}`);
    await refresh(); await getCoordCommands(appStore, rpcCall).openQueueDetail(queue);
  });
  return <details className={styles.root} data-issue-sources><summary>Sources · GitHub issues</summary><div className={styles.content}>
    <LoadStatusNote status={status} what="issue sources" hasRows={sources.length > 0} onRetry={() => { void refresh(); }} />
    {status.unsupported ? <p>GitHub issue sources are unavailable on this daemon.</p> : <>
      {status.loaded && !status.error && sources.length === 0 && <p>No sources bound to this queue. Opt in below.</p>}
      {sources.map(source => <div key={source.id} data-source-id={source.id}>
        <div className={styles.row}><strong>{source.repo}</strong><span>{source.state} · {source.labels.join(", ") || "all labels"} · {source.enabled ? "enabled" : "disabled"}</span>
          <ChipButton disabled={busy !== null || !source.enabled || status.loading} onClick={() => { void sync(source); }}>{busy === source.id ? "Syncing…" : "Sync now"}</ChipButton>
          <ChipButton disabled={busy !== null} onClick={() => { void act(source.id, async () => { await rpcCall("issues.sourceRemove", { sourceId: source.id }); await refresh(); }); }}>Remove source</ChipButton>
        </div>
        {source.lastError && <p role="alert">{source.lastError}</p>}
        <span className={styles.note}>{source.lastSyncAt === null ? "Never synced" : `Last synced ${new Date(source.lastSyncAt).toLocaleTimeString()}`}</span>
      </div>)}
      <ChipButton onClick={() => setSetup(!setup)} disabled={busy !== null}>{setup ? "Hide setup" : "Add source"}</ChipButton>
      {setup && <form className={styles.form} onSubmit={e => { e.preventDefault(); void act("setup", async () => {
        const source = await rpcCall<IssueSource>("issues.sourceUpsert", { projectId, repo, labels: labels.split(",").map(s => s.trim()).filter(Boolean), state, ...(bindExisting ? { queue, allowRunningQueue } : {}) });
        setSetup(false); await getCoordCommands(appStore, rpcCall).loadQueues();
        const snapshot = appStore.getState(); const index = newestFirst(snapshot.queues.items).findIndex(q => q["name"] === source.queue);
        onCreated?.(); if (index >= 0) appStore.dispatch({ type: "queueCursor", delta: index - snapshot.queueCursor });
        await getCoordCommands(appStore, rpcCall).openQueueDetail(source.queue); await refresh();
      }); }}>
        <label>Project name<input required value={projectId} onChange={e => setProjectId(e.target.value)} /></label>
        <label>Repository (owner/repo)<input required pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" value={repo} onChange={e => setRepo(e.target.value)} /></label>
        <label>Labels (comma separated, up to 8)<input value={labels} onChange={e => setLabels(e.target.value)} /></label>
        <label>Issue scope<select value={state} onChange={e => setState(e.target.value as "open" | "all")}><option value="open">Open issues</option><option value="all">All issues (closed issues update existing links)</option></select></label>
        <label className={styles.row}><input type="checkbox" checked={bindExisting} onChange={e => setBindExisting(e.target.checked)} />Bind this existing queue</label>
        {bindExisting && <label className={styles.row}><input type="checkbox" checked={allowRunningQueue} onChange={e => setAllowRunningQueue(e.target.checked)} />I allow dispatch if this queue is running</label>}
        <p className={styles.note}>Default: create a paused queue. Imported issue text is untrusted task data. Authenticate gh outside Chimera. One-way import and explicit comments; no webhooks, label writes or PR linking.</p>
        <button type="submit" disabled={busy !== null}>{busy === "setup" ? "Saving…" : "Save source"}</button>
      </form>}
    </>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error} <ChipButton disabled={busy !== null} onClick={() => { void refresh(); }}>Retry read</ChipButton></p>}
  </div></details>;
}

export function IssueChip({ queue, taskId }: { queue: string; taskId: string }) {
  const { links } = useQueueIssues(queue); const link = links.find(l => l.taskId === taskId);
  if (!link) return null;
  return <span className={styles.chip} data-issue-chip onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <button onClick={() => openInlineLinkUrl(link.url)} aria-label={`Open GitHub issue ${link.repo}#${link.number}`}>#{link.number}</button>
    <span>{link.boardStatus.replaceAll("_", " ")}</span>{link.changed && <span>issue changed</span>}{link.state === "closed" && <span>closed upstream</span>}
    <button onClick={() => openIssueComment(link)}>Post result to #{link.number}</button>
  </span>;
}
