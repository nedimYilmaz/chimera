import { describe, it, expect } from "vitest";
import { overlaps, hasConflict } from "./interval.js";

describe("overlaps", () => {
  it("detects a genuine overlap", () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 5, end: 15 })).toBe(true);
  });

  it("detects full containment as an overlap", () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 2, end: 8 })).toBe(true);
  });

  it("treats two identical meetings as overlapping", () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 0, end: 10 })).toBe(true);
  });

  it("does NOT count back-to-back meetings (touching endpoints) as overlapping", () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
  });

  it("does not flag disjoint meetings", () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 20, end: 30 })).toBe(false);
  });
});

describe("hasConflict", () => {
  it("finds a conflict against an existing schedule", () => {
    const existing = [{ start: 0, end: 10 }, { start: 30, end: 40 }];
    expect(hasConflict(existing, { start: 9, end: 12 })).toBe(true);
  });

  it("allows scheduling back-to-back right after an existing meeting", () => {
    const existing = [{ start: 0, end: 10 }];
    expect(hasConflict(existing, { start: 10, end: 20 })).toBe(false);
  });

  // The trap: a fix that only special-cases the "existing meeting first" order
  // (the only order every other test above happens to exercise) still leaves
  // the touching check inclusive on the other side, so it still misfires when
  // the CANDIDATE comes first. Back-to-back must hold regardless of which
  // meeting is "existing" and which is "candidate".
  it("allows scheduling back-to-back right before an existing meeting", () => {
    const existing = [{ start: 10, end: 20 }];
    expect(hasConflict(existing, { start: 0, end: 10 })).toBe(false);
  });
});
