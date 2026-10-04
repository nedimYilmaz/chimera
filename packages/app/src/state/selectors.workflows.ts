// W18 (F16 task workflows, coverage B20/C14) — PURE selectors/formatters for
// the workflow surfaces (task-row step meter, TaskInspector's step list, the
// read-only WorkflowCard, WorkflowFormCard's field state). Same discipline as
// selectors.coord.ts: plain functions over the loosely-typed workflow.list /
// queue.status payloads (read defensively — daemon-side field drift must
// never crash a pane), no React, no store import, fully unit-testable.
import { WorkflowSpecSchema, type NormalizedEvent } from "@chimera/protocol";
import { normalizeWorkflowGraph, serializeWorkflowGraph, type AgentView, type TeamColorId, type WorkflowGraphDocument } from "@chimera/ui-state";
import { COORD_NAME_RE } from "./selectors.coord";
import { conductorLabel, type AgentRow } from "./selectors";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export const GATE_KINDS = ["command", "artifact", "approval", "none"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

// F16.1 Phase 2 (WF-4/G5): the ArtifactKind enum, mirrored from protocol's
// ArtifactKindSchema — an artifact-gate's optional kind pin.
export const ARTIFACT_KINDS = ["report", "diff", "chart", "file", "link"] as const;
export type ArtifactKindOption = (typeof ARTIFACT_KINDS)[number];

// F16.1 Phase 2 (WF-5/G6): a step's onFail override — "" means "inherit the
// workflow-level policy" (not sent on the wire at all; see buildWorkflowSteps).
export const STEP_ON_FAIL_OPTIONS = ["", "halt", "retry"] as const;

function gateKindOf(gate: unknown): GateKind {
  const k = gate && typeof gate === "object" ? (gate as Record<string, unknown>)["kind"] : undefined;
  return (GATE_KINDS as readonly string[]).includes(k as string) ? (k as GateKind) : "none";
}

/** One-line gate summary for the workflow card/inspector ("command: npm test",
 * "artifact: build-output", "approval: ship it?", "none"). */
export function gateLabel(gate: unknown): string {
  const kind = gateKindOf(gate);
  const spec = gate && typeof gate === "object" ? (gate as Record<string, unknown>)["spec"] : undefined;
  const s = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
  if (kind === "command") {
    const args = Array.isArray(s["args"]) ? (s["args"] as unknown[]).filter((a): a is string => typeof a === "string") : [];
    return `command: ${[str(s["command"]), ...args].filter(Boolean).join(" ")}`;
  }
  if (kind === "artifact") return str(s["artifactId"]) ? `artifact: ${str(s["artifactId"])}` : "artifact";
  if (kind === "approval") return str(s["prompt"]) ? `approval: ${str(s["prompt"])}` : "approval";
  return "none";
}

export type WorkflowStepRow = {
  id: string;
  title: string;
  gateKind: GateKind;
  gateLabel: string;
  // the gate's raw spec sub-fields, kept alongside the rendered `gateLabel` so
  // an edit form can be REBUILT losslessly (workflowFormValuesFromRow below).
  command: string;
  args: string;
  // F16.1 Phase 2 (WF-3/G3): optional command-gate exec timeout override, "" ⇒
  // absent on the wire (defaultGateExec's 120s default applies).
  timeoutMs: string;
  artifactId: string;
  // F16.1 Phase 2 (WF-4/G5): artifact-gate scope ("task", the pre-existing
  // behavior, or "step" — only an artifact registered during THIS stepIndex
  // satisfies the gate) and an optional ArtifactKind pin ("" ⇒ unpinned).
  artifactScope: "task" | "step";
  artifactKind: string;
  approvalPrompt: string;
  // optional free-text shown to the agent on this step (F16.1 Phase 1, WF-1) —
  // absent on the wire when never set; projected here as "" so every UI
  // surface can read it without a null-check.
  instructions: string;
  // F16.1 Phase 2 (WF-5/G6): per-step onFail/retryLimit override — "" means
  // "inherit the workflow-level policy" (absent on the wire).
  onFail: "" | "halt" | "retry";
  retryLimit: string;
  // F16.1 Phase 3 (WF-8/WF-10): the TEAM role that must run this step — "" ⇒
  // absent on the wire (the step runs on whatever agent is already bound, the
  // pre-WF-8 single-agent behavior).
  role: string;
  // F16.1 Phase 3 (WF-9/WF-10): whether this step's incoming agent receives
  // the previous step's handoff package on a role-switch boundary. Mirrors
  // protocol's `context` enum ("handoff"|"none", default "handoff") — the UI
  // labels the "none" chip "clean" since "context: none" reads ambiguous.
  context: "handoff" | "none";
};

function stepRow(step: Record<string, unknown>): WorkflowStepRow {
  const gate = step["gate"];
  const kind = gateKindOf(gate);
  const rawSpec = gate && typeof gate === "object" ? (gate as Record<string, unknown>)["spec"] : undefined;
  const spec = rawSpec && typeof rawSpec === "object" ? (rawSpec as Record<string, unknown>) : {};
  const args = Array.isArray(spec["args"]) ? (spec["args"] as unknown[]).filter((a): a is string => typeof a === "string") : [];
  const stepOnFail = step["onFail"];
  return {
    id: str(step["id"]),
    title: str(step["title"]) || str(step["id"]),
    gateKind: kind,
    gateLabel: gateLabel(gate),
    command: str(spec["command"]),
    args: args.join(" "),
    timeoutMs: typeof spec["timeoutMs"] === "number" ? String(spec["timeoutMs"]) : "",
    artifactId: str(spec["artifactId"]),
    artifactScope: spec["scope"] === "step" ? "step" : "task",
    artifactKind: str(spec["kind"]),
    approvalPrompt: str(spec["prompt"]),
    instructions: str(step["instructions"]),
    onFail: stepOnFail === "retry" ? "retry" : stepOnFail === "halt" ? "halt" : "",
    retryLimit: typeof step["retryLimit"] === "number" ? String(step["retryLimit"]) : "",
    role: str(step["role"]),
    context: step["context"] === "none" ? "none" : "handoff",
  };
}

export type WorkflowRow = {
  name: string;
  version: number;
  onFail: "halt" | "retry";
  retryLimit: number;
  steps: WorkflowStepRow[];
  createdAt: number;
  spec: Record<string, unknown>;
};

/** Projects a workflow.list/create/update reply (protocol WorkflowRecord) into
 * the row shape every W18 surface reads — defensive like every other selector
 * here (daemon field drift never crashes a card). */
export function workflowRow(rec: Record<string, unknown>): WorkflowRow {
  const steps = Array.isArray(rec["steps"]) ? (rec["steps"] as unknown[]) : [];
  return {
    name: str(rec["name"]),
    version: num(rec["version"]) || 1,
    onFail: rec["onFail"] === "retry" ? "retry" : "halt",
    retryLimit: num(rec["retryLimit"]),
    steps: steps.filter((s): s is Record<string, unknown> => !!s && typeof s === "object").map(stepRow),
    createdAt: num(rec["createdAt"]),
    spec: { name: str(rec["name"]), steps: steps.filter((s): s is Record<string, unknown> => !!s && typeof s === "object"), onFail: rec["onFail"] === "retry" ? "retry" : "halt", retryLimit: num(rec["retryLimit"]) },
  };
}

export function workflowDocumentFromRow(row: WorkflowRow): WorkflowGraphDocument {
  const parsed = WorkflowSpecSchema.safeParse(row.spec);
  if (parsed.success) return normalizeWorkflowGraph(parsed.data);
  // a persisted spec that no longer matches the protocol schema (unknown gate kind, a field a
  // newer daemon added) must still open the studio — an empty graph, not a crash (matches
  // workflowGraphValidation's own safeParse discipline just below).
  return { name: row.name, onFail: row.onFail, retryLimit: row.retryLimit, params: [], nodeOrder: [], nodesById: {}, edgesById: {} };
}

export type WorkflowGraphIssue = { message: string; nodeId: string | null };
export function workflowGraphValidation(doc: WorkflowGraphDocument): WorkflowGraphIssue[] {
  const parsed = WorkflowSpecSchema.safeParse(serializeWorkflowGraph(doc));
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const index = typeof issue.path[1] === "number" ? issue.path[1] : null;
    return { message: issue.message, nodeId: index === null ? null : doc.nodeOrder[index] ?? null };
  });
}

