// VOICE S5 (§3 R2c, §9): the default STT adapter until S7's whisper.cpp sidecar lands. Web
// Speech's SpeechRecognition is DISQUALIFIED (streams audio to Apple servers + flaky in
// WKWebView — see the design doc's R2c verdict), and there is no local STT yet, so push-to-talk
// runs on a scripted transcript via the SAME window.__CHIMERA_MOCK__ seam the rpc bridge uses
// (rpc/bridge.ts) — installed BEFORE the app loads, dev/test only. `healthy` reflects that: this
// engine only reports itself usable when the mock seam is actually present, so a real (non-dev,
// non-test) build's engine list honestly shows "no local STT yet" (§7 "engine unavailable" row)
// instead of silently pretending to transcribe.
import type { SpeechEngine } from "../types";

export const MOCK_STT_ENGINE_ID = "mock-stt";

type VoiceMockScript = { transcript?: string | (() => string) };
declare global {
  interface Window {
    __CHIMERA_VOICE_MOCK__?: VoiceMockScript;
  }
}

function mockSeamActive(): boolean {
  return typeof window !== "undefined" && !!window.__CHIMERA_MOCK__;
}

export function createMockSttEngine(): SpeechEngine {
  return {
    meta: { id: MOCK_STT_ENGINE_ID, label: "Mock transcript (dev/test)", isLocal: true, healthy: mockSeamActive() },
    transcribe(): Promise<string> {
      if (!mockSeamActive()) return Promise.reject(new Error("no local STT adapter yet (S7) — mock seam is inactive"));
      const scripted = window.__CHIMERA_VOICE_MOCK__?.transcript;
      const text = typeof scripted === "function" ? scripted() : scripted;
      return Promise.resolve(text ?? "mock transcript");
    },
  };
}
