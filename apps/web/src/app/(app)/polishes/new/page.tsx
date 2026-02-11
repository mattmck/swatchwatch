"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";
import { BrandSpinner } from "@/components/brand-spinner";

const FormContent = dynamic(() => import("./polish-form"), {
  ssr: false,
});

export default function PolishPage() {
  return (
    <Suspense fallback={<BrandSpinner label="Loading polish form…" className="min-h-[240px]" />}>
      <FormContent />
    </Suspense>
  );
}
