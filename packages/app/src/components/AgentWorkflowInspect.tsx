import { useState } from "react";
import type { AgentView } from "@chimera/ui-state";
import type { ShadowActivity, WorkflowTranscriptLine } from "@chimera/protocol/contract";
import { foldInnerAgents, relTimeOf } from "../state/workflowInspect";
import { fmtDurationSec, fmtTokens } from "../state/selectors";
import { useWorkflowInspect } from "../state/useWorkflowInspect";
import styles from "./AgentWorkflowInspect.module.css";

export function AgentWorkflowInspect({ agent }: { agent: AgentView }) {
  return <WorkflowInspectBody key={agent.agentId} agent={agent} />;
}

function Activity({ activity }: { activity?: ShadowActivity }) {
  if (!activity) return null;
  const done = activity.steps.filter(s => s.status === "completed").length;
  return <div className={styles.activity}>
    <div className={styles.metaRow}>
      {activity.lastTool && <span>last tool: {activity.lastTool}</span>}
      {activity.lastActivityTs && <span>updated {relTimeOf(activity.lastActivityTs, Date.now())}</span>}
    </div>
    {activity.steps.length > 0 && <div aria-label="reported task steps">
      <div>{done}/{activity.steps.length} reported steps complete</div>
      {activity.steps.map((step, i) => <div key={i} className={styles.step}>
        <span>{step.status === "completed" ? "✓" : step.status === "in_progress" ? "●" : "○"}</span>
        <span>{step.title}</span><span className={styles.faint}>{step.status.replaceAll("_", " ")}</span>
      </div>)}
    </div>}
    {activity.truncated && <div className={styles.faint}>Showing recent activity; earlier history is omitted.</div>}
  </div>;
}

function Transcript({ lines }: { lines: WorkflowTranscriptLine[] | null }) {
  return <div className={styles.transcript} aria-label="shadow transcript">
    {lines?.length ? lines.map((line, i) => <div key={i} className={styles.line}>
      <span className={styles.role} title={line.ts ? new Date(line.ts).toLocaleString() : undefined}>{line.role}</span>
      <span className={styles.lineText}>{line.text}</span>
    </div>) : <div className={styles.faint}>No transcript captured yet. Activity refreshes automatically.</div>}
  </div>;
}

function WorkflowInspectBody({ agent }: { agent: AgentView }) {
  const [selectedInner, setSelectedInner] = useState<string | null>(null);
  const [phase, setPhase] = useState<number | null>(null);
  const { data, error, loading } = useWorkflowInspect(agent.agentId, selectedInner);
  if (!data?.available) return <div className={styles.wrap}>
    <div className={styles.note}>Session activity is read on demand and refreshes every 2.5 seconds.
      <div className={styles.reason} role="status">{error ?? data?.reason ?? (loading ? "loading activity…" : "activity unavailable")}</div>
    </div>
  </div>;

  const rows = foldInnerAgents(data.agents, Date.now());
  const selected = rows.find(r => r.agentId === selectedInner);
  const done = rows.filter(r => r.state === "done").length;
  const running = rows.filter(r => r.state === "running").length;
  const workflow = data.workflow;
  const native = data.source === "subagent";
  return <div className={styles.wrap} data-shadow-inspector={agent.agentId}>
    {error && <div className={styles.reason} role="alert">Refresh failed: {error}. Showing the last successful snapshot.</div>}
    <div className={styles.metaRow}>
      <strong>{workflow?.name ?? (native ? "Sub-agent activity" : "Workflow activity")}</strong>
      {data.runId && <span className={styles.runId}>{data.runId}</span>}
      {workflow?.status && <span>{workflow.status}</span>}
      {!native && <span>{done}/{rows.length} agents complete · {running} running</span>}
      {workflow?.totalTokens != null && <span>{fmtTokens(workflow.totalTokens)} tokens</span>}
      {workflow?.durationMs != null && <span>{fmtDurationSec(workflow.durationMs)}</span>}
      {workflow?.totalToolCalls != null && <span>{workflow.totalToolCalls} tool calls</span>}
    </div>
    {workflow?.phases.length ? <div className={styles.phases} aria-label="workflow phases">
      <button type="button" aria-pressed={phase === null} onClick={() => setPhase(null)}>All phases</button>
      {workflow.phases.map(p => {
        const members = rows.filter(r => r.phaseIndex === p.index);
        const completed = members.filter(r => r.state === "done").length;
        return <button type="button" key={p.index} aria-pressed={phase === p.index}
          title={p.detail ?? p.title} onClick={() => { setPhase(p.index); setSelectedInner(null); }}>
          {p.index} · {p.title} <span>{completed}/{members.length}</span>
          {members.some(r => r.state === "running") && <span className={styles.runningPill}>running</span>}
        </button>;
      })}
    </div> : null}
    {!native && <div className={styles.roster}>
      {rows.filter(r => phase === null || r.phaseIndex === phase).map(r => <button
        key={r.agentId} type="button" aria-pressed={r.agentId === selectedInner}
        title={`drill into ${r.agentId}`}
        className={`${styles.row} ${r.agentId === selectedInner ? styles.rowSelected : ""}`}
        onClick={() => setSelectedInner(r.agentId === selectedInner ? null : r.agentId)}>
        <span className={`${styles.dot} ${r.state === "running" ? styles.dotRunning : styles.dotDone}`}>
          {r.state === "done" ? "✓" : r.state === "running" ? "●" : "○"}
        </span>
        <span className={styles.rowMain}>
          <span className={styles.rowLabel}>{r.label ?? r.agentId}</span>
          <span className={styles.rowResult}>{r.lastToolName ? `${r.lastToolName} · ` : ""}{r.lastToolSummary ?? r.resultPreview}</span>
          {r.phase && <span className={styles.faint}>{r.phase}</span>}
        </span>
        <span className={styles.rowMeta}>
          {r.agentType && <span className={styles.typeChip}>{r.agentType}</span>}
          <span>{r.state}</span>{r.model && <span>{r.model}</span>}
          {r.tokens !== undefined && <span>{fmtTokens(r.tokens)} tok</span>}
          {r.durationMs !== undefined && <span>{fmtDurationSec(r.durationMs)}</span>}
          {r.toolCalls !== undefined && <span>{r.toolCalls} tools</span>}
          {r.relTime && <span className={styles.faint}>{r.relTime}</span>}
        </span>
      </button>)}
      {rows.length === 0 && <div className={styles.note}>No inner agents have been reported yet.</div>}
    </div>}
    {(native || selected) ? <div className={styles.drill}>
      {selected && <div className={styles.drillHead}>
        <strong className={styles.drillTitle}>{selected.label ?? selected.agentId}</strong>
        <span>{selected.state}</span><span className={styles.spacer} />
        <button type="button" className={styles.closeBtn} onClick={() => setSelectedInner(null)}>close ✕</button>
      </div>}
      <Activity activity={data.activity} />
      <Transcript lines={data.transcript} />
    </div> : <div className={styles.drillHint}>Select an agent to inspect its tool calls and transcript.</div>}
    {data.narratorLines.length > 0 && <details className={styles.logs}><summary>Workflow log</summary><pre>{data.narratorLines.join("\n")}</pre></details>}
  </div>;
}
