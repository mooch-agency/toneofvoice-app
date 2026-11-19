/**
 * Return `path` only if it is a same-site relative path; otherwise `fallback`.
 * Blocks open redirects such as "@evil.com", "//evil.com", "/\evil.com" and
 * absolute URLs, which browsers would treat as another origin.
 */
export function safeRedirectPath(
  path: string | null | undefined,
  fallback = "/dashboard",
): string {
  if (typeof path !== "string" || path.length === 0) return fallback
  if (!path.startsWith("/")) return fallback
  if (path.startsWith("//") || path.startsWith("/\\")) return fallback
  if (path.includes("@")) return fallback

  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return fallback
  }
  if (decoded.startsWith("//") || decoded.startsWith("/\\") || decoded.includes("@")) return fallback

  try {
    const base = "https://same-origin.invalid"
    if (new URL(path, base).origin !== base) return fallback
  } catch {
    return fallback
  }
  return path
}
