/**
 * Rapid Add's sticky ("going through this brand") hints, kept per user in localStorage so a
 * reload or a later shopping trip resumes the batch. Every access is guarded: blocked or
 * full storage just means the hints do not survive.
 */
import {
  EMPTY_STICKY_HINTS,
  STICKY_HINTS_STORAGE_PREFIX,
  isBatchMode,
  parseStickyHints,
  serializeStickyHints,
  stickyHintsStorageKey,
  type StickyHints,
} from "swatchwatch-shared";

type HintsStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStickyHints(storage: HintsStore | null | undefined, userId: string | null | undefined): StickyHints {
  if (!storage) return EMPTY_STICKY_HINTS;
  try {
    return parseStickyHints(storage.getItem(stickyHintsStorageKey(userId)));
  } catch {
    return EMPTY_STICKY_HINTS;
  }
}

/** Stores the hints; removes the key when nothing is worth remembering (no brand, finish or collection). */
export function writeStickyHints(
  storage: HintsStore | null | undefined,
  userId: string | null | undefined,
  hints: StickyHints,
): void {
  if (!storage) return;
  try {
    const key = stickyHintsStorageKey(userId);
    if (!isBatchMode(hints) && !hints.finish && !hints.collection) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, serializeStickyHints(hints));
    }
  } catch {
    // Quota or blocked storage: the hints just don't survive a reload.
  }
}

/** Remove every user's hints (sign-out). */
export function clearStickyHints(storage: HintsStore | null | undefined): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && (key === STICKY_HINTS_STORAGE_PREFIX || key.startsWith(`${STICKY_HINTS_STORAGE_PREFIX}:`))) {
        keys.push(key);
      }
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Blocked storage holds nothing to clear.
  }
}
