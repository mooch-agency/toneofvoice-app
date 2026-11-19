import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ refresh: vi.fn(), toast: vi.fn(), clearAutoSaveBlocks: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }) }))
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }))
vi.mock("./AutoSaveGuide", () => ({ clearAutoSaveBlocks: h.clearAutoSaveBlocks }))

import { GuideCard } from "./GuideCard"

describe("GuideCard delete", () => {
  beforeEach(() => {
    h.refresh.mockReset()
    h.clearAutoSaveBlocks.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  async function deleteGuide(status: number) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })))
    render(<GuideCard id="g1" title="Acme Style Guide" updatedAt={new Date().toISOString()} />)
    await userEvent.click(screen.getByRole("button", { name: "Delete guide" }))
    await userEvent.click(screen.getByRole("button", { name: "Delete" }))
  }

  it("frees the guide-limit save block after a delete, so a waiting draft can be saved", async () => {
    await deleteGuide(200)
    await waitFor(() => expect(h.refresh).toHaveBeenCalled())
    expect(h.clearAutoSaveBlocks).toHaveBeenCalledTimes(1)
  })

  it("keeps the block when the delete fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    await deleteGuide(500)
    await waitFor(() => expect(h.toast).toHaveBeenCalled())
    expect(h.clearAutoSaveBlocks).not.toHaveBeenCalled()
  })
})
