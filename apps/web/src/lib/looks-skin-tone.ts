import { SKIN_DEPTHS, SKIN_UNDERTONES, skinToneFrom, type SkinDepth, type SkinTone, type SkinUndertone } from "./looks";

export const SKIN_UNDERTONE_LABELS: Record<SkinUndertone, string> = { cool: "Cool", neutral: "Neutral", warm: "Warm" };
export const SKIN_DEPTH_LABELS: Record<SkinDepth, string> = {
  fair: "Fair",
  light: "Light",
  medium: "Medium",
  tan: "Tan",
  deep: "Deep",
};

const STORAGE_KEY_PREFIX = "swatchwatch-looks-skin-tone";

/** Per-user localStorage key (a failed user lookup falls back to one shared key, like the getting-started checklist). */
export function skinToneStorageKey(userId: string | null | undefined): string {
  return userId ? `${STORAGE_KEY_PREFIX}:${userId}` : STORAGE_KEY_PREFIX;
}

/** Parse a stored value; anything unusable is "no skin tone". */
export function parseStoredSkinTone(raw: string | null): SkinTone | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { undertone, depth } = value as Record<string, unknown>;
    return skinToneFrom(
      (SKIN_UNDERTONES as readonly unknown[]).includes(undertone) ? (undertone as SkinUndertone) : null,
      (SKIN_DEPTHS as readonly unknown[]).includes(depth) ? (depth as SkinDepth) : null
    );
  } catch {
    return null;
  }
}

export function readStoredSkinTone(userId: string | null | undefined): SkinTone | null {
  try {
    return parseStoredSkinTone(window.localStorage.getItem(skinToneStorageKey(userId)));
  } catch {
    return null;
  }
}

/** Remember the choice (null forgets it). Storage failures are ignored: the URL still carries it. */
export function writeStoredSkinTone(userId: string | null | undefined, skinTone: SkinTone | null): void {
  try {
    const key = skinToneStorageKey(userId);
    if (skinTone) window.localStorage.setItem(key, JSON.stringify(skinTone));
    else window.localStorage.removeItem(key);
  } catch {
    // Private mode or blocked storage.
  }
}
