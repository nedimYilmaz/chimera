import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  state: { connected: true, selectedAgentId: "a", activeTab: "agents", agents: {} },
  rooms: [{ id: "one", revision: 1, name: "Review", agenda: "Discuss work", state: "pending", agentIds: ["a", "b"], durationMinutes: 15, maxUtterances: 60, participants: [{ agentId: "a", name: "Atlas", role: "conductor", state: "running" }, { agentId: "b", name: "Nova", role: "engineer", state: "running" }] }],
  live: [] as any[], dispatch: vi.fn(), rpc: vi.fn(), leave: vi.fn(), end: vi.fn(), stopAll: vi.fn(), start: vi.fn(), join: vi.fn(), privateJoin: vi.fn(), setLimit: vi.fn(),
}));
vi.mock("../src/state/store", () => ({ appStore: { dispatch: mocks.dispatch } }));
vi.mock("../src/state/useStore", () => ({ useStore: (selector: any) => selector(mocks.state) }));
vi.mock("../src/state/selectors", () => ({ displayName: (a: any) => a.displayLabel }));
vi.mock("../src/rpc/bridge", () => ({ rpcCall: mocks.rpc }));
vi.mock("../src/voice/nativeCodex", () => ({ nativeCodexVoice: { join: mocks.privateJoin, setLimit: mocks.setLimit } }));
vi.mock("../src/voice/meetingHost", () => ({ meetingHost: { getState: () => mocks.live, subscribe: () => () => {}, leave: mocks.leave, end: mocks.end, stopAll: mocks.stopAll, start: mocks.start, join: mocks.join } }));
import { MeetingRooms, MeetingRoomsProvider, MeetingRoomsBand, useMeetingRooms } from "../src/components/MeetingRooms";
function Workspace() {
  const rooms = useMeetingRooms()!;
  return <><button onClick={rooms.openRooms}>Meeting rooms</button><MeetingRoomsBand /><MeetingRooms /></>;
}
const surface = () => <MeetingRoomsProvider><Workspace /></MeetingRoomsProvider>;
let view: ReturnType<typeof create>;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  mocks.state.selectedAgentId = "a"; mocks.state.activeTab = "agents";
  mocks.rpc.mockResolvedValue({ rooms: mocks.rooms, limits: { maxRooms: 32, maxSessions: 16, maxParticipants: 8 } });
});
afterEach(() => { act(() => view?.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });
async function mount() { await act(async () => { view = create(surface()); }); }
const textOf = (node: any): string => typeof node === "string" ? node : (node.children ?? []).map(textOf).join("");
const button = (text: string) => view.root.findAllByType("button").find(b => textOf(b).includes(text))!;
it("shows named participants and requires an explicit approval before starting agent audio", async () => {
  await mount(); act(() => button("Meeting rooms").props.onClick());
  const roomButton = view.root.findAllByType("button").find(b => b.findAllByType("strong").some(s => s.children.includes("Review")))!;
  act(() => roomButton.props.onClick());
  expect(JSON.stringify(view.toJSON())).toContain("Atlas"); expect(JSON.stringify(view.toJSON())).toContain("Nova");
  expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.join).not.toHaveBeenCalled();
  await act(async () => button("Approve sharing").props.onClick());
  expect(mocks.start).toHaveBeenCalledWith(mocks.rooms[0]); expect(mocks.join).not.toHaveBeenCalled();
});
it("agent or tab navigation mutes only the human and leaves hosted meetings alive", async () => {
  await mount(); vi.clearAllMocks();
  mocks.state.selectedAgentId = "b";
  await act(async () => view.update(surface()));
  expect(mocks.leave).toHaveBeenCalledOnce(); expect(mocks.privateJoin).toHaveBeenCalledWith(null);
  mocks.state.activeTab = "settings";
  await act(async () => view.update(surface()));
  expect(mocks.leave).toHaveBeenCalledTimes(2); expect(mocks.end).not.toHaveBeenCalled(); expect(mocks.stopAll).not.toHaveBeenCalled();
});
it("leaving the meeting workspace leaves audio without ending the meeting", async () => {
  await mount(); act(() => button("Meeting rooms").props.onClick()); vi.clearAllMocks();
  act(() => button("Back to inspector").props.onClick());
  expect(mocks.leave).toHaveBeenCalledOnce(); expect(mocks.end).not.toHaveBeenCalled(); expect(mocks.stopAll).not.toHaveBeenCalled();
});

it("uses an inline workspace and keeps approval notifications outside it", async () => {
  await mount();
  expect(view.root.findAllByProps({ "aria-label": "Meeting rooms workspace" })).toHaveLength(0);
  act(() => button("Invitation awaiting approval").props.onClick());
  expect(mocks.dispatch).toHaveBeenCalledWith({ type: "selectTab", tab: "agents" });
  expect(view.root.findAllByProps({ "aria-label": "Meeting rooms workspace" })).toHaveLength(1);
  expect(view.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  expect(view.root.findAllByProps({ "aria-label": "Meetings" })).toHaveLength(1);
  act(() => button("Back to inspector").props.onClick());
  expect(view.root.findAllByProps({ "aria-label": "Meeting rooms workspace" })).toHaveLength(0);
  expect(button("Invitation awaiting approval")).toBeTruthy();
});
it("filters rooms without changing the selected room or rejoining audio", async () => {
  await mount(); act(() => button("Invitation awaiting approval").props.onClick());
  mocks.leave.mockClear();
  const nav = view.root.findByProps({ "aria-label": "Meetings" });
  act(() => nav.findByType("button").props.onClick());
  expect(mocks.leave).not.toHaveBeenCalled();
  act(() => view.root.findByProps({ "aria-label": "Search meeting rooms" }).props.onChange({ target: { value: "does not exist" } }));
  expect(nav.findAllByType("button")).toHaveLength(0);
  expect(JSON.stringify(view.toJSON())).toContain("Discuss work");
  expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.join).not.toHaveBeenCalled();
});
