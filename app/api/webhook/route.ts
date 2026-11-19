import { NextResponse } from "next/server"
import type Stripe from "stripe"
import { emailService } from "@/lib/email-service"
import { getSupabaseAdmin } from "@/lib/supabase-admin"
import { applySubscriptionToProfile, getStripe, getWebhookSecret } from "@/lib/stripe"

/**
 * Stripe webhook. Returns 400 only for bad signatures and 500 whenever an
 * event could not be applied, so Stripe retries it. Events are deduplicated by
 * id in `stripe_events` (see supabase/migrations/002_security_hardening.sql).
 */
export async function POST(request: Request) {
  const sig = request.headers.get("stripe-signature")
  if (!sig) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 })
  }

  const secret = getWebhookSecret()
  if (!secret) {
    console.error("[webhook] Webhook secret not configured")
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 })
  }

  let event: Stripe.Event
  try {
    const payload = Buffer.from(await request.arrayBuffer())
    event = getStripe().webhooks.constructEvent(payload, sig, secret)
  } catch (err) {
    console.error("[webhook] Signature verification failed:", err instanceof Error ? err.message : err)
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  try {
    if (await alreadyProcessed(event.id)) {
      return NextResponse.json({ received: true, duplicate: true })
    }
    await handleEvent(event)
    await markProcessed(event)
    return NextResponse.json({ received: true })
  } catch (err) {
    console.error(`[webhook] Failed to process ${event.id} (${event.type}):`, err)
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 })
  }
}

async function handleEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(event.data.object)
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return handleSubscriptionChange(event)
    default:
      // past_due/unpaid arrive as customer.subscription.updated; nothing else changes access.
      return
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  if (session.mode !== "subscription") return // legacy one-time payments are no longer sold

  const userId = session.metadata?.user_id
  const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id
  if (!userId || !subId) {
    // Retrying cannot fix a session without these; acknowledge and alert via logs.
    console.error("[webhook] Subscription checkout without user_id or subscription", { sessionId: session.id })
    return
  }

  const subscription = await getStripe().subscriptions.retrieve(subId)
  await applySubscriptionToProfile({ userId }, subscription)
  await sendThankYouEmail(session)
}

async function handleSubscriptionChange(event: Stripe.Event) {
  const sub = event.data.object as Stripe.Subscription
  // Events can arrive out of order. For updates, write Stripe's current state
  // rather than the (possibly stale) event payload. A deletion is final.
  const current =
    event.type === "customer.subscription.deleted" ? sub : await getStripe().subscriptions.retrieve(sub.id)
  await applySubscriptionToProfile({ subscriptionId: sub.id }, current)
}

/** Best effort: an email failure must not make Stripe re-deliver the event. */
async function sendThankYouEmail(session: Stripe.Checkout.Session) {
  const email = session.customer_details?.email
  if (!email) return
  try {
    const result = await emailService.sendThankYouEmail({
      customerEmail: email,
      customerName: session.customer_details?.name ?? undefined,
    })
    if (!result.success) console.error("[webhook] Thank-you email not sent", { sessionId: session.id })
  } catch (err) {
    console.error("[webhook] Thank-you email failed", { sessionId: session.id }, err)
  }
}

/** Postgres "undefined table" / PostgREST "table not in schema cache". */
function isMissingTable(error: { code?: string } | null | undefined) {
  return error?.code === "42P01" || error?.code === "PGRST205"
}

async function alreadyProcessed(eventId: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("stripe_events")
    .select("id")
    .eq("id", eventId)
    .maybeSingle()
  if (error) {
    // Without the table we cannot dedupe; handlers are idempotent, so process anyway.
    if (!isMissingTable(error)) console.error("[webhook] stripe_events lookup failed:", error)
    else console.warn("[webhook] stripe_events table missing; apply migration 002")
    return false
  }
  return !!data
}

/** Recorded only after success, so a failed or crashed attempt is retried in full. */
async function markProcessed(event: Stripe.Event) {
  const { error } = await getSupabaseAdmin()
    .from("stripe_events")
    .insert({ id: event.id, type: event.type })
  if (error && error.code !== "23505" && !isMissingTable(error)) {
    console.error("[webhook] Could not record processed event:", error)
  }
}
