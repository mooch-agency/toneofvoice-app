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

  describe("existing subscriber upgrading (409 upgrade: true)", () => {
    const onUpgraded = vi.fn()
    beforeEach(() => onUpgraded.mockReset())

    it("upgrades in place via /api/change-plan and reports the new tier", async () => {
      fetchMock
        .mockResolvedValueOnce(json({ error: "exists", upgrade: true }, 409))
        .mockResolvedValueOnce(json({ success: true, subscription_tier: "agency" }))
      const { result } = renderHook(() => useCheckout({ navigate, onUpgraded }))
      await act(() => result.current.startCheckout("agency"))
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[1][0]).toBe("/api/change-plan")
      expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" })
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ plan: "agency" })
      expect(onUpgraded).toHaveBeenCalledWith("agency")
      expect(navigate).not.toHaveBeenCalled()
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/agency/i) }))
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }))
      expect(result.current.processingPlan).toBeNull()
    })

    it("shows the server's message when the upgrade fails (e.g. declined card)", async () => {
      fetchMock
        .mockResolvedValueOnce(json({ error: "exists", upgrade: true }, 409))
        .mockResolvedValueOnce(json({ error: "Your card was declined." }, 402))
      const { result } = renderHook(() => useCheckout({ navigate, onUpgraded }))
      await act(() => result.current.startCheckout("agency"))
      expect(onUpgraded).not.toHaveBeenCalled()
      expect(navigate).not.toHaveBeenCalled()
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive", description: "Your card was declined." }),
      )
      expect(result.current.processingPlan).toBeNull()
    })

    it("never charges an unconfirmed start (e.g. from a ?subscribe= link); asks for confirmation instead", async () => {
      const onNeedsConfirmation = vi.fn()
      fetchMock.mockResolvedValueOnce(json({ error: "exists", upgrade: true }, 409))
      const { result } = renderHook(() => useCheckout({ navigate, onUpgraded, onNeedsConfirmation }))
      await act(() => result.current.startCheckout("agency", { confirmed: false }))
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(onNeedsConfirmation).toHaveBeenCalledWith("agency")
      expect(onUpgraded).not.toHaveBeenCalled()
      expect(result.current.processingPlan).toBeNull()
    })

    it("keeps startCheckout stable when callbacks change", () => {
      const { result, rerender } = renderHook(({ cb }) => useCheckout({ navigate, onUpgraded: cb }), {
        initialProps: { cb: vi.fn() },
      })
      const first = result.current.startCheckout
      rerender({ cb: vi.fn() })
      expect(result.current.startCheckout).toBe(first)
    })

    it("works without an onUpgraded callback", async () => {
      fetchMock
        .mockResolvedValueOnce(json({ error: "exists", upgrade: true }, 409))
        .mockResolvedValueOnce(json({ success: true, subscription_tier: "agency" }))
      const { result } = renderHook(() => useCheckout({ navigate }))
      await act(() => result.current.startCheckout("agency"))
      expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }))
    })
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
