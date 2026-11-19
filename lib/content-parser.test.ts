// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  getSectionBody,
  getSectionIdFromHeading,
  insertCustomSection,
  parseStyleGuideContent,
  replaceSectionInMarkdown,
} from "./content-parser"
import { renderRulesMarkdown } from "./rules-renderer"
import { ALLOWED_RULE_CATEGORIES } from "./rules-schema"

const GUIDE = `## About Acme

We make rockets.

---

## Brand Voice

### 1. Warm

Warm sentence.

### 2. Direct

Direct sentence.

---

## Style Rules

_Unlock to see Style Rules._

---

## Before / After

_Unlock to see Before/After examples._

---

## Questions?

Contact the Acme content team.`

describe("parseStyleGuideContent", () => {
  it("splits on H1/H2 and maps known headings to section ids", () => {
    const sections = parseStyleGuideContent(GUIDE)
    expect(sections.map((s) => s.id)).toEqual(["about", "brand-voice", "style-rules", "examples", "contact"])
    expect(sections[2].minTier).toBe("pro")
    expect(sections[1].content).toContain("### 2. Direct")
  })

  it("returns one section when there are no headings", () => {
    expect(parseStyleGuideContent("just text")).toMatchObject([{ id: "content", content: "just text" }])
    expect(parseStyleGuideContent("")).toEqual([])
  })

  it("hides the deprecated Content Guidelines section", () => {
    const md = "## About X\n\nA\n\n## Content Guidelines\n\nold\n\n## Style Rules\n\nR"
    expect(parseStyleGuideContent(md).map((s) => s.id)).toEqual(["about", "style-rules"])
  })

  it("sees exactly one style-rules section after 25 rendered rules", () => {
    const rules = ALLOWED_RULE_CATEGORIES.map((c) => ({
      category: c,
      title: c,
      description: "20 words or fewer keeps every sentence easy to scan.",
      examples: { good: "1. Good at 10:00 am", bad: "2. Bad" },
    }))
    const md = `## Style Rules\n\n${renderRulesMarkdown(rules)}\n\n---\n\n## Word List\n\nx`
    const ids = parseStyleGuideContent(md).map((s) => s.id)
    expect(ids).toEqual(["style-rules", "word-list"])
  })
})

describe("replaceSectionInMarkdown", () => {
  it("replaces the right section when a skipped heading comes first (AI-8)", () => {
    const md =
      "## About X\n\nA\n\n## Content Guidelines\n\nold\n\n## Style Rules\n\n_Unlock to see Style Rules._\n\n## Before / After\n\nB"
    const out = replaceSectionInMarkdown(md, "style-rules", "## Style Rules\n\nNEW RULES")
    expect(out.match(/^## Style Rules/gm)).toHaveLength(1)
    expect(out).toContain("## Content Guidelines\n\nold")
    expect(out).toContain("NEW RULES")
    expect(out).not.toContain("_Unlock to see Style Rules._")
    expect(out).toContain("## Before / After\n\nB")
  })

  it("keeps the --- separator that ended the replaced section", () => {
    const out = replaceSectionInMarkdown(GUIDE, "style-rules", "## Style Rules\n\nRULES")
    expect(out).toContain("## Style Rules\n\nRULES\n\n---\n\n## Before / After")
  })

  it("replaces the last section and keeps earlier ones", () => {
    const out = replaceSectionInMarkdown(GUIDE, "contact", "## Questions?\n\nContact a@b.co")
    expect(out.endsWith("## Questions?\n\nContact a@b.co")).toBe(true)
    expect(out).toContain("## About Acme")
  })

  it("returns the input unchanged for an unknown id", () => {
    expect(replaceSectionInMarkdown(GUIDE, "word-list", "## Word List\n\nx")).toBe(GUIDE)
  })

  it("replaces the single section of heading-less markdown", () => {
    expect(replaceSectionInMarkdown("just text", "content", "new")).toBe("new")
  })
})

describe("getSectionBody", () => {
  it("returns the full body including ### blocks (AI-7)", () => {
    const body = getSectionBody(GUIDE, "brand-voice")
    expect(body).toContain("### 1. Warm")
    expect(body).toContain("### 2. Direct")
    expect(body).not.toContain("Style Rules")
  })

  it("returns an empty string when the section is missing", () => {
    expect(getSectionBody(GUIDE, "word-list")).toBe("")
  })
})

describe("getSectionIdFromHeading", () => {
  it("maps known headings and slugs the rest", () => {
    expect(getSectionIdFromHeading("Before / After")).toBe("examples")
    expect(getSectionIdFromHeading("Get in Touch")).toBe("contact")
    expect(getSectionIdFromHeading("What we care about")).toBe("what-we-care-about")
    expect(getSectionIdFromHeading("!!!")).toBe("section")
  })
})

describe("insertCustomSection", () => {
  it("inserts before Questions and truncates long titles", () => {
    const out = insertCustomSection(GUIDE, "x".repeat(80))
    expect(out).toContain(`## ${"x".repeat(60)}\n\nStart writing here...\n\n## Questions?`)
  })

  it("caps custom sections at 5", () => {
    let md = GUIDE
    for (let i = 0; i < 7; i++) md = insertCustomSection(md, `Custom ${i}`)
    expect(md.match(/^## Custom/gm)).toHaveLength(5)
  })

  it("ignores empty titles", () => {
    expect(insertCustomSection(GUIDE, "   ")).toBe(GUIDE)
  })
})
