"use client";

import { useMemo, useState } from "react";
import { Lock, Star, X } from "lucide-react";
import { toast } from "sonner";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_CATEGORY_LABELS,
  SHADE_FINISHES_MAX,
  type HexLabelQueueItem,
  type ProductCategory,
} from "swatchwatch-shared";
import { setShadeProductCategory } from "@/lib/api";
import { buildFinishOptions, resolveFinishLabel } from "@/lib/finish-options";
import { applyCategoryResponse, finishesChanged, makePrimaryFinish, toggleFinish } from "@/lib/shade-classification";
import { useReferenceData } from "@/hooks/use-reference-data";
import { ToggleChip } from "@/components/toggle-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { finishBadgeClassName } from "@/lib/constants";
import { cn } from "@/lib/utils";

export interface ShadeClassificationEditorProps {
  item: HexLabelQueueItem;
  /** Ordered draft finish list (primary first), owned by the labeler so its Save can flush it. */
  draftFinishes: string[];
  onDraftFinishesChange: (finishes: string[]) => void;
  /** Persist the draft (`PUT /api/shades-admin/{id}/finishes`). */
  onSaveFinishes: () => void;
  savingFinishes: boolean;
  disabled: boolean;
  /** Receives the item after a category change. */
  onItemChange: (item: HexLabelQueueItem) => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Category and finish pills in the Hex Labeling tool: mark a shade as a topper, coat, treatment or
 * accessory (saved on click, sticky `product_category_source = 'admin'`), and pick its finishes
 * from the finish catalog (saved with the label, or with "Save finishes"; sticky
 * `finishes_source = 'admin'`, so ingestion never re-adds a removed finish).
 */
export function ShadeClassificationEditor({
  item,
  draftFinishes,
  onDraftFinishesChange,
  onSaveFinishes,
  savingFinishes,
  disabled,
  onItemChange,
}: ShadeClassificationEditorProps) {
  const { finishTypes } = useReferenceData();
  const [savingCategory, setSavingCategory] = useState<ProductCategory | null>(null);
  const options = useMemo(() => buildFinishOptions(finishTypes, item.finishes), [finishTypes, item.finishes]);
  const dirty = finishesChanged(item.finishes, draftFinishes);
  const busy = disabled || savingCategory !== null || savingFinishes;

  async function chooseCategory(category: ProductCategory) {
    if (busy || category === item.productCategory) return;
    if (
      category === "accessory" &&
      !window.confirm("Mark as an accessory? Accessories nobody holds are hidden from the catalog and search.")
    ) {
      return;
    }
    setSavingCategory(category);
    try {
      const response = await setShadeProductCategory(item.shadeId, category);
      onItemChange(applyCategoryResponse(item, response));
      toast.success(`Marked as ${PRODUCT_CATEGORY_LABELS[category].toLowerCase()}`, {
        description:
          category === "color" ? undefined : "Not a color polish, so it leaves the labeling queue. No hex needed.",
      });
    } catch (error) {
      toast.error("Failed to set the category", { description: errorMessage(error, "Request failed") });
    } finally {
      setSavingCategory(null);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-1">
        <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          Type
          {item.productCategorySource === "admin" ? (
            <Lock className="size-3" aria-label="Set by an admin" />
          ) : null}
        </span>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Product type">
          {PRODUCT_CATEGORIES.map((category) => (
            <ToggleChip
              key={category}
              pressed={item.productCategory === category}
              onPressedChange={() => void chooseCategory(category)}
              disabled={busy}
              role="radio"
              aria-checked={item.productCategory === category}
              className="px-2 py-1 text-xs"
            >
              {savingCategory === category ? "Saving…" : PRODUCT_CATEGORY_LABELS[category]}
            </ToggleChip>
          ))}
        </div>
        {item.productCategory !== "color" ? (
          <p className="text-xs text-muted-foreground">
            Not a color polish: it leaves the labeling queue on the next load, so skip it unless you still want a hex.
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          Finishes
          {item.finishesSource === "admin" ? <Lock className="size-3" aria-label="Set by an admin" /> : null}
          <span className="font-normal">· first is primary, click a selected one to make it primary</span>
        </span>
        <div className="flex min-h-7 flex-wrap items-center gap-1" aria-label="Selected finishes">
          {draftFinishes.length === 0 ? <span className="text-xs text-muted-foreground">No finish</span> : null}
          {draftFinishes.map((finish, index) => (
            <Badge key={finish} className={cn("gap-1 pr-1", finishBadgeClassName(finish))}>
              <button
                type="button"
                className="inline-flex items-center gap-1"
                disabled={busy || index === 0}
                title={index === 0 ? "Primary finish" : "Make primary"}
                onClick={() => onDraftFinishesChange(makePrimaryFinish(draftFinishes, finish))}
              >
                {index === 0 ? <Star className="size-3 fill-current" aria-label="Primary" /> : null}
                {resolveFinishLabel(finish, finishTypes)}
              </button>
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove ${resolveFinishLabel(finish, finishTypes)}`}
                className="rounded-sm opacity-70 hover:opacity-100"
                onClick={() => onDraftFinishesChange(toggleFinish(draftFinishes, finish))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex flex-wrap gap-1" aria-label="All finishes">
          {options.map((option) => {
            const selected = draftFinishes.includes(option.value);
            return (
              <ToggleChip
                key={option.value}
                pressed={selected}
                disabled={busy || (!selected && draftFinishes.length >= SHADE_FINISHES_MAX)}
                onPressedChange={() => onDraftFinishesChange(toggleFinish(draftFinishes, option.value))}
                className="px-2 py-0.5 text-xs"
              >
                {option.label}
              </ToggleChip>
            );
          })}
        </div>
        {dirty ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button type="button" size="sm" onClick={onSaveFinishes} disabled={busy}>
              {savingFinishes ? "Saving…" : "Save finishes"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => onDraftFinishesChange(item.finishes)} disabled={busy}>
              Reset
            </Button>
            <span className="text-xs text-muted-foreground">Also saved with the label.</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
