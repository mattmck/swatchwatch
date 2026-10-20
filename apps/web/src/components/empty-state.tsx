import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SwatchWatchIcon } from "@/components/brand/swatchwatch-brand";
import { cn } from "@/lib/utils";

type EmptyStateAction = {
  label: string;
  /** Link target; without it the action renders as a button that calls `onClick`. */
  href?: string;
  onClick?: () => void;
};

type EmptyStateProps = {
  title: string;
  description: string;
  /** Icon in the badge; defaults to the SwatchWatch monogram. */
  icon?: LucideIcon;
  actionLabel?: string;
  actionHref?: string;
  /** Called when the primary action is used (telemetry), or the action itself when there is no href. */
  onAction?: () => void;
  /** A quieter second action, e.g. "Import" next to "Browse the catalog". */
  secondaryAction?: EmptyStateAction;
  className?: string;
};

/**
 * One empty state for every page: what the page will show once there is data, and the single best
 * next action. Copy rules: one sentence of body, warm, no exclamation marks.
 */
export function EmptyState({
  title,
  description,
  icon: Icon,
  actionLabel,
  actionHref,
  onAction,
  secondaryAction,
  className,
}: EmptyStateProps) {
  const hasPrimary = Boolean(actionLabel && (actionHref || onAction));
  return (
    <div className={cn("flex min-h-[300px] items-center justify-center px-4 py-8", className)}>
      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-brand-purple/20 bg-card/90 p-6 text-center shadow-[0_20px_48px_rgba(66,16,126,0.12)]">
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-lilac to-brand-purple"
        />
        <div className="mx-auto inline-flex size-14 items-center justify-center rounded-full bg-gradient-brand-soft text-brand-purple-deep shadow-glow-brand dark:text-white">
          {Icon ? (
            <Icon className="size-6" aria-hidden="true" />
          ) : (
            <SwatchWatchIcon name="monogram" size={30} title="SwatchWatch" />
          )}
        </div>
        <div className="mt-4">
          <p className="font-semibold text-foreground">{title}</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
        </div>
        {(hasPrimary || secondaryAction) && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {hasPrimary &&
              (actionHref ? (
                <Button asChild className="bg-gradient-brand text-white shadow-glow-brand hover:opacity-90">
                  <Link href={actionHref} onClick={onAction}>
                    {actionLabel}
                  </Link>
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={onAction}
                  className="bg-gradient-brand text-white shadow-glow-brand hover:opacity-90"
                >
                  {actionLabel}
                </Button>
              ))}
            {secondaryAction &&
              (secondaryAction.href ? (
                <Button asChild variant="outline">
                  <Link href={secondaryAction.href} onClick={secondaryAction.onClick}>
                    {secondaryAction.label}
                  </Link>
                </Button>
              ) : (
                <Button type="button" variant="outline" onClick={secondaryAction.onClick}>
                  {secondaryAction.label}
                </Button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
