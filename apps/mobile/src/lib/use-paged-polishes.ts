import { useCallback, useEffect, useRef, useState } from "react";
import type { Polish, PolishFilters } from "swatchwatch-shared";
import { errorMessage, listPolishes } from "@/api/client";
import { readCache, writeCache } from "./api-cache";
import { polishFiltersKey } from "./collection-filters";

const PAGE_SIZE = 30;

export interface PagedPolishes {
  items: Polish[];
  total: number;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  /** The rows on screen are a saved copy; the fresh response hasn't arrived (or failed). */
  fromCache: boolean;
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
  /** Saved copy from the persisted cache, shown until the fresh page 1 replaces it. */
  cached?: boolean;
}

/**
 * Infinite-scroll pages of `GET /api/polishes` for a filter set. A filter change starts over
 * from page 1 (`loading` until it arrives); responses for an older filter set are dropped.
 */
export function usePagedPolishes(filters: PolishFilters, cacheScope?: string): PagedPolishes {
  const key = polishFiltersKey(filters);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /**
   * The "load more" in flight: its filter set (key), so a filter change clears `loadingMore`
   * without touching state, and a per-request id, so only that request clears it.
   */
  const [loadingMoreRequest, setLoadingMoreRequest] = useState<{ key: string; id: number } | null>(null);
  const loadingMore = loadingMoreRequest?.key === key;
  const loadMoreId = useRef(0);
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
          if (page === 1 && cacheScope && !JSON.parse(forKey).search) {
            // Page 1 of each filter set (not free-text searches) is kept for the next launch.
            void writeCache(cacheScope, `polishes:${forKey}`, { items: res.polishes, total: res.total });
          }
          setLoaded((prev) => {
            if (page === 1) {
              return { key: forKey, items: res.polishes, total: res.total, page };
            }
            // Append page N only onto pages 1..N-1 of the same filter set. A page asked for from
            // rows that page 1 has since replaced (A → B → A while A's old rows were on screen)
            // would leave a gap, so it's dropped and the next "load more" asks for the right page.
            if (!prev || prev.key !== forKey || prev.page !== page - 1) return prev;
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
    [cacheScope],
  );

  useEffect(() => {
    generation.current += 1;
    const requestGeneration = generation.current;
    void fetchPage(key, 1, requestGeneration);
    if (!cacheScope) return;
    // Stale-while-revalidate: show the saved page 1 right away unless fresh data got there first.
    void readCache<{ items: Polish[]; total: number }>(cacheScope, `polishes:${key}`).then((entry) => {
      if (!entry || requestGeneration !== generation.current) return;
      setLoaded((prev) =>
        prev?.key === key ? prev : { key, items: entry.data.items, total: entry.data.total, page: 1, cached: true },
      );
    });
  }, [fetchPage, key, cacheScope]);

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
    setLoadingMoreRequest(null);
    void fetchPage(key, 1, generation.current).finally(() => setRefreshing(false));
  }, [fetchPage, key]);

  const loadMore = useCallback(() => {
    if (!current || loadingMore || refreshing || !hasMore) return;
    const requestGeneration = generation.current;
    loadMoreId.current += 1;
    const id = loadMoreId.current;
    setLoadingMoreRequest({ key, id });
    void fetchPage(key, current.page + 1, requestGeneration).finally(() => {
      // Clear the flag whenever it is still this request's, even if a filter change made the
      // request stale (otherwise A → B → A while it was in flight leaves A's pagination
      // blocked), but never a newer request's, such as a "load more" started after a refresh.
      setLoadingMoreRequest((active) => (active?.id === id ? null : active));
    });
  }, [current, fetchPage, hasMore, key, loadingMore, refreshing]);

  const replace = useCallback((polish: Polish) => {
    setLoaded((prev) => (prev ? { ...prev, items: prev.items.map((p) => (p.id === polish.id ? polish : p)) } : prev));
  }, []);

  return { items, total, loading, refreshing, loadingMore, error, hasMore, fromCache: Boolean(current?.cached), refresh, loadMore, replace };
}
