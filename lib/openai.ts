import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions"
import Logger from "./logger"
import { getOpenAIClient } from "./langsmith-openai"
import { parseJsonResponse, stripOuterFence } from "./llm-json"
import { formatTraitMarkdown, normalizeMarkdown } from "./markdown-format"
import { getAllowedCategoriesPromptText, validateRules } from "./rules-schema"
import { renderRulesMarkdown } from "./rules-renderer"
import { TRAIT_NAMES, parseTraitSuggestions, traitNames } from "./traits"

export interface GenerationResult {
  success: boolean
  content?: string
  error?: string
}

export type ResponseFormat = "json" | "markdown"
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

export interface GenerateOptions {
  /** Deadline shared by all calls of one request. */
  signal?: AbortSignal
}

/** Brand fields the section prompts read. Extra fields are ignored. */
export interface BrandPromptDetails {
  name?: string
  brandDetailsDescription?: string
  audience?: string
  traits?: unknown
  keywords?: unknown
  productsServices?: unknown
  formalityLevel?: string
  readingLevel?: string
  englishVariant?: string
}

const DEFAULT_MODEL = "gpt-5.2"
const NO_EM_DASH = "IMPORTANT: Never use em dashes (—) in your output. Use hyphens (-) or rewrite sentences instead."

// ---------------------------------------------------------------------------
// Core completion: one shared client, JSON mode, truncation check and a single
// content-validation retry. Transport retries (429/5xx/timeouts) are left to
// the SDK, which backs off (see langsmith-openai.ts).
// ---------------------------------------------------------------------------

type Checked = { ok: true; content: string } | { ok: false; error: string }
type Check = (raw: string) => Checked

interface CompletionSpec {
  prompt: string
  system: string
  format: ResponseFormat
  maxTokens: number
  model?: string
  effort?: ReasoningEffort
  /** Validate and transform the raw text. A failed check triggers the one retry. */
  check?: Check
  signal?: AbortSignal
}

const MAX_ATTEMPTS = 2

function buildRequest(spec: CompletionSpec, maxTokens: number): ChatCompletionCreateParamsNonStreaming {
  const model = spec.model ?? DEFAULT_MODEL
  const request: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: spec.system },
      { role: "user", content: spec.prompt },
    ],
  }
  if (model.startsWith("gpt-5")) {
    request.max_completion_tokens = maxTokens
    request.reasoning_effort = spec.effort ?? "medium"
  } else {
    request.max_tokens = maxTokens
    request.temperature = 0.4
  }
  if (spec.format === "json") request.response_format = { type: "json_object" }
  return request as unknown as ChatCompletionCreateParamsNonStreaming
}

const checkMarkdown: Check = (raw) => {
  const content = stripOuterFence(raw).normalize("NFC")
  return content ? { ok: true, content } : { ok: false, error: "Empty response" }
}

/** JSON check: parse, then let `toContent` validate the shape (null = invalid). */
function jsonCheck(toContent: (value: unknown) => string | null): Check {
  return (raw) => {
    const parsed = parseJsonResponse(raw)
    if (!parsed.ok) return parsed
    const content = toContent(parsed.value)
    return content ? { ok: true, content } : { ok: false, error: "Response JSON had the wrong shape" }
  }
}

const checkAnyJson = jsonCheck((value) => JSON.stringify(value))

async function complete(spec: CompletionSpec): Promise<GenerationResult> {
  const check = spec.check ?? (spec.format === "json" ? checkAnyJson : checkMarkdown)
  const model = spec.model ?? DEFAULT_MODEL
  let budget = spec.maxTokens
  let lastError = "No response"

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (spec.signal?.aborted) return { success: false, error: "Generation was cancelled" }

    let response: ChatCompletion
    try {
      response = await getOpenAIClient().chat.completions.create(buildRequest(spec, budget), { signal: spec.signal })
    } catch (error) {
      Logger.error("OpenAI request failed", error, { model })
      return { success: false, error: error instanceof Error ? error.message : "OpenAI request failed" }
    }

    const choice = response.choices?.[0]
    Logger.debug("OpenAI usage", { model, attempt, usage: response.usage, finish: choice?.finish_reason })

    if (choice?.finish_reason === "length") {
      lastError = "Response was cut off (token limit)"
      budget *= 2
    } else {
      const result = check(choice?.message?.content ?? "")
      if (result.ok) return { success: true, content: result.content }
      lastError = result.error
    }
    Logger.warn("OpenAI response rejected", { model, attempt, reason: lastError })
  }

  Logger.error("OpenAI generation failed", undefined, { model, reason: lastError })
  return { success: false, error: lastError }
}

