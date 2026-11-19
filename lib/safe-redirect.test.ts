import { describe, expect, it } from "vitest"
import { safeRedirectPath } from "./safe-redirect"

describe("safeRedirectPath", () => {
  it.each(["/dashboard", "/guide?guideId=abc", "/auth/claim", "/dashboard/billing#plans"])(
    "allows same-site path %s",
    (p) => {
      expect(safeRedirectPath(p)).toBe(p)
    },
  )

  it.each([
    "@evil.com/phish",
    ".evil.com",
    "//evil.com",
    "/\\evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "/foo@evil.com",
    "",
    null,
    undefined,
    " /dashboard",
    "/%2F%2Fevil.com",
  ])("rejects %s and falls back", (p) => {
    expect(safeRedirectPath(p as string | null | undefined)).toBe("/dashboard")
  })

  it("uses a custom fallback", () => {
    expect(safeRedirectPath("//evil.com", "/auth/claim")).toBe("/auth/claim")
  })

  it("never yields a URL with a foreign origin", () => {
    for (const p of ["@evil.com", "//evil.com", "/\\evil.com", "/ok"]) {
      expect(new URL(safeRedirectPath(p), "https://toneofvoice.app").origin).toBe("https://toneofvoice.app")
    }
  })
})
