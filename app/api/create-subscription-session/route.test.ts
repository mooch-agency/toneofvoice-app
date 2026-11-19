// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeSupabase } from "@/test/supabase-fake"
import { resetRateLimits } from "@/lib/rate-limit"

const h = vi.hoisted(() => ({
  stripe: {
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    subscriptions: { list: vi.fn() },
    customers: { create: vi.fn() },
  },
  userClient: null as unknown,
  admin: null as unknown,
  MissingSupabaseConfigError: class extends Error {},
}))

vi.mock("stripe", () => ({ default: function Stripe() { return h.stripe } }))
vi.mock("@/lib/supabase-server", () => ({
  createClient: async () => h.userClient,
  MissingSupabaseConfigError: h.MissingSupabaseConfigError,
}))
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: () => h.admin }))

import { POST } from "./route"

let profile: Record<string, unknown> | null
let adminWrites: { table: string; payload: unknown; filters: Record<string, unknown> }[]

function setUser(user: { id: string; email?: string } | null = { id: "u1", email: "a@b.co" }) {
  h.userClient = fakeSupabase((q) => (q.table === "profiles" ? { data: profile } : {}), user).client
}

const post = (body: unknown) =>
  POST(new Request("http://x/api/create-subscription-session", { method: "POST", body: JSON.stringify(body) }))

beforeEach(() => {
  resetRateLimits()
  process.env.STRIPE_SECRET_KEY = "sk_live_x"
  process.env.STRIPE_PRO_PRICE_ID = "price_pro"
  process.env.STRIPE_AGENCY_PRICE_ID = "price_agency"
  process.env.NEXT_PUBLIC_APP_URL = "https://toneofvoice.app"
  delete process.env.STRIPE_MODE
  h.stripe.checkout.sessions.create.mockReset().mockResolvedValue({ id: "cs_1", url: "https://checkout/cs_1" })
  h.stripe.billingPortal.sessions.create.mockReset().mockResolvedValue({ url: "https://portal/x" })
  h.stripe.subscriptions.list.mockReset().mockResolvedValue({ data: [] })
  h.stripe.customers.create.mockReset().mockResolvedValue({ id: "cus_new" })
  adminWrites = []
  h.admin = fakeSupabase((q) => {
    if (q.op === "update") adminWrites.push({ table: q.table, payload: q.payload, filters: q.filters })
    return { data: [{ id: "u1" }] }
  }).client
  profile = { stripe_customer_id: null }
  vi.spyOn(console, "error").mockImplementation(() => {})
  setUser()
})

it("401s without a session", async () => {
  setUser(null)
  expect((await post({ plan: "pro" })).status).toBe(401)
})

it("400s on an unknown plan", async () => {
  expect((await post({ plan: "enterprise" })).status).toBe(400)
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled()
})

it("503s when the price id is not configured", async () => {
  delete process.env.STRIPE_PRO_PRICE_ID
  const res = await post({ plan: "pro" })
  expect(res.status).toBe(503)
  expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled()
})

