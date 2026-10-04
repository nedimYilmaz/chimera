import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { ENGINE_PARITY_NOTE, type WorkflowRow } from "../state/selectors.workflows";
import styles from "./WorkflowCard.module.css";

// W18 (F16 task workflows) — the READ-ONLY bound-workflow view (mock
// `?screen=queues&showWorkflow=1`: steps · gate states · ● enforced badge ·
// engine-parity note), opened by `w` on a selected queue. Shows the queue's
// CURRENT default binding (queue.spec.workflow) resolved against the loaded
// workflow registry; "n new"/"e edit" hand off to WorkflowFormCard. esc
// closes, `w` re-toggles at the call site (QueuesScreen).
//
// F16.1 Phase 3 (WF-10): a step with a `role` set (WF-8 step-role switch)
// shows an "@role" chip next to its title — the multi-agent equivalent of
// the single-agent card's implicit "whoever's bound runs every step".
//
// QUEUE-WORKFLOW-OVERLAY-BLIND: `workflow` is ONLY the queue's default binding
// (queue.spec.workflow). A task can carry its own binding instead — queue.push's
// per-task `workflow` override, which pins {name,version} onto the TaskRecord — and
// that path never touches the queue spec. So a queue whose every task was pushed
// with an override read "no workflow bound to this queue" while the operator was
// watching those workflows run in the same pane, one keystroke away
// (`inspect workflow graph` on a task opens the Studio on exactly that workflow).
// The overlay now reports what is actually IN EFFECT, and says WHERE it is bound.

export function WorkflowCard({ queueName, workflow, taskBound = [], onNew, onEdit, onDelete, onOpenStudio, onClose }: {
  queueName: string;
  /** null: the queue has no DEFAULT workflow binding (a task may still carry its own). */
  workflow: WorkflowRow | null;
  /** QUEUE-WORKFLOW-OVERLAY-BLIND: distinct per-task bindings currently live in this queue,
   *  with how many tasks carry each. Empty when no task overrides the queue default. */
  taskBound?: ReadonlyArray<{ name: string; version: number; taskCount: number }>;
  onNew: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenStudio?: () => void;
  onClose: () => void;
}) {
  return (
    <OverlayCard width={620} align="center" onClose={onClose}>
      <OverlayCardHeader
        title={workflow ? `workflow · ${workflow.name}` : "workflow"}
        meta={workflow ? `v${workflow.version} → ${queueName}` : `→ ${queueName}`}
        hint="esc close"
      />
      <div className={styles.body}>
        {workflow === null ? (
          taskBound.length === 0 ? (
            <div className={styles.empty}>no workflow bound to this queue.</div>
          ) : (
            <>
              <div className={styles.empty}>
                no queue DEFAULT binding — but {taskBound.reduce((n, b) => n + b.taskCount, 0)} task
                {taskBound.reduce((n, b) => n + b.taskCount, 0) === 1 ? "" : "s"} in this queue carry their own,
                pinned when they were pushed. Setting a default here would apply to FUTURE tasks only;
                the ones below keep the version they were pinned to.
              </div>
              <div className={styles.chipRow} data-task-bound-workflows>
                {taskBound.map((b) => (
                  <span className={styles.chip} key={`${b.name}@${b.version}`} data-task-bound-workflow={b.name}>
                    {b.name} v{b.version} · {b.taskCount} task{b.taskCount === 1 ? "" : "s"}
                  </span>
                ))}
              </div>
            </>
          )
        ) : (
          <>
            <div className={styles.chipRow}>
              <span className={styles.enforcedChip}>● enforced</span>
              <span className={styles.chip}>{workflow.steps.length} steps</span>
              <span className={styles.chip}>on fail {workflow.onFail}</span>
              {workflow.onFail === "retry" && <span className={styles.chip}>retry limit {workflow.retryLimit}</span>}
            </div>
            {workflow.steps.map((step, i) => (
              <div className={styles.stepRow} key={step.id || i}>
                <span className={styles.stepIndex}>{i + 1}</span>
                <div className={styles.stepMain}>
                  <div className={styles.stepHeadRow}>
                    <span className={styles.stepTitle}>{step.title}</span>
                    {step.role && <span className={styles.roleChip} data-step-role={step.role}>@{step.role}</span>}
                    <span className={styles.stepGate}>{step.gateLabel}</span>
                  </div>
                  {step.instructions && <div className={styles.stepInstructions}>{step.instructions}</div>}
                </div>
              </div>
            ))}
          </>
        )}
        <div className={styles.note}>{ENGINE_PARITY_NOTE}</div>
      </div>
      <div className={styles.footer}>
        {workflow !== null && <span className={styles.actionChip} onClick={onOpenStudio} data-action="open-studio">g open studio</span>}
        <span className={styles.actionChip} onClick={onNew} data-action="new-workflow">n new</span>
        {workflow !== null && <span className={styles.actionChip} onClick={onEdit} data-action="edit-workflow">e edit</span>}
        {workflow !== null && <span className={styles.dangerChip} onClick={onDelete} data-action="delete-workflow">d delete</span>}
        <span className={styles.cancelChip} onClick={onClose}>esc close</span>
      </div>
    </OverlayCard>
  );
}
