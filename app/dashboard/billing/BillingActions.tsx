"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { isAbortError } from "@/lib/api-utils";
import { MetaPixel } from "@/lib/meta-pixel";
import { isPaidTier, normalizeTier, type Tier } from "@/lib/tiers";

type Plan = "pro" | "agency";

type Props = {
  hasCustomer: boolean;
  /** The user's effective tier. */
  tier: string;
  plan?: Plan;
  compact?: boolean;
  /** Optional class for the primary CTA (e.g. tier-themed button on billing cards). */
  buttonClass?: string;
};

const TIER_RANK: Record<Tier, number> = { starter: 0, pro: 1, agency: 2 };

/**
 * POST to a billing endpoint and follow the Stripe URL it returns. A 409 from
 * create-subscription-session carries `manageUrl` (billing portal), which is
 * followed too, so a second subscription is never created.
 */
async function goToStripe(endpoint: string, body?: unknown) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error("Your session expired. Please sign in again.");
  const data = (await res.json().catch(() => ({}))) as { url?: string; manageUrl?: string; error?: string };
  const target = data.url ?? (res.status === 409 ? data.manageUrl : undefined);
  if (!target) throw new Error(data.error || "Please try again in a few minutes.");
  window.location.href = target;
}

export function BillingActions({ hasCustomer, tier: rawTier, plan, compact, buttonClass }: Props) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const tier = normalizeTier(rawTier);
  const size = compact ? "sm" : "default";

  const run = async (title: string, action: () => Promise<void>) => {
    setLoading(true);
    try {
      await action();
    } catch (e) {
      setLoading(false);
      if (isAbortError(e)) return;
      toast({
        title,
        description: e instanceof Error ? e.message : "Please try again in a few minutes.",
        variant: "destructive",
      });
    }
  };

  const handleManage = () => run("Could not open billing", () => goToStripe("/api/create-portal-session"));

  const handleSubscribe = (p: Plan) =>
    run("Something went wrong", async () => {
      MetaPixel.initiateCheckout(p);
      await goToStripe("/api/create-subscription-session", { plan: p });
    });

  const spinner = <Loader2 className="h-4 w-4 animate-spin" />;

  // Main billing section: Manage in Stripe
  if (!plan) {
    return hasCustomer ? (
      <Button onClick={handleManage} disabled={loading} size={size} className={buttonClass}>
        {loading ? spinner : "Manage in Stripe"}
      </Button>
    ) : null;
  }

  if (tier === plan) {
    return hasCustomer ? (
      <Button onClick={handleManage} disabled={loading} size={size} variant="outline" className={compact ? undefined : buttonClass}>
        {loading ? spinner : "Manage"}
      </Button>
    ) : null;
  }

  if (TIER_RANK[plan] <= TIER_RANK[tier]) return null;

  // Paying customers change plan in the Stripe portal (prorated, same subscription).
  const upgradeInPortal = isPaidTier(tier) && hasCustomer;
  const label = plan === "pro" ? "Get Pro" : upgradeInPortal ? "Upgrade to Agency" : "Get Agency";
  return (
    <Button
      onClick={upgradeInPortal ? handleManage : () => handleSubscribe(plan)}
      disabled={loading}
      size={size}
      className={buttonClass}
    >
      {loading ? spinner : label}
    </Button>
  );
}
