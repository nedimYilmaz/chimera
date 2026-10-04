import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { createStore, initialState, reduce, type ChimeraApi, type UiState } from "@chimera/ui-state";

// WD Stage 1 (coverage B4, per-turn timestamps): TranscriptItem.ts — the ORIGINATING
// event's ts, stamped by the reducer ONLY when the dispatching store opts in via the
// "event"/"backfillHistory" actions' `stampTs`. The opt-in is the load-bearing part:
// a flag-less dispatch (the TUI store, every pre-existing test) must stay
// BYTE-IDENTICAL, which is exactly why the flag exists instead of an unconditional
// stamp. createStore (the shared app-side store) turns it on for its live stream.

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, s?: number): NormalizedEvent =>
  ({ ts: 1000 + (s ?? ++seq), seq: s ?? seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[], stampTs: boolean) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e, ...(stampTs ? { stampTs: true } : {}) }), state);

describe("reducer: TranscriptItem.ts stamping (WD Stage 1)", () => {
  it("default OFF: a flag-less dispatch never adds a ts key to any transcript item", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "hi" }),
      ev("a1", "tool_call", { toolName: "Read" }),
      ev("a1", "tool_result", { result: "ok" }),
      ev("a1", "error", { message: "boom" }),
    ], false);
    for (const item of st.agents["a1"]!.transcript) expect("ts" in item).toBe(false);
  });

  it("stamps the event ts onto assistant, tool and system items when opted in", () => {
    const st = feed(initialState, [
      ev("a1", "message_complete", { text: "answer" }, 5),
      ev("a1", "tool_call", { toolName: "Read" }, 6),
      ev("a1", "error", { message: "boom" }, 7),
    ], true);
    const t = st.agents["a1"]!.transcript;
    expect(t[0]).toMatchObject({ role: "assistant", text: "answer", streaming: false, ts: 1005 });
    expect(t[1]).toMatchObject({ role: "tool", toolName: "Read", ts: 1006 });
    expect(t[2]).toMatchObject({ role: "system", text: "error: boom", ts: 1007 });
  });

  it("a streaming turn keeps its FIRST delta's ts through accumulation AND finalization (turn start, not last byte)", () => {
    const st = feed(initialState, [
      ev("a1", "message_delta", { text: "hel" }, 10),
      ev("a1", "message_delta", { text: "lo" }, 11),
      ev("a1", "message_complete", { text: "hello!" }, 12),
    ], true);
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "assistant", text: "hello!", streaming: false, ts: 1010 }]);
  });

  it("a tool_result done-patch preserves the CALL item's ts (the patch spread carries it)", () => {
    const st = feed(initialState, [
      ev("a1", "tool_call", { toolName: "Read", toolId: "t1" }, 20),
      ev("a1", "tool_result", { toolId: "t1", result: "ok" }, 21),
    ], true);
    expect(st.agents["a1"]!.transcript[0]).toMatchObject({ role: "tool", status: "done", result: "ok", ts: 1020 });
  });

  it("stamps delivered user turns and denied tool rows from their status events", () => {
    const st = feed(initialState, [
      ev("a1", "status", { delivered: true, from: "agent-2", text: "hi" }, 30),
      ev("a1", "status", { denied: true, toolName: "Bash" }, 31),
    ], true);
    expect(st.agents["a1"]!.transcript[0]).toMatchObject({ role: "user", text: "hi", from: "agent-2", ts: 1030 });
    expect(st.agents["a1"]!.transcript[1]).toMatchObject({ role: "tool", toolName: "Bash", status: "denied", ts: 1031 });
  });

  it("backfillHistory mirrors the flag: a stampTs replay rebuilds items WITH ts, a flag-less one without", () => {
    const history = [ev("a1", "message_complete", { text: "old" }, 2)];
    const base = reduce(initialState, { type: "agentRecords", records: [
      { agentId: "a1", state: "done", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 },
    ] });
    const stamped = reduce(base, { type: "backfillHistory", agentId: "a1", events: history, stampTs: true });
    expect(stamped.agents["a1"]!.transcript).toMatchObject([{ role: "assistant", text: "old", streaming: false, ts: 1002 }]);
    const plain = reduce(base, { type: "backfillHistory", agentId: "a1", events: history });
    expect(plain.agents["a1"]!.transcript).toMatchObject([{ role: "assistant", text: "old", streaming: false }]);
  });

  it("createStore's live stream opts in: events arriving via connectAndLoad's subscription stamp ts", async () => {
    let push: ((e: NormalizedEvent) => void) | null = null;
    const api: ChimeraApi = {
      request: <T = unknown>(method: string): Promise<T> => {
        if (method === "daemon.status") return Promise.resolve({ protocolVersion: 1, agents: { running: 0, done: 0, failed: 0, killed: 0 } } as T);
        return Promise.resolve([] as T);
      },
      subscribe: (_f, cb) => { push = cb; return Promise.resolve(() => {}); },
    };
    const store = createStore(api);
    await store.connectAndLoad();
    push!(ev("live1", "message_complete", { text: "streamed" }, 40));
    expect(store.getState().agents["live1"]!.transcript).toMatchObject([{ role: "assistant", text: "streamed", streaming: false, ts: 1040 }]);
  });
});
