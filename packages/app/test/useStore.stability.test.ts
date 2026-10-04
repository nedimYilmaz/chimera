import { describe, it, expect } from "vitest";
import { stableEqual } from "../src/state/useStore";

// SELECTOR-STABILITY — the equality behind useStore's snapshot cache. This exists because an
// allocating selector (`Object.values(...).filter(...).map(...)` in the secrets settings section)
// made useSyncExternalStore see a new reference on every read, which React resolves by tearing the
// tree down — a WHITE SCREEN the moment that section was opened. The rule against allocating
// selectors was already written in useStore.ts as a comment; it was violated anyway, across 146
// call sites, so the binding enforces it instead of describing it.

describe("stableEqual", () => {
  it("is identity-true for the common case, so stable selectors pay nothing", () => {
    const agent = { agentId: "a" };
    expect(stableEqual(agent, agent)).toBe(true);
    expect(stableEqual("x", "x")).toBe(true);
    expect(stableEqual(3, 3)).toBe(true);
    expect(stableEqual(null, null)).toBe(true);
  });

  it("sees a freshly-mapped list of records as unchanged — the exact shape that crashed the app", () => {
    const a = [{ agentId: "a", label: "alpha" }, { agentId: "b", label: "beta" }];
    const b = [{ agentId: "a", label: "alpha" }, { agentId: "b", label: "beta" }];
    expect(a).not.toBe(b);
    expect(stableEqual(a, b)).toBe(true);
  });

  it("still reports a REAL change, or the UI would stop updating", () => {
    // The failure mode of over-eager equality is worse than the one it fixes: a stale screen.
    expect(stableEqual([{ id: "a" }], [{ id: "b" }])).toBe(false);
    expect(stableEqual([{ id: "a" }], [{ id: "a" }, { id: "b" }])).toBe(false);
    expect(stableEqual({ n: 1 }, { n: 2 })).toBe(false);
    expect(stableEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(stableEqual([], {})).toBe(false);
  });

  it("stops at two levels rather than walking an arbitrarily deep slice on every dispatch", () => {
    // Bounded on purpose: an unbounded compare over a large state slice, run per hook per
    // notification, would trade a render bug for a performance one.
    const deep = (v: number) => [{ a: { b: { c: v } } }];
    expect(stableEqual(deep(1), deep(1))).toBe(false);   // beyond the bound => "changed"
  });

  it("compares a non-plain object by IDENTITY, never by walking its keys", () => {
    // A Map/Date/class instance has semantics its own keys do not describe; claiming equality from
    // an enumerable-key walk would be a claim we cannot support.
    expect(stableEqual(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(false);
    const d = new Date(0);
    expect(stableEqual(d, d)).toBe(true);
    expect(stableEqual(new Date(0), new Date(0))).toBe(false);
  });

  it("does not confuse an object with a null-prototype one", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare["a"] = 1;
    expect(stableEqual(bare, { a: 1 })).toBe(false);
  });

  it("treats NaN as equal to itself, matching Object.is rather than ===", () => {
    // React's own snapshot check uses Object.is; disagreeing with it here would reintroduce the
    // very loop this guards against, for any selector that can produce NaN.
    expect(stableEqual(NaN, NaN)).toBe(true);
    expect(stableEqual([NaN], [NaN])).toBe(true);
  });
});
