import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// SEARCH-STORM. Reported as the search box "going into a loop" when you type in it.
//
// events.search scans the WHOLE log. Measured against this operator's 575 MB of segments: 3503 ms
// for one query, and 26476 ms with the ten prefixes of a ten-character word in flight together —
// four seconds short of the bridge's own 30 s timeout. Typing built a backlog of multi-second
// scans whose replies landed OUT OF ORDER and overwrote each other, so the visible results
// flickered between the query you had typed and one you had already moved past.
//
// The three guards are asserted against the source because the failure is about scheduling and
// ordering across real async boundaries, which this suite's no-DOM renderer cannot drive; a test
// that mounted the screen and stubbed the clock would be asserting its own stubs.

const SRC = readFileSync(join(__dirname, "../src/screens/EventsScreen.tsx"), "utf8");
const runSearch = SRC.slice(SRC.indexOf("const runSearch"), SRC.indexOf("}, [query, runSearch]);"));

describe("typing in the events search cannot pile up or paint stale results", () => {
  it("DROPS a reply whose query is no longer the current one", () => {
    // The correctness half, and the one a debounce cannot substitute for: without it a slower
    // earlier search still wins over a faster later one, whatever the delay is tuned to.
    expect(runSearch).toContain("searchSeq");
    expect(runSearch).toMatch(/if \(seq !== searchSeq\.current\) return;/);
  });

  it("guards the error and the spinner by the same sequence, not just the hits", () => {
    // A stale REJECTION painting an error over a query that succeeded, or a stale settle clearing
    // the spinner while the current search is still running, are the same bug wearing other
    // clothes.
    const settle = runSearch.slice(runSearch.indexOf(".catch("));
    expect(settle).toContain("seq === searchSeq.current");
    expect(settle.match(/seq === searchSeq\.current/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("bumps the sequence when the box is cleared, so nothing in flight repaints it", () => {
    const effect = SRC.slice(SRC.indexOf("if (q.length < SEARCH_MIN_CHARS) {"), SRC.indexOf("}, [query, runSearch]);"));
    expect(effect).toContain("searchSeq.current++");
  });

  it("refuses a query too short to be worth a full scan, and SAYS the minimum", () => {
    // "c" matches almost every event in the log and costs a whole scan to say so. A minimum that
    // is not stated reads as "the log is empty", so the placeholder carries it.
    expect(SRC).toMatch(/const SEARCH_MIN_CHARS = [3-9]/);
    expect(SRC).toContain("${SEARCH_MIN_CHARS}+ chars");
  });

  it("debounces on the scale of the operation, not of an instant filter", () => {
    // 180 ms suits a search that answers immediately. For one measured in seconds it only
    // guarantees the backlog it was meant to prevent.
    const ms = Number(/const SEARCH_DEBOUNCE_MS = (\d+)/.exec(SRC)?.[1] ?? 0);
    expect(ms).toBeGreaterThanOrEqual(400);
  });
});
