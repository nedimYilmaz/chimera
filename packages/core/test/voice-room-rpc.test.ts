import { describe, expect, it, vi } from "vitest";
import { VoiceRoomRpc } from "@chimera/core/rpc/voice-room-rpc";
import { VoiceLimitsSchema } from "@chimera/protocol/voice-rooms";
import { voiceAgentName } from "@chimera/protocol/agent-name";

function setup(plan?: (agentId: string, input: string, signal: AbortSignal) => Promise<any>) {
  let now = 1000; const stopped = vi.fn(), removed = vi.fn(), diagnostic = vi.fn(); const states: Record<string, string> = {};
  const rpc = new VoiceRoomRpc({ plan, limits: () => VoiceLimitsSchema.parse({}), identity: id => ({ agentId: id, name: `name-${id}`, role: id === "boss" ? "conductor" : "agent", state: states[id] ?? "running", conductor: id === "boss" || id === "other" }), check: id => { if (states[id] === "killed") throw new Error("killed"); }, stop: stopped, stopParticipant: removed, diagnostic }, () => now);
  const create = () => rpc.handlers["voice.room.create"]({ name: "Review", agenda: "Discuss implementation", agentIds: ["a", "b"], durationMinutes: 2, maxUtterances: 3, callerAgentId: "boss" });
  return { rpc, h: rpc.handlers, create, stopped, removed, diagnostic, states, time: (ms: number) => { now += ms; } };
}
describe("meeting room lifecycle and authority", () => {
  it("plans only for the approved host, revision and eligible roster", async () => {
    const plan = vi.fn(async (_agentId: string, _input: string, _signal: AbortSignal) => ({ action: "speak", agentId: "b", discussion: true, topic: "Topic", contribution: "New evidence", reason: "Relevant" }));
    const s = setup(plan), room = await s.create(); await s.h["voice.room.approve"]({ roomId: room.id, hostId: "host", revision: 1 });
    const p = { requestId: "plan", roomId: room.id, hostId: "host", revision: 1, input: { topic: "Discuss", stage: "initial" as const, candidates: ["b"], spoken: [], history: [] } };
    await expect(s.h["voice.room.plan"]({ ...p, hostId: "wrong" })).rejects.toThrow();
    await expect(s.h["voice.room.plan"]({ ...p, revision: 0 })).rejects.toThrow("changed");
    await expect(s.h["voice.room.plan"]({ ...p, input: { ...p.input, candidates: ["outsider"] } })).rejects.toThrow("unapproved");
    expect(plan).not.toHaveBeenCalled();
    expect(await s.h["voice.room.plan"](p)).toMatchObject({ agentId: "b" });
    expect(JSON.parse(plan.mock.calls[0]![1])).toMatchObject({ participants: [{ agentId: "a" }, { agentId: "b" }], candidates: ["b"] });
    expect(s.stopped).not.toHaveBeenCalled();
    plan.mockResolvedValueOnce({ action: "speak", agentId: "a", discussion: true, topic: "Topic", contribution: "", reason: "" });
    await expect(s.h["voice.room.plan"](p)).rejects.toThrow("ineligible");
  });
  it("rejects a pending plan after end without accepting its late decision", async () => {
    let resolve!: (value: any) => void;
    const plan = vi.fn((_id, _input, _signal) => new Promise<any>(r => { resolve = r; }));
    const s = setup(plan), room = await s.create(); await s.h["voice.room.approve"]({ roomId: room.id, hostId: "host", revision: 1 });
    const pending = s.h["voice.room.plan"]({ requestId: "plan", roomId: room.id, hostId: "host", revision: 1, input: { topic: "Topic", stage: "initial", candidates: ["a"], spoken: [], history: [] } });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await s.h["voice.room.end"]({ roomId: room.id }); await rejected;
    expect(plan.mock.calls[0]![2].aborted).toBe(true);
    resolve({ action: "speak", agentId: "a", discussion: true, topic: "stale", contribution: "", reason: "" });
    expect((await s.h["voice.room.list"]({})).rooms[0]!.state).toBe("ended");
  });
  it("cancels only the matching outstanding plan", async () => {
    const s = setup(async () => new Promise(() => {})), room = await s.create();
    await s.h["voice.room.approve"]({ roomId: room.id, hostId: "host", revision: 1 });
    const pending = s.h["voice.room.plan"]({ requestId: "current", roomId: room.id, hostId: "host", revision: 1, input: { topic: "Topic", stage: "initial", candidates: ["a"], spoken: [], history: [] } });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    expect(await s.h["voice.room.cancelPlan"]({ requestId: "old", roomId: room.id, hostId: "host" })).toEqual({ cancelled: false });
    expect(await s.h["voice.room.cancelPlan"]({ requestId: "current", roomId: room.id, hostId: "host" })).toEqual({ cancelled: true });
    await rejected;
  });
  it("retains the first failure and its ordered diagnostics after duplicate end and deletion", async () => {
    const s = setup(), room = await s.create();
    await s.h["voice.room.approve"]({ roomId: room.id, hostId: "host", revision: 1 });
    await s.h["voice.room.report"]({ roomId: room.id, hostId: "host", diagnostic: { source: "microphone", event: "toggle-requested", enabled: true } });
    await s.h["voice.room.end"]({ roomId: room.id, reason: "Native voice event channel closed", source: "participant-ended" });
    await s.h["voice.room.end"]({ roomId: room.id });
    const ended = (await s.h["voice.room.list"]({})).rooms[0]!;
    expect(ended.reason).toBe("Native voice event channel closed");
    expect(ended.diagnostics?.map(d => d.event)).toEqual(["created", "approved", "toggle-requested", "ended"]);
    expect(ended.diagnostics?.at(-1)).toMatchObject({ code: "participant-ended", origin: "daemon", at: 1000 });
    await s.h["voice.room.delete"]({ roomId: room.id });
    expect(s.diagnostic).toHaveBeenCalledWith("boss", room.id, expect.objectContaining({ event: "ended", message: ended.reason }));
  });
  it("keeps cleanup reports but rejects another host and never lets reports renew the lease", async () => {
    const s = setup(), room = await s.create();
    await s.h["voice.room.approve"]({ roomId: room.id, hostId: "host", revision: 1 });
    const p = { roomId: room.id, hostId: "host", diagnostic: { source: "webrtc" as const, event: "channel-closed", agentId: "a" } };
    expect(() => s.h["voice.room.report"]({ ...p, hostId: "other" })).toThrow("lease");
    expect(() => s.h["voice.room.report"]({ ...p, diagnostic: { ...p.diagnostic, agentId: "outsider" } })).toThrow("participant");
    s.time(20_001); await s.h["voice.room.report"](p);
    expect((await s.h["voice.room.list"]({})).rooms[0]).toMatchObject({ state: "ended", reason: "Desktop heartbeat lease expired" });
    expect(await s.h["voice.room.report"](p)).toEqual({ recorded: true });
  });
  it("bounds recent diagnostics and desktop report volume while retaining the terminal cause", async () => {
    const s = setup(), room = await s.create(); await s.h["voice.room.approve"]({ roomId: room.id, hostId: "host", revision: 1 });
    const p = { roomId: room.id, hostId: "host", diagnostic: { source: "webrtc" as const, event: "connection-state" } };
    for (let i = 0; i < 1000; i++) await s.h["voice.room.report"](p);
    expect(await s.h["voice.room.report"](p)).toEqual({ recorded: false });
    const ended = await s.h["voice.room.end"]({ roomId: room.id, reason: "test failure" });
    expect(ended.diagnostics).toHaveLength(50); expect(ended.diagnostics?.at(-1)?.message).toBe("test failure");
  });
  it("removes only an approved participant, revokes re-entry and ends only after the last dismissal", async () => {
    const s = setup(), room = await s.create(); await s.h["voice.room.approve"]({ roomId: room.id, hostId: "host", revision: 1 });
    const params = { roomId: room.id, hostId: "host", revision: 1, agentId: "a" };
    expect(() => s.h["voice.room.removeParticipant"]({ ...params, hostId: "other" })).toThrow("lease");
    expect(() => s.h["voice.room.removeParticipant"]({ ...params, revision: 0 })).toThrow("changed");
    expect(() => s.h["voice.room.removeParticipant"]({ ...params, agentId: "outsider" })).toThrow("participant");
    const reduced = await s.h["voice.room.removeParticipant"](params);
    expect(reduced).toMatchObject({ state: "active", agentIds: ["b"], revision: 2 });
    expect(s.removed).toHaveBeenCalledWith(room.id, "a"); expect(s.stopped).not.toHaveBeenCalled();
    expect(() => s.rpc.context(room.id, "host", "a")).toThrow("participant");
    s.states.a = "killed"; expect((await s.h["voice.room.heartbeat"]({ roomId: room.id, hostId: "host" })).state).toBe("active");
    const ended = await s.h["voice.room.removeParticipant"]({ ...params, revision: 2, agentId: "b" });
    expect(ended).toMatchObject({ state: "ended", agentIds: [], revision: 3 }); expect(s.stopped).toHaveBeenCalledOnce();
  });
  it("prepares a conductor invitation without audio, checks owner and filters membership", async () => {
    const s = setup(); const room = await s.create();
    expect(room.state).toBe("pending"); expect(s.stopped).not.toHaveBeenCalled();
    expect((await s.h["voice.room.list"]({ callerAgentId: "a" })).rooms).toHaveLength(1);
    expect((await s.h["voice.room.list"]({ callerAgentId: "stranger" })).rooms).toHaveLength(0);
    expect(() => s.h["voice.room.end"]({ roomId: room.id, callerAgentId: "other" })).toThrow("owner");
    expect(() => s.h["voice.room.create"]({ ...room, callerAgentId: "a" })).toThrow("conductors");
  });
  it("binds approved participants and revisions to one desktop lease", async () => {
    const s = setup(); const room = await s.create();
    expect(() => s.rpc.context(room.id, "host", "a")).toThrow("lease");
    await s.h["voice.room.approve"]({ roomId: room.id, hostId: "host", revision: 1 });
    expect(s.rpc.context(room.id, "host", "a").participants.map(p => p.name)).toEqual(["name-a", "name-b"]);
    expect(() => s.rpc.context(room.id, "other-host", "a")).toThrow("lease");
    expect(() => s.rpc.context(room.id, "host", "outsider")).toThrow("participant");
    expect(() => s.h["voice.room.approve"]({ roomId: room.id, hostId: "host2", revision: 1 })).toThrow("already hosted");
    const edited = await s.h["voice.room.update"]({ roomId: room.id, callerAgentId: "boss", revision: 1, spec: { name: "Review", agenda: "New", agentIds: ["b", "c"], durationMinutes: 2, maxUtterances: 3 } });
    expect(edited.state).toBe("active"); expect(edited.revision).toBe(2); expect(s.stopped).not.toHaveBeenCalled();
    expect(edited.agentIds).toEqual(["a", "b"]);
    expect(() => s.rpc.context(room.id, "host", "c")).toThrow("participant");
    const accepted = await s.h["voice.room.reviewUpdate"]({ roomId: room.id, hostId: "host", revision: 2, accept: true });
    expect(accepted).toMatchObject({ state: "active", agentIds: ["b", "c"], revision: 3 });
    expect(s.removed).toHaveBeenCalledWith(room.id, "a");
    expect(s.stopped).not.toHaveBeenCalled();
    expect(s.rpc.context(room.id, "host", "c").participants.map(p => p.agentId)).toEqual(["b", "c"]);
    expect(() => s.h["voice.room.approve"]({ roomId: room.id, hostId: "host", revision: 1 })).toThrow("changed");
  });
  it("rejects stale or foreign approvals and preserves expiration and consumed utterances when adding a participant", async () => {
    const s = setup(), room = await s.create();
    const initial = await s.h["voice.room.approve"]({ roomId: room.id, hostId: "host", revision: 1 });
    s.rpc.message("a"); s.time(5000);
    const spec = { name: room.name, agenda: room.agenda, agentIds: ["a", "b", "c"], durationMinutes: room.durationMinutes, maxUtterances: room.maxUtterances };
    await s.h["voice.room.update"]({ roomId: room.id, revision: 1, spec });
    const params = { roomId: room.id, hostId: "host", revision: 2, accept: true };
    expect(() => s.h["voice.room.reviewUpdate"]({ ...params, hostId: "other" })).toThrow("lease");
    expect(() => s.h["voice.room.reviewUpdate"]({ ...params, revision: 1 })).toThrow("changed");
    const accepted = await s.h["voice.room.reviewUpdate"](params);
    expect(accepted.expiresAt).toBe(initial.expiresAt);
    expect(accepted.pendingUpdate).toBeUndefined(); expect(s.stopped).not.toHaveBeenCalled(); expect(s.removed).not.toHaveBeenCalled();
    expect(() => s.h["voice.room.reviewUpdate"](params)).toThrow("changed");
    s.rpc.message("b"); expect(s.stopped).not.toHaveBeenCalled(); s.rpc.message("c"); expect(s.stopped).toHaveBeenCalledOnce();
  });
  it("isolates a newcomer that becomes unavailable after approval", async () => {
    const s = setup(), room = await s.create();
    await s.h["voice.room.approve"]({ roomId: room.id, hostId: "host", revision: 1 });
    await s.h["voice.room.update"]({ roomId: room.id, revision: 1, spec: { name: room.name, agenda: room.agenda, agentIds: ["a", "b", "c"], durationMinutes: 2, maxUtterances: 3 } });
    await s.h["voice.room.reviewUpdate"]({ roomId: room.id, hostId: "host", revision: 2, accept: true });
    s.states.c = "killed";
    const live = await s.h["voice.room.heartbeat"]({ roomId: room.id, hostId: "host" });
    expect(live).toMatchObject({ state: "active", agentIds: ["a", "b"] });
    expect(s.stopped).not.toHaveBeenCalled(); expect(s.removed).toHaveBeenCalledWith(room.id, "c");
    expect(() => s.rpc.context(room.id, "host", "c")).toThrow("participant");
  });
  it("declines proposals without closing audio and rechecks new participants at approval", async () => {
    const s = setup(), room = await s.create();
    await s.h["voice.room.approve"]({ roomId: room.id, hostId: "host", revision: 1 });
    const spec = { name: room.name, agenda: room.agenda, agentIds: ["a", "b", "c"], durationMinutes: room.durationMinutes, maxUtterances: room.maxUtterances };
    await s.h["voice.room.update"]({ roomId: room.id, revision: 1, spec }); s.states.c = "killed";
    expect(() => s.h["voice.room.reviewUpdate"]({ roomId: room.id, hostId: "host", revision: 2, accept: true })).toThrow("killed");
    const declined = await s.h["voice.room.reviewUpdate"]({ roomId: room.id, hostId: "host", revision: 2, accept: false });
    expect(declined).toMatchObject({ state: "active", agentIds: ["a", "b"] }); expect(declined.pendingUpdate).toBeUndefined();
    expect(s.stopped).not.toHaveBeenCalled();
  });
  it("leaves agents in an active meeting when humans only heartbeat; stops at its budget", async () => {
    const s = setup(); const room = await s.create(); await s.h["voice.room.approve"]({ roomId: room.id, hostId: "host", revision: 1 });
    s.time(10_000); await s.h["voice.room.heartbeat"]({ roomId: room.id, hostId: "host" });
    expect(s.stopped).not.toHaveBeenCalled();
    s.rpc.message("a"); s.rpc.message("b"); expect(s.stopped).not.toHaveBeenCalled(); s.rpc.message("a");
    expect(s.stopped).toHaveBeenCalledOnce();
    expect((await s.h["voice.room.list"]({})).rooms[0]?.reason).toContain("utterance budget");
    await s.h["voice.room.end"]({ roomId: room.id });
    expect((await s.h["voice.room.list"]({})).rooms[0]?.reason).toContain("utterance budget");
  });
  it("bounds host loss, killed participants and cross-room membership", async () => {
    const s = setup(); const one = await s.create(); const two = await s.create();
    await s.h["voice.room.approve"]({ roomId: one.id, hostId: "host", revision: 1 });
    expect(() => s.h["voice.room.approve"]({ roomId: two.id, hostId: "host", revision: 1 })).toThrow("another meeting");
    s.time(20_001); expect(() => s.h["voice.room.heartbeat"]({ roomId: one.id, hostId: "host" })).toThrow("expired");
    await s.h["voice.room.approve"]({ roomId: two.id, hostId: "host", revision: 1 });
    s.states.a = "killed";
    expect((await s.h["voice.room.list"]({})).rooms.every(r => r.state === "ended")).toBe(true);
  });
  it("requires end before deleting a room and supports more than four definitions", async () => {
    const s = setup(); const rooms = await Promise.all(Array.from({ length: 6 }, () => s.create()));
    expect((await s.h["voice.room.list"]({})).rooms).toHaveLength(6);
    expect(() => s.h["voice.room.delete"]({ roomId: rooms[0]!.id })).toThrow("End");
    await s.h["voice.room.end"]({ roomId: rooms[0]!.id });
    expect(await s.h["voice.room.delete"]({ roomId: rooms[0]!.id })).toEqual({ deleted: true });
  });
  it("uses custom and conductor names, not provider/account identity", () => {
    expect(voiceAgentName("a", " Atlas ")).toBe("Atlas");
    expect(voiceAgentName("a", undefined, true, "chimera")).toBe("chimera");
    expect(voiceAgentName("a", undefined, true)).toBe("main");
    expect(voiceAgentName("a")).toMatch(/^[a-z]+-[a-z]+$/);
  });
});
