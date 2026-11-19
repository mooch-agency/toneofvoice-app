// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

type CookieOpts = {
  cookies: {
    getAll: () => { name: string; value: string }[]
    setAll: (c: { name: string; value: string; options?: Record<string, unknown> }[]) => void
  }
}

const h = vi.hoisted(() => ({ getUser: vi.fn(), opts: null as CookieOpts | null }))

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, opts: CookieOpts) => {
    h.opts = opts
    return { auth: { getUser: h.getUser } }
  },
}))

import { updateSession } from "./supabase-middleware"

const request = () => new NextRequest("https://toneofvoice.app/dashboard")

beforeEach(() => {
  h.getUser.mockReset()
  h.opts = null
})

afterEach(() => vi.unstubAllEnvs())

describe("updateSession", () => {
  it("returns { response, user: null } when Supabase env is missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "")
    const result = await updateSession(request())
    expect(result.user).toBeNull()
    expect(result.response.headers.get("x-middleware-next")).toBe("1")
    expect(h.getUser).not.toHaveBeenCalled()
  })

  it("returns the user and a response carrying refreshed cookies", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon")
    h.getUser.mockImplementation(async () => {
      h.opts!.cookies.setAll([{ name: "sb-token", value: "fresh", options: { path: "/" } }])
      return { data: { user: { id: "u1" } } }
    })

    const result = await updateSession(request())

    expect(result.user).toEqual({ id: "u1" })
    expect(result.response.cookies.get("sb-token")?.value).toBe("fresh")
  })

  it("treats an auth error as signed out", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon")
    h.getUser.mockRejectedValue(new Error("network"))
    vi.spyOn(console, "error").mockImplementation(() => {})

    const result = await updateSession(request())

    expect(result.user).toBeNull()
  })
})
