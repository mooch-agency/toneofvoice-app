import "server-only"
import { getSupabaseAdmin } from "@/lib/supabase-admin"
import { rateLimit, type RateLimitOptions } from "@/lib/rate-limit"

/**
 * Rate limit shared by every server instance, using the `rate_limit_hit`
 * database function (supabase/migrations/003_rate_limits.sql). Until that
 * migration is applied, or if the database is unreachable, it falls back to
 * the per-instance in-memory limiter so requests are never blocked by an
 * outage of the limiter itself.
 */

export interface CheckResult {
  ok: boolean
  retryAfterSeconds: number
}

/** After learning the function is missing, skip the database for this long. */
const UNAVAILABLE_BACKOFF_MS = 5 * 60_000
let unavailableUntil = 0

function memory(key: string, opts: RateLimitOptions): CheckResult {
  const r = rateLimit(key, opts)
  return { ok: r.ok, retryAfterSeconds: r.retryAfterSeconds }
}

export async function checkRateLimit(key: string, opts: RateLimitOptions): Promise<CheckResult> {
  if (Date.now() < unavailableUntil) return memory(key, opts)

  try {
    const { data, error } = await getSupabaseAdmin().rpc("rate_limit_hit", {
      p_key: key,
      p_limit: opts.limit,
      p_window_ms: opts.windowMs,
    })
    if (error) {
      // PGRST202 / 42883: function not installed yet.
      if (error.code === "PGRST202" || error.code === "42883") {
        unavailableUntil = Date.now() + UNAVAILABLE_BACKOFF_MS
        console.warn("[rate-limit] rate_limit_hit missing; apply migration 003. Using in-memory limits.")
      } else {
        console.warn("[rate-limit] database limiter failed; using in-memory limits", error.code)
      }
      return memory(key, opts)
    }
    const row = Array.isArray(data) ? data[0] : data
    if (!row || typeof row.allowed !== "boolean") return memory(key, opts)
    return { ok: row.allowed, retryAfterSeconds: row.allowed ? 0 : Math.max(1, Number(row.retry_after_seconds) || 1) }
  } catch {
    // Missing admin env or network failure.
    return memory(key, opts)
  }
}

/** Test helper. */
export function resetDurableRateLimitState() {
  unavailableUntil = 0
}
