import { render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const replace = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }) }))
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" }, loading: false }) }))

import ClaimPage from "./page"

describe("ClaimPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    replace.mockReset()
    localStorage.setItem("brandDetails", JSON.stringify({ name: "Acme" }))
    localStorage.setItem("previewContent", "## About\n\nText.")
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ guide: { id: "g1" } }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("saves a fresh draft, clears it and goes to the dashboard", async () => {
    localStorage.setItem("draftCreatedAt", String(Date.now()))
    render(<ClaimPage />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem("previewContent")).toBeNull()
    expect(localStorage.getItem("savedGuideId")).toBeNull()
  })

  it("does not claim a stale draft into this account (FE-9)", async () => {
    localStorage.setItem("draftCreatedAt", String(Date.now() - 25 * 60 * 60 * 1000))
    render(<ClaimPage />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
