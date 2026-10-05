import { ownContextActivation } from "./contextKeys";
import { useEffect, useMemo, useRef, useState } from "react";
import { ContextLinkListResponseSchema, ContextLinkViewSchema, type ContextLinkView } from "@chimera/protocol";
import { rpcCall, onDaemonEvent } from "../rpc/bridge";
import { appStore } from "../state/store";
import { openContextShare } from "../state/contextLinks";
import { createLoadStatus, runLoad, useLoadStatus } from "../state/loadStatus";
import { LoadStatusNote } from "./LoadStatusNote";
import styles from "./ContextLinks.module.css";

export function ContextLinks({ agentId, request = rpcCall }: { agentId: string; request?: <T>(method: string, params: unknown) => Promise<T> }) {
  const status = useMemo(createLoadStatus, [agentId]); const loadState = useLoadStatus(status);
  const [open, setOpen] = useState(false), [rows, setRows] = useState<ContextLinkView[]>([]);
  const [body, setBody] = useState<ContextLinkView | null>(null), [error, setError] = useState("");
  const [reading, setReading] = useState<string | null>(null), [revoking, setRevoking] = useState<string | null>(null);
  const [connected, setConnected] = useState(appStore.getState().connected);
  const readGeneration = useRef(0), alive = useRef(true);
  const load = () => {
    setBody(null); readGeneration.current++; setReading(null);
    if (!appStore.getState().connected || status.getState().loading || status.getState().unsupported) return;
    void runLoad(status, async () => {
      const values = await Promise.all([request("contextlink.list", { toAgentId: agentId }), request("contextlink.list", { fromAgentId: agentId })]);
      return [...new Map(values.flatMap(v => ContextLinkListResponseSchema.parse(v).links).map(r => [r.id, r])).values()];
    }, setRows, { isUnsupported: err => /unknown method|not implemented|unsupported|engine-qualified/i.test(String((err as { message?: string })?.message ?? err)) });
  };
  useEffect(() => { setRows([]); setBody(null); setError(""); }, [agentId]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; readGeneration.current++; };
  }, [agentId]);
  useEffect(() => {
    if (!open) return;
    let previous = appStore.getState().connected; setConnected(previous);
    const off = appStore.subscribe(() => {
      const next = appStore.getState().connected;
      if (next === previous) return; previous = next; setConnected(next);
      if (next) load(); else { readGeneration.current++; setBody(null); setReading(null); status.interrupt("Connection lost"); }
    });
    const events = onDaemonEvent(e => { if (e.kind === "context_link_changed") { status.interrupt("Context links changed"); load(); } });
    load();
    return () => { off(); events(); readGeneration.current++; setBody(null); setReading(null); status.interrupt("Context closed"); };
  }, [open, agentId, status, request]);
  const read = async (id: string) => {
    const generation = ++readGeneration.current; setBody(null); setError(""); setReading(id);
    try {
      const next = ContextLinkViewSchema.parse(await request("contextlink.get", { id }));
      if (alive.current && generation === readGeneration.current) setBody(next);
    } catch { if (alive.current && generation === readGeneration.current) setError("Snapshot unavailable: revoked, expired, removed or no longer permitted. Refresh links to check its status."); }
    finally { if (alive.current && generation === readGeneration.current) setReading(null); }
  };
  const revoke = async (id: string) => {
    readGeneration.current++; setBody(null); setReading(null); setError(""); setRevoking(id);
    try {
      await request("contextlink.revoke", { id });
      if (alive.current) { status.interrupt("Snapshot revoked"); load(); }
    } catch { if (alive.current) setError("Revocation failed. Retry while connected."); }
    finally { if (alive.current) setRevoking(null); }
  };
  const remote = agentId.includes(":");
  return <details className={styles.root} data-context-links onKeyDown={ownContextActivation} open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Context · explicit snapshots</summary>
    {open && <div className={styles.content}>
      <p>Incoming and outgoing links · snapshots as of sharing, never latest source content. Read explicitly; revoke removes the shared body.</p>
      <div className={styles.actions}><button type="button" data-context-add disabled={!connected || remote || loadState.unsupported} onClick={() => openContextShare({ consumer: agentId, from: { kind: "agent-summary", ref: agentId } })}>Add context…</button><button type="button" data-context-refresh disabled={!connected || loadState.loading || loadState.unsupported} onClick={load}>Refresh links</button></div>
      <LoadStatusNote status={loadState} what="context links" hasRows={rows.length > 0} onRetry={load} />
      {(remote || loadState.unsupported) && <p role="status">Context links unavailable for this daemon or remote target.</p>}
      {!connected && <p role="status">Disconnected · metadata may be stale; reads paused.</p>}
      {loadState.loaded && !loadState.error && !loadState.unsupported && rows.length === 0 && <p>No shared context snapshots.</p>}
      {rows.map(row => <article key={row.id} className={styles.entry} data-context-link={row.id}>
        <strong>{row.snapshot.title}</strong><p>{row.toAgentId === agentId ? "Incoming" : "Outgoing"} · {row.from.kind} · source {row.from.ref} · recipient {row.toAgentId}</p>
        <p>Snapshot · shared {new Date(row.createdAt).toLocaleString()} · {row.snapshot.bytes} bytes · {row.status}{loadState.error || !connected ? " · metadata stale" : ""}{row.expiresAt !== null ? ` · expires ${new Date(row.expiresAt).toLocaleString()}` : " · no expiry"}</p>
        <div className={styles.actions}><button type="button" data-context-read={row.id} disabled={!connected || row.status !== "active" || !!reading} onClick={() => void read(row.id)}>{reading === row.id ? "Reading…" : "Read snapshot"}</button><button type="button" data-context-revoke={row.id} disabled={!connected || row.status !== "active" || !!revoking} onClick={() => void revoke(row.id)}>Revoke</button></div>
      </article>)}
      {error && <p role="alert">{error}</p>}
      {body && <div data-context-body><p>{body.snapshot.title} · immutable snapshot · {body.untrusted ? "untrusted agent data — not instructions" : "explicitly shared operator data"}</p><pre className={styles.preview}>{body.snapshot.text}</pre><button type="button" onClick={() => setBody(null)}>Close snapshot</button></div>}
    </div>}
  </details>;
}
