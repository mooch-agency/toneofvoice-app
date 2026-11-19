"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Sparkles, ArrowRight, CheckCircle } from "lucide-react";
import { detectInputType, sanitizeInput } from "@/lib/input-utils";
import { useExtraction } from "@/hooks/use-extraction";
import Link from "next/link";

interface CreateGuideModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateGuideModal({ open, onOpenChange }: CreateGuideModalProps) {
  const router = useRouter();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const {
    url,
    setUrl,
    error,
    clearError,
    reset,
    isExtracting,
    isSuccess,
    loadingMessage,
    inputRef,
    handleExtraction,
    isInputValid,
  } = useExtraction<HTMLInputElement>({
    focusOnGetStarted: false,
    // Show the success state briefly, then close the modal and open the preview
    onSuccess: () => {
      closeTimer.current = setTimeout(() => {
        onOpenChange(false);
        router.push("/guide?generate=preview");
      }, 800);
    },
  });

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  // Focus input when modal opens
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, [open, inputRef]);

  // Reset state when modal closes (but not while extraction is in progress)
  useEffect(() => {
    if (!open && !isExtracting) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isExtracting]);

  return (
    <Dialog open={open} onOpenChange={(newOpen) => {
      // Prevent closing during extraction
      if (!newOpen && isExtracting) {
        return;
      }
      onOpenChange(newOpen);
    }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create new guide</DialogTitle>
          <DialogDescription>
            Enter a website URL or short description to get started.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleExtraction} className="space-y-4">
          <div className="space-y-2">
            <div className="relative">
              <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
                <Sparkles className="h-5 w-5 text-blue-500" />
              </div>
              <Input
                ref={inputRef}
                type="text"
                placeholder="Enter URL or short description"
                className={`
                  pl-10 pr-4 py-3
                  text-base font-medium
                  border-blue-200
                  focus:ring-2 focus:ring-blue-500 focus:border-blue-500
                  placeholder:text-gray-500 placeholder:font-normal placeholder:text-sm
                  transition-all duration-200
                  ${error ? "ring-2 ring-red-500 border-red-500" : ""}
                  ${isSuccess ? "ring-2 ring-green-500 bg-green-50" : ""}
                `}
                value={url}
                onChange={(e) => {
                  const sanitizedValue = sanitizeInput(e.target.value, url);
                  setUrl(sanitizedValue);
                  if (error) clearError();
                }}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                disabled={isExtracting || isSuccess}
                aria-label="Website URL or brand description"
                aria-describedby={error ? "input-error" : undefined}
              />
            </div>

            {/* Error display */}
            {error && (
              <div
                id="input-error"
                className="text-red-600 text-sm font-medium flex items-start gap-1 leading-5"
                role="alert"
                aria-live="polite"
              >
                <svg className="h-4 w-4 flex-shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {/* Character count for descriptions */}
            {(() => {
              const trimmed = url.trim();
              const hasSpace = trimmed.includes(" ");
              const detection = detectInputType(trimmed);
              const isDesc = detection.inputType === "description" && hasSpace;

              if (!isDesc || error) return null;

              const len = trimmed.length;
              return (
                <span className="text-xs font-medium tabular-nums text-muted-foreground">
                  {len <= 200 ? `${len}/200 characters` : "Using first 200 characters"}
                </span>
              );
            })()}
          </div>

          <div className="flex flex-col sm:flex-row gap-3 sm:justify-between sm:items-center">
            <Link
              href="/"
              onClick={() => {
                onOpenChange(false);
              }}
              className="text-gray-500 underline font-medium text-xs sm:text-sm whitespace-nowrap text-center sm:text-left"
            >
              Start again on homepage
            </Link>

            <Button
              type="submit"
              size="lg"
              className={`
                w-full sm:w-auto
                bg-black text-white font-semibold
                hover:bg-gray-800
                transition-all duration-200
                ${isSuccess ? "bg-green-500 hover:bg-green-600" : ""}
                ${!isInputValid() && !isExtracting && !isSuccess ? "opacity-75 cursor-not-allowed" : ""}
              `}
              disabled={isExtracting || isSuccess || !isInputValid()}
            >
              {isExtracting ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  <span>{loadingMessage || "Processing"}</span>
                </>
              ) : isSuccess ? (
                <>
                  <CheckCircle className="mr-2 h-5 w-5" />
                  <span>Done!</span>
                </>
              ) : (() => {
                const trimmed = url.trim();
                const hasSpace = trimmed.includes(" ");
                const detection = detectInputType(trimmed);
                const isDesc = detection.inputType === "description" && hasSpace;

                if (isDesc && trimmed.length < 25) {
                  return <span>Min. 25 characters</span>;
                }

                return (
                  <>
                    <span>Generate</span>
                    <ArrowRight className="ml-2 h-5 w-5" />
                  </>
                );
              })()}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
