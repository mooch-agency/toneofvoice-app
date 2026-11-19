import { act, render, renderHook, waitFor } from "@testing-library/react"
import { createElement, useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const authState: { user: { id: string } | null; loading: boolean } = { user: { id: "u1" }, loading: false }
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => authState }))

import { useGuide, useScrollSpy } from "./use-guide"

const tierResponse = (tier: string) => new Response(JSON.stringify({ subscription_tier: tier }), { status: 200 })

describe("useGuide subscription tier", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    authState.user = { id: "u1" }
    fetchMock = vi.fn().mockImplementation(() => Promise.resolve(tierResponse("pro")))
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("fetches the tier again on every mount (no module cache)", async () => {
    const first = renderHook(() => useGuide())
    await waitFor(() => expect(first.result.current.subscriptionTier).toBe("pro"))
    first.unmount()

    const second = renderHook(() => useGuide())
    await waitFor(() => expect(second.result.current.subscriptionTier).toBe("pro"))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith("/api/user-subscription-tier", expect.anything())
  })

  it("normalizes legacy tiers", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(tierResponse("free")))
    const { result } = renderHook(() => useGuide())
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(result.current.subscriptionTier).toBe("starter")
  })

  it("does not fetch when the tier comes from elsewhere (saved guide load)", async () => {
    renderHook(() => useGuide({ fetchTier: false }))
    await act(async () => {})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("stays starter for signed-out users", async () => {
    authState.user = null
    const { result } = renderHook(() => useGuide())
    await act(async () => {})
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.subscriptionTier).toBe("starter")
  })

  it("uses lib/tiers for isUnlocked", async () => {
    const { result } = renderHook(() => useGuide())
    await waitFor(() => expect(result.current.subscriptionTier).toBe("pro"))
    expect(result.current.isUnlocked("pro")).toBe(true)
    expect(result.current.isUnlocked("agency")).toBe(false)
  })
})

describe("useGuide content changes", () => {
  beforeEach(() => {
    authState.user = null
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => vi.unstubAllGlobals())

  it("routes 'Add section' through onContentChange, before Questions?", () => {
    const onContentChange = vi.fn()
    const { result } = renderHook(() => useGuide({ onContentChange }))
    act(() => result.current.setContent("## About\n\nText.\n\n## Questions?\n\nAsk."))
    act(() => result.current.handleAddSection("Social"))

    expect(onContentChange).toHaveBeenCalledTimes(1)
    const md = onContentChange.mock.calls[0][0] as string
    expect(md.indexOf("## Social")).toBeGreaterThan(-1)
    expect(md.indexOf("## Social")).toBeLessThan(md.indexOf("## Questions?"))
    expect(result.current.content).toBe(md)
  })

  it("updateContent sets content and notifies once", () => {
    const onContentChange = vi.fn()
    const { result } = renderHook(() => useGuide({ onContentChange }))
    act(() => result.current.updateContent("## About\n\nEdited."))
    expect(result.current.content).toBe("## About\n\nEdited.")
    expect(onContentChange).toHaveBeenCalledWith("## About\n\nEdited.")
  })
})

describe("useScrollSpy", () => {
  let observed: Set<Element>
  let instances: { callback: IntersectionObserverCallback }[]

  beforeEach(() => {
    observed = new Set()
    instances = []
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        callback: IntersectionObserverCallback
        constructor(cb: IntersectionObserverCallback) {
          this.callback = cb
          instances.push(this)
        }
        observe(el: Element) {
          observed.add(el)
        }
        unobserve(el: Element) {
          observed.delete(el)
        }
        disconnect() {
          observed.clear()
        }
      },
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  const IDS = ["cover", "about"]
  function Spy({ version }: { version: number }) {
    const ref = useRef<HTMLDivElement>(null)
    const { activeSectionId } = useScrollSpy(IDS, ref)
    // Same ids, new DOM nodes on every version (edit/preview switch, expand remount).
    return createElement(
      "div",
      { ref },
      createElement(
        "div",
        { key: version },
        IDS.map((id) => createElement("section", { key: id, id }, id)),
      ),
      createElement("output", null, activeSectionId),
    )
  }

  const current = () => IDS.map((id) => document.getElementById(id)!)

  it("observes the section elements", () => {
    render(createElement(Spy, { version: 0 }))
    expect([...observed]).toEqual(current())
  })

  it("re-observes when the sections are re-rendered with the same ids", async () => {
    const { rerender, container } = render(createElement(Spy, { version: 0 }))
    rerender(createElement(Spy, { version: 1 }))
    await waitFor(() => expect([...observed]).toEqual(current()))
    expect([...observed].every((el) => el.isConnected)).toBe(true)

    // The highlight still follows the new nodes.
    const about = document.getElementById("about")!
    act(() => {
      instances.at(-1)!.callback(
        [{ isIntersecting: true, target: about } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
    })
    expect(container.querySelector("output")!.textContent).toBe("about")
  })
})
