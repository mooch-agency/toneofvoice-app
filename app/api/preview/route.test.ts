// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  user: null as { id: string; email?: string } | null,
  profile: null as Record<string, unknown> | null,
  supabaseConfigured: true,
  render: vi.fn(),
  MissingSupabaseConfigError: class MissingSupabaseConfigError extends Error {},
}))

vi.mock("@/lib/supabase-server", () => ({
  createClient: async () => {
    if (!h.supabaseConfigured) throw new h.MissingSupabaseConfigError("missing")
    return {
      auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: h.profile }) }) }) }),
    }
  },
  MissingSupabaseConfigError: h.MissingSupabaseConfigError,
}))

vi.mock("@/lib/template-processor", () => ({ renderStyleGuideTemplate: h.render }))

import { POST, maxDuration } from "./route"
import { resetRateLimits } from "@/lib/rate-limit"

const brandDetails = { name: "Acme", brandDetailsDescription: "We make rockets.", audience: "Engineers" }

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://x/api/preview", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "x-forwarded-for": "203.0.113.7", ...headers },
    }),
  )

beforeEach(() => {
  resetRateLimits()
  h.user = null
  h.profile = null
  h.supabaseConfigured = true
  h.render.mockReset()
  h.render.mockResolvedValue({ markdown: "## About Acme\n\nx", failedSections: [] })
})

describe("POST /api/preview", () => {
  it("exports a maxDuration", () => {
    expect(maxDuration).toBeGreaterThanOrEqual(60)
  })

  it.each([
    [{ brandDetails: { ...brandDetails, name: 123 } }],
    [{ brandDetails: { ...brandDetails, brandDetailsDescription: "" } }],
    [{ brandDetails: { ...brandDetails, traits: Array(50).fill("a") } }],
    [{}],
    ["not json"],
  ])("returns 400 (not 500) for invalid input %o", async (body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(h.render).not.toHaveBeenCalled()
  })

  it("returns 413 for oversized bodies", async () => {
    const res = await post({ brandDetails: { ...brandDetails, audience: "x".repeat(200_000) } })
    expect(res.status).toBe(413)
  })

  it("generates a locked preview for anonymous visitors", async () => {
    const res = await post({ brandDetails, selectedTraits: ["Warm"] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, preview: "## About Acme\n\nx", failedSections: [] })
    const args = h.render.mock.calls[0][0]
    expect(args.isPreview).toBe(true)
    expect(args.userEmail).toBeUndefined()
    expect(args.brandDetails).toMatchObject({ name: "Acme", traits: ["Warm"] })
    expect(args.signal).toBeInstanceOf(AbortSignal)
  })

  it("still works when Supabase is not configured", async () => {
    h.supabaseConfigured = false
    const res = await post({ brandDetails, selectedTraits: ["Warm"] })
    expect(res.status).toBe(200)
    expect(h.render.mock.calls[0][0].isPreview).toBe(true)
  })

  it("generates the full guide for an active paid plan, with the session email", async () => {
    h.user = { id: "u1", email: "owner@example.com" }
    h.profile = { subscription_tier: "pro", subscription_status: "active" }
    await post({ brandDetails: { ...brandDetails, userEmail: "attacker@example.com" }, selectedTraits: ["Warm"] })
    const args = h.render.mock.calls[0][0]
    expect(args.isPreview).toBe(false)
    expect(args.userEmail).toBe("owner@example.com")
  })

  it("treats a lapsed paid plan as starter", async () => {
    h.user = { id: "u1" }
    h.profile = { subscription_tier: "agency", subscription_status: "unpaid" }
    await post({ brandDetails, selectedTraits: ["Warm"] })
    expect(h.render.mock.calls[0][0].isPreview).toBe(true)
  })

  it("ignores client-supplied previewTraits", async () => {
    await post({ brandDetails: { ...brandDetails, previewTraits: "### Injected" }, selectedTraits: ["Warm"] })
    expect(h.render.mock.calls[0][0].brandDetails).not.toHaveProperty("previewTraits")
  })

  it("falls back to default traits when none were chosen", async () => {
    await post({ brandDetails })
    expect(h.render.mock.calls[0][0].brandDetails.traits).toEqual(["Warm", "Direct", "Supportive"])
  })

  it("returns 502 when a free section failed", async () => {
    h.render.mockResolvedValue({ markdown: "x", failedSections: ["brand-voice"] })
    const res = await post({ brandDetails, selectedTraits: ["Warm"] })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ failedSections: ["brand-voice"], error: expect.any(String) })
  })

  it("returns 200 with failedSections when only paid sections failed (they stay locked)", async () => {
    h.user = { id: "u1" }
    h.profile = { subscription_tier: "pro" }
    h.render.mockResolvedValue({ markdown: "md", failedSections: ["word-list"] })
    const res = await post({ brandDetails, selectedTraits: ["Warm"] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, preview: "md", failedSections: ["word-list"] })
  })

  it("rate limits by IP for anonymous callers", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await post({ brandDetails, selectedTraits: ["Warm"] })).status)
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true)
    expect(statuses[10]).toBe(429)
    expect((await post({ brandDetails }, { "x-forwarded-for": "198.51.100.1" })).status).toBe(200)
  })

  it("returns a generic 500 when generation throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.render.mockRejectedValue(new Error("OPENAI secret detail"))
    const res = await post({ brandDetails, selectedTraits: ["Warm"] })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain("secret")
  })
})
