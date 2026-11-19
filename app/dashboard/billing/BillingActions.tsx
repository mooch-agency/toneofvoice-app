"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { isAbortError } from "@/lib/api-utils";
import { PRICING_TIERS } from "@/lib/landing-data";
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
const PLAN_NAME: Record<Plan, string> = { pro: "Pro", agency: "Agency" };

/** Returned when create-subscription-session says the user should upgrade in place. */
const UPGRADE = "upgrade" as const;

/**
 * POST to a billing endpoint and follow the Stripe URL it returns. A 409 from
 * create-subscription-session carries either `manageUrl` (billing portal),
 * which is followed, or `upgrade: true`, which is returned so the caller can
 * offer the in-app upgrade. A second subscription is never created.
 */
async function goToStripe(endpoint: string, body?: unknown): Promise<typeof UPGRADE | void> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error("Your session expired. Please sign in again.");
  const data = (await res.json().catch(() => ({}))) as {
    url?: string;
    manageUrl?: string;
    upgrade?: boolean;
    error?: string;
  };
  if (res.status === 409 && data.upgrade) return UPGRADE;
  const target = data.url ?? (res.status === 409 ? data.manageUrl : undefined);
  if (!target) throw new Error(data.error || "Please try again in a few minutes.");
  window.location.href = target;
}

/** Upgrade the existing subscription in place; the server charges the prorated difference. */
async function changePlan(plan: Plan) {
  const res = await fetch("/api/change-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
  });
  if (res.status === 401) throw new Error("Your session expired. Please sign in again.");
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
  if (!res.ok || !data.success) throw new Error(data.error || "Please try again in a few minutes.");
}

function priceLabel(plan: Plan): string | undefined {
  return PRICING_TIERS.find((t) => t.id === plan)?.priceLabel;
}

export function BillingActions({ hasCustomer, tier: rawTier, plan, compact, buttonClass }: Props) {
  const [loading, setLoading] = useState(false);
  const [confirmPlan, setConfirmPlan] = useState<Plan | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
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

  const handleManage = () =>
    run("Could not open billing", async () => {
      await goToStripe("/api/create-portal-session");
    });

  const handleSubscribe = (p: Plan) =>
    run("Something went wrong", async () => {
      MetaPixel.initiateCheckout(p);
      if ((await goToStripe("/api/create-subscription-session", { plan: p })) === UPGRADE) {
        setLoading(false);
        setConfirmPlan(p);
      }
    });

  const handleConfirmUpgrade = async () => {
    if (!confirmPlan) return;
    setUpgrading(true);
    try {
      await changePlan(confirmPlan);
      setConfirmPlan(null);
      toast({ title: `You're on ${PLAN_NAME[confirmPlan]} now`, description: "Your plan was upgraded." });
      router.refresh();
    } catch (e) {
      toast({
        title: "Upgrade failed",
        description: e instanceof Error && !isAbortError(e) ? e.message : "Please try again in a few minutes.",
        variant: "destructive",
      });
    } finally {
      setUpgrading(false);
    }
  };

  const spinner = <Loader2 className="h-4 w-4 animate-spin" />;

  const confirmDialog = confirmPlan && (
    <Dialog open onOpenChange={(open) => !open && !upgrading && setConfirmPlan(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upgrade to {PLAN_NAME[confirmPlan]}?</DialogTitle>
          <DialogDescription>
            Your current subscription switches to {PLAN_NAME[confirmPlan]} right away. We&apos;ll charge the
            prorated difference for the rest of this billing period to your card on file today
            {priceLabel(confirmPlan) ? `, then ${priceLabel(confirmPlan)}/month from your next billing date` : ""}.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => setConfirmPlan(null)} disabled={upgrading}>
            Cancel
          </Button>
          <Button onClick={handleConfirmUpgrade} disabled={upgrading}>
            {upgrading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Confirm upgrade
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

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

  // Downgrades are done under Manage (billing portal).
  if (TIER_RANK[plan] <= TIER_RANK[tier]) return null;

  // Paying customers upgrade their existing subscription in-app (prorated, same subscription).
  const upgradeInApp = isPaidTier(tier) && hasCustomer;
  const label = plan === "pro" ? "Get Pro" : upgradeInApp ? "Upgrade to Agency" : "Get Agency";
  return (
    <>
      <Button
        onClick={upgradeInApp ? () => setConfirmPlan(plan) : () => handleSubscribe(plan)}
        disabled={loading || upgrading}
        size={size}
        className={buttonClass}
      >
        {loading ? spinner : label}
      </Button>
      {confirmDialog}
    </>
  );
}
