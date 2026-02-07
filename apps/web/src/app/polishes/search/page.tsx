"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import type { Polish } from "swatchwatch-shared";
import { listPolishes } from "@/lib/api";
import {
  colorDistance,
  complementaryHex,
  hslToHex,
  type HSL,
} from "@/lib/color-utils";
import { ColorWheel } from "@/components/color-wheel";
import { ColorSearchResults } from "@/components/color-search-results";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Mode = "similar" | "complementary";

/** Max OKLAB distance (used to normalize to 0-1 for display) */
const MAX_DISTANCE = 0.5;

export default function ColorSearchPage() {
  const [allPolishes, setAllPolishes] = useState<Polish[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("similar");
  const [lightness, setLightness] = useState(0.5);
  const [selectedHsl, setSelectedHsl] = useState<HSL | null>(null);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [previewHex, setPreviewHex] = useState<string | null>(null);

  useEffect(() => {
    listPolishes()
      .then((res) => setAllPolishes(res.polishes))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // The color we're actively matching against (hover takes priority over click)
  const activeHex = previewHex ?? selectedHex;

  // Polishes that have a colorHex
  const colorPolishes = useMemo(
    () => allPolishes.filter((p): p is Polish & { colorHex: string } => !!p.colorHex),
    [allPolishes]
  );

  // Compute the target color based on mode
  const targetHex = useMemo(() => {
    if (!activeHex) return null;
    return mode === "complementary" ? complementaryHex(activeHex) : activeHex;
  }, [activeHex, mode]);

  // Sort polishes by distance to target color
  const sortedPolishes = useMemo(() => {
    if (!targetHex) return [];
    return colorPolishes
      .map((p) => ({
        ...p,
        distance: Math.min(colorDistance(targetHex, p.colorHex) / MAX_DISTANCE, 1),
      }))
      .sort((a, b) => a.distance - b.distance);
  }, [targetHex, colorPolishes]);

  const handleHover = useCallback(
    (hex: string, _hsl: HSL) => {
      setPreviewHex(hex);
    },
    []
  );

  const handleSelect = useCallback((hex: string, hsl: HSL) => {
    setSelectedHex(hex);
    setSelectedHsl(hsl);
  }, []);

  const handleMouseLeaveWheel = useCallback(() => {
    setPreviewHex(null);
  }, []);

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

              {/* Color preview swatches */}
              {activeHex && (
                <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-4 py-2 w-full">
                  <div className="flex flex-col items-center gap-1">
                    <span
                      className="h-8 w-8 rounded-full border border-border"
                      style={{ backgroundColor: activeHex }}
                    />
                    <span className="text-[10px] text-muted-foreground">
                      {mode === "similar" ? "Selected" : "Picked"}
                    </span>
                  </div>
                  {mode === "complementary" && targetHex && (
                    <>
                      <span className="text-muted-foreground">→</span>
                      <div className="flex flex-col items-center gap-1">
                        <span
                          className="h-8 w-8 rounded-full border border-border"
                          style={{ backgroundColor: targetHex }}
                        />
                        <span className="text-[10px] text-muted-foreground">Match</span>
                      </div>
                    </>
                  )}
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {activeHex}
                  </span>
                </div>
              )}

              {/* Mode toggle */}
              <div className="flex w-full rounded-lg border bg-muted p-1">
                <Button
                  variant={mode === "similar" ? "default" : "ghost"}
                  size="sm"
                  className="flex-1"
                  onClick={() => setMode("similar")}
                >
                  Similar
                </Button>
                <Button
                  variant={mode === "complementary" ? "default" : "ghost"}
                  size="sm"
                  className="flex-1"
                  onClick={() => setMode("complementary")}
                >
                  Complementary
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: results */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {mode === "similar" ? "Similar Colors" : "Complementary Colors"}
            </CardTitle>
            <CardDescription>
              {activeHex
                ? `Polishes sorted by ${mode === "similar" ? "similarity to" : "complementary match for"} your selection`
                : "Pick a color on the wheel to see matches"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {activeHex && targetHex ? (
              <ColorSearchResults
                polishes={sortedPolishes}
                targetHex={targetHex}
                mode={mode}
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
