// @vitest-environment node
import { afterAll, describe, expect, it, vi } from "vitest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createServer as createTlsServer } from "node:tls"
import type { AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"

vi.mock("server-only", () => ({}))

import { safeGet } from "./safe-fetch"
import { UnsafeUrlError, type LookupFn } from "./url-validation"

const closers: (() => Promise<void>)[] = []

afterAll(async () => {
  await Promise.all(closers.map((c) => c()))
})

/** Throwaway HTTP server on 127.0.0.1; records every request path in `hits`. */
async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const hits: string[] = []
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? "")
    handler(req, res)
  })
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { port, hits, base: `http://127.0.0.1:${port}` }
}

/** Lookup that answers with fixed addresses and counts its calls. */
function fixedLookup(...addresses: string[]) {
  return vi.fn<LookupFn>(async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })))
}

const allowLoopback = (address: string) => address === "127.0.0.1"
const OPTS = { timeoutMs: 2000, maxBytes: 1024 * 1024 }

describe("safeGet", () => {
  it("refuses a hostname whose lookup returns 127.0.0.1 before connecting", async () => {
    const { port, hits } = await startServer((_req, res) => res.end("SECRET"))
    const lookup = fixedLookup("127.0.0.1")

    await expect(safeGet(`http://rebind.example:${port}/`, { ...OPTS, lookup })).rejects.toThrow(UnsafeUrlError)
    expect(lookup).toHaveBeenCalledWith("rebind.example")
    expect(hits).toEqual([])
  })

  it("refuses a hostname when any one of its addresses is private", async () => {
    const { port, hits } = await startServer((_req, res) => res.end("SECRET"))
    const lookup = fixedLookup("93.184.216.34", "127.0.0.1")

    await expect(safeGet(`http://mixed.example:${port}/`, { ...OPTS, lookup })).rejects.toThrow(UnsafeUrlError)
    expect(hits).toEqual([])
  })

  it("refuses a hostname that does not resolve", async () => {
    const lookup = fixedLookup()
    await expect(safeGet("http://empty.example/", { ...OPTS, lookup })).rejects.toThrow(UnsafeUrlError)

    const failing = vi.fn<LookupFn>(async () => {
      throw new Error("ENOTFOUND")
    })
    await expect(safeGet("http://nx.example/", { ...OPTS, lookup: failing })).rejects.toThrow(UnsafeUrlError)
  })

  it("refuses private IP-literal hosts without a lookup or a connection", async () => {
    const { port, hits } = await startServer((_req, res) => res.end("SECRET"))
    const lookup = fixedLookup("93.184.216.34")

    for (const url of [
      `http://127.0.0.1:${port}/`,
      `http://[::1]:${port}/`,
      `http://[::ffff:127.0.0.1]:${port}/`,
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
    ]) {
      await expect(safeGet(url, { ...OPTS, lookup })).rejects.toThrow(UnsafeUrlError)
    }
    expect(lookup).not.toHaveBeenCalled()
    expect(hits).toEqual([])
  })

  it("refuses non-http schemes", async () => {
    await expect(safeGet("file:///etc/passwd", OPTS)).rejects.toThrow(UnsafeUrlError)
    await expect(safeGet("ftp://example.com/", OPTS)).rejects.toThrow(UnsafeUrlError)
  })

  it("fetches through the injected lookup when the address is explicitly allowed", async () => {
    let hostHeader: string | undefined
    const { port } = await startServer((req, res) => {
      hostHeader = req.headers.host
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Test": "yes" })
      res.end("<title>Hello</title> café")
    })
    const lookup = fixedLookup("127.0.0.1")

    const res = await safeGet(`http://public.test:${port}/page?q=1`, {
      ...OPTS,
      lookup,
      isAllowedAddress: allowLoopback,
      headers: { "User-Agent": "test-agent" },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(res.headers.get("x-test")).toBe("yes")
    expect(res.body).toBe("<title>Hello</title> café")
    expect(res.url.href).toBe(`http://public.test:${port}/page?q=1`)
    expect(hostHeader).toBe(`public.test:${port}`)
    expect(lookup).toHaveBeenCalledWith("public.test")
  })

  it("checks every answer with the injected allow-list, not only the first", async () => {
    const { port, hits } = await startServer((_req, res) => res.end("SECRET"))
    const lookup = fixedLookup("127.0.0.1", "10.0.0.5")

    await expect(
      safeGet(`http://public.test:${port}/`, { ...OPTS, lookup, isAllowedAddress: allowLoopback }),
    ).rejects.toThrow(UnsafeUrlError)
    expect(hits).toEqual([])
  })

  it("checks IP-literal hosts with the injected allow-list", async () => {
    const { base } = await startServer((_req, res) => res.end("ok"))
    const res = await safeGet(base + "/", { ...OPTS, isAllowedAddress: allowLoopback })
    expect(res.body).toBe("ok")
  })

  it("does not follow redirects and returns the Location to the caller", async () => {
    const { port, hits } = await startServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(302, { Location: "/target" })
        return res.end("redirect body")
      }
      res.end("target")
    })

    const res = await safeGet(`http://public.test:${port}/`, {
      ...OPTS,
      lookup: fixedLookup("127.0.0.1"),
      isAllowedAddress: allowLoopback,
    })

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/target")
    expect(hits).toEqual(["/"])
  })

  it("stops reading the body at maxBytes and closes the connection", async () => {
    let serverSawClose = false
    const { port } = await startServer((_req, res) => {
      res.on("close", () => (serverSawClose = true))
      res.writeHead(200, { "Content-Type": "text/html" })
      res.write("start ")
      const chunk = "x".repeat(16 * 1024)
      let sent = 0
      // Keep streaming until the client hangs up (bounded so a bug cannot hang the test).
      const pump = () => {
        while (sent < 200 && res.write(chunk)) sent++
        if (sent < 200 && !res.destroyed) res.once("drain", pump)
        else res.end(" LATE-MARKER")
      }
      pump()
    })

    const started = Date.now()
    const res = await safeGet(`http://public.test:${port}/`, {
      timeoutMs: 5000,
      maxBytes: 1000,
      lookup: fixedLookup("127.0.0.1"),
      isAllowedAddress: allowLoopback,
    })

    expect(Buffer.byteLength(res.body)).toBe(1000)
    expect(res.body.startsWith("start ")).toBe(true)
    expect(res.body).not.toContain("LATE-MARKER")
    expect(Date.now() - started).toBeLessThan(2000)
    await vi.waitFor(() => expect(serverSawClose).toBe(true))
  })

  it("decodes gzip responses and applies the cap to the decoded size", async () => {
    const { port } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" })
      res.end(gzipSync("<title>Zipped</title>" + "y".repeat(100_000)))
    })
    const opts = { lookup: fixedLookup("127.0.0.1"), isAllowedAddress: allowLoopback }

    const small = await safeGet(`http://public.test:${port}/`, { ...opts, timeoutMs: 2000, maxBytes: 50 })
    expect(small.body).toBe("<title>Zipped</title>" + "y".repeat(29))

    const full = await safeGet(`http://public.test:${port}/`, { ...opts, timeoutMs: 2000, maxBytes: 1_000_000 })
    expect(full.body.length).toBe(100_021)
  })

  it("times out on a server that never responds", async () => {
    const { port } = await startServer(() => {
      /* tarpit: never respond */
    })

    const started = Date.now()
    await expect(
      safeGet(`http://public.test:${port}/`, {
        timeoutMs: 300,
        maxBytes: 1000,
        lookup: fixedLookup("127.0.0.1"),
        isAllowedAddress: allowLoopback,
      }),
    ).rejects.toThrow(/timed out/i)
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(1500)
  })

  it("times out on a slow-drip body even though bytes keep arriving", async () => {
    const { port } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" })
      const timer = setInterval(() => (res.destroyed ? clearInterval(timer) : res.write("x")), 50)
      res.on("close", () => clearInterval(timer))
    })

    const started = Date.now()
    await expect(
      safeGet(`http://public.test:${port}/`, {
        timeoutMs: 400,
        maxBytes: 1_000_000,
        lookup: fixedLookup("127.0.0.1"),
        isAllowedAddress: allowLoopback,
      }),
    ).rejects.toThrow(/timed out/i)
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it("honours the abort signal, including one that is already aborted", async () => {
    const { port, hits } = await startServer(() => {
      /* tarpit */
    })
    const opts = { ...OPTS, lookup: fixedLookup("127.0.0.1"), isAllowedAddress: allowLoopback }
    const url = `http://public.test:${port}/`

    const pre = new AbortController()
    pre.abort()
    await expect(safeGet(url, { ...opts, signal: pre.signal })).rejects.toThrow()
    expect(hits).toEqual([])

    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 100)
    const started = Date.now()
    await expect(safeGet(url, { ...opts, signal: ctrl.signal })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it("sends the hostname as TLS SNI while connecting to the validated address", async () => {
    // No certificate: the handshake fails, but SNICallback sees the ClientHello first.
    const sniNames: string[] = []
    const server = createTlsServer({
      SNICallback: (name, cb) => {
        sniNames.push(name)
        cb(new Error("no certificate"))
      },
    })
    server.on("tlsClientError", () => {})
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    const lookup = fixedLookup("127.0.0.1")

    await expect(
      safeGet(`https://public.test:${port}/`, { ...OPTS, lookup, isAllowedAddress: allowLoopback }),
    ).rejects.toThrow()
    expect(lookup).toHaveBeenCalledWith("public.test")
    expect(sniNames).toEqual(["public.test"])
  })
})
