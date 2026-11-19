"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useToast } from "@/hooks/use-toast"
import { getUserFriendlyError } from "@/lib/api-utils"
import { track as mpTrack } from "@/lib/mixpanel"
import type { BrandDetails } from "@/hooks/use-guide"

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/** Move a progress bar from `from` to `to` over `durationMs`; returns a stop function. */
function simulateProgress(from: number, to: number, durationMs: number, onUpdate: (p: number) => void) {
  const start = Date.now()
  const id = setInterval(() => {
    const p = Math.min(from + ((to - from) * (Date.now() - start)) / durationMs, to)
    onUpdate(Math.floor(p))
    if (p >= to) clearInterval(id)
  }, 200)
  return () => clearInterval(id)
}

interface UsePreviewGenerationOptions {
  /** True for the anonymous/preview flow (no guideId). */
  enabled: boolean
  /** `?generate=preview`: always generate, even if a preview is cached. */
  generate: boolean
  onLoad: (content: string, brandDetails: BrandDetails) => void
}

/**
 * Preview flow: load the cached preview or generate one from the brand
 * details in localStorage. With nothing stored, go back to the home page.
 * The request is aborted when the page unmounts.
 */
export function usePreviewGeneration({ enabled, generate, onLoad }: UsePreviewGenerationOptions) {
  const router = useRouter()
  const { toast } = useToast()
  const [loading, setLoading] = useState(enabled)
  const [generating, setGenerating] = useState(enabled && generate)
  const [progress, setProgress] = useState(15)
  const [step, setStep] = useState("Analysing your brand details...")
  const loadedRef = useRef(false)
  const onLoadRef = useRef(onLoad)

  useEffect(() => {
    onLoadRef.current = onLoad
  }, [onLoad])

  useEffect(() => {
    if (!enabled || loadedRef.current) return

    const brand = readJson<BrandDetails>("brandDetails")
    if (!brand) {
      router.replace("/")
      return
    }

    const cached = localStorage.getItem("previewContent")
    if (cached && !generate) {
      loadedRef.current = true
      onLoadRef.current(cached, brand)
      setLoading(false)
      return
    }

    const controller = new AbortController()
    setGenerating(true)
    setStep("Creating your tone of voice and guidelines...")
    setProgress(30)
    const stopProgress = simulateProgress(30, 85, 20000, setProgress)

    const run = async () => {
      try {
        const res = await fetch("/api/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brandDetails: brand, selectedTraits: readJson<string[]>("selectedTraits") ?? [] }),
          signal: controller.signal,
        })
        const data: { preview?: string; error?: string } = await res.json().catch(() => ({}))
        if (!res.ok || !data.preview) throw new Error(data.error || `Preview failed (${res.status})`)

        localStorage.setItem("previewContent", data.preview)
        mpTrack("Guide Generated", { plan: "preview" })
        loadedRef.current = true
        setProgress(100)
        onLoadRef.current(data.preview, brand)
        setGenerating(false)
        setLoading(false)
        router.replace("/guide", { scroll: false })
      } catch (error) {
        if (controller.signal.aborted) return
        console.error("[Guide] Preview generation failed:", error)
        toast({
          title: "Generation failed",
          description: `${getUserFriendlyError(error)} You can try again from the home page.`,
          variant: "destructive",
        })
        router.replace("/")
      } finally {
        stopProgress()
      }
    }
    run()

    return () => {
      controller.abort()
      stopProgress()
    }
  }, [enabled, generate, router, toast])

  return { loading: enabled && loading, generating, progress, step }
}
