/**
 * Token bucket rate limiter.
 * Usage:
 *   const limiter = new RateLimiter(40, 60000); // 40 requests per minute
 *   await limiter.acquire();
 */
export class RateLimiter {
  constructor(maxTokens, intervalMs) {
    this.maxTokens = maxTokens;
    this.intervalMs = intervalMs;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.queue = [];
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = (elapsed / this.intervalMs) * this.maxTokens;
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  async acquire() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait until a token is available
    const waitMs = ((1 - this.tokens) / this.maxTokens) * this.intervalMs;
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
    this._refill();
    this.tokens -= 1;
  }
}

// Shared rate limiters
export const apolloLimiter = new RateLimiter(40, 60_000); // 40 req/min
export const browserbaseLimiter = new RateLimiter(5, 1_000); // 5 concurrent sessions
