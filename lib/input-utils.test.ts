import { describe, expect, it } from "vitest"
import { detectInputType, validateInput } from "./input-utils"

describe("detectInputType", () => {
  it.each([
    "We build tools for node.js",
    "Visit acme.co today, we bake bread",
    "Acme is a bakery in London. Visit acme.co",
    "A shop in Leeds.uk",
  ])("treats text with spaces as a description: %s", (s) => {
    expect(detectInputType(s).inputType).toBe("description")
  })

  it.each(["acme.com", "https://acme.co.uk/about", "www.x.io", "acme.com/path?q=1", " acme.com "])(
    "detects url: %s",
    (s) => {
      expect(detectInputType(s).inputType).toBe("url")
    },
  )

  it("empty", () => expect(detectInputType("  ").inputType).toBe("empty"))

  it("lets a description ending in a domain-like word through validation", () => {
    const text = "We build tools for developers who use node.js"
    expect(validateInput(text)).toMatchObject({ isValid: true, inputType: "description" })
  })
})
