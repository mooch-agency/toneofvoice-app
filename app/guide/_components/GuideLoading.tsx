import { Loader2 } from "lucide-react"
import { Progress } from "@/components/ui/progress"

/** Spinner for loading a saved or cached guide. */
export function QuickLoad() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50">
      <div className="text-center space-y-4">
        <div className="w-10 h-10 rounded-full flex items-center justify-center mx-auto bg-gray-100">
          <Loader2 className="h-5 w-5 animate-spin text-gray-600" />
        </div>
        <p className="text-sm font-medium text-gray-900">Loading...</p>
      </div>
    </div>
  )
}

const NEXT_STEPS = [
  "Refine your guidelines with AI or manually",
  "Export as PDF, Word, or Markdown",
  "Share with your team or use in AI tools",
]

/** Progress screen while a new preview is generated. */
export function GenerationProgress({ progress, step }: { progress: number; step: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 p-4 sm:p-6">
      <div className="w-full max-w-lg animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 sm:p-8 md:p-10 text-center">
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full flex items-center justify-center mx-auto mb-6 sm:mb-8 bg-gray-100">
            <Loader2 className="h-6 w-6 sm:h-7 sm:w-7 animate-spin text-gray-600" />
          </div>
          <h1 className="text-lg sm:text-xl font-semibold text-gray-900 mb-2 sm:mb-3">
            Creating Your Tone of Voice Guidelines
          </h1>
          <p className="text-sm text-gray-600 mb-6 sm:mb-8 max-w-md mx-auto">Typically takes 30–60 seconds</p>

          <div className="space-y-4 sm:space-y-5 w-full">
            <Progress value={progress} className="h-1.5 sm:h-2" aria-label={`Loading progress: ${progress}%`} />
            {progress < 100 && <p className="text-xs sm:text-sm text-gray-500 text-center font-medium">{step}</p>}

            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 sm:p-5 text-left space-y-3">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Your next steps</p>
              <ol className="space-y-2.5">
                {NEXT_STEPS.map((text, i) => (
                  <li key={text} className="flex items-start gap-3">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-white border border-gray-300 flex items-center justify-center text-xs font-semibold text-gray-700">
                      {i + 1}
                    </span>
                    <span className="pt-0.5 text-xs sm:text-sm font-medium text-gray-900">{text}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
