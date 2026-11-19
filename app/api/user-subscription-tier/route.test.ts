// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest"
import { fakeSupabase } from "@/test/supabase-fake"

const h = vi.hoisted(() => ({ userClient: null as unknown, MissingSupabaseConfigError: class extends Error {} }))
vi.mock("@/lib/supabase-server", () => ({
  createClient: async () => h.userClient,
  MissingSupabaseConfigError: h.MissingSupabaseConfigError,
}))

import { GET } from "./route"

let profile: Record<string, unknown> | null

beforeEach(() => {
  profile = null
  h.userClient = fakeSupabase((q) => (q.table === "profiles" ? { data: profile } : {}), { id: "u1" }).client
})

it("401s without a session", async () => {
  h.userClient = fakeSupabase(() => ({}), null).client
  expect((await GET()).status).toBe(401)
})

it.each([
  [{ subscription_tier: "pro", subscription_status: "active" }, "pro"],
  [{ subscription_tier: "free", subscription_status: null }, "starter"],
  [{ subscription_tier: "agency", subscription_status: "past_due" }, "starter"],
  [null, "starter"],
])("profile %j -> %s", async (p, expected) => {
  profile = p
  expect(await (await GET()).json()).toEqual({ subscription_tier: expected })
})
