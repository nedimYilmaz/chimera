import { useEffect, useMemo, useRef } from "react";
import type { UiState } from "@chimera/ui-state";
import type { NormalizedEvent } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { defaultLiveboardIds, fleetRows } from "../state/selectors.fleet";
import { displayName, fmtCost, isNearBottom } from "../state/selectors";
import styles from "./Liveboard.module.css";

function Lane({ agentId, onOpen }: { agentId: string; onOpen: (id: string) => void }) {
  const agent = useStore((s: UiState) => s.agents[agentId]);
  const lane = useStore((s: UiState) => s.liveboardLanes.find((l) => l.agentId === agentId));
  const body = useRef<HTMLDivElement>(null);
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
      {items.length === 0 ? <div className={styles.empty}>no transcript yet</div> : items.map((item, i) => <div className={styles[item.role]} key={`${agent.transcript.length - items.length + i}:${item.role}`}><span>{item.role === "assistant" ? "agent" : item.role}</span>{"text" in item ? item.text : item.role === "tool" ? `${item.toolName} · ${item.status}` : ""}</div>)}
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
  // Mirrors TranscriptPanel.tsx's per-step backfill effect: a lane's agent isn't
  // necessarily the single-selection watcher's (history.ts) target, so nothing else
  // ever fires agent.tail for it — without this, a non-selected lane shows "no
  // transcript yet" forever even once the daemon has real history for it.
  const requestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const lane of state.liveboardLanes) {
      const id = lane.agentId;
      const a = state.agents[id];
      if (!a || a.state === "unknown" || a.historyLoaded || a.transcript.length > 0 || requestedRef.current.has(id)) continue;
      requestedRef.current.add(id);
      void rpcCall<NormalizedEvent[]>("agent.tail", { agentId: id, n: 1000 })
        .then((events) => {
          appStore.dispatch({ type: "backfillHistory", agentId: id, events: Array.isArray(events) ? events : [] });
        })
        .catch((err: unknown) => console.warn("[chimera] liveboard lane backfill failed:", err));
    }
  }, [state.liveboardLanes, state.agents]);
  return <section className={styles.root}><div className={styles.top}><strong>liveboard</strong><span>2–4 bounded lanes · follow/hold</span>{state.liveboardLanes.length < 4 && ids.filter((id) => !state.liveboardLanes.some((l) => l.agentId === id)).slice(0, 1).map((id) => <button key={id} onClick={() => appStore.dispatch({ type: "liveboardLaneAdd", agentId: id })}>+ lane</button>)}</div><div className={styles.grid}>{state.liveboardLanes.map((lane) => <Lane key={lane.agentId} agentId={lane.agentId} onOpen={onOpen} />)}</div></section>;
}
