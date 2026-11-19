import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildBrandDetails,
  classifyExtractionError,
  persistExtraction,
  requestExtraction,
} from "./extraction"

describe("persistExtraction", () => {
  beforeEach(() => localStorage.clear())

  it("clears the previous brand's traits and keywords when none are suggested (FE-8)", () => {
    localStorage.setItem("selectedTraits", JSON.stringify(["Bold", "Witty", "Warm"]))
    localStorage.setItem("suggestedTraits", JSON.stringify(["Bold"]))
    localStorage.setItem("brandKeywords", "old")
    persistExtraction({ success: true, brandName: "Globex", suggestedTraits: [] })
    expect(localStorage.getItem("selectedTraits")).toBeNull()
    expect(localStorage.getItem("brandKeywords")).toBeNull()
    expect(JSON.parse(localStorage.getItem("brandDetails")!).name).toBe("Globex")
  })

  it("stores suggested traits, auto-selects first three, and stores keywords", () => {
    persistExtraction({
      success: true,
      brandName: "Acme",
      suggestedTraits: ["A", "B", "C", "D"],
      keywords: "x, y\nz",
    })
    expect(JSON.parse(localStorage.getItem("suggestedTraits")!)).toEqual(["A", "B", "C", "D"])
    expect(JSON.parse(localStorage.getItem("selectedTraits")!)).toEqual(["A", "B", "C"])
    expect(localStorage.getItem("brandKeywords")).toBe("x\ny\nz")
  })
})

describe("buildBrandDetails", () => {
  it("maps response fields with defaults", () => {
    const d = buildBrandDetails({ success: true, brandName: "Acme", url: "https://acme.com", productsServices: ["a"] })
    expect(d).toMatchObject({
      name: "Acme",
      websiteUrl: "https://acme.com",
      audience: "",
      englishVariant: "american",
      productsServices: ["a"],
    })
  })
})

describe("classifyExtractionError", () => {
  it("timeouts", () => {
    expect(classifyExtractionError(Object.assign(new Error("x"), { name: "AbortError" })).type).toBe("TIMEOUT")
  })
  it("network", () => {
    expect(classifyExtractionError(new TypeError("Failed to fetch")).type).toBe("NETWORK")
  })
  it("rate limit by status", () => {
    expect(classifyExtractionError({}, { status: 429 } as Response).type).toBe("RATE_LIMIT")
  })
  it("server error by status", () => {
    expect(classifyExtractionError({}, { status: 503 } as Response).type).toBe("SERVER")
  })
  it("unknown fallback never leaks raw text", () => {
    const r = classifyExtractionError({ error: "weird internal thing" })
    expect(r.type).toBe("UNKNOWN")
    expect(r.message).not.toContain("weird")
  })
})

describe("requestExtraction", () => {
  const input = (inputType: "url" | "description", cleanInput: string) => ({
    isValid: true as const,
    inputType,
    cleanInput,
  })

  it("posts url or description body and returns data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, brandName: "A" })))
    const r = await requestExtraction(input("url", "https://a.com"), fetchMock)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ url: "https://a.com" })
    expect(r).toMatchObject({ ok: true, data: { brandName: "A" } })
    await requestExtraction(input("description", "a bakery in town"), fetchMock)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ description: "a bakery in town" })
  })

  it("returns classified error for success:false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 429 }))
    const r = await requestExtraction(input("url", "https://a.com"), fetchMock)
    expect(r).toMatchObject({ ok: false, error: { type: "RATE_LIMIT" } })
  })

  it("returns classified error when fetch throws or body is not JSON", async () => {
    const r1 = await requestExtraction(input("url", "https://a.com"), vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))
    expect(r1).toMatchObject({ ok: false, error: { type: "NETWORK" } })
    const r2 = await requestExtraction(input("url", "https://a.com"), vi.fn().mockResolvedValue(new Response("<html>")))
    expect(r2.ok).toBe(false)
  })
})
