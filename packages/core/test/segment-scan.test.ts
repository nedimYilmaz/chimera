import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { scanSegments, scanSegmentsInline, stopSegmentWorker } from "@chimera/core/segment-scan";

// SEGMENT-SCAN: the sealed-segment read, off the event loop.
//
// The blocking call this replaces: newestMatching stops at `need` matches, so a request that can
// never be satisfied — an agent whose events have rotated away — reads EVERY segment with
// readFileSync + JSON.parse first. Measured on an operator's machine at 60 segments / 575 MB and
// up to 13 SECONDS of a frozen daemon, from one transcript click.
//
// Two properties matter and both are pinned here: the worker must agree with the inline reference
// EXACTLY (a faster answer that differs is not an optimisation, it is a bug), and the event loop
// must stay responsive while the scan runs, which is the entire point.

afterAll(() => stopSegmentWorker());

/** A log directory with `count` sealed segments, each holding `per` events, alternating agents. */
function makeSegments(count: number, per: number): { dir: string; segments: Array<{ file: string; startSeq: number }> } {
  const dir = mkdtempSync(join(tmpdir(), "chimera-segscan-"));
  mkdirSync(join(dir, "events"), { recursive: true });
  const segments: Array<{ file: string; startSeq: number }> = [];
  let seq = 1;
  for (let s = 0; s < count; s++) {
    const startSeq = seq;
    const lines: string[] = [];
    for (let i = 0; i < per; i++) {
      lines.push(JSON.stringify({ seq, ts: 1_700_000_000 + seq, agentId: seq % 2 === 0 ? "even" : "odd", kind: "status", data: { i } }));
      seq++;
    }
    const file = join(dir, "events", `events.${startSeq}-${seq - 1}.jsonl`);
    writeFileSync(file, lines.join("\n") + "\n");
    segments.push({ file, startSeq });
  }
  return { dir, segments: segments.reverse() };   // newest-first, the order the scan walks
}

describe("the worker and the inline reference agree", () => {
  it("returns identical events for an agent spread across segments", async () => {
    const { segments } = makeSegments(4, 25);
    const req = { segments, agentId: "even", need: 30 };
    expect(await scanSegments(req)).toEqual(scanSegmentsInline(req));
  });

  it("agrees on the WORST case — a filter that matches nothing, so every segment is read", async () => {
    // Exactly the operator's situation: an agent whose events rotated away. Neither path may
    // invent a match, and both must walk the whole set to prove there is none.
    const { segments } = makeSegments(6, 20);
    const req = { segments, agentId: "gone", need: 500 };
    const viaWorker = await scanSegments(req);
    expect(viaWorker).toEqual([]);
    expect(viaWorker).toEqual(scanSegmentsInline(req));
  });

  it("agrees on ordering — oldest-first across segments, append order within one", async () => {
    const { segments } = makeSegments(3, 10);
    const req = { segments, agentId: null, need: 1000 };
    const got = await scanSegments(req);
    expect(got).toEqual(scanSegmentsInline(req));
    expect(got.map((e) => e.seq)).toEqual([...got.map((e) => e.seq)].sort((a, b) => a - b));
  });

  it("agrees on a toSeq bound, and skips a segment the bound rules out", async () => {
    const { segments } = makeSegments(4, 25);
    const req = { segments, agentId: null, toSeq: 30, need: 1000 };
    const got = await scanSegments(req);
    expect(got).toEqual(scanSegmentsInline(req));
    expect(Math.max(...got.map((e) => e.seq))).toBeLessThanOrEqual(30);
  });

  it("agrees on a TORN final line — a crash mid-append must be skipped, never thrown on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-segscan-torn-"));
    mkdirSync(join(dir, "events"), { recursive: true });
    const file = join(dir, "events", "events.1-3.jsonl");
    writeFileSync(file, [
      JSON.stringify({ seq: 1, ts: 1, agentId: "a", kind: "status", data: {} }),
      JSON.stringify({ seq: 2, ts: 2, agentId: "a", kind: "status", data: {} }),
      '{"seq":3,"agentId":"a","kind":"stat',   // torn
    ].join("\n"));
    const req = { segments: [{ file, startSeq: 1 }], agentId: "a", need: 10 };
    const got = await scanSegments(req);
    expect(got.map((e) => e.seq)).toEqual([1, 2]);
    expect(got).toEqual(scanSegmentsInline(req));
  });

  it("agrees when a segment file is missing entirely", async () => {
    const req = { segments: [{ file: "/nonexistent/events.1-9.jsonl", startSeq: 1 }], agentId: null, need: 5 };
    expect(await scanSegments(req)).toEqual([]);
    expect(await scanSegments(req)).toEqual(scanSegmentsInline(req));
  });

  it("STOPS once it has enough, rather than reading every segment", async () => {
    // The early exit is what keeps an ordinary transcript request at one segment. Verified by
    // pointing the tail of the list at a file that would throw if opened: reaching it means the
    // scan did not stop when it should have.
    const { segments } = makeSegments(3, 50);
    const withTrap = [...segments, { file: "/nonexistent/trap.jsonl", startSeq: 1 }];
    const got = await scanSegments({ segments: withTrap, agentId: null, need: 10 });
    expect(got.length).toBeGreaterThanOrEqual(10);
  });
});