export type WorkflowLayoutNode = { id: string; x: number; y: number; width: number; height: number };
export type WorkflowLayout = { nodes: Record<string, WorkflowLayoutNode>; width: number; height: number };
export function workflowGraphLayout(doc: WorkflowGraphDocument): WorkflowLayout {
  const incoming = new Map(doc.nodeOrder.map((id) => [id, 0]));
  const outgoing = new Map(doc.nodeOrder.map((id) => [id, [] as string[]]));
  for (const edge of Object.values(doc.edgesById)) if (incoming.has(edge.to) && outgoing.has(edge.from)) {
    incoming.set(edge.to, incoming.get(edge.to)! + 1); outgoing.get(edge.from)!.push(edge.to);
  }
  const rank = new Map(doc.nodeOrder.map((id) => [id, 0]));
  const queue = doc.nodeOrder.filter((id) => incoming.get(id) === 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const to of outgoing.get(id) ?? []) {
      rank.set(to, Math.max(rank.get(to)!, rank.get(id)! + 1));
      incoming.set(to, incoming.get(to)! - 1); if (incoming.get(to) === 0) queue.push(to);
    }
  }
  const lanes = new Map<number, string[]>();
  for (const id of doc.nodeOrder) { const r = rank.get(id)!; lanes.set(r, [...(lanes.get(r) ?? []), id]); }
  const nodes: Record<string, WorkflowLayoutNode> = {};
  for (const [r, ids] of lanes) ids.forEach((id, lane) => { nodes[id] = { id, x: 64 + r * 260, y: 64 + lane * 150, width: 190, height: 96 }; });
  return { nodes, width: Math.max(520, 128 + lanes.size * 260), height: Math.max(360, 128 + Math.max(1, ...[...lanes.values()].map((x) => x.length)) * 150) };
}

export type WorkflowRuntimeNode = { state: "pending" | "active" | "passed" | "failed" | "waiting"; attempts: number; agentId: string | null; reason: string | null };
export function workflowExecutionOverlay(doc: WorkflowGraphDocument, task: Record<string, unknown>, agents: Record<string, AgentView>): Record<string, WorkflowRuntimeNode> {
  const history = Array.isArray(task["stepHistory"]) ? task["stepHistory"] as Array<Record<string, unknown>> : [];
  const result: Record<string, WorkflowRuntimeNode> = {};
  for (const id of doc.nodeOrder) {
    const entries = history.filter((h) => {
      if (h["stepId"]) return h["stepId"] === id;
      // no stepId ⇒ fall back to stepIndex, but ONLY when it's genuinely a finite number —
      // num()'s silent-zero default would otherwise mis-attribute a malformed entry (neither
      // field present) to node 0, inflating its attempts and forcing it "active".
      const idx = h["stepIndex"];
      return typeof idx === "number" && Number.isFinite(idx) && doc.nodeOrder[idx] === id;
    });
    const latest = entries.at(-1);
    const agentId = typeof latest?.["agentId"] === "string" ? latest["agentId"] as string : null;
    const outcome = latest?.["outcome"];
    let state: WorkflowRuntimeNode["state"] = outcome === "passed" ? "passed" : outcome === "failed" ? "failed" : latest ? "active" : "pending";
    if (state === "active" && doc.nodesById[id]?.step.gate.kind === "approval" && agentId && agents[agentId]?.pendingQuestion?.gate === "approval") state = "waiting";
    result[id] = { state, attempts: entries.length, agentId, reason: typeof latest?.["reason"] === "string" ? latest["reason"] as string : null };
  }
  return result;
}

/** The task/queue's pinned {name, version} binding (TaskRecord.workflow — null
 * ⇒ not workflow-bound). */
export type WorkflowBinding = { name: string; version: number };

export function taskWorkflowBinding(raw: Record<string, unknown>): WorkflowBinding | null {
  const w = raw["workflow"];
  if (!w || typeof w !== "object") return null;
  const name = str((w as Record<string, unknown>)["name"]);
  return name ? { name, version: num((w as Record<string, unknown>)["version"]) } : null;
}

/** Resolves a pinned binding against the loaded workflow definitions.
 * workflow.list only ever returns the LATEST version per name (core's
 * WorkflowStore.list — there is no workflow.get{name,version} RPC), so an
 * older pinned version resolves against the CURRENT definition: best effort
 * for display only — the daemon still gates the task against its own
 * correctly-pinned version regardless of what this row shows. */
export function workflowFor(binding: WorkflowBinding | null, workflows: ReadonlyArray<WorkflowRow>): WorkflowRow | null {
  if (!binding) return null;
  return workflows.find((w) => w.name === binding.name) ?? null;
}

// ---------------------------------------------------------------------------
// task-row step meter ("◐ 3/5 test")
// ---------------------------------------------------------------------------

export type StepMeterView = { glyph: string; label: string; stepTitle: string | null };

