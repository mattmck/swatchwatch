"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { AdminBrandListItem, AdminBrandSourceRef, BrandPlatform } from "swatchwatch-shared";
import { BRAND_PLATFORMS } from "swatchwatch-shared";
import { ApiError, createAdminBrand } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import type { BrandSortKey } from "@/lib/sources-admin-url";
import { Chip, SortableHead, relativeTime } from "./sites-table";

export const PLATFORM_LABELS: Record<BrandPlatform, string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  bigcartel: "Big Cartel",
  custom: "Custom site",
  feed: "Product feed",
  none: "None",
  unknown: "Unknown",
};

/** The own-store chip: on/off, or the permission state when it is off. */
export function StoreChip({ store }: { store: AdminBrandSourceRef }) {
  const tone = store.enabled ? "green" : store.permissionStatus === "declined" ? "red" : store.permissionStatus === "asked" ? "amber" : "neutral";
  const label = store.enabled ? "on" : store.permissionStatus === "not_asked" ? "off, not asked" : `off, ${store.permissionStatus.replace("_", " ")}`;
  return (
    <span className="inline-flex items-center gap-1">
      {store.displayName} <Chip tone={tone}>{label}</Chip>
    </span>
  );
}

const COLUMNS: Array<{ key: BrandSortKey; label: string }> = [
  { key: "brand", label: "Brand" },
  { key: "shades", label: "Shades (color / other)" },
  { key: "ownStore", label: "Own store" },
  { key: "retailers", label: "Retailers" },
  { key: "blocker", label: "Blocker / plan" },
  { key: "latestIngest", label: "Latest ingest" },
];

export function BrandsTable({
  brands,
  sort,
  dir,
  openId,
  onSort,
  onOpen,
}: {
  brands: AdminBrandListItem[];
  sort: BrandSortKey;
  dir: "asc" | "desc";
  openId: number | null;
  onSort: (key: BrandSortKey) => void;
  onOpen: (id: number) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {COLUMNS.map((c) => (
            <SortableHead key={c.key} label={c.label} active={sort === c.key} dir={dir} onClick={() => onSort(c.key)} />
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {brands.length === 0 && (
          <TableRow>
            <TableCell colSpan={COLUMNS.length} className="py-8 text-center text-muted-foreground">No brands match these filters.</TableCell>
          </TableRow>
        )}
        {brands.map((b) => (
          <TableRow
            key={b.brandId}
            data-state={openId === b.brandId ? "selected" : undefined}
            className="cursor-pointer"
            tabIndex={0}
            onClick={() => onOpen(b.brandId)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(b.brandId);
              }
            }}
          >
            <TableCell className="font-medium">{b.name}</TableCell>
            <TableCell className="tabular-nums">{b.colorShades.toLocaleString()} / {b.otherShades.toLocaleString()}</TableCell>
            <TableCell>
              {b.ownStores.length === 0 ? (
                <span className="text-muted-foreground">none</span>
              ) : (
                <div className="flex flex-col gap-1">{b.ownStores.map((s) => <StoreChip key={s.dataSourceId} store={s} />)}</div>
              )}
            </TableCell>
            <TableCell>
              {b.retailers.length === 0 ? (
                <span className="text-muted-foreground">none</span>
              ) : (
                <div className="flex flex-wrap gap-1">{b.retailers.map((r) => <Chip key={r.dataSourceId} tone="blue">{r.displayName}</Chip>)}</div>
              )}
            </TableCell>
            <TableCell>{b.profile?.blocker ?? <span className="text-muted-foreground">—</span>}</TableCell>
            <TableCell className="whitespace-nowrap">{relativeTime(b.latestIngestAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function AddBrandDialog({
  open,
  onOpenChange,
  onCreated,
  onOpenExisting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (brand: AdminBrandListItem) => void;
  onOpenExisting: (brandId: number) => void;
}) {
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [platform, setPlatform] = useState<BrandPlatform | "">("");
  const [blocker, setBlocker] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<number | null>(null);

  const reset = () => {
    setName("");
    setWebsite("");
    setPlatform("");
    setBlocker("");
    setError(null);
    setExistingId(null);
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    setExistingId(null);
    try {
      const profile = {
        ...(website.trim() ? { websiteUrl: website.trim() } : {}),
        ...(platform ? { platform } : {}),
        ...(blocker.trim() ? { blocker: blocker.trim() } : {}),
      };
      const res = await createAdminBrand({ name: name.trim(), ...(Object.keys(profile).length > 0 ? { profile } : {}) });
      toast.success(`Added ${res.brand.name}`);
      onCreated(res.brand);
      reset();
      onOpenChange(false);
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { code?: string; brandId?: number } | undefined) : undefined;
      if (err instanceof ApiError && err.status === 409 && body?.code === "brand_exists" && typeof body.brandId === "number") {
        setError("Already exists");
        setExistingId(body.brandId);
      } else {
        setError(err instanceof Error ? err.message : "Could not add the brand.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add brand</DialogTitle>
          <DialogDescription>Adds a brand to track before any of its shades are ingested.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <label className="block space-y-1">
            <span className="text-muted-foreground">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block space-y-1">
            <span className="text-muted-foreground">Website (optional)</span>
            <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" />
          </label>
          <div className="space-y-1">
            <span className="text-muted-foreground">Platform (optional)</span>
            <Select value={platform || "unset"} onValueChange={(v) => setPlatform(v === "unset" ? "" : (v as BrandPlatform))}>
              <SelectTrigger aria-label="Platform"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unset">Not set</SelectItem>
                {BRAND_PLATFORMS.map((p) => <SelectItem key={p} value={p}>{PLATFORM_LABELS[p]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <label className="block space-y-1">
            <span className="text-muted-foreground">Blocker (optional)</span>
            <Input value={blocker} onChange={(e) => setBlocker(e.target.value)} />
          </label>
          {error && (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-destructive">
              {error}
              {existingId !== null && (
                <Button type="button" variant="outline" size="sm" onClick={() => { onOpenExisting(existingId); reset(); onOpenChange(false); }}>
                  Open it
                </Button>
              )}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={saving || name.trim().length === 0} onClick={submit}>{saving ? "Adding…" : "Add brand"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
