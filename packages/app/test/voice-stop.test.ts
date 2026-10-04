// VOICE-STOP: the operator reported there was no way to stop the app speaking. These cover the
// three surfaces that now stop it — the gated `esc` keymap row, the esc close-priority chain, and
// the watchdog — plus the "Speak agent replies" switch that prevents speech in the first place.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEYMAP, isWhenActive, registerWhen, resolveChord } from "../src/keymap";
import { resolveEscTier, type EscSnapshot } from "../src/state/commands.agents";
import { __resetTtsGateForTest, cancelSpeechGeneration, isCurrentSpeech, isSpeakRepliesEnabled, setSpeakRepliesEnabled, speechGeneration } from "../src/voice/ttsGate";
import { DEFAULT_VOICE_PREFS, VOICE_PREFS_STORAGE_KEY, loadPersistedVoicePrefs, persistVoicePrefs } from "../src/state/persistence";
import { SPEECH_TIMEOUT_MESSAGE } from "@chimera/ui-state";

describe("voice stop — keymap row", () => {
  it("declares esc → voice.stopSpeaking, global, gated on voiceSpeaking", () => {
    const row = KEYMAP.find((r) => r.action === "voice.stopSpeaking");
    expect(row).toBeDefined();
    expect(row?.chord).toBe("esc");
    expect(row?.scope).toBe("global");
    expect(row?.when).toBe("voiceSpeaking");
    expect(row?.unbound).toBeUndefined();
  });

  it("esc keeps its normal meaning until the gate is active, then resolves to the stop", () => {
    expect(isWhenActive("voiceSpeaking")).toBe(false);
    expect(resolveChord("esc", "agents")?.action).toBe("global.escape");

    let speaking = false;
    const off = registerWhen("voiceSpeaking", () => speaking);
    expect(resolveChord("esc", "agents")?.action).toBe("global.escape");
    speaking = true;
    expect(resolveChord("esc", "agents")?.action).toBe("voice.stopSpeaking");
    expect(resolveChord("esc", "settings")?.action).toBe("voice.stopSpeaking");
    off();
    expect(resolveChord("esc", "agents")?.action).toBe("global.escape");
  });
});

const QUIET: EscSnapshot = {
  voiceSpeaking: false, paletteOpen: false, mcpPaletteOpen: false, accountsOpen: false, resultOpen: false,
  modelOpen: false, pluginsOpen: false, hostToolsOpen: false, helpOpen: false, toolDetailOpen: false,
  agentDetailOpen: false, slashOpen: false, targetMenuOpen: false, spawnOpen: false, dialogVisible: false,
  questionVisible: false, permissionVisible: false, composeNonEmpty: false, queuedCount: 0, canInterrupt: false,
};

describe("voice stop — esc close-priority chain", () => {
  it("speaking outranks every overlay (audio is the most intrusive thing on screen)", () => {
    expect(resolveEscTier({ ...QUIET, voiceSpeaking: true })).toBe("voiceStopSpeaking");
    expect(resolveEscTier({ ...QUIET, voiceSpeaking: true, paletteOpen: true, helpOpen: true })).toBe("voiceStopSpeaking");
  });
  it("changes nothing when not speaking", () => {
    expect(resolveEscTier({ ...QUIET, paletteOpen: true })).toBe("palette");
    expect(resolveEscTier(QUIET)).toBeNull();
  });
});

describe("voice stop — speak-replies switch", () => {
  beforeEach(() => { __resetTtsGateForTest(true); });

  it("defaults to today's behaviour and persists both ways", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
    expect(DEFAULT_VOICE_PREFS.speakReplies).toBe(true);
    expect(loadPersistedVoicePrefs()).toEqual({ speakReplies: true });

    setSpeakRepliesEnabled(false);
    expect(isSpeakRepliesEnabled()).toBe(false);
    expect(loadPersistedVoicePrefs()).toEqual({ speakReplies: false });
    expect(store.get(VOICE_PREFS_STORAGE_KEY)).toContain("false");

    persistVoicePrefs({ speakReplies: true });
    expect(loadPersistedVoicePrefs()).toEqual({ speakReplies: true });
    vi.unstubAllGlobals();
  });

  it("corrupt storage degrades to speaking, never to a silent app", () => {
    vi.stubGlobal("localStorage", { getItem: () => "{not json", setItem: () => {}, removeItem: () => {} });
    expect(loadPersistedVoicePrefs()).toEqual({ speakReplies: true });
    vi.unstubAllGlobals();
  });
});

