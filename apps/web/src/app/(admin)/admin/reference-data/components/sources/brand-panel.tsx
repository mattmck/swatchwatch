"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import {
  BRAND_BLOCKER_PRESETS,
  BRAND_PLATFORMS,
  type AdminBrandListItem,
  type AdminBrandSourceRef,
  type AdminSourceListItem,
  type BrandPlatform,
} from "swatchwatch-shared";
import { updateAdminBrandProfile } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PLATFORM_LABELS, StoreChip } from "./brands-table";
import { Chip } from "./sites-table";

function SourceLink({ source, onOpenSite }: { source: AdminBrandSourceRef; onOpenSite: (id: number) => void }) {
  return (
    <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onOpenSite(source.dataSourceId)}>
      <StoreChip store={source} />
    </button>
  );
}

/** Edit form for one brand's ingest profile. Remount (key = brand id) when another brand opens. */
export function BrandPanel({
  brand,
  sources,
  onClose,
  onChange,
  onOpenSite,
}: {
  brand: AdminBrandListItem;
  sources: AdminSourceListItem[];
  onClose: () => void;
  onChange: (brand: AdminBrandListItem) => void;
  onOpenSite: (id: number) => void;
}) {
  const profile = brand.profile;
  const [website, setWebsite] = useState(profile?.websiteUrl ?? "");
  const [platform, setPlatform] = useState<BrandPlatform | "">(profile?.platform ?? "");
  const [blocker, setBlocker] = useState(profile?.blocker ?? "");
  const [notes, setNotes] = useState(profile?.notes ?? "");
  const [ownId, setOwnId] = useState<string>(profile?.ownDataSourceId ? String(profile.ownDataSourceId) : "none");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the saved link selectable even when it points outside the brand-store list.
  const brandStores = sources.filter(
    (s) => (s.kind === "brand" && s.fetchable) || s.dataSourceId === profile?.ownDataSourceId
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await updateAdminBrandProfile(brand.brandId, {
        websiteUrl: website.trim() || null,
        platform: platform || null,
        blocker: blocker.trim() || null,
        notes: notes.trim() || null,
        ownDataSourceId: ownId === "none" ? null : Number(ownId),
      });
      onChange(res.brand);
      toast.success(`Saved ${brand.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the profile.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside aria-label={`${brand.name} profile`} className="w-full shrink-0 space-y-4 rounded-lg border p-4 text-sm lg:w-80">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">{brand.name}</h3>
          <p className="text-muted-foreground">{brand.colorShades.toLocaleString()} color / {brand.otherShades.toLocaleString()} other shades</p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close panel" onClick={onClose}><X /></Button>
      </div>

      <label className="block space-y-1">
        <span className="text-muted-foreground">Website</span>
        <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" />
      </label>
      <div className="space-y-1">
        <span className="text-muted-foreground">Platform</span>
        <Select value={platform || "unset"} onValueChange={(v) => setPlatform(v === "unset" ? "" : (v as BrandPlatform))}>
          <SelectTrigger aria-label="Platform"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="unset">Not set</SelectItem>
            {BRAND_PLATFORMS.map((p) => <SelectItem key={p} value={p}>{PLATFORM_LABELS[p]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <span className="text-muted-foreground">Blocker</span>
        <div className="flex flex-wrap gap-1">
          {BRAND_BLOCKER_PRESETS.map((preset) => (
            <Button key={preset} type="button" size="sm" variant={blocker === preset ? "default" : "outline"} className="h-auto whitespace-normal py-1 text-left text-xs" onClick={() => setBlocker(preset)}>
              {preset}
            </Button>
          ))}
        </div>
        <Input value={blocker} onChange={(e) => setBlocker(e.target.value)} aria-label="Blocker" />
      </div>
      <label className="block space-y-1">
        <span className="text-muted-foreground">Notes</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </label>
      <div className="space-y-1">
        <span className="text-muted-foreground">Own store</span>
        <Select value={ownId} onValueChange={setOwnId}>
          <SelectTrigger aria-label="Own store"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            {brandStores.map((s) => <SelectItem key={s.dataSourceId} value={String(s.dataSourceId)}>{s.displayName}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {error && <p role="alert" className="text-destructive">{error}</p>}
      <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>

      <div className="space-y-2 border-t pt-3">
        <div>
          <p className="font-medium">Own stores</p>
          {brand.ownStores.length === 0 ? <p className="text-muted-foreground">none</p> : (
            <div className="flex flex-col gap-1">{brand.ownStores.map((s) => <SourceLink key={s.dataSourceId} source={s} onOpenSite={onOpenSite} />)}</div>
          )}
        </div>
        <div>
          <p className="font-medium">Retailers</p>
          {brand.retailers.length === 0 ? <p className="text-muted-foreground">none</p> : (
            <div className="flex flex-col gap-1">
              {brand.retailers.map((s) => (
                <button key={s.dataSourceId} type="button" className="w-fit text-left" onClick={() => onOpenSite(s.dataSourceId)}>
                  <Chip tone="blue">{s.displayName}</Chip>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
