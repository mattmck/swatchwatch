import { useCallback, useEffect, useRef, useState } from "react";
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
  /**
   * Request generation: bumped on every filter change and refresh. A response from an older
   * generation is dropped, so a slow "load more" can never land on a newer list (skipping
   * pages after a refresh, or replacing the rows of a newer filter set).
   */
  const generation = useRef(0);

  const fetchPage = useCallback(
    (forKey: string, page: number, requestGeneration: number): Promise<void> =>
      listPolishes({ ...(JSON.parse(forKey) as PolishFilters), page, pageSize: PAGE_SIZE }).then(
        (res) => {
          if (requestGeneration !== generation.current) return;
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
          if (requestGeneration === generation.current) {
            setFailed({ key: forKey, message: errorMessage(err, "Couldn't load your polishes.") });
          }
        },
      ),
    [],
  );

  useEffect(() => {
    generation.current += 1;
    void fetchPage(key, 1, generation.current);
  }, [fetchPage, key]);

  const current = loaded?.key === key ? loaded : null;
  const error = failed?.key === key ? failed.message : null;
  const items = current?.items ?? [];
  const total = current?.total ?? 0;
  const hasMore = items.length < total;
  const loading = !current && !error;

  const refresh = useCallback(() => {
    // A new generation also cancels an in-flight "load more".
    generation.current += 1;
    setRefreshing(true);
    setLoadingMore(false);
    void fetchPage(key, 1, generation.current).finally(() => setRefreshing(false));
  }, [fetchPage, key]);

  const loadMore = useCallback(() => {
    if (!current || loadingMore || refreshing || !hasMore) return;
    const requestGeneration = generation.current;
    setLoadingMore(true);
    void fetchPage(key, current.page + 1, requestGeneration).finally(() => {
      if (requestGeneration === generation.current) setLoadingMore(false);
    });
  }, [current, fetchPage, hasMore, key, loadingMore, refreshing]);

  const replace = useCallback((polish: Polish) => {
    setLoaded((prev) => (prev ? { ...prev, items: prev.items.map((p) => (p.id === polish.id ? polish : p)) } : prev));
  }, []);

  return { items, total, loading, refreshing, loadingMore, error, hasMore, refresh, loadMore, replace };
}