describe("voice stop — speech generation guard", () => {
  beforeEach(() => { __resetTtsGateForTest(true); });
  it("invalidates the token a queued chunk captured", () => {
    const token = speechGeneration();
    expect(isCurrentSpeech(token)).toBe(true);
    cancelSpeechGeneration();
    expect(isCurrentSpeech(token)).toBe(false);
    expect(isCurrentSpeech(speechGeneration())).toBe(true);
  });
});

// The voice modules below reach the rpc bridge at import time, so — exactly like
// voice-session-e2e — they are imported DYNAMICALLY after a mock window exists.
function installMockWindow(): { rpcCalls: { method: string; params: unknown }[]; cancels: () => number } {
  const rpcCalls: { method: string; params: unknown }[] = [];
  let cancels = 0;
  (globalThis as unknown as { window: unknown }).window = {
    __CHIMERA_MOCK__: {
      rpc: async (method: string, params: unknown) => {
        rpcCalls.push({ method, params });
        return method === "voice.session.start"
          ? { sessionId: "sess-1", agentId: (params as { agentId: string }).agentId, state: "listening", startedAt: 0 }
          : { ok: true };
      },
    },
    speechSynthesis: { speak: () => {}, cancel: () => { cancels += 1; } },
  };
  return { rpcCalls, cancels: () => cancels };
}

function pushEvent(event: Record<string, unknown>): void {
  (globalThis as unknown as { window: { __CHIMERA_PUSH__: { event(e: unknown): void } } }).window.__CHIMERA_PUSH__.event(event);
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.resetModules();
});

function fakeTimers() {
  let seq = 0;
  const pending = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void) => { const id = ++seq; pending.set(id, fn); return id; },
    clearTimer: (h: unknown) => { pending.delete(h as number); },
    fire: () => { const first = [...pending.entries()][0]; if (first) { pending.delete(first[0]); first[1](); } },
    size: () => pending.size,
  };
}

describe("voice stop — the stop itself", () => {
  it("stopSpeakingNow() cancels playback, closes the session and returns push-to-talk to idle", async () => {
    const mock = installMockWindow();
    vi.resetModules();
    const { voiceLocal } = await import("../src/voice/store");
    const { stopSpeakingNow } = await import("../src/voice/session");

    expect(stopSpeakingNow()).toBe(false);                      // nothing speaking → esc falls through
    voiceLocal.dispatch({ type: "sessionStarted", sessionId: "sess-1", agentId: "a1" });
    voiceLocal.dispatch({ type: "speaking", text: "hello" });
    expect(stopSpeakingNow()).toBe(true);
    expect(voiceLocal.getState().status).toBe("idle");
    expect(voiceLocal.getState().errorMessage).toBeNull();
    expect(mock.cancels()).toBeGreaterThan(0);                  // the utterance itself was cancelled
    await vi.waitFor(() => expect(mock.rpcCalls.map((c) => c.method)).toContain("voice.session.stop"));
  });

  // The operator's literal complaint: a reply streams chunk by chunk, so a stop that only kills
  // the QUEUED chunk lets the very next one start talking again.
  it("stays silent for the rest of the reply, then speaks the next one", async () => {
    installMockWindow();
    vi.resetModules();
    const { voiceLocal } = await import("../src/voice/store");
    const { installVoiceEventBridge } = await import("../src/voice/voiceEvents");
    const { stopSpeakingNow } = await import("../src/voice/session");
    installVoiceEventBridge();

    voiceLocal.dispatch({ type: "sessionStarted", sessionId: "sess-1", agentId: "a1" });
    voiceLocal.dispatch({ type: "speaking", text: "one" });
    expect(stopSpeakingNow()).toBe(true);

    const seen: string[] = [];
    const offStore = voiceLocal.subscribe(() => { seen.push(voiceLocal.getState().status); });
    pushEvent({ ts: 2, seq: 2, engineId: "local", agentId: "a1", kind: "voice_tts_chunk", data: { text: "two", final: false } });
    pushEvent({ ts: 3, seq: 3, engineId: "local", agentId: "a1", kind: "voice_tts_chunk", data: { text: "three", final: true } });
    await vi.waitFor(() => expect(voiceLocal.getState().status).toBe("idle"));
    offStore();
    expect(seen).not.toContain("speaking");   // no chunk of the stopped reply ever spoke

    // ...and the NEXT reply is not muted by that stop.
    const { isSpeechLatched } = await import("../src/voice/ttsGate");
    expect(isSpeechLatched()).toBe(false);
  });

  it("muted: a tts chunk never enters speaking, but still completes the turn", async () => {
    installMockWindow();
    vi.resetModules();
    const { voiceLocal } = await import("../src/voice/store");
    const { installVoiceEventBridge } = await import("../src/voice/voiceEvents");
    const gate = await import("../src/voice/ttsGate");

    installVoiceEventBridge();
    gate.__resetTtsGateForTest(false);
    voiceLocal.dispatch({ type: "sessionStarted", sessionId: "sess-1", agentId: "a1" });
    pushEvent({ ts: 1, seq: 1, engineId: "local", agentId: "a1", kind: "voice_tts_chunk", data: { text: "hi", final: true } });
    await vi.waitFor(() => expect(voiceLocal.getState().status).toBe("idle"));
    expect(voiceLocal.getState().lastTtsText).toBeNull();
  });
});