/** Generic completion (used by extract-website). JSON responses come back as normalised JSON text. */
export async function generateWithOpenAI(
  prompt: string,
  systemPrompt: string,
  responseFormat: ResponseFormat = "json",
  maxTokens: number = 2000,
  model: string = DEFAULT_MODEL,
  reasoningEffort: ReasoningEffort = "medium",
  opts: GenerateOptions = {},
): Promise<GenerationResult> {
  return complete({
    prompt,
    system: systemPrompt,
    format: responseFormat,
    maxTokens,
    model,
    effort: reasoningEffort,
    signal: opts.signal,
  })
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, max)
}

function listLine(prefix: string, value: unknown, max: number): string {
  const items = stringList(value, max)
  return items.length ? `${prefix}${items.join(", ")}` : ""
}

// ---------------------------------------------------------------------------
// Guide sections
// ---------------------------------------------------------------------------

/** Brand Voice: every selected trait in one call, formatted markdown. */
export async function generateBrandVoiceTraits(
  brandDetails: BrandPromptDetails,
  opts: GenerateOptions = {},
): Promise<GenerationResult> {
  const names = traitNames(brandDetails.traits)
  if (names.length === 0) return { success: false, error: "No traits selected for this brand" }

  const prompt = `You are a brand voice expert. Generate communication style guidelines for the following traits based on this brand information.

Brand Info:
• Brand Name: ${brandDetails.name}
• What they do: ${brandDetails.brandDetailsDescription}
• Audience: ${brandDetails.audience}${listLine("\n• Keywords: ", brandDetails.keywords, 25)}${listLine("\n• Products/Services: ", brandDetails.productsServices, 12)}

Traits to generate (${names.length} total):
${names.map((t, i) => `${i + 1}. ${t}`).join("\n")}

For EACH trait, create a description in this EXACT format. Use the exact heading level and structure:

### 1. [TraitName]

[ONE SENTENCE description of what this trait means for this specific brand and why it's important. Explicitly reference the core audience at least once.]

Important constraints for the ONE SENTENCE (3 rules):
- Be neutral and explanatory; never adopt the trait's tone.
- Max 20 words; no first/second person, emojis, or hype.
- Reading level/formality do NOT affect this sentence; they only affect examples.

***What It Means***

→ [Specific actionable writing instruction - around 10 words]
→ [Specific actionable writing instruction - around 10 words]
→ [Specific actionable writing instruction - around 10 words]

***What It Doesn't Mean***

✗ [How the first instruction could be taken too far]
✗ [How the second instruction could be taken too far]
✗ [How the third instruction could be taken too far]

${NO_EM_DASH}

Repeat this block for each trait (### 2. [TraitName], ### 3. [TraitName], etc.). Each "What It Doesn't Mean" should show how its corresponding "What It Means" could be taken too far. Use → (unicode arrow) and ✗ (unicode cross) exactly as shown.`

  return complete({
    prompt,
    system: "You are a brand voice expert creating specific, actionable communication style guidelines.",
    format: "markdown",
    maxTokens: 2500,
    effort: "low",
    check: (raw) => {
      const content = formatTraitMarkdown(stripOuterFence(raw).normalize("NFC"))
      return content ? { ok: true, content } : { ok: false, error: "Empty response" }
    },
    signal: opts.signal,
  })
}

/** Audience: overview, primary and secondary audience. Markdown with ### headings. */
export async function generateAudienceSection(
  brandDetails: BrandPromptDetails,
  opts: GenerateOptions = {},
): Promise<GenerationResult> {
  const prompt = `Write an Audience section for the brand below.

Brand: ${brandDetails.name}
What they do: ${brandDetails.brandDetailsDescription}
Audience hint: ${brandDetails.audience || "general audience"}
Keywords (optional): ${stringList(brandDetails.keywords, 25).join(", ")}
Products/services (optional): ${stringList(brandDetails.productsServices, 15).join(", ")}

Output markdown only, with these headings exactly:
### Overview
### Primary Audience
### Secondary Audience

Formatting rules:
- No bullets. No numbered lists. No tables. No code blocks.
- 1-2 sentences per paragraph. Keep sentences short.

Length rules:
- Overview: exactly 1 sentence.
- Primary: exactly 2 paragraphs, 2 sentences each (4 sentences total).
- Secondary: exactly 1 paragraph, 2 sentences.

Detail rules:
- Describe who they are and their context/mindset (goals, motivations, anxieties).
- Do not include writing advice or tone guidance.
- Be specific but don't invent facts. If unsure, use "often" or "typically."
- Never use em dashes (—). Use hyphens (-) or rewrite.`

  return complete({
    prompt,
    system: "You write precise, brand-specific audience sections for tone of voice guidelines.",
    format: "markdown",
    maxTokens: 800,
    effort: "low",
    check: (raw) => {
      const content = normalizeMarkdown(stripOuterFence(raw).normalize("NFC"))
      return content ? { ok: true, content } : { ok: false, error: "Empty response" }
    },
    signal: opts.signal,
  })
}

