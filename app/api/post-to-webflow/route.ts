import { createHash, timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"

/**
 * Zapier -> Webflow CMS blog publishing. Requires
 * `Authorization: Bearer ${WEBFLOW_WEBHOOK_SECRET}` and fails closed when the
 * secret is unset. Items are published directly, as before.
 */

const LOCATION = "Lisbon"
const BUSINESS_CATEGORY_ID = "68f8ff5305fca0c8ae56ed38"

const LIMITS = { title: 256, slug: 256, body: 200_000, summary: 1000 }
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const json = (body: unknown, status: number) => NextResponse.json(body, { status })

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest()
}

/** Constant-time check of the bearer token against WEBFLOW_WEBHOOK_SECRET. */
function isAuthorized(req: Request): boolean {
  const secret = process.env.WEBFLOW_WEBHOOK_SECRET
  if (!secret) return false
  const match = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")
  if (!match) return false
  return timingSafeEqual(sha256(match[1]), sha256(secret))
}

/** First value among Zapier's field-name variants. */
function pick(body: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (body[k] !== undefined && body[k] !== null && body[k] !== "") return body[k]
  return undefined
}

type Post = { title: string; slug: string; body: string; summary: string }

function parsePost(raw: unknown): Post | null {
  if (!raw || typeof raw !== "object") return null
  const b = raw as Record<string, unknown>
  const title = pick(b, ["title", "name", "Title"])
  const slug = pick(b, ["slug", "Slug"])
  const body = pick(b, ["body", "content", "Body", "Content"])
  const summary = pick(b, ["contentSummary", "summary", "Summary"]) ?? "Default summary"
  if (typeof title !== "string" || typeof slug !== "string" || typeof body !== "string" || typeof summary !== "string") {
    return null
  }
  if (title.length > LIMITS.title || body.length > LIMITS.body || summary.length > LIMITS.summary) return null
  if (slug.length > LIMITS.slug || !SLUG_PATTERN.test(slug)) return null
  return { title, slug, body, summary }
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return json({ error: "Body must be JSON" }, 400)
  }
  const post = parsePost(raw)
  if (!post) {
    return json(
      {
        error: `Need string fields title (<= ${LIMITS.title}), slug (lowercase-with-dashes), body (<= ${LIMITS.body}) and optional contentSummary (<= ${LIMITS.summary}).`,
      },
      400,
    )
  }

  const { WEBFLOW_SITE_ID, WEBFLOW_COLLECTION_ID, WEBFLOW_TOKEN } = process.env
  if (!WEBFLOW_SITE_ID || !WEBFLOW_COLLECTION_ID || !WEBFLOW_TOKEN) {
    console.error("[post-to-webflow] Webflow env is not configured")
    return json({ error: "Service unavailable" }, 503)
  }

  try {
    const response = await fetch(
      `https://api.webflow.com/v2/sites/${WEBFLOW_SITE_ID}/collections/${WEBFLOW_COLLECTION_ID}/items`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          isArchived: false,
          isDraft: false,
          fieldData: {
            name: post.title,
            slug: post.slug,
            location: LOCATION,
            content: post.body,
            "content-summary": post.summary,
            category: BUSINESS_CATEGORY_ID,
          },
        }),
      },
    )
    const data = (await response.json().catch(() => ({}))) as { id?: string; message?: string }
    if (!response.ok) {
      console.error("[post-to-webflow] Webflow API error:", response.status, data.message ?? "")
      return json({ error: "Webflow rejected the item" }, 502)
    }
    return json({ success: true, id: data.id, slug: post.slug }, 200)
  } catch (err) {
    console.error("[post-to-webflow] Request failed:", err instanceof Error ? err.message : err)
    return json({ error: "Webflow request failed" }, 502)
  }
}
