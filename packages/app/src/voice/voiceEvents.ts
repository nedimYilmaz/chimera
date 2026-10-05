// VOICE S5+S6 (§5 steps 4-5, §6): the daemon event consumer for the two remote-driven voice_*
// kinds — voice_tts_chunk (queued through the default TTS engine, sentence by sentence) and
// voice_session_state (folded straight into the local state machine). No emitter for these lands
// until S4 (backend TTS-tap seam); this bridge is written against the LANDED event contract
// (protocol EventKindSchema) so it needs no change once S4 ships.
import { onDaemonEvent } from "../rpc/bridge";
import type { NormalizedEvent } from "@chimera/protocol";
import type { VoiceSessionState } from "@chimera/protocol/contract";
import { getDefaultTtsEngine } from "./registry";
import { activeConversationFor } from "./realtime/conversation";
import { voiceLocal } from "./store";
import { clearSpeechLatch, isCurrentSpeech, isSpeakRepliesEnabled, isSpeechLatched, speechGeneration } from "./ttsGate";

const SESSION_STATES: readonly VoiceSessionState[] = ["idle", "listening", "transcribing", "speaking", "error"];

// Chains synthesize() calls so overlapping voice_tts_chunk events never race the TTS engine —
// each chunk plays after the previous one finishes, in arrival order.
let ttsQueue: Promise<void> = Promise.resolve();

// VOICE R3 (§4/§8): the SAME voice_tts_chunk tap, TWO consumers — push-to-talk plays a chunk
// through the plain SpeechEngine (unchanged); an active ⌥Space conversation plays it through its
// RealtimeSession instead, so stopSpeaking() (barge-in) can actually cancel it, and a final chunk
// returns to `listening` rather than resetting the whole session to `idle`.
function enqueueSynthesis(text: string, final: boolean, agentId: string): void {
  // VOICE-STOP: captured HERE, synchronously at enqueue time — a stop that lands while this chunk
  // is queued or playing bumps the generation, and every dispatch below is gated on still being
  // the current one. Without that, cancelling playback would immediately re-dispatch `error` (the
  // cancelled utterance rejects) or "back to listening", undoing the stop the operator asked for.
  const token = speechGeneration();
  // VOICE-STOP: a stop latches, so the REST of this streamed reply stays silent (the token alone
  // only kills chunks already queued). The final chunk still ends the turn and releases the latch.
  if (isSpeechLatched()) {
    if (final) {
      clearSpeechLatch();
      voiceLocal.dispatch(activeConversationFor(agentId) ? { type: "conversationListening" } : { type: "idle" });
    }
    return;
  }
  // "Speak agent replies" off: no TTS at all, and crucially we never enter `speaking`. The turn
  // must still be COMPLETED on the final chunk or conversation mode would sit in `transcribing`
  // forever with the mic effectively dead.
  if (!isSpeakRepliesEnabled()) {
    if (final) voiceLocal.dispatch(activeConversationFor(agentId) ? { type: "conversationListening" } : { type: "idle" });
    return;
  }
  ttsQueue = ttsQueue.then(async () => {
    if (!isCurrentSpeech(token)) return;
    voiceLocal.dispatch({ type: "speaking", text });
    const conversationSession = activeConversationFor(agentId);
    try {
      if (conversationSession) await conversationSession.playTts(text);
      else await getDefaultTtsEngine().synthesize?.(text);
    } catch (err) {
      if (!isCurrentSpeech(token)) return;   // the "error" was our own cancellation
      voiceLocal.dispatch({ type: "error", message: err instanceof Error ? err.message : "speech synthesis failed" });
      return;
    }
    // §5 step 5: message_complete/turn_complete flushes the final chunk and ends playback.
    if (!final || !isCurrentSpeech(token)) return;
    voiceLocal.dispatch(conversationSession ? { type: "conversationListening" } : { type: "idle" });
  });
}

function handleVoiceEvent(event: NormalizedEvent): void {
  // A local hold owns the draft and status; unrelated agent speech must not
  // take the mic control out of recording/transcribing or change its text.
  const local = voiceLocal.getState();
  if (local.sessionId?.startsWith("dictation:") && (local.status === "listening" || local.status === "transcribing")) return;
  const data = event.data;
  switch (event.kind) {
    case "voice_partial_transcript": {
      // The operator is talking again: whatever we stopped is over, so the next reply speaks.
      clearSpeechLatch();
      const text = typeof data["text"] === "string" ? data["text"] : "";
      voiceLocal.dispatch({ type: "partialTranscript", text });
      return;
    }
    case "voice_tts_chunk": {
      const text = typeof data["text"] === "string" ? data["text"] : "";
      if (text) enqueueSynthesis(text, data["final"] === true, event.agentId);
      return;
    }
    case "voice_session_state": {
      const state = data["state"];
      if (typeof state === "string" && (SESSION_STATES as readonly string[]).includes(state)) {
        voiceLocal.dispatch({ type: "sessionState", state: state as VoiceSessionState });
      }
      return;
    }
    default:
      return;
  }
}

let installed = false;

/** Installed once for the lifetime of the page (store.ts's bootstrap), same convention as
 * installHistoryBackfill — idempotent so a hot-reload/re-import never double-registers. */
export function installVoiceEventBridge(): () => void {
  if (installed) return () => {};
  installed = true;
  return onDaemonEvent(handleVoiceEvent);
}
