// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeSupabase, type FakeHandler, type FakeQuery } from "@/supabase/testing/fake-client"

const h = vi.hoisted(() => ({
  stripe: {
    webhooks: { constructEvent: vi.fn() },
    subscriptions: { retrieve: vi.fn() },
  },
  admin: null as unknown,
  sendThankYouEmail: vi.fn(),
}))

vi.mock("stripe", () => ({ default: function Stripe() { return h.stripe } }))
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: () => h.admin }))
vi.mock("@/lib/email-service", () => ({ emailService: { sendThankYouEmail: h.sendThankYouEmail } }))

import { POST } from "./route"

const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "active",
  customer: "cus_1",
  items: { data: [{ price: { id: "price_pro" }, current_period_end: 1_900_000_000 }] },
  ...overrides,
})

const checkoutEvent = (id = "evt_1") => ({
  id,
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_1",
      mode: "subscription",
      subscription: "sub_1",
      customer: "cus_1",
      metadata: { user_id: "u1", plan: "pro" },
      customer_details: { email: "a@b.co", name: "Ada Lovelace" },
    },
  },
})

function request() {
  return new Request("http://x/api/webhook", {
    method: "POST",
    headers: { "stripe-signature": "sig" },
    body: "{}",
  })
}

let processed: Set<string>
let profileUpdates: FakeQuery[]

function useAdmin(overrides: Partial<Record<string, FakeHandler>> = {}) {
  processed = new Set()
  profileUpdates = []
  const fake = fakeSupabase((q) => {
    const custom = overrides[`${q.table}.${q.op}`]
    if (custom) return custom(q)
    if (q.table === "stripe_events" && q.op === "select") {
      return { data: processed.has(q.filters.id as string) ? { id: q.filters.id } : null }
    }
    if (q.table === "stripe_events" && q.op === "insert") {
      processed.add((q.payload as { id: string }).id)
      return {}
    }
    if (q.table === "profiles" && q.op === "update") {
      profileUpdates.push(q)
      return { data: [{ id: "u1" }] }
    }
    return {}
  })
  h.admin = fake.client
  return fake
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_live_x"
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_x"
  process.env.STRIPE_PRO_PRICE_ID = "price_pro"
  process.env.STRIPE_AGENCY_PRICE_ID = "price_agency"
  delete process.env.STRIPE_MODE
  h.stripe.webhooks.constructEvent.mockReset()
  h.stripe.subscriptions.retrieve.mockReset()
  h.stripe.subscriptions.retrieve.mockResolvedValue(subscription())
  h.sendThankYouEmail.mockReset()
  h.sendThankYouEmail.mockResolvedValue({ success: true })
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  useAdmin()
})
afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_SECRET
})

describe("webhook signature", () => {
  it("rejects a missing signature with 400", async () => {
    const res = await POST(new Request("http://x", { method: "POST", body: "{}" }))
    expect(res.status).toBe(400)
  })

  it("rejects a bad signature with 400", async () => {
    h.stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error("bad sig")
    })
    const res = await POST(request())
    expect(res.status).toBe(400)
  })

  it("returns 500 when the webhook secret is not configured", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET
    const res = await POST(request())
    expect(res.status).toBe(500)
  })
})

describe("checkout.session.completed", () => {
  it("activates the plan derived from the subscription price, by user id", async () => {
    h.stripe.webhooks.constructEvent.mockReturnValue(checkoutEvent())
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect(profileUpdates).toHaveLength(1)
    expect(profileUpdates[0].filters).toEqual({ id: "u1" })
    expect(profileUpdates[0].payload).toMatchObject({
      subscription_tier: "pro",
      subscription_status: "active",
      guides_limit: 2,
      stripe_subscription_id: "sub_1",
      stripe_customer_id: "cus_1",
    })
  })

  it("writes a non-null period end when it only exists on the subscription item (SEC-15)", async () => {
    h.stripe.webhooks.constructEvent.mockReturnValue(checkoutEvent())
    await POST(request())
    expect((profileUpdates[0].payload as { current_period_end: string }).current_period_end).toBe(
      new Date(1_900_000_000 * 1000).toISOString(),
    )
  })

  it("returns 500 when the profile update fails, so Stripe retries (SEC-6)", async () => {
    useAdmin({ "profiles.update": () => ({ error: { message: "db down" } }) })
    h.stripe.webhooks.constructEvent.mockReturnValue(checkoutEvent())
    const res = await POST(request())
    expect(res.status).toBe(500)
  })

  it("returns 500 when no profile row was updated (SEC-6)", async () => {
    useAdmin({ "profiles.update": () => ({ data: [] }) })
    h.stripe.webhooks.constructEvent.mockReturnValue(checkoutEvent())
    const res = await POST(request())
    expect(res.status).toBe(500)
  })

  it("does not record a failed event as processed, so the retry runs again", async () => {
    let fail = true
    useAdmin({
      "profiles.update": (q) => {
        profileUpdates.push(q)
        return fail ? { error: { message: "db down" } } : { data: [{ id: "u1" }] }
      },
    })
    h.stripe.webhooks.constructEvent.mockReturnValue(checkoutEvent())
    expect((await POST(request())).status).toBe(500)
    fail = false
    expect((await POST(request())).status).toBe(200)
    expect(profileUpdates).toHaveLength(2)
  })

  it("sends the thank-you email once", async () => {
    h.stripe.webhooks.constructEvent.mockReturnValue(checkoutEvent())
    await POST(request())
    expect(h.sendThankYouEmail).toHaveBeenCalledTimes(1)
    expect(h.sendThankYouEmail).toHaveBeenCalledWith(
      expect.objectContaining({ customerEmail: "a@b.co", customerName: "Ada Lovelace" }),
    )
  })

  it("does not fail the event when the email fails", async () => {
    h.sendThankYouEmail.mockRejectedValue(new Error("resend down"))
    h.stripe.webhooks.constructEvent.mockReturnValue(checkoutEvent())
    const res = await POST(request())
    expect(res.status).toBe(200)
  })

  it("ignores one-time payment sessions (legacy flow removed, SEC-17)", async () => {
    const event = checkoutEvent()
    event.data.object.mode = "payment"
    h.stripe.webhooks.constructEvent.mockReturnValue(event)
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect(profileUpdates).toHaveLength(0)
    expect(h.sendThankYouEmail).not.toHaveBeenCalled()
  })
})

