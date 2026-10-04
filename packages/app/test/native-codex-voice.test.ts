import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeCodexVoice } from "../src/voice/nativeCodex";

function setup() {
  const track = { stop: vi.fn(), onended: null as (() => void) | null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const channel = { readyState: "open", send: vi.fn(), onerror: null as (() => void) | null, onclose: null as (() => void) | null, onmessage: null as ((e: any) => void) | null, close: vi.fn() };
  const pc = {
    ontrack: null as ((e: any) => void) | null, onconnectionstatechange: null as (() => void) | null,
    connectionState: "connected", iceGatheringState: "complete", localDescription: { sdp: "offer" },
    createDataChannel: vi.fn(() => channel), addTrack: vi.fn(),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer" })),
    setLocalDescription: vi.fn(async () => {}), setRemoteDescription: vi.fn(async () => {}), close: vi.fn(),
  };
  const audio = { autoplay: false, srcObject: null as unknown, play: vi.fn(async () => {}), pause: vi.fn() };
  const rpc = vi.fn(async (method: string, _params?: unknown): Promise<any> => {
    if (method === "voice.native.start") return { sdp: "answer" };
    if (method === "voice.native.poll") return { active: true, transcript: "You: hello", error: null };
    if (method === "voice.native.text") return { accepted: true };
    if (method === "voice.native.stop") return { stopped: true };
    throw new Error(`unexpected ${method}`);
  });
  const mic = vi.fn(async () => stream as unknown as MediaStream);
  let disconnect = () => {};
  const off = vi.fn();
  const stopMeter = vi.fn();
  const meter = vi.fn((_stream: MediaStream, _level: (value: number) => void) => stopMeter);
  const diagnostic = vi.fn();
  const id = vi.fn(() => "session-1");
  const voice = new NativeCodexVoice({ rpc, mic,
    meter, diagnostic,
    peer: () => pc as unknown as RTCPeerConnection, audio: () => audio as unknown as HTMLAudioElement,
    id, disconnected: cb => { disconnect = cb; return off; },
  });
  return { voice, track, stream, pc, audio, rpc, mic, off, channel, meter, stopMeter, diagnostic, id, disconnect: () => disconnect() };
}
afterEach(() => vi.useRealTimers());

describe("native Codex WebRTC client", () => {
  it.each(["stop", "error", "cancel"])("publishes stop-returned final messages after %s", async action => {
    const s = setup(); if (action === "cancel") s.pc.connectionState = "connecting";
    await s.voice.start("agent-a", true);
    let acknowledge!: (value: unknown) => void;
    const rpc = s.rpc.getMockImplementation()!;
    s.rpc.mockImplementation((method, params) => method === "voice.native.stop"
      ? new Promise(resolve => { acknowledge = resolve; }) : rpc(method, params));
    const final = { id: "stop-final", sessionId: "session-1", role: "assistant", final: true, text: "Son karar", ts: 1 };
    const observed: unknown[] = [];
    s.voice.subscribe(() => observed.push(...(s.voice.getState().messages ?? [])));
    if (action === "error") s.channel.onerror!(); else s.voice.stop();
    acknowledge({ stopped: true, messages: [final] });
    await s.voice.stopAndWait();
    expect(observed).toContainEqual(final);
  });
  it("does not publish an old stop payload into a replacement session", async () => {
    const s = setup(); await s.voice.start("agent-a", true);
    const rpc = s.rpc.getMockImplementation()!;
    let acknowledge!: (value: unknown) => void;
    s.rpc.mockImplementation((method, params) => method === "voice.native.stop" && (params as { sessionId: string }).sessionId === "session-1"
      ? new Promise(resolve => { acknowledge = resolve; }) : rpc(method, params));
    const stopped = s.voice.stopAndWait(); s.id.mockReturnValue("session-2");
    await s.voice.start("agent-b", true);
    const final = { id: "old-final", sessionId: "session-1", role: "assistant", final: true, text: "Old answer", ts: 1 };
    acknowledge({ stopped: true, messages: [final] });
    expect(await stopped).toEqual([final]);
    expect(s.voice.getState().messages ?? []).not.toContainEqual(final);
    expect(s.voice.getState().agentId).toBe("agent-b"); s.voice.stop();
  });
  it("bounds RTC readiness and releases subscribers when cancelled", async () => {
    vi.useFakeTimers(); const s = setup(); s.pc.connectionState = "connecting";
    await s.voice.start("agent-a", true);
    const timedOut = expect(s.voice.waitUntilConnected()).rejects.toThrow("Voice connection timed out");
    await vi.advanceTimersByTimeAsync(20_001); await timedOut;
    const cancelled = expect(s.voice.waitUntilConnected()).rejects.toThrow("cancelled");
    s.voice.stop(); await cancelled;
    expect(s.track.stop).toHaveBeenCalledOnce();
  });
  it("ignores a stale terminal poll after a manual reconnect", async () => {
    vi.useFakeTimers(); const s = setup();
    const rpc = s.rpc.getMockImplementation()!;
    let oldPoll!: (value: unknown) => void;
    s.rpc.mockImplementation((method, params) => method === "voice.native.poll"
      ? new Promise(resolve => { oldPoll = resolve; }) : rpc(method, params));
    await s.voice.start("agent-a", true);
    s.voice.stop(); s.rpc.mockImplementation(rpc);
    s.id.mockReturnValue("session-2");
    await s.voice.start("agent-b", true); await vi.advanceTimersByTimeAsync(0);
    oldPoll({ active: false, transcript: "Old response", messages: [{ id: "stale", role: "assistant", text: "Old response", final: true, ts: 1 }], error: "old failure" });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.voice.getState()).toMatchObject({ status: "listening", agentId: "agent-b", transcript: "You: hello" });
    expect(s.voice.getState().messages).toEqual([]);
    expect(s.rpc.mock.calls.filter(([method]) => method === "voice.native.stop").map(([, params]) => params)).toEqual([{ sessionId: "session-1" }]);
    s.voice.stop();
  });
  it("scopes delayed startup cleanup to the cancelled session after a replacement starts", async () => {
    const s = setup(); const rpc = s.rpc.getMockImplementation()!;
    let answer!: (value: unknown) => void, started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    s.rpc.mockImplementation((method, params) => {
      if (method === "voice.native.start" && (params as { sessionId: string }).sessionId === "session-1") {
        return new Promise(resolve => { answer = resolve; started(); });
      }
      return rpc(method, params);
    });
    const pending = s.voice.start("agent-a", true); await requested;
    s.voice.stop(); s.id.mockReturnValue("session-2");
    await s.voice.start("agent-b", true);
    answer({ sdp: "stale-answer" }); await pending;
    expect(s.voice.getState()).toMatchObject({ status: "listening", agentId: "agent-b" });
    expect(s.pc.setRemoteDescription).toHaveBeenCalledExactlyOnceWith({ type: "answer", sdp: "answer" });
    expect(s.rpc.mock.calls.filter(([method]) => method === "voice.native.stop").map(([, params]) => params)).toEqual([{ sessionId: "session-1" }, { sessionId: "session-1" }]);
    expect(s.rpc.mock.calls.some(([method]) => method.startsWith("agent."))).toBe(false);
    s.voice.stop();
  });
  it.each([null, "Provider ended"])("publishes the last poll transcript before terminal cleanup (%s)", async error => {
    vi.useFakeTimers(); const s = setup();
    await s.voice.start("agent-a", true); await vi.advanceTimersByTimeAsync(0);
    const final = { id: "last-answer", role: "assistant", text: "Son yanıt", final: true, ts: 1 };
    const observed: unknown[] = [];
    s.voice.subscribe(() => observed.push(...(s.voice.getState().messages ?? [])));
    s.rpc.mockImplementation(async method => method === "voice.native.poll"
      ? { active: false, transcript: "Son yanıt", messages: [final], error }
      : { stopped: true });
    await vi.advanceTimersByTimeAsync(1001);
    expect(observed).toContainEqual(final);
    expect(s.voice.getState().status).toBe(error ? "error" : "idle");
    expect(s.track.stop).toHaveBeenCalledOnce();
  });
  it("waits for the actual RTC connection and aborts when voice is stopped", async () => {
    const s = setup(); s.pc.connectionState = "connecting";
    await s.voice.start("agent-a", true);
    let ready = false; const waiting = s.voice.waitUntilConnected().then(() => { ready = true; });
    await Promise.resolve(); expect(ready).toBe(false);
    s.pc.connectionState = "connected"; s.pc.onconnectionstatechange!(); await waiting;
    expect(ready).toBe(true); s.voice.stop();
    await expect(s.voice.waitUntilConnected()).rejects.toThrow("ended");
  });
  it("does not report stop completion before the daemon acknowledges provider shutdown", async () => {
    const s = setup(); await s.voice.start("agent-a", true);
    let release!: () => void;
    s.rpc.mockImplementationOnce(async () => new Promise<void>(resolve => { release = resolve; }));
    let done = false; const stopped = s.voice.stopAndWait().then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false); expect(s.track.stop).toHaveBeenCalled();
    release(); await stopped; expect(done).toBe(true);
  });
  it("records the provider event and disposal in order with session identity but no audio payload", async () => {
    const s = setup(); await s.voice.start("agent-a", true);
    s.channel.onmessage!({ data: JSON.stringify({ type: "error", error: { code: "transport_error", message: "transport closed" }, audio: "private", transcript: "private" }) });
    expect(s.diagnostic.mock.calls.map(([d]) => d.event)).toEqual(["data-channel-error", "session-failed", "media-disposed"]);
    expect(s.diagnostic.mock.calls[0]![0]).toMatchObject({ agentId: "agent-a", sessionId: "session-1", code: "transport_error", message: "transport closed" });
    expect(JSON.stringify(s.diagnostic.mock.calls)).not.toContain("private");
  });
  it("keeps the native session alive when interruption is requested against an AVAS transport", async () => {
    vi.useFakeTimers();
    const s = setup();
    let providerError: string | null = null;
    // Reproduce the provider path as well as the desktop channel: an invalid
    // command ends app-server's session even if its channel error is ignored.
    s.channel.send.mockImplementation(json => {
      const event = JSON.parse(json);
      if (["response.cancel", "output_audio_buffer.clear"].includes(event.type)) {
        providerError = `Invalid value: '${event.type}'.`;
        s.channel.onmessage!({ data: JSON.stringify({ type: "error", error: { code: "invalid_value", message: providerError } }) });
      }
    });
    s.rpc.mockImplementation(async method => method === "voice.native.start" ? { sdp: "answer" }
      : method === "voice.native.poll" ? { active: !providerError, transcript: "", error: providerError } : { stopped: true });
    await s.voice.start("agent-a", true);
    s.voice.interruptPlayback(); s.voice.interruptPlayback();
    await vi.advanceTimersByTimeAsync(2500);
    expect(s.voice.getState()).toMatchObject({ status: "listening", controlWarning: expect.stringContaining("local only") });
    expect(s.channel.send).not.toHaveBeenCalled();
    expect(s.track.stop).not.toHaveBeenCalled();
    expect(s.rpc.mock.calls.some(([m]) => m === "voice.native.stop" || m === "agent.interrupt")).toBe(false);
    expect(s.diagnostic.mock.calls.filter(([d]) => d.event === "interruption-local-only")).toHaveLength(1);
    s.voice.stop();
  });
  it("still surfaces genuine provider failures after local interruption", async () => {
    const s = setup(); await s.voice.start("agent-a", true);
    expect(s.voice.interruptPlayback()).toBe(false);
    s.channel.onmessage!({ data: JSON.stringify({ type: "error", error: { code: "invalid_value", message: "Invalid audio format" } }) });
    expect(s.voice.getState()).toMatchObject({ status: "error", error: "Invalid audio format" });
    expect(s.track.stop).toHaveBeenCalledOnce();
  });
  it("publishes the real failure before a meeting subscriber can mistake it for a normal stop", async () => {
    const s = setup(); await s.voice.start("agent-a", true);
    const terminal: string[] = [];
    s.voice.subscribe(() => {
      const state = s.voice.getState();
      if (state.status === "idle" || state.status === "error") terminal.push(state.error ?? "A participant ended voice");
    });
    s.channel.onmessage!({ data: JSON.stringify({ type: "session.error", error: { message: "Provider session failed" } }) });
    expect(terminal).toEqual(["Provider session failed"]);
    expect(s.track.stop).toHaveBeenCalledOnce();
  });
  it("forwards explicit request consent and publishes real input/output levels with cleanup", async () => {
    const s = setup();
    await s.voice.start("agent-a", false, "request-1");
    expect(s.rpc).toHaveBeenCalledWith("voice.native.start", expect.objectContaining({ requestId: "request-1" }));
    s.meter.mock.calls[0]![1](0.8);
    expect(s.voice.getState().inputLevel).toBe(0.8);
    s.pc.ontrack!({ streams: [s.stream] });
    s.meter.mock.calls[1]![1](0.5);
    expect(s.voice.getState().outputLevel).toBe(0.5);
    s.voice.stop();
    expect(s.stopMeter).toHaveBeenCalledTimes(2);
    s.meter.mock.calls[0]![1](1);
    expect(s.voice.getState().inputLevel).toBeUndefined();
  });
  it("negotiates native audio with the selected agent without a token service or duplicate agent.send", async () => {
    const s = setup();
    await s.voice.start("agent-a", true);
    expect(s.pc.createDataChannel).toHaveBeenCalledWith("oai-events");
    expect(s.rpc).toHaveBeenCalledWith("voice.native.start", { agentId: "agent-a", sessionId: "session-1", sdp: "offer", acknowledgeTransition: true });
    expect(s.pc.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "answer" });
    expect(s.voice.getState()).toMatchObject({ status: "listening", agentId: "agent-a" });
    expect(s.rpc.mock.calls.every(([m]) => m.startsWith("voice.native."))).toBe(true);
    s.voice.stop();
    expect(s.track.stop).toHaveBeenCalledOnce(); expect(s.pc.close).toHaveBeenCalledOnce();
    expect(s.audio.pause).toHaveBeenCalledOnce(); expect(s.off).toHaveBeenCalledOnce();
  });
  it("never opens the provider session if microphone permission is denied", async () => {
    const s = setup(); s.mic.mockRejectedValue(new Error("permission denied"));
    await s.voice.start("agent-a", false);
    expect(s.voice.getState()).toMatchObject({ status: "error", error: "permission denied" });
    expect(s.rpc.mock.calls.some(([m]) => m === "voice.native.start")).toBe(false);
  });
  it("releases a microphone granted after cancellation", async () => {
    const s = setup(); let grant!: (s: MediaStream) => void;
    s.mic.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    const pending = s.voice.start("agent-a", false); s.voice.stop();
    grant(s.stream as unknown as MediaStream); await pending;
    expect(s.track.stop).toHaveBeenCalledOnce();
    expect(s.rpc.mock.calls.some(([m]) => m === "voice.native.start")).toBe(false);
    expect(s.voice.getState().status).toBe("idle");
  });
  it("cancels delayed SDP without opening playback or changing the target", async () => {
    const s = setup(); let answer!: (v: unknown) => void;
    s.rpc.mockImplementation(async m => m === "voice.native.start" ? new Promise(resolve => { answer = resolve; }) : { stopped: true });
    const pending = s.voice.start("agent-a", false);
    await vi.waitFor(() => expect(answer).toBeDefined());
    s.voice.stop(); answer({ sdp: "late" }); await pending;
    expect(s.pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(s.voice.getState().status).toBe("idle");
    expect(s.rpc.mock.calls.filter(([m]) => m === "voice.native.stop").length).toBeGreaterThanOrEqual(1);
  });
  it("does not retarget an active call when start is called for a second agent", async () => {
    const s = setup(); await s.voice.start("agent-a", false); await s.voice.start("agent-b", false);
    expect(s.voice.getState().agentId).toBe("agent-a");
    expect(s.mic).toHaveBeenCalledOnce(); s.voice.stop();
  });
  it("stops capture and playback on daemon disconnect", async () => {
    const s = setup(); await s.voice.start("agent-a", false); s.disconnect();
    expect(s.track.stop).toHaveBeenCalledOnce(); expect(s.audio.pause).toHaveBeenCalledOnce();
    expect(s.voice.getState().status).toBe("error");
  });
  it("stops when the provider/agent closes the leased session", async () => {
    const s = setup(); s.rpc.mockImplementation(async m => m === "voice.native.start" ? { sdp: "answer" } : { active: false, transcript: "", error: "agent paused" });
    await s.voice.start("agent-a", false); await vi.waitFor(() => expect(s.voice.getState().status).toBe("error"));
    expect(s.track.stop).toHaveBeenCalledOnce(); expect(s.voice.getState().error).toBe("agent paused");
  });
  it("fails closed if playback is blocked", async () => {
    const s = setup(); await s.voice.start("agent-a", false);
    s.audio.play.mockRejectedValue(new Error("blocked"));
    s.pc.ontrack!({ streams: [s.stream] });
    await vi.waitFor(() => expect(s.voice.getState().status).toBe("error"));
    expect(s.track.stop).toHaveBeenCalledOnce();
  });
  it("stops on WebRTC transport failure and never silently reconnects", async () => {
    const s = setup(); await s.voice.start("agent-a", false);
    s.pc.connectionState = "failed"; s.pc.onconnectionstatechange!();
    expect(s.voice.getState().status).toBe("error"); expect(s.mic).toHaveBeenCalledOnce();
  });
  it("closes the microphone when the heartbeat RPC never returns", async () => {
    vi.useFakeTimers(); const s = setup();
    s.rpc.mockImplementation(async m => m === "voice.native.start" ? { sdp: "answer" } : m === "voice.native.poll" ? new Promise(() => {}) : { stopped: true });
    await s.voice.start("agent-a", false);
    await vi.advanceTimersByTimeAsync(5001);
    expect(s.voice.getState()).toMatchObject({ status: "error", error: "Voice connection heartbeat timed out" });
    expect(s.track.stop).toHaveBeenCalledOnce();
  });
  it("surfaces data-channel service errors and closes native media", async () => {
    const s = setup(); await s.voice.start("agent-a", false);
    s.channel.onmessage!({ data: JSON.stringify({ type: "error", error: { message: "Voice not enabled on this account" } }) });
    expect(s.voice.getState()).toMatchObject({ status: "error", error: "Voice not enabled on this account" });
    expect(s.channel.close).toHaveBeenCalledOnce(); expect(s.track.stop).toHaveBeenCalledOnce();
  });
});
