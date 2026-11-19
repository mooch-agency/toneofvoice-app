import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase-middleware";

const PROTECTED_PREFIXES = ["/dashboard"];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Next 16 proxy (formerly middleware): refreshes the Supabase session and guards /dashboard. */
export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request);

  if (!user && isProtected(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    url.searchParams.set("redirectTo", request.nextUrl.pathname);
    const redirect = NextResponse.redirect(url);
    // Keep any cookies Supabase refreshed or cleared while checking the session.
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    return redirect;
  }

  return response;
}

export const config = {
  // Pages only: API routes do their own auth, and static assets need no session.
  matcher: [
    "/((?!api(?:/|$)|_next/static|_next/image|pdf-styles|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest|woff2?|css|js|map)$).*)",
  ],
};
