import { render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const toast = vi.fn()
const replace = vi.fn()
const refresh = vi.fn()
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh, push: vi.fn() }) }))
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { id: "u1" }, loading: false }) }))

import { AutoSaveGuide } from "./AutoSaveGuide"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("AutoSaveGuide", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    toast.mockReset()
    replace.mockReset()
    refresh.mockReset()
    localStorage.setItem("brandDetails", JSON.stringify({ name: "Acme" }))
    localStorage.setItem("previewContent", "## About\n\nText.")
    localStorage.setItem("draftCreatedAt", String(Date.now()))
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("tells the user at the guide limit and stops retrying", async () => {
    fetchMock.mockResolvedValue(json({ error: "limit" }, 403))
    const { unmount } = render(<AutoSaveGuide />)
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1))
    expect(toast.mock.calls[0][0].title).toMatch(/limit/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    unmount()

    render(<AutoSaveGuide />)
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem("previewContent")).not.toBeNull()
  })

  it("saves the preview, clears it and does not write dead keys", async () => {
    fetchMock.mockResolvedValue(json({ guide: { id: "g9" } }))
    render(<AutoSaveGuide />)
    await waitFor(() => expect(localStorage.getItem("previewContent")).toBeNull())
    expect(localStorage.getItem("savedGuideId")).toBeNull()
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ title: "Acme Style Guide", brand_name: "Acme", content_md: "## About\n\nText." })
    expect(toast).not.toHaveBeenCalled()
  })

  it("never saves a stale draft left by someone else (FE-9)", async () => {
    localStorage.setItem("draftCreatedAt", String(Date.now() - 25 * 60 * 60 * 1000))
    render(<AutoSaveGuide />)
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(localStorage.getItem("previewContent")).toBeNull()
  })

  it("does nothing without a stored preview", async () => {
    localStorage.removeItem("previewContent")
    render(<AutoSaveGuide />)
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
