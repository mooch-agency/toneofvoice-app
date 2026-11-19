// @vitest-environment node
import { describe, expect, it } from "vitest"
import { TRAIT_NAMES, TRAITS, canonicalTraitName, parseTraitSuggestions, traitNames } from "./traits"

describe("TRAIT_NAMES", () => {
  it("lists every predefined trait", () => {
    expect([...TRAIT_NAMES].sort()).toEqual(Object.keys(TRAITS).sort())
  })
})

describe("canonicalTraitName", () => {
  it("matches case-insensitively and trims", () => {
    expect(canonicalTraitName(" warm ")).toBe("Warm")
    expect(canonicalTraitName("PLAYFUL")).toBe("Playful")
    expect(canonicalTraitName("Professional")).toBeNull()
  })
})

describe("parseTraitSuggestions (AI-25)", () => {
  it("keeps only allowed traits with canonical case", () => {
    expect(parseTraitSuggestions('["warm","Professional","Witty"]')).toEqual(["Warm", "Witty"])
  })

  it("accepts an object with a traits array", () => {
    expect(parseTraitSuggestions({ traits: ["Direct", "direct", "Refined", "Inclusive"] })).toEqual([
      "Direct",
      "Refined",
      "Inclusive",
    ])
  })

  it("returns [] for anything else", () => {
    expect(parseTraitSuggestions("nope")).toEqual([])
    expect(parseTraitSuggestions({ traits: "Warm" })).toEqual([])
    expect(parseTraitSuggestions([1, null, {}])).toEqual([])
  })
})

describe("traitNames (SIMP-16)", () => {
  it("reads names from strings and trait objects", () => {
    expect(traitNames(["Warm", { name: "Bold Move", isCustom: true }, { type: "predefined", name: "Direct" }])).toEqual([
      "Warm",
      "Bold Move",
      "Direct",
    ])
  })

  it("drops empty and malformed entries", () => {
    expect(traitNames(["", "  ", null, 5, { name: 3 }, " Warm "])).toEqual(["Warm"])
    expect(traitNames(undefined)).toEqual([])
  })
})
