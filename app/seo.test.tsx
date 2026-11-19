import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("next/font/google", () => ({ Geist: () => ({ className: "g" }) }))
vi.mock("@/lib/fonts", () => ({ playfairDisplay: { variable: "p", className: "p" } }))
vi.mock("@vercel/analytics/next", () => ({ Analytics: () => null }))
vi.mock("@/components/MixpanelProvider", () => ({ MixpanelProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock("@/components/AuthProvider", () => ({ AuthProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }))
vi.mock("@/components/theme-provider", () => ({ ThemeProvider: ({ children }: { children: React.ReactNode }) => children }))

import RootLayout, { metadata } from "./layout"
import GlobalError from "./global-error"

describe("root layout SEO (FE-13)", () => {
  const html = renderToStaticMarkup(
    <RootLayout>
      <main />
    </RootLayout>,
  )

  it("does not hard-code title, description or canonical in the head", () => {
    expect(html).not.toMatch(/<title>/)
    expect(html).not.toMatch(/rel="canonical"/)
    expect(html).not.toMatch(/<meta name="description"/)
  })

  it("has no placeholder search-console verification", () => {
    expect(JSON.stringify(metadata)).not.toContain("google-site-verification-code-here")
  })

  it("still provides default title and description via metadata", () => {
    expect(metadata.title).toBeTruthy()
    expect(metadata.description).toBeTruthy()
  })
})

describe("global error page", () => {
  it("sets the document language and does not claim anyone was notified", () => {
    const html = renderToStaticMarkup(<GlobalError error={new Error("x")} reset={() => {}} />)
    expect(html).toMatch(/<html lang="en"/)
    expect(html).not.toMatch(/notified/i)
  })
})
