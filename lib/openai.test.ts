// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  create: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock("./langsmith-openai", () => ({
  getOpenAIClient: h.getClient,
}))

import {
  beforeAfterToMarkdown,
  generateAudienceSection,
  generateBeforeAfterSamples,
  generateBrandVoiceTraits,
  generateKeywords,
  generateStyleRules,
  generateTraitSuggestions,
  generateWithOpenAI,
  generateWordList,
  wordListToMarkdown,
} from "./openai"
import { ALLOWED_RULE_CATEGORIES } from "./rules-schema"

function resp(content: string | null, finish_reason = "stop") {
  return { choices: [{ message: { content }, finish_reason }], usage: { total_tokens: 10 } }
}

const brand = {
  name: "Acme",
  brandDetailsDescription: "We make rockets.",
  audience: "engineers",
  traits: ["Warm", { name: "Direct" }],
  keywords: ["rockets"],
  productsServices: ["Launch kits"],
}

const allRules = ALLOWED_RULE_CATEGORIES.map((c) => ({
  category: c,
  title: c,
  description: `Rule for ${c}.`,
  examples: { good: "Good.", bad: "Bad." },
}))

beforeEach(() => {
  h.create.mockReset()
  h.getClient.mockReset()
  h.getClient.mockReturnValue({ chat: { completions: { create: h.create } } })
})

const lastRequest = () => h.create.mock.calls[h.create.mock.calls.length - 1][0]

describe("generateWithOpenAI", () => {
  it("uses JSON mode and GPT-5 parameters for JSON calls", async () => {
    h.create.mockResolvedValueOnce(resp('{"name":"Acme"}'))
    const result = await generateWithOpenAI("p", "s", "json", 500, "gpt-5.2", "none")
    expect(result).toEqual({ success: true, content: '{"name":"Acme"}' })
    const req = lastRequest()
    expect(req.response_format).toEqual({ type: "json_object" })
    expect(req.max_completion_tokens).toBe(500)
    expect(req.reasoning_effort).toBe("none")
    expect(req).not.toHaveProperty("temperature")
    expect(req.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "p" },
    ])
  })

  it("uses max_tokens and temperature for older models", async () => {
    h.create.mockResolvedValueOnce(resp("hello"))
    await generateWithOpenAI("p", "s", "markdown", 300, "gpt-4o")
    const req = lastRequest()
    expect(req.max_tokens).toBe(300)
    expect(req.temperature).toBe(0.4)
    expect(req).not.toHaveProperty("reasoning_effort")
    expect(req).not.toHaveProperty("response_format")
  })

  it("extracts JSON wrapped in a fence or prose", async () => {
    h.create.mockResolvedValueOnce(resp('Sure [ok]:\n```json\n{"a":[1]}\n```'))
    expect(await generateWithOpenAI("p", "s", "json")).toEqual({ success: true, content: '{"a":[1]}' })
  })

  it("treats finish_reason=length as failure and retries once with a bigger budget", async () => {
    h.create.mockResolvedValueOnce(resp('{"a":', "length")).mockResolvedValueOnce(resp('{"a":1}'))
    const result = await generateWithOpenAI("p", "s", "json", 400)
    expect(result.success).toBe(true)
    expect(h.create).toHaveBeenCalledTimes(2)
    expect(h.create.mock.calls[1][0].max_completion_tokens).toBe(800)
  })

  it("fails when the output is truncated twice", async () => {
    h.create.mockResolvedValue(resp("Primary audience is", "length"))
    const result = await generateWithOpenAI("p", "s", "markdown", 400)
    expect(result.success).toBe(false)
    expect(h.create).toHaveBeenCalledTimes(2)
  })

  it("retries once when JSON is invalid", async () => {
    h.create.mockResolvedValueOnce(resp("{bad")).mockResolvedValueOnce(resp('{"ok":true}'))
    expect(await generateWithOpenAI("p", "s", "json")).toEqual({ success: true, content: '{"ok":true}' })
    expect(h.create).toHaveBeenCalledTimes(2)
  })

  it("does not retry transport errors itself (the SDK does, with backoff)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.create.mockRejectedValue(Object.assign(new Error("Rate limited"), { status: 429 }))
    const result = await generateWithOpenAI("p", "s", "json")
    expect(result.success).toBe(false)
    expect(h.create).toHaveBeenCalledTimes(1)
  })

  it("returns a failure instead of throwing when OpenAI is not configured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.getClient.mockImplementation(() => {
      throw new Error("OPENAI_API_KEY is not set")
    })
    const result = await generateWithOpenAI("p", "s", "json")
    expect(result.success).toBe(false)
  })

  it("passes the abort signal to the SDK and stops when it has fired", async () => {
    const controller = new AbortController()
    h.create.mockResolvedValueOnce(resp("text"))
    await generateWithOpenAI("p", "s", "markdown", 100, "gpt-5.2", "low", { signal: controller.signal })
    expect(h.create.mock.calls[0][1]).toEqual({ signal: controller.signal })

    controller.abort()
    h.create.mockClear()
    const result = await generateWithOpenAI("p", "s", "markdown", 100, "gpt-5.2", "low", { signal: controller.signal })
    expect(result.success).toBe(false)
    expect(h.create).not.toHaveBeenCalled()
  })

  it("strips only an outer fence from markdown (AI-27)", async () => {
    h.create.mockResolvedValueOnce(resp("Use this:\n```js\nconst a = 1\n```\nDone"))
    expect((await generateWithOpenAI("p", "s", "markdown")).content).toBe("Use this:\n```js\nconst a = 1\n```\nDone")
    h.create.mockResolvedValueOnce(resp("```markdown\n# A\n```"))
    expect((await generateWithOpenAI("p", "s", "markdown")).content).toBe("# A")
  })

  it("does not print token usage or prompts to stdout (AI-23)", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const log = vi.spyOn(console, "log")
    h.create.mockResolvedValueOnce(resp("hi"))
    await generateWithOpenAI("secret prompt a@b.co", "s", "markdown")
    expect(log).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})

