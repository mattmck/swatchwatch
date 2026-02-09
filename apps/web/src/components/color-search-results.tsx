import Link from "next/link";
import type { Polish } from "swatchwatch-shared";
import type { HarmonyType } from "@/lib/color-harmonies";
import { Badge } from "@/components/ui/badge";
import { ColorDot } from "@/components/color-dot";
import { QuantityControls } from "@/components/quantity-controls";

interface ColorSearchResultsProps {
  polishes: (Polish & {
    distance: number;
    matchedHarmonyHex: string;
    matchedHarmonyIndex: number;
  })[];
  harmonyColors: string[];
  harmonyType: HarmonyType;
  focusedTargetHex?: string | null;
  onQuantityChange?: (polishId: string, delta: number) => void;
  /** Header dot hover — affects wheel marker + table filter */
  onSwatchHover?: (hex: string) => void;
  onSwatchLeave?: () => void;
  onSwatchClick?: (hex: string) => void;
  /** Row color dot hover — affects wheel marker only */
  onColorHover?: (hex: string) => void;
  onColorLeave?: () => void;
}

export function ColorSearchResults({
  polishes,
  harmonyColors,
  harmonyType,
  focusedTargetHex,
  onQuantityChange,
  onSwatchHover,
  onSwatchLeave,
  onSwatchClick,
  onColorHover,
  onColorLeave,
}: ColorSearchResultsProps) {
  if (polishes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-muted-foreground">
          No polishes with color data found.
        </p>
      </div>
    );
  }

  const showMatchDot = harmonyType !== "similar" && harmonyColors.length > 1;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 pb-2">
        {harmonyColors.map((hex, i) => (
          <span
            key={i}
            className={`inline-block h-4 w-4 rounded-full cursor-pointer transition-all ${
              focusedTargetHex === hex
                ? "border-2 border-white ring-2 ring-primary scale-125"
                : "border border-border hover:scale-110"
            }`}
            style={{ backgroundColor: hex }}
            onMouseEnter={() => onSwatchHover?.(hex)}
            onMouseLeave={onSwatchLeave}
            onClick={() => onSwatchClick?.(hex)}
          />
        ))}
        <p className="text-xs text-muted-foreground">
          {polishes.length} {polishes.length === 1 ? "polish" : "polishes"}
        </p>
      </div>
      {polishes.map((polish) => {
        const owned = (polish.quantity ?? 0) > 0;
        return (
          <div
            key={polish.id}
            className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-muted"
          >
            {/* Ownership status icon */}
            <span className="shrink-0 text-lg" title={owned ? "In collection" : "Not owned"}>
              {owned ? "\u2714\uFE0F" : "\u2795"}
            </span>

            <Link
              href={`/polishes/${polish.id}`}
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <span
                onMouseEnter={() => polish.colorHex && onColorHover?.(polish.colorHex)}
                onMouseLeave={onColorLeave}
              >
                <ColorDot hex={polish.colorHex} size="md" />
              </span>
              {showMatchDot && (
                <span
                  className="inline-block h-3 w-3 shrink-0 rounded-full border border-border"
                  style={{ backgroundColor: polish.matchedHarmonyHex }}
                  title={`Matched harmony color ${polish.matchedHarmonyIndex + 1}`}
                  onMouseEnter={() => onColorHover?.(polish.matchedHarmonyHex)}
                  onMouseLeave={onColorLeave}
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{polish.name}</p>
                <p className="text-sm text-muted-foreground">{polish.brand}</p>
              </div>
              {polish.finish && (
                <Badge variant="secondary" className="shrink-0">
                  {polish.finish}
                </Badge>
              )}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground w-12 text-right">
                {((1 - polish.distance) * 100).toFixed(0)}%
              </span>
            </Link>

            {/* Quantity controls */}
            {onQuantityChange && (
              <div className="shrink-0">
                <QuantityControls
                  quantity={polish.quantity ?? 0}
                  onIncrement={() => onQuantityChange(polish.id, 1)}
                  onDecrement={() => onQuantityChange(polish.id, -1)}
                  onAdd={() => onQuantityChange(polish.id, 1)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
