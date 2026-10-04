import { describe, it, expect } from "vitest";
import { RetryPolicySchema, computeRetryDelayMs } from "@chimera/protocol";

describe("RetryPolicySchema", () => {
  it("applies defaults", () => {
    const p = RetryPolicySchema.parse({});
    expect(p).toEqual({ maxAttempts: 3, backoff: "fixed", baseMs: 1000, jitter: false });
  });
  it("rejects maxAttempts outside [1,20]", () => {
    expect(() => RetryPolicySchema.parse({ maxAttempts: 0 })).toThrow();
    expect(() => RetryPolicySchema.parse({ maxAttempts: 21 })).toThrow();
    expect(RetryPolicySchema.parse({ maxAttempts: 20 }).maxAttempts).toBe(20);
  });
  it("rejects an unknown backoff kind (strict)", () => {
    expect(() => RetryPolicySchema.parse({ backoff: "linear" })).toThrow();
  });
});

describe("computeRetryDelayMs", () => {
  it("fixed backoff returns baseMs regardless of attempt number", () => {
    const p = RetryPolicySchema.parse({ backoff: "fixed", baseMs: 100 });
    expect(computeRetryDelayMs(p, 1)).toBe(100);
    expect(computeRetryDelayMs(p, 2)).toBe(100);
    expect(computeRetryDelayMs(p, 5)).toBe(100);
  });

  it("exponential backoff doubles per attempt", () => {
    const p = RetryPolicySchema.parse({ backoff: "exponential", baseMs: 100 });
    expect(computeRetryDelayMs(p, 1)).toBe(100);
    expect(computeRetryDelayMs(p, 2)).toBe(200);
    expect(computeRetryDelayMs(p, 3)).toBe(400);
    expect(computeRetryDelayMs(p, 4)).toBe(800);
  });

  it("maxDelayMs caps the computed delay", () => {
    const p = RetryPolicySchema.parse({ backoff: "exponential", baseMs: 100, maxDelayMs: 250 });
    expect(computeRetryDelayMs(p, 1)).toBe(100);
    expect(computeRetryDelayMs(p, 2)).toBe(200);
    expect(computeRetryDelayMs(p, 3)).toBe(250);   // would be 400 uncapped
    expect(computeRetryDelayMs(p, 4)).toBe(250);   // would be 800 uncapped
  });

  it("jitter scales the delay by 0.5x-1.5x via the injected rand", () => {
    const p = RetryPolicySchema.parse({ backoff: "fixed", baseMs: 100, jitter: true });
    expect(computeRetryDelayMs(p, 1, () => 0)).toBe(50);          // 100 * 0.5
    expect(computeRetryDelayMs(p, 1, () => 0.999999)).toBe(150);  // 100 * 1.5 (rounded)
    expect(computeRetryDelayMs(p, 1, () => 0.5)).toBe(100);       // 100 * 1.0
  });

  it("no jitter is deterministic even with a rand supplied (never called)", () => {
    const p = RetryPolicySchema.parse({ backoff: "fixed", baseMs: 100, jitter: false });
    expect(computeRetryDelayMs(p, 1, () => { throw new Error("must not be called"); })).toBe(100);
  });
});
