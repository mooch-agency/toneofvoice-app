// @vitest-environment node
import { afterAll, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

vi.mock("server-only", () => ({}))

import {
  HOMEPAGE_FETCH_TIMEOUT_MS,
  MAX_BODY_BYTES,
  SUBPAGE_FETCH_TIMEOUT_MS,
  fetchAndExtractWithCheerio,
} from "./cheerio-site-scraper"
import { UnsafeUrlError, assertPublicHttpUrl, type LookupFn } from "./url-validation"

// The default validators reject 127.0.0.1, so tests that talk to a local
// server swap in validators that treat the test servers as public: one for the
// pre-request URL check and one for the address the socket connects to.
const allowAll = { assertUrl: async (u: URL) => u, isAllowedAddress: () => true }

const loopbackLookup: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }]
const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }]

const servers: Server[] = []

// Spin up a throwaway HTTP server and return its base URL.
async function startServer(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

afterAll(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  )
})

const PAGE = `<!doctype html><html><head>
  <title>Acme Corp</title>
  <meta name="description" content="We make excellent widgets.">
</head><body><main>
  <h1>Widgets for everyone</h1>
  <h2>Built to last</h2>
  <p>Acme has shipped widgets since 1952.</p>
  <a href="/about">About us</a>
</main></body></html>`

