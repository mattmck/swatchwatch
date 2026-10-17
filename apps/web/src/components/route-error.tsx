"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";
import { trackException } from "@/lib/telemetry";

type RouteErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
  /** Which `error.tsx` caught it; sent as the `boundary` telemetry property. */
  boundary: string;
  className?: string;
};

/** Shared body of the route-group `error.tsx` boundaries: report, then offer a retry. */
export function RouteError({ error, reset, boundary, className }: RouteErrorProps) {
  useEffect(() => {
    trackException(error, { boundary, digest: error.digest });
  }, [error, boundary]);

  return (
    <ErrorState
      message="This page hit an unexpected error. Try again, or reload if it keeps happening."
      onRetry={reset}
      className={className}
    />
  );
}
