import {
  swatchWatchIconSpecs,
  type BrandShape,
  type SwatchWatchIconName,
} from "swatchwatch-shared";
import { cn } from "@/lib/utils";

interface SwatchWatchIconProps {
  name?: SwatchWatchIconName;
  size?: number;
  className?: string;
  title?: string;
}

interface SwatchWatchWordmarkProps {
  icon?: SwatchWatchIconName;
  iconSize?: number;
  className?: string;
  textClassName?: string;
}

interface SwatchWatchSpriteIconProps {
  name?: SwatchWatchIconName;
  size?: number;
  className?: string;
  title?: string;
}

const spriteSymbolIds: Record<SwatchWatchIconName, string> = {
  app: "swatchwatch-icon-app",
  monogram: "swatchwatch-icon-monogram",
  swatch: "swatchwatch-icon-swatch",
  brush: "swatchwatch-icon-brush",
};

function renderShape(shape: BrandShape, key: string) {
  if (shape.kind === "rect") {
    return (
      <rect
        key={key}
        x={shape.x}
        y={shape.y}
        width={shape.width}
        height={shape.height}
        rx={shape.rx}
        fill={shape.fill}
        stroke={shape.stroke}
        strokeWidth={shape.strokeWidth}
        strokeLinecap={shape.strokeLinecap}
        strokeLinejoin={shape.strokeLinejoin}
        opacity={shape.opacity}
        transform={shape.transform}
      />
    );
  }

  if (shape.kind === "circle") {
    return (
      <circle
        key={key}
        cx={shape.cx}
        cy={shape.cy}
        r={shape.r}
        fill={shape.fill}
        stroke={shape.stroke}
        strokeWidth={shape.strokeWidth}
        strokeLinecap={shape.strokeLinecap}
        strokeLinejoin={shape.strokeLinejoin}
        opacity={shape.opacity}
        transform={shape.transform}
      />
    );
  }

  if (shape.kind === "line") {
    return (
      <line
        key={key}
        x1={shape.x1}
        y1={shape.y1}
        x2={shape.x2}
        y2={shape.y2}
        fill={shape.fill}
        stroke={shape.stroke}
        strokeWidth={shape.strokeWidth}
        strokeLinecap={shape.strokeLinecap}
        strokeLinejoin={shape.strokeLinejoin}
        opacity={shape.opacity}
        transform={shape.transform}
      />
    );
  }

  return (
    <path
      key={key}
      d={shape.d}
      fill={shape.fill}
      stroke={shape.stroke}
      strokeWidth={shape.strokeWidth}
      strokeLinecap={shape.strokeLinecap}
      strokeLinejoin={shape.strokeLinejoin}
      opacity={shape.opacity}
      transform={shape.transform}
    />
  );
}

export function SwatchWatchIcon({
  name = "monogram",
  size = 32,
  className,
  title,
}: SwatchWatchIconProps) {
  const spec = swatchWatchIconSpecs[name];

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={spec.viewBox}
      fill="none"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={!title}
    >
      {spec.shapes.map((shape, index) => renderShape(shape, `${name}-${index}`))}
    </svg>
  );
}

export function SwatchWatchSpriteIcon({
  name = "monogram",
  size = 32,
  className,
  title,
}: SwatchWatchSpriteIconProps) {
  const spec = swatchWatchIconSpecs[name];
  const symbolId = spriteSymbolIds[name];

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={spec.viewBox}
      fill="none"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={!title}
    >
      <use href={`/brand/swatchwatch-sprite.svg#${symbolId}`} />
    </svg>
  );
}

/**
 * SwatchWatch wordmark — clean, modern, cohesive.
 *
 * Design: "Swatch" in brand ink, "Watch" in brand purple.
 * Bold weight, tight tracking, no decorations. The drop icon
 * does the visual heavy lifting. Inspired by Cirque Colors'
 * restraint and Mooncat's bold simplicity.
 */
export function SwatchWatchWordmark({
  icon = "monogram",
  iconSize = 32,
  className,
  textClassName,
}: SwatchWatchWordmarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <SwatchWatchIcon name={icon} size={iconSize} title="SwatchWatch logo" />
      <span
        className={cn(
          "text-base font-bold tracking-tight",
          textClassName
        )}
      >
        <span className="text-brand-ink dark:text-brand-lilac">Swatch</span>
        <span className="text-brand-purple dark:text-brand-pink-soft">Watch</span>
      </span>
    </span>
  );
}

export function SwatchWatchGraphicSet({
  className,
}: {
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <SwatchWatchIcon name="app" size={52} title="SwatchWatch app icon" />
      <SwatchWatchIcon name="monogram" size={44} title="SW monogram" />
      <SwatchWatchIcon name="swatch" size={36} title="Color swatch icon" />
      <SwatchWatchIcon name="brush" size={36} title="Nail brush icon" />
    </div>
  );
}