describe("fetchAndExtractWithCheerio", () => {
  it("extracts title, meta, headings and body copy from a normal page", async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(PAGE)
    })

    const out = await fetchAndExtractWithCheerio(base + "/", allowAll)

    expect(out).toContain("Acme Corp")
    expect(out).toContain("We make excellent widgets.")
    expect(out).toContain("Widgets for everyone")
    expect(out).toContain("shipped widgets since 1952")
  })

  // The regression this guards: before the fix the homepage fetch had no
  // AbortSignal, so a tarpitting host hung for Node's ~120s socket default.
  it("gives up on a tarpitting homepage at the cap instead of hanging", async () => {
    const base = await startServer(() => {
      /* never respond, never close: simulates a tarpit */
    })

    const started = Date.now()
    await expect(fetchAndExtractWithCheerio(base + "/", allowAll)).rejects.toThrow()
    const elapsed = Date.now() - started

    expect(elapsed).toBeGreaterThanOrEqual(HOMEPAGE_FETCH_TIMEOUT_MS - 500)
    expect(elapsed).toBeLessThan(HOMEPAGE_FETCH_TIMEOUT_MS + 2000)
  }, 30_000)

  // A stalled subpage must not sink the homepage content we already have.
  it("still returns homepage content when the subpage tarpits", async () => {
    let base = ""
    base = await startServer((req, res) => {
      if (req.url?.startsWith("/about")) return // tarpit the subpage only
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(PAGE)
    })

    const started = Date.now()
    const out = await fetchAndExtractWithCheerio(base + "/", allowAll)
    const elapsed = Date.now() - started

    expect(out).toContain("Acme Corp")
    expect(out).not.toContain("[Subpage:")
    expect(elapsed).toBeGreaterThanOrEqual(SUBPAGE_FETCH_TIMEOUT_MS - 500)
    expect(elapsed).toBeLessThan(
      HOMEPAGE_FETCH_TIMEOUT_MS + SUBPAGE_FETCH_TIMEOUT_MS + 2000
    )
  }, 30_000)

  it("completes well within the cap for a fast page", async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end("<html><head><title>Fast</title></head><body>quick</body></html>")
    })

    const started = Date.now()
    const out = await fetchAndExtractWithCheerio(base + "/", allowAll)
    const elapsed = Date.now() - started

    expect(out).toContain("Fast")
    expect(elapsed).toBeLessThan(1000)
  })

  it("rejects a private address with the default validator before any request", async () => {
    const hits: string[] = []
    const base = await startServer((req, res) => {
      hits.push(req.url ?? "")
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(PAGE)
    })

    await expect(fetchAndExtractWithCheerio(base + "/")).rejects.toThrow(UnsafeUrlError)
    expect(hits).toEqual([])
  })

  it("does not follow a redirect to a private host", async () => {
    const privateHits: string[] = []
    const privateBase = await startServer((req, res) => {
      privateHits.push(req.url ?? "")
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end("<title>SECRET-INTERNAL-TOKEN</title>")
    })
    const privatePort = new URL(privateBase).port
    const publicBase = await startServer((_req, res) => {
      res.writeHead(302, { Location: `${privateBase}/latest/meta-data/` })
      res.end()
    })
    const opts = {
      assertUrl: async (u: URL) => {
        if (u.port === privatePort) throw new UnsafeUrlError("private")
        return u
      },
    }

    await expect(fetchAndExtractWithCheerio(publicBase + "/", opts)).rejects.toThrow(UnsafeUrlError)
    expect(privateHits).toEqual([])
  })

  it("follows up to 3 redirects and gives up after that", async () => {
    const base = await startServer((req, res) => {
      const m = /^\/r(\d)$/.exec(req.url ?? "")
      if (m && Number(m[1]) > 0) {
        res.writeHead(301, { Location: `/r${Number(m[1]) - 1}` })
        return res.end()
      }
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(PAGE)
    })

    expect(await fetchAndExtractWithCheerio(base + "/r3", allowAll)).toContain("Acme Corp")
    await expect(fetchAndExtractWithCheerio(base + "/r4", allowAll)).rejects.toThrow()
  })

  it("does not fetch an about link on another site", async () => {
    const hits: string[] = []
    let base = ""
    base = await startServer((req, res) => {
      hits.push(req.url ?? "")
      res.writeHead(200, { "Content-Type": "text/html" })
      const offSite = base.replace("127.0.0.1", "localhost")
      res.end(`<html><head><title>Home</title></head><body><main>Hello there, we sell things.
        <a href="${offSite}/about">About</a></main></body></html>`)
    })

    const out = await fetchAndExtractWithCheerio(base + "/", allowAll)

    expect(out).toContain("Home")
    expect(out).not.toContain("[Subpage:")
    expect(hits).toEqual(["/"])
  })

  it("ignores malformed hrefs and still returns homepage content", async () => {
    const base = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" })
      if (req.url === "/about") return res.end("<title>About Acme</title>")
      res.end(`<html><head><title>Acme Corp</title></head><body><main>Real copy.
        <a href="//[about">Broken about</a><a href="/about">About</a></main></body></html>`)
    })

    const out = await fetchAndExtractWithCheerio(base + "/", allowAll)

    expect(out).toContain("Acme Corp")
    expect(out).toContain("About Acme")
  })

  it("excludes script, style and other non-visible text", async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(`<html><head><title>T</title><style>a{color:red}</style></head><body>
        <script>window.__CONFIG={"apiKey":"abc"};function x(){}</script>
        <noscript>Enable JS</noscript><template>tmpl</template><svg><text>svgtext</text></svg>
        Visible copy.</body></html>`)
    })

    const out = await fetchAndExtractWithCheerio(base + "/", allowAll)

    expect(out).toContain("Visible copy.")
    for (const hidden of ["apiKey", "color:red", "Enable JS", "tmpl", "svgtext"]) {
      expect(out).not.toContain(hidden)
    }
  })

  it("returns an empty string for an error status", async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/html" })
      res.end("<title>Not Found</title>")
    })

    expect(await fetchAndExtractWithCheerio(base + "/", allowAll)).toBe("")
  })

  it("returns an empty string for a non-HTML response", async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/pdf" })
      res.end("%PDF-1.4 <title>nope</title>")
    })

    expect(await fetchAndExtractWithCheerio(base + "/", allowAll)).toBe("")
  })

  it("stops reading the body after the size cap", async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.write("<html><head><title>Big</title></head><body><main>start of page ")
      const chunk = "x".repeat(64 * 1024)
      for (let i = 0; i < (2 * MAX_BODY_BYTES) / chunk.length; i++) res.write(chunk)
      res.end(" LATE-MARKER</main></body></html>")
    })

    const out = await fetchAndExtractWithCheerio(base + "/", allowAll)

    expect(out).toContain("start of page")
    expect(out).not.toContain("LATE-MARKER")
    expect(out.length).toBeLessThanOrEqual(7000)
  })

  it("refuses a private address at connect time even when the URL check is bypassed", async () => {
    const hits: string[] = []
    const base = await startServer((req, res) => {
      hits.push(req.url ?? "")
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(PAGE)
    })

    const opts = { assertUrl: async (u: URL) => u }
    await expect(fetchAndExtractWithCheerio(base + "/", opts)).rejects.toThrow(UnsafeUrlError)
    expect(hits).toEqual([])
  })

  it("is not fooled by DNS rebinding between the URL check and the connection", async () => {
    const hits: string[] = []
    const base = await startServer((req, res) => {
      hits.push(req.url ?? "")
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end("<title>SECRET-INTERNAL-TOKEN</title>")
    })
    const port = new URL(base).port
    // The check sees a public answer; the connection-time lookup sees loopback.
    const opts = {
      assertUrl: (u: URL) => assertPublicHttpUrl(new URL(u.href.replace(`:${port}`, "")), { lookup: publicLookup }),
      lookup: loopbackLookup,
    }

    await expect(fetchAndExtractWithCheerio(`http://rebind.example:${port}/`, opts)).rejects.toThrow(UnsafeUrlError)
    expect(hits).toEqual([])
  })

  it("connects to the address its own lookup validated", async () => {
    let hostHeader = ""
    const base = await startServer((req, res) => {
      hostHeader = req.headers.host ?? ""
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(PAGE)
    })
    const port = new URL(base).port

    const out = await fetchAndExtractWithCheerio(`http://acme.test:${port}/`, {
      ...allowAll,
      lookup: loopbackLookup,
      isAllowedAddress: (a: string) => a === "127.0.0.1",
    })

    expect(out).toContain("Acme Corp")
    expect(out).toContain("[Subpage: http://acme.test:" + port + "/about]")
    expect(hostHeader).toBe(`acme.test:${port}`)
  })
})
