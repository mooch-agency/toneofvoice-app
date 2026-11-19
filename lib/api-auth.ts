import { NextResponse } from "next/server"
import type { SupabaseClient, User } from "@supabase/supabase-js"
import { createClient, MissingSupabaseConfigError } from "@/lib/supabase-server"
import { effectiveTier, isPaidTier, type Tier } from "@/lib/tiers"

export type AuthResult =
  | { ok: true; supabase: SupabaseClient; user: User; tier: Tier }
  | { ok: false; response: NextResponse }

interface RequireUserOptions {
  /** Load the profile and compute the effective tier (otherwise tier is "starter"). */
  withTier?: boolean
  /** Reject with 403 unless the effective tier is pro or agency. Implies withTier. */
  requirePaid?: boolean
}

/** Shared auth check for route handlers. Returns a ready-made error response on failure. */
export async function requireUser(opts: RequireUserOptions = {}): Promise<AuthResult> {
  const supabase = (await createClient()) as unknown as SupabaseClient
  const { data, error } = await supabase.auth.getUser()
  const user = data?.user
  if (error || !user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }

  let tier: Tier = "starter"
  if (opts.withTier || opts.requirePaid) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("subscription_tier, subscription_status")
      .eq("id", user.id)
      .single()
    tier = effectiveTier(profile)
  }

  if (opts.requirePaid && !isPaidTier(tier)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "A Pro or Agency subscription is required." },
        { status: 403 },
      ),
    }
  }

  return { ok: true, supabase, user, tier }
}

/** Wrap a handler so config and unexpected errors become safe, generic responses. */
export async function withRouteErrors(
  name: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler()
  } catch (e) {
    if (e instanceof MissingSupabaseConfigError) {
      return NextResponse.json({ error: "Service unavailable" }, { status: 503 })
    }
    console.error(`[${name}] Error:`, e)
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
  }
}

/** 429 response with a Retry-After header. */
export function tooManyRequests(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: "Too many requests. Please wait and try again." },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  )
}
