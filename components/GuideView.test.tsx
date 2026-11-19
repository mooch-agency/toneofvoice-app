import { render, screen } from "@testing-library/react"
import { createRef } from "react"
import { describe, expect, it, vi } from "vitest"
import { parseStyleGuideContent } from "@/lib/content-parser"
import { isUnlocked as tierUnlocked, type Tier } from "@/lib/tiers"

vi.mock("@/lib/fonts", () => ({ playfairDisplay: { variable: "font-display" } }))

// Stub editor: shows its markdown and immediately reports it back unchanged.
vi.mock("@/components/editor/GuideEditor", () => ({
  GuideEditor: ({ markdown, onChange }: { markdown: string; onChange?: (md: string) => void }) => {
    onChange?.(markdown)
    return <pre data-testid="editor">{markdown}</pre>
  },
}))

import { GuideView, type GuideViewProps } from "./GuideView"

const CONTENT = [
  "## About Acme", "", "About text.", "",
  "## Brand Voice", "", "Voice text.", "",
  "## Style Rules", "", "Rules text.", "",
  "## Word List", "", "Words text.", "",
  "## AI Writing Cleanup", "", "Cleanup text.", "",
  "## Questions?", "", "Email us.",
].join("\n")

function renderView(overrides: Partial<GuideViewProps> = {}) {
  const tier: Tier = "starter"
  const props: GuideViewProps = {
    sections: parseStyleGuideContent(CONTENT),
    scrollContainerRef: createRef<HTMLDivElement>(),
    viewMode: "edit",
    onContentChange: vi.fn(),
    brandName: "Acme",
    isUnlocked: (minTier?: Tier) => tierUnlocked(tier, minTier),
    onUpgrade: vi.fn(),
    editorKey: 0,
    editorId: "test-editor",
    subscriptionTier: tier,
    ...overrides,
  }
  render(<GuideView {...props} />)
  return props
}

describe("GuideView edit mode", () => {
  it("shows 'Questions?' once (inside the editor only)", async () => {
    renderView()
    const editor = await screen.findByTestId("editor")
    expect(editor.textContent).toContain("## Questions?")
    expect(screen.queryAllByText(/Questions\?/)).toHaveLength(1)
  })

  it("keeps the original section order when the editor reports a change", async () => {
    const props = renderView()
    await screen.findByTestId("editor")
    const merged = (props.onContentChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string
    expect(parseStyleGuideContent(merged).map((s) => s.id)).toEqual([
      "about", "brand-voice", "style-rules", "word-list", "ai-writing-cleanup", "contact",
    ])
  })

  it("renders locked sections behind the gate", async () => {
    renderView()
    await screen.findByTestId("editor")
    expect(screen.getAllByText("This section is locked")).toHaveLength(2)
  })
})

describe("GuideView preview mode", () => {
  it("renders the questions section once, after the other sections", () => {
    renderView({ viewMode: "preview" })
    expect(screen.getAllByRole("heading", { name: "Questions?" })).toHaveLength(1)
    expect(screen.queryByTestId("editor")).toBeNull()
  })
})
