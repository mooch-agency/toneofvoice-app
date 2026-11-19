// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  createClientImpl: (async () => ({})) as () => Promise<unknown>,
  MissingSupabaseConfigError: class MissingSupabaseConfigError extends Error {},
}))
const { MissingSupabaseConfigError } = h

vi.mock("@/lib/supabase-server", () => ({
  createClient: () => h.createClientImpl(),
  MissingSupabaseConfigError: h.MissingSupabaseConfigError,
}))

const getUser = vi.fn()
const single = vi.fn()
const from = vi.fn(() => ({ select: () => ({ eq: () => ({ single }) }) }))

import { requireUser, withRouteErrors } from "./api-auth"

beforeEach(() => {
  getUser.mockReset()
  single.mockReset()
  h.createClientImpl = async () => ({ auth: { getUser }, from })
})

describe("requireUser", () => {
  it("returns a 401 response when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null })
    const result = await requireUser()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(401)
  })

  it("returns the user and an effective tier from the profile", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1", email: "a@b.co" } }, error: null })
    single.mockResolvedValue({ data: { subscription_tier: "pro", subscription_status: "past_due" } })
    const result = await requireUser({ withTier: true })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.user.id).toBe("u1")
      expect(result.tier).toBe("starter")
    }
  })

  it("enforces a paid tier when asked", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null })
    single.mockResolvedValue({ data: { subscription_tier: "starter" } })
    const result = await requireUser({ requirePaid: true })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(403)
  })

  it("allows a paid tier through", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null })
    single.mockResolvedValue({ data: { subscription_tier: "agency", subscription_status: "active" } })
    const result = await requireUser({ requirePaid: true })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.tier).toBe("agency")
  })
})

describe("withRouteErrors", () => {
  it("maps missing Supabase config to 503", async () => {
    const res = await withRouteErrors("test", async () => {
      throw new MissingSupabaseConfigError("x")
    })
    expect(res.status).toBe(503)
  })

  it("maps unknown errors to a generic 500 without leaking details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await withRouteErrors("test", async () => {
      throw new Error('duplicate key value violates unique constraint "style_guides_pkey"')
    })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain("style_guides")
  })

  it("passes through a normal response", async () => {
    const res = await withRouteErrors("test", async () => new Response("ok", { status: 201 }))
    expect(res.status).toBe(201)
  })
})
