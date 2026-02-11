"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";

const FormContent = dynamic(() => import("./polish-form"), {
  ssr: false,
});

export default function PolishPage() {
  return (
    <Suspense fallback={<div className="min-h-[200px]" aria-live="polite">Loading polish form…</div>}>
      <FormContent />
    </Suspense>
  );
}
