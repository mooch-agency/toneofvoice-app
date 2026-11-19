import "server-only"
import { lookup as dnsLookup } from "node:dns/promises"
import { isIP } from "node:net"

/**
 * SSRF guard for server-side fetches of user-supplied URLs.
 *
 * `parsePublicHttpUrl` does the synchronous checks (scheme, port, credentials,
 * hostname shape, IP-literal ranges). `assertPublicHttpUrl` adds a DNS check:
 * every address the host resolves to must be public.
 *
 * Residual risk: the fetch does its own DNS lookup, so a host that changes its
 * answer between our check and the fetch (DNS rebinding) is not fully covered.
 * Callers must also re-validate every redirect hop.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeUrlError"
  }
}

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })

const ALLOWED_PORTS = new Set(["", "80", "443"])
const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost", ".localdomain", ".home.arpa"]

/** Trim stray quotes/whitespace and default to https://. */
export function normalizeUrlInput(input: string): string {
  const trimmed = input.trim().replace(/^['"\s]+|['"\s]+$/g, "")
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** Strip IPv6 brackets and a trailing root dot from a URL hostname. */
function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase()
}

/** Synchronous checks. Throws UnsafeUrlError, returns the parsed URL otherwise. */
export function parsePublicHttpUrl(input: string | URL): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new UnsafeUrlError("Invalid URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Only http and https URLs are allowed")
  }
  if (!ALLOWED_PORTS.has(url.port)) throw new UnsafeUrlError("Port not allowed")
  if (url.username || url.password) throw new UnsafeUrlError("Credentials in URL not allowed")

  const host = bareHost(url.hostname)
  if (!host) throw new UnsafeUrlError("Missing hostname")

  if (isIP(host)) {
    if (!isPublicIpAddress(host)) throw new UnsafeUrlError("Address not allowed")
    return url
  }
  if (!host.includes(".")) throw new UnsafeUrlError("Hostname must be a public domain")
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError("Hostname not allowed")
  }
  return url
}

/** Full check, including that every DNS answer for the host is public. */
export async function assertPublicHttpUrl(
  input: string | URL,
  { lookup = defaultLookup }: { lookup?: LookupFn } = {},
): Promise<URL> {
  const url = parsePublicHttpUrl(input)
  const host = bareHost(url.hostname)
  if (isIP(host)) return url

  let answers: { address: string }[]
  try {
    answers = await lookup(host)
  } catch {
    throw new UnsafeUrlError("Hostname could not be resolved")
  }
  if (answers.length === 0) throw new UnsafeUrlError("Hostname could not be resolved")
  if (!answers.every((a) => isPublicIpAddress(a.address))) {
    throw new UnsafeUrlError("Hostname resolves to a non-public address")
  }
  return url
}

// ---------------------------------------------------------------------------
// IP ranges

type Cidr4 = [base: number, bits: number]

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

function cidr4(spec: string): Cidr4 {
  const [ip, bits] = spec.split("/")
  return [ipv4ToInt(ip)!, Number(bits)]
}

/** IPv4 ranges that are not globally routable unicast (RFC 6890 and friends). */
const BLOCKED_V4: Cidr4[] = [
  "0.0.0.0/8", // "this" network, incl. 0.0.0.0
  "10.0.0.0/8", // private
  "100.64.0.0/10", // CGNAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local (cloud metadata)
  "172.16.0.0/12", // private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1
  "192.88.99.0/24", // 6to4 relay
  "192.168.0.0/16", // private
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, incl. broadcast
].map(cidr4)

function inCidr4(n: number, [base, bits]: Cidr4): boolean {
  if (bits === 0) return true
  const size = 2 ** (32 - bits)
  return Math.floor(n / size) === Math.floor(base / size)
}

function isPublicIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return false
  return !BLOCKED_V4.some((c) => inCidr4(n, c))
}

/** Parse an IPv6 address into eight 16-bit groups, or null. */
function parseIPv6(input: string): number[] | null {
  let ip = input.split("%")[0] // drop zone id
  // Rewrite a trailing dotted IPv4 part ("::ffff:1.2.3.4") as two hex groups.
  const lastColon = ip.lastIndexOf(":")
  const lastPart = ip.slice(lastColon + 1)
  if (lastPart.includes(".")) {
    const v4 = ipv4ToInt(lastPart)
    if (v4 === null) return null
    ip = `${ip.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`
  }

  const halves = ip.split("::")
  if (halves.length > 2) return null
  const toGroups = (s: string) => (s === "" ? [] : s.split(":"))
  const head = toGroups(halves[0])
  const rest = halves.length === 2 ? toGroups(halves[1]) : []
  const parsed = [...head, ...rest].map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN))
  if (parsed.some(Number.isNaN)) return null

  if (halves.length === 1 && parsed.length !== 8) return null
  if (halves.length === 2 && parsed.length > 7) return null
  const zeros = new Array(8 - parsed.length).fill(0)
  return [...parsed.slice(0, head.length), ...zeros, ...parsed.slice(head.length)]
}

function isPublicIPv6(ip: string): boolean {
  const g = parseIPv6(ip)
  if (!g) return false

  // IPv4-mapped (::ffff:a.b.c.d): judge the embedded IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isPublicIPv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`)
  }
  // Only global unicast (2000::/3) is public; this excludes ::, ::1, NAT64
  // (64:ff9b::/96), ULA (fc00::/7), link-local (fe80::/10) and multicast (ff00::/8).
  if ((g[0] & 0xe000) !== 0x2000) return false
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false // documentation
  if (g[0] === 0x2001 && g[1] < 0x0200) return false // Teredo, ORCHID, other IETF assignments
  if (g[0] === 0x2002) return false // 6to4 can embed private IPv4
  return true
}

/** True only for globally routable unicast addresses. */
export function isPublicIpAddress(ip: string): boolean {
  const kind = isIP(ip.split("%")[0])
  if (kind === 4) return isPublicIPv4(ip)
  if (kind === 6) return isPublicIPv6(ip)
  return false
}

// ---------------------------------------------------------------------------
// Domains

/** Common second-level labels under ccTLDs, e.g. co.uk, com.au. Not a full public-suffix list. */
const CC_SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "ltd", "plc", "sch", "nhs", "ne", "or", "go", "gob", "nom"])

/** Approximate registrable domain: "news.bbc.co.uk" -> "bbc.co.uk". IPs are returned as-is. */
export function registrableDomain(hostname: string): string {
  const host = bareHost(hostname)
  if (isIP(host)) return host
  const labels = host.split(".").filter(Boolean)
  if (labels.length <= 2) return labels.join(".")
  const tld = labels[labels.length - 1]
  const sld = labels[labels.length - 2]
  const take = tld.length === 2 && CC_SECOND_LEVEL.has(sld) ? 3 : 2
  return labels.slice(-take).join(".")
}

/** Brand-name hint from a host: "shop.acme.com" -> "acme", "news.bbc.co.uk" -> "bbc". */
export function brandHintFromHost(hostname: string): string {
  const host = bareHost(hostname)
  if (isIP(host)) return host
  return registrableDomain(host).split(".")[0] ?? host
}

/** Whether two URLs belong to the same site (registrable domain, or the same IP). */
export function isSameSite(a: URL, b: URL): boolean {
  return registrableDomain(a.hostname) === registrableDomain(b.hostname)
}
