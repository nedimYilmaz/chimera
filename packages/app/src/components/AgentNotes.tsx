import { useState } from "react";

export const agentNotesKey = (agentId: string): string => `chimera:operator-notes:v1:${agentId}`;
function readNote(agentId: string): string {
  try { return localStorage.getItem(agentNotesKey(agentId)) ?? ""; } catch { return ""; }
}

/** Mount keyed by agent identity. Never send notes through RPC or model context. */
export function AgentNotes({ agentId }: { agentId: string }) {
  const [text, setText] = useState(() => readNote(agentId));
  const [notice, setNotice] = useState("");
  return <details><summary>personal notes</summary>
    <p>Local to this app installation; never sent to the agent. Do not store passwords here.</p>
    <textarea aria-label="personal agent notes" rows={4} maxLength={16000} value={text} onChange={e => { setText(e.target.value); setNotice("unsaved"); }} />
    <button type="button" onClick={() => {
      try { if (text) localStorage.setItem(agentNotesKey(agentId), text); else localStorage.removeItem(agentNotesKey(agentId)); setNotice("saved locally"); }
      catch { setNotice("Unable to save: local storage is unavailable or full. Your draft is still here."); }
    }}>save notes</button><span role="status">{notice}</span>
  </details>;
}
