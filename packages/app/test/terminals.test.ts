import { describe, it, expect, vi } from "vitest";
import { createStore } from "@chimera/ui-state";
import { openTerminalForAgent, terminalCwdFor } from "../src/state/terminals";

// This package's vitest config is deliberately node-env/no-DOM (pure-function tests only), and
// jsdom isn't installed here. `new Channel()` from @tauri-apps/api/core reaches for
// `window.__TAURI_INTERNALS__.transformCallback` purely to register a callback id — stub just
// that, rather than pulling in a DOM environment for one constructor call.
(globalThis as unknown as { window: unknown }).window = {
  __TAURI_INTERNALS__: { transformCallback: (_cb: unknown) => 0 },
};

describe("terminalCwdFor", () => {
  it("prefers the agent workdir", () => {
    expect(terminalCwdFor({ id: "a1", workdir: "/repo/.chimera/worktrees/a1" }))
      .toBe("/repo/.chimera/worktrees/a1");
  });
  it("falls back to ~ when the agent has no workdir", () => {
    expect(terminalCwdFor({ id: "a1", workdir: null })).toBe("~");
  });
});

describe("openTerminalForAgent", () => {
  it("adds one tab and makes it active", async () => {
    const store = createStore({} as never);
    const open = vi.fn().mockResolvedValue("term-1");
    await openTerminalForAgent(store, { id: "a1", workdir: "/repo" }, open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(store.getState().terminals.tabs).toHaveLength(1);
    expect(store.getState().terminals.activeByAgent["a1"]).toBe("term-1");
  });
});
