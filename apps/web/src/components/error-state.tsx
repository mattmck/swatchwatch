import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AlertTriangle, RefreshCw } from "lucide-react";

type ErrorStateProps = {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
};

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div className={cn("flex min-h-[360px] items-center justify-center px-4", className)}>
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-destructive/35 bg-card/95 p-6 text-center shadow-[0_18px_44px_rgba(127,29,29,0.20)]">
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-destructive via-brand-pink to-brand-purple"
        />
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-destructive/12 text-destructive">
          <AlertTriangle className="size-5" />
        </div>
        <div className="mt-4">
          <p className="font-semibold text-destructive">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{message}</p>
        </div>
        {onRetry && (
          <Button variant="outline" size="sm" className="mt-4 gap-1.5" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
