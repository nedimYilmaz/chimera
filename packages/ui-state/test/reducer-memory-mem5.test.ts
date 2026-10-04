import { describe, it, expect } from "vitest";
import { reduce, initialState } from "@chimera/ui-state";

// MEM-5 — the memory slice gained `mode` (search ranking) and `folder` (the
// folder-rail selection). Both are pure filter state: the reducer only stores
// them; the screen re-issues memory.search with the new params.

describe("MEM-5 memory slice — mode + folder selection", () => {
  it("defaults to hybrid mode and the 'all' folder", () => {
    expect(initialState.memory.mode).toBe("hybrid");
    expect(initialState.memory.folder).toEqual({ kind: "all" });
  });

  it("memoryMode swaps the ranking mode without touching items/query", () => {
    let s = reduce(initialState, { type: "memoryQuery", query: "retry" });
    s = reduce(s, { type: "memoryMode", mode: "lexical" });
    expect(s.memory.mode).toBe("lexical");
    expect(s.memory.query).toBe("retry");        // untouched
    s = reduce(s, { type: "memoryMode", mode: "semantic" });
    expect(s.memory.mode).toBe("semantic");
  });

  it("memoryFolder holds each of the three selection kinds", () => {
    let s = reduce(initialState, { type: "memoryFolder", folder: { kind: "unfiled" } });
    expect(s.memory.folder).toEqual({ kind: "unfiled" });
    s = reduce(s, { type: "memoryFolder", folder: { kind: "folder", path: "ops/protocols" } });
    expect(s.memory.folder).toEqual({ kind: "folder", path: "ops/protocols" });
    s = reduce(s, { type: "memoryFolder", folder: { kind: "all" } });
    expect(s.memory.folder).toEqual({ kind: "all" });
  });

  it("a fresh memory reply preserves mode + folder (only items/cursor change)", () => {
    let s = reduce(initialState, { type: "memoryMode", mode: "lexical" });
    s = reduce(s, { type: "memoryFolder", folder: { kind: "folder", path: "ops" } });
    s = reduce(s, { type: "memory", items: [{ record: { id: "m1" }, score: 0 } as never] });
    expect(s.memory.mode).toBe("lexical");
    expect(s.memory.folder).toEqual({ kind: "folder", path: "ops" });
    expect(s.memory.items).toHaveLength(1);
  });
});
