import { NextResponse } from "next/server"
import { requireUser, withRouteErrors } from "@/lib/api-auth"
import { canCreateGuide, guideLimit } from "@/lib/tiers"

const MAX_CONTENT_BYTES = 200 * 1024
const MAX_BRAND_DETAILS_BYTES = 50 * 1024
const MAX_TEXT = 255

/** Raised by the style_guides BEFORE INSERT trigger (migration 002). */
const LIMIT_TRIGGER_MESSAGE = "guide_limit_reached"

interface SaveInput {
  guide_id?: string
  title: string
  brand_name: string | null
  content_md: string
  brand_details: Record<string, unknown> | null
}

type Parsed = { ok: true; input: SaveInput } | { ok: false; status: 400 | 413; error: string }

const byteLength = (s: string) => new TextEncoder().encode(s).length
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

function parse(body: unknown): Parsed {
  if (!isPlainObject(body)) return { ok: false, status: 400, error: "Invalid request body" }
  const { guide_id, title, brand_name, content_md, brand_details } = body

  if (typeof title !== "string" || !title.trim() || typeof content_md !== "string" || !content_md) {
    return { ok: false, status: 400, error: "Missing required fields: title, content_md" }
  }
  if (guide_id !== undefined && guide_id !== null && (typeof guide_id !== "string" || !guide_id)) {
    return { ok: false, status: 400, error: "Invalid guide_id" }
  }
  if (brand_name !== undefined && brand_name !== null && typeof brand_name !== "string") {
    return { ok: false, status: 400, error: "Invalid brand_name" }
  }
  if (brand_details !== undefined && brand_details !== null && !isPlainObject(brand_details)) {
    return { ok: false, status: 400, error: "Invalid brand_details" }
  }
  if (byteLength(content_md) > MAX_CONTENT_BYTES) {
    return { ok: false, status: 413, error: "Guide is too large to save" }
  }
  if (brand_details && byteLength(JSON.stringify(brand_details)) > MAX_BRAND_DETAILS_BYTES) {
    return { ok: false, status: 413, error: "Brand details are too large to save" }
  }

  return {
    ok: true,
    input: {
      guide_id: (guide_id as string | null | undefined) ?? undefined,
      title,
      brand_name: (brand_name as string | null | undefined) ?? null,
      content_md,
      brand_details: (brand_details as Record<string, unknown> | null | undefined) ?? null,
    },
  }
}

/** The one row shape written for both insert and update. */
function toRow(input: SaveInput) {
  return {
    title: input.title.slice(0, MAX_TEXT),
    brand_name: input.brand_name?.slice(0, MAX_TEXT) ?? null,
    content_md: input.content_md,
    plan_type: "style_guide" as const,
    brand_details: input.brand_details,
  }
}

const limitReached = (limit: number, used: number) =>
  NextResponse.json(
    { error: "Guide limit reached. Upgrade to add more guides.", code: "GUIDE_LIMIT", limit, used },
    { status: 403 },
  )

const saveFailed = () => NextResponse.json({ error: "Failed to save guide" }, { status: 500 })

/** Save (create or update) a style guide for the signed-in user. Never overwrites another guide. */
export async function POST(req: Request) {
  return withRouteErrors("save-style-guide", async () => {
    const auth = await requireUser({ withTier: true })
    if (!auth.ok) return auth.response
    const { supabase, user, tier } = auth

    const body = await req.json().catch(() => undefined)
    const parsed = parse(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status })
    const { input } = parsed

    if (input.guide_id) {
      const { data: guide, error } = await supabase
        .from("style_guides")
        .update({ ...toRow(input), updated_at: new Date().toISOString() })
        .eq("id", input.guide_id)
        .eq("user_id", user.id)
        .select("id, title, updated_at")
        .maybeSingle()
      if (error) {
        console.error("[save-style-guide] Update error:", error)
        return saveFailed()
      }
      if (!guide) return NextResponse.json({ error: "Guide not found or access denied" }, { status: 404 })
      return NextResponse.json({ success: true, guide })
    }

    const { count } = await supabase
      .from("style_guides")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
    const used = count ?? 0
    const limit = guideLimit(tier)
    if (!canCreateGuide(tier, used)) return limitReached(limit, used)

    const { data: guide, error } = await supabase
      .from("style_guides")
      .insert({ user_id: user.id, ...toRow(input) })
      .select("id, title, created_at")
      .single()
    if (error) {
      // The DB trigger closes the count-then-insert race.
      if (String(error.message ?? "").includes(LIMIT_TRIGGER_MESSAGE)) return limitReached(limit, limit)
      console.error("[save-style-guide] Insert error:", error)
      return saveFailed()
    }
    return NextResponse.json({ success: true, guide })
  })
}
