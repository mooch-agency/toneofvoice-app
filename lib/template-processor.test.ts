// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  traits: vi.fn(),
  audience: vi.fn(),
  rules: vi.fn(),
  examples: vi.fn(),
  wordList: vi.fn(),
}))

vi.mock("./openai", () => ({
  generateBrandVoiceTraits: h.traits,
  generateAudienceSection: h.audience,
  generateStyleRules: h.rules,
  generateBeforeAfterSamples: h.examples,
  generateWordList: h.wordList,
}))

import { PLACEHOLDERS, hasUnlockPlaceholders } from "./guide-placeholders"
import { parseStyleGuideContent } from "./content-parser"
import type { BrandDetails } from "./brand-input"
import {
  contactSection,
  extractTraitsContext,
  fillTemplate,
  renderFullGuideFromPreview,
  renderStyleGuideTemplate,
} from "./template-processor"

const ok = (content: string) => ({ success: true, content })
const fail = { success: false, error: "bad json" }

const TRAITS_MD = "### 1. Warm\n\nWarm sentence.\n\n### 2. Direct\n\nDirect sentence."
const RULES_MD = "### 1. Time\nWrite times as 10:00 am. See https://a.com\n✅ *At 10:00 am.*\n❌ *At 10.00AM*"

const brand: BrandDetails = {
  name: "Ca$$h & Co",
  brandDetailsDescription: "We save $' and $& for you.",
  audience: "Savers",
  traits: ["Warm", "Direct"],
  keywords: ["savings"],
  productsServices: ["Piggy banks"],
  formalityLevel: "Neutral",
  readingLevel: "6-8",
  englishVariant: "british",
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
  h.traits.mockResolvedValue(ok(TRAITS_MD))
  h.audience.mockResolvedValue(ok("### Overview\n\nSavers who plan."))
  h.rules.mockResolvedValue(ok(RULES_MD))
  h.examples.mockResolvedValue(ok("### Hero\n\n**Before:** a\n\n**After:** b"))
  h.wordList.mockResolvedValue(ok("### Avoid Terms\n\n| Avoid |\n|-------|\n| cheap |"))
})

describe("fillTemplate (AI-18)", () => {
  it("replaces every placeholder and keeps $ sequences literally", () => {
    expect(fillTemplate("{{a}} and {{a}}", { a: "$$ $& $' $`" })).toBe("$$ $& $' $` and $$ $& $' $`")
  })

  it("leaves unknown placeholders and does not rescan inserted values", () => {
    expect(fillTemplate("{{a}} {{b}}", { a: "{{b}}" })).toBe("{{b}} {{b}}")
  })
})

describe("extractTraitsContext (AI-7)", () => {
  const preview = `## Brand Voice\n\n${TRAITS_MD}\n\n---\n\n## Style Rules\n\n${PLACEHOLDERS.styleRules}`

  it("includes every ### trait block and stops at the next section", () => {
    const ctx = extractTraitsContext(preview, ["Warm", "Direct"])!
    expect(ctx).toContain("Selected Traits: Warm, Direct")
    expect(ctx).toContain("### 2. Direct")
    expect(ctx).not.toContain("Style Rules")
  })

  it("is capped at 4000 characters", () => {
    const long = `## Brand Voice\n\n${"x".repeat(5000)}`
    expect(extractTraitsContext(long, ["Warm"])!.length).toBe(4000)
  })

  it("returns only the trait names without a Brand Voice section", () => {
    expect(extractTraitsContext("## About\n\nx", ["Warm"])).toBe("Selected Traits: Warm")
    expect(extractTraitsContext("## About\n\nx", [])).toBeUndefined()
  })
})

describe("contactSection", () => {
  it("uses the email when known", () => {
    expect(contactSection("Acme", "a@b.co")).toContain("**Contact:** a@b.co")
    expect(contactSection("Acme", null)).toContain("Contact the Acme content team.")
  })
})

