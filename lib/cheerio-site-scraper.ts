import * as cheerio from "cheerio"

// Homepage context is optional, so both fetches are hard-capped. Without a
// timeout, sites that tarpit datacenter IPs rather than rejecting them (e.g.
// adidas.com from Vercel's egress) hang until Node's ~120s default socket
// timeout and stall the whole extract request.
export const HOMEPAGE_FETCH_TIMEOUT_MS = 5000
export const SUBPAGE_FETCH_TIMEOUT_MS = 3000

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
} as const

// Fallback: fetch HTML and extract text via Cheerio (no Firecrawl).
// Worst case is HOMEPAGE_FETCH_TIMEOUT_MS + SUBPAGE_FETCH_TIMEOUT_MS, since the
// single subpage is only fetched after the homepage resolves.
export async function fetchAndExtractWithCheerio(url: string): Promise<string> {
  const siteResponse = await fetch(url, {
    signal: AbortSignal.timeout(HOMEPAGE_FETCH_TIMEOUT_MS),
    headers: {
      ...BROWSER_HEADERS,
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
      DNT: "1",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    },
  })
  const html = await siteResponse.text()
  const $ = cheerio.load(html)
  const title = $("title").text()
  const metaDesc = $('meta[name="description"]').attr("content") || ""
  const h1 = $("h1").first().text()
  const h2 = $("h2").first().text()
  let mainContent = $("main").text() || $("body").text()
  mainContent = mainContent.replace(/\s+/g, " ").trim().slice(0, 2000)

  const subpageLinks: string[] = []
  // Types are inferred from cheerio's own `each` signature; annotating `el` here
  // would need domhandler, which pnpm does not expose as a resolvable module.
  $("a").each((_, el) => {
    const href = $(el).attr("href") || ""
    if (/about|company|team/i.test(href) && !href.startsWith("#") && !href.startsWith("mailto:")) {
      let u = href
      if (!/^https?:\/\//i.test(u)) u = new URL(u, url).href
      if (!subpageLinks.includes(u)) subpageLinks.push(u)
    }
  })
  const subpagesToCrawl = subpageLinks.slice(0, 1)
  let subpageText = ""
  if (subpagesToCrawl.length > 0) {
    const results = await Promise.all(
      subpagesToCrawl.map(async (subUrl) => {
        try {
          const subRes = await fetch(subUrl, {
            signal: AbortSignal.timeout(SUBPAGE_FETCH_TIMEOUT_MS),
            headers: BROWSER_HEADERS,
          })
          const subHtml = await subRes.text()
          const $sub = cheerio.load(subHtml)
          const subTitle = $sub("title").text()
          const subMeta = $sub('meta[name="description"]').attr("content") || ""
          const subH1 = $sub("h1").first().text()
          const subH2 = $sub("h2").first().text()
          let subMain = $sub("main").text() || $sub("body").text()
          subMain = subMain.replace(/\s+/g, " ").trim().slice(0, 1500)
          return `\n[Subpage: ${subUrl}]\n${subTitle}\n${subMeta}\n${subH1}\n${subH2}\n${subMain}`
        } catch {
          return ""
        }
      })
    )
    subpageText = results.join("")
  }
  const parts = [title, metaDesc, h1, h2, mainContent, subpageText].filter(Boolean)
  return parts.join("\n").slice(0, 7000)
}
