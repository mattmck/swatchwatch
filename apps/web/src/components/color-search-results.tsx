import Link from "next/link";
import Image from "next/image";
import type { Polish } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import { BsPlusLg } from "react-icons/bs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ColorDot } from "@/components/color-dot";
import { QuantityControls } from "@/components/quantity-controls";
import { finishBadgeClassName, finishLabel } from "@/lib/constants";
import { buildSwatchThumbnailUrl } from "@/lib/image-url";

interface ColorSearchResultsProps {
  polishes: (Polish & {
    distance: number;
    matchedHarmonyHex: string;
    matchedHarmonyIndex: number;
  })[];
  harmonyColors: string[];
  showMatchDots?: boolean;
  focusedTargetHex?: string | null;
  onQuantityChange?: (polishId: string, delta: number) => void;
  onAddFocus?: (hex: string) => void;
  /** Header dot hover — affects wheel marker + table filter */
  onSwatchHover?: (hex: string) => void;
  onSwatchLeave?: () => void;
  onSwatchClick?: (hex: string) => void;
  onColorSelect?: (hex: string) => void;
  /** Row color dot hover — affects wheel marker only */
  onColorHover?: (hex: string) => void;
  onColorLeave?: () => void;
}

/**
 * Render a searchable list of polishes with color swatches, match indicators, ownership and quantity controls.
 *
 * Renders a header row of harmony color swatches and a scrolling list of polish rows. Each row shows an optional swatch image, a color dot (and optional matched-harmony dot), name/brand/collection, finish badge, match percentage, ownership indicator, and optional controls to add to focused colors or change collection quantity.
 *
 * @param polishes - Array of polish objects augmented with `distance`, `matchedHarmonyHex`, and `matchedHarmonyIndex`.
 * @param harmonyColors - Array of hex color strings used to render the header swatches.
 * @param showMatchDots - When true and more than one harmony color exists, show a small matched-harmony dot for each polish.
 * @param focusedTargetHex - Hex string of the currently focused harmony swatch; used to highlight the corresponding header swatch.
 * @param onQuantityChange - Optional handler invoked as `(polishId, delta)` when quantity is incremented/decremented/added.
 * @param onAddFocus - Optional handler invoked with a hex string when the "add to focused colors" button is pressed.
 * @param onSwatchHover - Optional handler invoked with a hex string when a header swatch is hovered.
 * @param onSwatchLeave - Optional handler invoked when a header swatch hover ends.
 * @param onSwatchClick - Optional handler invoked with a hex string when a header swatch is clicked.
 * @param onColorSelect - Optional handler invoked with a hex string when a swatch or matched-harmony dot is clicked.
 * @param onColorHover - Optional handler invoked with a hex string when a swatch or matched-harmony dot is hovered.
 * @param onColorLeave - Optional handler invoked when a swatch or matched-harmony dot hover ends.
 * @returns A React node containing the rendered color search results list.
 */
export function ColorSearchResults({
  polishes,
  harmonyColors,
  showMatchDots = false,
  focusedTargetHex,
  onQuantityChange,
  onAddFocus,
  onSwatchHover,
  onSwatchLeave,
  onSwatchClick,
  onColorSelect,
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

  const showMatchDot = showMatchDots && harmonyColors.length > 1;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 pb-2">
        {harmonyColors.map((hex, i) => (
          <span
            key={i}
            className={`inline-block h-4 w-4 rounded-full cursor-pointer transition-all ${
              focusedTargetHex === hex
                ? "border-2 border-white ring-2 ring-brand-purple/75 shadow-glow-brand scale-125"
                : "border border-border hover:scale-110 hover:shadow-glow-purple"
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
              href={`/polishes/detail?id=${polish.id}`}
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              {polish.swatchImageUrl ? (
                <Image
                  src={buildSwatchThumbnailUrl(polish.swatchImageUrl)}
                  alt={`${polish.brand} ${polish.name} swatch`}
                  width={40}
                  height={40}
                  unoptimized
                  sizes="40px"
                  className="h-10 w-10 shrink-0 rounded-md border object-cover transition-opacity hover:opacity-85"
                />
              ) : (
                <div className="h-10 w-10 shrink-0 rounded-md border bg-muted/40" />
              )}
              <span
                onMouseEnter={() => { const h = resolveDisplayHex(polish); if (h) onColorHover?.(h); }}
                onMouseLeave={onColorLeave}
                onClick={(e) => {
                  const h = resolveDisplayHex(polish);
                  if (!h) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onColorSelect?.(h);
                }}
              >
                <ColorDot hex={resolveDisplayHex(polish)} size="md" />
              </span>
              {showMatchDot && (
                <span
                  className="inline-block h-3 w-3 shrink-0 rounded-full border border-border"
                  style={{ backgroundColor: polish.matchedHarmonyHex }}
                  title={`Matched harmony color ${polish.matchedHarmonyIndex + 1}`}
                  onMouseEnter={() => onColorHover?.(polish.matchedHarmonyHex)}
                  onMouseLeave={onColorLeave}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onColorSelect?.(polish.matchedHarmonyHex);
                  }}
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{polish.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {polish.brand}
                  {polish.collection ? ` · ${polish.collection}` : ""}
                </p>
              </div>
              {polish.finish && (
                <Badge className={`shrink-0 ${finishBadgeClassName(polish.finish)}`}>
                  {finishLabel(polish.finish)}
                </Badge>
              )}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground w-12 text-right">
                {((1 - polish.distance) * 100).toFixed(0)}%
              </span>
            </Link>

            {/* Quantity controls */}
            {(onAddFocus || onQuantityChange) && (
              <div className="shrink-0 flex items-center gap-2">
                {onAddFocus && resolveDisplayHex(polish) && (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    className="w-9"
                    title="Add to focused colors"
                    onClick={() => {
                      const h = resolveDisplayHex(polish);
                      if (h) onAddFocus(h);
                    }}
                  >
                    <BsPlusLg className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            )}
            {onQuantityChange && (
              <div className="shrink-0 w-[92px] flex justify-end">
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
