// @vitest-environment node
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  UnsafeUrlError,
  assertPublicHttpUrl,
  brandHintFromHost,
  isPublicIpAddress,
  isSameSite,
  normalizeUrlInput,
  parsePublicHttpUrl,
  type LookupFn,
} from "./url-validation"

const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }]

describe("isPublicIpAddress", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.0.9",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1",
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "not-an-ip",
  ])("rejects %s", (ip) => {
    expect(isPublicIpAddress(ip)).toBe(false)
  })

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"])(
    "accepts %s",
    (ip) => {
      expect(isPublicIpAddress(ip)).toBe(true)
    },
  )
})

describe("parsePublicHttpUrl (no DNS)", () => {
  it.each([
    "http://127.0.0.1",
    "https://localhost",
    "https://localhost.",
    "https://2130706433",
    "https://0x7f000001",
    "https://0x7f.1",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "http://169.254.169.254/latest/meta-data/",
    "https://10.1.2.3",
    "https://0.0.0.0",
    "https://intranet",
    "https://metadata.google.internal",
    "https://printer.local",
    "https://app.localhost",
    "ftp://x.com",
    "file:///etc/passwd",
    "https://x.com:6379",
    "https://user:pass@x.com",
    "not a url",
  ])("rejects %s", (u) => {
    expect(() => parsePublicHttpUrl(u)).toThrow(UnsafeUrlError)
  })

  it.each(["https://acme.com", "http://acme.com:80/about", "https://www.acme.co.uk:443/", "https://93.184.216.34/"])(
    "accepts %s",
    (u) => {
      expect(parsePublicHttpUrl(u)).toBeInstanceOf(URL)
    },
  )
})

describe("assertPublicHttpUrl", () => {
  it("accepts a public hostname that resolves to a public IP", async () => {
    const url = await assertPublicHttpUrl("https://acme.com/about", { lookup: publicLookup })
    expect(url.href).toBe("https://acme.com/about")
  })

  it("rejects a public hostname that resolves to a private IP", async () => {
    await expect(
      assertPublicHttpUrl("https://evil.test", {
        lookup: async () => [{ address: "10.0.0.1", family: 4 }],
      }),
    ).rejects.toThrow(UnsafeUrlError)
  })

  it("rejects when any DNS answer is private", async () => {
    await expect(
      assertPublicHttpUrl("https://evil.test", {
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "::1", family: 6 },
        ],
      }),
    ).rejects.toThrow(UnsafeUrlError)
  })

  it("rejects when DNS returns nothing or fails", async () => {
    await expect(assertPublicHttpUrl("https://empty.test", { lookup: async () => [] })).rejects.toThrow(
      UnsafeUrlError,
    )
    await expect(
      assertPublicHttpUrl("https://nx.test", {
        lookup: async () => {
          throw new Error("ENOTFOUND")
        },
      }),
    ).rejects.toThrow(UnsafeUrlError)
  })

  it("does not call DNS for IP literals", async () => {
    const lookup = vi.fn(publicLookup)
    await assertPublicHttpUrl("https://93.184.216.34/", { lookup })
    expect(lookup).not.toHaveBeenCalled()
    await expect(assertPublicHttpUrl("http://127.0.0.1/", { lookup })).rejects.toThrow(UnsafeUrlError)
  })
})

describe("normalizeUrlInput", () => {
  it("trims quotes and whitespace and adds https", () => {
    expect(normalizeUrlInput(`  "acme.com/about" `)).toBe("https://acme.com/about")
    expect(normalizeUrlInput("http://acme.com")).toBe("http://acme.com")
    expect(normalizeUrlInput("HTTPS://acme.com")).toBe("HTTPS://acme.com")
  })
})

describe("brandHintFromHost", () => {
  it.each([
    ["acme.com", "acme"],
    ["www.acme.com", "acme"],
    ["shop.acme.com", "acme"],
    ["news.bbc.co.uk", "bbc"],
    ["www.bbc.co.uk", "bbc"],
    ["awww.example.com", "example"],
    ["www.example.com.au", "example"],
    ["acme.io", "acme"],
  ])("brandHintFromHost(%s) = %s", (host, hint) => {
    expect(brandHintFromHost(host)).toBe(hint)
  })
})

describe("isSameSite", () => {
  it("treats subdomains of the same registrable domain as same-site", () => {
    expect(isSameSite(new URL("https://www.acme.com/"), new URL("https://acme.com/about"))).toBe(true)
    expect(isSameSite(new URL("https://acme.com/"), new URL("https://about.acme.com/"))).toBe(true)
    expect(isSameSite(new URL("https://news.bbc.co.uk/"), new URL("https://www.bbc.co.uk/about"))).toBe(true)
  })

  it("rejects other domains and other IPs", () => {
    expect(isSameSite(new URL("https://acme.com/"), new URL("https://evil.com/about"))).toBe(false)
    expect(isSameSite(new URL("https://acme.co.uk/"), new URL("https://evil.co.uk/about"))).toBe(false)
    expect(isSameSite(new URL("http://127.0.0.1:1/"), new URL("http://localhost:1/about"))).toBe(false)
  })

  it("compares IP hosts exactly", () => {
    expect(isSameSite(new URL("http://127.0.0.1:1/"), new URL("http://127.0.0.1:2/about"))).toBe(true)
  })
})
