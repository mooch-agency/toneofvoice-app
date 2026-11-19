import { NextResponse } from "next/server"
import { requireUser, withRouteErrors } from "@/lib/api-auth"

/** Load one of the signed-in user's guides, plus their effective tier. */
export async function GET(req: Request) {
  return withRouteErrors("load-style-guide", async () => {
    const guideId = new URL(req.url).searchParams.get("guideId")
    if (!guideId) return NextResponse.json({ error: "Missing guideId" }, { status: 400 })

    const auth = await requireUser({ withTier: true })
    if (!auth.ok) return auth.response

    const { data: guide } = await auth.supabase
      .from("style_guides")
      .select("id, title, brand_name, content_md, plan_type, brand_details")
      .eq("id", guideId)
      .eq("user_id", auth.user.id)
      .maybeSingle()

    if (!guide) return NextResponse.json({ error: "Guide not found or access denied" }, { status: 404 })
    return NextResponse.json({ ...guide, subscription_tier: auth.tier })
  })
}
