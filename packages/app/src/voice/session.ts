// Local dictation inserts into the caller-owned draft; it never invokes a message send.
import { rpcCall } from "../rpc/bridge";
import { createAudioCapture, type AudioCapture } from "./audioCapture";
import { getDefaultSttEngine, getDefaultTtsEngine } from "./registry";
import { sttLanguage } from "./localStt";
import { isConversationActive, stopActiveConversationSpeaking } from "./realtime/conversation";
import { voiceLocal } from "./store";
import { cancelSpeechGeneration, clearSpeechLatch, latchSpeechStopped } from "./ttsGate";
import { nativeCodexVoice } from "./nativeCodex";

let activeCapture: AudioCapture | null = null;
let pendingCapture: AudioCapture | null = null;
let captureGeneration = 0;
let startingCapture = false;

// BUG FIX (transcribing-hang): stopPushToTalkAndInsert awaited engine.transcribe() with no
// timeout, and cancelPushToTalk's only trigger (onMouseLeave/onTouchCancel) requires
// status === "listening" — a no-op once we're in "transcribing". A stalled/hung STT call
// (network stall, dead adapter) left the control permanently stuck showing "transcribing…"
// with isPushToTalkBusy() blocking every subsequent press. Bound the call so a hang always
// resolves into the existing `error` state instead of wedging the control forever.
const TRANSCRIBE_TIMEOUT_MS = 28_000;
let transcriptionController: AbortController | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export function isPushToTalkBusy(): boolean {
  const status = voiceLocal.getState().status;
  return startingCapture || status === "listening" || status === "transcribing";
}

/** Only an explicit hold opens a microphone. Dictation owns no daemon speech session:
 * opening that session would opt a busy agent into speaking during capture. */
export async function startPushToTalk(agentId: string): Promise<void> {
  if (isPushToTalkBusy() || isConversationActive() || ["connecting", "listening"].includes(nativeCodexVoice.getState().status)) return;
  const engine = getDefaultSttEngine();
  if (!engine?.meta.healthy || !engine.transcribe) { voiceLocal.dispatch({ type: "error", message: "Set up local speech in Settings → voice engines" }); return; }
  const generation = ++captureGeneration;
  startingCapture = true;
  cancelSpeechGeneration();
  getDefaultTtsEngine().stopSpeaking?.();
  clearSpeechLatch();   // a stop only silences the reply it interrupted, never the next one
  const capture = pendingCapture = createAudioCapture(error => {
    if (generation !== captureGeneration) return;
    cancelPushToTalk(); voiceLocal.dispatch({ type: "error", message: error.message });
  });
  try {
    await withTimeout(capture.start(), 15000, "microphone permission timed out");
  } catch (err) {
    if (pendingCapture === capture) pendingCapture = null;
    capture.cancel?.();
    if (generation === captureGeneration) {
      startingCapture = false;
      voiceLocal.dispatch({ type: "error", message: err instanceof Error ? err.message : "microphone unavailable" });
    }
    return;
  }
  if (pendingCapture === capture) pendingCapture = null;
  if (generation !== captureGeneration) { void capture.stop().catch(() => {}); return; }
  activeCapture = capture;
  startingCapture = false;
  voiceLocal.dispatch({ type: "sessionStarted", sessionId: `dictation:${crypto.randomUUID()}`, agentId });
}

/** Release returns a final transcript to the current draft owner. Cancellation invalidates
 * both transcription and the caller, so late work cannot insert into a different draft. */
