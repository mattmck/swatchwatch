/**
 * Stale-while-revalidate cache for the owned collection (web twin of
 * `apps/mobile/src/lib/api-cache.ts`), so `/polishes` (My Collection) and the detail page of an
 * owned polish open from the last loaded copy when the API cannot be reached (a shop with poor
 * signal).
 *
 * - localStorage, per signed-in user (the key carries the user), versioned, 7-day expiry.
 * - Only public data: private owner-scoped `v3` media URLs are stripped before writing and the
 *   bytes of private images are never stored (those load through `PrivateImage` in memory).
 * - Size guard: an entry is capped at `MAX_ENTRY_CHARS` (list rows are dropped from the end) and
 *   the whole cache at `MAX_TOTAL_CHARS` (oldest entries evicted), so it cannot fill the quota.
 * - Wiped on sign-out (`clearApiCache`) and whenever a different user signs in.
 * - Every storage call is wrapped: private windows and quota errors just mean no saved copy.
 */
import type { Polish, PolishListResponse } from "swatchwatch-shared";
import { buildPolishesListQueryString, type PolishesListState } from "./polish-list-url";

export const API_CACHE_VERSION = 1;
export const API_CACHE_PREFIX = "swatchwatch:api-cache:";
const USER_MARKER_KEY = `${API_CACHE_PREFIX}user`;
export const API_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ENTRY_CHARS = 300_000;
export const MAX_TOTAL_CHARS = 1_500_000;
export const MAX_LIST_ENTRIES = 6;
export const MAX_DETAIL_ENTRIES = 40;

export type CacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export interface CacheEntry<T> {
  v: number;
  savedAt: number;
  data: T;
}

export interface CachedValue<T> {
  data: T;
  savedAt: number;
}

export interface CacheContext {
  storage: CacheStorage;
  /** Stable id of the signed-in user (an opaque account id, never an email). */
  userKey: string;
  now: number;
}

/** Owner-scoped private image ids (`/api/images/v3.…`); never cached. */
const PRIVATE_IMAGE_PATTERN = /\/api\/images\/v3\./;

/** Deep copy of `value` with every string that is a private `v3` image URL removed. */
export function stripPrivateMedia<T>(value: T): T {
  if (typeof value === "string") {
    return (PRIVATE_IMAGE_PATTERN.test(value) ? undefined : value) as T;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => stripPrivateMedia(item))
      .filter((item) => item !== undefined) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripPrivateMedia(item);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out as T;
  }
  return value;
}

function entryKey(userKey: string, name: string): string {
  return `${API_CACHE_PREFIX}v${API_CACHE_VERSION}:${encodeURIComponent(userKey)}:${name}`;
}

/** Cache name of the owned list for one canonical filter query (see `buildPolishesListQueryString`). */
export function ownedListCacheName(queryString: string): string {
  return `owned-list:${queryString}`;
}

/**
 * Canonical query string to cache the list under, or null when the view is not cached: only the
 * first page of the "My Collection" preset (`status=owned` alone) is saved, with any search /
 * finish / family / category / sort filters part of the key. The tone filter loads the whole
 * list client-side, so it is never cached.
 */
export function ownedListCacheQuery(state: PolishesListState): string | null {
  if (state.statuses.length !== 1 || state.statuses[0] !== "owned") return null;
  if (state.toneFilter !== "all" || state.page !== 1) return null;
  return buildPolishesListQueryString(state);
}

export function polishDetailCacheName(id: string | number): string {
  return `polish:${id}`;
}

function ownKeys(storage: CacheStorage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && key.startsWith(API_CACHE_PREFIX) && key !== USER_MARKER_KEY) keys.push(key);
  }
  return keys;
}

function parseEntry(raw: string | null): CacheEntry<unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CacheEntry<unknown>> | null;
    if (!parsed || parsed.v !== API_CACHE_VERSION || typeof parsed.savedAt !== "number" || !("data" in parsed)) {
      return null;
    }
    return parsed as CacheEntry<unknown>;
  } catch {
    return null;
  }
}

export function readCache<T>(ctx: CacheContext, name: string): CachedValue<T> | null {
  const key = entryKey(ctx.userKey, name);
  try {
    const entry = parseEntry(ctx.storage.getItem(key));
    if (!entry) return null;
    if (ctx.now - entry.savedAt > API_CACHE_TTL_MS || entry.savedAt > ctx.now + 60_000) {
      ctx.storage.removeItem(key);
      return null;
    }
    return { data: entry.data as T, savedAt: entry.savedAt };
  } catch {
    return null;
  }
}

/** Entries of this user and kind, oldest first. Unreadable entries are removed. */
function entriesOfKind(ctx: CacheContext, kindPrefix: string) {
  const prefix = entryKey(ctx.userKey, kindPrefix);
  const found: { key: string; savedAt: number }[] = [];
  for (const key of ownKeys(ctx.storage)) {
    if (!key.startsWith(prefix)) continue;
    const entry = parseEntry(ctx.storage.getItem(key));
    if (!entry) {
      ctx.storage.removeItem(key);
      continue;
    }
    found.push({ key, savedAt: entry.savedAt });
  }
  return found.sort((a, b) => a.savedAt - b.savedAt);
}

