import { describe, expect, it } from "vitest";
import { createStore, TRANSCRIPT_BUFFER_MAX, type ChimeraApi } from "@chimera/ui-state";
import type { NormalizedEvent } from "@chimera/protocol";
import { installHistoryBackfill, requestOlderHistoryPage } from "../src/state/history";

// Review finding 4 — the lazy history backfill trigger, exercised against the
// REAL shared store (createStore + the real reducer) with a stub request, so
// the test proves the exact TUI-parity contract: selection landing on an
// empty-transcript agent pages events.replay for that agent, the reply
// folds in via backfillHistory (historyLoaded flips true, transcript rebuilt),
// and the requested-set / historyLoaded guards stop every re-fire.
//
// TRANSCRIPT-TAIL-FIRST: the paging direction flipped — the FIRST request is
// now the NEWEST page (no fromSeq/toSeq), painted via backfillHistory
// immediately. The harness below emulates events.replay's real "no fromSeq"
// semantics (packages/core/src/events.ts): newest `limit` events, optionally
// bounded above by `toSeq`.
//
// TRANSCRIPT-LAZY-OLDER (merged with remote's TRANSCRIPT-WINDOWING state
// machine): installHistoryBackfill no longer walks older pages in the
// background at all — opening an agent fires exactly ONE events.replay call
// (the newest page). requestOlderHistoryPage is a separate, explicitly
// on-demand function (the scroll-triggered / search-jump caller decides when
// to pay for another page) — exercised directly below, since TranscriptPanel's
// scroll wiring is a React-level concern out of this pure-store test's scope.

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function historyEvent(agentId: string, seq: number, text: string): NormalizedEvent {
  return { seq, ts: 1000 + seq, engineId: "local", agentId, kind: "message_complete", data: { text } };
}

// `tail[agentId]` is that agent's FULL ordered (ascending-seq) event log — the
// stub answers events.replay exactly like the real EventLog.replay's own
// "no fromSeq" branch: the newest `limit` events, filtered to seq<=toSeq first
// when toSeq is given.
function harness(tail: Record<string, NormalizedEvent[]>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const api: ChimeraApi = {
    request: <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === "events.replay") {
        const { agentId, toSeq, limit } = params as { agentId: string; toSeq?: number; limit: number };
        let events = tail[agentId] ?? [];
        if (toSeq !== undefined) events = events.filter((e) => e.seq <= toSeq);
        return Promise.resolve(events.slice(-limit) as T);
      }
      return Promise.resolve(null as T);
    },
    subscribe: () => Promise.resolve(() => {}),
  };
  const store = createStore(api);
  installHistoryBackfill(store, api.request);
  const replays = () => calls.filter((c) => c.method === "events.replay");
  return { store, calls, replays, request: api.request };
}

const records = [
  { agentId: "a1", state: "done", accountName: "main", provider: "claude", costUsd: 0.1, createdAt: 1 },
  { agentId: "a2", state: "done", accountName: "main", provider: "claude", costUsd: 0.2, createdAt: 2 },
];

