import { useState } from "react";
import type { AgentView } from "@chimera/ui-state";
import { foldInnerAgents } from "../state/workflowInspect";
import { useWorkflowInspect } from "../state/useWorkflowInspect";
import styles from "./AgentWorkflowInspect.module.css";

// SHADOW-WORKFLOW-VISIBILITY (cockpit, primary UI): the live inner-agent inspector shown in place
// of the old "the shadow has no transcript of its own" note for a WORKFLOW shadow. Left/top: the
// inner-agent roster (label / type / state / result preview), polled from shadow.workflowInspect.
// Click a row to drill into that inner agent's transcript tail. Degrades to a reason line when the
// workflow's transcript dir hasn't been reported yet or is gone.

const roleClass: Record<string, string> = {
  user: styles.roleUser!,
  assistant: styles.roleAssistant!,
  tool: styles.roleTool!,
  system: styles.roleSystem!,
};

export function AgentWorkflowInspect({ agent }: { agent: AgentView }) {
  // A drill-down belongs to one workflow, never to the next selected shadow.
  return <WorkflowInspectBody key={agent.agentId} agent={agent} />;
}

function WorkflowInspectBody({ agent }: { agent: AgentView }) {
  const [selectedInner, setSelectedInner] = useState<string | null>(null);
  const { data, error, loading } = useWorkflowInspect(agent.agentId, selectedInner);

  // Degrade path: no data yet, or the daemon reported the workflow unavailable. Keep the historic
  // note and append the concrete reason so the operator knows WHY the pane is empty.
  if (!data || !data.available) {
    const reason = data?.reason ?? error ?? (loading ? "loading workflow activity…" : null);
    return (
      <div className={styles.wrap}>
        <div className={styles.note}>
          the workflow runs its inner agents as separate processes — their activity is read on
          demand from the run&apos;s transcript directory.
          {reason ? <div className={styles.reason}>{reason}</div> : null}
        </div>
      </div>
    );
  }

  const nowMs = Date.now();
  const rows = foldInnerAgents(data.agents, nowMs);
  const running = rows.filter((r) => r.state === "running").length;
  const selected = selectedInner ? rows.find((r) => r.agentId === selectedInner) ?? null : null;

  return (
    <div className={styles.wrap}>
      <div className={styles.metaRow}>
        {data.runId ? <span className={styles.runId}>{data.runId}</span> : null}
        <span>{rows.length} inner {rows.length === 1 ? "agent" : "agents"}</span>
        {running > 0 ? <span className={styles.runningPill}>{running} running</span> : null}
        <span className={styles.spacer} />
        {loading ? <span className={styles.faint}>refreshing…</span> : null}
      </div>

      {rows.length === 0 ? (
        <div className={styles.note}>no inner agents have started yet.</div>
      ) : (
        <div className={styles.roster}>
          {rows.map((r) => {
            const isSel = r.agentId === selectedInner;
            return (
              <button
                key={r.agentId}
                type="button"
                className={`${styles.row} ${isSel ? styles.rowSelected : ""}`}
                onClick={() => setSelectedInner(isSel ? null : r.agentId)}
                title={`drill into ${r.agentId}`}
              >
                <span className={`${styles.dot} ${r.state === "running" ? styles.dotRunning : styles.dotDone}`}>
                  {r.state === "running" ? "●" : "✓"}
                </span>
                <span className={styles.rowMain}>
                  <span className={styles.rowLabel}>{r.label ?? r.agentId}</span>
                  {r.resultPreview ? <span className={styles.rowResult}>{r.resultPreview}</span> : null}
                </span>
                <span className={styles.rowMeta}>
                  {r.agentType ? <span className={styles.typeChip}>{r.agentType}</span> : null}
                  {r.relTime ? <span className={styles.faint}>{r.relTime}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {selected ? (
        <div className={styles.drill}>
          <div className={styles.drillHead}>
            <span className={styles.drillTitle}>{selected.label ?? selected.agentId}</span>
            <span className={styles.faint}>{selected.agentType ?? "agent"}</span>
            <span className={styles.spacer} />
            <button type="button" className={styles.closeBtn} onClick={() => setSelectedInner(null)}>
              close ✕
            </button>
          </div>
          <div className={styles.transcript}>
            {data.transcript && data.transcript.length > 0 ? (
              data.transcript.map((line, i) => (
                <div key={i} className={styles.line}>
                  <span className={`${styles.role} ${roleClass[line.role] ?? ""}`}>{line.role}</span>
                  <span className={styles.lineText}>{line.text}</span>
                </div>
              ))
            ) : (
              <div className={styles.faint}>no transcript for this inner agent yet.</div>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.drillHint}>select an inner agent to view its transcript</div>
      )}
    </div>
  );
}
