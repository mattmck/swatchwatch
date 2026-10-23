/**
 * Attributes for outbound "Buy from brand" links (#267). Render every external buy link
 * with both, so the destination gets no `window.opener`, no referrer, and no endorsement
 * signal for crawlers.
 */
export const OUTBOUND_LINK_TARGET = "_blank";
export const OUTBOUND_LINK_REL = "noopener noreferrer nofollow";

/**
 * Re-check of a "Buy from brand" URL (#267). The API already validates `buyUrl`; this is defense
 * in depth so a client can never open or render a link with an unsafe scheme or embedded
 * credentials. Returns the normalized URL or null. Shared by web (`lib/outbound-link.ts`) and the
 * Expo app (which hands it to `Linking.openURL`).
 */
export function safeOutboundUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /[\u0000- \u007f]/.test(trimmed)) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}
