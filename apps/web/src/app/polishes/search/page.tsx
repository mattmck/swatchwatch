"use client";

import { useState, useMemo, useCallback, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import type { Polish } from "swatchwatch-shared";
import { listPolishes, updatePolish } from "@/lib/api";
import {
  colorDistance,
  hexToHsl,
  hslToHex,
  type HSL,
} from "@/lib/color-utils";
import {
  HARMONY_TYPES,
  generateHarmonyColors,
  type HarmonyType,
} from "@/lib/color-harmonies";
import { ColorWheel, type WheelMode, type SnapDot, type HarmonyDot } from "@/components/color-wheel";
import { ColorSearchResults } from "@/components/color-search-results";
import { HarmonyPalette } from "@/components/harmony-palette";
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

type ResultsScope = "all" | "collection";

/** Max OKLAB distance (used to normalize to 0-1 for display) */
const MAX_DISTANCE = 0.5;

function ColorSearchPageContent() {
  const searchParams = useSearchParams();
  const [allPolishes, setAllPolishes] = useState<Polish[]>([]);
  const [loading, setLoading] = useState(true);
  const [harmonyType, setHarmonyType] = useState<HarmonyType>("similar");
  const [wheelMode, setWheelMode] = useState<WheelMode>("free");
  const [resultsScope, setResultsScope] = useState<ResultsScope>("all");
  const [lightness, setLightness] = useState(0.5);
  const [selectedHsl, setSelectedHsl] = useState<HSL | null>(null);
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
    setSelectedHsl((prev) => {
      if (!prev || prev.l === lightness) return prev;
      return { ...prev, l: lightness };
    });
  }, [lightness]);

  // Clear focus/lock when harmony type changes
  useEffect(() => {
    lockedTargetRef.current = null;
    setFocusedTargetHex(null);
  }, [harmonyType]);

  // Initialize from URL params
  useEffect(() => {
    const colorParam = searchParams.get("color");
    if (colorParam) {
      const hex = colorParam.startsWith("#") ? colorParam : `#${colorParam}`;
      if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
        const hsl = hexToHsl(hex);
        setSelectedHsl(hsl);
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

  // Snap dots for the wheel
  const snapDots: SnapDot[] = useMemo(
    () =>
      ownedColorPolishes.map((p) => ({
        hex: p.colorHex,
        hsl: hexToHsl(p.colorHex),
      })),
    [ownedColorPolishes]
  );

  // Generate harmony target colors — pinned to selectedHex so they don't shift on hover
  const harmonyColors = useMemo(() => {
    if (!selectedHex) return [];
    return generateHarmonyColors(selectedHex, harmonyType);
  }, [selectedHex, harmonyType]);

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

  // Closest owned polish hex for each harmony slot [source, ...harmony targets]
  const collectionColors = useMemo(() => {
    if (!selectedHex || ownedColorPolishes.length === 0) return [];
    const targets = [selectedHex, ...harmonyColors];
    return targets.map((targetHex) => {
      let closestHex: string | null = null;
      let minDist = Infinity;
      for (const p of ownedColorPolishes) {
        const d = colorDistance(targetHex, p.colorHex);
        if (d < minDist) {
          minDist = d;
          closestHex = p.colorHex;
        }
      }
      return closestHex;
    });
  }, [selectedHex, harmonyColors, ownedColorPolishes]);

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

    const source = resultsScope === "collection"
      ? colorPolishes.filter(isOwned)
      : colorPolishes;

    return source
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
  }, [focusedTargetHex, targetColors, colorPolishes, resultsScope]);

  const harmonyLabel = HARMONY_TYPES.find((h) => h.value === harmonyType)?.label ?? "Similar";

  const handleHover = useCallback(
    (hex: string, _hsl: HSL) => {
      setPreviewHex(hex);
    },
    []
  );

  const handleSelect = useCallback((hex: string, hsl: HSL) => {
    setSelectedHsl(hsl);
    // Clear focus/lock on new wheel selection
    lockedTargetRef.current = null;
    setFocusedTargetHex(null);
  }, []);

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

      <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
        {/* Left: wheel + controls */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Pick a Color</CardTitle>
              <CardDescription>
                {selectedHex
                  ? "Hover to preview, click to change selection"
                  : "Move your mouse over the wheel"}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-4">
              <div onMouseLeave={handleMouseLeaveWheel}>
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

              {/* Lightness slider */}
              <div className="w-full space-y-1.5">
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

              {/* Harmony palette preview — two bars: Target + Collection */}
              {selectedHex && (
                <HarmonyPalette
                  sourceHex={selectedHex}
                  harmonyColors={harmonyColors}
                  label={harmonyLabel}
                  collectionColors={collectionColors}
                  focusedTargetHex={focusedTargetHex}
                  onSwatchHover={handleSwatchHover}
                  onSwatchLeave={handleSwatchLeave}
                  onSwatchClick={handleSwatchClick}
                />
              )}

              {/* Harmony type selector */}
              <div className="w-full">
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

              {/* Wheel mode toggle (Free / Snap) */}
              <div className="flex w-full rounded-lg border bg-muted p-1">
                <Button
                  variant={wheelMode === "free" ? "default" : "ghost"}
                  size="sm"
                  className="flex-1"
                  onClick={() => setWheelMode("free")}
                >
                  Free
                </Button>
                <Button
                  variant={wheelMode === "snap" ? "default" : "ghost"}
                  size="sm"
                  className="flex-1"
                  onClick={() => setWheelMode("snap")}
                >
                  Snap
                </Button>
              </div>

              {/* Results scope toggle (All / My Collection) */}
              <div className="flex w-full rounded-lg border bg-muted p-1">
                <Button
                  variant={resultsScope === "all" ? "default" : "ghost"}
                  size="sm"
                  className="flex-1"
                  onClick={() => setResultsScope("all")}
                >
                  All Polishes
                </Button>
                <Button
                  variant={resultsScope === "collection" ? "default" : "ghost"}
                  size="sm"
                  className="flex-1"
                  onClick={() => setResultsScope("collection")}
                >
                  My Collection
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: results */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {harmonyLabel} Colors
              {resultsScope === "collection" && " — My Collection"}
            </CardTitle>
            <CardDescription>
              {activeHex
                ? `Polishes sorted by ${harmonyType === "similar" ? "similarity to" : `${harmonyLabel.toLowerCase()} match for`} your selection`
                : "Pick a color on the wheel to see matches"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {activeHex && targetColors.length > 0 ? (
              <ColorSearchResults
                polishes={sortedPolishes}
                harmonyColors={targetColors}
                harmonyType={harmonyType}
                focusedTargetHex={focusedTargetHex}
                onQuantityChange={handleQuantityChange}
                onSwatchHover={handleSwatchHover}
                onSwatchLeave={handleSwatchLeave}
                onSwatchClick={handleSwatchClick}
                onColorHover={handleColorHover}
                onColorLeave={handleColorLeave}
              />
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <span className="text-4xl">🎨</span>
                <p className="mt-3 text-sm text-muted-foreground">
                  Hover over the color wheel to preview matches
                </p>
              </div>
            )}
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
