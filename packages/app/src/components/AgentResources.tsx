import { useEffect, useMemo, useState } from "react";
import { useAgentResources, type ResourceRequest, type ResourceView } from "../state/agentResources";
import { LoadStatusNote } from "./LoadStatusNote";
import styles from "./AgentResources.module.css";

const bytes = (n: number | null): string => n === null ? "memory unavailable" : `${(n / 1024 ** 2).toFixed(1)} MiB RSS`;
const cpu = (n: number | null): string => n === null ? "CPU measuring" : `CPU ${n.toFixed(1)}%`;

export function AgentResources({ agentId, request }: { agentId: string; request?: ResourceRequest }) {
  const [open, setOpen] = useState(false);
  const resources = useAgentResources(agentId, open, request);
  const { sample, stale } = resources;
  return <details className={styles.root} data-agent-resources open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>Resources · {sample?.state === "ok" || sample?.state === "stale" ? `${sample.totals.procCount} procs · ${bytes(sample.totals.rssBytes)} · ${cpu(sample.totals.cpuPct)}` : "OS memory and CPU"}{stale ? " · stale" : !open && sample ? " · last sample" : ""}</summary>
    {open && <AgentResourceDetails resources={resources} />}
  </details>;
}

export function AgentResourceDetails({ resources }: { resources: ResourceView }) {
  const { data, sample, age, stale, connected, loadState, load } = resources;
  const [scrollTop, setScrollTop] = useState(0);
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
  return <div className={styles.content}>
      <div className={styles.note}>OS process memory (RSS), separate from token context. Shared daemon MCP services are excluded; RSS includes shared pages and is not unique physical memory.</div>
      <LoadStatusNote status={loadState} what="resources" hasRows={!!sample} onRetry={load} />
      {!connected && <div role="status">disconnected{sample ? " · keeping last good resources" : " · waiting for daemon"}</div>}
      {loadState.unsupported && <div role="status">Resources unavailable · this daemon does not support local resource snapshots for this agent.</div>}
      {sample && <>
        <div className={styles.note} data-resource-updated>updated {new Date(sample.sampledAt).toLocaleTimeString()} · {age}s ago{stale ? " · stale" : ""}</div>
        {sample.state === "unavailable" ? <div role="status">Resources unavailable · {sample.reason === "no_process" ? "no owned process (ended worker or transport hides PID)" : sample.reason}</div> : <>
          {sample.state === "stale" && <div role="alert">Process sampling failed ({sample.reason}); keeping last good measurements.</div>}
          <div className={styles.tree} data-resource-tree tabIndex={0} role="region" onScroll={e => setScrollTop(e.currentTarget.scrollTop)} aria-label="read-only process tree">
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
        <div data-host-admission>admission {data!.admission.running}/{data!.admission.cap} · ceiling {data!.admission.ceiling}</div>
        <div>{!data!.admission.healthy ? "monitoring unavailable — admission is fail-open · " : data!.admission.running >= data!.admission.cap ? "new agents wait for capacity · " : "capacity available · "}{data!.admission.explain}</div>
      </>}
  </div>;
}
