import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";

// VOICE S5+S6 (§9 "window.__CHIMERA_MOCK__ seam"): the full push-to-talk flow driven headlessly
// — scripted transcript in (mock STT) → existing send path → voice_tts_chunk event → captured
// synth text out (mock speechSynthesis) — with NO real mic/DOM, same discipline
// agents-window-harness.ts documents for the rpc bridge mock branch.

type RpcCall = { method: string; params: unknown };

function installMockWindow(transcript: string | undefined): { rpcCalls: RpcCall[]; spoken: string[] } {
  const rpcCalls: RpcCall[] = [];
  const spoken: string[] = [];

  (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
    text: string;
    onend: (() => void) | null = null;
    onerror: ((ev: { error: string }) => void) | null = null;
    constructor(text: string) { this.text = text; }
  };

  (globalThis as unknown as { window: unknown }).window = {
    __CHIMERA_MOCK__: {
      rpc: async (method: string, params: unknown) => {
        rpcCalls.push({ method, params });
        if (method === "voice.session.start") {
          return { sessionId: "sess-1", agentId: (params as { agentId: string }).agentId, state: "listening", startedAt: 0 };
        }
        if (method === "voice.session.stop") return { stopped: true };
        throw new Error(`unexpected rpc ${method}`);
      },
    },
    __CHIMERA_VOICE_MOCK__: transcript === undefined ? undefined : { transcript },
    speechSynthesis: {
      speak: (utter: { text: string; onend: (() => void) | null }) => {
        spoken.push(utter.text);
        queueMicrotask(() => utter.onend?.());
      },
      cancel: () => {},
    },
  };
  return { rpcCalls, spoken };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
  vi.resetModules();
});

