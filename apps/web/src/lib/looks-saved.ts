import { LOOK_FINISHES, LOOK_MOODS, LOOK_OCCASIONS, type Look, type LookStepRole, type LookStepSource, type Vibe } from "./looks";

/**
 * Saved looks, kept in this browser's localStorage for now (no `user_look` table yet). Only what
 * is needed to show the look again and re-wear it is stored: names, hexes, roles and shade ids.
 */
export const SAVED_LOOKS_STORAGE_KEY = "swatchwatch.looks.saved.v1";

/** Most looks kept; older ones fall off. */
export const MAX_SAVED_LOOKS = 30;

export interface SavedLookStep {
  role: LookStepRole;
  label: string;
  hex: string;
  source: LookStepSource;
  shadeId?: string;
  brand?: string;
  name?: string;
}

export interface SavedLook {
  /** `templateId:shadeIds` (a dash for steps without a polish): the same combo is saved once. */
  id: string;
  templateId: string;
  name: string;
  savedAt: string;
  vibe: Vibe;
  steps: SavedLookStep[];
}

export function toSavedLook(look: Look, vibe: Vibe, now: Date): SavedLook {
  return {
    id: `${look.templateId}:${look.steps.map((s) => s.polish?.id ?? "-").join(",")}`,
    templateId: look.templateId,
    name: look.name,
    savedAt: now.toISOString(),
    vibe,
    steps: look.steps.map((step) => ({
      role: step.role,
      label: step.label,
      hex: step.hex,
      source: step.source,
      ...(step.polish ? { shadeId: step.polish.id, brand: step.polish.brand, name: step.polish.name } : {}),
    })),
  };
}

/** Newest first, deduped by id, capped at `MAX_SAVED_LOOKS`. */
export function addSavedLook(list: readonly SavedLook[], look: SavedLook): SavedLook[] {
  return [look, ...list.filter((l) => l.id !== look.id)].slice(0, MAX_SAVED_LOOKS);
}

export function removeSavedLook(list: readonly SavedLook[], id: string): SavedLook[] {
  return list.filter((l) => l.id !== id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSavedStep(value: unknown): value is SavedLookStep {
  return (
    isRecord(value) &&
    typeof value.role === "string" &&
    typeof value.label === "string" &&
    typeof value.hex === "string" &&
    typeof value.source === "string"
  );
}

function isVibe(value: unknown): value is Vibe {
  return (
    isRecord(value) &&
    (LOOK_OCCASIONS as readonly unknown[]).includes(value.occasion) &&
    (LOOK_MOODS as readonly unknown[]).includes(value.mood) &&
    (value.finish === null || (LOOK_FINISHES as readonly unknown[]).includes(value.finish)) &&
    typeof value.ownedOnly === "boolean"
  );
}

function isSavedLook(value: unknown): value is SavedLook {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.templateId === "string" &&
    typeof value.name === "string" &&
    typeof value.savedAt === "string" &&
    isVibe(value.vibe) &&
    Array.isArray(value.steps) &&
    value.steps.every(isSavedStep)
  );
}

/** Parse the stored list; anything malformed is dropped rather than thrown. */
export function parseSavedLooks(raw: string | null): SavedLook[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSavedLook).slice(0, MAX_SAVED_LOOKS) : [];
  } catch {
    return [];
  }
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
