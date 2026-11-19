import { z } from "zod"
import { traitNames } from "./traits"

/**
 * One server-side schema for the brand details sent to the generation routes
 * (AI-13, SIMP-15). Fields the user controls are validated strictly; lists the
 * model generated (keywords, products) and the audience hint are cleaned and
 * capped instead of rejected, so a long model answer never blocks a user.
 * Unknown fields (for example a client-supplied `previewTraits`) are dropped.
 */

const MAX_TRAITS = 3

const Traits = z.preprocess(
  (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? traitNames(v) : v),
  z
    .array(z.string().max(40, "Trait names must be 40 characters or less"))
    .max(MAX_TRAITS, `Choose at most ${MAX_TRAITS} traits`),
)

function cleanList(maxItems: number, maxLength: number) {
  return z.preprocess(
    (v) =>
      (Array.isArray(v) ? v : [])
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item && item.length <= maxLength)
        .slice(0, maxItems),
    z.array(z.string()),
  )
}

function withLegacyDescription(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw
  const r = raw as Record<string, unknown>
  if (r.brandDetailsDescription) return r
  return { ...r, brandDetailsDescription: r.description ?? r.brandDetailsText }
}

export const BrandDetailsInput = z.preprocess(
  withLegacyDescription,
  z.object({
    name: z
      .string({ error: "Brand name is required" })
      .trim()
      .min(1, "Brand name is required")
      .max(80, "Brand name must be 80 characters or less"),
    brandDetailsDescription: z
      .string({ error: "Brand description is required" })
      .trim()
      .min(1, "Brand description is required")
      .max(2500, "Brand description must be 2500 characters or less"),
    audience: z.preprocess((v) => (typeof v === "string" ? v.trim().slice(0, 500) : ""), z.string()),
    traits: Traits,
    keywords: cleanList(25, 40),
    productsServices: cleanList(20, 80),
    formalityLevel: z.string().trim().min(1).max(40).catch("Neutral"),
    readingLevel: z.string().trim().min(1).max(20).catch("6-8"),
    englishVariant: z.enum(["american", "british"]).catch("american"),
  }),
)

export type BrandDetails = z.output<typeof BrandDetailsInput>

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string }

function firstError(error: z.ZodError): string {
  const issue = error.issues[0]
  return issue?.message || "Invalid brand details"
}

export function parseBrandDetails(input: unknown): ParseResult<BrandDetails> {
  if (!input || typeof input !== "object") return { ok: false, error: "Brand details are required" }
  const result = BrandDetailsInput.safeParse(input)
  return result.success ? { ok: true, data: result.data } : { ok: false, error: firstError(result.error) }
}

/**
 * Brand details already saved with a guide. Older rows may have an empty or
 * very long name, more traits or a longer description than new input allows;
 * clamp them rather than refusing to expand a paying user's guide.
 */
export function parseStoredBrandDetails(
  stored: Record<string, unknown> | null | undefined,
  fallbackName: string | null | undefined,
): ParseResult<BrandDetails> {
  const raw = (withLegacyDescription(stored ?? {}) as Record<string, unknown>) ?? {}
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  const name = (str(raw.name) || str(fallbackName) || "Brand").slice(0, 80)
  const description = str(raw.brandDetailsDescription).slice(0, 2500)
  const traits = (Array.isArray(raw.traits) ? traitNames(raw.traits) : [])
    .map((t) => t.slice(0, 40))
    .slice(0, MAX_TRAITS)
  return parseBrandDetails({ ...raw, name, brandDetailsDescription: description, traits })
}

export type JsonBodyResult = { ok: true; body: unknown } | { ok: false; status: 400 | 413; error: string }

/** Read a JSON request body, rejecting bodies over `maxBytes` (413) and invalid JSON (400). */
export async function readJsonBody(req: Request, maxBytes: number): Promise<JsonBodyResult> {
  const tooLarge = { ok: false, status: 413, error: "Request body is too large" } as const
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) return tooLarge
  const text = await req.text()
  if (new TextEncoder().encode(text).length > maxBytes) return tooLarge
  try {
    return { ok: true, body: JSON.parse(text) }
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON body" }
  }
}

const PreviewBody = z.object({
  brandDetails: z.record(z.string(), z.unknown(), { error: "Brand details are required" }),
  selectedTraits: Traits.optional(),
})

/** Body of POST /api/preview: `{ brandDetails, selectedTraits? }`. selectedTraits wins when non-empty. */
export function parsePreviewRequest(body: unknown): ParseResult<BrandDetails> {
  const outer = PreviewBody.safeParse(body ?? {})
  if (!outer.success) return { ok: false, error: firstError(outer.error) }
  const selected = outer.data.selectedTraits ?? []
  const details = parseBrandDetails(outer.data.brandDetails)
  if (!details.ok) return details
  return { ok: true, data: { ...details.data, traits: selected.length ? selected : details.data.traits } }
}
