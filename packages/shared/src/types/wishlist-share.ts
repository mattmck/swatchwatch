/**
 * Shareable wishlist (issue #268): an opt-in, revocable, read-only public page listing the
 * owner's `status = 'wishlist'` polishes. The whole feature sits behind the server-side
 * `SHAREABLE_WISHLIST_ENABLED` flag (off by default); while it is off every wishlist-share route
 * answers 404 with `code: "feature_disabled"`.
 */

/** Machine-readable `code` the API returns (404) while `SHAREABLE_WISHLIST_ENABLED` is off. */
export const WISHLIST_SHARE_FEATURE_DISABLED_CODE = "feature_disabled";

/** Longest owner-chosen display name shown on the public page. */
export const WISHLIST_SHARE_DISPLAY_NAME_MAX_LENGTH = 60;

/**
 * Web path of the public page for a share token. The web app is a static export, so the token
 * travels as a query parameter (same pattern as `/polishes/detail?id=`), not a path segment.
 */
export function wishlistSharePath(token: string): string {
  return `/w/?token=${encodeURIComponent(token)}`;
}

/** Owner view of their share link (`GET/POST /api/wishlist-share`, `POST .../rotate`). */
export interface WishlistShareStatus {
  /** True while a share link exists. Revoking deletes it, so a revoked link is `enabled: false`. */
  enabled: boolean;
  /**
   * The current share token, or null when there is no link or it can no longer be re-derived
   * (the server signing key changed); rotate to mint a fresh one in that case.
   */
  token: string | null;
  /** Web path for the public page (`/w/?token=...`), or null when `token` is null. */
  path: string | null;
  /** Owner-chosen public name; null shows a generic title. Never derived from the email. */
  displayName: string | null;
  /** Number of wishlist-status polishes the public page currently shows. */
  wishlistCount: number;
  /**
   * Wishlist polishes the public page hides: the owner's own `user_submitted` shades, which stay
   * private until an admin adds them to the shared catalog.
   */
  hiddenCount: number;
  createdAt: string | null;
  /** When the token was last rotated (equals `createdAt` until the first rotation). */
  rotatedAt: string | null;
}

/** Body of `POST /api/wishlist-share` (enable, or update the display name of an existing link). */
export interface WishlistShareEnableRequest {
  /** Public name for the page. Omit/null/empty for none. Email addresses are rejected. */
  displayName?: string | null;
}

/**
 * One public wishlist entry. This is an explicit allowlist: no ids, notes, prices, quantities,
 * dates, tags or private media ever appear here.
 */
export interface PublicWishlistItem {
  brand: string;
  name: string;
  /** Canonical finishes, primary first. */
  finishes: string[];
  /** Display hex (vendor > detected > name), or null when the shade has no color data. */
  hex: string | null;
  /** Public catalog image (`/api/images/v2...`), or null. Never an owner-scoped private image. */
  imageUrl: string | null;
}

/** Response of the anonymous `GET /api/wishlist/{token}`. */
export interface PublicWishlistResponse {
  /** Owner-chosen display name, or null. Never an email, handle or user id. */
  displayName: string | null;
  items: PublicWishlistItem[];
}
