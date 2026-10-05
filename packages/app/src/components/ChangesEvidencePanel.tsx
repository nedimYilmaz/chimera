import { WorkingTreeDisclosure } from "./WorkingTreePanel";
import type { TaskEvidence } from "@chimera/protocol";
import { evidenceFileStatusGlyph, evidenceProvenanceLine, evidenceStepLine } from "../state/selectors.evidence";
import styles from "./ChangesEvidencePanel.module.css";

// FEATURE-10 (Changes & Evidence Review): the in-place expansion off TaskInspector
// (opened via its "changes & evidence" affordance) — steps[] (gate/outcome evidence),
// provenance[] (branch → diff → merge commit), and artifacts are shown by the CALLER
// (TaskInspector already has its own artifacts row; this panel doesn't duplicate it).
// Loading/error render inline text, matching AgentDetailPanel's own "loading…" convention
// (no spinner component exists elsewhere in this codebase to reuse).
export function ChangesEvidencePanel({
  evidence,
  loading,
  error,
}: {
  evidence: TaskEvidence | null;
  loading: boolean;
  error: string | null;
}) {
  if (error) {
    return (
      <div className={styles.panel} data-evidence-panel>
        <span className={styles.error}>evidence fetch failed: {error}</span>
      </div>
    );
  }
  if (loading || !evidence) {
    return (
      <div className={styles.panel} data-evidence-panel>
        <span className={styles.hint}>loading…</span>
      </div>
    );
  }
  return (
    <div className={styles.panel} data-evidence-panel>
      {evidence.steps.length > 0 && (
        <div className={styles.section}>
          <span className={styles.sectionLabel}>steps</span>
          <div className={styles.stepList}>
            {evidence.steps.map((step, i) => (
              <span key={`${step.stepId}-${i}`} className={step.outcome === "failed" ? styles.stepFail : undefined} data-evidence-step={step.stepId}>
                {evidenceStepLine(step)}
                {step.outcome === "failed" && step.reason ? ` — ${step.reason}` : ""}
              </span>
            ))}
          </div>
        </div>
      )}
      {evidence.provenance.length === 0 ? (
        <span className={styles.hint}>no provenance available (task never picked up an isolated worktree)</span>
      ) : (
        evidence.provenance.map((entry) => (
          <div className={styles.section} key={entry.worktreeKey} data-evidence-provenance={entry.worktreeKey}>
            <span className={styles.sectionLabel}>{evidenceProvenanceLine(entry)}</span>
            {entry.agentIds.length > 0 && <WorkingTreeDisclosure target={{ agentId: entry.agentIds[entry.agentIds.length - 1]! }} taskId={evidence.taskId} />}
            {entry.diff.available && entry.diff.files.length > 0 && (
              <div className={styles.fileList}>
                {entry.diff.files.map((f) => (
                  <span key={f.path} className={styles.fileRow} data-evidence-file={f.path}>
                    <span className={styles.fileGlyph}>{evidenceFileStatusGlyph(f.status)}</span> {f.path}
                    <span className={styles.filePlus}> +{f.insertions}</span> <span className={styles.fileMinus}>−{f.deletions}</span>
                  </span>
                ))}
              </div>
            )}
            {entry.diff.available && entry.diff.truncated && <span className={styles.hint}>diff stat truncated</span>}
          </div>
        ))
      )}
    </div>
  );
}
