import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const toast = vi.fn()
const toastApi = { toast }
vi.mock("@/hooks/use-toast", () => ({ useToast: () => toastApi }))

import { useExpandGuide } from "./use-expand-guide"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("useExpandGuide", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const onExpanded = vi.fn()

  beforeEach(() => {
    toast.mockReset()
    onExpanded.mockReset()
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("hands the full guide to onExpanded", async () => {
    fetchMock.mockResolvedValue(json({ content: "## Style Rules\n\nReal rules." }))
    const { result } = renderHook(() => useExpandGuide({ guideId: "g1", onExpanded }))
    await act(() => result.current.expand())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ guideId: "g1" })
    expect(onExpanded).toHaveBeenCalledWith("## Style Rules\n\nReal rules.")
    expect(result.current.expanding).toBe(false)
  })

  it("names the failed sections on 502 and changes nothing", async () => {
    fetchMock.mockResolvedValue(json({ error: "partial", failedSections: ["Style Rules", "Word List"] }, 502))
    const { result } = renderHook(() => useExpandGuide({ guideId: "g1", onExpanded }))
    await act(() => result.current.expand())
    expect(onExpanded).not.toHaveBeenCalled()
    const { title, description } = toast.mock.calls[0][0]
    expect(title).toMatch(/could not/i)
    expect(description).toContain("Style Rules, Word List")
    expect(description).toMatch(/try again/i)
  })

  it("explains a concurrent update on 409", async () => {
    fetchMock.mockResolvedValue(json({ error: "conflict" }, 409))
    const { result } = renderHook(() => useExpandGuide({ guideId: "g1", onExpanded }))
    await act(() => result.current.expand())
    expect(onExpanded).not.toHaveBeenCalled()
    expect(toast.mock.calls[0][0].description).toMatch(/reload/i)
  })

  it("rejects content that still has unlock placeholders", async () => {
    fetchMock.mockResolvedValue(json({ content: "## Style Rules\n\n_Unlock to see Style Rules._" }))
    const { result } = renderHook(() => useExpandGuide({ guideId: "g1", onExpanded }))
    await act(() => result.current.expand())
    expect(onExpanded).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }))
  })

  it("does nothing without a guide id", async () => {
    const { result } = renderHook(() => useExpandGuide({ guideId: null, onExpanded }))
    await act(() => result.current.expand())
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
