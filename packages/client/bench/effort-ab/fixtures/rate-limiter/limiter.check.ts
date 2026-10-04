import { describe, it, expect } from "vitest";
import { RateLimiter } from "./limiter.js";

describe("RateLimiter", () => {
  it("allows exactly `capacity` requests before refill, then denies", () => {
    const limiter = new RateLimiter(5, 1); // 5 tokens, refills 1/sec
    for (let i = 0; i < 5; i++) expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 0)).toBe(false);
  });

  it("refills at exactly refillPerSec tokens per elapsed second, not per elapsed ms", () => {
    const limiter = new RateLimiter(5, 1); // 5 tokens, refills 1/sec
    for (let i = 0; i < 5; i++) limiter.allow("a", 0);
    // one real second later: exactly 1 token should have refilled
    expect(limiter.allow("a", 1000)).toBe(true);
    expect(limiter.allow("a", 1000)).toBe(false);
  });

  it("tracks separate clients independently", () => {
    const limiter = new RateLimiter(1, 1);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 0)).toBe(false);
    expect(limiter.allow("b", 0)).toBe(true);
  });
});