describe("push-to-talk mock end-to-end", () => {
  it("hold -> insert draft without agent RPC -> independent spoken reply remains available", async () => {
    const { rpcCalls, spoken } = installMockWindow("hello world");
    vi.resetModules();

    const { installVoiceEventBridge } = await import("../src/voice/voiceEvents");
    const { startPushToTalk, stopPushToTalkAndInsert } = await import("../src/voice/session");
    const { voiceLocal } = await import("../src/voice/store");

    installVoiceEventBridge();

    await startPushToTalk("agent-1");
    expect(voiceLocal.getState().status).toBe("listening");
    expect(voiceLocal.getState().sessionId).toMatch(/^dictation:/);
    expect(rpcCalls).toEqual([]);
    const localPush = (globalThis as any).window.__CHIMERA_PUSH__;
    localPush.event({ ts: 0, seq: 0, engineId: "local", agentId: "agent-1", kind: "voice_tts_chunk", data: { text: "do not interrupt capture", final: true } });
    await Promise.resolve(); expect(spoken).toEqual([]); expect(voiceLocal.getState().status).toBe("listening");

    const sent: string[] = [];
    await stopPushToTalkAndInsert((text) => sent.push(text));
    expect(sent).toEqual(["hello world"]);
    expect(rpcCalls).toEqual([]);
    expect(voiceLocal.getState().status).toBe("idle");

    // Simulate the daemon's TTS reply arriving over the event stream (S4's future emitter —
    // this bridge is written against the landed event contract, not a live emitter).
    const push = (globalThis as unknown as { window: { __CHIMERA_PUSH__: { event(e: NormalizedEvent): void } } }).window.__CHIMERA_PUSH__;
    push.event({
      ts: 1, seq: 1, engineId: "local", agentId: "agent-1",
      kind: "voice_tts_chunk", data: { sessionId: "sess-1", text: "hi there", final: true },
    });

    await vi.waitFor(() => expect(spoken).toEqual(["hi there"]));
    await vi.waitFor(() => expect(voiceLocal.getState().status).toBe("idle"));
  });

  it("an empty scripted transcript never sends and surfaces the \"didn't catch that\" error (§7)", async () => {
    installMockWindow("");
    vi.resetModules();

    const { startPushToTalk, stopPushToTalkAndInsert } = await import("../src/voice/session");
    const { voiceLocal } = await import("../src/voice/store");

    await startPushToTalk("agent-1");
    const sent: string[] = [];
    await stopPushToTalkAndInsert((text) => sent.push(text));

    expect(sent).toEqual([]);
    expect(voiceLocal.getState().status).toBe("error");
    expect(voiceLocal.getState().errorMessage).toBe("didn't catch that");
  });

  it("a hung STT engine times out into the error state instead of wedging \"transcribing\" forever", async () => {
    installMockWindow("hello world");
    vi.resetModules();
    vi.useFakeTimers();

    vi.doMock("../src/voice/registry", () => ({
      getDefaultTtsEngine: () => ({ stopSpeaking() {} }),
      getDefaultSttEngine: () => ({
        meta: { id: "hung-stt", label: "Hung STT", isLocal: true, healthy: true },
        transcribe: () => new Promise<string>(() => {}), // never resolves
      }),
    }));

    try {
      const { startPushToTalk, stopPushToTalkAndInsert, isPushToTalkBusy } = await import("../src/voice/session");
      const { voiceLocal } = await import("../src/voice/store");

      await startPushToTalk("agent-1");
      const sent: string[] = [];
      const donePromise = stopPushToTalkAndInsert((text) => sent.push(text));
      expect(voiceLocal.getState().status).toBe("transcribing");

      await vi.advanceTimersByTimeAsync(28_000);
      await donePromise;

      expect(sent).toEqual([]);
      expect(voiceLocal.getState().status).toBe("error");
      expect(voiceLocal.getState().errorMessage).toBe("transcription timed out");
      // the control must be usable again — not permanently stuck as "busy".
      expect(isPushToTalkBusy()).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.doUnmock("../src/voice/registry");
    }
  });

  it("a failed microphone start cancels capture without touching an agent session", async () => {
    const rpcCalls: RpcCall[] = [];
    (globalThis as unknown as { window: unknown }).window = {
      __CHIMERA_MOCK__: {
        rpc: async (method: string, params: unknown) => {
          rpcCalls.push({ method, params });
          if (method === "voice.session.start") throw new Error("daemon unreachable");
          throw new Error(`unexpected rpc ${method}`);
        },
      },
    };
    vi.resetModules();

    const stop = vi.fn().mockResolvedValue(new Blob());
    const cancel = vi.fn();
    vi.doMock("../src/voice/audioCapture", () => ({
      createAudioCapture: () => ({ start: () => Promise.reject(new Error("microphone unavailable")), stop, cancel }),
    }));

    try {
      const { startPushToTalk } = await import("../src/voice/session");
      const { voiceLocal } = await import("../src/voice/store");

      await startPushToTalk("agent-1");

      expect(cancel).toHaveBeenCalledOnce();
      expect(rpcCalls).toEqual([]);
      expect(voiceLocal.getState().status).toBe("error");
      expect(voiceLocal.getState().errorMessage).toBe("microphone unavailable");
    } finally {
      vi.doUnmock("../src/voice/audioCapture");
    }
  });

  it("capture-stop-hang: a rejecting capture.stop() lands in error instead of wedging \"transcribing\" forever", async () => {
    const { rpcCalls } = installMockWindow("hello world");
    vi.resetModules();

    vi.doMock("../src/voice/audioCapture", () => ({
      createAudioCapture: () => ({
        start: () => Promise.resolve(),
        stop: () => Promise.reject(new Error("recorder in an unexpected state")),
      }),
    }));

    try {
      const { startPushToTalk, stopPushToTalkAndInsert, isPushToTalkBusy, cancelPushToTalk } = await import("../src/voice/session");
      const { voiceLocal } = await import("../src/voice/store");

      await startPushToTalk("agent-1");
      const sent: string[] = [];
      await stopPushToTalkAndInsert((text) => sent.push(text));

      expect(sent).toEqual([]);
      expect(voiceLocal.getState().status).toBe("error");
      expect(voiceLocal.getState().errorMessage).toBe("recorder in an unexpected state");
      // the control must be usable again — not permanently stuck as "busy", and the session
      // must have been told to stop even though the local capture teardown failed.
      expect(isPushToTalkBusy()).toBe(false);
      expect(rpcCalls).toEqual([]);
      // cancelPushToTalk (mouseleave) requires status === "listening" in the UI — it must never
      // be needed here because this call already resolved the state on its own.
      cancelPushToTalk();
      expect(voiceLocal.getState().status).toBe("idle");
    } finally {
      vi.doUnmock("../src/voice/audioCapture");
    }
  });
});
