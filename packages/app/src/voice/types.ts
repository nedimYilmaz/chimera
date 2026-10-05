// VOICE S5 (docs/superpowers/specs/2026-07-24-voice-agents-design.md §4): the SpeechEngine
// interface every STT/TTS adapter implements, plus its privacy metadata. Both methods are
// optional — an engine can be STT-only (mock-stt, later whisper.cpp S7), TTS-only (system-tts),
// or both (a future cloud engine, S8) — the registry never assumes an engine does everything.
export type EngineMetadata = {
  id: string;
  label: string;
  isLocal: boolean;   // false ⇒ audio leaves the machine — the settings scaffold flags this (S8)
  healthy: boolean;   // false ⇒ registry/UI shows an engine error and falls back to text-only (§7)
};

export interface SpeechEngine {
  readonly meta: EngineMetadata;
  transcribe?(audio: Blob, options?: { signal?: AbortSignal; language?: "en" | "tr" }): Promise<string>;
  synthesize?(text: string): Promise<void>;
  /** Cancel in-flight/queued playback — used when a turn errors mid-speech (§7). */
  stopSpeaking?(): void;
}
