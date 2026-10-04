import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { nativeCodexVoice } from "../voice/nativeCodex";
import { onDaemonEvent, rpcCall } from "../rpc/bridge";
import type { NativeVoiceRequest } from "@chimera/protocol/contract";
import { appStore } from "../state/store";
import { composerLocal } from "../state/commands.agents";
import { ConfirmCard } from "./ConfirmCard";
import { displayChord, registerActionHandler } from "../keymap";
import { isConversationActive, stopConversation, toggleConversation } from "../voice/realtime/conversation";
import { cancelPushToTalk } from "../voice/session";
import { useStore } from "../state/useStore";
import styles from "./PushToTalkControl.module.css";

export function NativeVoiceControl({ agentId, onSend, requestsOnly = false }: { agentId: string | null; onSend: (text: string) => void; requestsOnly?: boolean }) {
  const provider = useStore(s => agentId ? s.agents[agentId]?.provider : undefined);
  const connected = useStore(s => s.connected);
  const voice = useSyncExternalStore(nativeCodexVoice.subscribe, () => nativeCodexVoice.getAgentState(agentId));
  const joined = useSyncExternalStore(nativeCodexVoice.subscribe, () => nativeCodexVoice.getRooms().some(room => room.agentId === agentId && room.joined));
  const [confirm, setConfirm] = useState<{ agentId: string; transition: boolean; requestId?: string } | null>(null);
  const [requests, setRequests] = useState<NativeVoiceRequest[]>([]);
  const requestTargetLabel = useStore(s => {
    const id = requests[0]?.agentId;
    return id ? s.agents[id]?.displayLabel ?? id.slice(0, 8) : "";
  });
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const active = voice.status === "connecting" || voice.status === "listening";

  useEffect(() => {
    if (!requestsOnly) return;
    if (!connected) { setRequests([]); return; }
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const pending = await rpcCall<NativeVoiceRequest[]>("voice.native.requests", {}); if (!disposed && Array.isArray(pending)) setRequests(pending); }
      catch { /* Reconnect owns connectivity errors; never request microphone here. */ }
      finally { if (!disposed) timer = setTimeout(() => { void poll(); }, 2000); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [connected, requestsOnly]);
  useEffect(() => {
    const subscribedAt = Date.now();
    return onDaemonEvent(event => {
      if (event.kind !== "voice_session_state" || event.data["native"] !== true || event.data["stopRequested"] !== true) return;
      if (event.ts < subscribedAt) return; // Historical stop events must never cancel a new call.
      if (event.agentId === agentId) { epoch.current++; setConfirm(null); setChecking(false); }
      setRequests(previous => previous.filter(r => r.agentId !== event.agentId));
    });
  }, [agentId]);

  useEffect(() => {
    setConfirm(null); setChecking(false); setError(null);
    return () => { epoch.current++; };
  }, [agentId, connected]);

  const toggle = async (request?: NativeVoiceRequest) => {
    if (request && (request.agentId !== agentId || provider !== "codex")) {
      setError("This voice request no longer targets a Codex agent. Dismiss it and request again.");
      return;
    }
    if (active && agentId) { if (joined) nativeCodexVoice.stop(agentId); else nativeCodexVoice.join(agentId); return; }
    if (isConversationActive()) { await stopConversation(); return; }
    if (checking || confirm || !agentId || !connected) return;
    if (provider !== "codex") {
      await toggleConversation(agentId, onSend);
      return;
    }
    const version = ++epoch.current;
    setChecking(true); setError(null);
    try {
      const check = await rpcCall<{ needsTransition: boolean }>("voice.native.check", { agentId });
      if (version === epoch.current) setConfirm({ agentId, transition: check.needsTransition, ...(request ? { requestId: request.requestId } : {}) });
    } catch (e) {
      if (version === epoch.current) setError(e && typeof e === "object" && "message" in e ? String(e.message) : String(e));
    } finally { if (version === epoch.current) setChecking(false); }
  };
  useEffect(() => requestsOnly ? undefined : registerActionHandler("voice.conversationToggle", () => { void toggle(); }));
  if (requestsOnly && requests.length === 0 && !confirm && !error) return null;
  if (provider !== "codex" && !active && requests.length === 0) return null;
  return <>
    {requests.slice(0, 1).map(request => <div key={request.requestId} className={styles.voiceRequest} role="status">
      <span>Voice requested for {requestTargetLabel}{request.callerAgentId ? ` by ${request.callerAgentId.slice(0, 8)}` : ""}{request.reason ? `: ${request.reason}` : ""}{requests.length > 1 ? ` (+${requests.length - 1} pending)` : ""}</span>
      <button type="button" className={`${styles.control} ${styles.idle}`} disabled={!connected || active || checking || !!confirm}
        onClick={() => {
          appStore.dispatch({ type: "selectTab", tab: "agents" });
          appStore.dispatch({ type: "selectAgent", agentId: request.agentId });
          composerLocal.set({ target: "selected", targetMenuOpen: false });
          if (request.agentId === agentId) void toggle(request);
        }}>{request.agentId === agentId ? "Review voice request" : "Open requested agent"}</button>
      <button type="button" className={`${styles.control} ${styles.idle}`} onClick={() => {
        void rpcCall("voice.native.dismiss", { requestId: request.requestId }).then(() => setRequests(previous => previous.filter(r => r.requestId !== request.requestId))).catch(e => setError(String(e)));
      }}>Dismiss</button>
    </div>)}
    {!requestsOnly && (provider === "codex" || active) && <>
    <button type="button" className={`${styles.control} ${active ? styles.listening : styles.idle}`}
      disabled={!active && (!connected || !agentId || checking)} aria-pressed={active}
      title={active ? joined ? "End this voice room; coding work continues" : "Join this room: other rooms stay open but muted" : `Talk to this Codex agent in its existing context (${displayChord("alt+space")})`}
      onClick={() => { void toggle(); }}>
      {active ? !joined ? "Join voice room" : voice.status === "connecting" ? "■ cancel voice connection" : "■ end native voice" : checking ? "checking voice…" : "◉ native Codex voice"}
    </button>
    </>}
    {(error || voice.error) && <span role="alert" className={styles.error}>{error ?? voice.error}</span>}
    {confirm && <div className={requestsOnly ? styles.globalVoiceConfirm : undefined}><ConfirmCard title="Native Codex voice" meta={confirm.agentId}
      body={confirm.transition
        ? "Enable realtime for this agent only? Continue to pause its current turn and resume the same saved session in app-server mode with native voice enabled. Its account, model, context and permissions are retained. Other agents and your global Codex settings are unchanged. Interrupted mailbox input is requeued, so switching between turns is recommended. The agent will remain available for follow-up turns."
        : "Start a native voice conversation in this agent’s existing Codex session?"}
      note="Your microphone audio is sent to your Codex account’s service. Text is saved locally; Chimera does not record audio. This joins a private voice room; other rooms remain connected but their microphones and speakers are muted. Changing tabs does not end voice. Use headphones to avoid acoustic feedback."
      confirmLabel="Start native voice" onClose={() => setConfirm(null)} onConfirm={() => {
        const target = confirm; const version = ++epoch.current;
        setConfirm(null); cancelPushToTalk();
        void stopConversation().then(() => { if (version === epoch.current) return nativeCodexVoice.start(target.agentId, target.transition, target.requestId); }).catch(e => { if (version === epoch.current) setError(String(e?.message ?? e)); });
      }} /></div>}
  </>;
}
