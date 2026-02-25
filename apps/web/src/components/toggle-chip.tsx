import * as React from "react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

type ToggleChipProps = {
  pressed: boolean;
  onPressedChange?: (pressed: boolean) => void;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

export function ToggleChip({
  pressed,
  onPressedChange,
  className,
  children,
  onClick,
  ...props
}: ToggleChipProps) {
  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    onClick?.(event);
    if (event.defaultPrevented) return;
    onPressedChange?.(!pressed);
  }

  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-state={pressed ? "on" : "off"}
      onClick={handleClick}
      className={cn(
        buttonVariants({ variant: pressed ? "default" : "ghost", size: "sm" }),
        "transition-colors",
        pressed
          ? "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        "gap-2 px-3 py-1.5",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
