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

const signInWithPassword = vi.fn()
const signInWithOAuth = vi.fn()
vi.mock("@/lib/supabase-browser", () => ({
  createClient: () => ({ auth: { signInWithPassword, signInWithOAuth } }),
}))

import SignInPage from "./page"

async function submit() {
  await userEvent.type(screen.getByLabelText(/email/i), "a@b.co")
  await userEvent.type(screen.getByLabelText(/password/i), "password1")
  await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }))
}

describe("sign-in page", () => {
  beforeEach(() => {
    push.mockReset()
    signInWithPassword.mockReset().mockResolvedValue({ error: null })
    signInWithOAuth.mockReset().mockResolvedValue({ error: null })
    search = ""
  })

  it("ignores a javascript: redirectTo and goes to /auth/claim (FE-1)", async () => {
    search = "?redirectTo=javascript:alert(1)"
    render(<SignInPage />)
    await submit()
    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/claim"))
  })

  it("ignores an absolute-URL redirectTo", async () => {
    search = "?redirectTo=https://evil.example/login"
    render(<SignInPage />)
    await submit()
    await waitFor(() => expect(push).toHaveBeenCalledWith("/auth/claim"))
  })

  it("follows a safe internal redirectTo", async () => {
    search = "?redirectTo=" + encodeURIComponent("/guide?guideId=1")
    render(<SignInPage />)
    await submit()
    await waitFor(() => expect(push).toHaveBeenCalledWith("/guide?guideId=1"))
  })

  it("forwards only a safe path to the OAuth callback", async () => {
    search = "?redirectTo=//evil.com"
    render(<SignInPage />)
    await userEvent.click(screen.getByRole("button", { name: /google/i }))
    const opts = signInWithOAuth.mock.calls[0][0].options
    expect(opts.redirectTo).toContain("next=" + encodeURIComponent("/auth/claim"))
    expect(opts.redirectTo).not.toContain("evil")
  })

  it("does not forward an unsafe redirectTo to the sign-up link", () => {
    search = "?redirectTo=javascript:alert(1)"
    render(<SignInPage />)
    expect(screen.getByRole("link", { name: /sign up/i })).toHaveAttribute("href", "/sign-up")
  })
})
