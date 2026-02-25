import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SwatchWatchIcon } from "@/components/brand/swatchwatch-brand";
import { cn } from "@/lib/utils";

type EmptyStateProps = {
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  className?: string;
};

export function EmptyState({
  title,
  description,
  actionLabel,
  actionHref,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn("flex min-h-[300px] items-center justify-center px-4 py-8", className)}>
      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-brand-purple/20 bg-card/90 p-6 text-center shadow-[0_20px_48px_rgba(66,16,126,0.12)]">
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-lilac to-brand-purple"
        />
        <div className="mx-auto inline-flex size-14 items-center justify-center rounded-full bg-gradient-brand-soft shadow-glow-brand">
          <SwatchWatchIcon name="monogram" size={30} title="SwatchWatch" />
        </div>
        <div className="mt-4">
          <p className="font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {actionLabel && actionHref && (
          <Button asChild className="mt-5 bg-gradient-brand text-white shadow-glow-brand hover:opacity-90">
            <Link href={actionHref}>{actionLabel}</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
