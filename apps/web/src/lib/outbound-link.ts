import { OUTBOUND_LINK_REL, OUTBOUND_LINK_TARGET } from "swatchwatch-shared";

/**
 * Client-side re-check of a "Buy from brand" URL (#267). The API already validates
 * `buyUrl`; this is defense in depth so the UI can never render an `href` with an
 * unsafe scheme or embedded credentials. Returns the normalized URL or null.
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

/** Anchor attributes for a safe outbound link, or null when the URL is not safe to render. */
export function outboundLinkProps(
  value: unknown
): { href: string; target: typeof OUTBOUND_LINK_TARGET; rel: typeof OUTBOUND_LINK_REL } | null {
  const href = safeOutboundUrl(value);
  return href ? { href, target: OUTBOUND_LINK_TARGET, rel: OUTBOUND_LINK_REL } : null;
}
