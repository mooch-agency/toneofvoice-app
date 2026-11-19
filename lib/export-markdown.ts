/**
 * Markdown preparation for Word/Markdown exports. Pure functions: they never
 * drop user text except whole locked sections and unlock placeholders.
 */
import { STYLE_GUIDE_SECTIONS } from "@/lib/content-parser"
import { hasUnlockPlaceholders, stripUnlockPlaceholders } from "@/lib/guide-placeholders"
import { isUnlocked, type Tier } from "@/lib/tiers"

export interface MarkdownChunk {
  /** 0 for text before the first heading, otherwise the heading level (1 or 2). */
  level: 0 | 1 | 2
  /** Heading text ("" for the preamble). */
  title: string
  /** Raw lines of the chunk, heading line included. */
  lines: string[]
}

const HEADING = /^(#{1,2})\s+(.+?)\s*#*\s*$/
const FENCE = /^\s*(```|~~~)/

/**
 * Split markdown into chunks at H1/H2 headings (ignoring fenced code).
 * `chunks.flatMap(c => c.lines).join("\n")` returns the input unchanged.
 */
export function splitMarkdownSections(markdown: string): MarkdownChunk[] {
  if (!markdown) return []
  const chunks: MarkdownChunk[] = [{ level: 0, title: "", lines: [] }]
  let inFence = false
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence
    const m = inFence ? null : HEADING.exec(line)
    if (m) {
      chunks.push({ level: m[1].length as 1 | 2, title: m[2].trim(), lines: [line] })
    } else {
      chunks[chunks.length - 1].lines.push(line)
    }
  }
  return chunks[0].lines.length === 0 ? chunks.slice(1) : chunks
}

export function joinChunks(chunks: MarkdownChunk[]): string {
  return chunks.flatMap((c) => c.lines).join("\n")
}

/** Minimum tier for a section heading (custom sections are open to all). */
export function sectionMinTier(title: string): Tier {
  return STYLE_GUIDE_SECTIONS.find((s) => s.matchHeading.test(title))?.minTier ?? "starter"
}

function bodyOf(chunk: MarkdownChunk): string {
  return chunk.lines.slice(chunk.level === 0 ? 0 : 1).join("\n")
}

function isPlaceholderOnly(chunk: MarkdownChunk): boolean {
  const body = bodyOf(chunk)
  if (!hasUnlockPlaceholders(body)) return false
  return stripUnlockPlaceholders(body).replace(/^\s*-{3,}\s*$/gm, "").trim() === ""
}

/** Remove sections the tier cannot see. Everything else is kept byte for byte. */
export function filterLockedSections(markdown: string, tier: Tier): string {
  const chunks = splitMarkdownSections(markdown)
  return joinChunks(chunks.filter((c) => c.level === 0 || isUnlocked(tier, sectionMinTier(c.title))))
}

export interface ExportMarkdownOptions {
  brandName: string
  tier: Tier
}

function isTitleHeading(title: string, brandName: string): boolean {
  return (!!brandName && title.includes(brandName)) || /tone of voice guide/i.test(title)
}

/**
 * Markdown body for DOCX/MD exports: locked and placeholder-only sections
 * removed, a leading title H1 removed (the exporter adds a cover), Brand Voice
 * named after the brand and its traits numbered.
 */
export function prepareExportMarkdown(markdown: string, { brandName, tier }: ExportMarkdownOptions): string {
  if (!markdown) return ""
  let chunks = splitMarkdownSections(markdown).filter(
    (c) => c.level === 0 || (isUnlocked(tier, sectionMinTier(c.title)) && !isPlaceholderOnly(c))
  )

  const first = chunks.find((c) => c.level !== 0 || c.lines.some((l) => l.trim()))
  if (first?.level === 1 && isTitleHeading(first.title, brandName)) {
    chunks = chunks.map((c) => (c === first ? { ...c, lines: c.lines.slice(1) } : c))
  }

  chunks = chunks.map((c) => {
    if (c.level !== 2 || !/^Brand Voice/i.test(c.title)) return c
    const heading = brandName ? `## ${brandName} Brand Voice` : c.lines[0]
    let n = 1
    const body = c.lines.slice(1).map((line) => {
      const m = /^###\s+(.+)$/.exec(line)
      if (!m) return line
      if (/^\d+\./.test(m[1])) {
        n++
        return line
      }
      return `### ${n++}. ${m[1]}`
    })
    return { ...c, lines: [heading, ...body] }
  })

  return joinChunks(chunks).replace(/^\s+/, "")
}