describe("checkout", () => {
  it("creates a subscription checkout that returns with the session id", async () => {
    const res = await post({ plan: "pro" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: "https://checkout/cs_1" })
    const args = h.stripe.checkout.sessions.create.mock.calls[0][0]
    expect(args).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_pro", quantity: 1 }],
      customer: "cus_new",
      client_reference_id: "u1",
      metadata: { user_id: "u1", plan: "pro" },
      subscription_data: { metadata: { user_id: "u1", plan: "pro" } },
      success_url: "https://toneofvoice.app/dashboard?subscription=success&session_id={CHECKOUT_SESSION_ID}",
    })
  })

  it("creates one Stripe customer per user up front, so parallel first checkouts share it", async () => {
    await post({ plan: "pro" })
    expect(h.stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: "a@b.co", metadata: { user_id: "u1" } }),
      expect.objectContaining({ idempotencyKey: "customer:u1" }),
    )
    expect(adminWrites).toEqual([
      expect.objectContaining({ table: "profiles", payload: { stripe_customer_id: "cus_new" } }),
    ])
    expect(h.stripe.checkout.sessions.create.mock.calls[0][0]).not.toHaveProperty("customer_email")
  })

  it("reuses the existing Stripe customer instead of creating a new one (SEC-8)", async () => {
    profile = { stripe_customer_id: "cus_1" }
    await post({ plan: "agency" })
    const args = h.stripe.checkout.sessions.create.mock.calls[0][0]
    expect(args.customer).toBe("cus_1")
    expect(args).not.toHaveProperty("customer_email")
    expect(h.stripe.customers.create).not.toHaveBeenCalled()
    expect(h.stripe.subscriptions.list).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_1" }))
  })

  it("returns 409 with a portal link instead of a second subscription (SEC-8)", async () => {
    profile = { stripe_customer_id: "cus_1" }
    h.stripe.subscriptions.list.mockResolvedValue({ data: [{ id: "sub_1", status: "active" }] })
    const res = await post({ plan: "agency" })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.manageUrl).toBe("https://portal/x")
    expect(body.error).toBeTruthy()
    expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled()
    expect(h.stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_1" }),
    )
  })

  it("pro subscriber asking for agency gets 409 { upgrade: true } (in-app upgrade, no portal)", async () => {
    profile = { stripe_customer_id: "cus_1", subscription_tier: "pro" }
    h.stripe.subscriptions.list.mockResolvedValue({
      data: [{ id: "sub_1", status: "active", items: { data: [{ price: { id: "price_pro" } }] } }],
    })
    const res = await post({ plan: "agency" })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.upgrade).toBe(true)
    expect(body.error).toBeTruthy()
    expect(body).not.toHaveProperty("manageUrl")
    expect(h.stripe.billingPortal.sessions.create).not.toHaveBeenCalled()
    expect(h.stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it("same plan keeps the portal link, without upgrade", async () => {
    profile = { stripe_customer_id: "cus_1", subscription_tier: "pro" }
    h.stripe.subscriptions.list.mockResolvedValue({
      data: [{ id: "sub_1", status: "active", items: { data: [{ price: { id: "price_pro" } }] } }],
    })
    const body = await (await post({ plan: "pro" })).json()
    expect(body.manageUrl).toBe("https://portal/x")
    expect(body).not.toHaveProperty("upgrade")
  })

  it("agency subscriber asking for pro (downgrade) gets the portal link", async () => {
    profile = { stripe_customer_id: "cus_1", subscription_tier: "agency" }
    h.stripe.subscriptions.list.mockResolvedValue({
      data: [{ id: "sub_1", status: "active", items: { data: [{ price: { id: "price_agency" } }] } }],
    })
    const res = await post({ plan: "pro" })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.manageUrl).toBe("https://portal/x")
    expect(body).not.toHaveProperty("upgrade")
  })

  it("falls back to the profile tier when the subscription price is unknown", async () => {
    profile = { stripe_customer_id: "cus_1", subscription_tier: "pro" }
    h.stripe.subscriptions.list.mockResolvedValue({
      data: [{ id: "sub_1", status: "active", items: { data: [{ price: { id: "price_legacy" } }] } }],
    })
    expect((await (await post({ plan: "agency" })).json()).upgrade).toBe(true)
  })

  it("a past_due subscriber asking for a higher plan is sent to the portal, not upgraded", async () => {
    profile = { stripe_customer_id: "cus_1", subscription_tier: "pro" }
    h.stripe.subscriptions.list.mockResolvedValue({
      data: [{ id: "sub_1", status: "past_due", items: { data: [{ price: { id: "price_pro" } }] } }],
    })
    const body = await (await post({ plan: "agency" })).json()
    expect(body.manageUrl).toBe("https://portal/x")
    expect(body).not.toHaveProperty("upgrade")
  })

  it("also blocks a second checkout while the existing subscription is past_due", async () => {
    profile = { stripe_customer_id: "cus_1" }
    h.stripe.subscriptions.list.mockResolvedValue({ data: [{ id: "sub_1", status: "past_due" }] })
    expect((await post({ plan: "pro" })).status).toBe(409)
  })

  it("returns a generic error when Stripe fails", async () => {
    h.stripe.checkout.sessions.create.mockRejectedValue(new Error("No such price: price_pro; secret sk_live"))
    const res = await post({ plan: "pro" })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toMatch(/price_pro|sk_live/)
  })
})

it("rate limits checkout creation", async () => {
  let last: Response | undefined
  for (let i = 0; i < 6; i++) last = await post({ plan: "pro" })
  expect(last?.status).toBe(429)
})