describe("generateKeywords", () => {
  it("returns cleaned, deduped keywords as JSON", async () => {
    h.create.mockResolvedValueOnce(resp('{"keywords":[" rockets ","Rockets","launch",3,""]}'))
    const result = await generateKeywords({ name: "Acme", brandDetailsDescription: "x" })
    expect(JSON.parse(result.content!)).toEqual({ keywords: ["rockets", "launch"] })
    expect(lastRequest().response_format).toEqual({ type: "json_object" })
  })

  it("retries once and fails on persistently invalid output", async () => {
    h.create.mockResolvedValue(resp('{"keywords": ["a", "b"'))
    const result = await generateKeywords({ name: "Acme", brandDetailsDescription: "x" })
    expect(result.success).toBe(false)
    expect(h.create).toHaveBeenCalledTimes(2)
  })
})

describe("generateTraitSuggestions (AI-25)", () => {
  it("returns only allowed traits, as a JSON array", async () => {
    h.create.mockResolvedValueOnce(resp('{"traits":["warm","Professional","Witty"]}'))
    const result = await generateTraitSuggestions({ name: "Acme", brandDetailsDescription: "x", audience: "y" })
    expect(result).toEqual({ success: true, content: '["Warm","Witty"]' })
  })

  it("only shows allowed traits in the prompt example", async () => {
    h.create.mockResolvedValueOnce(resp('{"traits":["Warm"]}'))
    await generateTraitSuggestions({ name: "Acme", brandDetailsDescription: "x" })
    const prompt: string = lastRequest().messages[1].content
    expect(prompt).not.toContain("Professional")
  })

  it("retries when no suggestion is allowed", async () => {
    h.create.mockResolvedValueOnce(resp('{"traits":["Professional"]}')).mockResolvedValueOnce(resp('["Direct"]'))
    const result = await generateTraitSuggestions({ name: "Acme" })
    expect(result.content).toBe('["Direct"]')
    expect(h.create).toHaveBeenCalledTimes(2)
  })
})

describe("generateWordList", () => {
  it("retries when JSON is invalid", async () => {
    h.create
      .mockResolvedValueOnce(resp("{bad"))
      .mockResolvedValueOnce(resp('{"preferredTerms":[],"avoidTerms":["x"],"spellingUsage":[]}'))
    const result = await generateWordList(brand)
    expect(result.success).toBe(true)
    expect(h.create).toHaveBeenCalledTimes(2)
  })

  it("fails when every list is empty", async () => {
    h.create.mockResolvedValue(resp('{"preferredTerms":[],"avoidTerms":[],"spellingUsage":[]}'))
    expect((await generateWordList(brand)).success).toBe(false)
  })
})

