import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState } from "@chimera/ui-state";

// A2A-UX-OVERHAUL: the reducer's `a2aHistoryOpen` case is the single toggle App
// dispatches to open/close the ⇄ a2a history overlay (bare `#`, command palette,
// esc/click-away). These lock the case to a plain latest-wins boolean set so the
// overlay's open state is a pure function of the last dispatched action.
describe("reducer: a2aHistoryOpen", () => {
  it("defaults to closed in the initial state", () => {
    expect(initialState.a2aHistoryOpen).toBe(false);
  });

  it("opens the overlay when dispatched with open:true", () => {
    const st = reduce(initialState, { type: "a2aHistoryOpen", open: true });
    expect(st.a2aHistoryOpen).toBe(true);
  });

  it("closes the overlay when dispatched with open:false", () => {
    const open = reduce(initialState, { type: "a2aHistoryOpen", open: true });
    const closed = reduce(open, { type: "a2aHistoryOpen", open: false });
    expect(closed.a2aHistoryOpen).toBe(false);
  });

  it("is a pure latest-wins set (re-opening an already-open overlay stays open)", () => {
    const once = reduce(initialState, { type: "a2aHistoryOpen", open: true });
    const twice = reduce(once, { type: "a2aHistoryOpen", open: true });
    expect(twice.a2aHistoryOpen).toBe(true);
  });

  it("touches only a2aHistoryOpen — leaves the rest of the state untouched", () => {
    const st = reduce(initialState, { type: "a2aHistoryOpen", open: true });
    expect({ ...st, a2aHistoryOpen: initialState.a2aHistoryOpen }).toEqual(initialState);
  });
});
