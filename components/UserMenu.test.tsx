import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/dashboard",
}))

const signOut = vi.fn()
const user = { id: "u1", email: "ann@example.com", user_metadata: { full_name: "Ann" } }
vi.mock("@/lib/supabase-browser", () => ({
  createClient: () => ({
    auth: {
      signOut,
      getUser: () => Promise.resolve({ data: { user } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  }),
}))
vi.mock("@/lib/mixpanel", () => ({ identify: vi.fn() }))
vi.mock("mixpanel-browser", () => ({ default: { register: vi.fn(), stop_session_recording: vi.fn() } }))

import { AuthProvider } from "./AuthProvider"
import { UserMenu } from "./UserMenu"

const KEYS = [
  "brandDetails",
  "previewContent",
  "generatedStyleGuide",
  "selectedTraits",
  "suggestedTraits",
  "brandKeywords",
  "emailCapture",
  "savedGuideId",
  "guide-edits-abc",
]

describe("UserMenu log out", () => {
  beforeEach(() => {
    signOut.mockReset().mockResolvedValue({ error: null })
    localStorage.clear()
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: "http://localhost/", origin: "http://localhost" },
    })
  })

  it("signs out and clears the previous user's drafts from localStorage (FE-9)", async () => {
    KEYS.forEach((k) => localStorage.setItem(k, "x"))
    localStorage.setItem("unrelated", "keep")
    render(
      <AuthProvider>
        <UserMenu />
      </AuthProvider>,
    )
    await userEvent.click(await screen.findByRole("button", { name: /ann/i }))
    await userEvent.click(await screen.findByRole("menuitem", { name: /log out/i }))

    await waitFor(() => expect(signOut).toHaveBeenCalled())
    KEYS.forEach((k) => expect(localStorage.getItem(k)).toBeNull())
    expect(localStorage.getItem("unrelated")).toBe("keep")
    expect(window.location.href).toBe("/")
  })
})
