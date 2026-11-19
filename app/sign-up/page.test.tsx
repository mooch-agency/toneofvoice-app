import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const push = vi.fn()
const refresh = vi.fn()
let search = ""
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  useSearchParams: () => new URLSearchParams(search),
}))

const signUp = vi.fn()
const signInWithOAuth = vi.fn()
vi.mock("@/lib/supabase-browser", () => ({
  createClient: () => ({ auth: { signUp, signInWithOAuth } }),
}))
vi.mock("@/lib/mixpanel", () => ({ track: vi.fn(), identify: vi.fn() }))
vi.mock("@/lib/meta-pixel", () => ({ MetaPixel: { completeRegistration: vi.fn(), lead: vi.fn() } }))

import SignUpPage from "./page"

async function fill(password: string) {
  await userEvent.type(screen.getByLabelText(/full name/i), "Ann")
  await userEvent.type(screen.getByLabelText(/email/i), "a@b.co")
  await userEvent.type(screen.getByLabelText(/password/i), password)
  await userEvent.click(screen.getByRole("button", { name: /create account/i }))
}

describe("sign-up page", () => {
  beforeEach(() => {
    push.mockReset()
    signUp.mockReset().mockResolvedValue({ data: { user: { id: "u" }, session: {} }, error: null })
    search = ""
  })

  it("redirects to /auth/claim for an unsafe redirectTo after instant sign-in (FE-1)", async () => {
    search = "?redirectTo=javascript:alert(1)"
    render(<SignUpPage />)
    await fill("password1")
    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/claim"))
    expect(signUp.mock.calls[0][0].options.emailRedirectTo).toContain(
      "next=" + encodeURIComponent("/auth/claim"),
    )
  })

  it("enforces the shared 8-char password policy", async () => {
    render(<SignUpPage />)
    await userEvent.type(screen.getByLabelText(/full name/i), "Ann")
    await userEvent.type(screen.getByLabelText(/email/i), "a@b.co")
    await userEvent.type(screen.getByLabelText(/password/i), "short")
    // bypass native minLength validation
    screen.getByRole("button", { name: /create account/i }).closest("form")!.noValidate = true
    await userEvent.click(screen.getByRole("button", { name: /create account/i }))
    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument()
    expect(signUp).not.toHaveBeenCalled()
  })
})
