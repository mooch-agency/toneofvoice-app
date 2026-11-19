// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest"
import { fakeSupabase, type FakeQuery, type FakeResult } from "@/test/supabase-fake"

const h = vi.hoisted(() => ({ userClient: null as unknown, MissingSupabaseConfigError: class extends Error {} }))
vi.mock("@/lib/supabase-server", () => ({
  createClient: async () => h.userClient,
  MissingSupabaseConfigError: h.MissingSupabaseConfigError,
}))

import { DELETE } from "./route"

let result: FakeResult
let deletes: FakeQuery[]

beforeEach(() => {
  result = { data: [{ id: "g1" }] }
  deletes = []
  vi.spyOn(console, "error").mockImplementation(() => {})
  h.userClient = fakeSupabase((q) => {
    if (q.op === "delete") deletes.push(q)
    return result
  }, { id: "u1" }).client
})

const del = (qs = "?guideId=g1") =>
  DELETE(new Request(`http://x/api/delete-style-guide${qs}`, { method: "DELETE" }))

it("400s without a guideId", async () => {
  expect((await del("")).status).toBe(400)
})

it("401s without a session", async () => {
  h.userClient = fakeSupabase(() => ({}), null).client
  expect((await del()).status).toBe(401)
})

it("deletes only the caller's own guide", async () => {
  const res = await del()
  expect(res.status).toBe(200)
  expect(deletes).toHaveLength(1)
  expect(deletes[0].filters).toEqual({ id: "g1", user_id: "u1" })
})

it("404s when nothing was deleted", async () => {
  result = { data: [] }
  expect((await del()).status).toBe(404)
})

it("does not leak database error text (SEC-20)", async () => {
  result = { error: { message: 'update or delete on table "style_guides" violates foreign key constraint' } }
  const res = await del()
  expect(res.status).toBe(500)
  expect(await res.text()).not.toContain("style_guides")
})
