"use client";

import { useEffect, useRef, useState } from "react";
import { runAdminBackfillBatch } from "@/lib/api";
import {
  type BackfillReport,
  mergeBackfillTotals,
  parseSourceNames,
  readBackfillCursor,
} from "@/lib/admin-backfills";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface BackfillDefinition {
  id: string;
  title: string;
  description: string;
  /** The equivalent shell command (README / CLAUDE.md). */
  command: string;
  /** API path after `/api/`. */
  path: string;
  /** Request body key for the keyset cursor, and the report key holding the next one. */
  cursorKey: string;
  nextKey: string;
  /** False for idempotent jobs with no dry run (they only fill gaps). */
  dryRun: boolean;
  defaultLimit: number;
  maxLimit: number;
  /** Offers the comma-separated data source filter (`sources`). */
  sources?: boolean;
  /** Boolean body fields shown as switches. */
  options?: { key: string; label: string; defaultValue: boolean }[];
  metrics: { key: string; label: string }[];
  /** Object-valued report keys shown as `key value` chips. */
  maps?: { key: string; label: string; format?: (value: unknown) => string }[];
  /** List-valued report keys (findings to review). */
  lists?: { key: string; label: string; format: (item: Record<string, unknown>) => string }[];
  applyConfirm: string;
}

