import type { Undertone } from "@/lib/color-utils";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const undertoneStyles: Record<Undertone, string> = {
  warm: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/40 dark:text-amber-200 dark:border-amber-700",
  cool: "bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-900/40 dark:text-sky-200 dark:border-sky-700",
  neutral: "bg-stone-100 text-stone-700 border-stone-300 dark:bg-stone-800/40 dark:text-stone-300 dark:border-stone-600",
};

const undertoneLabels: Record<Undertone, string> = {
  warm: "Warm",
  cool: "Cool",
  neutral: "Neutral",
};

interface UndertoneBadgeProps {
  undertone: Undertone;
  className?: string;
}

export function UndertoneBadge({ undertone, className }: UndertoneBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(undertoneStyles[undertone], "text-xs", className)}
    >
      {undertoneLabels[undertone]}
    </Badge>
  );
}
