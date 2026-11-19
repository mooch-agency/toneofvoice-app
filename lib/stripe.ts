import "server-only"
/**
 * Single Stripe module: client, price/plan mapping and the one function that
 * writes a subscription onto a profile. Nothing here talks to Stripe or reads
 * required env at import time, so `next build` works without secrets.
 */
import { NextResponse } from "next/server"
import Stripe from "stripe"
import { withRouteErrors } from "@/lib/api-auth"
import { getSupabaseAdmin } from "@/lib/supabase-admin"
import { effectiveTier, guideLimit, isUnlocked, normalizeTier, type Tier } from "@/lib/tiers"

/** Must match the installed SDK (stripe@18). Set the webhook endpoint to the same version. */
export const STRIPE_API_VERSION = "2025-03-31.basil" satisfies Stripe.LatestApiVersion

export type PaidPlan = "pro" | "agency"

export class StripeNotConfiguredError extends Error {
  constructor() {
    super("Stripe is not configured")
    this.name = "StripeNotConfiguredError"
  }
}

const isTestMode = () => process.env.STRIPE_MODE === "test"

/** Read `NAME` in live mode and `TEST_NAME`-style `STRIPE_TEST_*` in test mode. */
function modeEnv(liveName: string): string | undefined {
  const name = isTestMode() ? liveName.replace(/^STRIPE_/, "STRIPE_TEST_") : liveName
  return process.env[name] || undefined
}

let cached: { key: string; client: Stripe } | null = null

/** Lazily created Stripe client for the current STRIPE_MODE. */
export function getStripe(): Stripe {
  const key = modeEnv("STRIPE_SECRET_KEY")
  if (!key) throw new StripeNotConfiguredError()
  if (cached?.key !== key) {
    cached = { key, client: new Stripe(key, { apiVersion: STRIPE_API_VERSION }) }
  }
  return cached.client
}

export function getWebhookSecret(): string | undefined {
  return modeEnv("STRIPE_WEBHOOK_SECRET")
}

/** Price ids per plan, read from env on access (so mode switches and tests work). */
export const PRICE_IDS: Readonly<Record<PaidPlan, string | undefined>> = {
  get pro() {
    return modeEnv("STRIPE_PRO_PRICE_ID")
  },
  get agency() {
    return modeEnv("STRIPE_AGENCY_PRICE_ID")
  },
}

export function isPaidPlan(value: unknown): value is PaidPlan {
  return value === "pro" || value === "agency"
}

export function planToPriceId(plan: PaidPlan): string | null {
  return PRICE_IDS[plan] ?? null
}

export function priceIdToPlan(priceId: string | null | undefined): PaidPlan | null {
  if (!priceId) return null
  if (priceId === PRICE_IDS.pro) return "pro"
  if (priceId === PRICE_IDS.agency) return "agency"
  return null
}

/**
 * The paid plan a subscription is on: from its price, else from the stored
 * profile tier (legacy prices). Null when neither says.
 */
export function currentPlan(sub: Stripe.Subscription, profileTier: string | null | undefined): PaidPlan | null {
  const fromPrice = priceIdToPlan(sub.items?.data?.[0]?.price?.id)
  if (fromPrice) return fromPrice
  const tier = normalizeTier(profileTier)
  return isPaidPlan(tier) ? tier : null
}

/** Whether moving from `from` to `to` is an upgrade. An unknown current plan never is. */
export function isUpgrade(from: PaidPlan | null, to: PaidPlan): boolean {
  return from !== null && !isUnlocked(from, to)
}

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "https://toneofvoice.app").replace(/\/+$/, "")
}

/**
 * Period end as an ISO string. API 2025-03-31 moved it onto subscription
 * items; older payloads (webhook endpoints on older versions) keep it on the
 * subscription itself.
 */
export function subscriptionPeriodEnd(sub: Stripe.Subscription): string | null {
  const fromItem = sub.items?.data?.[0]?.current_period_end
  const legacy = (sub as unknown as { current_period_end?: number | null }).current_period_end
  const seconds = fromItem ?? legacy
  return typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null
}

/** Stripe statuses that mean the user is paying (or trialing). */
export const ACTIVE_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set(["active", "trialing"])

/** Statuses where a subscription still exists and could bill again; a second checkout would double-bill. */
export const LIVE_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
])

/**
 * The stored status keeps the vocabulary the app already used
 * ("active" / "inactive" / "cancelled"), so an existing CHECK constraint on
 * the column cannot reject a webhook write.
 */
function storedStatus(status: Stripe.Subscription.Status): "active" | "inactive" | "cancelled" {
  if (ACTIVE_STATUSES.has(status)) return "active"
  if (status === "canceled" || status === "incomplete_expired") return "cancelled"
  return "inactive"
}

