import type { SavedLook, SavedLookStep } from "swatchwatch-shared";
import { MAX_SAVED_LOOKS, savedLookKey, validateSavedLookInput } from "swatchwatch-shared";
import type { Look, Vibe } from "./looks";

/**
 * Saved looks. The source of truth is the caller's `user_look` rows (`GET/POST/DELETE /api/looks`);
 * localStorage holds a copy for offline use and for an API without the endpoint yet, and looks saved
 * there before the endpoint existed are uploaded once (`looksToUpload`). Only what is needed to show
 * the look again and re-wear it is stored: names, hexes, roles and shade ids.
 */
export { MAX_SAVED_LOOKS };
export type { SavedLook, SavedLookStep };

export const SAVED_LOOKS_STORAGE_KEY = "swatchwatch.looks.saved.v1";

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

/** Read saved looks; empty when storage is blocked or unavailable. */
export function readSavedLooks(): SavedLook[] {
  try {
    return parseSavedLooks(window.localStorage.getItem(SAVED_LOOKS_STORAGE_KEY));
  } catch {
    return [];
  }
}

/** Write saved looks; returns false when storage is blocked or full. */
export function writeSavedLooks(list: readonly SavedLook[]): boolean {
  try {
    window.localStorage.setItem(SAVED_LOOKS_STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
