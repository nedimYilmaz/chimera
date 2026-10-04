import { describe, it, expect } from "vitest";
import { initialState, reduce, TRANSCRIPT_BUFFER_MAX } from "@chimera/ui-state";
import type { NormalizedEvent } from "@chimera/protocol";

// TRANSCRIPT-TAIL-FIRST: prependHistory folds one OLDER page onto the FRONT of
// an agent's transcript, dispatched by history.ts's background backward walk
// AFTER the newest page has already painted via backfillHistory. These are the
// reducer-level unit tests for its narrow contract: transcript rows only,
// correct ordering, idempotent against re-delivery, and — the whole reason it's
// a SEPARATE action from backfillHistory — it must never roll a live agent's
// derived state (state/costUsd/usage/model) backwards.

const records = [
  { agentId: "a1", state: "running", accountName: "main", provider: "claude", costUsd: 0.5, createdAt: 1 },
];

function ev(seq: number, text: string, kind: NormalizedEvent["kind"] = "message_complete"): NormalizedEvent {
  return { seq, ts: 1000 + seq, engineId: "local", agentId: "a1", kind, data: { text } };
}

// The newest page always lands via backfillHistory first (history.ts's own
// contract) — this is the fixture every test below starts from: an agent with
// one "newest" turn (seq 100) already painted, historyMinSeq anchored at 100.
function withNewestPage() {
  const base = reduce(initialState, { type: "agentRecords", records });
  return reduce(base, { type: "backfillHistory", agentId: "a1", events: [ev(100, "newest turn")] });
}

