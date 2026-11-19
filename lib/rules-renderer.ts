// Renders validated JSON rules to the Style Rules markdown. Output is final:
// it is not passed through any other formatter (AI-5).

import type { StyleRule } from "./rules-schema"

/** Fix common model output quirks: quote spacing, stray characters, "10: 00" times. */
export function sanitizeRuleText(text: string): string {
  if (!text || typeof text !== "string") return ""
  return text
    .replace(/�/g, "") // replacement char (emoji/Unicode corruption)
    .replace(/[︀-️​-‍⁠]/g, "") // variation selectors, zero-width
    .replace(/([a-zA-Z0-9])"([a-zA-Z0-9/])/g, '$1 "$2') // Click"Create -> Click "Create
    .replace(/(\d+):\s+(\d+)/g, "$1:$2") // 10: 00 -> 10:00
    .replace(/\s*\n+\s*/g, " ") // stray newlines
    .trim()
}

const italic = (text: string) => (text ? `*${text.replace(/\*/g, "\\*")}*` : "")

/**
 * ### N. Title
 * Description
 * ✅ *Good example*
 * ❌ *Bad example*
 */
export function renderRulesMarkdown(rules: StyleRule[]): string {
  return rules
    .map((rule, index) =>
      [
        `### ${index + 1}. ${sanitizeRuleText(rule.title)}`,
        sanitizeRuleText(rule.description),
        `✅ ${italic(sanitizeRuleText(rule.examples.good))}`,
        `❌ ${italic(sanitizeRuleText(rule.examples.bad))}`,
      ].join("\n"),
    )
    .join("\n\n")
}
