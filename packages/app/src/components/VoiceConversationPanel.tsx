import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NativeVoiceMessageSchema, type NativeVoiceMessage } from "@chimera/protocol/contract";
import { onDaemonEvent, rpcCall } from "../rpc/bridge";
import { nativeCodexVoice } from "../voice/nativeCodex";
import { useStore } from "../state/useStore";
import { voiceAgentName } from "@chimera/protocol/agent-name";
import styles from "./VoiceConversationPanel.module.css";

export function mergeVoiceMessages(previous: NativeVoiceMessage[], incoming: NativeVoiceMessage[]): NativeVoiceMessage[] {
  const byId = new Map(previous.map(message => [message.id, message]));
  for (const message of incoming) {
    // A slow history response or heartbeat may trail a final live event.
    if (byId.get(message.id)?.final && !message.final) continue;
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-100);
}

export function VoiceConversationPanel({ agentId, open = false, onClose }: {
  agentId: string;
  open?: boolean;
  onClose?: () => void;
}) {
  const name = useStore(s => { const a = s.agents[agentId]; return voiceAgentName(agentId, a?.displayLabel, a?.conductor, a?.projectId ?? undefined); });
  const voice = useSyncExternalStore(nativeCodexVoice.subscribe, () => nativeCodexVoice.getAgentState(agentId));
  const joined = useSyncExternalStore(nativeCodexVoice.subscribe, () => nativeCodexVoice.getRooms().some(room => room.agentId === agentId && room.joined));
  const connected = useStore(s => s.connected);
  const [messages, setMessages] = useState<NativeVoiceMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const active = voice.agentId === agentId && (voice.status === "connecting" || voice.status === "listening");
  useEffect(() => {
    let disposed = false;
    if (!connected || (!active && !open)) return;
    setError(null);
    const off = onDaemonEvent(event => {
      if (event.agentId !== agentId || event.kind !== "voice_native_message") return;
      const parsed = NativeVoiceMessageSchema.safeParse(event.data);
      if (parsed.success) setMessages(previous => mergeVoiceMessages(previous, [parsed.data]));
    });
    void rpcCall<{ messages: NativeVoiceMessage[] }>("voice.native.history", { agentId }).then(result => {
      if (!disposed) setMessages(previous => mergeVoiceMessages(result.messages, previous));
    }).catch(e => { if (!disposed) setError(String(e?.message ?? e)); });
    return () => { disposed = true; off(); };
  }, [agentId, connected, retry, active, open]);
  useEffect(() => {
    if (voice.agentId === agentId && voice.messages?.length) setMessages(previous => mergeVoiceMessages(previous, voice.messages!));
  }, [agentId, voice.agentId, voice.messages]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages]);

  if (!active && !open) return null;
  const input = active && joined ? voice.inputLevel ?? 0 : 0;
  const output = active && joined ? voice.outputLevel ?? 0 : 0;
  const status = !active ? "Conversation ended" : !joined ? "Room open · microphone & speaker muted" : voice.status === "connecting" ? "Connecting…"
    : output > 0.035 ? `${name} speaking` : input > 0.035 ? "Listening to you" : "Listening";
  return <aside className={styles.panel} aria-label="Voice conversation">
    <header className={styles.header}>
      <span>Voice conversation</span>
      {!active && onClose && <button type="button" aria-label="Close voice history" onClick={onClose}>×</button>}
      {active && !joined && <button type="button" onClick={() => nativeCodexVoice.join(agentId)}>Join room</button>}
      {active && <button type="button" onClick={() => nativeCodexVoice.stop(agentId)}>End voice</button>}
    </header>
    <div className={styles.activity}>
      <div className={styles.meters} aria-hidden="true">
        {[input, output].map((level, side) => <div key={side} className={side ? styles.codexMeter : styles.userMeter}>
          {[0.45, 0.75, 1, 0.65, 0.4].map((weight, i) => <i key={i} style={{ transform: `scaleY(${0.12 + level * weight * 0.88})` }} />)}
        </div>)}
      </div>
      <span role="status">{status}</span>
    </div>
    <p className={styles.note}>You ↔ {name} · Native Codex audio<br />Coding actions appear in the work transcript.</p>
    {error && <div role="alert" className={styles.note}>Could not load voice history: {error} <button type="button" onClick={() => setRetry(n => n + 1)}>Retry</button></div>}
    {voice.agentId === agentId && voice.error && <p role="alert" className={styles.note}>{voice.error}</p>}
    <div className={styles.messages} ref={scroll} onScroll={() => {
      const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    }} aria-label="Voice messages">
      {messages.length === 0 && <p className={styles.note}>Your conversation will appear here as you speak.</p>}
      {messages.map((message, index) => <div key={message.id}>
        {index > 0 && messages[index - 1]?.sessionId !== message.sessionId && <div className={styles.separator}>New conversation</div>}
        <article className={`${styles.message} ${message.role === "user" ? styles.user : styles.assistant}`}>
          <div className={styles.meta}>{message.role === "user" ? message.roomId ? "Heard in meeting" : "You" : name} <time dateTime={new Date(message.ts).toISOString()}>{new Date(message.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
          <div className={styles.text}>{message.text}{!message.final && <span className={styles.partial}>{active ? " …" : " (unfinished)"}</span>}</div>
        </article>
      </div>)}
    </div>
    <footer className={styles.note}>Latest 100 messages · Text saved locally; no audio recording.</footer>
  </aside>;
}
