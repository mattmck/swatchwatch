/**
 * Getting-started checklist on the Home panel (web: `components/getting-started.tsx`, #372).
 * The rules (goal 20, show below 5, state, visibility) are the shared ones in
 * `swatchwatch-shared`; this file maps the step ids to Expo routes and builds the swatch strip.
 */
import {
  ONBOARDING_GOAL,
  resolveDisplayHex,
  type GettingStartedStepId,
  type Polish,
} from "swatchwatch-shared";

/** Where each step goes: import wizard, the Add tab (camera Rapid Add), the Search tab. */
export const ONBOARDING_ROUTES: Record<GettingStartedStepId, string> = {
  import: "/import",
  scan: "/add",
  search: "/search",
};

/** Cache key (under the per-user cache prefix, so sign-out wipes it) for the checklist state. */
export const GETTING_STARTED_CACHE_KEY = "getting-started";

/**
 * Hexes for the 20-swatch progress strip: owned polishes (oldest first, like the web), first
 * `ONBOARDING_GOAL`; a polish without any color is `null` (drawn in the brand tint).
 */
export function swatchStripHexes(owned: readonly Pick<Polish, "status" | "createdAt" | "vendorHex" | "detectedHex" | "nameHex">[]): (string | null)[] {
  return owned
    .filter((p) => p.status === "owned")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, ONBOARDING_GOAL)
    .map((p) => resolveDisplayHex(p) ?? null);
}

/** A user with nothing owned or wishlisted yet: Home shows only the checklist and one line. */
export function isBrandNewCollection(summary: { owned: number; wishlist: number } | undefined): boolean {
  return summary !== undefined && summary.owned === 0 && summary.wishlist === 0;
}
