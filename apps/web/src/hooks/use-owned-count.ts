"use client";

import { useEffect, useState } from "react";
import { listPolishes } from "@/lib/api";

/**
 * How many polishes the caller owns, from the list `total` of a one-row page (no over-fetch).
 * `null` while loading or when the request fails, so callers never show an empty state by mistake.
 */
export function useOwnedCount(): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    listPolishes({ status: ["owned"], page: 1, pageSize: 1 })
      .then((page) => {
        if (active) setCount(page.total);
      })
      .catch(() => {
        // Unknown: keep the normal page rather than claiming the collection is empty.
      });
    return () => {
      active = false;
    };
  }, []);

  return count;
}
