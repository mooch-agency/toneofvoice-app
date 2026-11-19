import { canCreateGuide, effectiveTier, guideLimit, TIER_LIMITS, type Tier, type TierProfile } from "@/lib/tiers"

const PLAN_NAMES: Record<Tier, string> = { starter: "Starter", pro: "Pro", agency: "Agency" }

export interface PlanSummary {
  tier: Tier
  limit: number
  used: number
  atLimit: boolean
  label: string
}

/** Effective tier, guide limit and the "Pro plan — 1 of 2 guides" line for dashboard pages. */
export function planSummary(profile: TierProfile | null | undefined, used: number): PlanSummary {
  const tier = effectiveTier(profile)
  const limit = guideLimit(tier)
  const limitText = limit >= TIER_LIMITS.agency ? "unlimited" : String(limit)
  return {
    tier,
    limit,
    used,
    atLimit: !canCreateGuide(tier, used),
    label: `${PLAN_NAMES[tier]} plan — ${used} of ${limitText} guides`,
  }
}
