/**
 * Small fixed-window rate limiter kept in memory.
 *
 * On serverless hosts each instance has its own memory, so this is a
 * best-effort brake on bursts, not a hard global quota. Swap the store for
 * Redis/Upstash if a strict global limit is needed; the API stays the same.
 */

export interface RateLimitOptions {
  limit: number
  windowMs: number
}

export interface RateLimitResult {
  ok: boolean
  remaining: number
  retryAfterSeconds: number
}

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
const MAX_KEYS = 10_000

export function rateLimit(key: string, { limit, windowMs }: RateLimitOptions): RateLimitResult {
  const now = Date.now()
  let bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size >= MAX_KEYS) pruneExpired(now)
    bucket = { count: 0, resetAt: now + windowMs }
    buckets.set(key, bucket)
  }

  if (bucket.count >= limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    }
  }

  bucket.count += 1
  return { ok: true, remaining: limit - bucket.count, retryAfterSeconds: 0 }
}

function pruneExpired(now: number) {
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k)
  }
  // Still full: drop the oldest entries so memory stays bounded.
  if (buckets.size >= MAX_KEYS) {
    const excess = buckets.size - MAX_KEYS + 1
    let i = 0
    for (const k of buckets.keys()) {
      if (i++ >= excess) break
      buckets.delete(k)
    }
  }
}

/** Test helper. */
export function resetRateLimits() {
  buckets.clear()
}

/** Rate-limit key: the user id when known, else the caller IP. */
export function clientKey(req: Request, userId?: string | null): string {
  if (userId) return `user:${userId}`
  const forwarded = req.headers.get("x-forwarded-for")
  const ip = forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown"
  return `ip:${ip}`
}
