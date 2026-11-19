// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeSupabase, type FakeHandler } from "@/supabase/testing/fake-client"
import { resetRateLimits } from "@/lib/rate-limit"

const h = vi.hoisted(() => ({
  stripe: {
    checkout: { sessions: { retrieve: vi.fn() } },
    subscriptions: { list: vi.fn() },
  },
  userClient: null as unknown,
  admin: null as unknown,
  adminThrows: false,
  MissingSupabaseConfigError: class extends Error {},
}))

vi.mock("stripe", () => ({ default: function Stripe() { return h.stripe } }))
vi.mock("@/lib/supabase-server", () => ({
  createClient: async () => h.userClient,
  MissingSupabaseConfigError: h.MissingSupabaseConfigError,
}))
vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => {
    if (h.adminThrows) throw new Error("Missing Supabase admin env")
    return h.admin
  },
}))

import { POST } from "./route"

const activeSub = (overrides: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "active",
  customer: "cus_1",
  items: { data: [{ price: { id: "price_pro" }, current_period_end: 1_900_000_000 }] },
  ...overrides,
})

const checkoutSession = (overrides: Record<string, unknown> = {}) => ({
  id: "cs_test_1",
  mode: "subscription",
  status: "complete",
  metadata: { user_id: "u1", plan: "agency" },
  subscription: activeSub(),
  ...overrides,
})

let profile: Record<string, unknown> | null
let userWrites: number
let adminUpdates: { filters: Record<string, unknown>; payload: unknown }[]

function setup({ user = { id: "u1" } as { id: string } | null } = {}) {
  userWrites = 0
  adminUpdates = []
  const userHandler: FakeHandler = (q) => {
    if (q.op !== "select") userWrites++
    if (q.table === "profiles") return { data: profile }
    return {}
  }
  h.userClient = fakeSupabase(userHandler, user).client
  h.admin = fakeSupabase((q) => {
    if (q.table === "profiles" && q.op === "update") {
      adminUpdates.push({ filters: q.filters, payload: q.payload })
      return { data: [{ id: "u1" }] }
    }
    return {}
  }).client
}

function post(body?: unknown) {
  return POST(
    new Request("http://x/api/verify-subscription", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  resetRateLimits()
  process.env.STRIPE_SECRET_KEY = "sk_live_x"
  process.env.STRIPE_PRO_PRICE_ID = "price_pro"
  process.env.STRIPE_AGENCY_PRICE_ID = "price_agency"
  delete process.env.STRIPE_MODE
  h.adminThrows = false
  h.stripe.checkout.sessions.retrieve.mockReset()
  h.stripe.subscriptions.list.mockReset()
  profile = { subscription_tier: "starter", subscription_status: null, stripe_customer_id: null }
  vi.spyOn(console, "error").mockImplementation(() => {})
  setup()
})

describe("with session_id", () => {
  it("401s without a session", async () => {
    setup({ user: null })
    expect((await post({ session_id: "cs_test_1" })).status).toBe(401)
  })

  it("rejects a malformed session id", async () => {
    expect((await post({ session_id: "../../v1/customers" })).status).toBe(400)
    expect(h.stripe.checkout.sessions.retrieve).not.toHaveBeenCalled()
  })

  it("activates from the retrieved session, taking the plan from the price, not metadata", async () => {
    h.stripe.checkout.sessions.retrieve.mockResolvedValue(checkoutSession())
    const res = await post({ session_id: "cs_test_1" })
    expect(h.stripe.checkout.sessions.retrieve).toHaveBeenCalledWith("cs_test_1", { expand: ["subscription"] })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ subscription_tier: "pro", updated: true })
    expect(adminUpdates).toHaveLength(1)
    expect(adminUpdates[0].filters).toEqual({ id: "u1" })
    expect(adminUpdates[0].payload).toMatchObject({ subscription_tier: "pro", subscription_status: "active" })
  })

  it("refuses a session that belongs to another user", async () => {
    h.stripe.checkout.sessions.retrieve.mockResolvedValue(
      checkoutSession({ metadata: { user_id: "someone-else", plan: "agency" } }),
    )
    const res = await post({ session_id: "cs_test_1" })
    expect(res.status).toBe(403)
    expect(adminUpdates).toHaveLength(0)
  })

  it("does not re-grant a paid tier when the subscription was cancelled (SEC-5)", async () => {
    h.stripe.checkout.sessions.retrieve.mockResolvedValue(
      checkoutSession({ subscription: activeSub({ status: "canceled" }) }),
    )
    const res = await post({ session_id: "cs_test_1" })
    const body = await res.json()
    expect(body.updated).toBeFalsy()
    expect(body.subscription_tier).toBe("starter")
    expect(adminUpdates).toHaveLength(0)
  })

  it("does nothing for an incomplete checkout", async () => {
    h.stripe.checkout.sessions.retrieve.mockResolvedValue(checkoutSession({ status: "open" }))
    const body = await (await post({ session_id: "cs_test_1" })).json()
    expect(body.updated).toBeFalsy()
    expect(adminUpdates).toHaveLength(0)
  })

  it("never falls back to the user's own client when the admin client fails (SEC-10)", async () => {
    h.adminThrows = true
    h.stripe.checkout.sessions.retrieve.mockResolvedValue(checkoutSession())
    const res = await post({ session_id: "cs_test_1" })
    expect(res.status).toBe(500)
    expect(userWrites).toBe(0)
  })
})

describe("without session_id", () => {
  it("returns already_active for an active paid profile without calling Stripe", async () => {
    profile = { subscription_tier: "pro", subscription_status: "active", stripe_customer_id: "cus_1" }
    const body = await (await post()).json()
    expect(body).toMatchObject({ subscription_tier: "pro", already_active: true })
    expect(h.stripe.subscriptions.list).not.toHaveBeenCalled()
  })

  it("looks up the user's own customer's subscriptions", async () => {
    profile = { subscription_tier: "starter", subscription_status: null, stripe_customer_id: "cus_1" }
    h.stripe.subscriptions.list.mockResolvedValue({ data: [activeSub()] })
    const body = await (await post()).json()
    expect(h.stripe.subscriptions.list).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_1" }))
    expect(body).toMatchObject({ subscription_tier: "pro", updated: true })
    expect(adminUpdates[0].filters).toEqual({ id: "u1" })
  })

  it("does nothing when the customer has no active subscription", async () => {
    profile = { subscription_tier: "starter", subscription_status: null, stripe_customer_id: "cus_1" }
    h.stripe.subscriptions.list.mockResolvedValue({ data: [activeSub({ status: "canceled" })] })
    const body = await (await post()).json()
    expect(body).toMatchObject({ subscription_tier: "starter", updated: false })
    expect(adminUpdates).toHaveLength(0)
  })

  it("does nothing (and calls no Stripe API) without a customer id", async () => {
    const body = await (await post()).json()
    expect(body).toMatchObject({ subscription_tier: "starter", updated: false })
    expect(h.stripe.subscriptions.list).not.toHaveBeenCalled()
  })
})

it("rate limits repeated calls", async () => {
  let last: Response | undefined
  for (let i = 0; i < 12; i++) last = await post()
  expect(last?.status).toBe(429)
})
