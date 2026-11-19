import { NextResponse } from "next/server"
import { requireUser } from "@/lib/api-auth"
import { appUrl, getStripe, withBillingErrors } from "@/lib/stripe"

/** Stripe Customer Portal for the signed-in user's own customer. */
export async function POST() {
  return withBillingErrors("create-portal-session", async () => {
    const auth = await requireUser()
    if (!auth.ok) return auth.response

    const { data: profile } = await auth.supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", auth.user.id)
      .single()

    const customerId = profile?.stripe_customer_id
    if (!customerId) {
      return NextResponse.json({ error: "No billing account found. Subscribe first." }, { status: 400 })
    }

    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl()}/dashboard/billing`,
    })
    return NextResponse.json({ url: session.url })
  })
}
