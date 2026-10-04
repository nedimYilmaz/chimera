import { useState, type ReactNode } from "react";
import type { TaskEvidence } from "@chimera/protocol";
import { displayChord } from "../keymap";
import { fmtClock, fmtDuration, fmtDurationSec } from "../state/selectors";
import { policyLine, summarizeEventData, taskTiming, taskVersionRows, type DependencyRow, type TaskRowView } from "../state/selectors.coord";
import { relativeLabel } from "../state/selectors.jobs";
import { stepGateState, stepHistoryEntry, taskWorkflowBinding, type WorkflowRow } from "../state/selectors.workflows";
import type { ArtifactRow } from "../state/selectors.artifacts";
import { ArtifactChip } from "./ArtifactChip";
import { ChangesEvidencePanel } from "./ChangesEvidencePanel";
import styles from "./TaskInspector.module.css";

// W5 — the inline task inspector card the Queues detail renders UNDER the
// selected task row (mock s_queues 676-681): pushed by/at · priority · role /
// prompt / policy / hint rows. pushedBy/pushedAt were NEEDS-API; the daemon
// workstream (WD Stage 1) has landed both on TaskRecord — read defensively
// regardless: pushedBy null (a direct/human push) renders "—", an absent
// pushedAt falls back to createdAt (the protocol's documented reader rule),
// and a truly field-less older record renders "—" for both.
//
// W18 (F16 task workflows): when the task carries a workflow binding, a
// "workflow" row lists every step with its gate state (done/current/failed/
// pending) + the ts it was first reached (stepTimestamps, from the event
// ring — TaskRecord itself has no per-step history).
//
// F16.1 Phase 2 (WF-4/G4 protocol, WF-6 UI): each step also reads its LATEST
// TaskRecord.stepHistory entry (stepHistoryEntry) for the agent that actually
// ran it, its duration, and — on a failed step — the gate's failure reason.
// Clicking a reached step jumps to THAT step's agent (falling back to the
// task's current agentId only for the in-progress step, where stepHistory may
// not have closed yet) — precise per-step "jump to where it started", not the
// task-level approximation this used before. TranscriptPanel has no
// scroll-to-turn API to target more precisely than "open the agent" yet.
//
// F16.1 Phase 3 (WF-10): a step whose incoming boundary was a role switch
// (WF-8/WF-9) renders a dim "⇄ handoff" marker in place of the plain " · "
// separator before it — derived from EITHER the task_step_handoff event ring
// (stepHandoffs, precomputed by the caller like stepTimestamps) OR this
// step's stepHistory.handoffSummary (persisted, covers boundaries that have
// scrolled out of the ring).

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{children}</span>
    </div>
  );
}

const GATE_STATE_GLYPH: Record<string, string> = { done: "●", current: "◐", failed: "✗", pending: "○" };

