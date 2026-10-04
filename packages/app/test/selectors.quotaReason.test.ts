// QUOTA-ABSENCE-IS-INVISIBLE — direct unit coverage of quotaReasonLabel, the caption that
// explains WHY an account's quota block is empty. Table-driven over every kind of the closed
// AccountQuotaReason enum (the component tests only exercise `unsupported` and `rate_limited`
// indirectly). Pure/DOM-free; timestamps are formatted with the local-clock fmtClock, so the
// expectations derive the time part from fmtClock rather than hard-coding a timezone.
import { describe, expect, it } from "vitest";
import type { AccountQuotaReason } from "@chimera/protocol";
import { fmtClock, quotaReasonLabel } from "../src/state/selectors";

const AT = Date.parse("2026-07-25T04:05:06Z");
const clock = fmtClock(AT);

describe("quotaReasonLabel", () => {
  it("returns null when no reason has been recorded (account never polled)", () => {
    expect(quotaReasonLabel(undefined)).toBeNull();
  });

  it("returns null for 'ok' — the real bars are rendered instead of a caption", () => {
    expect(quotaReasonLabel({ kind: "ok", at: AT })).toBeNull();
  });

  it("explains an unsupported auth type without a 'last tried' time (no attempt was made)", () => {
    expect(quotaReasonLabel({ kind: "unsupported", at: AT })).toBe("no quota source for this auth type");
  });

  it("names the 429 explicitly for a rate-limited poll", () => {
    expect(quotaReasonLabel({ kind: "rate_limited", httpStatus: 429, at: AT }))
      .toBe(`quota poll rate-limited (429) · last tried ${clock}`);
  });

  it("carries the real HTTP status for an http_error", () => {
    expect(quotaReasonLabel({ kind: "http_error", httpStatus: 401, at: AT }))
      .toBe(`quota poll failed (401) · last tried ${clock}`);
  });

  it("distinguishes a 403 from a 401 http_error", () => {
    expect(quotaReasonLabel({ kind: "http_error", httpStatus: 403, at: AT }))
      .toBe(`quota poll failed (403) · last tried ${clock}`);
  });

  it("reports a network error without leaking the raw detail string", () => {
    const reason: AccountQuotaReason = { kind: "network_error", detail: "ECONNRESET sk-ant-oat01-secret", at: AT };
    const label = quotaReasonLabel(reason)!;
    expect(label).toBe(`quota poll failed (network error) · last tried ${clock}`);
    expect(label).not.toContain("sk-ant-oat01");
  });

  it("says a successful poll reported no windows for 'empty'", () => {
    expect(quotaReasonLabel({ kind: "empty", at: AT })).toBe(`no quota windows reported · last tried ${clock}`);
  });
});
