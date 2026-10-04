import { describe, expect, it } from "vitest";
import {
  KIND_TOKEN,
  applyNodeColors,
  folderTintIndex,
  nodeColor,
  resolvePalette,
} from "../src/memory-graph/palette";
import type { SimNode } from "../src/memory-graph/types";

// a fake CSS reader: returns a hex per token so we can assert the mapping
const fakeVars: Record<string, string> = {
  "--bg": " #14161a ",
  "--fg": "#d7dbe2",
  "--muted": "#828b9a",
  "--line": "#262b34",
  "--accent": "#9aa3f2",
  "--success": "#79c58c",
  "--warn": "#d6b06a",
  "--human": "#d78ad0",
  "--danger": "#e2766f",
};
const read = (n: string): string => fakeVars[n] ?? "";

function node(partial: Partial<SimNode>): SimNode {
  return { id: "x", label: "x", kind: "note", folder: null, ghost: false, degree: 0, radius: 3, color: "", ...partial };
}

describe("memory-graph palette", () => {
  it("maps every kind to a distinct semantic token", () => {
    expect(KIND_TOKEN.decision).toBe("--accent");
    expect(KIND_TOKEN.fact).toBe("--success");
    expect(KIND_TOKEN.todo).toBe("--warn");
    expect(KIND_TOKEN.question).toBe("--human");
    expect(KIND_TOKEN.note).toBe("--muted");
  });

  it("resolves + trims tokens, falling back when a var is empty", () => {
    const p = resolvePalette(read);
    expect(p.bg).toBe("#14161a"); // trimmed
    expect(p.byKind.decision).toBe("#9aa3f2");
    expect(p.byKind.fact).toBe("#79c58c");
    // missing token → hex fallback (never empty)
    const empty = resolvePalette(() => "");
    expect(empty.byKind.question.length).toBeGreaterThan(0);
    expect(empty.folderTints.every((c) => c.length > 0)).toBe(true);
  });

  it("colors nodes by kind, ghosts by muted", () => {
    const p = resolvePalette(read);
    expect(nodeColor(node({ kind: "fact" }), p, "kind")).toBe("#79c58c");
    expect(nodeColor(node({ kind: "decision" }), p, "kind")).toBe("#9aa3f2");
    expect(nodeColor(node({ ghost: true, kind: null }), p, "kind")).toBe(p.ghost);
  });

  it("folder tint is deterministic and stable per folder", () => {
    const p = resolvePalette(read);
    const a = folderTintIndex("ops/protocols", p.folderTints.length);
    const b = folderTintIndex("ops/protocols", p.folderTints.length);
    expect(a).toBe(b);
    expect(folderTintIndex(null, p.folderTints.length)).toBe(-1); // unfiled → muted
    const c1 = nodeColor(node({ folder: "ops", kind: "note" }), p, "folder");
    const c2 = nodeColor(node({ folder: "ops", kind: "note" }), p, "folder");
    expect(c1).toBe(c2);
    // unfiled falls back to muted under folder mode
    expect(nodeColor(node({ folder: null }), p, "folder")).toBe(p.muted);
  });

  it("applyNodeColors writes color onto every node", () => {
    const p = resolvePalette(read);
    const nodes = [node({ kind: "todo" }), node({ ghost: true, kind: null })];
    applyNodeColors(nodes, p, "kind");
    expect(nodes[0].color).toBe("#d6b06a");
    expect(nodes[1].color).toBe(p.ghost);
  });
});
