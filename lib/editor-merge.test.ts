import { describe, expect, it } from "vitest"
import { parseStyleGuideContent } from "@/lib/content-parser"
import { isUnlocked as tierUnlocked, type Tier } from "@/lib/tiers"
import { buildEditorMarkdown, mergeEditedMarkdown } from "./editor-merge"

const CONTENT = [
  "## About Acme", "", "About text.", "",
  "## Your Audience", "", "Audience text.", "",
  "## How to Use This Document", "", "How text.", "",
  "## Brand Voice", "", "### Bold", "Bold text.", "",
  "## Style Rules", "", "Rules text.", "",
  "## Before / After", "", "Examples text.", "",
  "## Word List", "", "Words text.", "",
  "## AI Writing Cleanup", "", "Cleanup text.", "",
  "## Questions?", "", "Email us.",
].join("\n")

const sections = parseStyleGuideContent(CONTENT)
const unlockedFor = (tier: Tier) => (minTier?: Tier) => tierUnlocked(tier, minTier)
const ids = (md: string) => parseStyleGuideContent(md).map((s) => s.id)

describe("buildEditorMarkdown", () => {
  it("starts with the brand H1 and holds only unlocked sections, in order", () => {
    const md = buildEditorMarkdown({ sections, isUnlocked: unlockedFor("starter"), brandName: "Acme" })
    expect(md.startsWith("# Acme\n\n")).toBe(true)
    expect(ids(md).slice(1)).toEqual(["about", "audience", "how-to-use", "brand-voice", "ai-writing-cleanup", "contact"])
  })

  it("skips the synthetic cover section", () => {
    const withCover = [{ id: "cover", title: "Cover Page", content: "", level: 1, isMainSection: true }, ...sections]
    const md = buildEditorMarkdown({ sections: withCover, isUnlocked: unlockedFor("pro"), brandName: "Acme" })
    expect(md).not.toContain("Cover Page")
  })
})

describe("mergeEditedMarkdown", () => {
  it("keeps the original section order on an unchanged round trip (starter)", () => {
    const isUnlocked = unlockedFor("starter")
    const editorMarkdown = buildEditorMarkdown({ sections, isUnlocked, brandName: "Acme" })
    const { content } = mergeEditedMarkdown({ editorMarkdown, sections, isUnlocked, brandName: "Acme" })
    expect(ids(content)).toEqual(sections.map((s) => s.id))
  })

  it("keeps the original section order on an unchanged round trip (pro)", () => {
    const isUnlocked = unlockedFor("pro")
    const editorMarkdown = buildEditorMarkdown({ sections, isUnlocked, brandName: "Acme" })
    const { content } = mergeEditedMarkdown({ editorMarkdown, sections, isUnlocked, brandName: "Acme" })
    expect(ids(content)).toEqual(sections.map((s) => s.id))
  })

  it("updates an edited unlocked section in place and keeps locked ones verbatim", () => {
    const isUnlocked = unlockedFor("starter")
    const editorMarkdown = buildEditorMarkdown({ sections, isUnlocked, brandName: "Acme" }).replace(
      "About text.",
      "New about text."
    )
    const { content } = mergeEditedMarkdown({ editorMarkdown, sections, isUnlocked, brandName: "Acme" })
    const parsed = parseStyleGuideContent(content)
    expect(parsed.find((s) => s.id === "about")?.content).toBe("New about text.")
    expect(parsed.find((s) => s.id === "style-rules")?.content).toBe("Rules text.")
    expect(parsed.find((s) => s.id === "word-list")?.content).toBe("Words text.")
  })

  it("puts locked sections back before the next unlocked section that still exists", () => {
    const isUnlocked = unlockedFor("starter")
    const editorMarkdown = buildEditorMarkdown({ sections, isUnlocked, brandName: "Acme" }).replace(
      "## AI Writing Cleanup\n\nCleanup text.\n\n",
      ""
    )
    const { content } = mergeEditedMarkdown({ editorMarkdown, sections, isUnlocked, brandName: "Acme" })
    expect(ids(content)).toEqual([
      "about", "audience", "how-to-use", "brand-voice", "style-rules", "examples", "word-list", "contact",
    ])
  })

  it("appends locked sections when no later unlocked section remains", () => {
    const isUnlocked = unlockedFor("starter")
    const { content } = mergeEditedMarkdown({
      editorMarkdown: "# Acme\n\n## About Acme\n\nOnly this.",
      sections,
      isUnlocked,
      brandName: "Acme",
    })
    expect(ids(content)).toEqual(["about", "style-rules", "examples", "word-list"])
  })

  it("contains 'Questions?' exactly once", () => {
    const isUnlocked = unlockedFor("starter")
    const editorMarkdown = buildEditorMarkdown({ sections, isUnlocked, brandName: "Acme" })
    const { content } = mergeEditedMarkdown({ editorMarkdown, sections, isUnlocked, brandName: "Acme" })
    expect(content.match(/## Questions\?/g)).toHaveLength(1)
  })

  it("strips the leading H1 and reports a changed brand name", () => {
    const isUnlocked = unlockedFor("pro")
    const editorMarkdown = buildEditorMarkdown({ sections, isUnlocked, brandName: "Acme" }).replace("# Acme", "# Acme Corp")
    const result = mergeEditedMarkdown({ editorMarkdown, sections, isUnlocked, brandName: "Acme" })
    expect(result.content).not.toMatch(/^# /m)
    expect(result.brandName).toBe("Acme Corp")
  })

  it("does not report an unchanged or empty brand name", () => {
    const isUnlocked = unlockedFor("pro")
    const same = mergeEditedMarkdown({ editorMarkdown: "# Acme\n\n## About\n\nx", sections, isUnlocked, brandName: "Acme" })
    expect(same.brandName).toBeUndefined()
    const empty = mergeEditedMarkdown({ editorMarkdown: "#  \n\n## About\n\nx", sections, isUnlocked, brandName: "Acme" })
    expect(empty.brandName).toBeUndefined()
  })
})
