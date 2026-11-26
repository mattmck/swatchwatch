/** Feature flags the API reports to clients (`GET /api/config/flags`); internal flags are never listed. */
export const FEATURE_FLAG_NAMES = ["shareableWishlist", "shareableLooks", "bottleCapture"] as const;

export type PublicFeatureFlagName = (typeof FEATURE_FLAG_NAMES)[number];

export interface FeatureFlagsResponse {
  flags: Record<PublicFeatureFlagName, boolean>;
  /**
   * Local test harness only: the Functions host's AI record/replay mode (`AI_REPLAY_MODE`), present
   * only when it is `record` or `replay`. Never present on a hosted Azure instance (forced off there),
   * so clients must not depend on it; the capture replay e2e test and `eval:bottle` read it.
   */
  aiReplayMode?: "record" | "replay";
}