const BACKFILLS: BackfillDefinition[] = [
  {
    id: "image-variants",
    title: "Catalog thumbnails",
    description:
      "Writes the pre-generated WebP thumbnails missing for catalog images. Idempotent: existing variants are skipped, so a re-run only fills gaps. A batch that has to write many thumbnails ends early (about 45 s) and the run carries on from where it stopped. Run after bumping IMAGE_VARIANT_CROP_VERSION or changing the size ladder.",
    command: "npm run backfill:image-variants --workspace=swatchwatch-functions",
    path: "images-admin/variants/backfill",
    cursorKey: "afterImageId",
    nextKey: "nextAfterImageId",
    dryRun: false,
    defaultLimit: 25,
    maxLimit: 100,
    metrics: [
      { key: "scanned", label: "Images read" },
      { key: "checked", label: "Blobs checked" },
      { key: "complete", label: "Already complete" },
      { key: "variantsWritten", label: "Variants written" },
      { key: "skipped", label: "Skipped" },
    ],
    lists: [{ key: "failures", label: "Failures", format: (f) => `image ${f.imageId}: ${f.error}` }],
    applyConfirm: "Generate the missing catalog thumbnails? This writes blobs to storage.",
  },
  {
    id: "barcodes",
    title: "Catalog barcodes",
    description:
      "Builds catalog barcode rows from stored connector products (product GTIN and variant barcodes). A GTIN belongs to one shade: the first keeps it, later claims are listed as conflicts.",
    command: "npm run backfill:barcodes --workspace=swatchwatch-functions -- --write",
    path: "barcodes-admin/backfill",
    cursorKey: "afterExternalProductId",
    nextKey: "nextAfterExternalProductId",
    dryRun: true,
    defaultLimit: 200,
    maxLimit: 1000,
    metrics: [
      { key: "scannedProducts", label: "Products read" },
      { key: "productsWithGtins", label: "With a GTIN" },
      { key: "gtinsFound", label: "GTINs found" },
      { key: "inserted", label: "Barcodes added" },
      { key: "alreadyLinked", label: "Already linked" },
      { key: "shadesGainingBarcode", label: "Shades gaining one" },
    ],
    lists: [
      {
        key: "conflicts",
        label: "Conflicts (GTIN already on another shade)",
        format: (c) => `${c.gtin}: product ${c.externalProductId} → shade ${c.shadeId}, kept on shade ${c.existingShadeId}`,
      },
      {
        key: "ambiguousProducts",
        label: "Ambiguous products (several shades)",
        format: (p) => `product ${p.externalProductId} → shades ${Array.isArray(p.shadeIds) ? p.shadeIds.join(", ") : ""}`,
      },
      {
        key: "invalidCheckDigit",
        label: "Wrong check digit (kept)",
        format: (b) => `${b.gtin}: product ${b.externalProductId} → shade ${b.shadeId}`,
      },
    ],
    applyConfirm: "Write catalog barcode rows? Each GTIN goes to the first shade that claims it.",
  },
  {
    id: "gallery-dedupe",
    title: "Gallery duplicates",
    description:
      "Unlinks gallery images that duplicate another image of the same shade (perceptual match). Product images, labeled images and other sources are never touched; image rows and blobs are kept. Also stores missing image fingerprints, even in a dry run, unless switched off.",
    command: "npm run dedupe:gallery-images --workspace=swatchwatch-functions -- --write",
    path: "images-admin/gallery-dedupe",
    cursorKey: "afterShadeId",
    nextKey: "nextAfterShadeId",
    dryRun: true,
    defaultLimit: 25,
    maxLimit: 100,
    options: [{ key: "storeFingerprints", label: "Store image fingerprints", defaultValue: true }],
    metrics: [
      { key: "scannedShades", label: "Shades read" },
      { key: "shadesWithDuplicates", label: "With duplicates" },
      { key: "duplicateGroups", label: "Duplicate groups" },
      { key: "swatchesRemoved", label: "Swatches unlinked" },
      { key: "duplicatesKept", label: "Duplicates kept" },
      { key: "imagesFingerprinted", label: "Images fingerprinted" },
      { key: "fingerprintsStored", label: "Fingerprints stored" },
      { key: "unreadableImages", label: "Unreadable images" },
    ],
    lists: [
      {
        key: "groups",
        label: "Duplicate groups",
        format: (g) => {
          const removed = Array.isArray(g.removeImageIds) ? g.removeImageIds.join(", ") : "";
          return `shade ${g.shadeId}: keep image ${g.keepImageId}, unlink ${removed}`;
        },
      },
      { key: "failures", label: "Failures", format: (f) => `image ${f.imageId}: ${f.error}` },
    ],
    applyConfirm: "Unlink the duplicate gallery images? Image rows and blobs are kept.",
  },
  {
    id: "product-text",
    title: "Product text",
    description:
      "Recomputes the stored product description and descriptors from each connector product's raw data (#352). Not shown to users; it feeds finish detection.",
    command: "npm run backfill:product-text --workspace=swatchwatch-functions -- --write",
    path: "products-admin/text/backfill",
    cursorKey: "afterExternalProductId",
    nextKey: "nextAfterExternalProductId",
    dryRun: true,
    defaultLimit: 500,
    maxLimit: 1000,
    sources: true,
    metrics: [
      { key: "scanned", label: "Products read" },
      { key: "changed", label: "Changed" },
      { key: "written", label: "Written" },
    ],
    maps: [{ key: "bySource", label: "Changed by source" }],
    applyConfirm: "Rewrite the stored product text?",
  },
  {
    id: "finish-fill",
    title: "Empty shade finishes",
    description:
      "Fills finishes for shades that have none, from their most recently seen connector product, with ingestion's rules (tags, then descriptors, then description). Shades that already have finishes are never changed. Run Product text first.",
    command: "npm run backfill:product-text --workspace=swatchwatch-functions -- --write --fill-finishes",
    path: "shades-admin/finishes/backfill",
    cursorKey: "afterShadeId",
    nextKey: "nextAfterShadeId",
    dryRun: true,
    defaultLimit: 500,
    maxLimit: 1000,
    sources: true,
    metrics: [
      { key: "scanned", label: "Empty shades read" },
      { key: "fillable", label: "Fillable" },
      { key: "filled", label: "Filled" },
    ],
    maps: [
      { key: "fillableBySource", label: "Fillable from" },
      { key: "coverage", label: "Catalog before this run" },
    ],
    applyConfirm: "Fill finishes on shades that have none?",
  },
  {
    id: "product-price",
    title: "Product prices",
    description:
      "Recomputes the brand list price and currency (shown next to buy links) from each connector product's raw data. Shopify currencies come from the source settings, earlier ingests, or the shop's /meta.json.",
    command: "npm run backfill:product-price --workspace=swatchwatch-functions -- --write",
    path: "products-admin/price/backfill",
    cursorKey: "afterExternalProductId",
    nextKey: "nextAfterExternalProductId",
    dryRun: true,
    defaultLimit: 500,
    maxLimit: 1000,
    sources: true,
    options: [{ key: "fetchCurrency", label: "Ask shops for their currency", defaultValue: true }],
    metrics: [
      { key: "scanned", label: "Products read" },
      { key: "changed", label: "Changed" },
      { key: "written", label: "Written" },
      { key: "pricedWithCurrency", label: "Priced with currency" },
      { key: "pricedWithoutCurrency", label: "Priced, no currency" },
    ],
    maps: [
      { key: "bySource", label: "Changed by source" },
      {
        key: "currencies",
        label: "Store currencies",
        format: (value) => {
          const entry = (value ?? {}) as { currency?: string | null; origin?: string };
          return `${entry.currency ?? "unknown"} (${entry.origin ?? "?"})`;
        },
      },
    ],
    applyConfirm: "Rewrite the stored product prices?",
  },
];

type RunStatus = "idle" | "running" | "done" | "stopped" | "failed";

