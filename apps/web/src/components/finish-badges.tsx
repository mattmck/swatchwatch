import type { ReactNode } from "react";
import { resolvePolishFinishes } from "swatchwatch-shared";
import { Badge } from "@/components/ui/badge";
import { finishBadgeClassName, finishLabel } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface FinishBadgesProps {
  /** Polish-like row; `finishes` wins, legacy `finish` is the fallback. */
  polish: { finish?: string | null; finishes?: readonly string[] | null };
  /** Max badges to render before collapsing the rest into a "+N" badge. */
  max?: number;
  /** Rendered when the polish has no finishes. Defaults to nothing. */
  empty?: ReactNode;
  className?: string;
  badgeClassName?: string;
}

/**
 * Renders one color-coded badge per finish (multi-finish shades show several),
 * falling back to the legacy single `finish` for older payloads.
 */
export function FinishBadges({ polish, max, empty = null, className, badgeClassName }: FinishBadgesProps) {
  const finishes = resolvePolishFinishes(polish);
  if (finishes.length === 0) return <>{empty}</>;

  const visible = typeof max === "number" && max > 0 ? finishes.slice(0, max) : finishes;
  const hidden = finishes.slice(visible.length);

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {visible.map((finish) => (
        <Badge key={finish} className={cn(finishBadgeClassName(finish), badgeClassName)}>
          {finishLabel(finish)}
        </Badge>
      ))}
      {hidden.length > 0 && (
        <Badge
          variant="outline"
          className={badgeClassName}
          title={hidden.map(finishLabel).join(", ")}
        >
          +{hidden.length}
        </Badge>
      )}
    </span>
  );
}
