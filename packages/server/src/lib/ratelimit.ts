/** Fixed-window counter, good enough for per-key RPM and login throttling. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly windowMs = 60_000) {
    setInterval(() => this.sweep(), windowMs).unref();
  }

  hit(key: string, limit: number): { ok: boolean; retryAfterSec: number; remaining: number } {
    const now = Date.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    const retryAfterSec = Math.ceil((w.start + this.windowMs - now) / 1000);
    return { ok: w.count <= limit, retryAfterSec, remaining: Math.max(0, limit - w.count) };
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}
