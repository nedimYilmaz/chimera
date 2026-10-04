import type { VoiceRoom } from "@chimera/protocol/voice-rooms";
import { rpcCall } from "../rpc/bridge";

export type MeetingAgentAction = "pause" | "kill";
export type MeetingActionResult = { succeeded: string[]; failed: { agentId: string; error: string }[] };

// A confirmation authorizes these exact IDs, never a later/expanded roster.
// End voice first; a failed end acknowledgement must not silently kill agents.
export async function actOnMeetingAgents(snapshot: VoiceRoom, action: MeetingAgentAction, end: (id: string) => Promise<void>, rpc = rpcCall): Promise<MeetingActionResult> {
  const { rooms } = await rpc<{ rooms: VoiceRoom[] }>("voice.room.list", {});
  const current = rooms.find(room => room.id === snapshot.id);
  if (!current || current.revision !== snapshot.revision || current.agentIds.length !== snapshot.agentIds.length || current.agentIds.some(id => !snapshot.agentIds.includes(id))) throw new Error("Room participants changed; review and confirm again");
  if (!snapshot.agentIds.length) throw new Error("No participants to stop");
  await end(snapshot.id);
  if (action === "kill") return await rpc<MeetingActionResult>("agent.killMany", { agentIds: [...snapshot.agentIds] });
  const result = await rpc<{ held: string[]; skipped: { agentId: string; state: string }[] }>("agent.hold", { agentIds: [...snapshot.agentIds] });
  return { succeeded: result.held, failed: result.skipped.map(item => ({ agentId: item.agentId, error: `Not paused: ${item.state}` })) };
}
