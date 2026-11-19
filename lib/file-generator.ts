// File generation utilities for style guide exports
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx"

/** Formats built from markdown. PDF is rendered from the DOM (see app/guide). */
export type FileFormat = "md" | "docx"

const NUMBERING_REFERENCE = "guide-numbering"

export interface FileGenerationOptions {
  websiteUrl?: string
  subscriptionTier?: "starter" | "pro" | "agency"
  generationDate?: string
}

const formatDate = (date?: string) =>
  date || new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })

const displayUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")

/** Generate a Markdown or Word file for the guide. Errors are logged without content. */
export async function generateFile(
  format: FileFormat,
  content: string,
  brandName: string,
  options: FileGenerationOptions = {}
): Promise<Blob> {
  try {
    return format === "md" ? generateMarkdown(content, brandName, options) : await generateDOCX(content, brandName, options)
  } catch (error) {
    console.error("[File Generator] generation failed", {
      format,
      error: error instanceof Error ? error.message : "Unknown error",
      contentLength: content.length,
    })
    throw new Error(`Failed to generate ${format.toUpperCase()} file. Please try again or contact support.`)
  }
}

/** Markdown file: a short cover block followed by the guide body. */
function generateMarkdown(content: string, brandName: string, options: FileGenerationOptions): Blob {
  const { websiteUrl, subscriptionTier = "starter", generationDate } = options
  let cover = `# ${brandName}\n\n*Brand Voice & Content Guidelines*\n\n---\n\n${formatDate(generationDate)}\n\n`
  if (websiteUrl) cover += `${displayUrl(websiteUrl)}\n\n`
  if (subscriptionTier !== "agency") cover += `[Tone of Voice App](https://toneofvoice.app)\n\n`
  cover += `---\n\n`
  return new Blob([cover + content], { type: "text/markdown" })
}

/** Word file built with the docx library. */
async function generateDOCX(content: string, brandName: string, options: FileGenerationOptions): Promise<Blob> {
  const doc = new Document({
    numbering: {
      config: [
        {
          reference: NUMBERING_REFERENCE,
          levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START }],
        },
      ],
    },
    sections: [{ properties: {}, children: parseMarkdownToDocxParagraphs(content, brandName, options) }],
  })
  const buffer = await Packer.toBuffer(doc)
  return new Blob([new Uint8Array(buffer)], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  })
}

/** Cover paragraphs followed by the guide body. */
function parseMarkdownToDocxParagraphs(content: string, brandName: string, options: FileGenerationOptions): (Paragraph | Table)[] {
  const paragraphs: Paragraph[] = []
  const { websiteUrl, subscriptionTier = "starter", generationDate } = options
  const formattedDate = formatDate(generationDate)

  // Add eyebrow
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({
        text: 'BRAND VOICE & CONTENT GUIDELINES',
        size: 18,
        color: '666666',
        allCaps: true
      })],
      alignment: AlignmentType.LEFT,
      spacing: { after: 120 }
    })
  )

  // Add title
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: brandName, bold: true, size: 56 })],
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.LEFT,
      spacing: { after: 240 }
    })
  )

  // Add separator line
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: '', size: 20 })],
      spacing: { after: 240 },
      border: {
        bottom: {
          color: '000000',
          space: 1,
          style: BorderStyle.SINGLE,
          size: 12
        }
      }
    })
  )

  // Add generation date
  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: formattedDate, size: 20 })],
      spacing: { after: 120 }
    })
  )

  // Add website URL if available
  if (websiteUrl) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: displayUrl(websiteUrl), size: 20, bold: true })],
        spacing: { after: 240 }
      })
    )
  }

  // Add branding based on tier
  if (subscriptionTier === 'starter' || subscriptionTier === 'pro') {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({
          text: 'Tone of Voice App (toneofvoice.app)',
          size: 18,
          color: '999999',
          italics: true
        })],
        spacing: { before: websiteUrl ? 120 : 240, after: 600 }
      })
    )
  } else {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: '' })],
        spacing: { after: 600 }
      })
    )
  }
  
  return [...paragraphs, ...markdownToDocxBlocks(content)]
}

const TABLE_ROW = /^\|.*\|$/
const TABLE_DIVIDER = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/

function tableCells(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
}

