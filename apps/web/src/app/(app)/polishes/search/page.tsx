"use client";

import { useState, useMemo, useCallback, useEffect, useRef, Suspense, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Polish, PolishUpdateRequest } from "swatchwatch-shared";
import { compareColorSearchRank, isEstimatedDisplayHex, polishHasFinish, resolveDisplayHex } from "swatchwatch-shared";
import type { IconType } from "react-icons";
import { BsCurrencyDollar, BsPlusLg, BsQuestionCircleFill, BsTrash3Fill } from "react-icons/bs";
import { GiPerfumeBottle } from "react-icons/gi";
import { ArrowLeft, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { getPolishDupes, listAllPolishes, listPolishes, updatePolish } from "@/lib/api";
import { buildBrandOptions, matchesBrandFilter } from "@/lib/polish-filters";
import { isArchivingChange, isOwnedPolish, quantityChangeUpdate } from "@/lib/inventory-status";
import { showArchivedToast } from "@/components/archived-toast";
import { applyInventoryPatch } from "@/lib/collection-actions";
import {
  colorDistance,
  hexToHsl,
  hslToHex,
  undertone,
  type Undertone,
  type HSL,
} from "@/lib/color-utils";
import {
  getHarmonyTypeOptions,
  generateHarmonyColors,
  generateHarmonyPalette,
  type HarmonyType,
} from "@/lib/color-harmonies";
import { ColorWheel, type WheelMode, type SnapDot, type HarmonyDot } from "@/components/color-wheel";
import { ColorSearchResults } from "@/components/color-search-results";
import { Button } from "@/components/ui/button";
import { BrandSpinner } from "@/components/brand-spinner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useReferenceData } from "@/hooks/use-reference-data";
import { useAddGuard } from "@/hooks/use-add-guard";
import { AddGuardDialog } from "@/components/add-guard-dialog";
import { shadeGuardKey, wishlistInsteadUpdate } from "@/lib/add-guard";
import {
  buildColorSearchQueryString,
  parseColorSearchState,
  type ColorSearchUrlState,
} from "@/lib/color-search-url";
import { returnToLabel } from "@/lib/detail-href";
import {
  LatestLoader,
  contextNearbyTargets,
  listNearbyTargets,
  nearbyQueryKey,
  uniqueHexes,
  type NearbyQuery,
  type NearbyTargetsInput,
} from "@/lib/color-search-nearby";
import { toast } from "sonner";

type ResultsScope = "all" | "collection";
type HarmonyColorSet = "any" | "all" | "collection";
type ColorPolish = Polish & { colorHex: string }; // colorHex is a computed display hex
type ColorAvailability = "have" | "buy" | "virtual";
type ColorAvailabilityInfo = {
  status: ColorAvailability;
  ownedMatch: { polish: ColorPolish; distance: number } | null;
  purchaseMatch: { polish: ColorPolish; distance: number } | null;
};
type WantedColorStatus = {
  hex: string;
  availability: ColorAvailabilityInfo;
};
type RecommendedPalette = {
  id: string;
  harmony: HarmonyType;
  sourceHex: string;
  slotHexes: string[];
  slotStatuses: ColorAvailabilityInfo[];
  haveCoverage: number;
  buyCoverage: number;
  virtualCoverage: number;
  fitQuality: number;
  score: number;
};

/** Max OKLAB distance (used to normalize to 0-1 for display) */
const MAX_DISTANCE = 0.5;
const AVAILABILITY_MATCH_THRESHOLD = 0.075;

const AVAILABILITY_META: Record<ColorAvailability, { label: string; color: string }> = {
  have: { label: "Have", color: "#22C55E" },
  buy: { label: "Buy", color: "#F59E0B" },
  virtual: { label: "Virtual", color: "#6B7280" },
};
const AVAILABILITY_ICON: Record<ColorAvailability, IconType> = {
  have: GiPerfumeBottle,
  buy: BsCurrencyDollar,
  virtual: BsQuestionCircleFill,
};

const HARMONY_SYMBOLS: Record<HarmonyType, string> = {
  similar: "\u25EF",
  complementary: "\u25D0",
  "split-complementary": "\u25D4\u25D1",
  analogous: "\u25C9\u25C9\u25C9",
  triadic: "\u25B3",
  tetradic: "\u25AD",
  monochromatic: "\u25D2",
};
const ALL_HARMONY_SYMBOL = "\u2726";
const URL_WRITE_DEBOUNCE_MS = 200;
/** Catalog rows the API ranks nearest the current target colors (`?nearHex=`). */
const NEARBY_CATALOG_PAGE_SIZE = 120;
/** While the color moves (hover, lightness slider), ask for nearby catalog rows at most this often. */
const NEARBY_FETCH_MIN_INTERVAL_MS = 300;

/** Catalog rows from one `?nearHex=` query, and the query key they were fetched for. */
type NearbyRows = { key: string | null; rows: Polish[]; failedKey: string | null };
const EMPTY_NEARBY_ROWS: NearbyRows = { key: null, rows: [], failedKey: null };

/** Owned rows win over catalog rows for the same shade (both carry the caller's status). */
function mergePolishes(owned: Polish[], nearby: Polish[]): Polish[] {
  const byId = new Map<string, Polish>();
  for (const polish of nearby) byId.set(polish.id, polish);
  for (const polish of owned) byId.set(polish.id, polish);
  return [...byId.values()];
}

function findClosestPolish(
  targetHex: string,
  polishes: ColorPolish[],
): { polish: ColorPolish; distance: number } | null {
  if (polishes.length === 0) return null;

  let closest: ColorPolish | null = null;
  let minDistance = Infinity;
  for (const polish of polishes) {
    const d = colorDistance(targetHex, polish.colorHex);
    if (d < minDistance) {
      minDistance = d;
      closest = polish;
    }
  }

  if (!closest) return null;
  return { polish: closest, distance: minDistance };
}

function useWheelSize(defaultSize = 280, mobileSize = 240) {
  const [size, setSize] = useState(defaultSize);
  useEffect(() => {
    // Phones: shrink the wheel so it and the lightness slider fit beside each other (375px → 215).
    const update = () =>
      setSize(window.innerWidth < 640 ? Math.max(180, Math.min(mobileSize, window.innerWidth - 160)) : defaultSize);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [defaultSize, mobileSize]);
  return size;
}

/**
 * Render the Color Search page UI and manage its state, data, and interactions.
 *
 * Manages loading and fetching of polishes, color selection and preview, harmony generation,
 * palette anchoring and recommendations, filtering (brand, finish, tone, availability, scope),
 * and actions that update polish quantities or apply recommended palettes.
 *
 * @returns The rendered Color Search page content as a React element
 */
function ColorSearchPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  // URL state (#348): filters, selection and focus survive back navigation from a detail page.
  const [initialUrlState] = useState(() => parseColorSearchState(searchParams));
  const [initialHsl] = useState(() => (initialUrlState.color ? hexToHsl(initialUrlState.color) : null));
  const { finishTypes, harmonyTypes } = useReferenceData();
  const finishOptions = useMemo(
    () =>
      finishTypes
        .map((finish) => ({
          value: finish.name,
          label: finish.displayName,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [finishTypes],
  );
  const harmonyTypeOptions = useMemo(
    () => getHarmonyTypeOptions(harmonyTypes),
    [harmonyTypes],
  );
  const selectableHarmonyTypeOptions = useMemo(
    () => harmonyTypeOptions.filter((h) => h.value !== "similar"),
    [harmonyTypeOptions],
  );
  const harmonyLabelByValue = useMemo(
    () => new Map(harmonyTypeOptions.map((h) => [h.value, h.label])),
    [harmonyTypeOptions],
  );
  // The whole owned color collection (complete, so collection results and "have" are exact),
  // plus the catalog rows nearest the current target colors, ranked over the whole catalog by
  // the API (`?nearHex=`) instead of ranking a fetched sample here: one page for the colors the
  // list is ranked against, and one for the rest of the page's colors when those differ.
  const [ownedPolishes, setOwnedPolishes] = useState<Polish[]>([]);
  const [listNearby, setListNearby] = useState<NearbyRows>(EMPTY_NEARBY_ROWS);
  const [contextNearby, setContextNearby] = useState<NearbyRows>(EMPTY_NEARBY_ROWS);
  // Context rows kept from an earlier query are still real catalog rows ranked on the client,
  // so they never push a nearer row out of the list.
  const nearbyPolishes = useMemo(
    () => mergePolishes(listNearby.rows, contextNearby.rows),
    [listNearby.rows, contextNearby.rows]
  );
  const allPolishes = useMemo(() => mergePolishes(ownedPolishes, nearbyPolishes), [ownedPolishes, nearbyPolishes]);
  const [loading, setLoading] = useState(true);
  const wheelSize = useWheelSize();
  const [harmonyType, setHarmonyType] = useState<HarmonyType>(
    initialUrlState.harmony === "all" ? "complementary" : initialUrlState.harmony
  );
  const [includeAllHarmonies, setIncludeAllHarmonies] = useState(initialUrlState.harmony === "all");
  const [wheelMode, setWheelMode] = useState<WheelMode>(initialUrlState.wheelMode);
  const [harmonyColorSet, setHarmonyColorSet] = useState<HarmonyColorSet>(initialUrlState.harmonyColorSet);
  const [resultsScope, setResultsScope] = useState<ResultsScope>(initialUrlState.resultsScope);
  const [toneFilter, setToneFilter] = useState<Undertone | "all">(initialUrlState.toneFilter);
  const [brandFilter, setBrandFilter] = useState<string>(initialUrlState.brandFilter);
  const [finishFilter, setFinishFilter] = useState<string>(initialUrlState.finishFilter);
  const [availabilityFilter, setAvailabilityFilter] = useState<"all" | "owned" | "wishlist">(
    initialUrlState.availabilityFilter
  );
  const [lightness, setLightness] = useState(initialHsl?.l ?? 0.5);
  const [selectedHsl, setSelectedHsl] = useState<HSL | null>(initialHsl);
  const [paletteAnchors, setPaletteAnchors] = useState<string[]>(initialUrlState.paletteAnchors);
  // Page that opened this search (e.g. a look's "Color Lab" link, #386); kept in the URL.
  const [openedFrom, setOpenedFrom] = useState<string | null>(initialUrlState.returnTo);
  const [anchorFeedback, setAnchorFeedback] = useState<string | null>(null);
  const [previewHex, setPreviewHex] = useState<string | null>(null);
  const [externalHoverHex, setExternalHoverHex] = useState<string | null>(null);
  const [focusedTargetHex, setFocusedTargetHex] = useState<string | null>(initialUrlState.target);
  const [wheelPanelCollapsed, setWheelPanelCollapsed] = useState(false);
  const [harmoniesPanelCollapsed, setHarmoniesPanelCollapsed] = useState(false);
  const [activeRecommendedPaletteId, setActiveRecommendedPaletteId] = useState<string | null>(
    initialUrlState.paletteId
  );
  // The clicked (locked) target is URL state; the ref serves callbacks, the state the URL.
  const lockedTargetRef = useRef<string | null>(initialUrlState.target);
  const [lockedTarget, setLockedTargetState] = useState<string | null>(initialUrlState.target);
  const setLockedTarget = useCallback((hex: string | null) => {
    lockedTargetRef.current = hex;
    setLockedTargetState(hex);
  }, []);

  // Derive selectedHex from selectedHsl so lightness slider updates it
  const selectedHex = useMemo(
    () => (selectedHsl ? hslToHex(selectedHsl) : null),
    [selectedHsl]
  );

  // Sync lightness slider → selectedHsl so harmony colors update in realtime
  useEffect(() => {
    setSelectedHsl((prev) => { // eslint-disable-line react-hooks/set-state-in-effect
      if (!prev || prev.l === lightness) return prev;
      return { ...prev, l: lightness };
    });
  }, [lightness]);

  // Canonical URL for the current state (hover, panels and toasts stay in memory).
  const urlState = useMemo<ColorSearchUrlState>(
    () => ({
      color: selectedHex,
      harmony: includeAllHarmonies ? "all" : harmonyType,
      wheelMode,
      harmonyColorSet,
      resultsScope,
      toneFilter,
      brandFilter,
      finishFilter,
      availabilityFilter,
      paletteAnchors,
      target: lockedTarget,
      paletteId: activeRecommendedPaletteId,
      returnTo: openedFrom,
    }),
    [
      selectedHex, includeAllHarmonies, harmonyType, wheelMode, harmonyColorSet, resultsScope, toneFilter,
      brandFilter, finishFilter, availabilityFilter, paletteAnchors, lockedTarget, activeRecommendedPaletteId,
      openedFrom,
    ]
  );
  const queryString = useMemo(() => buildColorSearchQueryString(urlState), [urlState]);
  const returnToHref = queryString ? `${pathname}?${queryString}` : pathname;
  const lastWrittenQueryRef = useRef<string | null>(null);

  // Apply URL changes we did not write ourselves (back/forward, a link while mounted).
  useEffect(() => {
    if (searchParamsString === lastWrittenQueryRef.current) return;
    const next = parseColorSearchState(new URLSearchParams(searchParamsString));
    const nextHsl = next.color ? hexToHsl(next.color) : null;
    /* eslint-disable react-hooks/set-state-in-effect */
    setSelectedHsl(nextHsl);
    if (nextHsl) setLightness(nextHsl.l);
    setIncludeAllHarmonies(next.harmony === "all");
    if (next.harmony !== "all") setHarmonyType(next.harmony);
    setWheelMode(next.wheelMode);
    setHarmonyColorSet(next.harmonyColorSet);
    setResultsScope(next.resultsScope);
    setToneFilter(next.toneFilter);
    setBrandFilter(next.brandFilter);
    setFinishFilter(next.finishFilter);
    setAvailabilityFilter(next.availabilityFilter);
    setPaletteAnchors(next.paletteAnchors);
    setLockedTarget(next.target);
    setFocusedTargetHex(next.target);
    setActiveRecommendedPaletteId(next.paletteId);
    setOpenedFrom(next.returnTo);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [searchParamsString, setLockedTarget]);

  // Write the state back (debounced: the lightness slider changes it on every tick).
  useEffect(() => {
    if (queryString === searchParamsString) return;
    const timeoutId = window.setTimeout(() => {
      lastWrittenQueryRef.current = queryString;
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    }, URL_WRITE_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [pathname, queryString, router, searchParamsString]);

  useEffect(() => {
    let cancelled = false;

    // Color search compares hexes: color polishes only (#349).
    listAllPolishes({ status: ["owned"], categories: ["color"] })
      .then((rows) => {
        if (!cancelled) {
          setOwnedPolishes(rows);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // The color we're actively matching against (hover takes priority over click)
  const activeHex = previewHex ?? selectedHex;
  const isSimilarMode = !includeAllHarmonies && harmonyType === "similar";
  const recommendationHarmonyFilter: "all" | HarmonyType =
    includeAllHarmonies ? "all" : harmonyType;

  // Polishes that have a display hex (vendor, detected, or name)
  const colorPolishes: ColorPolish[] = useMemo(
    () => allPolishes.reduce<ColorPolish[]>((acc, p) => {
      const hex = resolveDisplayHex(p);
      if (hex) acc.push({ ...p, colorHex: hex });
      return acc;
    }, []),
    [allPolishes]
  );

  // Owned polishes with colors — used for snap dots
  const ownedColorPolishes = useMemo(
    () => colorPolishes.filter(isOwnedPolish),
    [colorPolishes]
  );
  const unownedColorPolishes = useMemo(
    () => colorPolishes.filter((p) => !isOwnedPolish(p)),
    [colorPolishes]
  );
  const getAvailabilityForHex = useCallback(
    (hex: string): ColorAvailabilityInfo => {
      const ownedMatch = findClosestPolish(hex, ownedColorPolishes);
      if (ownedMatch && ownedMatch.distance <= AVAILABILITY_MATCH_THRESHOLD) {
        return { status: "have", ownedMatch, purchaseMatch: null };
      }

      const purchaseMatch = findClosestPolish(hex, unownedColorPolishes);
      if (purchaseMatch && purchaseMatch.distance <= AVAILABILITY_MATCH_THRESHOLD) {
        return { status: "buy", ownedMatch: null, purchaseMatch };
      }

      return { status: "virtual", ownedMatch: null, purchaseMatch: null };
    },
    [ownedColorPolishes, unownedColorPolishes],
  );

  const scopedColorPolishes = useMemo(
    () => (resultsScope === "collection" ? ownedColorPolishes : colorPolishes),
    [resultsScope, ownedColorPolishes, colorPolishes]
  );
  // The selected brand stays listed even though the nearby query is then narrowed to it.
  const brandOptions = useMemo(
    () => buildBrandOptions(brandFilter !== "all" ? [...colorPolishes, { brand: brandFilter }] : colorPolishes),
    [colorPolishes, brandFilter]
  );

  const filteredScopedColorPolishes = useMemo(() => {
    let result = scopedColorPolishes;
    if (brandFilter !== "all") {
      const normalizedBrand = brandFilter.toLowerCase();
      result = result.filter((p) => matchesBrandFilter(p.brand, normalizedBrand));
    }
    if (finishFilter !== "all") {
      result = result.filter((p) => polishHasFinish(p, finishFilter));
    }
    if (toneFilter !== "all") {
      result = result.filter((p) => undertone(p.colorHex) === toneFilter);
    }
    if (availabilityFilter !== "all") {
      result = result.filter((p) =>
        availabilityFilter === "owned" ? isOwnedPolish(p) : p.status === "wishlist"
      );
    }
    return result;
  }, [scopedColorPolishes, brandFilter, finishFilter, toneFilter, availabilityFilter]);

  // Snap dots for the wheel
  const snapDots: SnapDot[] = useMemo(
    () =>
      ownedColorPolishes.map((p) => ({
        hex: p.colorHex,
        hsl: hexToHsl(p.colorHex),
      })),
    [ownedColorPolishes]
  );

  const constrainHarmonyHexes = useCallback(
    (hexes: string[], sourceHex: string | null): string[] => {
      const canonicalHexes = hexes.map((hex) => hex.toUpperCase());
      if (harmonyColorSet === "any") return canonicalHexes;

      const candidates = harmonyColorSet === "collection" ? ownedColorPolishes : colorPolishes;
      if (candidates.length === 0) return canonicalHexes;

      const sourceCanonical = sourceHex?.toUpperCase() ?? null;
      return canonicalHexes.map((hex) => {
        if (sourceCanonical && hex === sourceCanonical) return hex;
        const nearest = findClosestPolish(hex, candidates);
        return nearest?.polish.colorHex.toUpperCase() ?? hex;
      });
    },
    [harmonyColorSet, ownedColorPolishes, colorPolishes],
  );

  // Harmony target colors before snapping to polishes — pinned to selectedHex so they don't
  // shift on hover. These (not the snapped ones) drive the nearby catalog query, so the query
  // never depends on its own results.
  const rawHarmonyColors = useMemo(() => {
    if (!selectedHex) return [];
    if (includeAllHarmonies) {
      return uniqueHexes(
        harmonyTypeOptions
          .map((item) => item.value)
          .filter((value): value is HarmonyType => value !== "similar")
          .flatMap((value) => generateHarmonyColors(selectedHex, value))
      );
    }
    return generateHarmonyColors(selectedHex, harmonyType);
  }, [selectedHex, harmonyType, includeAllHarmonies, harmonyTypeOptions]);

  // Generate harmony target colors, snapped to polishes per the harmony color set
  const harmonyColors = useMemo(
    () => (selectedHex ? constrainHarmonyHexes(rawHarmonyColors, selectedHex) : []),
    [selectedHex, rawHarmonyColors, constrainHarmonyHexes]
  );

  // Catalog rows nearest the colors the page matches against, ranked over the whole catalog by
  // the API. Brand and finish filters go to the server so a filtered view is ranked over all its
  // shades. The list's own query follows what the list is ranked against (the hover color only in
  // Similar mode); the context query (focused colors, palette slots, harmony snapping) never
  // includes the hover color, so moving over the wheel in a harmony mode asks for nothing.
  const nearbyTargetsInput = useMemo<NearbyTargetsInput>(
    () => ({
      hoverHex: previewHex,
      selectedHex,
      focusedTargetHex,
      similarMode: isSimilarMode,
      paletteAnchors,
      rawHarmonyColors,
    }),
    [previewHex, selectedHex, focusedTargetHex, isSimilarMode, paletteAnchors, rawHarmonyColors]
  );
  const brandQuery = brandFilter !== "all" ? brandFilter : undefined;
  const finishQuery = finishFilter !== "all" ? finishFilter : undefined;
  const listTargetsKey = listNearbyTargets(nearbyTargetsInput).join(",");
  const contextTargetsKey = contextNearbyTargets(nearbyTargetsInput).join(",");
  const listQuery = useMemo<NearbyQuery>(
    () => ({ nearHex: listTargetsKey ? listTargetsKey.split(",") : [], brand: brandQuery, finish: finishQuery }),
    [listTargetsKey, brandQuery, finishQuery]
  );
  const contextQuery = useMemo<NearbyQuery>(
    () => ({ nearHex: contextTargetsKey ? contextTargetsKey.split(",") : [], brand: brandQuery, finish: finishQuery }),
    [contextTargetsKey, brandQuery, finishQuery]
  );
  const listQueryKey = nearbyQueryKey(listQuery);
  const contextQueryKey = nearbyQueryKey(contextQuery);

  // Throttled, latest-wins loaders: rows follow a moving color (at most one request per
  // interval each), a slow older response never replaces a newer one, and superseded requests
  // are aborted.
  const listLoaderRef = useRef<LatestLoader<NearbyQuery, Polish[]> | null>(null);
  const contextLoaderRef = useRef<LatestLoader<NearbyQuery, Polish[]> | null>(null);
  useEffect(() => {
    const createLoader = (setRows: Dispatch<SetStateAction<NearbyRows>>) =>
      new LatestLoader<NearbyQuery, Polish[]>({
        minIntervalMs: NEARBY_FETCH_MIN_INTERVAL_MS,
        load: (query, signal) =>
          listPolishes(
            {
              categories: ["color"],
              nearHex: query.nearHex,
              brand: query.brand,
              finish: query.finish,
              pageSize: NEARBY_CATALOG_PAGE_SIZE,
            },
            { signal }
          ).then((response) => response.polishes),
        onLoaded: (key, rows) => setRows({ key, rows, failedKey: null }),
        onFailed: (key) => setRows((prev) => ({ ...prev, failedKey: key })),
      });
    const listLoader = createLoader(setListNearby);
    const contextLoader = createLoader(setContextNearby);
    listLoaderRef.current = listLoader;
    contextLoaderRef.current = contextLoader;
    return () => {
      listLoader.dispose();
      contextLoader.dispose();
      listLoaderRef.current = null;
      contextLoaderRef.current = null;
    };
  }, []);
  useEffect(() => {
    listLoaderRef.current?.request(listQueryKey, listQuery);
  }, [listQueryKey, listQuery]);
  useEffect(() => {
    // Same colors as the list: its rows already cover them.
    const key = contextQueryKey === listQueryKey ? null : contextQueryKey;
    contextLoaderRef.current?.request(key, contextQuery);
  }, [contextQueryKey, listQueryKey, contextQuery]);

  // The list is ranked on the client the moment the color moves; until the catalog rows for the
  // new colors arrive, it may miss nearer catalog shades (My Collection is always complete).
  const catalogInResults = resultsScope === "all";
  const catalogFailed = catalogInResults && listQueryKey !== null && listNearby.failedKey === listQueryKey;
  const catalogPending =
    catalogInResults && listQueryKey !== null && listNearby.key !== listQueryKey && !catalogFailed;

  // Harmony target dots for the color wheel (diamonds)
  const harmonyDots: HarmonyDot[] = useMemo(() => {
    if (!selectedHex || isSimilarMode || harmonyColors.length === 0) return [];
    return harmonyColors.map((hex) => {
      const hsl = hexToHsl(hex);
      let closestSnapIndex: number | null = null;
      if (wheelMode === "snap" && snapDots.length > 0) {
        let minDist = Infinity;
        for (let i = 0; i < snapDots.length; i++) {
          const d = colorDistance(hex, snapDots[i].hex);
          if (d < minDist) {
            minDist = d;
            closestSnapIndex = i;
          }
        }
      }
      return { hex, hsl, closestSnapIndex };
    });
  }, [selectedHex, isSimilarMode, harmonyColors, wheelMode, snapDots]);

  const wantedColorStatuses = useMemo<WantedColorStatus[]>(
    () => paletteAnchors.map((hex) => ({ hex, availability: getAvailabilityForHex(hex) })),
    [paletteAnchors, getAvailabilityForHex],
  );

  const recommendedPalettes = useMemo<RecommendedPalette[]>(() => {
    const seeds = uniqueHexes(
      paletteAnchors.length > 0
        ? paletteAnchors
        : selectedHex
          ? [selectedHex]
          : [],
    );
    if (seeds.length === 0) return [];

    const fitColors = uniqueHexes(
      paletteAnchors.length > 0
        ? paletteAnchors
        : selectedHex
          ? [selectedHex]
          : [],
    );
    const harmonies = harmonyTypeOptions.map((item) => item.value).filter(
      (h): h is HarmonyType => h !== "similar",
    );
    const seen = new Set<string>();
    const candidates: RecommendedPalette[] = [];

    for (const sourceHex of seeds) {
      for (const harmony of harmonies) {
        if (recommendationHarmonyFilter !== "all" && recommendationHarmonyFilter !== harmony) continue;

        const rawSlots = generateHarmonyPalette(sourceHex, harmony);
        const slotHexes = constrainHarmonyHexes(rawSlots, sourceHex);
        const key = `${harmony}:${slotHexes.join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const slotStatuses = slotHexes.map((hex) => getAvailabilityForHex(hex));
        const haveCount = slotStatuses.filter((s) => s.status === "have").length;
        const buyCount = slotStatuses.filter((s) => s.status === "buy").length;
        const slotCount = slotHexes.length;
        const haveCoverage = haveCount / slotCount;
        const buyCoverage = buyCount / slotCount;
        const virtualCoverage = 1 - haveCoverage - buyCoverage;

        let avgMinDistance = 0;
        if (fitColors.length > 0) {
          let sumMin = 0;
          for (const fitHex of fitColors) {
            let minDist = Infinity;
            for (const slotHex of slotHexes) {
              const d = colorDistance(fitHex, slotHex);
              if (d < minDist) minDist = d;
            }
            sumMin += minDist;
          }
          avgMinDistance = sumMin / fitColors.length;
        }
        const fitQuality = fitColors.length > 0 ? 1 - Math.min(avgMinDistance / 0.25, 1) : 0.5;
        const score = haveCoverage * 0.7 + buyCoverage * 0.2 + fitQuality * 0.1;

        candidates.push({
          id: `${harmony}-${sourceHex}-${slotHexes.join("-")}`,
          harmony,
          sourceHex,
          slotHexes,
          slotStatuses,
          haveCoverage,
          buyCoverage,
          virtualCoverage,
          fitQuality,
          score,
        });
      }
    }

    return candidates.sort((a, b) => {
      if (b.haveCoverage !== a.haveCoverage) return b.haveCoverage - a.haveCoverage;
      if (b.buyCoverage !== a.buyCoverage) return b.buyCoverage - a.buyCoverage;
      return b.score - a.score;
    }).slice(0, 12);
  }, [
    paletteAnchors,
    selectedHex,
    recommendationHarmonyFilter,
    constrainHarmonyHexes,
    getAvailabilityForHex,
    harmonyTypeOptions,
  ]);

  const activeRecommendedPalette = useMemo(
    () => recommendedPalettes.find((candidate) => candidate.id === activeRecommendedPaletteId) ?? null,
    [recommendedPalettes, activeRecommendedPaletteId],
  );

  // Colors to match against — includes source for harmony modes
  const targetColors = useMemo(() => {
    if (activeRecommendedPalette) {
      return activeRecommendedPalette.slotHexes;
    }
    if (isSimilarMode) {
      return activeHex ? [activeHex] : [];
    }
    if (!selectedHex) return [];
    return [selectedHex, ...harmonyColors];
  }, [activeRecommendedPalette, isSimilarMode, activeHex, selectedHex, harmonyColors]);

  // Sort polishes by distance — if a target is focused, match only that color. Hexes guessed
  // from the color name rank after every measured one (`compareColorSearchRank`, like `?nearHex=`).
  const sortedPolishes = useMemo(() => {
    const colorsToMatch = focusedTargetHex ? [focusedTargetHex] : targetColors;
    if (colorsToMatch.length === 0) return [];
    return filteredScopedColorPolishes
      .map((p) => {
        let minDist = Infinity;
        let matchedHarmonyHex = colorsToMatch[0];
        let matchedHarmonyIndex = 0;
        for (let i = 0; i < colorsToMatch.length; i++) {
          const d = colorDistance(colorsToMatch[i], p.colorHex);
          if (d < minDist) {
            minDist = d;
            matchedHarmonyHex = colorsToMatch[i];
            matchedHarmonyIndex = i;
          }
        }
        return {
          ...p,
          distance: Math.min(minDist / MAX_DISTANCE, 1),
          estimated: isEstimatedDisplayHex(p),
          matchedHarmonyHex,
          matchedHarmonyIndex,
        };
      })
      .sort(compareColorSearchRank);
  }, [focusedTargetHex, targetColors, filteredScopedColorPolishes]);

  const handleHover = useCallback(
    (hex: string, _hsl: HSL) => { // eslint-disable-line @typescript-eslint/no-unused-vars
      setPreviewHex(hex);
    },
    []
  );

  const handleSelect = useCallback((hex: string, hsl: HSL) => {
    setSelectedHsl(hsl);
    setLightness(hsl.l);
    setActiveRecommendedPaletteId(null);
    // Clear focus/lock on new wheel selection
    setLockedTarget(null);
    setFocusedTargetHex(null);
  }, [setLockedTarget]);

  const handleExternalColorSelect = useCallback((hex: string) => {
    const hsl = hexToHsl(hex);
    setSelectedHsl(hsl);
    setLightness(hsl.l);
    setActiveRecommendedPaletteId(null);
  }, []);

  const addPaletteAnchorHex = useCallback((hex: string | null) => {
    if (!hex) {
      setAnchorFeedback("No focused color");
      return;
    }
    const canonical = hex.toUpperCase();
    setPaletteAnchors((prev) => {
      if (prev.includes(canonical)) {
        setAnchorFeedback(`Already focused ${canonical}`);
        return prev;
      }
      setAnchorFeedback(`Focused ${canonical}`);
      return [...prev, canonical].slice(-8);
    });
  }, []);

  const handleAddFocusedPaletteAnchor = useCallback(() => {
    const hex = focusedTargetHex ?? selectedHex ?? activeHex;
    addPaletteAnchorHex(hex);
  }, [focusedTargetHex, selectedHex, activeHex, addPaletteAnchorHex]);
  const handleRemoveSelectedPaletteColor = useCallback(() => {
    const hex = (focusedTargetHex ?? selectedHex)?.toUpperCase();
    if (!hex) {
      setAnchorFeedback("No focused color to remove");
      return;
    }
    setPaletteAnchors((prev) => {
      const next = prev.filter((c) => c !== hex);
      if (next.length === prev.length) {
        setAnchorFeedback(`${hex} is not in focused colors`);
        return prev;
      }
      setAnchorFeedback(`Unfocused ${hex}`);
      return next;
    });
  }, [focusedTargetHex, selectedHex]);
  const iconColorForHex = useCallback((hex: string) => {
    const l = hexToHsl(hex).l;
    return l > 0.62 ? "#111827" : "#F8FAFC";
  }, []);

  const handleClearPaletteAnchors = useCallback(() => {
    setPaletteAnchors([]);
    setAnchorFeedback(null);
  }, []);

  useEffect(() => {
    if (!anchorFeedback) return;
    const t = window.setTimeout(() => setAnchorFeedback(null), 1800);
    return () => window.clearTimeout(t);
  }, [anchorFeedback]);

  // Swatch hover/click handlers — affect wheel marker + table filter
  const handleSwatchHover = useCallback((hex: string) => {
    setExternalHoverHex(hex);
    setFocusedTargetHex(hex);
  }, []);

  const handleSwatchLeave = useCallback(() => {
    setExternalHoverHex(null);
    setFocusedTargetHex(lockedTargetRef.current);
  }, []);

  const handleSwatchClick = useCallback((hex: string) => {
    if (lockedTargetRef.current === hex) {
      setLockedTarget(null);
      setFocusedTargetHex(null);
    } else {
      setLockedTarget(hex);
      setFocusedTargetHex(hex);
    }
  }, [setLockedTarget]);

  // Row color dot hover — affects wheel marker only, not table filter
  const handleColorHover = useCallback((hex: string) => {
    setExternalHoverHex(hex);
  }, []);

  const handleColorLeave = useCallback(() => {
    setExternalHoverHex(null);
  }, []);

  const handleMouseLeaveWheel = useCallback(() => {
    setPreviewHex(null);
  }, []);

  // Add guard (#266): adding a not-owned shade shows its owned near-dupes first.
  const { guardAdd, active: activeGuard, choose: chooseGuard, isChecking: isGuardChecking } = useAddGuard();
  const isAddPending = useCallback(
    (polishId: string) => isGuardChecking(shadeGuardKey(polishId)),
    [isGuardChecking]
  );

  // Put a changed row in both lists: replaced in the nearby rows, and in or out of the owned
  // collection by its new status.
  const upsertPolish = useCallback((next: Polish) => {
    const replaceRow = (prev: NearbyRows): NearbyRows => ({
      ...prev,
      rows: prev.rows.map((p) => (p.id === next.id ? next : p)),
    });
    setListNearby(replaceRow);
    setContextNearby(replaceRow);
    setOwnedPolishes((prev) => {
      const without = prev.filter((p) => p.id !== next.id);
      return isOwnedPolish(next) ? [...without, next] : without;
    });
  }, []);

  // Optimistic inventory update (rolled back on failure)
  const applyInventoryChange = useCallback(
    (original: Polish, change: Pick<PolishUpdateRequest, "quantity" | "status">) => {
      upsertPolish(applyInventoryPatch(original, change));

      updatePolish(original.id, change)
        .then((updated) => {
          upsertPolish(updated);
          if (isArchivingChange(original, change)) {
            showArchivedToast({ polish: updated, onUpdated: upsertPolish });
          }
        })
        .catch(() => {
          upsertPolish(original);
        });
    },
    [upsertPolish]
  );

  const handleQuantityChange = useCallback(
    (polishId: string, delta: number) => {
      const original = allPolishes.find((p) => p.id === polishId);
      if (!original) return;

      if (delta > 0 && !isOwnedPolish(original)) {
        void guardAdd({
          guardKey: shadeGuardKey(original.id),
          shadeLabel: `${original.brand} ${original.name}`,
          status: original.status,
          intent: "own",
          surface: "color-search",
          loadDupes: () => getPolishDupes(original.id),
          proceed: (intent) => {
            if (intent === "wishlist") {
              applyInventoryChange(original, wishlistInsteadUpdate());
              toast.success("Added to wishlist", {
                description: `${original.brand} ${original.name} is on your wishlist.`,
              });
              return;
            }
            applyInventoryChange(original, quantityChangeUpdate(original, delta));
          },
        });
        return;
      }

      applyInventoryChange(original, quantityChangeUpdate(original, delta));
    },
    [allPolishes, guardAdd, applyInventoryChange]
  );

  const handleApplyRecommendedPalette = useCallback((
    candidate: RecommendedPalette,
    focusedHex?: string,
  ) => {
    const sourceHex = candidate.sourceHex.toUpperCase();
    const sourceHsl = hexToHsl(sourceHex);
    const harmonyLabel = harmonyLabelByValue.get(candidate.harmony) ?? candidate.harmony;
    const normalizedFocusHex = focusedHex?.toUpperCase() ?? null;

    setLockedTarget(normalizedFocusHex);
    setFocusedTargetHex(normalizedFocusHex);
    setExternalHoverHex(null);
    setPreviewHex(null);
    setActiveRecommendedPaletteId(candidate.id);
    setIncludeAllHarmonies(false);
    setHarmonyType(candidate.harmony);
    setSelectedHsl(sourceHsl);
    setLightness(sourceHsl.l);
    setAnchorFeedback(`Applied ${harmonyLabel} palette to search results`);
  }, [harmonyLabelByValue, setLockedTarget]);

  const layoutCols = "xl:grid-cols-[minmax(360px,_460px)_minmax(0,_1fr)]";

  if (loading) {
    return <BrandSpinner label="Loading color inventory…" />;
  }

  return (
    <div className="space-y-6">
      <div>
        {openedFrom ? (
          <Link
            href={openedFrom}
            className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to {returnToLabel(openedFrom)}
          </Link>
        ) : null}
        <h1 className="heading-page">Color Search</h1>
        <p className="text-muted-foreground">
          Explore your collection by color. Hover to preview, click to select.
        </p>
      </div>

      <div className={`grid gap-6 ${layoutCols}`}>
        <div className="space-y-6 xl:col-start-1">
          <Card className="relative overflow-hidden">
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-pink-soft via-brand-lilac to-brand-purple"
            />
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle>Pick a Color</CardTitle>
                  <CardDescription>
                    {selectedHex
                      ? "Hover to preview, click to update focus."
                      : "Use the wheel, harmony swatches, or table dots to focus a color."}
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setWheelPanelCollapsed((prev) => !prev)}
                  aria-label={wheelPanelCollapsed ? "Expand color wheel panel" : "Collapse color wheel panel"}
                >
                  {wheelPanelCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                </Button>
              </div>
            </CardHeader>
            {wheelPanelCollapsed ? (
              <CardContent className="pt-0">
                <p className="text-xs text-muted-foreground">
                  Focus is set to <span className="font-mono">{selectedHex ?? "--"}</span>. Expand to adjust.
                </p>
              </CardContent>
            ) : (
              <CardContent className="space-y-4 px-4 sm:px-6">
                <div className="mx-auto flex w-fit items-center gap-2 sm:gap-4" onMouseLeave={handleMouseLeaveWheel}>
                  <div className="rounded-[2rem] bg-gradient-brand p-[2px] shadow-glow-brand">
                    <div className="glass rounded-[calc(2rem-2px)] p-1.5 sm:p-3">
                      <div className="rounded-full border border-white/60 bg-background/65 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)]">
                        <ColorWheel
                          lightness={lightness}
                          onHover={handleHover}
                          onSelect={handleSelect}
                          selectedHsl={selectedHsl}
                          size={wheelSize}
                          wheelMode={wheelMode}
                          snapDots={snapDots}
                          externalHoverHex={externalHoverHex}
                          harmonyDots={harmonyDots}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex h-[292px] flex-col items-center justify-between rounded-xl border bg-muted/35 px-2 py-3">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Light</span>
                    <div className="flex items-center justify-center">
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={lightness}
                        onChange={(e) => setLightness(parseFloat(e.target.value))}
                        className="h-[200px] w-8 accent-primary"
                        aria-label="Lightness"
                        aria-orientation="vertical"
                        {...({ orient: "vertical" } as object)}
                        style={{
                          writingMode: "vertical-lr",
                          WebkitAppearance: "slider-vertical",
                          direction: "rtl",
                          background: `linear-gradient(to top, #000, ${hslToHex({ h: selectedHsl?.h ?? 0, s: selectedHsl?.s ?? 1, l: 0.5 })}, #fff)`,
                          borderRadius: "9999px",
                        }}
                      />
                    </div>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Dark</span>
                  </div>
                </div>

                <div className="grid w-full gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                  <div className="flex justify-start">
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 rounded-full px-2.5 text-[11px] font-medium pointer-coarse:h-9"
                      variant={wheelMode === "snap" ? "default" : "outline"}
                      onClick={() => setWheelMode((prev) => (prev === "snap" ? "free" : "snap"))}
                      title={wheelMode === "snap" ? "Mine mode is on. Click to turn off." : "Mine mode is off. Click to turn on."}
                    >
                      ◎ Mine
                    </Button>
                  </div>

                  <div className="flex justify-center">
                    <div className="flex w-fit items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs">
                      <span
                        className={`inline-block h-4 w-4 rounded-full border ${
                          selectedHex ? "shadow-glow-brand ring-1 ring-brand-purple/35" : ""
                        }`}
                        style={{ backgroundColor: selectedHex ?? "transparent" }}
                      />
                      <span className="text-muted-foreground">Focused</span>
                      <span className="font-mono">{selectedHex ?? "--"}</span>
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <div className="flex items-center gap-1 rounded-full border bg-background px-2 py-1.5">
                      <span className="text-xs font-medium text-muted-foreground">Focus</span>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="secondary"
                        className="h-6 w-6 rounded-full pointer-coarse:size-9"
                        onClick={() => addPaletteAnchorHex(selectedHex)}
                        disabled={!selectedHex}
                        aria-label="Add focused color"
                        title="Add focused color"
                      >
                        <BsPlusLg className="h-3 w-3" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            )}
          </Card>

          <Card className="relative overflow-hidden">
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-lilac via-brand-pink-soft to-brand-purple"
            />
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle>Harmonies</CardTitle>
                  <CardDescription>
                    Build focused colors and explore top palette recommendations.
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setHarmoniesPanelCollapsed((prev) => !prev)}
                  aria-label={harmoniesPanelCollapsed ? "Expand harmonies panel" : "Collapse harmonies panel"}
                >
                  {harmoniesPanelCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                </Button>
              </div>
            </CardHeader>
            {harmoniesPanelCollapsed ? (
              <CardContent className="pt-0">
                <p className="text-xs text-muted-foreground">
                  Harmonies hidden while you refine selection. Expand when ready to build focus palettes.
                </p>
              </CardContent>
            ) : (
              <CardContent className="space-y-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Harmony Type</p>
                <div className="grid grid-cols-4 gap-1 rounded-lg border bg-muted/60 p-1 sm:grid-cols-7">
                  <Button
                    type="button"
                    size="sm"
                    variant={includeAllHarmonies ? "default" : "ghost"}
                    className="h-7 w-full rounded-md px-0 pointer-coarse:h-9"
                    title="All harmony types"
                    aria-label="Set harmony type to all"
                    onClick={() => {
                      setIncludeAllHarmonies(true);
                      setActiveRecommendedPaletteId(null);
                      setLockedTarget(null);
                      setFocusedTargetHex(null);
                    }}
                  >
                    <span className="text-sm leading-none">{ALL_HARMONY_SYMBOL}</span>
                  </Button>
                  {selectableHarmonyTypeOptions.map((h) => (
                    <Button
                      key={h.value}
                      type="button"
                      size="sm"
                      variant={!includeAllHarmonies && harmonyType === h.value ? "default" : "ghost"}
                      className="h-7 w-full rounded-md px-0 pointer-coarse:h-9"
                      title={h.label}
                      aria-label={`Set harmony type to ${h.label}`}
                      onClick={() => {
                        setIncludeAllHarmonies(false);
                        setHarmonyType(h.value);
                        setActiveRecommendedPaletteId(null);
                        setLockedTarget(null);
                        setFocusedTargetHex(null);
                      }}
                    >
                      <span className="text-sm leading-none">{HARMONY_SYMBOLS[h.value]}</span>
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Harmony Color Set</p>
                <div className="flex w-full rounded-lg border bg-muted p-1">
                  <Button
                    variant={harmonyColorSet === "any" ? "default" : "ghost"}
                    size="sm"
                    className="flex-1"
                    onClick={() => setHarmonyColorSet("any")}
                  >
                    Any
                  </Button>
                  <Button
                    variant={harmonyColorSet === "all" ? "default" : "ghost"}
                    size="sm"
                    className="flex-1"
                    onClick={() => setHarmonyColorSet("all")}
                  >
                    All
                  </Button>
                  <Button
                    variant={harmonyColorSet === "collection" ? "default" : "ghost"}
                    size="sm"
                    className="flex-1"
                    onClick={() => setHarmonyColorSet("collection")}
                  >
                    Mine
                  </Button>
                </div>
              </div>

              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Focus</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {paletteAnchors.length} color{paletteAnchors.length === 1 ? "" : "s"}
                    </span>
                    {paletteAnchors.length > 0 && (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="outline"
                        className="h-6 w-6 border-brand-lilac/60 text-muted-foreground hover:border-brand-purple/60 hover:text-foreground"
                        onClick={handleClearPaletteAnchors}
                        aria-label="Clear focused colors"
                        title="Clear focused colors"
                      >
                        <BsTrash3Fill className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </div>
                {anchorFeedback && (
                  <p className="text-xs text-muted-foreground">{anchorFeedback}</p>
                )}
                <div className="flex items-stretch gap-2">
                  <div className="flex h-10 flex-1 overflow-hidden rounded-md border">
                    {wantedColorStatuses.length === 0 ? (
                      <div className="flex w-full items-center justify-center text-xs text-muted-foreground">
                        Add focused colors from wheel, table, or palette suggestions
                      </div>
                    ) : (
                      wantedColorStatuses.map(({ hex, availability }) => {
                        const status = availability.status;
                        const Icon = AVAILABILITY_ICON[status];
                        return (
                        <button
                          key={hex}
                          type="button"
                          className={`relative flex-1 transition-all duration-150 ${
                            focusedTargetHex === hex
                              ? "z-10 scale-[1.06] ring-2 ring-brand-purple/75 ring-offset-1 ring-offset-background shadow-glow-brand outline outline-1 outline-white/85"
                              : "hover:opacity-90 hover:scale-[1.01]"
                          }`}
                          style={{ backgroundColor: hex }}
                          title={`${hex} • ${AVAILABILITY_META[status].label}`}
                          onMouseEnter={() => handleSwatchHover(hex)}
                          onMouseLeave={handleSwatchLeave}
                            onClick={() => {
                              handleSwatchClick(hex);
                              handleExternalColorSelect(hex);
                          }}
                        >
                          {focusedTargetHex === hex && (
                            <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full border border-white bg-brand-purple shadow-glow-purple" />
                          )}
                          <span className="absolute inset-0 flex items-center justify-center">
                            <Icon className="h-4 w-4" style={{ color: iconColorForHex(hex) }} />
                          </span>
                        </button>
                      );
                      })
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="secondary"
                      className="h-10 w-10"
                      onClick={handleAddFocusedPaletteAnchor}
                      disabled={!focusedTargetHex && !selectedHex}
                      aria-label="Add focused color"
                      title="Add focused color"
                    >
                      <BsPlusLg className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="outline"
                      className="h-10 w-10"
                      onClick={handleRemoveSelectedPaletteColor}
                      disabled={paletteAnchors.length === 0 || (!focusedTargetHex && !selectedHex)}
                      aria-label="Remove focused color"
                      title="Remove focused color"
                    >
                      <BsTrash3Fill className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </div>

              <div className="space-y-2 rounded-md border bg-muted/30 p-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">Recommended Palettes</p>
                  <p className="text-[10px] text-muted-foreground">
                    {recommendationHarmonyFilter === "all"
                      ? "Top 12 by Have %, then Buy %"
                      : `Showing ${harmonyLabelByValue.get(recommendationHarmonyFilter) ?? "selected"} only`}
                  </p>
                </div>
                {recommendedPalettes.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Add focused colors or pick a source color to generate recommendations.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {recommendedPalettes.map((candidate) => {
                      const harmonyName = harmonyLabelByValue.get(candidate.harmony) ?? candidate.harmony;
                      return (
                        <div
                          key={candidate.id}
                          className={`glass cursor-pointer rounded-lg border bg-background/70 p-2 shadow-[0_12px_26px_rgba(66,16,126,0.12)] transition-all ${
                            activeRecommendedPalette?.id === candidate.id
                              ? "border-brand-purple/65 ring-2 ring-brand-purple/35 shadow-glow-brand"
                              : "border-brand-lilac/45 hover:shadow-glow-brand"
                          }`}
                          onClick={() => handleApplyRecommendedPalette(candidate)}
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <span
                                className="inline-flex h-5 w-5 items-center justify-center rounded border text-xs"
                                title={harmonyName}
                              >
                                {HARMONY_SYMBOLS[candidate.harmony]}
                              </span>
                              <p className="truncate text-xs font-medium">{harmonyName}</p>
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                              {(candidate.haveCoverage * 100).toFixed(0)}% Have •{" "}
                              {(candidate.buyCoverage * 100).toFixed(0)}% Buy
                            </p>
                          </div>
                          <div className="flex h-10 overflow-hidden rounded-md border">
                            {candidate.slotHexes.map((hex, index) => {
                              const status = candidate.slotStatuses[index]?.status ?? "virtual";
                              const Icon = AVAILABILITY_ICON[status];
                              return (
                                <button
                                  key={`${candidate.id}-${hex}-${index}`}
                                  type="button"
                                  className={`relative flex-1 transition-all duration-150 ${
                                    focusedTargetHex === hex
                                      ? "z-10 scale-[1.06] ring-2 ring-brand-purple/75 ring-offset-1 ring-offset-background shadow-glow-brand outline outline-1 outline-white/85"
                                      : "hover:opacity-90 hover:scale-[1.01]"
                                  }`}
                                  style={{ backgroundColor: hex }}
                                  title={`${hex} • ${AVAILABILITY_META[status].label}`}
                                  onMouseEnter={() => handleSwatchHover(hex)}
                                  onMouseLeave={handleSwatchLeave}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleApplyRecommendedPalette(candidate, hex);
                                  }}
                                >
                                  {focusedTargetHex === hex && (
                                    <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full border border-white bg-brand-purple shadow-glow-purple" />
                                  )}
                                  <span className="absolute inset-0 flex items-center justify-center">
                                    <Icon className="h-4 w-4" style={{ color: iconColorForHex(hex) }} />
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              </CardContent>
            )}
          </Card>
        </div>

        <Card className="relative overflow-hidden xl:col-start-2">
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-purple via-brand-lilac to-brand-pink-soft"
          />
          <CardHeader>
            <CardTitle>
              {isSimilarMode ? "Similar Colors" : "Harmony Matches"}
              {resultsScope === "collection" && " — My Collection"}
            </CardTitle>
            <CardDescription>
              {activeHex
                ? `Polishes sorted by ${
                    isSimilarMode ? "similarity to" : "best harmony for"
                  } your selection`
                : "Pick or hover a color on the wheel to see matches"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg border bg-muted p-1">
                <Button
                  variant={resultsScope === "all" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setResultsScope("all")}
                >
                  All
                </Button>
                <Button
                  variant={resultsScope === "collection" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setResultsScope("collection")}
                >
                  My Collection
                </Button>
              </div>
              <Select
                value={toneFilter}
                onValueChange={(v) => setToneFilter(v as Undertone | "all")}
              >
                <SelectTrigger className="h-8 w-[140px]">
                  <SelectValue placeholder="Tone" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Tones</SelectItem>
                  <SelectItem value="warm">Warm</SelectItem>
                  <SelectItem value="cool">Cool</SelectItem>
                  <SelectItem value="neutral">Neutral</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={brandFilter}
                onValueChange={setBrandFilter}
              >
                <SelectTrigger className="h-8 w-[180px]">
                  <SelectValue placeholder="Brand" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Brands</SelectItem>
                  {brandOptions.map((brand) => (
                    <SelectItem key={brand} value={brand}>
                      {brand}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={finishFilter}
                onValueChange={setFinishFilter}
              >
                <SelectTrigger className="h-8 w-[160px]">
                  <SelectValue placeholder="Finish" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Finishes</SelectItem>
                  {finishOptions.map((finish) => (
                    <SelectItem key={finish.value} value={finish.value}>
                      {finish.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={availabilityFilter}
                onValueChange={(v) => setAvailabilityFilter(v as "all" | "owned" | "wishlist")}
              >
                <SelectTrigger className="h-8 w-[170px]">
                  <SelectValue placeholder="Availability" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Items</SelectItem>
                  <SelectItem value="owned">In Collection</SelectItem>
                  <SelectItem value="wishlist">Wishlist</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-xs text-muted-foreground"
                onClick={() => {
                  setResultsScope("all");
                  setToneFilter("all");
                  setBrandFilter("all");
                  setFinishFilter("all");
                  setAvailabilityFilter("all");
                }}
              >
                Clear filters
              </Button>
            </div>

            {activeHex && targetColors.length > 0 ? (
              <>
              <p
                aria-live="polite"
                className={`flex min-h-4 items-center gap-1.5 text-xs text-muted-foreground transition-opacity ${
                  catalogPending || catalogFailed ? "opacity-100 delay-150" : "opacity-0"
                }`}
              >
                {catalogFailed ? (
                  "Couldn't load catalog matches for this color. Showing your collection and earlier matches."
                ) : catalogPending ? (
                  <>
                    <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                    Updating catalog matches…
                  </>
                ) : null}
              </p>
              <ColorSearchResults
                polishes={sortedPolishes}
                provisional={catalogPending}
                harmonyColors={targetColors}
                showMatchDots={!isSimilarMode}
                finishTypes={finishTypes}
                focusedTargetHex={focusedTargetHex}
                onQuantityChange={handleQuantityChange}
                isAddPending={isAddPending}
                onAddFocus={(hex) => {
                  handleExternalColorSelect(hex);
                  addPaletteAnchorHex(hex);
                }}
                onSwatchHover={handleSwatchHover}
                onSwatchLeave={handleSwatchLeave}
                onSwatchClick={handleSwatchClick}
                onColorSelect={handleExternalColorSelect}
                onColorHover={handleColorHover}
                onColorLeave={handleColorLeave}
                returnTo={returnToHref}
              />
              </>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <span className="text-4xl">🎨</span>
                <p className="mt-3 text-sm text-muted-foreground">
                  Pick or hover a color on the wheel to see matches
                </p>
              </div>
            )}
          </CardContent>
        </Card>

      </div>
      <AddGuardDialog guard={activeGuard} onChoice={chooseGuard} returnTo={returnToHref} />
    </div>
  );
}

export default function ColorSearchPage() {
  return (
    <Suspense fallback={<BrandSpinner label="Loading color search…" />}>
      <ColorSearchPageContent />
    </Suspense>
  );
}
