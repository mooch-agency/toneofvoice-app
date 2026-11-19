/**
 * Small, conservative markdown clean-up for AI-written guide sections.
 *
 * Rules: only touch whitespace, heading levels and the trait block labels.
 * Never edit punctuation, times, URLs or example text, and never create
 * H1/H2 headings (those split guide sections; see content-parser).
 */

const SECTION_HEADING = /^#{1,2}(?=[ \t])/gm

/** Turn `#`/`##` headings into `###` so model output cannot start a new guide section. */
export function demoteSectionHeadings(content: string): string {
  return content.replace(SECTION_HEADING, "###")
}

/** Trim lines, collapse runs of blank lines, demote section headings. */
export function normalizeMarkdown(content: string | undefined): string {
  if (!content) return ""
  const trimmedLines = content
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
  return demoteSectionHeadings(trimmedLines.replace(/\n{3,}/g, "\n\n").trim())
}

const TRAIT_LABEL =
  /^(?:#{1,6}\s*)?(?:\*{1,3}|_{1,2})?\s*What It (Doesn['’]t |Does Not )?Means?\s*:?\s*(?:\*{1,3}|_{1,2})?\s*:?$/i
const LIST_ITEM = /^([→✗])\s*(.+)$/

/**
 * Format the Brand Voice trait blocks:
 * `### n. Trait`, a sentence, `#### What It Means` with → items and
 * `#### What It Doesn't Mean` with ✗ items, separated by single blank lines.
 */
export function formatTraitMarkdown(content: string | undefined): string {
  if (!content) return ""
  const out: string[] = []
  const pushBlank = () => {
    if (out.length && out[out.length - 1] !== "") out.push("")
  }

  for (const rawLine of content.split("\n")) {
    let line = rawLine.trim()
    if (!line) {
      pushBlank()
      continue
    }

    const label = TRAIT_LABEL.exec(line)
    if (label) line = label[1] ? "#### What It Doesn't Mean" : "#### What It Means"
    line = demoteSectionHeadings(line)

    if (/^#{3,6} /.test(line)) {
      pushBlank()
      out.push(line, "")
      continue
    }

    const item = LIST_ITEM.exec(line)
    out.push(item ? `${item[1]} ${item[2]}` : line)
  }

  while (out.length && out[out.length - 1] === "") out.pop()
  return out.join("\n")
}
