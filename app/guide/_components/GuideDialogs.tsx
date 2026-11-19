"use client"

import Link from "next/link"
import type { ReactNode } from "react"
import { Check, Download, FileText, Loader2 } from "lucide-react"
import { track } from "@vercel/analytics"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { PRICING_TIERS } from "@/lib/landing-data"
import { TIER_LIMITS } from "@/lib/tiers"
import type { ExportFormat } from "../_hooks/use-guide-export"
import type { PaidPlan } from "../_hooks/use-checkout"

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Signed-out preview users must create an account before downloading. */
export function ExportGateDialog({ open, onOpenChange }: DialogProps) {
  const redirect = encodeURIComponent("/guide")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px] text-sm sm:text-base">
        <DialogHeader>
          <DialogTitle>Sign up free to download</DialogTitle>
          <DialogDescription>Your free account also unlocks:</DialogDescription>
        </DialogHeader>
        <ul className="mt-3 space-y-2 text-sm text-gray-600">
          {["Save guides and edit anytime", "Use AI to rewrite sections"].map((item) => (
            <li key={item} className="flex items-center gap-2">
              <Check className="h-4 w-4 shrink-0 text-green-600" />
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-gray-500">Your preview is safe - pick up right where you left off.</p>
        <DialogFooter className="mt-6 flex gap-3 sm:gap-2">
          <Button variant="outline" className="flex-1" asChild>
            <Link href={`/sign-in?redirectTo=${redirect}`} onClick={() => onOpenChange(false)}>
              Log in
            </Link>
          </Button>
          <Button className="flex-1 bg-gray-900 text-white hover:bg-gray-800 hover:text-white" asChild>
            <Link href={`/sign-up?redirectTo=${redirect}`} onClick={() => onOpenChange(false)}>
              Sign up
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const PLAN_COPY: Record<PaidPlan, string> = {
  pro: `${TIER_LIMITS.pro} guides, full editing & export`,
  agency: "Unlimited guides, white-label exports, priority support",
}

/** Choose a paid plan from the preview. */
export function PaymentDialog({
  open,
  onOpenChange,
  processingPlan,
  onSubscribe,
}: DialogProps & { processingPlan: PaidPlan | null; onSubscribe: (plan: PaidPlan) => void }) {
  const plans = (["pro", "agency"] as const).map((id) => ({ id, tier: PRICING_TIERS.find((t) => t.id === id)! }))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] text-sm sm:text-base">
        <DialogHeader className="space-y-4">
          <DialogTitle className="text-base sm:text-xl">Get your full tone of voice guide</DialogTitle>
          <DialogDescription className="text-xs sm:text-base">Subscribe to unlock all rules, editing, and exports</DialogDescription>
        </DialogHeader>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {plans.map(({ id, tier }) => (
            <div
              key={id}
              className={id === "pro" ? "rounded-lg border border-blue-300 bg-blue-50/50 p-4 dark:bg-blue-950/20" : "rounded-lg border p-4"}
            >
              {id === "pro" && (
                <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900">RECOMMENDED</span>
              )}
              <h4 className="mt-1 font-semibold">
                {tier.name} — {tier.priceLabel}/mo
              </h4>
              <p className="mt-1 text-xs text-muted-foreground">{PLAN_COPY[id]}</p>
              <Button
                onClick={() => {
                  track("Payment Started", { plan: id, type: "subscription" })
                  onSubscribe(id)
                }}
                disabled={processingPlan !== null}
                className="mt-3 w-full"
              >
                {processingPlan === id && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Subscribe
              </Button>
            </div>
          ))}
        </div>

        <DialogFooter className="sm:justify-start">
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={processingPlan !== null}
            className="w-full text-base sm:text-lg py-4 sm:py-6"
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FormatButton({
  busy,
  disabled,
  onClick,
  icon,
  title,
  subtitle,
  primary = false,
}: {
  busy: boolean
  disabled: boolean
  onClick: () => void
  icon: ReactNode
  title: string
  subtitle: string
  primary?: boolean
}) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      className={
        primary
          ? "w-full justify-start gap-3 h-14 bg-gray-950 border border-gray-950 text-white hover:bg-gray-800 shadow-none"
          : "w-full justify-start gap-3 h-14 bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-gray-300 shadow-none"
      }
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      <div className="text-left">
        <div className={primary ? "font-medium" : "font-medium text-gray-900"}>{title}</div>
        <div className={primary ? "text-xs opacity-70" : "text-xs text-gray-500"}>{subtitle}</div>
      </div>
    </Button>
  )
}

/** Download format picker for saved guides. */
export function DownloadOptionsDialog({
  open,
  onOpenChange,
  downloading,
  onExport,
}: DialogProps & { downloading: ExportFormat | null; onExport: (format: ExportFormat) => void }) {
  const fileIcon = <FileText className="h-4 w-4 text-gray-600" />
  const item = (format: ExportFormat) => ({
    busy: downloading === format,
    disabled: downloading !== null,
    onClick: () => onExport(format),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] bg-white border-gray-200">
        <DialogHeader className="text-center pb-4">
          <div className="w-12 h-12 bg-blue-50 rounded-lg flex items-center justify-center mx-auto mb-3">
            <Download className="w-6 h-6 text-blue-600" />
          </div>
          <DialogTitle className="text-lg font-semibold text-gray-900">Download Style Guide</DialogTitle>
          <DialogDescription className="text-sm text-gray-600">Choose your preferred format</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-4">
          <FormatButton {...item("zip")} primary icon={<Download className="h-4 w-4" />} title="All formats" subtitle="PDF + Word + Markdown in one zip" />
          <div className="relative flex items-center gap-2 py-1">
            <div className="flex-1 border-t border-gray-100" />
            <span className="text-xs text-gray-400">or download individually</span>
            <div className="flex-1 border-t border-gray-100" />
          </div>
          <FormatButton {...item("pdf")} icon={fileIcon} title="PDF" subtitle="Perfect for sharing" />
          <FormatButton {...item("docx")} icon={fileIcon} title="Word" subtitle="Opens directly in Word" />
          <FormatButton {...item("md")} icon={fileIcon} title="Markdown" subtitle="Perfect for AI tools" />
        </div>
      </DialogContent>
    </Dialog>
  )
}
