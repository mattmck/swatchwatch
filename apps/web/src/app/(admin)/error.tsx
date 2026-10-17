"use client";

import { RouteError } from "@/components/route-error";

// (admin) has no layout (pages wrap themselves in AppShell), so this renders
// full-screen.
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} boundary="admin" className="min-h-screen" />;
}