/** Style Rules: 25 rules, one per canonical category, rendered to final markdown. */
export async function generateStyleRules(
  brandDetails: BrandPromptDetails,
  traitsContext?: string,
  opts: GenerateOptions = {},
): Promise<GenerationResult> {
  const names = traitNames(brandDetails.traits)
  const prompt = `Create exactly 25 writing style rules for this brand. Use ONE rule per category from the list below. Rules support brand voice traits.

Brand:
- Name: ${brandDetails.name}
- Audience: ${brandDetails.audience}
- Description: ${brandDetails.brandDetailsDescription}
- Formality: ${brandDetails.formalityLevel || "Neutral"}
- Reading Level: ${brandDetails.readingLevel || "10-12"}
- English Variant: ${brandDetails.englishVariant || "american"}${listLine("\nKeywords: ", brandDetails.keywords, 25)}${listLine("\nProducts/Services: ", brandDetails.productsServices, 12)}
${names.length ? `- Selected Traits: ${names.join(", ")}` : ""}
${traitsContext ? `\nTraits Context:\n${traitsContext}\n` : ""}

Allowed categories (use each exactly once, in this order):
${getAllowedCategoriesPromptText()}

Return a STRICT JSON object:
{"rules": [{"category": "Category Name", "title": "Category Name", "description": "One sentence rule 8-12 words", "examples": {"good": "Example", "bad": "Example"}}]}

Requirements:
- Write rule descriptions naturally. Most should include why the rule matters, but use varied sentence structures to avoid monotony: "Use contractions to sound conversational and warm." or "Stick with British spelling throughout." or "Keep sentences under 20 words, shorter sentences are easier to scan." or "Multiple exclamation marks feel jarring and lose impact."
- Break monotony by using different sentence patterns: some with "to" connectors, some with periods separating the action from the benefit, some as observations. Vary opening words and structure.
- Pick the single trait that best fits each rule; vary which traits you use across rules.
- Examples must sound like ${brandDetails.name} speaking to ${brandDetails.audience}
- Description 8-12 words max
- Exactly 25 rules, one per category
- Format times without extra spaces (e.g. "10:00 am" not "10: 00 am")
- Use a space before quoted text (e.g. "Click \\"Mark as duplicate\\"" not "Click\\"Mark as duplicate\\"")
- In the Emojis rule, do NOT use emoji characters in examples; use plain text only (avoids encoding artifacts)
- ${NO_EM_DASH}`

  return complete({
    prompt,
    system: "You are a tone of voice guide expert. Return a strict JSON object only.",
    format: "json",
    maxTokens: 3000,
    effort: "none",
    check: jsonCheck((value) => {
      const list = Array.isArray(value) ? value : (value as { rules?: unknown } | null)?.rules
      const { valid } = validateRules(list)
      return valid.length >= 20 ? renderRulesMarkdown(valid.slice(0, 25)) : null
    }),
    signal: opts.signal,
  })
}

const BEFORE_AFTER_TYPES = [
  "Homepage Headline",
  "Email Subject Line",
  "Social Media Post",
  "Error or Empty State Message",
  "Blog Intro Paragraph",
]

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** Before/After examples to markdown: at most 5, skipping incomplete ones. */
export function beforeAfterToMarkdown(examples: unknown): string {
  if (!Array.isArray(examples)) return ""
  return examples
    .map((ex) => (ex && typeof ex === "object" ? (ex as Record<string, unknown>) : {}))
    .filter((ex) => text(ex.before) && text(ex.after))
    .slice(0, 5)
    .map((ex, i) => {
      const type = text(ex.contentType) || BEFORE_AFTER_TYPES[i] || `Example ${i + 1}`
      return `### ${type}\n\n**Before:** ${text(ex.before)}\n\n**After:** ${text(ex.after)}`
    })
    .join("\n\n")
}

