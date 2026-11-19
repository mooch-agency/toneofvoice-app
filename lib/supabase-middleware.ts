import { createServerClient } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

export interface SessionResult {
  /** Pass-through response that carries any refreshed auth cookies. */
  response: NextResponse;
  user: User | null;
}

/** Refresh the auth session for a page request. Always returns { response, user }. */
export async function updateSession(request: NextRequest): Promise<SessionResult> {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return { response, user: null };

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // Refresh session - required to keep user logged in
  try {
    const { data } = await supabase.auth.getUser();
    return { response, user: data?.user ?? null };
  } catch (error) {
    console.error("[proxy] Session refresh failed:", error);
    return { response, user: null };
  }
}
