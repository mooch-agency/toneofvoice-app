"use client"

import { useEffect, useRef } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useToast } from "@/hooks/use-toast"
import { MetaPixel } from "@/lib/meta-pixel"
import { readPendingDraft, savePendingDraft } from "@/lib/pending-draft"
import { clearAutoSaveBlocks } from "@/components/dashboard/AutoSaveGuide"

/** Save a guide previewed before checkout now that the new plan has room for it. */
async function savePendingDraftAfterUpgrade() {
  const draft = readPendingDraft()
  if (!draft) return
  try {
    const { status, guideId } = await savePendingDraft(draft)
    if (!guideId) console.warn(`[SubscriptionRefresh] Pending guide not saved (${status})`)
  } catch (error) {
    console.error("[SubscriptionRefresh] Pending guide save failed:", error)
  }
}

/**
 * After the Stripe checkout redirect (?subscription=success&session_id=...),
 * asks the server to verify that checkout session and activate the plan in
 * case the webhook has not arrived yet. Fires the Purchase pixel only for a
 * plan the server confirmed. Once verified it saves a pending preview guide
 * (AutoSaveGuide waits for this on the checkout return) before refreshing.
 */
export function SubscriptionRefresh() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const started = useRef(false)

  useEffect(() => {
    if (searchParams.get("subscription") !== "success" || started.current) return
    started.current = true
    const sessionId = searchParams.get("session_id")

    const verify = async () => {
      try {
        const res = await fetch("/api/verify-subscription", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sessionId ? { session_id: sessionId } : {}),
        })
        const data = (await res.json()) as { subscription_tier?: string }
        const tier = data.subscription_tier
        // The plan may have changed: let AutoSaveGuide try a blocked draft again.
        clearAutoSaveBlocks()
        if (tier === "pro" || tier === "agency") {
          await savePendingDraftAfterUpgrade()
          MetaPixel.purchase(tier)
          toast({ title: "Subscription activated!", description: `Your ${tier} plan is now active.` })
        } else {
          toast({
            title: "Processing subscription...",
            description: "Your payment was received. Refresh in a moment if your plan hasn't updated.",
          })
        }
      } catch (error) {
        console.error("[SubscriptionRefresh] Verify error:", error)
      }

      router.replace("/dashboard", { scroll: false })
      router.refresh()
    }

    void verify()
  }, [searchParams, router, toast])

  return null
}
