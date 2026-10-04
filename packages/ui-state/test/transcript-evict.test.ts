import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce, initialState, TRANSCRIPT_BUFFER_MAX, type UiState } from "@chimera/ui-state";

// TRANSCRIPT-EVICT-OLD: unit tests for the reducer half of the eviction
// contract — the app-side atBottom wiring (TranscriptSegment/TranscriptPanel)
// and the history.ts exhausted-clear are exercised in
// packages/app/test/history.test.ts.

const records = [
  { agentId: "a1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 },
];

function ev(seq: number, text: string): NormalizedEvent {
  return { seq, ts: 1000 + seq, engineId: "local", agentId: "a1", kind: "message_complete", data: { text } };
}

function feedN(state: UiState, from: number, to: number): UiState {
  let st = state;
  for (let i = from; i <= to; i++) st = reduce(st, { type: "event", event: ev(i, `t${i}`) });
  return st;
}

describe("TRANSCRIPT-EVICT-OLD: reducer eviction", () => {
  it("evicts from the FRONT once over the cap while pinned at the bottom (default atBottom:true)", () => {
    const base = reduce(initialState, { type: "agentRecords", records });
    const st = feedN(base, 1, TRANSCRIPT_BUFFER_MAX + 50);
    const t = st.agents["a1"]!.transcript;
    expect(t).toHaveLength(TRANSCRIPT_BUFFER_MAX);
    expect((t[0] as { text: string }).text).toBe(`t${51}`); // oldest 50 dropped
    expect((t.at(-1) as { text: string }).text).toBe(`t${TRANSCRIPT_BUFFER_MAX + 50}`); // newest survives
  });

  it("does NOT evict while the operator is scrolled up (atBottom:false)", () => {
    let st = reduce(initialState, { type: "agentRecords", records });
    st = reduce(st, { type: "transcriptAtBottom", agentId: "a1", atBottom: false });
    st = feedN(st, 1, TRANSCRIPT_BUFFER_MAX + 50);
    // grew past the cap, uncapped — nothing was yanked out from under the reader
    expect(st.agents["a1"]!.transcript).toHaveLength(TRANSCRIPT_BUFFER_MAX + 50);
    expect((st.agents["a1"]!.transcript[0] as { text: string }).text).toBe("t1");
  });

  it("deferred eviction runs the instant the operator returns to the bottom, catching up in one shot", () => {
    let st = reduce(initialState, { type: "agentRecords", records });
    st = reduce(st, { type: "transcriptAtBottom", agentId: "a1", atBottom: false });
    st = feedN(st, 1, TRANSCRIPT_BUFFER_MAX + 50);
    expect(st.agents["a1"]!.transcript).toHaveLength(TRANSCRIPT_BUFFER_MAX + 50);

    st = reduce(st, { type: "transcriptAtBottom", agentId: "a1", atBottom: true });
    const t = st.agents["a1"]!.transcript;
    expect(t).toHaveLength(TRANSCRIPT_BUFFER_MAX);
    expect((t[0] as { text: string }).text).toBe(`t${51}`);
    expect(st.agents["a1"]!.historyMinSeq).toBe(t[0]!.seq);
  });

  it("re-pinning to the bottom under the cap is a no-op (no spurious historyEvictedAt bump)", () => {
    let st = reduce(initialState, { type: "agentRecords", records });
    st = feedN(st, 1, 5); // well under the cap
    const before = st.agents["a1"]!.historyEvictedAt;
    st = reduce(st, { type: "transcriptAtBottom", agentId: "a1", atBottom: false });
    st = reduce(st, { type: "transcriptAtBottom", agentId: "a1", atBottom: true });
    expect(st.agents["a1"]!.historyEvictedAt).toBe(before);
    expect(st.agents["a1"]!.transcript).toHaveLength(5);
  });

  it("historyMinSeq always tracks the new oldest retained row's seq after eviction", () => {
    const base = reduce(initialState, { type: "agentRecords", records });
    const st = feedN(base, 1, TRANSCRIPT_BUFFER_MAX + 1);
    const t = st.agents["a1"]!.transcript;
    expect(st.agents["a1"]!.historyMinSeq).toBe(t[0]!.seq);
    expect(t[0]!.seq).toBe(2); // row for seq 1 was the one dropped
  });

  it("historyEvictedAt only bumps on an actual eviction, monotonically", () => {
    const base = reduce(initialState, { type: "agentRecords", records });
    let st = feedN(base, 1, 5);
    expect(st.agents["a1"]!.historyEvictedAt).toBe(0);
    st = feedN(st, 6, TRANSCRIPT_BUFFER_MAX + 5);
    expect(st.agents["a1"]!.historyEvictedAt).toBe(5); // one bump per row dropped this call, via one-at-a-time event dispatch
    const gen = st.agents["a1"]!.historyEvictedAt;
    // one more event that doesn't grow past the cap after its own drop still evicts by exactly 1
    st = feedN(st, TRANSCRIPT_BUFFER_MAX + 6, TRANSCRIPT_BUFFER_MAX + 6);
    expect(st.agents["a1"]!.historyEvictedAt).toBe(gen + 1);
  });
});
