/**
 * Chrome/Chromium launch options and request policy for server-side PDF export.
 * Local dev: uses system Chrome (set CHROME_EXECUTABLE_PATH to override). Vercel: uses @sparticuz/chromium.
 */
import "server-only"
import puppeteer from "puppeteer-core"
import chromium from "@sparticuz/chromium"

export function getDefaultChromePath(): string {
  const platform = process.platform
  if (platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  }
  if (platform === "win32") {
    return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  }
  return "/usr/bin/google-chrome"
}

export async function getChromeLaunchOptions(): Promise<{
  executablePath: string
  args: string[]
  headless: boolean | "shell"
}> {
  // Use system Chrome when not on Vercel (avoids ENOEXEC from @sparticuz/chromium on macOS).
  const useLocal =
    process.env.VERCEL !== "1" ||
    process.env.CHROME_EXECUTABLE_PATH ||
    process.env.PDF_USE_LOCAL_CHROME === "true"

  if (useLocal) {
    const path = process.env.CHROME_EXECUTABLE_PATH || getDefaultChromePath()
    return {
      executablePath: path,
      args: puppeteer.defaultArgs().filter((a) => a !== "--headless" && !a.startsWith("--headless=")),
      headless: true,
    }
  }
  const executablePath = await chromium.executablePath()
  return {
    executablePath,
    args: puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
    headless: "shell" as const,
  }
}

/** Request body cap for /api/export-pdf (html + css JSON). */
export const MAX_PDF_BODY_BYTES = 2 * 1024 * 1024

const ALLOWED_FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"])

/**
 * Requests the PDF renderer may make: inline data, the blank page and Google
 * Fonts over https. Everything else (internal hosts, metadata endpoints, file:)
 * is aborted, so attacker HTML cannot pull private content into the PDF.
 */
export function isAllowedPdfRequest(rawUrl: string): boolean {
  if (rawUrl === "about:blank" || rawUrl.startsWith("data:")) return true
  try {
    const url = new URL(rawUrl)
    return url.protocol === "https:" && url.port === "" && ALLOWED_FONT_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}
