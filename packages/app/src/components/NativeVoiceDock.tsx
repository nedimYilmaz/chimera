import { useEffect, useSyncExternalStore } from "react";
import { nativeCodexVoice } from "../voice/nativeCodex";
import { onDaemonEvent } from "../rpc/bridge";
import { useStore } from "../state/useStore";
import { NativeVoiceControl } from "./NativeVoiceControl";
import styles from "./NativeVoiceDock.module.css";

// App-owned, never screen-owned. Navigation must not dispose media or hide MCP
// invitations. Only explicit stop, app close or transport/agent failure does.
export function NativeVoiceDock() {
  const rooms = useSyncExternalStore(nativeCodexVoice.subscribe, nativeCodexVoice.getRooms);
  const agents = useStore(s => s.agents);
  const selected = useStore(s => s.selectedAgentId);
  useEffect(() => {
    const since = Date.now();
    const off = onDaemonEvent(event => {
      if (event.ts >= since && event.kind === "voice_session_state" && event.data["native"] === true && event.data["stopRequested"] === true) nativeCodexVoice.stop(event.agentId);
    });
    const stop = () => nativeCodexVoice.stop();
    window.addEventListener("pagehide", stop);
    return () => { off(); window.removeEventListener("pagehide", stop); stop(); };
  }, []);
  return <div className={styles.dock} aria-label="Native voice rooms">
    {rooms.map(room => <div className={styles.room} key={room.roomId}>
      <span>{room.joined ? "●" : "○"} {agents[room.agentId ?? ""]?.displayLabel ?? room.agentId?.slice(0, 8)} · room {room.roomId.slice(0, 6)}</span>
      <span>{room.error ?? (room.joined ? room.status === "connecting" ? "connecting" : "mic & speaker connected" : "mic & speaker muted")}</span>
      {room.agentId && room.status !== "error" && <button type="button" onClick={() => nativeCodexVoice.join(room.joined ? null : room.agentId)}>{room.joined ? "Leave room" : "Join room"}</button>}
      <button type="button" onClick={() => { if (room.agentId) nativeCodexVoice.stop(room.agentId); }}>End voice</button>
    </div>)}
    <NativeVoiceControl agentId={selected} onSend={() => {}} requestsOnly />
  </div>;
}
