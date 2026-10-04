import { describe, it, expect } from "vitest";
import { isOnboardingGated } from "@chimera/ui-state";

// FEATURE ONBOARDING-GATE (R2): the shared predicate both UIs lock their tab
// bar/keyboard/palette navigation on. Must gate ONLY on CONFIRMED zero
// accounts — a disconnected/reconnecting client's empty `accounts` array is
// just unloaded state, not evidence the daemon itself has none.
describe("isOnboardingGated", () => {
  it("gates when connected and accounts is confirmed empty", () => {
    expect(isOnboardingGated({ connected: true, accounts: [] })).toBe(true);
  });

  it("does not gate once at least one account exists", () => {
    expect(isOnboardingGated({ connected: true, accounts: [{ name: "a", provider: "claude" } as never] })).toBe(false);
  });

  it("does not gate while disconnected, even with an empty accounts array", () => {
    expect(isOnboardingGated({ connected: false, accounts: [] })).toBe(false);
  });
});
