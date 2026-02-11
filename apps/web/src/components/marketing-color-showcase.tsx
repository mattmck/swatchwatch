"use client";

import { useMemo, useState } from "react";
import { Sparkles, WandSparkles } from "lucide-react";
import { generateHarmonyPalette, type HarmonyType } from "@/lib/color-harmonies";
import { cn } from "@/lib/utils";

type PalettePreset = {
  id: string;
  label: string;
  description: string;
  anchorHex: string;
  harmony: HarmonyType;
  collectionNames: [string, string, string, string];
};

type CollectionTile = {
  name: string;
  hex: string;
};

const PALETTE_PRESETS: PalettePreset[] = [
  {
    id: "berry-pop",
    label: "Berry Pop",
    description: "Playful pinks with a bold violet edge.",
    anchorHex: "#D442B5",
    harmony: "triadic",
    collectionNames: ["Berry Kiss", "Mermaid Veil", "Hot Fuchsia", "Studio Plum"],
  },
  {
    id: "soft-editorial",
    label: "Soft Editorial",
    description: "Pastel-forward tones for clean, modern sets.",
    anchorHex: "#C6A9FF",
    harmony: "analogous",
    collectionNames: ["Rose Quartz", "Lilac Dream", "Cloud Mauve", "Velvet Dawn"],
  },
  {
    id: "night-shift",
    label: "Night Shift",
    description: "High-contrast shades for dramatic nail art.",
    anchorHex: "#5F24D4",
    harmony: "split-complementary",
    collectionNames: ["Midnight Plum", "Neon Fizz", "Cyber Orchid", "Violet Noir"],
  },
  {
    id: "gloss-lab",
    label: "Gloss Lab",
    description: "Balanced pairs that avoid near-duplicate buys.",
    anchorHex: "#FF4FB8",
    harmony: "complementary",
    collectionNames: ["Hot Fuchsia", "Rose Alloy", "Peony Glaze", "Lime Spark"],
  },
];

const HARMONY_LABELS: Record<HarmonyType, string> = {
  similar: "Similar",
  complementary: "Complementary",
  "split-complementary": "Split Complementary",
  analogous: "Analogous",
  triadic: "Triadic",
  tetradic: "Tetradic",
  monochromatic: "Monochromatic",
};

const DOT_POSITIONS: ReadonlyArray<{ top: string; left: string }> = [
  { top: "13%", left: "50%" },
  { top: "50%", left: "83%" },
  { top: "87%", left: "50%" },
  { top: "50%", left: "17%" },
];

const CONNECTED_DOT_PAIRS: ReadonlyArray<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [0, 2],
];

function toDisplayPalette(sourceHex: string, harmony: HarmonyType): [string, string, string, string] {
  const generated = generateHarmonyPalette(sourceHex, harmony).map((hex) => hex.toUpperCase());
  const unique: string[] = [];

  for (const hex of generated) {
    if (!unique.includes(hex)) unique.push(hex);
  }

  if (unique.length === 0) {
    unique.push(sourceHex.toUpperCase());
  }

  const fillSource = [...unique];
  while (unique.length < 4) {
    unique.push(fillSource[unique.length % fillSource.length] ?? sourceHex.toUpperCase());
  }

  return [unique[0]!, unique[1]!, unique[2]!, unique[3]!];
}

function toCollectionTiles(
  names: [string, string, string, string],
  palette: [string, string, string, string],
): CollectionTile[] {
  return names.map((name, index) => ({ name, hex: palette[index] }));
}

