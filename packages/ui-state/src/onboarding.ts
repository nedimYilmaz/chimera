import type { UiState } from "./types.js";

// FEATURE ONBOARDING-GATE (R2): the app must not let the user into any other
// screen until at least one provider account is configured. `connected` gates
// the check on CONFIRMED zero accounts — a disconnected/reconnecting client's
// `accounts` array is just stale/empty-by-default, not evidence the daemon
// itself has none, so it must never trip the gate.
export function isOnboardingGated(state: Pick<UiState, "connected" | "accounts">): boolean {
  return state.connected && state.accounts.length === 0;
}
