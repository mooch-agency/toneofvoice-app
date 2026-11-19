import "server-only"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { traceable } from "langsmith/traceable"
import type { BrandDetails } from "./brand-input"
import { getSectionBody, replaceSectionBody } from "./content-parser"
import { PLACEHOLDERS } from "./guide-placeholders"
import Logger from "./logger"
import {
  generateAudienceSection,
  generateBeforeAfterSamples,
  generateBrandVoiceTraits,
  generateStyleRules,
  generateWordList,
  type GenerateOptions,
  type GenerationResult,
} from "./openai"

/** Section ids (content-parser) of generated sections. */
export type GeneratedSectionId = "brand-voice" | "audience" | "style-rules" | "examples" | "word-list"

export interface RenderResult {
  markdown: string
  /** Sections whose generation failed. Paid sections keep their unlock placeholder. */
  failedSections: GeneratedSectionId[]
}

interface PaidSection {
  id: "style-rules" | "examples" | "word-list"
  placeholder: string
  generate: (details: BrandDetails, traitsContext: string | undefined, opts: GenerateOptions) => Promise<GenerationResult>
}

const PAID_SECTIONS: PaidSection[] = [
  { id: "style-rules", placeholder: PLACEHOLDERS.styleRules, generate: generateStyleRules },
  { id: "examples", placeholder: PLACEHOLDERS.beforeAfter, generate: generateBeforeAfterSamples },
  { id: "word-list", placeholder: PLACEHOLDERS.wordList, generate: generateWordList },
]

const TEMPLATE_PATH = path.join(process.cwd(), "templates", "style_guide_template.md")
let templateCache: string | undefined

/** The guide template, read from disk once (the build traces templates/ into the routes). */
export async function loadTemplate(): Promise<string> {
  templateCache ??= await readFile(TEMPLATE_PATH, "utf8")
  return templateCache
}

/**
 * Replace `{{key}}` placeholders in one pass. Values are inserted literally
 * (no `$&`/`$'` patterns, AI-18) and are not rescanned. Unknown keys stay.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  )
}

const TRAITS_CONTEXT_LIMIT = 4000

/** Selected trait names plus the Brand Voice section of a guide, for the paid-section prompts (AI-7). */
export function extractTraitsContext(markdown: string, traitNames: string[]): string | undefined {
  const parts = [traitNames.length ? `Selected Traits: ${traitNames.join(", ")}` : "", getSectionBody(markdown, "brand-voice")]
  const context = parts.filter(Boolean).join("\n\n").slice(0, TRAITS_CONTEXT_LIMIT)
  return context || undefined
}

/** Body of the "Questions?" section. */
export function contactSection(brandName: string, userEmail?: string | null): string {
  const intro = `Need help applying these guidelines? Have questions about ${brandName}'s voice?`
  const email = userEmail?.trim()
  return email ? `${intro}\n\n**Contact:** ${email}` : `${intro}\n\nContact the ${brandName} content team.`
}

/** Generate the paid sections in parallel. Failed ones keep their placeholder. */
async function generatePaidSections(
  sections: PaidSection[],
  details: BrandDetails,
  traitsContext: string | undefined,
  opts: GenerateOptions,
): Promise<{ content: Record<string, string>; failed: GeneratedSectionId[] }> {
  const results = await Promise.all(sections.map((s) => s.generate(details, traitsContext, opts)))
  const content: Record<string, string> = {}
  const failed: GeneratedSectionId[] = []
  sections.forEach((section, i) => {
    const result = results[i]
    if (result.success && result.content) {
      content[section.id] = result.content
    } else {
      content[section.id] = section.placeholder
      failed.push(section.id)
    }
  })
  return { content, failed }
}

function logFailures(operation: string, failed: GeneratedSectionId[]) {
  if (failed.length) Logger.warn("Guide sections failed to generate", { operation, failed })
}

