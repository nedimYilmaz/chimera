// VOICE-STOP (uiux polish): the two daemon/module-side voice events that were INVISIBLE to the
// operator, routed onto the app's one notice channel. `notify` is injected (never imported from
// state/store) because store.ts installs these at bootstrap — importing it back would close a
// cycle, and injection is what makes both testable without a store.
import { TOASTS } from "../copy";
import { abortSpeech, stopSpeakingNow } from "./session";
import { onSpeakRepliesChange } from "./ttsGate";

export type Notify = (message: string) => void;

/**
 * BUG (mute-does-not-stop): enqueueSynthesis reads the speak-replies pref only when a chunk is
 * ENQUEUED, so flipping the Settings switch off mid-reply left the current reply talking to the
 * end — exactly the "I can't turn speaking off" complaint the feature was meant to fix. Stopping
 * via stopSpeakingNow() (not just bumping the generation) also latches, so the rest of the turn
 * drops and the state leaves `speaking` immediately instead of hanging there until the watchdog.
 */
export function installMuteStopsSpeech(notify: Notify): () => void {
  return onSpeakRepliesChange((enabled) => {
    if (enabled) { notify(TOASTS.voiceRepliesUnmuted); return; }
    notify(stopSpeakingNow() ? TOASTS.voiceRepliesMutedStopped : TOASTS.voiceRepliesMuted);
  });
}

/** The watchdog's fallback said WHY only through a sticky errorMessage on a non-error state,
 * which then outlived the event on the idle control. A toast is the honest shape: it explains
 * the moment it happens and then gets out of the way. */
export function speechTimeoutNotifier(notify: Notify): () => void {
  return () => {
    if (abortSpeech("timeout")) notify(TOASTS.voiceSpeechTimedOut);
  };
}
