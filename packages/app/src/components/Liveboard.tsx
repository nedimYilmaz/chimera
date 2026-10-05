import { useCallback, useEffect, useMemo, useRef } from "react";
import type { UiState } from "@chimera/ui-state";
import type { NormalizedEvent } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { defaultLiveboardIds, fleetRows } from "../state/selectors.fleet";
import { displayName, fmtCost, isNearBottom } from "../state/selectors";
import { createLoadStatus, runLoad, useLoadStatus } from "../state/loadStatus";
import { LoadStatusNote } from "./LoadStatusNote";
import styles from "./Liveboard.module.css";

function Lane({ agentId, onOpen }: { agentId: string; onOpen: (id: string) => void }) {
  const agent = useStore((s: UiState) => s.agents[agentId]);
  const lane = useStore((s: UiState) => s.liveboardLanes.find((l) => l.agentId === agentId));
  const body = useRef<HTMLDivElement>(null);
  const status = useMemo(createLoadStatus, [agentId]);
  const loadState = useLoadStatus(status);
  const ready = !!agent && agent.state !== "unknown";
  const load = useCallback(() => {
    if (!appStore.getState().connected || status.getState().loading) return;
    void runLoad(status, () => rpcCall<NormalizedEvent[]>("agent.tail", { agentId, n: 1000 }), events => {
      appStore.dispatch({ type: "backfillHistory", agentId, events: Array.isArray(events) ? events : [] });
    }, { isUnsupported: error => /unknown method|unknown rpc|not implemented/i.test(String((error as { message?: unknown })?.message ?? error)) });
  }, [agentId, status]);
  useEffect(() => {
    if (!ready) return;
    let connected = appStore.getState().connected;
    const offline = () => {
      status.interrupt("disconnected");
      status.fail(status.begin(), "disconnected");
    };
    const current = appStore.getState().agents[agentId];
    if (current?.historyLoaded || current?.transcript.length) status.succeed(status.begin());
    if (!connected) offline();
    else if (!current?.historyLoaded && !current?.transcript.length) load();
    // Observe synchronous edges: React may batch disconnect/reconnect into one render.
    const off = appStore.subscribe(() => {
      const next = appStore.getState().connected;
      if (next === connected) return;
      connected = next;
      if (next) load(); else offline();
    });
    return () => { off(); status.interrupt("lane closed"); };
  }, [agentId, ready, load, status]);
  const transcriptLength = agent?.transcript.length ?? 0;
  useEffect(() => {
    if (!lane?.follow || !body.current) return;
    body.current.scrollTop = body.current.scrollHeight;
  }, [transcriptLength, lane?.follow]);
  if (!agent || !lane) return null;
  const items = agent.transcript.slice(Math.max(0, agent.transcript.length - 40));
  const attention = agent.state === "failed" || agent.state === "paused" || !!agent.pendingQuestion || !!agent.pendingDialog || (agent.busy && Date.now() - agent.lastEventTs > 60_000);
  return <article className={attention ? styles.laneAttention : styles.lane} aria-label={`${displayName(agent)} live transcript`}>
    <header><button onClick={() => onOpen(agentId)}>{displayName(agent)}</button><span>{agent.state}{agent.busy ? " · busy" : ""}</span><span>{fmtCost(agent.costUsd)}</span><button onClick={() => appStore.dispatch({ type: "liveboardLaneFollow", agentId, follow: !lane.follow })}>{lane.follow ? "follow" : `hold${lane.unread ? ` +${lane.unread}` : ""}`}</button><button aria-label={`remove ${displayName(agent)} lane`} onClick={() => appStore.dispatch({ type: "liveboardLaneRemove", agentId })}>×</button></header>
    <div ref={body} className={styles.transcript} onScroll={(e) => { const el = e.currentTarget; if (lane.follow && !isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight)) appStore.dispatch({ type: "liveboardLaneFollow", agentId, follow: false }); }}>
      <LoadStatusNote status={{ ...loadState, loaded: loadState.loaded || items.length > 0 }} what="transcript" hasRows={items.length > 0} onRetry={load} />
      {loadState.unsupported && <div className={styles.empty}>Transcript history is unavailable on this daemon.</div>}
      {items.length === 0 ? (loadState.loaded && !loadState.error && !loadState.unsupported ? <div className={styles.empty}>no transcript yet</div> : null) : items.map((item, i) => <div className={styles[item.role]} key={`${agent.transcript.length - items.length + i}:${item.role}`}><span>{item.role === "assistant" ? "agent" : item.role}</span>{"text" in item ? item.text : item.role === "tool" ? `${item.toolName} · ${item.status}` : ""}</div>)}
    </div>
  </article>;
}

export function Liveboard({ onOpen }: { onOpen: (id: string) => void }) {
  const state = useStore((s: UiState) => s);
  const ids = useMemo(() => defaultLiveboardIds(fleetRows(state, Date.now()), state.selectedAgentId), [state]);
  useEffect(() => {
    if (state.liveboardLanes.length > 0) return;
    for (const id of ids) appStore.dispatch({ type: "liveboardLaneAdd", agentId: id });
  }, [ids, state.liveboardLanes.length]);
  return <section className={styles.root}><div className={styles.top}><strong>liveboard</strong><span>2–4 bounded lanes · follow/hold</span>{state.liveboardLanes.length < 4 && ids.filter((id) => !state.liveboardLanes.some((l) => l.agentId === id)).slice(0, 1).map((id) => <button key={id} onClick={() => appStore.dispatch({ type: "liveboardLaneAdd", agentId: id })}>+ lane</button>)}</div><div className={styles.grid}>{state.liveboardLanes.map((lane) => <Lane key={lane.agentId} agentId={lane.agentId} onOpen={onOpen} />)}</div></section>;
}
