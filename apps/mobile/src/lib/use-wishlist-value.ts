import type { ListPriceFields } from "swatchwatch-shared";
import { useEffect, useMemo, useState } from "react";
import { listAllPolishes } from "@/api/client";
import { readCache, writeCache } from "./api-cache";
import { slimWishlistRows, WISHLIST_VALUE_CACHE_KEY, wishlistValueView, type WishlistValueView } from "./wishlist-value";

/**
 * The wishlist's brand list-price totals: every wishlist row is fetched once per `refreshToken`
 * (not the visible page), shown from the per-user api-cache first (stale-while-revalidate) and
 * saved back slimmed to the price fields. A failed fetch keeps the saved copy; null until
 * something is known, or while `enabled` is false.
 */
export function useWishlistValue(scope: string | undefined, enabled: boolean, refreshToken = 0): WishlistValueView | null {
  const [rows, setRows] = useState<ListPriceFields[] | null>(null);

  useEffect(() => {
    if (!enabled || !scope) return;
    let cancelled = false;
    void readCache<ListPriceFields[]>(scope, WISHLIST_VALUE_CACHE_KEY).then((entry) => {
      // Never replace a fresh response that arrived first.
      if (entry && !cancelled) setRows((current) => current ?? entry.data);
    });
    listAllPolishes({ status: ["wishlist"] })
      .then((fresh) => {
        if (cancelled) return;
        const slim = slimWishlistRows(fresh);
        setRows(slim);
        void writeCache(scope, WISHLIST_VALUE_CACHE_KEY, slim);
      })
      .catch(() => {
        // Offline or failing: keep whatever saved copy is showing.
      });
    return () => {
      cancelled = true;
    };
  }, [scope, enabled, refreshToken]);

  return useMemo(() => (enabled && rows ? wishlistValueView(rows) : null), [enabled, rows]);
}
