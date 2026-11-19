import { NextResponse } from "next/server"
import type { User } from "@supabase/supabase-js"
import { tooManyRequests, withRouteErrors } from "@/lib/api-auth"
import { parsePreviewRequest, readJsonBody } from "@/lib/brand-input"
import Logger from "@/lib/logger"
import { clientKey, rateLimit } from "@/lib/rate-limit"
import { createClient } from "@/lib/supabase-server"
import { renderStyleGuideTemplate } from "@/lib/template-processor"
import { effectiveTier, isPaidTier, type Tier } from "@/lib/tiers"
import type { TraitName } from "@/lib/traits"

export const maxDuration = 120
/** Stop generating a little before the platform kills the function. */
const DEADLINE_MS = (maxDuration - 10) * 1000

const MAX_BODY_BYTES = 100_000
const RATE_LIMIT = { limit: 10, windowMs: 10 * 60_000 }

/** Used when the visitor has no traits selected (for example trait suggestion failed). */
const DEFAULT_TRAITS: TraitName[] = ["Warm", "Direct", "Supportive"]

/** Sections a preview cannot do without. Paid sections that fail stay locked and can be expanded later. */
const REQUIRED_SECTIONS = new Set(["brand-voice", "audience"])

/** The signed-in user and effective tier, or an anonymous starter. Never throws. */
async function optionalUser(): Promise<{ user: User | null; tier: Tier }> {
  try {
    const supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    const user = data?.user ?? null
    if (!user) return { user: null, tier: "starter" }
    const { data: profile } = await supabase
      .from("profiles")
      .select("subscription_tier, subscription_status")
      .eq("id", user.id)
      .single()
    return { user, tier: effectiveTier(profile) }
  } catch (error) {
    Logger.warn("Preview: could not load user, continuing as anonymous", undefined, error)
    return { user: null, tier: "starter" }
  }
}

/**
 * Generate a new guide. Starter (or anonymous): preview with locked paid
 * sections. Active Pro/Agency: full guide.
 *
 * Body: { brandDetails, selectedTraits? }
 * Responses:
 * - 200 { success: true, preview, failedSections } (failed paid sections stay locked)
 * - 400 { error } invalid input; 413 body too large; 429 rate limited
 * - 502 { error, failedSections } Brand Voice or Audience failed
 */
export async function POST(req: Request) {
  return withRouteErrors("preview", async () => {
    const parsed = await readJsonBody(req, MAX_BODY_BYTES)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })
    const input = parsePreviewRequest(parsed.body)
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 })

    const { user, tier } = await optionalUser()
    const limited = rateLimit(`preview:${clientKey(req, user?.id)}`, RATE_LIMIT)
    if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds)

    const brandDetails = { ...input.data, traits: input.data.traits.length ? input.data.traits : DEFAULT_TRAITS }
    const { markdown, failedSections } = await renderStyleGuideTemplate({
      brandDetails,
      isPreview: !isPaidTier(tier),
      userEmail: user?.email,
      signal: AbortSignal.timeout(DEADLINE_MS),
    })

    if (failedSections.some((id) => REQUIRED_SECTIONS.has(id))) {
      Logger.warn("Preview generation failed", { failedSections })
      return NextResponse.json(
        { error: "We couldn't generate your guide. Please try again.", failedSections },
        { status: 502 },
      )
    }

    return NextResponse.json({ success: true, preview: markdown, failedSections })
  })
}
