"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  SOURCE_PERMISSION_STATUSES,
  type AdminBrandListItem,
  type AdminSourceKind,
  type AdminSourceListItem,
  type BrandSupply,
  type SourcePermissionStatus,
} from "swatchwatch-shared";
import { BrandSpinner } from "@/components/brand-spinner";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listAdminBrands, listAdminSources } from "@/lib/api";
import { filterBrands, filterSites, sortBrands, sortSites } from "@/lib/sources-admin-view";
import {
  buildSourcesAdminSearch,
  defaultSortFor,
  parseSourcesAdminState,
  type BrandSortKey,
  type SiteSortKey,
  type SourcesAdminState,
  type SourcesAdminView,
} from "@/lib/sources-admin-url";
import { cn } from "@/lib/utils";
import { AddBrandDialog, BrandsTable } from "./brands-table";
import { BrandPanel } from "./brand-panel";
import { SitePanel } from "./site-panel";
import { SitesTable, KIND_LABELS } from "./sites-table";

function Chips<T extends string>({
  label,
  options,
  isOn,
  onToggle,
}: {
  label: string;
  options: Array<{ value: T | null; text: string }>;
  isOn: (value: T | null) => boolean;
  onToggle: (value: T | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      <span className="text-xs text-muted-foreground">{label}:</span>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={isOn(o.value)}
          onClick={() => onToggle(o.value)}
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-xs",
            isOn(o.value) ? "border-primary bg-primary/15 font-medium" : "hover:bg-muted"
          )}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

const PERMISSION_TEXT: Record<SourcePermissionStatus, string> = {
  not_needed: "Not needed",
  not_asked: "Not asked",
  asked: "Asked",
  granted: "Granted",
  declined: "Declined",
};

export function SourcesTab() {
  const searchParams = useSearchParams();
  const state = parseSourcesAdminState(searchParams);

  const [sources, setSources] = useState<AdminSourceListItem[] | null>(null);
  const [brands, setBrands] = useState<AdminBrandListItem[] | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [brandsError, setBrandsError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const fetchSources = useCallback(() => {
    listAdminSources()
      .then((r) => setSources(r.sources))
      .catch((e) => setSourcesError(e instanceof Error ? e.message : "Could not load sites."));
  }, []);
  // Only the latest brands response (or a local create) may land; older ones are dropped.
  const brandsRequest = useRef(0);
  const sourcesRef = useRef<AdminSourceListItem[] | null>(null);
  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);
  const fetchBrands = useCallback((quiet = false) => {
    const id = ++brandsRequest.current;
    listAdminBrands()
      .then((r) => { if (id === brandsRequest.current) setBrands(r.brands); })
      .catch((e) => {
        if (!quiet && id === brandsRequest.current) setBrandsError(e instanceof Error ? e.message : "Could not load brands.");
      });
  }, []);
  const retrySources = () => {
    setSourcesError(null);
    setSources(null);
    fetchSources();
  };
  const retryBrands = () => {
    setBrandsError(null);
    setBrands(null);
    fetchBrands();
  };

  useEffect(() => {
    fetchSources();
    fetchBrands();
  }, [fetchSources, fetchBrands]);

  const update = (patch: Partial<SourcesAdminState>) => {
    const next: SourcesAdminState = { ...parseSourcesAdminState(new URLSearchParams(window.location.search)), ...patch };
    window.history.replaceState(null, "", buildSourcesAdminSearch(window.location.search, next));
  };

  const setView = (view: SourcesAdminView) => {
    if (view === state.view) return;
    // Filters and sort belong to one view; start the other one clean.
    update({ view, sort: defaultSortFor(view), dir: "asc", kind: null, enabled: null, permission: [], supply: null, q: "", open: null });
  };

  const sort = (key: SiteSortKey | BrandSortKey) =>
    update(state.sort === key ? { dir: state.dir === "asc" ? "desc" : "asc" } : { sort: key, dir: "asc" });

  const visibleSites = useMemo(
    () => (sources ? sortSites(filterSites(sources, state), state.sort as SiteSortKey, state.dir) : []),
    [sources, state]
  );
  const visibleBrands = useMemo(
    () => (brands ? sortBrands(filterBrands(brands, state), state.sort as BrandSortKey, state.dir) : []),
    [brands, state]
  );

  const replaceSource = useCallback((next: AdminSourceListItem) => {
    setSources((prev) => prev && prev.map((s) => (s.dataSourceId === next.dataSourceId ? next : s)));
    // Own-store and retailer chips depend on on/off and permission only; polling ticks change neither.
    const prev = sourcesRef.current?.find((s) => s.dataSourceId === next.dataSourceId);
    if (!prev || prev.enabled !== next.enabled || prev.permission.status !== next.permission.status) fetchBrands(true);
  }, [fetchBrands]);
  const replaceBrand = useCallback((next: AdminBrandListItem) => {
    setBrands((prev) => prev && prev.map((b) => (b.brandId === next.brandId ? next : b)));
  }, []);

  const toggleKind = (kind: AdminSourceKind | null) => update({ kind });
  const togglePermission = (status: SourcePermissionStatus | null) => {
    if (status === null) return update({ permission: [] });
    update({ permission: state.permission.includes(status) ? state.permission.filter((s) => s !== status) : [...state.permission, status] });
  };

  const isSites = state.view === "sites";
  const error = isSites ? sourcesError : brandsError;
  const loaded = isSites ? sources !== null : brands !== null;
  const openSite = sources?.find((s) => s.dataSourceId === state.open) ?? null;
  const openBrand = brands?.find((b) => b.brandId === state.open) ?? null;

  return (
    <div className="space-y-4">
      <div className="inline-flex overflow-hidden rounded-lg border text-sm" role="group" aria-label="View">
        {(["sites", "brands"] as const).map((v) => {
          const count = v === "sites" ? sources?.length : brands?.length;
          return (
            <button
              key={v}
              type="button"
              aria-pressed={state.view === v}
              onClick={() => setView(v)}
              className={cn("px-4 py-1.5", state.view === v ? "bg-primary/15 font-semibold" : "hover:bg-muted")}
            >
              {v === "sites" ? "Sites" : "Brands"}{count !== undefined ? ` (${count})` : ""}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="w-full sm:w-56"
          aria-label={isSites ? "Search sites" : "Search brands"}
          placeholder={isSites ? "Search name or URL…" : "Search brand…"}
          value={state.q}
          onChange={(e) => update({ q: e.target.value })}
        />
        {isSites ? (
          <>
            <Chips<AdminSourceKind>
              label="Kind"
              options={[{ value: null, text: "All" }, ...(["brand", "retailer", "feed"] as const).map((k) => ({ value: k, text: KIND_LABELS[k] }))]}
              isOn={(v) => state.kind === v}
              onToggle={toggleKind}
            />
            <Chips<"on" | "off">
              label="Enabled"
              options={[{ value: null, text: "Any" }, { value: "on", text: "On" }, { value: "off", text: "Off" }]}
              isOn={(v) => state.enabled === v}
              onToggle={(enabled) => update({ enabled })}
            />
            <Chips<SourcePermissionStatus>
              label="Permission"
              options={[{ value: null, text: "Any" }, ...SOURCE_PERMISSION_STATUSES.map((s) => ({ value: s, text: PERMISSION_TEXT[s] }))]}
              isOn={(v) => (v === null ? state.permission.length === 0 : state.permission.includes(v))}
              onToggle={togglePermission}
            />
          </>
        ) : (
          <>
            <Chips<BrandSupply>
              label="Supplied by"
              options={[
                { value: null, text: "All" },
                { value: "own", text: "Own store" },
                { value: "retailer", text: "Retailer only" },
                { value: "both", text: "Both" },
                { value: "none", text: "No source" },
              ]}
              isOn={(v) => state.supply === v}
              onToggle={(supply) => update({ supply })}
            />
            <Button className="sm:ml-auto" variant="outline" size="sm" onClick={() => setAddOpen(true)}>+ Add brand</Button>
          </>
        )}
      </div>

      {error ? (
        <ErrorState title={isSites ? "Could not load sites" : "Could not load brands"} message={error} onRetry={isSites ? retrySources : retryBrands} className="min-h-[200px]" />
      ) : !loaded ? (
        <BrandSpinner label={isSites ? "Loading sites…" : "Loading brands…"} />
      ) : (
        <div className="flex flex-col items-start gap-4 lg:flex-row">
          <div className="w-full min-w-0 flex-1 overflow-x-auto">
            {isSites ? (
              <SitesTable sites={visibleSites} sort={state.sort as SiteSortKey} dir={state.dir} openId={state.open} onSort={sort} onOpen={(open) => update({ open })} />
            ) : (
              <BrandsTable brands={visibleBrands} sort={state.sort as BrandSortKey} dir={state.dir} openId={state.open} onSort={sort} onOpen={(open) => update({ open })} />
            )}
          </div>
          {isSites && openSite && (
            <SitePanel key={openSite.dataSourceId} source={openSite} onClose={() => update({ open: null })} onChange={replaceSource} />
          )}
          {!isSites && openBrand && (
            <BrandPanel
              key={openBrand.brandId}
              brand={openBrand}
              sources={sources ?? []}
              onClose={() => update({ open: null })}
              onChange={replaceBrand}
              onOpenSite={(open) => update({ view: "sites", sort: "site", dir: "asc", kind: null, enabled: null, permission: [], supply: null, q: "", open })}
            />
          )}
        </div>
      )}

      <AddBrandDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(brand) => {
          brandsRequest.current++;
          setBrands((prev) => (prev ? [...prev, brand] : prev));
          update({ open: brand.brandId });
        }}
        onOpenExisting={(open) => update({ q: "", supply: null, open })}
      />
    </div>
  );
}
