import { useState } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import {
  ARTIFACT_KINDS,
  buildWorkflowPatch,
  buildWorkflowSpec,
  defaultWorkflowFormValues,
  emptyWorkflowStep,
  GATE_KINDS,
  validateWorkflowForm,
  type GateKind,
  type WorkflowFormValues,
  type WorkflowStepFormValues,
} from "../state/selectors.workflows";
import styles from "./WorkflowFormCard.module.css";

// W18 (F16 task workflows) — create/edit a versioned workflow (mock `w` in
// queues → WorkflowCard's "n new"/"e edit" chips open this): OverlayCard
// center 680. name* (locked once editing — workflow.update can't rename) /
// onFail (halt|retry) / retryLimit, then a repeatable step list — each step
// title* + an auto-derived id + a GATE-KIND CHIP ROW (command/artifact/
// approval/none, the F15 chip-selector pattern) with the kind's own field(s).
// Create mode offers "bind to queue X" (checked by default when opened from
// that queue's context) since queue.update{workflow} is otherwise the only
// way to make a created workflow reachable at all. esc cancels, the opener
// key (`w`) re-toggles at the call site (QueuesScreen).

export function WorkflowFormCard({ initial, bindQueue, onSubmit, onClose }: {
  /** Present in edit mode (name is then read-only); absent for create. */
  initial?: WorkflowFormValues;
  /** The queue this form was opened from — create mode offers to bind the new
   * workflow to it as that queue's default. */
  bindQueue?: string | null;
  onSubmit: (spec: Record<string, unknown> | { patch: Record<string, unknown> }, bind: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const editing = initial !== undefined;
  const [values, setValues] = useState<WorkflowFormValues>(initial ?? defaultWorkflowFormValues());
  const [bind, setBind] = useState(!editing && !!bindQueue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setField = <K extends keyof WorkflowFormValues>(key: K, v: WorkflowFormValues[K]): void => {
    setValues((s) => ({ ...s, [key]: v }));
    if (error) setError(null);
  };

  const setStep = (i: number, patch: Partial<WorkflowStepFormValues>): void => {
    setValues((s) => ({ ...s, steps: s.steps.map((st, idx) => (idx === i ? { ...st, ...patch } : st)) }));
    if (error) setError(null);
  };

  const addStep = (): void => setValues((s) => ({ ...s, steps: [...s.steps, emptyWorkflowStep()] }));
  const removeStep = (i: number): void => setValues((s) => ({ ...s, steps: s.steps.filter((_, idx) => idx !== i) }));

  const submit = (): void => {
    if (busy) return;
    const invalid = validateWorkflowForm(values);
    if (invalid) { setError(invalid); return; }
    const payload = editing ? { patch: buildWorkflowPatch(values) } : buildWorkflowSpec(values);
    setBusy(true);
    void onSubmit(payload, bind).then(onClose).catch((err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err));
    });
  };

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); submit(); return; }
    if (ev.key.toLowerCase() === "w" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); onClose(); }
  };

  const gateFields = (i: number, step: WorkflowStepFormValues) => {
    switch (step.gateKind) {
      case "command":
        return (
          <>
            <div className={styles.pair}>
              <div className={styles.field}>
                <span className={styles.label}>command</span>
                <input className={styles.input} value={step.command} placeholder="npm" onChange={(e) => setStep(i, { command: e.target.value })} />
              </div>
              <div className={styles.field}>
                <span className={styles.label}>args</span>
                <input className={styles.input} value={step.args} placeholder="test --ci" onChange={(e) => setStep(i, { args: e.target.value })} />
              </div>
            </div>
            <div className={styles.field}>
              <span className={styles.label}>timeout ms</span>
              <input
                className={styles.input}
                value={step.timeoutMs}
                placeholder="optional, 1000–600000 (default 120000)"
                onChange={(e) => setStep(i, { timeoutMs: e.target.value })}
                data-field={`step-${i}-timeout`}
              />
            </div>
          </>
        );
      case "artifact":
        return (
          <>
            <div className={styles.field}>
              <span className={styles.label}>artifact id</span>
              <input className={styles.input} value={step.artifactId} placeholder="optional" onChange={(e) => setStep(i, { artifactId: e.target.value })} />
            </div>
            <div className={styles.pair}>
              <div className={styles.field}>
                <span className={styles.label}>scope</span>
                <div className={styles.inlineChipRow}>
                  {(["task", "step"] as const).map((sc) => (
                    <span
                      key={sc}
                      className={step.artifactScope === sc ? styles.gateChipActive : styles.gateChip}
                      onClick={() => setStep(i, { artifactScope: sc })}
                      role="button"
                      tabIndex={0}
                      data-artifact-scope={sc}
                    >
                      {sc}
                    </span>
                  ))}
                </div>
              </div>
              <div className={styles.field}>
                <span className={styles.label}>kind</span>
                <select
                  className={styles.select}
                  value={step.artifactKind}
                  onChange={(e) => setStep(i, { artifactKind: e.target.value })}
                  data-field={`step-${i}-artifact-kind`}
                >
                  <option value="">any</option>
                  {ARTIFACT_KINDS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </div>
            </div>
          </>
        );
      case "approval":
        return (
          <div className={styles.field}>
            <span className={styles.label}>prompt</span>
            <input className={styles.input} value={step.approvalPrompt} placeholder="ship it?" onChange={(e) => setStep(i, { approvalPrompt: e.target.value })} />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <OverlayCard width={680} align="center" onClose={onClose}>
      <div onKeyDown={onKeyDown}>
        <OverlayCardHeader
          title={editing ? `edit workflow · ${values.name}` : "new workflow"}
          hint={error ? <span className={styles.error}>{error}</span> : "esc cancel"}
        />
        <div className={styles.fields}>
          <div className={styles.field}>
            <span className={styles.label}>name</span>
            <input
              className={styles.input}
              value={values.name}
              disabled={editing}
              placeholder="release-flow"
              onChange={(e) => setField("name", e.target.value)}
              data-field="name"
            />
          </div>
          <div className={styles.pair}>
            <div className={styles.field}>
              <span className={styles.label}>on fail</span>
              <select className={styles.select} value={values.onFail} onChange={(e) => setField("onFail", e.target.value as "halt" | "retry")}>
                <option value="halt">halt</option>
                <option value="retry">retry</option>
              </select>
            </div>
            <div className={styles.field}>
              <span className={styles.label}>retry limit</span>
              <input className={styles.input} value={values.retryLimit} onChange={(e) => setField("retryLimit", e.target.value)} />
            </div>
          </div>
          {!editing && bindQueue && (
            <div className={styles.checkboxRow}>
              <input type="checkbox" checked={bind} onChange={(e) => setBind(e.target.checked)} id="workflow-bind" />
              <label htmlFor="workflow-bind">bind to queue {bindQueue} (its new default)</label>
            </div>
          )}
          <div className={styles.stepsHead}>steps</div>
          {values.steps.map((step, i) => (
            <div className={styles.stepBlock} key={i}>
              <div className={styles.stepHeadRow}>
                <span className={styles.stepIndex}>{i + 1}</span>
                <input
                  className={styles.input}
                  value={step.title}
                  placeholder="step title"
                  onChange={(e) => setStep(i, { title: e.target.value })}
                  data-field={`step-${i}-title`}
                />
                <input
                  className={styles.input}
                  value={step.role}
                  placeholder="role — optional, runs this step"
                  onChange={(e) => setStep(i, { role: e.target.value })}
                  data-field={`step-${i}-role`}
                />
                {values.steps.length > 1 && (
                  <span className={styles.removeChip} onClick={() => removeStep(i)} role="button" tabIndex={0}>×</span>
                )}
              </div>
              <div className={styles.field}>
                <span className={styles.label}>context</span>
                <div className={styles.inlineChipRow}>
                  {(["handoff", "none"] as const).map((c) => (
                    <span
                      key={c}
                      className={step.context === c ? styles.gateChipActive : styles.gateChip}
                      onClick={() => setStep(i, { context: c })}
                      role="button"
                      tabIndex={0}
                      data-step-context={c}
                    >
                      {c === "handoff" ? "handoff" : "clean"}
                    </span>
                  ))}
                </div>
              </div>
              <div className={styles.gateChipRow}>
                {GATE_KINDS.map((k: GateKind) => (
                  <span
                    key={k}
                    className={step.gateKind === k ? styles.gateChipActive : styles.gateChip}
                    onClick={() => setStep(i, { gateKind: k })}
                    role="button"
                    tabIndex={0}
                    data-gate-kind={k}
                  >
                    {k}
                  </span>
                ))}
              </div>
              {gateFields(i, step)}
              <div className={styles.pair}>
                <div className={styles.field}>
                  <span className={styles.label}>on fail</span>
                  <select
                    className={styles.select}
                    value={step.onFail}
                    onChange={(e) => setStep(i, { onFail: e.target.value as WorkflowStepFormValues["onFail"] })}
                    data-field={`step-${i}-onfail`}
                  >
                    <option value="">inherit ({values.onFail})</option>
                    <option value="halt">halt</option>
                    <option value="retry">retry</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <span className={styles.label}>retry limit</span>
                  <input
                    className={styles.input}
                    value={step.retryLimit}
                    placeholder={`inherit (${values.retryLimit || "0"})`}
                    onChange={(e) => setStep(i, { retryLimit: e.target.value })}
                    data-field={`step-${i}-retrylimit`}
                  />
                </div>
              </div>
              <div className={styles.field}>
                <span className={styles.label}>instructions</span>
                <textarea
                  className={styles.textarea}
                  value={step.instructions}
                  placeholder="optional — shown to the agent on this step"
                  onChange={(e) => setStep(i, { instructions: e.target.value })}
                  data-field={`step-${i}-instructions`}
                />
              </div>
            </div>
          ))}
          <span className={styles.addStepChip} onClick={addStep} role="button" tabIndex={0}>+ add step</span>
        </div>
        <div className={styles.footer}>
          <span className={styles.submitChip} onClick={submit} data-workflow-submit>
            <span className={styles.submitKey}>{editing ? "save" : "create"}</span>
          </span>
          <span className={styles.cancelChip} onClick={onClose}>esc cancel</span>
        </div>
      </div>
    </OverlayCard>
  );
}
