"use client";

import { useEffect, useState } from "react";
import { FEATURE_FLAG_NAMES, type FeatureFlagsResponse } from "swatchwatch-shared";
import { getFeatureFlags } from "@/lib/api";

type Flags = FeatureFlagsResponse["flags"];

const ALL_OFF = Object.fromEntries(FEATURE_FLAG_NAMES.map((name) => [name, false])) as Flags;

/**
 * How long a page waits for `GET /config/flags` before treating every flag as off, so a request
 * that never answers (a stalled phone connection) cannot keep a page waiting on `loaded`.
 */
export const FEATURE_FLAGS_TIMEOUT_MS = 5000;

let cached: Flags | null = null;
let inFlight: Promise<Flags> | null = null;

/**
 * Fetched once per page load and kept in memory. A failure or a timeout counts as every flag
 * off, and the first outcome is kept for the rest of the page load, so flags never change once
 * they have loaded.
 */
function loadFlags(): Promise<Flags> {
  if (cached) return Promise.resolve(cached);
  inFlight ??= new Promise<Flags>((resolve) => {
    const settle = (flags: Flags) => {
      cached ??= flags;
      resolve(cached);
    };
    const timer = setTimeout(() => settle(ALL_OFF), FEATURE_FLAGS_TIMEOUT_MS);
    getFeatureFlags()
      .then((res) => settle({ ...ALL_OFF, ...res.flags }))
      .catch(() => settle(ALL_OFF))
      .finally(() => clearTimeout(timer));
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export interface FeatureFlagsState {
  flags: Flags;
  /** False until the flags request answered, failed or timed out; every flag is off until then. */
  loaded: boolean;
}

/** Server feature flags plus whether they have loaded (Rapid Add waits for them, #527). */
export function useFeatureFlagsState(): FeatureFlagsState {
  const [state, setState] = useState<FeatureFlagsState>(() =>
    cached ? { flags: cached, loaded: true } : { flags: ALL_OFF, loaded: false },
  );
  useEffect(() => {
    let cancelled = false;
    loadFlags().then((flags) => {
      if (!cancelled) setState({ flags, loaded: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/** Server feature flags. Every flag is false until the response arrives (and when it fails). */
export function useFeatureFlags(): Flags {
  return useFeatureFlagsState().flags;
}
