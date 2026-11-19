// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeSupabase } from "@/test/supabase-fake"
import { resetRateLimits } from "@/lib/rate-limit"

const h = vi.hoisted(() => ({
  stripe: {
    subscriptions: { list: vi.fn(), retrieve: vi.fn(), update: vi.fn() },
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

type Sub = { id: string; status: string; customer: string; metadata: Record<string, string>; items: { data: unknown[] } }
const liveSub = (price = "price_pro", status = "active"): Sub => ({
  id: "sub_1",
  status,
  customer: "cus_1",
  metadata: { user_id: "u1", plan: price === "price_agency" ? "agency" : "pro" },
  items: { data: [{ id: "si_1", price: { id: price }, current_period_end: 1_900_000_000 }] },
})

let profile: Record<string, unknown> | null
let adminWrites: { payload: unknown; filters: Record<string, unknown> }[]
let adminResult: { data?: unknown; error?: unknown }

function setUser(user: { id: string; email?: string } | null = { id: "u1", email: "a@b.co" }) {
  h.userClient = fakeSupabase((q) => (q.table === "profiles" ? { data: profile } : {}), user).client
}

const post = (body: unknown) =>
  POST(new Request("http://x/api/change-plan", { method: "POST", body: JSON.stringify(body) }))

beforeEach(() => {
  resetRateLimits()
  process.env.STRIPE_SECRET_KEY = "sk_live_x"
  process.env.STRIPE_PRO_PRICE_ID = "price_pro"
  process.env.STRIPE_AGENCY_PRICE_ID = "price_agency"
  delete process.env.STRIPE_MODE
  h.stripe.subscriptions.list.mockReset().mockResolvedValue({ data: [liveSub()] })
  h.stripe.subscriptions.retrieve.mockReset().mockResolvedValue(liveSub())
  h.stripe.subscriptions.update.mockReset().mockResolvedValue(liveSub("price_agency"))
  adminWrites = []
  adminResult = { data: [{ id: "u1" }] }
  h.admin = fakeSupabase((q) => {
    if (q.op === "update") adminWrites.push({ payload: q.payload, filters: q.filters })
    return adminResult
  }).client
  profile = {
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    subscription_tier: "pro",
    subscription_status: "active",
  }
  vi.spyOn(console, "error").mockImplementation(() => {})
  setUser()
})

it("401s without a session", async () => {
  setUser(null)
  expect((await post({ plan: "agency" })).status).toBe(401)
  expect(h.stripe.subscriptions.update).not.toHaveBeenCalled()
})

it.each([{ plan: "enterprise" }, { plan: "starter" }, {}, null])("400s on an invalid plan (%j)", async (body) => {
  expect((await post(body)).status).toBe(400)
  expect(h.stripe.subscriptions.update).not.toHaveBeenCalled()
})

it("400s on a malformed body", async () => {
  const res = await POST(new Request("http://x/api/change-plan", { method: "POST", body: "{nope" }))
  expect(res.status).toBe(400)
})

it("503s when the target price is not configured", async () => {
  delete process.env.STRIPE_AGENCY_PRICE_ID
  expect((await post({ plan: "agency" })).status).toBe(503)
  expect(h.stripe.subscriptions.update).not.toHaveBeenCalled()
})

it("503s when Stripe keys are missing", async () => {
  delete process.env.STRIPE_SECRET_KEY
  expect((await post({ plan: "agency" })).status).toBe(503)
})

describe("upgrade", () => {
  it("upgrades pro -> agency in place, charging the prorated difference now", async () => {
    const res = await post({ plan: "agency" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, subscription_tier: "agency" })
    expect(h.stripe.subscriptions.list).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_1" }))
    expect(h.stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
      items: [{ id: "si_1", price: "price_agency" }],
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
      metadata: { user_id: "u1", plan: "agency" },
    })
  })

  it("writes the new tier onto the profile right away (admin client, by user id)", async () => {
    await post({ plan: "agency" })
    expect(adminWrites).toHaveLength(1)
    expect(adminWrites[0].filters).toEqual({ id: "u1" })
    expect(adminWrites[0].payload).toMatchObject({
      subscription_tier: "agency",
      subscription_status: "active",
      guides_limit: 99,
      stripe_subscription_id: "sub_1",
    })
  })

  it("still reports success when the profile write fails after the charge (webhook catches up)", async () => {
    adminResult = { error: { message: "db down" } }
    const res = await post({ plan: "agency" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, subscription_tier: "agency" })
    expect(console.error).toHaveBeenCalled()
  })

  it("uses the live subscription found on the customer, not a stale stored id", async () => {
    profile = { ...profile, stripe_subscription_id: "sub_old" }
    h.stripe.subscriptions.list.mockResolvedValue({
      data: [{ ...liveSub(), id: "sub_old", status: "canceled" }, liveSub()],
    })
    await post({ plan: "agency" })
    expect(h.stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", expect.anything())
  })

  it("falls back to the stored subscription id when there is no customer id", async () => {
    profile = { ...profile, stripe_customer_id: null }
    const res = await post({ plan: "agency" })
    expect(res.status).toBe(200)
    expect(h.stripe.subscriptions.list).not.toHaveBeenCalled()
    expect(h.stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_1")
  })
})

describe("refusals", () => {
  it("409s when the user has no subscription at all (use checkout)", async () => {
    profile = { stripe_customer_id: null, stripe_subscription_id: null, subscription_tier: "starter" }
    const res = await post({ plan: "agency" })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/subscri/i)
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  it("409s when the customer has no live subscription", async () => {
    h.stripe.subscriptions.list.mockResolvedValue({ data: [{ ...liveSub(), status: "canceled" }] })
    expect((await post({ plan: "agency" })).status).toBe(409)
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  it("409s when the stored subscription (no customer) is no longer live", async () => {
    profile = { ...profile, stripe_customer_id: null }
    h.stripe.subscriptions.retrieve.mockResolvedValue({ ...liveSub(), status: "canceled" })
    expect((await post({ plan: "agency" })).status).toBe(409)
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  it("409s when the profile has no profile row", async () => {
    profile = null
    expect((await post({ plan: "agency" })).status).toBe(409)
  })

  it("409s for the same plan", async () => {
    h.stripe.subscriptions.list.mockResolvedValue({ data: [liveSub("price_agency")] })
    const res = await post({ plan: "agency" })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already/i)
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  it("409s for a downgrade (those stay in the billing portal)", async () => {
    h.stripe.subscriptions.list.mockResolvedValue({ data: [liveSub("price_agency")] })
    const res = await post({ plan: "pro" })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/manage/i)
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  it("uses the profile tier when the subscription's price is unknown (legacy)", async () => {
    profile = { ...profile, subscription_tier: "agency" }
    h.stripe.subscriptions.list.mockResolvedValue({ data: [liveSub("price_legacy")] })
    expect((await post({ plan: "agency" })).status).toBe(409)
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  it("409s when the current plan cannot be determined (unknown price, no paid tier on the profile)", async () => {
    profile = { ...profile, subscription_tier: "starter" }
    h.stripe.subscriptions.list.mockResolvedValue({ data: [liveSub("price_legacy")] })
    const res = await post({ plan: "agency" })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/manage/i)
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  it("409s while the subscription is past_due (fix payment in Manage first)", async () => {
    h.stripe.subscriptions.list.mockResolvedValue({ data: [liveSub("price_pro", "past_due")] })
    const res = await post({ plan: "agency" })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/payment/i)
    expect(h.stripe.subscriptions.update).not.toHaveBeenCalled()
  })
})

describe("Stripe errors", () => {
  it("maps a declined card to 402 with a user-facing message and no profile write", async () => {
    h.stripe.subscriptions.update.mockRejectedValue(
      Object.assign(new Error("Your card was declined."), { type: "StripeCardError", code: "card_declined" }),
    )
    const res = await post({ plan: "agency" })
    expect(res.status).toBe(402)
    expect((await res.json()).error).toMatch(/card was declined/i)
    expect(adminWrites).toHaveLength(0)
  })

  it("returns a generic 500 for other Stripe failures without leaking details", async () => {
    h.stripe.subscriptions.update.mockRejectedValue(new Error("No such price: price_agency; sk_live"))
    const res = await post({ plan: "agency" })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toMatch(/price_agency|sk_live/)
  })
})

it("rate limits plan changes", async () => {
  let last: Response | undefined
  for (let i = 0; i < 6; i++) last = await post({ plan: "enterprise" })
  expect(last?.status).toBe(429)
})
