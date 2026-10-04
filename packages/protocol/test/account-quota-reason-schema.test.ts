import { describe, it, expect } from "vitest";
import { AccountQuotaReasonSchema } from "@chimera/protocol";

// QUOTA-ABSENCE-IS-INVISIBLE: the wire contract for "why is there no quota data". `.strict()`
// is load-bearing — an extra key must be a parse error, not silently carried across the RPC
// boundary — and the kind enum is closed so a typo'd kind can never reach the UI's switch.

describe("AccountQuotaReasonSchema", () => {
  for (const kind of ["unsupported", "rate_limited", "http_error", "network_error", "empty", "ok"] as const) {
    it(`accepts the '${kind}' kind`, () => {
      expect(AccountQuotaReasonSchema.parse({ kind, at: 1000 })).toEqual({ kind, at: 1000 });
    });
  }

  it("accepts the optional httpStatus alongside a kind", () => {
    expect(AccountQuotaReasonSchema.parse({ kind: "http_error", httpStatus: 401, at: 1000 }))
      .toEqual({ kind: "http_error", httpStatus: 401, at: 1000 });
  });

  it("accepts the optional detail string for a network error", () => {
    expect(AccountQuotaReasonSchema.parse({ kind: "network_error", detail: "ECONNRESET", at: 1000 }).detail)
      .toBe("ECONNRESET");
  });

  it("rejects an unknown kind", () => {
    expect(AccountQuotaReasonSchema.safeParse({ kind: "exploded", at: 1000 }).success).toBe(false);
  });

  it("rejects an extra key (.strict)", () => {
    expect(AccountQuotaReasonSchema.safeParse({ kind: "ok", at: 1000, token: "sk-ant-oat01-secret" }).success).toBe(false);
  });

  it("requires `at`", () => {
    expect(AccountQuotaReasonSchema.safeParse({ kind: "ok" }).success).toBe(false);
  });

  it("rejects a non-numeric httpStatus", () => {
    expect(AccountQuotaReasonSchema.safeParse({ kind: "http_error", httpStatus: "401", at: 1000 }).success).toBe(false);
  });
});
