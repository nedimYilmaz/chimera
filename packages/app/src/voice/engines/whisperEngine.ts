import { rpcCall } from "../../rpc/bridge";
import type { SpeechEngine } from "../types";
import { pcm16Wav, speechBase64, speechPcm } from "../wav";
export function createWhisperEngine(healthy: boolean): SpeechEngine {
  return { meta: { id: "whisper-cpp", label: "Whisper local · small multilingual", isLocal: true, healthy },
    async transcribe(audio, options) {
      const samples = await speechPcm(audio, options?.signal);
      const bytes = pcm16Wav(samples); const requestId = crypto.randomUUID();
      const cancel = () => { void rpcCall("stt.transcribeCancel", { requestId }).catch(() => {}); };
      options?.signal?.throwIfAborted(); options?.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await rpcCall<{ text: string }>("stt.transcribe", { requestId, engine: "whisper-cpp", language: options?.language ?? "en", audio: { format: "wav-pcm16-16k-mono", base64: speechBase64(bytes) } });
        options?.signal?.throwIfAborted(); return result.text;
      } finally { samples.fill(0); bytes.fill(0); options?.signal?.removeEventListener("abort", cancel); }
    },
  };
}
