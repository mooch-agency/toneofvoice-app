"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { validateInput, sanitizeInput, detectInputType } from "@/lib/input-utils"
import { persistExtraction, requestExtraction } from "@/lib/extraction"

// Progressive loading word arrays (stable refs for effect deps)
const DESCRIPTION_WORDS = ["Thinking...", "Exploring...", "Assembling...", "Creating..."]
const URL_WORDS = ["Reading...", "Understanding...", "Assembling...", "Creating..."]

export interface UseExtractionReturn<T extends InputEl = HTMLTextAreaElement> {
  url: string
  setUrl: (value: string | ((prev: string) => string)) => void
  error: string
  clearError: () => void
  reset: () => void
  isExtracting: boolean
  isSuccess: boolean
  loadingMessage: string
  inputAnimating: boolean
  inputRef: React.RefObject<T | null>
  handleExtraction: (e: React.FormEvent) => Promise<void>
  isInputValid: () => boolean
  sanitizeInput: (value: string, currentValue: string) => string
  detectInputType: typeof detectInputType
  getEffectiveInput: (raw: string) => string
}

type InputEl = HTMLInputElement | HTMLTextAreaElement

interface UseExtractionOptions {
  /** Called after a successful extraction instead of navigating to the preview. */
  onSuccess?: () => void
  /** Focus the input on "#hero" / get-started events. Default true. */
  focusOnGetStarted?: boolean
}

export function useExtraction<T extends InputEl = HTMLTextAreaElement>({
  onSuccess,
  focusOnGetStarted = true,
}: UseExtractionOptions = {}): UseExtractionReturn<T> {
  const router = useRouter()
  const [url, setUrl] = useState("")
  const [error, setError] = useState("")
  const [isExtracting, setIsExtracting] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [loadingMessage, setLoadingMessage] = useState("")
  const [extractionStartTime, setExtractionStartTime] = useState<number | null>(
    null
  )
  const [inputAnimating, setInputAnimating] = useState(false)
  const inputRef = useRef<T>(null)

  // Handle "Get Started" button click - animate and focus input
  useEffect(() => {
    if (!focusOnGetStarted) return
    const animateAndFocusInput = () => {
      if (inputRef.current) {
        const heroElement = document.getElementById("hero")
        const isAtHero =
          heroElement &&
          window.scrollY < heroElement.offsetTop + heroElement.offsetHeight

        if (isAtHero) {
          setInputAnimating(true)
          inputRef.current.focus()
          setTimeout(() => setInputAnimating(false), 2000)
        } else {
          setTimeout(() => {
            setInputAnimating(true)
            inputRef.current?.focus()
            setTimeout(() => setInputAnimating(false), 2000)
          }, 500)
        }
      }
    }

    const handleHashChange = () => {
      if (window.location.hash === "#hero") {
        animateAndFocusInput()
      }
    }

    if (window.location.hash === "#hero") {
      animateAndFocusInput()
    }

    window.addEventListener("hashchange", handleHashChange)
    const handleGetStartedClick = () => animateAndFocusInput()
    window.addEventListener("get-started-clicked", handleGetStartedClick)

    return () => {
      window.removeEventListener("hashchange", handleHashChange)
      window.removeEventListener("get-started-clicked", handleGetStartedClick)
    }
  }, [focusOnGetStarted])

  // Cycle through loading messages during extraction
  useEffect(() => {
    if (!isExtracting || !extractionStartTime) return

    const isUrl = url.trim().startsWith("http") || url.trim().includes(".")
    const words = isUrl ? URL_WORDS : DESCRIPTION_WORDS

    const interval = setInterval(() => {
      const elapsed = Date.now() - extractionStartTime
      const wordIndex = Math.floor(elapsed / 2000) % words.length
      setLoadingMessage(words[wordIndex])
    }, 200)

    return () => clearInterval(interval)
  }, [isExtracting, extractionStartTime, url])

  const getEffectiveInput = (raw: string) => {
    const trimmed = raw.trim()
    const detection = detectInputType(trimmed)
    if (
      detection.inputType === "description" &&
      trimmed.length > 200
    ) {
      return trimmed.slice(0, 200)
    }
    return trimmed
  }

  const isInputValid = () => {
    const effective = getEffectiveInput(url)
    if (!effective) return false
    const validation = validateInput(effective)
    return validation.isValid
  }

  const handleInputValidation = (input: string) => {
    const validation = validateInput(input)
    if (!validation.isValid && validation.error) {
      setError(validation.error)
      return false
    }
    setError("")
    return validation
  }

  const resetState = () => {
    setIsExtracting(false)
    setLoadingMessage("")
    setExtractionStartTime(null)
  }

  const handleExtraction = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setIsSuccess(false)

    const validation = validateInput(getEffectiveInput(url))
    if (!validation.isValid) {
      if (validation.error) setError(validation.error)
      return
    }
    // Empty input: stay put so the user can go to manual entry
    if (validation.inputType === "empty") return

    setIsExtracting(true)
    setExtractionStartTime(Date.now())
    setLoadingMessage(
      (validation.inputType === "url" ? URL_WORDS : DESCRIPTION_WORDS)[0]
    )

    const result = await requestExtraction(validation)
    resetState()
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    persistExtraction(result.data)
    setIsSuccess(true)
    if (onSuccess) onSuccess()
    else router.push("/guide?generate=preview")
  }

  const reset = () => {
    setUrl("")
    setError("")
    setIsSuccess(false)
    resetState()
  }

  const clearError = () => setError("")

  return {
    url,
    setUrl,
    error,
    clearError,
    reset,
    isExtracting,
    isSuccess,
    loadingMessage,
    inputAnimating,
    inputRef,
    handleExtraction,
    isInputValid,
    sanitizeInput,
    detectInputType,
    getEffectiveInput,
  }
}
