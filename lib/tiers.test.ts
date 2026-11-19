import { describe, expect, it } from "vitest"
import {
  TIER_LIMITS,
  canCreateGuide,
  effectiveTier,
  guideLimit,
  isPaidTier,
  isUnlocked,
  normalizeTier,
} from "./tiers"

describe("normalizeTier", () => {
  it.each([
    [undefined, "starter"],
    [null, "starter"],
    ["", "starter"],
    ["free", "starter"],
    ["starter", "starter"],
    ["pro", "pro"],
    ["agency", "agency"],
    ["team", "agency"],
    ["PRO", "pro"],
    ["enterprise", "starter"],
  ])("maps %s to %s", (input, expected) => {
    expect(normalizeTier(input as string | null | undefined)).toBe(expected)
  })
})

describe("effectiveTier", () => {
  it("keeps a paid tier while the subscription is active", () => {
    expect(effectiveTier({ subscription_tier: "pro", subscription_status: "active" })).toBe("pro")
  })

  it("keeps a paid tier when status is unknown (manual grants)", () => {
    expect(effectiveTier({ subscription_tier: "agency", subscription_status: null })).toBe("agency")
  })

  it.each(["inactive", "cancelled", "canceled", "past_due", "unpaid", "incomplete_expired"])(
    "drops a paid tier to starter when status is %s",
    (status) => {
      expect(effectiveTier({ subscription_tier: "agency", subscription_status: status })).toBe("starter")
    },
  )

  it("handles a missing profile", () => {
    expect(effectiveTier(null)).toBe("starter")
  })
})

describe("limits", () => {
  it("has one source of truth for guide limits", () => {
    expect(TIER_LIMITS).toEqual({ starter: 1, pro: 2, agency: 99 })
    expect(guideLimit("pro")).toBe(2)
  })

  it("canCreateGuide compares usage against the tier limit", () => {
    expect(canCreateGuide("starter", 0)).toBe(true)
    expect(canCreateGuide("starter", 1)).toBe(false)
    expect(canCreateGuide("pro", 1)).toBe(true)
    expect(canCreateGuide("pro", 2)).toBe(false)
    expect(canCreateGuide("agency", 98)).toBe(true)
  })

  it("isPaidTier is true only for pro and agency", () => {
    expect(isPaidTier("starter")).toBe(false)
    expect(isPaidTier("pro")).toBe(true)
    expect(isPaidTier("agency")).toBe(true)
  })
})

describe("isUnlocked", () => {
  it.each([
    ["starter", undefined, true],
    ["starter", "starter", true],
    ["starter", "pro", false],
    ["starter", "agency", false],
    ["pro", "pro", true],
    ["pro", "agency", false],
    ["agency", "pro", true],
    ["agency", "agency", true],
  ] as const)("tier %s, section minTier %s -> %s", (tier, minTier, expected) => {
    expect(isUnlocked(tier, minTier)).toBe(expected)
  })
})
