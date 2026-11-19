// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  ctor: vi.fn(),
  wrap: vi.fn((client: unknown) => ({ wrapped: client })),
}))

vi.mock("openai", () => ({
  OpenAI: class {
    opts: unknown
    constructor(opts: unknown) {
      h.ctor(opts)
      this.opts = opts
    }
  },
}))
vi.mock("langsmith/wrappers", () => ({ wrapOpenAI: h.wrap }))

beforeEach(() => {
  vi.resetModules()
  h.ctor.mockClear()
  h.wrap.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("getOpenAIClient", () => {
  it("does nothing at import time", async () => {
    vi.stubEnv("OPENAI_API_KEY", "")
    await import("./langsmith-openai")
    expect(h.ctor).not.toHaveBeenCalled()
  })

  it("creates one client with a timeout and SDK retries, then reuses it", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test")
    vi.stubEnv("LANGSMITH_TRACING", "")
    const { getOpenAIClient } = await import("./langsmith-openai")
    const a = getOpenAIClient()
    const b = getOpenAIClient()
    expect(a).toBe(b)
    expect(h.ctor).toHaveBeenCalledTimes(1)
    expect(h.ctor).toHaveBeenCalledWith({ apiKey: "sk-test", timeout: 60_000, maxRetries: 2 })
    expect(h.wrap).not.toHaveBeenCalled()
  })

  it("wraps the client with LangSmith when tracing is configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test")
    vi.stubEnv("LANGSMITH_TRACING", "true")
    vi.stubEnv("LANGSMITH_API_KEY", "ls-key")
    const { getOpenAIClient } = await import("./langsmith-openai")
    expect(getOpenAIClient()).toHaveProperty("wrapped")
  })

  it("throws a config error when the key is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "")
    const { getOpenAIClient, MissingOpenAIKeyError } = await import("./langsmith-openai")
    expect(() => getOpenAIClient()).toThrow(MissingOpenAIKeyError)
  })

  it("does not log configuration", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test")
    const log = vi.spyOn(console, "log")
    const { getOpenAIClient } = await import("./langsmith-openai")
    getOpenAIClient()
    expect(log).not.toHaveBeenCalled()
  })
})