/** Drop the oldest entries (of any kind) until the cache plus `extraChars` fits the budget. */
function evictToFit(ctx: CacheContext, keepKey: string, extraChars: number): void {
  const all = ownKeys(ctx.storage)
    .filter((key) => key !== keepKey)
    .map((key) => {
      const raw = ctx.storage.getItem(key);
      return { key, savedAt: parseEntry(raw)?.savedAt ?? 0, size: raw?.length ?? 0 };
    })
    .sort((a, b) => a.savedAt - b.savedAt);
  let total = all.reduce((sum, item) => sum + item.size, 0) + extraChars;
  for (const item of all) {
    if (total <= MAX_TOTAL_CHARS) break;
    ctx.storage.removeItem(item.key);
    total -= item.size;
  }
}

/**
 * Serialize `data` and store it. `shrink` returns a smaller copy when the entry is over
 * `MAX_ENTRY_CHARS` (or null when it cannot shrink, which skips the write).
 */
function writeEntry<T>(
  ctx: CacheContext,
  name: string,
  kindPrefix: string,
  maxEntries: number,
  data: T,
  shrink?: (data: T) => T | null,
): boolean {
  const key = entryKey(ctx.userKey, name);
  try {
    let current: T | null = stripPrivateMedia(data);
    let serialized = "";
    while (current !== null) {
      serialized = JSON.stringify({ v: API_CACHE_VERSION, savedAt: ctx.now, data: current } satisfies CacheEntry<T>);
      if (serialized.length <= MAX_ENTRY_CHARS) break;
      current = shrink ? shrink(current) : null;
    }
    if (current === null) return false;

    const sameKind = entriesOfKind(ctx, kindPrefix).filter((item) => item.key !== key);
    for (const stale of sameKind.slice(0, Math.max(0, sameKind.length - (maxEntries - 1)))) {
      ctx.storage.removeItem(stale.key);
    }
    evictToFit(ctx, key, serialized.length);
    try {
      ctx.storage.setItem(key, serialized);
    } catch {
      // Quota: free everything else of ours and try once more.
      for (const other of ownKeys(ctx.storage)) if (other !== key) ctx.storage.removeItem(other);
      ctx.storage.setItem(key, serialized);
    }
    return true;
  } catch {
    return false;
  }
}

/** Halve a list page's rows (the true `total` is kept so the UI still knows how many exist). */
function shrinkList(page: PolishListResponse): PolishListResponse | null {
  if (page.polishes.length <= 1) return null;
  return { ...page, polishes: page.polishes.slice(0, Math.floor(page.polishes.length / 2)) };
}

export function writeOwnedList(ctx: CacheContext, queryString: string, page: PolishListResponse): boolean {
  return writeEntry(ctx, ownedListCacheName(queryString), "owned-list:", MAX_LIST_ENTRIES, page, shrinkList);
}

export function readOwnedList(ctx: CacheContext, queryString: string): CachedValue<PolishListResponse> | null {
  return readCache<PolishListResponse>(ctx, ownedListCacheName(queryString));
}

export function writePolishDetail(ctx: CacheContext, polish: Polish): boolean {
  return writeEntry(ctx, polishDetailCacheName(polish.id), "polish:", MAX_DETAIL_ENTRIES, polish);
}

export function removePolishDetail(ctx: CacheContext, id: string | number): void {
  try {
    ctx.storage.removeItem(entryKey(ctx.userKey, polishDetailCacheName(id)));
  } catch {
    // Best effort.
  }
}

export function readPolishDetail(ctx: CacheContext, id: string | number): CachedValue<Polish> | null {
  return readCache<Polish>(ctx, polishDetailCacheName(id));
}

/** Remove every cached entry (all users). */
export function clearCache(storage: CacheStorage): void {
  try {
    for (const key of [...ownKeys(storage), USER_MARKER_KEY]) storage.removeItem(key);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

/**
 * Remember who the cache belongs to; entries left by a different user are removed so one
 * account's collection never lingers for the next sign-in on a shared browser.
 */
export function bindCacheUser(storage: CacheStorage, userKey: string): void {
  try {
    const previous = storage.getItem(USER_MARKER_KEY);
    if (previous !== null && previous !== userKey) clearCache(storage);
    storage.setItem(USER_MARKER_KEY, userKey);
  } catch {
    // Binding is best effort.
  }
}

// --- Browser bindings -----------------------------------------------------------------------

let currentUserKey: string | null = null;

function browserStorage(): CacheStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Dev bypass has one fixed identity; MSAL accounts register theirs with `setApiCacheUser`. */
function resolveUserKey(): string | null {
  if (currentUserKey) return currentUserKey;
  return process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true" ? "dev:1" : null;
}

/** Called by the auth provider with the signed-in account id (null on sign-out). */
export function setApiCacheUser(userKey: string | null): void {
  currentUserKey = userKey;
  const storage = browserStorage();
  if (storage && userKey) bindCacheUser(storage, userKey);
}

/** Context for the current user, or null when nobody is identified or storage is unavailable. */
export function currentCacheContext(now: number = Date.now()): CacheContext | null {
  const storage = browserStorage();
  const userKey = resolveUserKey();
  if (!storage || !userKey) return null;
  return { storage, userKey, now };
}

/** Wipe the saved copies (sign-out). */
export function clearApiCache(): void {
  currentUserKey = null;
  const storage = browserStorage();
  if (storage) clearCache(storage);
}
