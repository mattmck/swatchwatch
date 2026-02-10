"use client";

import { useState, useMemo, useCallback, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import type { Polish } from "swatchwatch-shared";
import type { IconType } from "react-icons";
import { BsCurrencyDollar, BsPlusLg, BsQuestionCircleFill, BsTrash3Fill } from "react-icons/bs";
import { GiPerfumeBottle } from "react-icons/gi";
import { listPolishes, updatePolish } from "@/lib/api";
import {
  colorDistance,
  hexToHsl,
  hslToHex,
  undertone,
  type Undertone,
  type HSL,
} from "@/lib/color-utils";
import {
  HARMONY_TYPES,
  generateHarmonyColors,
  generateHarmonyPalette,
  type HarmonyType,
} from "@/lib/color-harmonies";
import { ColorWheel, type WheelMode, type SnapDot, type HarmonyDot } from "@/components/color-wheel";
import { ColorSearchResults } from "@/components/color-search-results";
import { Button } from "@/components/ui/button";
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
import { FINISHES } from "@/lib/constants";

type ResultsScope = "all" | "collection";
type HarmonyColorSet = "any" | "all" | "collection";
type ColorPolish = Polish & { colorHex: string };
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

function uniqueHexes(hexes: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const hex of hexes) {
    const canonical = hex.toUpperCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }
  return result;
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

function ColorSearchPageContent() {
  const searchParams = useSearchParams();
  const [allPolishes, setAllPolishes] = useState<Polish[]>([]);
  const [loading, setLoading] = useState(true); // eslint-disable-line @typescript-eslint/no-unused-vars
  const [harmonyType, setHarmonyType] = useState<HarmonyType>("similar");
  const [wheelMode, setWheelMode] = useState<WheelMode>("free");
  const [harmonyColorSet, setHarmonyColorSet] = useState<HarmonyColorSet>("any");
  const [recommendationHarmonyFilter, setRecommendationHarmonyFilter] = useState<"all" | HarmonyType>("all");
  const [resultsScope, setResultsScope] = useState<ResultsScope>("all");
  const [toneFilter, setToneFilter] = useState<Undertone | "all">("all");
  const [finishFilter, setFinishFilter] = useState<string>("all");
  const [lightness, setLightness] = useState(0.5);
  const [selectedHsl, setSelectedHsl] = useState<HSL | null>(null);
  const [paletteAnchors, setPaletteAnchors] = useState<string[]>([]);
  const [anchorFeedback, setAnchorFeedback] = useState<string | null>(null);
  const [previewHex, setPreviewHex] = useState<string | null>(null);
  const [externalHoverHex, setExternalHoverHex] = useState<string | null>(null);
  const [focusedTargetHex, setFocusedTargetHex] = useState<string | null>(null);
  const lockedTargetRef = useRef<string | null>(null);

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

  // Clear focus/lock when harmony type changes
  useEffect(() => {
    lockedTargetRef.current = null;
    setFocusedTargetHex(null); // eslint-disable-line react-hooks/set-state-in-effect
  }, [harmonyType]);

  // Initialize from URL params
  useEffect(() => {
    const colorParam = searchParams.get("color");
    if (colorParam) {
      const hex = colorParam.startsWith("#") ? colorParam : `#${colorParam}`;
      if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
        const hsl = hexToHsl(hex);
        setSelectedHsl(hsl); // eslint-disable-line react-hooks/set-state-in-effect
        setLightness(hsl.l);
      }
    }
    const harmonyParam = searchParams.get("harmony");
    if (harmonyParam && HARMONY_TYPES.some((h) => h.value === harmonyParam)) {
      setHarmonyType(harmonyParam as HarmonyType);
    }
  }, [searchParams]);

  useEffect(() => {
    listPolishes()
      .then((res) => setAllPolishes(res.polishes))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const isOwned = (p: Polish) => (p.quantity ?? 0) > 0;

  // The color we're actively matching against (hover takes priority over click)
  const activeHex = previewHex ?? selectedHex;

  // Polishes that have a colorHex
  const colorPolishes = useMemo(
    () => allPolishes.filter((p): p is Polish & { colorHex: string } => !!p.colorHex),
    [allPolishes]
  );

  // Owned polishes with colors — used for snap dots
  const ownedColorPolishes = useMemo(
    () => colorPolishes.filter(isOwned),
    [colorPolishes]
  );
  const unownedColorPolishes = useMemo(
    () => colorPolishes.filter((p) => !isOwned(p)),
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
  const filteredScopedColorPolishes = useMemo(() => {
    let result = scopedColorPolishes;
    if (finishFilter !== "all") {
      result = result.filter((p) => p.finish === finishFilter);
    }
    if (toneFilter !== "all") {
      result = result.filter((p) => undertone(p.colorHex) === toneFilter);
    }
    return result;
  }, [scopedColorPolishes, finishFilter, toneFilter]);

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

  // Generate harmony target colors — pinned to selectedHex so they don't shift on hover
  const harmonyColors = useMemo(() => {
    if (!selectedHex) return [];
    const rawHarmonyColors = generateHarmonyColors(selectedHex, harmonyType);
    return constrainHarmonyHexes(rawHarmonyColors, selectedHex);
  }, [selectedHex, harmonyType, constrainHarmonyHexes]);

  // Harmony target dots for the color wheel (diamonds)
  const harmonyDots: HarmonyDot[] = useMemo(() => {
    if (!selectedHex || harmonyType === "similar" || harmonyColors.length === 0) return [];
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
  }, [selectedHex, harmonyType, harmonyColors, wheelMode, snapDots]);

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
    const harmonies = HARMONY_TYPES.map((item) => item.value).filter(
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
  ]);

  // Colors to match against — includes source for harmony modes
  const targetColors = useMemo(() => {
    if (harmonyType === "similar") {
      return activeHex ? [activeHex] : [];
    }
    if (!selectedHex) return [];
    return [selectedHex, ...harmonyColors];
  }, [harmonyType, activeHex, selectedHex, harmonyColors]);

  // Sort polishes by distance — if a target is focused, match only that color
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
          matchedHarmonyHex,
          matchedHarmonyIndex,
        };
      })
      .sort((a, b) => a.distance - b.distance);
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
    // Clear focus/lock on new wheel selection
    lockedTargetRef.current = null;
    setFocusedTargetHex(null);
  }, []);

  const handleExternalColorSelect = useCallback((hex: string) => {
    const hsl = hexToHsl(hex);
    setSelectedHsl(hsl);
    setLightness(hsl.l);
  }, []);

  const addPaletteAnchorHex = useCallback((hex: string | null) => {
    if (!hex) {
      setAnchorFeedback("No color selected");
      return;
    }
    const canonical = hex.toUpperCase();
    setPaletteAnchors((prev) => {
      if (prev.includes(canonical)) {
        setAnchorFeedback(`Already added ${canonical}`);
        return prev;
      }
      setAnchorFeedback(`Added ${canonical}`);
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
      setAnchorFeedback("No selected color to remove");
      return;
    }
    setPaletteAnchors((prev) => {
      const next = prev.filter((c) => c !== hex);
      if (next.length === prev.length) {
        setAnchorFeedback(`${hex} is not in desired colors`);
        return prev;
      }
      setAnchorFeedback(`Removed ${hex}`);
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
      lockedTargetRef.current = null;
      setFocusedTargetHex(null);
    } else {
      lockedTargetRef.current = hex;
      setFocusedTargetHex(hex);
    }
  }, []);

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

  const handleQuantityChange = useCallback(
    (polishId: string, delta: number) => {
      setAllPolishes((prev) =>
        prev.map((p) => {
          if (p.id !== polishId) return p;
          const newQty = Math.max(0, (p.quantity ?? 0) + delta);
          return { ...p, quantity: newQty };
        })
      );

      const polish = allPolishes.find((p) => p.id === polishId);
      if (!polish) return;
      const newQty = Math.max(0, (polish.quantity ?? 0) + delta);

      updatePolish(polishId, { id: polishId, quantity: newQty }).catch(() => {
        // Revert on failure
        setAllPolishes((prev) =>
          prev.map((p) => (p.id === polishId ? { ...p, quantity: polish.quantity } : p))
        );
      });
    },
    [allPolishes]
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Color Search</h1>
        <p className="text-muted-foreground">
          Explore your collection by color. Hover to preview, click to select.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Pick Color</CardTitle>
            <CardDescription>
              Use wheel, table dots, or harmony swatches to set the selected color.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="mx-auto w-fit" onMouseLeave={handleMouseLeaveWheel}>
              <ColorWheel
                lightness={lightness}
                onHover={handleHover}
                onSelect={handleSelect}
                selectedHsl={selectedHsl}
                size={280}
                wheelMode={wheelMode}
                snapDots={snapDots}
                externalHoverHex={externalHoverHex}
                harmonyDots={harmonyDots}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Dark</span>
                <span>Lightness</span>
                <span>Light</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={lightness}
                onChange={(e) => setLightness(parseFloat(e.target.value))}
                className="w-full accent-primary"
                aria-label="Lightness"
                style={{
                  background: `linear-gradient(to right, #000, ${hslToHex({ h: selectedHsl?.h ?? 0, s: selectedHsl?.s ?? 1, l: 0.5 })}, #fff)`,
                  borderRadius: "9999px",
                  height: "8px",
                }}
              />
            </div>

            <div className="grid gap-2">
              <Select
                value={harmonyType}
                onValueChange={(v) => setHarmonyType(v as HarmonyType)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Harmony type" />
                </SelectTrigger>
                <SelectContent>
                  {HARMONY_TYPES.map((h) => (
                    <SelectItem key={h.value} value={h.value}>
                      {h.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Source Color Mode</p>
              <div className="flex w-full rounded-lg border bg-muted p-1">
                <Button
                  variant={wheelMode === "free" ? "default" : "ghost"}
                  size="sm"
                  className="flex-1"
                  onClick={() => setWheelMode("free")}
                >
                  Any Color
                </Button>
                <Button
                  variant={wheelMode === "snap" ? "default" : "ghost"}
                  size="sm"
                  className="flex-1"
                  onClick={() => setWheelMode("snap")}
                >
                  Snap to Owned
                </Button>
              </div>
            </div>

            <div className="rounded-md border p-2 text-xs">
              <p className="text-muted-foreground">Selected</p>
              <div className="mt-1 flex items-center gap-2">
                <span
                  className="inline-block h-4 w-4 rounded-full border"
                  style={{ backgroundColor: selectedHex ?? "transparent" }}
                />
                <span className="font-mono">{selectedHex ?? "--"}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="order-3 xl:order-none xl:col-start-2 xl:row-span-2">
          <CardHeader>
            <CardTitle className="text-base">
              Match Table
              {resultsScope === "collection" && " — My Collection"}
            </CardTitle>
            <CardDescription>
              Scope and filters are inline with results.
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
                value={finishFilter}
                onValueChange={setFinishFilter}
              >
                <SelectTrigger className="h-8 w-[160px]">
                  <SelectValue placeholder="Finish" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Finishes</SelectItem>
                  {FINISHES.map((finish) => (
                    <SelectItem key={finish} value={finish}>
                      {finish.charAt(0).toUpperCase() + finish.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {activeHex && targetColors.length > 0 ? (
              <ColorSearchResults
                polishes={sortedPolishes}
                harmonyColors={targetColors}
                harmonyType={harmonyType}
                focusedTargetHex={focusedTargetHex}
                onQuantityChange={handleQuantityChange}
                onAddDesired={(hex) => {
                  handleExternalColorSelect(hex);
                  addPaletteAnchorHex(hex);
                }}
                onSwatchHover={handleSwatchHover}
                onSwatchLeave={handleSwatchLeave}
                onSwatchClick={handleSwatchClick}
                onColorSelect={handleExternalColorSelect}
                onColorHover={handleColorHover}
                onColorLeave={handleColorLeave}
              />
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

        <Card className="order-2 xl:order-none xl:col-start-1 xl:row-start-2">
          <CardHeader>
            <CardTitle className="text-base">Harmonies</CardTitle>
            <CardDescription>
              Build desired colors and explore top palette recommendations.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
                <p className="text-sm font-medium">Desired Colors</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {paletteAnchors.length} color{paletteAnchors.length === 1 ? "" : "s"}
                  </span>
                  {paletteAnchors.length > 0 && (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="destructive"
                      onClick={handleClearPaletteAnchors}
                      title="Clear desired colors"
                    >
                      <BsTrash3Fill className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="secondary"
                  onClick={handleAddFocusedPaletteAnchor}
                  disabled={!focusedTargetHex && !selectedHex}
                  title="Add selected color to desired"
                >
                  <BsPlusLg className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  onClick={handleRemoveSelectedPaletteColor}
                  disabled={paletteAnchors.length === 0 || (!focusedTargetHex && !selectedHex)}
                  title="Remove selected color from desired"
                >
                  <BsTrash3Fill className="h-4 w-4" />
                </Button>
              </div>
              {anchorFeedback && (
                <p className="text-xs text-muted-foreground">{anchorFeedback}</p>
              )}
              <div className="flex h-10 overflow-hidden rounded-md border">
                {wantedColorStatuses.length === 0 ? (
                  <div className="flex w-full items-center justify-center text-xs text-muted-foreground">
                    Add colors from wheel, table, or harmonies
                  </div>
                ) : (
                  wantedColorStatuses.map((wanted, i) => {
                    const Icon = AVAILABILITY_ICON[wanted.availability.status];
                    return (
                      <button
                        key={`${wanted.hex}-${i}`}
                        type="button"
                        className={`relative flex-1 ${
                          focusedTargetHex === wanted.hex ? "ring-2 ring-primary ring-inset" : "hover:opacity-90"
                        }`}
                        style={{ backgroundColor: wanted.hex }}
                        onMouseEnter={() => handleSwatchHover(wanted.hex)}
                        onMouseLeave={handleSwatchLeave}
                        onClick={() => {
                          handleSwatchClick(wanted.hex);
                          handleExternalColorSelect(wanted.hex);
                        }}
                        title={`${wanted.hex} • ${AVAILABILITY_META[wanted.availability.status].label}`}
                      >
                        <span className="absolute inset-0 flex items-center justify-center">
                          <Icon className="h-4 w-4" style={{ color: iconColorForHex(wanted.hex) }} />
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                {(["have", "buy", "virtual"] as const).map((status) => {
                  const Icon = AVAILABILITY_ICON[status];
                  return (
                    <span key={status} className="inline-flex items-center gap-1">
                      <Icon className="h-3.5 w-3.5" style={{ color: AVAILABILITY_META[status].color }} />
                      {AVAILABILITY_META[status].label}
                    </span>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2 rounded-md border bg-muted/30 p-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">Recommended Palettes</p>
                <p className="text-[10px] text-muted-foreground">Top 12 by Have %, then Buy %</p>
              </div>
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant={recommendationHarmonyFilter === "all" ? "default" : "outline"}
                  onClick={() => setRecommendationHarmonyFilter("all")}
                >
                  All
                </Button>
                {HARMONY_TYPES.filter((h) => h.value !== "similar").map((h) => (
                  <Button
                    key={h.value}
                    type="button"
                    size="xs"
                    variant={recommendationHarmonyFilter === h.value ? "default" : "outline"}
                    title={h.label}
                    onClick={() => setRecommendationHarmonyFilter(h.value)}
                  >
                    <span className="mr-1">{HARMONY_SYMBOLS[h.value]}</span>
                    {h.label}
                  </Button>
                ))}
              </div>
              {recommendedPalettes.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Add desired colors or pick a source color to generate recommendations.
                </p>
              ) : (
                <div className="space-y-2">
                  {recommendedPalettes.map((candidate) => {
                    const harmonyName =
                      HARMONY_TYPES.find((h) => h.value === candidate.harmony)?.label ?? candidate.harmony;
                    return (
                      <div key={candidate.id} className="rounded-md border bg-background p-2">
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
                                className={`relative flex-1 ${
                                  focusedTargetHex === hex ? "ring-2 ring-primary ring-inset" : "hover:opacity-90"
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
        </Card>
      </div>
    </div>
  );
}

export default function ColorSearchPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-[400px]"><p className="text-muted-foreground">Loading...</p></div>}>
      <ColorSearchPageContent />
    </Suspense>
  );
}
