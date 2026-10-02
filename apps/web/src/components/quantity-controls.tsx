"use client";

import { BsDashLg, BsPlusLg, BsTrash3Fill } from "react-icons/bs";
import { Button } from "@/components/ui/button";

interface QuantityControlsProps {
  quantity: number;
  onIncrement: () => void;
  onDecrement: () => void;
  onAdd: () => void;
}

export function QuantityControls({
  quantity,
  onIncrement,
  onDecrement,
  onAdd,
}: QuantityControlsProps) {
  if (quantity <= 0) {
    return (
      <div className="w-[88px] flex justify-end">
        <Button variant="outline" size="xs" className="w-[88px]" onClick={onAdd}>
          Add
        </Button>
      </div>
    );
  }

  return (
    <div className="inline-flex w-[88px] items-center justify-between gap-1">
      <Button
        variant="outline"
        size="icon-xs"
        onClick={onDecrement}
        aria-label={quantity === 1 ? "Remove from collection" : "Decrease quantity"}
      >
        {quantity === 1 ? (
          <BsTrash3Fill className="h-3 w-3" aria-hidden="true" />
        ) : (
          <BsDashLg className="h-3 w-3" aria-hidden="true" />
        )}
      </Button>
      <span
        className="w-6 text-center text-sm tabular-nums"
        aria-live="polite"
        aria-atomic="true"
      >
        {quantity}
      </span>
      <Button
        variant="outline"
        size="icon-xs"
        onClick={onIncrement}
        aria-label="Increase quantity"
      >
        <BsPlusLg className="h-3 w-3" aria-hidden="true" />
      </Button>
    </div>
  );
}
