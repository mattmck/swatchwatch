import Link from "next/link";
import type { Polish } from "polish-inventory-shared";
import { Badge } from "@/components/ui/badge";
import { ColorDot } from "@/components/color-dot";

interface ColorSearchResultsProps {
  polishes: (Polish & { distance: number })[];
  targetHex: string;
  mode: "similar" | "complementary";
}

export function ColorSearchResults({
  polishes,
  targetHex,
  mode,
}: ColorSearchResultsProps) {
  if (polishes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-muted-foreground">
          No polishes with color data in your collection.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 pb-2">
        <span
          className="inline-block h-4 w-4 rounded-full border border-border"
          style={{ backgroundColor: targetHex }}
        />
        <p className="text-xs text-muted-foreground">
          {mode === "similar" ? "Closest matches" : "Complementary matches"} ·{" "}
          {polishes.length} {polishes.length === 1 ? "polish" : "polishes"}
        </p>
      </div>
      {polishes.map((polish) => (
        <Link
          key={polish.id}
          href={`/polishes/${polish.id}`}
          className="flex items-center gap-3 rounded-md p-2 transition-colors hover:bg-muted"
        >
          <ColorDot hex={polish.colorHex} size="md" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{polish.name}</p>
            <p className="text-sm text-muted-foreground">{polish.brand}</p>
          </div>
          {polish.finish && (
            <Badge variant="secondary" className="shrink-0">
              {polish.finish}
            </Badge>
          )}
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground w-12 text-right">
            {(polish.distance * 100).toFixed(0)}%
          </span>
        </Link>
      ))}
    </div>
  );
}
