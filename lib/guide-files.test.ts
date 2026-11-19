import { describe, expect, it } from "vitest"
import { guideFilename, guideSlug, prepareExportClone } from "./guide-files"

describe("guideSlug", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(guideSlug("Acme Co")).toBe("acme-co")
  })

  it("falls back to 'style' for a missing or blank name", () => {
    expect(guideSlug(undefined)).toBe("style")
    expect(guideSlug(null)).toBe("style")
    expect(guideSlug("   ")).toBe("style")
  })

  it("strips characters that are invalid in filenames", () => {
    expect(guideSlug('A/B\\C:D*E?F"G<H>I|J')).toBe("abcdefghij")
  })

  it("collapses repeated separators and trims hyphens", () => {
    expect(guideSlug("  Ben  &  Jerry's  ")).toBe("ben-&-jerry's")
    expect(guideSlug("--Acme--")).toBe("acme")
  })

  it("keeps unicode letters", () => {
    expect(guideSlug("Café Noir")).toBe("café-noir")
  })

  it("falls back when only invalid characters remain", () => {
    expect(guideSlug("/// ***")).toBe("style")
  })
})

describe("guideFilename", () => {
  it("builds the full guide filename", () => {
    expect(guideFilename("Acme Co", "docx")).toBe("acme-co-style-guide.docx")
  })

  it("adds a preview suffix", () => {
    expect(guideFilename("Acme Co", "pdf", { preview: true })).toBe("acme-co-style-guide-preview.pdf")
  })

  it("never throws on a missing name", () => {
    expect(guideFilename(undefined, "md")).toBe("style-style-guide.md")
  })
})

describe("prepareExportClone", () => {
  function source() {
    const root = document.createElement("div")
    root.innerHTML = `
      <section id="a">Open</section>
      <section id="b" data-locked-section>Locked</section>
      <div class="pdf-only" style="display:none">Footer</div>
      <div class="pdf-exclude">Spacer</div>
    `
    return root
  }

  it("removes locked sections, shows pdf-only and hides pdf-exclude", () => {
    const original = source()
    const clone = prepareExportClone(original)

    expect(clone.querySelector("[data-locked-section]")).toBeNull()
    expect((clone.querySelector(".pdf-only") as HTMLElement).style.display).toBe("block")
    expect((clone.querySelector(".pdf-exclude") as HTMLElement).style.display).toBe("none")
    expect(clone.classList.contains("pdf-rendering")).toBe(true)
  })

  it("does not modify the source element", () => {
    const original = source()
    prepareExportClone(original)

    expect(original.querySelector("[data-locked-section]")).not.toBeNull()
    expect((original.querySelector(".pdf-only") as HTMLElement).style.display).toBe("none")
    expect(original.classList.contains("pdf-rendering")).toBe(false)
  })
})
