/**
 * A "pending draft" is a preview guide made before sign-in, kept in
 * localStorage until it can be saved to the account. Used by /auth/claim and
 * AutoSaveGuide so both follow the same rules.
 */

export const DRAFT_STAMP_KEY = "draftCreatedAt"
/** Drafts older than this are treated as someone else's leftovers (shared browsers). */
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface PendingDraft {
  brandDetails: Record<string, unknown> & { name?: string }
  previewContent: string
}

/** Mark the current brand draft as just created. Call when a new draft starts. */
export function stampDraft() {
  try {
    localStorage.setItem(DRAFT_STAMP_KEY, String(Date.now()))
  } catch {
    // storage unavailable
  }
}

/** Save the preview guide locally and refresh the draft time (the visitor is active). */
export function storePreview(markdown: string) {
  try {
    localStorage.setItem("previewContent", markdown)
  } catch {
    return
  }
  stampDraft()
}

function clearDraft() {
  for (const key of ["brandDetails", "previewContent", DRAFT_STAMP_KEY]) localStorage.removeItem(key)
}

/** The draft to claim, or null when there is none or it is stale or unreadable. */
export function readPendingDraft(): PendingDraft | null {
  try {
    const raw = localStorage.getItem("brandDetails")
    const previewContent = localStorage.getItem("previewContent")
    if (!raw || !previewContent) return null

    const rawStamp = localStorage.getItem(DRAFT_STAMP_KEY)
    if (rawStamp === null) {
      // Draft from before stamping existed: keep it and start its clock now.
      stampDraft()
    } else if (Date.now() - Number(rawStamp) > DRAFT_MAX_AGE_MS || !Number(rawStamp)) {
      clearDraft()
      return null
    }

    const brandDetails = JSON.parse(raw)
    if (!brandDetails || typeof brandDetails !== "object") return null
    return { brandDetails, previewContent }
  } catch {
    return null
  }
}

/** Save the draft to the signed-in account. On success the local preview is removed. */
export async function savePendingDraft(
  draft: PendingDraft,
): Promise<{ status: number; guideId: string | undefined }> {
  const name = draft.brandDetails.name || "Brand"
  const res = await fetch("/api/save-style-guide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `${name} Style Guide`,
      brand_name: name,
      content_md: draft.previewContent,
      plan_type: "style_guide",
      brand_details: draft.brandDetails,
    }),
  })

  let guideId: string | undefined
  if (res.ok) {
    const data = await res.json().catch(() => null)
    guideId = data?.guide?.id
    if (guideId) localStorage.removeItem("previewContent")
  }
  return { status: res.status, guideId }
}
