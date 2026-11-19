"use client";

// Fires CompleteRegistration for Google OAuth sign-ups.
// The Purchase event fires in SubscriptionRefresh, once the server has verified the checkout.
import { useEffect } from "react";
import { MetaPixel } from "@/lib/meta-pixel";
import { createClient } from "@/lib/supabase-browser";

export function MetaPixelPurchase() {
  // Handle Google OAuth sign-up: check for flag set on the sign-up page
  useEffect(() => {
    const pending = localStorage.getItem("meta_pixel_pending");
    if (pending !== "complete_registration") return;

    // Clear immediately to prevent double-fire if dashboard mounts twice
    localStorage.removeItem("meta_pixel_pending");

    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      const createdAt = data.user?.created_at;
      if (!createdAt) return;
      // Only fire for accounts created in the last 10 minutes - guards against
      // returning users who hit /sign-up and clicked "Continue with Google"
      const ageMs = Date.now() - new Date(createdAt).getTime();
      if (ageMs < 10 * 60 * 1000) {
        MetaPixel.completeRegistration();
        MetaPixel.lead();
      }
    });
  }, []); // run once on mount

  return null;
}
