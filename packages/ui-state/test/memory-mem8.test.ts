import { describe, it, expect } from "vitest";
import type { MemoryGetResult } from "@chimera/protocol";
import { parseMemoryQuery, memoryJumpTargets } from "../src/memory.js";
import { reduce } from "../src/reducer.js";
import { initialState } from "../src/types.js";

// MEM-8 (PLAN-MEMORY.md §9): the honest-minimal TUI memory fallback — client-parsed
// search prefixes, the note-adjacency jump-target derivation, and the reducer's
// detail/jump-cursor state.

describe("parseMemoryQuery (folder: / mode: prefixes)", () => {
  it("strips folder: and mode: and keeps the remaining words as the query", () => {
    expect(parseMemoryQuery("folder:ops/protocols mode:semantic gate death")).toEqual({
      query: "gate death", folder: "ops/protocols", mode: "semantic",
    });
  });
  it("returns an empty object for a pure whitespace / prefix-only string", () => {
    expect(parseMemoryQuery("   ")).toEqual({});
    expect(parseMemoryQuery("folder:")).toEqual({});          // bare folder: clears, no filter
  });
  it("drops an unrecognized mode value (falls back to the server default)", () => {
    expect(parseMemoryQuery("mode:fuzzy hello")).toEqual({ query: "hello" });
  });
  it("is prefix-position agnostic and last-wins per kind", () => {
    expect(parseMemoryQuery("hello mode:lexical world folder:a folder:b")).toEqual({
      query: "hello world", folder: "b", mode: "lexical",
    });
  });
  it("prefix match is case-insensitive; the folder value keeps its case", () => {
    expect(parseMemoryQuery("FOLDER:Ops MODE:HYBRID x")).toEqual({ query: "x", folder: "Ops", mode: "hybrid" });
  });
});

const detail = (over: Partial<MemoryGetResult> = {}): MemoryGetResult => ({
  record: { id: "a", author: "z", text: "note A body", title: "A", folder: null, tags: [], kind: "note", treeId: null, taskId: null, createdAt: 1, updatedAt: 1 },
  links: [],
  backlinks: [],
  ...over,
});

describe("memoryJumpTargets", () => {
  it("is empty for a null detail", () => {
    expect(memoryJumpTargets(null)).toEqual([]);
  });
  it("orders resolved links first, then backlinks; ghost/missing links are excluded", () => {
    const d = detail({
      links: [
        { target: "B", resolvedId: "b", resolvedTitle: "B" },            // resolved
        { target: "Ghost", resolvedId: null, resolvedTitle: "Ghost" },   // ghost — no id
        { target: "deadbeef", resolvedId: null, resolvedTitle: null },   // missing — no id
      ],
      backlinks: [{ id: "c", title: "C", kind: "note", folder: null, snippet: "…mentions [[a]]…" }],
    });
    expect(memoryJumpTargets(d)).toEqual([
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ]);
  });
  it("falls back to raw target / short id when a title is absent", () => {
    const d = detail({
      links: [{ target: "some-raw-target", resolvedId: "b", resolvedTitle: null }],
      backlinks: [{ id: "0123456789abcdef", title: null, kind: "fact", folder: null, snippet: "s" }],
    });
    expect(memoryJumpTargets(d)).toEqual([
      { id: "b", label: "some-raw-target" },
      { id: "0123456789abcdef", label: "01234567" },
    ]);
  });
});

describe("reducer: MEM-8 detail + jump cursor", () => {
  it("memoryDetail sets/clears the region and resets the jump cursor", () => {
    const d = detail({ links: [{ target: "B", resolvedId: "b", resolvedTitle: "B" }] });
    let st = reduce(initialState, { type: "memoryDetail", detail: d });
    expect(st.memoryDetail).toBe(d);
    expect(st.memoryDetailCursor).toBe(0);
    st = reduce({ ...st, memoryDetailCursor: 3 }, { type: "memoryDetail", detail: null });
    expect(st.memoryDetail).toBeNull();
    expect(st.memoryDetailCursor).toBe(0);
  });

  it("memoryDetailCursor clamps against the jump-target count", () => {
    const d = detail({
      links: [{ target: "B", resolvedId: "b", resolvedTitle: "B" }],
      backlinks: [{ id: "c", title: "C", kind: "note", folder: null, snippet: "s" }],
    });
    let st = reduce(initialState, { type: "memoryDetail", detail: d });   // 2 targets
    st = reduce(st, { type: "memoryDetailCursor", delta: 5 });
    expect(st.memoryDetailCursor).toBe(1);                                // clamped to last
    st = reduce(st, { type: "memoryDetailCursor", delta: -5 });
    expect(st.memoryDetailCursor).toBe(0);
  });

  it("memoryCursorSet jumps the record cursor to an absolute, clamped index", () => {
    let st = reduce(initialState, { type: "memory", items: [
      { record: { id: "a" } as never, score: 0 },
      { record: { id: "b" } as never, score: 0 },
    ] });
    st = reduce(st, { type: "memoryCursorSet", index: 1 });
    expect(st.memoryCursor).toBe(1);
    st = reduce(st, { type: "memoryCursorSet", index: 99 });
    expect(st.memoryCursor).toBe(1);                                      // clamped to last row
  });

  it("a fresh search reply and a query edit both close the detail region", () => {
    const d = detail();
    const open = reduce(initialState, { type: "memoryDetail", detail: d });
    expect(reduce(open, { type: "memory", items: [] }).memoryDetail).toBeNull();
    expect(reduce(open, { type: "memoryQuery", query: "x" }).memoryDetail).toBeNull();
  });
});
