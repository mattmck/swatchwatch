/**
 * Pure helpers for the shareable wishlist (#268): the owner share card and the public `/w` page.
 *
 * The web app is a static export (`output: "export"`), so the public page cannot have a dynamic
 * `/w/[token]` segment; the token travels as `/w/?token=…`, like `/polishes/detail?id=`.
 */

/** Shape of a valid share token: 43 base64url chars (32 bytes). Mirrors the server check. */
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Read the share token from the page's query string; null when absent or malformed. */
export function readShareToken(params: { get(name: string): string | null } | null | undefined): string | null {
  const raw = params?.get("token")?.trim() ?? "";
  return SHARE_TOKEN_PATTERN.test(raw) ? raw : null;
}

/** Absolute share URL for the owner to copy, from the page origin and the API's `path`. */
export function buildWishlistShareUrl(origin: string, path: string): string {
  return new URL(path, origin).toString();
}

/** Public page heading: the owner's chosen name, or a generic title. */
export function publicWishlistTitle(displayName: string | null | undefined): string {
  const name = displayName?.trim();
  return name ? `${name}'s wishlist` : "A SwatchWatch wishlist";
}

/** Viewer-facing message for a failed public wishlist load. */
export function publicWishlistErrorMessage(status: number | undefined): string {
  if (status === 404) {
    return "This wishlist link doesn't exist, or its owner has turned sharing off or replaced the link.";
  }
  if (status === 429) {
    return "Too many requests for this wishlist right now. Wait a minute and try again.";
  }
  return "We couldn't load this wishlist. Try again in a moment.";
}

/** Short privacy note shown on the owner share card. */
export function wishlistSharePrivacyNote(visibleCount: number, hiddenCount: number): string {
  const items = `${visibleCount} ${visibleCount === 1 ? "polish" : "polishes"}`;
  const hidden =
    hiddenCount > 0
      ? ` ${hiddenCount} ${hiddenCount === 1 ? "polish you added that isn't" : "polishes you added that aren't"} in the shared catalog yet ${hiddenCount === 1 ? "stays" : "stay"} hidden.`
      : "";
  return (
    `Anyone with the link can see the brand, shade, finish and color of the ${items} on your wishlist, ` +
    "plus the display name you choose. They can't see your email, notes, prices, quantities or the " +
    `rest of your collection.${hidden} Search engines are asked not to index the page. ` +
    "Replace or turn off the link at any time; the old link stops working immediately."
  );
}
