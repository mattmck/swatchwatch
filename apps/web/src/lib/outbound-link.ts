import { OUTBOUND_LINK_REL, OUTBOUND_LINK_TARGET, safeOutboundUrl } from "swatchwatch-shared";

export { safeOutboundUrl };

/** Anchor attributes for a safe outbound link, or null when the URL is not safe to render. */
export function outboundLinkProps(
  value: unknown
): { href: string; target: typeof OUTBOUND_LINK_TARGET; rel: typeof OUTBOUND_LINK_REL } | null {
  const href = safeOutboundUrl(value);
  return href ? { href, target: OUTBOUND_LINK_TARGET, rel: OUTBOUND_LINK_REL } : null;
}
