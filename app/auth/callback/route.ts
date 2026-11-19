import { createClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { classifyAuthError } from "@/lib/auth-errors";
import { safeRedirectPath } from "@/lib/safe-redirect";

/** Handles OAuth redirects and email confirmation code exchange. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Default to /auth/claim so pending localStorage guides get saved before dashboard renders.
  // Only same-site paths are accepted, so `next` cannot send the user to another origin.
  const next = safeRedirectPath(searchParams.get("next"), "/auth/claim");
  const errorParam = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, origin));
  const redirectToError = (message: string) =>
    redirectTo(`/auth/error?message=${encodeURIComponent(message)}`);

  // Handle OAuth provider errors
  if (errorParam) {
    console.error("[auth/callback] OAuth error:", errorParam, errorDescription);
    return redirectToError(classifyAuthError({ message: errorDescription || errorParam }).message);
  }

  if (!code) return redirectToError("Missing authentication code");

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return redirectTo(next);

    const errorDetails = classifyAuthError(error);
    console.error(
      "[auth/callback] exchangeCodeForSession error:",
      errorDetails.type,
      errorDetails.message
    );
    return redirectToError(errorDetails.message);
  } catch (error) {
    console.error("[auth/callback] Unexpected error:", error);
    return redirectToError(classifyAuthError(error).message);
  }
}
