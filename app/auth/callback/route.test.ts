// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ exchangeCodeForSession: vi.fn() }))

vi.mock("@/lib/supabase-server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession: h.exchangeCodeForSession } }),
}))

import { GET } from "./route"

const ORIGIN = "https://toneofvoice.app"

async function callback(query: string) {
  const res = await GET(new Request(`${ORIGIN}/auth/callback?${query}`))
  return new URL(res.headers.get("location")!)
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  h.exchangeCodeForSession.mockReset().mockResolvedValue({ error: null })
})

describe("GET /auth/callback", () => {
  it("redirects to a same-site next path after a successful exchange", async () => {
    const location = await callback("code=abc&next=/dashboard?tab=guides")
    expect(location.href).toBe(`${ORIGIN}/dashboard?tab=guides`)
    expect(h.exchangeCodeForSession).toHaveBeenCalledWith("abc")
  })

  it("defaults to /auth/claim", async () => {
    expect((await callback("code=abc")).href).toBe(`${ORIGIN}/auth/claim`)
  })

  it.each(["@evil.com/phish", ".evil.com", "//evil.com", "/\\evil.com", "https://evil.com", "/%2F%2Fevil.com"])(
    "never leaves the origin for next=%s",
    async (next) => {
      const location = await callback(`code=abc&next=${encodeURIComponent(next)}`)
      expect(location.origin).toBe(ORIGIN)
      expect(location.pathname).toBe("/auth/claim")
    },
  )

  it("sends exchange errors to /auth/error on the same origin", async () => {
    h.exchangeCodeForSession.mockResolvedValue({ error: { message: "invalid grant" } })
    const location = await callback("code=bad&next=@evil.com")
    expect(location.origin).toBe(ORIGIN)
    expect(location.pathname).toBe("/auth/error")
  })

  it("sends a missing code to /auth/error", async () => {
    const location = await callback("next=/dashboard")
    expect(location.origin).toBe(ORIGIN)
    expect(location.pathname).toBe("/auth/error")
    expect(location.searchParams.get("message")).toBe("Missing authentication code")
  })
})