describe("voice stop — page-wide registration", () => {
  it("installs the gate + handler from the store bootstrap, not from a tab-scoped screen", async () => {
    installMockWindow();
    vi.resetModules();
    const km = await import("../src/keymap");
    const { voiceLocal } = await import("../src/voice/store");
    const { installVoiceStopKeybinding } = await import("../src/voice/keybind");
    const off = installVoiceStopKeybinding();
    expect(km.isWhenActive("voiceSpeaking")).toBe(false);
    voiceLocal.dispatch({ type: "speaking", text: "hi" });
    expect(km.isWhenActive("voiceSpeaking")).toBe(true);
    expect(km.resolveChord("esc", "settings")?.action).toBe("voice.stopSpeaking");
    off();
  });
});

describe("voice stop — playback watchdog", () => {
  it("falls back to idle with a reason when speaking never ends (push-to-talk)", async () => {
    installMockWindow();
    vi.resetModules();
    const { voiceLocal } = await import("../src/voice/store");
    const { installSpeakingWatchdog } = await import("../src/voice/watchdog");
    const t = fakeTimers();
    const timeouts: number[] = [];
    const off = installSpeakingWatchdog({
      timeoutMs: 120_000,
      setTimer: (fn, ms) => { timeouts.push(ms); return t.setTimer(fn); },
      clearTimer: t.clearTimer,
      onTimeout: () => { voiceLocal.dispatch({ type: "speechTimeout" }); },
    });

    expect(t.size()).toBe(0);                       // idle arms nothing
    voiceLocal.dispatch({ type: "speaking", text: "hello" });
    expect(t.size()).toBe(1);
    expect(timeouts[0]).toBe(120_000);

    t.fire();
    expect(voiceLocal.getState().status).toBe("idle");
    expect(voiceLocal.getState().errorMessage).toBe(SPEECH_TIMEOUT_MESSAGE);
    off();
  });

  it("re-arms on each chunk and disarms when speech ends", async () => {
    installMockWindow();
    vi.resetModules();
    const { voiceLocal } = await import("../src/voice/store");
    const { installSpeakingWatchdog } = await import("../src/voice/watchdog");
    const t = fakeTimers();
    const fired: number[] = [];
    const off = installSpeakingWatchdog({
      setTimer: (fn) => t.setTimer(fn), clearTimer: t.clearTimer,
      onTimeout: () => { fired.push(1); },
    });
    voiceLocal.dispatch({ type: "conversationStarted", sessionId: "s1", agentId: "a1" });
    voiceLocal.dispatch({ type: "speaking", text: "one" });
    voiceLocal.dispatch({ type: "speaking", text: "two" });   // progress → new timer, old cleared
    expect(t.size()).toBe(1);

    voiceLocal.dispatch({ type: "stopSpeaking" });
    expect(voiceLocal.getState().status).toBe("listening");   // conversation stays live
    expect(voiceLocal.getState().conversationActive).toBe(true);
    expect(t.size()).toBe(0);
    expect(fired).toEqual([]);
    off();
  });

  it("arms for a REMOTE speaking state with no local chunk (the stuck case)", async () => {
    installMockWindow();
    vi.resetModules();
    const { voiceLocal } = await import("../src/voice/store");
    const { installSpeakingWatchdog } = await import("../src/voice/watchdog");
    const t = fakeTimers();
    const off = installSpeakingWatchdog({ setTimer: (fn) => t.setTimer(fn), clearTimer: t.clearTimer, onTimeout: () => { voiceLocal.dispatch({ type: "speechTimeout" }); } });
    voiceLocal.dispatch({ type: "sessionState", state: "speaking" });
    expect(t.size()).toBe(1);
    t.fire();
    expect(voiceLocal.getState().status).toBe("idle");
    off();
  });
});
