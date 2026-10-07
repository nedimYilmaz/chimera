import React, { useSyncExternalStore } from "react";
import { emptyAgent, initialState, reduce, type UiState, type UiStore } from "@chimera/ui-state";
import { createAgentCommands, type RpcFn } from "../../src/state/commands.agents";
import { TranscriptPanel } from "../../src/components/TranscriptPanel";
import type { ContentBlock, NormalizedEvent } from "@chimera/protocol";

let state: UiState = initialState;
const listeners = new Set<() => void>();
const store: UiStore = {
  getState: () => state,
  dispatch(action) { state = reduce(state, action); listeners.forEach(fn => fn()); },
  subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  connectAndLoad: async () => {},
};
let requests: Record<string, unknown>[] = [];
let persisted: NormalizedEvent[] = [];
let seq = 1;
const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
  if (method !== "agent.send") throw new Error(method);
  requests.push(params as Record<string, unknown>);
  return {} as T;
};
let commands = createAgentCommands(store, rpc);
const content: ContentBlock[] = [
  { type: "image", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ioAAAAASUVORK5CYII=" },
  { type: "text", text: " önce npm tarafındaki paketin açıklamasını düzeltelim" },
];
export const messageIdentityFixture = {
  reset() {
    state = { ...initialState, agents: { "identity-fixture": { ...emptyAgent("identity-fixture"), state: "running", historyLoaded: true } } };
    requests = []; persisted = []; seq = 1; commands = createAgentCommands(store, rpc);
  },
  async send() { await commands.sendToAgent("identity-fixture", " önce npm tarafındaki paketin açıklamasını düzeltelim", undefined, false, content, true); },
  ack(index: number) {
    const request = requests[index]!;
    const event: NormalizedEvent = { agentId: "identity-fixture", seq: seq++, ts: seq, kind: "status", data: {
      delivered: true, from: "app", messageId: request.messageId,
      messageMetadata: { from: "app", source: "operator", engineId: "local", kind: "user_message" },
      text: content.filter(block => block.type === "text").map(block => block.text).join("\n\n"), content,
    } };
    persisted.push(event); store.dispatch({ type: "event", event });
  },
  reload() {
    state = { ...initialState, agents: { "identity-fixture": { ...emptyAgent("identity-fixture"), state: "running" } } };
    store.dispatch({ type: "backfillHistory", agentId: "identity-fixture", events: persisted });
  },
  collide() {
    for (const origin of [
      { from: "worker", source: "agent", engineId: "local" },
      { from: "app", source: "external", engineId: "local" },
      { from: "app", source: "operator", engineId: "remote" },
    ]) {
      const event: NormalizedEvent = { agentId: "identity-fixture", seq: seq++, ts: seq, kind: "status", data: {
        delivered: true, from: origin.from, messageId: requests[0]!.messageId,
        messageMetadata: { ...origin, kind: "user_message" }, text: `${origin.from}/${origin.source}/${origin.engineId}`, content: [{ type: "text", text: `${origin.from}/${origin.source}/${origin.engineId}` }],
      } };
      persisted.push(event); store.dispatch({ type: "event", event });
    }
  },
  snapshot() { return { requests: requests.map(request => request.messageId), rows: state.agents["identity-fixture"]!.transcript }; },
};

export function MessageIdentityFixture() {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column" }} data-message-identity><TranscriptPanel agent={snapshot.agents["identity-fixture"]!} /></div>;
}
