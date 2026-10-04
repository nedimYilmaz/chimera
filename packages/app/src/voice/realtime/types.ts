// VOICE R2 (docs/superpowers/specs/2026-07-24-voice-realtime-design.md §4 "Registry seam"):
// the RealtimeEngine abstraction. Duplex + session-lifetime, unlike the landed request/response
// SpeechEngine (registry.ts) — this is a PARALLEL kind, S1-S6's SpeechEngine registry is
// untouched. R3 (state machine), R4 (VAD), R5 (keymap) and RK2 (real OpenAI adapter) all consume
// this exact shape, so it is copied verbatim from the design doc rather than reinterpreted.
import type { VoiceRealtimeMode } from "@chimera/protocol/contract";
import type { EngineMetadata } from "../types";

export interface RealtimeEngine {
  readonly meta: EngineMetadata & { realtime: true };
  start(opts: RealtimeStartOpts): Promise<RealtimeSession>;
}

export interface RealtimeStartOpts {
  // §7/§3: the ephemeral token minted by voice.realtime.token (RK1) — R2 never calls the RPC
  // itself, it only carries the token through to a real adapter (RK2).
  token: string;
  agentId: string;
  mode: VoiceRealtimeMode;
}

export interface RealtimeSession {
  /** → voiceReducer partialTranscript (R3). */
  onPartialTranscript(cb: (t: string) => void): void;
  /** A: app forwards to the existing agent send path (R3). */
  onFinalTranscript(cb: (t: string) => void): void;
  /** Barge-in signal — client VAD (R4) in the real adapter, scripted in the mock. */
  onSpeechStart(cb: () => void): void;
  /** A: driven by the S4 voice_tts_chunk tap. */
  playTts(text: string): Promise<void>;
  /** Barge-in / turn error (§7 landed) — cancel in-flight/queued playback. */
  stopSpeaking(): void;
  close(): Promise<void>;
}
