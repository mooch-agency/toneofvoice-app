// @vitest-environment node
import { describe, expect, it } from "vitest"
import { getSectionDescription, getSectionEyebrow } from "./guide-styles"

describe("getSectionEyebrow (AI-28)", () => {
  it.each([
    ["About Acme", "BRAND OVERVIEW"],
    ["How to Use This Document", "USAGE GUIDE"],
    ["Your Audience", "WHO YOU'RE WRITING FOR"],
    ["Content Guidelines", "FOUNDATION"],
    ["Brand Voice", "BRAND IDENTITY"],
    ["Style Rules", "STYLE RULES"],
    ["Before / After", "EXAMPLES"],
    ["Word List", "TERMINOLOGY"],
  ])("%s -> %s", (heading, eyebrow) => {
    expect(getSectionEyebrow(heading)).toBe(eyebrow)
  })

  it.each(["What we care about", "Questions?", "AI Writing Cleanup", "Our brand voice in ads"])(
    "has no eyebrow for %s",
    (heading) => {
      expect(getSectionEyebrow(heading)).toBeNull()
    },
  )
})

describe("getSectionDescription", () => {
  it("describes known sections only", () => {
    expect(getSectionDescription("Brand Voice")).toMatch(/core character/)
    expect(getSectionDescription("Word List")).toMatch(/Preferred terms/)
    expect(getSectionDescription("Sustainability and brand voice")).toBeNull()
  })
})
