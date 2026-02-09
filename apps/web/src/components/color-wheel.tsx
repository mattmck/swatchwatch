"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import { hslToHex, hexToHsl, type HSL } from "@/lib/color-utils";
import { Button } from "@/components/ui/button";

export type WheelMode = "free" | "snap";

export interface SnapDot {
  hex: string;
  hsl: HSL;
}

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
  /** Wheel interaction mode */
  wheelMode?: WheelMode;
  /** Dots to render on the wheel (owned polish positions) */
  snapDots?: SnapDot[];
}

/** Pixel radius for snapping to a dot */
const SNAP_RADIUS = 20;

export function ColorWheel({
  lightness,
  onHover,
  onSelect,
  selectedHsl,
  size = 280,
  wheelMode = "free",
  snapDots = [],
}: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredPos, setHoveredPos] = useState<{ x: number; y: number } | null>(null);

  // Zoom & pan state
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const panOffsetStartRef = useRef({ x: 0, y: 0 });

  // Snap highlight
  const [snappedDotIndex, setSnappedDotIndex] = useState<number | null>(null);

  const radius = size / 2;

  // Convert HSL to wheel pixel position (in wheel-space)
  const hslToWheelPos = useCallback(
    (hsl: HSL): { x: number; y: number } => {
      const angle = (hsl.h * Math.PI) / 180;
      const dist = hsl.s * radius;
      return {
        x: radius + Math.cos(angle) * dist,
        y: radius + Math.sin(angle) * dist,
      };
    },
    [radius]
  );

  // Convert wheel-space position to viewport position (accounting for zoom/pan)
  const wheelToViewport = useCallback(
    (wx: number, wy: number): { x: number; y: number } => {
      return {
        x: (wx - radius) * zoom + radius + panOffset.x,
        y: (wy - radius) * zoom + radius + panOffset.y,
      };
    },
    [zoom, panOffset, radius]
  );

  // Convert viewport position to wheel-space
  const viewportToWheel = useCallback(
    (vx: number, vy: number): { x: number; y: number } => {
      return {
        x: (vx - radius - panOffset.x) / zoom + radius,
        y: (vy - radius - panOffset.y) / zoom + radius,
      };
    },
    [zoom, panOffset, radius]
  );

  // Draw the wheel whenever lightness or zoom/pan changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const imageData = ctx.createImageData(size, size);
    const data = imageData.data;

    for (let vy = 0; vy < size; vy++) {
      for (let vx = 0; vx < size; vx++) {
        // Map viewport pixel to wheel-space
        const wx = (vx - radius - panOffset.x) / zoom + radius;
        const wy = (vy - radius - panOffset.y) / zoom + radius;

        const dx = wx - radius;
        const dy = wy - radius;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist <= radius) {
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
          const hue = (angle + 360) % 360;
          const saturation = dist / radius;

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

          const idx = (vy * size + vx) * 4;
          data[idx] = Math.round((r + m) * 255);
          data[idx + 1] = Math.round((g + m) * 255);
          data[idx + 2] = Math.round((b + m) * 255);
          data[idx + 3] = 255;
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // Draw snap dots on canvas in snap mode
    if (wheelMode === "snap" && snapDots.length > 0) {
      for (let i = 0; i < snapDots.length; i++) {
        const dot = snapDots[i];
        const wp = hslToWheelPos(dot.hsl);
        const vp = wheelToViewport(wp.x, wp.y);

        // Skip dots outside the visible canvas
        if (vp.x < -10 || vp.x > size + 10 || vp.y < -10 || vp.y > size + 10) continue;

        const isSnapped = snappedDotIndex === i;
        const dotRadius = isSnapped ? 7 : 4;

        ctx.beginPath();
        ctx.arc(vp.x, vp.y, dotRadius, 0, Math.PI * 2);
        ctx.fillStyle = dot.hex;
        ctx.fill();
        ctx.lineWidth = isSnapped ? 3 : 2;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.4)";
        ctx.stroke();

        if (isSnapped) {
          ctx.beginPath();
          ctx.arc(vp.x, vp.y, dotRadius + 4, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255,255,255,0.6)";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }
  }, [lightness, size, radius, zoom, panOffset, wheelMode, snapDots, snappedDotIndex, hslToWheelPos, wheelToViewport]);

  // Find nearest snap dot in viewport space
  const findNearestDot = useCallback(
    (vx: number, vy: number): { index: number; dot: SnapDot; distPx: number } | null => {
      if (snapDots.length === 0) return null;

      let best: { index: number; dot: SnapDot; distPx: number } | null = null;

      for (let i = 0; i < snapDots.length; i++) {
        const wp = hslToWheelPos(snapDots[i].hsl);
        const vp = wheelToViewport(wp.x, wp.y);
        const dx = vx - vp.x;
        const dy = vy - vp.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist <= SNAP_RADIUS && (!best || dist < best.distPx)) {
          best = { index: i, dot: snapDots[i], distPx: dist };
        }
      }

      return best;
    },
    [snapDots, hslToWheelPos, wheelToViewport]
  );

  const getColorFromEvent = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): { hex: string; hsl: HSL } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;

      const rect = canvas.getBoundingClientRect();
      const scaleX = size / rect.width;
      const scaleY = size / rect.height;
      const vx = (e.clientX - rect.left) * scaleX;
      const vy = (e.clientY - rect.top) * scaleY;

      // In snap mode, check for nearby dots first
      if (wheelMode === "snap") {
        const nearest = findNearestDot(vx, vy);
        if (nearest) {
          setSnappedDotIndex(nearest.index);
          const hsl: HSL = { ...nearest.dot.hsl, l: lightness };
          return { hex: hslToHex(hsl), hsl };
        }
        setSnappedDotIndex(null);
      }

      // Convert viewport to wheel-space
      const wp = viewportToWheel(vx, vy);
      const dx = wp.x - radius;
      const dy = wp.y - radius;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > radius) return null;

      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      const hue = (angle + 360) % 360;
      const saturation = dist / radius;
      const hsl: HSL = { h: hue, s: saturation, l: lightness };

      return { hex: hslToHex(hsl), hsl };
    },
    [lightness, radius, size, wheelMode, findNearestDot, viewportToWheel]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      // If panning, don't pick colors
      if (isPanningRef.current) return;

      const result = getColorFromEvent(e);
      if (result) {
        const rect = canvasRef.current!.getBoundingClientRect();
        const scaleX = size / rect.width;
        const scaleY = size / rect.height;
        const vx = (e.clientX - rect.left) * scaleX;
        const vy = (e.clientY - rect.top) * scaleY;

        // In snap mode with a snapped dot, position the indicator at the dot
        if (wheelMode === "snap" && snappedDotIndex !== null) {
          const dot = snapDots[snappedDotIndex];
          const wp = hslToWheelPos(dot.hsl);
          const vp = wheelToViewport(wp.x, wp.y);
          setHoveredPos({ x: vp.x, y: vp.y });
        } else {
          setHoveredPos({ x: vx, y: vy });
        }
        onHover(result.hex, result.hsl);
      } else {
        setHoveredPos(null);
        setSnappedDotIndex(null);
      }
    },
    [getColorFromEvent, onHover, size, wheelMode, snappedDotIndex, snapDots, hslToWheelPos, wheelToViewport]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isPanningRef.current) return;

      const result = getColorFromEvent(e);
      if (result) {
        onSelect(result.hex, result.hsl);
      }
    },
    [getColorFromEvent, onSelect]
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredPos(null);
    setSnappedDotIndex(null);
  }, []);

  // Zoom on wheel scroll
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();

      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const scaleX = size / rect.width;
      const scaleY = size / rect.height;
      const cursorVx = (e.clientX - rect.left) * scaleX;
      const cursorVy = (e.clientY - rect.top) * scaleY;

      // Zoom centered on cursor position
      const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newZoom = Math.min(8, Math.max(1, zoom * zoomFactor));

      if (newZoom === zoom) return;

      // Adjust pan so cursor stays over the same wheel-space point
      const wx = (cursorVx - radius - panOffset.x) / zoom + radius;
      const wy = (cursorVy - radius - panOffset.y) / zoom + radius;
      const newPanX = cursorVx - (wx - radius) * newZoom - radius;
      const newPanY = cursorVy - (wy - radius) * newZoom - radius;

      setZoom(newZoom);
      setPanOffset(clampPan(newPanX, newPanY, newZoom, size, radius));
    },
    [zoom, panOffset, size, radius]
  );

  // Attach wheel listener as non-passive so preventDefault works
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  // Pan via mouse drag when zoomed
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (zoom <= 1) return;
      // Right-click or middle-click, or any click when zoomed to start pan
      if (e.button === 1 || e.button === 2 || zoom > 1) {
        isPanningRef.current = true;
        panStartRef.current = { x: e.clientX, y: e.clientY };
        panOffsetStartRef.current = { ...panOffset };
        e.preventDefault();
      }
    },
    [zoom, panOffset]
  );

  const handleMouseMoveGlobal = useCallback(
    (e: MouseEvent) => {
      if (!isPanningRef.current) return;

      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const scaleX = size / rect.width;
      const scaleY = size / rect.height;

      const dx = (e.clientX - panStartRef.current.x) * scaleX;
      const dy = (e.clientY - panStartRef.current.y) * scaleY;

      setPanOffset(
        clampPan(
          panOffsetStartRef.current.x + dx,
          panOffsetStartRef.current.y + dy,
          zoom,
          size,
          radius
        )
      );
    },
    [zoom, size, radius]
  );

  const handleMouseUpGlobal = useCallback(
    (e: MouseEvent) => {
      if (isPanningRef.current) {
        // If barely moved, treat as a click (don't suppress)
        const dx = Math.abs(e.clientX - panStartRef.current.x);
        const dy = Math.abs(e.clientY - panStartRef.current.y);
        isPanningRef.current = false;
        // If it was a real drag, don't fire click
        if (dx > 3 || dy > 3) {
          e.preventDefault();
        }
      }
    },
    []
  );

  useEffect(() => {
    window.addEventListener("mousemove", handleMouseMoveGlobal);
    window.addEventListener("mouseup", handleMouseUpGlobal);
    return () => {
      window.removeEventListener("mousemove", handleMouseMoveGlobal);
      window.removeEventListener("mouseup", handleMouseUpGlobal);
    };
  }, [handleMouseMoveGlobal, handleMouseUpGlobal]);

  // Touch zoom (pinch)
  const lastTouchDistRef = useRef<number | null>(null);
  const lastTouchCenterRef = useRef<{ x: number; y: number } | null>(null);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const centerX = (t1.clientX + t2.clientX) / 2;
        const centerY = (t1.clientY + t2.clientY) / 2;

        if (lastTouchDistRef.current !== null && lastTouchCenterRef.current !== null) {
          const container = containerRef.current;
          if (!container) return;
          const rect = container.getBoundingClientRect();
          const scaleX = size / rect.width;
          const scaleY = size / rect.height;
          const cursorVx = (centerX - rect.left) * scaleX;
          const cursorVy = (centerY - rect.top) * scaleY;

          const zoomFactor = dist / lastTouchDistRef.current;
          const newZoom = Math.min(8, Math.max(1, zoom * zoomFactor));

          const wx = (cursorVx - radius - panOffset.x) / zoom + radius;
          const wy = (cursorVy - radius - panOffset.y) / zoom + radius;
          const newPanX = cursorVx - (wx - radius) * newZoom - radius;
          const newPanY = cursorVy - (wy - radius) * newZoom - radius;

          setZoom(newZoom);
          setPanOffset(clampPan(newPanX, newPanY, newZoom, size, radius));
        }

        lastTouchDistRef.current = dist;
        lastTouchCenterRef.current = { x: centerX, y: centerY };
      }
    },
    [zoom, panOffset, size, radius]
  );

  const handleTouchEnd = useCallback(() => {
    lastTouchDistRef.current = null;
    lastTouchCenterRef.current = null;
  }, []);

  // Reset zoom
  const resetZoom = useCallback(() => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  }, []);

  // Calculate selected position for the marker (in viewport space)
  const selectedPos = selectedHsl
    ? (() => {
        const wp = hslToWheelPos(selectedHsl);
        return wheelToViewport(wp.x, wp.y);
      })()
    : null;

  return (
    <div className="relative inline-block" style={{ width: size, height: size }}>
      <div
        ref={containerRef}
        className="relative overflow-hidden rounded-full"
        style={{ width: size, height: size }}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <canvas
          ref={canvasRef}
          width={size}
          height={size}
          className={zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-crosshair"}
          style={{ width: size, height: size }}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          onMouseLeave={handleMouseLeave}
        />
        {/* Hover cursor indicator */}
        {hoveredPos && !isPanningRef.current && (
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
      {/* Reset zoom button */}
      {zoom > 1 && (
        <Button
          variant="secondary"
          size="sm"
          className="absolute -bottom-9 left-1/2 -translate-x-1/2 text-xs"
          onClick={resetZoom}
        >
          Reset zoom ({zoom.toFixed(1)}x)
        </Button>
      )}
    </div>
  );
}

function clampPan(
  x: number,
  y: number,
  zoom: number,
  size: number,
  radius: number
): { x: number; y: number } {
  // Allow panning so at least the center of the wheel stays visible
  const maxPan = radius * (zoom - 1);
  return {
    x: Math.max(-maxPan, Math.min(maxPan, x)),
    y: Math.max(-maxPan, Math.min(maxPan, y)),
  };
}