/** Task-row step meter — null when the task carries no workflow binding at
 * all (an ordinary, ungated task renders no meter). `workflow` may be null
 * (definition not yet loaded/resolved) — the meter still renders the glyph +
 * 1-based step index, just without the "/N" total or step title. F16.1 Phase
 * 3 (WF-10): a step with a `role` appends " @role" ("◐ 2/5 review @qa") so
 * the row surfaces WHICH agent the current step runs on without opening the
 * inspector. */
export function stepMeterView(raw: Record<string, unknown>, workflow: WorkflowRow | null): StepMeterView | null {
  const binding = taskWorkflowBinding(raw);
  if (!binding) return null;
  const stepIndex = num(raw["stepIndex"]);
  const total = workflow ? workflow.steps.length : null;
  const step = workflow?.steps[stepIndex] ?? null;
  const state = str(raw["state"]);
  const glyph = state === "failed" ? "✗" : state === "done" ? "●" : "◐";
  const fraction = total !== null ? `${stepIndex + 1}/${total}` : `${stepIndex + 1}`;
  const roleSuffix = step?.role ? ` @${step.role}` : "";
  return { glyph, label: `${fraction}${step ? ` ${step.title}` : ""}${roleSuffix}`, stepTitle: step?.title ?? null };
}

// ---------------------------------------------------------------------------
// AgentList step-dot indicator (W20 — a workflow-bound agent's row shows N
// dots instead of/alongside the normal state word)
// ---------------------------------------------------------------------------

export type WorkflowDotState = "done" | "current" | "failed" | "waiting" | "pending";

/** Per-step dot states for the AgentList step indicator — null when the task
 * carries no binding at all, or the bound definition hasn't resolved yet (a
 * definition-less binding can't produce a fixed dot COUNT). Unlike
 * stepGateState (TaskInspector's step list) this special-cases a "done" task
 * to color every dot solid green: the scheduler never advances stepIndex past
 * the last step on success (handleWorkflowTurn just closes the session), so
 * treating raw.stepIndex as authoritative for a finished task would strand
 * the final dot on "current" forever. `waiting` is the caller's call — true
 * while the current step is an approval gate the agent has asked about and
 * nobody has answered yet (AgentList derives it from pendingQuestion). */
export function workflowStepDots(
  raw: Record<string, unknown>,
  workflow: WorkflowRow | null,
  waiting: boolean,
): WorkflowDotState[] | null {
  if (!taskWorkflowBinding(raw) || !workflow || workflow.steps.length === 0) return null;
  const total = workflow.steps.length;
  const stepIndex = num(raw["stepIndex"]);
  const state = str(raw["state"]);
  if (state === "done") return Array.from({ length: total }, () => "done");
  return Array.from({ length: total }, (_, i) => {
    if (i < stepIndex) return "done";
    if (i > stepIndex) return "pending";
    return state === "failed" ? "failed" : waiting ? "waiting" : "current";
  });
}

/** AgentList row composition over workflowStepDots: derives `waiting` (true
 * while the CURRENT step is an approval gate the bound agent has asked about
 * and nobody has answered yet) from the agent's pendingQuestion, then defers
 * to workflowStepDots for the actual per-step array. `pendingQuestion`
 * mirrors AgentView.pendingQuestion — loosely typed here (this module has no
 * ui-state dependency) so any truthy value counts as "asked". */
export function agentWorkflowStepDots(
  raw: Record<string, unknown> | null,
  workflow: WorkflowRow | null,
  pendingQuestion: unknown,
): WorkflowDotState[] | null {
  if (!raw || !workflow) return null;
  const currentStep = workflow.steps[num(raw["stepIndex"])];
  const waiting = Boolean(pendingQuestion) && currentStep?.gateKind === "approval";
  return workflowStepDots(raw, workflow, waiting);
}

// ---------------------------------------------------------------------------
// optimistic overlay + reconcile (task_step_advanced/_failed)
// ---------------------------------------------------------------------------

export type StepEventOverlay = {
  stepIndex: number;
  stepId: string;
  title: string | null;
  failed: boolean;
  willRetry: boolean;
  reason: string | null;
};

/** The NEWEST task_step_advanced/_failed for this taskId still in the ring
 * buffer. QueuesScreen merges this over the fetched `raw.stepIndex` (see
 * overlayTaskStep) so a row/inspector shows the new step the instant the
 * event lands, without waiting on the queue.status refetch the SAME event
 * also triggers (selectors.coord's latestCoordSeq) to land — the optimistic
 * half; that refetch is the reconcile half (raw catches up and the overlay
 * stops changing anything visible). */
export function latestStepEvent(
  events: ReadonlyArray<Pick<NormalizedEvent, "kind" | "data">>,
  taskId: string,
): StepEventOverlay | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "task_step_advanced" && e.kind !== "task_step_failed") continue;
    if (e.data?.["taskId"] !== taskId) continue;
    return {
      stepIndex: num(e.data["stepIndex"]),
      stepId: str(e.data["stepId"]),
      title: e.kind === "task_step_advanced" ? str(e.data["title"]) || null : null,
      failed: e.kind === "task_step_failed",
      willRetry: e.data["willRetry"] === true,
      reason: typeof e.data["reason"] === "string" ? (e.data["reason"] as string) : null,
    };
  }
  return null;
}

/** Merges an optimistic overlay onto a fetched task record. Only takes effect
 * while STRICTLY ahead of the fetched stepIndex — once the reconcile refetch
 * catches raw up, this is a no-op again (never regresses/flickers backward). */
export function overlayTaskStep(raw: Record<string, unknown>, overlay: StepEventOverlay | null): Record<string, unknown> {
  if (!overlay) return raw;
  const rawStepIndex = num(raw["stepIndex"]);
  if (overlay.failed) {
    return overlay.stepIndex === rawStepIndex && !overlay.willRetry && raw["state"] !== "failed"
      ? { ...raw, state: "failed" }
      : raw;
  }
  return overlay.stepIndex > rawStepIndex ? { ...raw, stepIndex: overlay.stepIndex } : raw;
}

// ---------------------------------------------------------------------------
// TaskInspector's step list (gate states + timestamps)
// ---------------------------------------------------------------------------

export type StepGateState = "done" | "current" | "failed" | "pending";

export function stepGateState(stepIdx: number, taskStepIndex: number, taskState: string): StepGateState {
  if (stepIdx < taskStepIndex) return "done";
  if (stepIdx > taskStepIndex) return "pending";
  return taskState === "failed" ? "failed" : "current";
}

