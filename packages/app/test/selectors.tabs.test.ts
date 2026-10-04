import { describe, expect, it } from "vitest";
import { splitTabs } from "../src/state/selectors.tabs";

// TOPBAR-OVERFLOW — the pure fit computation, no DOM involved.

describe("splitTabs", () => {
  it("keeps everything visible when the strip fits", () => {
    const widths = [80, 90, 70, 85, 75, 80, 90, 70, 60];
    const split = splitTabs(1000, widths, 0, 40);
    expect(split.visible).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(split.hidden).toEqual([]);
  });

  it("drops from the right (highest index) first when the active tab is at the front", () => {
    // 9 slots @ 80px each; active=0 fits, room for slots 1..5 (6*80=480 <= 480 budget)
    const widths = new Array(9).fill(80);
    const split = splitTabs(520, widths, 0, 40); // budget = 480
    expect(split.visible).toEqual([0, 1, 2, 3, 4, 5]);
    expect(split.hidden).toEqual([6, 7, 8]);
  });

  it("pins the active tab even when it would otherwise fall into overflow", () => {
    const widths = new Array(9).fill(80);
    // active is slot 8 (last); budget = 480 - one forced 80 = 400 left for others -> 5 more fit (0..4)
    const split = splitTabs(520, widths, 8, 40);
    expect(split.visible).toContain(8);
    expect(split.hidden).not.toContain(8);
    expect(split.visible).toEqual([0, 1, 2, 3, 4, 8]);
    expect(split.hidden).toEqual([5, 6, 7]);
  });

  it("falls back to plain left-to-right fill when activeIndex is out of range", () => {
    const widths = new Array(9).fill(80);
    const split = splitTabs(520, widths, -1, 40);
    expect(split.visible).toEqual([0, 1, 2, 3, 4, 5]);
    expect(split.hidden).toEqual([6, 7, 8]);
  });

  it("never hides the active tab even at zero/negative available width", () => {
    const widths = new Array(9).fill(80);
    const split = splitTabs(0, widths, 3, 40);
    expect(split.visible).toEqual([3]);
    expect(split.hidden).toEqual([0, 1, 2, 4, 5, 6, 7, 8]);
  });

  it("handles an empty widths array without crashing", () => {
    expect(splitTabs(500, [], 0, 40)).toEqual({ visible: [], hidden: [] });
  });

  it("is reversible: widening the available width restores previously hidden slots", () => {
    const widths = new Array(9).fill(80);
    const narrow = splitTabs(520, widths, 0, 40);
    const wide = splitTabs(760, widths, 0, 40); // budget 720 >= 9*80=720
    expect(narrow.hidden.length).toBeGreaterThan(0);
    expect(wide.hidden).toEqual([]);
  });

  it("does not let a later, narrower slot fill a gap left by an earlier slot that didn't fit (non-contiguous drop)", () => {
    // 9 real-labelled slots (agents..slo), non-uniform widths — mirrors APP_TABS
    // (rows.tabs.ts) where e.g. "settings"/"inbox" (slots 6,7) are wider than
    // "slo" (slot 8). Slots 0-5 fill exactly to 400; slots 6 and 7 (90 each)
    // don't fit the 480 budget, but slot 8 (50) alone technically would — a
    // pre-fix greedy scan kept scanning past the first miss and pulled slot 8
    // into `visible` while slots 6/7 stayed hidden, leaving a hole in the
    // middle of the strip instead of a clean trailing overflow.
    const widths = [60, 70, 60, 70, 70, 70, 90, 90, 50];
    const split = splitTabs(520, widths, -1, 40); // budget = 480
    expect(split.visible).toEqual([0, 1, 2, 3, 4, 5]);
    expect(split.hidden).toEqual([6, 7, 8]);
  });
});