export async function stopPushToTalkAndInsert(insert: (text: string) => void): Promise<void> {
  const state = voiceLocal.getState();
  const capture = activeCapture;
  if (state.status !== "listening" || !capture || !state.sessionId) return;
  const generation = captureGeneration;
  activeCapture = null;
  voiceLocal.dispatch({ type: "transcribing" });
  let audio: Blob;
  try {
    audio = await capture.stop();
  } catch (err) {
    // BUG FIX (capture-stop-hang): capture.stop() was awaited unguarded. A rejection (recorder
    // in an unexpected state, hardware error) threw out of this function, stranding status at
    // "transcribing" forever — cancelPushToTalk's only UI trigger requires status === "listening"
    // (PushToTalkControl's onMouseLeave/onTouchCancel), so it can never reach this state to
    // recover it. Same shape as VOICE-TRANSCRIBE-HANG, one call earlier in the pipeline.
    if (generation === captureGeneration) voiceLocal.dispatch({ type: "error", message: err instanceof Error ? err.message : "microphone capture failed" });
    return;
  }
  if (generation !== captureGeneration) return;

  const engine = getDefaultSttEngine();
  if (!engine?.meta.healthy || !engine.transcribe) {
    voiceLocal.dispatch({ type: "error", message: "Set up local speech in Settings → voice engines" }); return;
  }
  const controller = transcriptionController = new AbortController();
  let transcript: string;
  try {
    transcript = await withTimeout(engine.transcribe(audio, { signal: controller.signal, language: sttLanguage() }), TRANSCRIBE_TIMEOUT_MS, "transcription timed out");
  } catch (err) {
    controller.abort();
    if (generation === captureGeneration) voiceLocal.dispatch({ type: "error", message: err instanceof Error ? err.message : "transcription failed" });
    return;
  } finally { if (transcriptionController === controller) transcriptionController = null; }
  if (generation !== captureGeneration) return;
  if (!transcript.trim()) {
    voiceLocal.dispatch({ type: "error", message: "didn't catch that" });
    return;
  }
  insert(transcript);
  voiceLocal.dispatch({ type: "idle" });
}

/** Abandon an in-progress capture without sending (e.g. escape while holding). */
export function cancelPushToTalk(): void {
  captureGeneration++;
  transcriptionController?.abort(); transcriptionController = null;
  startingCapture = false;
  const capture = activeCapture ?? pendingCapture;
  const wasPending = !activeCapture && !!pendingCapture;
  activeCapture = null; pendingCapture = null;
  if (capture) { capture.cancel?.(); if (!wasPending) void capture.stop().catch(() => {}); }
  const sessionId = voiceLocal.getState().sessionId;
  if (sessionId && !sessionId.startsWith("dictation:")) void rpcCall("voice.session.stop", { sessionId }).catch(() => {});
  voiceLocal.dispatch({ type: "idle" });
}

/**
 * VOICE-STOP: the ONE universal stop for spoken output, shared by the Esc keymap row, the esc
 * close-priority chain and the click on the speaking control — and, with kind:"timeout", by the
 * playback watchdog. Reported bug: once the app started speaking there was nothing at all that
 * stopped it (barge-in needed the mic, and the reducer only left `speaking` on a daemon event).
 *
 * Order matters: bump the generation FIRST so the chunk we are about to cancel can't overwrite
 * the state we set below (cancelling playback rejects the in-flight utterance — see ttsGate).
 * Returns false when nothing was speaking, so Esc falls through to its normal tiers.
 */
export function abortSpeech(kind: "manual" | "timeout" = "manual"): boolean {
  const state = voiceLocal.getState();
  if (state.status !== "speaking") return false;
  cancelSpeechGeneration();
  latchSpeechStopped();
  const handledByConversation = stopActiveConversationSpeaking();
  if (!handledByConversation) {
    getDefaultTtsEngine().stopSpeaking?.();
    // Push-to-talk only, and only if a session is still open: stopPushToTalkAndInsert already
    // dispatched `idle` (clearing sessionId) before the reply's TTS arrived, so this is usually
    // a no-op. NEVER sent in conversation mode — that would tear down the live conversation.
    if (state.sessionId) void rpcCall("voice.session.stop", { sessionId: state.sessionId }).catch(() => {});
  }
  voiceLocal.dispatch(kind === "timeout" ? { type: "speechTimeout" } : { type: "stopSpeaking" });
  return true;
}

/** Alias used by the UI surfaces (keymap action, esc chain, control click). */
export function stopSpeakingNow(): boolean {
  return abortSpeech("manual");
}
