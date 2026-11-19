// Shared logic for the brand extraction flow (hero form and "Create guide" modal).

import type { InputValidationResult } from "./input-utils"

export interface ExtractionResponse {
  success?: boolean
  brandName?: string
  brandDetailsDescription?: string
  audience?: string
  url?: string
  productsServices?: unknown
  keywords?: unknown
  suggestedTraits?: unknown
  error?: string
  message?: string
}

export interface ClassifiedError {
  type: string
  message: string
}

export type ExtractionResult =
  | { ok: true; data: ExtractionResponse }
  | { ok: false; error: ClassifiedError }

/** localStorage keys describing the brand currently being set up. */
const BRAND_KEYS = ["selectedTraits", "suggestedTraits", "brandKeywords"] as const

function errorText(error: unknown): string {
  if (!error) return "Unknown error"
  if (typeof error === "string") return error
  const e = error as { message?: unknown; error?: unknown }
  if (e.message) return String(e.message)
  if (e.error) return String(e.error)
  return "Unknown error"
}

const RULES: Array<{ match: string[]; type: string; message: string }> = [
  { match: ["ECONNRESET", "connection reset"], type: "CONNECTION_RESET", message: "Connection was interrupted. Try again or add details manually." },
  { match: ["fetch", "network"], type: "NETWORK", message: "Can't reach this site. Try again later." },
  { match: ["SSL", "certificate", "CERT"], type: "SSL", message: "Site has security issues. Add brand details manually." },
  { match: ["quota", "billing"], type: "QUOTA_EXCEEDED", message: "AI unavailable. Try again later." },
  { match: ["content policy", "safety", "inappropriate"], type: "CONTENT_POLICY", message: "Couldn't analyze content. Add brand details manually." },
  { match: ["javascript", "dynamic content"], type: "JAVASCRIPT_SITE", message: "Site uses dynamic content. Add brand details manually." },
  { match: ["login", "authentication", "password"], type: "LOGIN_REQUIRED", message: "Login required. Add brand details manually." },
  { match: ["no content", "empty", "insufficient content"], type: "NO_CONTENT", message: "Not enough content. Add brand details manually." },
  { match: ["Invalid URL", "malformed"], type: "MALFORMED_URL", message: "Check URL format." },
  { match: ["Description too short", "at least 5 words"], type: "DESCRIPTION_TOO_SHORT", message: "Please enter at least 5 words to describe your brand" },
  { match: ["Description is too long", "under 200 characters"], type: "DESCRIPTION_TOO_LONG", message: "Description is too long. Please keep it under 200 characters" },
  { match: ["unsupported", "blocked"], type: "UNSUPPORTED_DOMAIN", message: "Can't access this site type. Add brand details manually." },
  { match: ["test domain", "example domain"], type: "TEST_DOMAIN", message: "This is a test domain. Enter a real site." },
]

/** Turn an API payload, thrown error and/or HTTP response into one user-facing message. */
export function classifyExtractionError(
  error: unknown,
  response?: Pick<Response, "status">,
): ClassifiedError {
  const text = errorText(error)
  const status = response?.status

  if ((error as { name?: string })?.name === "AbortError" || text.includes("timeout")) {
    return { type: "TIMEOUT", message: "Site didn't respond. Try again or add details manually." }
  }
  if (status === 429) {
    return { type: "RATE_LIMIT", message: "AI is overloaded. Try again in a few minutes." }
  }
  if (status === 402) {
    return { type: "QUOTA_EXCEEDED", message: "AI unavailable. Try again later." }
  }
  const rule = RULES.find((r) => r.match.some((m) => text.includes(m)))
  if (rule) return { type: rule.type, message: rule.message }
  if (status === 404) {
    return { type: "NOT_FOUND", message: "Site not found. Check the URL or add details manually." }
  }
  if (status && status >= 500) {
    return { type: "SERVER", message: "Problem analyzing site. Try again or add details manually." }
  }
  return { type: "UNKNOWN", message: "Problem analyzing site. Try again or add details manually." }
}

function toKeywordArray(keywords: unknown): string[] {
  if (Array.isArray(keywords)) return keywords.map(String)
  return String(keywords)
    .split(/\r?\n|,/)
    .map((k) => k.trim())
    .filter(Boolean)
}

export function buildBrandDetails(data: ExtractionResponse): Record<string, unknown> {
  const details: Record<string, unknown> = {
    name: data.brandName || "",
    brandDetailsDescription: data.brandDetailsDescription,
    audience: data.audience || "",
    websiteUrl: data.url || "",
    englishVariant: "american",
    formalityLevel: "Neutral",
    readingLevel: "6-8",
  }
  if (Array.isArray(data.productsServices)) details.productsServices = data.productsServices
  if (data.keywords) details.keywords = toKeywordArray(data.keywords)
  return details
}

/**
 * Save a successful extraction to localStorage for the guide preview.
 * Always clears the previous brand's traits and keywords first (FE-8).
 */
export function persistExtraction(data: ExtractionResponse): Record<string, unknown> {
  const details = buildBrandDetails(data)
  try {
    BRAND_KEYS.forEach((k) => localStorage.removeItem(k))
    if (Array.isArray(details.keywords)) {
      localStorage.setItem("brandKeywords", (details.keywords as string[]).join("\n"))
    }
    if (Array.isArray(data.suggestedTraits) && data.suggestedTraits.length > 0) {
      localStorage.setItem("suggestedTraits", JSON.stringify(data.suggestedTraits))
      localStorage.setItem("selectedTraits", JSON.stringify(data.suggestedTraits.slice(0, 3)))
    }
    localStorage.setItem("brandDetails", JSON.stringify(details))
  } catch {
    // storage unavailable (private mode, quota)
  }
  return details
}

/** Call /api/extract-website for validated input and classify any failure. */
export async function requestExtraction(
  input: Pick<InputValidationResult, "inputType" | "cleanInput">,
  fetchImpl: typeof fetch = fetch,
): Promise<ExtractionResult> {
  const body = input.inputType === "url" ? { url: input.cleanInput } : { description: input.cleanInput }
  let response: Response | undefined
  try {
    response = await fetchImpl("/api/extract-website", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    let data: ExtractionResponse
    try {
      data = await response.json()
    } catch {
      data = { success: false, error: "Invalid response format" }
    }
    if (data?.success) return { ok: true, data }
    return { ok: false, error: classifyExtractionError(data ?? {}, response) }
  } catch (err) {
    return { ok: false, error: classifyExtractionError(err, response) }
  }
}
