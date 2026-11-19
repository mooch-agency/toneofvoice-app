// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest"
import { fakeSupabase } from "@/test/supabase-fake"

const h = vi.hoisted(() => ({
  stripe: { billingPortal: { sessions: { create: vi.fn() } } },
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

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_live_x"
  process.env.NEXT_PUBLIC_APP_URL = "https://toneofvoice.app"
  h.stripe.billingPortal.sessions.create.mockReset().mockResolvedValue({ url: "https://portal/x" })
  profile = { stripe_customer_id: "cus_1" }
  h.userClient = fakeSupabase((q) => (q.table === "profiles" ? { data: profile } : {}), { id: "u1" }).client
})

it("401s without a session", async () => {
  h.userClient = fakeSupabase(() => ({}), null).client
  expect((await POST()).status).toBe(401)
})

it("400s when the user has no Stripe customer", async () => {
  profile = { stripe_customer_id: null }
  expect((await POST()).status).toBe(400)
  expect(h.stripe.billingPortal.sessions.create).not.toHaveBeenCalled()
})

it("opens the portal for the user's own customer", async () => {
  const res = await POST()
  expect(await res.json()).toEqual({ url: "https://portal/x" })
  expect(h.stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
    customer: "cus_1",
    return_url: "https://toneofvoice.app/dashboard/billing",
  })
})

it("503s when Stripe is not configured", async () => {
  delete process.env.STRIPE_SECRET_KEY
  expect((await POST()).status).toBe(503)
})
