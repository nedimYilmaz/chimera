import { afterEach, describe, expect, it, vi } from "vitest";
import { pcm16Wav } from "../src/voice/wav";
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.useRealTimers(); });
describe("local dictation capture boundary", () => {
  it("encodes bounded mono PCM16 with clamping and a canonical WAV header", () => {
    const bytes = pcm16Wav(new Float32Array([-2, 0, 2])); const v = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF"); expect(v.getUint32(24, true)).toBe(16000); expect(v.getUint16(22, true)).toBe(1);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([-32768, 0, 32767]);
    expect(() => pcm16Wav(new Float32Array(960001))).toThrow("60 seconds"); expect(() => pcm16Wav(new Float32Array([NaN]))).toThrow("Invalid");
  });
  it("releases a microphone granted after the user cancelled the permission prompt", async () => {
    let grant!: (stream: unknown) => void; const stop = vi.fn();
    vi.stubGlobal("window", {}); vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise(r => { grant = r; }) } });
    const { createAudioCapture } = await import("../src/voice/audioCapture"); const capture = createAudioCapture();
    const pending = capture.start(); capture.cancel?.(); grant({ getTracks: () => [{ stop }] });
    await expect(pending).rejects.toThrow("cancelled"); expect(stop).toHaveBeenCalledOnce();
  });
  it("stops a device on the duration limit without silently returning partial text", async () => {
    vi.useFakeTimers(); const stop = vi.fn(); let recorder: any;
    vi.stubGlobal("window", {}); vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
    vi.stubGlobal("MediaRecorder", class { state = "recording"; onstop?: () => void; constructor() { recorder = this; } start() {} stop() { this.state = "inactive"; this.onstop?.(); } });
    const { createAudioCapture } = await import("../src/voice/audioCapture"); const capture = createAudioCapture(); await capture.start(); await vi.advanceTimersByTimeAsync(60000);
    expect(stop).toHaveBeenCalled(); expect(recorder.state).toBe("inactive"); await expect(capture.stop()).rejects.toThrow("60 second");
  });
});
