"use client";

import { useEffect, useState } from "react";
import { FEATURE_FLAG_NAMES, type FeatureFlagsResponse } from "swatchwatch-shared";
import { getFeatureFlags } from "@/lib/api";

type Flags = FeatureFlagsResponse["flags"];

const ALL_OFF = Object.fromEntries(FEATURE_FLAG_NAMES.map((name) => [name, false])) as Flags;

let cached: Flags | null = null;
let inFlight: Promise<Flags> | null = null;

/** Fetched once per page load and kept in memory; a failure counts as every flag off. */
function loadFlags(): Promise<Flags> {
  if (cached) return Promise.resolve(cached);
  inFlight ??= getFeatureFlags()
    .then((res) => (cached = { ...ALL_OFF, ...res.flags }))
    .catch(() => (cached = ALL_OFF))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Server feature flags. Every flag is false until the response arrives (and when it fails). */
export function useFeatureFlags(): Flags {
  const [flags, setFlags] = useState<Flags>(cached ?? ALL_OFF);
  useEffect(() => {
    let cancelled = false;
    loadFlags().then((next) => {
      if (!cancelled) setFlags(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return flags;
}