/** Every task_step_advanced this taskId has emitted, keyed by stepIndex → the
 * ts it FIRST reached that step — the only per-step timing data available
 * client-side (TaskRecord itself carries no per-step history). Ring-buffer-
 * bounded like every other event-derived view: a step from long enough ago
 * may have scrolled out of the buffer, in which case the inspector simply
 * shows no timestamp for it rather than guessing.
 *
 * NOTE: despite the name, this reads the EVENT ring, not TaskRecord.
 * stepHistory (added later, WF-4/G4) — kept as-is (still the only source for
 * a step reached long enough ago to have scrolled out of stepHistory too, and
 * pre-existing callers already depend on the event-ring signature). See
 * `stepHistoryEntry` below for the richer, TaskRecord-backed per-attempt view
 * (agent/duration/failure reason). */
export function stepTimestamps(
  events: ReadonlyArray<Pick<NormalizedEvent, "kind" | "data" | "ts">>,
  taskId: string,
): Map<number, number> {
  const map = new Map<number, number>();
  for (const e of events) {
    if (e.kind !== "task_step_advanced" || e.data?.["taskId"] !== taskId) continue;
    const idx = num(e.data["stepIndex"]);
    if (!map.has(idx)) map.set(idx, e.ts);
  }
  return map;
}

// ---------------------------------------------------------------------------
// TaskInspector's step list — per-attempt detail from TaskRecord.stepHistory
// (F16.1 Phase 2, WF-4/G4 protocol + WF-6 UI)
// ---------------------------------------------------------------------------

export type StepHistoryView = {
  stepIndex: number;
  agentId: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: "passed" | "failed" | "retried" | null;
  reason: string | null;
  /** endedAt - startedAt; null while the attempt is still in flight (never
   * guessed from the current time — same "no data, no guess" discipline as
   * stepTimestamps above). */
  durationMs: number | null;
  /** F16.1 Phase 3 (WF-9/WF-10): the outgoing agent's captured handoff
   * summary for the boundary INTO this step, if one was captured — null for
   * a context:"none" step, an artifacts-only fallback (summarize turn failed/
   * timed out), or a step that isn't a role-switch boundary at all. */
  handoffSummary: string | null;
};

/** The LATEST stepHistory entry for a given stepIndex (a retried step has one
 * entry per attempt, appended in order — the last one is the current/most
 * recent attempt). null when the task carries no stepHistory at all for this
 * step (an older daemon build, or a step never reached yet). */
export function stepHistoryEntry(raw: Record<string, unknown>, stepIndex: number): StepHistoryView | null {
  const history = Array.isArray(raw["stepHistory"]) ? (raw["stepHistory"] as unknown[]) : [];
  let latest: Record<string, unknown> | null = null;
  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (num(e["stepIndex"]) !== stepIndex) continue;
    latest = e;
  }
  if (!latest) return null;
  const startedAt = num(latest["startedAt"]);
  const endedAt = typeof latest["endedAt"] === "number" ? (latest["endedAt"] as number) : null;
  const outcome = latest["outcome"];
  return {
    stepIndex,
    agentId: typeof latest["agentId"] === "string" ? (latest["agentId"] as string) : null,
    startedAt,
    endedAt,
    outcome: outcome === "passed" || outcome === "failed" || outcome === "retried" ? outcome : null,
    reason: typeof latest["reason"] === "string" ? (latest["reason"] as string) : null,
    durationMs: endedAt !== null ? endedAt - startedAt : null,
    handoffSummary: typeof latest["handoffSummary"] === "string" ? (latest["handoffSummary"] as string) : null,
  };
}

/** Every toStepIndex the task_step_handoff event ring shows for this taskId —
 * a role-switch boundary landed on that step, whether or not a summary was
 * actually captured (mirrors stepTimestamps' event-ring scope/caveat: a
 * boundary from long enough ago may have scrolled out of the ring, in which
 * case TaskInspector falls back to stepHistoryEntry(...).handoffSummary,
 * persisted server-side, to still show the marker). */
export function stepHandoffIndices(
  events: ReadonlyArray<Pick<NormalizedEvent, "kind" | "data">>,
  taskId: string,
): Set<number> {
  const set = new Set<number>();
  for (const e of events) {
    if (e.kind !== "task_step_handoff" || e.data?.["taskId"] !== taskId) continue;
    set.add(num(e.data["toStepIndex"]));
  }
  return set;
}

/** The read-only workflow card's engine-parity note (mock copy: `?screen=
 * queues&showWorkflow=1`) — claude's native plan mode carries the full step
 * sequence; a non-native engine (codex, …) gets the CURRENT step re-injected
 * each turn. Either way the daemon (not the engine's own self-report)
 * evaluates the gate before advancing, so both paths enforce identically. */
export const ENGINE_PARITY_NOTE =
  "engine parity: claude follows the full plan natively; other engines are stepped per-turn — chimera evaluates every gate either way.";

// ---------------------------------------------------------------------------
// WorkflowFormCard — create/edit form values
// ---------------------------------------------------------------------------

export type WorkflowStepFormValues = {
  id: string;
  title: string;
  gateKind: GateKind;
  command: string;
  args: string;
  timeoutMs: string;
  artifactId: string;
  artifactScope: "task" | "step";
  artifactKind: string;
  approvalPrompt: string;
  instructions: string;
  onFail: "" | "halt" | "retry";
  retryLimit: string;
  role: string;
  context: "handoff" | "none";
};

export type WorkflowFormValues = {
  name: string;
  onFail: "halt" | "retry";
  retryLimit: string;
  steps: WorkflowStepFormValues[];
};

export function emptyWorkflowStep(): WorkflowStepFormValues {
  return {
    id: "", title: "", gateKind: "none", command: "", args: "", timeoutMs: "",
    artifactId: "", artifactScope: "task", artifactKind: "", approvalPrompt: "", instructions: "",
    onFail: "", retryLimit: "", role: "", context: "handoff",
  };
}

export function defaultWorkflowFormValues(): WorkflowFormValues {
  return { name: "", onFail: "halt", retryLimit: "0", steps: [emptyWorkflowStep()] };
}

/** "run tests" -> "run-tests" (a step's default id when left blank, mirroring
 * the protocol CoordName rule). */
