// W15 (F14 schedules panel, coverage B19/C12) — job.* command wrappers + their
// screen-local store. job.list/create/update/delete/runNow have NO ui-state
// slot (jobs/schedules are an app-only surface, mirroring commands.projects.ts's
// own module-local store precedent), so the panel's rows/cursor/overlay flags
// live here. Structured like commands.projects.ts: a PURE factory over
// injected deps so the behaviors are unit-testable against stub stores; the
// Queues screen binds the singleton with the real appStore + rpcCall via
// getJobsCommands.
import { useSyncExternalStore } from "react";
import type { QueueStatusView, UiStore } from "@chimera/ui-state";
import type { RequestFn } from "./commands.coord";
import { jobRow, requeueNoticeLabel, runNowNoticeLabel, type JobRow, type JobRunView } from "./selectors.jobs";

const errMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
};

// ---------------------------------------------------------------------------
// the W15 local store
// ---------------------------------------------------------------------------

export type JobsLocalState = {
  items: JobRow[];
  cursor: number;
  /** true: the schedules panel owns ↑↓ (arrows fall off the bottom of the
   * queue master list into it); false: the queue list owns them. */
  focused: boolean;
  formOpen: boolean;             // ScheduleFormCard
  confirmDelete: string | null;  // job name awaiting the ConfirmCard gate
  /** F05.UI: false until the first job.list settles, so an empty panel can say "loading" instead
   * of claiming there are no schedules; `listError` holds the reason the last list failed (null on
   * success) so the panel can say THAT rather than "no schedules". */
  loaded: boolean;
  listError: string | null;
  /** F05.UI: job name awaiting the requeue ConfirmCard — a separate slot from confirmDelete so
   * the two gates can never be confused for one another by a stale key. */
  confirmRequeue: string | null;
};

const initialLocal: JobsLocalState = { items: [], cursor: 0, focused: false, formOpen: false, confirmDelete: null, confirmRequeue: null, loaded: false, listError: null };

export type JobsLocalStore = {
  getState(): JobsLocalState;
  set(patch: Partial<JobsLocalState>): void;
  subscribe(fn: () => void): () => void;
};

