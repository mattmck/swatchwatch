import { cn } from "@/lib/utils";

type BrandSpinnerProps = {
  label?: string;
  className?: string;
};

export function BrandSpinner({ label = "Loading…", className }: BrandSpinnerProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-4 min-h-[400px]", className)}>
      <div className="relative size-10">
        {/* Outer ring */}
        <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-brand-pink border-r-brand-purple" />
        {/* Inner dot */}
        <div className="absolute inset-2 rounded-full bg-gradient-brand opacity-40 animate-pulse" />
      </div>
      <p className="text-sm text-muted-foreground animate-pulse">{label}</p>
    </div>
  );
}
