"use client";

import { useState, type FormEvent } from "react";
import { batchHeaderLabel, type StickyHints } from "swatchwatch-shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FinishOption } from "@/lib/finish-options";

const ANY_FINISH = "__any__";

export interface BatchBrandFieldProps {
  hints: StickyHints;
  finishOptions: readonly FinishOption[];
  /** Start "going through" this brand (finish and collection are optional). */
  onConfirm: (next: { brand: string; finish: string | null; collection: string | null }) => void;
  onDone: () => void;
}

/**
 * "I'm going through one brand": a brand (plus an optional finish and collection) that every
 * bottle of the batch starts with. Confirmed, it becomes the "Going through: <brand> · Done" header.
 */
export function BatchBrandField({ hints, finishOptions, onConfirm, onDone }: BatchBrandFieldProps) {
  const [brand, setBrand] = useState("");
  const [finish, setFinish] = useState<string>(ANY_FINISH);
  const [collection, setCollection] = useState("");
  const header = batchHeaderLabel(hints);

  if (header) {
    const extras = [hints.finish, hints.collection].filter(Boolean).join(" · ");
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand-purple/30 bg-brand-pink-light/15 px-3 py-2">
        <p className="min-w-0 text-sm font-medium">
          <span className="truncate">{header}</span>
          {extras && <span className="ml-2 text-xs font-normal text-muted-foreground">{extras}</span>}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }

  const canConfirm = brand.trim().length > 0;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canConfirm) return;
    onConfirm({
      brand: brand.trim(),
      finish: finish === ANY_FINISH ? null : finish,
      collection: collection.trim() || null,
    });
    setBrand("");
    setFinish(ANY_FINISH);
    setCollection("");
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex gap-2">
        <Input
          aria-label="Brand for this batch"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          placeholder="Going through one brand? Type it (e.g. OPI)"
        />
        <Button type="submit" variant="outline" disabled={!canConfirm}>
          Confirm
        </Button>
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">More hints</summary>
        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
          <Select value={finish} onValueChange={setFinish}>
            <SelectTrigger aria-label="Finish for this batch">
              <SelectValue placeholder="Finish (optional)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_FINISH}>Any finish</SelectItem>
              {finishOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Collection for this batch"
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder="Collection (optional)"
          />
        </div>
      </details>
    </form>
  );
}
