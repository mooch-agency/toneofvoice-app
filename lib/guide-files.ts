/** Filename and DOM helpers shared by every guide export. */

const INVALID_FILENAME_CHARS = /[/\\:*?"<>|]/g

/** URL- and filename-safe slug for a brand name. Never throws; blank names become "style". */
export function guideSlug(name: string | null | undefined): string {
  const slug = (name ?? "")
    .replace(INVALID_FILENAME_CHARS, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "style"
}

export type GuideFileExtension = "pdf" | "docx" | "md" | "zip"

/** e.g. `acme-co-style-guide.docx`, or `acme-co-style-guide-preview.pdf` for previews. */
export function guideFilename(
  name: string | null | undefined,
  ext: GuideFileExtension,
  { preview = false }: { preview?: boolean } = {}
): string {
  return `${guideSlug(name)}-style-guide${preview ? "-preview" : ""}.${ext}`
}

/**
 * Deep-clone the rendered guide for PDF export: drop locked sections, show
 * `.pdf-only` blocks, hide `.pdf-exclude` blocks. The source is left untouched.
 */
export function prepareExportClone(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement
  clone.classList.add("pdf-rendering")
  clone.querySelectorAll("[data-locked-section]").forEach((el) => el.remove())
  clone.querySelectorAll<HTMLElement>(".pdf-only").forEach((el) => (el.style.display = "block"))
  clone.querySelectorAll<HTMLElement>(".pdf-exclude").forEach((el) => (el.style.display = "none"))
  return clone
}
