import { WorkingTreeDisclosure } from "../components/WorkingTreePanel";
import { useEffect, useMemo, useState } from "react";
import type { ReviewFinding } from "@chimera/protocol";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { reviewFiles, nextReviewHunk, reviewUnavailable, reviewIsLive } from "../state/selectors.review";
import { HighlightedCode } from "./FileViewer";
import styles from "./ReviewRoomScreen.module.css";
import { rpcCall } from "../rpc/bridge";
import { getEvidenceCommands } from "../state/commands.evidence";
import { isEditableTarget } from "../keymap";
import { errorText } from "../state/errorText";

const reviewCommands = getEvidenceCommands(rpcCall);

const SEVERITY_GLYPH: Record<ReviewFinding["severity"], string> = { note: "·", warning: "▲", blocking: "✗" };

// Live diff refresh: while the room is open on an in_progress task, re-fetch evidence.get on a
// short poll so the diff catches up as the agent commits/edits. Stops itself the moment the
// fetched evidence's state moves off "in_progress" (task landed/failed/etc.) or the room closes
// (openTaskId changes) — see the effect's cleanup and its `live` dependency below.
const LIVE_POLL_MS = 1500;

export function ReviewRoomScreen() {
  const room = useStore((s) => s.reviewRoom);
  const evidence = room.openTaskId ? room.evidenceByTask[room.openTaskId] ?? null : null;
  const files = useMemo(() => reviewFiles(evidence), [evidence]);
  const unavailable = useMemo(() => reviewUnavailable(evidence), [evidence]);
  const live = reviewIsLive(evidence);
  const selected = files.find((f) => f.path === room.selectedPath) ?? files[0] ?? null;
  const session = room.openTaskId ? room.sessionsByTask[room.openTaskId] : undefined;
  // DECIDE-BUSY-GUARD: decide() had neither the RULE-FORM-BUSY-GUARD (a fast double-click
  // fired review.decide twice) nor error handling (a rejected RPC vanished silently, leaving
  // the decision stuck at "pending" with no sign anything went wrong) — the same double-submit
  // and missing-feedback class already guarded against on the findings form below.
  const [decideBusy, setDecideBusy] = useState(false);
  const [decideError, setDecideError] = useState<string | null>(null);
  const decide = (status: "accepted" | "changes_requested") => {
    const taskId = room.openTaskId;
    if (!taskId || decideBusy) return;
    setDecideBusy(true);
    setDecideError(null);
    void reviewCommands.decide(taskId, status, status === "accepted" ? "review accepted" : "address open review findings")
      .then((next) => appStore.dispatch({ type: "reviewRoomSession", session: next }))
      .catch((err) => setDecideError(errorText(err)))
      .finally(() => setDecideBusy(false));
  };
  // Threaded findings: backend RPCs (review.finding.add/resolve) and their session
  // slice have existed since the review room landed, but nothing ever called them —
  // findings could never be created. `busy` mirrors the RULE-FORM-BUSY-GUARD pattern
  // (disable the submit control for the duration of the in-flight request) so a fast
  // double-click can't fire the RPC twice.
  const [findingBody, setFindingBody] = useState("");
  const [findingSeverity, setFindingSeverity] = useState<ReviewFinding["severity"]>("note");
  const [findingBusy, setFindingBusy] = useState(false);
  const [findingError, setFindingError] = useState<string | null>(null);
  const refreshSession = (taskId: string) => reviewCommands.getReview(taskId).then((next) => appStore.dispatch({ type: "reviewRoomSession", session: next }));
  const submitFinding = () => {
    const taskId = room.openTaskId;
    const path = selected?.path;
    if (!taskId || !path || findingBusy || !findingBody.trim()) return;
    setFindingBusy(true);
    setFindingError(null);
    void reviewCommands.addFinding({ taskId, path, hunkId: room.selectedHunkId, severity: findingSeverity, body: findingBody.trim() })
      .then(() => { setFindingBody(""); return refreshSession(taskId); })
      .catch((err) => setFindingError(errorText(err)))
      .finally(() => setFindingBusy(false));
  };
  const resolveFindingClick = (findingId: string) => {
    const taskId = room.openTaskId;
    if (!taskId || findingBusy) return;
    setFindingBusy(true);
    setFindingError(null);
    void reviewCommands.resolveFinding(taskId, findingId)
      .then(() => refreshSession(taskId))
      .catch((err) => setFindingError(errorText(err)))
      .finally(() => setFindingBusy(false));
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || (event.target instanceof Element && event.target.closest('[role="dialog"]'))) return;
      if (event.key === "Escape") appStore.dispatch({ type: "reviewRoomClose" });
      else if (event.key === "]" || event.key === "[") {
        const next = nextReviewHunk(files, room.selectedHunkId, event.key === "]" ? 1 : -1);
        if (next) appStore.dispatch({ type: "reviewRoomSelect", path: next.path, hunkId: next.hunkId });
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [files, room.selectedHunkId]);
  useEffect(() => {
    const taskId = room.openTaskId;
    if (!taskId || !live) return;
    let alive = true;
    const id = setInterval(() => {
      reviewCommands.get(taskId).then(
        (next) => { if (alive) appStore.dispatch({ type: "reviewRoomEvidenceRefreshed", taskId, evidence: next }); },
        () => {},   // transient RPC hiccup — just retry on the next tick
      );
    }, LIVE_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [room.openTaskId, live]);
  if (!room.openTaskId) return null;
  return <section className={styles.room} data-review-room>
    <header className={styles.header}><strong>review · {room.openTaskId}</strong><span>{evidence?.workflow ? `${evidence.workflow.name} v${evidence.workflow.version}` : "unbound task"}</span>{live && <span className={styles.liveBadge} data-review-live>● live</span>}<button onClick={() => appStore.dispatch({ type: "reviewRoomClose" })}>close</button></header>
    {room.loading ? <div className={styles.empty}>loading evidence…</div> : room.error ? <div className={`${styles.empty} ${styles.error}`}>{room.error}</div> : <div className={styles.grid}>
      <nav className={styles.files} aria-label="changed files">{files.map((file) => <button className={file.path === selected?.path ? styles.selected : undefined} key={`${file.branch}:${file.path}`} title={file.path} onClick={() => appStore.dispatch({ type: "reviewRoomSelect", path: file.path, hunkId: file.hunks[0]?.id ?? null })}><span className={styles.fileStatus}>{file.status[0]}</span><span className={styles.filePath}><bdi>{file.path}</bdi></span><small>{file.hunks.length} hunks</small></button>)}</nav>
      <main className={styles.diff}>{selected?.agentIds.length ? <WorkingTreeDisclosure target={{ agentId: selected.agentIds[selected.agentIds.length - 1]! }} taskId={room.openTaskId} initialPath={selected.path} /> : null}{!selected ? (live ? <div className={styles.empty} data-review-live-empty>no changes yet</div> : unavailable.length ? <div className={styles.empty} data-review-unavailable><p>no patch to review</p>{unavailable.map((row) => <p key={row.branch}><strong>{row.branch}</strong>: {row.reason}</p>)}</div> : <div className={styles.empty}>no patch available</div>) : selected.binary ? <div className={styles.empty}>binary file — preview unavailable</div> : selected.hunks.map((hunk) => <article className={hunk.id === room.selectedHunkId ? styles.activeHunk : styles.hunk} key={hunk.id}><div className={styles.hunkHeader}>{hunk.header}</div>{hunk.lines.map((line, index) => <div className={styles[line.kind]} key={index}><span>{line.oldLine ?? ""}</span><span>{line.newLine ?? ""}</span><HighlightedCode content={line.text || " "} lang={selected.language} /></div>)}</article>)}</main>
      <aside className={styles.rail}><h3>provenance</h3>{selected && <><p>{selected.branch}</p><p>{selected.agentIds.join(" → ") || "unattributed"}</p>{selected.mergeCommitSha && <p>merge {selected.mergeCommitSha.slice(0, 8)}</p>}</>}{room.sessionError ? <div className={styles.empty}>{room.sessionError}</div> : <><h3>findings</h3><ul className={styles.findings} data-findings-list>{(session?.findings ?? []).length === 0 ? <li className={styles.empty}>no findings yet</li> : (session?.findings ?? []).map((finding) => <li key={finding.id} data-finding={finding.id} className={finding.status === "resolved" ? styles.findingResolved : undefined}><span title={finding.severity}>{SEVERITY_GLYPH[finding.severity]}</span><span className={styles.findingPath}>{finding.path}</span><p>{finding.body}</p>{finding.status === "open" ? <button disabled={findingBusy} onClick={() => resolveFindingClick(finding.id)}>resolve</button> : <span className={styles.muted}>resolved · {finding.resolvedBy ?? "operator"}</span>}</li>)}</ul>{selected && <div className={styles.findingForm}><textarea placeholder={`comment on ${room.selectedHunkId ? "selected hunk" : selected.path}`} value={findingBody} onChange={(event) => setFindingBody(event.target.value)} rows={2} /><div className={styles.findingFormRow}><select value={findingSeverity} onChange={(event) => setFindingSeverity(event.target.value as ReviewFinding["severity"])}><option value="note">note</option><option value="warning">warning</option><option value="blocking">blocking</option></select><button disabled={findingBusy || !findingBody.trim()} onClick={submitFinding}>comment</button></div>{findingError && <p className={styles.error} data-finding-error>{findingError}</p>}</div>}<h3>decision</h3><p>{session?.decision?.status ?? "pending"}</p><button disabled={decideBusy} onClick={() => decide("accepted")}>accept</button><button disabled={decideBusy} onClick={() => decide("changes_requested")}>request changes</button>{decideError && <p className={styles.error} data-decide-error>{decideError}</p>}</>}</aside>
    </div>}
    <footer className={styles.footer}>[ / ] hunks · esc close</footer>
  </section>;
}