export function MarketingColorShowcase() {
  const [activePresetId, setActivePresetId] = useState(PALETTE_PRESETS[0]!.id);
  const [activeDotIndex, setActiveDotIndex] = useState(0);

  const activePreset = useMemo(
    () => PALETTE_PRESETS.find((preset) => preset.id === activePresetId) ?? PALETTE_PRESETS[0]!,
    [activePresetId],
  );

  const displayPalette = useMemo(
    () => toDisplayPalette(activePreset.anchorHex, activePreset.harmony),
    [activePreset.anchorHex, activePreset.harmony],
  );

  const collectionTiles = useMemo(
    () => toCollectionTiles(activePreset.collectionNames, displayPalette),
    [activePreset.collectionNames, displayPalette],
  );

  const activeHex = displayPalette[activeDotIndex] ?? displayPalette[0];

  return (
    <div className="mt-10 grid gap-4 sm:mt-14 sm:gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.9fr)]">
      <div className="glass relative overflow-hidden rounded-3xl border border-brand-purple/15 p-5 sm:p-6 lg:p-8">
        <div className="pointer-events-none absolute -top-24 -left-20 size-60 rounded-full bg-brand-pink/30 blur-3xl" />
        <div className="pointer-events-none absolute -right-24 -bottom-20 size-64 rounded-full bg-brand-purple/25 blur-3xl" />

        <div className="relative grid gap-5 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-brand-purple/20 bg-background/70 px-3 py-1 text-xs font-medium text-brand-purple">
              <WandSparkles className="size-3.5" />
              Interactive harmony preview
            </div>
            <div className="relative mx-auto aspect-square w-full max-w-xs">
              <div className="absolute inset-0 rounded-full border border-brand-purple/25 bg-[conic-gradient(from_0deg,#FF4FB822,#C5A6FF38,#7B2EFF33,#FF4FB822)]" />
              <div className="absolute inset-[13%] rounded-full border border-white/35 bg-background/65 backdrop-blur-sm dark:border-white/15" />

              <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full">
                {CONNECTED_DOT_PAIRS.map(([fromIndex, toIndex], pairIndex) => {
                  const from = DOT_POSITIONS[fromIndex];
                  const to = DOT_POSITIONS[toIndex];
                  return (
                    <line
                      key={`${fromIndex}-${toIndex}`}
                      x1={Number.parseFloat(from!.left)}
                      y1={Number.parseFloat(from!.top)}
                      x2={Number.parseFloat(to!.left)}
                      y2={Number.parseFloat(to!.top)}
                      stroke={pairIndex === 4 ? "oklch(0.546 0.275 290.7 / 0.6)" : "oklch(0.546 0.275 290.7 / 0.35)"}
                      strokeWidth={pairIndex === 4 ? 1.6 : 1.2}
                    />
                  );
                })}
              </svg>

              {displayPalette.map((hex, index) => (
                <button
                  key={`${hex}-${index}`}
                  type="button"
                  onMouseEnter={() => setActiveDotIndex(index)}
                  onFocus={() => setActiveDotIndex(index)}
                  onClick={() => setActiveDotIndex(index)}
                  className={cn(
                    "absolute size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-glow-brand transition-transform hover:scale-110",
                    index === activeDotIndex && "scale-110 ring-2 ring-brand-purple/45 ring-offset-2 ring-offset-background",
                  )}
                  style={{
                    top: DOT_POSITIONS[index]!.top,
                    left: DOT_POSITIONS[index]!.left,
                    backgroundColor: hex,
                  }}
                  aria-label={`Preview color ${hex}`}
                />
              ))}
            </div>
            <div className="mt-5 rounded-xl border border-brand-purple/15 bg-background/75 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-purple/80">
                Focus shade
              </p>
              <div className="mt-2 flex items-center gap-2">
                <span
                  className="size-6 rounded-full border border-black/10"
                  style={{ backgroundColor: activeHex }}
                />
                <span className="font-mono text-sm font-medium text-foreground">{activeHex}</span>
              </div>
            </div>
          </div>

          <div>
            <p className="text-sm font-medium text-foreground">
              Pick a collection vibe to see harmony lines and auto-curated swatches.
            </p>
            <div className="mt-3 grid gap-2">
              {PALETTE_PRESETS.map((preset) => {
                const isActive = preset.id === activePreset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      setActivePresetId(preset.id);
                      setActiveDotIndex(0);
                    }}
                    className={cn(
                      "rounded-xl border p-3 text-left transition-all",
                      isActive
                        ? "border-brand-purple/40 bg-brand-pink-light/35 shadow-glow-brand dark:bg-brand-purple/20"
                        : "border-border/80 bg-background/70 hover:border-brand-purple/25 hover:bg-brand-pink-light/15",
                    )}
                  >
                    <p className="text-sm font-semibold text-foreground">{preset.label}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{preset.description}</p>
                    <p className="mt-2 text-[11px] font-medium uppercase tracking-[0.15em] text-brand-purple/70">
                      {HARMONY_LABELS[preset.harmony]}
                    </p>
                  </button>
                );
              })}
            </div>

            <div className="mt-4 rounded-xl border border-border/70 bg-background/70 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-purple/80">
                Suggested set
              </p>
              <div key={activePreset.id} className="mt-3 grid grid-cols-2 gap-2">
                {collectionTiles.map((tile, index) => (
                  <div
                    key={`${tile.name}-${index}`}
                    className="animate-fade-in-up rounded-lg border border-border/70 bg-card px-2.5 py-2"
                    style={{ animationDelay: `${index * 65}ms` }}
                  >
                    <div
                      className="h-1.5 w-full rounded-full"
                      style={{ backgroundColor: tile.hex }}
                    />
                    <p className="mt-2 truncate text-xs font-medium text-foreground">{tile.name}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-border/70 bg-card/70 p-5 sm:p-6">
        <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-brand-purple/75">
          <Sparkles className="size-3.5" />
          Why this matters
        </p>
        <h3 className="mt-3 text-xl font-semibold tracking-tight text-foreground">
          Color planning that prevents duplicate buys
        </h3>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          SwatchWatch groups shades by perceptual distance, then suggests harmonies that actually
          look distinct in real-world lighting.
        </p>
        <div className="mt-5 space-y-2.5 text-sm text-foreground">
          <div className="rounded-lg border border-border/70 bg-background/70 px-3 py-2.5">
            Spot near-identical polishes before checkout.
          </div>
          <div className="rounded-lg border border-border/70 bg-background/70 px-3 py-2.5">
            Build matching sets in seconds.
          </div>
          <div className="rounded-lg border border-border/70 bg-background/70 px-3 py-2.5">
            Keep your collection balanced across tones.
          </div>
        </div>
      </div>
    </div>
  );
}
