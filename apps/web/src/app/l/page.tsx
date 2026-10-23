import type { Metadata } from "next";
import { Suspense } from "react";
import { BrandSpinner } from "@/components/brand-spinner";
import { PublicLookClient } from "./public-look-client";

/**
 * Public, read-only shared look: `/l/?token=…` (behind the server flag `SHAREABLE_LOOKS_ENABLED`).
 *
 * The app is a static export, so the token is a query parameter instead of a `/l/[token]`
 * segment (same pattern as the shared wishlist at `/w/`). No auth, no app shell. Never indexed,
 * and the token is kept out of `Referer` headers.
 */
export const metadata: Metadata = {
  title: "Shared look",
  description: "A nail look shared from SwatchWatch.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
  referrer: "no-referrer",
  // Don't advertise the token-bearing URL in link previews.
  openGraph: null,
  twitter: null,
};

export default function SharedLookPage() {
  return (
    <Suspense fallback={<BrandSpinner label="Loading look…" className="min-h-[320px]" />}>
      <PublicLookClient />
    </Suspense>
  );
}
