// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "./route"

const SECRET = "s3cret-value-for-tests"
const fetchMock = vi.fn()

const VALID = {
  title: "Hello world",
  slug: "hello-world",
  body: "<p>Post body</p>",
  contentSummary: "Short summary",
}

function req(body: unknown, auth?: string) {
  return new Request("http://localhost/api/post-to-webflow", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.stubEnv("WEBFLOW_WEBHOOK_SECRET", SECRET)
  vi.stubEnv("WEBFLOW_SITE_ID", "site1")
  vi.stubEnv("WEBFLOW_COLLECTION_ID", "coll1")
  vi.stubEnv("WEBFLOW_TOKEN", "wf-token")
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset().mockResolvedValue(
    new Response(JSON.stringify({ id: "item1", fieldData: { slug: "hello-world" }, internal: "x" }), { status: 202 }),
  )
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("POST /api/post-to-webflow auth", () => {
  it("401 without an Authorization header", async () => {
    const res = await POST(req(VALID))
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([`Bearer wrong`, `Bearer ${SECRET}x`, SECRET, `Basic ${SECRET}`])("401 for %s", async (auth) => {
    const res = await POST(req(VALID, auth))
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails closed when WEBFLOW_WEBHOOK_SECRET is unset", async () => {
    vi.stubEnv("WEBFLOW_WEBHOOK_SECRET", "")
    for (const auth of ["Bearer ", "Bearer undefined", "Bearer"]) {
      expect((await POST(req(VALID, auth))).status).toBe(401)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("POST /api/post-to-webflow with the secret", () => {
  const auth = `Bearer ${SECRET}`

  it("publishes the item as before and returns only the id and slug", async () => {
    const res = await POST(req(VALID, auth))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, id: "item1", slug: "hello-world" })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.webflow.com/v2/sites/site1/collections/coll1/items")
    const sent = JSON.parse(init.body)
    expect(sent.isDraft).toBe(false)
    expect(sent.fieldData).toMatchObject({
      name: "Hello world",
      slug: "hello-world",
      content: "<p>Post body</p>",
      "content-summary": "Short summary",
    })
  })

  it("accepts Zapier's alternative field names", async () => {
    const res = await POST(req({ Title: "T", Slug: "t", Content: "c" }, auth))
    expect(res.status).toBe(200)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).fieldData).toMatchObject({ name: "T", slug: "t", content: "c" })
  })

  it.each([
    ["missing fields", { title: "only a title, private-marker" }],
    ["a long title", { ...VALID, title: "t".repeat(257) }],
    ["an invalid slug", { ...VALID, slug: "Not A Slug!" }],
    ["a huge body", { ...VALID, body: "b".repeat(200_001) }],
    ["a long summary", { ...VALID, contentSummary: "s".repeat(1001) }],
    ["non-string fields", { ...VALID, title: { evil: true } }],
  ])("400 for %s without echoing the body", async (_label, body) => {
    const res = await POST(req(body, auth))
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain("private-marker")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("400 for malformed JSON", async () => {
    expect((await POST(req("{nope", auth))).status).toBe(400)
  })

  it("502 with a generic body when Webflow rejects the item", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "Validation: token wf-internal" }), { status: 400 }))
    const res = await POST(req(VALID, auth))
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain("wf-internal")
  })

  it("503 when Webflow is not configured", async () => {
    vi.stubEnv("WEBFLOW_TOKEN", "")
    const res = await POST(req(VALID, auth))
    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
