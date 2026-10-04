// MEM-6 §5.2 — turn a MemoryGraphResult (MEM-2 wire shape) into d3-force sim
// data. Pure and deterministic (no positions seeded here — d3-force's default
// phyllotaxis init is deterministic), so it's fully unit-testable.
import type { MemoryGraphEdge, MemoryGraphNode, MemoryGraphResult } from "@chimera/protocol";
import type { SimData, SimLink, SimNode } from "./types";

// Node radius from degree (§5.2): a soft-glow dot, 2.5px floor growing sub-
// linearly (log2) so a hub with 200 links is prominent but not a blob.
export function nodeRadius(degree: number): number {
  return 2.5 + 1.5 * Math.log2(1 + Math.max(0, degree));
}

function toSimNode(n: MemoryGraphNode): SimNode {
  return {
    id: n.id,
    label: n.label,
    kind: n.kind,
    folder: n.folder,
    ghost: n.ghost === true,
    degree: n.degree,
    radius: nodeRadius(n.degree),
    color: "", // assigned by palette.applyNodeColors once tokens resolve
  };
}

function toSimLink(e: MemoryGraphEdge): SimLink {
  return { source: e.source, target: e.target, kind: e.kind, weight: e.weight };
}

/** MemoryGraphResult → SimData. Edges whose endpoints aren't both present are
 *  dropped defensively (the server already emits a clean subgraph, but a stale
 *  fetch mid-mutation could straggle — forceLink throws on an unknown id). */
export function buildSimData(result: MemoryGraphResult): SimData {
  const nodes = result.nodes.map(toSimNode);
  const ids = new Set(nodes.map((n) => n.id));
  const links = result.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map(toSimLink);
  return { nodes, links };
}

/** Resolve a link endpoint to its node id whether forceLink has swapped in the
 *  node object yet or not (source/target start as ids, become SimNode refs). */
export function endpointId(end: string | SimNode): string {
  return typeof end === "string" ? end : end.id;
}
