// @vitest-environment node
import { describe, expect, it } from "vitest"
import nextConfig from "../next.config.js"

describe("next.config", () => {
  it("does not inline server secrets into bundles", () => {
    const env = (nextConfig as { env?: Record<string, unknown> }).env ?? {}
    expect(Object.keys(env)).not.toContain("OPENAI_API_KEY")
    expect(Object.keys(env)).not.toContain("STRIPE_SECRET_KEY")
  })

  it("does not proxy images from any host", () => {
    const patterns = nextConfig.images?.remotePatterns ?? []
    for (const p of patterns) {
      expect((p as { hostname: string }).hostname).not.toContain("*")
    }
  })

  it("does not hide type errors at build time", () => {
    expect(nextConfig.typescript?.ignoreBuildErrors ?? false).toBe(false)
  })
})
