// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { simulateReadableStream } from "ai"
import { MockLanguageModelV2 } from "ai/test"

type CallOptions = Parameters<MockLanguageModelV2["doStream"]>[0]
type StreamPart =
  Awaited<ReturnType<MockLanguageModelV2["doStream"]>>["stream"] extends ReadableStream<infer P> ? P : never

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  profile: vi.fn(),
  modelIds: [] as string[],
  model: null as unknown,
}))

vi.mock("@/lib/supabase-server", () => ({
  createClient: async () => ({
    auth: { getUser: h.getUser },
    from: () => ({ select: () => ({ eq: () => ({ single: h.profile }) }) }),
  }),
  MissingSupabaseConfigError: class extends Error {},
}))
// @platejs/math imports katex CSS, which Node cannot load outside the Next bundler.
vi.mock("@/components/editor/plugins/math-base-kit", () => ({ BaseMathKit: [] }))
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => (id: string) => {
    h.modelIds.push(id)
    return h.model
  },
}))

import { resetRateLimits } from "@/lib/rate-limit"
import { MAX_MESSAGE_CHARS, MAX_MESSAGES } from "./input"
import { POST } from "./route"

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

function stream(parts: StreamPart[]) {
  return { stream: simulateReadableStream({ chunks: parts }) }
}

function textStream(text: string) {
  return stream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage },
  ])
}

let promptsSeen: string[] = []

function mockModel() {
  return new MockLanguageModelV2({
    doStream: async (options: CallOptions) => {
      promptsSeen.push(JSON.stringify(options.prompt))
      if (options.tools?.some((t) => t.name === "comment") && options.toolChoice?.type === "tool") {
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "c1", toolName: "comment", input: "{}" },
          { type: "finish", finishReason: "tool-calls", usage },
        ])
      }
      if (options.responseFormat?.type === "json") {
        return textStream(JSON.stringify({ elements: [{ blockId: "b1", comment: "Nice", content: "Hello" }] }))
      }
      return textStream("Generated text")
    },
  })
}

const doc = [{ type: "p", id: "b1", children: [{ text: "Hello world" }] }]
const userMsg = (text: string, id = text.slice(0, 20)) => ({ id, role: "user", parts: [{ type: "text", text }] })

function req(body: unknown) {
  return new Request("http://localhost/api/ai/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

/** Parse the SSE body into its JSON chunks. */
function chunks(body: string): { type: string; data?: unknown; delta?: string }[] {
  return body
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)))
}

const validBody = (overrides: Record<string, unknown> = {}) => ({
  messages: [userMsg("Write an intro")],
  ctx: { children: doc, selection: null, toolName: "generate" },
  ...overrides,
})

beforeEach(() => {
  resetRateLimits()
  promptsSeen = []
  h.modelIds.length = 0
  h.model = mockModel()
  vi.stubEnv("OPENAI_API_KEY", "sk-test")
  vi.spyOn(console, "error").mockImplementation(() => {})
  h.getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null })
  h.profile.mockResolvedValue({ data: { subscription_tier: "pro", subscription_status: "active" } })
})

afterEach(() => vi.unstubAllEnvs())

describe("POST /api/ai/command access", () => {
  it("401 without a session", async () => {
    h.getUser.mockResolvedValue({ data: { user: null }, error: null })
    expect((await POST(req(validBody()))).status).toBe(401)
    expect(h.modelIds).toEqual([])
  })

  it.each([
    ["starter", { subscription_tier: "starter" }],
    ["lapsed pro", { subscription_tier: "pro", subscription_status: "past_due" }],
  ])("403 for a %s user", async (_label, profile) => {
    h.profile.mockResolvedValue({ data: profile })
    expect((await POST(req(validBody()))).status).toBe(403)
    expect(h.modelIds).toEqual([])
  })

  it("503 when OpenAI is not configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "")
    expect((await POST(req(validBody()))).status).toBe(503)
  })

  it("rate limits per user", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) statuses.push((await POST(req(validBody()))).status)
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true)
    expect(statuses[30]).toBe(429)
  })
})

describe("POST /api/ai/command input", () => {
  it("ignores a client-supplied model", async () => {
    const res = await POST(req(validBody({ model: "o1-pro" })))
    expect(res.status).toBe(200)
    await res.text()
    expect(h.modelIds).toEqual(["gpt-5-mini"])
  })

  it.each([
    ["malformed JSON", "{nope"],
    ["messages not an array", validBody({ messages: "hi" })],
    ["a message without parts", validBody({ messages: [{ id: "1", role: "user" }] })],
    ["children not an array", validBody({ ctx: { children: "x", selection: null } })],
    ["a malformed selection", validBody({ ctx: { children: doc, selection: { anchor: 1 } } })],
    ["an unknown toolName", validBody({ ctx: { children: doc, selection: null, toolName: "shell" } })],
  ])("400 for %s", async (_label, body) => {
    expect((await POST(req(body))).status).toBe(400)
    expect(h.modelIds).toEqual([])
  })

  it("413 when the messages are too long", async () => {
    const res = await POST(req(validBody({ messages: [userMsg("x".repeat(MAX_MESSAGE_CHARS + 1))] })))
    expect(res.status).toBe(413)
  })

  it("413 when the document is too large", async () => {
    const children = Array.from({ length: 20_000 }, (_, i) => ({ type: "p", children: [{ text: `para ${i}` }] }))
    expect((await POST(req(validBody({ ctx: { children, selection: null, toolName: "generate" } })))).status).toBe(413)
  })

  it(`only sends the last ${MAX_MESSAGES} messages to the model`, async () => {
    const messages = Array.from({ length: 15 }, (_, i) => userMsg(`message-${String(i).padStart(2, "0")}`))
    const res = await POST(req(validBody({ messages })))
    await res.text()
    const prompt = promptsSeen.join("\n")
    expect(prompt).toContain("message-14")
    expect(prompt).toContain(`message-${String(15 - MAX_MESSAGES).padStart(2, "0")}`)
    expect(prompt).not.toContain(`message-${String(14 - MAX_MESSAGES).padStart(2, "0")}`)
  })
})

describe("POST /api/ai/command streaming", () => {
  it("streams the tool name and generated text", async () => {
    const res = await POST(req(validBody()))
    const parts = chunks(await res.text())
    expect(parts).toContainEqual({ type: "data-toolName", data: "generate" })
    expect(parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")).toBe("Generated text")
  })

  it("streams typed data-comment parts for the comment tool", async () => {
    const res = await POST(req(validBody({ ctx: { children: doc, selection: null, toolName: "comment" } })))
    const parts = chunks(await res.text()).filter((p) => p.type === "data-comment")
    expect(parts.at(-1)?.data).toEqual({ comment: null, status: "finished" })
    expect(parts).toContainEqual(
      expect.objectContaining({
        data: { comment: { blockId: "b1", comment: "Nice", content: "Hello" }, status: "streaming" },
      }),
    )
  })
})