describe("the event loop keeps running during a scan", () => {
  it("lets the event loop turn while sealed segments are being read", async () => {
    // The property the whole change exists for: the read must not hold the daemon's thread.
    // Asserted by ORDER, not by time. An inline read finishes inside the call, so the scan's
    // promise settles before any queued setImmediate; an off-thread read can only answer through a
    // later loop turn, so the setImmediate runs first. Counting 1ms interval ticks used to stand in
    // for this, but a warm worker answers in ~2ms on Linux and the interval never fired.
    const { segments } = makeSegments(8, 400);
    let loopTurned = false;
    setImmediate(() => { loopTurned = true; });
    await scanSegments({ segments, agentId: "nobody", need: 500 });   // worst case: reads them all
    expect(loopTurned).toBe(true);
  });

  it("the order check above would catch an inline read", async () => {
    // Guards the guard: the same check against the synchronous reference must come out false,
    // or the test above would pass whatever thread the read ran on.
    const { segments } = makeSegments(8, 400);
    let loopTurned = false;
    setImmediate(() => { loopTurned = true; });
    await Promise.resolve(scanSegmentsInline({ segments, agentId: "nobody", need: 500 }));
    expect(loopTurned).toBe(false);
  });
});

describe("EventLog.replayAsync / tailAsync", () => {
  it("finds sparse voice history across sealed coding segments and after reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-voice-history-"));
    const log = new EventLog(dir, { maxEventsPerSegment: 5, integrityScan: "sync" });
    for (let i = 0; i < 32; i++) log.append({ agentId: "a", kind: i % 10 === 0 ? "voice_native_message" : "status", data: { i } });
    log.append({ agentId: "other", kind: "voice_native_message", data: { i: 99 } });
    expect((await log.tailKindAsync("a", "voice_native_message", 3)).map(e => e.data["i"])).toEqual([10, 20, 30]);
    const reloaded = new EventLog(dir, { integrityScan: "sync" });
    expect((await reloaded.tailKindAsync("a", "voice_native_message", 3)).map(e => e.data["i"])).toEqual([10, 20, 30]);
    expect(await log.tailKindAsync("a", "voice_native_message", 0)).toEqual([]);
  });
  it("matches the synchronous twin, including across sealed segments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-segscan-log-"));
    const log = new EventLog(dir, { maxEventsPerSegment: 10, integrityScan: "sync" });
    for (let i = 0; i < 55; i++) log.append({ agentId: i % 3 === 0 ? "a" : "b", kind: "status", data: { i } });

    // Deep enough that the in-memory active window cannot answer it alone — the sealed path runs.
    expect(await log.replayAsync({ agentId: "a", limit: 15 })).toEqual(log.replay({ agentId: "a", limit: 15 }));
    expect(await log.tailAsync("a", 12)).toEqual(log.tail("a", 12));
    expect(await log.replayAsync({ agentId: "a", toSeq: 20, limit: 15 })).toEqual(log.replay({ agentId: "a", toSeq: 20, limit: 15 }));
    // An agent with no events at all: the case that used to read every segment for nothing.
    expect(await log.replayAsync({ agentId: "ghost", limit: 500 })).toEqual([]);
  });

  it("serves a request the in-memory window already covers without touching disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-segscan-recent-"));
    const log = new EventLog(dir, { maxEventsPerSegment: 1000, integrityScan: "sync" });
    for (let i = 0; i < 20; i++) log.append({ agentId: "a", kind: "status", data: { i } });
    expect((await log.replayAsync({ agentId: "a", limit: 5 })).length).toBe(5);
    expect(await log.replayAsync({ agentId: "a", limit: 5 })).toEqual(log.replay({ agentId: "a", limit: 5 }));
  });

  it("keeps the forward (fromSeq) branch byte-identical to the sync path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-segscan-fwd-"));
    const log = new EventLog(dir, { maxEventsPerSegment: 10, integrityScan: "sync" });
    for (let i = 0; i < 40; i++) log.append({ agentId: "a", kind: "status", data: { i } });
    expect(await log.replayAsync({ fromSeq: 5, limit: 10 })).toEqual(log.replay({ fromSeq: 5, limit: 10 }));
  });
});

