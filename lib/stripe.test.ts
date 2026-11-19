// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type Stripe from "stripe"
import { fakeSupabase, type FakeHandler } from "@/supabase/testing/fake-client"

const h = vi.hoisted(() => ({
  StripeCtor: vi.fn(),
  admin: null as unknown,
}))

vi.mock("stripe", () => ({
  default: function Stripe(this: unknown, ...args: unknown[]) {
    h.StripeCtor(...args)
    return { marker: args[0] }
  },
}))
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: () => h.admin }))

import {
  STRIPE_API_VERSION,
  StripeNotConfiguredError,
  applySubscriptionToProfile,
  getStripe,
  planToPriceId,
  priceIdToPlan,
  profileUpdateFromSubscription,
  subscriptionPeriodEnd,
} from "./stripe"

const ENV_KEYS = [
  "STRIPE_MODE",
  "STRIPE_SECRET_KEY",
  "STRIPE_TEST_SECRET_KEY",
  "STRIPE_PRO_PRICE_ID",
  "STRIPE_AGENCY_PRICE_ID",
  "STRIPE_TEST_PRO_PRICE_ID",
  "STRIPE_TEST_AGENCY_PRICE_ID",
]
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  h.StripeCtor.mockReset()
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function sub(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    items: { data: [{ price: { id: "price_pro" }, current_period_end: 1_900_000_000 }] },
    ...overrides,
  } as unknown as Stripe.Subscription
}

describe("getStripe", () => {
  it("does not construct a client at import time", () => {
    expect(h.StripeCtor).not.toHaveBeenCalled()
  })

  it("throws a typed error when the key is missing", () => {
    expect(() => getStripe()).toThrow(StripeNotConfiguredError)
  })

  it("uses the test key in test mode with the pinned API version, and caches", () => {
    process.env.STRIPE_MODE = "test"
    process.env.STRIPE_TEST_SECRET_KEY = "sk_test_x"
    const a = getStripe()
    const b = getStripe()
    expect(a).toBe(b)
    expect(h.StripeCtor).toHaveBeenCalledTimes(1)
    expect(h.StripeCtor).toHaveBeenCalledWith("sk_test_x", { apiVersion: STRIPE_API_VERSION })
  })

  it("pins the SDK's own API version", () => {
    expect(STRIPE_API_VERSION).toBe("2025-03-31.basil")
  })
})

describe("price mapping", () => {
  it("maps live price ids both ways", () => {
    process.env.STRIPE_PRO_PRICE_ID = "price_pro"
    process.env.STRIPE_AGENCY_PRICE_ID = "price_agency"
    expect(planToPriceId("pro")).toBe("price_pro")
    expect(priceIdToPlan("price_agency")).toBe("agency")
    expect(priceIdToPlan("price_other")).toBeNull()
  })

  it("uses test price ids in test mode", () => {
    process.env.STRIPE_MODE = "test"
    process.env.STRIPE_PRO_PRICE_ID = "price_live_pro"
    process.env.STRIPE_TEST_PRO_PRICE_ID = "price_test_pro"
    expect(priceIdToPlan("price_test_pro")).toBe("pro")
    expect(priceIdToPlan("price_live_pro")).toBeNull()
  })

  it("never matches a missing price id against a missing env var", () => {
    expect(priceIdToPlan(undefined)).toBeNull()
    expect(planToPriceId("pro")).toBeNull()
  })
})

describe("subscriptionPeriodEnd", () => {
  it("reads the period end from the first item (API 2025-03-31+)", () => {
    expect(subscriptionPeriodEnd(sub())).toBe(new Date(1_900_000_000 * 1000).toISOString())
  })

  it("falls back to the legacy top-level field", () => {
    const s = sub({ items: { data: [{ price: { id: "p" } }] }, current_period_end: 1_800_000_000 })
    expect(subscriptionPeriodEnd(s)).toBe(new Date(1_800_000_000 * 1000).toISOString())
  })

  it("returns null when neither is present", () => {
    expect(subscriptionPeriodEnd(sub({ items: { data: [] } }))).toBeNull()
  })
})

describe("profileUpdateFromSubscription", () => {
  beforeEach(() => {
    process.env.STRIPE_PRO_PRICE_ID = "price_pro"
    process.env.STRIPE_AGENCY_PRICE_ID = "price_agency"
  })

  it("active pro subscription -> pro tier, active, pro limit", () => {
    const u = profileUpdateFromSubscription(sub())
    expect(u).toMatchObject({
      subscription_tier: "pro",
      subscription_status: "active",
      guides_limit: 2,
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
    })
    expect(u.current_period_end).toBeTruthy()
  })

  it("trialing counts as active", () => {
    expect(profileUpdateFromSubscription(sub({ status: "trialing" })).subscription_status).toBe("active")
  })

  it.each(["past_due", "unpaid", "incomplete", "paused"])(
    "%s marks the subscription inactive so the effective tier is starter",
    (status) => {
      const u = profileUpdateFromSubscription(sub({ status }))
      expect(u.subscription_status).toBe("inactive")
      expect(u.guides_limit).toBe(1)
    },
  )

  it("canceled -> starter tier and the single 'cancelled' spelling", () => {
    const u = profileUpdateFromSubscription(sub({ status: "canceled" }))
    expect(u.subscription_tier).toBe("starter")
    expect(u.subscription_status).toBe("cancelled")
    expect(u.guides_limit).toBe(1)
  })

  it("unknown price leaves the tier and limit untouched", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const u = profileUpdateFromSubscription(
      sub({ items: { data: [{ price: { id: "price_legacy" }, current_period_end: 1 }] } }),
    )
    expect(u).not.toHaveProperty("subscription_tier")
    expect(u).not.toHaveProperty("guides_limit")
    expect(u.subscription_status).toBe("active")
    expect(err).toHaveBeenCalled()
  })

  it("accepts an expanded customer object", () => {
    const u = profileUpdateFromSubscription(sub({ customer: { id: "cus_9" } }))
    expect(u.stripe_customer_id).toBe("cus_9")
  })
})

describe("applySubscriptionToProfile", () => {
  function useAdmin(handler: FakeHandler) {
    const fake = fakeSupabase(handler)
    h.admin = fake.client
    return fake
  }

  beforeEach(() => {
    process.env.STRIPE_PRO_PRICE_ID = "price_pro"
  })

  it("updates the profile by user id", async () => {
    const fake = useAdmin(() => ({ data: [{ id: "u1" }] }))
    const result = await applySubscriptionToProfile({ userId: "u1" }, sub())
    expect(result.plan).toBe("pro")
    expect(fake.queries[0]).toMatchObject({ table: "profiles", op: "update", filters: { id: "u1" } })
  })

  it("updates the profile by subscription id", async () => {
    const fake = useAdmin(() => ({ data: [{ id: "u1" }] }))
    await applySubscriptionToProfile({ subscriptionId: "sub_1" }, sub())
    expect(fake.queries[0].filters).toEqual({ stripe_subscription_id: "sub_1" })
  })

  it("throws when no row was updated", async () => {
    useAdmin(() => ({ data: [] }))
    await expect(applySubscriptionToProfile({ userId: "u1" }, sub())).rejects.toThrow(/no profile/i)
  })

  it("throws when the database returns an error", async () => {
    useAdmin(() => ({ error: { message: "boom" } }))
    await expect(applySubscriptionToProfile({ userId: "u1" }, sub())).rejects.toThrow()
  })
})
