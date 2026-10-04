import type { AgentView, UiState } from "@chimera/ui-state";
import { useStore } from "../state/useStore";
import { derivedState, displayName, fmtDurationSec, fmtTokens, shadowParent, stateVisual } from "../state/selectors";
import { attachedWorkflowDotState, isAttachedWorkflowShadow } from "./AgentList";
import { AgentWorkflowInspect } from "./AgentWorkflowInspect";
import { Panel } from "./Panel";
import { WorkflowStepDots } from "./WorkflowStepDots";
import styles from "./AgentShadowPane.module.css";

// W3 — the right-pane alternate for a selected SHADOW row (mock rv_shadow):
// a native sub-agent has no transcript of its own, so the pane renders its
// live shadowInfo (task / summary / metrics) instead. Read-only.
//
// R2 (inline sub-agent/workflow surfacing): this pane is now ONLY rendered when the shadow has
// no captured transcript yet (AgentsScreen.tsx routes a shadow WITH one to the normal
// TranscriptPanel instead) — so the closing "no transcript" note below stays accurate without a
// conditional. item 2's rich card: a subagentType chip states plainly what kind of sub-agent this
// is. item 3's attached-workflow view: a distinct header section (glyph + name + a single live
// WorkflowStepDots dot — there's no discrete step list for an inline SDK workflow, see PLAN.md
// §0/§8) for a shadow carrying shadowInfo.workflowName instead of subagentType.

const toneClass: Record<string, string> = {
  success: styles.toneSuccess!,
  info: styles.toneInfo!,
  warn: styles.toneWarn!,
  danger: styles.toneDanger!,
  muted: styles.toneMuted!,
};

export function AgentShadowPane({ agent }: { agent: AgentView }) {
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
            shadow of {parent ? displayName(parent) : "?"} · {isWorkflow ? "attached workflow" : "native sub-agent"}
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
      <div className={`${styles.body} ${isWorkflow ? styles.bodyFill : ""}`}>
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
        {isWorkflow ? (
          // SHADOW-WORKFLOW-VISIBILITY: a workflow shadow gets the live inner-agent inspector in
          // place of the static "no transcript" note — the workflow's inner agents run as separate
          // processes, so their activity is read on demand from the run's transcript dir. Keyed on
          // agentId so switching directly between two workflow shadows REMOUNTS it — resetting the
          // drill-down selection and the polled snapshot, so workflow A's roster/transcript never
          // flashes for a tick under freshly-selected workflow B (the pane is rendered unkeyed).
          <AgentWorkflowInspect key={agent.agentId} agent={agent} />
        ) : (
          <div className={styles.note}>
            the shadow has no transcript of its own — its events log into the parent as{" "}
            <span className={styles.info}>↩</span> · enter → parent transcript · a → answer the question
          </div>
        )}
      </div>
      {isWorkflow ? null : <div className={styles.spacerV} />}
    </Panel>
  );
}
