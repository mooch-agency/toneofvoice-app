import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"

const mp = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  stop_session_recording: vi.fn(),
  get_config: vi.fn(),
}))
vi.mock("mixpanel-browser", () => ({ default: mp }))

import { MixpanelProvider } from "./MixpanelProvider"

describe("MixpanelProvider", () => {
  beforeEach(() => {
    Object.values(mp).forEach((f) => f.mockReset())
    vi.stubEnv("NEXT_PUBLIC_MIXPANEL_TOKEN", "tok")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("masks all text and inputs in session replay (FE-19)", () => {
    render(<MixpanelProvider>x</MixpanelProvider>)
    expect(mp.init).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({ record_mask_all_text: true, record_mask_all_inputs: true }),
    )
  })

  it("does not log its config to the console", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    render(<MixpanelProvider>x</MixpanelProvider>)
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })
})