export interface ProfileBillingUpdate {
  subscription_tier?: Tier
  subscription_status: string
  guides_limit?: number
  stripe_customer_id: string | null
  stripe_subscription_id: string
  current_period_end: string | null
  updated_at: string
}

/** Pure mapping from a Stripe subscription to the profile billing columns. */
export function profileUpdateFromSubscription(sub: Stripe.Subscription): ProfileBillingUpdate {
  const status = storedStatus(sub.status)
  const priceId = sub.items?.data?.[0]?.price?.id
  const plan = priceIdToPlan(priceId)
  const customer = typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null)

  const update: ProfileBillingUpdate = {
    subscription_status: status,
    stripe_customer_id: customer,
    stripe_subscription_id: sub.id,
    current_period_end: subscriptionPeriodEnd(sub),
    updated_at: new Date().toISOString(),
  }

  // A cancelled subscription always ends paid access, whatever the price.
  const tier: Tier | null = status === "cancelled" ? "starter" : plan
  if (tier) {
    update.subscription_tier = tier
    update.guides_limit = guideLimit(effectiveTier({ subscription_tier: tier, subscription_status: status }))
  } else {
    // Legacy/unknown price or missing env: never guess a tier for a paying customer.
    console.error("[stripe] Unknown price on subscription; tier left unchanged", {
      subscriptionId: sub.id,
      priceId,
    })
  }
  return update
}

export type ProfileTarget = { userId: string } | { subscriptionId: string }

/** No profile row matched the target (e.g. an orphaned subscription). */
export class NoProfileMatchedError extends Error {
  constructor(column: string) {
    super(`No profile matched ${column}`)
    this.name = "NoProfileMatchedError"
  }
}

/**
 * Write a subscription's current state onto the matching profile with the
 * admin client. Throws on a database error, and NoProfileMatchedError when no
 * row matched, so callers decide whether a retry could help.
 */
export async function applySubscriptionToProfile(
  target: ProfileTarget,
  sub: Stripe.Subscription,
): Promise<{ plan: PaidPlan | null; update: ProfileBillingUpdate }> {
  const update = profileUpdateFromSubscription(sub)
  const [column, value] =
    "userId" in target ? ["id", target.userId] : ["stripe_subscription_id", target.subscriptionId]

  const { data, error } = await getSupabaseAdmin()
    .from("profiles")
    .update(update)
    .eq(column, value)
    .select("id")

  if (error) throw new Error(`Profile update failed: ${error.message ?? "unknown error"}`)
  if (!data || data.length === 0) throw new NoProfileMatchedError(column)

  return { plan: priceIdToPlan(sub.items?.data?.[0]?.price?.id), update }
}

/** `withRouteErrors` plus a 503 when Stripe keys are missing. */
export function withBillingErrors(name: string, handler: () => Promise<Response>): Promise<Response> {
  return withRouteErrors(name, async () => {
    try {
      return await handler()
    } catch (e) {
      if (e instanceof StripeNotConfiguredError) {
        console.error(`[${name}] Stripe is not configured`)
        return NextResponse.json({ error: "Service unavailable" }, { status: 503 })
      }
      throw e
    }
  })
}

/** First subscription of a customer whose status is in `statuses` (newest first). */
export async function findSubscription(
  customerId: string,
  statuses: ReadonlySet<Stripe.Subscription.Status>,
): Promise<Stripe.Subscription | null> {
  const list = await getStripe().subscriptions.list({ customer: customerId, status: "all", limit: 10 })
  return list.data.find((s) => statuses.has(s.status)) ?? null
}

/**
 * Move a subscription to another plan in place (same subscription, same
 * customer). The prorated difference is invoiced and charged right away, and
 * the update fails instead of leaving the subscription incomplete when that
 * payment fails, so a declined card surfaces as a Stripe error (402).
 * Callers decide which changes are allowed (the app only upgrades in-app).
 */
export async function changeSubscriptionPlan(subscriptionId: string, plan: PaidPlan): Promise<Stripe.Subscription> {
  const priceId = planToPriceId(plan)
  if (!priceId) throw new StripeNotConfiguredError()

  const stripe = getStripe()
  const current = await stripe.subscriptions.retrieve(subscriptionId)
  const itemId = current.items?.data?.[0]?.id
  if (!itemId) throw new Error(`Subscription ${subscriptionId} has no item to change`)

  return stripe.subscriptions.update(subscriptionId, {
    items: [{ id: itemId, price: priceId }],
    proration_behavior: "always_invoice",
    payment_behavior: "error_if_incomplete",
    metadata: { ...(current.metadata ?? {}), plan },
  })
}
