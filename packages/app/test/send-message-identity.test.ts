import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initialState, reduce, emptyAgent, type Action, type UiStore } from "@chimera/ui-state";
import { MailboxStore } from "../../core/src/mailbox";
import { createAgentCommands, type RpcFn } from "../src/state/commands.agents";

describe("send → durable mailbox → delivered projection", () => {
  it("acknowledges the same image message despite trimmed display text; replay and retries preserve intentional repeats", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-send-identity-"));
    let state = { ...initialState, agents: { a: { ...emptyAgent("a"), state: "running" as const } } };
    const store: UiStore = {
      getState: () => state,
      dispatch: (action: Action) => { state = reduce(state, action); },
      subscribe: () => () => {}, connectAndLoad: async () => {},
    };
    const accepted: Record<string, unknown>[] = [];
    const mailbox = new MailboxStore(home);
    mailbox.setPrincipalResolver(from => ({ from, source: "operator", engineId: "local" }));
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      if (method !== "agent.send") throw new Error(method);
      const p = params as Record<string, unknown>;
      accepted.push(p);
      mailbox.enqueue("a", {
        id: p.messageId as string | undefined, from: "app", kind: "user_message", text: p.text as string,
        content: p.content as import("@chimera/protocol").ContentBlock[],
      });
      return {} as T;
    };
    const commands = createAgentCommands(store, rpc);
    const text = " önce npm tarafındaki paketin açıklamasını düzeltelim + sonra bu pakete bi release çıkalım";
    const content: import("@chimera/protocol").ContentBlock[] = [
      { type: "image", mediaType: "image/png", data: "YQ==" }, { type: "text", text },
    ];
    let seq = 1;
    const event = (message: ReturnType<MailboxStore["history"]>[number]) => ({
      seq: seq++, ts: seq, agentId: "a", kind: "status" as const,
      data: { delivered: true, messageMetadata: { ...message.message!.author, kind: message.kind }, from: "app", text: message.text, messageId: message.message!.id, content: message.content },
    });
    try {
      await commands.sendToAgent("a", text, undefined, false, content);
      const durable = new MailboxStore(home).history("a")[0]!;
      expect(durable.text).toBe(text);
      store.dispatch({ type: "event", event: event(durable) });
      expect(state.agents.a!.transcript.filter(row => row.role === "user")).toHaveLength(1);
      expect(accepted[0]!.messageId).toBe(durable.message!.id);
      expect(state.agents.a!.transcript[0]).toMatchObject({ content, messageId: durable.message!.id });
      // A delivery retry retains the authored ID, even though its event seq changes.
      store.dispatch({ type: "event", event: event(durable) });
      expect(state.agents.a!.transcript.filter(row => row.role === "user")).toHaveLength(1);
      await commands.sendToAgent("a", text, undefined, false, content, true);
      const second = new MailboxStore(home).history("a")[1]!;
      expect(second.message!.id).not.toBe(durable.message!.id);
      store.dispatch({ type: "event", event: event(second) });
      expect(state.agents.a!.transcript.filter(row => row.role === "user")).toHaveLength(2);
      let reloaded = initialState;
      for (const message of [durable, second, durable]) reloaded = reduce(reloaded, { type: "event", event: event(message) });
      expect(reloaded.agents.a!.transcript.filter(row => row.role === "user")).toHaveLength(2);
      expect(reloaded.agents.a!.transcript[0]).toMatchObject({ content });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("a failed queued send keeps its own image echo and only consumes its own queue item", async () => {
    let state: import("@chimera/ui-state").UiState = { ...initialState, agents: { a: { ...emptyAgent("a"), state: "running", busy: true }, b: { ...emptyAgent("b"), state: "running", busy: true } } };
    const listeners = new Set<() => void>();
    const store: UiStore = {
      getState: () => state,
      dispatch(action) { state = reduce(state, action); listeners.forEach(fn => fn()); },
      subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }, connectAndLoad: async () => {},
    };
    const content = (data: string): import("@chimera/protocol").ContentBlock[] => [{ type: "image", mediaType: "image/png", data }, { type: "text", text: " same " }];
    const requests: Record<string, unknown>[] = [];
    const rpc: RpcFn = async <T,>(method: string, params?: unknown): Promise<T> => {
      if (method !== "agent.send") throw new Error(method);
      requests.push(params as Record<string, unknown>);
      if (requests.length === 1) throw new Error("network down");
      return {} as T;
    };
    const commands = createAgentCommands(store, rpc);
    await commands.sendToAgent("a", " same ", undefined, false, content("YQ=="));
    await commands.sendToAgent("a", " same ", undefined, false, content("Yg=="));
    await commands.sendToAgent("b", " same ", undefined, false, content("Yw=="));
    const queued = [...state.outbox];
    expect(requests).toHaveLength(0);
    store.dispatch({ type: "event", event: { seq: 1, ts: 1, agentId: "a", kind: "turn_complete", data: {} } });
    await vi.waitFor(() => expect(state.lastError).toBe("network down"));
    expect(state.outbox.map(item => item.id)).toEqual([queued[1]!.id, queued[2]!.id]);
    const failedId = requests[0]!.messageId;
    expect(state.agents.a!.transcript[0]).toMatchObject({ messageId: failedId, content: content("YQ==") });
    await commands.sendToAgent("a", " same ", undefined, false, content("ZA=="), true);
    expect(state.outbox).toEqual([queued[2]]);
    expect(new Set(requests.map(request => request.messageId)).size).toBe(3);
    for (const [index, request] of requests.slice(1).entries()) {
      store.dispatch({ type: "event", event: { seq: index + 2, ts: index + 2, agentId: "a", kind: "status", data: { delivered: true, messageMetadata: { from: "app", source: "operator", engineId: "local" }, from: "app", text: " same ", messageId: request.messageId, content: request.content } } });
    }
    expect(state.agents.a!.transcript.filter(row => row.role === "user")).toMatchObject([
      { messageId: failedId, content: content("YQ==") }, { content: content("Yg==") }, { content: content("ZA==") },
    ]);
    expect(state.agents.b!.transcript).toHaveLength(0);
  });
});
