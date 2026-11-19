import { describe, expect, it } from "vitest"
import { filterLockedSections, prepareExportMarkdown } from "./export-markdown"

const GUIDE = [
  "## About Acme",
  "",
  "We keep every message clear and consistent across channels.",
  "Read our essential guide to onboarding.",
  "March 3, 2025 was our launch day.",
  "",
  "---",
  "",
  "## Brand Voice",
  "",
  "### Bold",
  "Bold text.",
  "",
  "### 2. Warm",
  "Warm text.",
  "",
  "---",
  "",
  "## Style Rules",
  "",
  "Rule one.",
  "",
  "## Before / After",
  "",
  "Example.",
  "",
  "## Word List",
  "",
  "| Use | Instead of |",
  "|-----|------------|",
  "| buy | purchase |",
  "",
  "## AI Writing Cleanup",
  "",
  "### Remove filler",
  "Cleanup text.",
  "",
  "## Questions?",
  "",
  "Email us.",
].join("\n")

describe("filterLockedSections", () => {
  it("drops pro sections for starter users", () => {
    const out = filterLockedSections(GUIDE, "starter")
    expect(out).not.toContain("## Style Rules")
    expect(out).not.toContain("## Before / After")
    expect(out).not.toContain("## Word List")
    expect(out).toContain("## AI Writing Cleanup")
    expect(out).toContain("## Questions?")
  })

  it.each(["pro", "agency"] as const)("keeps every section for %s", (tier) => {
    expect(filterLockedSections(GUIDE, tier)).toBe(GUIDE)
  })

  it("keeps section order", () => {
    const out = filterLockedSections(GUIDE, "starter")
    const headings = out.split("\n").filter((l) => l.startsWith("## "))
    expect(headings).toEqual(["## About Acme", "## Brand Voice", "## AI Writing Cleanup", "## Questions?"])
  })

  it("keeps preamble text before the first heading", () => {
    const out = filterLockedSections("Intro line.\n\n## Style Rules\n\nRule.", "starter")
    expect(out).toContain("Intro line.")
    expect(out).not.toContain("Rule.")
  })

  it("does not turn an H1 into an H2", () => {
    const out = filterLockedSections("# Acme\n\nIntro.\n\n## About\n\nText.", "starter")
    expect(out).toMatch(/^# Acme$/m)
    expect(out).not.toContain("## Acme")
  })

  it("returns an empty string for empty input", () => {
    expect(filterLockedSections("", "starter")).toBe("")
  })
})

describe("prepareExportMarkdown", () => {
  const opts = { brandName: "Acme", tier: "starter" as const }

  it("keeps lines that mention 'clear and consistent' or 'essential guide'", () => {
    const out = prepareExportMarkdown(GUIDE, opts)
    expect(out).toContain("We keep every message clear and consistent across channels.")
    expect(out).toContain("Read our essential guide to onboarding.")
  })

  it("keeps date sentences inside sections", () => {
    expect(prepareExportMarkdown(GUIDE, opts)).toContain("March 3, 2025 was our launch day.")
  })

  it("names the brand voice section after the brand, idempotently", () => {
    const once = prepareExportMarkdown(GUIDE, opts)
    expect(once).toContain("## Acme Brand Voice")
    expect(once).not.toMatch(/^## Brand Voice$/m)
    expect(prepareExportMarkdown(once, opts)).toBe(once)
  })

  it("numbers brand voice traits and leaves numbered ones alone", () => {
    const out = prepareExportMarkdown(GUIDE, opts)
    expect(out).toContain("### 1. Bold")
    expect(out).toContain("### 2. Warm")
    expect(out).not.toContain("### 2. 2. Warm")
  })

  it("does not number H3s outside the brand voice section", () => {
    expect(prepareExportMarkdown(GUIDE, opts)).toContain("### Remove filler")
  })

  it("drops a leading title H1 (the export adds its own cover)", () => {
    const out = prepareExportMarkdown("# Acme Tone of Voice Guide\n\n## About\n\nText.", opts)
    expect(out).not.toContain("# Acme Tone of Voice Guide")
    expect(out).toContain("## About")
  })

  it("keeps an H1 that is not the guide title", () => {
    const out = prepareExportMarkdown("## About\n\nText.\n\n# Appendix\n\nMore.", opts)
    expect(out).toContain("# Appendix")
  })

  it("drops sections that only hold an unlock placeholder", () => {
    const md = "## About\n\nText.\n\n## Style Rules\n\n_Unlock to see Style Rules._\n\n---\n\n## Questions?\n\nAsk."
    const out = prepareExportMarkdown(md, { brandName: "Acme", tier: "pro" })
    expect(out).not.toContain("Style Rules")
    expect(out).not.toContain("_Unlock to see")
    expect(out).toContain("## Questions?")
  })

  it("returns an empty string for empty input", () => {
    expect(prepareExportMarkdown("", opts)).toBe("")
  })
})
