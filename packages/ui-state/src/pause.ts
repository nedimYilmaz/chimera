import type { PauseReason } from "./types.js";

// PAUSED-AGENTS-VISIBLE: the ONE human-readable label per PauseReason, shared by the app
// (selectors.ts) and the TUI (AgentList.tsx) so the two front ends can never drift into
// describing the same daemon-side hold mechanism with different words.
const PAUSE_REASON_LABEL: Record<PauseReason, string> = {
  "session-limit": "session limit",
  "crash-loop-backoff": "crash loop",
  "reattach-recovery": "reattach recovery",
  // LAZY-REATTACH: deliberately NOT phrased as a fault — this is the normal resting state of
  // every prior agent after a daemon restart, and the label is what the operator reads before
  // deciding to bring it back.
  "daemon-restart": "daemon restarted",
  // IDLE-REAP: same "not a fault" phrasing as daemon-restart — the agent is intact, its
  // process was simply reclaimed after sitting idle between turns.
  "idle-timeout": "idle — process released",
  // OPERATOR-HOLD: the only hold a PERSON caused, so it is the only one where the answer to
  // "why is this stopped?" is "because you stopped it" — and the only one that will not clear on
  // its own. It keeps its text (never glyph-only): a held agent looks exactly like a reaped one
  // at a glance, and confusing the two means either waiting forever for a hold to lift itself or
  // hunting a fault that never happened.
  "operator-hold": "held by you — release to resume",
};

export function pauseReasonLabel(reason: PauseReason | undefined): string {
  return reason ? PAUSE_REASON_LABEL[reason] : "unknown reason";
}
