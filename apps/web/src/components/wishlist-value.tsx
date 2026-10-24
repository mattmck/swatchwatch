"use client";

import { useEffect, useState } from "react";
import { getCollectionStats } from "@/lib/api";
import { wishlistValueViewFromTotals, type WishlistValueView } from "@/lib/wishlist-value";

/**
 * Wishlist value line for the `/polishes` Wishlist view: what the wishlist adds up to in the
 * brands' list prices, one total per currency (never converted or summed across currencies) with
 * unpriced polishes counted. Totals come summed from `GET /api/stats/collection` (every wishlist
 * row, not the visible page); `refreshKey` (e.g. the list total) refetches after quick actions.
 */
export function WishlistValue({ refreshKey }: { refreshKey?: number }) {
  const [view, setView] = useState<WishlistValueView | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCollectionStats()
      .then((stats) => {
        if (cancelled) return;
        // `wishlist` may be missing from a stats response cached before the API added it.
        const wishlist = stats.wishlist ?? null;
        setView(wishlist ? wishlistValueViewFromTotals(wishlist.count, wishlist.listPrices) : null);
      })
      .catch(() => {
        // The header is a nicety: the list itself reports load errors.
        if (!cancelled) setView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (!view) return null;
  return (
    <p className="text-sm text-muted-foreground tabular-nums" data-testid="wishlist-value">
      <span title="Brand list prices when SwatchWatch last checked each store. Not what you paid; currencies are not added together.">
        {view.line}
      </span>
      {view.hasPrices && view.asOf && <span className="ml-1.5 text-[10px]">{view.asOf}</span>}
    </p>
  );
}
