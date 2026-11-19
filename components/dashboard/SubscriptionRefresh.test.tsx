import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@testing-library/react"

const h = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  purchase: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () => h.params,
  useRouter: () => ({ replace: h.replace, refresh: h.refresh }),
}))
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }))
vi.mock("@/lib/meta-pixel", () => ({ MetaPixel: { purchase: h.purchase } }))

import { SubscriptionRefresh } from "./SubscriptionRefresh"

const fetchMock = vi.fn()

beforeEach(() => {
  h.replace.mockReset()
  h.refresh.mockReset()
  h.toast.mockReset()
  h.purchase.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})

const respond = (body: unknown) => fetchMock.mockResolvedValue({ ok: true, json: async () => body })

describe("SubscriptionRefresh", () => {
  it("does nothing without ?subscription=success", () => {
    h.params = new URLSearchParams("")
    render(<SubscriptionRefresh />)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends the checkout session_id to verify-subscription", async () => {
    h.params = new URLSearchParams("subscription=success&session_id=cs_test_123")
    respond({ subscription_tier: "pro", updated: true })
    render(<SubscriptionRefresh />)
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/dashboard", { scroll: false }))
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/verify-subscription",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ session_id: "cs_test_123" }) }),
    )
    expect(h.refresh).toHaveBeenCalled()
  })

  it("fires the Purchase pixel with the verified tier", async () => {
    h.params = new URLSearchParams("subscription=success&session_id=cs_test_123&plan=agency")
    respond({ subscription_tier: "pro", updated: true })
    render(<SubscriptionRefresh />)
    await waitFor(() => expect(h.purchase).toHaveBeenCalledWith("pro"))
  })

  it("does not fire the pixel when the plan is not active yet", async () => {
    h.params = new URLSearchParams("subscription=success&session_id=cs_test_123")
    respond({ subscription_tier: "starter", updated: false })
    render(<SubscriptionRefresh />)
    await waitFor(() => expect(h.replace).toHaveBeenCalled())
    expect(h.purchase).not.toHaveBeenCalled()
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Processing subscription..." }))
  })

  it("still verifies (by customer) when the session id is missing", async () => {
    h.params = new URLSearchParams("subscription=success")
    respond({ subscription_tier: "starter" })
    render(<SubscriptionRefresh />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({}))
  })
})
