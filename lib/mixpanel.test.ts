import { beforeEach, describe, expect, it, vi } from "vitest"

const mp = vi.hoisted(() => ({ reset: vi.fn(), track: vi.fn(), __loaded: false as boolean | undefined }))
vi.mock("mixpanel-browser", () => ({ default: mp }))

import { reset } from "./mixpanel"

describe("mixpanel reset", () => {
  beforeEach(() => {
    mp.reset.mockReset()
  })

  it("resets the distinct id once Mixpanel is initialised", () => {
    mp.__loaded = true
    reset()
    expect(mp.reset).toHaveBeenCalledTimes(1)
  })

  it("does nothing (and does not throw) before init", () => {
    mp.__loaded = undefined
    expect(() => reset()).not.toThrow()
    expect(mp.reset).not.toHaveBeenCalled()
  })

  it("never throws when Mixpanel does", () => {
    mp.__loaded = true
    mp.reset.mockImplementation(() => {
      throw new Error("boom")
    })
    expect(() => reset()).not.toThrow()
  })
})
