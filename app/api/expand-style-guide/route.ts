import { NextResponse } from "next/server"
import { requireUser, tooManyRequests, withRouteErrors } from "@/lib/api-auth"
import { parseStoredBrandDetails, readJsonBody } from "@/lib/brand-input"
import { hasUnlockPlaceholders } from "@/lib/guide-placeholders"
import Logger from "@/lib/logger"
import { clientKey } from "@/lib/rate-limit"
import { checkRateLimit } from "@/lib/rate-limit-durable"
import { renderFullGuideFromPreview } from "@/lib/template-processor"

export const maxDuration = 120
/** Stop generating a little before the platform kills the function. */
const DEADLINE_MS = (maxDuration - 10) * 1000

const RATE_LIMIT = { limit: 5, windowMs: 10 * 60_000 }

const SECTION_LABELS: Record<string, string> = {
  "style-rules": "Style Rules",
  examples: "Before/After examples",
  "word-list": "Word List",
}

/** Guides being expanded by this instance (stops double-click double spend). */
const inFlight = new Set<string>()

/**
 * Expand a preview guide: generate the locked paid sections and save.
 *
 * Responses:
 * - 200 { success: true, content }
 * - 400 bad body, nothing to unlock, or incomplete brand details
 * - 401 / 403 not signed in / not on a paid plan
 * - 404 guide not found for this user
 * - 409 { error } guide changed during generation, or already expanding
 * - 429 rate limited
 * - 502 { error, failedSections: string[] } some sections failed; nothing saved
 */
export async function POST(req: Request) {
  return withRouteErrors("expand-style-guide", async () => {
    const auth = await requireUser({ requirePaid: true })
    if (!auth.ok) return auth.response
    const { supabase, user } = auth

    const parsed = await readJsonBody(req, 4_096)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })
    const guideId = (parsed.body as { guideId?: unknown } | null)?.guideId
    if (typeof guideId !== "string" || !guideId || guideId.length > 100) {
      return NextResponse.json({ error: "Missing guideId" }, { status: 400 })
    }

    const limited = await checkRateLimit(`expand:${clientKey(req, user.id)}`, RATE_LIMIT)
    if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds)

    const { data: guide, error: loadError } = await supabase
      .from("style_guides")
      .select("id, content_md, brand_details, brand_name, updated_at")
      .eq("id", guideId)
      .eq("user_id", user.id)
      .single()
    if (loadError || !guide) return NextResponse.json({ error: "Guide not found" }, { status: 404 })

    const content: string = guide.content_md || ""
    if (!hasUnlockPlaceholders(content)) {
      return NextResponse.json({ error: "Guide already has full content" }, { status: 400 })
    }

    const stored = (guide.brand_details as Record<string, unknown> | null) ?? {}
    const details = parseStoredBrandDetails(stored, guide.brand_name)
    if (!details.ok) {
      return NextResponse.json({ error: "This guide's brand details are incomplete, so it cannot be expanded." }, { status: 400 })
    }

    if (inFlight.has(guideId)) {
      return NextResponse.json({ error: "This guide is already being generated." }, { status: 409 })
    }
    inFlight.add(guideId)
    try {
      const { markdown, failedSections } = await renderFullGuideFromPreview({
        previewContent: content,
        brandDetails: details.data,
        userEmail: user.email ?? null,
        signal: AbortSignal.timeout(DEADLINE_MS),
      })

      if (failedSections.length > 0) {
        Logger.warn("Guide expansion incomplete", { guideId, failedSections })
        const names = failedSections.map((id) => SECTION_LABELS[id] ?? id).join(", ")
        return NextResponse.json(
          { error: `We couldn't generate: ${names}. Nothing was saved. Please try again.`, failedSections },
          { status: 502 },
        )
      }
      if (hasUnlockPlaceholders(markdown)) {
        Logger.error("Guide expansion left placeholders", undefined, { guideId })
        return NextResponse.json({ error: "Failed to generate complete sections. Please try again." }, { status: 500 })
      }

      // Optimistic concurrency: only save over the version we generated from (AI-24).
      let update = supabase
        .from("style_guides")
        .update({ content_md: markdown, updated_at: new Date().toISOString() }, { count: "exact" })
        .eq("id", guideId)
        .eq("user_id", user.id)
      update = guide.updated_at ? update.eq("updated_at", guide.updated_at) : update.is("updated_at", null)
      const { error: updateError, count } = await update

      if (updateError) {
        Logger.error("Saving expanded guide failed", updateError, { guideId })
        return NextResponse.json({ error: "Failed to save expanded guide" }, { status: 500 })
      }
      if (!count) {
        return NextResponse.json(
          { error: "This guide was changed while it was being generated. Reload it and try again." },
          { status: 409 },
        )
      }

      return NextResponse.json({ success: true, content: markdown })
    } finally {
      inFlight.delete(guideId)
    }
  })
}
