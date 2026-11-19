import { NextResponse } from "next/server"
import { requireUser, tooManyRequests } from "@/lib/api-auth"
import { clientKey, rateLimit } from "@/lib/rate-limit"
import {
  LIVE_STATUSES,
  appUrl,
  findSubscription,
  getStripe,
  isPaidPlan,
  planToPriceId,
  withBillingErrors,
} from "@/lib/stripe"

/**
 * Stripe Checkout for a Pro or Agency subscription.
 * A user who already has a subscription gets 409 `{ error, manageUrl }`
 * (billing portal) instead of a second subscription.
 */
export async function POST(req: Request) {
  return withBillingErrors("create-subscription-session", async () => {
    const auth = await requireUser()
    if (!auth.ok) return auth.response
    const { supabase, user } = auth

    const limited = rateLimit(`checkout:${clientKey(req, user.id)}`, { limit: 5, windowMs: 60_000 })
    if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds)

    const body = (await req.json().catch(() => ({}))) as { plan?: unknown }
    const plan = body?.plan
    if (!isPaidPlan(plan)) {
      return NextResponse.json({ error: "Invalid plan. Use 'pro' or 'agency'." }, { status: 400 })
    }

    const priceId = planToPriceId(plan)
    if (!priceId) {
      console.error(`[create-subscription-session] No price id configured for plan "${plan}"`)
      return NextResponse.json({ error: "Service temporarily unavailable. Please try again later." }, { status: 503 })
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single()
    const customerId = typeof profile?.stripe_customer_id === "string" ? profile.stripe_customer_id : null

    const stripe = getStripe()
    const base = appUrl()

    if (customerId && (await findSubscription(customerId, LIVE_STATUSES))) {
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${base}/dashboard/billing`,
      })
      return NextResponse.json(
        { error: "You already have a subscription. Change or manage it in the billing portal.", manageUrl: portal.url },
        { status: 409 },
      )
    }

    const metadata = { user_id: user.id, plan }
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/dashboard?subscription=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/dashboard/billing?subscription=cancelled`,
      allow_promotion_codes: true,
      client_reference_id: user.id,
      metadata,
      subscription_data: { metadata },
      ...(customerId ? { customer: customerId } : { customer_email: user.email ?? undefined }),
    })

    return NextResponse.json({ url: session.url })
  })
}
