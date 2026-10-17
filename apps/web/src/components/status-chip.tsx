import type { PolishStatus } from "swatchwatch-shared";
import { Badge } from "@/components/ui/badge";
import { POLISH_STATUS_LABELS } from "@/lib/inventory-status";
import { cn } from "@/lib/utils";

const STATUS_CHIP_CLASSES: Record<PolishStatus, string> = {
  owned:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-300",
  wishlist:
    "border-brand-pink/40 bg-brand-pink-light/50 text-brand-purple-deep dark:border-brand-pink/40 dark:bg-brand-pink/20 dark:text-brand-pink-soft",
  destash:
    "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-200",
  archived: "border-border bg-muted text-muted-foreground",
};

interface StatusChipProps {
  /** Inventory status; null/undefined renders the catalog-only placeholder. */
  status: PolishStatus | null | undefined;
  className?: string;
}

/** Color-coded inventory status chip (`Owned`, `Wishlist`, `Destash`, `Archived`), or "Not added". */
export function StatusChip({ status, className }: StatusChipProps) {
  if (!status) {
    return (
      <Badge variant="outline" className={cn("border-dashed font-normal text-muted-foreground", className)}>
        Not added
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={cn(STATUS_CHIP_CLASSES[status], className)}>
      {POLISH_STATUS_LABELS[status]}
    </Badge>
  );
}

/** "Untried" badge for owned polishes with no `triedAt` (`Polish.isUntried`). */
export function UntriedBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-brand-purple/30 bg-brand-lilac/30 text-brand-purple-deep dark:border-brand-lilac/40 dark:bg-brand-purple/25 dark:text-brand-lilac",
        className
      )}
      title="Owned, never tried"
    >
      Untried
    </Badge>
  );
}
