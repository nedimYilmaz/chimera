import { describe, it, expect } from "vitest";
import { QuotaTracker } from "@chimera/core/failover";
import { normalizeClaudeOverage, normalizeClaudeRateLimit } from "@chimera/core/backends/claude";

// EXTRA-USAGE-VISIBILITY — the second allowance. The event path used to drop it entirely, so
// chimera held an agent until reset while unable to say whether that hold was necessary, and the
// operator had no view of the allowance the provider's own UI shows them.
//
// Note what these tests do NOT assert: that chimera skips a hold when overage is available.
// Whether a rejected primary window plus an allowed overage means a retry would succeed is
// provider behaviour nobody has observed here, and encoding a guess about it is the mistake
// QUOTA-METER-WRONG-BY-100X already cost this file once.

describe("normalizeClaudeOverage", () => {
  it("reads status, reason, in-use and reset from a live event", () => {
    expect(normalizeClaudeOverage({
      status: "rejected", rateLimitType: "five_hour", resetsAt: 1_800_000_000, utilization: 1,
      overageStatus: "allowed", overageResetsAt: 1_800_003_600, isUsingOverage: true,
    })).toEqual({ status: "allowed", disabledReason: null, inUse: true, resetsAt: 1_800_003_600_000 });
  });

  it("uses the SAME epoch-seconds convention resetsAt does on this transport", () => {
    // Getting this wrong on the primary window put a meter in 1970 and understated usage 100x
    // (QUOTA-METER-WRONG-BY-100X). The overage reset rides the same event, so it rides the same
    // convention — a 1000x error here would show a reset decades away and never expire.
    const out = normalizeClaudeOverage({ overageResetsAt: 1_800_000_000 })!;
    expect(out.resetsAt).toBe(1_800_000_000_000);
    expect(new Date(out.resetsAt!).getUTCFullYear()).toBeGreaterThan(2020);
  });

  it("returns null when the event says nothing about overage — absent is UNKNOWN, not disabled", () => {
    // API key, Bedrock, Vertex and plans without extra usage all land here. Reporting them as
    // "overage: rejected" would be a confident claim about something the provider never said.
    expect(normalizeClaudeOverage({ rateLimitType: "five_hour", resetsAt: 1, utilization: 0.5 })).toBeNull();
    expect(normalizeClaudeOverage(undefined)).toBeNull();
  });

  it("carries the disabled reason, because 'out of credits' and 'org disabled' need different fixes", () => {
    expect(normalizeClaudeOverage({ overageStatus: "rejected", overageDisabledReason: "out_of_credits" }))
      .toMatchObject({ status: "rejected", disabledReason: "out_of_credits" });
    expect(normalizeClaudeOverage({ overageStatus: "rejected", overageDisabledReason: "org_level_disabled" }))
      .toMatchObject({ disabledReason: "org_level_disabled" });
  });

  it("accepts either spelling of the in-use flag", () => {
    // The SDK carries the same fact under two names; reading only one would report "unknown"
    // against a provider that told us plainly.
    expect(normalizeClaudeOverage({ isUsingOverage: true })?.inUse).toBe(true);
    expect(normalizeClaudeOverage({ overageInUse: true })?.inUse).toBe(true);
  });

  it("ignores an unrecognized status rather than passing it through", () => {
    expect(normalizeClaudeOverage({ overageStatus: "maybe", isUsingOverage: false }))
      .toMatchObject({ status: null, inUse: false });
  });

  it("leaves the WINDOW normalizer's behaviour untouched — 'overage' is still not a window", () => {
    // It is a spend budget, not a rolling window; forcing it into the two-window model is what
    // this whole split exists to avoid.
    expect(normalizeClaudeRateLimit({ rateLimitType: "overage", resetsAt: 1, utilization: 0.5 })).toBeNull();
  });
});

describe("QuotaTracker overage", () => {
  it("is readable for an account with NO usable window — the case where overage is the whole story", () => {
    const t = new QuotaTracker(() => 5_000);
    t.recordOverage("acct", { status: "allowed", inUse: true });
    const q = t.get("acct");
    expect(q?.windows).toEqual([]);
    expect(q?.overage).toMatchObject({ status: "allowed", inUse: true, observedAt: 5_000 });
  });

  it("merges partial observations instead of blanking what the other transport established", () => {
    // The push event knows status; the usage poll knows the credit budget. Neither sees the whole
    // picture, so a later partial observation must not erase an earlier one.
    const t = new QuotaTracker(() => 1_000);
    t.recordOverage("acct", { status: "allowed_warning", disabledReason: null });
    t.recordOverage("acct", { monthlyLimit: 50, usedCredits: 40, usedFraction: 0.8, currency: "USD" });
    expect(t.getOverage("acct")).toMatchObject({
      status: "allowed_warning", monthlyLimit: 50, usedCredits: 40, usedFraction: 0.8, currency: "USD",
    });
  });

  it("appears in the snapshot even with no windows recorded", () => {
    const t = new QuotaTracker(() => 1_000);
    t.recordOverage("only-overage", { status: "rejected", disabledReason: "out_of_credits" });
    expect(t.snapshot().map((q) => q.account)).toContain("only-overage");
  });

  it("reports nothing at all for an account nobody has observed", () => {
    const t = new QuotaTracker(() => 1_000);
    expect(t.get("unknown")).toBeUndefined();
    expect(t.getOverage("unknown")).toBeUndefined();
  });
});
