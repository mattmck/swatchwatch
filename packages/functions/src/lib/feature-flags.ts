import { FEATURE_FLAG_NAMES, type FeatureFlagsResponse } from "swatchwatch-shared";

/**
 * Feature-flag registry (#313, decision D22): the one place that knows which env var backs a
 * flag and how it is parsed. Env-backed today; moving to Azure App Configuration later means
 * changing `isFeatureEnabled` only. Every flag fails closed: unset, empty or unrecognized = off.
 */
interface FeatureFlagDefinition {
  /** Environment variable that turns the flag on. */
  env: string;
  /** May be reported to clients by `GET /api/config/flags`. Internal flags are never exposed. */
  public: boolean;
  /** Also accept `1`, `yes` and `on` (legacy semantics of the batch flag); default is exactly `true`. */
  lenient?: boolean;
}

export const FEATURE_FLAGS = {
  shareableWishlist: { env: "SHAREABLE_WISHLIST_ENABLED", public: true },
  shareableLooks: { env: "SHAREABLE_LOOKS_ENABLED", public: true },
  hexDetectionBatch: { env: "HEX_DETECTION_BATCH_ENABLED", public: false, lenient: true },
  hexDetectionSnap: { env: "HEX_DETECTION_SNAP_ENABLED", public: false },
} as const satisfies Record<string, FeatureFlagDefinition>;

export type FeatureFlagName = keyof typeof FEATURE_FLAGS;

export function parseFlagValue(raw: string | undefined, lenient = false): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return false;
  return value === "true" || (lenient && (value === "1" || value === "yes" || value === "on"));
}

/** Read at call time (env reads are cheap), so a setting change applies to the next call. */
export function isFeatureEnabled(name: FeatureFlagName, env: NodeJS.ProcessEnv = process.env): boolean {
  const def: FeatureFlagDefinition = FEATURE_FLAGS[name];
  return parseFlagValue(env[def.env], def.lenient);
}

/** The flags safe to send to browsers, keyed by their public name. */
export function listPublicFeatureFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlagsResponse["flags"] {
  const flags = {} as FeatureFlagsResponse["flags"];
  for (const name of FEATURE_FLAG_NAMES) {
    flags[name] = isFeatureEnabled(name, env);
  }
  return flags;
}