export function slugify(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** First validation error for the create/edit workflow form, or null when
 * submittable. Mirrors protocol constraints client-side (WorkflowSpecSchema/
 * WorkflowStepSchema) so the inline error is instant. */
export function validateWorkflowForm(v: WorkflowFormValues): string | null {
  if (!v.name.trim()) return "name is required";
  if (!COORD_NAME_RE.test(v.name.trim())) return "name: letters, digits, _ and - only";
  if (v.steps.length === 0) return "at least one step is required";
  if (v.retryLimit.trim() && !(Number.isInteger(Number(v.retryLimit)) && Number(v.retryLimit) >= 0))
    return "retry limit must be a non-negative integer";
  for (const [i, s] of v.steps.entries()) {
    if (!s.title.trim()) return `step ${i + 1}: title is required`;
    if (s.gateKind === "command" && !s.command.trim()) return `step ${i + 1}: command is required`;
    if (s.gateKind === "command" && s.timeoutMs.trim() && !(Number.isInteger(Number(s.timeoutMs)) && Number(s.timeoutMs) >= 1000 && Number(s.timeoutMs) <= 600_000))
      return `step ${i + 1}: timeout must be an integer between 1000 and 600000 ms`;
    if (s.retryLimit.trim() && !(Number.isInteger(Number(s.retryLimit)) && Number(s.retryLimit) >= 0))
      return `step ${i + 1}: retry limit must be a non-negative integer`;
  }
  const ids = v.steps.map((s) => s.id.trim() || slugify(s.title));
  if (new Set(ids).size !== ids.length) return "step ids must be unique";
  return null;
}

function buildGate(s: WorkflowStepFormValues): Record<string, unknown> {
  switch (s.gateKind) {
    case "command": {
      const timeoutMs = s.timeoutMs.trim();
      return {
        kind: "command",
        spec: {
          command: s.command.trim(),
          args: s.args.trim() ? s.args.trim().split(/\s+/) : [],
          ...(timeoutMs ? { timeoutMs: Number(timeoutMs) } : {}),
        },
      };
    }
    case "artifact": {
      const spec: Record<string, unknown> = {};
      if (s.artifactId.trim()) spec["artifactId"] = s.artifactId.trim();
      if (s.artifactScope === "step") spec["scope"] = "step";
      if (s.artifactKind.trim()) spec["kind"] = s.artifactKind.trim();
      return { kind: "artifact", spec };
    }
    case "approval":
      return { kind: "approval", spec: s.approvalPrompt.trim() ? { prompt: s.approvalPrompt.trim() } : {} };
    default:
      return { kind: "none" };
  }
}

/** protocol WorkflowStepSchema[] (workflow.create's spec.steps / workflow.
 * update's patch.steps). `instructions` is optional (`.min(1).optional()` on
 * the protocol side) — an empty/whitespace-only field OMITS the key entirely
 * rather than sending "", so previously persisted steps without it round-trip
 * byte-identically through an edit that leaves it blank. */
export function buildWorkflowSteps(v: WorkflowFormValues): Array<Record<string, unknown>> {
  return v.steps.map((s) => ({
    id: s.id.trim() || slugify(s.title),
    title: s.title.trim(),
    gate: buildGate(s),
    ...(s.instructions.trim() ? { instructions: s.instructions.trim() } : {}),
    ...(s.onFail ? { onFail: s.onFail } : {}),
    ...(s.retryLimit.trim() ? { retryLimit: Number(s.retryLimit) } : {}),
    ...(s.role.trim() ? { role: s.role.trim() } : {}),
    ...(s.context === "none" ? { context: "none" } : {}),
  }));
}

/** workflow.create's full spec (protocol WorkflowSpecSchema). */
export function buildWorkflowSpec(v: WorkflowFormValues): Record<string, unknown> {
  return {
    name: v.name.trim(),
    steps: buildWorkflowSteps(v),
    onFail: v.onFail,
    ...(v.retryLimit.trim() ? { retryLimit: Number(v.retryLimit) } : {}),
  };
}

/** workflow.update's patch (protocol WorkflowUpdateParams.patch — name is
 * immutable, never included). */
export function buildWorkflowPatch(v: WorkflowFormValues): Record<string, unknown> {
  return { steps: buildWorkflowSteps(v), onFail: v.onFail, ...(v.retryLimit.trim() ? { retryLimit: Number(v.retryLimit) } : {}) };
}

/** Edit mode: project an existing WorkflowRow back into form values,
 * PREFILLED (mirrors the F15 edit-opens-prefilled convention) — the name
 * field renders read-only in edit mode (workflow.update can never rename). */
export function workflowFormValuesFromRow(row: WorkflowRow): WorkflowFormValues {
  return {
    name: row.name,
    onFail: row.onFail,
    retryLimit: String(row.retryLimit),
    steps: row.steps.map((s) => ({
      id: s.id, title: s.title, gateKind: s.gateKind,
      command: s.command, args: s.args, timeoutMs: s.timeoutMs,
      artifactId: s.artifactId, artifactScope: s.artifactScope, artifactKind: s.artifactKind,
      approvalPrompt: s.approvalPrompt, instructions: s.instructions,
      onFail: s.onFail, retryLimit: s.retryLimit,
      role: s.role, context: s.context,
    })),
  };
}

// ---------------------------------------------------------------------------
// WORKFLOW-TASK-VIEW-2: AgentList task-row grouping — MODE-AGNOSTIC over the
// two shapes a workflow-bound task's stepHistory can take: MULTI-agent (WF-8's
// per-step role switch spawns a FRESH agent per step — glm→claude→codex — so
// stepHistory names several distinct agentIds) and SINGLE-agent (the pre-WF-8
// norm: no step roles, or every step's role resolves to the SAME bound agent —
// stepHistory's agentId never changes). Both take the SAME code path: every
// workflow-bound task collapses into exactly ONE row, styled like an ordinary
// agent row (leading glyph, name, a step-DOT state cell, summed cost/tokens) —
// there is no separate "multi-agent" special case, and (unlike the original
// WORKFLOW-TASK-VIEW) no nested per-step agent rows at all: the step agents
// this task ran are an implementation detail, reachable via the stitched
// transcript's step headers, never a row of their own in the pane. A task with
// NO workflow binding at all is untouched — that's the only thing left
// rendering exactly as before.
// ---------------------------------------------------------------------------

/** The synthetic row/selection id for a task group — mirrors the existing
 * `task:<taskId>` convention W18's transcript-banner projectEvent branch
 * already uses for a non-agent event target (reducer.ts). Never a real
 * agentId; used as-is wherever `selectedAgentId`/`collapsed` take a plain
 * string (both are id-agnostic — see AgentList.tsx). */
export function taskRowId(taskId: string): string {
  return `task:${taskId}`;
}

/** Inverse of taskRowId — null for a plain agentId (no "task:" prefix). */
export function taskIdFromRowId(id: string): string | null {
  return id.startsWith("task:") ? id.slice(5) : null;
}

// JOB-FLEET-GROUPING: mirrors taskRowId's synthetic-id convention — a jobGroup row has no
// single agentId of its own (it stands in for N member rows), so keyboard selection/fold
// addresses it via this prefix instead.
export function jobGroupRowId(jobName: string): string {
  return `jobgroup:${jobName}`;
}

// AGENT-GROUPS Phase 1: same synthetic-id convention as jobGroupRowId — a group box has no
// single agentId of its own either.
export function groupRowId(groupId: string): string {
  return `group:${groupId}`;
}

/** Every distinct agentId this task's stepHistory has run, in FIRST-SEEN
 * (step/attempt) order — the task→agents mapping WORKFLOW-TASK-VIEW groups
 * under one row. Falls back to `[task.agentId]` for a legacy/empty-history
 * record (pre-WF-4, or a step that hasn't started yet), which always yields
 * a 1-member "group" — never grouped, since groupAgentListRowsByTask only
 * groups a task with ≥1 member actually present in the row list. */
export function taskStepAgentIds(raw: Record<string, unknown>): string[] {
  const history = Array.isArray(raw["stepHistory"]) ? (raw["stepHistory"] as unknown[]) : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>)["agentId"];
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    const cur = raw["agentId"];
    if (typeof cur === "string" && cur) ids.push(cur);
  }
  return ids;
}

