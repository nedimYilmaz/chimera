import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  easeCubicInOut,
  fitToBox,
  interpolateTransform,
  makeTransform,
  transformsClose,
  zoomToward,
} from "../src/memory-graph/view";

describe("memory-graph view transform", () => {
  it("makeTransform yields exactly {k,x,y} and apply/invert round-trip", () => {
    const t = makeTransform(2, 30, -10);
    expect(t.k).toBe(2);
    expect(t.x).toBe(30);
    expect(t.y).toBe(-10);
    // apply([5, 5]) = [5*2+30, 5*2-10] = [40, 0]
    expect(t.applyX(5)).toBe(40);
    expect(t.applyY(5)).toBe(0);
    expect(t.invertX(40)).toBeCloseTo(5, 6);
  });

  it("clampScale bounds to [MIN,MAX]", () => {
    expect(clampScale(1000)).toBe(MAX_SCALE);
    expect(clampScale(1e-9)).toBe(MIN_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
  });

  it("zoomToward keeps the world point under the cursor fixed", () => {
    const t = makeTransform(1, 0, 0);
    const px = 200;
    const py = 120;
    const worldBefore = [t.invertX(px), t.invertY(py)];
    const nt = zoomToward(t, 3, px, py);
    expect(nt.k).toBe(3);
    // the same world point still lands under (px,py)
    expect(nt.applyX(worldBefore[0])).toBeCloseTo(px, 4);
    expect(nt.applyY(worldBefore[1])).toBeCloseTo(py, 4);
  });

  it("fitToBox centers the box and fits within padding", () => {
    const box = { minX: -100, minY: -50, maxX: 100, maxY: 50 };
    const t = fitToBox(box, 800, 600, 60);
    // box center (0,0) maps to viewport center (400,300)
    expect(t.applyX(0)).toBeCloseTo(400, 3);
    expect(t.applyY(0)).toBeCloseTo(300, 3);
    // width 200 with 60 pad each side → fits inside 800-120=680 → k≈3.4, but the
    // limiting dim is height 100 vs 600-120=480 → k=4.8; min of the two = 3.4
    expect(t.k).toBeCloseTo((800 - 120) / 200, 3);
  });

  it("easeCubicInOut is clamped and symmetric-ish", () => {
    expect(easeCubicInOut(0)).toBe(0);
    expect(easeCubicInOut(1)).toBe(1);
    expect(easeCubicInOut(-1)).toBe(0);
    expect(easeCubicInOut(2)).toBe(1);
    expect(easeCubicInOut(0.5)).toBeCloseTo(0.5, 6);
  });

  it("interpolateTransform hits both endpoints", () => {
    const a = makeTransform(1, 0, 0);
    const b = makeTransform(4, 100, 50);
    const at0 = interpolateTransform(a, b, 0);
    const at1 = interpolateTransform(a, b, 1);
    expect(transformsClose(at0, a)).toBe(true);
    expect(transformsClose(at1, b)).toBe(true);
    // scale interpolates in log space → midpoint scale = sqrt(1*4)=2
    expect(interpolateTransform(a, b, 0.5).k).toBeCloseTo(2, 4);
  });
});
