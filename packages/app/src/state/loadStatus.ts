import { useSyncExternalStore } from "react";

/**
 * Honest load state for a screen-owned list.  A list's default value ("no rows")
 * is indistinguishable from "the fetch failed" or "the fetch has not answered
 * yet", which is how an empty-looking Roles pane used to lie about a transient
 * `role.list` failure.  This is the one place that records which of the three
 * it really is, so the empty hint, the count and the retry affordance can be
 * derived instead of guessed.
 *
 * Deliberately app-layer and per-list (one `createLoadStatus()` beside the
 * commands that own the fetch), NOT a reducer field: the reducer's
 * `connectAndLoad` snapshot retries every failure on a bounded ladder, so a
 * list the Phase-1 daemon cannot serve (unknown method) must never be put on
 * that path — the screen owns when it loads.
 */
export interface LoadStatusState {
  /** At least one fetch succeeded: the rows the screen holds are real (possibly stale). */
  readonly loaded: boolean;
  readonly loading: boolean;
  /** The LATEST attempt failed.  With `loaded` this means "rows are stale", not "no rows". */
  readonly error: string | null;
  /** The daemon does not implement the method — a stable capability fact, not a retryable error. */
  readonly unsupported: boolean;
}

export interface LoadStatus {
  getState(): LoadStatusState;
  subscribe(listener: () => void): () => void;
  /** Start a load; returns its generation.  Any earlier in-flight load is now superseded. */
  begin(): number;
  /** False once a newer `begin()` (or `reset()`) happened — the caller must drop its result. */
  isCurrent(generation: number): boolean;
  succeed(generation: number): void;
  fail(generation: number, message: string): void;
  markUnsupported(generation: number): void;
  /**
   * The connection dropped.  Supersedes any in-flight load (its late result is dropped, so a
   * response the daemon sent BEFORE the drop cannot present itself as fresh while no new load has
   * started) and, if one was in flight, records `message` so the rows read as stale rather than
   * as a spinner that never resolves.  A no-op when idle: the rows are still the last good ones
   * and the reconnect edge starts the fresh load.
   */
  interrupt(message: string): void;
  reset(): void;
}

const INITIAL: LoadStatusState = { loaded: false, loading: false, error: null, unsupported: false };

export function createLoadStatus(): LoadStatus {
  let state = INITIAL;
  let generation = 0;
  const listeners = new Set<() => void>();
  const set = (next: LoadStatusState): void => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    begin() {
      generation += 1;
      // `error` is kept while retrying so a stale note does not flicker away and back.
      if (!state.loading) set({ ...state, loading: true });
      return generation;
    },
    isCurrent: (g) => g === generation,
    succeed(g) {
      if (g === generation) set({ loaded: true, loading: false, error: null, unsupported: false });
    },
    fail(g, message) {
      if (g === generation) set({ ...state, loading: false, error: message, unsupported: false });
    },
    markUnsupported(g) {
      if (g === generation) set({ loaded: true, loading: false, error: null, unsupported: true });
    },
    interrupt(message) {
      generation += 1;
      if (state.loading) set({ ...state, loading: false, error: message });
    },
    reset() {
      generation += 1;
      set(INITIAL);
    },
  };
}

export interface RunLoadOptions {
  /** Classifies a rejection as a stable "method not implemented" fact rather than a transient failure. */
  isUnsupported?: (err: unknown) => boolean;
  onUnsupported?: () => void;
}

// The rpc bridge rejects with plain `{code, message}` objects, not Error instances.
const errText = (err: unknown): string => {
  if (typeof err === "object" && err !== null && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
};

/**
 * Fetch → (generation check) → apply.  Only the fetch sits inside the
 * try/catch: an exception thrown by `apply` is a real bug and must surface,
 * not be misreported as a daemon failure.  The generation check precedes
 * `apply`, so an out-of-order retry/reconnect response can never overwrite
 * data or status written by the newer load.
 */
export async function runLoad<T>(
  status: LoadStatus,
  fetch: () => Promise<T>,
  apply: (value: T) => void,
  opts: RunLoadOptions = {},
): Promise<void> {
  const generation = status.begin();
  let value: T;
  try {
    value = await fetch();
  } catch (err) {
    if (!status.isCurrent(generation)) return;
    if (opts.isUnsupported?.(err)) {
      opts.onUnsupported?.();
      status.markUnsupported(generation);
      return;
    }
    status.fail(generation, errText(err));
    return;
  }
  if (!status.isCurrent(generation)) return;
  apply(value);
  status.succeed(generation);
}

/** Subscribe a component to a load status.  Returns the whole (referentially stable) state object. */
export function useLoadStatus(status: LoadStatus): LoadStatusState {
  return useSyncExternalStore(status.subscribe, status.getState, status.getState);
}
