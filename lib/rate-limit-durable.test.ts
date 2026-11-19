// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  adminThrows: false,
}))

vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => {
    if (h.adminThrows) throw new Error("Missing Supabase admin env")
    return { rpc: h.rpc }
  },
}))

import { checkRateLimit, resetDurableRateLimitState } from "./rate-limit-durable"
import { resetRateLimits } from "./rate-limit"

const opts = { limit: 2, windowMs: 60_000 }

beforeEach(() => {
  h.rpc.mockReset()
  h.adminThrows = false
  resetRateLimits()
  resetDurableRateLimitState()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("checkRateLimit", () => {
  it("uses the shared database counter when it is available", async () => {
    h.rpc.mockResolvedValue({ data: [{ allowed: false, retry_after_seconds: 42 }], error: null })
    const result = await checkRateLimit("k", opts)
    expect(result).toEqual({ ok: false, retryAfterSeconds: 42 })
    expect(h.rpc).toHaveBeenCalledWith("rate_limit_hit", { p_key: "k", p_limit: 2, p_window_ms: 60_000 })
  })

  it("allows the request when the database says so", async () => {
    h.rpc.mockResolvedValue({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null })
    expect((await checkRateLimit("k", opts)).ok).toBe(true)
  })

  it("falls back to the in-memory limiter when the function is not installed", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "function not found" } })
    expect((await checkRateLimit("k", opts)).ok).toBe(true)
    expect((await checkRateLimit("k", opts)).ok).toBe(true)
    expect((await checkRateLimit("k", opts)).ok).toBe(false)
  })

  it("stops calling the database for a while once the function is known to be missing", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "function not found" } })
    await checkRateLimit("k", opts)
    await checkRateLimit("k", opts)
    expect(h.rpc).toHaveBeenCalledTimes(1)
  })

  it("falls back to memory when Supabase admin is not configured", async () => {
    h.adminThrows = true
    expect((await checkRateLimit("k", opts)).ok).toBe(true)
  })

  it("fails open to the in-memory limiter on a transient database error", async () => {
    h.rpc.mockRejectedValue(new Error("network"))
    expect((await checkRateLimit("k", { limit: 1, windowMs: 60_000 })).ok).toBe(true)
    expect((await checkRateLimit("k", { limit: 1, windowMs: 60_000 })).ok).toBe(false)
  })
})
