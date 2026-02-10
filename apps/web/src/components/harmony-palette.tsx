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
            <div
              key={i}
              className={`flex-1 cursor-pointer transition-all ${
                focusedTargetHex === hex
                  ? "ring-2 ring-white ring-inset opacity-90 z-10"
                  : "hover:opacity-80"
              }`}
              style={{ backgroundColor: hex }}
              title={i === 0 ? `Source: ${hex}` : `Harmony ${i}: ${hex}`}
              onMouseEnter={() => onSwatchHover?.(hex)}
              onMouseLeave={onSwatchLeave}
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
              return (
                <div
                  key={i}
                  className={`flex-1 ${
                    matchHex
                      ? `cursor-pointer transition-all ${
                          focusedTargetHex === matchHex
                            ? "ring-2 ring-white ring-inset opacity-90 z-10"
                            : "hover:opacity-80"
                        }`
                      : ""
                  }`}
                  style={{
                    backgroundColor: matchHex ?? undefined,
                    backgroundImage: matchHex
                      ? undefined
                      : "repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(128,128,128,0.15) 4px, rgba(128,128,128,0.15) 8px)",
                  }}
                  title={matchHex ? `Closest in ${matchLabel}: ${matchHex}` : `No match in ${matchLabel.toLowerCase()}`}
                  onMouseEnter={() => matchHex && onSwatchHover?.(matchHex)}
                  onMouseLeave={onSwatchLeave}
                  onClick={() => {
                    if (!matchHex) return;
                    onSwatchClick?.(matchHex);
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
