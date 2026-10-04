import { describe, expect, it } from "vitest";
import { nextMatchIndex } from "../src/state/transcriptFind";

// TRANSCRIPT-FIND — ⌘F as find-in-page. The count in the bar used to come from the events.search
// history index, which answers a different question from the marks on screen: with the word
// highlighted a dozen times in the transcript, the bar read "0 hits". And Enter was bound to
// nothing at all, so there was no way to walk the matches.
//
// The stepping MATH is what is pinned here — where the cursor lands is the decision; querying the
// DOM for the marks is glue.

describe("nextMatchIndex", () => {
  it("starts at the LAST match when stepping up from no cursor", () => {
    // Enter steps upward, and reading back through a transcript starts at the nearest thing behind
    // you — the bottom-most match, not the top-most.
    expect(nextMatchIndex(-1, 5, -1)).toBe(4);
  });

  it("starts at the first match when stepping down from no cursor", () => {
    expect(nextMatchIndex(-1, 5, 1)).toBe(0);
  });

  it("walks upward one at a time", () => {
    expect(nextMatchIndex(4, 5, -1)).toBe(3);
    expect(nextMatchIndex(1, 5, -1)).toBe(0);
  });

  it("wraps rather than stopping dead at either end", () => {
    // A find that stops silently is indistinguishable from a find that is broken: you press again,
    // nothing moves, and there is no way to tell "no more" from "not working".
    expect(nextMatchIndex(0, 5, -1)).toBe(4);
    expect(nextMatchIndex(4, 5, 1)).toBe(0);
  });

  it("has no cursor when there is nothing to step through", () => {
    expect(nextMatchIndex(-1, 0, -1)).toBe(-1);
    expect(nextMatchIndex(2, 0, 1)).toBe(-1);
  });

  it("lands somewhere valid from a cursor left over from a longer previous result", () => {
    // Typing another character shrinks the match set while the cursor still points into the old
    // one; an out-of-range index must not survive into a DOM lookup.
    expect(nextMatchIndex(9, 3, -1)).toBe(2);
    expect(nextMatchIndex(9, 3, 1)).toBe(0);
  });

  it("is stable on a single match — pressing enter again keeps you on it", () => {
    expect(nextMatchIndex(0, 1, -1)).toBe(0);
    expect(nextMatchIndex(0, 1, 1)).toBe(0);
  });
});
