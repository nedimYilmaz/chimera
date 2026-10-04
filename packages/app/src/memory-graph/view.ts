// MEM-6 §5.2/§5.3 — pan/zoom transform algebra, built on d3-zoom's ZoomTransform
// (pure {k,x,y} + apply/invert; NO d3-selection / DOM binding needed — we drive
// the wheel/drag gestures on the canvas ourselves). This module is pure and
// unit-testable: it converts world↔screen, zooms toward a cursor point, fits a
// world box into the viewport, and interpolates between transforms for the
// 400ms animated search-focus (§5.2).
import { zoomIdentity, type ZoomTransform } from "d3-zoom";

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;

export function clampScale(k: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, k));
}

/** Build a ZoomTransform with the given fields. `translate` then `scale` on the
 *  identity yields exactly {k, x, y} (scale leaves x/y untouched). */
export function makeTransform(k: number, x: number, y: number): ZoomTransform {
  return zoomIdentity.translate(x, y).scale(k);
}

/** New transform at scale `k` that keeps the world point currently under screen
 *  (px,py) fixed there — the wheel-zoom-toward-cursor invariant. */
export function zoomToward(t: ZoomTransform, k: number, px: number, py: number): ZoomTransform {
  const nk = clampScale(k);
  const wx = t.invertX(px);
  const wy = t.invertY(py);
  return makeTransform(nk, px - wx * nk, py - wy * nk);
}

/** Transform that fits `box` (world coords) into a viewW×viewH viewport with
 *  `pad` screen px of margin, centered. */
export function fitToBox(box: Box, viewW: number, viewH: number, pad = 60): ZoomTransform {
  const bw = Math.max(1, box.maxX - box.minX);
  const bh = Math.max(1, box.maxY - box.minY);
  const k = clampScale(Math.min((viewW - 2 * pad) / bw, (viewH - 2 * pad) / bh));
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  return makeTransform(k, viewW / 2 - cx * k, viewH / 2 - cy * k);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Cubic in-out ease for the focus animation. */
export function easeCubicInOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/** Interpolate between two transforms at eased fraction `e` (scale in log space
 *  so the zoom feels perceptually even). */
export function interpolateTransform(a: ZoomTransform, b: ZoomTransform, e: number): ZoomTransform {
  const k = Math.exp(lerp(Math.log(a.k), Math.log(b.k), e));
  return makeTransform(k, lerp(a.x, b.x, e), lerp(a.y, b.y, e));
}

/** Are two transforms close enough to treat the animation as finished? */
export function transformsClose(a: ZoomTransform, b: ZoomTransform): boolean {
  return Math.abs(a.k - b.k) < 1e-3 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}
