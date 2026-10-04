// VOICE R4 (docs/superpowers/specs/2026-07-24-voice-realtime-design.md §5 "VAD + barge-in"):
// client-side Silero VAD (@ricky0123/vad-web, onnxruntime-web WASM) — on-device only, so VAD
// decisions never leave the machine (the ONLY audio that reaches OpenAI is the STT stream the
// user already opted into via R2/RK2). Mirrors audioCapture.ts's window.__CHIMERA_MOCK__ seam:
// headless tests (R6) drive onSpeechStart/onSpeechEnd deterministically instead of racing a real
// mic + WASM model.
// BUNDLE-STARTUP-COST: type-only here, loaded on demand in start() below. The runtime import
// drags in onnxruntime-web (~400 kB of the entry chunk, plus its WASM) for a feature that does
// nothing until you actually hold the talk key — so it must not be parsed at app startup.
import type { MicVAD } from "@ricky0123/vad-web";

export type VadHandlers = {
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
};

export interface VoiceActivityDetector {
  start(): Promise<void>;
  stop(): Promise<void>;
}

type VadMockSeam = { fireSpeechStart(): void; fireSpeechEnd(): void };
declare global {
  interface Window {
    __CHIMERA_VAD_MOCK__?: VadMockSeam;
  }
}

function mockSeamActive(): boolean {
  return typeof window !== "undefined" && !!window.__CHIMERA_MOCK__;
}

function createMockVad(handlers: VadHandlers): VoiceActivityDetector {
  const seam: VadMockSeam = { fireSpeechStart: handlers.onSpeechStart, fireSpeechEnd: handlers.onSpeechEnd };
  return {
    start(): Promise<void> {
      if (typeof window !== "undefined") window.__CHIMERA_VAD_MOCK__ = seam;
      return Promise.resolve();
    },
    stop(): Promise<void> {
      if (typeof window !== "undefined" && window.__CHIMERA_VAD_MOCK__ === seam) delete window.__CHIMERA_VAD_MOCK__;
      return Promise.resolve();
    },
  };
}

function createRealVad(handlers: VadHandlers): VoiceActivityDetector {
  let mic: MicVAD | null = null;
  return {
    async start(): Promise<void> {
      const { MicVAD } = await import("@ricky0123/vad-web");
      const instance = await MicVAD.new({
        onSpeechStart: handlers.onSpeechStart,
        onSpeechEnd: () => handlers.onSpeechEnd(),
      });
      mic = instance;
      instance.start();
    },
    async stop(): Promise<void> {
      const active = mic;
      mic = null;
      if (active) await active.destroy();
    },
  };
}

/** The one VAD entry point conversation.ts (R3) drives — real mic+Silero in the app, a
 * test-driven seam under __CHIMERA_MOCK__ so R6 never touches a real mic/WASM model. */
export function createVad(handlers: VadHandlers): VoiceActivityDetector {
  return mockSeamActive() ? createMockVad(handlers) : createRealVad(handlers);
}
