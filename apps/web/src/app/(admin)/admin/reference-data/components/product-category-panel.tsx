"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_CATEGORY_LABELS,
  type ProductCategory,
  type ProductCategoryBackfillReport,
  type ProductCategoryReportShade,
  type ShadeProductCategoryItem,
} from "swatchwatch-shared";
import {
  listShadesByProductCategory,
  runProductCategoryBackfill,
  setShadeProductCategory,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE_SIZE = 25;
type CategoryFilter = ProductCategory | "all";

/**
 * Admin Category control (#349): sets `product_category` with `product_category_source = 'admin'`,
 * which ingestion and the backfill never overwrite. `value` seeds the control; give it a `key`
 * per shade so another shade starts fresh.
 */
export function ProductCategorySelect({
  shadeId,
  value,
  onChanged,
}: {
  shadeId: string;
  value: ProductCategory;
  onChanged?: (category: ProductCategory, status: string) => void;
}) {
  const [current, setCurrent] = useState<ProductCategory>(value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (next: string) => {
    const category = next as ProductCategory;
    if (category === current) return;
    setPending(true);
    setError(null);
    try {
      const result = await setShadeProductCategory(shadeId, category);
      setCurrent(result.productCategory);
      onChanged?.(result.productCategory, result.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Select value={current} onValueChange={(next) => void handleChange(next)} disabled={pending}>
        <SelectTrigger className="h-8 w-[130px]" aria-label="Product category">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRODUCT_CATEGORIES.map((category) => (
            <SelectItem key={category} value={category}>
              {PRODUCT_CATEGORY_LABELS[category]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function ShadeList({ title, shades, empty }: { title: string; shades: ProductCategoryReportShade[]; empty: string }) {
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-medium">
        {title} <span className="text-muted-foreground">({shades.length})</span>
      </h4>
      {shades.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
          {shades.map((shade) => (
            <li key={shade.shadeId}>
              #{shade.shadeId} {shade.brand} — {shade.name} <span className="text-muted-foreground">({shade.status})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function downloadReport(report: ProductCategoryBackfillReport) {
  const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `product-category-${report.dryRun ? "dry-run" : "applied"}-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Backfill (dry run → apply) and a category browser with the admin override (#349, #347). */
export function ProductCategoryPanel() {
  const [report, setReport] = useState<ProductCategoryBackfillReport | null>(null);
  const [clearTopperHex, setClearTopperHex] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [filter, setFilter] = useState<CategoryFilter>("accessory");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ShadeProductCategoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // Sequence guard: a slow earlier request must not overwrite a newer search's results.
  const requestSeq = useRef(0);
  const loadList = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setListError(null);
    try {
      const response = await listShadesByProductCategory({
        categories: filter === "all" ? undefined : [filter],
        q: search,
        page,
        pageSize: PAGE_SIZE,
      });
      if (seq !== requestSeq.current) return;
      setItems(response.items);
      setTotal(response.total);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setListError(err instanceof Error ? err.message : "Failed to load shades");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [filter, search, page]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const run = async (dryRun: boolean) => {
    if (
      !dryRun &&
      !window.confirm(
        `Apply product categories to the catalog${clearTopperHex ? " and clear suspicious topper hexes" : ""}? Every change is logged and can be undone.`
      )
    ) {
      return;
    }
    setRunning(true);
    setRunError(null);
    try {
      setReport(await runProductCategoryBackfill({ dryRun, clearTopperDetectedHex: clearTopperHex }));
      if (!dryRun) void loadList();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Backfill failed");
    } finally {
      setRunning(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="space-y-6 rounded-lg border p-4" aria-labelledby="product-category-heading">
      <div className="space-y-1">
        <h3 id="product-category-heading" className="text-base font-semibold">
          Product categories
        </h3>
        <p className="text-sm text-muted-foreground">
          Color polishes, toppers, coats, treatments and accessories (#349, #347). A category set here is sticky:
          ingestion and the backfill never change it.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => void run(true)} disabled={running}>
            {running ? "Running…" : "Dry run backfill"}
          </Button>
          <Button size="sm" onClick={() => void run(false)} disabled={running || !report?.dryRun}>
            Apply
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={clearTopperHex}
              onCheckedChange={(next) => {
                setClearTopperHex(next);
                // Apply must always follow a dry run made with the same options.
                if (report?.dryRun) setReport(null);
              }}
            />
            Also clear suspicious topper hexes
          </label>
          {report && (
            <Button size="sm" variant="ghost" onClick={() => downloadReport(report)}>
              Download report
            </Button>
          )}
        </div>
        {!report?.dryRun && <p className="text-xs text-muted-foreground">Run a dry run first; Apply uses the same options.</p>}
        {runError && <p className="text-sm text-destructive">{runError}</p>}

        {report && (
          <div className="space-y-4 rounded-md bg-muted/40 p-3">
            <p className="text-sm">
              {report.dryRun ? "Dry run" : `Applied (run ${report.runId})`}: {report.scannedShades} shades,{" "}
              {report.categoryChanges.length} category changes, {report.excluded.length} to exclude,{" "}
              {report.heldAccessories.length} held accessories.
              {!report.dryRun &&
                ` Written: ${report.applied.category} categories, ${report.applied.exclude} exclusions, ${report.applied.clearDetectedHex} hexes cleared.`}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Shades</TableHead>
                  <TableHead className="text-right">Active</TableHead>
                  <TableHead className="text-right">Held</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {PRODUCT_CATEGORIES.map((category) => (
                  <TableRow key={category}>
                    <TableCell>{PRODUCT_CATEGORY_LABELS[category]}</TableCell>
                    <TableCell className="text-right">{report.byCategory[category].shades}</TableCell>
                    <TableCell className="text-right">{report.byCategory[category].active}</TableCell>
                    <TableCell className="text-right">{report.byCategory[category].held}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {report.transitions.length > 0 && (
              <p className="text-xs">
                {report.transitions.map((t) => `${t.from} → ${t.to}: ${t.shades}`).join(" · ")}
              </p>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <h4 className="text-sm font-medium">
                  Held accessories to review <span className="text-muted-foreground">({report.heldAccessories.length})</span>
                </h4>
                {report.heldAccessories.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None.</p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {report.heldAccessories.map((shade) => (
                      <li key={shade.shadeId} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          #{shade.shadeId} {shade.brand} — {shade.name}{" "}
                          <span className="text-muted-foreground">
                            ({shade.holders} {shade.holders === 1 ? "holder" : "holders"})
                          </span>
                        </span>
                        <ProductCategorySelect shadeId={shade.shadeId} value="accessory" />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <ShadeList title="Accessories to exclude (nobody holds them)" shades={report.excluded} empty="None." />
              <ShadeList title="Toppers by tag only (check these)" shades={report.topperByTagOnly} empty="None." />
              <ShadeList
                title={`Toppers with a suspicious detected hex${report.clearTopperDetectedHex ? " (cleared on apply)" : ""}`}
                shades={report.topperHexCandidates}
                empty="None."
              />
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={filter}
            onValueChange={(next) => {
              setFilter(next as CategoryFilter);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 w-[150px]" aria-label="Filter by category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {PRODUCT_CATEGORIES.map((category) => (
                <SelectItem key={category} value={category}>
                  {PRODUCT_CATEGORY_LABELS[category]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="h-8 max-w-xs"
            placeholder="Search brand or shade"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
          <span className="text-xs text-muted-foreground">{loading ? "Loading…" : `${total} shades`}</span>
        </div>
        {listError && <p className="text-sm text-destructive">{listError}</p>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Shade</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Holders</TableHead>
              <TableHead>Category</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.shadeId}>
                <TableCell className="text-sm">
                  #{item.shadeId} {item.brand} — {item.name}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{item.status}</Badge>
                </TableCell>
                <TableCell className="text-right">{item.holders}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <ProductCategorySelect
                      key={`${item.shadeId}:${item.productCategory}`}
                      shadeId={item.shadeId}
                      value={item.productCategory}
                      onChanged={(productCategory, status) =>
                        setItems((rows) =>
                          rows.map((row) =>
                            row.shadeId === item.shadeId
                              ? { ...row, productCategory, status, productCategorySource: "admin" }
                              : row
                          )
                        )
                      }
                    />
                    {item.productCategorySource === "admin" && (
                      <Badge variant="secondary" title="Set by an admin; ingestion never changes it">
                        admin
                      </Badge>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!loading && items.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                  No shades.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {pageCount > 1 && (
          <div className="flex items-center gap-2 text-sm">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <span>
              Page {page} of {pageCount}
            </span>
            <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
