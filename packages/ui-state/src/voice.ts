// VOICE S5+S6 (docs/superpowers/specs/2026-07-24-voice-agents-design.md §5/§9): the app's
// push-to-talk UI state machine — UI-framework-free (this package's hard rule) so it's plain-
// object testable without React or a live daemon. Mirrors the landed VoiceSessionState enum
// (protocol/contract.ts) plus the local-only phases (partial transcript text, last TTS chunk,
// an error message) the app layer needs that the wire contract doesn't carry.
import type { VoiceSessionState } from "@chimera/protocol/contract";

export type VoiceUiState = {
  status: VoiceSessionState;      // idle | listening | transcribing | speaking | error
  sessionId: string | null;
  agentId: string | null;
  partialTranscript: string;
  lastTtsText: string | null;     // most recent TTS chunk text played — indicator detail + test seam
  errorMessage: string | null;
  // VOICE R3 (§5 "Turn state"): continuous ⌥Space conversation mode vs. one-shot push-to-talk —
  // same status enum, this flag just tells the loop (and the UI) it should return to `listening`
  // instead of resetting to `idle` once a turn's TTS finishes or barge-in cancels it.
  conversationActive: boolean;
};

export const initialVoiceState: VoiceUiState = {
  status: "idle",
  sessionId: null,
  agentId: null,
  partialTranscript: "",
  lastTtsText: null,
  errorMessage: null,
  conversationActive: false,
};

export type VoiceAction =
  | { type: "sessionStarted"; sessionId: string; agentId: string }
  | { type: "transcribing" }
  | { type: "partialTranscript"; text: string }
  | { type: "speaking"; text: string }
  | { type: "sessionState"; state: VoiceSessionState }
  | { type: "idle" }
  | { type: "error"; message: string }
  // VOICE R3: conversation mode's own lifecycle — kept distinct from
  // sessionStarted/idle (push-to-talk) so a conversation turn's end returns to
  // `listening` (conversationListening) rather than resetting the session.
  | { type: "conversationStarted"; sessionId: string; agentId: string }
  | { type: "conversationListening" }
  | { type: "conversationEnded" }
  // VOICE-STOP: the ONE way out of `speaking` that isn't the daemon's own event — a manual stop
  // (Esc / the speaking control) and the playback watchdog. Both are no-ops unless we are
  // actually speaking, so a stray Esc can never reset a listening/transcribing turn; both return
  // to `listening` (keeping conversationActive) in conversation mode and to `idle` otherwise,
  // because an `idle` status with conversationActive:true would be an unrepresentable state.
  | { type: "stopSpeaking" }
  | { type: "speechTimeout" };

/** VOICE-STOP: what the operator is shown when playback never reported an end (§7's error table
 * has no row for it — the daemon can emit `speaking` and then nothing at all). Kept here so the
 * reducer, the app watchdog and the tests all name it once. */
export const SPEECH_TIMEOUT_MESSAGE = "speech playback timed out";

/** The state `speaking` falls back to, shared by the manual stop and the watchdog. */
function afterSpeaking(state: VoiceUiState, errorMessage: string | null): VoiceUiState {
  if (state.conversationActive) {
    return { ...state, status: "listening", partialTranscript: "", lastTtsText: null, errorMessage };
  }
  return { ...initialVoiceState, errorMessage };
}

/** Pure — every transition the push-to-talk flow (§5) and the error table (§7) drive, folded
 * into one reducer so both the local orchestration (session.ts) and remote voice_session_state
 * events (voiceEvents.ts) update the SAME state shape through the SAME rules. */
export function voiceReducer(state: VoiceUiState, action: VoiceAction): VoiceUiState {
  switch (action.type) {
    case "sessionStarted":
      return { ...initialVoiceState, status: "listening", sessionId: action.sessionId, agentId: action.agentId };
    case "transcribing":
      return { ...state, status: "transcribing" };
    case "partialTranscript":
      return { ...state, partialTranscript: action.text };
    case "speaking":
      return { ...state, status: "speaking", lastTtsText: action.text };
    case "sessionState":
      return { ...state, status: action.state };
    case "idle":
      return { ...initialVoiceState };
    case "error":
      return { ...state, status: "error", errorMessage: action.message };
    case "conversationStarted":
      return { ...initialVoiceState, status: "listening", sessionId: action.sessionId, agentId: action.agentId, conversationActive: true };
    case "conversationListening":
      return { ...state, status: "listening", partialTranscript: "", lastTtsText: null, errorMessage: null };
    case "conversationEnded":
      return { ...initialVoiceState };
    case "stopSpeaking":
      return state.status === "speaking" ? afterSpeaking(state, null) : state;
    case "speechTimeout":
      // The message survives the fallback (afterSpeaking's only caller that passes one) so the
      // control can say WHY it went quiet — conversationListening deliberately clears it, which
      // is why the watchdog can't just reuse that action.
      return state.status === "speaking" ? afterSpeaking(state, SPEECH_TIMEOUT_MESSAGE) : state;
    default:
      return state;
  }
}