// SEARCH-OFF-THREAD: search() walks EVERY sealed segment, and searchExport calls it in a LOOP to
// page — so one export re-read the whole log once per page, synchronously, on the thread that
// answers every RPC. searchAsync moves the read and a coarse prefilter to the pool.
//
// The prefilter tests the RAW LINE, which is a superset of every field the real scorer extracts,
// so it can produce false positives but never a false negative. These pin that: the two paths must
// return the SAME hits, in the same order, or the "faster" one is simply wrong.
describe("searchAsync matches search exactly", () => {
  function loggedWith(entries: Array<{ agentId: string; text: string }>): EventLog {
    const dir = mkdtempSync(join(tmpdir(), "chimera-search-"));
    const log = new EventLog(dir, { maxEventsPerSegment: 8, integrityScan: "sync" });
    for (const e of entries) log.append({ agentId: e.agentId, kind: "result", data: { text: e.text } });
    return log;
  }

  const corpus = [
    { agentId: "a", text: "refactor the supervisor and wire compaction through" },
    { agentId: "b", text: "the compaction threshold lands near 450k" },
    { agentId: "a", text: "nothing to do with the subject at hand" },
    { agentId: "c", text: "COMPACTION in capitals, to prove the fold is case-insensitive" },
    { agentId: "b", text: "supervisor restart after a crash" },
    ...Array.from({ length: 30 }, (_, i) => ({ agentId: "filler", text: `unrelated filler line ${i}` })),
  ];

  it("agrees on a single-token query spanning several sealed segments", async () => {
    const log = loggedWith(corpus);
    const req = { query: "compaction", limit: 20 };
    const asyncRes = await log.searchAsync(req);
    expect(asyncRes.hits).toEqual(log.search(req).hits);
    expect(asyncRes.hits.length).toBeGreaterThan(0);   // a vacuous agreement would prove nothing
  });

  it("agrees on a MULTI-token query — every token must be present, not just one", async () => {
    const log = loggedWith(corpus);
    const req = { query: "supervisor compaction", limit: 20 };
    expect((await log.searchAsync(req)).hits).toEqual(log.search(req).hits);
  });

  it("agrees when nothing matches at all — the case that used to read every segment for nothing", async () => {
    const log = loggedWith(corpus);
    const req = { query: "kubernetes ingress controller", limit: 20 };
    expect((await log.searchAsync(req)).hits).toEqual([]);
    expect((await log.searchAsync(req)).hits).toEqual(log.search(req).hits);
  });

  it("agrees on the retained range it reports, which now comes from filenames not a read", async () => {
    const log = loggedWith(corpus);
    const req = { query: "compaction", limit: 5 };
    expect((await log.searchAsync(req)).retained).toEqual(log.search(req).retained);
  });

  it("agrees across a PAGED walk — the loop searchExport makes", async () => {
    const log = loggedWith(corpus);
    let cursorA: string | null | undefined = undefined;
    let cursorB: string | null | undefined = undefined;
    for (let page = 0; page < 3; page++) {
      const a = await log.searchAsync({ query: "compaction", limit: 1, ...(cursorA ? { cursor: cursorA } : {}) });
      const b = log.search({ query: "compaction", limit: 1, ...(cursorB ? { cursor: cursorB } : {}) });
      expect(a.hits).toEqual(b.hits);
      cursorA = a.nextCursor; cursorB = b.nextCursor;
      if (!cursorA) break;
    }
  });
});
