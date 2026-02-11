"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";
import { ErrorState } from "@/components/error-state";

const ClientContent = dynamic(() => import("./detail-shell"), {
  ssr: false,
  loading: () => <div className="min-h-[200px]" aria-live="polite">Loading polish…</div>,
});

export default function PolishDetailPage() {
  return (
    <Suspense fallback={<div className="min-h-[200px]" aria-live="polite">Loading polish…</div>}>
      <ClientContent fallback={<ErrorState message="Missing polish id." />} />
    </Suspense>
  );
}
