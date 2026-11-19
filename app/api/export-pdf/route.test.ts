// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

type RequestHandler = (req: { url: () => string; continue: () => void; abort: () => void }) => void

const h = vi.hoisted(() => {
  const calls: string[] = []
  const handlers: RequestHandler[] = []
  const page = {
    setJavaScriptEnabled: vi.fn(async (v: boolean) => void calls.push(`js:${v}`)),
    setRequestInterception: vi.fn(async (v: boolean) => void calls.push(`intercept:${v}`)),
    on: vi.fn((event: string, handler: RequestHandler) => {
      if (event === "request") handlers.push(handler)
    }),
    setContent: vi.fn(async () => void calls.push("setContent")),
    pdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
  }
  const browser = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) }
  return {
    calls,
    handlers,
    page,
    browser,
    launch: vi.fn(async () => browser),
    getUser: vi.fn(),
  }
})

vi.mock("server-only", () => ({}))
vi.mock("puppeteer-core", () => ({ default: { launch: h.launch } }))
vi.mock("@/lib/pdf-chrome", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pdf-chrome")>()),
  getChromeLaunchOptions: async () => ({ executablePath: "/chrome", args: [], headless: true }),
}))
vi.mock("@/lib/supabase-server", () => ({
  createClient: async () => ({ auth: { getUser: h.getUser } }),
  MissingSupabaseConfigError: class extends Error {},
}))

import { resetRateLimits } from "@/lib/rate-limit"
import { MAX_PDF_BODY_BYTES } from "@/lib/pdf-chrome"
import { POST } from "./route"

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/export-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const VALID = { html: "<h1>Guide</h1>", css: "h1{color:red}", filename: "My Guide!.pdf" }

beforeEach(() => {
  resetRateLimits()
  h.calls.length = 0
  h.handlers.length = 0
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  h.getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null })
})

describe("POST /api/export-pdf", () => {
  it("401 without a session, and Chrome is never launched", async () => {
    h.getUser.mockResolvedValue({ data: { user: null }, error: null })
    const res = await POST(req(VALID))
    expect(res.status).toBe(401)
    expect(h.launch).not.toHaveBeenCalled()
  })

  it("413 when Content-Length is over the cap", async () => {
    const res = await POST(req(VALID, { "Content-Length": String(MAX_PDF_BODY_BYTES + 1) }))
    expect(res.status).toBe(413)
    expect(h.launch).not.toHaveBeenCalled()
  })

  it("413 for a 5 MB body even without a Content-Length header", async () => {
    const big = JSON.stringify({ ...VALID, html: "x".repeat(5 * 1024 * 1024) })
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big))
        c.close()
      },
    })
    const request = new Request("http://localhost/api/export-pdf", {
      method: "POST",
      body: stream,
      // @ts-expect-error duplex is required for stream bodies in Node
      duplex: "half",
    })
    const res = await POST(request)
    expect(res.status).toBe(413)
    expect(h.launch).not.toHaveBeenCalled()
  })

  it.each([
    ["missing html", { css: "a{}" }],
    ["missing css", { html: "<p>x</p>" }],
    ["css that closes the style tag", { html: "<p>x</p>", css: "a{}</STYLE><script>alert(1)</script>" }],
    ["malformed JSON", "{nope"],
  ])("400 for %s", async (_label, body) => {
    const res = await POST(req(body))
    expect(res.status).toBe(400)
    expect(h.launch).not.toHaveBeenCalled()
  })

  it("disables JavaScript and intercepts requests before loading content", async () => {
    const res = await POST(req(VALID))
    expect(res.status).toBe(200)
    expect(h.calls).toEqual(["js:false", "intercept:true", "setContent"])
    expect(h.handlers).toHaveLength(1)
  })

  it("aborts every request except data:, about:blank and Google Fonts", async () => {
    await POST(req(VALID))
    const handler = h.handlers[0]
    const decide = (url: string) => {
      let outcome = ""
      handler({ url: () => url, continue: () => (outcome = "continue"), abort: () => (outcome = "abort") })
      return outcome
    }

    expect(decide("data:image/png;base64,AAAA")).toBe("continue")
    expect(decide("about:blank")).toBe("continue")
    expect(decide("https://fonts.googleapis.com/css2?family=Playfair+Display")).toBe("continue")
    expect(decide("https://fonts.gstatic.com/s/playfair/v1/x.woff2")).toBe("continue")

    expect(decide("http://169.254.169.254/latest/meta-data/iam/")).toBe("abort")
    expect(decide("http://127.0.0.1:3000/")).toBe("abort")
    expect(decide("file:///etc/passwd")).toBe("abort")
    expect(decide("http://fonts.googleapis.com/css2")).toBe("abort")
    expect(decide("https://fonts.googleapis.com.evil.com/x")).toBe("abort")
    expect(decide("https://evil.com/?fonts.googleapis.com")).toBe("abort")
  })

  it("returns the PDF with a sanitised filename", async () => {
    const res = await POST(req(VALID))
    expect(res.headers.get("Content-Type")).toBe("application/pdf")
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="My_Guide_.pdf"')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]))
    expect(h.browser.close).toHaveBeenCalled()
  })

  it("returns a generic 500 and closes Chrome when rendering fails", async () => {
    h.page.pdf.mockRejectedValueOnce(new Error("Protocol error: /tmp/chromium secret path"))
    const res = await POST(req(VALID))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain("chromium")
    expect(h.browser.close).toHaveBeenCalled()
  })

  it("rate limits per user", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await POST(req(VALID))).status)
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true)
    expect(statuses[10]).toBe(429)
  })
})
