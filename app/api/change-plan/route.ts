import { NextResponse } from "next/server"
import type Stripe from "stripe"
import { requireUser, tooManyRequests } from "@/lib/api-auth"
import { clientKey } from "@/lib/rate-limit"
import { checkRateLimit } from "@/lib/rate-limit-durable"
import {
  ACTIVE_STATUSES,
  LIVE_STATUSES,
  applySubscriptionToProfile,
  changeSubscriptionPlan,
  currentPlan,
  findSubscription,
  getStripe,
  isPaidPlan,
  isUpgrade,
  planToPriceId,
  withBillingErrors,
} from "@/lib/stripe"
import type { Tier } from "@/lib/tiers"

const NAME = "change-plan"

/** Stripe SDK errors carry `type`; card failures (declines, SCA) are "StripeCardError". */
function isCardError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { type?: unknown }).type === "StripeCardError"
}

function isMissingResource(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "resource_missing"
}

const conflict = (error: string) => NextResponse.json({ error }, { status: 409 })

/** The user's live subscription: looked up on the customer, else the stored subscription id. */
async function findLiveSubscription(
  customerId: string | null,
  subscriptionId: string | null,
): Promise<Stripe.Subscription | null> {
  if (customerId) return findSubscription(customerId, LIVE_STATUSES)
  if (!subscriptionId) return null
  try {
    const sub = await getStripe().subscriptions.retrieve(subscriptionId)
    return LIVE_STATUSES.has(sub.status) ? sub : null
  } catch (e) {
    if (isMissingResource(e)) return null
    throw e
  }
}

const asString = (v: unknown) => (typeof v === "string" && v ? v : null)

/**
 * POST `{ plan }`: upgrade the user's existing subscription in place (pro ->
 * agency). The prorated difference is charged immediately; a declined card is
 * a 402. Users without a live subscription use checkout (409); same-plan and
 * downgrades stay in the billing portal (409).
 * Success: `{ success: true, subscription_tier }`.
 */
export async function POST(req: Request) {
  return withBillingErrors(NAME, async () => {
    const auth = await requireUser()
    if (!auth.ok) return auth.response
    const { supabase, user } = auth

    const limited = await checkRateLimit(`change-plan:${clientKey(req, user.id)}`, { limit: 5, windowMs: 60_000 })
    if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds)

    const body = (await req.json().catch(() => null)) as { plan?: unknown } | null
    const plan = body?.plan
    if (!isPaidPlan(plan)) {
      return NextResponse.json({ error: "Invalid plan. Use 'pro' or 'agency'." }, { status: 400 })
    }
    if (!planToPriceId(plan)) {
      console.error(`[${NAME}] No price id configured for plan "${plan}"`)
      return NextResponse.json({ error: "Service temporarily unavailable. Please try again later." }, { status: 503 })
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id, stripe_subscription_id, subscription_tier, subscription_status")
      .eq("id", user.id)
      .single()

    const sub = await findLiveSubscription(
      asString(profile?.stripe_customer_id),
      asString(profile?.stripe_subscription_id),
    )
    if (!sub) return conflict("You don't have an active subscription. Choose a plan to subscribe.")
    if (!ACTIVE_STATUSES.has(sub.status)) {
      return conflict("Your last payment didn't go through. Update your payment method under Manage billing first.")
    }

    const current = currentPlan(sub, asString(profile?.subscription_tier))
    if (current === plan) return conflict("You're already on this plan.")
    if (!isUpgrade(current, plan)) {
      return conflict("Only upgrades can be done here. Change or downgrade your plan under Manage billing.")
    }

    let updated: Stripe.Subscription
    try {
      updated = await changeSubscriptionPlan(sub.id, plan)
    } catch (e) {
      if (isCardError(e)) {
        return NextResponse.json(
          { error: "Your card was declined. Update your payment method under Manage billing and try again." },
          { status: 402 },
        )
      }
      throw e
    }

    // The webhook writes the same state later; this makes the new tier visible now.
    let tier: Tier = plan
    try {
      const { update } = await applySubscriptionToProfile({ userId: user.id }, updated)
      tier = update.subscription_tier ?? tier
    } catch (e) {
      // The charge went through; do not report a failure the user would retry.
      console.error(`[${NAME}] Profile update after plan change failed; webhook will retry`, e)
    }

    return NextResponse.json({ success: true, subscription_tier: tier })
  })
}
