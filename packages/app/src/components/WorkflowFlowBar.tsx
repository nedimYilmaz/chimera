import { useEffect, useRef } from "react";
import type { AgentView } from "@chimera/ui-state";
import { conductorLabel, fmtDuration } from "../state/selectors";
import type { WorkflowFlowBarStep, WorkflowFlowBarView } from "../state/selectors.workflows";
import styles from "./WorkflowFlowBar.module.css";

// WORKFLOW-UI-1 — a pinned, animated step-timeline bar rendered above the
// stitched transcript's scroll body (StitchedTranscriptPanel), the ONLY
// workflow-specific chrome addition: a normal (non-workflow) agent's
// TranscriptPanel renders no such bar. Pure presentational over
// workflowFlowBarView's STORE-FREE view model — agentId -> display name
// resolution happens here via conductorLabel, same as every other component
// that reads `agents`.

const STATE_GLYPH: Record<WorkflowFlowBarStep["state"], string> = {
  done: "✓",
  current: "◐",
  failed: "✗",
  waiting: "◐",
  pending: "○",
};

const STATE_CLASS: Record<WorkflowFlowBarStep["state"], string> = {
  done: styles.stepDone,
  current: styles.stepCurrent,
  failed: styles.stepFailed,
  waiting: styles.stepWaiting,
  pending: styles.stepPending,
};

export function WorkflowFlowBar({
  view,
  agents,
  onStepClick,
}: {
  view: WorkflowFlowBarView;
  agents: Record<string, AgentView>;
  onStepClick?: (agentId: string) => void;
}) {
  const activeIndex = view.steps.findIndex((s) => s.state === "current" || s.state === "waiting" || s.state === "failed");
  const activeStepRef = useRef<HTMLDivElement | null>(null);
  // Keep the active step in view whenever it changes (including first mount)
  // — the strip scrolls horizontally instead of growing downward (see
  // .timeline's overflow-x), so a workflow with many steps can otherwise
  // scroll the active one out of sight. "nearest" is a no-op when it's
  // already visible, so this never jitters an already-in-view step.
  useEffect(() => {
    activeStepRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeIndex]);
  const handoffs = view.steps
    .map((step, i) => ({ step, i }))
    .filter(({ step, i }) => step.isHandoffBoundary && i > 0)
    .map(({ step, i }) => {
      const agentName = step.agentId ? conductorLabel(agents, step.agentId) : null;
      const prevAgentName = view.steps[i - 1]!.agentId ? conductorLabel(agents, view.steps[i - 1]!.agentId!) : null;
      return {
        i,
        text: `handed step ${i + 1} → @${agentName ?? "—"} · worktree carried over · @${prevAgentName ?? "—"} released`,
      };
    });
  return (
    <div className={styles.bar} data-workflow-flow-bar>
      <div className={styles.badge}>
        <span>{view.name} v{view.version}</span>
        <span className={styles.enforced}>⛨ enforced</span>
      </div>
      <div className={styles.timeline}>
        {view.steps.map((step, i) => {
          const agentName = step.agentId ? conductorLabel(agents, step.agentId) : null;
          const clickable = !!step.agentId && !!onStepClick;
          const duration = fmtDuration(step.durationMs);
          return (
            <div key={i} className={styles.stepRow}>
              <div
                ref={i === activeIndex ? activeStepRef : undefined}
                className={[styles.step, STATE_CLASS[step.state]].join(" ")}
                data-workflow-flow-step={i}
                data-step-state={step.state}
                onClick={clickable ? () => onStepClick!(step.agentId!) : undefined}
                style={clickable ? { cursor: "pointer" } : undefined}
              >
                <div className={styles.head}>
                  <span key={`${i}-${step.state}`} className={styles.glyph}>
                    {STATE_GLYPH[step.state]}
                  </span>
                  <span className={styles.title}>{step.title}</span>
                </div>
                {duration ? <span className={styles.duration}>{duration}</span> : null}
                {agentName ? <span className={styles.agent}>@{agentName}</span> : null}
                {i === activeIndex ? <span key={activeIndex} className={styles.activeMarker} /> : null}
              </div>
              {i < view.steps.length - 1 ? <span className={styles.arrow}>→</span> : null}
            </div>
          );
        })}
      </div>
      {handoffs.length > 0 ? (
        <div className={styles.transitions}>
          {handoffs.map(({ i, text }) => (
            <div key={i} className={styles.transitionRow} data-handoff-boundary={i} title={text}>
              {text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
