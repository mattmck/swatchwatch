"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import PolishDetailClient from "./polish-detail-client";
import { ErrorState } from "@/components/error-state";

export default function DetailShell({ fallback }: { fallback?: ReactNode }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const id = searchParams.get("id");

  if (!id) {
    return fallback ?? <ErrorState message="Missing polish id." onRetry={() => router.push("/polishes")} />;
  }

  return <PolishDetailClient id={id} />;
}
