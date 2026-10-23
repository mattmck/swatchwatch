import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WISHLIST_SHARE_DISPLAY_NAME_MAX_LENGTH } from "swatchwatch-shared";
import { deriveSigningSubkey } from "./image-proxy";
import { isFeatureEnabled } from "./feature-flags";

/**
 * Shareable wishlist tokens (issue #268).
 *
 * Design (HMAC-derived, hash-stored):
 *
 *   token      = base64url(HMAC-SHA256(k, "<userId>:<salt>"))   — 32 bytes = 256 bits, 43 chars
 *   k          = deriveSigningSubkey("wishlist-share:v1")      — bound to IMAGE_PROXY_SIGNING_KEY
 *   salt       = base64url(16 random bytes), stored in wishlist_share.token_salt
 *   token_hash = hex(SHA-256(token)), stored (UNIQUE) and used for the public lookup
 *
 * The raw token is never stored. Because it is derived from the server key, the owner's status
 * endpoint can re-derive it any time (so "copy link" keeps working) while a database leak alone
 * (salt + hash) cannot be turned into a working link. Rotating writes a new salt (new token, new
 * hash); revoking deletes the row. If the server key changes, the stored hash no longer matches
 * the re-derived token: the old link keeps resolving (lookup is by hash), but the owner can no
 * longer copy it and is asked to rotate.
 */

const TOKEN_SUBKEY_PURPOSE = "wishlist-share:v1";
const TOKEN_BYTES = 32;
const SALT_BYTES = 16;
/** base64url of 32 bytes, no padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** Server-side feature flag. Off unless `SHAREABLE_WISHLIST_ENABLED` is exactly "true" (any case). */
export function isShareableWishlistEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isFeatureEnabled("shareableWishlist", env);
}

export function generateShareTokenSalt(): string {
  return randomBytes(SALT_BYTES).toString("base64url");
}

/**
 * Derive the share token for an owner and salt.
 * @throws ImageProxyConfigError when no signing key is available.
 */
export function deriveShareToken(userId: number, salt: string): string {
  return createHmac("sha256", deriveSigningSubkey(TOKEN_SUBKEY_PURPOSE))
    .update(`${userId}:${salt}`, "utf8")
    .digest()
    .toString("base64url");
}

/** Lookup hash for a token: lowercase hex SHA-256. */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Return the token when it is syntactically valid (43 canonical base64url chars encoding exactly
 * 32 bytes), otherwise null. Rejecting non-canonical spellings keeps one token = one string.
 */
export function parseShareToken(raw: unknown): string | null {
  if (typeof raw !== "string" || !TOKEN_PATTERN.test(raw)) return null;
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== TOKEN_BYTES || bytes.toString("base64url") !== raw) return null;
  return raw;
}

/** Constant-time check that `token` hashes to `storedHash` (hex). */
export function shareTokenMatchesHash(token: string, storedHash: string): boolean {
  const expected = Buffer.from(hashShareToken(token), "hex");
  const stored = /^[0-9a-f]{64}$/.test(storedHash) ? Buffer.from(storedHash, "hex") : Buffer.alloc(0);
  return stored.length === expected.length && timingSafeEqual(expected, stored);
}

/**
 * Re-derive an owner's current token from its stored salt, or null when it no longer matches the
 * stored hash (server key changed) or no key is available.
 */
export function recoverShareToken(userId: number, salt: string, storedHash: string): string | null {
  try {
    const token = deriveShareToken(userId, salt);
    return shareTokenMatchesHash(token, storedHash) ? token : null;
  } catch {
    return null;
  }
}

export type DisplayNameResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * Validate an owner-chosen public display name. Empty/null → null (generic title). Collapses
 * whitespace, strips control characters, caps the length, and rejects anything that looks like
 * an email address so the owner cannot publish theirs by accident.
 */
export function normalizeShareDisplayName(value: unknown): DisplayNameResult {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "displayName must be a string" };
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return { ok: true, value: null };
  if (cleaned.length > WISHLIST_SHARE_DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `displayName must be at most ${WISHLIST_SHARE_DISPLAY_NAME_MAX_LENGTH} characters`,
    };
  }
  if (EMAIL_LIKE.test(cleaned)) {
    return { ok: false, error: "displayName must not be an email address" };
  }
  return { ok: true, value: cleaned };
}