describe("installHistoryBackfill — TRANSCRIPT-TAIL-FIRST", () => {
  it("shrinks oversized pages at the same cursor and loads every older message without false exhaustion", async () => {
    const rows = Array.from({ length: 650 }, (_, i) => historyEvent("a1", i + 1, `turn ${i + 1}`));
    const calls: Array<{ limit: number; toSeq?: number }> = [];
    const request = async <T = unknown>(_method: string, params?: unknown): Promise<T> => {
      const p = params as { limit: number; toSeq?: number };
      calls.push(p);
      if (p.limit > 125) throw { code: "response-too-large", message: "Response exceeds 32 MiB" };
      return rows.filter(e => p.toSeq === undefined || e.seq <= p.toSeq).slice(-p.limit) as T;
    };
    const store = createStore({ request, subscribe: () => Promise.resolve(() => {}) });
    installHistoryBackfill(store, request);
    store.dispatch({ type: "agentRecords", records });
    await flush();
    expect(calls.map(p => p.limit)).toEqual([500, 250, 125]);
    expect(store.getState().agents.a1).toMatchObject({ historyLoaded: true, historyMinSeq: 526, historyOlderExhausted: false });
    store.dispatch({ type: "transcriptAtBottom", agentId: "a1", atBottom: false });
    await requestOlderHistoryPage(store, "a1", request);
    expect(calls.slice(3).map(p => [p.limit, p.toSeq])).toEqual([[500, 525], [250, 525], [125, 525]]);
    expect(store.getState().agents.a1!.historyOlderExhausted).toBe(false);
    for (let i = 0; i < 4; i++) await requestOlderHistoryPage(store, "a1", request);
    expect(store.getState().agents.a1!.historyOlderExhausted).toBe(true);
    expect(store.getState().agents.a1!.transcript.map(row => "text" in row ? row.text : "")).toEqual(rows.map(e => e.data.text));
  });

  it("surfaces a single oversized event without an infinite retry or marking history loaded", async () => {
    const limits: number[] = [];
    const request = async <T = unknown>(_method: string, params?: unknown): Promise<T> => {
      limits.push((params as { limit: number }).limit);
      throw { code: "response-too-large", message: "Response exceeds 32 MiB" };
    };
    const store = createStore({ request, subscribe: () => Promise.resolve(() => {}) });
    installHistoryBackfill(store, request);
    store.dispatch({ type: "agentRecords", records });
    await flush();
    expect(limits).toEqual([500, 250, 125, 62, 31, 15, 7, 3, 1]);
    expect(store.getState().agents.a1).toMatchObject({ historyLoaded: false, historyLoadState: "failed" });
  });

  it("fires the NEWEST page first (no fromSeq/toSeq) when selection lands on an empty done agent", async () => {
    const { store, replays } = harness({ a1: [historyEvent("a1", 1, "old turn")] });
    store.dispatch({ type: "agentRecords", records }); // reducer auto-selects a1
    expect(store.getState().selectedAgentId).toBe("a1");
    await flush();
    expect(replays()).toHaveLength(1);
    expect(replays()[0]!.params).toEqual({ agentId: "a1", limit: 500 });
    const a1 = store.getState().agents["a1"]!;
    expect(a1.historyLoaded).toBe(true);
    expect(a1.transcript).toMatchObject([{ role: "assistant", text: "old turn", streaming: false }]);
  });

  it("opening an agent issues ONE replay call, not a background sweep", async () => {
    // A full page PLUS more behind it — the old walkOlderHistory would have
    // immediately fired a second (and third, ...) request for this. Now
    // nothing but the newest page fires until something explicitly asks for more.
    const rows = Array.from({ length: 900 }, (_, i) => historyEvent("a1", i + 1, `turn ${i + 1}`));
    const { store, replays } = harness({ a1: rows });
    store.dispatch({ type: "agentRecords", records });
    await flush(); await flush(); await flush();
    expect(replays()).toHaveLength(1);
    expect(replays()[0]!.params).toEqual({ agentId: "a1", limit: 500 });
    expect(store.getState().agents.a1!.historyOlderLoadState).toBe("idle"); // no walk ever started
    expect(store.getState().agents.a1!.historyOlderExhausted).toBe(false);
  });

  it("TRANSCRIPT-LAZY-OLDER: selecting an agent with a FULL newest page fires no older-page request on its own", async () => {
    const newest = Array.from({ length: 500 }, (_, i) => historyEvent("a1", i + 251, `turn ${i + 251}`));
    const { store, replays } = harness({ a1: newest });
    store.dispatch({ type: "agentRecords", records });
    await flush(); await flush();
    expect(replays()).toHaveLength(1); // newest page only — no background walk, ever
    expect(store.getState().agents.a1!.transcript).toHaveLength(500);
    expect(store.getState().agents.a1!.historyOlderLoadState).toBe("idle"); // untouched until a scroll trigger
  });

  it("a newest page shorter than a full page needs no older fetch at all, and requestOlderHistoryPage is a no-op", async () => {
    const { store, replays } = harness({ a1: [historyEvent("a1", 1, "only turn")] });
    store.dispatch({ type: "agentRecords", records });
    await flush();
    expect(replays()).toHaveLength(1); // no second (older-page) request ever fires
    expect(store.getState().agents.a1!.historyOlderLoadState).toBe("loaded");
    expect(store.getState().agents.a1!.historyOlderExhausted).toBe(true);

    await requestOlderHistoryPage(store, "a1", async () => { throw new Error("must not be called"); });
    expect(replays()).toHaveLength(1);
  });

  it("re-selecting the same agent never re-fetches (requested-set + historyLoaded guards)", async () => {
    const { store, replays } = harness({ a1: [historyEvent("a1", 1, "x")] });
    store.dispatch({ type: "agentRecords", records });
    await flush();
    store.dispatch({ type: "selectAgent", agentId: "a2" });
    await flush();
    store.dispatch({ type: "selectAgent", agentId: "a1" });
    await flush();
    expect(replays().map((c) => (c.params as { agentId: string }).agentId)).toEqual(["a1", "a2"]);
  });

  it("a rapid re-select mid-fetch can't double-request (set populated before the await)", async () => {
    const { store, replays } = harness({ a1: [] });
    store.dispatch({ type: "agentRecords", records }); // lands on a1 → fetch in flight
    store.dispatch({ type: "selectAgent", agentId: "a2" });
    store.dispatch({ type: "selectAgent", agentId: "a1" }); // reply for a1 not folded yet
    await flush();
    expect(replays().map((c) => (c.params as { agentId: string }).agentId)).toEqual(["a1", "a2"]);
  });

  it("never fires for an agent the live stream is already filling (non-empty transcript)", async () => {
    const { store, replays } = harness({});
    store.dispatch({ type: "agentRecords", records });
    await flush();
    store.dispatch({
      type: "event",
      event: { seq: 10, ts: 2000, engineId: "local", agentId: "a2", kind: "message_complete", data: { text: "live" } },
    });
    store.dispatch({ type: "selectAgent", agentId: "a2" });
    await flush();
    expect(replays().map((c) => (c.params as { agentId: string }).agentId)).toEqual(["a1"]);
  });

  it("never fires while nothing is selected or for an unknown-state agent", async () => {
    const { store, replays } = harness({});
    store.dispatch({ type: "helpOpen", open: true }); // a dispatch with no selection change
    await flush();
    expect(replays()).toHaveLength(0);
    // an agent whose record never arrived (state "unknown" via a bare event)
    store.dispatch({
      type: "event",
      event: { seq: 1, ts: 1, engineId: "local", agentId: "ghost", kind: "status", data: {} },
    });
    store.dispatch({ type: "selectAgent", agentId: "ghost" });
    await flush();
    expect(replays().filter((c) => (c.params as { agentId: string }).agentId === "ghost")).toHaveLength(0);
  });

  it("tolerates a non-array reply (dev mock seam answers null) by folding an empty history", async () => {
    const calls: string[] = [];
    const api: ChimeraApi = {
      request: <T = unknown>(method: string): Promise<T> => {
        calls.push(method);
        return Promise.resolve(null as T);
      },
      subscribe: () => Promise.resolve(() => {}),
    };
    const store = createStore(api);
    installHistoryBackfill(store, api.request);
    store.dispatch({ type: "agentRecords", records });
    await flush();
    expect(store.getState().agents["a1"]!.historyLoaded).toBe(true); // no crash, marked loaded
    expect(calls.filter((m) => m === "events.replay")).toHaveLength(1); // no older-page walk off an empty newest page
  });

  it("TRANSCRIPT-LOADING-STATE: historyLoadState is \"loading\" the instant selection lands, before the fetch resolves", () => {
    const { store } = harness({ a1: [historyEvent("a1", 1, "old turn")] });
    store.dispatch({ type: "agentRecords", records }); // lands on a1, fetch fired but not yet awaited
    expect(store.getState().agents["a1"]!.historyLoadState).toBe("loading");
    expect(store.getState().agents["a1"]!.transcript).toMatchObject([]); // not yet resolved
  });

  it("TRANSCRIPT-LOADING-STATE: a successful backfill flips historyLoadState to \"loaded\"", async () => {
    const { store } = harness({ a1: [historyEvent("a1", 1, "old turn")] });
    store.dispatch({ type: "agentRecords", records });
    await flush();
    expect(store.getState().agents["a1"]!.historyLoadState).toBe("loaded");
  });

  it("TRANSCRIPT-VANISHES-ON-RELOAD: a rejected fetch releases the guard so a reselect retries, and surfaces a notice", async () => {
    let a1Attempts = 0;
    const calls: Array<{ agentId: string }> = [];
    const api: ChimeraApi = {
      request: <T = unknown>(method: string, params?: unknown): Promise<T> => {
        const { agentId } = params as { agentId: string };
        calls.push({ agentId });
        if (agentId === "a2") return Promise.resolve([] as unknown as T); // irrelevant to this scenario
        a1Attempts += 1;
        if (a1Attempts === 1) return Promise.reject({ code: "E_TAIL", message: "daemon unreachable" });
        return Promise.resolve([historyEvent("a1", 1, "recovered")] as unknown as T);
      },
      subscribe: () => Promise.resolve(() => {}),
    };
    const store = createStore(api);
    installHistoryBackfill(store, api.request);

    store.dispatch({ type: "agentRecords", records }); // lands on a1 → first fetch rejects
    await flush();

    // Failure must NOT be recorded as "loaded and empty" — the guard must be
    // released so re-landing on a1 retries, and the user must be told.
    expect(store.getState().agents["a1"]!.historyLoaded).toBe(false);
    expect(store.getState().agents["a1"]!.transcript).toMatchObject([]);
    expect(store.getState().notice).toMatch(/history load failed.*daemon unreachable/);
    expect(calls.filter((c) => c.agentId === "a1")).toHaveLength(1);
    // TRANSCRIPT-LOADING-STATE: a failed fetch is "failed", not a permanent
    // "loading" — the pane must be able to tell this apart from in-flight.
    expect(store.getState().agents["a1"]!.historyLoadState).toBe("failed");
    expect(store.getState().agents["a1"]!.historyLoadError).toBe("daemon unreachable");

    store.dispatch({ type: "selectAgent", agentId: "a2" });
    store.dispatch({ type: "selectAgent", agentId: "a1" }); // reselect → must retry, not stay poisoned forever
    await flush();

    expect(calls.filter((c) => c.agentId === "a1")).toHaveLength(2);
    expect(store.getState().agents["a1"]!.historyLoaded).toBe(true);
    expect(store.getState().agents["a1"]!.transcript).toMatchObject([{ role: "assistant", text: "recovered", streaming: false }]);
    expect(store.getState().agents["a1"]!.historyLoadState).toBe("loaded");
  });

  it("a rejected on-demand older-page fetch surfaces historyOlderLoadState \"failed\" without touching the painted newest page, and a later retry can still succeed", async () => {
    const newest = Array.from({ length: 500 }, (_, i) => historyEvent("a1", i + 101, `turn ${i + 101}`));
    let olderCalls = 0;
    const api: ChimeraApi = {
      request: <T = unknown>(method: string, params?: unknown): Promise<T> => {
        if (method !== "events.replay") return Promise.resolve(null as T);
        const p = params as { toSeq?: number; limit: number };
        if (p.toSeq === undefined) return Promise.resolve(newest as unknown as T); // newest page
        olderCalls += 1;
        if (olderCalls === 1) return Promise.reject({ code: "E_REPLAY", message: "replay unavailable" });
        return Promise.resolve([historyEvent("a1", 1, "turn 1")] as unknown as T);
      },
      subscribe: () => Promise.resolve(() => {}),
    };
    const store = createStore(api);
    installHistoryBackfill(store, api.request);
    store.dispatch({ type: "agentRecords", records });
    await flush();
    expect(olderCalls).toBe(0); // no automatic older fetch — this is the on-demand model

    await requestOlderHistoryPage(store, "a1", api.request); // scroll near top → rejects

    expect(store.getState().agents.a1!.historyOlderLoadState).toBe("failed");
    expect(store.getState().agents.a1!.historyOlderLoadError).toBe("replay unavailable");
    expect(store.getState().agents.a1!.historyOlderExhausted).toBe(false); // a rejection is NOT exhaustion — retry must stay possible
    // the newest page that already painted must be left exactly as it was
    expect(store.getState().agents.a1!.transcript).toHaveLength(500);
    expect(store.getState().agents.a1!.historyLoaded).toBe(true);
    expect(store.getState().agents.a1!.historyLoadState).toBe("loaded");

    await requestOlderHistoryPage(store, "a1", api.request); // scroll near top again → retries and succeeds
    expect(olderCalls).toBe(2);
    expect(store.getState().agents.a1!.historyOlderLoadState).toBe("loaded");
    expect(store.getState().agents.a1!.transcript).toHaveLength(501);
  });
});

