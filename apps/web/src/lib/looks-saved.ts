import type { SavedLook, SavedLookStep } from "swatchwatch-shared";
import { MAX_SAVED_LOOKS, savedLookKey, validateSavedLookInput } from "swatchwatch-shared";
import type { Look, Vibe } from "./looks";

/**
 * Saved looks. The source of truth is the caller's `user_look` rows (`GET/POST/DELETE /api/looks`).
 * localStorage keeps two lists:
 *
 * - **pending** (`SAVED_LOOKS_PENDING_KEY`): saves the server has not accepted yet (offline, an API
 *   without the endpoint, or looks saved before it existed, which used this same key). They are
 *   uploaded on the next successful load (`looksToUpload`) and then cleared.
 * - **cache** (`SAVED_LOOKS_CACHE_KEY`): the last list the server returned, shown while loading or
 *   offline. It is never uploaded, so a look deleted on another device does not come back.
 *
 * Only what is needed to show the look again and re-wear it is stored: names, hexes, roles and
 * shade ids.
 */
export { MAX_SAVED_LOOKS };
export type { SavedLook, SavedLookStep };

/** Saves not yet on the server (the pre-endpoint key, so older local saves upload once). */
export const SAVED_LOOKS_PENDING_KEY = "swatchwatch.looks.saved.v1";
/** The last server list, for display while loading or offline. */
export const SAVED_LOOKS_CACHE_KEY = "swatchwatch.looks.cache.v1";

export function toSavedLook(look: Look, vibe: Vibe, now: Date): SavedLook {
  const steps: SavedLookStep[] = look.steps.map((step) => ({
    role: step.role,
    label: step.label,
    hex: step.hex,
    source: step.source,
    ...(step.polish ? { shadeId: step.polish.id, brand: step.polish.brand, name: step.polish.name } : {}),
  }));
  return {
    id: savedLookKey(look.templateId, steps),
    templateId: look.templateId,
    name: look.name,
    savedAt: now.toISOString(),
    vibe,
    steps,
  };
}

/** Newest first, deduped by id, capped at `MAX_SAVED_LOOKS`. */
export function addSavedLook(list: readonly SavedLook[], look: SavedLook): SavedLook[] {
  return [look, ...list.filter((l) => l.id !== look.id)].slice(0, MAX_SAVED_LOOKS);
}

export function removeSavedLook(list: readonly SavedLook[], id: string): SavedLook[] {
  return list.filter((l) => l.id !== id);
}

/** A stored or fetched look, validated by the same rule as the API; null when malformed. */
export function toValidSavedLook(value: unknown): SavedLook | null {
  const result = validateSavedLookInput(value);
  if (!result.ok) return null;
  const savedAt = (value as { savedAt?: unknown }).savedAt;
  if (typeof savedAt !== "string" || !Number.isFinite(Date.parse(savedAt))) return null;
  return { ...result.look, savedAt };
}

/** Parse the stored list; anything malformed is dropped rather than thrown. */
export function parseSavedLooks(raw: string | null): SavedLook[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => toValidSavedLook(item) ?? []).slice(0, MAX_SAVED_LOOKS);
  } catch {
    return [];
  }
}

/** Local looks the server doesn't have yet (saved before the endpoint existed, or offline), oldest first. */
export function looksToUpload(local: readonly SavedLook[], server: readonly SavedLook[]): SavedLook[] {
  const onServer = new Set(server.map((l) => l.id));
  return local.filter((l) => !onServer.has(l.id)).reverse();
}

/** Server looks merged with not-yet-uploaded local ones, newest first, capped. */
export function mergeSavedLooks(server: readonly SavedLook[], local: readonly SavedLook[]): SavedLook[] {
  const byId = new Map<string, SavedLook>();
  for (const look of [...server, ...local]) if (!byId.has(look.id)) byId.set(look.id, look);
  return [...byId.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, MAX_SAVED_LOOKS);
}

/** Read a stored list; empty when storage is blocked or unavailable. */
export function readLookList(key: string): SavedLook[] {
  try {
    return parseSavedLooks(window.localStorage.getItem(key));
  } catch {
    return [];
  }
}

/** Write a stored list (an empty list removes the key); returns false when storage is blocked or full. */
export function writeLookList(key: string, list: readonly SavedLook[]): boolean {
  try {
    if (list.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** What to show before the server answers: the cached server list plus pending saves. */
export function readSavedLooksForDisplay(): SavedLook[] {
  return mergeSavedLooks(readLookList(SAVED_LOOKS_CACHE_KEY), readLookList(SAVED_LOOKS_PENDING_KEY));
}
