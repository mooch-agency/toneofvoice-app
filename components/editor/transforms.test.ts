// @vitest-environment node
import { describe, expect, it } from "vitest"
import { createSlateEditor, KEYS, type TElement } from "platejs"
import type { PlateEditor } from "platejs/react"
import { MarkdownPlugin } from "@platejs/markdown"
import {
  BaseBulletedListPlugin,
  BaseListItemContentPlugin,
  BaseListItemPlugin,
  BaseListPlugin,
  BaseNumberedListPlugin,
} from "@platejs/list-classic"
import { getBlockType, isSafeLinkUrl, setBlockType } from "./transforms"

function editorWith(text = "hello") {
  const editor = createSlateEditor({
    plugins: [
      MarkdownPlugin,
      BaseListPlugin,
      BaseBulletedListPlugin,
      BaseNumberedListPlugin,
      BaseListItemPlugin,
      BaseListItemContentPlugin,
    ],
    value: [{ type: "p", children: [{ text }] }],
  })
  editor.tf.select({ path: [0, 0], offset: 0 })
  return editor
}

const serialize = (editor: ReturnType<typeof editorWith>) => editor.getApi(MarkdownPlugin).markdown.serialize()

describe("setBlockType", () => {
  it("turns a paragraph into a classic bulleted list", () => {
    const editor = editorWith()
    setBlockType(editor as unknown as PlateEditor, KEYS.ul)
    expect((editor.children[0] as TElement).type).toBe("ul")
    expect(editor.children[0]).not.toHaveProperty(KEYS.listType)
    expect(serialize(editor)).toBe("* hello\n")
  })

  it("turns a paragraph into a classic numbered list", () => {
    const editor = editorWith()
    setBlockType(editor as unknown as PlateEditor, KEYS.ol)
    expect((editor.children[0] as TElement).type).toBe("ol")
    expect(serialize(editor)).toBe("1. hello\n")
  })

  it("turns a list item back into a paragraph", () => {
    const editor = editorWith()
    setBlockType(editor as unknown as PlateEditor, KEYS.ul)
    editor.tf.select({ path: [0, 0, 0, 0], offset: 0 })
    setBlockType(editor as unknown as PlateEditor, KEYS.p)
    expect((editor.children[0] as TElement).type).toBe("p")
    expect(serialize(editor)).toBe("hello\n")
  })

  it("sets heading types", () => {
    const editor = editorWith()
    setBlockType(editor as unknown as PlateEditor, "h2")
    expect((editor.children[0] as TElement).type).toBe("h2")
  })
})

describe("getBlockType", () => {
  it("maps classic list containers to the menu values", () => {
    expect(getBlockType({ type: "ul", children: [] } as TElement)).toBe(KEYS.ul)
    expect(getBlockType({ type: "ol", children: [] } as TElement)).toBe(KEYS.ol)
  })

  it("returns other block types unchanged", () => {
    expect(getBlockType({ type: "h3", children: [] } as TElement)).toBe("h3")
  })

  it("round-trips with setBlockType", () => {
    const editor = editorWith()
    setBlockType(editor as unknown as PlateEditor, KEYS.ol)
    expect(getBlockType(editor.children[0] as TElement)).toBe(KEYS.ol)
  })
})

describe("isSafeLinkUrl", () => {
  it.each(["https://example.com", "http://example.com/a?b=c", "mailto:hi@example.com", "  HTTPS://EXAMPLE.COM  "])(
    "accepts %s",
    (url) => expect(isSafeLinkUrl(url)).toBe(true)
  )

  it.each(["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "//evil.com", "example.com", ""])(
    "rejects %s",
    (url) => expect(isSafeLinkUrl(url)).toBe(false)
  )
})
