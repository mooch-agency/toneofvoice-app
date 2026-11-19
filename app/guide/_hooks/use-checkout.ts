"use client"

import { useCallback, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/components/AuthProvider"
import { useToast } from "@/hooks/use-toast"
import { MetaPixel } from "@/lib/meta-pixel"

export type PaidPlan = "pro" | "agency"

export const isPaidPlan = (value: string | null): value is PaidPlan => value === "pro" || value === "agency"

interface UseCheckoutOptions {
  /** Full-page navigation to Stripe (injectable for tests). */
  navigate?: (url: string) => void
}

const defaultNavigate = (url: string) => window.location.assign(url)

/**
 * Start a subscription checkout. Signed-out users go to sign-up first; users
 * who already subscribe (409) are sent to the billing portal instead.
 */
export function useCheckout({ navigate = defaultNavigate }: UseCheckoutOptions = {}) {
  const router = useRouter()
  const { user } = useAuth()
  const { toast } = useToast()
  const [processingPlan, setProcessingPlan] = useState<PaidPlan | null>(null)

  const startCheckout = useCallback(
    async (plan: PaidPlan) => {
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
        const data: { url?: string; manageUrl?: string } = await res.json().catch(() => ({}))

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
        toast({ title: "Something went wrong", description: "Please try again in a few minutes.", variant: "destructive" })
      } finally {
        setProcessingPlan(null)
      }
    },
    [user, router, toast, navigate]
  )

  return { processingPlan, startCheckout }
}
