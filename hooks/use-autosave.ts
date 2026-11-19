"use client"

import { useCallback, useEffect, useRef, useState } from "react"

export type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "error"

export interface AutosaveBrandDetails {
  name?: string
  [key: string]: unknown
}

export interface UseAutosaveOptions {
  guideId: string | null
  content: string | null
  brandDetails: AutosaveBrandDetails | null
  /** The guide's stored plan type, sent back unchanged. */
  planType: string
  /** False until the user has edited something. */
  enabled: boolean
  delayMs?: number
  onError?: () => void
}

interface SavePayload {
  guide_id: string
  title: string
  brand_name: string
  content_md: string
  plan_type: string
  brand_details: AutosaveBrandDetails
}

const SAVE_URL = "/api/save-style-guide"
/** Browsers reject keepalive requests with bodies over 64 KB (total in flight). */
const KEEPALIVE_MAX_BYTES = 60_000

function post(payload: SavePayload, init: RequestInit = {}) {
  const body = JSON.stringify(payload)
  return fetch(SAVE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    ...init,
    // A large guide is sent without keepalive: it still completes on in-app navigation.
    ...(init.keepalive && { keepalive: new Blob([body]).size <= KEEPALIVE_MAX_BYTES }),
  })
}

/** Every mounted autosave registers here so sign-out can save the last edits first. */
const flushers = new Set<() => Promise<void>>()

/**
 * Save every pending edit now and wait until those saves (and any already in
 * flight) finish. Call before ending the session: requests sent after sign-out
 * are unauthenticated and would lose up to `delayMs` of typing. Never rejects.
 */
export async function flushPendingAutosaves(): Promise<void> {
  await Promise.all([...flushers].map((flushAndWait) => flushAndWait().catch(() => {})))
}

/**
 * Debounced autosave for a saved guide. Only the latest request counts (older
 * ones are aborted), and a pending save is flushed with `keepalive` when the
 * component unmounts or the page is hidden, so the last edits are not lost.
 */
export function useAutosave({
  guideId,
  content,
  brandDetails,
  planType,
  enabled,
  delayMs = 2000,
  onError,
}: UseAutosaveOptions): { status: AutosaveStatus } {
  const [status, setStatus] = useState<AutosaveStatus>("idle")
  const pendingRef = useRef<SavePayload | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const inflightRef = useRef<Promise<void> | null>(null)
  const onErrorRef = useRef(onError)

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  const save = useCallback(() => {
    clearTimer()
    const payload = pendingRef.current
    if (!payload) return
    pendingRef.current = null

    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setStatus("saving")

    const request = post(payload, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return
        if (!res.ok) throw new Error(`Save failed (${res.status})`)
        setStatus("saved")
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setStatus("error")
        onErrorRef.current?.()
      })
      .finally(() => {
        if (inflightRef.current === request) inflightRef.current = null
      })
    inflightRef.current = request
  }, [])

  /** Save what is pending now and resolve when the latest save has finished (see flushPendingAutosaves). */
  const flushAndWait = useCallback(async () => {
    if (pendingRef.current) save()
    await inflightRef.current
  }, [save])

  useEffect(() => {
    flushers.add(flushAndWait)
    return () => {
      flushers.delete(flushAndWait)
    }
  }, [flushAndWait])

  /** Send whatever is pending without waiting: survives navigation and tab close. */
  const flush = useCallback(() => {
    clearTimer()
    const payload = pendingRef.current
    if (!payload) return
    pendingRef.current = null
    post(payload, { keepalive: true }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!enabled || !guideId || !content || !brandDetails) return
    const name = brandDetails.name || "Brand"
    pendingRef.current = {
      guide_id: guideId,
      title: `${name} Style Guide`,
      brand_name: name,
      content_md: content,
      plan_type: planType,
      brand_details: brandDetails,
    }
    setStatus("pending")
    clearTimer()
    timerRef.current = setTimeout(save, delayMs)
    return clearTimer
  }, [enabled, guideId, content, brandDetails, planType, delayMs, save])

  useEffect(() => {
    window.addEventListener("pagehide", flush)
    return () => {
      window.removeEventListener("pagehide", flush)
      flush()
    }
  }, [flush])

  return { status }
}
