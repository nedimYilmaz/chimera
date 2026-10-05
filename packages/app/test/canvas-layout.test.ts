import { it, expect } from "vitest";
import { emptyCanvasLayout, type CanvasNode } from "@chimera/protocol";
import { canvasPositions, visibleCanvasNodes, canvasDelta, zoomCanvas, filterCanvasNodes } from "../src/state/canvas-layout";
const nodes: CanvasNode[] = Array.from({ length: 300 }, (_, i) => ({ ref: `agent:${i}`, entityId: String(i), kind: "agent", status: "idle", label: String(i) }));
it("keeps saved nodes fixed under removals and insertions, and bounds large view rendering", () => {
  const layout = { ...emptyCanvasLayout(), positions: { "agent:2": { x: 700, y: 650 } } };
  const positions = canvasPositions(nodes, [], layout);
  expect(canvasPositions(nodes.slice(2), [], layout)["agent:2"]).toEqual({ x: 700, y: 650 });
  expect(visibleCanvasNodes(nodes, positions, layout.viewport, 600, 430, null).length).toBeLessThan(15);
  expect(visibleCanvasNodes(nodes, positions, layout.viewport, 100000, 100000, null)).toHaveLength(80);
});
it("converts pointer deltas at scaled zoom and preserves the zoom anchor", () => {
  expect(canvasDelta(40, 20, 0.5)).toEqual({ x: 80, y: 40 });
  const view = zoomCanvas({ x: 20, y: 10, zoom: 1 }, 2, { x: 100, y: 100 });
  expect(view).toEqual({ x: -60, y: -80, zoom: 2 });
  expect((100 - view.x) / view.zoom).toBe(80);
});
it("keeps the selected entity in the bounded set even at large zoomed-out views", () => {
  const positions = canvasPositions(nodes, [], emptyCanvasLayout());
  const visible = visibleCanvasNodes(nodes, positions, { x: 0, y: 0, zoom: 0.2 }, 10000, 10000, "agent:299");
  expect(visible).toHaveLength(80); expect(visible.some(n => n.ref === "agent:299")).toBe(true);
});

it("filters included metadata by type, status and identity without mutating the full graph", () => {
  expect(filterCanvasNodes(nodes, "agent idle 299").map(n => n.ref)).toEqual(["agent:299"]);
  expect(filterCanvasNodes(nodes, "missing")).toEqual([]);
  expect(filterCanvasNodes(nodes, " ")).toHaveLength(300);
  expect(nodes).toHaveLength(300);
});