/** taskStepAgentIds (distinct stepHistory agentIds, first-seen order) UNIONED with the task's
 * CURRENT bound agentId — covers the narrow window where a fresh step has been marked
 * in-progress (task.agentId updated) but its stepHistory entry hasn't landed yet. Used to decide
 * whether a task is "effectively single-agent" for row labeling — see
 * groupAgentListRowsByTask. */
export function taskDistinctAgentIds(raw: Record<string, unknown>): string[] {
  const fromHistory = taskStepAgentIds(raw);
  const current = raw["agentId"];
  if (typeof current === "string" && current && !fromHistory.includes(current)) return [...fromHistory, current];
  return fromHistory;
}

export type AgentListRow =
  | { kind: "agent"; agentId: string; depth: number; collapsible: boolean; collapsed: boolean; hiddenCount: number; section: "main" | "session" }
  | {
      kind: "task";
      taskId: string;
      /** Agent whose lineage anchors this synthetic row in the inspector. */
      anchorAgentId?: string;
      depth: number;
      /** The name-cell label: "<agent name> · <queue>" for an effectively single-agent task,
       * else "<workflow name> · <queue> · @<current step agent>" (R2 UI FIX — see
       * groupAgentListRowsByTask). The leading glyph (⧉) and the state cell's step dots render
       * as separate cells, mirroring an ordinary agent row's GlyphCell/state split (see
       * TaskRow). */
      label: string;
      state: string;
      /** Summed across every step agent this task has run. */
      costUsd: number;
      usage: { input: number; output: number } | null;
      /** Per-step dot states (agentWorkflowStepDots) driven by the TASK's own
       * stepIndex/stepHistory/state — null when the bound workflow definition
       * hasn't resolved yet (no fixed dot count), in which case TaskRow falls
       * back to the plain state glyph/word. */
      stepDots: WorkflowDotState[] | null;
      /** RUNNING-STATE-PURPLE: the CURRENT step agent's live AgentView.state
       * (e.g. "running"/"paused"/"waiting") — task["state"] alone stays
       * "in_progress" through a session-limit pause (scheduler.ts: paused is a
       * non-terminal HOLD, the worker keeps its bound task), so it can't tell a
       * genuinely-running step from a paused one apart. null only if the
       * current step agent isn't resolvable in `agents` (not expected once a
       * group has formed at all — see groupAgentListRowsByTask's present
       * filter — kept null-safe regardless). */
      currentAgentState: string | null;
      /** The current step agent's pause reason/resume time, set ONLY while
       * currentAgentState === "paused" — mirrors what an ordinary Row already
       * shows via pauseSummary (PAUSED-AGENTS-VISIBLE), so a workflow task row
       * doesn't lose that badge just because its step agent folded into a
       * task-group row instead of rendering as a plain Row. */
      currentAgentPause: { pauseReason: AgentView["pauseReason"]; resumeAt: AgentView["resumeAt"] } | null;
    }
  | {
      // JOB-FLEET-GROUPING: a scheduled job's spawns collapse into ONE row (see
      // groupAgentListRowsByJob) — memberIds is EVERY run, newest-spawn-first;
      // AgentList renders only a component-local "loaded" PREFIX of it (default 3,
      // grows via a "load more" affordance) so a job with hundreds of runs never puts
      // hundreds of Row components in the DOM. Always placed at the END of listRows.
      kind: "jobGroup";
      jobName: string;
      memberIds: string[];
    }
  | {
      // AGENT-GROUPS Phase 1: an operator-defined wrapper box (see selectors.groups.ts's
      // groupAgentListRowsByGroup) — UNLIKE jobGroup, this does NOT flatten its members: a
      // grouped agent's full subtree renders NESTED inside the box (memberRows keeps each
      // row's ORIGINAL kind/shape, just depth-rebased so the box's root renders at depth 0),
      // so "no row ever renders under an ancestor that isn't actually its ancestor" holds.
      // Placed IN-PLACE at its first member's original position (not moved to the list's
      // end like jobGroup) — a persistent container reads as replacing that spot in the
      // tree, not as overflow. An empty (0 live-or-terminal member) group still renders,
      // appended after every non-empty box, in registry order — "sprint"/"daily" must
      // persist even with nobody in them right now.
      kind: "group";
      groupId: string;
      name: string;
      color: TeamColorId;
      liveCount: number;
      totalCount: number;
      memberRows: AgentListRow[];
    };

/** Per-agent live data groupAgentListRowsByTask needs to summarize a task row
 * — loosely typed like the rest of this module (no ui-state/AgentView
 * dependency); callers project it from AgentView themselves (see
 * AgentList.tsx). */
export type AgentMetaForTask = {
  costUsd: number;
  usage: { input: number; output: number } | null;
  pendingQuestion: unknown;
};

export type TaskAgentTotals = { costUsd: number; usage: { input: number; output: number } | null };

/** Cost/usage summed across every distinct step agent a task has run
 * (taskStepAgentIds) — the exact math groupAgentListRowsByTask's task row
 * uses, factored out so a second consumer (TranscriptPanel's workflow-mode
 * header, WORKFLOW-UI-2) can't drift from the row it's showing detail for. */
export function taskAgentTotals(
  raw: Record<string, unknown>,
  agentMeta: Record<string, AgentMetaForTask>,
): TaskAgentTotals {
  const ids = taskStepAgentIds(raw);
  const costUsd = ids.reduce((sum, id) => sum + (agentMeta[id]?.costUsd ?? 0), 0);
  const usage = ids.reduce<{ input: number; output: number } | null>((acc, id) => {
    const u = agentMeta[id]?.usage;
    if (!u) return acc;
    return { input: (acc?.input ?? 0) + u.input, output: (acc?.output ?? 0) + u.output };
  }, null);
  return { costUsd, usage };
}

