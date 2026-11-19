// @vitest-environment node
import { describe, expect, it } from "vitest"
import { extractJson, parseJsonResponse, stripOuterFence } from "./llm-json"

describe("stripOuterFence", () => {
  it("unwraps a fence around the whole response", () => {
    expect(stripOuterFence("```markdown\n# A\n```")).toBe("# A")
    expect(stripOuterFence("```json\n{\"a\":1}\n```")).toBe('{"a":1}')
    expect(stripOuterFence("  ```\nplain\n```  ")).toBe("plain")
  })

  it("leaves inner fences alone (AI-27)", () => {
    const text = "Use this:\n```js\nconst a = 1\n```\nDone"
    expect(stripOuterFence(text)).toBe(text)
    expect(stripOuterFence("x\n```js\ny\n```")).toBe("x\n```js\ny\n```")
  })

  it("trims plain text", () => {
    expect(stripOuterFence("  hi \n")).toBe("hi")
  })
})

describe("extractJson", () => {
  it("parses clean JSON", () => {
    expect(extractJson('{"a":[1,2]}')).toEqual({ a: [1, 2] })
    expect(extractJson('["A","B"]')).toEqual(["A", "B"])
  })

  it("skips leading prose that contains brackets", () => {
    expect(extractJson('ok [see]:\n["A"]')).toEqual(["A"])
    expect(extractJson('Sure! [see below]:\n["Warm", "Direct"]')).toEqual(["Warm", "Direct"])
  })

  it("ignores trailing text after the JSON value", () => {
    expect(extractJson('{"a":1}\nHope this helps!')).toEqual({ a: 1 })
  })

  it("handles brackets inside strings", () => {
    expect(extractJson('{"a":"x ] } y","b":"\\"q\\""}')).toEqual({ a: "x ] } y", b: '"q"' })
  })

  it("returns undefined for truncated JSON instead of throwing", () => {
    expect(extractJson('{"keywords": ["a", "b"')).toBeUndefined()
    expect(extractJson("no json here")).toBeUndefined()
    expect(extractJson("")).toBeUndefined()
  })

  it("is linear on large truncated input", () => {
    const big = "[" + Array.from({ length: 20000 }, (_, i) => `"item-${i}"`).join(",")
    const garbage = "[".repeat(200_000)
    const start = performance.now()
    expect(extractJson(big)).toBeUndefined()
    expect(extractJson(garbage)).toBeUndefined()
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe("parseJsonResponse", () => {
  it("strips a json fence and parses", () => {
    expect(parseJsonResponse('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } })
  })

  it("reports invalid JSON as a failure", () => {
    const result = parseJsonResponse("{bad")
    expect(result.ok).toBe(false)
  })
})
