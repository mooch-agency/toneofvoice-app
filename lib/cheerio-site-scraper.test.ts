import { afterAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import {
  HOMEPAGE_FETCH_TIMEOUT_MS,
  SUBPAGE_FETCH_TIMEOUT_MS,
  fetchAndExtractWithCheerio,
} from "./cheerio-site-scraper"

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

    const out = await fetchAndExtractWithCheerio(base + "/")

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
    await expect(fetchAndExtractWithCheerio(base + "/")).rejects.toThrow()
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
    const out = await fetchAndExtractWithCheerio(base + "/")
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
    const out = await fetchAndExtractWithCheerio(base + "/")
    const elapsed = Date.now() - started

    expect(out).toContain("Fast")
    expect(elapsed).toBeLessThan(1000)
  })
})
