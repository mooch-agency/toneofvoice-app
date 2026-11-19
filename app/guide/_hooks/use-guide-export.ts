"use client"

import { useCallback, useState } from "react"
import JSZip from "jszip"
import { useToast } from "@/hooks/use-toast"
import { prepareExportMarkdown } from "@/lib/export-markdown"
import { downloadFile, generateFile, type FileFormat } from "@/lib/file-generator"
import { guideFilename, prepareExportClone } from "@/lib/guide-files"
import { track as mpTrack } from "@/lib/mixpanel"
import type { Tier } from "@/lib/tiers"

export type ExportFormat = "pdf" | FileFormat | "zip"

const PDF_EXPORT_TIMEOUT_MS = 25000
const PDF_SOURCE_ID = "pdf-export-content"

/** Render the guide on the server (Puppeteer). Throws on any failure. */
async function fetchServerPdf(clone: HTMLElement, filename: string): Promise<Blob> {
  const cssRes = await fetch("/pdf-styles")
  if (!cssRes.ok) throw new Error(`PDF styles failed (${cssRes.status})`)
  const css = await cssRes.text()
  const res = await fetch("/api/export-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html: clone.outerHTML, css, filename }),
    signal: AbortSignal.timeout(PDF_EXPORT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`PDF export failed (${res.status})`)
  return res.blob()
}

type Html2Pdf = () => { set: (o: object) => { from: (el: HTMLElement) => { save: () => Promise<void> } } }

/** Client-side PDF (html2pdf) when the server export is unavailable. */
async function html2pdfDownload(clone: HTMLElement, filename: string, paginate: boolean) {
  const wrapper = document.createElement("div")
  Object.assign(wrapper.style, { position: "fixed", left: "-99999px", top: "0", background: "#ffffff", width: "816px" })
  wrapper.appendChild(clone)
  document.body.appendChild(wrapper)
  try {
    await document.fonts?.ready
    // @ts-expect-error - no declaration file for html2pdf.js
    const html2pdf = (await import("html2pdf.js")).default as Html2Pdf
    await html2pdf()
      .set({
        margin: 0.5,
        filename,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, allowTaint: true, letterRendering: true, logging: false },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
        ...(paginate && {
          pagebreak: { mode: ["avoid-all", "css", "legacy"], avoid: ["h2", "h3", ".voice-trait", ".rule-section", ".pdf-section"] },
        }),
      })
      .from(clone)
      .save()
  } finally {
    wrapper.remove()
  }
}

function exportClone(): HTMLElement {
  const source = document.getElementById(PDF_SOURCE_ID)
  if (!source) throw new Error("PDF content not found")
  return prepareExportClone(source)
}

export interface UseGuideExportOptions {
  content: string | null
  brandName: string
  websiteUrl?: string
  tier: Tier
  /** Preview flow: files are named "-preview". */
  preview: boolean
  onExported?: () => void
}

/** PDF, Word, Markdown and zip downloads for the guide on screen. */
export function useGuideExport({ content, brandName, websiteUrl, tier, preview, onExported }: UseGuideExportOptions) {
  const { toast } = useToast()
  const [downloading, setDownloading] = useState<ExportFormat | null>(null)

  const buildFile = useCallback(
    (format: FileFormat) =>
      generateFile(format, prepareExportMarkdown(content ?? "", { brandName, tier }), brandName, {
        websiteUrl,
        subscriptionTier: tier,
      }),
    [content, brandName, tier, websiteUrl]
  )

  const run = useCallback(
    async (format: ExportFormat, task: () => Promise<string>) => {
      if (!content || downloading) return
      setDownloading(format)
      try {
        const description = await task()
        mpTrack("Guide Downloaded", { format, flow: preview ? "preview" : "saved" })
        toast({ title: "Download started", description })
        onExported?.()
      } catch (error) {
        console.error(`[Guide] ${format} export failed:`, error)
        toast({ title: "Download failed", description: "Could not generate the file. Please try again.", variant: "destructive" })
      } finally {
        setDownloading(null)
      }
    },
    [content, downloading, preview, toast, onExported]
  )

  const exportPdf = useCallback(
    () =>
      run("pdf", async () => {
        const clone = exportClone()
        const filename = guideFilename(brandName, "pdf", { preview })
        try {
          downloadFile(await fetchServerPdf(clone, filename), filename)
          return "Your guide is downloading in PDF format."
        } catch (error) {
          console.warn("[Guide] Server PDF failed, using browser fallback:", error)
          await html2pdfDownload(clone, filename, !preview)
          return "Your guide is downloading. Some styling may differ."
        }
      }),
    [run, brandName, preview]
  )

  const exportFile = useCallback(
    (format: FileFormat) =>
      run(format, async () => {
        downloadFile(await buildFile(format), guideFilename(brandName, format, { preview }))
        return `Your guide is downloading in ${format === "docx" ? "Word" : "Markdown"} format.`
      }),
    [run, buildFile, brandName, preview]
  )

  const exportAll = useCallback(
    () =>
      run("zip", async () => {
        const [docx, md] = await Promise.all([buildFile("docx"), buildFile("md")])
        const pdfName = guideFilename(brandName, "pdf", { preview })
        const pdf = await fetchServerPdf(exportClone(), pdfName).catch(() => null)
        const zip = new JSZip()
        zip.file(guideFilename(brandName, "docx", { preview }), docx)
        zip.file(guideFilename(brandName, "md", { preview }), md)
        if (pdf) zip.file(pdfName, pdf)
        downloadFile(await zip.generateAsync({ type: "blob" }), guideFilename(brandName, "zip", { preview }))
        return pdf
          ? "All formats (PDF, Word, Markdown) downloaded as a zip."
          : "Word and Markdown downloaded as a zip. Download the PDF separately."
      }),
    [run, buildFile, brandName, preview]
  )

  return { downloading, exportPdf, exportFile, exportAll }
}
