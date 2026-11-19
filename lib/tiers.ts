/**
 * Single source of truth for subscription tiers and guide limits.
 * Used by API routes (enforcement) and UI (copy), so numbers never drift.
 */

export type Tier = "starter" | "pro" | "agency"

export const TIER_LIMITS: Record<Tier, number> = {
  starter: 1,
  pro: 2,
  agency: 99,
}

/** Subscription statuses that mean the user is no longer paying. */
const LAPSED_STATUSES = new Set([
  "inactive",
  "cancelled",
  "canceled",
  "past_due",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
])

/** Map any stored tier value (including legacy "free"/"team") to a known tier. */
export function normalizeTier(raw: string | null | undefined): Tier {
  const t = (raw ?? "").toLowerCase()
  if (t === "pro") return "pro"
  if (t === "agency" || t === "team") return "agency"
  return "starter"
}

export interface TierProfile {
  subscription_tier?: string | null
  subscription_status?: string | null
}

/**
 * The tier a user can actually use right now. A paid tier with a lapsed
 * subscription status counts as starter. Unknown/empty status keeps the tier
 * so manually granted accounts keep working.
 */
export function effectiveTier(profile: TierProfile | null | undefined): Tier {
  const tier = normalizeTier(profile?.subscription_tier)
  if (tier === "starter") return tier
  const status = (profile?.subscription_status ?? "").toLowerCase()
  return LAPSED_STATUSES.has(status) ? "starter" : tier
}

export function isPaidTier(tier: Tier): boolean {
  return tier === "pro" || tier === "agency"
}

export function guideLimit(tier: Tier): number {
  return TIER_LIMITS[tier]
}

export function canCreateGuide(tier: Tier, used: number): boolean {
  return used < guideLimit(tier)
}

const TIER_RANK: Record<Tier, number> = { starter: 0, pro: 1, agency: 2 }

/** Whether a user on `tier` can see content gated at `minTier` (default: open to all). */
export function isUnlocked(tier: Tier, minTier?: Tier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[minTier ?? "starter"]
}
