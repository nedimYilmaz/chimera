import { IssueSources, IssueChip } from "../components/IssueSources";
import { useEffect, useMemo, useRef, useState } from "react";
import { type UiState } from "@chimera/ui-state";
import { onRowKeyDown } from "../a11y";
import { displayChord, registerActionHandler, runAction } from "../keymap";
import { rpcCall, readArtifactSnapshot } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { getCoordCommands } from "../state/commands.coord";
import { getRolesCommands } from "../state/commands.roles";
import { singleFlight } from "../state/singleFlight";
import { useArtifacts, useDiffMeta } from "../state/commands.artifacts";
import { openReviewRoom } from "../state/commands.evidence";
import { systemCommands, useSystemLocal } from "../state/commands.system";
import { CONFIRMS, TOASTS } from "../copy";
import { shortId } from "../state/selectors";
import {
  backlogPct,
  backlogRatio,
  countTone,
  dependencyRows,
  drainOrderTasks,
  drainPositions,
  editFormValuesFromTask,
  isTaskRetryable,
  latestCoordSeq,
  isTaskEditable,
  isTaskReorderable,
  matchesQueueQuery,
  matchesTaskQuery,
  newestFirst,
  newestFirstTasks,
  num,
  queueFormValuesFromSpec,
  str,
  TASK_STATES,
  taskRowView,
  type CoordTone,
} from "../state/selectors.coord";
import { Panel, PanelFooter } from "../components/Panel";
import { OverlayOutlet } from "../components/OverlayOutlet";
import { SearchBox } from "../components/SearchBox";
import { Collapse } from "../components/Collapse";
import { toggleCollapsed } from "../state/selectionToggle";
import { TaskInspector } from "../components/TaskInspector";
import { PushTaskCard } from "../components/PushTaskCard";
import { EditTaskCard } from "../components/EditTaskCard";
import { ConfirmCard } from "../components/ConfirmCard";
import { ScheduleFormCard } from "../components/ScheduleFormCard";
import { ScheduleDetail } from "../components/ScheduleDetail";
import { ScheduleLibraryCard } from "../components/ScheduleLibraryCard";
import { exportSchedule } from "../state/schedule-library";
import { writeClipboard } from "../state/copyOnSelect";
import { QueueFormCard } from "../components/QueueFormCard";
import { ActionChipRow } from "../components/ActionChipRow";
import { WorkflowCard } from "../components/WorkflowCard";
import { WorkflowFormCard } from "../components/WorkflowFormCard";
import { getJobsCommands, jobsLocal, useJobsLocal } from "../state/commands.jobs";
import {
  scheduleGapBanner, lastResultLabel, latestJobSeq, jobStateLabel, relativeLabel, resultTone, scheduleFormValuesFromSpec, type JobRow,
} from "../state/selectors.jobs";
import { getWorkflowsCommands, useWorkflowsLocal, workflowsLocal } from "../state/commands.workflows";
import {
  latestStepEvent, overlayTaskStep, stepHandoffIndices, stepMeterView, stepTimestamps, taskWorkflowBinding,
  workflowFor, workflowFormValuesFromRow,
  workflowDocumentFromRow,
  workflowRow,
} from "../state/selectors.workflows";
import styles from "./QueuesScreen.module.css";
import { usePaneRow } from "../components/PaneDivider";

// W5 — the Queues screen (mock s_queues, coverage B9): 430px master list
// (queue/pending/active/backlog meter — fill=(pending+blocked)/Σ) + detail
// (colored counts row, tasks table with the TaskInspector under the cursor
// row, failed rows carrying ✗ error inline). mod+o pushes (PushTaskCard →
// queue.push), mod+shift+c cancels a PENDING task through the ConfirmCard gate —
// cancel on a non-pending task is not offered (a footer hint says why).
// Refresh: tab entry + relevant events + after mutations; no polling timers.
//
// W15 (F14, coverage B19/C12): a schedules panel is a PERMANENT fixture below
// the queue master list (standing job.* definitions, not a spawn-time thing) —
// see commands.jobs.ts for the job.list projection + its screen-local store.
// mod+o opens ScheduleFormCard whenever no queue drill is open (the drill
// already owns mod+o for push-task); space/mod+r/mod+shift+x always act on the schedule
// row under the panel's OWN cursor. Live refresh rides job_run_started/
// _finished/_skipped/_disabled — never polled.

const coord = getCoordCommands(appStore, rpcCall);
// FLAT-SHAPE-SWEEP: the role library (role.list) — TaskInspector's policyLine needs
// it to resolve a bound team's role BINDING to its effective cwd/permissionProfile
// (same reachability need as TeamsScreen's own rolesCommands, see its comment).
const rolesCommands = getRolesCommands(appStore, rpcCall);
const jobs = getJobsCommands(appStore, rpcCall);
const workflowsCmd = getWorkflowsCommands(appStore, rpcCall);

const toneClass: Record<CoordTone, string> = {
  warn: styles.toneWarn!,
  muted: styles.toneMuted!,
  accent: styles.toneAccent!,
  success: styles.toneSuccess!,
  danger: styles.toneDanger!,
  info: styles.toneInfo!,
  human: styles.toneHuman!,
};

