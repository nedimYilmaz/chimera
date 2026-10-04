import { useEffect, useRef, useState } from "react";
import { rpcCall } from "../rpc/bridge";
import { nativeCodexVoice } from "../voice/nativeCodex";
import styles from "./SpawnCard.module.css";
import own from "./AgentSettingsCard.module.css";

// Applied separately: hold/resume retains pinned jobs and supports paused agents,
// whereas the general settings patch uses the legacy kill/respawn workflow.
export function AgentRealtimeSetting({ agentId, enabled, paused, disabled, onChange, onBusy }: {
  agentId: string; enabled: boolean; paused: boolean; disabled: boolean;
  onChange: (enabled: boolean) => void; onBusy: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; onBusy(false); }; }, [onBusy]);
  useEffect(() => { setDraft(enabled); }, [enabled]);
  const apply = async () => {
    if (pending.current || disabled || draft === enabled) return;
    pending.current = true; setBusy(true); onBusy(true); setError(null);
    try {
      if (!draft) nativeCodexVoice.stop(agentId);
      const result = await rpcCall<{ enabled: boolean }>("voice.native.configure", { agentId, enabled: draft });
      if (active.current) onChange(result.enabled);
    } catch (e) {
      if (active.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      if (active.current) { setBusy(false); onBusy(false); }
    }
  };
  return <div data-agent-realtime-setting>
    <div className={styles.row}>
      <label className={styles.label} htmlFor={`realtime-${agentId}`}>realtime conversation</label>
      <select id={`realtime-${agentId}`} className={`${styles.inputBox} ${own.nativeField}`} value={draft ? "on" : "off"}
        disabled={disabled || busy} onChange={e => setDraft(e.target.value === "on")} data-settings-realtime>
        <option value="off">off</option><option value="on">on — this agent only</option>
      </select>
      <button type="button" className={styles.submitChip} disabled={disabled || busy || draft === enabled}
        onClick={() => void apply()} data-settings-realtime-apply>{busy ? "applying…" : "apply realtime"}</button>
    </div>
    <div className={styles.fieldHint}>
      Applied separately to this agent only; global settings and other agents are unchanged.
      {paused ? " This agent stays paused." : " Restarts this agent’s connection in the same thread; apply between turns because interrupted mailbox input is requeued."}
      {" Turning off ends active voice. Turning on does not open the microphone; use native Codex voice to start talking."}
    </div>
    {error && <div role="alert" className={styles.error}>{error}</div>}
  </div>;
}
