// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PLACEHOLDERS } from "@/lib/guide-placeholders"

type Query = {
  table: string
  op: "select" | "update"
  filters: [string, string, unknown][]
  values?: Record<string, unknown>
  options?: Record<string, unknown>
}

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "owner@example.com" } as { id: string; email?: string } | null,
  profile: { subscription_tier: "pro", subscription_status: "active" } as Record<string, unknown> | null,
  guide: null as Record<string, unknown> | null,
  updateResult: { error: null, count: 1 } as { error: unknown; count: number | null },
  queries: [] as Query[],
  render: vi.fn(),
  MissingSupabaseConfigError: class MissingSupabaseConfigError extends Error {},
}))

function respond(q: Query) {
  if (q.table === "profiles") return { data: h.profile, error: null }
  if (q.op === "update") return h.updateResult
  return h.guide ? { data: h.guide, error: null } : { data: null, error: { message: "not found" } }
}

function from(table: string) {
  const q: Query = { table, op: "select", filters: [] }
  h.queries.push(q)
  const b = {
    select: () => b,
    eq: (col: string, val: unknown) => (q.filters.push(["eq", col, val]), b),
    is: (col: string, val: unknown) => (q.filters.push(["is", col, val]), b),
    update: (values: Record<string, unknown>, options?: Record<string, unknown>) => {
      q.op = "update"
      q.values = values
      q.options = options
      return b
    },
    single: async () => respond(q),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(respond(q)).then(res, rej),
  }
  return b
}

vi.mock("@/lib/supabase-server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
    from,
  }),
  MissingSupabaseConfigError: h.MissingSupabaseConfigError,
}))

vi.mock("@/lib/template-processor", () => ({ renderFullGuideFromPreview: h.render }))

import { POST, maxDuration } from "./route"
import { resetRateLimits } from "@/lib/rate-limit"

const PREVIEW = `## About Acme\n\nRockets.\n\n## Style Rules\n\n${PLACEHOLDERS.styleRules}\n\n## Questions?\n\nx`
const EXPANDED = "## About Acme\n\nRockets.\n\n## Style Rules\n\nRULES\n\n## Questions?\n\nx"

const post = (body: unknown) =>
  POST(new Request("http://x/api/expand-style-guide", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }))

const updates = () => h.queries.filter((q) => q.op === "update")

beforeEach(() => {
  resetRateLimits()
  h.user = { id: "u1", email: "owner@example.com" }
  h.profile = { subscription_tier: "pro", subscription_status: "active" }
  h.guide = {
    id: "g1",
    content_md: PREVIEW,
    brand_name: "Acme",
    brand_details: { name: "Acme", description: "Rockets.", traits: ["Warm"], productsServices: ["Kits"] },
    updated_at: "2026-11-01T00:00:00.000Z",
  }
  h.updateResult = { error: null, count: 1 }
  h.queries = []
  h.render.mockReset()
  h.render.mockResolvedValue({ markdown: EXPANDED, failedSections: [] })
})

