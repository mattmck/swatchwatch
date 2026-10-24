/**
 * Server feature flags for the app (`GET /api/config/flags`). Every flag is false until the
 * response arrives and whenever it fails; the last good response is cached on the device so the
 * flags are right on an offline launch. The cache scope is "shared" (not a user id): the flags
 * are not user data, so sign-out has nothing to wipe beyond the normal cache clear.
 */
import { useEffect, useState } from "react";
import { FEATURE_FLAG_NAMES, type FeatureFlagsResponse } from "swatchwatch-shared";
import { readCache, writeCache } from "@/lib/api-cache";

type Flags = FeatureFlagsResponse["flags"];

export const FEATURE_FLAGS_CACHE_KEY = "config.flags";
const CACHE_SCOPE = "shared";

export const DEFAULT_FLAGS: Flags = Object.fromEntries(FEATURE_FLAG_NAMES.map((name) => [name, false])) as Flags;

/** Known flags only, strictly boolean; anything else is false. */
export function parseFlags(raw: unknown): Flags {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_FLAGS;
  const record = raw as Record<string, unknown>;
  return Object.fromEntries(FEATURE_FLAG_NAMES.map((name) => [name, record[name] === true])) as Flags;
}

let memory: Flags | null = null;
let inFlight: Promise<Flags> | null = null;

/** Fetched once per app launch; a failure keeps whatever was cached, else every flag off. */
function refreshFlags(): Promise<Flags> {
  // Loaded lazily so the pure helpers above stay importable in node tests (the client pulls in React Native).
  inFlight ??= import("@/api/client")
    .then(({ getFeatureFlags }) => getFeatureFlags())
    .then(async (res) => {
      memory = parseFlags(res.flags);
      await writeCache(CACHE_SCOPE, FEATURE_FLAGS_CACHE_KEY, memory);
      return memory;
    })
    .catch(() => memory ?? DEFAULT_FLAGS)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useFeatureFlags(): Flags {
  const [flags, setFlags] = useState<Flags>(memory ?? DEFAULT_FLAGS);
  useEffect(() => {
    let cancelled = false;
    const apply = (next: Flags) => {
      if (!cancelled) setFlags(next);
    };
    void (async () => {
      if (!memory) {
        const cached = await readCache<unknown>(CACHE_SCOPE, FEATURE_FLAGS_CACHE_KEY);
        if (cached) {
          memory = parseFlags(cached.data);
          apply(memory);
        }
      }
      apply(await refreshFlags());
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return flags;
}
