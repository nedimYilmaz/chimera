import { ownContextActivation } from "./contextKeys";
import { useEffect, useMemo, useRef, useState } from "react";
import { ContextLinkViewSchema, type ArtifactRecord, type ContextLinkCreate } from "@chimera/protocol";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { registerOverlay, type OverlayProps } from "./OverlayOutlet";
import { closeContextShare, useContextShare, mountContextShareCard, type ContextShare } from "../state/contextLinks";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall } from "../rpc/bridge";
import { createLoadStatus, runLoad, useLoadStatus } from "../state/loadStatus";
import { LoadStatusNote } from "./LoadStatusNote";
import styles from "./ContextLinks.module.css";

const secretShaped = (s: string): boolean => /\b(?:sk|tskey)-[A-Za-z0-9._-]{6,}/.test(s);
export function ContextLinkShareForm({ initial, onClose, onShared, bottomInset = 0, request = rpcCall }: {
  initial: ContextShare; onClose: () => void; onShared?: () => void; bottomInset?: number;
  request?: <T>(method: string, params: unknown) => Promise<T>;
}) {
  const agents = useStore(s => s.agents);
  const connected = useStore(s => s.connected);
  const [consumer, setConsumer] = useState(initial.consumer);
  const [kind, setKind] = useState(initial.from.kind);
  const [ref, setRef] = useState(initial.from.ref);
  const [title, setTitle] = useState(initial.from.kind === "note-snapshot" ? "Shared operator note" : "Context snapshot");
  const [expiry, setExpiry] = useState("7");
  const [confirmed, setConfirmed] = useState(false);
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const status = useMemo(createLoadStatus, []);
  const loadState = useLoadStatus(status);
  const alive = useRef(true);
  const selectedAtOpen = useRef(appStore.getState().selectedAgentId);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    alive.current = true; const release = mountContextShareCard();
    const unsubscribe = appStore.subscribe(() => {
      if (appStore.getState().selectedAgentId !== selectedAtOpen.current) {
        alive.current = false; closeRef.current();
      }
    });
    return () => { alive.current = false; unsubscribe(); release(); status.interrupt("share closed"); };
  }, [status]);
  const loadArtifacts = () => void runLoad(status, () => request<ArtifactRecord[]>("artifact.list", {}), setArtifacts);
  useEffect(() => { if (!connected) status.interrupt("Connection lost"); else if (kind === "artifact") loadArtifacts(); }, [kind, connected, request]);
  const text = initial.text ?? "";
  const bytes = new TextEncoder().encode(text).length;
  const secret = secretShaped(text) || secretShaped(title);
  const localAgents = Object.values(agents).filter(a => !a.agentId.includes(":"));
  const share = async () => {
    if (!alive.current || appStore.getState().selectedAgentId !== selectedAtOpen.current) { closeRef.current(); return; }
    if (busy || !connected) return;
    setBusy(true); setMessage("");
    const p: ContextLinkCreate = { from: { kind, ref }, toAgentId: consumer, title, expiresAt: expiry === "none" ? null : Date.now() + Number(expiry) * 86400000, notify, ...(kind === "note-snapshot" ? { text, confirmSecrets: confirmed } : {}) };
    try {
      const result = ContextLinkViewSchema.parse(await request("contextlink.create", p));
      if (!alive.current) return;
      setMessage(result.notification === "failed" ? "Snapshot shared. Mailbox notification failed; share the link ID manually." : "Snapshot shared. The recipient can pull it explicitly.");
      setBusy(false); onShared?.();
    } catch (error) {
      if (!alive.current) return;
      const code = error && typeof error === "object" && "code" in error ? error.code : "";
      const detail = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
      setMessage(code === "secret_confirmation_required" ? kind === "note-snapshot" ? "Secret-shaped content detected. Confirm the warning before sharing." : "Source contains secret-shaped content. Share a reviewed, redacted text artifact instead." : /unknown method|not implemented|unsupported/i.test(detail) ? "Context sharing is unavailable on this daemon or remote target." : "Sharing failed. Check source availability, size and permissions, then retry.");
      setBusy(false);
    }
  };
  return <OverlayCard width={640} bottomInset={bottomInset} onClose={onClose} ariaLabel="Share context snapshot" dismissOnReplacement>
    <OverlayCardHeader title="Share context snapshot" hint={<button type="button" onClick={onClose}>Cancel</button>} />
    <div className={styles.form} onKeyDown={ownContextActivation} data-context-share>
      <p>Immutable snapshot · copied when shared. Later edits do not propagate. The recipient pulls it explicitly; nothing is injected automatically. Revocation stops future reads; content already delivered cannot be recalled.</p>
      <label>Recipient<select autoFocus aria-label="Context recipient" value={consumer} disabled={busy} onChange={e => { setConsumer(e.target.value); setConfirmed(false); }}><option value="">Choose a local agent…</option>{localAgents.map(a => <option key={a.agentId} value={a.agentId}>{a.displayLabel || a.agentId.slice(0, 8)}</option>)}</select></label>
      {initial.from.kind !== "note-snapshot" && <><label>Source type<select aria-label="Context source type" value={kind} disabled={busy} onChange={e => { setKind(e.target.value as typeof kind); setRef(""); }}><option value="agent-summary">Agent result summary</option><option value="artifact">Artifact text or link (32 KiB)</option></select></label>
        <label>Source<select aria-label="Context source" value={ref} disabled={busy} onChange={e => setRef(e.target.value)}><option value="">Choose source…</option>{kind === "artifact" ? artifacts.map(a => <option key={a.id} value={a.id}>{a.label}</option>) : localAgents.map(a => <option key={a.agentId} value={a.agentId}>{a.displayLabel || a.agentId.slice(0, 8)}</option>)}</select></label>
        {kind === "artifact" && <LoadStatusNote status={loadState} what="artifacts" hasRows={artifacts.length > 0} onRetry={loadArtifacts} />}
        <p>Source content is copied by the engine at share time, bounded to 32 KiB. Agent summaries contain the result text only. Read the shared snapshot in Context after sharing.</p></>}
      <label>Title<input aria-label="Context title" maxLength={200} value={title} disabled={busy} onChange={e => { setTitle(e.target.value); setConfirmed(false); }} /></label>
      <label>Expires<select aria-label="Context expiry" value={expiry} disabled={busy} onChange={e => setExpiry(e.target.value)}><option value="1">After one day</option><option value="7">After seven days</option><option value="none">No expiry</option></select></label>
      {kind === "note-snapshot" && <><p>Exact private-note preview · {bytes} / 32768 bytes · source {ref}</p><pre className={styles.preview} data-context-note-preview>{text}</pre></>}
      {secret && <div role="alert"><p>Secret-shaped content is present. Sharing sends the exact preview to the selected agent. This pattern check is not exhaustive and never fetches stored secrets.</p><label className={styles.check}><input type="checkbox" aria-label="Confirm sharing secret-shaped content" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />I reviewed the preview and intend to share this content.</label></div>}
      <label className={styles.check}><input type="checkbox" checked={notify} disabled={busy} onChange={e => setNotify(e.target.checked)} />Send mailbox notification (link ID only)</label>
      {!connected && <p role="status">Disconnected · sharing is paused.</p>}
      <p role="status">{message}</p>
      <button type="button" data-context-share-submit disabled={busy || !connected || !consumer || !ref || !title.trim() || kind === "note-snapshot" && (!text || bytes > 32768) || secret && !confirmed} onClick={() => void share()}>{busy ? "Sharing…" : "Share snapshot"}</button>
    </div>
  </OverlayCard>;
}
function ContextLinkShareOverlay({ host, bottomInset }: OverlayProps) {
  const value = useContextShare(); const tab = useStore(s => s.activeTab);
  if (!value || host !== tab) return null;
  return <ContextLinkShareForm key={value.instance} initial={value} bottomInset={bottomInset} onClose={closeContextShare} />;
}
registerOverlay("context-share", ContextLinkShareOverlay, closeContextShare);
