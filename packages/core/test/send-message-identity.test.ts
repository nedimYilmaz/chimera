import { describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine";
import { FakeAgentBackend } from "../src/backends/fake";
import { MailboxStore } from "../src/mailbox";
import { makeEngineHome } from "./helpers";
import { emptyAgent, initialState, reduce, type UiState, type UiStore } from "../../ui-state/src/index";
import { createAgentCommands, type RpcFn } from "../../app/src/state/commands.agents";

describe("agent.send authored identity", () => {
  it("passes the cockpit ID through RPC validation, durable storage, delivery and acknowledgement", async () => {
    const home = makeEngineHome();
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);
    const engine = new Engine({ home, backends: new Map([["claude", fake]]) });
    const { agentId } = await engine.handle("agent.spawn", { spec: { prompt: "wait", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
    const messageId = "510fb1f9-f412-44c8-98ff-cc83ffdfac73";
    const content = [{ type: "image", mediaType: "image/png", data: "YQ==" }, { type: "text", text: " original whitespace " }];
    try {
      const ack = await engine.handle("agent.send", { agentId, messageId, from: "app", text: "original whitespace", content });
      expect(ack).toMatchObject({ deliveryId: messageId });
      await vi.waitFor(() => expect(fake.deliveries).toHaveLength(1));
      expect(fake.deliveries[0]!.delivery!.messages[0]).toMatchObject({ id: messageId, content });
      const stored = new MailboxStore(home).history(agentId)[0]!;
      expect(stored.message!.id).toBe(messageId);
      expect(stored.text).toBe(" original whitespace ");
      await vi.waitFor(() => expect(engine.events.tail(agentId, 30).find(event => event.data.delivered)?.data).toMatchObject({ messageId, content, text: stored.text }));
    } finally { await engine.supervisor.kill(agentId); }
  });

  it("reconciles actual command → RPC → persisted event → reducer with unchanged ordered image content", async () => {
    const home = makeEngineHome();
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);
    const engine = new Engine({ home, backends: new Map([["claude", fake]]) });
    const { agentId } = await engine.handle("agent.spawn", { spec: { prompt: "wait", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
    let state: UiState = { ...initialState, agents: { [agentId]: { ...emptyAgent(agentId), state: "running" } } };
    const store: UiStore = { getState: () => state, dispatch: action => { state = reduce(state, action); }, subscribe: () => () => {}, connectAndLoad: async () => {} };
    const accepted: Record<string, unknown>[] = [];
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      accepted.push(params as Record<string, unknown>);
      return await engine.handle(method, params) as T;
    };
    const commands = createAgentCommands(store, rpc);
    const unsubscribe = engine.events.subscribe(event => store.dispatch({ type: "event", event }));
    const content = [{ type: "image" as const, mediaType: "image/png", data: "YQ==" }, { type: "text" as const, text: " same authored body " }];
    try {
      await commands.sendToAgent(agentId, " same authored body ", undefined, false, content);
      await vi.waitFor(() => expect(engine.events.tail(agentId, 30).filter(event => event.data.delivered)).toHaveLength(1));
      expect(state.agents[agentId]!.transcript.filter(row => row.role === "user")).toMatchObject([{ messageId: accepted[0]!.messageId, content }]);
      await commands.sendToAgent(agentId, " same authored body ", undefined, false, content, true);
      await vi.waitFor(() => expect(engine.events.tail(agentId, 30).filter(event => event.data.delivered)).toHaveLength(2));
      expect(accepted[0]!.messageId).not.toBe(accepted[1]!.messageId);
      expect(state.agents[agentId]!.transcript.filter(row => row.role === "user")).toHaveLength(2);
      const history = engine.events.tail(agentId, 30);
      const replayed = reduce(initialState, { type: "backfillHistory", agentId, events: history });
      expect(replayed.agents[agentId]!.transcript.filter(row => row.role === "user")).toMatchObject([{ content }, { content }]);
    } finally { unsubscribe(); await engine.supervisor.kill(agentId); }
  });

  it("accepts legacy callers without ID and rejects malformed IDs before enqueue", async () => {
    const home = makeEngineHome();
    const fake = new FakeAgentBackend([[{ awaitSend: true }]]);
    const engine = new Engine({ home, backends: new Map([["claude", fake]]) });
    const { agentId } = await engine.handle("agent.spawn", { spec: { prompt: "wait", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
    try {
      await expect(engine.handle("agent.send", { agentId, from: "app", text: "same", messageId: "invalid" })).rejects.toMatchObject({ code: "protocol" });
      expect(new MailboxStore(home).history(agentId)).toHaveLength(0);
      const ack = await engine.handle("agent.send", { agentId, from: "app", text: "same" }) as { deliveryId: string };
      expect(ack.deliveryId).toMatch(/^[a-f0-9-]{36}$/);
      await vi.waitFor(() => expect(engine.events.tail(agentId, 30).find(event => event.data.delivered)?.data.messageId).toBe(ack.deliveryId));
    } finally { await engine.supervisor.kill(agentId); }
  });
});
