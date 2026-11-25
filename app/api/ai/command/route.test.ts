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
  /** A mock LanguageModel, or null to run the real Anthropic provider against `fetch`. */
  model: null as unknown,
  fetch: null as unknown as typeof fetch,
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
vi.mock("@ai-sdk/anthropic", async (importActual) => {
  const actual = await importActual<typeof import("@ai-sdk/anthropic")>()
  return {
    createAnthropic: (settings: Parameters<typeof actual.createAnthropic>[0]) => (id: string) => {
      h.modelIds.push(id)
      return h.model ?? actual.createAnthropic({ ...settings, fetch: h.fetch })(id)
    },
  }
})

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
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test")
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

  it("503 when Anthropic is not configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "")
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
    expect(h.modelIds).toEqual(["claude-sonnet-5-5"])
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

/**
 * Wire-level checks: run the real @ai-sdk/anthropic provider with a fake fetch and
 * inspect the request bodies it sends. Claude Sonnet 5.5 returns 400 for forced
 * tool_choice, non-default temperature/top_p/top_k, `thinking: disabled` or
 * `budget_tokens`, and an assistant prefill, so every code path must avoid them.
 */
describe("POST /api/ai/command Anthropic requests", () => {
  type Body = Record<string, unknown> & {
    messages: { role: string }[]
    output_config?: { effort?: string; format?: { type: string } }
    stream?: boolean
  }
  let bodies: Body[] = []
  let betas: string[] = []

  const sse = (events: object[]) =>
    new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })

  /** Canned Claude reply: JSON when the request asks for structured output, prose otherwise. */
  function reply(body: Body): string {
    if (!body.output_config?.format) return "Claude text"
    const schema = JSON.stringify(body.output_config.format)
    if (schema.includes('"enum"')) return JSON.stringify({ result: "comment" })
    if (schema.includes("blockId")) return JSON.stringify({ elements: [{ blockId: "b1", comment: "Nice", content: "Hello" }] })
    return JSON.stringify({ elements: [{ id: "c1", content: "Updated" }] })
  }

  beforeEach(() => {
    bodies = []
    betas = []
    h.model = null
    h.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body
      bodies.push(body)
      betas.push(new Headers(init?.headers).get("anthropic-beta") ?? "")
      const text = reply(body)
      const usage = { input_tokens: 10, output_tokens: 5 }
      if (!body.stream) {
        return Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage,
        })
      }
      return sse([
        { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ])
    }) as typeof fetch
  })

  /** Every request must be safe for Claude Sonnet 5.5. */
  function expectSonnet55Safe() {
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) {
      expect(body.model).toBe("claude-sonnet-5-5")
      // 1. No forced tool choice, and no tools at all (no legacy forced "json" tool).
      expect(body.tool_choice).toBeUndefined()
      expect(body.tools).toBeUndefined()
      // 2. No sampling parameters.
      expect(body).not.toHaveProperty("temperature")
      expect(body).not.toHaveProperty("top_p")
      expect(body).not.toHaveProperty("top_k")
      // 3. No thinking config (no `disabled`, no `budget_tokens`): default adaptive thinking.
      expect(body).not.toHaveProperty("thinking")
      // 4. No assistant prefill: a single user turn.
      expect(body.messages.map((m) => m.role)).toEqual(["user"])
      expect(body.fallbacks).toBe("default")
    }
  }

  const tableDoc = [
    {
      type: "table",
      id: "t1",
      children: [
        {
          type: "tr",
          id: "r1",
          children: [
            { type: "td", id: "c1", children: [{ type: "p", id: "p1", children: [{ text: "Alpha" }] }] },
            { type: "td", id: "c2", children: [{ type: "p", id: "p2", children: [{ text: "Beta" }] }] },
          ],
        },
      ],
    },
  ]
  const editBody = (children: unknown, selection: unknown) =>
    validBody({ messages: [userMsg("Make it formal")], ctx: { children, selection, toolName: "edit" } })

  it("chooses the tool with native structured output at low effort", async () => {
    const res = await POST(req(validBody({ ctx: { children: doc, selection: null } })))
    const parts = chunks(await res.text())
    expect(parts).toContainEqual({ type: "data-toolName", data: "comment" })
    expect(bodies[0].stream).toBeFalsy()
    expect(bodies[0].output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } })
    expectSonnet55Safe()
  })

  it("generates text at medium effort", async () => {
    const parts = chunks(await (await POST(req(validBody()))).text())
    expect(parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")).toBe("Claude text")
    expect(bodies).toHaveLength(1)
    expect(bodies[0].output_config).toEqual({ effort: "medium" })
    expectSonnet55Safe()
  })

  it("edits a selection", async () => {
    const selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 5 } }
    const parts = chunks(await (await POST(req(editBody(doc, selection)))).text())
    expect(parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")).toBe("Claude text")
    expect(JSON.stringify(bodies[0].messages)).toContain("Make it formal")
    expectSonnet55Safe()
  })

  it("streams comments as structured output without a forced tool call", async () => {
    const res = await POST(req(validBody({ ctx: { children: doc, selection: null, toolName: "comment" } })))
    const parts = chunks(await res.text()).filter((p) => p.type === "data-comment")
    expect(parts.map((p) => p.data)).toEqual([
      { comment: { blockId: "b1", comment: "Nice", content: "Hello" }, status: "streaming" },
      { comment: null, status: "finished" },
    ])
    expect(bodies).toHaveLength(1)
    expect(bodies[0].output_config).toMatchObject({ effort: "medium", format: { type: "json_schema" } })
    expectSonnet55Safe()
  })

  it("streams multi-cell table edits as structured output", async () => {
    const selection = { anchor: { path: [0, 0, 0, 0, 0], offset: 0 }, focus: { path: [0, 0, 1, 0, 0], offset: 4 } }
    const parts = chunks(await (await POST(req(editBody(tableDoc, selection)))).text()).filter(
      (p) => p.type === "data-table",
    )
    expect(parts.map((p) => p.data)).toEqual([
      { cellUpdate: { id: "c1", content: "Updated" }, status: "streaming" },
      { cellUpdate: null, status: "finished" },
    ])
    expect(bodies[0].output_config).toMatchObject({ format: { type: "json_schema" } })
    expectSonnet55Safe()
  })
})
