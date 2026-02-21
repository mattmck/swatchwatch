"use client";

import { useEffect, useMemo, useState } from "react";
import type { FinishType, ReferenceHarmonyType } from "swatchwatch-shared";
import { listReferenceFinishTypes, listReferenceHarmonyTypes } from "@/lib/api";
import { HARMONY_TYPES } from "@/lib/color-harmonies";
import { FINISHES, finishLabel } from "@/lib/constants";

const REFERENCE_DATA_STORAGE_KEY = "swatchwatch.reference-data.v1";
const CACHE_TTL_MS = 10 * 60 * 1000;

type CachedReferenceData = {
  savedAt: number;
  finishTypes: FinishType[];
  harmonyTypes: ReferenceHarmonyType[];
};

let inMemoryCache: CachedReferenceData | null = null;

function isHarmonyName(value: string): value is ReferenceHarmonyType["name"] {
  return HARMONY_TYPES.some((item) => item.value === value);
}

function buildFallbackFinishTypes(): FinishType[] {
  const now = new Date().toISOString();
  return FINISHES.map((name, index) => ({
    finishTypeId: index + 1,
    name,
    displayName: finishLabel(name),
    description: undefined,
    sortOrder: index + 1,
    createdAt: now,
    updatedAt: now,
    updatedByUserId: undefined,
  }));
}

function buildFallbackHarmonyTypes(): ReferenceHarmonyType[] {
  const now = new Date().toISOString();
  return HARMONY_TYPES.map((harmony, index) => ({
    harmonyTypeId: index + 1,
    name: harmony.value,
    displayName: harmony.label,
    description: undefined,
    sortOrder: index + 1,
    createdAt: now,
    updatedAt: now,
    updatedByUserId: undefined,
  }));
}

function readCachedReferenceData(): CachedReferenceData | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(REFERENCE_DATA_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedReferenceData;
    if (!parsed?.savedAt || !Array.isArray(parsed.finishTypes) || !Array.isArray(parsed.harmonyTypes)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedReferenceData(data: CachedReferenceData): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REFERENCE_DATA_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage errors; data still stays in memory for this tab.
  }
}

export function getFinishDisplayName(name: string, finishTypes?: FinishType[]): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return "";
  const found = finishTypes?.find((finish) => finish.name.toLowerCase() === normalized);
  return found?.displayName ?? finishLabel(normalized);
}

export function getHarmonyDisplayName(name: string, harmonyTypes?: ReferenceHarmonyType[]): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return "";
  const found = harmonyTypes?.find((harmony) => harmony.name.toLowerCase() === normalized);
  if (found?.displayName) return found.displayName;
  return HARMONY_TYPES.find((harmony) => harmony.value === normalized)?.label ?? normalized;
}

export function useReferenceData() {
  const fallbackFinishTypes = useMemo(buildFallbackFinishTypes, []);
  const fallbackHarmonyTypes = useMemo(buildFallbackHarmonyTypes, []);

  const [finishTypes, setFinishTypes] = useState<FinishType[]>(fallbackFinishTypes);
  const [harmonyTypes, setHarmonyTypes] = useState<ReferenceHarmonyType[]>(fallbackHarmonyTypes);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();

    const cached = inMemoryCache ?? readCachedReferenceData();
    if (cached) {
      inMemoryCache = cached;
      if (!cancelled) {
        setFinishTypes(cached.finishTypes);
        setHarmonyTypes(cached.harmonyTypes);
      }
      if (now - cached.savedAt <= CACHE_TTL_MS) {
        if (!cancelled) setLoading(false);
        return () => {
          cancelled = true;
        };
      }
    }

    async function load() {
      try {
        setLoading(true);
        setError(null);

        const [finishResponse, harmonyResponse] = await Promise.all([
          listReferenceFinishTypes(),
          listReferenceHarmonyTypes(),
        ]);

        const normalizedHarmonyTypes = harmonyResponse.harmonyTypes.filter((harmony) =>
          isHarmonyName(harmony.name)
        );

        const nextData: CachedReferenceData = {
          savedAt: Date.now(),
          finishTypes: finishResponse.finishTypes,
          harmonyTypes: normalizedHarmonyTypes,
        };

        inMemoryCache = nextData;
        writeCachedReferenceData(nextData);

        if (!cancelled) {
          setFinishTypes(nextData.finishTypes);
          setHarmonyTypes(nextData.harmonyTypes);
        }
      } catch (loadError: unknown) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load reference data");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return {
    finishTypes,
    harmonyTypes,
    loading,
    error,
    getFinishDisplayName: (name: string) => getFinishDisplayName(name, finishTypes),
    getHarmonyDisplayName: (name: string) => getHarmonyDisplayName(name, harmonyTypes),
  };
}
