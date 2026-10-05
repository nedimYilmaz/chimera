import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../src/voice/audioCapture");
  vi.doUnmock("../src/voice/registry");
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.useRealTimers();
});

function setupRpc() {
  const rpc = vi.fn(async (method: string, params: { agentId?: string }) => method === "voice.session.start"
    ? { sessionId: "voice-1", agentId: params.agentId, state: "listening", startedAt: 0 } : { stopped: true });
  vi.stubGlobal("window", { __CHIMERA_MOCK__: { rpc } });
  return rpc;
}

it("deduplicates pending microphone starts and closes a capture that arrives after cancellation", async () => {
  const rpc = setupRpc();
  let ready!: () => void;
  const start = vi.fn(() => new Promise<void>(resolve => { ready = resolve; }));
  const stop = vi.fn(async () => new Blob());
  vi.doMock("../src/voice/audioCapture", () => ({ createAudioCapture: () => ({ start, stop }) }));
  const voice = await import("../src/voice/session");
  const pending = voice.startPushToTalk("first-agent");
  expect(voice.isPushToTalkBusy()).toBe(true);
  await voice.startPushToTalk("second-agent");
  expect(start).toHaveBeenCalledTimes(1);
  voice.cancelPushToTalk();
  ready();
  await pending;
  expect(stop).toHaveBeenCalledTimes(1);
  expect(rpc).not.toHaveBeenCalled();
  expect(voice.isPushToTalkBusy()).toBe(false);
});

it("keeps dictation local even when the daemon speech lifecycle is unavailable", async () => {
  const rpc = vi.fn(async () => { throw Error("daemon unavailable"); });
  vi.stubGlobal("window", { __CHIMERA_MOCK__: { rpc } });
  const stop = vi.fn(async () => new Blob());
  vi.doMock("../src/voice/audioCapture", () => ({ createAudioCapture: () => ({ start: async () => {}, stop }) }));
  const voice = await import("../src/voice/session"); await voice.startPushToTalk("agent");
  const { voiceLocal } = await import("../src/voice/store"); expect(voiceLocal.getState().status).toBe("listening");
  voice.cancelPushToTalk(); expect(stop).toHaveBeenCalledOnce(); expect(rpc).not.toHaveBeenCalled();
});

it("never sends a late transcript after cancellation or target change", async () => {
  setupRpc();
  let finish!: (text: string) => void;
  const transcribe = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  vi.doMock("../src/voice/registry", () => ({ getDefaultTtsEngine: () => ({ stopSpeaking() {} }), getDefaultSttEngine: () => ({ meta: { id: "test", healthy: true }, transcribe }) }));
  const voice = await import("../src/voice/session");
  await voice.startPushToTalk("first-agent");
  const send = vi.fn();
  const pending = voice.stopPushToTalkAndInsert(send);
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
  voice.cancelPushToTalk();
  finish("a task that no longer belongs to the selected agent");
  await pending;
  expect(send).not.toHaveBeenCalled();
  expect(voice.isPushToTalkBusy()).toBe(false);
});

it("releases microphone tracks when the recorder cannot initialize", async () => {
  const stop = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
  vi.stubGlobal("MediaRecorder", class { constructor() { throw new Error("unsupported recorder"); } });
  const { createAudioCapture } = await import("../src/voice/audioCapture");
  await expect(createAudioCapture().start()).rejects.toThrow("unsupported recorder");
  expect(stop).toHaveBeenCalledTimes(1);
});

it("releases the microphone immediately and rejects if a recorder never emits stop", async () => {
  vi.useFakeTimers();
  const stop = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
  vi.stubGlobal("MediaRecorder", class { state = "recording"; start() {} stop() {} });
  const { createAudioCapture } = await import("../src/voice/audioCapture");
  const capture = createAudioCapture(); await capture.start();
  const pending = capture.stop();
  const assertion = expect(pending).rejects.toThrow("did not stop");
  expect(stop).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5000); await assertion;
});

it("rejects unavailable local engines before requesting any microphone permission", async () => {
  setupRpc(); const create = vi.fn();
  vi.doMock("../src/voice/audioCapture", () => ({ createAudioCapture: create }));
  vi.doMock("../src/voice/registry", () => ({ getDefaultSttEngine: () => undefined }));
  const voice = await import("../src/voice/session"); await voice.startPushToTalk("agent");
  expect(create).not.toHaveBeenCalled(); const { voiceLocal } = await import("../src/voice/store"); expect(voiceLocal.getState().errorMessage).toContain("Set up local speech");
});

it("exits recording immediately on a device/capture failure", async () => {
  setupRpc(); let fail!: (error: Error) => void; const stop = vi.fn(async () => new Blob());
  vi.doMock("../src/voice/audioCapture", () => ({ createAudioCapture: (callback: (error: Error) => void) => { fail = callback; return { start: async () => {}, stop }; } }));
  const voice = await import("../src/voice/session"); await voice.startPushToTalk("agent"); fail(new Error("microphone device disconnected"));
  const { voiceLocal } = await import("../src/voice/store"); expect(voiceLocal.getState().status).toBe("error"); expect(voiceLocal.getState().errorMessage).toContain("disconnected"); expect(voice.isPushToTalkBusy()).toBe(false); expect(stop).toHaveBeenCalledOnce();
});
