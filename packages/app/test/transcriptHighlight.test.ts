import { describe, it, expect, beforeEach } from "vitest";
import {
  highlightQuery, setHighlightQuery, splitHighlight, subscribeHighlight,
} from "../src/state/transcriptHighlight";

// TRANSCRIPT-HIGHLIGHT — ⌘F now opens the transcript's search, and what it finds is marked in the
// transcript itself. The splitting is where this can go wrong invisibly: a highlight that rewrites
// the text it marks looks like a rendering glitch, not like a search bug.

beforeEach(() => setHighlightQuery(""));

describe("splitHighlight", () => {
  it("marks a match and leaves the rest alone", () => {
    expect(splitHighlight("the queue never drained", "queue")).toEqual([
      { text: "the ", hit: false },
      { text: "queue", hit: true },
      { text: " never drained", hit: false },
    ]);
  });

  it("marks EVERY occurrence, not just the first", () => {
    expect(splitHighlight("a b a b a", "a").filter((p) => p.hit)).toHaveLength(3);
  });

  it("matches case-insensitively but keeps the ORIGINAL casing", () => {
    // Marking "ERROR" and rendering "error" would silently rewrite the transcript.
    expect(splitHighlight("An ERROR and an error", "error")).toEqual([
      { text: "An ", hit: false },
      { text: "ERROR", hit: true },
      { text: " and an ", hit: false },
      { text: "error", hit: true },
    ]);
  });

  it("treats the query LITERALLY — it comes from an input, not from a regex", () => {
    // `(`, `*` and `.` are ordinary characters someone searches for. As regex syntax they would
    // either throw or match the wrong thing.
    expect(splitHighlight("call foo(bar) now", "foo(bar)").filter((p) => p.hit)).toEqual([{ text: "foo(bar)", hit: true }]);
    expect(splitHighlight("a.b and axb", ".").filter((p) => p.hit)).toEqual([{ text: ".", hit: true }]);
    expect(() => splitHighlight("anything", "[")).not.toThrow();
  });

  it("returns ONE unmatched run when there is nothing to mark", () => {
    // One code path for the caller, one small allocation in the common case.
    expect(splitHighlight("nothing here", "absent")).toEqual([{ text: "nothing here", hit: false }]);
    expect(splitHighlight("text", "")).toEqual([{ text: "text", hit: false }]);
    expect(splitHighlight("", "q")).toEqual([{ text: "", hit: false }]);
  });

  it("handles a match at either end without emitting empty runs", () => {
    expect(splitHighlight("queue drained", "queue")).toEqual([
      { text: "queue", hit: true },
      { text: " drained", hit: false },
    ]);
    expect(splitHighlight("drained queue", "queue")).toEqual([
      { text: "drained ", hit: false },
      { text: "queue", hit: true },
    ]);
    expect(splitHighlight("queue", "queue")).toEqual([{ text: "queue", hit: true }]);
  });

  it("does not loop forever on overlapping candidates", () => {
    // The cursor advances by the needle's length, so "aa" in "aaaa" is two matches, not four and
    // not an infinite scan.
    expect(splitHighlight("aaaa", "aa")).toEqual([
      { text: "aa", hit: true },
      { text: "aa", hit: true },
    ]);
  });
});

describe("the published query", () => {
  it("trims, because a half-typed query is whitespace and marking every gap is worse than nothing", () => {
    setHighlightQuery("  queue  ");
    expect(highlightQuery()).toBe("queue");
    setHighlightQuery("   ");
    expect(highlightQuery()).toBe("");
  });

  it("notifies only on a real change, so a re-render does not repaint the transcript", () => {
    let fired = 0;
    const off = subscribeHighlight(() => { fired++; });
    setHighlightQuery("queue");
    expect(fired).toBe(1);
    setHighlightQuery("queue");
    expect(fired).toBe(1);
    setHighlightQuery(" queue ");   // same after trimming
    expect(fired).toBe(1);
    off();
  });

  it("can be cleared", () => {
    setHighlightQuery("queue");
    setHighlightQuery("");
    expect(highlightQuery()).toBe("");
  });
});
