import { NextResponse } from "next/server"
import type Stripe from "stripe"
import { requireUser, tooManyRequests } from "@/lib/api-auth"
import { clientKey } from "@/lib/rate-limit"
import { checkRateLimit } from "@/lib/rate-limit-durable"
import { ACTIVE_STATUSES, applySubscriptionToProfile, findSubscription, getStripe, withBillingErrors } from "@/lib/stripe"
import { effectiveTier, isPaidTier } from "@/lib/tiers"

const SESSION_ID = /^cs_(test_|live_)?[A-Za-z0-9]{1,200}$/

/**
 * Webhook fallback after the checkout redirect. Activates a subscription only
 * when Stripe confirms it belongs to this user and is active. All writes go
 * through the admin client (users can never write billing columns).
 */
export async function POST(req: Request) {
  return withBillingErrors("verify-subscription", async () => {
    const auth = await requireUser()
    if (!auth.ok) return auth.response
    const { supabase, user } = auth

    const limited = await checkRateLimit(`verify-subscription:${clientKey(req, user.id)}`, { limit: 10, windowMs: 60_000 })
    if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds)

    const body = (await req.json().catch(() => ({}))) as { session_id?: unknown }
    const sessionId = body?.session_id
    if (sessionId !== undefined && (typeof sessionId !== "string" || !SESSION_ID.test(sessionId))) {
      return NextResponse.json({ error: "Invalid session_id" }, { status: 400 })
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("subscription_tier, subscription_status, stripe_customer_id")
      .eq("id", user.id)
      .single()
    const currentTier = effectiveTier(profile)

    let subscription: Stripe.Subscription | null = null
    if (sessionId) {
      const session = await getStripe().checkout.sessions.retrieve(sessionId, { expand: ["subscription"] })
      if (session.metadata?.user_id !== user.id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      const sub = session.subscription
      if (session.mode === "subscription" && session.status === "complete" && sub && typeof sub !== "string") {
        subscription = ACTIVE_STATUSES.has(sub.status) ? sub : null
      }
    } else {
      if (isPaidTier(currentTier)) {
        return NextResponse.json({ subscription_tier: currentTier, already_active: true, updated: false })
      }
      const customerId = profile?.stripe_customer_id
      if (typeof customerId === "string" && customerId) {
        subscription = await findSubscription(customerId, ACTIVE_STATUSES)
      }
    }

    if (!subscription) {
      return NextResponse.json({ subscription_tier: currentTier, already_active: false, updated: false })
    }

    const { update } = await applySubscriptionToProfile({ userId: user.id }, subscription)
    const tier = effectiveTier({
      subscription_tier: update.subscription_tier ?? profile?.subscription_tier,
      subscription_status: update.subscription_status,
    })
    return NextResponse.json({ subscription_tier: tier, already_active: false, updated: true })
  })
}
