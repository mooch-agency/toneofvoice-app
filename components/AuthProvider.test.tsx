import { act, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  signOut: vi.fn(),
  flush: vi.fn(),
  reset: vi.fn(),
}))

vi.mock("@/lib/supabase-browser", () => ({
  createClient: () => ({
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      getUser: () => Promise.resolve({ data: { user: { id: "u1", email: "a@b.co" } } }),
      signOut: h.signOut,
    },
  }),
}))
vi.mock("@/hooks/use-autosave", () => ({ flushPendingAutosaves: h.flush }))
vi.mock("@/lib/mixpanel", () => ({ identify: vi.fn(), reset: h.reset }))
vi.mock("mixpanel-browser", () => ({ default: { register: vi.fn(), stop_session_recording: vi.fn() } }))

import { AuthProvider, useAuth } from "./AuthProvider"

const api: { signOut: () => Promise<void> } = { signOut: async () => {} }
const signOut = () => api.signOut()
function Grab() {
  const auth = useAuth()
  useEffect(() => {
    api.signOut = auth.signOut
  }, [auth.signOut])
  return <span>{auth.user?.id ?? "none"}</span>
}

describe("AuthProvider signOut", () => {
  const originalLocation = window.location

  beforeEach(() => {
    h.signOut.mockReset().mockResolvedValue({ error: null })
    h.flush.mockReset().mockResolvedValue(undefined)
    h.reset.mockReset()
    localStorage.clear()
    Object.defineProperty(window, "location", { configurable: true, value: { href: "/guide" } })
  })

  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
  })

  async function mount() {
    render(
      <AuthProvider>
        <Grab />
      </AuthProvider>
    )
    await waitFor(() => expect(screen.getByText("u1")).toBeInTheDocument())
  }

  it("flushes pending autosaves before ending the session", async () => {
    let finishFlush!: () => void
    h.flush.mockReturnValue(new Promise<void>((r) => (finishFlush = r)))
    await mount()

    let done: Promise<void>
    act(() => {
      done = signOut()
    })
    await act(async () => {})
    expect(h.flush).toHaveBeenCalledTimes(1)
    expect(h.signOut).not.toHaveBeenCalled()

    await act(async () => {
      finishFlush()
      await done
    })
    expect(h.signOut).toHaveBeenCalledTimes(1)
    expect(h.flush.mock.invocationCallOrder[0]).toBeLessThan(h.signOut.mock.invocationCallOrder[0])
    expect(window.location.href).toBe("/")
  })

  it("still signs out when the flush fails", async () => {
    h.flush.mockRejectedValue(new Error("offline"))
    await mount()
    await act(() => signOut())
    expect(h.signOut).toHaveBeenCalledTimes(1)
  })

  it("resets Mixpanel and the internal-user flag so the next person is not attributed to this user", async () => {
    localStorage.setItem("mp_internal_user", "true")
    await mount()
    await act(() => signOut())
    expect(h.reset).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem("mp_internal_user")).toBeNull()
  })
})
