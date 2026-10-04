import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  stop: vi.fn(), join: vi.fn(), event: undefined as ((event: any) => void) | undefined,
  rooms: [{ roomId: "room-a", agentId: "a", joined: true, status: "listening" }, { roomId: "room-b", agentId: "b", joined: false, status: "listening" }],
  pagehide: undefined as (() => void) | undefined,
}));
vi.mock("../src/voice/nativeCodex", () => ({ nativeCodexVoice: { subscribe: () => () => {}, getRooms: () => mocks.rooms, stop: mocks.stop, join: mocks.join } }));
vi.mock("../src/rpc/bridge", () => ({ onDaemonEvent: (fn: any) => { mocks.event = fn; return () => {}; } }));
vi.mock("../src/state/useStore", () => ({ useStore: (fn: any) => fn({ selectedAgentId: "b", agents: { a: { displayLabel: "Builder" }, b: { displayLabel: "Reviewer" } } }) }));
vi.mock("../src/components/NativeVoiceControl", () => ({ NativeVoiceControl: (props: any) => <div data-request-inbox={props.requestsOnly} /> }));
import { NativeVoiceDock } from "../src/components/NativeVoiceDock";
let mounted: ReturnType<typeof create> | undefined;
beforeEach(() => { vi.stubGlobal("window", { addEventListener: (_: string, fn: () => void) => { mocks.pagehide = fn; }, removeEventListener: vi.fn() }); });
afterEach(() => { act(() => mounted?.unmount()); mounted = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => { mounted = create(<NativeVoiceDock />); }); };
describe("app-owned voice lifecycle", () => {
  it("shows both rooms and a global request inbox independently of the selected agent", async () => {
    await mount(); const text = JSON.stringify(mounted!.toJSON());
    expect(text).toContain("Builder"); expect(text).toContain("Reviewer");
    expect(mounted!.root.findByProps({ "data-request-inbox": true })).toBeDefined();
    const buttons = mounted!.root.findAllByType("button");
    act(() => buttons.find(b => b.children.join("") === "Join room")!.props.onClick());
    expect(mocks.join).toHaveBeenCalledWith("b");
    act(() => buttons.find(b => b.children.join("") === "Leave room")!.props.onClick());
    expect(mocks.join).toHaveBeenCalledWith(null); expect(mocks.stop).not.toHaveBeenCalled();
  });
  it("handles MCP self-stop for an unselected room on any tab; ignores historical replay", async () => {
    await mount(); const event = { kind: "voice_session_state", agentId: "a", data: { native: true, stopRequested: true } };
    act(() => mocks.event!({ ...event, ts: 1 })); expect(mocks.stop).not.toHaveBeenCalled();
    act(() => mocks.event!({ ...event, ts: Date.now() })); expect(mocks.stop).toHaveBeenCalledWith("a");
  });
  it("real window close tears down every room", async () => {
    await mount(); act(() => mocks.pagehide!()); expect(mocks.stop).toHaveBeenCalledWith();
  });
});
