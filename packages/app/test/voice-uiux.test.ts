// VOICE-STOP (uiux pass): the operator-facing half of the stop feature — what the control SAYS,
// what happens when the "speak agent replies" switch is flipped mid-reply, and whether a silent
// daemon/watchdog event reaches the transcript's notice channel at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOASTS } from "../src/copy";
import { voiceControlView } from "../src/voice/controlView";

const BASE = { errorMessage: null, conversationActive: false, connected: true, agentId: "a1", speakReplies: true } as const;

describe("push-to-talk control copy", () => {
  it("speaking is a STOP button: square glyph, stop label, clickable with no agent selected", () => {
    const v = voiceControlView({ ...BASE, status: "speaking", agentId: null, connected: false });
    expect(v.glyph).toBe("■");
    expect(v.label).toContain("Esc or click to stop");
    expect(v.title).toBe("stop speaking (Esc)");
    expect(v.stopMode).toBe(true);
    expect(v.disabled).toBe(false);   // push-to-talk clears agentId before the reply is spoken
  });

  // The stale-reason bug: the watchdog leaves an errorMessage on a NON-error status, and the old
  // control let it win "whenever set" — so an idle mic read "speech playback timed out" forever.
  it("an errorMessage only wins the label on the error status", () => {
    expect(voiceControlView({ ...BASE, status: "error", errorMessage: "microphone unavailable" }).label)
      .toBe("microphone unavailable");
    expect(voiceControlView({ ...BASE, status: "idle", errorMessage: "speech playback timed out" }).label)
      .toBe("hold to talk");
  });

  it("muted is visible on the control, not only in Settings", () => {
    const muted = voiceControlView({ ...BASE, status: "idle", speakReplies: false });
    expect(muted.muted).toBe(true);
    expect(muted.label).toContain("replies muted");
    expect(muted.title).toContain("Settings");
    expect(voiceControlView({ ...BASE, status: "idle" }).muted).toBe(false);
  });

  it("disabled explains itself and conversation mode gets its own labels", () => {
    expect(voiceControlView({ ...BASE, status: "idle", agentId: null }).title).toBe("select an agent to use push-to-talk");
    expect(voiceControlView({ ...BASE, status: "listening", conversationActive: true }).label).toContain("⌥Space");
  });
});

function installMockWindow(): void {
  (globalThis as unknown as { window: unknown }).window = {
    __CHIMERA_MOCK__: { rpc: async () => ({ ok: true }) },
    speechSynthesis: { speak: () => {}, cancel: () => {} },
    localStorage: undefined,
  };
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("muting mid-reply", () => {
  it("stops the reply in flight and says so (it used to keep talking to the end)", async () => {
    installMockWindow();
    vi.resetModules();
    const { voiceLocal } = await import("../src/voice/store");
    const { setSpeakRepliesEnabled, __resetTtsGateForTest } = await import("../src/voice/ttsGate");
    const { installMuteStopsSpeech } = await import("../src/voice/notices");
    __resetTtsGateForTest(true);
    const notices: string[] = [];
    const off = installMuteStopsSpeech((m) => notices.push(m));

    voiceLocal.dispatch({ type: "speaking", text: "a long answer" });
    setSpeakRepliesEnabled(false);
    expect(voiceLocal.getState().status).toBe("idle");
    expect(notices).toEqual([TOASTS.voiceRepliesMutedStopped]);

    setSpeakRepliesEnabled(true);
    expect(notices[1]).toBe(TOASTS.voiceRepliesUnmuted);
    off();
  });

  it("muting while nothing is speaking is a quieter notice, not a phantom stop", async () => {
    installMockWindow();
    vi.resetModules();
    const { voiceLocal } = await import("../src/voice/store");
    const { setSpeakRepliesEnabled, __resetTtsGateForTest } = await import("../src/voice/ttsGate");
    const { installMuteStopsSpeech } = await import("../src/voice/notices");
    __resetTtsGateForTest(true);
    const notices: string[] = [];
    const off = installMuteStopsSpeech((m) => notices.push(m));
    setSpeakRepliesEnabled(false);
    expect(notices).toEqual([TOASTS.voiceRepliesMuted]);
    expect(voiceLocal.getState().status).toBe("idle");
    off();
  });
});

describe("watchdog timeout is announced", () => {
  it("emits one notice and stops, and nothing when it wasn't speaking", async () => {
    installMockWindow();
    vi.resetModules();
    const { voiceLocal } = await import("../src/voice/store");
    const { speechTimeoutNotifier } = await import("../src/voice/notices");
    const notices: string[] = [];
    const onTimeout = speechTimeoutNotifier((m) => notices.push(m));

    onTimeout();
    expect(notices).toEqual([]);                    // no speech → no toast

    voiceLocal.dispatch({ type: "speaking", text: "hello" });
    onTimeout();
    expect(voiceLocal.getState().status).toBe("idle");
    expect(notices).toEqual([TOASTS.voiceSpeechTimedOut]);
  });
});