/** Before/After: 5 content types, generic copy rewritten in the brand voice. */
export async function generateBeforeAfterSamples(
  brandDetails: BrandPromptDetails,
  traitsContext?: string,
  opts: GenerateOptions = {},
): Promise<GenerationResult> {
  const prompt = `Create exactly 5 "Before → After" content transformation examples for ${brandDetails.name}. Each tied to a content type.

Brand: ${brandDetails.name}
Description: ${brandDetails.brandDetailsDescription}
Audience: ${brandDetails.audience}${listLine("\nProducts/Services: ", brandDetails.productsServices, 15)}
${traitsContext ? `Traits: ${traitsContext.slice(0, 800)}` : ""}

Content types (one example each):
${BEFORE_AFTER_TYPES.map((t, i) => `${i + 1}. ${t}`).join("\n")}

For each: "Before" = plausible generic copy (not absurdly bad). "After" = on-brand, demonstrates voice. 1-2 sentences each.

${NO_EM_DASH}

Return JSON:
{"examples":[{"contentType":"Homepage Headline","before":"...","after":"..."}, ...]}`

  return complete({
    prompt,
    system:
      "You are an expert copywriter who transforms generic content into distinctive brand voice. Return strict JSON only. Never use em dashes.",
    format: "json",
    maxTokens: 1200,
    effort: "low",
    check: jsonCheck((value) => beforeAfterToMarkdown((value as { examples?: unknown } | null)?.examples) || null),
    signal: opts.signal,
  })
}

const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ")

function termPair(item: unknown): [string, string] | null {
  if (typeof item === "string") {
    const [use, instead = ""] = item.split(" not ")
    return use.trim() ? [use.trim(), instead.trim()] : null
  }
  if (item && typeof item === "object") {
    const { use, insteadOf } = item as Record<string, unknown>
    return text(use) ? [text(use), text(insteadOf)] : null
  }
  return null
}

function pairTable(title: string, items: unknown): string[] {
  const rows = (Array.isArray(items) ? items : []).map(termPair).filter((p): p is [string, string] => !!p)
  if (!rows.length) return []
  return [
    `### ${title}`,
    "",
    "| Use | Instead of |",
    "|-----|------------|",
    ...rows.map(([use, instead]) => `| ${cell(use)} | ${cell(instead)} |`),
    "",
  ]
}

/** Word list JSON to markdown tables. Empty subsections are omitted. */
export function wordListToMarkdown(list: { preferredTerms?: unknown; avoidTerms?: unknown; spellingUsage?: unknown }): string {
  const avoid = (Array.isArray(list.avoidTerms) ? list.avoidTerms : []).map(text).filter(Boolean)
  const lines = [
    ...pairTable("Preferred Terms", list.preferredTerms),
    ...pairTable("Spelling and Usage", list.spellingUsage),
    ...(avoid.length ? ["### Avoid Terms", "", "| Avoid |", "|-------|", ...avoid.map((t) => `| ${cell(t)} |`)] : []),
  ]
  return lines.join("\n").trim()
}

/** Word List: preferred terms, spelling/usage and terms to avoid. */
export async function generateWordList(
  brandDetails: BrandPromptDetails,
  traitsContext?: string,
  opts: GenerateOptions = {},
): Promise<GenerationResult> {
  const keywords = stringList(brandDetails.keywords, 25).join(", ") || "none"
  const ukUs = brandDetails.englishVariant === "british" ? "UK" : "US"
  const prompt = `Create a Word List for this brand. Return JSON with three arrays:

{
  "preferredTerms": [{"use": "term to use", "insteadOf": "term to avoid"}, ...],
  "avoidTerms": ["word to avoid", ...],
  "spellingUsage": [{"use": "correct spelling", "insteadOf": "incorrect spelling"}, ...]
}

- **preferredTerms** (5-8 items): Brand-specific language using keywords: ${keywords}. Each item has "use" and "insteadOf" fields.
- **avoidTerms** (5-8 items): Words that conflict with brand voice (derived from traits). Simple string array.
- **spellingUsage** (3-5 items): Contested spellings for ${ukUs} English and industry terms. Each item has "use" and "insteadOf" fields.

Brand: ${brandDetails.name}
Description: ${brandDetails.brandDetailsDescription}${listLine("\nProducts/Services: ", brandDetails.productsServices, 15)}${traitsContext ? `\nTraits: ${traitsContext.slice(0, 400)}` : ""}

${NO_EM_DASH}

Return strict JSON only.`

  return complete({
    prompt,
    system: "You are a brand voice expert. Return strict JSON only.",
    format: "json",
    maxTokens: 1000,
    effort: "low",
    check: jsonCheck((value) => (value && typeof value === "object" ? wordListToMarkdown(value) || null : null)),
    signal: opts.signal,
  })
}

