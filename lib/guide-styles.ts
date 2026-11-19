// Design system: see DESIGN_SYSTEM.md for full typography/spacing decisions and Edit → Preview mapping.
// Single source of truth for all style guide typography and spacing (this file is what the code uses).
// If you change any PREVIEW_* or EDITOR_* tokens here, update the mapping table in DESIGN_SYSTEM.md.
// Preview variants: larger, more premium, generous spacing
// Editor variants: slightly more compact, functional, still readable

import type { CSSProperties } from "react"
import { getSectionIdFromHeading } from "./content-parser"

// Shared serif font style (used by both preview and editor)
const SERIF_FONT_STYLE: CSSProperties = {
  fontFamily: "var(--font-display), serif",
  letterSpacing: "-0.02em",
}

// ============================================================================
// PREVIEW MODE STYLES (Premium, generous, magazine-like)
// ============================================================================

// H1 - Cover page title (very large)
export const PREVIEW_H1_CLASS = "text-5xl md:text-6xl font-bold tracking-tight text-gray-900 leading-[0.95]"
export const PREVIEW_H1_STYLE: CSSProperties = {
  ...SERIF_FONT_STYLE,
}

// H2 - Section headings (large, premium)
export const PREVIEW_H2_CLASS = "text-5xl md:text-6xl font-bold tracking-tight text-gray-900 leading-[1.1] text-balance"
export const PREVIEW_H2_STYLE: CSSProperties = {
  ...SERIF_FONT_STYLE,
}

// H3 - Subsection headings (medium-large, serif)
export const PREVIEW_H3_CLASS = "text-2xl md:text-3xl font-bold text-gray-900 text-balance"
export const PREVIEW_H3_STYLE: CSSProperties = {
  ...SERIF_FONT_STYLE,
  hyphens: "none",
  wordBreak: "keep-all",
}

// H4 - Sub-subsection headings
export const PREVIEW_H4_CLASS = "text-lg font-medium text-gray-700"

// Eyebrow label (like "BRAND IDENTITY SYSTEM" on cover) — gray-600 for WCAG AA at 12px
export const PREVIEW_EYEBROW_CLASS = "text-xs font-medium uppercase tracking-widest text-gray-600"

// Body text - generous line height for readability
export const PREVIEW_BODY_CLASS = "text-base md:text-lg leading-relaxed text-gray-600 text-pretty"
export const PREVIEW_BODY_STYLE: CSSProperties = {
  orphans: 2,
  widows: 2,
}

// Lists
export const PREVIEW_LIST_CLASS = "text-base md:text-lg leading-relaxed text-gray-600"
export const PREVIEW_LIST_ITEM_CLASS = "leading-relaxed"

// Blockquote
export const PREVIEW_BLOCKQUOTE_CLASS = "border-l-4 border-gray-200 pl-4 italic text-gray-600"

// Horizontal rule
export const PREVIEW_HR_CLASS = "border-gray-200"

// Decorative bar under H2 (matches cover page aesthetic)
export const PREVIEW_H2_BAR_CLASS = "h-1 w-24 bg-gray-900 rounded-full"

// Section description (explainer text below H2) — gray-600 passes WCAG AA; italic removed since small+italic+light is a compound readability hit
export const PREVIEW_SECTION_DESCRIPTION_CLASS = "text-sm text-gray-600"

// Spacing tokens
export const PREVIEW_H2_MARGIN_TOP = "mt-24" // Generous spacing above sections
export const PREVIEW_H2_MARGIN_BOTTOM = "mb-8"
export const PREVIEW_H3_MARGIN_TOP = "mt-12"
export const PREVIEW_H3_MARGIN_BOTTOM = "mb-5"
export const PREVIEW_P_MARGIN_BOTTOM = "mb-5"
export const PREVIEW_LIST_MARGIN_BOTTOM = "mb-6"
export const PREVIEW_HR_MARGIN = "my-12"

// ============================================================================
// EDITOR MODE STYLES (Functional, slightly more compact)
// ============================================================================

// H1 - Editor title
export const EDITOR_H1_CLASS = "text-5xl md:text-6xl font-bold tracking-tight leading-[0.95] text-gray-900 border-b border-gray-200"
export const EDITOR_H1_STYLE: CSSProperties = {
  ...SERIF_FONT_STYLE,
}

// H2 - Editor section headings (smaller than preview to signal "editable")
export const EDITOR_H2_CLASS = "text-3xl md:text-4xl font-bold tracking-tight leading-[1.1] text-gray-900"
export const EDITOR_H2_STYLE: CSSProperties = {
  ...SERIF_FONT_STYLE,
}

// H3 - Editor subsection headings (must include serif - currently missing!)
export const EDITOR_H3_CLASS = "text-xl md:text-2xl font-bold tracking-tight text-gray-900"
export const EDITOR_H3_STYLE: CSSProperties = {
  ...SERIF_FONT_STYLE,
}

// H4 - Editor sub-subsection headings
export const EDITOR_H4_CLASS = "text-lg font-semibold tracking-tight text-gray-800"

// Decorative bar under H2 in editor (same as preview for consistency)
export const EDITOR_H2_BAR_CLASS = "h-1 w-16 bg-gray-900 rounded-full"

// Spacing tokens for editor
export const EDITOR_H1_MARGIN_TOP = "mt-8"
export const EDITOR_H1_MARGIN_BOTTOM = "mb-4"
export const EDITOR_H2_MARGIN_TOP = "mt-16"
export const EDITOR_H2_MARGIN_BOTTOM = "mb-6"
export const EDITOR_H3_MARGIN_TOP = "mt-10"
export const EDITOR_H3_MARGIN_BOTTOM = "mb-4"
export const EDITOR_H4_MARGIN_TOP = "mt-6"
export const EDITOR_H4_MARGIN_BOTTOM = "mb-2"

// ============================================================================
// SECTION LABELS (keyed by content-parser section id, so headings are matched in one place)
// ============================================================================

const SECTION_COPY: Record<string, { eyebrow: string; description?: string }> = {
  about: { eyebrow: "BRAND OVERVIEW" },
  "how-to-use": { eyebrow: "USAGE GUIDE" },
  audience: { eyebrow: "WHO YOU'RE WRITING FOR", description: "Who we write for and how to address them." },
  "content-guidelines": { eyebrow: "FOUNDATION", description: "Guardrails for short-form, long-form, and product copy." },
  "brand-voice": {
    eyebrow: "BRAND IDENTITY",
    description: "The core character of our brand that defines the dos and don'ts of our personality.",
  },
  "style-rules": { eyebrow: "STYLE RULES", description: "Rules that support our brand voice across every channel." },
  examples: { eyebrow: "EXAMPLES", description: "Real examples that show our guidelines in action." },
  "word-list": { eyebrow: "TERMINOLOGY", description: "Preferred terms, words to avoid, and spelling conventions." },
}

const sectionCopy = (headingText: string) => SECTION_COPY[getSectionIdFromHeading(headingText.trim())]

/** Section explainer copy: first person plural, informational. Preview only (not in editor). */
export function getSectionDescription(headingText: string): string | null {
  return sectionCopy(headingText)?.description ?? null
}

/** Eyebrow label for a section (uppercase category label like "BRAND IDENTITY"). */
export function getSectionEyebrow(headingText: string): string | null {
  return sectionCopy(headingText)?.eyebrow ?? null
}
