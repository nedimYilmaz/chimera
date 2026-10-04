import { describe, expect, it } from "vitest";
import { msgKey, resolveRawCopy } from "../src/state/richMessages";

// F12 (W12) — the pure selection→RAW-copy resolver (node env, no DOM). Copy raw
// ONLY when both selection endpoints resolve to the SAME keyed message and its
// source is known; otherwise return null so the caller keeps the DOM text.

const lookup = (key: string): string | undefined =>
  ({ "a1#0": "| q | n |\n| - | - |\n| x | 1 |", "a1#2": "**bold** and `code`" })[key];

describe("msgKey", () => {
  it("encodes agent + transcript index", () => {
    expect(msgKey("a1", 2)).toBe("a1#2");
  });
});

describe("resolveRawCopy", () => {
  it("returns the RAW source when both endpoints share one keyed message", () => {
    expect(resolveRawCopy("a1#0", "a1#0", lookup)).toBe("| q | n |\n| - | - |\n| x | 1 |");
    expect(resolveRawCopy("a1#2", "a1#2", lookup)).toBe("**bold** and `code`");
  });

  it("falls back (null) for a cross-message drag", () => {
    expect(resolveRawCopy("a1#0", "a1#2", lookup)).toBeNull();
  });

  it("falls back (null) when an endpoint is outside any keyed message", () => {
    expect(resolveRawCopy(null, "a1#0", lookup)).toBeNull();
    expect(resolveRawCopy("a1#0", null, lookup)).toBeNull();
    expect(resolveRawCopy(null, null, lookup)).toBeNull();
  });

  it("falls back (null) when the source is unknown (stale/other agent)", () => {
    expect(resolveRawCopy("a1#9", "a1#9", lookup)).toBeNull();
  });
});
