/**
 * Attributes for outbound "Buy from brand" links (#267). Render every external buy link
 * with both, so the destination gets no `window.opener`, no referrer, and no endorsement
 * signal for crawlers.
 */
export const OUTBOUND_LINK_TARGET = "_blank";
export const OUTBOUND_LINK_REL = "noopener noreferrer nofollow";
