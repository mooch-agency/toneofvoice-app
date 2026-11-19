import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const push = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

import { CreateGuideModal } from "./CreateGuideModal"

const DESC = "A family bakery in Leeds making sourdough"

describe("CreateGuideModal", () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    push.mockReset()
    fetchMock.mockReset()
    localStorage.clear()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("extracts, persists (clearing old traits) and navigates to the preview", async () => {
    localStorage.setItem("selectedTraits", JSON.stringify(["Old"]))
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, brandName: "Crumb", suggestedTraits: [] })),
    )
    const onOpenChange = vi.fn()
    render(<CreateGuideModal open onOpenChange={onOpenChange} />)
    await userEvent.type(screen.getByLabelText(/website url or brand description/i), DESC)
    await userEvent.click(screen.getByRole("button", { name: /generate/i }))

    await waitFor(() => expect(push).toHaveBeenCalledWith("/guide?generate=preview"), { timeout: 3000 })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ description: DESC })
    expect(localStorage.getItem("selectedTraits")).toBeNull()
    expect(JSON.parse(localStorage.getItem("brandDetails")!).name).toBe("Crumb")
  })

  it("shows the shared classified message on failure", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 429 }))
    render(<CreateGuideModal open onOpenChange={() => {}} />)
    await userEvent.type(screen.getByLabelText(/website url or brand description/i), DESC)
    await userEvent.click(screen.getByRole("button", { name: /generate/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/overloaded/i)
    expect(push).not.toHaveBeenCalled()
  })
})
