"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/components/AuthProvider"
import { useToast } from "@/hooks/use-toast"
import { MetaPixel } from "@/lib/meta-pixel"

export type PaidPlan = "pro" | "agency"

export const isPaidPlan = (value: string | null): value is PaidPlan => value === "pro" || value === "agency"

interface UseCheckoutOptions {
  /** Full-page navigation to Stripe (injectable for tests). */
  navigate?: (url: string) => void
  /** Called after an existing subscription was upgraded in place, with the new tier. */
  onUpgraded?: (tier: PaidPlan) => void
  /** Called instead of upgrading when an unconfirmed start (`confirmed: false`) would upgrade. */
  onNeedsConfirmation?: (plan: PaidPlan) => void
}

interface StartCheckoutOptions {
  /**
   * Whether the user explicitly chose this plan in the UI (default true). An
   * unconfirmed start (e.g. from a `?subscribe=` link) never upgrades, since
   * an upgrade charges the card immediately.
   */
  confirmed?: boolean
}

const defaultNavigate = (url: string) => window.location.assign(url)

/** A failed in-place upgrade; the message is the server's, safe to show. */
class UpgradeError extends Error {}

/** Upgrade the existing subscription in place. Throws with the server's message on failure. */
async function changePlan(plan: PaidPlan): Promise<PaidPlan> {
  const res = await fetch("/api/change-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
  })
  const data: { success?: boolean; subscription_tier?: string; error?: string } = await res.json().catch(() => ({}))
  if (!res.ok || !data.success) throw new UpgradeError(data.error || "Please try again in a few minutes.")
  const tier = data.subscription_tier ?? null
  return isPaidPlan(tier) ? tier : plan
}

/**
 * Start a subscription checkout. Signed-out users go to sign-up first. Users
 * who already subscribe (409) either upgrade in place (`upgrade: true`; the
 * plan dialog was their confirmation) or are sent to the billing portal
 * (`manageUrl`).
 */
export function useCheckout({ navigate = defaultNavigate, onUpgraded, onNeedsConfirmation }: UseCheckoutOptions = {}) {
  const router = useRouter()
  const { user } = useAuth()
  const { toast } = useToast()
  const [processingPlan, setProcessingPlan] = useState<PaidPlan | null>(null)
  const callbacks = useRef({ onUpgraded, onNeedsConfirmation })
  useEffect(() => {
    callbacks.current = { onUpgraded, onNeedsConfirmation }
  }, [onUpgraded, onNeedsConfirmation])

  const startCheckout = useCallback(
    async (plan: PaidPlan, { confirmed = true }: StartCheckoutOptions = {}) => {
      MetaPixel.initiateCheckout(plan)
      if (!user) {
        router.push(`/sign-up?redirectTo=${encodeURIComponent(`/guide?subscribe=${plan}`)}`)
        return
      }
      setProcessingPlan(plan)
      try {
        const res = await fetch("/api/create-subscription-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan }),
        })
        const data: { url?: string; manageUrl?: string; upgrade?: boolean } = await res.json().catch(() => ({}))

        if (res.status === 409 && data.upgrade) {
          if (!confirmed) {
            callbacks.current.onNeedsConfirmation?.(plan)
            return
          }
          const tier = await changePlan(plan)
          toast({ title: `You're on ${tier === "agency" ? "Agency" : "Pro"} now`, description: "Your plan was upgraded." })
          callbacks.current.onUpgraded?.(tier)
          return
        }
        if (res.status === 409 && data.manageUrl) {
          toast({ title: "You already have a subscription", description: "Opening your billing settings." })
          navigate(data.manageUrl)
          return
        }
        if (res.status === 401) {
          toast({ title: "Session expired", description: "Please sign in again.", variant: "destructive" })
          return
        }
        if (!res.ok || !data.url) throw new Error(`Checkout failed (${res.status})`)
        navigate(data.url)
      } catch (error) {
        console.error("[Guide] Checkout error:", error)
        if (error instanceof UpgradeError) {
          toast({ title: "Upgrade failed", description: error.message, variant: "destructive" })
          return
        }
        toast({ title: "Something went wrong", description: "Please try again in a few minutes.", variant: "destructive" })
      } finally {
        setProcessingPlan(null)
      }
    },
    [user, router, toast, navigate]
  )

  return { processingPlan, startCheckout }
}
