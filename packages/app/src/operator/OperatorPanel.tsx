import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { initialState, reduce } from "@chimera/ui-state";
import type { OperatorWebSnapshot, ReviewSession } from "@chimera/protocol";
import { ChipButton } from "../components/ChipButton";
import { SessionExpired, type OperatorSession, type OperatorTransport } from "./bridge";
import styles from "./OperatorPanel.module.css";

export function OperatorPanel({ transport }: { transport: OperatorTransport }) {
  const [session, setSession] = useState<OperatorSession | null>(null), [snapshot, setSnapshot] = useState<OperatorWebSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState("Agents"), [code, setCode] = useState(""), [label, setLabel] = useState(""), [control, setControl] = useState(false);
  const [draft, setDraft] = useState(""), [tail, setTail] = useState<Array<{ seq: number; kind: string; text: string }>>([]), [review, setReview] = useState<ReviewSession | null>(null);
  const [ui, dispatch] = useReducer(reduce, initialState);
  const sessionRef = useRef<OperatorSession | null>(null);
  const epoch = useRef(0), mounted = useRef(true), loadingRef = useRef(false), commandRef = useRef(false), refreshAgain = useRef(false), drafts = useRef(new Map<string, string>());
  const failed = useCallback((e: unknown) => {
    if (!mounted.current) return;
    setNotice(null); setError(e instanceof Error ? e.message : "Panel request failed");
    if (e instanceof SessionExpired) { epoch.current++; sessionRef.current = null; setSession(null); setSnapshot(null); setTail([]); setReview(null); drafts.current.clear(); setDraft(""); }
  }, []);
  const refresh = useCallback(async () => {
    if (loadingRef.current) { refreshAgain.current = true; return; } loadingRef.current = true;
    const generation = epoch.current; setLoading(true);
    try { const data = await transport.snapshot<OperatorWebSnapshot>();
      const expected = sessionRef.current;
      if (generation === epoch.current && expected && (expected.project !== data.project || expected.scope !== data.scope)) throw new SessionExpired("Browser session changed. Reload to restore the current paired project.");
      if (mounted.current && generation === epoch.current) { setSnapshot(data); setError(null); } }
    catch (e) { if (generation === epoch.current) failed(e); }
    finally { loadingRef.current = false; if (mounted.current) { setLoading(false); if (refreshAgain.current && generation === epoch.current) { refreshAgain.current = false; void refresh(); } } }
  }, [transport, failed]);
  useEffect(() => {
    mounted.current = true; const generation = epoch.current;
    void transport.restore().then(s => { if (mounted.current && generation === epoch.current) { sessionRef.current = s; setSession(s); void refresh(); } }).catch(failed).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; epoch.current++; };
  }, [transport, refresh, failed]);
  useEffect(() => {
    if (!session) return;
    const off = transport.events(() => { void refresh(); }, () => {
      setError("Connection interrupted. Checking session…");
      const generation = epoch.current;
      void transport.restore().then(() => { if (mounted.current && generation === epoch.current) setError("Event stream interrupted. Use Refresh to reconnect."); }).catch(e => { if (generation === epoch.current) failed(e); });
    });
    const timeout = setTimeout(() => failed(new SessionExpired()), Math.max(0, session.expiresAt - Date.now()));
    return () => { off(); clearTimeout(timeout); };
  }, [session, transport, refresh, failed]);
  const run = async (work: () => Promise<unknown>) => {
    if (commandRef.current) return; commandRef.current = true; setBusy(true); setError(null); const generation = epoch.current;
    try { await work(); if (generation === epoch.current && mounted.current) await refresh(); }
    catch (e) { if (generation === epoch.current) failed(e); }
    finally { commandRef.current = false; if (mounted.current) setBusy(false); }
  };
  const canControl = session?.scope === "control";
  const selected = snapshot?.agents.find(a => a.agentId === ui.selectedAgentId);
  return <main className={styles.panel} data-operator-panel>
    <header><h1>Chimera operator</h1><span>{session ? `${session.project} · ${session.scope === "control" ? "Control" : "Read only"}` : "Pair this device"}</span></header>
    {notice && session && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}{session && snapshot && " · Showing last loaded data"}</p>}
    {!session ? <form onSubmit={e => { e.preventDefault(); void run(async () => { const s = await transport.pair(code.trim(), label.trim(), control ? "control" : "read"); epoch.current++; setCode(""); sessionRef.current = s; setSession(s); await refresh(); }); }}>
      <p>On the desktop, open Settings → Network → Remote operator panel and pair a device. Codes expire after two minutes.</p>
      <label>Pairing code<input data-operator-code autoComplete="off" spellCheck={false} value={code} onChange={e => setCode(e.target.value)} /></label>
      <label>Device name<input autoComplete="off" maxLength={80} value={label} onChange={e => setLabel(e.target.value)} /></label>
      <label className={styles.row}><input type="checkbox" checked={control} onChange={e => setControl(e.target.checked)} />Control access (must also be approved on desktop)</label>
      <button type="submit" disabled={busy || loading || !code.trim() || !label.trim()}>{busy ? "Pairing…" : "Pair device"}</button>
    </form> : <>
      <nav aria-label="Operator views">{["Agents", "Queue", "Review"].map(v => <ChipButton key={v} aria-pressed={view === v} onClick={() => setView(v)}>{v}</ChipButton>)}<ChipButton disabled={busy || loading} onClick={() => { const generation = epoch.current; void transport.restore().then(s => { if (mounted.current && generation === epoch.current) { sessionRef.current = s; setSession(s); void refresh(); } }).catch(failed); }}>Refresh</ChipButton><ChipButton disabled={busy} onClick={() => { void run(async () => { await transport.logout(); epoch.current++; sessionRef.current = null; setSession(null); setSnapshot(null); setTail([]); setReview(null); drafts.current.clear(); setDraft(""); }); }}>Sign out</ChipButton></nav>
      {loading && <p role="status">Loading panel…</p>}
      {snapshot?.truncated && <p>Showing bounded recent data. Use the desktop for the full history.</p>}
      <section aria-label="Attention" data-operator-attention><h2>Attention</h2>{!snapshot?.attention.length ? <p>{snapshot ? "No pending approvals or questions" : "Attention not loaded"}</p> : snapshot.attention.map(a => <article key={a.id}>
        <strong>{a.kind === "permission" ? "Approval" : "Question"} · {snapshot.agents.find(agent => agent.agentId === a.agentId)?.label ?? a.agentId}</strong><pre>{a.prompt}</pre>
        {canControl && a.actionable && (a.kind === "permission" ? <div className={styles.row}><ChipButton disabled={busy} onClick={() => { void run(() => transport.rpc("agent.permissionRespond", { requestId: a.id, allow: true })); }}>Allow</ChipButton><ChipButton disabled={busy} onClick={() => { void run(() => transport.rpc("agent.permissionRespond", { requestId: a.id, allow: false })); }}>Deny</ChipButton></div> : <QuestionAnswer attention={a} disabled={busy} submit={answer => { void run(() => transport.rpc("agent.answerQuestion", { questionId: a.id, answer })); }} />)}
      </article>)}</section>
      {view === "Agents" && <section aria-label="Agents"><h2>Agents</h2>{snapshot?.agents.length === 0 && <p>No agents in this project</p>}{snapshot?.agents.map(a => <article key={a.agentId}>
        <ChipButton aria-pressed={a.agentId === ui.selectedAgentId} disabled={busy} onClick={() => { if (commandRef.current) return; dispatch({ type: "selectAgent", agentId: a.agentId }); setDraft(drafts.current.get(a.agentId) ?? ""); setTail([]); void run(async () => { const generation = epoch.current; const data = await transport.rpc<typeof tail>("agent.tail", { agentId: a.agentId, n: 50 }); if (generation === epoch.current && mounted.current) setTail(data); }); }}>{a.label}</ChipButton> <span>{a.state}</span>
        {canControl && <ChipButton disabled={busy || (a.state !== "running" && !a.held)} onClick={() => { void run(async () => { const result = await transport.rpc<{ held?: string[]; released?: string[]; skipped?: unknown[] }>(a.held ? "agent.release" : "agent.hold", { agentIds: [a.agentId] }); setNotice(result.skipped?.length ? "Agent state did not change; review current status." : a.held ? "Agent resumed." : "Agent paused."); }); }}>{a.held ? "Resume" : "Pause"}</ChipButton>}
      </article>)}{selected && <section aria-label="Agent tail"><h3>{selected.label} · Recent text</h3>{tail.map(t => <pre key={t.seq}>{t.text || `[${t.kind}]`}</pre>)}{canControl && <form onSubmit={e => { e.preventDefault(); void run(async () => { const result = await transport.rpc<{ ack?: string; delivered?: boolean }>("agent.send", { agentId: selected.agentId, text: draft }); setNotice(result.ack === "held" ? "Message queued while the agent is paused." : result.ack === "pending" ? "Message queued; agent acknowledgement is pending." : result.delivered ? "Message delivered to agent." : "Message accepted; check recent activity."); drafts.current.delete(selected.agentId); setDraft(""); }); }}><label>Message<textarea value={draft} maxLength={16000} onChange={e => { setDraft(e.target.value); drafts.current.set(selected.agentId, e.target.value); }} /></label><button type="submit" disabled={busy || !draft.trim()}>Send message</button></form>}</section>}</section>}
      {view === "Queue" && <section aria-label="Queue"><h2>Queue</h2>{snapshot?.queues.length === 0 && <p>No exclusive queue for this project. Shared queues stay in the desktop.</p>}{snapshot?.queues.map(q => <article key={q.name}><h3>{q.name} · {q.paused ? "Paused" : "Active"}</h3>{canControl && <><ChipButton disabled={busy} onClick={() => { void run(() => transport.rpc(q.paused ? "queue.resume" : "queue.pause", { queue: q.name })); }}>{q.paused ? "Resume queue" : "Pause queue"}</ChipButton><Answer disabled={busy} label="Task prompt" button="Add task" submit={prompt => { void run(() => transport.rpc("queue.push", { queue: q.name, prompt })); }} /></>}{q.tasks.map(t => <div key={t.taskId}><p>{t.state} · {t.prompt}</p>{canControl && ["pending", "blocked"].includes(t.state) && <ChipButton disabled={busy} onClick={() => { void run(() => transport.rpc("queue.cancelTask", { taskId: t.taskId })); }}>Cancel pending task</ChipButton>}</div>)}</article>)}</section>}
      {view === "Review" && <section aria-label="Review"><h2>Review</h2><p>Select a task to read its review.</p>{snapshot?.queues.flatMap(q => q.tasks).map(t => <ChipButton key={t.taskId} disabled={busy} onClick={() => { void run(async () => { const generation = epoch.current; const data = await transport.rpc<ReviewSession>("review.get", { taskId: t.taskId }); if (generation === epoch.current && mounted.current) setReview(data); }); }}>{t.prompt.slice(0, 80)}</ChipButton>)}{review && <ReviewPane key={review.taskId} review={review} control={canControl} busy={busy} write={(method, params) => { void run(async () => { const generation = epoch.current; await transport.rpc(method, { taskId: review.taskId, ...params }); const updated = await transport.rpc<ReviewSession>("review.get", { taskId: review.taskId }); if (generation === epoch.current && mounted.current) setReview(updated); }); }} />}</section>}
    </>}
    <footer>Text only · No terminal, files, spawn or microphone · Remote access requires an owner-managed HTTPS tunnel.</footer>
  </main>;
}
function Answer({ disabled, submit, label = "Answer", button = "Submit answer" }: { disabled: boolean; submit(text: string): void; label?: string; button?: string }) {
  const [text, setText] = useState("");
  return <form onSubmit={e => { e.preventDefault(); submit(text); }}><label>{label}<textarea value={text} maxLength={16000} onChange={e => setText(e.target.value)} /></label><button type="submit" disabled={disabled || !text.trim()}>{button}</button></form>;
}

