/** Placeholder lines that stand in for paid sections in a preview guide. */
export const PLACEHOLDERS = {
  styleRules: "_Unlock to see Style Rules._",
  beforeAfter: "_Unlock to see Before/After examples._",
  wordList: "_Unlock to see Word List._",
} as const

/** True when the guide still has at least one locked (unexpanded) section. */
export function hasUnlockPlaceholders(content: string | null | undefined): boolean {
  if (!content) return false
  return Object.values(PLACEHOLDERS).some((p) => content.includes(p))
}

/** Remove placeholder lines (and a directly following `---`) for display or export. */
export function stripUnlockPlaceholders(content: string): string {
  return content.replace(/\n*_Unlock to see[^_]+_[^\n]*\n(\s*---\s*\n)?/gi, "\n")
}
