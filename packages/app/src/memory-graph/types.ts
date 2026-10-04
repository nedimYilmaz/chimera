// MEM-6 (PLAN-MEMORY.md §5) — the neural graph view's internal data model.
// Kept framework-free: everything here is plain data the hand-rolled canvas
// renderer (renderer.ts) and its d3-force simulation share. Wire types come
// from @chimera/protocol; these are the *simulation-side* mirrors d3-force
// mutates in place (x/y/vx/vy/fx/fy/index).
import type { MemoryKind } from "@chimera/protocol";

// One physics body. `radius`/`color` are derived once at setData time (degree
// sizing + kind→token color) so the per-frame draw never recomputes them.
// d3-force writes x/y/vx/vy/index; fx/fy pin a dragged node.
export interface SimNode {
  id: string;
  label: string;
  kind: MemoryKind | null; // null on ghost nodes
  folder: string | null;
  ghost: boolean;
  degree: number;
  radius: number; // world-space px, from degree (build.ts)
  color: string; // resolved token color (assigned after palette resolution)
  // d3-force SimulationNodeDatum fields (mutated in place):
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  index?: number;
}

// One edge. d3-force's forceLink replaces source/target (ids) with SimNode refs
// after the first init, so both forms are valid at runtime.
export interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
  kind: "link" | "semantic";
  weight: number;
}

export interface SimData {
  nodes: SimNode[];
  links: SimLink[];
}

// The token colors the renderer reads from CSS once at mount (canvas can't use
// var() — §5.2). Keyed so build/palette stay hex-free (token-only rule).
export interface GraphPalette {
  bg: string;
  fg: string;
  muted: string;
  line: string;
  byKind: Record<MemoryKind, string>;
  ghost: string; // hollow-ring stroke for dangling [[Title]] nodes
  // rotating tints for the "color by folder" toggle (§5.2)
  folderTints: string[];
}

// How nodes are colored: by record kind (default) or a per-folder tint (§5.2).
export type ColorMode = "kind" | "folder";
