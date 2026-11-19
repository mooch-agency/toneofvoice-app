import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchWithRetry } from "./api-utils"

const res = (status: number) => new Response("x", { status, statusText: "S" })
const fast = { delayMs: 1, maxAttempts: 3 }

describe("fetchWithRetry", () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("returns an ok response without retrying", async () => {
    fetchMock.mockResolvedValue(res(200))
    const r = await fetchWithRetry("/x", {}, fast)
    expect(r.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([400, 401, 403, 404, 422, 500])("does not retry %i", async (status) => {
    fetchMock.mockResolvedValue(res(status))
    await expect(fetchWithRetry("/x", {}, fast)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([408, 429, 502, 503, 504])("retries %i and succeeds", async (status) => {
    fetchMock.mockResolvedValueOnce(res(status)).mockResolvedValueOnce(res(200))
    const r = await fetchWithRetry("/x", {}, fast)
    expect(r.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("gives up after maxAttempts on retryable status", async () => {
    fetchMock.mockResolvedValue(res(503))
    await expect(fetchWithRetry("/x", {}, fast)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("retries network errors", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(res(200))
    await fetchWithRetry("/x", {}, fast)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("backs off between retries", async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(res(503))
    const p = fetchWithRetry("/x", {}, { delayMs: 100, maxAttempts: 3, backoffMultiplier: 2 })
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(199)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await expect(p).rejects.toThrow()
  })

  it("respects the caller's AbortSignal and does not retry an abort", async () => {
    const ac = new AbortController()
    fetchMock.mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_r, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          )
        }),
    )
    const p = fetchWithRetry("/x", { signal: ac.signal }, fast)
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: "AbortError" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
