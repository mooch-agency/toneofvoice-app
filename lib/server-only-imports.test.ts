// @vitest-environment node
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// These modules hold secrets or reach internal services. `import "server-only"`
// makes an accidental import from a client component fail the build.
const SERVER_ONLY = [
  "lib/supabase-admin.ts",
  "lib/pdf-chrome.ts",
  "lib/url-validation.ts",
  "lib/cheerio-site-scraper.ts",
]

describe("server-only modules", () => {
  it.each(SERVER_ONLY)("%s imports server-only", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8")
    expect(source).toMatch(/^import "server-only"$/m)
  })
})
