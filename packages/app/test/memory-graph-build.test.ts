import { describe, expect, it } from "vitest";
import type { MemoryGraphResult } from "@chimera/protocol";
import { buildSimData, endpointId, nodeRadius } from "../src/memory-graph/build";

function ghostResult(): MemoryGraphResult {
  return {
    nodes: [
      { id: "a", title: "A", label: "A", kind: "decision", folder: "ops", tags: [], degree: 2, updatedAt: 1 },
      { id: "b", title: null, label: "b note", kind: "note", folder: null, tags: ["x"], degree: 1, updatedAt: 2 },
      { id: "ghost:retry doctrine", title: "Retry doctrine", label: "Retry doctrine", kind: null, folder: null, tags: [], degree: 1, updatedAt: null, ghost: true },
    ],
    edges: [
      { source: "a", target: "b", kind: "link", weight: 1 },
      { source: "a", target: "ghost:retry doctrine", kind: "link", weight: 1 },
      // dangling: target not present → must be dropped defensively
      { source: "a", target: "missing", kind: "link", weight: 1 },
    ],
  };
}

describe("memory-graph build", () => {
  it("nodeRadius grows sub-linearly from a 2.5 floor", () => {
    expect(nodeRadius(0)).toBeCloseTo(2.5, 5);
    expect(nodeRadius(1)).toBeCloseTo(2.5 + 1.5, 5); // log2(2)=1
    expect(nodeRadius(3)).toBeCloseTo(2.5 + 3, 5); // log2(4)=2
    expect(nodeRadius(7)).toBeGreaterThan(nodeRadius(3));
    // guards negatives
    expect(nodeRadius(-5)).toBeCloseTo(2.5, 5);
  });

  it("builds sim nodes with radius + ghost flag and drops dangling edges", () => {
    const { nodes, links } = buildSimData(ghostResult());
    expect(nodes).toHaveLength(3);
    const ghost = nodes.find((n) => n.id.startsWith("ghost:"));
    expect(ghost?.ghost).toBe(true);
    expect(ghost?.kind).toBeNull();
    expect(nodes.find((n) => n.id === "a")?.radius).toBeCloseTo(nodeRadius(2), 5);
    // the "missing" edge is gone; the two valid edges remain
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.source === "a")).toBe(true);
  });

  it("endpointId works for id and resolved-node forms", () => {
    expect(endpointId("a")).toBe("a");
    expect(endpointId({ id: "z" } as never)).toBe("z");
  });
});
