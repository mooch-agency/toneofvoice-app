import { NextResponse } from "next/server"
import { z } from "zod"
import {
  generateAudienceSummary,
  generateKeywords,
  generateTraitSuggestions,
  generateWithOpenAI,
} from "@/lib/openai"
import { fetchAndExtractWithCheerio } from "@/lib/cheerio-site-scraper"
import { normalizeUrlInput, parsePublicHttpUrl } from "@/lib/url-validation"
import { clientKey, rateLimit } from "@/lib/rate-limit"
import { tooManyRequests } from "@/lib/api-auth"
import { SYSTEM_PROMPT, descriptionPrompt, urlPrompt } from "./prompts"

// Anonymous onboarding route: every call costs several LLM requests.
const RATE_LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 }
const MAX_DESCRIPTION_CHARS = 2000
const MAX_URL_CHARS = 2048

type GenerationResult = Awaited<ReturnType<typeof generateWithOpenAI>>

const RequestSchema = z
  .object({
    url: z.string().trim().max(MAX_URL_CHARS).optional(),
    description: z.string().trim().max(MAX_DESCRIPTION_CHARS).optional(),
  })
  .refine((b) => Boolean(b.url || b.description), { message: "url or description is required" })

const AudienceObject = z.object({
  demographic: z
    .object({ age: z.string().optional(), occupation: z.string().optional(), location: z.string().optional() })
    .partial()
    .optional(),
  interestsValues: z.array(z.string()).optional(),
  context: z.string().optional(),
})

const BrandProfileSchema = z.object({
  name: z.string(),
  description: z.string(),
  targetAudience: z.union([z.string(), AudienceObject]).optional().catch(undefined),
  productsServices: z
    .array(z.unknown())
    .optional()
    .transform((list) => (list ?? []).filter((p): p is string => typeof p === "string")),
})
type BrandProfile = z.infer<typeof BrandProfileSchema>

function safeJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const stringsOnly = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

function flattenAudience(audience: BrandProfile["targetAudience"]): string {
  if (!audience) return ""
  if (typeof audience === "string") return audience
  const demo = audience.demographic
  const demoText = [demo?.occupation, demo?.age && `aged ${demo.age}`, demo?.location && `in ${demo.location}`]
    .filter(Boolean)
    .join(" ")
  const interests = audience.interestsValues?.length ? `interested in ${audience.interestsValues.join(", ")}` : ""
  return [demoText, interests, audience.context].filter(Boolean).join(" who are ")
}

function settle(p: Promise<GenerationResult>): Promise<GenerationResult> {
  return p.catch((e): GenerationResult => ({ success: false, error: e instanceof Error ? e.message : String(e) }))
}

/** Generate the main profile; throws if the model fails or returns the wrong shape. */
async function generateProfile(prompt: string): Promise<BrandProfile> {
  const result = await generateWithOpenAI(prompt, SYSTEM_PROMPT, "json", 1500, "gpt-5.2", "none")
  if (!result.success) throw new Error("Brand profile generation failed")
  const parsed = BrandProfileSchema.safeParse(safeJson(result.content))
  if (!parsed.success) throw new Error("Brand profile had an unexpected shape")
  return parsed.data
}

/** Audience, keywords and trait suggestions. Each is optional: failures fall back to defaults. */
async function enrichProfile(profile: BrandProfile) {
  const name = profile.name || "Brand"
  const fallbackAudience = flattenAudience(profile.targetAudience) || "general audience"

  const [audienceResult, keywordsResult] = await Promise.all([
    settle(generateAudienceSummary({ name, brandDetailsDescription: profile.description })),
    settle(generateKeywords({ name, brandDetailsDescription: profile.description, audience: fallbackAudience })),
  ])
  const audience = (audienceResult.success && audienceResult.content?.trim()) || fallbackAudience
  const keywordsJson = keywordsResult.success ? safeJson(keywordsResult.content) : undefined
  const keywords = stringsOnly((keywordsJson as { keywords?: unknown } | undefined)?.keywords)

  const traitsResult = await settle(
    generateTraitSuggestions({ name, brandDetailsDescription: profile.description, audience }),
  )
  const suggestedTraits = traitsResult.success ? stringsOnly(safeJson(traitsResult.content)) : []

  return {
    success: true as const,
    brandName: profile.name,
    brandDetailsDescription: profile.description,
    audience,
    keywords,
    suggestedTraits,
    productsServices: profile.productsServices,
  }
}

async function scrapeHomepage(url: URL): Promise<string> {
  try {
    const text = await fetchAndExtractWithCheerio(url.href)
    return text.length > 100 ? text : ""
  } catch (e) {
    console.warn("[extract-website] Homepage scrape failed, using model knowledge:", e instanceof Error ? e.name : "error")
    return ""
  }
}

function badRequest(message: string) {
  return NextResponse.json({ success: false, message, error: "Invalid request" }, { status: 400 })
}

export async function POST(request: Request) {
  const limited = rateLimit(`extract-website:${clientKey(request)}`, RATE_LIMIT)
  if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds)

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return badRequest("Request body must be JSON.")
  }
  const input = RequestSchema.safeParse(raw)
  if (!input.success) {
    return badRequest(
      `Enter a website URL (up to ${MAX_URL_CHARS} characters) or a description (up to ${MAX_DESCRIPTION_CHARS} characters).`,
    )
  }

  // URL wins when both are sent, as before.
  if (input.data.url) {
    let url: URL
    try {
      url = parsePublicHttpUrl(normalizeUrlInput(input.data.url))
    } catch {
      return badRequest("Invalid URL provided. Please check for typos or extra punctuation.")
    }
    try {
      const homepage = await scrapeHomepage(url)
      const profile = await generateProfile(urlPrompt(url, homepage))
      return NextResponse.json({ ...(await enrichProfile(profile)), url: url.href })
    } catch (e) {
      console.error("[extract-website] URL extraction failed:", e)
      return NextResponse.json(
        { success: false, message: "Failed to extract brand information", error: "Extraction failed" },
        { status: 500 },
      )
    }
  }

  try {
    const profile = await generateProfile(descriptionPrompt(input.data.description!))
    return NextResponse.json(await enrichProfile(profile))
  } catch (e) {
    console.error("[extract-website] Description processing failed:", e)
    return NextResponse.json(
      {
        success: false,
        message: "Could not process description. Try again or add details manually.",
        error: "Description processing failed",
      },
      { status: 500 },
    )
  }
}
