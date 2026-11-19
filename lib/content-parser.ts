import {
  LayoutTemplate,
  Info,
  HelpCircle,
  Megaphone,
  ScrollText,
  ArrowLeftRight,
  Users,
  BookOpen,
  Eraser,
  Mail,
  type LucideIcon
} from "lucide-react"
import type { Tier } from "./tiers"

export type { Tier }

export interface SectionConfig {
  id: string
  label: string
  icon: LucideIcon
  minTier: Tier
  matchHeading: RegExp
}

export const STYLE_GUIDE_SECTIONS: SectionConfig[] = [
  {
    id: 'cover',
    label: 'Cover Page',
    icon: LayoutTemplate,
    minTier: 'starter',
    matchHeading: /^Cover/i // Special case, usually won't match content
  },
  {
    id: 'about',
    label: 'About Brand',
    icon: Info,
    minTier: 'starter',
    matchHeading: /^About/i
  },
  {
    id: 'how-to-use',
    label: 'How to Use',
    icon: HelpCircle,
    minTier: 'starter',
    matchHeading: /^How to Use/i
  },
  {
    id: 'audience',
    label: 'Your Audience',
    icon: Users,
    minTier: 'starter',
    matchHeading: /^Your Audience/i
  },
  {
    id: 'brand-voice',
    label: 'Brand Voice',
    icon: Megaphone,
    minTier: 'starter',
    matchHeading: /^Brand Voice/i
  },
  {
    id: 'style-rules',
    label: 'Style Rules',
    icon: ScrollText,
    minTier: 'pro',
    matchHeading: /^Style Rules/i
  },
  {
    id: 'examples',
    label: 'Before / After',
    icon: ArrowLeftRight,
    minTier: 'pro',
    matchHeading: /^Before.*After/i
  },
  {
    id: 'word-list',
    label: 'Word List',
    icon: BookOpen,
    minTier: 'pro',
    matchHeading: /^Word List/i
  },
  {
    id: 'ai-writing-cleanup',
    label: 'AI Writing Cleanup',
    icon: Eraser,
    minTier: 'starter',
    matchHeading: /^AI Writing Cleanup/i
  },
  {
    id: 'contact',
    label: 'Questions?',
    icon: Mail,
    minTier: 'starter',
    matchHeading: /^(Questions\?|Get in Touch|Contact)/i
  }
]

export interface StyleGuideSection {
  id: string
  title: string
  content: string
  level: number
  isMainSection: boolean
  configId?: string
  icon?: LucideIcon
  minTier?: Tier
}

/** Sections that older guides contain but the app no longer shows. */
const DEPRECATED_HEADING = /^Content Guidelines$/i

/** One H1/H2 section of the markdown, by character offsets. */
interface SectionSpan {
  id: string
  title: string
  level: number
  config?: SectionConfig
  start: number
  contentStart: number
  end: number
}

/**
 * The single heading scanner. Parsing and replacing both use these spans,
 * so skipped (deprecated) sections can never shift indexes (AI-8).
 */
