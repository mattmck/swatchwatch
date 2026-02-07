"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import { hslToHex, type HSL } from "@/lib/color-utils";

interface ColorWheelProps {
  /** Currently selected/previewed HSL (without lightness — that comes from the slider) */
  lightness: number;
  /** Called continuously as the mouse moves over the wheel */
  onHover: (hex: string, hsl: HSL) => void;
  /** Called when the user clicks to lock a color */
  onSelect: (hex: string, hsl: HSL) => void;
  /** Currently locked selection (to render the marker) */
  selectedHsl: HSL | null;
  size?: number;
}

export function ColorWheel({
  lightness,
  onHover,
  onSelect,
  selectedHsl,
  size = 280,
}: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredPos, setHoveredPos] = useState<{ x: number; y: number } | null>(null);

  const radius = size / 2;

  // Draw the wheel whenever lightness changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const imageData = ctx.createImageData(size, size);
    const data = imageData.data;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - radius;
        const dy = y - radius;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist <= radius) {
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
          const hue = (angle + 360) % 360;
          const saturation = dist / radius;

          // Convert HSL → RGB for the pixel
          const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
          const hPrime = hue / 60;
          const xVal = c * (1 - Math.abs((hPrime % 2) - 1));
          const m = lightness - c / 2;

          let r = 0, g = 0, b = 0;
          if (hPrime < 1) [r, g, b] = [c, xVal, 0];
          else if (hPrime < 2) [r, g, b] = [xVal, c, 0];
          else if (hPrime < 3) [r, g, b] = [0, c, xVal];
          else if (hPrime < 4) [r, g, b] = [0, xVal, c];
          else if (hPrime < 5) [r, g, b] = [xVal, 0, c];
          else [r, g, b] = [c, 0, xVal];

          const idx = (y * size + x) * 4;
          data[idx] = Math.round((r + m) * 255);
          data[idx + 1] = Math.round((g + m) * 255);
          data[idx + 2] = Math.round((b + m) * 255);
          data[idx + 3] = 255;
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }, [lightness, size, radius]);

  const getColorFromEvent = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): { hex: string; hsl: HSL } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;

      const rect = canvas.getBoundingClientRect();
      const scaleX = size / rect.width;
      const scaleY = size / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      const dx = x - radius;
      const dy = y - radius;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > radius) return null;

      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      const hue = (angle + 360) % 360;
      const saturation = dist / radius;
      const hsl: HSL = { h: hue, s: saturation, l: lightness };

      return { hex: hslToHex(hsl), hsl };
    },
    [lightness, radius, size]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const result = getColorFromEvent(e);
      if (result) {
        const rect = canvasRef.current!.getBoundingClientRect();
        const scaleX = size / rect.width;
        const scaleY = size / rect.height;
        setHoveredPos({
          x: (e.clientX - rect.left) * scaleX,
          y: (e.clientY - rect.top) * scaleY,
        });
        onHover(result.hex, result.hsl);
      } else {
        setHoveredPos(null);
      }
    },
    [getColorFromEvent, onHover, size]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const result = getColorFromEvent(e);
      if (result) {
        onSelect(result.hex, result.hsl);
      }
    },
    [getColorFromEvent, onSelect]
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredPos(null);
  }, []);

  // Calculate selected position for the marker
  const selectedPos = selectedHsl
    ? (() => {
        const angle = (selectedHsl.h * Math.PI) / 180;
        const dist = selectedHsl.s * radius;
        return {
          x: radius + Math.cos(angle) * dist,
          y: radius + Math.sin(angle) * dist,
        };
      })()
    : null;

  return (
    <div className="relative inline-block" style={{ width: size, height: size }}>
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        className="cursor-crosshair rounded-full"
        style={{ width: size, height: size }}
        onMouseMove={handleMouseMove}
        onClick={handleClick}
        onMouseLeave={handleMouseLeave}
      />
      {/* Hover cursor indicator */}
      {hoveredPos && (
        <div
          className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)]"
          style={{ left: hoveredPos.x, top: hoveredPos.y }}
        />
      )}
      {/* Locked selection marker */}
      {selectedPos && (
        <div
          className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_2px_rgba(0,0,0,0.4)]"
          style={{ left: selectedPos.x, top: selectedPos.y }}
        />
      )}
    </div>
  );
}
