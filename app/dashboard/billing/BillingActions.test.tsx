import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const h = vi.hoisted(() => ({ toast: vi.fn(), initiateCheckout: vi.fn() }))
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }))
vi.mock("@/lib/meta-pixel", () => ({ MetaPixel: { initiateCheckout: h.initiateCheckout } }))

import { BillingActions } from "./BillingActions"

const fetchMock = vi.fn()
const originalLocation = window.location

beforeEach(() => {
  fetchMock.mockReset()
  h.toast.mockReset()
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

  it("pro -> agency goes through the billing portal, never a second checkout (SEC-8)", async () => {
    respond(200, { url: "https://portal/x" })
    render(<BillingActions hasCustomer tier="pro" plan="agency" />)
    fireEvent.click(screen.getByRole("button", { name: /agency/i }))
    await waitFor(() => expect(window.location.href).toBe("https://portal/x"))
    expect(fetchMock).toHaveBeenCalledWith("/api/create-portal-session", expect.anything())
    expect(fetchMock).not.toHaveBeenCalledWith("/api/create-subscription-session", expect.anything())
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
