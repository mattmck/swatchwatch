import Link from "next/link";
import type { CollectionGapCell, HueFamily, LightnessBand, Polish } from "swatchwatch-shared";
import { HUE_FAMILY_ORDER } from "@/lib/color-utils";
import { ColorDot } from "@/components/color-dot";
import { Badge } from "@/components/ui/badge";
import {
  getVisibleItems,
  LIGHTNESS_META,
  shouldShowTruncationSummary,
  type RowCellPresentation,
  getRowCellPresentation,
} from "./gaps-utils";

export type CellBoundPolish = {
  polish: Polish;
  colorHex: string;
  hueFamily: HueFamily;
  lightnessBand: LightnessBand;
  owned: boolean;
};

/**
 * Compact list of polishes assigned to a selected heatmap cell.
 * @param title Section title.
 * @param items Matched polishes.
 * @param emptyLabel Message shown when `items` is empty.
 * @param resolveVisibleItems Optional override for computing visible rows (used by tests).
 * @returns A card-like list with count badge, up to six links, and optional truncation summary.
 */
export function CellMatchesList({
  title,
  items,
  emptyLabel,
  resolveVisibleItems = getVisibleItems,
}: {
  title: string;
  items: CellBoundPolish[];
  emptyLabel: string;
  resolveVisibleItems?: (items: CellBoundPolish[], maxVisible?: number) => CellBoundPolish[];
}) {
  const visible = resolveVisibleItems(items, 6);

  return (
    <div className="rounded-md border bg-muted/30 p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          {title}
        </p>
        <Badge variant="outline" className="h-5 px-2 text-[10px]">
          {items.length}
        </Badge>
      </div>
      {visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="space-y-1.5">
          {visible.map((item) => (
            <Link
              key={item.polish.id}
              href={`/polishes/detail?id=${item.polish.id}`}
              className="flex items-center gap-2 rounded-md border bg-background/85 px-2 py-1.5 text-xs transition hover:bg-background"
            >
              <ColorDot hex={item.colorHex} size="sm" />
              <span className="min-w-0 flex-1 truncate font-medium">
                {item.polish.brand} · {item.polish.name}
              </span>
            </Link>
          ))}
          {shouldShowTruncationSummary(items.length, visible.length) && (
            <p className="text-[11px] text-muted-foreground">
              Showing {visible.length} of {items.length}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Render one lightness row of heatmap cells across all hue families.
 * @param lightnessBand Row lightness band.
 * @param cellsByKey Precomputed cell lookup map.
 * @param maxCellCount Maximum cell count in analysis.
 * @param missingKeys Set of missing cell keys.
 * @param thinKeys Set of thin cell keys.
 * @param selectedCellKey Currently selected key.
 * @param onSelect Called with a cell key when user clicks a cell.
 * @param resolveCellPresentation Optional override for row cell derivation (used by tests).
 * @returns Row label plus one button per hue family; missing cell entries render as empty placeholders.
 */
export function Row({
  lightnessBand,
  cellsByKey,
  maxCellCount,
  missingKeys,
  thinKeys,
  selectedCellKey,
  onSelect,
  resolveCellPresentation = getRowCellPresentation,
}: {
  lightnessBand: LightnessBand;
  cellsByKey: Map<string, CollectionGapCell>;
  maxCellCount: number;
  missingKeys: Set<string>;
  thinKeys: Set<string>;
  selectedCellKey: string | null;
  onSelect: (key: string) => void;
  resolveCellPresentation?: (params: {
    hueFamily: HueFamily;
    lightnessBand: LightnessBand;
    cellsByKey: Map<string, CollectionGapCell>;
    maxCellCount: number;
    missingKeys: Set<string>;
    thinKeys: Set<string>;
    selectedCellKey: string | null;
  }) => RowCellPresentation | null;
}) {
  return (
    <>
      <div className="flex items-center rounded-md border border-brand-lilac/45 bg-muted/40 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {LIGHTNESS_META[lightnessBand].label}
      </div>
      {HUE_FAMILY_ORDER.map((hueFamily) => {
        const cellView = resolveCellPresentation({
          hueFamily,
          lightnessBand,
          cellsByKey,
          maxCellCount,
          missingKeys,
          thinKeys,
          selectedCellKey,
        });

        if (!cellView) {
          return <div key={`${hueFamily}:${lightnessBand}`} />;
        }

        return (
          <button
            key={cellView.key}
            type="button"
            title={cellView.title}
            onClick={() => onSelect(cellView.key)}
            className={`group relative h-20 rounded-lg border p-2 text-left transition hover:scale-[1.02] hover:shadow-glow-brand ${cellView.className}`}
            style={cellView.style}
          >
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] opacity-75">
              {cellView.lightnessShort}
            </p>
            <p className="mt-1 text-2xl font-black leading-none">{cellView.count}</p>
            <p className="mt-1 text-[10px] font-medium opacity-80">{cellView.severityLabel}</p>
          </button>
        );
      })}
    </>
  );
}
