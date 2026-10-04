// A token-bucket: capacity tokens max, refilling at refillPerSec tokens/second.
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    nowMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = nowMs;
  }

  private refill(nowMs: number): void {
    const elapsedMs = nowMs - this.lastRefillMs;
    const added = elapsedMs * this.refillPerSec;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefillMs = nowMs;
  }

  tryTake(nowMs: number, count = 1): boolean {
    this.refill(nowMs);
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}
