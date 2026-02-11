"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { hexToHsl, hslToHex, type HSL } from "@/lib/color-utils";

export type WheelMode = "free" | "snap";

export interface SnapDot {
  hex: string;
  hsl: HSL;
}

export interface HarmonyDot {
  hex: string;
  hsl: HSL;
  /** Kept for API compatibility with ColorWheel consumers. */
  closestSnapIndex: number | null;
}

interface ColorSpectrumProps {
  lightness: number;
  saturation: number;
  onHover: (hex: string, hsl: HSL) => void;
  onSelect: (hex: string, hsl: HSL) => void;
  selectedHsl: HSL | null;
  wheelMode?: WheelMode;
  snapDots?: SnapDot[];
  externalHoverHex?: string | null;
  harmonyDots?: HarmonyDot[];
}

const SNAP_THRESHOLD_PX = 14;

function clampHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

export function ColorSpectrum({
  lightness,
  saturation,
  onHover,
  onSelect,
  selectedHsl,
  wheelMode = "free",
  snapDots = [],
  externalHoverHex,
  harmonyDots = [],
}: ColorSpectrumProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hoverHue, setHoverHue] = useState<number | null>(null);

  const activeSaturation = selectedHsl?.s ?? saturation;

  const spectrumBackground = useMemo(() => {
    const stops = Array.from({ length: 13 }, (_, index) => {
      const hue = (index / 12) * 360;
      const hex = hslToHex({ h: hue, s: activeSaturation, l: lightness });
      return `${hex} ${(index / 12) * 100}%`;
    });
    return `linear-gradient(90deg, ${stops.join(", ")})`;
  }, [activeSaturation, lightness]);

  const hueToPercent = useCallback((hue: number) => (clampHue(hue) / 360) * 100, []);

  const resolveSelection = useCallback(
    (clientX: number): { hex: string; hsl: HSL; hue: number } | null => {
      const track = trackRef.current;
      if (!track) return null;

      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const hue = (x / rect.width) * 360;

      if (wheelMode === "snap" && snapDots.length > 0) {
        let nearest: { dot: SnapDot; distancePx: number } | null = null;
        for (const dot of snapDots) {
          const dotX = (clampHue(dot.hsl.h) / 360) * rect.width;
          const linearDistance = Math.abs(dotX - x);
          const wrapDistance = rect.width - linearDistance;
          const distancePx = Math.min(linearDistance, wrapDistance);
          if (!nearest || distancePx < nearest.distancePx) {
            nearest = { dot, distancePx };
          }
        }
        if (nearest && nearest.distancePx <= SNAP_THRESHOLD_PX) {
          return {
            hex: nearest.dot.hex,
            hsl: { ...nearest.dot.hsl },
            hue: clampHue(nearest.dot.hsl.h),
          };
        }
      }

      const hsl: HSL = {
        h: clampHue(hue),
        s: activeSaturation,
        l: lightness,
      };
      return { hex: hslToHex(hsl), hsl, hue: hsl.h };
    },
    [activeSaturation, lightness, wheelMode, snapDots],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const result = resolveSelection(e.clientX);
      if (!result) return;
      setHoverHue(result.hue);
      onHover(result.hex, result.hsl);
    },
    [onHover, resolveSelection],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const result = resolveSelection(e.clientX);
      if (!result) return;
      onSelect(result.hex, result.hsl);
    },
    [onSelect, resolveSelection],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (e.touches.length !== 1) return;
      const result = resolveSelection(e.touches[0].clientX);
      if (!result) return;
      setHoverHue(result.hue);
      onHover(result.hex, result.hsl);
    },
    [onHover, resolveSelection],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (e.touches.length !== 1) return;
      const result = resolveSelection(e.touches[0].clientX);
      if (!result) return;
      setHoverHue(result.hue);
      onSelect(result.hex, result.hsl);
    },
    [onSelect, resolveSelection],
  );

  const selectedHue = selectedHsl ? clampHue(selectedHsl.h) : null;
  const externalHoverHue = externalHoverHex ? clampHue(hexToHsl(externalHoverHex).h) : null;

  return (
    <div className="space-y-2">
      <div
        ref={trackRef}
        className="relative h-14 w-full cursor-crosshair overflow-hidden rounded-xl border border-border shadow-inner"
        style={{ background: spectrumBackground }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverHue(null)}
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={() => setHoverHue(null)}
      >
        {wheelMode === "snap" &&
          snapDots.map((dot, index) => (
            <span
              key={`${dot.hex}-${index}`}
              className="pointer-events-none absolute inset-y-0 w-[3px] -translate-x-1/2 rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.75),0_0_0_2px_rgba(0,0,0,0.35)]"
              style={{ left: `${hueToPercent(dot.hsl.h)}%`, backgroundColor: dot.hex, opacity: 0.9 }}
              title={`Owned: ${dot.hex}`}
            />
          ))}

        {harmonyDots.map((dot, index) => (
          <span
            key={`${dot.hex}-${index}`}
            className="pointer-events-none absolute top-[3px] h-2.5 w-2.5 -translate-x-1/2 rotate-45 border border-white/90"
            style={{ left: `${hueToPercent(dot.hsl.h)}%`, backgroundColor: dot.hex }}
            title={`Harmony: ${dot.hex}`}
          />
        ))}

        {selectedHue !== null && (
          <span
            className="pointer-events-none absolute top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_2px_rgba(0,0,0,0.4)]"
            style={{ left: `${hueToPercent(selectedHue)}%` }}
          />
        )}

        {hoverHue !== null && (
          <span
            className="pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
            style={{ left: `${hueToPercent(hoverHue)}%` }}
          />
        )}

        {externalHoverHue !== null && externalHoverHex && (
          <span
            className="pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_6px_2px_rgba(255,255,255,0.6)]"
            style={{ left: `${hueToPercent(externalHoverHue)}%`, backgroundColor: externalHoverHex }}
          />
        )}
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>0°</span>
        <span>Hue Spectrum</span>
        <span>360°</span>
      </div>
    </div>
  );
}
