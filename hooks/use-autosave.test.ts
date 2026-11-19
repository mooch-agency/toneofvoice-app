import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useAutosave, type UseAutosaveOptions } from "./use-autosave"

const brandDetails = { name: "Acme" }

function setup(initial: Partial<UseAutosaveOptions> = {}) {
  const props: UseAutosaveOptions = {
    guideId: "g1",
    content: "## About\n\nv1",
    brandDetails,
    planType: "core",
    enabled: true,
    ...initial,
  }
  return renderHook((p: UseAutosaveOptions) => useAutosave(p), { initialProps: props })
}

const okResponse = () => new Response(JSON.stringify({ success: true }), { status: 200 })

describe("useAutosave", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okResponse()))
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("debounces: no call before the delay, one call after", async () => {
    setup()
    await act(async () => vi.advanceTimersByTime(1999))
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("sends the real plan type and guide fields", async () => {
    setup()
    await act(async () => vi.advanceTimersByTime(2000))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/save-style-guide")
    expect(JSON.parse(init.body)).toEqual({
      guide_id: "g1",
      title: "Acme Style Guide",
      brand_name: "Acme",
      content_md: "## About\n\nv1",
      plan_type: "core",
      brand_details: brandDetails,
    })
  })

  it("does nothing while disabled (no edits yet)", async () => {
    setup({ enabled: false })
    await act(async () => vi.advanceTimersByTime(5000))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does nothing without a guide id", async () => {
    setup({ guideId: null })
    await act(async () => vi.advanceTimersByTime(5000))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("flushes a pending save on unmount with keepalive", async () => {
    const { unmount } = setup()
    await act(async () => vi.advanceTimersByTime(500))
    unmount()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).content_md).toBe("## About\n\nv1")
  })

  it("flushes large guides without keepalive (browsers cap keepalive bodies at 64 KB)", async () => {
    const { unmount } = setup({ content: "x".repeat(70_000) })
    unmount()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(false)
  })

  it("does not save again on unmount when nothing is pending", async () => {
    const { unmount } = setup()
    await act(async () => vi.advanceTimersByTime(2000))
    unmount()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("flushes a pending save on pagehide", async () => {
    setup()
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"))
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true)
  })

  it("aborts the previous request when a newer save starts", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const { rerender } = setup()
    await act(async () => vi.advanceTimersByTime(2000))
    const firstSignal: AbortSignal = fetchMock.mock.calls[0][1].signal
    expect(firstSignal.aborted).toBe(false)

    rerender({ guideId: "g1", content: "## About\n\nv2", brandDetails, planType: "core", enabled: true })
    await act(async () => vi.advanceTimersByTime(2000))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(firstSignal.aborted).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).content_md).toBe("## About\n\nv2")
  })

  it("reports status saving then saved", async () => {
    let resolve!: (r: Response) => void
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (resolve = r)))
    const { result } = setup()
    expect(result.current.status).toBe("pending")
    await act(async () => vi.advanceTimersByTime(2000))
    expect(result.current.status).toBe("saving")
    await act(async () => resolve(okResponse()))
    expect(result.current.status).toBe("saved")
  })

  it("reports errors once and sets status error", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("{}", { status: 500 })))
    const onError = vi.fn()
    const { result } = setup({ onError })
    await act(async () => vi.advanceTimersByTime(2000))
    expect(result.current.status).toBe("error")
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