describe("POST /api/expand-style-guide", () => {
  it("exports a maxDuration for the platform", () => {
    expect(maxDuration).toBeGreaterThanOrEqual(60)
  })

  it("rejects anonymous callers without generating", async () => {
    h.user = null
    const res = await post({ guideId: "g1" })
    expect(res.status).toBe(401)
    expect(h.render).not.toHaveBeenCalled()
  })

  it.each([
    [{ subscription_tier: "starter" }],
    [{ subscription_tier: "pro", subscription_status: "past_due" }],
  ])("rejects unpaid or lapsed profiles (%o) with 403", async (profile) => {
    h.profile = profile
    const res = await post({ guideId: "g1" })
    expect(res.status).toBe(403)
    expect(h.render).not.toHaveBeenCalled()
  })

  it.each([[{}], [{ guideId: 5 }], ["not json"]])("returns 400 for a bad body %o", async (body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
  })

  it("returns 404 for a guide the user does not own", async () => {
    h.guide = null
    const res = await post({ guideId: "g1" })
    expect(res.status).toBe(404)
    const guideQuery = h.queries.find((q) => q.table === "style_guides")!
    expect(guideQuery.filters).toContainEqual(["eq", "user_id", "u1"])
  })

  it("returns 400 when the guide has nothing left to unlock", async () => {
    h.guide!.content_md = EXPANDED
    const res = await post({ guideId: "g1" })
    expect(res.status).toBe(400)
    expect(h.render).not.toHaveBeenCalled()
  })

  it("returns 400 when stored brand details have no description", async () => {
    h.guide!.brand_details = { name: "Acme" }
    const res = await post({ guideId: "g1" })
    expect(res.status).toBe(400)
  })

  it("generates with validated brand details and the session email, then saves with a concurrency check", async () => {
    const res = await post({ guideId: "g1", userEmail: "attacker@example.com" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, content: EXPANDED })

    const args = h.render.mock.calls[0][0]
    expect(args.previewContent).toBe(PREVIEW)
    expect(args.userEmail).toBe("owner@example.com")
    expect(args.brandDetails).toMatchObject({ name: "Acme", brandDetailsDescription: "Rockets.", productsServices: ["Kits"] })
    expect(args.signal).toBeInstanceOf(AbortSignal)

    const [update] = updates()
    expect(update.values).toMatchObject({ content_md: EXPANDED })
    expect(update.filters).toEqual([
      ["eq", "id", "g1"],
      ["eq", "user_id", "u1"],
      ["eq", "updated_at", "2026-11-01T00:00:00.000Z"],
    ])
    expect(update.options).toEqual({ count: "exact" })
  })

  it("uses an IS NULL check when the guide has no updated_at", async () => {
    h.guide!.updated_at = null
    await post({ guideId: "g1" })
    expect(updates()[0].filters).toContainEqual(["is", "updated_at", null])
  })

  it("returns 502 with the failed sections and saves nothing (AI-6)", async () => {
    h.render.mockResolvedValue({ markdown: PREVIEW, failedSections: ["style-rules", "word-list"] })
    const res = await post({ guideId: "g1" })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.failedSections).toEqual(["style-rules", "word-list"])
    expect(typeof body.error).toBe("string")
    expect(updates()).toHaveLength(0)
  })

  it("returns 409 when the guide changed during generation (AI-24)", async () => {
    h.updateResult = { error: null, count: 0 }
    const res = await post({ guideId: "g1" })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toEqual(expect.any(String))
  })

  it("returns 409 while the same guide is already expanding", async () => {
    let finish: (v: unknown) => void = () => {}
    h.render.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const first = post({ guideId: "g1" })
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledTimes(1))
    const second = await post({ guideId: "g1" })
    expect(second.status).toBe(409)
    finish({ markdown: EXPANDED, failedSections: [] })
    expect((await first).status).toBe(200)
    expect(h.render).toHaveBeenCalledTimes(1)
  })

  it("returns a generic 500 when saving fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.updateResult = { error: { message: 'duplicate key value violates "style_guides_pkey"' }, count: null }
    const res = await post({ guideId: "g1" })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain("style_guides")
  })

  it("rate limits repeated expansions", async () => {
    h.render.mockResolvedValue({ markdown: PREVIEW, failedSections: ["word-list"] })
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) statuses.push((await post({ guideId: "g1" })).status)
    expect(statuses.slice(0, 5)).toEqual([502, 502, 502, 502, 502])
    expect(statuses[5]).toBe(429)
  })

  it("does not log the user's email or guide content", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")]
    for (const s of spies) s.mockImplementation(() => {})
    h.render.mockResolvedValue({ markdown: PREVIEW, failedSections: ["word-list"] })
    await post({ guideId: "g1" })
    const logged = spies.flatMap((s) => s.mock.calls.flat()).map(String).join("\n")
    expect(logged).not.toContain("owner@example.com")
    expect(logged).not.toContain("Rockets.")
  })
})
