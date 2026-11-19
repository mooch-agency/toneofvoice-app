import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const toast = vi.fn()
const replace = vi.fn()
const toastApi = { toast }
const router = { replace }
const authState: { user: { id: string } | null; loading: boolean } = { user: { id: "u1" }, loading: false }
vi.mock("@/hooks/use-toast", () => ({ useToast: () => toastApi }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => authState }))

import { useSavedGuide } from "./use-saved-guide"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("useSavedGuide", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const onLoad = vi.fn()

  beforeEach(() => {
    authState.user = { id: "u1" }
    authState.loading = false
    toast.mockReset()
    replace.mockReset()
    onLoad.mockReset()
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("loads the guide and takes the tier from the load response", async () => {
    fetchMock.mockResolvedValue(
      json({
        id: "g1",
        content_md: "## About\n\nText.",
        brand_name: "Acme",
        brand_details: { name: "Acme", websiteUrl: "https://acme.test" },
        plan_type: "core",
        subscription_tier: "pro",
      })
    )
    const { result } = renderHook(() => useSavedGuide("g1", onLoad))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe("/api/load-style-guide?guideId=g1")
    expect(onLoad).toHaveBeenCalledWith({
      content: "## About\n\nText.",
      brandDetails: { name: "Acme", websiteUrl: "https://acme.test" },
      planType: "core",
      tier: "pro",
    })
  })

  it("falls back to the brand name and starter tier", async () => {
    fetchMock.mockResolvedValue(json({ id: "g1", content_md: "x", brand_name: "Acme", subscription_tier: "free" }))
    renderHook(() => useSavedGuide("g1", onLoad))
    await waitFor(() => expect(onLoad).toHaveBeenCalled())
    expect(onLoad.mock.calls[0][0]).toMatchObject({ brandDetails: { name: "Acme" }, planType: "style_guide", tier: "starter" })
  })

  it("sends signed-out users to sign in", async () => {
    authState.user = null
    renderHook(() => useSavedGuide("g1", onLoad))
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/sign-in?redirectTo=${encodeURIComponent("/guide?guideId=g1")}`))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("waits for auth before loading", async () => {
    authState.loading = true
    renderHook(() => useSavedGuide("g1", onLoad))
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it("goes to the dashboard when the guide is missing", async () => {
    fetchMock.mockResolvedValue(json({ error: "not found" }, 404))
    renderHook(() => useSavedGuide("g1", onLoad))
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"))
    expect(onLoad).not.toHaveBeenCalled()
  })

  it("aborts the request on unmount", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const { unmount } = renderHook(() => useSavedGuide("g1", onLoad))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const signal: AbortSignal = fetchMock.mock.calls[0][1].signal
    unmount()
    expect(signal.aborted).toBe(true)
  })

  it("does nothing without a guide id", async () => {
    const { result } = renderHook(() => useSavedGuide(null, onLoad))
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
  })
})
