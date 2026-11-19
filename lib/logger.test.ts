// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import Logger from "./logger"

afterEach(() => {
  vi.unstubAllEnvs()
})

function lastEntry(spy: { mock: { calls: unknown[][] } }) {
  const calls = spy.mock.calls
  return JSON.parse(String(calls[calls.length - 1][0]))
}

describe("Logger", () => {
  it("serialises Error objects", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    Logger.error("boom", new Error("bad thing"), { id: 1 })
    const entry = lastEntry(spy)
    expect(entry).toMatchObject({ level: "error", message: "boom", details: { id: 1 } })
    expect(entry.error).toMatchObject({ name: "Error", message: "bad thing" })
  })

  it("accepts non-Error values (catch clauses give unknown)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    Logger.error("boom", "plain string")
    expect(lastEntry(spy).error).toMatchObject({ message: "plain string" })
  })

  it("writes one line per entry", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    Logger.info("hello", { a: 1 })
    expect(String(spy.mock.calls[0][0])).not.toContain("\n")
  })

  it("skips debug logs in production", () => {
    vi.stubEnv("NODE_ENV", "production")
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    Logger.debug("hidden")
    expect(spy).not.toHaveBeenCalled()
  })
})
