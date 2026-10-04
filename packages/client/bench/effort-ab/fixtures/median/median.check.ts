import { describe, it, expect } from "vitest";
import { median } from "./median.js";

describe("median", () => {
  it("returns the middle element for an odd-length array", () => {
    expect(median([5, 1, 3])).toBe(3);
  });
  it("averages the two middle elements for an even-length array", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("handles a single element", () => {
    expect(median([7])).toBe(7);
  });
  it("throws on an empty array", () => {
    expect(() => median([])).toThrow();
  });
});
