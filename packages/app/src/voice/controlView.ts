// VOICE-STOP (uiux polish): the push-to-talk control's ENTIRE presentation, as a pure function of
// the voice state — glyph, label, tooltip, tone and whether the press is a stop or a hold. Kept
// out of the component because it is the part with real rules (a stop looks nothing like a hold; a
// stale errorMessage must not replace an actionable hint) and this package's tests run in a node
// env, so a plain-object view is the only way to assert copy without rendering.
import type { VoiceSessionState } from "@chimera/protocol/contract";

export type VoiceTone = "idle" | "listening" | "transcribing" | "speaking" | "error";

export type VoiceControlInput = {
  status: VoiceSessionState;
  errorMessage: string | null;
  conversationActive: boolean;
  connected: boolean;
  agentId: string | null;
  /** The persisted "Speak agent replies" switch — off means the reply arrives silently. */
  speakReplies: boolean;
};

export type VoiceControlView = {
  tone: VoiceTone;
  glyph: string;
  label: string;
  title: string;
  /** Pressing the control stops playback instead of starting a capture. */
  stopMode: boolean;
  disabled: boolean;
  /** Rendered as a dimmed pill + a `data-voice-muted` hook, so "no reply was spoken" is never a
   * silent mystery the operator has to open Settings to explain. */
  muted: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  idle: "hold to talk",
  listening: "listening… release to draft",
  transcribing: "transcribing…",
  error: "mic",
};

// VOICE R3: ⌥Space conversation mode reuses this SAME control/status enum (§5 "voice_session_state
// UI") — only the labels differ, since there's no hold/release, just continuous listening until
// the chord toggles it off again.
const CONVERSATION_LABEL: Record<string, string> = {
  idle: "conversation mode",
  listening: "listening… (⌥Space to stop)",
  transcribing: "transcribing…",
  error: "mic",
};

/** VOICE-STOP: a stop button must LOOK like a stop — `♪` reads as "audio is playing", which is
 * exactly the state the operator wants to leave, not an affordance. */
const STOP_GLYPH = "■";
const STATUS_GLYPH: Record<string, string> = { idle: "◉", listening: "●", transcribing: "◐", speaking: STOP_GLYPH, error: "⚠" };

const HOLD_TITLE = "hold to talk, release to draft · ⌥space for conversation mode";

export function voiceControlView(input: VoiceControlInput): VoiceControlView {
  const stopMode = input.status === "speaking";
  // While speaking, this button IS the stop — so it stays clickable even with no agent selected
  // (push-to-talk clears agentId before the reply is spoken).
  const disabled = !stopMode && (!input.connected || !input.agentId);
  const muted = !input.speakReplies;
  const tone: VoiceTone = (["listening", "transcribing", "speaking", "error"] as const).find((t) => t === input.status) ?? "idle";

  if (stopMode) {
    return { tone, glyph: STOP_GLYPH, label: "speaking… (Esc or click to stop)", title: "stop speaking (Esc)", stopMode, disabled, muted };
  }
  const glyph = STATUS_GLYPH[input.status] ?? "◉";
  if (input.status === "error") {
    // Only an ACTUAL error state shows errorMessage. The watchdog's fallback lands on idle/
    // listening carrying `speech playback timed out`; showing that as the idle label would replace
    // "hold to talk" with a stale postmortem until the next session — the toast carries the reason
    // instead (see voice/notices.ts).
    return { tone, glyph, label: input.errorMessage ?? "mic", title: input.errorMessage ?? "voice error", stopMode, disabled, muted };
  }
  const labels = input.conversationActive ? CONVERSATION_LABEL : STATUS_LABEL;
  const base = labels[input.status] ?? labels["idle"]!;
  const label = muted && input.status === "idle" ? `${base} · replies muted` : base;
  const title = disabled
    ? "select an agent to use push-to-talk"
    : muted ? `${HOLD_TITLE} · spoken replies are muted (Settings → voice engines)` : HOLD_TITLE;
  return { tone, glyph, label, title, stopMode, disabled, muted };
}
