// Schema and validation for the 25 style-guide rules the model returns as JSON.

export const ALLOWED_RULE_CATEGORIES = [
  "Contractions",
  "Active vs. Passive Voice",
  "Emojis",
  "Exclamation Points",
  "Sentence Length",
  "Slang and Jargon",
  "Pronouns and Point of View",
  "UK vs. US English",
  "Serial Comma",
  "Capitalisation",
  "Title Case vs. Sentence Case",
  "Acronyms",
  "Abbreviated Words",
  "Numbers",
  "Dates",
  "Time and Time Zones",
  "Money and Currency",
  "Percentages",
  "Hedging Language",
  "Sentence Structure",
  "Ellipses",
  "Quotation Marks",
  "Company and Product Name Spelling",
  "Job Titles",
  "Inclusive Language",
] as const

export type RuleCategory = (typeof ALLOWED_RULE_CATEGORIES)[number]

export interface StyleRule {
  category: RuleCategory
  title: string
  description: string
  examples: { good: string; bad: string }
}

export interface ValidationResult {
  valid: StyleRule[]
  invalid: unknown[]
}

function categoryKey(category: string): string {
  return category
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bversus\b/g, "vs")
    .replace(/ization/g, "isation")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

const CATEGORY_BY_KEY = new Map<string, RuleCategory>(
  ALLOWED_RULE_CATEGORIES.map((c) => [categoryKey(c), c]),
)

/** Map a model-written category ("capitalization", "Active vs Passive Voice") to its canonical name. */
export function canonicalRuleCategory(category: string): RuleCategory | null {
  return CATEGORY_BY_KEY.get(categoryKey(category)) ?? null
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0

function toRule(raw: unknown): StyleRule | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const examples = r.examples as Record<string, unknown> | null | undefined
  if (!nonEmpty(r.category) || !nonEmpty(r.description)) return null
  if (!examples || typeof examples !== "object" || !nonEmpty(examples.good) || !nonEmpty(examples.bad)) return null
  const category = canonicalRuleCategory(r.category)
  if (!category) return null
  return {
    category,
    title: nonEmpty(r.title) ? r.title.trim() : category,
    description: r.description,
    examples: { good: examples.good, bad: examples.bad },
  }
}

/** Keep well-formed rules with a known category, one per category. Never throws. */
export function validateRules(rules: unknown): ValidationResult {
  const valid: StyleRule[] = []
  const invalid: unknown[] = []
  if (!Array.isArray(rules)) return { valid, invalid }
  const seen = new Set<RuleCategory>()
  for (const raw of rules) {
    const rule = toRule(raw)
    if (!rule || seen.has(rule.category)) {
      invalid.push(raw)
      continue
    }
    seen.add(rule.category)
    valid.push(rule)
  }
  return { valid, invalid }
}

/** Numbered list of categories for prompts. */
export function getAllowedCategoriesPromptText(): string {
  return ALLOWED_RULE_CATEGORIES.map((cat, i) => `${i + 1}. ${cat}`).join("\n")
}
