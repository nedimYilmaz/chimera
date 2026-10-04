import { createContext, useCallback, useContext, useMemo, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { VoiceLimits, VoiceRoom } from "@chimera/protocol/voice-rooms";
import { rpcCall } from "../rpc/bridge";
import { useStore } from "../state/useStore";
import { meetingHost } from "../voice/meetingHost";
import { nativeCodexVoice } from "../voice/nativeCodex";
import { displayName } from "../state/selectors";
import { actOnMeetingAgents, type MeetingAgentAction, type MeetingActionResult } from "../voice/meetingActions";
import { MeetingActionDialog } from "./MeetingActionDialog";
import { appStore } from "../state/store";
import { Panel } from "./Panel";
import { usePaneRow } from "./PaneDivider";
import styles from "./MeetingRooms.module.css";
import { MeetingAvatar } from "./MeetingAvatar";

type MeetingWorkspace = { open: boolean; openRooms: () => void; closeRooms: () => void };
const MeetingWorkspaceContext = createContext<MeetingWorkspace | null>(null);
const MeetingSurfacesContext = createContext<{ workspace: ReactNode; band: ReactNode } | null>(null);
export const useMeetingRooms = () => useContext(MeetingWorkspaceContext);
export function MeetingRooms() { return useContext(MeetingSurfacesContext)?.workspace ?? null; }
export function MeetingRoomsBand() { return useContext(MeetingSurfacesContext)?.band ?? null; }

// One app-level owner keeps room polling and hosted audio alive while panes change.
export function MeetingRoomsProvider({ children }: { children: ReactNode }) {
  const live = useSyncExternalStore(meetingHost.subscribe, meetingHost.getState);
  const connected = useStore(s => s.connected);
  const selected = useStore(s => s.selectedAgentId);
  const tab = useStore(s => s.activeTab);
  const agents = useStore(s => s.agents);
  const [rooms, setRooms] = useState<VoiceRoom[]>([]);
  const [limits, setLimits] = useState<VoiceLimits>({ maxRooms: 32, maxSessions: 16, maxParticipants: 8 });
  const [capacity, setCapacity] = useState<VoiceLimits | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [operatorName, setOperatorName] = useState(() => {
    try { return localStorage.getItem("chimera.meeting.displayName") || ""; } catch { return ""; }
  });
  const humanName = operatorName.trim() || "You";
  const updateOperatorName = (value: string) => {
    setOperatorName(value);
    try { localStorage.setItem("chimera.meeting.displayName", value); } catch { /* A session name still works when storage is unavailable. */ }
  };
  const pane = usePaneRow("meetings");
  const previousNavigation = useRef({ selected, tab });
  const [viewId, setViewId] = useState<string | null>(null);
  const [name, setName] = useState("Planning room");
  const [agenda, setAgenda] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [duration, setDuration] = useState(15);
  const [turns, setTurns] = useState(60);
  const [inviteId, setInviteId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ room: VoiceRoom; action: MeetingAgentAction | "remove"; agentId?: string } | null>(null);
  const [actionResult, setActionResult] = useState<{ room: VoiceRoom; action: MeetingAgentAction; result: MeetingActionResult } | null>(null);
  const runLock = useRef(false);
  const alive = useRef(true);
  const refreshVersion = useRef(0);
  const refresh = async () => {
    const version = ++refreshVersion.current;
    const result = await rpcCall<{ rooms: VoiceRoom[]; limits: VoiceLimits }>("voice.room.list", {});
    if (!alive.current || version !== refreshVersion.current) return;
    setRooms(result.rooms); setLimits(result.limits); nativeCodexVoice.setLimit(result.limits.maxSessions);
  };
  useEffect(() => {
    alive.current = true;
    const close = () => meetingHost.stopAll("pagehide"); window.addEventListener("pagehide", close);
    return () => { alive.current = false; window.removeEventListener("pagehide", close); meetingHost.stopAll("ui-unmount"); };
  }, []);
  useEffect(() => {
    const previous = previousNavigation.current;
    previousNavigation.current = { selected, tab };
    // Opening a notification navigates TO agents; only departures leave the human seat.
    if (previous.selected !== selected || tab !== "agents") {
      meetingHost.leave(); nativeCodexVoice.join(null); setOpen(false); setConfirmation(null);
    }
  }, [selected, tab]);
  useEffect(() => {
    if (!connected) { refreshVersion.current++; meetingHost.stopAll("daemon-disconnect"); setRooms([]); return; }
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { if (!disposed) await refresh(); } catch (e) { if (!disposed && alive.current) setError(String(e)); }
      if (!disposed) timer = setTimeout(() => { void poll(); }, 2000);
    };
    void poll(); return () => { disposed = true; refreshVersion.current++; clearTimeout(timer); };
  }, [connected]);
  const run = async (task: () => Promise<unknown>) => {
    if (runLock.current) return; runLock.current = true; setBusy(true); setError(null);
    try { await task(); await refresh(); } catch (e) { if (alive.current) setError(String(e)); }
    finally { runLock.current = false; if (alive.current) setBusy(false); }
  };
  const current = live.find(r => r.room.id === viewId);
  const listedRoom = rooms.find(r => r.id === viewId);
  const room = current && (!listedRoom || current.room.revision > listedRoom.revision) ? current.room : listedRoom;
  const leave = useCallback(() => { meetingHost.leave(); nativeCodexVoice.join(null); setOpen(false); setConfirmation(null); }, []);
  const openRooms = useCallback(() => { appStore.dispatch({ type: "selectTab", tab: "agents" }); setOpen(true); }, []);
  // Audio/transcript updates should repaint the meeting surfaces, not the whole app shell.
  const navigation = useMemo(() => ({ open, openRooms, closeRooms: leave }), [open, openRooms, leave]);
  const showRoom = (id: string | null) => {
    // Reselecting an open room is not a departure or a microphone toggle.
    if (open && viewId === id) return;
    meetingHost.leave(); nativeCodexVoice.join(null);
    const hosted = live.find(r => r.room.id === id);
    if (id && hosted && !hosted.connecting && !hosted.error) meetingHost.observe(id);
    setViewId(id); openRooms(); setConfirmation(null);
  };
  const retainedMessages = (current?.context ?? []).map(line => ({ ...line, final: true, who: line.speaker === "operator" ? humanName : room?.participants.find(p => p.agentId === line.speaker)?.name ?? "Former participant" }));
  const messages = room ? [...retainedMessages, ...room.agentIds.flatMap(id => (current?.agents[id]?.messages ?? []).filter(m => m.role === "assistant" && !retainedMessages.some(line => line.id === m.id)).map(m => ({ ...m, who: room.participants.find(p => p.agentId === id)?.name ?? id })))].sort((a, b) => a.ts - b.ts).slice(-100) : [];

  const notifications = rooms.filter(r => r.state === "pending" || r.pendingUpdate);
  const band = (live.length > 0 || notifications.length > 0) && <div className={styles.launcher} aria-label="Meeting notifications">
    {live.filter(r => !r.error).map(r => <button key={r.room.id} type="button" onClick={() => showRoom(r.room.id)}>{r.joined ? "●" : r.speakerEnabled ? "◖" : "○"} {r.room.name}</button>)}
    {notifications.map(r => <button key={`approval:${r.id}`} type="button" onClick={() => showRoom(r.id)}>{r.name} · {r.pendingUpdate ? "Review changes" : "Invitation awaiting approval"}</button>)}
    {live.filter(r => r.error).map(r => <button key={r.room.id} role="alert" type="button" onClick={() => showRoom(r.room.id)}>{r.room.name} stopped: {r.error}</button>)}
  </div>;
  const workspace = open && <section className={styles.workspace} aria-label="Meeting rooms workspace">
    <div className={styles.layout} {...pane.rowProps}>
      <Panel label={<>meeting rooms <span>({rooms.length})</span></>} className={styles.roomList}>
        <div className={styles.listTools}>
          <input aria-label="Search meeting rooms" placeholder="search rooms" value={query} onChange={e => setQuery(e.target.value)} />
          <button type="button" onClick={() => showRoom(null)}>＋ New meeting</button>
        </div>
        <nav aria-label="Meetings">
          {rooms.filter(r => `${r.name} ${r.agenda}`.toLowerCase().includes(query.toLowerCase())).map(r => <button type="button" key={r.id} aria-pressed={r.id === viewId} onClick={() => showRoom(r.id)}><strong>{r.name}</strong><small>{r.agentIds.length} participants · {r.state}</small></button>)}
          {!rooms.length && <p className={styles.empty}>No meeting rooms yet. Create a room to bring your agents together.</p>}
          {!!rooms.length && !rooms.some(r => `${r.name} ${r.agenda}`.toLowerCase().includes(query.toLowerCase())) && <p className={styles.empty}>No rooms match your search.</p>}
        </nav>
      </Panel>
      {pane.divider}
      <Panel label="meeting transcript" className={styles.detail}>
        <header className={styles.header}><div><strong>{room?.name ?? "New meeting"}</strong><small>{room ? `${room.participants.length + (current?.joined ? 1 : 0)} participants · ${room.state}` : "Create a shared conversation"}</small></div><button type="button" onClick={leave}>Back to inspector · leave audio</button></header>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {!room ? <form className={styles.setup} onSubmit={e => { e.preventDefault(); void run(async () => { const made = await rpcCall<VoiceRoom>("voice.room.create", { name, agenda, agentIds: chosen, durationMinutes: duration, maxUtterances: turns }); setViewId(made.id); }); }}>
          <h3>Bring your agents together</h3><p>Each participant keeps its existing coding context. A meeting shares its conversation text with participants; work permissions remain unchanged.</p>
          <label>Room name<input value={name} maxLength={80} required onChange={e => setName(e.target.value)} /></label>
          <label>Agenda<textarea value={agenda} maxLength={2000} onChange={e => setAgenda(e.target.value)} /></label>
          <div className={styles.budgets}><label>Minutes<input type="number" min={1} max={120} required value={duration} onChange={e => setDuration(Number(e.target.value))} /></label><label>Maximum utterances<input type="number" min={1} max={500} required value={turns} onChange={e => setTurns(Number(e.target.value))} /></label></div>
          <fieldset><legend>Participants · up to {limits.maxParticipants}</legend>{Object.values(agents).filter(a => a.provider === "codex" && a.state === "running").map(a => <label key={a.agentId}><input type="checkbox" checked={chosen.includes(a.agentId)} disabled={!chosen.includes(a.agentId) && chosen.length >= limits.maxParticipants} onChange={e => setChosen(ids => e.target.checked ? [...ids, a.agentId] : ids.filter(id => id !== a.agentId))} />{displayName(a)}</label>)}</fieldset>
          <button disabled={busy || !connected || !chosen.length} type="submit">Create meeting</button>
          <details><summary>Capacity: {limits.maxRooms} rooms / {limits.maxSessions} live voice sessions</summary><p>Shared by private calls and meetings. Changes affect new sessions; provider limits still apply.</p>
            <div className={styles.budgets}>{([["maxRooms", "Rooms", 128], ["maxSessions", "Live sessions", 32], ["maxParticipants", "Participants per room", 12]] as const).map(([key, label, max]) => <label key={key}>{label}<input type="number" min={key === "maxParticipants" ? 2 : 1} max={max} value={(capacity ?? limits)[key]} onChange={e => setCapacity({ ...(capacity ?? limits), [key]: Number(e.target.value) })} /></label>)}</div>
            <button type="button" disabled={busy || !capacity} onClick={() => { void run(async () => { await rpcCall("config.patch", { patch: { nativeVoice: capacity } }); setCapacity(null); }); }}>Save capacity limits</button>
          </details>
        </form> : <div className={styles.meeting}>
          <div className={styles.roomStatus}><span>{current?.error ? "Meeting stopped" : current?.connecting ? "Connecting participants…" : room.state === "active" ? "● Meeting in progress" : room.state === "pending" ? "Ready for your approval" : "Meeting ended"}</span><span>{room.expiresAt && room.state === "active" ? `${Math.max(0, Math.ceil((room.expiresAt - Date.now()) / 60000))} min remaining` : `${room.durationMinutes} min`} · {room.maxUtterances} utterances maximum</span></div>
          <p>{room.agenda || "Coordinate current work"}</p>
          {current && <div className={styles.rosterSummary}><span>{room.agentIds.length} agents</span><span>{Object.values(current.participants).filter(p => p.mode === "listener").length} listeners</span><span>{Object.values(current.participants).filter(p => p.mode === "parked").length} voice parked</span><span>Coding permissions unchanged</span></div>}
          {current?.joined && <div className={styles.controls}>
            <label>Answering<select aria-label="Who should answer" value={current.recipient ?? ""} onChange={e => { if (e.target.value) meetingHost.chooseRecipient(room.id, e.target.value); }}>
              <option value="">{current.routingNote ?? "Listening for an addressee…"}</option>
              {room.participants.filter(p => current.participants[p.agentId]?.mode === "speaker").map(p => <option key={p.agentId} value={p.agentId}>{p.name}</option>)}
            </select></label>
            <span>{current.autoParticipation !== false ? "Address someone directly or invite a discussion. Relevant participants take turns; listeners stay silent." : "Name an agent to address them; otherwise the conductor answers."}</span>
          </div>}
          <details className={styles.participantSection} open={!!room.pendingUpdate}><summary data-participant-settings>Participants · {room.participants.length}</summary>
          {room.state === "active" && current && !current.error && <div className={styles.controls}>
            <label>Add participant<select aria-label="Add participant" value={inviteId} onChange={e => setInviteId(e.target.value)}>
              <option value="">Choose an agent</option>
              {Object.values(agents).filter(a => a.provider === "codex" && a.state === "running" && !room.agentIds.includes(a.agentId)).map(a => <option key={a.agentId} value={a.agentId}>{displayName(a)}</option>)}
            </select></label>
            <button type="button" disabled={busy || !inviteId || !!room.pendingUpdate || room.agentIds.length >= limits.maxParticipants} onClick={() => { void run(async () => {
              await rpcCall("voice.room.update", { roomId: room.id, revision: room.revision, spec: { name: room.name, agenda: room.agenda, agentIds: [...room.agentIds, inviteId], durationMinutes: room.durationMinutes, maxUtterances: room.maxUtterances } }); setInviteId("");
            }); }}>Invite to this meeting</button>
          </div>}
          {room.state === "active" && room.pendingUpdate && <div role="region" aria-label="Review meeting changes" className={styles.consent}>
            <strong>Review meeting changes · conversation continues</strong>
            <p>Joining: {room.pendingUpdate.agentIds.filter(id => !room.agentIds.includes(id)).map(id => agents[id] ? displayName(agents[id]!) : id).join(", ") || "None"}</p>
            <p>Leaving: {room.participants.filter(p => !room.pendingUpdate!.agentIds.includes(p.agentId)).map(p => p.name).join(", ") || "None"}</p>
            <p>{room.pendingUpdate.name} · {room.pendingUpdate.durationMinutes} minutes total · {room.pendingUpdate.maxUtterances} utterances maximum</p>
            <p>{room.pendingUpdate.agenda}</p>
            <p>Approval shares future conversation text with the new participants. Their voice opens only when you address them. The meeting stays open.</p>
            <button type="button" disabled={busy || !current || current.connecting || !!current.error} onClick={() => { void run(() => meetingHost.reviewUpdate(room.id, room.revision, true, room.pendingUpdate)); }}>Approve changes · keep meeting going</button>
            <button type="button" disabled={busy || !current || current.connecting || !!current.error} onClick={() => { void run(() => meetingHost.reviewUpdate(room.id, room.revision, false, room.pendingUpdate)); }}>Decline changes</button>
          </div>}
          </details>
          <div className={styles.stage} aria-label="Meeting participants">

            {room.participants.map(p => {
              const speaking = room.state === "active" && !current?.error && !current?.paused && !current?.humanSpeaking && current?.speaker === p.agentId;
              const waiting = current?.waiting.includes(p.agentId);
              const status = current?.agents[p.agentId]?.status;
              const control = current?.participants[p.agentId];
              const canManage = !!current && !current.error && !current.connecting && !!control;
              const label = room.state === "ended" || current?.error ? `Voice ended · agent ${p.state}` : control?.mode === "listener" ? "Listener · transcript retained" : control?.mode === "parked" ? "Voice parked · not listening" : current?.paused ? "Voice paused · coding continues" : current?.humanSpeaking ? "Listening to you" : speaking ? "Speaking" : waiting ? "Waiting for the floor" : status === "listening" ? "Ready to speak" : status === "connecting" ? "Connecting…" : control ? "Waiting · transcript retained" : p.state;
              return <article key={p.agentId} data-meeting-seat={p.agentId} data-speaking={speaking} className={`${styles.seat} ${speaking ? styles.speaking : ""}`}>
                <MeetingAvatar name={p.name} identity={p.agentId} speaking={speaking} />
                <strong>{p.name}</strong><small>{p.role}</small><span className={styles.modeBadge} data-participant-mode={control?.mode}>{control?.pending ? "Updating voice…" : label}</span>
                <small>{agents[p.agentId]?.busy ? "Coding work active" : `Coding agent: ${agents[p.agentId]?.state ?? p.state}`}</small>
                {control?.note && <span className={styles.participantNote}>{control.note}</span>}
                {canManage && <div className={styles.participantControls}>
                  <button type="button" aria-label={`${control.mode === "speaker" ? "Make listener" : "Allow speaking"}: ${p.name}`} disabled={busy || control.pending || status === "connecting"} onClick={() => { void run(() => meetingHost.setListener(room.id, p.agentId, control.mode === "speaker")); }}>{control.mode === "speaker" ? "Make listener" : "Allow speaking"}</button>
                  <button type="button" aria-label={`Remove from room: ${p.name}`} disabled={busy || control.pending} onClick={() => setConfirmation({ room, action: "remove", agentId: p.agentId })}>Remove from room</button>
                </div>}
              </article>;
            })}
            {current?.joined && <article data-meeting-seat="operator" data-speaking={room.state === "active" && !current.error && current.microphone && current.humanSpeaking} className={`${styles.seat} ${styles.operator}`}>
              <MeetingAvatar name={humanName} identity="operator" human speaking={room.state === "active" && !current.error && current.microphone && current.humanSpeaking} />
              <strong>{humanName} · participant</strong><small>You</small>
              <span>{current.microphone && current.humanSpeaking ? "Speaking" : current.micPending ? "Waiting for microphone…" : current.microphone ? "Mic on · you have priority" : "Mic off"} · {current.speakerEnabled ? "speaker on" : "speaker off"}</span>
            </article>}
          </div>
          <label className={styles.displayName}>Your meeting name<input aria-label="Your meeting name" placeholder="Your name" maxLength={80} value={operatorName} onChange={event => updateOperatorName(event.target.value)} /></label>
          {current && !current.error && <p role="status" className={styles.presence}>{current.joined ? current.microphone ? (current.autoParticipation !== false ? "Active participation: address an agent or invite a discussion. Relevant speakers contribute in turn; listeners remain silent." : "Direct addressing: name an agent; otherwise the conductor answers.") : "You are seated in the meeting. Mic and speaker are independent; enable your mic to take priority." : `Observer · ${current.speakerEnabled ? "listening from outside" : "watching silently"}. You are not a participant and no microphone is captured.`}</p>}
          {current?.draftTranscript && <p aria-label="Live transcription">Heard: {current.draftTranscript}</p>}
          {current?.routingNote && <p role="status">{current.routingNote}</p>}
          {current?.joined && !current.error && <form className={styles.controls} onSubmit={event => { event.preventDefault(); void run(async () => { meetingHost.submitText(room.id, message); setMessage(""); }); }}>
            <label className={styles.displayName}>Message meeting<input aria-label="Message meeting" value={message} maxLength={8192} placeholder="Atlas, what do you think?" onChange={event => setMessage(event.target.value)} /></label>
            <button type="submit" disabled={busy || !message.trim()}>Send to meeting</button>
            <button type="button" disabled={busy || !current.context.some(line => line.speaker === "operator")} onClick={() => { void run(async () => current.discussion ? meetingHost.stopDiscussion(room.id) : meetingHost.startDiscussion(room.id)); }}>{current.discussion ? "Stop discussion" : "Discuss latest question"}</button>
            <label><input type="checkbox" aria-label="Active participation" checked={current.autoParticipation !== false} onChange={e => meetingHost.setAutoParticipation(room.id, e.target.checked)} />Active participation</label>
            {current.planning && <span role="status">Choosing the next contribution…</span>}
            {current.discussion && <span role="status">Relevant contributions, one speaker at a time. Speak or send a message to take the floor.</span>}
            {current.participationNote && <span>{current.participationNote}</span>}
          </form>}
          <div className={styles.controls}>
            {room.state === "pending" && <button disabled={busy || !connected} type="button" onClick={() => { void run(() => meetingHost.start(room)); }}>Approve sharing & start meeting</button>}
            {current && !current.error && <>
              <button disabled={busy || current.connecting} type="button" onClick={() => { if (current.joined) meetingHost.observe(room.id); else void run(() => meetingHost.join(room.id)); }}>{current.joined ? "Leave seat · observe" : "Join meeting · mic off"}</button>
              <button disabled={busy || current.connecting} aria-pressed={current.speakerEnabled} type="button" onClick={() => { void run(() => meetingHost.setSpeaker(room.id, !current.speakerEnabled)); }}>{current.speakerEnabled ? "Speaker off" : current.joined ? "Speaker on" : "Listen from outside"}</button>
              {current.joined && <button disabled={busy || current.micPending} aria-pressed={current.microphone} type="button" onClick={() => { void run(() => meetingHost.setMicrophone(room.id, !current.microphone)); }}>{current.micPending ? "Speech & microphone permission…" : current.microphone ? "Mute microphone" : "Mic on · take the floor"}</button>}
              <button disabled={current.connecting} aria-pressed={current.paused} type="button" onClick={() => meetingHost.setPaused(room.id, !current.paused)}>{current.paused ? "Resume agent audio" : "Pause agent audio"}</button>
            </>}
            {room.state !== "ended" && <button disabled={busy} type="button" onClick={() => { void run(() => meetingHost.endMeeting(room.id)); }}>End meeting · dismiss all voices</button>}
            {room.state === "ended" && <button disabled={busy} type="button" onClick={() => { void run(async () => { await rpcCall("voice.room.delete", { roomId: room.id }); setViewId(null); }); }}>Delete ended room · retain agent history</button>}
          </div>

          {!!room.agentIds.length && <details className={styles.codingActions}><summary>Stop coding agents · separate from voice controls</summary><p>These actions end meeting audio AND stop coding work for the listed participants. Only these agent IDs are targeted; their dependent tasks may also be affected.</p><div className={styles.controls}>
            <button type="button" disabled={busy || !connected} onClick={() => setConfirmation({ room, action: "pause" })}>Pause all coding agents…</button>
            <button className={styles.danger} type="button" disabled={busy || !connected} onClick={() => setConfirmation({ room, action: "kill" })}>Kill all coding agents…</button>
          </div></details>}
          {actionResult?.room.id === room.id && <div role="status" className={styles.actionResult}><strong>{actionResult.result.succeeded.length} agents {actionResult.action === "pause" ? "paused" : "stopped"}</strong>{actionResult.result.failed.map(item => <p key={item.agentId}>{actionResult.room.participants.find(p => p.agentId === item.agentId)?.name ?? item.agentId}: {item.error}</p>)}</div>}
          {room.state === "pending" && <p className={styles.consent}>Approval enables native voice for these agents if needed, retaining their saved threads. It shares their meeting audio with all listed participants through their Codex accounts. Conversations can continue while you are outside, up to the limits above. Text is retained in agent history; queued audio is memory-only. Your microphone stays off until you explicitly join. Use headphones.</p>}
          {(current?.error || room.reason) && <p role="status">{current?.error ?? room.reason}</p>}
          {!!(room.diagnostics?.length || current?.room.diagnostics?.length) && <details className={styles.transcript} open={room.state === "ended" || !!current?.error}><summary>Connection diagnostics</summary>{(room.diagnostics ?? current?.room.diagnostics ?? []).map((d, index) => <p key={`${d.at}-${index}`}><time>{new Date(d.at).toLocaleTimeString()}</time><strong>{d.origin} · {d.source} · {d.event}</strong><span>{[d.code, d.message, d.agentId, d.sessionId, d.connectionState, d.iceConnectionState, d.signalingState, d.channelState, d.enabled === undefined ? undefined : `enabled=${d.enabled}`].filter(Boolean).join(" · ")}</span></p>)}</details>}
          {Object.entries(current?.agents ?? {}).filter(([, a]) => a.controlWarning).map(([id, a]) => <p role="status" key={id}>{room.participants.find(p => p.agentId === id)?.name ?? id}: {a.controlWarning}</p>)}
          <details open className={styles.transcript}><summary>Live room conversation</summary>{messages.length ? messages.map(m => <p key={m.id}><strong>{m.who}</strong><time>{new Date(m.ts).toLocaleTimeString()}</time><span>{m.text}{m.final ? "" : " …"}</span></p>) : <p>The conversation appears here as participants speak. Coding actions remain in each agent’s transcript.</p>}</details>
        </div>}
      </Panel>
      </div>
      {confirmation && <MeetingActionDialog
        title={confirmation.action === "remove" ? "Remove this participant?" : confirmation.action === "pause" ? "Pause these coding agents?" : "Kill these coding agents?"}
        body={confirmation.action === "remove" ? "Only this agent leaves voice. Other participants and coding work continue. Re-adding it requires approval for that participant; the meeting stays open." : confirmation.action === "pause" ? "Meeting voice ends. These agents pause their coding work and can be started again with their saved context." : "Meeting voice ends and these agent runs terminate. Active tasks and pinned scheduled jobs may stop. This does not delete files or transcript history."}
        names={confirmation.room.agentIds.filter(id => !confirmation.agentId || confirmation.agentId === id).map(id => confirmation.room.participants.find(p => p.agentId === id)?.name ?? id)}
        label={confirmation.action === "remove" ? "Remove participant" : confirmation.action === "pause" ? "Confirm pause" : "Confirm kill"}
        onClose={() => setConfirmation(null)}
        onConfirm={() => {
          const target = confirmation; setConfirmation(null);
          void run(async () => {
            if (target.action === "remove") await meetingHost.removeParticipant(target.room.id, target.agentId!);
            else { const result = await actOnMeetingAgents(target.room, target.action, id => meetingHost.endMeeting(id)); if (alive.current) setActionResult({ room: target.room, action: target.action, result }); }
          });
        }} />}
    </section>;
  return <MeetingWorkspaceContext.Provider value={navigation}><MeetingSurfacesContext.Provider value={{ workspace, band }}>{children}</MeetingSurfacesContext.Provider></MeetingWorkspaceContext.Provider>;
}
