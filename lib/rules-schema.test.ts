// @vitest-environment node
import { describe, expect, it } from "vitest"
import { ALLOWED_RULE_CATEGORIES, canonicalRuleCategory, validateRules } from "./rules-schema"
import { renderRulesMarkdown, sanitizeRuleText } from "./rules-renderer"

const rule = (over: Record<string, unknown> = {}) => ({
  category: "Contractions",
  title: "Contractions",
  description: "Use contractions to sound warm.",
  examples: { good: "We're here.", bad: "We are here." },
  ...over,
})

describe("canonicalRuleCategory", () => {
  it.each([
    ["capitalization", "Capitalisation"],
    [" Emojis ", "Emojis"],
    ["Active vs Passive Voice", "Active vs. Passive Voice"],
    ["uk vs us english", "UK vs. US English"],
    ["Title case vs. sentence case", "Title Case vs. Sentence Case"],
    ["Time & Time Zones", "Time and Time Zones"],
    ["Active versus passive voice", "Active vs. Passive Voice"],
    ["Made up", null],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalRuleCategory(input)).toBe(expected)
  })

  it("maps every allowed category to itself", () => {
    for (const c of ALLOWED_RULE_CATEGORIES) expect(canonicalRuleCategory(c)).toBe(c)
  })
})

describe("validateRules", () => {
  it.each(["capitalization", " Emojis ", "Active vs Passive Voice"])("accepts %s and canonicalises", (c) => {
    const { valid } = validateRules([rule({ category: c })])
    expect(valid).toHaveLength(1)
    expect(ALLOWED_RULE_CATEGORIES).toContain(valid[0].category)
  })

  it("skips null, strings and malformed rules instead of throwing", () => {
    const { valid, invalid } = validateRules([
      null,
      "rule",
      42,
      rule({ examples: null }),
      rule({ description: 5 }),
      rule({ examples: { good: "x" } }),
      rule(),
    ])
    expect(valid).toHaveLength(1)
    expect(invalid).toHaveLength(6)
  })

  it("dedupes categories after canonicalisation", () => {
    const { valid } = validateRules([rule({ category: "Capitalisation" }), rule({ category: "capitalization" })])
    expect(valid).toHaveLength(1)
  })

  it("falls back to the category as title when the title is missing", () => {
    const { valid } = validateRules([rule({ title: "" })])
    expect(valid[0].title).toBe("Contractions")
  })

  it("rejects unknown categories", () => {
    expect(validateRules([rule({ category: "Tone" })]).valid).toHaveLength(0)
  })

  it("returns an empty result for non-arrays", () => {
    expect(validateRules(undefined)).toEqual({ valid: [], invalid: [] })
  })
})

describe("sanitizeRuleText", () => {
  it("fixes model quirks", () => {
    expect(sanitizeRuleText("At 10: 00 am")).toBe("At 10:00 am")
    expect(sanitizeRuleText('Click"Mark as duplicate"')).toBe('Click "Mark as duplicate"')
    expect(sanitizeRuleText("a�b​c")).toBe("abc")
    expect(sanitizeRuleText("line\n\nbreak")).toBe("line break")
  })
})

describe("renderRulesMarkdown", () => {
  it("renders title, description and italic examples per rule", () => {
    const md = renderRulesMarkdown([
      rule({ title: "Time", description: "Write times as 10:00 am. See https://a.com", examples: { good: "Join us at 10:00 am GMT.", bad: "Wait . . . what?" } }),
    ])
    expect(md).toBe(
      "### 1. Time\nWrite times as 10:00 am. See https://a.com\n✅ *Join us at 10:00 am GMT.*\n❌ *Wait . . . what?*",
    )
  })

  it("escapes asterisks inside examples so italics stay intact", () => {
    const md = renderRulesMarkdown([rule({ examples: { good: "Save *now*", bad: "x" } })])
    expect(md).toContain("✅ *Save \\*now\\**")
  })

  it("separates rules with a blank line and never emits H1/H2", () => {
    const md = renderRulesMarkdown([rule(), rule({ title: "Numbers", description: "20 words or fewer per sentence." })])
    expect(md.split("\n\n")).toHaveLength(2)
    expect(md).not.toMatch(/^#{1,2} /m)
  })

  it("returns an empty string for no rules", () => {
    expect(renderRulesMarkdown([])).toBe("")
  })
})
