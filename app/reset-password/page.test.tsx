import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))

const updateUser = vi.fn()
vi.mock("@/lib/supabase-browser", () => ({
  createClient: () => ({
    auth: {
      updateUser,
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
        cb("PASSWORD_RECOVERY", null)
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      },
    },
  }),
}))

import ResetPasswordPage from "./page"

describe("reset-password page", () => {
  beforeEach(() => updateUser.mockReset())

  it("uses the shared 8-character policy (FE-21)", async () => {
    render(<ResetPasswordPage />)
    await userEvent.type(screen.getByLabelText("New password"), "1234567")
    await userEvent.type(screen.getByLabelText("Confirm new password"), "1234567")
    const form = screen.getByLabelText("New password").closest("form")!
    form.noValidate = true
    await userEvent.click(form.querySelector("button[type=submit]")!)
    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument()
    expect(updateUser).not.toHaveBeenCalled()
  })
})
