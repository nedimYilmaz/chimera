import { useSyncExternalStore } from "react";
import type { HistoryRunsResponse, RunHistoryCoverage, RunHistoryRow, RunKind, RunOutcome } from "@chimera/protocol";
import {
  EMPTY_RUN_HISTORY_FILTER,
  RUN_HISTORY_WINDOWS,
  type QueueStatusView,
  type RunCostBasis,
  type RunHistoryFilter,
  type RunHistoryTotals,
  type RunHistoryWindow,
  type UiStore,
} from "@chimera/ui-state";
import { errorText } from "./errorText";

type RequestFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

// The window map is ui-state's so the TUI overlay and this screen mean the same
// thing by "24h"; re-exported here because the screen already imports from this module.
export { RUN_HISTORY_WINDOWS };
export type { RunHistoryWindow };

// A page of history.runs plus the chip filter. KIND and OUTCOME chips are sent to the
// daemon and cost a round trip on purpose (F13.QA M-3): the page is capped at `limit`, so
// re-filtering it client-side hides matches that never made it into the page — wrong
// numbers, not just stale ones. Every other chip (team/basis/text/new) stays a pure
// re-filter of this page via ui-state's filterRuns, and costs nothing.
export type RunHistoryState = {
  window: RunHistoryWindow;
  filter: RunHistoryFilter;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  rows: RunHistoryRow[];
  matched: number;
  /** Server-side fold over the FULL matched set — the header reads this, not the page. */
  totals: RunHistoryTotals | null;
  coverage: RunHistoryCoverage | null;
  lastUpdated: number | null;
};

const initial: RunHistoryState = {
  window: "24h",
  filter: EMPTY_RUN_HISTORY_FILTER,
  loading: false,
  loaded: false,
  error: null,
  rows: [],
  matched: 0,
  totals: null,
  coverage: null,
  lastUpdated: null,
};

// Toggle semantics for the chip rows: clicking an active chip clears it, so an
// empty array always reads as "all" (EMPTY_RUN_HISTORY_FILTER's contract).
const toggle = <T,>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

export function createRunHistoryCommands(request: RequestFn, now: () => number = Date.now, store: UiStore | null = null) {
  let state = initial;
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let burstTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<RunHistoryState>) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  const refresh = async () => {
    const gen = ++generation;
    const to = now();
    const from = to - RUN_HISTORY_WINDOWS[state.window];
    set({ loading: true, error: null });
    try {
      const { kinds, outcome } = state.filter;
      const res = await request<HistoryRunsResponse>("history.runs", {
        from, to, limit: 500,
        ...(kinds.length > 0 ? { kinds: [...kinds] } : {}),
        ...(outcome.length > 0 ? { outcome: [...outcome] } : {}),
      });
      // Generation guard: a window chip clicked mid-flight must win over the
      // older, slower response (same rule as commands.slo's refresh).
      if (gen !== generation) return;
      set({ rows: res.rows.slice(), matched: res.matched, totals: res.totals, coverage: res.coverage, loading: false, loaded: true, lastUpdated: to });
    } catch (err) {
      if (gen !== generation) return;
      set({ loading: false, loaded: true, error: errorText(err) });
    }
  };
  const setFilter = (patch: Partial<RunHistoryFilter>) => set({ filter: { ...state.filter, ...patch } });
  return {
    getState: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    refresh,
    setWindow: (window: RunHistoryWindow) => { set({ window }); void refresh(); },
    // These two re-fetch: they are SERVER-side facets now (see the note on RunHistoryState).
    toggleKind: (kind: RunKind) => { setFilter({ kinds: toggle(state.filter.kinds, kind) }); void refresh(); },
    toggleOutcome: (outcome: RunOutcome) => { setFilter({ outcome: toggle(state.filter.outcome, outcome) }); void refresh(); },
    toggleUnseenOnly: () => setFilter({ unseenOnly: !state.filter.unseenOnly }),
    toggleTeam: (team: string) => setFilter({ teams: toggle(state.filter.teams, team) }),
    toggleCostBasis: (basis: RunCostBasis) => setFilter({ costBasis: toggle(state.filter.costBasis, basis) }),
    clearFilters: () => { const refetch = state.filter.kinds.length > 0 || state.filter.outcome.length > 0; set({ filter: EMPTY_RUN_HISTORY_FILTER }); if (refetch) void refresh(); },
    setText: (text: string) => setFilter({ text }),
    /** Row click-through — the same seam commands.jobs' openRun uses, so a run opens
     * where it actually lives: an agent row on the Agents tab, a queued task in its
     * queue drill. A row with neither is honestly a no-op (the screen greys it). */
    openRun: async (row: RunHistoryRow): Promise<void> => {
      if (!store) return;
      if (row.agentId) {
        store.dispatch({ type: "selectAgent", agentId: row.agentId });
        store.dispatch({ type: "selectTab", tab: "agents" });
        return;
      }
      if (row.queue) {
        const detail = await request<QueueStatusView>("queue.status", { queue: row.queue });
        store.dispatch({ type: "queueDetail", detail });
        store.dispatch({ type: "selectTab", tab: "queues" });
      }
    },
    start: () => { void refresh(); if (!timer) timer = setInterval(() => void refresh(), 30_000); },
    stop: () => { if (timer) clearInterval(timer); if (burstTimer) clearTimeout(burstTimer); timer = null; burstTimer = null; },
    requestRefresh: () => { if (burstTimer) return; burstTimer = setTimeout(() => { burstTimer = null; void refresh(); }, 250); },
  };
}

let singleton: ReturnType<typeof createRunHistoryCommands> | null = null;
export function getRunHistoryCommands(request: RequestFn, store: UiStore | null = null) {
  if (!singleton) singleton = createRunHistoryCommands(request, Date.now, store);
  return singleton;
}
export function useRunHistoryState<T>(selector: (s: RunHistoryState) => T): T {
  // Same standalone-render contract commands.slo documents: a component test may
  // mount a consumer without the module that installs the bridge-backed singleton.
  if (!singleton) singleton = createRunHistoryCommands(async () => { throw new Error("run history commands not initialized"); });
  return useSyncExternalStore(singleton.subscribe, () => selector(singleton!.getState()));
}

/** Test seam — drop the module singleton so each test builds a fresh store. */
export function __resetRunHistoryCommands(): void {
  singleton?.stop();
  singleton = null;
}
