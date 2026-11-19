"use client"

import { RefObject, type ReactNode } from "react"
import dynamic from "next/dynamic"
import { playfairDisplay } from "@/lib/fonts"
import { GuideCover } from "@/components/GuideCover"
import { ContentGate } from "@/components/ContentGate"
import { MarkdownRenderer } from "@/components/MarkdownRenderer"
import type { StyleGuideSection, Tier } from "@/lib/content-parser"
import { buildEditorMarkdown, mergeEditedMarkdown } from "@/lib/editor-merge"
import { cn } from "@/lib/utils"

// The editor (Plate + AI kits) is only needed in edit mode; keep it out of read-only pages.
const GuideEditor = dynamic(() => import("@/components/editor/GuideEditor").then((m) => m.GuideEditor), {
  ssr: false,
})

export interface GuideViewProps {
  sections: StyleGuideSection[]
  scrollContainerRef: RefObject<HTMLDivElement | null>
  viewMode: "preview" | "edit"
  /** Called with the full guide markdown (locked sections kept in place) after an edit */
  onContentChange: (markdown: string) => void
  /** Called when the user edits the H1 brand name in the editor */
  onBrandNameChange?: (name: string) => void
  brandName: string
  showPreviewBadge?: boolean
  isUnlocked: (minTier?: Tier) => boolean
  onUpgrade: () => void
  /** Change to remount the editor with fresh content */
  editorKey: number
  editorId: string
  pdfFooter?: ReactNode
  /** Optional class for the content wrapper */
  contentClassName?: string
  /** Key to force remount and trigger entrance animation (e.g. after expand) */
  contentKey?: string | number
  websiteUrl?: string
  subscriptionTier?: Tier
  /** Enable AI features in the editor (Cmd+J) */
  showAI?: boolean
  coverDisclaimer?: string
  coverDate?: string
}

const hasContent = (s: StyleGuideSection) => (s.content || "").trim().length > 0

function SectionBlock({ section, index, children }: { section: StyleGuideSection; index: number; children: ReactNode }) {
  return (
    <div
      id={section.id}
      className={cn(
        "pdf-section scroll-mt-4 px-12 md:px-20 py-20 md:py-24 border-t border-gray-100",
        index % 2 === 0 ? "bg-white" : "bg-gray-50/30"
      )}
    >
      <div className="max-w-5xl mx-auto">{children}</div>
    </div>
  )
}

function LockedSection({ section, index, onUpgrade }: { section: StyleGuideSection; index: number; onUpgrade: () => void }) {
  return (
    <div data-locked-section>
      <SectionBlock section={section} index={index}>
        <ContentGate
          content={section.content}
          locked
          showUpgradeCTA
          sectionTitle={section.title}
          sectionId={section.id}
          onUpgrade={onUpgrade}
        />
      </SectionBlock>
    </div>
  )
}

/** "Powered by" footer shown in exports for starter and pro. */
function BrandingFooter({ tier }: { tier: Tier }) {
  if (tier === "agency") return null
  return (
    <div className="pdf-only px-12 md:px-20 py-12 border-t border-gray-200">
      <div className="max-w-5xl mx-auto text-center">
        {tier === "starter" ? (
          <div className="space-y-4">
            <p className="text-base font-semibold text-gray-900">Powered by Tone of Voice App</p>
            <p className="text-sm text-gray-600">
              Create your own professional tone of voice guidelines in minutes at{" "}
              <a href="https://toneofvoice.app" className="text-gray-900 hover:underline font-medium">
                toneofvoice.app
              </a>
            </p>
          </div>
        ) : (
          <p className="text-xs text-gray-400">
            Powered by{" "}
            <a href="https://toneofvoice.app" className="text-gray-500 hover:underline">
              Tone of Voice App
            </a>
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * The guide document: cover and sections in preview mode, or a single editor
 * (unlocked sections) followed by locked sections in edit mode.
 */
export function GuideView({
  sections,
  scrollContainerRef,
  viewMode,
  onContentChange,
  onBrandNameChange,
  brandName,
  showPreviewBadge = false,
  isUnlocked,
  onUpgrade,
  editorKey,
  editorId,
  pdfFooter = null,
  contentClassName,
  contentKey,
  websiteUrl,
  subscriptionTier = "starter",
  showAI = false,
  coverDisclaimer,
  coverDate,
}: GuideViewProps) {
  const nonCover = sections.filter((s) => s.id !== "cover")
  const lockedSections = nonCover.filter((s) => !isUnlocked(s.minTier) && hasContent(s))

  const handleEditorChange = (md: string) => {
    const merged = mergeEditedMarkdown({ editorMarkdown: md, sections, isUnlocked, brandName })
    if (merged.brandName) onBrandNameChange?.(merged.brandName)
    onContentChange(merged.content)
  }

  let body: ReactNode
  if (viewMode === "preview") {
    // Preview: open sections, then locked sections, then "Questions?" last.
    const questions = nonCover.find((s) => s.id === "contact" && hasContent(s))
    const unlocked = nonCover.filter((s) => s.id !== "contact" && isUnlocked(s.minTier) && hasContent(s))
    const locked = lockedSections.filter((s) => s.id !== "contact")
    body = (
      <>
        <div id="cover" className="scroll-mt-4">
          <GuideCover
            brandName={brandName}
            date={coverDate}
            showPreviewBadge={showPreviewBadge}
            websiteUrl={websiteUrl}
            subscriptionTier={subscriptionTier}
            disclaimer={coverDisclaimer}
          />
        </div>
        {unlocked.map((section, i) => (
          <SectionBlock key={section.id} section={section} index={i}>
            <MarkdownRenderer content={`## ${section.title}\n\n${section.content}`} sectionId={section.id} />
          </SectionBlock>
        ))}
        {locked.map((section, i) => (
          <LockedSection key={section.id} section={section} index={unlocked.length + i} onUpgrade={onUpgrade} />
        ))}
        {questions && (
          <SectionBlock section={questions} index={unlocked.length + locked.length}>
            <MarkdownRenderer content={`## ${questions.title}\n\n${questions.content}`} sectionId={questions.id} />
          </SectionBlock>
        )}
      </>
    )
  } else {
    // Edit: one editor with every unlocked section (including "Questions?"), locked sections below.
    body = (
      <>
        <div id="cover" className="scroll-mt-4" />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-single-editor-root>
          <GuideEditor
            key={editorKey}
            editorId={editorId}
            markdown={buildEditorMarkdown({ sections, isUnlocked, brandName })}
            useSectionIds
            showAI={showAI}
            subscriptionTier={subscriptionTier}
            onChange={handleEditorChange}
          />
        </div>
        {lockedSections.map((section, i) => (
          <LockedSection key={section.id} section={section} index={i} onUpgrade={onUpgrade} />
        ))}
      </>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div
          key={contentKey}
          id="pdf-export-content"
          className={cn(
            playfairDisplay.variable,
            viewMode === "edit"
              ? "flex min-h-full flex-col bg-white overflow-hidden"
              : "bg-white rounded-lg border shadow-sm overflow-hidden preview-document",
            contentClassName
          )}
        >
          {body}
          <BrandingFooter tier={subscriptionTier} />
          {viewMode === "preview" && <div className="pdf-exclude h-[50vh] min-h-[300px] shrink-0" aria-hidden />}
          {pdfFooter}
        </div>
      </div>
    </div>
  )
}
