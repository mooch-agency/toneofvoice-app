import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Keep-alive cron. A scheduled request that touches Postgres so Supabase
// doesn't auto-pause the project after 7 days of inactivity. Scheduled
// Mondays and Thursdays in vercel.json, which keeps the largest gap between
// hits to about 3 to 4 days. Guarded by CRON_SECRET: Vercel Cron sends it as
// a Bearer token automatically.

export const dynamic = "force-dynamic";

function secretMatches(provided: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !provided) return false;
  if (provided.length !== secret.length) return false;
  let mismatch = 0;
  for (let i = 0; i < provided.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return mismatch === 0;
}

function extractSecret(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  return req.headers.get("x-cron-secret");
}

export async function GET(req: Request): Promise<Response> {
  if (!secretMatches(extractSecret(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // auth.users always exists, so the ping never depends on an app table.
    const admin = getSupabaseAdmin();
    const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) {
      console.error("[keep-alive] Ping failed:", error);
      return NextResponse.json({ ok: false, error: "Database ping failed" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, ts: new Date().toISOString() });
  } catch (err) {
    console.error("[keep-alive] Error:", err);
    return NextResponse.json({ ok: false, error: "Keep-alive failed" }, { status: 500 });
  }
}
