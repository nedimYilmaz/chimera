import { useSyncExternalStore } from "react";
import type { SliRollupResult, SloThreshold, UsageQueryResult } from "@chimera/protocol";
import { SLO_WINDOWS, evaluateThresholds, type SloBreach, type SloWindow } from "./selectors.slo";

type RequestFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;
export type SloGroupBy = "team" | "provider" | "workflow";
export type SloState = { window: SloWindow; groupBy: SloGroupBy; loading: boolean; loaded: boolean; error: string | null;
  sli: SliRollupResult | null; usage: UsageQueryResult | null; thresholds: SloThreshold[]; breaches: SloBreach[]; lastUpdated: number | null };
const initial: SloState = { window: "24h", groupBy: "team", loading: false, loaded: false, error: null,
  sli: null, usage: null, thresholds: [], breaches: [], lastUpdated: null };

export function createSloCommands(request: RequestFn, now: () => number = Date.now, onBreach: (b: SloBreach) => void = () => {}) {
  let state = initial; let generation = 0; let timer: ReturnType<typeof setInterval> | null = null;
  let burstTimer: ReturnType<typeof setTimeout> | null = null; let notify = onBreach;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SloState>) => { state = { ...state, ...patch }; for (const fn of listeners) fn(); };
  const refresh = async () => {
    const gen = ++generation; const to = now(); const from = to - SLO_WINDOWS[state.window];
    set({ loading: true, error: null });
    // DECOUPLED: allSettled (not all) — a rejection on either RPC must not blank the
    // tiles fed by the OTHER, still-successful RPC. Each side falls back to its own
    // previous value on rejection, so a transient failure reads as "stale" not "—".
    const [sliRes, usageRes] = await Promise.allSettled([
      request<SliRollupResult>("sli.rollup", { from, to, bucketMs: Math.max(60_000, Math.ceil((to - from) / 48)), groupBy: state.groupBy }),
      request<UsageQueryResult>("usage.query", { from, to, groupBy: state.groupBy === "workflow" ? "team" : state.groupBy }),
    ]);
    if (gen !== generation) return;
    const sli = sliRes.status === "fulfilled" ? sliRes.value : state.sli;
    const usage = usageRes.status === "fulfilled" ? usageRes.value : state.usage;
    const errs = [sliRes, usageRes]
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason instanceof Error ? r.reason.message : typeof r.reason === "object" && r.reason !== null && "message" in r.reason ? String((r.reason as { message: unknown }).message) : String(r.reason)));
    let breaches = state.breaches;
    if (sli && usage) {
      // Guarded like the RPCs above — a malformed response shouldn't crash the whole
      // refresh cycle when both RPCs otherwise succeeded.
      try {
        breaches = evaluateThresholds(state.thresholds.filter((t) => t.window === state.window), sli, usage);
        const old = new Set(state.breaches.map((b) => b.id)); for (const b of breaches) if (!old.has(b.id)) notify(b);
      } catch (e) { errs.push(e instanceof Error ? e.message : String(e)); }
    }
    set({ sli, usage, breaches, loading: false, loaded: true, lastUpdated: to, error: errs.length ? errs.join("; ") : null });
  };
  const loadThresholds = async () => {
    const cfg = await request<{ sloThresholds?: SloThreshold[] }>("config.get", {});
    set({ thresholds: cfg.sloThresholds ?? [] });
  };
  const saveThresholds = async (thresholds: SloThreshold[]) => {
    await request("config.patch", { patch: { sloThresholds: thresholds } }); set({ thresholds }); await refresh();
  };
  return { getState: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); }, refresh, loadThresholds,
    saveThresholds, setWindow: (window: SloWindow) => { set({ window }); void refresh(); },
    setGroupBy: (groupBy: SloGroupBy) => { set({ groupBy }); void refresh(); },
    start: () => { void loadThresholds().then(refresh); if (!timer) timer = setInterval(() => void refresh(), 30_000); },
    stop: () => { if (timer) clearInterval(timer); if (burstTimer) clearTimeout(burstTimer); timer = null; burstTimer = null; },
    requestRefresh: () => { if (burstTimer) return; burstTimer = setTimeout(() => { burstTimer = null; void refresh(); }, 250); },
    setBreachNotifier: (fn: (b: SloBreach) => void) => { notify = fn; } };
}

let singleton: ReturnType<typeof createSloCommands> | null = null;
export function getSloCommands(request: RequestFn, onBreach?: (b: SloBreach) => void) {
  if (!singleton) singleton = createSloCommands(request, Date.now, onBreach); return singleton;
}
export function useSloState<T>(selector: (s: SloState) => T): T {
  // Component tests may mount InboxScreen without the App/SloScreen module that
  // installs the real bridge-backed singleton. An inert store preserves that
  // standalone rendering contract; production initializes the real singleton first.
  if (!singleton) singleton = createSloCommands(async () => { throw new Error("SLO commands not initialized"); });
  return useSyncExternalStore(singleton.subscribe, () => selector(singleton!.getState()));
}
