import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const replace = vi.fn()
const push = vi.fn()
const router = { replace, push, refresh: vi.fn() }
let params = new URLSearchParams()
const authState: { user: { id: string } | null; loading: boolean; signOut: () => Promise<void> } = {
  user: null,
  loading: false,
  signOut: async () => {},
}
const toastApi = { toast: vi.fn() }

vi.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => params }))
vi.mock("@/components/AuthProvider", () => ({ useAuth: () => authState }))
vi.mock("@/hooks/use-toast", () => ({ useToast: () => toastApi }))
vi.mock("@vercel/analytics", () => ({ track: vi.fn() }))
vi.mock("@/lib/mixpanel", () => ({ track: vi.fn() }))
vi.mock("@/lib/meta-pixel", () => ({ MetaPixel: { viewContent: vi.fn(), initiateCheckout: vi.fn() } }))
vi.mock("@/lib/fonts", () => ({ playfairDisplay: { variable: "font-display" } }))
vi.mock("@/lib/supabase-browser", () => ({ createClient: () => ({}) }))
vi.mock("@/components/editor/GuideEditor", () => ({
  GuideEditor: ({ onChange }: { onChange: (md: string) => void }) => (
    <button data-testid="editor" onClick={() => onChange("## About Acme\n\nEdited.")}>
      editor
    </button>
  ),
}))

import GuidePage from "./page"

const GUIDE = "## About Acme\n\nAbout text.\n\n## Style Rules\n\n_Unlock to see Style Rules._\n\n## Questions?\n\nAsk us."
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("/guide", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    replace.mockReset()
    params = new URLSearchParams()
    authState.user = null
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    )
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      }
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  it("redirects home when there is no guide id and no stored preview", async () => {
    render(<GuidePage />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("never calls the removed /api/generate-styleguide route", async () => {
    params = new URLSearchParams("generated=true")
    render(<GuidePage />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"))
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain("/api/generate-styleguide")
  })

  it("shows a cached preview from localStorage", async () => {
    localStorage.setItem("brandDetails", JSON.stringify({ name: "Acme" }))
    localStorage.setItem("previewContent", GUIDE)
    render(<GuidePage />)
    expect(await screen.findByRole("heading", { name: "About Acme" })).toBeInTheDocument()
    expect(screen.getByText("This section is locked")).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("loads a saved guide with the tier from the load response", async () => {
    authState.user = { id: "u1" }
    params = new URLSearchParams("guideId=g1")
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.startsWith("/api/load-style-guide")
          ? json({ id: "g1", content_md: GUIDE, brand_name: "Acme", plan_type: "core", subscription_tier: "pro" })
          : json({}, 404)
      )
    )
    render(<GuidePage />)
    expect(await screen.findByRole("button", { name: /generate full guide/i })).toBeInTheDocument()
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain("/api/user-subscription-tier")
  })

  it("offers Ask AI to signed-in starter users too, as an upgrade path", async () => {
    authState.user = { id: "u1" }
    params = new URLSearchParams("guideId=g1")
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.startsWith("/api/load-style-guide")
          ? json({ id: "g1", content_md: GUIDE, brand_name: "Acme", plan_type: "core", subscription_tier: "starter" })
          : json({}, 404)
      )
    )
    render(<GuidePage />)
    expect(await screen.findByText(/to rewrite any section instantly/)).toBeInTheDocument()
  })

  it("refreshes the draft timestamp when the preview is edited", async () => {
    localStorage.setItem("brandDetails", JSON.stringify({ name: "Acme" }))
    localStorage.setItem("previewContent", GUIDE)
    render(<GuidePage />)
    fireEvent.click(await screen.findByRole("button", { name: /edit guide/i }))
    localStorage.setItem("draftCreatedAt", "1") // loading the preview stamps it; isolate the edit
    fireEvent.click(await screen.findByTestId("editor"))
    await waitFor(() => expect(Number(localStorage.getItem("draftCreatedAt"))).toBeGreaterThan(1))
    expect(localStorage.getItem("previewContent")).toContain("Edited.")
  })

  it("makes the guide read-only while the full guide is generating", async () => {
    authState.user = { id: "u1" }
    params = new URLSearchParams("guideId=g1")
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("/api/load-style-guide")
        ? Promise.resolve(
            json({ id: "g1", content_md: GUIDE, brand_name: "Acme", plan_type: "core", subscription_tier: "pro" })
          )
        : url === "/api/expand-style-guide"
          ? new Promise(() => {})
          : Promise.resolve(json({}, 404))
    )
    render(<GuidePage />)
    fireEvent.click(await screen.findByRole("button", { name: /edit guide/i }))
    expect(await screen.findByTestId("editor")).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /generate full guide/i }))
    })
    expect(screen.getByRole("button", { name: /generating/i })).toBeDisabled()
    expect(screen.queryByTestId("editor")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^(edit guide|preview)$/i })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain("/api/save-style-guide")
  })
})
