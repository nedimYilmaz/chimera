// W21 (F19 · coverage §B23/§C17) — the usage & cost card's own local store
// (HostToolsCard/commands.host.ts shape discipline: a PURE factory over
// injected deps, unit-testable against a stub request). Tauri-only, TUI track
// frozen for this feature (F19-usage-analytics.md), so state lives HERE
// rather than the shared @chimera/ui-state reducer — mirrors W20's
// commands.notify.ts precedent, not AccountsCard's shared-reducer one.
//
// "No drift" (F19): every number on the card traces back to ONE usage.query
// response per concern — the groupBy bars + 7d trend share a SINGLE response
// (bucket:"day" rides the same call as the selected groupBy), while top runs
// (groupBy:"agent") and the jobs row (groupBy:"job") are separate calls over
// the identical [from,to) range, so their totalCostUsd always agrees with the
// bars' total — nothing here re-sums or re-derives a number the daemon
// already computed.
import type { UsageQueryGroup, UsageQueryResult } from "@chimera/protocol";
import type { UiStore } from "@chimera/ui-state";
import { buildUsageCsv, jobsFrom, last7DaysRange, topRunsFrom, usageCsvFilename } from "./selectors.usage";

// doExport is injected (not imported from ../rpc/bridge) so this module stays
// a pure, dependency-free factory (commands.notify.ts/commands.host.ts shape
// discipline) — bridge.ts has module-eval side effects (the DEV probe's
// onDaemonState/onDaemonEvent listeners) that need a real `window`, which
// would break this store's node-environment unit tests. UsageCard.tsx (the
// one real caller) supplies bridge.ts's exportCsv.

export type RequestFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;
export type ExportFn = (filename: string, content: string) => Promise<string>;

export type UsageBarsGroupBy = "team" | "account" | "model";

export type UsageCardState = {
  open: boolean;
  groupBy: UsageBarsGroupBy;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  groups: UsageQueryGroup[];
  trend: { day: string; costUsd: number }[];
  topRuns: UsageQueryGroup[];
  jobs: UsageQueryGroup[];
};

const initial: UsageCardState = {
  open: false,
  groupBy: "team",
  loading: false,
  loaded: false,
  error: null,
  totalCostUsd: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  groups: [],
  trend: [],
  topRuns: [],
  jobs: [],
};

const errMessage = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
};

export type UsageCommands = ReturnType<typeof createUsageCommands>;

export function createUsageCommands(
  store: UiStore,
  request: RequestFn,
  doExport: ExportFn,
  now: () => number = Date.now,
) {
  let state: UsageCardState = initial;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<UsageCardState>): void => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  const fail = (err: unknown): void => store.dispatch({ type: "commandError", message: errMessage(err) });

  /** One round of the three queries the card needs, all over the SAME
   * [from,to) range — see the module doc for why this keeps every number on
   * the card mutually consistent. */
  const refresh = async (): Promise<void> => {
    const { from, to } = last7DaysRange(now());
    set({ loading: true, error: null });
    try {
      const [main, runsQ, jobsQ] = await Promise.all([
        request<UsageQueryResult>("usage.query", { from, to, groupBy: state.groupBy, bucket: "day" }),
        request<UsageQueryResult>("usage.query", { from, to, groupBy: "agent" }),
        request<UsageQueryResult>("usage.query", { from, to, groupBy: "job" }),
      ]);
      set({
        loading: false,
        loaded: true,
        totalCostUsd: main.totalCostUsd,
        totalTokensIn: main.totalTokensIn,
        totalTokensOut: main.totalTokensOut,
        groups: main.groups,
        trend: (main.buckets ?? []).map((b) => ({ day: b.day, costUsd: b.costUsd })),
        topRuns: topRunsFrom(runsQ.groups),
        jobs: jobsFrom(jobsQ.groups),
      });
    } catch (err) {
      set({ loading: false, error: errMessage(err) });
      fail(err);
    }
  };

  return {
    getState: (): UsageCardState => state,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },

    /** the SpendChip's opener / re-toggle (same convention as notify.toggle). */
    toggle: (): void => {
      if (state.open) { set({ open: false }); return; }
      set({ open: true });
      void refresh();
    },

    escape: (): void => set({ open: false }),

    /** the bars header cycles team → account → model, re-querying ONLY the
     * shared main+trend response — top runs/jobs are unaffected by this
     * selector, so their totals still agree with the new bars' total. */
    setGroupBy: (groupBy: UsageBarsGroupBy): void => {
      if (groupBy === state.groupBy) return;
      set({ groupBy });
      void refresh();
    },

    /** `x` — writes the CURRENTLY DISPLAYED groupBy rows (never a re-derived
     * set) to a csv file and toasts the resulting path. */
    exportSelectedCsv: async (): Promise<void> => {
      const filename = usageCsvFilename(state.groupBy, now());
      const csv = buildUsageCsv(state.groupBy, state.groups);
      try {
        const path = await doExport(filename, csv);
        store.dispatch({ type: "notice", message: `csv exported: ${path}` });
      } catch (err) {
        fail(err);
      }
    },
  };
}

let cardSingleton: UsageCommands | null = null;
export function getUsageCommands(store: UiStore, request: RequestFn, doExport: ExportFn): UsageCommands {
  if (!cardSingleton) cardSingleton = createUsageCommands(store, request, doExport);
  return cardSingleton;
}
