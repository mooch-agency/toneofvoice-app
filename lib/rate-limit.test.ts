import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clientKey, rateLimit, resetRateLimits } from "./rate-limit"

describe("rateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetRateLimits()
  })
  afterEach(() => vi.useRealTimers())

  it("allows up to the limit, then blocks with a retry hint", () => {
    const opts = { limit: 2, windowMs: 60_000 }
    expect(rateLimit("u1", opts).ok).toBe(true)
    expect(rateLimit("u1", opts).ok).toBe(true)
    const blocked = rateLimit("u1", opts)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60)
  })

  it("tracks keys independently", () => {
    const opts = { limit: 1, windowMs: 60_000 }
    expect(rateLimit("a", opts).ok).toBe(true)
    expect(rateLimit("b", opts).ok).toBe(true)
    expect(rateLimit("a", opts).ok).toBe(false)
  })

  it("frees capacity once the window passes", () => {
    const opts = { limit: 1, windowMs: 1_000 }
    expect(rateLimit("k", opts).ok).toBe(true)
    expect(rateLimit("k", opts).ok).toBe(false)
    vi.advanceTimersByTime(1_001)
    expect(rateLimit("k", opts).ok).toBe(true)
  })
})

describe("clientKey", () => {
  it("prefers the user id", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4" } })
    expect(clientKey(req, "user-1")).toBe("user:user-1")
  })

  it("falls back to the first forwarded IP", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } })
    expect(clientKey(req)).toBe("ip:1.2.3.4")
  })

  it("uses x-real-ip, then 'unknown'", () => {
    expect(clientKey(new Request("http://x", { headers: { "x-real-ip": "5.6.7.8" } }))).toBe("ip:5.6.7.8")
    expect(clientKey(new Request("http://x"))).toBe("ip:unknown")
  })
})
