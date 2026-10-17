"use client";

import { BsArchiveFill, BsDashLg, BsPlusLg } from "react-icons/bs";
import { Button } from "@/components/ui/button";

interface QuantityControlsProps {
  /** Whether the polish is in the collection (`status === "owned"`); otherwise an Add button shows. */
  owned: boolean;
  quantity: number;
  onIncrement: () => void;
  onDecrement: () => void;
  onAdd: () => void;
  /** Disables every button (e.g. while a status change for the row is in flight). */
  disabled?: boolean;
}

export function QuantityControls({
  owned,
  quantity,
  onIncrement,
  onDecrement,
  onAdd,
  disabled = false,
}: QuantityControlsProps) {
  if (!owned) {
    return (
      <div className="w-[88px] flex justify-end">
        <Button variant="outline" size="xs" className="w-[88px]" onClick={onAdd} disabled={disabled}>
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
        disabled={disabled}
        aria-label={quantity <= 1 ? "Remove last bottle (moves to Archived)" : "Decrease quantity"}
        title={quantity <= 1 ? "Used up? Moves the polish to Archived" : undefined}
      >
        {quantity <= 1 ? (
          <BsArchiveFill className="h-3 w-3" aria-hidden="true" />
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
        disabled={disabled}
        aria-label="Increase quantity"
      >
        <BsPlusLg className="h-3 w-3" aria-hidden="true" />
      </Button>
    </div>
  );
}