export function TaskInspector({
  task,
  raw,
  retryLimit,
  team,
  library,
  pushedByLabel,
  workflow,
  stepTimestamps,
  stepHandoffs,
  onOpenAgent,
  artifacts,
  artifactDiffMeta,
  onOpenEvidence,
  evidenceOpen,
  evidence,
  evidenceLoading,
  evidenceError,
  onOpenWorkflowGraph,
  dependencies,
  onRetryTask,
}: {
  task: TaskRowView;
  raw: Record<string, unknown>;              // the raw task record (pushedBy/At live here)
  retryLimit: number;
  team: Record<string, unknown> | null;      // the team spec bound to this queue (policy derivation)
  /** FLAT-SHAPE-SWEEP: the role library (role.list) — policyLine needs it to resolve
   * the bound team's role BINDING to its effective cwd/permissionProfile (a binding's
   * own fields live under `overrides`/the library entry it references, not its raw
   * top-level fields). Undefined/empty degrades to the plain retry/team text, same as
   * an operator who hasn't opened Roles/Teams yet. */
  library?: ReadonlyArray<Record<string, unknown>>;
  /** Display mapping for raw.pushedBy (the screen maps a conductor id → "main",
   * others → short id); the raw id is the fallback. */
  pushedByLabel?: string | null;
  /** The resolved workflow definition this task is bound to (see
   * selectors.workflows.workflowFor) — undefined/null renders no steps row
   * (an ordinary, ungated task). */
  workflow?: WorkflowRow | null;
  /** stepIndex -> the ts it was first reached (selectors.workflows.
   * stepTimestamps over the event ring) — absent entries render no ts. */
  stepTimestamps?: Map<number, number>;
  /** F16.1 Phase 3 (WF-10): toStepIndex values the task_step_handoff event
   * ring shows a role-switch boundary landed on (selectors.workflows.
   * stepHandoffIndices) — undefined/absent falls back to per-step
   * stepHistory.handoffSummary alone. */
  stepHandoffs?: Set<number>;
  /** Step click → jump to the agent that ran THAT step (stepHistory-backed,
   * F16.1 Phase 2 WF-6 — replaces the earlier approximation of always jumping
   * to task.agentId, the task's CURRENT agent). Called with the step's
   * agentId. */
  onOpenAgent?: (agentId: string) => void;
  /** F17 (W19): this task's OWN artifacts (taskId-scoped — every agent that
   * touched this task, not just whichever one is currently bound to it).
   * Undefined/empty renders no artifacts row (an ordinary task with none). */
  artifacts?: ArtifactRow[];
  /** id -> ±line count, for any diff-kind row in `artifacts` (selectors.
   * artifacts.countDiffLines via commands.artifacts.useDiffMeta). */
  artifactDiffMeta?: Record<string, { plus: number; minus: number }>;
  /** FEATURE-10 (Changes & Evidence Review): toggles the in-place
   * ChangesEvidencePanel expansion below. Undefined renders no affordance
   * (the OWNING screen decides whether this task's evidence is fetchable —
   * mirrors onOpenAgent's optional-callback pattern). */
  onOpenEvidence?: () => void;
  /** Whether the evidence panel is CURRENTLY expanded for this task — the
   * screen owns this (like `selected` for the row itself), since only one
   * evidence.get fetch should be in flight per task at a time. */
  evidenceOpen?: boolean;
  /** FEATURE-10: the fetched evidence.get reply (commands.evidence.
   * useTaskEvidence), null while loading/unopened. */
  evidence?: TaskEvidence | null;
  evidenceLoading?: boolean;
  evidenceError?: string | null;
  onOpenWorkflowGraph?: () => void;
  /** QUEUE-REORDER: this task's dependencies resolved against its queue's live sibling tasks
   * (selectors.coord.dependencyRows) — shows what actually blocks it, not just a bare id list.
   * Undefined (the default) falls back to the old plain dependsOn-ids-joined-by-comma rendering
   * — a caller that doesn't have the sibling task list in hand still gets a sane row. */
  dependencies?: DependencyRow[];
  /** QUEUE-REORDER: recover a failed/dead_letter task by cloning it into a fresh pending task
   * (queue.retryTask) — undefined/omitted renders no affordance; the row only shows for a
   * terminal-with-error task (task.state failed/dead_letter), mirroring onOpenEvidence's
   * optional-callback convention. */
  onRetryTask?: () => void;
}) {
  const pushedBy = pushedByLabel ?? (typeof raw["pushedBy"] === "string" ? (raw["pushedBy"] as string) : null);
  const pushedAtMs =
    typeof raw["pushedAt"] === "number" ? (raw["pushedAt"] as number)
    : typeof raw["createdAt"] === "number" ? (raw["createdAt"] as number)
    : null;
  const pushedAt = pushedAtMs === null ? null : fmtClock(pushedAtMs);
  const timing = taskTiming(raw);
  const startedAt = timing.startedAt === null ? null : fmtClock(timing.startedAt);
  const endedAt = timing.endedAt === null ? null : fmtClock(timing.endedAt);
  const waitDuration = timing.waitMs === null ? null : fmtDuration(timing.waitMs);
  const runDuration = timing.runMs === null ? null : fmtDuration(timing.runMs);
  const binding = taskWorkflowBinding(raw);
  const stepIndex = typeof raw["stepIndex"] === "number" ? (raw["stepIndex"] as number) : 0;
  // TASK-EDIT-VERSIONING: the read-only edit history. The indicator (v{n} ·
  // edited {ago}) is always shown once any edit exists; clicking it expands the
  // per-version prior-values list (newest first). No fetch — the whole history
  // rides on the TaskRecord already in hand.
  const versions = taskVersionRows(raw);
  const [showVersions, setShowVersions] = useState(false);
  const lastEditedAt = versions.length > 0 ? versions[versions.length - 1]!.editedAt : 0;
  return (
    <div className={styles.card} data-task-inspector>
      <Row label="pushed by">
        <span>
          <span className={styles.owner}>◆ {pushedBy ?? "—"}</span>
          <span className={styles.meta}>{` · ${pushedAt ?? "—"} · priority ${task.priority} · role ${task.role}`}</span>
        </span>
      </Row>
      <Row label="started">
        <span>
          <span className={styles.meta}>{startedAt ?? "—"}</span>
          <span className={styles.meta}>{` · waited ${waitDuration ?? "—"}`}</span>
        </span>
      </Row>
      <Row label="ended">
        <span>
          <span className={styles.meta}>{endedAt ?? "—"}</span>
          <span className={styles.meta}>{` · ran ${runDuration ?? "—"}`}</span>
        </span>
      </Row>
      <Row label="prompt">
        <span className={styles.prompt}>{task.prompt ? `"${task.prompt}"` : "—"}</span>
      </Row>
      {/* TASK-TAGS: shown only when the task HAS tags — an untagged task is the common case and
          an empty "tags —" row would be pure chrome. These are what a hook/subscription
          `filter: {tags:[...]}` routes on, so they belong next to the brief they qualify. */}
      {task.tags.length > 0 && (
        <Row label="tags">
          <span className={styles.meta} data-task-tags>{task.tags.join(" · ")}</span>
        </Row>
      )}
      {versions.length > 0 && (
        <Row label="edits">
          <span className={styles.versionIndicator} data-task-versions onClick={() => setShowVersions((v) => !v)}>
            {showVersions ? "▾" : "▸"} v{versions.length} · edited {relativeLabel(lastEditedAt - Date.now())}
          </span>
        </Row>
      )}
      {showVersions
        && versions
          .slice()
          .reverse()
          .map((v) => (
            <Row key={v.version} label={`v${v.version}`}>
              <span className={styles.meta} data-task-version={v.version}>
                {relativeLabel(v.editedAt - Date.now())} · changed: {v.changedFields.length > 0 ? v.changedFields.join(", ") : "—"}
                {Object.keys(v.prior).length > 0 ? ` · was ${summarizeEventData(v.prior)}` : ""}
              </span>
            </Row>
          ))}
      <Row label="depends on">
        <span className={styles.meta} data-task-depends-on>
          {dependencies === undefined
            ? (Array.isArray(raw["dependsOn"]) && (raw["dependsOn"] as unknown[]).length > 0
                ? (raw["dependsOn"] as unknown[]).filter((x): x is string => typeof x === "string").join(", ")
                : "(none)")
            : dependencies.length === 0
              ? "(none)"
              : dependencies.map((d, i) => (
                  <span key={d.taskId} data-dependency={d.taskId} className={d.done ? undefined : styles.toneWarn}>
                    {i > 0 ? ", " : ""}{d.taskId.slice(0, 8)} ({d.state})
                  </span>
                ))}
        </span>
      </Row>
      {/* QUEUE-REORDER: the T15 incident's own root cause, said plainly where the operator is
          looking — "run this last" is dependsOn, not priority (priority only breaks ties among
          tasks that are already ready). */}
      {task.state === "blocked" && dependencies !== undefined && dependencies.some((d) => !d.done) && (
        <Row label="">
          <span className={styles.meta} data-task-blocked-note>
            blocked on: {dependencies.filter((d) => !d.done).map((d) => d.taskId.slice(0, 8)).join(", ")}
            {" — priority only breaks ties among READY tasks; \"run after X\" is dependsOn, not priority"}
          </span>
        </Row>
      )}
      <Row label={typeof raw["error"] === "string" && raw["error"] ? "error" : "result"}>
        {/* TASK-DETAIL: an unstarted/still-running task has no result yet — that
            reads as "still running", never a bare "—" that could be misread as
            "produced nothing". A terminal task with a genuinely empty
            resultText renders "(empty result)" instead, so the two states are
            never confused. */}
        <span className={styles.meta} data-task-result>
          {typeof raw["error"] === "string" && raw["error"]
            ? raw["error"]
            : typeof raw["resultText"] === "string" && raw["resultText"]
              ? raw["resultText"]
              : task.state === "done" || task.state === "failed"
                ? "(empty result)"
                : "(no result yet — task is still running)"}
        </span>
      </Row>
      {onRetryTask && (task.state === "failed" || task.state === "dead_letter") && (
        <Row label="">
          <span className={styles.evidenceToggle} data-retry-task={task.taskId} onClick={onRetryTask}>
            ↺ retry — clones this task into a fresh pending one (no retyping the prompt); the original stays as-is for the record
          </span>
        </Row>
      )}
      <Row label="policy">
        <span className={styles.meta}>{policyLine(task, retryLimit, team, library)}</span>
      </Row>
      {binding && (
        <Row label="workflow">
          <span className={styles.meta}>
            {workflow
              ? workflow.steps.map((step, i) => {
                  const state = stepGateState(i, stepIndex, task.state);
                  const ts = stepTimestamps?.get(i);
                  const hist = stepHistoryEntry(raw, i);
                  const agentId = hist?.agentId ?? (i === stepIndex ? task.agentId : null);
                  const duration = hist?.durationMs != null ? fmtDurationSec(hist.durationMs) : null;
                  const reason = state === "failed" ? (hist?.reason ?? null) : null;
                  const clickable = i <= stepIndex && !!agentId && !!onOpenAgent;
                  const handoff = i > 0 && (stepHandoffs?.has(i) || !!hist?.handoffSummary);
                  return (
                    <span
                      key={step.id || i}
                      data-workflow-step={step.id}
                      data-step-agent={agentId ?? undefined}
                      onClick={clickable ? () => onOpenAgent(agentId) : undefined}
                      style={clickable ? { cursor: "pointer" } : undefined}
                    >
                      {i > 0 ? (
                        handoff
                          ? <span className={styles.handoffMarker} data-handoff-marker={step.id}> ⇄ handoff </span>
                          : " · "
                      ) : ""}
                      {GATE_STATE_GLYPH[state]} {step.title}
                      {ts !== undefined ? ` (${fmtClock(ts)})` : ""}
                      {duration !== null ? ` [${duration}]` : ""}
                      {reason ? <span className={styles.stepFail}>{` — ${reason}`}</span> : ""}
                    </span>
                  );
                })
              : `${binding.name} v${binding.version} — step ${stepIndex + 1}`}
          </span>
        </Row>
      )}
      {binding && onOpenWorkflowGraph && <Row label=""><span className={styles.evidenceToggle} onClick={onOpenWorkflowGraph}>▸ inspect workflow graph</span></Row>}
      {artifacts && artifacts.length > 0 && (
        <Row label="artifacts">
          <span className={styles.artifacts} data-task-artifacts>
            {artifacts.map((row) => (
              <ArtifactChip key={row.id} row={row} diffMeta={artifactDiffMeta?.[row.id]} />
            ))}
          </span>
        </Row>
      )}
      {onOpenEvidence && (
        <Row label="">
          <span className={styles.evidenceToggle} onClick={onOpenEvidence} data-open-evidence>
            {evidenceOpen ? "▾ hide changes & evidence" : "▸ view changes & evidence"}
          </span>
        </Row>
      )}
      {evidenceOpen && (
        <ChangesEvidencePanel evidence={evidence ?? null} loading={!!evidenceLoading} error={evidenceError ?? null} />
      )}
      <Row label="">
        <span className={styles.hint}>{`${displayChord("mod+shift+c")} cancel (pending) · enter to see the agent once assigned`}</span>
      </Row>
    </div>
  );
}
