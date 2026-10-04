import type { AgentView, FailureCause, FailureView, UiState } from "./types.js";
import { filterOrderKeeping } from "./seen.js";

// F08.UI: the WHOLE operator vocabulary for a classified death lives here — row badge, tooltip/
// footer detail, the transcript line written the moment the disposition is decided, and the
// recovery line. Same one-place-per-event contract as promptStall.ts: app and TUI must never be
// able to describe the same daemon failure with different words.

const FAILURE_CAUSE_LABEL: Record<FailureCause, string> = {
  "account-cap": "account capped",
  "provider-rate-limit": "provider throttled",
  "provider-capacity": "model busy",
  "provider-stream": "provider stream interrupted",
  "transient-network": "connection lost",
  "bad-request": "rejected — retrying won't help",
  "credential": "credential rejected",
  "output-truncated": "response cut off — retrying",
  "context-overflow": "context transport overflow — starting fresh",
  "unclassified": "unclassified failure",
};

// What the operator should DO, per cause. Deliberately imperative and free of provider jargon:
// the cause label says WHAT happened, this says WHOSE move it is next.
const FAILURE_CAUSE_ACTION: Record<FailureCause, string> = {
  "account-cap": "this account is capped until its window resets — switch account or wait it out",
  "provider-rate-limit": "the provider is throttling — retry once it clears",
  "provider-capacity": "the model is busy — retry after capacity becomes available",
  "provider-stream": "the provider stream failed — resume the saved conversation and check completed work",
  "transient-network": "the connection dropped and in-place restarts are spent — respawn the agent",
  "bad-request": "the request itself was refused — fix the prompt/tools, a retry cannot help",
  "credential": "the credentials were refused — re-authenticate this account",
  "output-truncated": "the model's response was cut off — the engine will retry automatically",
  "context-overflow": "the provider context overflowed — the engine will recover with a fresh native session",
  "unclassified": "no classifier rule matched this death — read the error line above",
};

// F08.QA: a newer daemon can ship a cause this build has never heard of. Both front ends style
// such a value differently (muted/dim, not warn-toned) instead of silently passing raw wire text
// off as a curated label — the operator can tell "my UI is older than my daemon" from "capped".
export function isKnownFailureCause(cause: string | undefined): boolean {
  return !!cause && Object.hasOwn(FAILURE_CAUSE_LABEL, cause);
}

export function failureCauseLabel(cause: FailureCause | undefined): string {
  if (!cause) return "unknown cause";
  return FAILURE_CAUSE_LABEL[cause] ?? cause;   // F08.QA: raw wire value, NOT "unclassified failure"
}

// Fallback ONLY for a disposition that predates the booleans riding the wire (older daemon):
// mirrors core/src/failover.ts's DISPOSITION table for the six causes this build knows.
const NEEDS_OPERATOR_BY_CAUSE: Record<FailureCause, boolean> = {
  "account-cap": false,        // failoverAccount + holdForReset — the engine has a move left
  "provider-rate-limit": false, // retryable + failoverAccount
  "provider-capacity": false,
  "provider-stream": false,
  "transient-network": false,  // restartInPlace
  "bad-request": true,
  "credential": true,
  "output-truncated": false, // retryable — the engine retries automatically, no operator move needed
  "context-overflow": false,
  "unclassified": true,
};

// "Needs operator" = the engine has NO automatic remedy for this death: every disposition
// boolean is false. Protocol is explicit that the four booleans are the whole decision surface,
// so branch on them and never on the cause string — that is also what lets an UNKNOWN cause from
// a newer daemon still land in the right filter bucket.
export function failureNeedsOperator(failure: FailureView | undefined): boolean {
  if (!failure) return false;
  if (
    failure.retryable !== undefined ||
    failure.failoverAccount !== undefined ||
    failure.holdForReset !== undefined ||
    failure.restartInPlace !== undefined
  ) {
    return !failure.retryable && !failure.failoverAccount && !failure.holdForReset && !failure.restartInPlace;
  }
  return NEEDS_OPERATOR_BY_CAUSE[failure.cause] ?? true;   // unknown cause: surface it rather than hide it
}

// Trailing row badge, same slot/tone as the ⏸ pause badge and the F09 stall badge. The suffix is
// the only thing that distinguishes "you must act" from "the engine already tried everything it
// had" — both are terminal rows, and an operator triaging a red fleet needs that split at a
// glance without opening anything.
export function failureBadge(failure: FailureView | undefined): string {
  if (!failure) return "";
  const tail = failureNeedsOperator(failure) ? "needs you" : "retries spent";
  return `⚠ ${failureCauseLabel(failure.cause)} · ${tail}`;
}

// Long form for the app's title/aria-label and the TUI footer. `evidence` is a RULE NAME (A20 —
// never provider text), so it is labelled "rule:" and never presented as quoted output.
export function failureDetail(failure: FailureView | undefined): string {
  if (!failure) return "";
  const action = isKnownFailureCause(failure.cause)
    ? FAILURE_CAUSE_ACTION[failure.cause]
    : "this daemon reported a failure cause this build does not know — check the daemon/app versions";
  const rule = failure.evidence ? ` (rule: ${failure.evidence})` : "";
  return `${failureCauseLabel(failure.cause)} — ${action}${rule}`;
}

// Written into the transcript at the moment the disposition is decided, so the reason a run died
// is legible where an operator already reads a run's story — not only on a row badge that a
// restart wipes.
export function failureLine(failure: FailureView): string {
  return `⚠ failed — ${failureDetail(failure)}`;
}

// F08.QA (history gap): the badge is correctly transient, so once an agent recovers there was
// previously NO trace left of what it recovered from. This line is that trace.
export function failureRecoveredLine(prior: FailureView): string {
  const rule = prior.evidence ? ` (rule: ${prior.evidence})` : "";
  return `✓ running again after "${failureCauseLabel(prior.cause)}"${rule}`;
}

// F08.UI: the needs-operator fleet count — fold- and query-insensitive, matching unseenAgentIds'
// contract exactly (folding a team hides rows, it does not fix anything).
export function needsOperatorAgentIds(state: Pick<UiState, "agents" | "agentOrder">): string[] {
  return state.agentOrder.filter((id) => failureNeedsOperator(state.agents[id]?.failure));
}

// The needs-operator view's row filter, ancestor-preserving exactly like filterOrderForUnseen —
// a dead worker three levels down is precisely what this filter exists to surface.
export function filterOrderForNeedsOperator(
  state: Pick<UiState, "agents">,
  order: readonly string[],
): string[] {
  return filterOrderKeeping(state, order, (a: AgentView | undefined) => failureNeedsOperator(a?.failure));
}
