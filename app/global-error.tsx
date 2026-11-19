"use client"

// Catches React render errors that escape all error boundaries.
// Next.js renders this instead of the root layout on a fatal crash.
import { useEffect } from "react"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[global-error]", error)
  }, [error])

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-white">
        <div className="text-center space-y-4 px-6">
          <h1 className="text-xl font-semibold text-gray-900">Something went wrong</h1>
          <p className="text-sm text-gray-500">Please try again. If the problem continues, contact support.</p>
          <button
            onClick={reset}
            className="text-sm font-medium text-gray-900 underline underline-offset-4"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
