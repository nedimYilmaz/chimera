// VOICE S5 (§3 R2c, §4): the LOCAL TTS default — window.speechSynthesis is pure webview JS,
// on-device, works in WKWebView with near-zero effort (unlike Web Speech's SpeechRecognition,
// which is disqualified for STT — see mockSttEngine.ts's header). This is the real shipped
// default, not a placeholder.
import type { SpeechEngine } from "../types";

export const SYSTEM_TTS_ENGINE_ID = "system-tts";

export function createSpeechSynthesisEngine(): SpeechEngine {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  return {
    meta: { id: SYSTEM_TTS_ENGINE_ID, label: "System voice (speechSynthesis)", isLocal: true, healthy: !!synth },
    synthesize(text: string): Promise<void> {
      if (!synth) return Promise.reject(new Error("speechSynthesis is unavailable in this window"));
      return new Promise((resolve, reject) => {
        const utter = new SpeechSynthesisUtterance(text);
        utter.onend = () => resolve();
        utter.onerror = (ev) => reject(new Error(ev.error || "speech synthesis failed"));
        synth.speak(utter);
      });
    },
    stopSpeaking(): void {
      synth?.cancel();
    },
  };
}
