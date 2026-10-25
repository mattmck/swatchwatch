import { createHmac } from "node:crypto";
import {
  LOOK_FINISHES,
  LOOK_MOODS,
  LOOK_OCCASIONS,
  LOOK_STEP_ROLES,
  MAX_LOOK_STEPS,
  resolveDisplayHex,
  type LookFinish,
  type LookMood,
  type LookOccasion,
  type LookStepRole,
  type PublicLookResponse,
  type PublicLookStep,
  type PublicLookVibe,
} from "swatchwatch-shared";
import { isFeatureEnabled } from "./feature-flags";
import { deriveSigningSubkey } from "./image-proxy";
import { publicCatalogImageUrl } from "./public-catalog-image";
import { hashShareToken, shareTokenMatchesHash } from "./wishlist-share";

/**
 * Shareable looks: one public, read-only link per saved look (`user_look`), modeled on the
 * shareable wishlist (#268, `lib/wishlist-share.ts`, whose token parsing, hashing and display-name
 * rules are reused as-is).
 *
 *   token      = base64url(HMAC-SHA256(k, "<userId>:<userLookId>:<salt>"))   — 32 bytes, 43 chars
 *   k          = deriveSigningSubkey("look-share:v1")  — a different subkey from the wishlist's
 *                ("wishlist-share:v1"), so a wishlist token and a look token can never coincide
 *   salt       = base64url(16 random bytes), stored in look_share.token_salt
 *   token_hash = hex(SHA-256(token)), stored (UNIQUE) and used for the public lookup
 *
 * The raw token is never stored; the owner's status endpoint re-derives it. Revoking keeps the
 * row (revoked_at, the link answers 410); sharing again writes a new salt, so a new token.
 */

const TOKEN_SUBKEY_PURPOSE = "look-share:v1";
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const SHADE_ID_RE = /^[1-9]\d{0,17}$/;

/** Server-side feature flag. Off unless `SHAREABLE_LOOKS_ENABLED` is exactly "true" (any case). */
export function isShareableLooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isFeatureEnabled("shareableLooks", env);
}

/**
 * Derive the share token for one saved look of an owner.
 * @throws ImageProxyConfigError when no signing key is available.
 */
export function deriveLookShareToken(userId: number, userLookId: number, salt: string): string {
  return createHmac("sha256", deriveSigningSubkey(TOKEN_SUBKEY_PURPOSE))
    .update(`${userId}:${userLookId}:${salt}`, "utf8")
    .digest()
    .toString("base64url");
}

/**
 * Re-derive a look's current token from its stored salt, or null when it no longer matches the
 * stored hash (server key changed) or no key is available.
 */
export function recoverLookShareToken(
  userId: number,
  userLookId: number,
  salt: string,
  storedHash: string
): string | null {
  try {
    const token = deriveLookShareToken(userId, userLookId, salt);
    return shareTokenMatchesHash(token, storedHash) ? token : null;
  } catch {
    return null;
  }
}

export { hashShareToken as hashLookShareToken };

// ---------------------------------------------------------------------------
// Public allowlist
// ---------------------------------------------------------------------------

/** The stored look the public route reads (`user_look` columns). */
export interface StoredLookForShare {
  templateId: string;
  vibe: unknown;
  steps: unknown;
}

/** A shade the public route may show: already filtered to public catalog shades by the SQL. */
export interface PublicShadeRow {
  shadeId: number | string;
  brand: string | null;
  name: string | null;
  finish: string | null;
  finishes: string[] | null;
  vendorHex: string | null;
  detectedHex: string | null;
  nameHex: string | null;
  imageUrl: string | null;
}

interface StoredStep {
  role: LookStepRole;
  hex: string;
  shadeId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/**
 * The stored steps reduced to what the public page may use: role, the saved color and the shade
 * id to look up. The saved label, brand, name and source (owned / to buy) are ignored: names come
 * from the catalog, never from the owner's snapshot, and ownership is never published.
 */
export function storedStepsForShare(steps: unknown): StoredStep[] {
  if (!Array.isArray(steps)) return [];
  const out: StoredStep[] = [];
  for (const raw of steps.slice(0, MAX_LOOK_STEPS)) {
    if (!isRecord(raw) || !oneOf(LOOK_STEP_ROLES, raw.role)) continue;
    if (typeof raw.hex !== "string" || !HEX_RE.test(raw.hex)) continue;
    const shadeId = typeof raw.shadeId === "string" && SHADE_ID_RE.test(raw.shadeId) ? raw.shadeId : null;
    out.push({ role: raw.role, hex: raw.hex.toUpperCase(), shadeId });
  }
  return out;
}

/** Shade ids the public route should look up (deduplicated). */
export function shadeIdsForShare(steps: readonly StoredStep[]): string[] {
  return [...new Set(steps.flatMap((s) => (s.shadeId ? [s.shadeId] : [])))];
}

function publicVibe(raw: unknown): PublicLookVibe | null {
  if (!isRecord(raw) || !oneOf(LOOK_OCCASIONS, raw.occasion) || !oneOf(LOOK_MOODS, raw.mood)) return null;
  const finish = oneOf(LOOK_FINISHES, raw.finish) ? (raw.finish as LookFinish) : null;
  return { occasion: raw.occasion as LookOccasion, mood: raw.mood as LookMood, finish };
}

function shadeFinishes(row: PublicShadeRow): string[] {
  const finishes = Array.isArray(row.finishes)
    ? row.finishes.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    : [];
  if (finishes.length === 0 && row.finish?.trim()) finishes.push(row.finish.trim());
  return finishes;
}

/**
 * Build the public payload. Only the fields named here can leave the server: a step whose shade
 * is in `publicShades` (public catalog shades, filtered in SQL) gets the catalog's brand, name,
 * finishes, display hex and public v2 image; any other step (template color, the owner's private
 * submission, a missing or retired shade) is a plain color chip with the saved hex.
 * Returns null when the stored look is unusable (bad vibe or no valid steps).
 */
export function toPublicLook(
  look: StoredLookForShare,
  displayName: string | null,
  publicShades: ReadonlyMap<string, PublicShadeRow>,
  requestUrl: string
): PublicLookResponse | null {
  const vibe = publicVibe(look.vibe);
  const stored = storedStepsForShare(look.steps);
  if (!vibe || stored.length === 0 || !/^[a-z0-9-]{1,40}$/.test(look.templateId)) return null;
  const steps: PublicLookStep[] = stored.map((step) => {
    const shade = step.shadeId ? publicShades.get(step.shadeId) : undefined;
    if (!shade) {
      return { role: step.role, brand: null, name: null, finishes: [], hex: step.hex, imageUrl: null };
    }
    const hex = resolveDisplayHex({
      vendorHex: shade.vendorHex ?? undefined,
      detectedHex: shade.detectedHex ?? undefined,
      nameHex: shade.nameHex ?? undefined,
    });
    return {
      role: step.role,
      brand: shade.brand ?? "",
      name: shade.name ?? "",
      finishes: shadeFinishes(shade),
      hex: hex && HEX_RE.test(hex) ? hex.toUpperCase() : step.hex,
      imageUrl: publicCatalogImageUrl(shade.imageUrl, requestUrl),
    };
  });
  return { displayName: displayName ?? null, templateId: look.templateId, vibe, steps };
}
