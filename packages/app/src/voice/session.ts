// VOICE S5+S6 (§5 "Push-to-talk (Phase A)"): the push-to-talk orchestration — hold → capture →
// (release →) transcribe → send via the EXISTING user-message send path (identical to typed
// input, per §5 step 3 — this module never invents a second send pipe). TTS playback on the
// agent's reply is driven separately by voiceEvents.ts off the voice_tts_chunk event stream.
import { rpcCall } from "../rpc/bridge";
import { errorText } from "../state/errorText";
import type { VoiceSessionRecord } from "@chimera/protocol/contract";
import { createAudioCapture, type AudioCapture } from "./audioCapture";
import { getDefaultSttEngine, getDefaultTtsEngine } from "./registry";
import { MOCK_STT_ENGINE_ID } from "./engines/mockSttEngine";
import { isConversationActive, stopActiveConversationSpeaking, VOICE_REALTIME_NOT_CONFIGURED_MESSAGE } from "./realtime/conversation";
import { voiceLocal } from "./store";
import { cancelSpeechGeneration, clearSpeechLatch, latchSpeechStopped } from "./ttsGate";
import { nativeCodexVoice } from "./nativeCodex";

let activeCapture: AudioCapture | null = null;
let captureGeneration = 0;
let startingCapture = false;

// BUG FIX (transcribing-hang): stopPushToTalkAndSend awaited engine.transcribe() with no
// timeout, and cancelPushToTalk's only trigger (onMouseLeave/onTouchCancel) requires
// status === "listening" — a no-op once we're in "transcribing". A stalled/hung STT call
// (network stall, dead adapter) left the control permanently stuck showing "transcribing…"
// with isPushToTalkBusy() blocking every subsequent press. Bound the call so a hang always
// resolves into the existing `error` state instead of wedging the control forever.
const TRANSCRIBE_TIMEOUT_MS = 15_000;

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

/** Hold trigger: mic on, voice.session.start opens the correlation id (§6) TTS chunks reply
 * under. Errors (permission denied, RPC failure) land in the `error` state per §7's mic-denied
 * row — never throws past this function. VOICE R3: a ⌥Space conversation owns the mic while
 * active, so push-to-talk defers to it rather than opening a second, conflicting session. */
export async function startPushToTalk(agentId: string): Promise<void> {
  if (isPushToTalkBusy() || isConversationActive() || ["connecting", "listening"].includes(nativeCodexVoice.getState().status)) return;
  const generation = ++captureGeneration;
  startingCapture = true;
  clearSpeechLatch();   // a stop only silences the reply it interrupted, never the next one
  const capture = createAudioCapture();
  try {
    await capture.start();
  } catch (err) {
    if (generation === captureGeneration) {
      startingCapture = false;
      voiceLocal.dispatch({ type: "error", message: err instanceof Error ? err.message : "microphone unavailable" });
    }
    return;
  }
  if (generation !== captureGeneration) { void capture.stop().catch(() => {}); return; }
  activeCapture = capture;
  let record: VoiceSessionRecord;
  try {
    record = await rpcCall<VoiceSessionRecord>("voice.session.start", { agentId });
  } catch (err) {
    if (generation !== captureGeneration) return;
    activeCapture = null;
    startingCapture = false;
    // BUG FIX (mic-leak-on-session-start-fail): capture.start() already opened a live
    // MediaStream/MediaRecorder; dropping the reference without stopping it left the mic
    // held open (OS mic indicator stuck on) with no way to release it short of an app restart.
    void capture.stop().catch(() => {});
    voiceLocal.dispatch({ type: "error", message: errorText(err) || "voice session failed to start" });
    return;
  }
  if (generation !== captureGeneration) {
    void rpcCall("voice.session.stop", { sessionId: record.sessionId }).catch(() => {});
    return;
  }
  startingCapture = false;
  voiceLocal.dispatch({ type: "sessionStarted", sessionId: record.sessionId, agentId });
}

/** Release trigger (§5 steps 2-3): stop capture, transcribe, and hand the transcript to the
 * caller's existing send path. `send` is Composer's commands.sendComposed — voice text is never
 * a distinct pipe from typed input. Empty/failed transcript → no send, `error` state (§7). */
export async function stopPushToTalkAndSend(send: (text: string) => void): Promise<void> {
  const state = voiceLocal.getState();
  const capture = activeCapture;
  if (state.status !== "listening" || !capture || !state.sessionId) return;
  const generation = captureGeneration;
  activeCapture = null;
  voiceLocal.dispatch({ type: "transcribing" });
  void rpcCall("voice.session.stop", { sessionId: state.sessionId }).catch(() => {});
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
  if (!engine.meta.healthy || !engine.transcribe) {
    // UX FIX: the mock STT engine's dev/test label ("Mock transcript (dev/test)") must never
    // leak into a real (non-mock) build — that's an internal test-seam name, not something a
    // real user's "no OpenAI voice account yet" error should show. Any OTHER unhealthy engine
    // (a future real STT adapter reporting its own failure) still surfaces its own label.
    const message = engine.meta.id === MOCK_STT_ENGINE_ID
      ? VOICE_REALTIME_NOT_CONFIGURED_MESSAGE
      : `${engine.meta.label} is unavailable — falling back to text input`;
    voiceLocal.dispatch({ type: "error", message });
    return;
  }
  let transcript: string;
  try {
    transcript = await withTimeout(engine.transcribe(audio), TRANSCRIBE_TIMEOUT_MS, "transcription timed out");
  } catch (err) {
    if (generation === captureGeneration) voiceLocal.dispatch({ type: "error", message: err instanceof Error ? err.message : "transcription failed" });
    return;
  }
  if (generation !== captureGeneration) return;
  if (!transcript.trim()) {
    voiceLocal.dispatch({ type: "error", message: "didn't catch that" });
    return;
  }
  send(transcript);
  voiceLocal.dispatch({ type: "idle" });
}

/** Abandon an in-progress capture without sending (e.g. escape while holding). */
export function cancelPushToTalk(): void {
  captureGeneration++;
  startingCapture = false;
  const capture = activeCapture;
  activeCapture = null;
  if (capture) void capture.stop().catch(() => {});
  const sessionId = voiceLocal.getState().sessionId;
  if (sessionId) void rpcCall("voice.session.stop", { sessionId }).catch(() => {});
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
    // Push-to-talk only, and only if a session is still open: stopPushToTalkAndSend already
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
