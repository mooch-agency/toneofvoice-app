// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeSupabase, type FakeQuery, type FakeResult } from "@/test/supabase-fake"
import { TIER_LIMITS, type Tier } from "@/lib/tiers"

const h = vi.hoisted(() => ({
  userClient: null as unknown,
  MissingSupabaseConfigError: class extends Error {},
}))

vi.mock("@/lib/supabase-server", () => ({
  createClient: async () => h.userClient,
  MissingSupabaseConfigError: h.MissingSupabaseConfigError,
}))

import { POST } from "./route"

let profile: Record<string, unknown>
let used: number
let writes: FakeQuery[]
let insertResult: FakeResult
let updateResult: FakeResult

function setUser(user: { id: string } | null = { id: "u1" }) {
  h.userClient = fakeSupabase((q) => {
    if (q.table === "profiles") return { data: profile }
    if (q.table === "style_guides" && q.op === "select") return { count: used, data: null }
    if (q.table === "style_guides" && q.op === "insert") {
      writes.push(q)
      return insertResult
    }
    if (q.table === "style_guides" && q.op === "update") {
      writes.push(q)
      return updateResult
    }
    return {}
  }, user).client
}

const post = (body: unknown) =>
  POST(new Request("http://x/api/save-style-guide", { method: "POST", body: JSON.stringify(body) }))

const valid = { title: "Acme guide", brand_name: "Acme", content_md: "# Acme", brand_details: { name: "Acme" } }

beforeEach(() => {
  profile = { subscription_tier: "starter", subscription_status: null }
  used = 0
  writes = []
  insertResult = { data: { id: "g_new", title: "Acme guide", created_at: "now" } }
  updateResult = { data: { id: "g1", title: "Acme guide", updated_at: "now" } }
  vi.spyOn(console, "error").mockImplementation(() => {})
  setUser()
})

it("401s without a session", async () => {
  setUser(null)
  expect((await post(valid)).status).toBe(401)
})

describe("validation", () => {
  it.each([
    ["missing title", { ...valid, title: "" }],
    ["missing content", { ...valid, content_md: undefined }],
    ["non-string content", { ...valid, content_md: { evil: true } }],
    ["non-string title", { ...valid, title: ["x"] }],
    ["array brand_details", { ...valid, brand_details: [1, 2] }],
    ["non-string guide_id", { ...valid, guide_id: 5 }],
  ])("400s on %s", async (_name, body) => {
    expect((await post(body)).status).toBe(400)
    expect(writes).toHaveLength(0)
  })

  it("413s when content_md is over 200 KB", async () => {
    const res = await post({ ...valid, content_md: "x".repeat(200 * 1024 + 1) })
    expect(res.status).toBe(413)
    expect(writes).toHaveLength(0)
  })

  it("400s on invalid JSON", async () => {
    const res = await POST(new Request("http://x", { method: "POST", body: "{nope" }))
    expect(res.status).toBe(400)
  })
})

describe("update", () => {
  it("updates only the caller's own guide, with the shared row shape", async () => {
    const res = await post({ ...valid, guide_id: "g1", title: "t".repeat(300) })
    expect(res.status).toBe(200)
    expect(writes[0].filters).toEqual({ id: "g1", user_id: "u1" })
    expect(writes[0].payload).toMatchObject({
      title: "t".repeat(255),
      brand_name: "Acme",
      content_md: "# Acme",
      plan_type: "style_guide",
      brand_details: { name: "Acme" },
    })
  })

  it("404s when the guide is not the caller's", async () => {
    updateResult = { data: null }
    expect((await post({ ...valid, guide_id: "g_other" })).status).toBe(404)
  })
})

describe("create and limits (SEC-12)", () => {
  const cases = (Object.keys(TIER_LIMITS) as Tier[]).map((tier) => [tier, TIER_LIMITS[tier]] as const)

  it.each(cases)("%s: allows a new guide below the limit of %i", async (tier, limit) => {
    profile = { subscription_tier: tier, subscription_status: "active" }
    used = limit - 1
    const res = await post(valid)
    expect(res.status).toBe(200)
    expect(writes).toHaveLength(1)
    expect(writes[0].op).toBe("insert")
    expect(writes[0].payload).toMatchObject({ user_id: "u1", title: "Acme guide" })
  })

  it.each(cases)("%s: 403s at the limit of %i and never overwrites another guide", async (tier, limit) => {
    profile = { subscription_tier: tier, subscription_status: "active" }
    used = limit
    const res = await post(valid)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "GUIDE_LIMIT", limit, used: limit })
    expect(writes).toHaveLength(0)
  })

  it("uses the effective tier: a past_due Pro user has the Starter limit", async () => {
    profile = { subscription_tier: "pro", subscription_status: "past_due" }
    used = 1
    expect((await post(valid)).status).toBe(403)
  })

  it("maps the database guide-limit trigger to 403 (race-safe)", async () => {
    insertResult = { error: { code: "P0001", message: "guide_limit_reached" } }
    expect((await post(valid)).status).toBe(403)
  })
})

describe("errors (SEC-20)", () => {
  it("returns a generic message on database errors", async () => {
    insertResult = { error: { code: "23505", message: 'duplicate key value violates unique constraint "style_guides_pkey"' } }
    const res = await post(valid)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain("style_guides")
  })

  it("returns a generic message on update errors", async () => {
    updateResult = { error: { message: 'column "foo" of relation "style_guides" does not exist' } }
    const res = await post({ ...valid, guide_id: "g1" })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain("style_guides")
  })
})
