"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";

const ClientContent = dynamic(() => import("./detail-shell"), {
  ssr: false,
  loading: () => <BrandSpinner label="Loading polish details…" className="min-h-[240px]" />,
});

export default function PolishDetailPage() {
  return (
    <Suspense fallback={<BrandSpinner label="Loading polish details…" className="min-h-[240px]" />}>
      <ClientContent fallback={<ErrorState message="Missing polish id." />} />
    </Suspense>
  );
}