export function createJobsLocal(): JobsLocalStore {
  let state = initialLocal;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

/** The ONE app-wide W15 local store (module singleton — pure, no IO). */
export const jobsLocal: JobsLocalStore = createJobsLocal();

/** React binding — same selector discipline as useStore/useProjectsLocal. */
export function useJobsLocal<T>(selector: (s: JobsLocalState) => T): T {
  return useSyncExternalStore(jobsLocal.subscribe, () => selector(jobsLocal.getState()));
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export type JobsCommands = ReturnType<typeof createJobsCommands>;

export function createJobsCommands(local: JobsLocalStore, store: UiStore, request: RequestFn) {
  let listGeneration = 0;
  /** Fire-and-forget guard for keybinding-driven calls: an RPC rejection
   * surfaces as lastError (the footer's red line), never as a crash. */
  const guarded = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      store.dispatch({ type: "commandError", message: errMessage(err) });
    }
  };

  /** job.list is the sole source for every cell (schedule/next-run/last-run) —
   * a full relist on every relevant event is cheap and keeps the panel
   * trivially correct, mirroring the queues/projects screens' own
   * refresh-on-event cadence (no polling timers). */
  const loadJobs = async (): Promise<void> => {
    const generation = ++listGeneration;
    try {
      const items = (await request<Array<Record<string, unknown>>>("job.list", {})).map(jobRow);
      if (generation !== listGeneration) return;
      const current = local.getState();
      const selectedName = current.items[current.cursor]?.name;
      const selectedIndex = items.findIndex(item => item.name === selectedName);
      const cursor = selectedIndex >= 0 ? selectedIndex : Math.max(0, Math.min(current.cursor, items.length - 1));
      local.set({ items, cursor, loaded: true, listError: null });
    } catch (err) {
      if (generation !== listGeneration) return;
      // F05.UI: `loaded` flips even on failure — otherwise the panel would sit on "loading
      // schedules…" forever after one bad list. The reason is kept so the panel can show it
      // instead of the "no schedules yet" empty state, which would be a lie.
      local.set({ loaded: true, listError: errMessage(err) });
      store.dispatch({ type: "commandError", message: errMessage(err) });
    }
  };

  return {
    loadJobs,
    refresh: loadJobs,

    /** job.status — the full raw spec (job.list's row projection strips most
     * fields), fetched on-demand right before the "e" edit form opens. */
    getJob: (name: string): Promise<Record<string, unknown>> => request("job.status", { name }),

    /** job.create — REJECTS on failure (ScheduleFormCard shows the error inline). */
    createJob: async (spec: Record<string, unknown>): Promise<void> => {
      await request("job.create", { spec });
      await loadJobs();
    },

    /** job.update (D10, W16/F15 edit chip) — REJECTS on failure (ScheduleFormCard
     * inline error). A schedule/tz change recomputes nextRunTs daemon-side. */
    updateJob: async (name: string, patch: Record<string, unknown>): Promise<void> => {
      await request("job.update", { name, patch });
      await loadJobs();
    },

    /** space — job.update{patch:{enabled}}. Re-enabling a failure-disabled job
     * (D10: job_disabled after 3 consecutive failures) resets its
     * consecutiveFailures/disabledReason daemon-side. */
    toggleEnabled: (name: string, enabled: boolean): Promise<void> =>
      guarded(async () => {
        await request("job.update", { name, patch: { enabled } });
        await loadJobs();
      }),

    /** F05: space on a dead-lettered row — job.requeue clears `failure` and reschedules
     * from `failure.nominalRunTs` daemon-side, instead of the ordinary enable toggle.
     * F05.UI: the daemon emits no event for a requeue, so the toast below is the operator's only
     * receipt; a refusal (one-shot whose slot has passed, or a job that is not dead-lettered)
     * comes back as a rejection and `guarded` puts it on the footer's red line. */
    requeueJob: (name: string): Promise<void> =>
      guarded(async () => {
        const job = await request<Record<string, unknown> | null>("job.requeue", { name });
        const nextRunTs = job && typeof job["nextRunTs"] === "number" ? (job["nextRunTs"] as number) : null;
        store.dispatch({ type: "notice", message: requeueNoticeLabel(name, nextRunTs, Date.now()) });
        await loadJobs();
      }),

    /** r — job.runNow: bypasses the schedule but NOT the overlap guard, and NOT F04's
     * idempotency claim. A refusal comes back as `{started: false, reason}` — a 200, not an
     * error — so without this toast the keypress looks like a dead button. */
    runNow: (name: string): Promise<void> =>
      guarded(async () => {
        const res = await request<{ started?: boolean; reason?: string } | null>("job.runNow", { name });
        const notice = runNowNoticeLabel(name, res);
        if (notice) store.dispatch({ type: "notice", message: notice });
        await loadJobs();
      }),

    /** Destructive — only ever reached through the ConfirmCard gate. */
    deleteJob: (name: string): Promise<void> =>
      guarded(async () => {
        await request("job.delete", { name });
        await loadJobs();
      }),

    /** Run cell click-through — defaults to the job's last run, but accepts any
     * entry from the schedule detail pane's full run history so every row (not
     * just the newest) can jump to its agent/queue. An agent-target job's run
     * carries its own agentId (spawned directly) → straight to the Agents tab.
     * A team-target job's run only ever carries a taskId (JobScheduler.settleRun
     * stamps agentId:null for a queue-pushed run — see jobs.ts) — the closest
     * live view is that team's bound queue drill, where the task (pending,
     * running, or settled) is listed. */
    openRun: (job: JobRow, run: JobRunView | null = job.lastRun): Promise<void> =>
      guarded(async () => {
        if (!run) return;
        if (run.agentId) {
          store.dispatch({ type: "selectAgent", agentId: run.agentId });
          store.dispatch({ type: "selectTab", tab: "agents" });
          return;
        }
        if (run.taskId && job.targetTeam) {
          const status = await request<{ spec: Record<string, unknown> }>("team.status", { name: job.targetTeam });
          const queue = status.spec["queue"];
          if (typeof queue === "string") {
            const detail = await request<QueueStatusView>("queue.status", { queue });
            store.dispatch({ type: "queueDetail", detail });
          }
        }
      }),
  };
}

// The app-side singleton: bound lazily by the first caller with the deps IT
// imports — this module itself stays free of bridge/store imports for tests.
let singleton: JobsCommands | null = null;
export function getJobsCommands(store: UiStore, request: RequestFn): JobsCommands {
  if (!singleton) singleton = createJobsCommands(jobsLocal, store, request);
  return singleton;
}
