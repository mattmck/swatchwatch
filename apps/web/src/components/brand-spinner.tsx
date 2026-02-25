import { SwatchWatchIcon } from "@/components/brand/swatchwatch-brand";
import { cn } from "@/lib/utils";

type BrandSpinnerProps = {
  label?: string;
  className?: string;
};

export function BrandSpinner({ label = "Loading…", className }: BrandSpinnerProps) {
  return (
    <div
      className={cn("flex min-h-[360px] flex-col items-center justify-center gap-4 px-4", className)}
      role="status"
      aria-live="polite"
    >
      <div className="relative grid size-16 place-items-center rounded-full bg-gradient-brand-soft/70 shadow-glow-brand">
        <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-brand-pink border-r-brand-purple" />
        <div className="absolute inset-2 rounded-full border border-brand-purple/15 bg-background/80" />
        <div className="relative z-10 animate-pulse">
          <SwatchWatchIcon name="monogram" size={24} />
        </div>
      </div>
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
    </div>
  );
}
