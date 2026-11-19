"use client"

import { useState, useEffect, useRef, useCallback, useMemo, type RefObject } from "react"
import { useAuth } from "@/components/AuthProvider"
import {
  parseStyleGuideContent,
  StyleGuideSection,
  STYLE_GUIDE_SECTIONS,
  insertCustomSection,
} from "@/lib/content-parser"
import { isUnlocked as tierUnlocked, normalizeTier, type Tier } from "@/lib/tiers"

export interface BrandDetails {
  name?: string
  websiteUrl?: string
  [key: string]: unknown
}

export type ViewMode = "preview" | "edit"

const COVER_SECTION: StyleGuideSection = {
  id: "cover",
  title: "Cover Page",
  content: "",
  level: 1,
  isMainSection: true,
  configId: "cover",
  icon: STYLE_GUIDE_SECTIONS.find((s) => s.id === "cover")?.icon,
  minTier: "starter",
}

/**
 * Sidebar highlight that follows scrolling, plus click-to-scroll.
 * The observer is rebuilt when the set of section ids changes. The section DOM
 * is also replaced with the same ids (edit/preview switch, remount after
 * expand, async editor render), so a MutationObserver re-observes whenever the
 * elements behind those ids change. Typing does not trigger a re-observe.
 */
export function useScrollSpy(sectionIds: string[], scrollContainerRef: RefObject<HTMLElement | null>) {
  const [activeSectionId, setActiveSectionId] = useState("cover")
  const idsKey = sectionIds.join("\n")

  const handleSectionSelect = useCallback((id: string) => {
    setActiveSectionId(id)
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  useEffect(() => {
    const container = scrollContainerRef.current
    const ids = idsKey ? idsKey.split("\n") : []
    if (!container || ids.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        const topmost = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.target.getBoundingClientRect().top - b.target.getBoundingClientRect().top)[0]
        if (topmost?.target.id) setActiveSectionId(topmost.target.id)
      },
      { root: container, rootMargin: "-20% 0px -60% 0px", threshold: 0 }
    )

    let observed: HTMLElement[] = []
    const sync = () => {
      const elements = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el)
      if (elements.length === observed.length && elements.every((el, i) => el === observed[i])) return
      observer.disconnect()
      elements.forEach((el) => observer.observe(el))
      observed = elements
    }
    sync()
    const mutations = new MutationObserver(sync)
    mutations.observe(container, { childList: true, subtree: true })

    // Keep the highlight valid when sections change (e.g. after expand)
    setActiveSectionId((prev) => (ids.includes(prev) ? prev : "cover"))
    return () => {
      mutations.disconnect()
      observer.disconnect()
    }
  }, [idsKey, scrollContainerRef])

  return { activeSectionId, handleSectionSelect }
}

export interface UseGuideOptions {
  /** Fetch the tier from /api/user-subscription-tier on mount (false when the guide load provides it). */
  fetchTier?: boolean
  /** Side effects for every user edit (persist, mark dirty). Not called for programmatic loads. */
  onContentChange?: (markdown: string) => void
}

/** Shared guide state: content, sections, tier, view mode and editor remount key. */
export function useGuide({ fetchTier = true, onContentChange }: UseGuideOptions = {}) {
  const { user } = useAuth()

  const [content, setContent] = useState<string | null>(null)
  const [brandDetails, setBrandDetails] = useState<BrandDetails | null>(null)
  const [guideType, setGuideType] = useState<string>("style_guide")
  const [viewMode, setViewMode] = useState<ViewMode>("preview")
  const [subscriptionTier, setSubscriptionTier] = useState<Tier>("starter")
  const [editorKey, setEditorKey] = useState(0)

  const sections = useMemo(() => (content ? [COVER_SECTION, ...parseStyleGuideContent(content)] : []), [content])
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const sectionIds = useMemo(() => sections.map((s) => s.id), [sections])
  const { activeSectionId, handleSectionSelect } = useScrollSpy(sectionIds, scrollContainerRef)

  // Tier: fetched fresh on every mount for signed-in users; starter when signed out.
  const userId = user?.id
  useEffect(() => {
    if (!userId) {
      setSubscriptionTier("starter")
      return
    }
    if (!fetchTier) return
    const controller = new AbortController()
    fetch("/api/user-subscription-tier", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setSubscriptionTier(normalizeTier(data?.subscription_tier)))
      .catch(() => {
        if (!controller.signal.aborted) setSubscriptionTier("starter")
      })
    return () => controller.abort()
  }, [userId, fetchTier])

  // Preserve the scroll position across preview/edit switches.
  const scrollTopBeforeSwitchRef = useRef(0)
  useEffect(() => {
    requestAnimationFrame(() => {
      if (scrollContainerRef.current && scrollTopBeforeSwitchRef.current > 0) {
        scrollContainerRef.current.scrollTop = scrollTopBeforeSwitchRef.current
        scrollTopBeforeSwitchRef.current = 0
      }
    })
  }, [viewMode])

  const handleModeSwitch = useCallback((mode: ViewMode) => {
    setViewMode((current) => {
      if (current !== mode) scrollTopBeforeSwitchRef.current = scrollContainerRef.current?.scrollTop ?? 0
      return mode
    })
  }, [])

  const isUnlocked = useCallback((minTier?: Tier) => tierUnlocked(subscriptionTier, minTier), [subscriptionTier])

  const onContentChangeRef = useRef(onContentChange)
  useEffect(() => {
    onContentChangeRef.current = onContentChange
  }, [onContentChange])

  /** The single path for user edits: update state and run the caller's side effects. */
  const updateContent = useCallback((markdown: string) => {
    setContent(markdown)
    onContentChangeRef.current?.(markdown)
  }, [])

  const handleAddSection = useCallback(
    (title: string) => {
      if (!content) return
      const next = insertCustomSection(content, title)
      if (next === content) return // empty title or custom-section limit reached
      updateContent(next)
      setEditorKey((k) => k + 1)
      requestAnimationFrame(() => {
        const added = parseStyleGuideContent(next).find((s) => s.title === title.trim().slice(0, 60))
        if (added) handleSectionSelect(added.id)
      })
    },
    [content, updateContent, handleSectionSelect]
  )

  return {
    content,
    setContent,
    updateContent,
    brandDetails,
    setBrandDetails,
    guideType,
    setGuideType,
    sections,
    activeSectionId,
    handleSectionSelect,
    viewMode,
    handleModeSwitch,
    subscriptionTier,
    setSubscriptionTier,
    isUnlocked,
    scrollContainerRef,
    editorKey,
    setEditorKey,
    handleAddSection,
  }
}
