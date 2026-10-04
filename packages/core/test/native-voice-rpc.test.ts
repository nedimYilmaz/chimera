import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeVoiceRpc } from "@chimera/core/rpc/native-voice-rpc";
import type { NativeVoiceHandle } from "@chimera/core/backend";
import { RPC_CONTRACT } from "@chimera/protocol/contract";

const id = "f38dfae2-01c8-4bea-8ca4-0429d61e4e21";
const input = { agentId: "agent", sessionId: id, sdp: "offer", acknowledgeTransition: false };
function setup(extra: Partial<import("@chimera/core/rpc/native-voice-rpc").NativeVoiceDeps> = {}) {
  let notify: Parameters<NativeVoiceHandle["start"]>[1] = () => {};
  const handle: NativeVoiceHandle = { start: vi.fn(async (_sdp, cb) => { notify = cb; return "answer"; }), stop: vi.fn(async () => {}), text: vi.fn(async () => {}) };
  let current: NativeVoiceHandle | undefined = handle;
  const deps = { check: vi.fn(() => ({ needsTransition: false })), prepare: vi.fn(async () => handle), current: () => current, configure: vi.fn(async (_agentId: string, enabled: boolean) => ({ enabled })) };
  const persist = vi.fn(); const ended = vi.fn(); const validateCaller = vi.fn();
  const rpc = new NativeVoiceRpc({ ...deps, validateCaller, history: async () => [], persist, ended, ...extra });
  return { rpc, handle, deps, persist, ended, validateCaller, h: rpc.handlers, change: () => { current = undefined; }, notify: (s: Parameters<typeof notify>[0]) => notify(s) };
}
afterEach(() => vi.useRealTimers());

