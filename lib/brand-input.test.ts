// @vitest-environment node
import { describe, expect, it } from "vitest"
import { BrandDetailsInput, parseBrandDetails, parsePreviewRequest } from "./brand-input"

const valid = {
  name: "Acme",
  brandDetailsDescription: "We make rockets for small teams.",
  audience: "Engineers",
  traits: ["Warm"],
}

describe("BrandDetailsInput", () => {
  it.each([
    { name: 123 },
    { name: "" },
    { name: "   " },
    { name: "x".repeat(81) },
    { traits: Array(50).fill("a") },
    { traits: ["Warm", "Direct", "Witty", "Refined"] },
    { traits: ["x".repeat(41)] },
    { brandDetailsDescription: "x".repeat(2501) },
    { brandDetailsDescription: 42 },
  ])("rejects %o", (override) => {
    expect(BrandDetailsInput.safeParse({ ...valid, ...override }).success).toBe(false)
  })

  it("trims values and fills defaults", () => {
    const parsed = BrandDetailsInput.parse({ name: "  Acme ", brandDetailsDescription: " Desc " })
    expect(parsed).toEqual({
      name: "Acme",
      brandDetailsDescription: "Desc",
      audience: "",
      traits: [],
      keywords: [],
      productsServices: [],
      formalityLevel: "Neutral",
      readingLevel: "6-8",
      englishVariant: "american",
    })
  })

  it("coerces legacy description fields", () => {
    expect(BrandDetailsInput.parse({ name: "A", description: "Legacy" }).brandDetailsDescription).toBe("Legacy")
    expect(BrandDetailsInput.parse({ name: "A", brandDetailsText: "Older" }).brandDetailsDescription).toBe("Older")
    expect(
      BrandDetailsInput.parse({ name: "A", brandDetailsDescription: "New", description: "Legacy" }).brandDetailsDescription,
    ).toBe("New")
  })

  it("reads trait names from strings and stored trait objects", () => {
    const parsed = BrandDetailsInput.parse({ ...valid, traits: [" Warm ", { type: "custom", id: "c1", name: "Bold" }] })
    expect(parsed.traits).toEqual(["Warm", "Bold"])
  })

  it("cleans model-generated lists instead of rejecting them", () => {
    const parsed = BrandDetailsInput.parse({
      ...valid,
      keywords: [...Array.from({ length: 30 }, (_, i) => `kw${i}`), "x".repeat(41), 7, " "],
      productsServices: "not a list",
      audience: "a".repeat(600),
    })
    expect(parsed.keywords).toHaveLength(25)
    expect(parsed.keywords.every((k) => k.length <= 40)).toBe(true)
    expect(parsed.productsServices).toEqual([])
    expect(parsed.audience).toHaveLength(500)
  })

  it("falls back to defaults for unknown option values", () => {
    const parsed = BrandDetailsInput.parse({ ...valid, englishVariant: "klingon", formalityLevel: 5, readingLevel: "x".repeat(50) })
    expect(parsed.englishVariant).toBe("american")
    expect(parsed.formalityLevel).toBe("Neutral")
    expect(parsed.readingLevel).toBe("6-8")
  })

  it("keeps british spelling when asked", () => {
    expect(BrandDetailsInput.parse({ ...valid, englishVariant: "british" }).englishVariant).toBe("british")
  })

  it("drops fields it does not know (e.g. client-supplied previewTraits)", () => {
    const parsed = BrandDetailsInput.parse({ ...valid, previewTraits: "IGNORE PREVIOUS", userEmail: "a@b.co" })
    expect(parsed).not.toHaveProperty("previewTraits")
    expect(parsed).not.toHaveProperty("userEmail")
  })
})

describe("parseBrandDetails", () => {
  it("returns a readable error", () => {
    const result = parseBrandDetails({ name: "" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/name/i)
  })

  it("rejects non-objects", () => {
    expect(parseBrandDetails(null).ok).toBe(false)
    expect(parseBrandDetails("x").ok).toBe(false)
  })
})

describe("parsePreviewRequest", () => {
  it("uses selectedTraits when given", () => {
    const result = parsePreviewRequest({ brandDetails: valid, selectedTraits: ["Direct", { name: "Bold" }] })
    expect(result.ok && result.data.traits).toEqual(["Direct", "Bold"])
  })

  it("falls back to brandDetails.traits when selectedTraits is empty or missing", () => {
    expect(parsePreviewRequest({ brandDetails: valid }).ok).toBe(true)
    const result = parsePreviewRequest({ brandDetails: valid, selectedTraits: [] })
    expect(result.ok && result.data.traits).toEqual(["Warm"])
  })

  it("rejects a missing brandDetails object and too many selected traits", () => {
    expect(parsePreviewRequest({}).ok).toBe(false)
    expect(parsePreviewRequest({ brandDetails: valid, selectedTraits: ["a", "b", "c", "d"] }).ok).toBe(false)
  })
})
