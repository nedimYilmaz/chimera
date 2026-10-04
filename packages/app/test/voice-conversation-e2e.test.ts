import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";

// VOICE R6 (docs/superpowers/specs/2026-07-24-voice-realtime-design.md §8/§9 "R6 mock e2e
// tests"): drives the FULL ⌥Space conversation loop headlessly — toggle on -> listening -> VAD
// onSpeechEnd -> send (existing path) -> agent's voice_tts_chunk reply -> RealtimeSession.playTts
// -> barge-in (VAD onSpeechStart while speaking -> stopSpeaking + agent.interrupt) -> toggle off
// -> teardown. No real mic/WASM/key: the mock RealtimeEngine (R2) + vad.ts's __CHIMERA_VAD_MOCK__
// seam (R4) stand in for both.

type RpcCall = { method: string; params: unknown };

function installMockWindow(): { rpcCalls: RpcCall[] } {
  const rpcCalls: RpcCall[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    __CHIMERA_MOCK__: {
      rpc: async (method: string, params: unknown) => {
        rpcCalls.push({ method, params });
        switch (method) {
          case "voice.session.start":
            return { sessionId: "sess-1", agentId: (params as { agentId: string }).agentId, state: "listening", startedAt: 0 };
          case "voice.conversation.set":
            return params;
          case "voice.realtime.token":
            return { token: "tok-1", expiresAt: 0, url: "wss://mock", model: "mock-realtime" };
          case "voice.session.stop":
            return { stopped: true };
          case "agent.interrupt":
            return { ok: true };
          default:
            throw new Error(`unexpected rpc ${method}`);
        }
      },
    },
    __CHIMERA_REALTIME_MOCK__: { partials: ["hel"], final: "hello agent" },
  };
  return { rpcCalls };
}

function pushDaemonEvent(event: NormalizedEvent): void {
  (globalThis as unknown as { window: { __CHIMERA_PUSH__: { event(e: NormalizedEvent): void } } })
    .window.__CHIMERA_PUSH__.event(event);
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.resetModules();
});

