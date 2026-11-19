// @vitest-environment node
import { describe, expect, it } from "vitest"
import { demoteSectionHeadings, formatTraitMarkdown, normalizeMarkdown } from "./markdown-format"

const RAW_TRAITS = `### 1. Warm

Warm means speaking to busy parents with empathy and care.

***What It Means***

→Use friendly greetings in every message
→ Acknowledge feelings before giving advice
→   Use contractions to sound natural



***What It Doesn't Mean***

✗ Overly gushing praise
✗Ignoring facts for feelings
✗ Slang that excludes readers
### 2. Direct
Direct means clear statements at 10:00 am, see https://acme.com/help... really.
**What It Means**
→ Lead with the answer
**What It Doesn't Mean**
✗ Being blunt or rude`

const EXPECTED = `### 1. Warm

Warm means speaking to busy parents with empathy and care.

#### What It Means

→ Use friendly greetings in every message
→ Acknowledge feelings before giving advice
→ Use contractions to sound natural

#### What It Doesn't Mean

✗ Overly gushing praise
✗ Ignoring facts for feelings
✗ Slang that excludes readers

### 2. Direct

Direct means clear statements at 10:00 am, see https://acme.com/help... really.

#### What It Means

→ Lead with the answer

#### What It Doesn't Mean

✗ Being blunt or rude`

describe("formatTraitMarkdown", () => {
  it("normalises trait blocks into headings, items and blank lines", () => {
    expect(formatTraitMarkdown(RAW_TRAITS)).toBe(EXPECTED)
  })

  it("is idempotent", () => {
    expect(formatTraitMarkdown(EXPECTED)).toBe(EXPECTED)
  })

  it("never changes times, URLs, ratios or ellipses (AI-5)", () => {
    const out = formatTraitMarkdown("### 1. Clear\n\nUse 10:00 am, 3:2 ratios and https://a.com/x?y=1. Wait... what ?")
    expect(out).toContain("10:00 am")
    expect(out).toContain("3:2")
    expect(out).toContain("https://a.com/x?y=1")
    expect(out).toContain("Wait... what ?")
  })

  it("never introduces H2 headings, even for lines starting with a number", () => {
    const out = formatTraitMarkdown("### 1. Warm\n\n20 words or fewer keeps every sentence easy to scan.\n1. Not a heading")
    expect(out).not.toMatch(/^#{1,2} /m)
  })

  it("demotes H1/H2 headings from the model so they cannot split guide sections", () => {
    const out = formatTraitMarkdown("## Brand Voice\n\n# Warm\n\nText")
    expect(out).toBe("### Brand Voice\n\n### Warm\n\nText")
  })

  it("returns an empty string for empty input", () => {
    expect(formatTraitMarkdown("")).toBe("")
    expect(formatTraitMarkdown(undefined)).toBe("")
  })
})

describe("normalizeMarkdown", () => {
  it("collapses blank lines and trims each line", () => {
    expect(normalizeMarkdown("  ### Overview  \n\n\n\n  Text here.  \n")).toBe("### Overview\n\nText here.")
  })

  it("keeps punctuation and URLs intact and demotes section headings", () => {
    expect(normalizeMarkdown("## Primary\nSee https://x.co at 9:30.")).toBe("### Primary\nSee https://x.co at 9:30.")
  })
})

describe("demoteSectionHeadings", () => {
  it("turns # and ## into ### and leaves deeper headings alone", () => {
    expect(demoteSectionHeadings("# A\n## B\n### C\n#### D\n#hashtag")).toBe("### A\n### B\n### C\n#### D\n#hashtag")
  })
})
