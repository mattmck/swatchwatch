import type { PolishListResponse } from "swatchwatch-shared";
import PolishDetailClient from "./polish-detail-client";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7071/api";

// `output: "export"` requires generateStaticParams to return at least one entry.
// We fetch current polish IDs from the API at build time. If the API is
// unreachable we fall back to a placeholder so the build still succeeds —
// the client component handles any ID at runtime via SWA's navigation fallback.
export async function generateStaticParams(): Promise<Array<{ id: string }>> {
  try {
    const response = await fetch(`${API_BASE_URL}/polishes`);
    if (!response.ok) return [{ id: "0" }];
    const data = (await response.json()) as PolishListResponse;
    const params = data.polishes.map((p) => ({ id: String(p.id) }));
    return params.length > 0 ? params : [{ id: "0" }];
  } catch {
    return [{ id: "0" }];
  }
}

export default async function PolishDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PolishDetailClient id={id} />;
}
