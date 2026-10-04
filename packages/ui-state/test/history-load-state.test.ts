import { describe, it, expect } from "vitest";
import { initialState, reduce } from "@chimera/ui-state";

// TRANSCRIPT-LOADING-STATE: historyLoaded alone conflated "not fetched yet",
// "fetch in flight" and "fetch failed" into the same `false` — a pane couldn't
// tell a genuinely-empty agent from one still loading. historyLoadState adds
// the missing signal; these are the reducer-level unit tests for its four
// transitions (idle -> loading -> loaded/failed).

const records = [
  { agentId: "a1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 },
];

describe("reducer: historyLoadState", () => {
  it("a freshly-known agent starts \"idle\"", () => {
    const st = reduce(initialState, { type: "agentRecords", records });
    expect(st.agents["a1"]!.historyLoadState).toBe("idle");
  });

  it("historyLoadStarted flips it to \"loading\" without touching historyLoaded/transcript", () => {
    const base = reduce(initialState, { type: "agentRecords", records });
    const st = reduce(base, { type: "historyLoadStarted", agentId: "a1" });
    expect(st.agents["a1"]!.historyLoadState).toBe("loading");
    expect(st.agents["a1"]!.historyLoaded).toBe(false);
    expect(st.agents["a1"]!.transcript).toEqual([]);
  });

  it("a successful backfillHistory sets \"loaded\" and clears any prior error", () => {
    const base = reduce(initialState, { type: "agentRecords", records });
    const loading = reduce(base, { type: "historyLoadStarted", agentId: "a1" });
    const failed = reduce(loading, { type: "historyLoadFailed", agentId: "a1", message: "boom" });
    const loaded = reduce(failed, {
      type: "backfillHistory", agentId: "a1",
      events: [{ seq: 1, ts: 1001, engineId: "local", agentId: "a1", kind: "message_complete", data: { text: "hi" } }],
    });
    expect(loaded.agents["a1"]!.historyLoadState).toBe("loaded");
    expect(loaded.agents["a1"]!.historyLoadError).toBeUndefined();
    expect(loaded.agents["a1"]!.historyLoaded).toBe(true);
  });

  it("a backfillHistory on an already-loaded/non-empty agent (the idempotent early-return branch) still lands \"loaded\"", () => {
    const base = reduce(initialState, { type: "agentRecords", records });
    const live = reduce(base, {
      type: "event",
      event: { seq: 1, ts: 1001, engineId: "local", agentId: "a1", kind: "message_complete", data: { text: "live turn" } },
    });
    const st = reduce(live, { type: "backfillHistory", agentId: "a1", events: [] });
    expect(st.agents["a1"]!.historyLoadState).toBe("loaded");
    expect(st.agents["a1"]!.transcript).toHaveLength(1); // untouched, not rebuilt from the (irrelevant) empty replay
  });

  it("historyLoadFailed sets \"failed\" + the error text, and leaves historyLoaded false", () => {
    const base = reduce(initialState, { type: "agentRecords", records });
    const loading = reduce(base, { type: "historyLoadStarted", agentId: "a1" });
    const st = reduce(loading, { type: "historyLoadFailed", agentId: "a1", message: "daemon unreachable" });
    expect(st.agents["a1"]!.historyLoadState).toBe("failed");
    expect(st.agents["a1"]!.historyLoadError).toBe("daemon unreachable");
    expect(st.agents["a1"]!.historyLoaded).toBe(false);
  });

  it("a retry (historyLoadStarted again) after a failure clears back to \"loading\"", () => {
    const base = reduce(initialState, { type: "agentRecords", records });
    const loading = reduce(base, { type: "historyLoadStarted", agentId: "a1" });
    const failed = reduce(loading, { type: "historyLoadFailed", agentId: "a1", message: "boom" });
    const retrying = reduce(failed, { type: "historyLoadStarted", agentId: "a1" });
    expect(retrying.agents["a1"]!.historyLoadState).toBe("loading");
  });
});
