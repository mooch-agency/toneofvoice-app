// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server"

const h = vi.hoisted(() => ({ updateSession: vi.fn() }))
vi.mock("@/lib/supabase-middleware", () => ({ updateSession: h.updateSession }))

import { config, proxy } from "./proxy"

function sessionResponse(request: NextRequest) {
  const response = NextResponse.next({ request })
  response.cookies.set("sb-token", "refreshed", { path: "/", httpOnly: true })
  return response
}

beforeEach(() => h.updateSession.mockReset())

describe("proxy", () => {
  it("redirects signed-out users from /dashboard to sign-in and keeps refreshed cookies", async () => {
    const request = new NextRequest("https://toneofvoice.app/dashboard/billing")
    h.updateSession.mockResolvedValue({ response: sessionResponse(request), user: null })

    const res = await proxy(request)

    expect(res.status).toBe(307)
    const location = new URL(res.headers.get("location")!)
    expect(location.pathname).toBe("/sign-in")
    expect(location.searchParams.get("redirectTo")).toBe("/dashboard/billing")
    expect(res.cookies.get("sb-token")?.value).toBe("refreshed")
  })

  it("lets signed-in users through with the session response", async () => {
    const request = new NextRequest("https://toneofvoice.app/dashboard")
    const response = sessionResponse(request)
    h.updateSession.mockResolvedValue({ response, user: { id: "u1" } })

    expect(await proxy(request)).toBe(response)
  })

  it("does not protect public pages", async () => {
    const request = new NextRequest("https://toneofvoice.app/guide")
    const response = sessionResponse(request)
    h.updateSession.mockResolvedValue({ response, user: null })

    expect(await proxy(request)).toBe(response)
  })

  it("does not treat /dashboards-like prefixes as protected", async () => {
    const request = new NextRequest("https://toneofvoice.app/dashboardx")
    const response = sessionResponse(request)
    h.updateSession.mockResolvedValue({ response, user: null })

    expect(await proxy(request)).toBe(response)
  })
})

describe("proxy matcher", () => {
  it.each(["/", "/dashboard", "/dashboard/billing", "/guide?guideId=1", "/sign-in", "/auth/claim"])(
    "runs on page %s",
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true)
    },
  )

  it.each([
    "/api",
    "/api/webhook",
    "/api/ai/command",
    "/api/cron/keep-alive",
    "/_next/static/chunks/main.js",
    "/_next/image?url=x",
    "/favicon.ico",
    "/logo.png",
    "/sitemap.xml",
    "/robots.txt",
    "/pdf-styles",
  ])("skips %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false)
  })
})
