"use client";

import { useMemo, useState } from "react";
import {
  canSubmitCreateCard,
  type CaptureBrandConflict,
  type CaptureBrandRef,
  type CreateCardEdits,
  type CreateCardModel,
} from "swatchwatch-shared";
import { Heart } from "lucide-react";
import { ColorDot } from "@/components/color-dot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useReferenceData } from "@/hooks/use-reference-data";
import { buildFinishOptions } from "@/lib/finish-options";

const NO_FINISH = "__none__";
const FALLBACK_HEX = "#cccccc";

export interface CreateShadeCardProps {
  card: CreateCardModel;
  brandConflict: CaptureBrandConflict | null;
  /** The create request is in flight. */
  creating: boolean;
  onCreate: (edits: CreateCardEdits, status: "owned" | "wishlist") => void;
  /** Leave without adding: the next bottle. */
  onNext: () => void;
  /** Use the brand read from the bottle for the rest of the batch. */
  onSwitchBrand: (read: CaptureBrandRef) => void;
}

/**
 * The "add it as new" card for a bottle the catalog could not match, prefilled from what the
 * photos showed. Nothing is saved until Add or Wishlist is tapped; a brand only read off the
 * bottle has to be confirmed (or edited) first.
 */
export function CreateShadeCard({ card, brandConflict, creating, onCreate, onNext, onSwitchBrand }: CreateShadeCardProps) {
  const { finishTypes } = useReferenceData();
  const finishOptions = useMemo(
    () => buildFinishOptions(finishTypes, card.finish ? [card.finish] : []),
    [finishTypes, card.finish],
  );
  const [edits, setEdits] = useState<CreateCardEdits>({
    brand: card.brand,
    shadeName: card.shadeName,
    hex: card.hex,
    finish: card.finish,
    brandConfirmed: false,
  });
  const submittable = canSubmitCreateCard(card, edits);
  const brandNeedsConfirm = card.brandNeedsConfirm && !edits.brandConfirmed && edits.brand.trim() === card.brand;
  const read = brandConflict?.read;
  const canSwitch = Boolean(read && edits.brand.trim() !== read.name);

  function switchBrand(ref: CaptureBrandRef) {
    setEdits((current) => ({ ...current, brand: ref.name, brandConfirmed: true }));
    onSwitchBrand(ref);
  }

  return (
    <div className="space-y-3 text-foreground">
      <div className="space-y-1">
        <label htmlFor="create-card-brand" className="text-xs font-medium text-muted-foreground">
          Brand
        </label>
        <div className="flex gap-2">
          <Input
            id="create-card-brand"
            value={edits.brand}
            onChange={(e) => setEdits({ ...edits, brand: e.target.value })}
            placeholder="Brand"
          />
          {brandNeedsConfirm && (
            <Button
              type="button"
              variant="outline"
              disabled={!edits.brand.trim()}
              onClick={() => setEdits({ ...edits, brandConfirmed: true })}
            >
              Confirm
            </Button>
          )}
        </div>
        {brandNeedsConfirm && (
          <p className="text-xs text-amber-700 dark:text-amber-400">Read from the bottle, check it.</p>
        )}
        {read && canSwitch && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              You said {brandConflict?.hinted.name}, but this bottle reads {read.name}.
            </span>
            <Button type="button" variant="outline" size="xs" onClick={() => switchBrand(read)}>
              Switch to {read.name}
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <label htmlFor="create-card-name" className="text-xs font-medium text-muted-foreground">
          Shade name
        </label>
        <Input
          id="create-card-name"
          value={edits.shadeName}
          onChange={(e) => setEdits({ ...edits, shadeName: e.target.value })}
          placeholder="Shade name"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="create-card-hex" className="text-xs font-medium text-muted-foreground">
            Color
          </label>
          <div className="flex items-center gap-2">
            <ColorDot hex={edits.hex ?? undefined} size="lg" />
            <input
              id="create-card-hex"
              type="color"
              value={edits.hex ?? FALLBACK_HEX}
              onChange={(e) => setEdits({ ...edits, hex: e.target.value })}
              className="h-9 w-14 cursor-pointer rounded-md border border-border bg-transparent p-1"
            />
            <span className="font-mono text-xs text-muted-foreground">{edits.hex ?? "not set"}</span>
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor="create-card-finish" className="text-xs font-medium text-muted-foreground">
            Finish
          </label>
          <Select
            value={edits.finish ?? NO_FINISH}
            onValueChange={(value) => setEdits({ ...edits, finish: value === NO_FINISH ? null : value })}
          >
            <SelectTrigger id="create-card-finish" aria-label="Finish">
              <SelectValue placeholder="Finish" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_FINISH}>No finish</SelectItem>
              {finishOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="brand" disabled={!submittable || creating} onClick={() => onCreate(edits, "owned")}>
          {creating ? "Adding…" : "Add"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!submittable || creating}
          onClick={() => onCreate(edits, "wishlist")}
        >
          <Heart aria-hidden /> Wishlist
        </Button>
        <Button type="button" variant="ghost" disabled={creating} onClick={onNext}>
          Next
        </Button>
      </div>
    </div>
  );
}
