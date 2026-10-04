import { appStore } from "./store";
import { fleetTelemetry, pushSample, type FleetTelemetry, type Sample } from "./selectors.telemetry";

// FLEET-TELEMETRY: the sampler behind the live dashboard.
//
// The load-bearing decision here is that it does NOT re-derive on every event. The store sees
// every message_delta and tool_call from every running agent; re-aggregating ~1000 agent views
// at that rate would make the dashboard the reason the UI is slow — the same class of problem as
// polling a 5MB agent.list, just self-inflicted. It samples on a fixed 1Hz tick instead, which
// is far faster than a human reads a chart and bounded regardless of how loud the fleet is.
//
// It also only runs while somebody is LOOKING: start() is refcounted from the panel's mount, so
// a session sitting on the agents tab pays nothing for a dashboard it never opened.

export type TelemetryState = { now: FleetTelemetry; series: Sample[] };

const EMPTY: FleetTelemetry = {
  live: 0, busy: 0, paused: 0, busyRatio: 0, queued: 0, tokens: 0, costUsd: 0,
  ctxUsed: 0, ctxLimit: 0, byModel: [], byEffort: [], topCost: [],
  compactedAgents: 0, compactions: 0, ctxPressure: [],
  tools: [], mcpServers: [], toolCalls: 0, mcpCalls: 0,
};

export const SAMPLE_INTERVAL_MS = 1000;

export function createTelemetryStore(deps: {
  read: () => FleetTelemetry;
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
}) {
  let state: TelemetryState = { now: EMPTY, series: [] };
  const listeners = new Set<() => void>();
  let handle: unknown = null;
  let viewers = 0;

  const tick = (): void => {
    const snapshot = deps.read();
    state = {
      now: snapshot,
      series: pushSample(state.series, {
        t: deps.now(), tokens: snapshot.tokens, costUsd: snapshot.costUsd,
        busy: snapshot.busy, live: snapshot.live,
      }),
    };
    for (const fn of listeners) fn();
  };

  return {
    getState: (): TelemetryState => state,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    /** Refcounted: the panel starts it on mount and stops it on unmount, so nothing samples
     * while the dashboard is closed. Returns the stop for that one viewer. */
    start(): () => void {
      viewers++;
      if (handle === null) {
        tick();                                        // paint immediately, don't wait a second
        handle = deps.setInterval(tick, SAMPLE_INTERVAL_MS);
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        viewers--;
        if (viewers === 0 && handle !== null) { deps.clearInterval(handle); handle = null; }
      };
    },
    /** Test seam — drive a tick without waiting on a real clock. */
    sampleNow: tick,
  };
}

export type TelemetryStore = ReturnType<typeof createTelemetryStore>;

export const telemetryStore: TelemetryStore = createTelemetryStore({
  read: () => fleetTelemetry(appStore.getState()),
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
});
