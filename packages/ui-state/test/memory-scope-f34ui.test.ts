import { describe, it, expect } from "vitest";
import {
  cycleScopeSel, parseMemoryQuery, scopeMatches, scopeNames, scopeSearchParam,
  scopeSelLabel, scopeSummary, scopeToken,
} from "../src/memory.js";
import { reduce } from "../src/reducer.js";
import { initialState } from "../src/types.js";

// F34.UI (QA F34 §6): the scope axis needs its own operator vocabulary — a sigil
// that folder names can never collide with, an honest post-filter, and a summary
// that reads as words on a store where nothing is scoped yet.
describe("F34.UI scope helpers", () => {
  it("scopeToken sigils BOTH the null case and a named scope", () => {
    expect(scopeToken(null)).toBe("@global");     // never bare "global" — folders can be named that
    expect(scopeToken("alpha")).toBe("@alpha");
  });

  it("scopeSelLabel names the three selection kinds", () => {
    expect(scopeSelLabel({ kind: "all" })).toBe("all scopes");
    expect(scopeSelLabel({ kind: "global" })).toBe("@global");
    expect(scopeSelLabel({ kind: "scope", name: "alpha" })).toBe("@alpha");
  });

  it("scopeMatches is case-insensitive and treats null as global only", () => {
    expect(scopeMatches({ kind: "all" }, "alpha")).toBe(true);
    expect(scopeMatches({ kind: "global" }, null)).toBe(true);
    expect(scopeMatches({ kind: "global" }, "alpha")).toBe(false);
    expect(scopeMatches({ kind: "scope", name: "Alpha" }, "alpha")).toBe(true);
    expect(scopeMatches({ kind: "scope", name: "alpha" }, null)).toBe(false);
  });

  it("scopeNames drops the null bucket and sorts; tolerates a byScope-less daemon", () => {
    expect(scopeNames([{ scope: null, count: 9 }, { scope: "b", count: 1 }, { scope: "a", count: 2 }])).toEqual(["a", "b"]);
    expect(scopeNames(undefined)).toEqual([]);
  });

  it("scopeSummary says day-one in words, then counts", () => {
    expect(scopeSummary([{ scope: null, count: 1641 }])).toBe("all 1641 global · no project scopes yet");
    expect(scopeSummary([{ scope: null, count: 1641 }, { scope: "a", count: 3 }])).toBe("1 scope · 1641 global");
    expect(scopeSummary([{ scope: null, count: 1641 }, { scope: "a", count: 3 }, { scope: "b", count: 1 }])).toBe("2 scopes · 1641 global");
    expect(scopeSummary(undefined)).toBe("all 0 global · no project scopes yet");
  });

  it("cycleScopeSel rings all → @global → each project scope → all", () => {
    let sel = cycleScopeSel({ kind: "all" }, ["a", "b"]);
    expect(sel).toEqual({ kind: "global" });
    sel = cycleScopeSel(sel, ["a", "b"]);
    expect(sel).toEqual({ kind: "scope", name: "a" });
    sel = cycleScopeSel(sel, ["a", "b"]);
    expect(sel).toEqual({ kind: "scope", name: "b" });
    expect(cycleScopeSel(sel, ["a", "b"])).toEqual({ kind: "all" });
    // A scope that vanished from stats must not strand the cycle.
    expect(cycleScopeSel({ kind: "scope", name: "gone" }, ["a"])).toEqual({ kind: "all" });
  });

  it("F34-SCOPE-FILTER: scopeSearchParam feeds the server-side scopeMode filter", () => {
    // "scope" mode: exact-membership to the named project, no global widening.
    expect(scopeSearchParam({ kind: "scope", name: "alpha" })).toEqual({ scope: "alpha", scopeMode: "project" });
    // "global" mode: exact-membership to unscoped records.
    expect(scopeSearchParam({ kind: "global" })).toEqual({ scopeMode: "global" });
    // "all": no narrowing at all — server default widening behaviour.
    expect(scopeSearchParam({ kind: "all" })).toEqual({});
  });

  it("parseMemoryQuery reads a scope: prefix; bare `scope:` clears it", () => {
    expect(parseMemoryQuery("scope:alpha gate")).toMatchObject({ query: "gate", scope: { kind: "scope", name: "alpha" } });
    expect(parseMemoryQuery("scope:global")).toMatchObject({ scope: { kind: "global" } });
    expect(parseMemoryQuery("scope:").scope).toBeUndefined();   // bare `scope:` clears (callers default to all)
    expect(parseMemoryQuery("gate").scope).toBeUndefined();
  });

  it("reducer: memoryScope + memoryStats carry the new state", () => {
    const st = reduce(initialState, { type: "memoryScope", scope: { kind: "scope", name: "alpha" } });
    expect(st.memory.scope).toEqual({ kind: "scope", name: "alpha" });
    const st2 = reduce(st, { type: "memoryStats", stats: { total: 4, byScope: [{ scope: null, count: 4 }] } });
    expect(st2.memoryStats?.total).toBe(4);
    expect(reduce(st2, { type: "memoryStats", stats: null }).memoryStats).toBeNull();
  });
});
