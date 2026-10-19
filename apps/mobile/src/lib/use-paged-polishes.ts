import { useCallback, useEffect, useState } from "react";
import type { Polish, PolishFilters } from "swatchwatch-shared";
import { errorMessage, listPolishes } from "@/api/client";

const PAGE_SIZE = 30;

export interface PagedPolishes {
  items: Polish[];
  total: number;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => void;
  loadMore: () => void;
  /** Replace one row in place (after a quick action) without refetching. */
  replace: (polish: Polish) => void;
}

interface Loaded {
  /** Filter set these rows belong to (JSON). */
  key: string;
  items: Polish[];
  total: number;
  page: number;
}

/**
 * Infinite-scroll pages of `GET /api/polishes` for a filter set. A filter change starts over
 * from page 1 (`loading` until it arrives); responses for an older filter set are dropped.
 */
export function usePagedPolishes(filters: PolishFilters): PagedPolishes {
  const key = JSON.stringify(filters);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  /** Fetch one page and merge it; `isStale` drops answers for a filter set no longer shown. */
  const fetchPage = useCallback(
    (forKey: string, page: number, isStale: () => boolean = () => false): Promise<void> =>
      listPolishes({ ...(JSON.parse(forKey) as PolishFilters), page, pageSize: PAGE_SIZE }).then(
        (res) => {
          if (isStale()) return;
          setLoaded((prev) => {
            if (page === 1 || !prev || prev.key !== forKey) {
              return { key: forKey, items: res.polishes, total: res.total, page };
            }
            const seen = new Set(prev.items.map((p) => p.id));
            return {
              key: forKey,
              items: [...prev.items, ...res.polishes.filter((p) => !seen.has(p.id))],
              total: res.total,
              page,
            };
          });
          setFailed(null);
        },
        (err: unknown) => {
          if (!isStale()) setFailed({ key: forKey, message: errorMessage(err, "Couldn't load your polishes.") });
        },
      ),
    [],
  );

  useEffect(() => {
    let stale = false;
    void fetchPage(key, 1, () => stale);
    return () => {
      stale = true;
    };
  }, [fetchPage, key]);

  const current = loaded?.key === key ? loaded : null;
  const error = failed?.key === key ? failed.message : null;
  const items = current?.items ?? [];
  const total = current?.total ?? 0;
  const hasMore = items.length < total;
  const loading = !current && !error;

  const refresh = useCallback(() => {
    setRefreshing(true);
    void fetchPage(key, 1).finally(() => setRefreshing(false));
  }, [fetchPage, key]);

  const loadMore = useCallback(() => {
    if (!current || loadingMore || refreshing || !hasMore) return;
    setLoadingMore(true);
    void fetchPage(key, current.page + 1).finally(() => setLoadingMore(false));
  }, [current, fetchPage, hasMore, key, loadingMore, refreshing]);

  const replace = useCallback((polish: Polish) => {
    setLoaded((prev) => (prev ? { ...prev, items: prev.items.map((p) => (p.id === polish.id ? polish : p)) } : prev));
  }, []);

  return { items, total, loading, refreshing, loadingMore, error, hasMore, refresh, loadMore, replace };
}
