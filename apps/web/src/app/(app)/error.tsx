"use client";

import { RouteError } from "@/components/route-error";

// Renders inside the (app) layout, so the sidebar shell stays usable.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} boundary="app" />;
}