// TRANSCRIPT-LAZY-OLDER: requestOlderHistoryPage is the ENTIRE older-paging
// surface — one page per scroll-to-top trigger (or a search jump-to-hit
// walking backward), no background walk. Guarded entirely by the AgentView's
// own fields (historyOlderLoadState/historyOlderExhausted), so every test
// here is free to reuse the shared store per its own agentId.
function recordsFor(agentId: string) {
  return [{ agentId, state: "done", accountName: "main", provider: "claude", costUsd: 0.1, createdAt: 1 }];
}

describe("requestOlderHistoryPage — TRANSCRIPT-LAZY-OLDER", () => {
  it("fetches exactly one older page, bounded by (oldest seen seq - 1), and prepends it", async () => {
    const id = "o1";
    const newest = Array.from({ length: 500 }, (_, i) => historyEvent(id, i + 101, `turn ${i + 101}`));
    const older = [historyEvent(id, 100, "older turn")];
    const { store, calls, replays } = harness({ [id]: [...older, ...newest] });
    store.dispatch({ type: "agentRecords", records: recordsFor(id) });
    await flush();
    expect(replays()).toHaveLength(1); // newest page only, so far

    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method !== "events.replay") return Promise.resolve(null as T);
      const p = params as { toSeq?: number; limit: number };
      let events = [...older, ...newest];
      if (p.toSeq !== undefined) events = events.filter((e) => e.seq <= p.toSeq!);
      return Promise.resolve(events.slice(-p.limit) as unknown as T);
    };
    await requestOlderHistoryPage(store, id, request);

    const olderReplays = replays().filter((c) => (c.params as { toSeq?: number }).toSeq !== undefined);
    expect(olderReplays).toHaveLength(1);
    expect(olderReplays[0]!.params).toEqual({ agentId: id, toSeq: 100, limit: 500 }); // oldest seen seq (101) - 1
    expect(store.getState().agents[id]!.transcript).toHaveLength(501);
    expect((store.getState().agents[id]!.transcript[0] as { text: string }).text).toBe("older turn");
    expect(store.getState().agents[id]!.historyOlderLoadState).toBe("loaded");
  });

  it("a second concurrent trigger while one is in flight issues nothing", async () => {
    const id = "o2";
    const newest = Array.from({ length: 500 }, (_, i) => historyEvent(id, i + 1, `turn ${i + 1}`));
    let olderCalls = 0;
    let resolveOlder: ((events: NormalizedEvent[]) => void) | null = null;
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      if (method !== "events.replay") return Promise.resolve(null as T);
      const p = params as { toSeq?: number };
      if (p.toSeq === undefined) return Promise.resolve(newest as unknown as T);
      olderCalls += 1;
      return new Promise<T>((resolve) => { resolveOlder = resolve as (events: NormalizedEvent[]) => void; });
    };
    const store = createStore({ request, subscribe: () => Promise.resolve(() => {}) });
    installHistoryBackfill(store, request);
    store.dispatch({ type: "agentRecords", records: recordsFor(id) });
    await flush();

    const first = requestOlderHistoryPage(store, id, request);
    expect(store.getState().agents[id]!.historyOlderLoadState).toBe("loading");
    const second = requestOlderHistoryPage(store, id, request); // blocked — a fetch is already in flight
    expect(olderCalls).toBe(1);
    expect(resolveOlder).not.toBeNull();
    resolveOlder!([]);
    await Promise.all([first, second]);
    expect(olderCalls).toBe(1);
  });

  it("a rejected older page dispatches historyOlderLoadFailed, and a later trigger retries successfully", async () => {
    const id = "o3";
    const newest = Array.from({ length: 500 }, (_, i) => historyEvent(id, i + 101, `turn ${i + 101}`));
    const older = [historyEvent(id, 100, "recovered older turn")];
    let attempt = 0;
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      if (method !== "events.replay") return Promise.resolve(null as T);
      const p = params as { toSeq?: number };
      if (p.toSeq === undefined) return Promise.resolve(newest as unknown as T);
      attempt += 1;
      if (attempt === 1) return Promise.reject({ code: "E_REPLAY", message: "replay unavailable" });
      return Promise.resolve(older as unknown as T);
    };
    const store = createStore({ request, subscribe: () => Promise.resolve(() => {}) });
    installHistoryBackfill(store, request);
    store.dispatch({ type: "agentRecords", records: recordsFor(id) });
    await flush();

    await requestOlderHistoryPage(store, id, request);
    expect(store.getState().agents[id]!.historyOlderLoadState).toBe("failed");
    expect(store.getState().agents[id]!.historyOlderLoadError).toBe("replay unavailable");
    expect(store.getState().agents[id]!.transcript).toHaveLength(500); // newest page untouched

    await requestOlderHistoryPage(store, id, request); // retry
    expect(store.getState().agents[id]!.historyOlderLoadState).toBe("loaded");
    expect(store.getState().agents[id]!.transcript).toHaveLength(501);
    expect((store.getState().agents[id]!.transcript[0] as { text: string }).text).toBe("recovered older turn");
  });

  it("reaching the true beginning (a short page) stops further fetches", async () => {
    const id = "o4";
    const newest = Array.from({ length: 500 }, (_, i) => historyEvent(id, i + 3, `turn ${i + 3}`));
    const older = [historyEvent(id, 2, "second"), historyEvent(id, 1, "first")];
    let olderCalls = 0;
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      if (method !== "events.replay") return Promise.resolve(null as T);
      const p = params as { toSeq?: number; limit: number };
      if (p.toSeq === undefined) return Promise.resolve(newest as unknown as T);
      olderCalls += 1;
      const filtered = older.filter((e) => e.seq <= p.toSeq!);
      return Promise.resolve(filtered.slice(-p.limit) as unknown as T);
    };
    const store = createStore({ request, subscribe: () => Promise.resolve(() => {}) });
    installHistoryBackfill(store, request);
    store.dispatch({ type: "agentRecords", records: recordsFor(id) });
    await flush();

    await requestOlderHistoryPage(store, id, request); // returns a short (2-row) page — the true beginning
    expect(olderCalls).toBe(1);
    expect(store.getState().agents[id]!.transcript).toHaveLength(502);
    expect(store.getState().agents[id]!.historyOlderLoadState).toBe("loaded");
    expect(store.getState().agents[id]!.historyOlderExhausted).toBe(true);

    await requestOlderHistoryPage(store, id, request); // exhausted — no further request
    expect(olderCalls).toBe(1);
  });
});

