import { expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { TIER_LIMITS } from "@/lib/tiers"
import { UpgradeNudgeModal } from "./UpgradeNudgeModal"

it("shows the Pro guide limit from lib/tiers (SEC-12)", () => {
  render(<UpgradeNudgeModal open onOpenChange={() => {}} used={1} limit={1} />)
  expect(screen.getByText(`Pro: ${TIER_LIMITS.pro} guides`)).toBeInTheDocument()
  expect(screen.queryByText(/Pro: 5 guides/)).not.toBeInTheDocument()
})

it("tells the user how many guides they have used", () => {
  render(<UpgradeNudgeModal open onOpenChange={() => {}} used={2} limit={2} />)
  expect(screen.getByText(/2 of 2 guides/)).toBeInTheDocument()
})
