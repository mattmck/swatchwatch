"use client";

import {
  PRODUCT_CATEGORIES,
  PRODUCT_CATEGORY_LABELS,
  resolveProductCategory,
  type ProductCategory,
} from "swatchwatch-shared";
import { ToggleChip } from "@/components/toggle-chip";
import { toggleProductCategory } from "@/lib/product-category-filter";
import { cn } from "@/lib/utils";

/**
 * Product-category UI (#349): a small pill naming non-color categories, a neutral swatch for
 * toppers (a topper has no single color, D-D) and the `/polishes` Category chip filter.
 */

/** True when the row should show the neutral topper swatch instead of its hex. */
export function showsTopperSwatch(category: unknown): boolean {
  return resolveProductCategory(category) === "topper";
}

/**
 * Small pill with the category label. Renders nothing for color polishes (the default), so rows
 * stay quiet unless the product is a topper, coat, treatment or accessory.
 */
export function ProductCategoryPill({ category, className }: { category: unknown; className?: string }) {
  const resolved = resolveProductCategory(category);
  if (resolved === "color") return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-muted px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground",
        className
      )}
      title={`Product category: ${PRODUCT_CATEGORY_LABELS[resolved]}`}
    >
      {PRODUCT_CATEGORY_LABELS[resolved]}
    </span>
  );
}

const SWATCH_SIZES = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
  xl: "h-24 w-24",
} as const;

/** Sparkle-on-clear swatch for a topper: neutral, never a color guess. */
export function TopperSwatch({ size = "md", className }: { size?: keyof typeof SWATCH_SIZES; className?: string }) {
  return (
    <span
      role="img"
      aria-label="Topper (no single color)"
      title="Topper: shown over another polish, no single color"
      className={cn("inline-block shrink-0 rounded-full border border-border", SWATCH_SIZES[size], className)}
      style={{
        // Sparkles over a faint iridescent clear base, so it never reads as a white polish.
        background:
          "radial-gradient(circle at 30% 30%, #ffffff 0 11%, transparent 12%), " +
          "radial-gradient(circle at 68% 40%, #8a8aa3 0 9%, transparent 10%), " +
          "radial-gradient(circle at 42% 72%, #ffffff 0 9%, transparent 10%), " +
          "radial-gradient(circle at 74% 74%, #6f6f88 0 7%, transparent 8%), " +
          "conic-gradient(from 210deg, #d8d0f0, #cdeef0, #f3d6e6, #e9e2c8, #d8d0f0)",
      }}
    />
  );
}

type ProductCategoryChipsProps = {
  /** Selected categories (any-of). Empty means every category. */
  value: readonly ProductCategory[];
  onChange: (next: ProductCategory[]) => void;
  className?: string;
};

/** Multi-select Category filter for `/polishes`, plus an "Any category" chip that clears it. */
export function ProductCategoryChips({ value, onChange, className }: ProductCategoryChipsProps) {
  const selected = new Set(value);
  return (
    <div role="group" aria-label="Filter by category" className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <ToggleChip pressed={selected.size === 0} onPressedChange={() => onChange([])} className="h-7 px-2.5 text-xs pointer-coarse:h-9">
        Any category
      </ToggleChip>
      {PRODUCT_CATEGORIES.map((category) => (
        <ToggleChip
          key={category}
          pressed={selected.has(category)}
          onPressedChange={() => onChange(toggleProductCategory(value, category))}
          className="h-7 px-2.5 text-xs pointer-coarse:h-9"
        >
          {PRODUCT_CATEGORY_LABELS[category]}
        </ToggleChip>
      ))}
    </div>
  );
}
