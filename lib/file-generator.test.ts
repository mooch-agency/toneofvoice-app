// @vitest-environment node
import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { generateFile } from "./file-generator"

async function documentXml(markdown: string): Promise<string> {
  const blob = await generateFile("docx", markdown, "Acme")
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  return zip.file("word/document.xml")!.async("string")
}

describe("generateFile docx", () => {
  it("writes numbered lists with a real numbering id", async () => {
    const xml = await documentXml("1. first\n2. second")
    expect(xml).toMatch(/<w:numId w:val="\d+"\/>/)
    expect(xml).not.toContain("{default-numbering")
  })

  it("renders markdown tables as Word tables", async () => {
    const xml = await documentXml("| Use | Instead of |\n|-----|------------|\n| buy | purchase |\n| help | assist |")
    expect(xml).toContain("<w:tbl>")
    expect(xml).not.toContain("|---")
    expect(xml).not.toContain("| Use |")
    expect((xml.match(/<w:tr>/g) ?? []).length).toBe(3)
    expect(xml).toContain("purchase")
  })

  it("keeps text around a table", async () => {
    const xml = await documentXml("Before.\n\n| A | B |\n|---|---|\n| c | d |\n\nAfter.")
    expect(xml).toContain("Before.")
    expect(xml).toContain("After.")
    expect(xml).toContain("<w:tbl>")
  })
})

describe("generateFile md", () => {
  it("puts the cover before the body", async () => {
    const blob = await generateFile("md", "## About\n\nText.", "Acme", { generationDate: "May 1, 2026" })
    const text = await blob.text()
    expect(text.startsWith("# Acme\n")).toBe(true)
    expect(text).toContain("May 1, 2026")
    expect(text.endsWith("## About\n\nText.")).toBe(true)
  })
})
