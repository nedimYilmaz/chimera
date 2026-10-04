import { TokenBucket } from "./bucket.js";

// Per-client rate limiter: each clientId gets its own token bucket, created
// lazily on first use.
export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {}

  allow(clientId: string, nowMs: number): boolean {
    let bucket = this.buckets.get(clientId);
    if (!bucket) {
      bucket = new TokenBucket(this.capacity, this.refillPerSec, nowMs);
      this.buckets.set(clientId, bucket);
    }
    return bucket.tryTake(nowMs);
  }
}
