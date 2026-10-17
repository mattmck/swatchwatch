import type { Metadata } from "next";
import { Suspense } from "react";
import { BrandSpinner } from "@/components/brand-spinner";
import { PublicWishlistClient } from "./public-wishlist-client";

/**
 * Public, read-only shared wishlist (#268): `/w/?token=…`.
 *
 * The app is a static export, so the token is a query parameter instead of a `/w/[token]`
 * segment (same pattern as `/polishes/detail?id=`). No auth, no app shell. Never indexed, and the
 * token is kept out of `Referer` headers.
 */
export const metadata: Metadata = {
  title: "Wishlist",
  description: "A shared SwatchWatch wishlist.",
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

export default function SharedWishlistPage() {
  return (
    <Suspense fallback={<BrandSpinner label="Loading wishlist…" className="min-h-[320px]" />}>
      <PublicWishlistClient />
    </Suspense>
  );
}
