interface HarmonyPaletteProps {
  sourceHex: string;
  harmonyColors: string[];
  label: string;
  /** Closest match hex for each slot [source, ...harmonyColors]. null = no match. */
  matchColors?: (string | null)[];
  /** Label for the scoped match bar (e.g. "My Collection" or "All Polishes"). */
  matchLabel?: string;
  /** Currently focused target hex (for visual highlight) */
  focusedTargetHex?: string | null;
  onSwatchHover?: (hex: string) => void;
  onSwatchLeave?: () => void;
  onSwatchClick?: (hex: string) => void;
}

export function HarmonyPalette({
  sourceHex,
  harmonyColors,
  label,
  matchColors = [],
  matchLabel = "My Collection",
  focusedTargetHex,
  onSwatchHover,
  onSwatchLeave,
  onSwatchClick,
}: HarmonyPaletteProps) {
  const targetColors = [sourceHex, ...harmonyColors];

  return (
    <div className="w-full space-y-2">
      {/* Target bar — ideal harmony colors */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{label} — Target</span>
          <span className="font-mono">{sourceHex}</span>
        </div>
        <div className="flex h-8 overflow-hidden rounded-lg border border-border">
          {targetColors.map((hex, i) => (
            <button
              type="button"
              key={i}
              className={`flex-1 cursor-pointer border-0 p-0 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
                focusedTargetHex === hex
                  ? "ring-2 ring-white ring-inset opacity-90 z-10"
                  : "hover:opacity-80"
              }`}
              style={{ backgroundColor: hex }}
              title={i === 0 ? `Source: ${hex}` : `Harmony ${i}: ${hex}`}
              aria-label={i === 0 ? `Source color: ${hex}` : `Harmony color ${i}: ${hex}`}
              onMouseEnter={() => onSwatchHover?.(hex)}
              onMouseLeave={onSwatchLeave}
              onFocus={() => onSwatchHover?.(hex)}
              onBlur={onSwatchLeave}
              onClick={() => onSwatchClick?.(hex)}
            />
          ))}
        </div>
      </div>

      {/* Scope bar — closest scoped polish for each target */}
      {matchColors.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{matchLabel}</p>
          <div className="flex h-8 overflow-hidden rounded-lg border border-border">
            {targetColors.map((_, i) => {
              const matchHex = matchColors[i] ?? null;
              if (!matchHex) {
                return (
                  <div
                    key={i}
                    className="flex-1"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(128,128,128,0.15) 4px, rgba(128,128,128,0.15) 8px)",
                    }}
                    title={`No match in ${matchLabel.toLowerCase()}`}
                  />
                );
              }
              return (
                <button
                  type="button"
                  key={i}
                  className={`flex-1 cursor-pointer border-0 p-0 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
                    focusedTargetHex === matchHex
                      ? "ring-2 ring-white ring-inset opacity-90 z-10"
                      : "hover:opacity-80"
                  }`}
                  style={{ backgroundColor: matchHex }}
                  title={`Closest in ${matchLabel}: ${matchHex}`}
                  aria-label={`Closest match in ${matchLabel}: ${matchHex}`}
                  onMouseEnter={() => onSwatchHover?.(matchHex)}
                  onMouseLeave={onSwatchLeave}
                  onFocus={() => onSwatchHover?.(matchHex)}
                  onBlur={onSwatchLeave}
                  onClick={() => onSwatchClick?.(matchHex)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
