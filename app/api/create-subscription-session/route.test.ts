// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeSupabase } from "@/test/supabase-fake"
import { resetRateLimits } from "@/lib/rate-limit"

const h = vi.hoisted(() => ({
  stripe: {
    checkout: { sessions: { create: vi.fn() } },
    billingPortal: { sessions: { create: vi.fn() } },
    subscriptions: { list: vi.fn() },
  },
  userClient: null as unknown,
  MissingSupabaseConfigError: class extends Error {},
}))

vi.mock("stripe", () => ({ default: function Stripe() { return h.stripe } }))
vi.mock("@/lib/supabase-server", () => ({
  createClient: async () => h.userClient,
  MissingSupabaseConfigError: h.MissingSupabaseConfigError,
}))
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: () => ({}) }))

import { POST } from "./route"

let profile: Record<string, unknown> | null

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
      customer_email: "a@b.co",
      client_reference_id: "u1",
      metadata: { user_id: "u1", plan: "pro" },
      subscription_data: { metadata: { user_id: "u1", plan: "pro" } },
      success_url: "https://toneofvoice.app/dashboard?subscription=success&session_id={CHECKOUT_SESSION_ID}",
    })
  })

  it("reuses the existing Stripe customer instead of creating a new one (SEC-8)", async () => {
    profile = { stripe_customer_id: "cus_1" }
    await post({ plan: "agency" })
    const args = h.stripe.checkout.sessions.create.mock.calls[0][0]
    expect(args.customer).toBe("cus_1")
    expect(args).not.toHaveProperty("customer_email")
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
