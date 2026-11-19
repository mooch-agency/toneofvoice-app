/**
 * Helpers for reading JSON and markdown out of LLM responses.
 * Pure and linear-time: no "try every prefix" parsing.
 */

const OUTER_FENCE = /^```[\w-]*[ \t]*\n([\s\S]*?)\n?```$/

/** Remove a code fence only when it wraps the whole response. Inner fences are kept. */
export function stripOuterFence(text: string): string {
  const trimmed = text.trim()
  const match = OUTER_FENCE.exec(trimmed)
  return match ? match[1].trim() : trimmed
}

/** How many candidate start brackets to try before giving up (keeps work O(n)). */
const MAX_CANDIDATES = 8

/**
 * Find the first balanced JSON object/array in `text` and parse it.
 * Skips prose before the JSON (even prose with brackets) and text after it.
 * Returns undefined when nothing parses (for example truncated output).
 */
export function extractJson(text: string): unknown {
  if (!text) return undefined
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through to scanning
  }

  let tried = 0
  for (let i = 0; i < trimmed.length && tried < MAX_CANDIDATES; i++) {
    const ch = trimmed[i]
    if (ch !== "{" && ch !== "[") continue
    tried++
    const end = matchingBracket(trimmed, i)
    if (end === -1) continue
    try {
      return JSON.parse(trimmed.slice(i, end + 1))
    } catch {
      // not JSON (e.g. "[see below]"); try the next candidate
    }
  }
  return undefined
}

/** Index of the bracket closing the one at `start`, or -1. String-aware. */
function matchingBracket(text: string, start: number): number {
  const stack: string[] = []
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === "\\") i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") stack.push("}")
    else if (ch === "[") stack.push("]")
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: string }

/** Strip an outer fence and extract the JSON value. */
export function parseJsonResponse(text: string): JsonParseResult {
  const value = extractJson(stripOuterFence(text))
  return value === undefined ? { ok: false, error: "Response was not valid JSON" } : { ok: true, value }
}