function QuestionAnswer({ attention, disabled, submit }: { attention: OperatorWebSnapshot["attention"][number]; disabled: boolean; submit(answer: { text?: string; optionIds?: string[] }): void }) {
  return <>{attention.options?.map(o => <ChipButton key={o.id} disabled={disabled} onClick={() => submit({ optionIds: [o.id] })}>{o.label}</ChipButton>)}{attention.freeform && <Answer disabled={disabled} submit={text => submit({ text })} />}</>;
}

function ReviewPane({ review, control, busy, write }: { review: ReviewSession; control: boolean; busy: boolean; write(method: string, params: Record<string, unknown>): void }) {
  const [path, setPath] = useState(""), [body, setBody] = useState(""), [summary, setSummary] = useState(""), [severity, setSeverity] = useState("note"), [decision, setDecision] = useState("changes_requested");
  return <article data-operator-review>
    <h3>{review.decision ? review.decision.status === "accepted" ? "Accepted" : "Changes requested" : "Awaiting decision"}</h3>
    {review.decision?.summary && <p>{review.decision.summary}</p>}
    {!review.findings.length && <p>No findings</p>}
    {review.findings.map(f => <article key={f.id}><strong>{f.severity} · {f.path} · {f.status}</strong><pre>{f.body}</pre>{control && f.status === "open" && <ChipButton disabled={busy} onClick={() => write("review.finding.resolve", { findingId: f.id })}>Resolve finding</ChipButton>}</article>)}
    {control && <>
      <details><summary>Add a review finding</summary><form onSubmit={e => { e.preventDefault(); write("review.finding.add", { path, body, severity }); }}>
        <label>File path<input data-review-path maxLength={1000} value={path} onChange={e => setPath(e.target.value)} /></label>
        <label>Severity<select value={severity} onChange={e => setSeverity(e.target.value)}><option value="note">Note</option><option value="warning">Warning</option><option value="blocking">Blocking</option></select></label>
        <label>Finding<textarea data-review-finding maxLength={16000} value={body} onChange={e => setBody(e.target.value)} /></label><button type="submit" disabled={busy || !path.trim() || !body.trim()}>Add finding</button>
      </form></details>
      <form onSubmit={e => { e.preventDefault(); write("review.decide", { status: decision, summary }); }}><label>Decision<select value={decision} onChange={e => setDecision(e.target.value)}><option value="changes_requested">Request changes</option><option value="accepted">Accept review</option></select></label><label>Review summary<textarea data-review-summary maxLength={16000} value={summary} onChange={e => setSummary(e.target.value)} /></label><button type="submit" disabled={busy || !summary.trim() || (decision === "accepted" && review.findings.some(f => f.severity === "blocking" && f.status === "open"))}>Record review decision</button></form>
    </>}
  </article>;
}
