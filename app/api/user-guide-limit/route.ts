import { NextResponse } from "next/server"
import { requireUser, withRouteErrors } from "@/lib/api-auth"
import { canCreateGuide, guideLimit } from "@/lib/tiers"

/** Current user's effective tier, guide limit and usage (drives the upgrade nudge). */
export async function GET() {
  return withRouteErrors("user-guide-limit", async () => {
    const auth = await requireUser({ withTier: true })
    if (!auth.ok) return auth.response
    const { supabase, user, tier } = auth

    const { count } = await supabase
      .from("style_guides")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
    const used = count ?? 0

    return NextResponse.json({
      subscription_tier: tier,
      limit: guideLimit(tier),
      used,
      atLimit: !canCreateGuide(tier, used),
    })
  })
}
