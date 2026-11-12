import { useState, type ReactNode } from "react";
import type { AgentView, UiState } from "@chimera/ui-state";
import { useStore } from "../state/useStore";
import { derivedState, displayName, fmtDurationSec, fmtTokens, shadowParent, stateVisual } from "../state/selectors";
import { attachedWorkflowDotState, isAttachedWorkflowShadow } from "./AgentList";
import { AgentWorkflowInspect } from "./AgentWorkflowInspect";
import { Panel } from "./Panel";
import { WorkflowStepDots } from "./WorkflowStepDots";
import styles from "./AgentShadowPane.module.css";

const toneClass: Record<string, string> = {
  success: styles.toneSuccess!,
  info: styles.toneInfo!,
  warn: styles.toneWarn!,
  danger: styles.toneDanger!,
  muted: styles.toneMuted!,
};

export function AgentShadowPane({ agent, children }: { agent: AgentView; children?: ReactNode }) {
  const [showTranscript, setShowTranscript] = useState(false);
  // Narrow selector (review finding 6 — no whole-state subscription):
  // shadowParent returns an EXISTING AgentView reference (or null), never a
  // fresh object, so it satisfies useStore's referential-stability contract
  // and this pane re-renders only when the resolved parent record changes.
  const parent = useStore((s: UiState) => shadowParent(s, agent.agentId));
  const info = agent.shadowInfo;
  const st = derivedState(agent);
  const visual = stateVisual(st);
  const stateLabel = agent.pendingQuestion ? "waiting on question" : st;
  const name = displayName(agent);
  const isWorkflow = isAttachedWorkflowShadow(agent);
  return (
    <Panel
      label={
        <>
          shadow <span className={styles.faint}>· {name}</span>
        </>
      }
      className={styles.pane}
    >
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.name}>{name}</span>
          <span className={styles.sub}>
            shadow of {parent ? displayName(parent) : "?"} · {isWorkflow ? "attached workflow" : info?.subagentType ? "native sub-agent" : "native task"}
          </span>
          <span className={styles.spacer} />
          <span className={`${styles.state} ${toneClass[visual.tone] ?? ""}`}>
            {visual.glyph} {stateLabel}
          </span>
        </div>
        <div className={styles.chipRow}>
          {info?.subagentType && <span className={styles.chip}>{info.subagentType}</span>}
          {info?.totalTokens !== undefined && <span className={styles.chip}>{fmtTokens(info.totalTokens)} tok</span>}
          {info?.toolUses !== undefined && <span className={styles.chip}>{info.toolUses} tool uses</span>}
          {info?.durationMs !== undefined && <span className={styles.chip}>{fmtDurationSec(info.durationMs)}</span>}
          {info?.lastToolName && <span className={styles.faint}>last tool: {info.lastToolName}</span>}
        </div>
      </div>
      {children && <div className={styles.chipRow}>
        <button type="button" aria-pressed={!showTranscript} onClick={() => setShowTranscript(false)}>Activity</button>
        <button type="button" aria-pressed={showTranscript} onClick={() => setShowTranscript(true)}>Live transcript</button>
      </div>}
      {showTranscript ? children : <div className={`${styles.body} ${styles.bodyFill}`}>
        {isWorkflow ? (
          <div className={styles.workflowBadge}>
            <span className={styles.workflowGlyph} title="attached workflow">⧉</span>
            <span className={styles.workflowName}>{info!.workflowName}</span>
            <WorkflowStepDots steps={[attachedWorkflowDotState(agent.state)]} />
          </div>
        ) : null}
        {info?.description ? (
          <div>
            <span className={styles.sectionLabel}>TASK</span>
            <div className={styles.task}>{info.description}</div>
          </div>
        ) : null}
        {info?.summary ? (
          <div>
            <span className={styles.sectionLabel}>SUMMARY</span>
            <div className={styles.summary}>{info.summary}</div>
          </div>
        ) : null}
        {info?.error ? (
          <div>
            <span className={styles.sectionLabel}>ERROR</span>
            <div className={styles.error}>{info.error}</div>
          </div>
        ) : null}
        <AgentWorkflowInspect key={agent.agentId} agent={agent} />
      </div>}
    </Panel>
  );
}
