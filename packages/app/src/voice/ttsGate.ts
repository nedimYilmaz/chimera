// VOICE-STOP: the two pieces of speech state that are NOT in the reducer, kept in one leaf module
// (imported by voiceEvents/session/Settings; imports nothing from voice/* itself, so it can never
// close an import cycle):
//   1. speakReplies — the persisted "Speak agent replies" switch. When off, TTS is skipped
//      entirely: conversation mode still listens and transcribes, push-to-talk still sends.
//   2. the speech GENERATION counter — the cancellation token every stop bumps. It exists because
//      cancelling playback REJECTS the in-flight utterance (speechSynthesis.cancel() fires
//      utter.onerror with "interrupted"), so without it a stop would immediately be overwritten by
//      an `error` state, or by the finished chunk's own "back to listening" dispatch.
import { useSyncExternalStore } from "react";
import { loadPersistedVoicePrefs, persistVoicePrefs } from "../state/persistence";

let speakReplies = loadPersistedVoicePrefs().speakReplies;
let generation = 0;
// VOICE-STOP: the generation token only invalidates chunks ALREADY queued. A reply streams
// sentence by sentence, so without this latch the very next voice_tts_chunk after a stop starts
// talking again — exactly the operator's complaint ("pressed stop, it kept talking"). Latched, the
// rest of the turn is dropped; the turn's final chunk still completes the turn and clears it.
let stopLatched = false;
const listeners = new Set<(enabled: boolean) => void>();

export function isSpeakRepliesEnabled(): boolean {
  return speakReplies;
}

export function setSpeakRepliesEnabled(enabled: boolean): void {
  if (speakReplies === enabled) return;
  speakReplies = enabled;
  persistVoicePrefs({ speakReplies: enabled });
  for (const listener of listeners) listener(enabled);
}

/** VOICE-STOP (uiux): the pref is module state, not store state, so nothing outside the Settings
 * checkbox could ever notice it flip — the composer control showed "hold to talk" identically
 * whether replies would be spoken or silently swallowed, and muting mid-reply kept talking.
 * Subscribers close both gaps; this module still imports nothing from voice/* (no cycle). */
export function onSpeakRepliesChange(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** React binding for the same subscription (the app's useSyncExternalStore convention). */
export function useSpeakReplies(): boolean {
  return useSyncExternalStore(onSpeakRepliesChange, isSpeakRepliesEnabled, isSpeakRepliesEnabled);
}

/** The token to capture when a chunk is queued; compare with isCurrentSpeech() afterwards. */
export function speechGeneration(): number {
  return generation;
}

/** Invalidate every queued/in-flight chunk. Returns the new generation. */
export function cancelSpeechGeneration(): number {
  generation += 1;
  return generation;
}

export function isCurrentSpeech(token: number): boolean {
  return token === generation;
}

/** Latched by a manual/timeout stop: drop the REST of this reply's chunks, not just the queued one. */
export function latchSpeechStopped(): void {
  stopLatched = true;
}

export function isSpeechLatched(): boolean {
  return stopLatched;
}

/** Cleared when a new turn starts (the final chunk of the stopped reply, a new push-to-talk
 * session, a new conversation) — a stop must never mute the NEXT reply. */
export function clearSpeechLatch(): void {
  stopLatched = false;
}

/** Test seam only — resets module state between cases. */
export function __resetTtsGateForTest(enabled: boolean = true): void {
  listeners.clear();
  speakReplies = enabled;
  generation = 0;
  stopLatched = false;
}
