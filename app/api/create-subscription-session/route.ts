import { NextResponse } from "next/server"
import { requireUser, tooManyRequests } from "@/lib/api-auth"
import { clientKey, rateLimit } from "@/lib/rate-limit"
import { getSupabaseAdmin } from "@/lib/supabase-admin"
import {
  ACTIVE_STATUSES,
  LIVE_STATUSES,
  appUrl,
  currentPlan,
  findSubscription,
  getStripe,
  isPaidPlan,
  isUpgrade,
  planToPriceId,
  withBillingErrors,
} from "@/lib/stripe"

/**
 * Stripe Checkout for a Pro or Agency subscription.
 * A user who already has a subscription never gets a second one:
 * - an active subscriber asking for a higher plan gets 409 `{ error, upgrade: true }`
 *   (the client then calls POST /api/change-plan);
 * - otherwise (same/lower plan, or payment trouble) 409 `{ error, manageUrl }` (billing portal).
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
      .select("stripe_customer_id, subscription_tier")
      .eq("id", user.id)
      .single()
    const stripe = getStripe()
    const base = appUrl()

    let customerId = typeof profile?.stripe_customer_id === "string" ? profile.stripe_customer_id : null
    if (!customerId) {
      // One customer per user. The idempotency key makes parallel first-time
      // checkouts (two tabs, double clicks) get the same customer, and the
      // live-subscription check below then stops a second subscription.
      const customer = await stripe.customers.create(
        { email: user.email ?? undefined, metadata: { user_id: user.id } },
        { idempotencyKey: `customer:${user.id}` },
      )
      customerId = customer.id
      const { error } = await getSupabaseAdmin()
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", user.id)
      if (error) throw new Error(`Could not store Stripe customer: ${error.message ?? "unknown"}`)
    } else {
      const existing = await findSubscription(customerId, LIVE_STATUSES)
      if (existing) {
        const current = currentPlan(existing, profile?.subscription_tier)
        if (ACTIVE_STATUSES.has(existing.status) && isUpgrade(current, plan)) {
          return NextResponse.json(
            { error: "You already have a subscription. Upgrade it instead of starting a new one.", upgrade: true },
            { status: 409 },
          )
        }
        const portal = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: `${base}/dashboard/billing`,
        })
        return NextResponse.json(
          { error: "You already have a subscription. Change or manage it in the billing portal.", manageUrl: portal.url },
          { status: 409 },
        )
      }
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
      customer: customerId,
    })

    return NextResponse.json({ url: session.url })
  })
}
