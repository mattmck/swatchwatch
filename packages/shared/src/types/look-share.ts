/**
 * Shareable looks: an opt-in, revocable, read-only public page for one saved look (`user_look`),
 * modeled on the shareable wishlist (#268). The whole feature sits behind the server-side
 * `SHAREABLE_LOOKS_ENABLED` flag (off by default); while it is off every look-share route answers
 * 404 with `code: "feature_disabled"` (the same code as the wishlist).
 */
import type { LookMood, LookOccasion, LookFinish, LookStepRole } from "./looks";

/** Machine-readable `code` the API returns (404) while `SHAREABLE_LOOKS_ENABLED` is off. */
export const LOOK_SHARE_FEATURE_DISABLED_CODE = "feature_disabled";

/** Machine-readable `code` of the public 410 answer for a link its owner turned off. */
export const LOOK_SHARE_REVOKED_CODE = "share_revoked";

/**
 * Web path of the public page for a look share token. The web app is a static export, so the
 * token travels as a query parameter (like `/w/?token=`), not a path segment.
 */
export function lookSharePath(token: string): string {
  return `/l/?token=${encodeURIComponent(token)}`;
}

/** Owner view of one saved look's share link (`GET/POST/DELETE /api/look-share`). */
export interface LookShareStatus {
  /** The saved look's key (`SavedLook.id`). */
  lookKey: string;
  /** True while the link works. A revoked link is `enabled: false` with `revokedAt` set. */
  enabled: boolean;
  /**
   * The current share token, or null when the link is off or can no longer be re-derived (the
   * server signing key changed); turn it off and on again to mint a fresh one.
   */
  token: string | null;
  /** Web path for the public page (`/l/?token=...`), or null when `token` is null. */
  path: string | null;
  /** Owner-chosen public name for this link; null shows a generic title. Never derived from the email. */
  displayName: string | null;
  /** When the current link was created (a re-share after a revoke starts a new link). */
  createdAt: string | null;
  /** When the link was turned off, or null while it works. */
  revokedAt: string | null;
}

/** `GET /api/look-share`: the caller's live links, one per shared saved look. */
export interface LookShareListResponse {
  shares: LookShareStatus[];
}

/**
 * Body of `POST /api/look-share`: share a saved look (idempotent while the link works; a revoked
 * link gets a new token) and/or set its public display name.
 */
export interface LookShareCreateRequest {
  /** The saved look's key (`SavedLook.id`). The look must already be saved to the account. */
  lookKey: string;
  /** Public name for the page. Omit to keep the current one; null/empty for none. Emails are rejected. */
  displayName?: string | null;
}

/**
 * One step of a public look. An explicit allowlist: no shade ids, no owned/to-buy source, no
 * notes, prices, quantities or private media. A step whose polish is not a public catalog shade
 * (a template color, or the owner's private `user_submitted` shade) is a plain color chip:
 * `brand` and `name` are null, `finishes` is empty and `imageUrl` is null.
 */
export interface PublicLookStep {
  role: LookStepRole;
  brand: string | null;
  name: string | null;
  /** Canonical finishes, primary first (empty for a color chip). */
  finishes: string[];
  /** Display hex (vendor > detected > name for catalog shades; the saved color otherwise). */
  hex: string;
  /** Public catalog image (`/api/images/v2...`), or null. Never an owner-scoped private image. */
  imageUrl: string | null;
}

/** The public vibe: occasion, mood and finish preference only (no "owned only" flag). */
export interface PublicLookVibe {
  occasion: LookOccasion;
  mood: LookMood;
  finish: LookFinish | null;
}

/** Response of the anonymous `GET /api/look/{token}`. */
export interface PublicLookResponse {
  /** Owner-chosen display name, or null. Never an email, handle or user id. */
  displayName: string | null;
  /** Built-in template slug (e.g. `glazed-donut`); the page names the look from it. */
  templateId: string;
  vibe: PublicLookVibe;
  steps: PublicLookStep[];
}
