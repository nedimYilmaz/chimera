import type { NormalizedEvent } from "@chimera/protocol";
import type { RpcCallOpts, RpcMethod, RpcRequestInputFor, RpcResponseFor } from "@chimera/protocol/contract";
import { isUnknownMethod } from "./errorText.js";
import { reduce } from "./reducer.js";
import { initialState, type Action, type AgentRecordLite, type UiState } from "./types.js";

// W2 state port: the minimal client surface BOTH UIs' stores are written
// against (moved here verbatim from the TUI's state/store.ts so the Tauri app
// and the TUI share one client-surface type instead of duplicating it).
// The TUI backs it with a real @chimera/client UDS connection; the desktop app
// backs it with the Tauri rpc bridge (rpcCall/subscribeEvents/onDaemonEvent) --
// either way, `request` is one JSON-RPC round trip and `subscribe` turns on the
// daemon's normalized event stream, returning an unsubscribe.
//
// TYPED-CLIENT-SDK: `call` is `request`'s typed sibling for methods on RPC_CONTRACT — kept on
// this minimal shared surface (unlike the generated per-family groups, which stay a
// @chimera/client-only convenience: they're not part of this deliberately small cross-UI type).
export type ChimeraApi = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  call<M extends RpcMethod>(method: M, params: RpcRequestInputFor<M>, opts?: RpcCallOpts): Promise<RpcResponseFor<M>>;
  subscribe(filter: { agentId?: string }, cb: (e: NormalizedEvent) => void): Promise<() => void>;
};

// The store shape the desktop app builds on: a plain, framework-free
// getState/subscribe/dispatch triple (exactly what React's useSyncExternalStore
// wants to be fed) plus the one-shot connectAndLoad bootstrap. Deliberately NOT
// a port of the TUI's ChimeraStore class -- that class owns polling, reconnect
// loops, outbox flushing and a dozen command helpers that are either Ink-coupled
// or superseded by the Tauri bridge (the Rust core owns reconnect/backoff and
// re-applies the event subscription itself). This is only the projection loop:
// reducer + listeners + the initial snapshot fetch.
export type UiStore = {
  getState(): UiState;
  subscribe(fn: () => void): () => void;
  dispatch(action: Action): void;
  connectAndLoad(): Promise<void>;
};

export function createStore(api: ChimeraApi): UiStore {
  let state: UiState = initialState;
  const listeners = new Set<() => void>();

  const dispatch = (action: Action): void => {
    const next = reduce(state, action);
    if (next === state) return; // no-op dispatch: don't wake subscribers (mirrors the TUI store)
    state = next;
    for (const fn of listeners) fn();
  };

  // Tolerate a Phase 1 daemon exactly like the TUI store's tryPhase2: a
  // positively-identified unknown-method error flips the pane to
  // available:false; any OTHER error is transient -- keep the previous pane
  // contents (no dispatch at all), so a blip never wipes a loaded list.
  const tryPhase2 = async (method: "team.list" | "queue.list", kind: "teams" | "queues"): Promise<void> => {
    try {
      const items = await api.request<Array<Record<string, unknown>>>(method, {});
      dispatch({ type: kind, available: true, items });
    } catch (err) {
      if (isUnknownMethod(err)) dispatch({ type: kind, available: false, items: [] });
      // other errors: transient — keep the previous pane contents
    }
  };

  // One-shot bootstrap: turn on the live event stream FIRST, then snapshot the
  // daemon's current world (status -> counts/accounts/peers, agent.list ->
  // records/tree order, team.list/queue.list -> coordination panes).
  // Subscribe-first mirrors the TUI store's discipline and closes the gap the
  // reverse order leaves: an event landing between a snapshot fetch and a later
  // subscribe would be lost for good (this store has no polling refresh to
  // recover it). The inverted overlap is harmless by construction -- events are
  // deduped by the reducer's seq watermark, and every snapshot action is a full
  // replace fetched AFTER the stream opened, so it can only be at-least-as-new
  // as any event it races. Rejections propagate to the caller -- the app guards
  // this at the bootstrap call site (daemon may simply be down; the UI renders
  // disconnected and the bridge keeps retrying).
  const connectAndLoad = async (): Promise<void> => {
    // WD Stage 1 (coverage B4): stampTs opts the live stream into per-item transcript
    // timestamps (TranscriptItem.ts) — this shared store is the app-side path; the
    // TUI's own store dispatches un-flagged and keeps its byte-identical projection.
    await api.subscribe({}, (e) => dispatch({ type: "event", event: e, stampTs: true }));
    const status = await api.request<{
      protocolVersion: number;
      agents: UiState["agentCounts"];
      accounts?: UiState["accounts"];
      peers?: UiState["peers"];
    }>("daemon.status", {});
    dispatch({ type: "daemonStatus", status });
    // BOOT-LATENCY-AGENT-LIST: `lite` drops spec.instructions/spec.prompt/resultText/
    // lastTurnBillableUsage — bulk text AgentRecordLite never declared and no selector reads
    // (the detail panel sources them from agent.status). On a large fleet that is the
    // difference between a ~5MB and a ~1.4MB snapshot on every connect and reconnect, which is
    // what made a restarted daemon feel like it had failed to come up. An older daemon ignores
    // the param and returns the full record — a superset, so the projection is unaffected.
    const records = await api.request<AgentRecordLite[]>("agent.list", { lite: true });
    dispatch({ type: "agentRecords", records });
    await tryPhase2("team.list", "teams");
    await tryPhase2("queue.list", "queues");
  };

  return {
    getState: () => state,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    dispatch,
    connectAndLoad,
  };
}
