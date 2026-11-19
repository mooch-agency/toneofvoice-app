"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/components/AuthProvider"
import { useToast } from "@/hooks/use-toast"
import { readPendingDraft, savePendingDraft } from "@/lib/pending-draft"

// Module-level flag prevents concurrent saves across instances
let saving = false

/** Per tab: once a save hits the guide limit, do not try again for this user. */
const blockedKey = (userId: string) => `autosave-blocked:${userId}`

function isBlocked(userId: string): boolean {
  try {
    return sessionStorage.getItem(blockedKey(userId)) === "1"
  } catch {
    return false
  }
}

function block(userId: string) {
  try {
    sessionStorage.setItem(blockedKey(userId), "1")
  } catch {
    // storage unavailable: worst case we try once more on the next page load
  }
}

/**
 * After sign-in, saves a fresh pending preview guide (see lib/pending-draft)
 * to the account. Runs on /guide and /dashboard. On success it
 * clears the preview and opens the saved guide; at the guide limit it tells
 * the user once and stops.
 */
export function AutoSaveGuide() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const { toast } = useToast()

  useEffect(() => {
    if (authLoading || !user || saving || isBlocked(user.id)) return

    const draft = readPendingDraft()
    if (!draft) return
    saving = true

    const save = async (attempt = 0): Promise<void> => {
      const { status, guideId } = await savePendingDraft(draft)

      // The session cookie may not be ready right after sign-in.
      if (status === 401 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        return save(attempt + 1)
      }
      if (status === 403) {
        block(user.id)
        toast({
          title: "Guide limit reached",
          description:
            "This guide was not saved to your account. You can still download it, or upgrade your plan to save more guides.",
          variant: "destructive",
        })
        return
      }
      if (!guideId) {
        if (status >= 400) console.warn(`[AutoSaveGuide] Save failed (${status})`)
        return
      }
      const onGuidePreview = window.location.pathname === "/guide" && !window.location.search.includes("guideId=")
      if (onGuidePreview) router.replace(`/guide?guideId=${guideId}`)
      else router.refresh()
    }

    save()
      .catch((error) => console.error("[AutoSaveGuide] Failed to save guide:", error))
      .finally(() => {
        saving = false
      })
  }, [user, authLoading, router, toast])

  return null
}