describe("reducer: prependHistory", () => {
  it("backfillHistory's newest page sets historyMinSeq to its own lowest seq", () => {
    const st = withNewestPage();
    expect(st.agents["a1"]!.historyMinSeq).toBe(100);
  });

  it("prepends an older batch's rows AHEAD of the existing transcript, in ascending order", () => {
    const withNewest = withNewestPage();
    const older = reduce(withNewest, {
      type: "prependHistory", agentId: "a1",
      events: [ev(97, "turn 97"), ev(99, "turn 99"), ev(98, "turn 98")], // delivered out of order
    });
    expect(older.agents["a1"]!.transcript.map((t) => (t as { text: string }).text)).toMatchObject([
      "turn 97", "turn 98", "turn 99", "newest turn",
    ]);
  });

  it("advances historyMinSeq to the batch's own lowest seq", () => {
    const withNewest = withNewestPage();
    const older = reduce(withNewest, { type: "prependHistory", agentId: "a1", events: [ev(90, "a"), ev(95, "b")] });
    expect(older.agents["a1"]!.historyMinSeq).toBe(90);
  });

  it("a SECOND older batch prepends further back, ahead of the first", () => {
    const withNewest = withNewestPage();
    const first = reduce(withNewest, { type: "prependHistory", agentId: "a1", events: [ev(95, "second-newest older")] });
    const second = reduce(first, { type: "prependHistory", agentId: "a1", events: [ev(90, "oldest")] });
    expect(second.agents["a1"]!.transcript.map((t) => (t as { text: string }).text)).toMatchObject([
      "oldest", "second-newest older", "newest turn",
    ]);
    expect(second.agents["a1"]!.historyMinSeq).toBe(90);
  });

  it("does NOT touch state/costUsd/usage/model — only transcript grows", () => {
    const withNewest = withNewestPage();
    // simulate the live agent having since finished + reported cost/usage, the
    // way a real running agent would evolve between the newest-page paint and
    // an older-page landing later in the background walk
    const evolved = reduce(withNewest, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "done", accountName: "main", provider: "claude", costUsd: 1.23, createdAt: 1 }],
    });
    expect(evolved.agents["a1"]!.state).toBe("done");
    const older = reduce(evolved, { type: "prependHistory", agentId: "a1", events: [ev(50, "ancient turn")] });
    expect(older.agents["a1"]!.state).toBe("done"); // unchanged — an old agent_started here must not roll this back
    expect(older.agents["a1"]!.costUsd).toBe(1.23); // unchanged
    expect(older.agents["a1"]!.transcript.map((t) => (t as { text: string }).text)).toMatchObject(["ancient turn", "newest turn"]);
  });

  it("re-delivering the exact same batch is idempotent (no duplicate rows, no state change)", () => {
    const withNewest = withNewestPage();
    const batch = [ev(97, "turn 97"), ev(98, "turn 98")];
    const once = reduce(withNewest, { type: "prependHistory", agentId: "a1", events: batch });
    const twice = reduce(once, { type: "prependHistory", agentId: "a1", events: batch });
    expect(twice.agents["a1"]!.transcript).toMatchObject(once.agents["a1"]!.transcript);
    expect(twice.agents["a1"]!.historyMinSeq).toBe(once.agents["a1"]!.historyMinSeq);
  });

  it("a re-delivered batch that PARTIALLY overlaps only contributes its genuinely-new (lower-seq) tail", () => {
    const withNewest = withNewestPage();
    const first = reduce(withNewest, { type: "prependHistory", agentId: "a1", events: [ev(95, "a"), ev(96, "b")] });
    // a retried page redelivers 95/96 (already covered) PLUS genuinely new 93/94
    const retried = reduce(first, {
      type: "prependHistory", agentId: "a1",
      events: [ev(93, "c"), ev(94, "d"), ev(95, "a"), ev(96, "b")],
    });
    expect(retried.agents["a1"]!.transcript.map((t) => (t as { text: string }).text)).toMatchObject([
      "c", "d", "a", "b", "newest turn",
    ]);
    expect(retried.agents["a1"]!.historyMinSeq).toBe(93);
  });

  // TRANSCRIPT-EVICT-OLD: a deliberately-paged-in (historyMinSeq-bearing)
  // transcript is no longer exempt from the cap — the whole point of this task
  // is that unbounded growth after paging is exactly the memory cost it fixes.
  // It's still gated on the operator being pinned at the bottom (AgentView's
  // default `atBottom: true`, same as here), and evictTranscriptFront
  // recomputes historyMinSeq from the new-oldest row so older-paging stays
  // correct after the drop.
  it("a long prepended transcript is CAPPED by a subsequent live event when the operator is at the bottom, with historyMinSeq re-anchored", () => {
    // build a transcript well past TRANSCRIPT_BUFFER_MAX purely via prependHistory
    // batches (the way a real deep backward walk would), then fold ONE ordinary
    // live event through the normal "event" action.
    // A high seq anchor (not the shared withNewestPage()'s seq 100) — this walk
    // needs ~2500 descending seqs, and real event seq is a strictly positive
    // monotonic counter (never 0 or negative). projectEvent's live-stream dedupe
    // (`e.seq <= state.lastSeq`, reducer.ts) treats seq<=0 as already-seen and
    // silently drops it during prependHistory's scratch replay (which starts
    // from initialState's lastSeq:0 on every call) — walking down from 100
    // crosses zero almost immediately, transcript growth stalls, and this test's
    // while-loop below spun forever. Real data never reaches seq<=0 (history.ts's
    // backward walk stops once events.replay returns empty), so this is a test
    // fixture fix, not a product fix.
    const base = reduce(initialState, { type: "agentRecords", records });
    let st = reduce(base, { type: "backfillHistory", agentId: "a1", events: [ev(100000, "newest turn")] });
    const perBatch = 400;
    let hi = 99999;
    while (st.agents["a1"]!.transcript.length < TRANSCRIPT_BUFFER_MAX + 500) {
      const lo = hi - perBatch + 1;
      const batch = Array.from({ length: perBatch }, (_, i) => ev(lo + i, `turn ${lo + i}`));
      st = reduce(st, { type: "prependHistory", agentId: "a1", events: batch });
      hi = lo - 1;
    }
    const beforeLen = st.agents["a1"]!.transcript.length;
    expect(beforeLen).toBeGreaterThan(TRANSCRIPT_BUFFER_MAX);

    const live = reduce(st, {
      type: "event",
      event: { seq: 100000, ts: 999999, engineId: "local", agentId: "a1", kind: "message_complete", data: { text: "brand new live turn" } },
    });
    expect(live.agents["a1"]!.transcript).toHaveLength(TRANSCRIPT_BUFFER_MAX); // evicted down to the cap
    expect((live.agents["a1"]!.transcript.at(-1) as { text: string }).text).toBe("brand new live turn"); // newest survives
    expect(live.agents["a1"]!.historyMinSeq).toBe(live.agents["a1"]!.transcript[0]!.seq); // re-anchored to the new oldest row
  });

  it("a NEVER-backfilled live agent still gets the ordinary TUI-008 cap, and eviction anchors historyMinSeq to the new oldest row", () => {
    let base = reduce(initialState, { type: "agentRecords", records });
    for (let i = 1; i <= TRANSCRIPT_BUFFER_MAX + 50; i++) {
      base = reduce(base, {
        type: "event",
        event: { seq: i, ts: i, engineId: "local", agentId: "a1", kind: "message_complete", data: { text: `t${i}` } },
      });
    }
    expect(base.agents["a1"]!.transcript.length).toBe(TRANSCRIPT_BUFFER_MAX); // capped exactly as before this task
    // TRANSCRIPT-EVICT-OLD: eviction now anchors historyMinSeq even for an
    // agent that never went through backfillHistory/prependHistory — it just
    // means "there is older content on the daemon than what's retained",
    // which is true here too (51 rows were dropped).
    expect(base.agents["a1"]!.historyMinSeq).toBe(base.agents["a1"]!.transcript[0]!.seq);
  });

  it("an empty batch is a pure no-op", () => {
    const withNewest = withNewestPage();
    const st = reduce(withNewest, { type: "prependHistory", agentId: "a1", events: [] });
    expect(st).toBe(withNewest); // same reference — reducer short-circuits
  });
});

