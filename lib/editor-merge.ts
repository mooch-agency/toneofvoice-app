/**
 * Round-trip between the full guide markdown and the single editor, which
 * only holds the sections the user's tier can edit. Locked sections are kept
 * verbatim and put back at their original position.
 */
import { getSectionIdFromHeading, type StyleGuideSection, type Tier } from "@/lib/content-parser"
import { splitMarkdownSections } from "@/lib/export-markdown"

type IsUnlocked = (minTier?: Tier) => boolean

const sectionMarkdown = (s: StyleGuideSection) =>
  `${"#".repeat(s.level === 1 ? 1 : 2)} ${s.title}\n\n${s.content}`.trim()

const contentSections = (sections: StyleGuideSection[]) => sections.filter((s) => s.id !== "cover")

/** Markdown for the editor: `# Brand` followed by every unlocked section in order. */
export function buildEditorMarkdown({
  sections,
  isUnlocked,
  brandName,
}: {
  sections: StyleGuideSection[]
  isUnlocked: IsUnlocked
  brandName: string
}): string {
  const editable = contentSections(sections).filter((s) => isUnlocked(s.minTier))
  return [`# ${brandName}`, ...editable.map(sectionMarkdown)].join("\n\n")
}

export interface MergeResult {
  /** Full guide markdown (no brand H1). */
  content: string
  /** Set only when the editor's H1 holds a new, non-empty brand name. */
  brandName?: string
}

/** Merge the editor's markdown back into the full guide. */
export function mergeEditedMarkdown({
  editorMarkdown,
  sections,
  isUnlocked,
  brandName,
}: {
  editorMarkdown: string
  sections: StyleGuideSection[]
  isUnlocked: IsUnlocked
  brandName: string
}): MergeResult {
  const chunks = splitMarkdownSections(editorMarkdown)

  // The first H1 is the brand name; any text under it stays as preamble.
  let newBrand: string | undefined
  const firstIdx = chunks.findIndex((c) => c.level !== 0 || c.lines.some((l) => l.trim()))
  if (firstIdx !== -1 && chunks[firstIdx].level === 1) {
    const title = chunks[firstIdx].title.trim()
    if (title && title !== brandName) newBrand = title
    chunks[firstIdx] = { level: 0, title: "", lines: chunks[firstIdx].lines.slice(1) }
  }

  const edited = chunks.map((c) => ({
    id: c.level === 0 ? null : getSectionIdFromHeading(c.title),
    text: c.lines.join("\n").trim(),
  }))
  const editedIds = new Set(edited.map((e) => e.id))

  // Anchor each locked section to the next unlocked original section still in the editor.
  const original = contentSections(sections)
  const lockedByAnchor = new Map<string | null, string[]>()
  original.forEach((s, i) => {
    if (isUnlocked(s.minTier)) return
    const anchor = original.slice(i + 1).find((n) => isUnlocked(n.minTier) && editedIds.has(n.id))?.id ?? null
    lockedByAnchor.set(anchor, [...(lockedByAnchor.get(anchor) ?? []), sectionMarkdown(s)])
  })

  const parts: string[] = []
  for (const e of edited) {
    if (e.id && lockedByAnchor.has(e.id)) {
      parts.push(...lockedByAnchor.get(e.id)!)
      lockedByAnchor.delete(e.id)
    }
    parts.push(e.text)
  }
  for (const rest of lockedByAnchor.values()) parts.push(...rest)

  return { content: parts.filter(Boolean).join("\n\n"), ...(newBrand ? { brandName: newBrand } : {}) }
}
