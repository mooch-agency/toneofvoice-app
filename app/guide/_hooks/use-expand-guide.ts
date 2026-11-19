"use client"

import { useCallback, useState } from "react"
import { useToast } from "@/hooks/use-toast"
import { hasUnlockPlaceholders } from "@/lib/guide-placeholders"

interface ExpandResponse {
  content?: string
  failedSections?: string[]
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
        fail("This guide was changed somewhere else. Reload the page and try again.")
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
