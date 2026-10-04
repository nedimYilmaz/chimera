import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { UiState } from "@chimera/ui-state";
import { appStore } from "./store";

// W2 state port (PLAN-TAURI §3): the app's one React binding over the shared framework-free store
// — useSyncExternalStore keeps ui-state itself free of any react dependency.
//
// SELECTOR-STABILITY: useSyncExternalStore compares snapshots by reference and re-reads during
// render, so a selector that allocates a fresh object/array per call never compares equal, and
// React tears the tree down with "The result of getSnapshot should be cached to avoid an infinite
// loop". In this app that is a WHITE SCREEN, not a warning.
//
// That rule used to live here as a comment telling callers not to do it. It was violated anyway —
// one `Object.values(...).filter(...).map(...)` in the secrets settings section blanked the whole
// app the moment you opened it. An unenforced convention across 146 call sites is a matter of time,
// so the binding now makes the violation harmless instead of describing it.
//
// The selector is still evaluated on every read (so a selector closing over changed props is
// always honoured — memoising on state identity alone would silently return a stale slice). What
// changes is the RESULT: when the new value is structurally equal to the last one, the previous
// REFERENCE is returned, which is what React's identity check needs. Stable selectors — the
// overwhelming majority, returning `s.agents[id]` or a primitive — hit the Object.is fast path and
// pay nothing.
export function useStore<T>(selector: (s: UiState) => T): T {
  const prev = useRef<{ value: T } | null>(null);
  const getSnapshot = (): T => {
    const next = selector(appStore.getState());
    const last = prev.current;
    if (last !== null && stableEqual(last.value, next)) return last.value;
    prev.current = { value: next };
    return next;
  };
  return useSyncExternalStore(appStore.subscribe, getSnapshot);
}

/** RENDER-TREADMILL: the same subscription, sampled at most every `ms`.
 *
 *  `useStore` repaints on every dispatch, which is right for a chip or a count and wrong for a
 *  list of hundreds of rows. Measured with 370 agents mounted: one event dispatched on its own
 *  costs 7.7 ms of re-render (a fresh agentMeta over every agent, then three grouping passes over
 *  every row). At this machine's measured peak of 101 events/sec that is 778 ms of rendering per
 *  second — 78% of the main thread — before the operator has typed anything. Typing then adds its
 *  own re-render chain on top, and the window stops responding. Reported as the agent list
 *  freezing when you type in its search box.
 *
 *  Nothing here is dropped: every change updates the pending value immediately, and the trailing
 *  flush guarantees the LAST one is always rendered. What is dropped is the redundant PAINTS in
 *  between — at 100 events/sec a human sees the same thing at 10 fps as at 100, for a tenth of
 *  the work.
 *
 *  Deliberately not the default. A latency-sensitive reader (the composer's target, a permission
 *  prompt) must repaint the moment its state changes; this is for the readers whose cost scales
 *  with the fleet. */
export function useStoreThrottled<T>(selector: (s: UiState) => T, ms = 100): T {
  const [snapshot, setSnapshot] = useState<T>(() => selector(appStore.getState()));
  const latest = useRef<T>(snapshot);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlush = useRef(0);
  // The selector closes over props/state and is recreated each render; kept in a ref so the
  // subscription below is installed ONCE rather than torn down and rebuilt on every render.
  const sel = useRef(selector);
  sel.current = selector;

  useEffect(() => {
    const flush = (): void => {
      timer.current = null;
      lastFlush.current = Date.now();
      setSnapshot(latest.current);
    };
    const unsubscribe = appStore.subscribe(() => {
      const next = sel.current(appStore.getState());
      if (stableEqual(latest.current, next)) return;
      latest.current = next;
      if (timer.current !== null) return;                        // a flush is already due
      const wait = ms - (Date.now() - lastFlush.current);
      if (wait <= 0) flush();
      else timer.current = setTimeout(flush, wait);
    });
    return () => {
      unsubscribe();
      if (timer.current !== null) clearTimeout(timer.current);   // never flush into an unmounted tree
    };
  }, [ms]);

  return snapshot;
}

/** Equality bounded to TWO levels: enough for the shapes selectors actually produce (an array of
 *  small `{id, label}` records, a `{a, b}` projection) and cheap enough to run on every dispatch
 *  for every hook. Deliberately NOT a deep compare — an unbounded walk over a large slice on every
 *  store notification would trade a render bug for a performance one. */
export function stableEqual(a: unknown, b: unknown, depth = 2): boolean {
  if (Object.is(a, b)) return true;
  if (depth <= 0) return false;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    return x.every((v, i) => stableEqual(v, y[i], depth - 1));
  }
  // Plain objects only. Anything with a prototype (a Map, a class instance, a Date) is compared by
  // identity above and left alone here — walking its keys would claim an equality its own semantics
  // may not have.
  const protoA = Object.getPrototypeOf(a);
  if (protoA !== Object.prototype && protoA !== null) return false;
  if (Object.getPrototypeOf(b) !== protoA) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    Object.prototype.hasOwnProperty.call(b, k) &&
    stableEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth - 1));
}
