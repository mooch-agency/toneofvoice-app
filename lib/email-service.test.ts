// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock("resend", () => ({
  Resend: function Resend() {
    return { emails: { send: h.send } }
  },
}))

import * as mod from "./email-service"

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_x"
  process.env.NEXT_PUBLIC_APP_URL = "https://toneofvoice.app"
  h.send.mockReset()
  h.send.mockResolvedValue({ data: { id: "email_1" } })
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  delete process.env.RESEND_API_KEY
})

describe("emailService.sendThankYouEmail", () => {
  it("HTML-escapes the customer name (SEC-24)", async () => {
    await mod.emailService.sendThankYouEmail({
      customerEmail: "a@b.co",
      customerName: "<img src=x onerror=alert(1)> Smith",
    })
    const { html, text } = h.send.mock.calls[0][0]
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img")
    expect(text).toContain("<img") // plain text needs no escaping
  })

  it("links to the dashboard, not the removed one-time-payment guide link", async () => {
    await mod.emailService.sendThankYouEmail({ customerEmail: "a@b.co" })
    const { html, text } = h.send.mock.calls[0][0]
    expect(html).toContain("https://toneofvoice.app/dashboard")
    expect(html).not.toContain("session_id")
    expect(text).not.toContain("session_id")
  })

  it("does not log the recipient address", async () => {
    const log = vi.spyOn(console, "log")
    await mod.emailService.sendThankYouEmail({ customerEmail: "secret@b.co" })
    for (const call of log.mock.calls) expect(JSON.stringify(call)).not.toContain("secret@b.co")
  })

  it("reports failure without throwing when no API key is set", async () => {
    delete process.env.RESEND_API_KEY
    const result = await mod.emailService.sendThankYouEmail({ customerEmail: "a@b.co" })
    expect(result.success).toBe(false)
    expect(h.send).not.toHaveBeenCalled()
  })
})

it("no longer exports the mock helpers (SEC-22 / SIMP-6)", () => {
  const exported = mod as Record<string, unknown>
  for (const name of ["sendEmail", "scheduleEmail", "generateSecureToken", "sendPurchaseConfirmationEmail"]) {
    expect(exported[name]).toBeUndefined()
  }
})
