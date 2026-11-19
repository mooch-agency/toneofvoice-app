import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const toast = vi.fn()
const push = vi.fn()
const authState: { user: { id: string } | null } = { user: { id: "u1" } }
const toastApi = { toast }
vi.mock("@/hooks/use-toast", () => ({ useToast: () => toastApi }))
const router = { push }
vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => authState }))
vi.mock("@/lib/meta-pixel", () => ({ MetaPixel: { initiateCheckout: vi.fn() } }))

import { useCheckout } from "./use-checkout"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("useCheckout", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const navigate = vi.fn()

  beforeEach(() => {
    authState.user = { id: "u1" }
    toast.mockReset()
    push.mockReset()
    navigate.mockReset()
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("goes to the Stripe checkout URL", async () => {
    fetchMock.mockResolvedValue(json({ url: "https://checkout.stripe.com/x" }))
    const { result } = renderHook(() => useCheckout({ navigate }))
    await act(() => result.current.startCheckout("pro"))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ plan: "pro" })
    expect(navigate).toHaveBeenCalledWith("https://checkout.stripe.com/x")
  })

  it("opens the billing portal when the user already has a subscription (409)", async () => {
    fetchMock.mockResolvedValue(json({ error: "exists", manageUrl: "https://billing.stripe.com/p" }, 409))
    const { result } = renderHook(() => useCheckout({ navigate }))
    await act(() => result.current.startCheckout("agency"))
    expect(navigate).toHaveBeenCalledWith("https://billing.stripe.com/p")
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/already/i) }))
  })

  it("sends signed-out users to sign-up with the plan", async () => {
    authState.user = null
    const { result } = renderHook(() => useCheckout({ navigate }))
    await act(() => result.current.startCheckout("pro"))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith(`/sign-up?redirectTo=${encodeURIComponent("/guide?subscribe=pro")}`)
  })

  it("shows a toast on failure and resets the processing plan", async () => {
    fetchMock.mockResolvedValue(json({ error: "boom" }, 500))
    const { result } = renderHook(() => useCheckout({ navigate }))
    await act(() => result.current.startCheckout("pro"))
    expect(navigate).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }))
    expect(result.current.processingPlan).toBeNull()
  })

  it("asks to sign in again on 401", async () => {
    fetchMock.mockResolvedValue(json({ error: "Unauthorized" }, 401))
    const { result } = renderHook(() => useCheckout({ navigate }))
    await act(() => result.current.startCheckout("pro"))
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Session expired" }))
  })
})
