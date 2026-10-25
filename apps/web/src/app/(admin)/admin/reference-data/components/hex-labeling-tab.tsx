"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  HexLabelPromoteResponse,
  HexLabelQueueFilters,
  HexLabelQueueItem,
  HexLabelRequest,
  HexLabelSaveResponse,
} from "swatchwatch-shared";
import { deleteHexLabel, getHexLabelQueue, saveHexLabel } from "@/lib/api";
import { labelProgress, undoHexLabelSave } from "@/lib/hex-sampling";
import { ShadeLabeler } from "@/components/shade-hex-labeler";
import { applyPromotionResponse } from "@/lib/vendor-hex-promotion";
import { ToggleChip } from "@/components/toggle-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PAGE_SIZE = 20;
/** Prefetch the next page when this many shades are left in the loaded queue. */
const PREFETCH_REMAINING = 3;

type FilterState = Required<Pick<HexLabelQueueFilters, "disagreeOnly" | "showLabeled" | "includeWithoutImages">> & {
  brand: string;
};

interface QueueState {
  key: string;
  items: HexLabelQueueItem[];
  nextCursor: string | null;
  total: number;
  labeled: number;
  threshold: number;
  index: number;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// ── Tab ─────────────────────────────────────────────────────────────────────

function filtersKey(filters: FilterState): string {
  return JSON.stringify(filters);
}

/**
 * Admin "Hex Labeling" tab: walk a queue of shades and pick each one's true colour from its
 * product images with a canvas eyedropper. Saves ground-truth labels for the hex-detection eval
 * (`color_training_sample`, source_type `manual`); never changes the shade's vendor/detected hex,
 * except through the explicit, confirmed "Promote to vendor hex" action on a saved label (#321).
 */
export function HexLabelingTab() {
  const [filters, setFilters] = useState<FilterState>({
    brand: "",
    disagreeOnly: false,
    showLabeled: false,
    includeWithoutImages: false,
  });
  const [brandDraft, setBrandDraft] = useState("");
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [sampleSize, setSampleSize] = useState(5);
  const [saving, setSaving] = useState(false);
  const [lastSave, setLastSave] = useState<HexLabelSaveResponse | null>(null);
  const [skipped, setSkipped] = useState(0);
  const loadingMoreRef = useRef(false);

  const key = `${filtersKey(filters)}#${reloadToken}`;
  const isLoading = queue?.key !== key && loadError?.key !== key;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await getHexLabelQueue({
          brand: filters.brand || undefined,
          disagreeOnly: filters.disagreeOnly,
          showLabeled: filters.showLabeled,
          includeWithoutImages: filters.includeWithoutImages,
          pageSize: PAGE_SIZE,
        });
        if (cancelled) return;
        setQueue({
          key,
          items: response.items,
          nextCursor: response.nextCursor,
          total: response.total,
          labeled: response.labeled,
          threshold: response.disagreementThreshold,
          index: 0,
        });
        setLoadError(null);
      } catch (error) {
        if (!cancelled) setLoadError({ key, message: errorMessage(error, "Failed to load the labeling queue") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters, key]);

  const current = queue && queue.key === key ? queue.items[queue.index] ?? null : null;

  // Prefetch the next page as the admin nears the end of the loaded queue.
  useEffect(() => {
    if (!queue || queue.key !== key || !queue.nextCursor || loadingMoreRef.current) return;
    if (queue.items.length - queue.index > PREFETCH_REMAINING) return;
    loadingMoreRef.current = true;
    const cursor = queue.nextCursor;
    void (async () => {
      try {
        const response = await getHexLabelQueue({
          brand: filters.brand || undefined,
          disagreeOnly: filters.disagreeOnly,
          showLabeled: filters.showLabeled,
          includeWithoutImages: filters.includeWithoutImages,
          pageSize: PAGE_SIZE,
          cursor,
        });
        setQueue((prev) =>
          prev && prev.key === key && prev.nextCursor === cursor
            ? {
                ...prev,
                items: [
                  ...prev.items,
                  ...response.items.filter((item) => !prev.items.some((existing) => existing.shadeId === item.shadeId)),
                ],
                nextCursor: response.nextCursor,
              }
            : prev
        );
      } catch (error) {
        toast.error("Failed to load more shades", { description: errorMessage(error, "Request failed") });
      } finally {
        loadingMoreRef.current = false;
      }
    })();
  }, [filters, key, queue]);

  const goTo = useCallback(
    (delta: 1 | -1) => {
      if (delta === 1 && queue && queue.index >= queue.items.length - 1 && !queue.nextCursor) {
        toast.info("End of the queue", { description: "Change the filters or turn on “Show labeled” to review." });
      }
      setQueue((prev) => {
        if (!prev) return prev;
        const index = Math.min(prev.items.length - 1, Math.max(0, prev.index + delta));
        return index === prev.index ? prev : { ...prev, index };
      });
    },
    [queue]
  );

  const handleNext = useCallback(() => goTo(1), [goTo]);
  const handlePrev = useCallback(() => goTo(-1), [goTo]);
  const handleSkip = useCallback(() => {
    setSkipped((count) => count + 1);
    goTo(1);
  }, [goTo]);

  /** Replace one shade's label in the loaded queue and keep the progress count in sync. */
  const applyLabel = useCallback((shadeId: string, label: HexLabelQueueItem["label"]) => {
    setQueue((prev) => {
      if (!prev) return prev;
      let delta = 0;
      const items = prev.items.map((item) => {
        if (item.shadeId !== shadeId) return item;
        delta = (label ? 1 : 0) - (item.label ? 1 : 0);
        return { ...item, label };
      });
      return { ...prev, items, labeled: Math.max(0, prev.labeled + delta) };
    });
  }, []);

  const handlePromotionChange = useCallback((response: HexLabelPromoteResponse) => {
    setQueue((prev) => (prev ? { ...prev, items: prev.items.map((item) => applyPromotionResponse(item, response)) } : prev));
  }, []);

  const handleItemChange = useCallback((next: HexLabelQueueItem) => {
    setQueue((prev) =>
      prev ? { ...prev, items: prev.items.map((item) => (item.shadeId === next.shadeId ? next : item)) } : prev
    );
  }, []);

  const handleSave = useCallback(
    async (request: HexLabelRequest) => {
      setSaving(true);
      try {
        const response = await saveHexLabel(request);
        applyLabel(response.label.shadeId, response.label);
        setLastSave(response);
        toast.success(response.label.unreliable ? "Flagged as unreliable" : `Saved ${response.label.hex}`, {
          description: response.previous ? "Replaced the previous label." : undefined,
        });
        goTo(1);
      } catch (error) {
        toast.error("Failed to save label", { description: errorMessage(error, "Request failed") });
      } finally {
        setSaving(false);
      }
    },
    [applyLabel, goTo]
  );

  const handleUndo = useCallback(async () => {
    if (!lastSave || saving) return;
    setSaving(true);
    try {
      const { plan, label } = await undoHexLabelSave(lastSave, { saveHexLabel, deleteHexLabel });
      applyLabel(plan.shadeId, label);
      setLastSave(null);
      setQueue((prev) => {
        if (!prev) return prev;
        const index = prev.items.findIndex((item) => item.shadeId === plan.shadeId);
        return index >= 0 ? { ...prev, index } : prev;
      });
      toast.success(plan.kind === "delete" ? "Label removed" : "Previous label restored");
    } catch (error) {
      toast.error("Undo failed", { description: errorMessage(error, "Request failed") });
    } finally {
      setSaving(false);
    }
  }, [applyLabel, lastSave, saving]);

  const progress = useMemo(() => labelProgress(queue?.labeled ?? 0, queue?.total ?? 0), [queue?.labeled, queue?.total]);

  function applyBrand() {
    const brand = brandDraft.trim();
    if (brand !== filters.brand) setFilters((prev) => ({ ...prev, brand }));
  }

  return (
    <div className="space-y-4" data-testid="hex-labeling-tab">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Hex Labeling</h2>
        <p className="text-sm text-muted-foreground">
          Pick each polish&apos;s true colour from its product images to build ground truth for the hex-detection
          eval (<code className="text-xs">npm run eval:hex:populate -- --source-type manual</code>). Labels never change a
          shade&apos;s vendor or detected hex unless you promote a saved label to the vendor hex.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            applyBrand();
          }}
        >
          <Input
            value={brandDraft}
            onChange={(event) => setBrandDraft(event.target.value)}
            onBlur={applyBrand}
            placeholder="Filter by brand"
            aria-label="Filter by brand"
            className="h-8 w-44"
          />
        </form>
        <ToggleChip pressed={filters.disagreeOnly} onPressedChange={(disagreeOnly) => setFilters((prev) => ({ ...prev, disagreeOnly }))}>
          Vendor ≠ detected
        </ToggleChip>
        <ToggleChip pressed={filters.showLabeled} onPressedChange={(showLabeled) => setFilters((prev) => ({ ...prev, showLabeled }))}>
          Show labeled
        </ToggleChip>
        <ToggleChip
          pressed={filters.includeWithoutImages}
          onPressedChange={(includeWithoutImages) => setFilters((prev) => ({ ...prev, includeWithoutImages }))}
        >
          Include no-image shades
        </ToggleChip>
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span>
            <span className="font-semibold">{progress.labeled}</span> / {progress.total} labeled ({progress.percent}%)
            {skipped > 0 ? <span className="text-muted-foreground"> · {skipped} skipped this session</span> : null}
          </span>
          {queue && queue.key === key && queue.items.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              Shade {queue.index + 1} of {queue.items.length}
              {queue.nextCursor ? "+" : ""} in queue
            </span>
          ) : null}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
          <div className="h-full bg-primary transition-all" style={{ width: `${progress.percent}%` }} />
        </div>
      </div>

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading queue…</p>
      ) : loadError?.key === key ? (
        <div className="space-y-2 py-8 text-center">
          <p className="text-sm text-destructive">{loadError.message}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setReloadToken((token) => token + 1)}>
            Retry
          </Button>
        </div>
      ) : current && queue ? (
        <ShadeLabeler
          key={current.shadeId}
          item={current}
          threshold={queue.threshold}
          sampleSize={sampleSize}
          onSampleSizeChange={setSampleSize}
          saving={saving}
          canUndo={lastSave !== null}
          canPrev={queue.index > 0}
          onSave={handleSave}
          onSkip={handleSkip}
          onNext={handleNext}
          onPrev={handlePrev}
          onUndo={handleUndo}
          onPromotionChange={handlePromotionChange}
          onItemChange={handleItemChange}
        />
      ) : (
        <p className="py-12 text-center text-sm text-muted-foreground">
          Nothing to label with these filters. Try another brand or turn on “Show labeled”.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Shortcuts: click/tap the image to sample · <kbd>Enter</kbd> save · <kbd>S</kbd> skip · <kbd>N</kbd>/<kbd>→</kbd> next ·{" "}
        <kbd>P</kbd>/<kbd>←</kbd> previous · <kbd>1</kbd>–<kbd>9</kbd> image · <kbd>[</kbd>/<kbd>]</kbd> sample size ·{" "}
        <kbd>E</kbd> eyedropper · <kbd>U</kbd> undo
      </p>
    </div>
  );
}