describe("wordListToMarkdown", () => {
  it("renders tables, escapes pipes and omits empty subsections", () => {
    const md = wordListToMarkdown({
      preferredTerms: [{ use: "launch | lift-off", insteadOf: "start" }, "rocket not missile"],
      avoidTerms: ["synergy"],
      spellingUsage: [],
    })
    expect(md).toBe(
      [
        "### Preferred Terms",
        "",
        "| Use | Instead of |",
        "|-----|------------|",
        "| launch \\| lift-off | start |",
        "| rocket | missile |",
        "",
        "### Avoid Terms",
        "",
        "| Avoid |",
        "|-------|",
        "| synergy |",
      ].join("\n"),
    )
  })

  it("returns an empty string when there is nothing to show", () => {
    expect(wordListToMarkdown({ preferredTerms: [null, 3], avoidTerms: [""], spellingUsage: [] })).toBe("")
  })
})

describe("beforeAfterToMarkdown", () => {
  it("renders at most 5 examples with content-type fallbacks", () => {
    const examples = Array.from({ length: 7 }, (_, i) => ({ before: `b${i}`, after: `a${i}`, contentType: i === 0 ? "Hero" : "" }))
    const md = beforeAfterToMarkdown(examples)
    expect(md.match(/^### /gm)).toHaveLength(5)
    expect(md).toContain("### Hero\n\n**Before:** b0\n\n**After:** a0")
    expect(md).toContain("### Email Subject Line")
  })

  it("skips examples without before or after text", () => {
    expect(beforeAfterToMarkdown([{ before: "x" }, null, { before: "b", after: "a" }])).toBe(
      "### Homepage Headline\n\n**Before:** b\n\n**After:** a",
    )
  })
})

describe("generateBeforeAfterSamples", () => {
  it("returns markdown and retries when no example is usable", async () => {
    h.create
      .mockResolvedValueOnce(resp('{"examples":[]}'))
      .mockResolvedValueOnce(resp('{"examples":[{"contentType":"Hero","before":"b","after":"a"}]}'))
    const result = await generateBeforeAfterSamples(brand, "traits")
    expect(result.content).toBe("### Hero\n\n**Before:** b\n\n**After:** a")
    expect(lastRequest().messages[1].content).toContain("Launch kits")
  })
})

describe("generateStyleRules", () => {
  it("renders 25 validated rules from a JSON object", async () => {
    h.create.mockResolvedValueOnce(resp(JSON.stringify({ rules: allRules })))
    const result = await generateStyleRules(brand, "Selected Traits: Warm")
    expect(result.success).toBe(true)
    expect(result.content!.match(/^### \d+\. /gm)).toHaveLength(25)
    expect(result.content).not.toMatch(/^## /m)
    const prompt: string = lastRequest().messages[1].content
    expect(prompt).toContain("Selected Traits: Warm, Direct")
  })

  it("makes at most two calls when too few rules are valid", async () => {
    h.create.mockResolvedValue(resp(JSON.stringify({ rules: allRules.slice(0, 5) })))
    const result = await generateStyleRules(brand)
    expect(result.success).toBe(false)
    expect(h.create).toHaveBeenCalledTimes(2)
  })
})

describe("generateBrandVoiceTraits", () => {
  it("fails without calling OpenAI when there are no traits", async () => {
    const result = await generateBrandVoiceTraits({ ...brand, traits: [] })
    expect(result.success).toBe(false)
    expect(h.create).not.toHaveBeenCalled()
  })

  it("asks for every trait in one call and returns formatted markdown", async () => {
    h.create.mockResolvedValueOnce(resp("## Warm\n***What It Means***\n→Be kind"))
    const result = await generateBrandVoiceTraits(brand)
    expect(result.content).toBe("### Warm\n\n#### What It Means\n\n→ Be kind")
    const prompt: string = lastRequest().messages[1].content
    expect(prompt).toContain("1. Warm\n2. Direct")
  })
})

describe("generateAudienceSection", () => {
  it("normalises the markdown", async () => {
    h.create.mockResolvedValueOnce(resp("## Overview\n\n\n\nThey build things.  "))
    expect((await generateAudienceSection(brand)).content).toBe("### Overview\n\nThey build things.")
  })

  it("does not return a truncated section as success", async () => {
    h.create.mockResolvedValue(resp("### Overview\nThey", "length"))
    expect((await generateAudienceSection(brand)).success).toBe(false)
  })
})
