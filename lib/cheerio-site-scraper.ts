import "server-only"
import * as cheerio from "cheerio"
import { safeGet } from "./safe-fetch"
import { assertPublicHttpUrl, isSameSite, type LookupFn } from "./url-validation"

// Homepage context is optional, so both fetches are hard-capped. Without a
// timeout, sites that tarpit datacenter IPs rather than rejecting them (e.g.
// adidas.com from Vercel's egress) hang until Node's ~120s default socket
// timeout and stall the whole extract request.
export const HOMEPAGE_FETCH_TIMEOUT_MS = 5000
export const SUBPAGE_FETCH_TIMEOUT_MS = 3000
export const MAX_BODY_BYTES = 1024 * 1024
export const MAX_REDIRECTS = 3

const MAX_OUTPUT_CHARS = 7000
const SUBPAGE_LINK = /about|company|team/i
const HIDDEN_ELEMENTS = "script, style, noscript, svg, template, iframe, object"

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
} as const

export interface ScrapeOptions {
  /** Throws for URLs that must not be fetched. Runs before every request, including redirects. */
  assertUrl?: (url: URL) => Promise<unknown>
  /** Resolver used for the connection itself. Defaults to the system resolver. */
  lookup?: LookupFn
  /** Which addresses the socket may connect to. Defaults to public unicast only. */
  isAllowedAddress?: (address: string) => boolean
}

const defaultAssertUrl = (url: URL) => assertPublicHttpUrl(url)

/**
 * Fetch HTML with SSRF checks on every hop: `assertUrl` vets each URL, and
 * `safeGet` re-checks the address it actually connects to (DNS rebinding).
 * Returns null for error statuses and non-HTML responses; throws for unsafe
 * URLs, timeouts and redirect loops.
 */
async function fetchHtml(
  start: URL,
  timeoutMs: number,
  opts: ScrapeOptions,
): Promise<{ html: string; url: URL } | null> {
  const assertUrl = opts.assertUrl ?? defaultAssertUrl
  // One deadline for the whole redirect chain.
  const signal = AbortSignal.timeout(timeoutMs)
  let url = start
  for (let hop = 0; ; hop++) {
    await assertUrl(url)
    const res = await safeGet(url, {
      timeoutMs,
      maxBytes: MAX_BODY_BYTES,
      signal,
      headers: BROWSER_HEADERS,
      lookup: opts.lookup,
      isAllowedAddress: opts.isAllowedAddress,
    })
    const location = res.headers.get("location")
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects")
      url = new URL(location, url)
      continue
    }
    const contentType = res.headers.get("content-type") ?? ""
    if (res.status < 200 || res.status >= 300 || !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return null
    }
    return { html: res.body, url }
  }
}

/** Visible text summary of a page: title, meta description, first headings, body copy. */
function pageSummary($: cheerio.CheerioAPI, bodyChars: number): string[] {
  $(HIDDEN_ELEMENTS).remove()
  const title = $("title").text()
  const metaDesc = $('meta[name="description"]').attr("content") || ""
  const h1 = $("h1").first().text()
  const h2 = $("h2").first().text()
  const main = ($("main").text() || $("body").text()).replace(/\s+/g, " ").trim().slice(0, bodyChars)
  return [title, metaDesc, h1, h2, main]
}

/** First same-site link that looks like an about/company/team page. Skips malformed hrefs. */
function findSubpageLink($: cheerio.CheerioAPI, base: URL): URL | null {
  for (const el of $("a").toArray()) {
    const href = $(el).attr("href") || ""
    if (!SUBPAGE_LINK.test(href) || href.startsWith("#")) continue
    let candidate: URL
    try {
      candidate = new URL(href, base)
    } catch {
      continue
    }
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:") continue
    if (!isSameSite(base, candidate)) continue
    return candidate
  }
  return null
}

/**
 * Fetch a homepage (plus one about-like subpage) and return its visible text.
 * Worst case is HOMEPAGE_FETCH_TIMEOUT_MS + SUBPAGE_FETCH_TIMEOUT_MS, since the
 * subpage is only fetched after the homepage resolves.
 */
export async function fetchAndExtractWithCheerio(url: string, opts: ScrapeOptions = {}): Promise<string> {
  const home = await fetchHtml(new URL(url), HOMEPAGE_FETCH_TIMEOUT_MS, opts)
  if (!home) return ""

  const $ = cheerio.load(home.html)
  const subUrl = findSubpageLink($, home.url)
  const parts = pageSummary($, 2000)

  if (subUrl) {
    try {
      const sub = await fetchHtml(subUrl, SUBPAGE_FETCH_TIMEOUT_MS, opts)
      if (sub) parts.push(`\n[Subpage: ${sub.url.href}]\n${pageSummary(cheerio.load(sub.html), 1500).join("\n")}`)
    } catch {
      // A failed subpage must not sink the homepage content we already have.
    }
  }

  return parts.filter(Boolean).join("\n").slice(0, MAX_OUTPUT_CHARS)
}
