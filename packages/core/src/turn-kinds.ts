// F09/J4: the ONE definition of "a turn is open for this agent", shared by HealthMonitor's wedge
// detector (health.ts) and the prompt-ack watch (prompt-ack.ts). Extracted from health.ts with
// membership UNCHANGED — two copies of this set would drift, and they answer the same question,
// so "verified a prompt started a turn" and "this agent is mid-turn" can never disagree.
// Zero-dependency (type-only protocol import) so either consumer can take it without a cycle.
import type { EventKind } from "@chimera/protocol";

// Events that mean a turn is actively in flight (the agent is producing output or blocked
// awaiting a tool/permission/dialog it opened this turn). Any of these flips an idle-capable
// agent's `midTurn` true, making it wedge-eligible. Deliberately EXCLUDES `usage`: unlike
// otel.ts's turn-span set, a usage snapshot is passive telemetry (LIVE_CTX_USAGE backpressure)
// that also arrives as trailing between-turn noise after a turn ends (LIVENESS-IDLE-CONDUCTOR
// lists it as one of the events that defeated the old exemption), so it must NOT open a turn —
// it is treated as neutral by both consumers. Excluding usage loses no wedge coverage in
// practice: a wedge mid-stream is always preceded by a real forward-progress event
// (message/tool) that already opened the turn. ACCEPTED TRADEOFF: a hang on the FIRST token of a
// freshly-triggered turn (e.g. after a mailbox delivery, before any forward-progress event)
// leaves midTurn false, so health.ts's coarse 15-min probe won't flag it — but the backend's own
// per-turn watchdog (TurnController, armed at turn start → turn_timeout → onError) is the
// precise mechanism for exactly that hang, and F09's prompt-ack watch is the mechanism for the
// delivery half. Erring toward exemption here is deliberate: the old last-event heuristic
// "caught" the first-token case only by also killing a conductor legitimately slow on its first
// token — the LIVENESS-IDLE-CONDUCTOR false positive this set exists to remove.
export const TURN_OPENING_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "message_delta", "message_complete", "tool_call", "tool_result",
  "permission_request", "agent_question", "agent_dialog", "agent_task",
]);

// A provider can accept a turn long before its first token (e.g. native compaction).
// Only its explicit start marker counts; delivery/status/session-init alone do not.
export function isTurnOpening(kind: EventKind, data?: Record<string, unknown>): boolean {
  return TURN_OPENING_KINDS.has(kind) || (kind === "status" && data?.["turnStarted"] === true);
}

// Events that mean no turn is open (a turn just ended, or a fresh session just started with no
// turn yet) — clears `midTurn`. `agent_started` is the session-init signal; `turn_complete`/
// `result`/`error` close a turn. `status` markers are handled specially by health.ts's fold.
export const TURN_CLOSING_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "turn_complete", "result", "error", "agent_started",
]);
