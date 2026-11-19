// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ listUsers: vi.fn() }))
vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => ({ auth: { admin: { listUsers: h.listUsers } } }),
}))

import { GET } from "./route"

const get = (auth?: string) =>
  GET(new Request("http://x/api/cron/keep-alive", { headers: auth ? { authorization: auth } : {} }))

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret"
  h.listUsers.mockReset().mockResolvedValue({ error: null })
  vi.spyOn(console, "error").mockImplementation(() => {})
})

it("401s without the right secret", async () => {
  expect((await get()).status).toBe(401)
  expect((await get("Bearer wrong!")).status).toBe(401)
  expect(h.listUsers).not.toHaveBeenCalled()
})

it("fails closed when CRON_SECRET is unset", async () => {
  delete process.env.CRON_SECRET
  expect((await get("Bearer s3cret")).status).toBe(401)
})

it("pings the database with the right secret", async () => {
  const res = await get("Bearer s3cret")
  expect(res.status).toBe(200)
  expect(h.listUsers).toHaveBeenCalledTimes(1)
})

it("does not leak error details (SEC-20)", async () => {
  h.listUsers.mockResolvedValue({ error: { message: "JWT secret mismatch for project abc" } })
  const res = await get("Bearer s3cret")
  expect(res.status).toBe(502)
  expect(await res.text()).not.toContain("JWT")
})
