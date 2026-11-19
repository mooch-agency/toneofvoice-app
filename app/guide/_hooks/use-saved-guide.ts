"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/components/AuthProvider"
import { useToast } from "@/hooks/use-toast"
import type { BrandDetails } from "@/hooks/use-guide"
import { normalizeTier, type Tier } from "@/lib/tiers"

export interface LoadedGuide {
  content: string
  brandDetails: BrandDetails
  planType: string
  tier: Tier
}

interface LoadStyleGuideResponse {
  content_md?: string
  brand_name?: string
  brand_details?: BrandDetails | null
  plan_type?: string
  subscription_tier?: string
}

/**
 * Load a saved guide (and the user's tier, from the same response). Signed-out
 * users go to sign-in; a missing guide goes to the dashboard. The request is
 * aborted on unmount or when the guide id changes.
 */
export function useSavedGuide(guideId: string | null, onLoad: (guide: LoadedGuide) => void) {
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const { toast } = useToast()
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const onLoadRef = useRef(onLoad)
  const userId = user?.id

  useEffect(() => {
    onLoadRef.current = onLoad
  }, [onLoad])

  useEffect(() => {
    if (!guideId || authLoading) return
    const signInUrl = `/sign-in?redirectTo=${encodeURIComponent(`/guide?guideId=${guideId}`)}`
    if (!userId) {
      router.replace(signInUrl)
      return
    }

    const controller = new AbortController()
    const load = async () => {
      try {
        const res = await fetch(`/api/load-style-guide?guideId=${encodeURIComponent(guideId)}`, {
          signal: controller.signal,
        })
        if (res.status === 404) return router.replace("/dashboard")
        if (res.status === 401) return router.replace(signInUrl)
        if (!res.ok) throw new Error(`Load failed (${res.status})`)
        const guide: LoadStyleGuideResponse = await res.json()

        onLoadRef.current({
          content: guide.content_md || "",
          brandDetails: guide.brand_details || { name: guide.brand_name || "Brand" },
          planType: guide.plan_type || "style_guide",
          tier: normalizeTier(guide.subscription_tier),
        })
        setLoadedId(guideId)
      } catch (error) {
        if (controller.signal.aborted) return
        console.error("[Guide] Error loading guide:", error)
        toast({
          title: "Could not load guide",
          description: "Something went wrong. You can try again from the dashboard.",
          variant: "destructive",
        })
        router.replace("/dashboard")
      }
    }
    load()
    return () => controller.abort()
  }, [guideId, authLoading, userId, router, toast])

  return { loading: !!guideId && loadedId !== guideId }
}
