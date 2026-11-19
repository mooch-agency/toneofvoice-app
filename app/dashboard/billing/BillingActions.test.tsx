import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const h = vi.hoisted(() => ({ toast: vi.fn(), initiateCheckout: vi.fn(), refresh: vi.fn() }))
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }) }))
vi.mock("@/lib/meta-pixel", () => ({ MetaPixel: { initiateCheckout: h.initiateCheckout } }))

import { BillingActions } from "./BillingActions"

const fetchMock = vi.fn()
const originalLocation = window.location

beforeEach(() => {
  fetchMock.mockReset()
  h.toast.mockReset()
  h.refresh.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  Object.defineProperty(window, "location", { configurable: true, value: { href: "http://localhost/" } })
})
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
})

const respond = (status: number, body: unknown) =>
  fetchMock.mockResolvedValue({ ok: status < 400, status, json: async () => body })

describe("BillingActions", () => {
  it("starter: starts checkout for the chosen plan", async () => {
    respond(200, { url: "https://checkout/cs_1" })
    render(<BillingActions hasCustomer={false} tier="starter" plan="pro" />)
    fireEvent.click(screen.getByRole("button", { name: "Get Pro" }))
    await waitFor(() => expect(window.location.href).toBe("https://checkout/cs_1"))
    expect(fetchMock).toHaveBeenCalledWith("/api/create-subscription-session", expect.anything())
  })

  it("follows the billing portal link when the server says a subscription already exists (409)", async () => {
    respond(409, { error: "You already have a subscription.", manageUrl: "https://portal/x" })
    render(<BillingActions hasCustomer tier="starter" plan="agency" />)
    fireEvent.click(screen.getByRole("button", { name: "Get Agency" }))
    await waitFor(() => expect(window.location.href).toBe("https://portal/x"))
    expect(h.toast).not.toHaveBeenCalled()
  })

  it("starter whose checkout says 'upgrade' (409) gets the in-app upgrade dialog", async () => {
    respond(409, { error: "You already have a subscription.", upgrade: true })
    render(<BillingActions hasCustomer tier="starter" plan="agency" />)
    fireEvent.click(screen.getByRole("button", { name: "Get Agency" }))
    expect(await screen.findByRole("dialog")).toHaveTextContent(/prorated/i)
    expect(window.location.href).toBe("http://localhost/")
  })

  describe("pro -> agency (in-app upgrade, no billing portal)", () => {
    const openDialog = async () => {
      render(<BillingActions hasCustomer tier="pro" plan="agency" />)
      fireEvent.click(screen.getByRole("button", { name: "Upgrade to Agency" }))
      return screen.findByRole("dialog")
    }

    it("asks for confirmation first, explaining the prorated charge today", async () => {
      const dialog = await openDialog()
      expect(dialog).toHaveTextContent(/prorated/i)
      expect(dialog).toHaveTextContent(/today/i)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("cancel closes the dialog without charging", async () => {
      await openDialog()
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("confirm upgrades via /api/change-plan, toasts and refreshes", async () => {
      respond(200, { success: true, subscription_tier: "agency" })
      await openDialog()
      fireEvent.click(screen.getByRole("button", { name: /confirm upgrade/i }))
      await waitFor(() => expect(h.refresh).toHaveBeenCalled())
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe("/api/change-plan")
      expect(init).toMatchObject({ method: "POST" })
      expect(JSON.parse(init.body)).toEqual({ plan: "agency" })
      expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/agency/i) }))
      expect(h.toast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }))
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
      expect(window.location.href).toBe("http://localhost/")
    })

    it("shows the server's message when the upgrade fails (e.g. card declined)", async () => {
      respond(402, { error: "Your card was declined. Update your payment method." })
      await openDialog()
      fireEvent.click(screen.getByRole("button", { name: /confirm upgrade/i }))
      await waitFor(() =>
        expect(h.toast).toHaveBeenCalledWith(
          expect.objectContaining({ variant: "destructive", description: "Your card was declined. Update your payment method." }),
        ),
      )
      expect(h.refresh).not.toHaveBeenCalled()
      expect(screen.getByRole("button", { name: /confirm upgrade/i })).not.toBeDisabled()
    })

    it("shows a generic message when the request itself fails", async () => {
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
      await openDialog()
      fireEvent.click(screen.getByRole("button", { name: /confirm upgrade/i }))
      await waitFor(() =>
        expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })),
      )
      expect(h.refresh).not.toHaveBeenCalled()
    })

    it("never starts a second checkout or opens the portal", async () => {
      respond(200, { success: true, subscription_tier: "agency" })
      await openDialog()
      fireEvent.click(screen.getByRole("button", { name: /confirm upgrade/i }))
      await waitFor(() => expect(h.refresh).toHaveBeenCalled())
      expect(fetchMock).not.toHaveBeenCalledWith("/api/create-subscription-session", expect.anything())
      expect(fetchMock).not.toHaveBeenCalledWith("/api/create-portal-session", expect.anything())
    })
  })

  it("current plan shows Manage", () => {
    render(<BillingActions hasCustomer tier="agency" plan="agency" />)
    expect(screen.getByRole("button", { name: "Manage" })).toBeInTheDocument()
  })

  it("no downgrade button on a lower plan card", () => {
    const { container } = render(<BillingActions hasCustomer tier="agency" plan="pro" />)
    expect(container).toBeEmptyDOMElement()
  })
})
