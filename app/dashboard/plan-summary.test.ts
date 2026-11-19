// @vitest-environment node
import { describe, expect, it } from "vitest"
import { planSummary } from "./plan-summary"

describe("planSummary", () => {
  it("starter has a limit of 1 (billing page used to say 0)", () => {
    expect(planSummary({ subscription_tier: "free" }, 1)).toEqual({
      tier: "starter",
      limit: 1,
      used: 1,
      atLimit: true,
      label: "Starter plan — 1 of 1 guides",
    })
  })

  it("pro shows its real limit", () => {
    expect(planSummary({ subscription_tier: "pro", subscription_status: "active" }, 1).label).toBe(
      "Pro plan — 1 of 2 guides",
    )
  })

  it("agency shows unlimited", () => {
    expect(planSummary({ subscription_tier: "agency", subscription_status: "active" }, 3).label).toBe(
      "Agency plan — 3 of unlimited guides",
    )
  })

  it("a lapsed paid plan is shown as starter", () => {
    expect(planSummary({ subscription_tier: "pro", subscription_status: "past_due" }, 0).tier).toBe("starter")
  })

  it("handles a missing profile", () => {
    expect(planSummary(null, 0)).toMatchObject({ tier: "starter", limit: 1, atLimit: false })
  })
})
