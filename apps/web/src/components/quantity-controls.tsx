"use client";

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
      <Button variant="outline" size="sm" onClick={onAdd}>
        Add
      </Button>
    );
  }

  return (
    <div className="inline-flex items-center gap-1">
      <Button variant="outline" size="icon-xs" onClick={onDecrement}>
        -
      </Button>
      <span className="w-6 text-center text-sm tabular-nums">{quantity}</span>
      <Button variant="outline" size="icon-xs" onClick={onIncrement}>
        +
      </Button>
    </div>
  );
}
