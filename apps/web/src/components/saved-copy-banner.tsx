"use client";

import { CloudOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatSavedAt } from "@/lib/offline";
import { cn } from "@/lib/utils";

interface SavedCopyBannerProps {
  /** When the copy being shown was saved (epoch ms). */
  savedAt: number;
  /** What is being shown: the whole collection list or one polish. */
  subject: "collection" | "polish";
  retrying?: boolean;
  onRetry: () => void;
  className?: string;
}

/** Shown while the API is unreachable and a saved copy is displayed (read-only). */
export function SavedCopyBanner({ savedAt, subject, retrying = false, onRetry, className }: SavedCopyBannerProps) {
  return (
    <div
      role="status"
      data-testid="saved-copy-banner"
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100",
        className
      )}
    >
      <CloudOff aria-hidden="true" className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        {subject === "collection" ? "Showing your saved collection" : "Showing your saved copy of this polish"} from{" "}
        {formatSavedAt(savedAt)}; some actions are unavailable.
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
        <RefreshCw aria-hidden="true" className={cn("size-3.5", retrying && "animate-spin")} />
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