describe("idempotency (SEC-16)", () => {
  it("processes the same event id only once", async () => {
    h.stripe.webhooks.constructEvent.mockReturnValue(checkoutEvent("evt_dup"))
    expect((await POST(request())).status).toBe(200)
    expect((await POST(request())).status).toBe(200)
    expect(profileUpdates).toHaveLength(1)
    expect(h.sendThankYouEmail).toHaveBeenCalledTimes(1)
  })

  it("still processes events when the stripe_events table is missing", async () => {
    const missing = { error: { code: "42P01", message: 'relation "stripe_events" does not exist' } }
    useAdmin({ "stripe_events.select": () => missing, "stripe_events.insert": () => missing })
    h.stripe.webhooks.constructEvent.mockReturnValue(checkoutEvent())
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect(profileUpdates).toHaveLength(1)
  })
})

describe("customer.subscription.updated / deleted (SEC-7)", () => {
  const event = (type: string, obj: Record<string, unknown>) => ({
    id: `evt_${type}_${Math.random()}`,
    type,
    data: { object: obj },
  })

  it("re-fetches the subscription so an out-of-order event writes the current state", async () => {
    h.stripe.webhooks.constructEvent.mockReturnValue(
      event("customer.subscription.updated", subscription({ status: "active" })),
    )
    h.stripe.subscriptions.retrieve.mockResolvedValue(subscription({ status: "canceled" }))
    await POST(request())
    expect(h.stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_1")
    expect(profileUpdates[0].filters).toEqual({ stripe_subscription_id: "sub_1" })
    expect(profileUpdates[0].payload).toMatchObject({ subscription_status: "cancelled", subscription_tier: "starter" })
  })

  it("an unknown price never changes the tier (no starter-with-99-guides)", async () => {
    const legacy = subscription({ items: { data: [{ price: { id: "price_legacy" }, current_period_end: 1 }] } })
    h.stripe.webhooks.constructEvent.mockReturnValue(event("customer.subscription.updated", legacy))
    h.stripe.subscriptions.retrieve.mockResolvedValue(legacy)
    expect((await POST(request())).status).toBe(200)
    expect(profileUpdates[0].payload).not.toHaveProperty("subscription_tier")
    expect(profileUpdates[0].payload).not.toHaveProperty("guides_limit")
  })

  it("unpaid keeps the plan but marks it inactive so the effective tier is starter", async () => {
    const unpaid = subscription({ status: "unpaid" })
    h.stripe.webhooks.constructEvent.mockReturnValue(event("customer.subscription.updated", unpaid))
    h.stripe.subscriptions.retrieve.mockResolvedValue(unpaid)
    await POST(request())
    expect(profileUpdates[0].payload).toMatchObject({ subscription_status: "inactive", guides_limit: 1 })
  })

  it("deleted -> starter / cancelled", async () => {
    h.stripe.webhooks.constructEvent.mockReturnValue(
      event("customer.subscription.deleted", subscription({ status: "canceled" })),
    )
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect(profileUpdates[0].payload).toMatchObject({ subscription_tier: "starter", subscription_status: "cancelled" })
  })

  it("returns 500 when the subscription matches no profile yet (Stripe retries)", async () => {
    useAdmin({ "profiles.update": () => ({ data: [] }) })
    h.stripe.webhooks.constructEvent.mockReturnValue(event("customer.subscription.updated", subscription()))
    expect((await POST(request())).status).toBe(500)
  })
})

it("acknowledges unhandled event types", async () => {
  h.stripe.webhooks.constructEvent.mockReturnValue({ id: "evt_x", type: "invoice.paid", data: { object: {} } })
  expect((await POST(request())).status).toBe(200)
  expect(profileUpdates).toHaveLength(0)
})

it("returns 500 (so Stripe retries) when the Stripe key is missing", async () => {
  delete process.env.STRIPE_SECRET_KEY
  expect((await POST(request())).status).toBe(500)
})