function markdownTable(rows: string[]): Table {
  const body = rows.filter((r) => !TABLE_DIVIDER.test(r)).map(tableCells)
  const columns = Math.max(...body.map((r) => r.length))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: body.map(
      (cells, rowIndex) =>
        new TableRow({
          tableHeader: rowIndex === 0,
          children: Array.from({ length: columns }, (_, c) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: rowIndex === 0
                    ? [new TextRun({ text: cells[c] ?? "", bold: true })]
                    : parseFormattedText(cells[c] ?? ""),
                }),
              ],
            })
          ),
        })
    ),
  })
}

const HEADING_LEVELS = [
  { heading: HeadingLevel.HEADING_1, size: 24 },
  { heading: HeadingLevel.HEADING_2, size: 20 },
  { heading: HeadingLevel.HEADING_3, size: 16 },
  { heading: HeadingLevel.HEADING_4, size: 14 },
  { heading: HeadingLevel.HEADING_5, size: 12 },
]

/** Convert the guide body (headings, lists, rules, tables, paragraphs) into DOCX blocks. */
function markdownToDocxBlocks(content: string): (Paragraph | Table)[] {
  const blocks: (Paragraph | Table)[] = []
  const lines = content.split("\n").map((l) => l.trim())
  // Each separate numbered list restarts at 1.
  let listInstance = 0
  let inNumberedList = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isNumbered = /^\d+\.\s+/.test(line)
    if (!isNumbered && line) inNumberedList = false
    if (!line) continue

    if (TABLE_ROW.test(line)) {
      const rows: string[] = []
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(lines[i++])
      i--
      blocks.push(markdownTable(rows))
    } else if (line.startsWith("#")) {
      const level = Math.min(line.match(/^#+/)![0].length, HEADING_LEVELS.length)
      const { heading, size } = HEADING_LEVELS[level - 1]
      blocks.push(
        new Paragraph({
          children: [new TextRun({ text: line.replace(/^#+\s*/, ""), bold: true, size: size * 2 })],
          heading,
          spacing: { before: 240, after: 120 },
        })
      )
    } else if (/^-{3,}$/.test(line)) {
      blocks.push(
        new Paragraph({
          children: [new TextRun({ text: "", size: 20 })],
          spacing: { before: 200, after: 200 },
          border: { bottom: { color: "auto", space: 1, style: BorderStyle.SINGLE, size: 6 } },
        })
      )
    } else if (/^[-*+]\s+/.test(line)) {
      blocks.push(
        new Paragraph({
          children: parseFormattedText(line.replace(/^[-*+]\s+/, "")),
          bullet: { level: 0 },
          spacing: { after: 60 },
        })
      )
    } else if (isNumbered) {
      if (!inNumberedList) listInstance++
      inNumberedList = true
      blocks.push(
        new Paragraph({
          children: parseFormattedText(line.replace(/^\d+\.\s+/, "")),
          numbering: { reference: NUMBERING_REFERENCE, level: 0, instance: listInstance },
          spacing: { after: 60 },
        })
      )
    } else {
      blocks.push(new Paragraph({ children: parseFormattedText(line), spacing: { after: 120 } }))
    }
  }

  return blocks
}

/**
 * Parse formatted text (bold, italic, etc.) into TextRuns
 */
function parseFormattedText(text: string): TextRun[] {
  const runs: TextRun[] = []
  // Word renders these emoji poorly; use plain symbols.
  const currentText = text.replace(/✅/g, "✓").replace(/❌/g, "✗")

  // Enhanced parsing for bold, italic, and inline code
  const parts = currentText.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/g)
  
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**')) {
      // Bold text
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true }))
    } else if (part.startsWith('*') && part.endsWith('*') && !part.startsWith('**')) {
      // Italic text (but not bold)
      runs.push(new TextRun({ text: part.slice(1, -1), italics: true }))
    } else if (part.startsWith('`') && part.endsWith('`')) {
      // Inline code
      runs.push(new TextRun({ 
        text: part.slice(1, -1), 
        font: { name: "Consolas" },
        shading: { fill: "F5F5F5" }
      }))
    } else if (part) {
      // Regular text
      runs.push(new TextRun({ text: part }))
    }
  }
  
  return runs.length > 0 ? runs : [new TextRun({ text })]
}

/**
 * Download a generated file
 */
export function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke after the click has been handled; some browsers cancel the download otherwise.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