export function QueuesScreen() {
  // PANE-RESIZE: the row carries the width and is the drag ceiling.
  const pane = usePaneRow("queues");
  const queues = useStore((s: UiState) => s.queues);
  const queueCursor = useStore((s: UiState) => s.queueCursor);
  const detail = useStore((s: UiState) => s.queueDetail);
  const taskCursor = useStore((s: UiState) => s.taskCursor);
  const mode = useStore((s: UiState) => s.mode);
  const confirm = useStore((s: UiState) => s.confirm);
  const pushQueue = useStore((s: UiState) => s.pushQueue);
  const teams = useStore((s: UiState) => s.teams);
  const roles = useStore((s: UiState) => s.roles);
  const coordSeq = useStore((s: UiState) => latestCoordSeq(s.events));
  const jobSeq = useStore((s: UiState) => latestJobSeq(s.events));
  const events = useStore((s: UiState) => s.events);
  const [nowTick, setNowTick] = useState(() => Date.now());
  // F02.UI: the schedules panel's suspend/restart banner. `nowTick` (the display clock below) is
  // a REAL dep, not decoration: the banner's own 6h window is measured against it, and with
  // `[events]` alone a fleet that goes idle right after a wake — the single most likely state —
  // pinned "slept 9h 13m" above the rows until some unrelated event happened to arrive.
  const gapBanner = useMemo(() => scheduleGapBanner(events, nowTick), [events, nowTick]);
  const pins = useSystemLocal((s) => s.pins);

  const jobItems = useJobsLocal((s) => s.items);
  const jobCursor = useJobsLocal((s) => s.cursor);
  const jobsFocused = useJobsLocal((s) => s.focused);
  const jobFormOpen = useJobsLocal((s) => s.formOpen);
  const confirmDeleteJob = useJobsLocal((s) => s.confirmDelete);
  const confirmRequeueJob = useJobsLocal((s) => s.confirmRequeue);
  const jobsLoaded = useJobsLocal((s) => s.loaded);
  const jobListError = useJobsLocal((s) => s.listError);

  // W16 (F15/D11 CRUD completion): the queue create/edit form (mode
  // "queueForm" — declared but unused before this feature) and the schedule
  // "e" edit form (a separate slot from jobsLocal.formOpen's CREATE-only
  // toggle, prefilled from a job.status fetch). Both screen-local, mirroring
  // TeamsScreen's editingTeam precedent.
  const [editingQueueSpec, setEditingQueueSpec] = useState<Record<string, unknown> | null>(null);
  const [editingJobSpec, setEditingJobSpec] = useState<Record<string, unknown> | null>(null);
  const [librarySource, setLibrarySource] = useState<Record<string, unknown> | null | undefined>(undefined);

  // TASK-EDIT-VERSIONING: the in-place edit form for a still-queued task. A
  // separate screen-local slot (like editingQueueSpec) rather than a ui-state
  // mode enum — the app owns its overlays locally (PushTaskCard's pushForm mode
  // is the only ui-state one, kept for cross-store parity). Holds the raw task
  // record so the card prefills from its current head fields.
  const [editingTask, setEditingTask] = useState<Record<string, unknown> | null>(null);

  // W18 (F16 task workflows): the workflow registry is a standing definition
  // set (like the schedules panel's jobs), loaded once + relisted after every
  // mutation — no dedicated workflow_* event to ride (step-gate events refresh
  // the QUEUE drill via latestCoordSeq above, not this registry).
  const workflowItems = useWorkflowsLocal((s) => s.items);
  const workflowCardOpen = useWorkflowsLocal((s) => s.cardOpen);
  const workflowFormOpen = useWorkflowsLocal((s) => s.formOpen);
  const workflowEditing = useWorkflowsLocal((s) => s.editing);
  const workflowConfirmDelete = useWorkflowsLocal((s) => s.confirmDelete);
  useEffect(() => { void workflowsCmd.loadWorkflows(); }, []);

  // Selection alone drives the detail pane now (no separate drill action to
  // SEE it) — `enter`/dblclick only move keyboard focus INTO the task list.
  // A ref mirrors the state for the mounted-once move()/drill() closures
  // below (same pattern as TeamsScreen's agentIdxRef/mergedRef).
  const [taskFocused, setTaskFocused] = useState(false);
  const taskFocusedRef = useRef(false);
  taskFocusedRef.current = taskFocused;

  // F-TOGGLE-ANIM: clicking an already-selected row again collapses its
  // detail (animated via Collapse) instead of no-oping — separate flags
  // because queueCursor/taskCursor are shared ui-state reducer state
  // (clampCursor never lets them go negative). Any real cursor move (click
  // or arrow key) reopens.
  const [queueDetailCollapsed, setQueueDetailCollapsed] = useState(false);
  useEffect(() => setQueueDetailCollapsed(false), [queueCursor]);
  // TASK-EDIT-VERSIONING: navigating to another queue closes any open task-edit
  // form (its taskId belongs to the queue you were on, not the new one).
  useEffect(() => setEditingTask(null), [queueCursor]);
  const [taskDetailCollapsed, setTaskDetailCollapsed] = useState(false);
  useEffect(() => setTaskDetailCollapsed(false), [taskCursor]);

  // Master-list per-queue counts: queue.list carries only the spec, so each
  // queue's counts come from one queue.status fetch (screen-local cache).
  const [countsByQueue, setCountsByQueue] = useState<Record<string, Record<string, number>>>({});
  // Both a coord event and the queue.list refresh it triggers re-run this, and each run fetches
  // every queue's full status; singleFlight keeps it to one round plus one trailing round, which
  // reads the newest queue names from the ref.
  const queueNames = useRef<string[]>([]);
  queueNames.current = queues.items.map((q) => str(q["name"])).filter((n) => n.length > 0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const loadCounts = useMemo(() => singleFlight(async () => {
    const pairs = await Promise.all(
      queueNames.current.map((name) =>
        coord.queueStatus(name).then(
          (qs) => [name, qs.counts] as const,
          () => [name, {}] as const,
        ),
      ),
    );
    if (mounted.current) setCountsByQueue(Object.fromEntries(pairs));
  }), [coord]);
  useEffect(() => { void loadCounts(); }, [queues.items, coordSeq, loadCounts]);

  // tab entry + relevant events → refresh list + open drill
  useEffect(() => { void coord.loadQueues(); void rolesCommands.loadRoles(); }, []);
  useEffect(() => { if (coordSeq > 0) void coord.refresh(); }, [coordSeq]);

  // W-SORT (P2 UX): newest-first display order for the queue master list —
  // queueCursor indexes THIS reordering everywhere below (selection, edit/
  // delete/pin targets), not the raw queues.items the daemon returns, so ↑↓
  // tracks the rendered rows.
  const sortedQueues = useMemo(() => newestFirst(queues.items), [queues.items]);

  // QUEUE-REORDER: the drilled task list now has TWO explicit sort modes —
  // "newest" (unchanged W-SORT default) and "drain" (priority desc, then FIFO —
  // the EXACT order the scheduler will actually drain, via selectors.coord's
  // drainOrderTasks). Neither silently replaces the other; the operator picks.
  // taskCursor indexes whichever is active, same "cursor tracks rendered rows"
  // contract W-SORT established.
  const [taskSort, setTaskSort] = useState<"newest" | "drain">("newest");
  const sortedTasks = useMemo(
    () => (detail ? (taskSort === "drain" ? drainOrderTasks(detail.tasks) : newestFirstTasks(detail.tasks)) : []),
    [detail, taskSort],
  );
  // taskId -> 1-based rank among pending/blocked tasks — shown on every such row regardless of
  // which sort mode is active (requirement: the effective position must be visible even from the
  // newest-first view, not just in drain-order mode).
  const taskPositions = useMemo(() => (detail ? drainPositions(detail.tasks) : new Map<string, number>()), [detail]);

  // SEARCH-QUEUES: free-text search over the queue master list, and (separately)
  // over the drilled queue's task list. queueCursor/taskCursor are global
  // ui-state indices whose reducer clamp bounds against the RAW array lengths
  // (queues.items.length / queueDetail.tasks.length) — a narrower query can
  // leave the cursor pointing past the filtered rows the reducer never sees,
  // so every cursor-indexed lookup below reads off these FILTERED arrays (not
  // sortedQueues/sortedTasks), and the two effects further down reclamp the
  // cursor into filtered bounds whenever the query shrinks the list.
  const [queueQuery, setQueueQuery] = useState("");
  const [taskQuery, setTaskQuery] = useState("");
  const filteredQueues = useMemo(
    () => sortedQueues.filter((q) => matchesQueueQuery(q, queueQuery)),
    [sortedQueues, queueQuery],
  );
  const filteredTasks = useMemo(
    () => sortedTasks.filter((raw) => matchesTaskQuery(taskRowView(raw), taskQuery)),
    [sortedTasks, taskQuery],
  );
  // Mirrors for the mounted-once move()/drill()/etc closures below (same
  // pattern as taskFocusedRef) — those read the LATEST filtered rows without
  // re-registering the keymap handlers every render.
  const filteredQueuesRef = useRef(filteredQueues);
  filteredQueuesRef.current = filteredQueues;
  const filteredTasksRef = useRef(filteredTasks);
  filteredTasksRef.current = filteredTasks;

  useEffect(() => {
    const max = filteredQueues.length - 1;
    if (queueCursor > max) {
      const target = Math.max(max, 0);
      if (target !== queueCursor) appStore.dispatch({ type: "queueCursor", delta: target - queueCursor });
    }
  }, [filteredQueues.length, queueCursor]);
  useEffect(() => {
    const max = filteredTasks.length - 1;
    if (taskCursor > max) {
      const target = Math.max(max, 0);
      if (target !== taskCursor) appStore.dispatch({ type: "taskCursor", delta: target - taskCursor });
    }
  }, [filteredTasks.length, taskCursor]);

  // Selection drives the detail fetch directly: whichever queue is under the
  // cursor gets its queue.status loaded immediately — a single click or an
  // arrow-key move is enough, no separate "drill" action required to see it.
  const selectedQueueName = (() => {
    const name = filteredQueues[queueCursor]?.["name"];
    return typeof name === "string" && name.length > 0 ? name : null;
  })();
  // QUEUE-PAUSE: the ActionChipRow label/footer flips between "pause"/"resume" off the
  // SELECTED row's own live paused flag (queues.items, kept current by the reducer's
  // queue_paused/queue_resumed fold) — no separate fetch needed.
  const selectedQueuePaused = filteredQueues[queueCursor]?.["paused"] === true;
  useEffect(() => {
    if (selectedQueueName) void coord.openQueueDetail(selectedQueueName);
    else coord.closeQueueDetail();
  }, [selectedQueueName]);

  // F17 (W19): "TaskInspector lists its OWN artifacts" — the SELECTED task's
  // taskId-scoped registrations (every agent that touched this task, not just
  // whichever one is currently bound to it), same useArtifacts optimistic+
  // reconcile pair as the composer strip/ResultCard.
  const selectedTaskId = filteredTasks[taskCursor] ? taskRowView(filteredTasks[taskCursor]!).taskId : null;
  const taskArtifactScope = selectedTaskId ? { taskId: selectedTaskId } : null;
  const taskArtifacts = useArtifacts(taskArtifactScope, events, rpcCall);
  const taskArtifactDiffMeta = useDiffMeta(taskArtifacts, readArtifactSnapshot);

  // FEATURE-10 (Changes & Evidence Review): the evidence panel is closed by default
  // (evidence.get shells out to git — it must not fire per-row on every render, unlike
  // useArtifacts) and closes automatically when the selected task changes.

  // W15: the schedules panel loads independently and refreshes off its OWN
  // event kinds (job_run_started/_finished/_skipped/_disabled) — a coord-only
  // event never touches it, and vice versa.
  useEffect(() => { void jobs.loadJobs(); }, []);
  useEffect(() => { if (jobSeq > 0) void jobs.loadJobs(); }, [jobSeq]);

  // A focused schedule shows its detail on the RIGHT (user request), mirroring
  // how a selected queue does. The JobRow is already in hand; the full spec
  // (prompt + precise schedule/tz) is fetched via job.status on selection.
  const selectedJob = jobItems[jobCursor] ?? null;
  const scheduleFocused = jobsFocused && selectedJob !== null;
  const [jobDetail, setJobDetail] = useState<{ name: string; spec: Record<string, unknown> | null; error: string | null } | null>(null);
  const jobSpec = jobDetail?.name === selectedJob?.name ? jobDetail?.spec ?? null : null;
  const jobDetailError = jobDetail?.name === selectedJob?.name ? jobDetail?.error ?? null : null;
  useEffect(() => {
    if (!scheduleFocused || !selectedJob) { setJobDetail(null); return undefined; }
    let alive = true;
    const name = selectedJob.name;
    void jobs.getJob(name).then((spec) => { if (alive) setJobDetail({ name, spec, error: null }); }).catch((e) => { if (alive) setJobDetail({ name, spec: null, error: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
    // F01.UI: jobSeq, not just the name — job.status carries the LIVE wakeScheduling block
    // (holdingAwake, next armed wake). Keyed on the name alone, the caffeinate line would freeze
    // at whatever was true when the row was first selected and go on claiming a hold after the run
    // ended. jobSeq only bumps on this panel's own job_* event kinds, so this is not a poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleFocused, selectedJob?.name, jobSeq, jobItems]);

  // transient footer hint (e.g. cancel refused on a non-pending task)
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<number | undefined>(undefined);
  const showHint = (text: string): void => {
    setHint(text);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), 3000);
  };
  useEffect(() => () => window.clearTimeout(hintTimer.current), []);

  // W15: a display-only clock tick (no RPC — the schedules panel's next-run/
  // last-run cells are relative-time strings that go stale between events).
  // F02.UI: it carries the timestamp now instead of a bare counter, so every relative label on
  // this screen reads the SAME `now` the banner's staleness check does.
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // ---- keymap registrations ------------------------------------------------
  useEffect(() => {
    const disposers = [
      registerActionHandler("queues.up", () => move(-1)),
      registerActionHandler("queues.down", () => move(1)),
      registerActionHandler("queues.drill", () => drill()),
      registerActionHandler("queues.new", () => togglePushForm()),
      registerActionHandler("queues.edit", () => requestEdit()),
      registerActionHandler("queues.cancel", () => requestCancel()),
      registerActionHandler("queues.workflow", () => toggleWorkflowCard()),
      registerActionHandler("queues.pauseToggle", () => requestTogglePause()),
      registerActionHandler("queues.pin", () => pinSelectedTask()),
      registerActionHandler("queues.scheduleToggle", () => toggleSelectedJob()),
      registerActionHandler("queues.scheduleRun", () => runSelectedJob()),
      registerActionHandler("queues.scheduleDelete", () => requestDeleteJob()),
    ];
    return () => { for (const d of disposers) d(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers read live state
  }, []);

  // esc exits keyboard focus FROM the task list back to the queue list — the
  // detail itself stays populated (it tracks selection, not focus).
  useEffect(() => {
    if (!taskFocused) return undefined;
    return registerActionHandler("global.escape", () => setTaskFocused(false));
  }, [taskFocused]);

  function move(delta: number): void {
    const state = appStore.getState();
    if (taskFocusedRef.current) {
      const list = filteredTasksRef.current;
      if (list.length === 0) return;
      const next = Math.min(list.length - 1, Math.max(0, state.taskCursor + delta));
      if (next !== state.taskCursor) appStore.dispatch({ type: "taskCursor", delta: next - state.taskCursor });
      return;
    }
    const js = jobsLocal.getState();
    if (js.focused) {
      const next = js.cursor + delta;
      if (next < 0) { jobsLocal.set({ focused: false }); return; } // hand focus back to the queue list
      jobsLocal.set({ cursor: Math.min(Math.max(0, js.items.length - 1), Math.max(0, next)) });
      return;
    }
    // SEARCH-QUEUES: bound against the FILTERED rows on screen, not
    // state.queues.items.length — a narrower query must fall off the bottom
    // into the schedules panel sooner than the raw list would.
    const list = filteredQueuesRef.current;
    const nextQ = state.queueCursor + delta;
    if (nextQ >= list.length && js.items.length > 0) {
      jobsLocal.set({ focused: true, cursor: 0 }); // arrows fall off the queue list into the schedules panel
      return;
    }
    const clamped = list.length === 0 ? 0 : Math.min(list.length - 1, Math.max(0, nextQ));
    if (clamped !== state.queueCursor) appStore.dispatch({ type: "queueCursor", delta: clamped - state.queueCursor });
  }

  // enter — a "focus INTO the task list" action, not what SHOWS the detail
  // (selection already does that): first press moves keyboard focus onto the
  // task list, a second press (now focused) drills into the task's agent.
  function drill(): void {
    const state = appStore.getState();
    if (taskFocusedRef.current) {
      const task = filteredTasksRef.current[state.taskCursor];
      const agentId = task?.["agentId"];
      if (typeof agentId === "string" && agentId.length > 0) coord.openAgent(agentId);
      return;
    }
    if (state.queueDetail && filteredTasksRef.current.length > 0) setTaskFocused(true);
  }

  function togglePushForm(): void {
    const state = appStore.getState();
    if (state.mode === "pushForm") {
      appStore.dispatch({ type: "setMode", mode: "normal" });
      appStore.dispatch({ type: "pushQueue", queue: null });
      return;
    }
    const name = taskFocusedRef.current && state.queueDetail ? state.queueDetail.spec["name"] : undefined;
    if (typeof name === "string") {
      appStore.dispatch({ type: "pushQueue", queue: name });
      appStore.dispatch({ type: "setMode", mode: "pushForm" });
      return;
    }
    // W16 (F15/D11): no drill open — mod+o now creates whichever list has
    // cursor focus: the schedules panel (arrows fell off the bottom into it)
    // or the queue master list (queue.create).
    if (jobsLocal.getState().focused) {
      jobsLocal.set({ formOpen: !jobsLocal.getState().formOpen });
      return;
    }
    setEditingQueueSpec(null);   // mod+o always means CREATE, even over an open edit
    appStore.dispatch({ type: "setMode", mode: state.mode === "queueForm" ? "normal" : "queueForm" });
  }

  function closeQueueForm(): void {
    setEditingQueueSpec(null);
    appStore.dispatch({ type: "setMode", mode: "normal" });
  }

  /** "e" — routes by whichever list currently has cursor focus (mirrors
   * move()'s own jobsFocused branch): the schedules panel's row, the drilled
   * queue's TASK under the cursor (TASK-EDIT-VERSIONING), or the queue master
   * list / open drill. */
  function requestEdit(): void {
    if (jobsLocal.getState().focused) { requestEditSchedule(); return; }
    if (taskFocusedRef.current && appStore.getState().queueDetail) { requestEditTask(); return; }
    requestEditQueue();
  }

  /** TASK-EDIT-VERSIONING: "e" on a task row inside a drill opens the edit
   * form — but only for a still-queued task (pending/blocked); an in_progress/
   * terminal task is immutable (the daemon refuses it too), so a footer hint
   * says why instead of opening a form that would only fail on submit. */
  function requestEditTask(): void {
    const state = appStore.getState();
    if (!taskFocusedRef.current || !state.queueDetail) return;
    const task = filteredTasksRef.current[state.taskCursor];
    if (!task) return;
    if (!isTaskEditable(task)) {
      showHint(TOASTS.editOnlyQueued);
      return;
    }
    setEditingTask(task);
  }

  function requestEditQueue(): void {
    const state = appStore.getState();
    const name = state.queueDetail ? state.queueDetail.spec["name"] : filteredQueuesRef.current[state.queueCursor]?.["name"];
    if (typeof name !== "string") return;
    const spec = state.queueDetail && state.queueDetail.spec["name"] === name
      ? state.queueDetail.spec
      : state.queues.items.find((q) => q["name"] === name);
    if (!spec) return;
    setEditingQueueSpec(spec);
    appStore.dispatch({ type: "setMode", mode: "queueForm" });
  }

  /** job.status fetch (job.list's row projection strips most fields) right
   * before the schedule edit card opens, prefilled from the full spec. */
  function requestEditSchedule(): void {
    const job = jobsLocal.getState().items[jobsLocal.getState().cursor];
    if (!job) return;
    void jobs.getJob(job.name).then(spec => {
      const current = jobsLocal.getState();
      if (current.items[current.cursor]?.name !== job.name) return;
      if ((spec.schedule as { watch?: boolean } | undefined)?.watch) {
        showHint("Watch processes use job.update; the timed schedule form cannot edit them.");
        return;
      }
      setEditingJobSpec(spec);
    }).catch((e) => appStore.dispatch({ type: "commandError", message: String(e) }));
  }

  async function transferSchedule(action: "clone" | "export"): Promise<void> {
    const job = jobsLocal.getState().items[jobsLocal.getState().cursor];
    if (!job) return;
    try {
      const spec = await jobs.getJob(job.name);
      if (action === "clone") setLibrarySource(spec);
      else {
        const ok = await writeClipboard(exportSchedule(spec));
        appStore.dispatch({ type: "notice", message: ok ? "schedule copied; review prompts and commands before sharing" : "clipboard unavailable" });
      }
    } catch (e) { appStore.dispatch({ type: "commandError", message: String(e) }); }
  }

  /** mod+shift+c on the master list (no drill, schedules panel not focused) —
   * queue.delete is only OFFERED once the client's OWN counts already show
   * zero pending/in-progress/blocked; a stale count is still caught by the
   * engine's own guard (commands.coord.deleteQueue surfaces that inline+toast
   * too). Refused upfront the SAME way — inline hint + toast, never silent. */
  function requestDeleteQueue(): void {
    const state = appStore.getState();
    const name = filteredQueuesRef.current[state.queueCursor]?.["name"];
    if (typeof name !== "string") return;
    const counts = countsByQueue[name];
    const pending = num(counts?.["pending"]) + num(counts?.["in_progress"]) + num(counts?.["blocked"]);
    if (pending > 0) {
      const message = TOASTS.queueDeleteHasPending(name, pending);
      showHint(message);
      appStore.dispatch({ type: "commandError", message });
      return;
    }
    appStore.dispatch({ type: "confirm", confirm: { kind: "deleteQueue", name } });
  }

  // W18 (F16 task workflows): `w` opens the read-only WorkflowCard for
  // whichever queue is currently selected — a no-op with none selected.
  // Re-toggles (the opener-key convention): pressing `w` again closes it.
  function toggleWorkflowCard(): void {
    if (!appStore.getState().queueDetail) return;
    workflowsLocal.set({ cardOpen: !workflowsLocal.getState().cardOpen });
  }

  // QUEUE-PAUSE: mod+k on the master list — acts on whichever queue is under the
  // cursor (mirrors requestEditQueue's own name resolution: prefer the open
  // drill's spec when it matches, else the master row). Non-destructive, so no
  // ConfirmCard gate (unlike delete) — a pause is instantly reversible.
  function requestTogglePause(): void {
    const state = appStore.getState();
    const name = state.queueDetail ? state.queueDetail.spec["name"] : filteredQueuesRef.current[state.queueCursor]?.["name"];
    if (typeof name !== "string") return;
    const spec = state.queueDetail && state.queueDetail.spec["name"] === name
      ? state.queueDetail.spec
      : state.queues.items.find((q) => q["name"] === name);
    const paused = spec?.["paused"] === true;
    void (paused ? coord.resumeQueue(name) : coord.pauseQueue(name));
  }

  // ---- W15 schedules panel actions -----------------------------------------
  function toggleSelectedJob(): void {
    const job = jobsLocal.getState().items[jobsLocal.getState().cursor];
    if (!job) return;
    // F05: bare space already drives the enable toggle — a dead-lettered row reuses it for
    // requeue instead of adding a second chord, since the job is stopped and "on/off" no
    // longer applies.
    // F05.UI (QA UI-3): gated behind a ConfirmCard like every other schedule mutation — the
    // wording is what makes "requeue" mean "re-arm the next occurrence" rather than "retry that
    // failed run", which is how the bare press read sitting under the failed history row.
    if (job.failure?.deadLetterAt != null) {
      jobsLocal.set({ confirmRequeue: job.name });
      return;
    }
    void jobs.toggleEnabled(job.name, !job.enabled);
  }

  function runSelectedJob(): void {
    const job = jobsLocal.getState().items[jobsLocal.getState().cursor];
    if (!job) return;
    void jobs.runNow(job.name);
  }

  function requestDeleteJob(): void {
    const job = jobsLocal.getState().items[jobsLocal.getState().cursor];
    if (!job) return;
    jobsLocal.set({ confirmDelete: job.name });
  }

  const selectJob = (i: number): void => jobsLocal.set({ focused: true, cursor: i });

  /** mod+shift+c — cancel the cursor task inside a drill; on the master list (no
   * drill, schedules panel not focused) it now means "delete queue" instead
   * (W16/F15/D11 — schedules keep their OWN mod+shift+x delete, a separate chord). */
  function requestCancel(): void {
    const state = appStore.getState();
    if (!taskFocusedRef.current || !state.queueDetail) {
      if (!jobsLocal.getState().focused) requestDeleteQueue();
      return;
    }
    const task = filteredTasksRef.current[state.taskCursor];
    if (!task) return;
    const taskId = task["taskId"];
    const queue = state.queueDetail.spec["name"];
    if (typeof taskId !== "string" || typeof queue !== "string") return;
    if (task["state"] !== "pending") {
      // B9: cancel is only offered for pending; a running task is killed via
      // its agent (agent_kill → the task settles as failed).
      showHint(TOASTS.cancelOnlyPending);
      return;
    }
    appStore.dispatch({ type: "confirm", confirm: { kind: "cancelTask", taskId, queue } });
  }

  // `p` — pin/unpin the SELECTED task row into the PinnedBar (F01). Only in
  // the drill (a task row must be under the cursor); a task pin's live fields
  // resolve off the event ring (PinnedBar.taskPinView).
  function pinSelectedTask(): void {
    const state = appStore.getState();
    if (!taskFocusedRef.current || !state.queueDetail) return;
    const task = filteredTasksRef.current[state.taskCursor];
    const taskId = task?.["taskId"];
    if (typeof taskId !== "string" || taskId.length === 0) return;
    systemCommands(appStore, rpcCall).togglePin({ type: "task", id: taskId });
  }

  const selectQueue = (i: number): void => {
    const cur = appStore.getState().queueCursor;
    if (i === cur) { setQueueDetailCollapsed((c) => toggleCollapsed(i, cur, c)); return; }
    appStore.dispatch({ type: "queueCursor", delta: i - cur });
    jobsLocal.set({ focused: false }); // a click on the queue list hands ↑↓ back to it
    setTaskFocused(false); // …and back to the master list, not the task sub-list
  };

  const selectTask = (i: number): void => {
    const cur = appStore.getState().taskCursor;
    if (i === cur) { setTaskDetailCollapsed((c) => toggleCollapsed(i, cur, c)); return; }
    appStore.dispatch({ type: "taskCursor", delta: i - cur });
    setTaskFocused(true);
  };

  const pinTask = (i: number): void => {
    const cur = appStore.getState().taskCursor;
    if (i !== cur) appStore.dispatch({ type: "taskCursor", delta: i - cur });
    taskFocusedRef.current = true;
    setTaskFocused(true);
    runAction("queues.pin", appStore);
  };

  /** raw.pushedBy → display: the conductor reads "main" (mock), other agents
   * their short id, a human/direct push (null) stays "—" in the inspector. */
  const pushedByLabelOf = (raw: Record<string, unknown>): string | null => {
    const id = raw["pushedBy"];
    if (typeof id !== "string" || id.length === 0) return null;
    const s = appStore.getState();
    return s.agents[id]?.conductor || id === s.mainConductorId ? "main" : shortId(id);
  };

  const detailName = detail ? str(detail.spec["name"]) : null;
  const detailTeam = useMemo(
    () => (detailName === null ? null : teams.items.find((t) => t["queue"] === detailName) ?? null),
    [teams.items, detailName],
  );
  const confirmTask = confirm?.kind === "cancelTask" && detail
    ? detail.tasks.find((t) => t["taskId"] === confirm.taskId)
    : undefined;

  // W18 (F16 task workflows): the SELECTED queue's default binding, resolved
  // against the loaded workflow registry (queue.spec.workflow is a bare name —
  // the exact version is only pinned per-TASK at pickup, see
  // selectors.workflows' doc comments).
  const queueWorkflowName = detail && typeof detail.spec["workflow"] === "string" ? (detail.spec["workflow"] as string) : null;
  const queueWorkflow = queueWorkflowName ? workflowItems.find((w) => w.name === queueWorkflowName) ?? null : null;
  // QUEUE-WORKFLOW-OVERLAY-BLIND: the queue spec is only HALF the story — queue.push's per-task
  // `workflow` override pins {name,version} onto the TaskRecord and never touches the spec, so a
  // queue running nothing but overridden tasks looked workflow-less in the `w` overlay. Collect
  // the distinct bindings actually live on its tasks so the card can report what is in effect.
  const taskBoundWorkflows = useMemo(() => {
    const counts = new Map<string, { name: string; version: number; taskCount: number }>();
    for (const raw of detail?.tasks ?? []) {
      const binding = taskWorkflowBinding(raw as Record<string, unknown>);
      if (!binding) continue;
      const key = `${binding.name}@${binding.version}`;
      const hit = counts.get(key);
      if (hit) hit.taskCount += 1;
      else counts.set(key, { name: binding.name, version: binding.version, taskCount: 1 });
    }
    return [...counts.values()].sort((a, b) => b.taskCount - a.taskCount || a.name.localeCompare(b.name));
  }, [detail]);

  return (
    <div className={styles.screen}>
    <div data-screen-layout="split" className={styles.row} {...pane.rowProps}>
      <div className={styles.leftCol}>
      <Panel
        label={<>queues <span className={styles.countMeta}>({queues.items.length})</span></>}
        className={styles.master}
      >
        <SearchBox
          value={queueQuery}
          onChange={setQueueQuery}
          placeholder="search queues"
          count={{ shown: filteredQueues.length, total: sortedQueues.length, noun: "queues" }}
          dataAttr="queues-search"
        />
        <div className={styles.colHead}>
          <div className={styles.colQueue}>queue</div>
          <div className={styles.colPending}>pending</div>
          <div className={styles.colActive}>active</div>
          <div className={styles.colBacklog}>backlog</div>
        </div>
        {!queues.available ? (
          <div className={styles.emptyHint}>queues require a Phase 2 daemon</div>
        ) : queues.items.length === 0 ? (
          <div className={styles.emptyHint}>{`no queues — ${displayChord("mod+o")} creates one`}</div>
        ) : filteredQueues.length === 0 ? (
          <div className={styles.emptyHint}>no queues match</div>
        ) : (
          filteredQueues.map((q, i) => {
            const name = str(q["name"]);
            const counts = countsByQueue[name];
            const pending = num(counts?.["pending"]);
            const active = num(counts?.["in_progress"]);
            const ratio = backlogRatio(counts);
            return (
              <div
                key={name || i}
                className={i === queueCursor ? styles.rowSelected : styles.rowItem}
                onClick={() => selectQueue(i)}
                onDoubleClick={() => { selectQueue(i); setTaskFocused(true); }}
                onKeyDown={onRowKeyDown(() => selectQueue(i))}
                role="button"
                tabIndex={0}
                data-queue-row={name}
              >
                <div className={styles.colQueue}>
                  <span className={i === queueCursor ? undefined : styles.softName}>{name}</span>
                  <span className={styles.retryMeta}> · retry {num(q["retryLimit"])}</span>
                  {q["paused"] === true && <span className={styles.toneWarn}> ⏸ paused</span>}
                </div>
                <div className={styles.colPending}>
                  <span className={pending > 0 ? styles.toneWarn : styles.faintCell}>{pending}</span>
                </div>
                <div className={styles.colActive}>
                  <span className={active > 0 ? styles.toneSuccess : styles.faintCell}>{active}</span>
                </div>
                <div className={styles.colBacklog}>
                  <span className={styles.meterTrack}>
                    <span
                      className={ratio > 0 ? styles.meterFillWarn : styles.meterFillOk}
                      style={{ width: `${Math.round(ratio * 100)}%` }}
                    />
                  </span>
                </div>
              </div>
            );
          })
        )}
        <div className={styles.filler} />
        <PanelFooter>
          <div className={styles.footerRow}>
            <span className={hint !== null && !detail ? styles.toneWarn : undefined}>
              {hint !== null && !detail ? hint : "↑↓ select · enter focus tasks"}
            </span>
            <ActionChipRow
              chips={[
                { key: displayChord("mod+o"), label: "new", onClick: togglePushForm },
                { key: displayChord("mod+e"), label: "edit", onClick: requestEditQueue, disabled: queues.items.length === 0 },
                { key: "w", label: "workflow", onClick: () => runAction("queues.workflow", appStore), disabled: queues.items.length === 0 },
                { key: displayChord("mod+k"), label: selectedQueuePaused ? "resume" : "pause", onClick: requestTogglePause, disabled: queues.items.length === 0 },
                { key: displayChord("mod+shift+c"), label: "delete", danger: true, onClick: requestDeleteQueue, disabled: queues.items.length === 0 },
              ]}
            />
          </div>
        </PanelFooter>
      </Panel>

      <Panel
        label={<>schedules <span className={styles.countMeta}>({jobItems.length})</span></>}
        className={styles.schedules}
        focused={jobsFocused}
      >
        {gapBanner !== null ? (
          <div
            className={gapBanner.tone === "warn" ? styles.clockJumpNoteWarn : styles.clockJumpNote}
            data-schedule-gap-tone={gapBanner.tone}
          >
            {gapBanner.text}
          </div>
        ) : null}
        <div className={styles.jobColHead}>
          <div className={styles.colLead} />
          <div className={styles.colJob}>job</div>
          <div className={styles.colSchedule}>schedule</div>
          <div className={styles.colNextRun}>next run</div>
          <div className={styles.colLastResult}>last result</div>
        </div>
        {jobItems.length === 0 && !jobsLoaded ? (
          <div className={styles.emptyHint}>loading schedules…</div>
        ) : jobItems.length === 0 && jobListError !== null ? (
          <div className={styles.emptyHint}>{`could not load schedules — ${jobListError}`}</div>
        ) : jobItems.length === 0 ? (
          <div className={styles.emptyHint}>{`no schedules — ${displayChord("mod+o")} creates one`}</div>
        ) : (
          jobItems.map((job, i) => (
            <JobRowView
              key={job.name || i}
              job={job}
              now={nowTick}
              selected={jobsFocused && i === jobCursor}
              onSelect={() => selectJob(i)}
              onOpenRun={() => void jobs.openRun(job)}
            />
          ))
        )}
        <div className={styles.filler} />
        <PanelFooter>
          <ActionChipRow
            chips={[
              { key: displayChord("mod+o"), label: "new", onClick: () => jobsLocal.set({ formOpen: !jobsLocal.getState().formOpen }) },
              { key: displayChord("mod+e"), label: "edit", onClick: requestEditSchedule, disabled: jobItems.length === 0 },
              { key: "", label: "clone", onClick: () => void transferSchedule("clone"), disabled: jobItems.length === 0 },
              { key: "", label: "export", onClick: () => void transferSchedule("export"), disabled: jobItems.length === 0 },
              { key: "", label: "import", onClick: () => setLibrarySource(null) },
              { key: "", label: "snooze 1h", onClick: () => { if (selectedJob) void jobs.updateJob(selectedJob.name, { snoozedUntil: Date.now() + 3600000 }).catch(e => appStore.dispatch({ type: "commandError", message: String(e) })); }, disabled: !selectedJob?.enabled || !!selectedJob?.watch },
              { key: "", label: "unsnooze", onClick: () => { if (selectedJob) void jobs.updateJob(selectedJob.name, { snoozedUntil: null }).catch(e => appStore.dispatch({ type: "commandError", message: String(e) })); }, disabled: !selectedJob },
              { key: "space", label: selectedJob?.failure?.deadLetterAt != null ? "requeue" : "on/off", onClick: toggleSelectedJob, disabled: jobItems.length === 0 },
              { key: displayChord("mod+r"), label: "run now", onClick: runSelectedJob, disabled: jobItems.length === 0 },
              { key: displayChord("mod+shift+x"), label: "delete", danger: true, onClick: requestDeleteJob, disabled: jobItems.length === 0 },
            ]}
          />
        </PanelFooter>
      </Panel>
      </div>

      {/* PANE-RESIZE: the seam, in place of the gap. */}
      {pane.divider}
      <Panel label={scheduleFocused ? `schedule · ${selectedJob!.name}` : detailName ? `queue · ${detailName}` : "queue"} className={styles.detail}>
        {scheduleFocused ? (
          <Collapse open fill>
            <ScheduleDetail key={selectedJob!.name} row={selectedJob!} spec={jobSpec} error={jobDetailError} now={nowTick} events={events} onRetry={() => void jobs.loadJobs()} onOpenRun={(run) => void jobs.openRun(selectedJob!, run)} />
          </Collapse>
        ) : detail === null ? (
          <div className={styles.emptyPane}>
            <div className={styles.emptyGlyph}>◆</div>
            <div className={styles.emptyHint}>no queue selected</div>
          </div>
        ) : (
          <Collapse open={!queueDetailCollapsed} fill>
            <div className={styles.detailHead}>
              <div className={styles.detailTitleRow}>
                <span className={styles.detailName}>{detailName}</span>
                <span className={styles.retryLimitMeta}>retry limit {num(detail.spec["retryLimit"])}</span>
                {detail.spec["paused"] === true && <span className={styles.toneWarn}> ⏸ paused</span>}
                <span className={styles.spacer} />
                <span className={styles.toneWarn}>{num(detail.counts["pending"])} pending</span>
              </div>
              <div className={styles.countsRow}>
                {TASK_STATES.map((s) => (
                  <span key={s} className={toneClass[countTone(s)]}>{s} {num(detail.counts[s])}</span>
                ))}
                <span className={styles.backlogChip}>
                  backlog{" "}
                  <span className={styles.meterTrackWide}>
                    <span className={styles.meterFillOk} style={{ width: `${backlogPct(detail.counts)}%` }} />
                  </span>{" "}
                  {backlogPct(detail.counts)}%
                </span>
              </div>
            </div>
            {detailName && <IssueSources key={detailName} queue={detailName} onCreated={() => setQueueQuery("")} />}
            <SearchBox
              value={taskQuery}
              onChange={setTaskQuery}
              placeholder="search tasks (id · role · agent · prompt)"
              count={{ shown: filteredTasks.length, total: sortedTasks.length, noun: "tasks" }}
              dataAttr="tasks-search"
            />
            <div className={styles.sortToggle} data-task-sort-mode={taskSort}>
              <span>sort:</span>
              <span
                className={taskSort === "newest" ? styles.sortOptionActive : styles.sortOption}
                data-sort-option="newest"
                onClick={() => setTaskSort("newest")}
              >
                newest
              </span>
              <span
                className={taskSort === "drain" ? styles.sortOptionActive : styles.sortOption}
                data-sort-option="drain"
                onClick={() => setTaskSort("drain")}
              >
                drain order (priority · FIFO)
              </span>
            </div>
            <div className={styles.orderingNote}>
              priority only breaks ties among tasks already READY to run — to say "run this after
              those others", add a dependency (below), not a higher/lower priority
            </div>
            <div className={styles.taskHead}>
              <div className={styles.colLead} />
              <div className={styles.colPos}>pos</div>
              <div className={styles.colState}>state</div>
              <div className={styles.colTask}>task</div>
              <div className={styles.colRole}>role</div>
              <div className={styles.colAgent}>agent</div>
              <div className={styles.colTry}>try</div>
              <div className={styles.colStep}>step</div>
              <div className={styles.colPrompt}>prompt</div>
            </div>
            <div className={styles.tasksBody}>
            {sortedTasks.length === 0 ? (
              <div className={styles.emptyHint}>{`no tasks — ${displayChord("mod+o")} pushes one`}</div>
            ) : filteredTasks.length === 0 ? (
              <div className={styles.emptyHint}>no tasks match</div>
            ) : (
              filteredTasks.map((raw, i) => {
                const t = taskRowView(raw);
                const retryLimit = num(detail.spec["retryLimit"]);
                const selected = i === taskCursor;
                // W18 (F16 task workflows): optimistic overlay (the newest
                // task_step_advanced/_failed for this task) merged over the
                // fetched record — reconciled automatically once the queue.
                // status refetch latestCoordSeq triggers lands (raw catches
                // up and the overlay becomes a no-op).
                const overlaidRaw = overlayTaskStep(raw, latestStepEvent(events, t.taskId));
                const workflow = workflowFor(taskWorkflowBinding(overlaidRaw), workflowItems);
                const meter = stepMeterView(overlaidRaw, workflow);
                return (
                  <div key={t.taskId || i}>
                    <div
                      className={selected ? styles.taskRowSelected : styles.taskRow}
                      onClick={() => selectTask(i)}
                      onDoubleClick={() => { if (t.agentId) coord.openAgent(t.agentId); }}
                      onKeyDown={onRowKeyDown(() => selectTask(i))}
                      role="button"
                      tabIndex={0}
                      data-task-row={t.taskId}
                    >
                      <div className={styles.colLead}>
                        <button
                          type="button"
                          className={styles.pinButton}
                          aria-label={pins.some((pin) => pin.type === "task" && pin.id === t.taskId) ? "unpin task" : "pin task"}
                          title="pin task"
                          data-queue-action="queues.pin"
                          data-pin-task={t.taskId}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            pinTask(i);
                          }}
                        >
                          {pins.some((pin) => pin.type === "task" && pin.id === t.taskId) ? "★" : "☆"}
                        </button>
                      </div>
                      <div className={styles.colPos} data-task-pos={t.taskId}>
                        {isTaskReorderable(raw) && taskPositions.get(t.taskId) !== undefined ? (
                          <>
                            <span className={styles.posBadge}>{taskPositions.get(t.taskId)}</span>
                            {taskSort === "drain" && detailName !== null && (
                              <span className={styles.moveButtons}>
                                <button
                                  type="button"
                                  className={styles.moveButton}
                                  aria-label="move up"
                                  data-move-up={t.taskId}
                                  disabled={taskPositions.get(t.taskId) === 1}
                                  onClick={(ev) => { ev.stopPropagation(); void coord.moveTask(t.taskId, detailName, "up"); }}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  className={styles.moveButton}
                                  aria-label="move down"
                                  data-move-down={t.taskId}
                                  disabled={taskPositions.get(t.taskId) === taskPositions.size}
                                  onClick={(ev) => { ev.stopPropagation(); void coord.moveTask(t.taskId, detailName, "down"); }}
                                >
                                  ↓
                                </button>
                              </span>
                            )}
                          </>
                        ) : null}
                      </div>
                      <div className={`${styles.colState} ${toneClass[countTone(t.state)]}`}>{t.state}</div>
                      <div className={`${styles.colTask} ${styles.mutedCell}`}>{t.taskId}</div>
                      <div className={`${styles.colRole} ${styles.mutedCell}`}>{t.role}</div>
                      <div className={t.agentId ? `${styles.colAgent} ${styles.mutedCell}` : `${styles.colAgent} ${styles.faintCell}`}>
                        {t.agentId ? shortId(t.agentId) : "—"}
                      </div>
                      <div className={`${styles.colTry} ${t.state === "failed" ? styles.toneDanger : styles.mutedCell}`}>
                        {t.attempts}/{retryLimit}
                      </div>
                      <div className={`${styles.colStep} ${styles.mutedCell}`} data-step-meter={t.taskId}>
                        {meter ? `${meter.glyph} ${meter.label}` : ""}
                      </div>
                      <div className={styles.colPrompt}>
                        <span className={selected ? undefined : styles.softName}>{t.prompt}</span>
                        {detailName && <IssueChip queue={detailName} taskId={t.taskId} />}
                        {t.state === "failed" && t.error !== null && (
                          <span className={styles.toneDanger}> ✗ {t.error}</span>
                        )}
                      </div>
                    </div>
                    <Collapse open={selected && !taskDetailCollapsed}>
                      {selected ? (
                        <TaskInspector
                          task={t}
                          raw={raw}
                          retryLimit={retryLimit}
                          team={detailTeam}
                          library={roles.items}
                          pushedByLabel={pushedByLabelOf(raw)}
                          workflow={workflow}
                          stepTimestamps={stepTimestamps(events, t.taskId)}
                          stepHandoffs={stepHandoffIndices(events, t.taskId)}
                          onOpenAgent={(agentId) => coord.openAgent(agentId)}
                          onOpenWorkflowGraph={workflow ? () => appStore.dispatch({ type: "workflowStudioOpen", mode: "inspect", document: workflowDocumentFromRow(workflow), queue: detailName, taskId: str(raw["taskId"]), version: taskWorkflowBinding(raw)?.version }) : undefined}
                          artifacts={taskArtifacts}
                          artifactDiffMeta={taskArtifactDiffMeta}
                          onOpenEvidence={() => { void openReviewRoom(appStore, rpcCall, t.taskId); }}
                          evidenceOpen={false}
                          evidence={null}
                          evidenceLoading={false}
                          evidenceError={null}
                          dependencies={dependencyRows(raw, detail.tasks)}
                          onRetryTask={isTaskRetryable(raw) && detailName !== null
                            ? () => void coord.retryTask(t.taskId, detailName)
                            : undefined}
                        />
                      ) : null}
                    </Collapse>
                  </div>
                );
              })
            )}
            </div>
            <PanelFooter>
              {hint !== null ? <span className={styles.toneWarn}>{hint}</span> : `↑↓ task · ${displayChord("mod+e")} edit (queued) · ${displayChord("mod+shift+c")} cancel · ${displayChord("mod+o")} push · w workflow · esc back to queues`}
            </PanelFooter>
          </Collapse>
        )}
        {mode === "pushForm" && pushQueue !== null && (
          <PushTaskCard
            queue={pushQueue}
            defaultRole={detailTeam ? Object.keys((detailTeam["roles"] as Record<string, unknown> | undefined) ?? {})[0] : undefined}
            defaultWorkflow={queueWorkflowName}
            onSubmit={(params) => coord.pushTask(params as Record<string, unknown> & { queue: string })}
            onClose={() => {
              appStore.dispatch({ type: "setMode", mode: "normal" });
              appStore.dispatch({ type: "pushQueue", queue: null });
            }}
          />
        )}
        {editingTask !== null && detailName !== null && (
          <EditTaskCard
            taskId={str(editingTask["taskId"])}
            queue={detailName}
            initial={editFormValuesFromTask(editingTask)}
            onSubmit={(patch) => coord.editTask({ taskId: str(editingTask["taskId"]), queue: detailName, patch })}
            onClose={() => setEditingTask(null)}
          />
        )}
        {workflowCardOpen && detailName !== null && (
          <WorkflowCard
            queueName={detailName}
            workflow={queueWorkflow}
            taskBound={taskBoundWorkflows}
            onNew={() => { const row = workflowRow({ name: "new-workflow", version: 1, createdAt: Date.now(), onFail: "halt", retryLimit: 0, steps: [{ id: "step-1", title: "First step", gate: { kind: "none" } }] }); appStore.dispatch({ type: "workflowStudioOpen", mode: "author", document: workflowDocumentFromRow(row), queue: detailName, version: null }); workflowsLocal.set({ cardOpen: false }); }}
            onEdit={() => { if (queueWorkflow) { appStore.dispatch({ type: "workflowStudioOpen", mode: "author", document: workflowDocumentFromRow(queueWorkflow), queue: detailName, version: queueWorkflow.version }); workflowsLocal.set({ cardOpen: false }); } }}
            onDelete={() => { if (queueWorkflow) workflowsLocal.set({ cardOpen: false, confirmDelete: queueWorkflow.name }); }}
            onOpenStudio={() => { if (queueWorkflow) { appStore.dispatch({ type: "workflowStudioOpen", mode: "author", document: workflowDocumentFromRow(queueWorkflow), queue: detailName, version: queueWorkflow.version }); workflowsLocal.set({ cardOpen: false }); } }}
            onClose={() => workflowsLocal.set({ cardOpen: false })}
          />
        )}
        {workflowConfirmDelete !== null && (
          <ConfirmCard
            title="⚠ delete workflow"
            meta={workflowConfirmDelete}
            body={CONFIRMS.deleteWorkflow(workflowConfirmDelete).body}
            note={CONFIRMS.deleteWorkflow(workflowConfirmDelete).note}
            confirmLabel="confirm delete"
            onConfirm={() => {
              const name = workflowConfirmDelete;
              void workflowsCmd.deleteWorkflow(name);
            }}
            onClose={() => workflowsLocal.set({ confirmDelete: null })}
          />
        )}
        {workflowFormOpen && (
          <WorkflowFormCard
            initial={(() => {
              const editingRow = workflowEditing ? workflowItems.find((w) => w.name === workflowEditing) ?? null : null;
              return editingRow ? workflowFormValuesFromRow(editingRow) : undefined;
            })()}
            bindQueue={workflowEditing ? null : detailName}
            onSubmit={async (payload, bind) => {
              if (workflowEditing) {
                await workflowsCmd.updateWorkflow(workflowEditing, (payload as { patch: Record<string, unknown> }).patch);
              } else {
                await workflowsCmd.createWorkflow(payload as Record<string, unknown>, bind && detailName ? detailName : undefined);
              }
              await coord.refresh(); // picks up a fresh queue.spec.workflow when `bind` just changed it
            }}
            onClose={() => workflowsLocal.set({ formOpen: false, editing: null })}
          />
        )}
        {confirm?.kind === "cancelTask" && (
          <ConfirmCard
            title="⚠ cancel task"
            meta={confirm.taskId}
            body={CONFIRMS.cancelTask(confirmTask ? str(confirmTask["prompt"]) : confirm.taskId).body}
            note={CONFIRMS.cancelTask(confirmTask ? str(confirmTask["prompt"]) : confirm.taskId).note}
            confirmLabel="confirm cancel"
            onConfirm={() => {
              const { taskId, queue } = confirm;
              appStore.dispatch({ type: "confirm", confirm: null });
              void coord.cancelTask(taskId, queue);
            }}
            onClose={() => appStore.dispatch({ type: "confirm", confirm: null })}
          />
        )}
        <OverlayOutlet host="queues" />
      </Panel>

      {librarySource !== undefined && <ScheduleLibraryCard source={librarySource ?? undefined} onSubmit={spec => jobs.createJob(spec)} onClose={() => setLibrarySource(undefined)} />}
      {jobFormOpen && (
        <ScheduleFormCard
          onSubmit={(spec) => jobs.createJob(spec)}
          onClose={() => jobsLocal.set({ formOpen: false })}
        />
      )}
      {editingJobSpec !== null && (
        <ScheduleFormCard
          mode="edit"
          initial={scheduleFormValuesFromSpec(editingJobSpec)}
          onSubmit={(patch) => jobs.updateJob(str(editingJobSpec["name"]), patch)}
          onClose={() => setEditingJobSpec(null)}
        />
      )}
      {confirmDeleteJob !== null && (
        <ConfirmCard
          title="⚠ delete schedule"
          meta={confirmDeleteJob}
          body={CONFIRMS.deleteJob(confirmDeleteJob).body}
          note={CONFIRMS.deleteJob(confirmDeleteJob).note}
          confirmLabel="confirm delete"
          onConfirm={() => {
            const name = confirmDeleteJob;
            jobsLocal.set({ confirmDelete: null });
            void jobs.deleteJob(name);
          }}
          onClose={() => jobsLocal.set({ confirmDelete: null })}
        />
      )}
      {confirmRequeueJob !== null && (() => {
        const row = jobItems.find((j) => j.name === confirmRequeueJob);
        const failed = row?.failure?.attempt ?? 0;
        return (
          <ConfirmCard
            title="↻ requeue schedule"
            meta={confirmRequeueJob}
            body={CONFIRMS.requeueJob(confirmRequeueJob, failed).body}
            note={CONFIRMS.requeueJob(confirmRequeueJob, failed).note}
            confirmLabel="confirm requeue"
            onConfirm={() => {
              const name = confirmRequeueJob;
              jobsLocal.set({ confirmRequeue: null });
              void jobs.requeueJob(name);
            }}
            onClose={() => jobsLocal.set({ confirmRequeue: null })}
          />
        );
      })()}
      {mode === "queueForm" && editingQueueSpec === null && (
        <QueueFormCard
          onSubmit={(spec) => coord.createQueue(spec)}
          onClose={closeQueueForm}
        />
      )}
      {mode === "queueForm" && editingQueueSpec !== null && (
        <QueueFormCard
          mode="edit"
          initial={queueFormValuesFromSpec(editingQueueSpec)}
          onSubmit={(patch) => coord.updateQueue(str(editingQueueSpec["name"]), patch)}
          onClose={closeQueueForm}
        />
      )}
      {confirm?.kind === "deleteQueue" && (
        <ConfirmCard
          title="⚠ delete queue"
          meta={confirm.name}
          body={CONFIRMS.deleteQueue(confirm.name).body}
          note={CONFIRMS.deleteQueue(confirm.name).note}
          confirmLabel="confirm delete"
          onConfirm={() => {
            const name = confirm.name;
            appStore.dispatch({ type: "confirm", confirm: null });
            void coord.deleteQueue(name);
          }}
          onClose={() => appStore.dispatch({ type: "confirm", confirm: null })}
        />
      )}
    </div>
    </div>
  );
}

function JobRowView({ job, now, selected, onSelect, onOpenRun }: {
  job: JobRow;
  // F02.UI: the screen's display clock, not Date.now() at render — a panel that only re-renders
  // on an event would otherwise freeze "in 4m" at whatever it said when the last event arrived.
  now: number;
  selected: boolean;
  onSelect: () => void;
  onOpenRun: () => void;
}) {
  const tone = job.lastRun ? resultTone(job.lastRun.result) : null;
  return (
    <div
      className={selected ? styles.rowSelected : styles.rowItem}
      onClick={onSelect}
      onKeyDown={onRowKeyDown(onSelect)}
      role="button"
      tabIndex={0}
      data-job-row={job.name}
    >
      <div className={styles.colLead}>
        <span className={job.enabled ? styles.toneSuccess : styles.faintCell}>{job.enabled ? "●" : "○"}</span>
      </div>
      <div className={styles.colJob}>
        <span className={selected ? undefined : styles.softName}>{job.name}</span>
        <span className={styles.retryMeta}> · {job.targetLabel}</span>
      </div>
      <div className={`${styles.colSchedule} ${styles.mutedCell}`}>{job.scheduleLabel}</div>
      <div
        className={`${styles.colNextRun} ${job.failure?.deadLetterAt != null ? styles.toneDanger : job.enabled ? styles.mutedCell : styles.faintCell}`}
      >
        {jobStateLabel(job, now)}
      </div>
      <div
        className={`${styles.colLastResult} ${tone ? toneClass[tone] : styles.faintCell}`}
        onClick={(e) => { e.stopPropagation(); if (job.lastRun) onOpenRun(); }}
        data-job-last-run={job.name}
      >
        {lastResultLabel(job.lastRun)}
        {job.lastRun && <span className={styles.retryMeta}> · {relativeLabel(job.lastRun.ts - now)}</span>}
      </div>
    </div>
  );
}
