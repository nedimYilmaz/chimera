import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createStore, type ChimeraApi } from "@chimera/ui-state";
import type { NormalizedEvent } from "@chimera/protocol";
import { installHistoryBackfill, requestOlderHistoryPage } from "../../src/state/history";
import { TranscriptPanel } from "../../src/components/TranscriptPanel";

export function HistoryRecoveryProbe() {
  const fixture = useMemo(() => {
    const events: NormalizedEvent[] = Array.from({ length: 300 }, (_, i) => ({
      agentId: "history-recovery", seq: i + 1, ts: 1000 + i, engineId: "local",
      kind: "message_complete", data: { text: `Retained conversation ${i + 1}` },
    }));
    const calls: number[] = [];
    const request: ChimeraApi["request"] = async <T,>(_method: string, params?: unknown): Promise<T> => {
      const { limit, toSeq } = params as { limit: number; toSeq?: number };
      calls.push(limit);
      if (limit > 125) throw { code: "response-too-large", message: "Response exceeds 32 MiB" };
      return events.filter(e => toSeq === undefined || e.seq <= toSeq).slice(-limit) as T;
    };
    const store = createStore({ request, call: request, subscribe: async () => () => {} });
    return { store, request, calls };
  }, []);
  const state = useSyncExternalStore(fixture.store.subscribe, fixture.store.getState);
  useEffect(() => {
    const off = installHistoryBackfill(fixture.store, fixture.request);
    fixture.store.dispatch({ type: "agentRecords", records: [{
      agentId: "history-recovery", state: "paused", provider: "codex", accountName: "fixture", createdAt: 1, costUsd: 0,
    }] });
    return off;
  }, [fixture]);
  const agent = state.agents["history-recovery"];
  return <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
    <output data-history-page>{JSON.stringify({ count: agent?.transcript.length, exhausted: agent?.historyOlderExhausted, calls: fixture.calls, error: agent?.historyLoadError })}</output>
    <button data-history-older onClick={() => {
      fixture.store.dispatch({ type: "transcriptAtBottom", agentId: "history-recovery", atBottom: false });
      void requestOlderHistoryPage(fixture.store, "history-recovery", fixture.request);
    }}>Load older conversations</button>
    <TranscriptPanel agent={agent ?? null} />
  </div>;
}
