import { NextResponse } from "next/server"
import { requireUser, withRouteErrors } from "@/lib/api-auth"

/** The signed-in user's effective subscription tier (lapsed paid plans count as starter). */
export async function GET() {
  return withRouteErrors("user-subscription-tier", async () => {
    const auth = await requireUser({ withTier: true })
    if (!auth.ok) return auth.response
    return NextResponse.json({ subscription_tier: auth.tier })
  })
}
