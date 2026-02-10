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
        buttonVariants({ variant: "outline", size: "sm" }),
        "border border-brand-lilac/60 bg-white/80 text-brand-ink shadow-[0_6px_16px_rgba(66,16,126,0.08)] transition-colors dark:border-brand-purple/40 dark:bg-brand-purple-deep/30 dark:text-white data-[state=on]:border-brand-purple data-[state=on]:bg-brand-pink-soft/30 data-[state=on]:text-brand-ink data-[state=on]:shadow-[0_14px_32px_rgba(66,16,126,0.25)] data-[state=off]:hover:border-brand-pink/70 data-[state=off]:hover:bg-brand-pink-light/30",
        "gap-2 px-3 py-1.5",
        className,
      )}
      {...props}
    >
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em]">
        {children}
      </span>
    </button>
  );
}
