import type { CanvasLayout, CanvasNode, CanvasEdge } from "@chimera/protocol";
export const NODE_WIDTH = 184, NODE_HEIGHT = 76;
export type Point = { x: number; y: number };
export function canvasPositions(nodes: CanvasNode[], edges: CanvasEdge[], layout: CanvasLayout): Record<string, Point> {
  // Kind layers are stable under insertions; previously placed nodes always win.
  const kinds = ["agent", "task", "worktree", "artifact", "context-link", "issue", "cluster"];
  const result: Record<string, Point> = {};
  const rows = new Map<string, number>();
  const incoming = new Set(edges.filter(e => e.kind === "fork").map(e => e.to));
  for (const node of nodes) {
    const row = rows.get(node.kind) ?? 0; rows.set(node.kind, row + 1);
    const column = kinds.indexOf(node.kind) + (node.kind === "agent" && incoming.has(node.ref) ? 1 : 0);
    result[node.ref] = layout.positions[node.ref] ?? { x: 30 + column * 230, y: 30 + row * 110 };
  }
  return result;
}
export function canvasDelta(dx: number, dy: number, zoom: number): Point { return { x: dx / zoom, y: dy / zoom }; }
export function zoomCanvas(view: CanvasLayout["viewport"], zoom: number, anchor: Point): CanvasLayout["viewport"] {
  const next = Math.min(3, Math.max(0.2, zoom));
  return { x: anchor.x - (anchor.x - view.x) * next / view.zoom, y: anchor.y - (anchor.y - view.y) * next / view.zoom, zoom: next };
}
export function visibleCanvasNodes(nodes: CanvasNode[], positions: Record<string, Point>, view: CanvasLayout["viewport"], width: number, height: number, selected: string | null): CanvasNode[] {
  const visible = nodes.filter(n => { const p = positions[n.ref]!; return n.ref === selected || (p.x + NODE_WIDTH) * view.zoom + view.x >= -100 && p.x * view.zoom + view.x <= width + 100 && (p.y + NODE_HEIGHT) * view.zoom + view.y >= -100 && p.y * view.zoom + view.y <= height + 100; }).slice(0, 80);
  const picked = selected ? nodes.find(n => n.ref === selected) : undefined;
  if (picked && !visible.includes(picked)) visible.splice(Math.min(79, visible.length), 1, picked);
  return visible;
}

export function filterCanvasNodes(nodes: CanvasNode[], query: string): CanvasNode[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return nodes.filter(n => words.every(word => `${n.kind} ${n.entityId} ${n.label} ${n.status}`.toLowerCase().includes(word)));
}
