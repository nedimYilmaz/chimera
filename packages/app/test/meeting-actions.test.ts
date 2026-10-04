import { expect, it, vi } from "vitest";
import { actOnMeetingAgents } from "../src/voice/meetingActions";
import type { VoiceRoom } from "@chimera/protocol/voice-rooms";
const room = { id: "one", revision: 1, agentIds: ["a", "b"] } as VoiceRoom;

it("stops voice before the exact confirmed coding roster and reports partial failures", async () => {
  const end = vi.fn(async () => {});
  const rpc = vi.fn(async (method: string) => method === "voice.room.list" ? { rooms: [room] } : { held: ["a"], skipped: [{ agentId: "b", state: "done" }] });
  expect(await actOnMeetingAgents(room, "pause", end, rpc as any)).toEqual({ succeeded: ["a"], failed: [{ agentId: "b", error: "Not paused: done" }] });
  expect(rpc).toHaveBeenLastCalledWith("agent.hold", { agentIds: ["a", "b"] });
  expect(end.mock.invocationCallOrder[0]!).toBeLessThan(rpc.mock.invocationCallOrder[1]!);
});
it("uses killMany only after explicit kill selection", async () => {
  const rpc = vi.fn(async (method: string) => method === "voice.room.list" ? { rooms: [room] } : { succeeded: ["a", "b"], failed: [] });
  await actOnMeetingAgents(room, "kill", async () => {}, rpc as any);
  expect(rpc).toHaveBeenLastCalledWith("agent.killMany", { agentIds: ["a", "b"] });
});
it("refuses changed rosters and never stops coding if voice closure fails", async () => {
  const rpc = vi.fn(async (_method: string) => ({ rooms: [{ ...room, agentIds: ["a", "c"] }] })), end = vi.fn(async () => {});
  await expect(actOnMeetingAgents(room, "kill", end, rpc as any)).rejects.toThrow("changed"); expect(end).not.toHaveBeenCalled();
  rpc.mockResolvedValue({ rooms: [room] }); end.mockRejectedValue(new Error("offline"));
  await expect(actOnMeetingAgents(room, "kill", end, rpc as any)).rejects.toThrow("offline");
  expect(rpc.mock.calls.every(([method]) => method === "voice.room.list")).toBe(true);
});
