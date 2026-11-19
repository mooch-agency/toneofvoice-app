import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DRAFT_MAX_AGE_MS,
  DRAFT_STAMP_KEY,
  readPendingDraft,
  savePendingDraft,
  stampDraft,
} from "./pending-draft"

const brand = { name: "Acme", brandDetailsDescription: "We make anvils." }

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-11-19T12:00:00Z"))
})
afterEach(() => vi.useRealTimers())

function seed({ stampedAgoMs }: { stampedAgoMs?: number } = {}) {
  localStorage.setItem("brandDetails", JSON.stringify(brand))
  localStorage.setItem("previewContent", "## About Acme\n\nText")
  if (stampedAgoMs !== undefined) {
    localStorage.setItem(DRAFT_STAMP_KEY, String(Date.now() - stampedAgoMs))
  }
}

describe("readPendingDraft", () => {
  it("returns null when nothing is stored", () => {
    expect(readPendingDraft()).toBeNull()
  })

  it("returns a fresh draft", () => {
    seed({ stampedAgoMs: 60_000 })
    expect(readPendingDraft()).toEqual({ brandDetails: brand, previewContent: "## About Acme\n\nText" })
  })

  it("ignores and clears a draft older than the max age (shared browsers, FE-9)", () => {
    seed({ stampedAgoMs: DRAFT_MAX_AGE_MS + 1 })
    expect(readPendingDraft()).toBeNull()
    expect(localStorage.getItem("previewContent")).toBeNull()
    expect(localStorage.getItem("brandDetails")).toBeNull()
  })

  it("ignores an unstamped draft", () => {
    seed()
    expect(readPendingDraft()).toBeNull()
  })

  it("ignores corrupt brand details", () => {
    seed({ stampedAgoMs: 0 })
    localStorage.setItem("brandDetails", "{not json")
    expect(readPendingDraft()).toBeNull()
  })
})

describe("stampDraft", () => {
  it("records the current time", () => {
    stampDraft()
    expect(localStorage.getItem(DRAFT_STAMP_KEY)).toBe(String(Date.now()))
  })
})

describe("savePendingDraft", () => {
  it("posts the draft and clears the preview on success", async () => {
    seed({ stampedAgoMs: 0 })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, guide: { id: "g1" } }), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const draft = readPendingDraft()!
    const result = await savePendingDraft(draft)
    expect(result).toEqual({ status: 200, guideId: "g1" })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ title: "Acme Style Guide", brand_name: "Acme", content_md: "## About Acme\n\nText" })
    expect(localStorage.getItem("previewContent")).toBeNull()
    expect(localStorage.getItem("savedGuideId")).toBeNull()
    vi.unstubAllGlobals()
  })

  it("keeps the preview when the save fails", async () => {
    seed({ stampedAgoMs: 0 })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })))
    const result = await savePendingDraft(readPendingDraft()!)
    expect(result).toEqual({ status: 403, guideId: undefined })
    expect(localStorage.getItem("previewContent")).not.toBeNull()
    vi.unstubAllGlobals()
  })
})