/**
 * Render a new guide from the template.
 * Preview (starter): Brand Voice and Audience; paid sections are locked placeholders.
 * Full (paid): all sections.
 */
export const renderStyleGuideTemplate = traceable(
  async function renderStyleGuideTemplate({
    brandDetails,
    isPreview,
    userEmail,
    signal,
  }: {
    brandDetails: BrandDetails
    isPreview: boolean
    userEmail?: string | null
    signal?: AbortSignal
  }): Promise<RenderResult> {
    const opts: GenerateOptions = { signal }

    // Audience does not depend on the traits, so it runs alongside them.
    const audiencePromise = generateAudienceSection(brandDetails, opts)
    const traitsResult = await generateBrandVoiceTraits(brandDetails, opts)
    const brandVoice = traitsResult.content ?? ""

    let paid: Record<string, string> = Object.fromEntries(PAID_SECTIONS.map((s) => [s.id, s.placeholder]))
    let paidFailed: GeneratedSectionId[] = []
    if (!isPreview) {
      const traitsContext = extractTraitsContext(`## Brand Voice\n\n${brandVoice}`, brandDetails.traits)
      const generated = await generatePaidSections(PAID_SECTIONS, brandDetails, traitsContext, opts)
      paid = generated.content
      paidFailed = generated.failed
    }

    const audienceResult = await audiencePromise
    const failed: GeneratedSectionId[] = [
      ...(traitsResult.success ? [] : (["brand-voice"] as const)),
      ...(audienceResult.success ? [] : (["audience"] as const)),
      ...paidFailed,
    ]

    const markdown = fillTemplate(await loadTemplate(), {
      brand_name: brandDetails.name,
      brand_description: brandDetails.brandDetailsDescription,
      audience_section: audienceResult.content ?? "",
      brand_voice_traits: brandVoice,
      style_rules: paid["style-rules"],
      before_after_examples: paid.examples,
      word_list: paid["word-list"],
      contact_section: contactSection(brandDetails.name, userEmail),
    }).trim()

    logFailures(isPreview ? "preview" : "full", failed)
    return { markdown, failedSections: failed }
  },
  { name: "renderStyleGuideTemplate", run_type: "chain" },
)

/**
 * Upgrade a preview: generate only the paid sections that are still locked
 * and merge them into the existing guide. Everything else is kept as the user
 * saw (or edited) it. Failed sections keep their placeholder (AI-6).
 */
export const renderFullGuideFromPreview = traceable(
  async function renderFullGuideFromPreview({
    previewContent,
    brandDetails,
    userEmail,
    signal,
  }: {
    previewContent: string
    brandDetails: BrandDetails
    userEmail?: string | null
    signal?: AbortSignal
  }): Promise<RenderResult> {
    const locked = PAID_SECTIONS.filter((s) => getSectionBody(previewContent, s.id).includes(s.placeholder))
    const traitsContext = extractTraitsContext(previewContent, brandDetails.traits)
    const { content, failed } = await generatePaidSections(locked, brandDetails, traitsContext, { signal })

    let merged = previewContent
    for (const section of locked) {
      if (failed.includes(section.id)) continue
      const body = getSectionBody(merged, section.id).replace(section.placeholder, () => content[section.id])
      merged = replaceSectionBody(merged, section.id, body)
    }
    // Fill in the user's email only while the contact section is still our
    // default text; never overwrite contact details the user wrote.
    const norm = (t: string) => t.replace(/\s+/g, " ").trim()
    const currentContact = norm(getSectionBody(merged, "contact"))
    const defaults = [contactSection(brandDetails.name, null), contactSection(brandDetails.name, userEmail)].map(norm)
    if (defaults.includes(currentContact)) {
      merged = replaceSectionBody(merged, "contact", contactSection(brandDetails.name, userEmail))
    }

    logFailures("expand", failed)
    return { markdown: merged, failedSections: failed }
  },
  { name: "renderFullGuideFromPreview", run_type: "chain" },
)
