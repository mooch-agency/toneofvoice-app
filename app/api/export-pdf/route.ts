import { NextResponse } from "next/server"
import puppeteer from "puppeteer-core"
import { MAX_PDF_BODY_BYTES, getChromeLaunchOptions, isAllowedPdfRequest } from "@/lib/pdf-chrome"
import { requireUser, tooManyRequests, withRouteErrors } from "@/lib/api-auth"
import { clientKey, rateLimit } from "@/lib/rate-limit"

// Allow longer run for PDF generation (cold start + render)
export const maxDuration = 60

// Each call launches a full Chromium.
const RATE_LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 }

const tooLarge = () => NextResponse.json({ error: "Document is too large to export." }, { status: 413 })
const badRequest = () => NextResponse.json({ error: "Invalid export request." }, { status: 400 })

/** Read the body as text, giving up once it passes `maxBytes`. Returns null when too large. */
async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null
  if (!request.body) return ""
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function parseBody(text: string): { html: string; css: string; filename?: unknown } | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  const { html, css, filename } = (body ?? {}) as Record<string, unknown>
  if (typeof html !== "string" || !html || typeof css !== "string" || !css) return null
  // The CSS goes inside <style>; it must not be able to close it and inject markup.
  if (/<\/style/i.test(css)) return null
  return { html, css, filename }
}

function safeFilename(filename: unknown): string {
  if (typeof filename !== "string" || !filename) return "style-guide.pdf"
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)
}

export async function POST(request: Request) {
  return withRouteErrors("export-pdf", async () => {
    const auth = await requireUser()
    if (!auth.ok) return auth.response

    const limited = rateLimit(`export-pdf:${clientKey(request, auth.user.id)}`, RATE_LIMIT)
    if (!limited.ok) return tooManyRequests(limited.retryAfterSeconds)

    const text = await readBodyCapped(request, MAX_PDF_BODY_BYTES)
    if (text === null) return tooLarge()
    const body = parseBody(text)
    if (!body) return badRequest()

    const { executablePath, args, headless } = await getChromeLaunchOptions()
    const browser = await puppeteer.launch({
      args,
      defaultViewport: { width: 816, height: 1056, deviceScaleFactor: 1 },
      executablePath,
      headless,
    })

    try {
      const page = await browser.newPage()
      await page.setJavaScriptEnabled(false)
      await page.setRequestInterception(true)
      page.on("request", (req) => {
        if (isAllowedPdfRequest(req.url())) void req.continue()
        else void req.abort()
      })

      await page.setContent(
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=816, initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap" rel="stylesheet" />
  <style>${body.css}</style>
</head>
<body><div class="pdf-rendering">${body.html}</div></body>
</html>`,
        { waitUntil: "networkidle0", timeout: 20000 },
      )

      const pdf = await page.pdf({
        format: "Letter",
        printBackground: true,
        margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" },
      })

      return new NextResponse(Buffer.from(pdf), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${safeFilename(body.filename)}"`,
        },
      })
    } finally {
      await browser.close().catch((e) => console.error("[export-pdf] Error closing browser:", e))
    }
  })
}
