import { describe, expect, it } from "vitest"
import { PLACEHOLDERS, hasUnlockPlaceholders, stripUnlockPlaceholders } from "./guide-placeholders"

describe("guide placeholders", () => {
  it.each(Object.values(PLACEHOLDERS))("detects %s", (p) => {
    expect(hasUnlockPlaceholders(`## Section\n\n${p}\n`)).toBe(true)
  })

  it("is false for full content and empty input", () => {
    expect(hasUnlockPlaceholders("## Style Rules\n\n### 1. Be clear")).toBe(false)
    expect(hasUnlockPlaceholders(null)).toBe(false)
    expect(hasUnlockPlaceholders(undefined)).toBe(false)
  })

  it("strips placeholder lines and a following rule", () => {
    const md = `## Style Rules\n\n${PLACEHOLDERS.styleRules}\n\n---\n\n## Next\n\nText`
    const out = stripUnlockPlaceholders(md)
    expect(out).not.toContain("Unlock to see")
    expect(out).toContain("## Next")
    expect(out).toContain("Text")
  })
})
