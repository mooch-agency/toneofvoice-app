"use client"

import { useCallback, useState } from "react"
import { useToast } from "@/hooks/use-toast"
import { hasUnlockPlaceholders } from "@/lib/guide-placeholders"

interface ExpandResponse {
  content?: string
  error?: string
  failedSections?: string[]
}

/** "Try again in 2 minutes." from a Retry-After header (seconds), or "" when absent. */
function retryAfterText(res: Response): string {
  const seconds = Number(res.headers.get("Retry-After"))
  if (!Number.isFinite(seconds) || seconds <= 0) return ""
  if (seconds < 60) return ` Try again in ${Math.ceil(seconds)} second${Math.ceil(seconds) === 1 ? "" : "s"}.`
  const minutes = Math.ceil(seconds / 60)
  return ` Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`
}

/** Generate the paid sections of a saved guide (server checks the tier). */
export function useExpandGuide({ guideId, onExpanded }: { guideId: string | null; onExpanded: (content: string) => void }) {
  const { toast } = useToast()
  const [expanding, setExpanding] = useState(false)

  const fail = useCallback(
    (description: string) => toast({ title: "Could not generate full guide", description, variant: "destructive" }),
    [toast]
  )

  const expand = useCallback(async () => {
    if (!guideId || expanding) return
    setExpanding(true)
    try {
      const res = await fetch("/api/expand-style-guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guideId }),
      })
      const data: ExpandResponse = await res.json().catch(() => ({}))

      if (res.status === 502) {
        const names = data.failedSections?.length ? `: ${data.failedSections.join(", ")}` : ""
        fail(`Some sections could not be generated${names}. Your guide was not changed. Please try again.`)
        return
      }
      if (res.status === 409) {
        // The editor is read-only while generating, so a conflict is another tab or device.
        fail(
          data.error && /already being generated/i.test(data.error)
            ? data.error
            : "This guide was edited while generating. Reload and try again."
        )
        return
      }
      if (res.status === 400 && data.error && /already has full content/i.test(data.error)) {
        fail("This guide already has its full content. Reload the page to see it.")
        return
      }
      if (res.status === 429) {
        fail(`${data.error || "Too many requests. Please wait and try again."}${retryAfterText(res)}`)
        return
      }
      if (res.status === 400 && data.error) {
        fail(data.error)
        return
      }
      if (!res.ok || typeof data.content !== "string" || !data.content || hasUnlockPlaceholders(data.content)) {
        fail("Something went wrong. Please try again.")
        return
      }

      onExpanded(data.content)
      toast({ title: "Full guide generated", description: "Style Rules, Before/After, and Word List are now complete." })
    } catch (error) {
      console.error("[Guide] Expand error:", error)
      fail("Something went wrong. Please try again.")
    } finally {
      setExpanding(false)
    }
  }, [guideId, expanding, onExpanded, fail, toast])

  return { expanding, expand }
}