describe("reducer: historyOlderLoadState", () => {
  it("starts \"idle\"", () => {
    const st = withNewestPage();
    expect(st.agents["a1"]!.historyOlderLoadState).toBe("idle");
  });

  it("historyOlderLoadStarted flips it to \"loading\" without touching transcript", () => {
    const withNewest = withNewestPage();
    const st = reduce(withNewest, { type: "historyOlderLoadStarted", agentId: "a1" });
    expect(st.agents["a1"]!.historyOlderLoadState).toBe("loading");
    expect(st.agents["a1"]!.transcript).toMatchObject(withNewest.agents["a1"]!.transcript);
  });

  it("historyOlderLoadFinished flips it to \"loaded\"", () => {
    const withNewest = withNewestPage();
    const loading = reduce(withNewest, { type: "historyOlderLoadStarted", agentId: "a1" });
    const st = reduce(loading, { type: "historyOlderLoadFinished", agentId: "a1", exhausted: false });
    expect(st.agents["a1"]!.historyOlderLoadState).toBe("loaded");
  });

  // TRANSCRIPT-WINDOWING: historyOlderExhausted is sticky (never un-set) and
  // only flips true when the page itself reports it — the caller (history.ts)
  // knows this from the batch length, the reducer just records it.
  it("historyOlderLoadFinished({exhausted:true}) sets historyOlderExhausted, and it stays true even after a later non-exhausted finish", () => {
    const withNewest = withNewestPage();
    const loading = reduce(withNewest, { type: "historyOlderLoadStarted", agentId: "a1" });
    const st = reduce(loading, { type: "historyOlderLoadFinished", agentId: "a1", exhausted: true });
    expect(st.agents["a1"]!.historyOlderExhausted).toBe(true);
    const again = reduce(st, { type: "historyOlderLoadFinished", agentId: "a1", exhausted: false });
    expect(again.agents["a1"]!.historyOlderExhausted).toBe(true);
  });

  it("historyOlderLoadFailed sets \"failed\" + the error text, without touching the already-painted transcript", () => {
    const withNewest = withNewestPage();
    const loading = reduce(withNewest, { type: "historyOlderLoadStarted", agentId: "a1" });
    const st = reduce(loading, { type: "historyOlderLoadFailed", agentId: "a1", message: "daemon unreachable" });
    expect(st.agents["a1"]!.historyOlderLoadState).toBe("failed");
    expect(st.agents["a1"]!.historyOlderLoadError).toBe("daemon unreachable");
    expect(st.agents["a1"]!.transcript).toMatchObject(withNewest.agents["a1"]!.transcript);
  });
});

describe("reducer: backfillHistory guard — regression (must survive TRANSCRIPT-TAIL-FIRST)", () => {
  it("never rebuilds a live agent that already has transcript content (the real data-loss bug this guards)", () => {
    const base = reduce(initialState, { type: "agentRecords", records });
    const live = reduce(base, {
      type: "event",
      event: { seq: 1, ts: 1001, engineId: "local", agentId: "a1", kind: "message_complete", data: { text: "tui-origin echo" } },
    });
    // a backfillHistory reply lands late, for an agent that's since grown live
    // content (e.g. a tui-origin user echo that is NOT in the persisted event
    // log) — it must be left untouched, not rebuilt from the (unrelated) reply.
    const st = reduce(live, { type: "backfillHistory", agentId: "a1", events: [ev(1, "some other content")] });
    expect(st.agents["a1"]!.transcript).toMatchObject(live.agents["a1"]!.transcript);
    expect(st.agents["a1"]!.historyLoaded).toBe(true);
    expect(st.agents["a1"]!.historyLoadState).toBe("loaded");
  });

  it("a repeated backfillHistory for an already-loaded agent is idempotent", () => {
    const withNewest = withNewestPage();
    const again = reduce(withNewest, { type: "backfillHistory", agentId: "a1", events: [ev(200, "should be ignored")] });
    expect(again.agents["a1"]!.transcript).toMatchObject(withNewest.agents["a1"]!.transcript);
  });
});
