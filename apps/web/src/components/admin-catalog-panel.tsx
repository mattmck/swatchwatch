"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, Loader2, PackageX } from "lucide-react";
import { toast } from "sonner";
import {
  PRODUCT_CATEGORIES,
  PRODUCT_CATEGORY_LABELS,
  resolveProductCategory,
  type ProductCategory,
  type ShadeSourceProduct,
} from "swatchwatch-shared";
import { getShadeSourceProducts, setShadeProductCategory } from "@/lib/api";
import { AdminOnly } from "@/components/admin-hex-sip-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Admin row action for list views: one tap marks the polish's shade as an accessory (sticky admin
 * override; the API hides it from the catalog when nobody holds it). Renders nothing once the row
 * is an accessory. The caller only renders it for admins.
 */
export function MarkAccessoryButton({
  shadeId,
  productCategory,
  disabled,
  compact = false,
  onMarked,
}: {
  shadeId: string;
  productCategory: unknown;
  disabled?: boolean;
  /** Icon only (the desktop table's narrow Admin column). */
  compact?: boolean;
  onMarked: (category: ProductCategory) => void;
}) {
  const [saving, setSaving] = useState(false);
  if (resolveProductCategory(productCategory) === "accessory") return null;

  async function mark() {
    setSaving(true);
    try {
      const result = await setShadeProductCategory(shadeId, "accessory");
      onMarked(result.productCategory);
      toast.success("Marked as an accessory.");
    } catch (error) {
      toast.error(errorMessage(error, "Could not change the category"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Button
      type="button"
      size={compact ? "icon-xs" : "xs"}
      variant="outline"
      disabled={disabled || saving}
      onClick={mark}
      title="Mark as accessory (not a polish)"
      aria-label={compact ? "Mark as accessory" : undefined}
    >
      {saving ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <PackageX className="size-3" aria-hidden />}
      {!compact && "Accessory"}
    </Button>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * Admin-only catalog tools for the polish detail page: set the shade's product category (sticky
 * admin override, `PUT /api/shades-admin/{id}/product-category`, with a one-tap "Mark as
 * accessory") and inspect every vendor listing behind the shade with its raw and normalized JSON
 * (`GET /api/shades-admin/{id}/source-products`). Non-admins never mount it.
 */
export function AdminCatalogSection(props: AdminCatalogPanelProps) {
  return (
    <AdminOnly>
      <AdminCatalogPanel {...props} />
    </AdminOnly>
  );
}

interface AdminCatalogPanelProps {
  shadeId: string;
  productCategory: unknown;
  onCategoryChange: (category: ProductCategory) => void;
}

function AdminCatalogPanel({ shadeId, productCategory, onCategoryChange }: AdminCatalogPanelProps) {
  const category = resolveProductCategory(productCategory);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  async function changeCategory(next: ProductCategory) {
    if (next === category || saving) return;
    setSaving(true);
    try {
      const result = await setShadeProductCategory(shadeId, next);
      onCategoryChange(result.productCategory);
      const hidden = result.status === "excluded" ? " Hidden from the catalog (nobody holds it)." : "";
      toast.success(`Category set to ${PRODUCT_CATEGORY_LABELS[result.productCategory]}.${hidden}`);
    } catch (error) {
      toast.error(errorMessage(error, "Could not change the category"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="admin-catalog-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Catalog data <Badge variant="outline">Admin</Badge>
        </CardTitle>
        <CardDescription>
          A category you set here is sticky: ingestion and the category backfill never change it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`admin-category-${shadeId}`} className="text-sm font-medium">
            Category
          </label>
          <Select value={category} onValueChange={(value) => changeCategory(value as ProductCategory)} disabled={saving}>
            <SelectTrigger id={`admin-category-${shadeId}`} size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRODUCT_CATEGORIES.map((value) => (
                <SelectItem key={value} value={value}>
                  {PRODUCT_CATEGORY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {category !== "accessory" && (
            <Button variant="outline" size="sm" disabled={saving} onClick={() => changeCategory("accessory")}>
              Mark as accessory
            </Button>
          )}
        </div>

        <div>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            Vendor listings and source JSON
          </Button>
          {open && <SourceProducts shadeId={shadeId} />}
        </div>
      </CardContent>
    </Card>
  );
}

function SourceProducts({ shadeId }: { shadeId: string }) {
  // Keyed by shade, so a stale response never shows and "loading" is derived.
  const [result, setResult] = useState<{ shadeId: string; products: ShadeSourceProduct[] | null; error: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getShadeSourceProducts(shadeId)
      .then((response) => {
        if (!cancelled) setResult({ shadeId, products: response.products, error: null });
      })
      .catch((error) => {
        if (!cancelled) setResult({ shadeId, products: null, error: errorMessage(error, "Could not load the listings") });
      });
    return () => {
      cancelled = true;
    };
  }, [shadeId]);

  if (!result || result.shadeId !== shadeId) {
    return <p className="mt-2 text-sm text-muted-foreground">Loading listings…</p>;
  }
  if (result.error) return <p className="mt-2 text-sm text-destructive">{result.error}</p>;
  const products = result.products ?? [];
  if (products.length === 0) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        No vendor listing is linked to this shade (a user submission, or ingested before listings were recorded).
      </p>
    );
  }
  return (
    <ul className="mt-2 space-y-3">
      {products.map((product) => (
        <SourceProductItem key={product.externalProductId} product={product} />
      ))}
    </ul>
  );
}

function SourceProductItem({ product }: { product: ShadeSourceProduct }) {
  const [view, setView] = useState<"raw" | "normalized" | null>(null);
  const [copied, setCopied] = useState(false);
  const json = view === "raw" ? product.rawJson : view === "normalized" ? product.normalizedJson : null;
  const text = view ? JSON.stringify(json, null, 2) : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy");
    }
  }

  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">{product.source}</span>
        {!product.sourceEnabled && <Badge variant="outline">source disabled</Badge>}
        <span className="font-mono text-xs text-muted-foreground">id {product.externalId}</span>
        {product.gtin && <span className="font-mono text-xs text-muted-foreground">GTIN {product.gtin}</span>}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Fetched {formatDate(product.fetchedAt)} · last seen {formatDate(product.lastSeenAt)}
      </p>
      {product.productUrl && (
        <a
          href={product.productUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="mt-1 inline-flex max-w-full items-center gap-1 break-all text-xs text-primary underline-offset-2 hover:underline"
        >
          <ExternalLink className="size-3 shrink-0" aria-hidden />
          {product.productUrl}
        </a>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant={view === "raw" ? "default" : "outline"}
          size="xs"
          aria-pressed={view === "raw"}
          onClick={() => setView(view === "raw" ? null : "raw")}
        >
          Raw JSON
        </Button>
        <Button
          variant={view === "normalized" ? "default" : "outline"}
          size="xs"
          aria-pressed={view === "normalized"}
          onClick={() => setView(view === "normalized" ? null : "normalized")}
        >
          Normalized JSON
        </Button>
        {view && (
          <Button variant="ghost" size="xs" onClick={copy}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
      </div>
      {view && (
        <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">{text}</pre>
      )}
    </li>
  );
}