// ---------------------------------------------------------------------------
// Extraction helpers (used by /api/extract-website)
// ---------------------------------------------------------------------------

/** Up to 25 keywords. Content is JSON text: {"keywords": string[]}. */
export async function generateKeywords(params: {
  name: string
  brandDetailsDescription: string
  audience?: string
}): Promise<GenerationResult> {
  const { name, brandDetailsDescription, audience = "general audience" } = params
  const prompt = `Generate up to 25 high-value keywords for this brand's content marketing and communications.

- Brand
  - Name: ${name}
  - Description: ${brandDetailsDescription}
  - Audience: ${audience}

- Guidelines
  - Focus on terms the audience actually searches for and uses
  - Include product/service names, features, and industry terminology
  - Avoid generic buzzwords like "innovative", "leading", "solution"
  - Each keyword MUST be 20 characters or less (including spaces)
  - Prefer 1-2 words; use 3 words only if under 20 chars
  - Choose terms that would appear in blog posts, marketing copy, and user communications

- Output format
  - Return clean JSON: {"keywords": ["keyword1", "keyword2", ...]}
  - 15-25 keywords`

  return complete({
    prompt,
    system: "You are a keyword expert focused on content marketing terms.",
    format: "json",
    maxTokens: 800,
    effort: "none",
    check: jsonCheck((value) => {
      const seen = new Set<string>()
      const keywords = stringList((value as { keywords?: unknown } | null)?.keywords, 100).filter((k) => {
        const key = k.toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      return keywords.length ? JSON.stringify({ keywords: keywords.slice(0, 25) }) : null
    }),
  })
}

/** Short internal audience description (1-2 sentences). Plain text. */
export async function generateAudienceSummary(params: {
  name: string
  brandDetailsDescription: string
}): Promise<GenerationResult> {
  const prompt = `Based on the brand below, write a concise audience description (1–2 sentences, ~25–40 words). Keep it practical and specific. Output plain text only.

Brand Name: ${params.name}
What they do: ${params.brandDetailsDescription}`

  return complete({
    prompt,
    system: "You are a brand strategist who writes precise, practical audience descriptions.",
    format: "markdown",
    maxTokens: 400,
    effort: "low",
  })
}

/** One-paragraph brand summary from free text. */
export async function generateBrandSummary(brandDetails: { brandDetailsText?: string }): Promise<GenerationResult> {
  const prompt = `Write a single paragraph (30–40 words) that starts with the brand name and summarizes the brand using all key info, keywords, and terms from the input below.\n\nBrand Info:\n${brandDetails.brandDetailsText}`
  return complete({ prompt, system: "You are a brand strategist.", format: "markdown", maxTokens: 2000, effort: "low" })
}

/** Up to 3 suggested traits from the predefined list. Content is a JSON array of trait names. */
export async function generateTraitSuggestions(brandDetails: {
  name?: string
  brandDetailsDescription?: string
  brandDetailsText?: string
  audience?: string
  targetAudience?: string
}): Promise<GenerationResult> {
  const prompt = `Based on this brand information, suggest exactly 3 brand voice traits that would work best for this brand.

Brand Name: ${brandDetails.name || "Brand"}
Description: ${brandDetails.brandDetailsDescription || brandDetails.brandDetailsText}
Audience: ${brandDetails.audience || brandDetails.targetAudience}

Available traits (use only these exact names): ${TRAIT_NAMES.join(", ")}

Return ONLY a JSON object with exactly 3 trait names, like this:
{"traits": ["Warm", "Direct", "Inspiring"]}`

  return complete({
    prompt,
    system: "You are a brand voice expert. Choose the 3 most fitting traits for this brand.",
    format: "json",
    maxTokens: 200,
    effort: "none",
    check: jsonCheck((value) => {
      const traits = parseTraitSuggestions(value).slice(0, 3)
      return traits.length ? JSON.stringify(traits) : null
    }),
  })
}
