import { afterEach, describe, expect, it, vi } from "vitest";

// VOICE R2 (§8 "Test strategy: mock RealtimeEngine drives the full loop headlessly", §9 R2):
// scripted partial/final transcripts in, captured send/TTS out, no network/mic/key. R3 (state
// machine) wires VAD callbacks -> dispatch for real; this test stands in for that orchestration
// with plain callbacks to prove the mock's contract shape matches types.ts verbatim.

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.resetModules();
});

describe("mock realtime engine — full scripted turn", () => {
  it("start -> partial transcripts -> final transcript -> send -> playTts -> barge-in -> close", async () => {
    (globalThis as unknown as { window: unknown }).window = {
      __CHIMERA_MOCK__: { rpc: async () => ({}) },
      __CHIMERA_REALTIME_MOCK__: { partials: ["hel", "hello wor"], final: "hello world" },
    };

    const { createMockRealtimeEngine, MockRealtimeSession } = await import("../src/voice/realtime/mockRealtimeEngine");
    const engine = createMockRealtimeEngine();
    expect(engine.meta.realtime).toBe(true);
    expect(engine.meta.isLocal).toBe(true);
    expect(engine.meta.healthy).toBe(true);

    const session = await engine.start({ token: "tok", agentId: "agent-1", mode: "transcription" });
    expect(session).toBeInstanceOf(MockRealtimeSession);
    const mockSession = session as InstanceType<typeof MockRealtimeSession>;

    const partials: string[] = [];
    const finals: string[] = [];
    const sent: string[] = [];
    let bargeIn = false;

    session.onPartialTranscript((t) => partials.push(t));
    session.onFinalTranscript((t) => {
      finals.push(t);
      sent.push(t); // stand-in for R3's "hand to the existing agent send path"
    });
    session.onSpeechStart(() => {
      bargeIn = true;
      session.stopSpeaking();
    });

    mockSession.fireScriptedTranscripts();
    expect(partials).toEqual(["hel", "hello wor"]);
    expect(finals).toEqual(["hello world"]);
    expect(sent).toEqual(["hello world"]);

    // Agent streams text back (stand-in for the S4 voice_tts_chunk tap) — RealtimeEngine plays it.
    await session.playTts("hi there");
    expect(mockSession.spokenText).toEqual(["hi there"]);

    // Barge-in: new speech while "speaking" cancels playback via stopSpeaking().
    mockSession.fireSpeechStart();
    expect(bargeIn).toBe(true);

    await session.close();
    expect(mockSession.closed).toBe(true);
  });

  it("rejects start() when the __CHIMERA_MOCK__ seam is inactive", async () => {
    (globalThis as unknown as { window: unknown }).window = {};
    const { createMockRealtimeEngine } = await import("../src/voice/realtime/mockRealtimeEngine");
    const engine = createMockRealtimeEngine();
    expect(engine.meta.healthy).toBe(false);
    await expect(engine.start({ token: "tok", agentId: "agent-1", mode: "transcription" })).rejects.toThrow();
  });
});
