/**
 * Fixed-window rate limiter.
 *
 * TRD §14 requires rate limits. This one is in-process: it protects a single
 * instance and nothing more. Behind more than one instance the effective limit
 * multiplies by the instance count, so this must move to the shared store
 * (Redis, per TRD §2) before horizontal scaling. Recorded here rather than
 * left as a surprise in production.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Bounds memory if a burst of unique keys arrives (one key per attacker IP). */
const MAX_TRACKED_KEYS = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    if (windows.size >= MAX_TRACKED_KEYS) sweep(now);
    const resetAt = now + windowMs;
    windows.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  const allowed = existing.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    retryAfterSeconds: allowed ? 0 : Math.ceil((existing.resetAt - now) / 1000),
  };
}

function sweep(now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
  // Everything is still live: drop the oldest-resetting entries rather than
  // growing without bound.
  if (windows.size >= MAX_TRACKED_KEYS) {
    const sorted = [...windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [key] of sorted.slice(0, Math.floor(MAX_TRACKED_KEYS / 2))) windows.delete(key);
  }
}

/** Test hook. */
export function resetRateLimits(): void {
  windows.clear();
}
