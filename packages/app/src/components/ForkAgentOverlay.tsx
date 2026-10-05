import { useEffect, useMemo, useRef, useState } from "react";
import { ForkCapabilitiesSchema, ForkResponseSchema, type ForkCapabilities } from "@chimera/protocol";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { registerOverlay, type OverlayProps } from "./OverlayOutlet";
import { branchCreated, closeConversationFork, useBranchNotice, useConversationFork, mountConversationForkCard } from "../state/conversationFork";
import { createLoadStatus, runLoad, useLoadStatus } from "../state/loadStatus";
import { useStore } from "../state/useStore";
import { appStore } from "../state/store";
import { rpcCall } from "../rpc/bridge";
import { LoadStatusNote } from "./LoadStatusNote";
import { errorText } from "../state/errorText";
import { ownContextActivation } from "./contextKeys";
import styles from "./ForkAgentOverlay.module.css";

export function ForkAgentForm({ agentId, upToSeq, onClose, bottomInset = 0, request = rpcCall, onCreated = branchCreated }: {
  agentId: string; upToSeq?: number; onClose: () => void; bottomInset?: number;
  request?: <T>(method: string, params: unknown) => Promise<T>; onCreated?: (source: string, child: string, label: string) => void;
}) {
  const connected = useStore(s => s.connected);
  const [capabilities, setCapabilities] = useState<ForkCapabilities | null>(null);
  const [mode, setMode] = useState<"snapshot" | "native">("snapshot");
  const [task, setTask] = useState("");
  const [title, setTitle] = useState("");
  const [includeUncommitted, setIncludeUncommitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const busyRef = useRef(false), alive = useRef(true);
  const status = useMemo(createLoadStatus, []);
  const load = useLoadStatus(status);
  const selectedAtOpen = useRef(appStore.getState().selectedAgentId);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const reload = () => void runLoad(status, async () => ForkCapabilitiesSchema.parse(await request("agent.forkCapabilities", { agentId, upToSeq })), setCapabilities,
    { isUnsupported: e => /unknown method|not implemented/i.test(errorText(e)) });
  const reloadRef = useRef(reload); reloadRef.current = reload;
  useEffect(() => {
    alive.current = true;
    const release = mountConversationForkCard();
    let wasConnected = appStore.getState().connected;
    const unsubscribe = appStore.subscribe(() => {
      const isConnected = appStore.getState().connected;
      if (!isConnected && wasConnected) status.interrupt("Connection lost");
      if (isConnected && !wasConnected) reloadRef.current();
      wasConnected = isConnected;
      if (appStore.getState().selectedAgentId !== selectedAtOpen.current) { alive.current = false; closeRef.current(); }
    });
    return () => { alive.current = false; unsubscribe(); release(); status.interrupt("Branch dialog closed"); };
  }, [status]);
  useEffect(() => { if (connected) reload(); else status.interrupt("Connection lost"); }, [agentId, upToSeq, request]);
  const create = async () => {
    if (busyRef.current || !connected || !capabilities?.[mode].available || !task.trim() || !alive.current) return;
    busyRef.current = true; setBusy(true); setMessage("");
    try {
      const result = ForkResponseSchema.parse(await request("agent.fork", { agentId, upToSeq: capabilities.atSeq, mode, task: task.trim(), ...(title.trim() ? { title: title.trim() } : {}), includeUncommitted }));
      if (alive.current) onCreated(agentId, result.agentId, result.label);
    } catch (error) { if (alive.current) setMessage(errorText(error)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  return <OverlayCard width={640} bottomInset={bottomInset} onClose={onClose} ariaLabel="Branch conversation" dismissOnReplacement>
    <OverlayCardHeader title="Branch conversation" hint={<button type="button" onClick={onClose}>Cancel</button>} />
    <div className={styles.form} onKeyDown={ownContextActivation} data-fork-form>
      <p>Parent {agentId} · through {capabilities?.atSeq ? `completed event ${capabilities.atSeq}` : upToSeq ? `event ${upToSeq}` : "last completed message"}. Creates a separate session and worktree; the original conversation stays open. The child consumes additional budget.</p>
      <LoadStatusNote status={load} what="branch capabilities" hasRows={!!capabilities} onRetry={reload} />
      {load.unsupported && <p role="status">Branching is unavailable on this daemon. Update it or create a fresh agent with a reviewed brief.</p>}
      {capabilities && <>
        <p>{capabilities.provider} · account {capabilities.account} · {capabilities.model ?? "provider default model"}</p>
        <fieldset disabled={busy || load.loading || !!load.error || !connected}>
          <legend>Context mode</legend>
          <label><input type="radio" name="fork-mode" value="snapshot" checked={mode === "snapshot"} disabled={!capabilities.snapshot.available} onChange={() => setMode("snapshot")} />Snapshot handoff — context re-created from a bounded brief; no tool history</label>
          {!capabilities.snapshot.available && <p>{capabilities.snapshot.reason}</p>}
          <label><input type="radio" name="fork-mode" value="native" checked={mode === "native"} disabled={!capabilities.native.available} onChange={() => setMode("native")} />Native conversation fork</label>
          {!capabilities.native.available && <p data-fork-native-reason>{capabilities.native.reason}</p>}
        </fieldset>
      </>}
      <label>Intended task<textarea autoFocus aria-label="Branch intended task" maxLength={8000} value={task} disabled={busy} onChange={e => setTask(e.target.value)} placeholder="What should the new branch do?" /></label>
      <label>Branch title (optional)<input aria-label="Branch title" maxLength={120} value={title} disabled={busy} onChange={e => setTitle(e.target.value)} /></label>
      <label className={styles.check}><input type="checkbox" checked={includeUncommitted} disabled={busy} onChange={e => setIncludeUncommitted(e.target.checked)} />Copy tracked uncommitted changes into the child only</label>
      <p>Files start at the source’s current HEAD, not the selected message’s historical file state. Untracked files, image bytes, private operator notes and secret grants are excluded. Transcribed attachment text is included when recorded.</p>
      {!connected && <p role="status">Disconnected · branching is paused.</p>}
      {message && <p role="alert">{message}</p>}
      <button type="button" data-fork-submit disabled={busy || !connected || !task.trim() || !capabilities?.[mode].available || load.loading || !!load.error || load.unsupported} onClick={() => void create()}>{busy ? "Creating branch…" : "Create branch"}</button>
    </div>
  </OverlayCard>;
}

export function ForkLineageChip({ lineage }: { lineage?: { forkedFrom: string; mode: string; atSeq: number } }) {
  return lineage ? <span className={styles.lineage} data-fork-lineage>Branched from {lineage.forkedFrom} · {lineage.mode} · event {lineage.atSeq}</span> : null;
}
export function BranchNotice({ agentId }: { agentId: string }) {
  const notice = useBranchNotice();
  if (notice?.source !== agentId) return null;
  return <div className={styles.notice} role="status" data-fork-notice>{notice.label} <button type="button" onClick={() => appStore.dispatch({ type: "selectAgent", agentId: notice.child })}>Open branch</button></div>;
}
function ForkAgentOverlay({ host, bottomInset }: OverlayProps) {
  const branch = useConversationFork(), tab = useStore(s => s.activeTab);
  if (!branch || host !== tab) return null;
  return <ForkAgentForm key={branch.instance} agentId={branch.agentId} upToSeq={branch.upToSeq} onClose={closeConversationFork} bottomInset={bottomInset} />;
}
registerOverlay("conversation-fork", ForkAgentOverlay, closeConversationFork);
