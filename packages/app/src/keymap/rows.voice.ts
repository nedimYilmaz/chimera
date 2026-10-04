// VOICE R5 (docs/superpowers/specs/2026-07-24-voice-realtime-design.md §6, user decision:
// Option+Space TOGGLE): ⌥Space toggles conversation mode (start if idle, stop if active) — a
// real keymap row through the shared table, never a hardcoded listener. `alt` is `ev.altKey`
// on every platform (unlike `mod`, chordOf never remaps it), so ONE row covers mac/win/linux —
// no wrong-platform-modifier split needed (contrast the design doc's ctrl+space, which needed
// two rows because "mod" resolves differently per platform).
import type { KeymapRow } from "../keymap";

export const VOICE_ROWS: readonly KeymapRow[] = [
  { chord: "alt+space", action: "voice.conversationToggle", scope: "global", label: "voice conversation" },
  // VOICE-STOP: the universal "make it stop talking" key. Gated by the `voiceSpeaking` predicate
  // (registered page-wide by voice/keybind.ts, installed from state/store.ts), so it only shadows the global
  // `esc` row WHILE speech is playing — modals/search keep Esc at every other moment. Declared
  // BEFORE rows.global's esc has no effect on ordering; resolveChord prefers the gated row.
  { chord: "esc", action: "voice.stopSpeaking", scope: "global", label: "stop speaking", when: "voiceSpeaking" },
];
