import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const toast = vi.fn()
const replace = vi.fn()
const toastApi = { toast }
vi.mock("@/hooks/use-toast", () => ({ useToast: () => toastApi }))
const router = { replace }
vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("@/lib/mixpanel", () => ({ track: vi.fn() }))

import { usePreviewGeneration } from "./use-preview-generation"

const brand = { name: "Acme" }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("usePreviewGeneration", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const onLoad = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    toast.mockReset()
    replace.mockReset()
    onLoad.mockReset()
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("redirects home when there is no stored brand", async () => {
    renderHook(() => usePreviewGeneration({ enabled: true, generate: false, onLoad }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("loads a cached preview without calling the API", async () => {
    localStorage.setItem("brandDetails", JSON.stringify(brand))
    localStorage.setItem("previewContent", "## About\n\nCached.")
    const { result } = renderHook(() => usePreviewGeneration({ enabled: true, generate: false, onLoad }))
    await waitFor(() => expect(onLoad).toHaveBeenCalledWith("## About\n\nCached.", brand))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
  })

  it("refreshes the draft time when a cached preview is opened (visitor is active)", async () => {
    localStorage.setItem("brandDetails", JSON.stringify(brand))
    localStorage.setItem("previewContent", "## About\n\nCached.")
    localStorage.setItem("draftCreatedAt", "1")
    renderHook(() => usePreviewGeneration({ enabled: true, generate: false, onLoad }))
    await waitFor(() => expect(onLoad).toHaveBeenCalled())
    expect(Number(localStorage.getItem("draftCreatedAt"))).toBeGreaterThan(1)
  })

  it("generates a fresh preview, stores it and cleans the URL", async () => {
    localStorage.setItem("brandDetails", JSON.stringify(brand))
    localStorage.setItem("selectedTraits", JSON.stringify(["Bold"]))
    fetchMock.mockResolvedValue(json({ preview: "## About\n\nNew." }))
    const { result } = renderHook(() => usePreviewGeneration({ enabled: true, generate: true, onLoad }))
    expect(result.current.generating).toBe(true)
    await waitFor(() => expect(onLoad).toHaveBeenCalledWith("## About\n\nNew.", brand))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ brandDetails: brand, selectedTraits: ["Bold"] })
    expect(localStorage.getItem("previewContent")).toBe("## About\n\nNew.")
    expect(Number(localStorage.getItem("draftCreatedAt"))).toBeGreaterThan(0)
    expect(replace).toHaveBeenCalledWith("/guide", { scroll: false })
  })

  it("aborts the generation request on unmount", async () => {
    localStorage.setItem("brandDetails", JSON.stringify(brand))
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const { unmount } = renderHook(() => usePreviewGeneration({ enabled: true, generate: true, onLoad }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const signal: AbortSignal = fetchMock.mock.calls[0][1].signal
    unmount()
    expect(signal.aborted).toBe(true)
    expect(toast).not.toHaveBeenCalled()
  })

  it("shows an error and goes home when generation fails", async () => {
    localStorage.setItem("brandDetails", JSON.stringify(brand))
    fetchMock.mockResolvedValue(json({ error: "Rate limited" }, 429))
    renderHook(() => usePreviewGeneration({ enabled: true, generate: true, onLoad }))
    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(replace).toHaveBeenCalledWith("/")
    expect(onLoad).not.toHaveBeenCalled()
  })

  it("does nothing when disabled (saved guide flow)", async () => {
    localStorage.setItem("brandDetails", JSON.stringify(brand))
    const { result } = renderHook(() => usePreviewGeneration({ enabled: false, generate: false, onLoad }))
    await new Promise((r) => setTimeout(r, 0))
    expect(onLoad).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
  })
})
