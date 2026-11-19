// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest"
import { fakeSupabase, type FakeQuery } from "@/supabase/testing/fake-client"

const h = vi.hoisted(() => ({ userClient: null as unknown, MissingSupabaseConfigError: class extends Error {} }))
vi.mock("@/lib/supabase-server", () => ({
  createClient: async () => h.userClient,
  MissingSupabaseConfigError: h.MissingSupabaseConfigError,
}))

import { GET } from "./route"

let profile: Record<string, unknown> | null
let guide: Record<string, unknown> | null
let guideQuery: FakeQuery | undefined

beforeEach(() => {
  profile = { subscription_tier: "pro", subscription_status: "active" }
  guide = { id: "g1", title: "T", content_md: "# T" }
  guideQuery = undefined
  h.userClient = fakeSupabase((q) => {
    if (q.table === "profiles") return { data: profile }
    guideQuery = q
    return { data: guide }
  }, { id: "u1" }).client
})

const get = (qs = "?guideId=g1") => GET(new Request(`http://x/api/load-style-guide${qs}`))

it("400s without a guideId", async () => {
  expect((await get("")).status).toBe(400)
})

it("401s without a session", async () => {
  h.userClient = fakeSupabase(() => ({}), null).client
  expect((await get()).status).toBe(401)
})

it("loads only the caller's own guide", async () => {
  const res = await get()
  expect(res.status).toBe(200)
  expect(guideQuery?.filters).toEqual({ id: "g1", user_id: "u1" })
  expect(await res.json()).toMatchObject({ id: "g1", subscription_tier: "pro" })
})

it("404s when the guide is missing or not owned", async () => {
  guide = null
  expect((await get()).status).toBe(404)
})

it("returns the effective tier (lapsed Pro -> starter)", async () => {
  profile = { subscription_tier: "pro", subscription_status: "past_due" }
  expect(await (await get()).json()).toMatchObject({ subscription_tier: "starter" })
})
