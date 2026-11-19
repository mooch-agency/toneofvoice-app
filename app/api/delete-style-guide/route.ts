import { NextResponse } from "next/server"
import { requireUser, withRouteErrors } from "@/lib/api-auth"

/** Delete one of the signed-in user's guides. */
export async function DELETE(req: Request) {
  return withRouteErrors("delete-style-guide", async () => {
    const guideId = new URL(req.url).searchParams.get("guideId")
    if (!guideId) return NextResponse.json({ error: "Missing guideId" }, { status: 400 })

    const auth = await requireUser()
    if (!auth.ok) return auth.response

    const { data, error } = await auth.supabase
      .from("style_guides")
      .delete()
      .eq("id", guideId)
      .eq("user_id", auth.user.id)
      .select("id")

    if (error) {
      console.error("[delete-style-guide] Delete error:", error)
      return NextResponse.json({ error: "Failed to delete guide" }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Guide not found or access denied" }, { status: 404 })
    }
    return NextResponse.json({ success: true })
  })
}
