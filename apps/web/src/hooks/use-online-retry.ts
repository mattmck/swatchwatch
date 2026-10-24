"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * A counter that goes up whenever a retry is wanted: the browser's `online` event, or `retry()`
 * (the saved-copy banner's button). Put it in a fetch effect's dependencies to refetch.
 */
export function useOnlineRetry(): { tick: number; retry: () => void } {
  const [tick, setTick] = useState(0);
  const retry = useCallback(() => setTick((value) => value + 1), []);
  useEffect(() => {
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [retry]);
  return { tick, retry };
}