describe("renderStyleGuideTemplate", () => {
  it("builds a preview with traits and audience and locks the paid sections", async () => {
    const { markdown, failedSections } = await renderStyleGuideTemplate({ brandDetails: brand, isPreview: true })
    expect(failedSections).toEqual([])
    expect(markdown).not.toContain("{{")
    expect(markdown).toContain("## About Ca$$h & Co")
    expect(markdown).toContain("We save $' and $& for you.")
    expect(markdown).toContain("### 2. Direct")
    expect(markdown).toContain("Savers who plan.")
    expect(markdown).toContain(PLACEHOLDERS.styleRules)
    expect(markdown).toContain(PLACEHOLDERS.beforeAfter)
    expect(markdown).toContain(PLACEHOLDERS.wordList)
    expect(markdown).toContain("## How to Use This Document")
    expect(markdown).toContain("## AI Writing Cleanup")
    expect(h.rules).not.toHaveBeenCalled()
  })

  it("builds the full guide with rules inserted as-is (AI-5)", async () => {
    const { markdown, failedSections } = await renderStyleGuideTemplate({ brandDetails: brand, isPreview: false })
    expect(failedSections).toEqual([])
    expect(hasUnlockPlaceholders(markdown)).toBe(false)
    expect(markdown).toContain("Write times as 10:00 am. See https://a.com")
    const ids = parseStyleGuideContent(markdown).map((s) => s.id)
    expect(ids.filter((id) => id === "style-rules")).toHaveLength(1)
    const traitsContext = h.rules.mock.calls[0][1]
    expect(traitsContext).toContain("### 2. Direct")
    expect(h.wordList.mock.calls[0][0].productsServices).toEqual(["Piggy banks"])
  })

  it("keeps the placeholder for a failed paid section and reports it (AI-6)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.wordList.mockResolvedValue(fail)
    const { markdown, failedSections } = await renderStyleGuideTemplate({ brandDetails: brand, isPreview: false })
    expect(failedSections).toEqual(["word-list"])
    expect(markdown).toContain(PLACEHOLDERS.wordList)
    expect(markdown).not.toContain(PLACEHOLDERS.styleRules)
    expect(markdown).not.toMatch(/Could not generate/)
  })

  it("reports failed free sections", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.traits.mockResolvedValue(fail)
    h.audience.mockResolvedValue(fail)
    const { failedSections } = await renderStyleGuideTemplate({ brandDetails: brand, isPreview: true })
    expect(failedSections).toEqual(["brand-voice", "audience"])
  })

  it("puts the user's email in the contact section", async () => {
    const { markdown } = await renderStyleGuideTemplate({ brandDetails: brand, isPreview: true, userEmail: "a@b.co" })
    expect(markdown).toContain("**Contact:** a@b.co")
  })

  it("passes the abort signal to every section call", async () => {
    const signal = new AbortController().signal
    await renderStyleGuideTemplate({ brandDetails: brand, isPreview: false, signal })
    expect(h.traits.mock.calls[0][1]).toEqual({ signal })
    expect(h.audience.mock.calls[0][1]).toEqual({ signal })
    expect(h.rules.mock.calls[0][2]).toEqual({ signal })
  })
})

describe("renderFullGuideFromPreview", () => {
  async function preview() {
    return (await renderStyleGuideTemplate({ brandDetails: brand, isPreview: true })).markdown
  }

  it("fills the locked sections and keeps the rest of the preview", async () => {
    const previewContent = await preview()
    const { markdown, failedSections } = await renderFullGuideFromPreview({ previewContent, brandDetails: brand })
    expect(failedSections).toEqual([])
    expect(hasUnlockPlaceholders(markdown)).toBe(false)
    expect(markdown).toContain(RULES_MD)
    expect(markdown).toContain("Savers who plan.")
    expect(markdown).toContain("## Style Rules\n\n" + RULES_MD + "\n\n---\n\n## Before / After")
  })

  it("passes the full Brand Voice section and productsServices to the generators (AI-7, AI-20)", async () => {
    const previewContent = await preview()
    await renderFullGuideFromPreview({ previewContent, brandDetails: brand })
    expect(h.rules.mock.calls[0][1]).toContain("### 2. Direct")
    expect(h.wordList.mock.calls[0][0].productsServices).toEqual(["Piggy banks"])
  })

  it("reports failed sections instead of embedding failure text (AI-6)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const previewContent = await preview()
    h.wordList.mockResolvedValue(fail)
    const r = await renderFullGuideFromPreview({ previewContent, brandDetails: brand })
    expect(r.failedSections).toEqual(["word-list"])
    expect(r.markdown).toContain(PLACEHOLDERS.wordList)
  })

  it("updates the contact section with the user's email (AI-20)", async () => {
    const previewContent = await preview()
    const { markdown } = await renderFullGuideFromPreview({ previewContent, brandDetails: brand, userEmail: "a@b.co" })
    expect(markdown).toContain("**Contact:** a@b.co")
    expect(markdown.match(/^## Questions\?/gm)).toHaveLength(1)
  })

  it("only generates sections that are still locked", async () => {
    const previewContent = (await preview()).replace(PLACEHOLDERS.styleRules, RULES_MD)
    const { failedSections } = await renderFullGuideFromPreview({ previewContent, brandDetails: brand })
    expect(failedSections).toEqual([])
    expect(h.rules).not.toHaveBeenCalled()
    expect(h.examples).toHaveBeenCalledTimes(1)
  })
})