function parseNonNegativeInt(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

function downloadJson(name: string, data: unknown) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function BackfillCard({ definition }: { definition: BackfillDefinition }) {
  const [status, setStatus] = useState<RunStatus>("idle");
  const [stopping, setStopping] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [totals, setTotals] = useState<BackfillReport>({});
  const [batches, setBatches] = useState(0);
  const [startedAfter, setStartedAfter] = useState(0);
  // Where a stopped or failed run resumes; null once a run reaches the end.
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startAfterText, setStartAfterText] = useState("0");
  const [limitText, setLimitText] = useState(String(definition.defaultLimit));
  const [sourcesText, setSourcesText] = useState("");
  const [options, setOptions] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((definition.options ?? []).map((option) => [option.key, option.defaultValue]))
  );
  const stopRequested = useRef(false);

  const running = status === "running";

  // Leaving the page drops the loop between batches; warn first.
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  useEffect(
    () => () => {
      stopRequested.current = true;
    },
    []
  );

  const limit = parseNonNegativeInt(limitText);
  const limitValid = limit !== null && limit >= 1 && limit <= definition.maxLimit;
  const startAfter = parseNonNegativeInt(startAfterText);
  const canResume = (status === "stopped" || status === "failed") && cursor !== null;

  const run = async (runDryRun: boolean, resume: boolean) => {
    if (!limitValid || limit === null) return;
    const from = resume ? cursor : startAfter;
    if (from === null) return;
    const applying = !definition.dryRun || !runDryRun;
    if (applying && !resume && !window.confirm(definition.applyConfirm)) return;

    stopRequested.current = false;
    setStopping(false);
    setStatus("running");
    setError(null);
    setDryRun(runDryRun);
    let runTotals = resume ? totals : {};
    let runBatches = resume ? batches : 0;
    if (!resume) {
      setTotals({});
      setBatches(0);
      setStartedAfter(from);
    }
    const sources = definition.sources ? parseSourceNames(sourcesText) : null;
    let after = from;
    try {
      for (;;) {
        const report = await runAdminBackfillBatch(definition.path, {
          [definition.cursorKey]: after,
          limit,
          ...(definition.dryRun ? { dryRun: runDryRun } : {}),
          ...options,
          ...(sources ? { sources } : {}),
        });
        runTotals = mergeBackfillTotals(runTotals, report, [definition.nextKey, "dryRun"]);
        runBatches += 1;
        const next = readBackfillCursor(report, definition.nextKey);
        setTotals(runTotals);
        setBatches(runBatches);
        setCursor(next);
        if (next === null) {
          setStatus("done");
          return;
        }
        after = next;
        if (stopRequested.current) {
          setStatus("stopped");
          return;
        }
      }
    } catch (err) {
      setCursor(after);
      setError(err instanceof Error ? err.message : "Batch failed");
      setStatus("failed");
    }
  };

  const modeLabel = !definition.dryRun ? "Run" : dryRun ? "Dry run" : "Apply";
  const statusLine =
    status === "idle"
      ? null
      : `${modeLabel} from ${startedAfter} · ${batches} ${batches === 1 ? "batch" : "batches"}` +
        (status === "running"
          ? stopping
            ? " · stopping after this batch…"
            : cursor !== null
              ? ` · next after ${cursor}`
              : ""
          : status === "done"
            ? " · finished"
            : cursor !== null
              ? ` · resume after ${cursor}`
              : "");

  return (
    <section className="space-y-4 rounded-lg border p-4" aria-labelledby={`backfill-${definition.id}`}>
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`backfill-${definition.id}`} className="text-base font-semibold">
            {definition.title}
          </h3>
          {status === "running" && <Badge variant="secondary">Running</Badge>}
          {status === "done" && <Badge variant="outline">{dryRun && definition.dryRun ? "Dry run done" : "Done"}</Badge>}
          {status === "stopped" && <Badge variant="outline">Stopped</Badge>}
          {status === "failed" && <Badge variant="destructive">Failed</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">{definition.description}</p>
        <p className="break-all font-mono text-xs text-muted-foreground">{definition.command}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Start after id</span>
          <Input
            className="h-8 w-28"
            inputMode="numeric"
            value={startAfterText}
            onChange={(event) => setStartAfterText(event.target.value)}
            disabled={running}
            aria-invalid={startAfter === null}
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Batch size (1–{definition.maxLimit})</span>
          <Input
            className="h-8 w-24"
            inputMode="numeric"
            value={limitText}
            onChange={(event) => setLimitText(event.target.value)}
            disabled={running}
            aria-invalid={!limitValid}
          />
        </label>
        {definition.sources && (
          <label className="min-w-[12rem] flex-1 space-y-1 text-xs">
            <span className="text-muted-foreground">Data sources (comma-separated, empty = all)</span>
            <Input
              className="h-8"
              placeholder="MakeupAPI, HoloTacoShopify"
              value={sourcesText}
              onChange={(event) => setSourcesText(event.target.value)}
              disabled={running}
            />
          </label>
        )}
        {(definition.options ?? []).map((option) => (
          <label key={option.key} className="flex h-8 items-center gap-2 text-sm">
            <Switch
              checked={options[option.key]}
              onCheckedChange={(checked) => setOptions((current) => ({ ...current, [option.key]: checked }))}
              disabled={running}
            />
            {option.label}
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {definition.dryRun ? (
          <>
            <Button size="sm" variant="outline" onClick={() => void run(true, false)} disabled={running || !limitValid || startAfter === null}>
              Dry run
            </Button>
            <Button size="sm" onClick={() => void run(false, false)} disabled={running || !limitValid || startAfter === null}>
              Apply
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => void run(false, false)} disabled={running || !limitValid || startAfter === null}>
            Run
          </Button>
        )}
        {running && (
          <Button
            size="sm"
            variant="ghost"
            disabled={stopping}
            onClick={() => {
              stopRequested.current = true;
              setStopping(true);
            }}
          >
            Stop
          </Button>
        )}
        {canResume && !running && (
          <Button size="sm" variant="outline" onClick={() => void run(dryRun, true)} disabled={!limitValid}>
            Resume after {cursor}
          </Button>
        )}
        {batches > 0 && !running && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              downloadJson(`${definition.id}-${modeLabel.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.json`, {
                backfill: definition.id,
                mode: modeLabel,
                startedAfter,
                batches,
                finished: status === "done",
                resumeAfter: status === "done" ? null : cursor,
                totals,
              })
            }
          >
            Download report
          </Button>
        )}
      </div>

      {statusLine && <p className="text-xs text-muted-foreground">{statusLine}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {batches > 0 && (
        <div className="space-y-3 rounded-md bg-muted/40 p-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            {definition.metrics.map((metric) => (
              <div key={metric.key}>
                <dt className="text-xs text-muted-foreground">{metric.label}</dt>
                <dd className="text-sm font-medium tabular-nums">{Number(totals[metric.key] ?? 0).toLocaleString()}</dd>
              </div>
            ))}
          </dl>
          {(definition.maps ?? []).map((map) => {
            const value = totals[map.key];
            if (!value || typeof value !== "object") return null;
            const entries = Object.entries(value as Record<string, unknown>);
            if (entries.length === 0) return null;
            return (
              <div key={map.key} className="space-y-1">
                <h4 className="text-xs font-medium">{map.label}</h4>
                <p className="text-xs text-muted-foreground">
                  {entries.map(([key, entry]) => `${key} ${map.format ? map.format(entry) : String(entry)}`).join(" · ")}
                </p>
              </div>
            );
          })}
          {(definition.lists ?? []).map((list) => {
            const items = Array.isArray(totals[list.key]) ? (totals[list.key] as Record<string, unknown>[]) : [];
            const count = Number(totals[`${list.key}Count`] ?? items.length);
            if (count === 0) return null;
            return (
              <div key={list.key} className="space-y-1">
                <h4 className="text-xs font-medium">
                  {list.label} <span className="text-muted-foreground">({count.toLocaleString()})</span>
                </h4>
                <ul className="max-h-40 space-y-0.5 overflow-y-auto break-all text-xs">
                  {items.map((item, index) => (
                    <li key={index}>{list.format(item)}</li>
                  ))}
                </ul>
                {count > items.length && (
                  <p className="text-xs text-muted-foreground">First {items.length} shown; the full list is in the server log.</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Admin console Backfills tab: runs the catalog backfills that otherwise need a shell
 * (`npm run backfill:*`), one keyset batch per request, looping until the scan is finished.
 * Stop ends a run after the current batch; a stopped or failed run resumes from its cursor.
 */
export function BackfillsTab({ onOpenProductCategories }: { onOpenProductCategories?: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Each backfill runs in batches from this browser tab and is safe to repeat. Keep the page open while one runs
        (switching admin tabs is fine). Dry run reports what would change without writing anything.
        {onOpenProductCategories && (
          <>
            {" "}
            The product category backfill lives with the review tools in{" "}
            <button type="button" className="underline underline-offset-2" onClick={onOpenProductCategories}>
              Review Queue
            </button>
            .
          </>
        )}
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        {BACKFILLS.map((definition) => (
          <BackfillCard key={definition.id} definition={definition} />
        ))}
      </div>
    </div>
  );
}
