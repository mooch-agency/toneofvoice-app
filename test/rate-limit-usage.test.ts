// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return routes(p)
    return name === "route.ts" ? [p] : []
  })
}

// Every limited route must share counters across server instances.
describe("API rate limiting", () => {
  it.each(routes(join(process.cwd(), "app/api")).map((p) => p.replace(process.cwd() + "/", "")))(
    "%s does not use the per-instance limiter directly",
    (file) => {
      const source = readFileSync(join(process.cwd(), file), "utf8")
      expect(source).not.toMatch(/\brateLimit\(/)
    },
  )
})
