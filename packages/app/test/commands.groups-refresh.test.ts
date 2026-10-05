import { describe, expect, it, vi, afterEach } from "vitest";
import { createStore, type ChimeraApi } from "@chimera/ui-state";
import { createGroupsCommands } from "../src/state/commands.groups";
import type { AgentGroup } from "@chimera/protocol";
const group = (name: string): AgentGroup => ({ id: "g", name, createdAt: 1, order: 0 });
const api = { request: async () => ({}), subscribe: async () => () => {} } as unknown as ChimeraApi;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

afterEach(() => vi.useRealTimers());
describe("event-driven Inspector registry loads", () => {
  it("coalesces a burst, excludes unrelated/duplicate events, and discards invalidated responses", async () => {
    vi.useFakeTimers();
    const store = createStore(api);
    const replies: ((value: { groups: AgentGroup[] }) => void)[] = [];
    const request = vi.fn(() => new Promise<{ groups: AgentGroup[] }>(resolve => replies.push(resolve)));
    const cmd = createGroupsCommands(store, request as never);
    const event = (seq: number) => store.dispatch({ type: "event", event: { agentId: "group:registry", kind: "group_registry_changed", seq, ts: seq, data: {} } });
    const initial = cmd.loadGroups();
    event(1); event(2); event(3);
    await vi.advanceTimersByTimeAsync(25);
    expect(request).toHaveBeenCalledTimes(1);
    replies[0]!({ groups: [group("Old")] }); await flush();
    expect(store.getState().groups.items).toEqual([]);
    expect(request).toHaveBeenCalledTimes(2);
    replies[1]!({ groups: [group("Current")] }); await initial;
    expect(store.getState().groups.items[0]?.name).toBe("Current");
    event(3);
    store.dispatch({ type: "event", event: { agentId: "fixture", kind: "status", seq: 4, ts: 4, data: { groups: [] } } });
    await vi.advanceTimersByTimeAsync(100);
    expect(request).toHaveBeenCalledTimes(2);
    cmd.dispose(); event(5); await vi.advanceTimersByTimeAsync(100);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reconnect reloads missed CRUD without replay events and rejects a pre-disconnect reply", async () => {
    vi.useFakeTimers();
    const store = createStore(api);
    store.dispatch({ type: "connected", connected: true });
    store.dispatch({ type: "groups", available: true, items: [group("Retained")] });
    const replies: ((value: { groups: AgentGroup[] }) => void)[] = [];
    const request = vi.fn(() => new Promise<{ groups: AgentGroup[] }>(resolve => replies.push(resolve)));
    const cmd = createGroupsCommands(store, request as never);
    const loading = cmd.loadGroups();
    store.dispatch({ type: "connected", connected: false });
    store.dispatch({ type: "connected", connected: true });
    await vi.advanceTimersByTimeAsync(25);
    expect(request).toHaveBeenCalledTimes(1);
    replies[0]!({ groups: [group("Stale")] }); await flush();
    expect(store.getState().groups.items[0]?.name).toBe("Retained");
    expect(request).toHaveBeenCalledTimes(2);
    replies[1]!({ groups: [] }); await loading;
    expect(store.getState().groups.items).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(2);
    cmd.dispose();
  });
});
