import { describe, expect, it } from "vitest"
import { MIN_PASSWORD_LENGTH, validatePassword } from "./password"

describe("validatePassword", () => {
  it("requires at least 8 characters", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8)
    expect(validatePassword("1234567")).toBe("Password must be at least 8 characters long.")
    expect(validatePassword("")).toBe("Password must be at least 8 characters long.")
  })
  it("returns null when valid", () => {
    expect(validatePassword("12345678")).toBeNull()
  })
})
