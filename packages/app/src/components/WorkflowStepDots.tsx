import type { WorkflowDotState } from "../state/selectors.workflows";
import styles from "./WorkflowStepDots.module.css";

// W20 — the AgentList step indicator for a workflow-bound task: N dots (one
// per workflow step), done steps solid green, the running step pulsing
// green, a failed gate red, an approval gate awaiting its owner amber. Pure
// presentational — selectors.workflows.workflowStepDots does all the state
// derivation; this component only maps states to dots + an aria-label.

const DOT_CLASS: Record<WorkflowDotState, string> = {
  done: styles.dotDone!,
  current: styles.dotCurrent!,
  failed: styles.dotFailed!,
  waiting: styles.dotWaiting!,
  pending: styles.dotPending!,
};

/** "step 2/4 running" / "step 4/4 done" / "step 1/3 failed" / "step 2/2 waiting". */
function stepDotsLabel(steps: WorkflowDotState[]): string {
  const total = steps.length;
  if (steps.every((s) => s === "done")) return `step ${total}/${total} done`;
  const activeIndex = steps.findIndex((s) => s === "failed" || s === "waiting" || s === "current");
  const at = activeIndex === -1 ? 1 : activeIndex + 1;
  const word = steps[activeIndex] === "failed" ? "failed" : steps[activeIndex] === "waiting" ? "waiting" : "running";
  return `step ${at}/${total} ${word}`;
}

export function WorkflowStepDots({ steps }: { steps: WorkflowDotState[] }) {
  if (steps.length === 0) return null;
  return (
    <span className={styles.dots} aria-label={stepDotsLabel(steps)} data-workflow-step-dots>
      {steps.map((s, i) => (
        <span key={i} className={`${styles.dot} ${DOT_CLASS[s]}`} />
      ))}
    </span>
  );
}