/** Reshapes buildAgentRows' flat output: every WORKFLOW-BOUND task with ≥1
 * distinct stepHistory agentId PRESENT in `rows` collapses into ONE row,
 * replacing every one of its step-agent rows outright (no nesting, no fold —
 * the step agents never render as rows of their own; see the module doc
 * comment above) — a single-agent workflow task collapses exactly like a
 * multi-agent one, just summarizing one member instead of several. A task
 * with no binding at all passes its row through unchanged — only ordinary,
 * non-workflow agents render byte-identically to buildAgentRows' own
 * output. */
export function groupAgentListRowsByTask(
  rows: ReadonlyArray<AgentRow>,
  tasks: ReadonlyArray<Record<string, unknown>>,
  agentMeta: Record<string, AgentMetaForTask>,
  workflows: ReadonlyArray<WorkflowRow>,
  agents: Record<string, AgentView>,
): AgentListRow[] {
  const rowIndex = new Map<string, number>();
  rows.forEach((r, i) => rowIndex.set(r.agentId, i));

  const memberOf = new Map<string, string>();
  const groups = new Map<string, { task: Record<string, unknown>; memberIds: string[] }>();
  for (const raw of tasks) {
    const binding = taskWorkflowBinding(raw);
    if (!binding) continue;
    const taskId = str(raw["taskId"]);
    if (!taskId) continue;
    const present = taskStepAgentIds(raw).filter((id) => rowIndex.has(id));
    if (present.length === 0) continue; // no member currently visible — nothing to anchor a group on
    groups.set(taskId, { task: raw, memberIds: present });
    for (const id of present) memberOf.set(id, taskId);
  }
  if (groups.size === 0) return rows.map((r) => ({ ...r }));

  const emittedGroup = new Set<string>();
  const out: AgentListRow[] = [];
  for (const r of rows) {
    const taskId = memberOf.get(r.agentId);
    if (!taskId) {
      out.push({ ...r });
      continue;
    }
    if (emittedGroup.has(taskId)) continue; // a later member — already folded into the one row emitted below
    emittedGroup.add(taskId);
    const g = groups.get(taskId)!;
    const binding = taskWorkflowBinding(g.task)!;
    const workflow = workflowFor(binding, workflows);
    const queue = str(g.task["queue"]);
    const queueSuffix = queue ? ` · ${queue}` : "";
    // R2 UI FIX: an effectively SINGLE-agent task (one distinct agentId across its whole
    // stepHistory + current bound agent) labels with THAT agent's name instead of the workflow
    // name — every single-agent task otherwise rendered the identical "<workflow> · <queue>"
    // label, making rows indistinguishable by agent. A genuinely multi-agent task keeps the
    // workflow name, appending the CURRENT step agent so multi-agent rows are distinguishable too.
    const distinctIds = taskDistinctAgentIds(g.task);
    const label = distinctIds.length === 1
      ? `${conductorLabel(agents, distinctIds[0]!)}${queueSuffix}`
      : (() => {
          const currentId = distinctIds[distinctIds.length - 1] ?? null;
          const currentLabel = currentId ? conductorLabel(agents, currentId) : null;
          return `${binding.name}${queueSuffix}${currentLabel ? ` · @${currentLabel}` : ""}`;
        })();
    const { costUsd, usage } = taskAgentTotals(g.task, agentMeta);
    // `waiting` (an approval gate the live step agent has asked about) only
    // ever applies to the CURRENT step, so only the last (most recent) member
    // — the earlier ones already finished their steps — can supply it.
    const currentAgentId = g.memberIds[g.memberIds.length - 1]!;
    const pendingQuestion = agentMeta[currentAgentId]?.pendingQuestion;
    // RUNNING-STATE-PURPLE: read the live agent record (not agentMeta, which only
    // carries cost/usage/pendingQuestion) for the current step agent's own state —
    // see the currentAgentState doc comment on AgentListRow above for why task.state
    // can't stand in for it.
    const currentAgent = agents[currentAgentId];
    out.push({
      kind: "task",
      taskId,
      anchorAgentId: r.agentId,
      depth: r.depth,
      label,
      state: str(g.task["state"]) || "pending",
      costUsd,
      usage,
      stepDots: agentWorkflowStepDots(g.task, workflow, pendingQuestion),
      currentAgentState: currentAgent?.state ?? null,
      currentAgentPause: currentAgent?.state === "paused"
        ? { pauseReason: currentAgent.pauseReason, resumeAt: currentAgent.resumeAt }
        : null,
    });
  }
  return out;
}

/** The ordered row ids ↑/↓ step over (mirrors visibleAgentIds, task-row
 * aware) — AgentList's keyboard nav reads this over its own grouped rows. */
// JOB-FLEET-GROUPING: how many of a jobGroup's members render (and are keyboard-reachable)
// before its "load more" affordance grows the window — JobGroupRow's own initial useState
// matches this exactly, so keyboard nav and the visual default never disagree at rest. Nav
// intentionally does NOT grow with a mouse-driven "load more" click (a rarer, scroll/click-
// oriented path into deep history) — it stays capped at this default in every case.
export const JOB_GROUP_DEFAULT_VISIBLE = 3;

export function visibleListRowIds(rows: ReadonlyArray<AgentListRow>): string[] {
  return rows.flatMap((r) => {
    if (r.kind === "task") return [taskRowId(r.taskId)];
    if (r.kind === "jobGroup") return r.memberIds.slice(0, JOB_GROUP_DEFAULT_VISIBLE);
    // AGENT-GROUPS Phase 1: unlike jobGroup, nav walks INTO the box's own nested rows (they
    // keep their real agentId/task shape) rather than a flat memberIds slice — a group's
    // members are placed by the operator, not spawn-time noise, so there's no volume
    // problem to cap the way JOB_GROUP_DEFAULT_VISIBLE guards against.
    if (r.kind === "group") return visibleListRowIds(r.memberRows);
    return [r.agentId];
  });
}

// ---------------------------------------------------------------------------
// WORKFLOW-TASK-VIEW: the stitched-transcript builder — every stepHistory
// attempt IN ORDER, projected into a header + its agent's transcript slice.
// MODE-AGNOSTIC: a section is "agentId + a [startedAt,endedAt] time range",
// never "the whole agent" — in multi-agent mode each section's agentId is
// distinct (the range covers essentially its whole transcript); in
// single-agent mode the SAME agentId repeats and the range is what segments
// its one growing transcript into per-step slices. Same builder, same render
// path, either mode — see TranscriptPanel.tsx's `workflow` mode.
// ---------------------------------------------------------------------------