// TRANSCRIPT-EVICT-OLD: eviction (reducer.ts's evictTranscriptFront, driven
// here via plain "event" dispatches past TRANSCRIPT_BUFFER_MAX) resets
// historyOlderExhausted (and bumps historyEvictedAt) — after eviction there
// genuinely IS older content again (relative to what's currently resident),
// so a scroll-to-top must re-fetch instead of sitting dead forever.
describe("requestOlderHistoryPage — TRANSCRIPT-EVICT-OLD interplay", () => {
  it("a short page marks exhausted, but a SUBSEQUENT eviction clears it so the next scroll-to-top retries", async () => {
    const id = "e1";
    const newest = Array.from({ length: 500 }, (_, i) => historyEvent(id, i + 3, `turn ${i + 3}`));
    const older = [historyEvent(id, 2, "second"), historyEvent(id, 1, "first")];
    let olderCalls = 0;
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      if (method !== "events.replay") return Promise.resolve(null as T);
      const p = params as { toSeq?: number; limit: number };
      if (p.toSeq === undefined) return Promise.resolve(newest as unknown as T);
      olderCalls += 1;
      return Promise.resolve(older.filter((e) => e.seq <= p.toSeq!).slice(-p.limit) as unknown as T);
    };
    const store = createStore({ request, subscribe: () => Promise.resolve(() => {}) });
    installHistoryBackfill(store, request);
    store.dispatch({ type: "agentRecords", records: recordsFor(id) });
    await flush();

    await requestOlderHistoryPage(store, id, request); // short page (2 rows) -> exhausted
    expect(olderCalls).toBe(1);
    expect(store.getState().agents[id]!.transcript).toHaveLength(502);
    expect(store.getState().agents[id]!.historyOlderExhausted).toBe(true);

    await requestOlderHistoryPage(store, id, request); // still exhausted, no new eviction yet
    expect(olderCalls).toBe(1);

    // fill the agent's live transcript past the cap, at the bottom (default) —
    // this is the reducer's own eviction, independent of paging.
    for (let i = 100; i < 100 + TRANSCRIPT_BUFFER_MAX + 10; i++) {
      store.dispatch({ type: "event", event: historyEvent(id, i, `live ${i}`) });
    }
    expect(store.getState().agents[id]!.historyEvictedAt).toBeGreaterThan(0);
    expect(store.getState().agents[id]!.historyOlderExhausted).toBe(false); // eviction reset it

    await requestOlderHistoryPage(store, id, request); // eviction moved "the beginning" — retries
    expect(olderCalls).toBe(2);
  });

  // TRANSCRIPT-EVICT-OLD requirement 5: no eviction/refetch ping-pong. Eviction
  // only ever runs while atBottom — and a scroll-to-top trigger is exactly the
  // operator leaving the bottom, so requestOlderHistoryPage's own prepend can
  // never immediately trigger the reducer to evict what it just fetched (the
  // agent's atBottom stays false through the whole round trip here).
  it("prepending an older page while scrolled up never triggers eviction of what was just fetched", async () => {
    const id = "e2";
    const newest = Array.from({ length: 500 }, (_, i) => historyEvent(id, i + 501, `turn ${i + 501}`));
    const older = Array.from({ length: 500 }, (_, i) => historyEvent(id, i + 1, `older ${i + 1}`));
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      if (method !== "events.replay") return Promise.resolve(null as T);
      const p = params as { toSeq?: number; limit: number };
      let events = [...older, ...newest];
      if (p.toSeq !== undefined) events = events.filter((e) => e.seq <= p.toSeq!);
      return Promise.resolve(events.slice(-p.limit) as unknown as T);
    };
    const store = createStore({ request, subscribe: () => Promise.resolve(() => {}) });
    installHistoryBackfill(store, request);
    store.dispatch({ type: "agentRecords", records: recordsFor(id) });
    await flush();
    expect(store.getState().agents[id]!.transcript).toHaveLength(500);

    store.dispatch({ type: "transcriptAtBottom", agentId: id, atBottom: false }); // operator scrolled up
    const evictedBefore = store.getState().agents[id]!.historyEvictedAt;

    await requestOlderHistoryPage(store, id, request); // pushes total past TRANSCRIPT_BUFFER_MAX (1000 rows)
    expect(store.getState().agents[id]!.transcript).toHaveLength(1000); // grew, nothing evicted back out
    expect(store.getState().agents[id]!.historyEvictedAt).toBe(evictedBefore); // no eviction fired
    expect((store.getState().agents[id]!.transcript[0] as { text: string }).text).toBe("older 1"); // fetched rows survive
  });
});
