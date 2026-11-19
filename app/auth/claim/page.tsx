"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/components/AuthProvider"
import { readPendingDraft, savePendingDraft } from "@/lib/pending-draft"

/**
 * Landing page after sign-in/sign-up. Saves a fresh pending preview guide to
 * the account before the dashboard renders, so it shows up straight away.
 * Failures fall through to AutoSaveGuide on the dashboard, which tells the user.
 */
export default function ClaimPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const attempted = useRef(false)

  useEffect(() => {
    if (authLoading || attempted.current) return
    attempted.current = true

    if (!user) {
      router.replace("/sign-in")
      return
    }

    const draft = readPendingDraft()
    if (!draft) {
      router.replace("/dashboard")
      return
    }

    savePendingDraft(draft)
      .catch((err) => console.error("[claim] Could not save guide:", err))
      .finally(() => router.replace("/dashboard"))
  }, [user, authLoading, router])

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-white">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
        <p className="text-sm text-gray-500">Setting up your dashboard...</p>
      </div>
    </div>
  )
}
