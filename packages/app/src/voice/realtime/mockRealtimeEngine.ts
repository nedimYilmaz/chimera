// VOICE R2 (§4, §8 "Test strategy"): the mock RealtimeEngine — scripted partial/final
// transcripts in, captured TTS/agent-send out, deterministic, no network/mic/key. Mirrors the
// mockSttEngine.ts pattern (same window.__CHIMERA_MOCK__ dev/test seam) so R3/R6's headless
// conversation-loop tests drive a full realtime turn (start -> transcripts -> playTts ->
// barge-in -> close) without the real OpenAI adapter (RK2).
import type { RealtimeEngine, RealtimeSession, RealtimeStartOpts } from "./types";

export const MOCK_REALTIME_ENGINE_ID = "mock-realtime";

type RealtimeMockScript = {
  // Scripted transcripts fired (in order) shortly after start() — a test calls
  // fireScriptedTranscripts()/fireScriptedSpeechStart() explicitly rather than racing timers.
  partials?: string[];
  final?: string;
};

declare global {
  interface Window {
    __CHIMERA_REALTIME_MOCK__?: RealtimeMockScript;
  }
}

function mockSeamActive(): boolean {
  return typeof window !== "undefined" && !!window.__CHIMERA_MOCK__;
}

export class MockRealtimeSession implements RealtimeSession {
  private partialCbs: Array<(t: string) => void> = [];
  private finalCbs: Array<(t: string) => void> = [];
  private speechStartCbs: Array<() => void> = [];
  readonly spokenText: string[] = [];
  closed = false;

  constructor(private readonly script: RealtimeMockScript) {}

  onPartialTranscript(cb: (t: string) => void): void {
    this.partialCbs.push(cb);
  }

  onFinalTranscript(cb: (t: string) => void): void {
    this.finalCbs.push(cb);
  }

  onSpeechStart(cb: () => void): void {
    this.speechStartCbs.push(cb);
  }

  /** Test-driven: fire the script's partials, then its final transcript. */
  fireScriptedTranscripts(): void {
    for (const partial of this.script.partials ?? []) {
      for (const cb of this.partialCbs) cb(partial);
    }
    if (this.script.final !== undefined) {
      for (const cb of this.finalCbs) cb(this.script.final);
    }
  }

  /** Test-driven barge-in trigger. */
  fireSpeechStart(): void {
    for (const cb of this.speechStartCbs) cb();
  }

  playTts(text: string): Promise<void> {
    this.spokenText.push(text);
    return Promise.resolve();
  }

  stopSpeaking(): void {
    // no-op: the mock never has real in-flight playback to cancel.
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

export function createMockRealtimeEngine(): RealtimeEngine {
  return {
    meta: {
      id: MOCK_REALTIME_ENGINE_ID,
      label: "Mock realtime (dev/test)",
      isLocal: true,
      healthy: mockSeamActive(),
      realtime: true,
    },
    start(_opts: RealtimeStartOpts): Promise<RealtimeSession> {
      if (!mockSeamActive()) return Promise.reject(new Error("mock realtime engine requires the __CHIMERA_MOCK__ seam"));
      const script = window.__CHIMERA_REALTIME_MOCK__ ?? {};
      return Promise.resolve(new MockRealtimeSession(script));
    },
  };
}
