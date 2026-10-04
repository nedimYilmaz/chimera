import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeVoiceMessage } from "@chimera/protocol/contract";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), event: undefined as undefined | ((event: any) => void),
  voice: { status: "idle", agentId: null } as any, stop: vi.fn(),
}));
vi.mock("../src/rpc/bridge", () => ({ rpcCall: mocks.rpc, onDaemonEvent: (cb: any) => { mocks.event = cb; return () => { mocks.event = undefined; }; } }));
vi.mock("../src/state/useStore", () => ({ useStore: (selector: any) => selector({ connected: true, agents: { a: { displayLabel: "Atlas" } } }) }));
vi.mock("../src/voice/nativeCodex", () => ({ nativeCodexVoice: { getState: () => mocks.voice, getAgentState: () => mocks.voice, getRooms: () => [{ ...mocks.voice, joined: true }], subscribe: () => () => {}, stop: mocks.stop } }));
import { VoiceConversationPanel, mergeVoiceMessages } from "../src/components/VoiceConversationPanel";

const message = (overrides: Partial<NativeVoiceMessage> = {}): NativeVoiceMessage => ({
  id: "f38dfae2-01c8-4bea-8ca4-0429d61e4e21", sessionId: "b676e7a4-92b0-4998-a12e-a258d62b6418", role: "user", text: "Hello", final: true, ts: 1000, ...overrides,
});
let mounted: ReturnType<typeof create> | undefined;
beforeEach(() => { mocks.rpc.mockResolvedValue({ messages: [] }); mocks.voice = { status: "idle", agentId: null }; });
afterEach(() => { act(() => mounted?.unmount()); mounted = undefined; vi.clearAllMocks(); });
const render = async (open = false, onClose?: () => void) => { await act(async () => { mounted = create(<VoiceConversationPanel agentId="a" open={open} onClose={onClose} />); }); };
describe("voice conversation side panel", () => {
  it("is absent when this agent has no conversation", async () => {
    await render(); expect(mounted!.toJSON()).toBeNull();
  });
  it("renders separate speakers, history and an end button only for the live target", async () => {
    mocks.voice = { status: "listening", agentId: "a", inputLevel: 0.8, outputLevel: 0, messages: [message()] };
    mocks.rpc.mockResolvedValue({ messages: [message({ id: "54b52a9a-6f24-46f6-bd57-8af9a1c755e4", role: "assistant", text: "How can I help?", ts: 2000 })] });
    await render();
    expect(mounted!.root.findAllByType("article")).toHaveLength(2);
    expect(JSON.stringify(mounted!.toJSON())).toContain("Listening to you");
    act(() => mounted!.root.findByType("button").props.onClick());
    expect(mocks.stop).toHaveBeenCalledOnce();
    mocks.voice = { status: "listening", agentId: "other" };
    await act(async () => mounted!.update(<VoiceConversationPanel agentId="a" />));
    expect(mounted!.toJSON()).toBeNull();
    await act(async () => mounted!.update(<VoiceConversationPanel agentId="a" open />));
    expect(mounted!.root.findAllByType("article")).toHaveLength(2);
  });
  it("ignores another agent and merges live finals with a late history response without duplicates", async () => {
    let finish!: (data: any) => void;
    mocks.rpc.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(true);
    await act(async () => mocks.event!({ agentId: "other", kind: "voice_native_message", data: message() }));
    expect(mounted!.root.findAllByType("article")).toHaveLength(0);
    await act(async () => mocks.event!({ agentId: "a", kind: "voice_native_message", data: message({ text: "Final" }) }));
    await act(async () => finish({ messages: [message({ text: "stale", final: false })] }));
    expect(mounted!.root.findAllByType("article")).toHaveLength(1);
    expect(JSON.stringify(mounted!.toJSON())).toContain("Final");
  });
  it("offers a retry on history errors instead of silently reporting no conversation", async () => {
    mocks.rpc.mockRejectedValueOnce(new Error("offline")); await render(true);
    expect(mounted!.root.findByProps({ role: "alert" })).toBeDefined();
    await act(async () => mounted!.root.findByType("button").props.onClick());
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
  it("keeps old history closed and allows reopening after dismissal without stopping voice", async () => {
    const onClose = vi.fn();
    mocks.rpc.mockResolvedValue({ messages: [message()] });
    await render(false, onClose);
    expect(mounted!.toJSON()).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
    await act(async () => mounted!.update(<VoiceConversationPanel agentId="a" open onClose={onClose} />));
    expect(mounted!.root.findAllByType("article")).toHaveLength(1);
    act(() => mounted!.root.findByProps({ "aria-label": "Close voice history" }).props.onClick());
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.stop).not.toHaveBeenCalled();
    await act(async () => mounted!.update(<VoiceConversationPanel agentId="a" open={false} onClose={onClose} />));
    expect(mounted!.toJSON()).toBeNull();
    expect(mocks.event).toBeUndefined();
    await act(async () => mounted!.update(<VoiceConversationPanel agentId="a" open onClose={onClose} />));
    expect(mounted!.root.findAllByType("article")).toHaveLength(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
  it("retains final text over stale partials, stable ordering and a bounded window", () => {
    expect(mergeVoiceMessages([message()], [message({ final: false, text: "Hel" })])[0]!.text).toBe("Hello");
    const list = Array.from({ length: 120 }, (_, i) => message({ id: String(i), ts: i }));
    const merged = mergeVoiceMessages([], list);
    expect(merged).toHaveLength(100); expect(merged[0]!.ts).toBe(20);
  });
});