describe("⌥Space conversation mode — full mock e2e", () => {
  it("toggle on -> listen -> transcribe -> send -> agent TTS -> barge-in -> toggle off", async () => {
    const { rpcCalls } = installMockWindow();
    vi.resetModules();

    const { installVoiceEventBridge } = await import("../src/voice/voiceEvents");
    const { toggleConversation, isConversationActive, activeConversationFor } = await import("../src/voice/realtime/conversation");
    const { MockRealtimeSession } = await import("../src/voice/realtime/mockRealtimeEngine");
    const { voiceLocal } = await import("../src/voice/store");

    installVoiceEventBridge();

    // --- toggle ON --------------------------------------------------------
    const sent: string[] = [];
    await toggleConversation("agent-1", (text) => sent.push(text));

    expect(isConversationActive()).toBe(true);
    expect(voiceLocal.getState()).toMatchObject({ status: "listening", sessionId: "sess-1", agentId: "agent-1", conversationActive: true });
    expect(rpcCalls.map((c) => c.method)).toEqual(["voice.session.start", "voice.conversation.set", "voice.realtime.token"]);
    expect(rpcCalls[1]).toEqual({ method: "voice.conversation.set", params: { agentId: "agent-1", enabled: true } });

    const session = activeConversationFor("agent-1") as InstanceType<typeof MockRealtimeSession>;
    expect(session).toBeInstanceOf(MockRealtimeSession);

    // STT session produces its scripted partial/final transcripts (independent of VAD timing).
    session.fireScriptedTranscripts();
    expect(voiceLocal.getState().partialTranscript).toBe("hel");
    expect(sent).toEqual([]); // final transcript alone never sends — only VAD onSpeechEnd triggers it

    // --- VAD onSpeechEnd: take the final transcript, send via the existing path ------------
    const vadSeam = (globalThis as unknown as { window: { __CHIMERA_VAD_MOCK__: { fireSpeechEnd(): void; fireSpeechStart(): void } } }).window.__CHIMERA_VAD_MOCK__;
    vadSeam.fireSpeechEnd();
    expect(sent).toEqual(["hello agent"]);
    expect(voiceLocal.getState().status).toBe("transcribing");

    // --- agent streams its reply -> S4's voice_tts_chunk tap -> RealtimeSession.playTts ----
    pushDaemonEvent({ ts: 1, seq: 1, engineId: "local", agentId: "agent-1", kind: "voice_tts_chunk", data: { text: "hi there", final: false } });
    await vi.waitFor(() => expect(voiceLocal.getState().status).toBe("speaking"));
    expect(session.spokenText).toEqual(["hi there"]);

    // --- barge-in: new user speech while the agent is speaking ------------
    const stopSpeaking = vi.spyOn(session, "stopSpeaking");
    vadSeam.fireSpeechStart();
    expect(stopSpeaking).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(rpcCalls.some((c) => c.method === "agent.interrupt")).toBe(true));
    expect(rpcCalls.at(-1)).toEqual({ method: "agent.interrupt", params: { agentId: "agent-1" } });
    expect(voiceLocal.getState()).toMatchObject({ status: "listening", conversationActive: true });

    // A final chunk after the turn resumes returns to listening too (not idle — conversation stays active).
    pushDaemonEvent({ ts: 2, seq: 2, engineId: "local", agentId: "agent-1", kind: "voice_tts_chunk", data: { text: "done", final: true } });
    await vi.waitFor(() => expect(session.spokenText).toHaveLength(2));
    expect(session.spokenText).toEqual(["hi there", "done"]);
    await vi.waitFor(() => expect(voiceLocal.getState().status).toBe("listening"));
    expect(voiceLocal.getState().conversationActive).toBe(true);

    // --- toggle OFF: full teardown ------------------------------------------------------------
    await toggleConversation("agent-1", (text) => sent.push(text));
    expect(isConversationActive()).toBe(false);
    expect(session.closed).toBe(true);
    expect(voiceLocal.getState()).toEqual({
      status: "idle", sessionId: null, agentId: null,
      partialTranscript: "", lastTtsText: null, errorMessage: null, conversationActive: false,
    });
    expect(rpcCalls.filter((c) => c.method === "voice.session.stop")).toEqual([{ method: "voice.session.stop", params: { sessionId: "sess-1" } }]);
    expect(rpcCalls.filter((c) => c.method === "voice.conversation.set")).toEqual([
      { method: "voice.conversation.set", params: { agentId: "agent-1", enabled: true } },
      { method: "voice.conversation.set", params: { agentId: "agent-1", enabled: false } },
    ]);
  });

  it("surfaces the friendly 'voice not configured' error and never starts when the token mint fails", async () => {
    const rpcCalls: RpcCall[] = [];
    (globalThis as unknown as { window: unknown }).window = {
      __CHIMERA_MOCK__: {
        rpc: async (method: string, params: unknown) => {
          rpcCalls.push({ method, params });
          if (method === "voice.session.start") return { sessionId: "sess-1", agentId: (params as { agentId: string }).agentId, state: "listening", startedAt: 0 };
          if (method === "voice.conversation.set") return params;
          if (method === "voice.realtime.token") {
            const err = new Error("OpenAI voice account not configured") as Error & { code: string };
            err.code = "credential";
            throw err;
          }
          if (method === "voice.session.stop") return { stopped: true };
          throw new Error(`unexpected rpc ${method}`);
        },
      },
    };
    vi.resetModules();

    const { toggleConversation, isConversationActive, VOICE_REALTIME_NOT_CONFIGURED_MESSAGE } = await import("../src/voice/realtime/conversation");
    const { voiceLocal } = await import("../src/voice/store");

    await toggleConversation("agent-1", () => {});

    expect(isConversationActive()).toBe(false);
    expect(voiceLocal.getState().status).toBe("error");
    expect(voiceLocal.getState().errorMessage).toBe(VOICE_REALTIME_NOT_CONFIGURED_MESSAGE);
    expect(voiceLocal.getState().errorMessage).not.toContain("Mock transcript");
  });

  it("releases the realtime session and daemon voice state when the mic/VAD fails to start", async () => {
    const { rpcCalls } = installMockWindow();
    vi.resetModules();

    vi.doMock("../src/voice/realtime/vad", () => ({
      createVad: () => ({
        start: () => Promise.reject(new Error("microphone permission denied")),
        stop: () => Promise.resolve(),
      }),
    }));

    const { toggleConversation, isConversationActive } = await import("../src/voice/realtime/conversation");
    const { MockRealtimeSession } = await import("../src/voice/realtime/mockRealtimeEngine");
    const { voiceLocal } = await import("../src/voice/store");

    const closeSpy = vi.spyOn(MockRealtimeSession.prototype, "close");

    await toggleConversation("agent-1", () => {});

    expect(isConversationActive()).toBe(false);
    expect(voiceLocal.getState().status).toBe("error");
    expect(voiceLocal.getState().errorMessage).toBe("microphone permission denied");
    // the already-opened realtime session must be closed, not leaked
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // and the daemon-side session/conversation-enabled state must be released too
    expect(rpcCalls.filter((c) => c.method === "voice.session.stop")).toEqual([{ method: "voice.session.stop", params: { sessionId: "sess-1" } }]);
    expect(rpcCalls.filter((c) => c.method === "voice.conversation.set")).toEqual([
      { method: "voice.conversation.set", params: { agentId: "agent-1", enabled: true } },
      { method: "voice.conversation.set", params: { agentId: "agent-1", enabled: false } },
    ]);

    vi.doUnmock("../src/voice/realtime/vad");
  });

  // ERROR-EXTRACTION-SWEEP: the daemon's rpcCall rejects with a plain {code,message}
  // object, never a JS Error — `err instanceof Error ? err.message : "<generic>"`
  // silently discards the real daemon message and always shows the generic fallback.
  it("surfaces the daemon's real {code,message} rejection text when voice.session.start fails", async () => {
    (globalThis as unknown as { window: unknown }).window = {
      __CHIMERA_MOCK__: {
        rpc: async (method: string) => {
          if (method === "voice.session.start") throw { code: "not_found", message: "no audio device registered for this agent" };
          throw new Error(`unexpected rpc ${method}`);
        },
      },
    };
    vi.resetModules();

    const { toggleConversation, isConversationActive } = await import("../src/voice/realtime/conversation");
    const { voiceLocal } = await import("../src/voice/store");

    await toggleConversation("agent-1", () => {});

    expect(isConversationActive()).toBe(false);
    expect(voiceLocal.getState().status).toBe("error");
    expect(voiceLocal.getState().errorMessage).toBe("no audio device registered for this agent");
  });
});
