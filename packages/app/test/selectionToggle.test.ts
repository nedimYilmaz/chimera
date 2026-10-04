import { describe, expect, it } from "vitest";
import { toggleCollapsed, toggleIndex } from "../src/state/selectionToggle";

describe("toggleCollapsed", () => {
  it("flips collapsed when the SAME row is clicked again", () => {
    expect(toggleCollapsed(2, 2, false)).toBe(true);
    expect(toggleCollapsed(2, 2, true)).toBe(false);
  });

  it("always opens (collapsed=false) when a DIFFERENT row is clicked", () => {
    expect(toggleCollapsed(3, 2, true)).toBe(false);
    expect(toggleCollapsed(3, 2, false)).toBe(false);
  });
});

describe("toggleIndex", () => {
  it("deselects (-1) when the SAME index is clicked again", () => {
    expect(toggleIndex(1, 1)).toBe(-1);
  });

  it("selects the clicked index when it differs from the current one", () => {
    expect(toggleIndex(4, 1)).toBe(4);
  });

  it("supports seq-like (non-array-index) values, e.g. EventsScreen's selSeq", () => {
    expect(toggleIndex(9001, 9001)).toBe(-1);
    expect(toggleIndex(9002, 9001)).toBe(9002);
  });
});
