// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest"
import { fakeSupabase } from "@/test/supabase-fake"
import { TIER_LIMITS } from "@/lib/tiers"

const h = vi.hoisted(() => ({ userClient: null as unknown, MissingSupabaseConfigError: class extends Error {} }))
vi.mock("@/lib/supabase-server", () => ({
  createClient: async () => h.userClient,
  MissingSupabaseConfigError: h.MissingSupabaseConfigError,
}))

import { GET } from "./route"

let profile: Record<string, unknown> | null
let used: number

beforeEach(() => {
  profile = { subscription_tier: "starter", subscription_status: null }
  used = 0
  h.userClient = fakeSupabase(
    (q) => (q.table === "profiles" ? { data: profile } : { count: used }),
    { id: "u1" },
  ).client
})

it("401s without a session", async () => {
  h.userClient = fakeSupabase(() => ({}), null).client
  expect((await GET()).status).toBe(401)
})

it("starter with one guide is at the limit (was never at limit before)", async () => {
  used = 1
  expect(await (await GET()).json()).toEqual({
    subscription_tier: "starter",
    limit: TIER_LIMITS.starter,
    used: 1,
    atLimit: true,
  })
})

it("pro below the limit", async () => {
  profile = { subscription_tier: "pro", subscription_status: "active" }
  used = 1
  expect(await (await GET()).json()).toMatchObject({ subscription_tier: "pro", limit: TIER_LIMITS.pro, atLimit: false })
})

it("uses the effective tier for lapsed subscriptions", async () => {
  profile = { subscription_tier: "agency", subscription_status: "unpaid" }
  used = 1
  expect(await (await GET()).json()).toMatchObject({ subscription_tier: "starter", atLimit: true })
})