function scanSections(markdown: string): SectionSpan[] {
  const headingRegex = /^(#{1,2})\s+(.+)$/gm
  const found: { level: number; title: string; start: number }[] = []
  let match: RegExpExecArray | null
  while ((match = headingRegex.exec(markdown)) !== null) {
    found.push({ level: match[1].length, title: match[2].trim(), start: match.index })
  }

  return found.map((heading, i) => {
    const lineEnd = markdown.indexOf("\n", heading.start)
    const config = STYLE_GUIDE_SECTIONS.find((c) => c.matchHeading.test(heading.title))
    return {
      ...heading,
      config,
      id: config?.id || generateSectionId(heading.title) || `section-${i}`,
      contentStart: lineEnd === -1 ? markdown.length : lineEnd + 1,
      end: i + 1 < found.length ? found[i + 1].start : markdown.length,
    }
  })
}

/**
 * Parse markdown into sections for the sidebar and editor.
 * Splits on # and ## headings; content stays raw markdown (### blocks included).
 */
export function parseStyleGuideContent(markdown: string): StyleGuideSection[] {
  if (!markdown) return []
  const spans = scanSections(markdown)
  if (spans.length === 0) {
    return [{ id: "content", title: "Style Guide", content: markdown.trim(), level: 2, isMainSection: true, minTier: "starter" }]
  }

  return spans
    .filter((span) => !DEPRECATED_HEADING.test(span.title))
    .map((span) => ({
      id: span.id,
      title: span.title,
      content: markdown.slice(span.contentStart, span.end).trim(),
      level: span.level,
      isMainSection: span.level <= 2,
      configId: span.config?.id,
      icon: span.config?.icon,
      minTier: span.config?.minTier || "starter",
    }))
}

/** Section id for heading text: a known section id or a slug. */
export function getSectionIdFromHeading(title: string): string {
  const config = STYLE_GUIDE_SECTIONS.find((c) => c.matchHeading.test(title))
  if (config) return config.id
  return generateSectionId(title) || "section"
}

function generateSectionId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

/** Body of a section (without its heading), or "" when the section is missing. */
export function getSectionBody(markdown: string, sectionId: string): string {
  if (!markdown) return ""
  const span = scanSections(markdown).find((s) => s.id === sectionId)
  return span ? markdown.slice(span.contentStart, span.end).trim() : ""
}

const TRAILING_RULE = /(^|\n)---\s*$/

/**
 * Replace a whole section (heading + body) with `newContent`.
 * A `---` separator that ended the old section is kept.
 * Returns the input unchanged when the section is not found.
 */
export function replaceSectionInMarkdown(markdown: string, sectionId: string, newContent: string): string {
  if (!markdown || !sectionId) return markdown
  const spans = scanSections(markdown)
  if (spans.length === 0) return sectionId === "content" ? newContent.trim() : markdown

  const span = spans.find((s) => s.id === sectionId)
  return span ? replaceSpan(markdown, span, newContent) : markdown
}

/** Replace a section's body, keeping its heading line and trailing `---`. */
export function replaceSectionBody(markdown: string, sectionId: string, newBody: string): string {
  if (!markdown) return markdown
  const span = scanSections(markdown).find((s) => s.id === sectionId)
  if (!span) return markdown
  const heading = markdown.slice(span.start, span.contentStart).trim()
  return replaceSpan(markdown, span, `${heading}\n\n${newBody.trim()}`)
}

function replaceSpan(markdown: string, span: SectionSpan, newContent: string): string {
  const replacement = newContent.trim()
  const keepRule = TRAILING_RULE.test(markdown.slice(span.start, span.end)) && !TRAILING_RULE.test(replacement)
  const before = markdown.slice(0, span.start)
  const after = markdown.slice(span.end)
  return before + replacement + (keepRule ? "\n\n---" : "") + (after ? "\n\n" + after : "")
}

/**
 * Insert a custom section before the Questions/Contact section.
 * At most 5 custom sections (headings that match no known section); titles capped at 60 chars.
 */
export function insertCustomSection(markdown: string, title: string): string {
  const trimmed = title.trim().slice(0, 60)
  if (!trimmed || !markdown) return markdown

  const customCount = parseStyleGuideContent(markdown).filter((s) => !s.configId).length
  if (customCount >= 5) return markdown

  const newSection = `## ${trimmed}\n\nStart writing here...\n\n`
  const contactMatch = /^## (Questions\?|Get in Touch|Contact)/im.exec(markdown)
  if (contactMatch) {
    return markdown.slice(0, contactMatch.index) + newSection + markdown.slice(contactMatch.index)
  }
  return `${markdown}\n\n${newSection}`
}

/** Editable markdown from the sections the user can see (no cover). */
export function buildEditableMarkdown(sections: StyleGuideSection[], isUnlocked: (minTier?: Tier) => boolean): string {
  const editable = sections.filter((s) => s.id !== "cover" && isUnlocked(s.minTier))
  return editable.map((s) => `## ${s.title}\n\n${s.content}`.trim()).join("\n\n")
}
