"use client";

import {
  COLOR_FAMILIES,
  COLOR_FAMILY_LABELS,
  COLOR_FAMILY_SWATCH_HEX,
  type ColorFamily,
} from "swatchwatch-shared";
import { ToggleChip } from "@/components/toggle-chip";
import { colorFamilySwatchBackground, toggleColorFamily } from "@/lib/color-family-filter";
import { cn } from "@/lib/utils";

type ColorFamilyChipsProps = {
  /** Selected families (any-of). Empty means no family filter. */
  value: readonly ColorFamily[];
  onChange: (next: ColorFamily[]) => void;
  className?: string;
};

/**
 * Multi-select color family filter: one swatch-colored toggle chip per family
 * (`COLOR_FAMILIES`), plus an "Any color" chip that clears the selection.
 */
export function ColorFamilyChips({ value, onChange, className }: ColorFamilyChipsProps) {
  const selected = new Set(value);

  return (
    <div
      role="group"
      aria-label="Filter by color family"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      <ToggleChip
        pressed={selected.size === 0}
        onPressedChange={() => onChange([])}
        className="h-7 px-2.5 text-xs"
      >
        Any color
      </ToggleChip>
      {COLOR_FAMILIES.map((family) => {
        const pressed = selected.has(family);
        return (
          <ToggleChip
            key={family}
            pressed={pressed}
            onPressedChange={() => onChange(toggleColorFamily(value, family))}
            className="h-7 gap-1.5 px-2.5 text-xs"
            title={`${COLOR_FAMILY_LABELS[family]} polishes`}
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-block size-3.5 shrink-0 rounded-full border",
                pressed ? "border-primary-foreground/70" : "border-border"
              )}
              style={{ background: colorFamilySwatchBackground(family, COLOR_FAMILY_SWATCH_HEX[family]) }}
            />
            {COLOR_FAMILY_LABELS[family]}
          </ToggleChip>
        );
      })}
    </div>
  );
}
