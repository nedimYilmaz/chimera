import { it, expect } from "vitest";
import { CanvasLayoutSchema, CanvasSaveLayoutSchema, emptyCanvasLayout } from "../src/canvas.js";
it("rejects unbounded/forged cosmetic layout requests", () => {
  expect(CanvasSaveLayoutSchema.safeParse({ projectId: "p", baseRevision: 0, layout: emptyCanvasLayout(), callerAgentId: "forged" }).success).toBe(false);
  expect(CanvasLayoutSchema.safeParse({ ...emptyCanvasLayout(), stickies: [{ id: "s", x: 0, y: 0, text: "x".repeat(501) }] }).success).toBe(false);
  expect(CanvasLayoutSchema.safeParse({ ...emptyCanvasLayout(), viewport: { x: Infinity, y: 0, zoom: 1 } }).success).toBe(false);
});