export type StitchedStepSection = {
  /** Stable React key: `${stepIndex}-${attempt}` (a retried step repeats
   * stepIndex across several attempts/sections). */
  key: string;
  stepIndex: number;
  attempt: number;
  stepId: string;
  stepTitle: string | null;
  role: string | null;
  agentId: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  outcome: "passed" | "failed" | "retried" | null;
  reason: string | null;
  gateLabel: string | null;
  handoffSummary: string | null;
  /** A role-switch boundary landed on entering this section (WF-9) — every
   * section past the first whose agentId differs from the PRECEDING
   * section's agentId (a plain retry on the same agent is not a handoff;
   * single-agent mode is NEVER a handoff boundary, by construction). */
  isHandoffBoundary: boolean;
};

/** One section per TaskRecord.stepHistory entry, in persisted (attempt)
 * order — the stitched panel's ordering source of truth. Empty for a task
 * with no stepHistory at all (a legacy record, or a step not yet started). */
export function stitchedStepSections(raw: Record<string, unknown>, workflow: WorkflowRow | null): StitchedStepSection[] {
  const history = Array.isArray(raw["stepHistory"]) ? (raw["stepHistory"] as unknown[]) : [];
  const sections: StitchedStepSection[] = [];
  const attemptOf = new Map<number, number>();
  let prevAgentId: string | null = null;
  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const stepIndex = num(e["stepIndex"]);
    const attempt = attemptOf.get(stepIndex) ?? 0;
    attemptOf.set(stepIndex, attempt + 1);
    const step = workflow?.steps[stepIndex] ?? null;
    const agentId = typeof e["agentId"] === "string" ? (e["agentId"] as string) : null;
    const startedAt = num(e["startedAt"]);
    const endedAt = typeof e["endedAt"] === "number" ? (e["endedAt"] as number) : null;
    const outcome = e["outcome"];
    sections.push({
      key: `${stepIndex}-${attempt}`,
      stepIndex,
      attempt,
      stepId: str(e["stepId"]) || step?.id || String(stepIndex),
      stepTitle: step?.title ?? null,
      role: step?.role || null,
      agentId,
      startedAt,
      endedAt,
      durationMs: endedAt !== null ? endedAt - startedAt : null,
      outcome: outcome === "passed" || outcome === "failed" || outcome === "retried" ? outcome : null,
      reason: typeof e["reason"] === "string" ? (e["reason"] as string) : null,
      gateLabel: step ? step.gateLabel : null,
      handoffSummary: typeof e["handoffSummary"] === "string" ? (e["handoffSummary"] as string) : null,
      isHandoffBoundary: sections.length > 0 && agentId !== null && agentId !== prevAgentId,
    });
    prevAgentId = agentId;
  }
  return sections;
}

// ---------------------------------------------------------------------------
// WORKFLOW-UI-1: WorkflowFlowBar — the pinned step-timeline bar above a
// workflow task's stitched transcript. Zips the workflow's static step list
// (title/role) against live per-step state (workflowStepDots) and the latest
// attempt's timing/agent/handoff-boundary data (stitchedStepSections) — same
// STORE-FREE discipline as every selector here; the component resolves
// agentId -> display name itself via conductorLabel.
// ---------------------------------------------------------------------------

export type WorkflowFlowBarStep = {
  title: string;
  role: string | null;
  state: WorkflowDotState;
  durationMs: number | null;
  agentId: string | null;
  isHandoffBoundary: boolean;
  reason: string | null;
};

export type WorkflowFlowBarView = {
  name: string;
  version: number;
  enforced: true;
  steps: WorkflowFlowBarStep[];
};

/** null when the task carries no workflow binding, or the bound definition
 * hasn't resolved yet (mirrors workflowStepDots' null cases — no fixed step
 * list means no bar to render). `waiting` is always false in the
 * workflowStepDots call below: telling an approval gate someone's waiting on
 * apart from an ordinary in-progress step needs the live agent's
 * pendingQuestion (see agentWorkflowStepDots), which this STORE-FREE selector
 * has no access to — the bar renders that step as plain "current" instead. */
export function workflowFlowBarView(
  raw: Record<string, unknown>,
  workflow: WorkflowRow | null,
  sections: ReadonlyArray<StitchedStepSection>,
): WorkflowFlowBarView | null {
  const binding = taskWorkflowBinding(raw);
  if (!binding || !workflow) return null;
  const dots = workflowStepDots(raw, workflow, false);
  if (!dots) return null;
  const latestByStep = new Map<number, StitchedStepSection>();
  for (const s of sections) latestByStep.set(s.stepIndex, s);
  const steps: WorkflowFlowBarStep[] = workflow.steps.map((step, i) => {
    const section = latestByStep.get(i) ?? null;
    return {
      title: step.title,
      role: step.role || null,
      state: dots[i]!,
      durationMs: section?.durationMs ?? null,
      agentId: section?.agentId ?? null,
      isHandoffBoundary: section?.isHandoffBoundary ?? false,
      reason: section?.reason ?? null,
    };
  });
  return { name: binding.name, version: binding.version, enforced: true, steps };
}

/** The task's CURRENT live agentId — the composer's send target while a
 * stitched task-row view is selected (WORKFLOW-TASK-VIEW). Only "live" while
 * the task itself is still in_progress; a done/failed/pending task has no
 * live step to target (the composer renders disabled with a hint instead). */
export function liveTaskStepAgentId(raw: Record<string, unknown> | null): string | null {
  if (!raw || raw["state"] !== "in_progress") return null;
  return typeof raw["agentId"] === "string" && raw["agentId"] ? (raw["agentId"] as string) : null;
}

/** WORKFLOW-HEADER-CHIPS-DEAD: resolves `state.selectedAgentId` to a REAL agentId the
 * model/effort/account overlays (ModelCard/EffortCard/AccountCard, commands.system.ts's
 * toggleModel/toggleEffort/toggleAccount) can act on. A task-row selection is the
 * synthetic `task:<id>` string (taskRowId above) — never a key in `state.agents` — so
 * indexing `state.agents[selectedAgentId]` directly (what all three overlays did) always
 * misses for a task row, silently rendering nothing despite the chip's local "open" flag
 * flipping true. Mirrors liveTaskStepAgentId's own "only live while in_progress" rule
 * (already applied to the composer's send target) via the live TaskLite fold instead of
 * the raw task object, since callers here only have `state.tasks`, not `raw`.
 * Non-task selections pass through unchanged. */
export function overlayTargetAgentId(state: {
  selectedAgentId: string | null;
  tasks: Record<string, { state: string; agentId: string | null }>;
}): string | null {
  const sel = state.selectedAgentId;
  if (!sel) return null;
  const taskId = taskIdFromRowId(sel);
  if (taskId === null) return sel;
  const task = state.tasks[taskId];
  return task && task.state === "in_progress" ? task.agentId : null;
}
