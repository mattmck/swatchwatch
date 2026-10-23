/** Feature flags the API reports to clients (`GET /api/config/flags`); internal flags are never listed. */
export const FEATURE_FLAG_NAMES = ["shareableWishlist", "shareableLooks"] as const;

export type PublicFeatureFlagName = (typeof FEATURE_FLAG_NAMES)[number];

export interface FeatureFlagsResponse {
  flags: Record<PublicFeatureFlagName, boolean>;
}
