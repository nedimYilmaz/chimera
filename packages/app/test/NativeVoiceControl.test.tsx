import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), start: vi.fn(), stop: vi.fn(), dispatch: vi.fn(), local: vi.fn(), legacy: vi.fn(), provider: "codex",
  event: undefined as undefined | ((event: any) => void),
  voice: { status: "idle", agentId: null } as any,
  pending: [{ requestId: "request-1", agentId: "a", callerAgentId: "b", reason: "Review the change", expiresAt: Date.now() + 120_000 }],
}));
vi.mock("../src/rpc/bridge", () => ({ rpcCall: mocks.rpc, onDaemonEvent: (cb: any) => { mocks.event = cb; return () => {}; } }));
vi.mock("../src/state/useStore", () => ({ useStore: (selector: any) => selector({ connected: true, agents: { a: { provider: mocks.provider, displayLabel: "Builder" }, b: { provider: "claude" } } }) }));
vi.mock("../src/state/store", () => ({ appStore: { dispatch: mocks.dispatch } }));
vi.mock("../src/state/commands.agents", () => ({ composerLocal: { set: mocks.local } }));
vi.mock("../src/voice/nativeCodex", () => ({ nativeCodexVoice: { getState: () => mocks.voice, getAgentState: () => mocks.voice, getRooms: () => [{ ...mocks.voice, joined: true }], subscribe: () => () => {}, start: mocks.start, stop: mocks.stop } }));
vi.mock("../src/keymap", () => ({ registerActionHandler: () => () => {} }));
vi.mock("../src/voice/session", () => ({ cancelPushToTalk: vi.fn() }));
vi.mock("../src/voice/realtime/conversation", () => ({ isConversationActive: () => false, stopConversation: async () => {}, toggleConversation: mocks.legacy }));
vi.mock("../src/components/ConfirmCard", () => ({ ConfirmCard: (props: any) => <div data-confirm-card><button onClick={props.onConfirm}>Approve microphone</button><button onClick={props.onClose}>Cancel</button></div> }));
import { NativeVoiceControl } from "../src/components/NativeVoiceControl";

let mounted: ReturnType<typeof create> | undefined;
beforeEach(() => {
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  mocks.voice = { status: "idle", agentId: null };
  mocks.provider = "codex";
  mocks.rpc.mockImplementation(async method => method === "voice.native.requests" ? mocks.pending : method === "voice.native.check" ? { needsTransition: false } : {});
});
afterEach(() => { act(() => mounted?.unmount()); mounted = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });
const mount = async (agentId: string) => { await act(async () => { mounted = create(<NativeVoiceControl agentId={agentId} onSend={() => {}} requestsOnly />); }); };
const click = async (label: string) => { await act(async () => mounted!.root.findAllByType("button").find(button => button.children.join("") === label)!.props.onClick()); };

describe("agent-requested native voice consent", () => {
  it("cannot redirect a stale Codex request into legacy voice after provider migration", async () => {
    mocks.provider = "claude";
    await mount("a"); await click("Review voice request");
    expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
    expect(mounted!.root.findByProps({ role: "alert" }).children.join("")).toContain("no longer targets");
  });
  it("does not open audio on an MCP request or its review, only on explicit microphone approval", async () => {
    await mount("a");
    expect(mocks.start).not.toHaveBeenCalled();
    await click("Review voice request");
    expect(mocks.rpc).toHaveBeenCalledWith("voice.native.check", { agentId: "a" });
    expect(mocks.start).not.toHaveBeenCalled();
    await click("Approve microphone");
    expect(mocks.start).toHaveBeenCalledWith("a", false, "request-1");
  });
  it("shows requests while looking at Claude, and navigates without opening the microphone", async () => {
    await mount("b"); await click("Open requested agent");
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: "selectAgent", agentId: "a" });
    expect(mocks.local).toHaveBeenCalledWith({ target: "selected", targetMenuOpen: false });
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("dismisses without audio and cancels an outstanding confirmation on self-stop", async () => {
    await mount("a"); await click("Review voice request");
    await act(async () => mocks.event!({ agentId: "a", kind: "voice_session_state", ts: Date.now(), data: { native: true, stopRequested: true } }));
    expect(mounted!.root.findAllByProps({ "data-confirm-card": true })).toHaveLength(0);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("navigation and screen unmount do not own media shutdown", async () => {
    await mount("a"); mocks.stop.mockClear(); mocks.voice = { status: "listening", agentId: "a" };
    const event = { agentId: "a", kind: "voice_session_state", ts: 1, data: { native: true, stopRequested: true } };
    await act(async () => mocks.event!(event));
    await act(async () => mocks.event!({ ...event, agentId: "other", ts: Date.now() }));
    expect(mocks.stop).not.toHaveBeenCalled();
    await act(async () => mocks.event!({ ...event, ts: Date.now() }));
    expect(mocks.stop).not.toHaveBeenCalled();
    await act(async () => mounted!.update(<NativeVoiceControl agentId="other" onSend={() => {}} requestsOnly />));
    act(() => mounted!.unmount()); mounted = undefined;
    expect(mocks.stop).not.toHaveBeenCalled();
  });
  it("dismiss removes the pending request without starting voice", async () => {
    await mount("a"); await click("Dismiss");
    expect(mocks.rpc).toHaveBeenCalledWith("voice.native.dismiss", { requestId: "request-1" });
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
