import { describe, it, expect } from "vitest";
import { QuotaTracker } from "@chimera/core/failover";
import type { AccountQuotaWindow } from "@chimera/protocol";

// QUOTA-ABSENCE-IS-INVISIBLE: QuotaTracker keeps reasons in a SEPARATE map from windows,
// precisely so a reason survives for an account that has never recorded a window (the
// "unsupported"/"http_error" case the feature exists to surface). These tests pin that
// invariant plus the reason/window independence in both directions.

// QUOTA-SANITY-GUARD: windowStartedAt/resetsAt must be realistic (post-2020) epoch-ms — a
// near-1970 value like the old `windowStartedAt: 0, resetsAt: 5_000` is now itself rejected as
// implausible (see failover.test.ts's implausibleQuotaWindowReason suite), which would make
// record() below silently no-op instead of exercising what this file actually tests.
const BASE = Date.UTC(2026, 0, 1);
const WINDOW: AccountQuotaWindow = { kind: "session", usedFraction: 0.5, windowStartedAt: BASE - 1000, resetsAt: BASE + 5_000 };

describe("QuotaTracker — quota reasons", () => {
  it("returns undefined for an account with no reason recorded", () => {
    expect(new QuotaTracker(() => 1000).getReason("nobody")).toBeUndefined();
  });

  it("keeps a reason for an account that has NEVER recorded a window", () => {
    const t = new QuotaTracker(() => 1000);
    t.recordReason("codex-1", { kind: "unsupported", at: 1000 });
    expect(t.getReason("codex-1")).toEqual({ kind: "unsupported", at: 1000 });
    expect(t.get("codex-1")).toBeUndefined();
    expect(t.snapshot()).toEqual([]);
  });

  it("the latest reason replaces the previous one for the same account", () => {
    const t = new QuotaTracker(() => 1000);
    t.recordReason("a", { kind: "rate_limited", httpStatus: 429, at: 1000 });
    t.recordReason("a", { kind: "ok", at: 2000 });
    expect(t.getReason("a")).toEqual({ kind: "ok", at: 2000 });
  });

  it("reasons are per-account and never bleed across accounts", () => {
    const t = new QuotaTracker(() => 1000);
    t.recordReason("a", { kind: "http_error", httpStatus: 401, at: 1000 });
    t.recordReason("b", { kind: "network_error", detail: "ECONNRESET", at: 1000 });
    expect(t.getReason("a")).toEqual({ kind: "http_error", httpStatus: 401, at: 1000 });
    expect(t.getReason("b")).toEqual({ kind: "network_error", detail: "ECONNRESET", at: 1000 });
  });

  it("recording a window does not clear a previously recorded reason", () => {
    // QUOTA-SANITY-GUARD: `now` must itself be a realistic epoch-ms clock — the guard's
    // future-bound check compares WINDOW.resetsAt against `now`, so a toy clock like `7_000`
    // (1970) would make a realistic (2026) resetsAt look implausibly far in the future.
    const t = new QuotaTracker(() => BASE + 7_000);
    t.recordReason("a", { kind: "empty", at: 1000 });
    t.record("a", WINDOW);
    expect(t.getReason("a")).toEqual({ kind: "empty", at: 1000 });
    expect(t.get("a")).toEqual({ account: "a", windows: [WINDOW], fetchedAt: BASE + 7_000 });
  });

  it("recording a reason does not disturb already-recorded windows", () => {
    const t = new QuotaTracker(() => BASE + 7_000);
    t.record("a", WINDOW);
    t.recordReason("a", { kind: "rate_limited", httpStatus: 429, at: 9_000 });
    expect(t.get("a")!.windows).toEqual([WINDOW]);
    expect(t.get("a")!.fetchedAt).toBe(BASE + 7_000);   // a failed poll must not look like a fresh one
  });
});
