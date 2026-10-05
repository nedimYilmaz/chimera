import { useEffect, useMemo, useState } from "react";
import { AgentResourcesResponseSchema, type AgentResourcesResponse } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { createLoadStatus, runLoad, useLoadStatus } from "../state/loadStatus";
import { LoadStatusNote } from "./LoadStatusNote";
import styles from "./AgentResources.module.css";

const bytes = (n: number | null): string => n === null ? "memory unavailable" : `${(n / 1024 ** 2).toFixed(1)} MiB RSS`;
const cpu = (n: number | null): string => n === null ? "CPU measuring" : `CPU ${n.toFixed(1)}%`;

export function AgentResources({ agentId, request = rpcCall }: {
  agentId: string;
  request?: <T>(method: string, params: unknown) => Promise<T>;
}) {
  const status = useMemo(createLoadStatus, [agentId]);
  const loadState = useLoadStatus(status);
  const [data, setData] = useState<AgentResourcesResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(appStore.getState().connected);
  const [clock, setClock] = useState(Date.now());
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => { setData(null); setScrollTop(0); }, [agentId]);
  const load = (): void => {
    if (!appStore.getState().connected || status.getState().loading || status.getState().unsupported) return;
    void runLoad(status, async () => AgentResourcesResponseSchema.parse(await request<AgentResourcesResponse>("agent.resources", { agentId })), setData, {
      isUnsupported: (error) => {
        const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
        return /unknown method|unknown rpc|not implemented|does not accept engine-qualified ids|federation is not configured/i.test(message);
      },
    });
  };
  useEffect(() => {
    if (!open) return undefined;
    setClock(Date.now());
    let wasConnected = appStore.getState().connected;
    setConnected(wasConnected);
    const off = appStore.subscribe(() => {
      const next = appStore.getState().connected;
      if (next === wasConnected) return;
      wasConnected = next; setConnected(next);
      if (next) load(); else status.interrupt("connection to the daemon was lost");
    });
    load();
    const timer = setInterval(() => {
      setClock(Date.now());
      if (typeof document === "undefined" || document.visibilityState !== "hidden") load();
    }, 5000);
    return () => { off(); clearInterval(timer); status.interrupt("resource disclosure closed"); };
  }, [open, agentId, status, request]);
  const sample = data?.sample;
  const age = sample ? Math.max(0, Math.floor((clock - sample.sampledAt) / 1000)) : 0;
  const stale = !!sample && (!connected || !!loadState.error || loadState.unsupported || sample.state === "stale" || age > 12);
  const rows = sample?.procs ?? [];
  useEffect(() => { setScrollTop(0); }, [sample?.rootPid]);
  const start = Math.min(Math.max(0, rows.length - 14), Math.max(0, Math.floor(scrollTop / 28) - 2));
  const visible = rows.slice(start, start + 14);
  const depths = useMemo(() => {
    const parents = new Map(rows.map(p => [p.pid, p.ppid]));
    return new Map(rows.map(p => {
      let depth = 0; let parent = p.ppid; const seen = new Set([p.pid]);
      while (parents.has(parent) && !seen.has(parent) && depth < 8) { seen.add(parent); depth++; parent = parents.get(parent)!; }
      return [p.pid, depth];
    }));
  }, [rows]);
  return <details className={styles.root} data-agent-resources open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Resources · {sample?.state === "ok" || sample?.state === "stale" ? `${sample.totals.procCount} procs · ${bytes(sample.totals.rssBytes)} · ${cpu(sample.totals.cpuPct)}` : "OS memory and CPU"}{stale ? " · stale" : !open && sample ? " · last sample" : ""}</summary>
    {open && <div className={styles.content}>
      <div className={styles.note}>OS process memory (RSS), separate from token context. Shared daemon MCP services are excluded; RSS includes shared pages and is not unique physical memory.</div>
      <LoadStatusNote status={loadState} what="resources" hasRows={!!sample} onRetry={load} />
      {!connected && <div role="status">disconnected{sample ? " · keeping last good resources" : " · waiting for daemon"}</div>}
      {loadState.unsupported && <div role="status">Resources unavailable · this daemon does not support local resource snapshots for this agent.</div>}
      {sample && <>
        <div className={styles.note} data-resource-updated>updated {new Date(sample.sampledAt).toLocaleTimeString()} · {age}s ago{stale ? " · stale" : ""}</div>
        {sample.state === "unavailable" ? <div role="status">Resources unavailable · {sample.reason === "no_process" ? "no owned process (ended worker or transport hides PID)" : sample.reason}</div> : <>
          {sample.state === "stale" && <div role="alert">Process sampling failed ({sample.reason}); keeping last good measurements.</div>}
          <div className={styles.tree} data-resource-tree onScroll={e => setScrollTop(e.currentTarget.scrollTop)} aria-label="read-only process tree">
            <div style={{ height: rows.length * 28, position: "relative" }}>
              {visible.map((p, i) => <div key={p.pid} className={styles.process} style={{ top: (start + i) * 28 }}>
                <span className={styles.processName} style={{ paddingLeft: Math.min(depths.get(p.pid) ?? 0, 4) * 8 }} title={`${p.name} · PID ${p.pid} · parent ${p.ppid}`}>{p.name} · {p.pid}</span>
                <span>{bytes(p.rssBytes)} · {cpu(p.cpuPct)}</span>
              </div>)}
            </div>
          </div>
          {sample.truncated && <div className={styles.note}>Partial tree · limited to 2,000 processes and depth 8. Totals cover displayed processes.</div>}
          <div className={styles.note}>CPU uses two samples; Linux counters may have one-second granularity. 100% equals one CPU core.</div>
        </>}
        <div data-host-admission>admission {data.admission.running}/{data.admission.cap} · ceiling {data.admission.ceiling}</div>
        <div>{!data.admission.healthy ? "monitoring unavailable — admission is fail-open · " : data.admission.running >= data.admission.cap ? "new agents wait for capacity · " : "capacity available · "}{data.admission.explain}</div>
      </>}
    </div>}
  </details>;
}
