import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const toast = vi.fn()
const toastApi = { toast }
const html2pdfSave = vi.fn().mockResolvedValue(undefined)
vi.mock("@/hooks/use-toast", () => ({ useToast: () => toastApi }))
vi.mock("@/lib/mixpanel", () => ({ track: vi.fn() }))
vi.mock("html2pdf.js", () => ({
  default: () => ({ set: () => ({ from: () => ({ save: html2pdfSave }) }) }),
}))
vi.mock("@/lib/file-generator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/file-generator")>()),
  downloadFile: vi.fn(),
}))

import JSZip from "jszip"
import { downloadFile } from "@/lib/file-generator"
import { useGuideExport, type UseGuideExportOptions } from "./use-guide-export"

const CONTENT = "## About\n\nKeep every message clear and consistent.\n\n## Style Rules\n\nRule one."

const options = (overrides: Partial<UseGuideExportOptions> = {}): UseGuideExportOptions => ({
  content: CONTENT,
  brandName: "Acme Co",
  tier: "starter",
  preview: false,
  ...overrides,
})

const downloads = () => vi.mocked(downloadFile).mock.calls

/** jsdom Blobs have no .text(); read them with jsdom's FileReader. */
const readText = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.readAsText(blob)
  })

/** Minimal fetch responses built on jsdom Blobs (undici Response blobs are not jsdom Blobs). */
const serverPdfOk = (url: string) =>
  Promise.resolve(
    url === "/pdf-styles"
      ? { ok: true, status: 200, text: async () => "body{}" }
      : { ok: true, status: 200, blob: async () => new Blob(["%PDF"]) }
  )

describe("useGuideExport", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    toast.mockReset()
    html2pdfSave.mockClear()
    vi.mocked(downloadFile).mockReset()
    document.body.innerHTML = `<div id="pdf-export-content"><section>Body</section><section data-locked-section>Locked</section></div>`
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("exports Markdown without dropping user text or locked-tier leaks", async () => {
    const { result } = renderHook(() => useGuideExport(options()))
    await act(() => result.current.exportFile("md"))
    const [blob, filename] = downloads()[0]
    expect(filename).toBe("acme-co-style-guide.md")
    const text = await readText(blob)
    expect(text).toContain("Keep every message clear and consistent.")
    expect(text).not.toContain("Style Rules")
  })

  it("calls onExported after a successful export", async () => {
    const onExported = vi.fn()
    const { result } = renderHook(() => useGuideExport(options({ onExported })))
    await act(() => result.current.exportFile("docx"))
    expect(downloads()[0][1]).toBe("acme-co-style-guide.docx")
    expect(onExported).toHaveBeenCalledTimes(1)
  })

  it("downloads the server PDF without the locked sections", async () => {
    fetchMock.mockImplementation(serverPdfOk)
    const { result } = renderHook(() => useGuideExport(options({ preview: true })))
    await act(() => result.current.exportPdf())
    const exportCall = fetchMock.mock.calls.find(([url]) => url === "/api/export-pdf")!
    expect(JSON.parse(exportCall[1].body).html).not.toContain("Locked")
    expect(downloads()[0][1]).toBe("acme-co-style-guide-preview.pdf")
    expect(html2pdfSave).not.toHaveBeenCalled()
  })

  it("falls back to html2pdf when the PDF styles cannot be loaded", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }))
    const { result } = renderHook(() => useGuideExport(options()))
    await act(() => result.current.exportPdf())
    expect(html2pdfSave).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Download started" }))
  })

  it("bundles Word, Markdown and PDF into one zip", async () => {
    fetchMock.mockImplementation(serverPdfOk)
    const { result } = renderHook(() => useGuideExport(options({ tier: "pro" })))
    await act(() => result.current.exportAll())
    const [blob, filename] = downloads()[0]
    expect(filename).toBe("acme-co-style-guide.zip")
    const zip = await JSZip.loadAsync(blob)
    expect(Object.keys(zip.files).sort()).toEqual([
      "acme-co-style-guide.docx",
      "acme-co-style-guide.md",
      "acme-co-style-guide.pdf",
    ])
    expect(result.current.downloading).toBeNull()
  })

  it("reports a failure with a toast", async () => {
    document.body.innerHTML = ""
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }))
    const { result } = renderHook(() => useGuideExport(options()))
    await act(() => result.current.exportPdf())
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }))
    expect(result.current.downloading).toBeNull()
  })
})