describe("native voice session lease", () => {
  it("allows only one native provider in a room and waits for complete shutdown", async () => {
    const meeting = { roomId: "room", name: "Review", agenda: "", participants: [] };
    const s = setup({ meeting: () => meeting });
    await s.h["voice.native.start"]({ ...input, meeting: { roomId: "room", hostId: "host" } });
    const next = { ...input, agentId: "other", sessionId: "other-session", meeting: { roomId: "room", hostId: "host" } };
    await expect(s.h["voice.native.start"](next)).rejects.toThrow("current meeting speaker");
    let release!: () => void;
    vi.mocked(s.handle.stop).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const stopped = s.h["voice.native.stop"]({ sessionId: id });
    const started = s.h["voice.native.start"](next);
    await Promise.resolve(); expect(s.handle.start).toHaveBeenCalledOnce();
    release(); await stopped; await started; expect(s.handle.start).toHaveBeenCalledTimes(2);
    await s.h["voice.native.stop"]({ sessionId: next.sessionId });
  });
  it("tracks provider-error cleanup before a replacement and never prompts on roster updates", async () => {
    const s = setup(); await s.h["voice.native.start"](input);
    let release!: () => void;
    vi.mocked(s.handle.stop).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    s.notify({ error: "connection lost", closed: true });
    const next = { ...input, sessionId: "replacement" };
    const started = s.h["voice.native.start"](next);
    await Promise.resolve(); expect(s.handle.start).toHaveBeenCalledOnce();
    release(); await started; expect(s.handle.start).toHaveBeenCalledTimes(2);
    s.rpc.updateRoomContext("room", { participants: ["newcomer"] });
    expect(s.handle.text).not.toHaveBeenCalled();
    await s.h["voice.native.stop"]({ sessionId: next.sessionId });
  });
  it("returns the last unpolled completed response at shutdown for meeting catch-up", async () => {
    const s = setup(); await s.h["voice.native.start"](input);
    s.notify({ message: { role: "assistant", text: "Decision retained", final: true } });
    const result = await s.h["voice.native.stop"]({ sessionId: id });
    expect(result).toMatchObject({ stopped: true, messages: [{ role: "assistant", text: "Decision retained", final: true }] });
    expect(RPC_CONTRACT["voice.native.stop"].response.parse(result)).toEqual(result);
  });
  it("records provider failure before cleanup without logging negotiated SDP or speech", async () => {
    const diagnostic = vi.fn(); const s = setup({ diagnostic });
    await s.h["voice.native.start"](input);
    s.notify({ transcript: "private speech", error: "provider failed", closed: true });
    expect(diagnostic).toHaveBeenCalledWith("agent", undefined, expect.objectContaining({ sessionId: id, event: "provider-error", message: "provider failed" }));
    expect(s.handle.stop).toHaveBeenCalledOnce();
    const logged = JSON.stringify(diagnostic.mock.calls);
    expect(logged).not.toContain("offer"); expect(logged).not.toContain("private speech");
    await s.h["voice.native.stop"]({ sessionId: id });
  });
  it("rejects unstructured or excessive browser diagnostic payloads", () => {
    const request = RPC_CONTRACT["voice.room.report"].request;
    const p = { roomId: id, hostId: id, diagnostic: { source: "microphone", event: "enabled" } };
    expect(request.safeParse(p).success).toBe(true);
    expect(request.safeParse({ ...p, diagnostic: { ...p.diagnostic, sdp: "offer" } }).success).toBe(false);
    expect(request.safeParse({ ...p, diagnostic: { ...p.diagnostic, message: "x".repeat(1001) } }).success).toBe(false);
  });
  it("binds approved room identity to native startup and history; routes text without a coding prompt", async () => {
    const identity = { agentId: "agent", name: "Atlas", role: "engineer" };
    const meeting = { roomId: "room", name: "Review", agenda: "Discuss work", participants: [identity] };
    const s = setup({ identity: () => identity, meeting: (room, host, agent) => { if (room !== "room" || host !== "host" || agent !== "agent") throw new Error("not approved"); return meeting; } });
    await expect(s.h["voice.native.start"]({ ...input, meeting: { roomId: "room", hostId: "forged" } })).rejects.toThrow("approved");
    expect(s.handle.start).not.toHaveBeenCalled();
    await s.h["voice.native.start"]({ ...input, meeting: { roomId: "room", hostId: "host" } });
    expect(s.handle.start).toHaveBeenCalledWith("offer", expect.any(Function), { identity, meeting });
    s.notify({ message: { role: "assistant", text: "Atlas here", final: true } });
    expect(s.persist).toHaveBeenCalledWith("agent", expect.objectContaining({ roomId: "room" }));
    await s.h["voice.native.text"]({ sessionId: id, text: "Begin", role: "user" });
    expect(s.handle.text).toHaveBeenCalledWith("Begin", "user");
    s.rpc.stopParticipant("other", "agent"); s.rpc.stopParticipant("room", "another"); expect(s.handle.stop).not.toHaveBeenCalled();
    s.rpc.stopParticipant("room", "agent"); expect(s.handle.stop).toHaveBeenCalledOnce();
    await expect(s.h["voice.native.text"]({ sessionId: id, text: "Late", role: "user" })).rejects.toThrow("unavailable");
  });
  it("coalesces per-speaker deltas, replaces with final text and persists only completed text", async () => {
    const s = setup(); await s.h["voice.native.start"](input);
    s.notify({ message: { role: "user", text: "hel", final: false } });
    s.notify({ message: { role: "assistant", text: "yes", final: false } });
    s.notify({ message: { role: "user", text: "lo", final: false } });
    const partial = (await s.h["voice.native.poll"]({ sessionId: id })).messages!;
    expect(partial.map(m => m.text)).toEqual(["hello", "yes"]);
    expect(s.persist).not.toHaveBeenCalled();
    s.notify({ message: { role: "user", text: "Hello!", final: true } });
    expect(s.persist).toHaveBeenCalledWith("agent", { ...partial[0], text: "Hello!", final: true });
    expect(JSON.stringify(s.persist.mock.calls)).not.toContain("offer");
    await s.h["voice.native.stop"]({ sessionId: id });
  });
  it("bounds the heartbeat payload and ignores events after stop", async () => {
    const s = setup(); await s.h["voice.native.start"](input);
    for (let n = 0; n < 105; n++) s.notify({ message: { role: "assistant", text: "x".repeat(9000), final: true } });
    const messages = (await s.h["voice.native.poll"]({ sessionId: id })).messages!;
    expect(messages).toHaveLength(100); expect(messages[0]!.text).toHaveLength(8192);
    await s.h["voice.native.stop"]({ sessionId: id });
    s.notify({ message: { role: "user", text: "late", final: true } });
    expect(s.persist).toHaveBeenCalledTimes(105);
  });
  it("requests another agent without opening audio, and consumes consent exactly once", async () => {
    const s = setup();
    const request = await s.h["voice.native.request"]({ agentId: "agent", callerAgentId: "requester", reason: "Please review" });
    expect(s.validateCaller).toHaveBeenCalledWith("requester");
    expect(s.deps.prepare).not.toHaveBeenCalled(); expect(s.handle.start).not.toHaveBeenCalled();
    s.validateCaller.mockImplementation(() => { throw new Error("requester finished its task"); });
    expect(await s.h["voice.native.requests"]({})).toEqual([request]);
    expect(await s.h["voice.native.request"]({ agentId: "agent", reason: "duplicate" })).toEqual(request);
    await s.h["voice.native.start"]({ ...input, requestId: request.requestId });
    expect(await s.h["voice.native.requests"]({})).toEqual([]);
    await s.h["voice.native.stop"]({ sessionId: id });
    await expect(s.h["voice.native.start"]({ ...input, requestId: request.requestId })).rejects.toThrow("expired");
  });
  it("cannot open an expired, dismissed or killed-target request", async () => {
    vi.useFakeTimers(); const s = setup();
    const request = await s.h["voice.native.request"]({ agentId: "agent", reason: "" });
    await vi.advanceTimersByTimeAsync(120_001);
    await expect(s.h["voice.native.start"]({ ...input, requestId: request.requestId })).rejects.toThrow("expired");
    const next = await s.h["voice.native.request"]({ agentId: "agent", reason: "" });
    await s.h["voice.native.dismiss"]({ requestId: next.requestId });
    await expect(s.h["voice.native.start"]({ ...input, requestId: next.requestId })).rejects.toThrow("cancelled");
    await s.h["voice.native.request"]({ agentId: "agent", reason: "" });
    s.deps.check.mockImplementation(() => { throw new Error("agent killed"); });
    expect(await s.h["voice.native.requests"]({})).toEqual([]);
    expect(s.deps.prepare).not.toHaveBeenCalled();
  });
  it("self-stop cancels pending consent and active media but refuses stopping someone else", async () => {
    const s = setup();
    const pending = await s.h["voice.native.request"]({ agentId: "agent", reason: "" });
    await s.h["voice.native.end"]({ agentId: "agent", callerAgentId: "agent" });
    expect(s.ended).toHaveBeenCalledWith("agent");
    await expect(s.h["voice.native.start"]({ ...input, requestId: pending.requestId })).rejects.toThrow("cancelled");
    await s.h["voice.native.start"](input);
    expect(() => s.h["voice.native.end"]({ agentId: "agent", callerAgentId: "other" })).toThrow("own");
    expect(s.handle.stop).not.toHaveBeenCalled();
    await s.h["voice.native.end"]({ agentId: "agent", callerAgentId: "agent" });
    expect(s.handle.stop).toHaveBeenCalledOnce();
  });
  it("disabling an agent closes its active lease", async () => {
    const s = setup(); await s.h["voice.native.start"](input);
    expect(await s.h["voice.native.configure"]({ agentId: "agent", enabled: false })).toEqual({ enabled: false });
    expect(s.deps.configure).toHaveBeenCalledWith("agent", false);
    expect(s.handle.stop).toHaveBeenCalledOnce();
    expect(await s.h["voice.native.poll"]({ sessionId: id })).toMatchObject({ active: false });
  });
  it("a refused configuration change leaves an existing voice lease alone", async () => {
    const s = setup(); await s.h["voice.native.start"](input);
    s.deps.configure.mockRejectedValueOnce(new Error("busy"));
    await expect(s.h["voice.native.configure"]({ agentId: "agent", enabled: false })).rejects.toThrow("busy");
    expect(s.handle.stop).not.toHaveBeenCalled();
    await s.h["voice.native.stop"]({ sessionId: id });
  });
  it("negotiates on the pinned handle and never resubmits the transcript", async () => {
    const s = setup();
    expect(await s.h["voice.native.start"](input)).toEqual({ sdp: "answer" });
    s.notify({ transcript: "You: fix the tests" });
    expect(await s.h["voice.native.poll"]({ sessionId: id })).toMatchObject({ active: true, transcript: "You: fix the tests", error: null });
    expect(s.handle.start).toHaveBeenCalledTimes(1);
    await s.h["voice.native.stop"]({ sessionId: id });
    expect(s.handle.stop).toHaveBeenCalledTimes(1);
  });
  it("does not attach an old session to a replacement agent process", async () => {
    const s = setup(); await s.h["voice.native.start"](input); s.change();
    expect(await s.h["voice.native.poll"]({ sessionId: id })).toMatchObject({ active: false });
    expect(s.handle.stop).toHaveBeenCalledOnce();
  });
  it("expires abandoned sessions without touching the agent's input", async () => {
    vi.useFakeTimers(); const s = setup(); await s.h["voice.native.start"](input);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(s.handle.stop).toHaveBeenCalledOnce();
    expect(await s.h["voice.native.poll"]({ sessionId: id })).toMatchObject({ active: false });
  });
  it("rejects parallel starts for the same agent", async () => {
    const s = setup(); await s.h["voice.native.start"](input);
    await expect(s.h["voice.native.start"]({ ...input, sessionId: "another" })).rejects.toThrow("already");
    await s.h["voice.native.stop"]({ sessionId: id });
  });
  it("cancels a start while the transition is still pending", async () => {
    const s = setup(); let ready!: (h: NativeVoiceHandle) => void;
    s.deps.prepare.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
    const started = s.h["voice.native.start"](input);
    await s.h["voice.native.stop"]({ sessionId: id }); ready(s.handle);
    await expect(started).rejects.toThrow("cancelled");
    expect(s.handle.start).not.toHaveBeenCalled();
  });
  it("surfaces provider errors and bounds transcript memory", async () => {
    const s = setup(); await s.h["voice.native.start"](input);
    s.notify({ transcript: "x".repeat(20_000) });
    expect((await s.h["voice.native.poll"]({ sessionId: id })).transcript).toHaveLength(16384);
    s.notify({ error: "account does not support voice", closed: true });
    expect(await s.h["voice.native.poll"]({ sessionId: id })).toMatchObject({ active: false, error: "account does not support voice" });
    await s.h["voice.native.stop"]({ sessionId: id });
  });
  it("rejects oversized SDP and unknown fields at the contract boundary", () => {
    const schema = RPC_CONTRACT["voice.native.start"].request;
    expect(() => schema.parse({ ...input, sdp: "x".repeat(65537) })).toThrow();
    expect(() => schema.parse({ ...input, apiKey: "not-allowed" })).toThrow();
    expect(schema.parse(input)).toEqual(input);
  });
  it("an expired closed-session tombstone cannot stop the replacement call", async () => {
    vi.useFakeTimers(); const s = setup(); await s.h["voice.native.start"](input);
    s.notify({ closed: true });
    expect(s.handle.stop).toHaveBeenCalledTimes(1);
    const next = { ...input, sessionId: "c5d2d555-33bb-49b4-ac87-3d6f0ea482bb" };
    await s.h["voice.native.start"](next);
    await vi.advanceTimersByTimeAsync(10_000);
    await s.h["voice.native.poll"]({ sessionId: next.sessionId });
    await vi.advanceTimersByTimeAsync(6000);
    expect(s.handle.stop).toHaveBeenCalledTimes(1);
    expect(await s.h["voice.native.poll"]({ sessionId: next.sessionId })).toMatchObject({ active: true });
    await s.h["voice.native.stop"]({ sessionId: next.sessionId });
  });
});
