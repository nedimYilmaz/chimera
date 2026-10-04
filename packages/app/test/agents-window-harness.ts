// AUTOFIX harness for the AgentsScreen keyboard-chord tests (node env, no DOM).
//
// AgentsScreen mounts a capture-phase `window.addEventListener("keydown", ...)`
// handler (the permission-answer chords + esc chain). To exercise that handler
// in the app package's node test env we need (1) a window stub that CAPTURES the
// registered keydown listeners so a synthetic event can be fired at them, and
// (2) `window.__CHIMERA_MOCK__` set BEFORE the rpc bridge module evaluates, so
// the bridge routes through its own mock branch instead of a real Tauri invoke()
// (which throws "window is not defined" at import and floods unhandled
// rejections). This module MUST be imported before any src/ module — its
// top-level assignments run at import time, ahead of the mocked bridge factory.

type KeydownHandler = (ev: unknown) => void;

export const keydownHandlers: KeydownHandler[] = [];

// The bridge computes `mock` from window.__CHIMERA_MOCK__ at module-eval time
// (behind import.meta.env.DEV, which Vitest sets true) — present it here so the
// real bridge's own Tauri side-effects are neutralized. rpcCall itself is
// separately overridden by the test's vi.mock to record calls.
(globalThis as unknown as { window: unknown }).window = {
  __CHIMERA_MOCK__: { rpc: async () => ({}) },
  addEventListener: (type: string, fn: KeydownHandler) => {
    if (type === "keydown") keydownHandlers.push(fn);
  },
  removeEventListener: (type: string, fn: KeydownHandler) => {
    if (type !== "keydown") return;
    const i = keydownHandlers.indexOf(fn);
    if (i >= 0) keydownHandlers.splice(i, 1);
  },
};

(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

// rpc calls recorded by the test's bridge mock (kept on globalThis so the hoisted
// vi.mock factory can push to it without a TDZ reference to a module binding).
(globalThis as unknown as { __rpcCalls: Array<{ method: string; params: unknown }> }).__rpcCalls = [];
export const rpcCalls = (globalThis as unknown as { __rpcCalls: Array<{ method: string; params: unknown }> }).__rpcCalls;

/** Fire a synthetic keydown at every registered capture listener. Each gets the
 * KeyboardEvent surface AgentsScreen's handler actually reads. */
export function fireKeydown(ev: Record<string, unknown>): void {
  const e = {
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault() {},
    stopImmediatePropagation() {},
    ...ev,
  };
  for (const h of [...keydownHandlers]) {
    try { h(e); } catch { /* unrelated overlay listeners must not fail the chord assertion */ }
  }
}
