import { Channel, invoke } from "@tauri-apps/api/core";
import type { SpeechEngine } from "../types";
import { speechPcm } from "../wav";
type SpeechEvent = { type: string; text?: string; final?: boolean; boundaryId?: string; utteranceId?: string; error?: string };
export function createAppleOnDeviceEngine(languages: string[], language: "en" | "tr" = "en"): SpeechEngine {
  return { meta: { id: "apple-on-device", label: "Apple on-device speech", isLocal: true, healthy: languages.includes(language === "tr" ? "tr-TR" : "en-US") },
    async transcribe(audio, options) {
      const locale = (options?.language ?? "en") === "tr" ? "tr-TR" : "en-US";
      if (!languages.includes(locale)) throw new Error(`On-device recognition is unavailable for ${locale}. No cloud fallback is enabled.`);
      const samples = await speechPcm(audio, options?.signal);
      // The meeting bridge queues only three seconds while finalizing a 45s round.
      // One-shot dictation stays within one round and exposes this bound honestly.
      if (samples.length > 30 * 16000) throw new Error("Apple on-device dictation is limited to 30 seconds per hold");
      const sessionId = `ptt-${crypto.randomUUID()}`; const boundaryId = crypto.randomUUID();
      const channel = new Channel<SpeechEvent>(); const segments = new Map<string, string>();
      let resolve!: (value: string) => void; let reject!: (error: Error) => void;
      const result = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
      // Avoid an unhandled rejection while startup/append IPC is still pending.
      void result.catch(() => {});
      channel.onmessage = event => {
        if (event.type === "error") reject(new Error(event.error ?? "On-device speech failed"));
        if (event.type === "transcript" && event.final) {
          if (event.utteranceId && event.text) segments.set(event.utteranceId, event.text);
          if (event.boundaryId === boundaryId) resolve([...segments.values()].join(" "));
        }
      };
      const cancel = () => { reject(new Error("Transcription cancelled")); void invoke("meeting_speech_stop", { sessionId }).catch(() => {}); };
      options?.signal?.throwIfAborted(); options?.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, 25000);
      try {
        await invoke("meeting_speech_start", { sessionId, locale, contextualStrings: [], onEvent: channel }); options?.signal?.throwIfAborted();
        for (let i = 0; i < samples.length; i += 16384) { options?.signal?.throwIfAborted(); await invoke("meeting_speech_append", { sessionId, samples: Array.from(samples.subarray(i, i + 16384)), sampleRate: 16000 }); }
        await invoke("meeting_speech_finish", { sessionId, boundaryId }); return await result;
      } finally { samples.fill(0); clearTimeout(timer); options?.signal?.removeEventListener("abort", cancel); await invoke("meeting_speech_stop", { sessionId }).catch(() => {}); }
    },
  };
}
