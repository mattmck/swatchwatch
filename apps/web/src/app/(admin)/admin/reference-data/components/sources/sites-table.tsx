"use client";

import { AlertTriangle, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import type { AdminSourceKind, AdminSourceLastJob, AdminSourceListItem, SourcePermission } from "swatchwatch-shared";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { SiteSortKey } from "@/lib/sources-admin-url";

export const KIND_LABELS: Record<AdminSourceKind, string> = {
  brand: "Brand store",
  retailer: "Retailer",
  feed: "Feed",
};

export const CONNECTOR_LABELS: Record<string, string> = {
  HoloTaco: "Holo Taco",
  Shopify: "Shopify",
  OpenBeautyFacts: "OpenBeautyFacts",
  MakeupAPI: "MakeupAPI",
  GS1: "GS1",
  ProductFeed: "Product feed",
  SitemapJsonLd: "Sitemap + JSON-LD",
  WooCommerce: "WooCommerce",
  BigCartel: "Big Cartel",
  Custom: "Custom",
};

/** `2026-11-08` -> `11-08`. */
export function shortDate(value: string | undefined): string {
  return value && value.length >= 10 ? value.slice(5, 10) : (value ?? "");
}

/** Local today as `YYYY-MM-DD`, the format permission dates use. */
export function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const minutes = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const CHIP_TONE = {
  neutral: "bg-muted text-muted-foreground",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  green: "bg-green-600/15 text-green-700 dark:text-green-400",
  red: "bg-red-600/15 text-red-700 dark:text-red-400",
  blue: "bg-blue-600/15 text-blue-700 dark:text-blue-400",
} as const;

export function Chip({ tone, children, className }: { tone: keyof typeof CHIP_TONE; children: React.ReactNode; className?: string }) {
  return <Badge variant="outline" className={cn("border-transparent", CHIP_TONE[tone], className)}>{children}</Badge>;
}

export function PermissionChip({ permission }: { permission: SourcePermission }) {
  switch (permission.status) {
    case "not_needed":
      return <Chip tone="neutral">Not needed</Chip>;
    case "not_asked":
      return <Chip tone="neutral">Not asked</Chip>;
    case "asked":
      return <Chip tone="amber">Asked {shortDate(permission.askedAt)}</Chip>;
    case "granted":
      return <Chip tone="green">Granted</Chip>;
    case "declined":
      return <Chip tone="red">Declined</Chip>;
  }
}

export function LastJob({ job }: { job: AdminSourceLastJob | null }) {
  if (!job) return <span className="text-muted-foreground">never</span>;
  const icon =
    job.status === "succeeded" ? <CheckCircle2 className="size-3.5 text-green-600" aria-label="Succeeded" />
    : job.status === "failed" || job.status === "cancelled" ? <XCircle className="size-3.5 text-red-600" aria-label={job.status} />
    : job.status === "running" ? <Loader2 className="size-3.5 animate-spin text-blue-600" aria-label="Running" />
    : <Clock className="size-3.5 text-amber-600" aria-label="Queued" />;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {icon}
      {relativeTime(job.startedAt)}
      {job.recordsProcessed !== null && <span className="text-muted-foreground">· {job.recordsProcessed.toLocaleString()}</span>}
    </span>
  );
}

function host(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const COLUMNS: Array<{ key: SiteSortKey; label: string; numeric?: boolean }> = [
  { key: "site", label: "Site" },
  { key: "kind", label: "Kind" },
  { key: "connector", label: "Connector" },
  { key: "enabled", label: "On" },
  { key: "permission", label: "Permission" },
  { key: "lastJob", label: "Last job" },
  { key: "listings", label: "Listings", numeric: true },
  { key: "shades", label: "Shades", numeric: true },
];

export function SortableHead({
  label,
  active,
  dir,
  onClick,
  numeric,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  numeric?: boolean;
}) {
  return (
    <TableHead aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"} className={numeric ? "text-right" : undefined}>
      <button type="button" onClick={onClick} className="inline-flex items-center gap-1 font-medium hover:text-foreground">
        {label}
        <span aria-hidden className="text-xs">{active ? (dir === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </TableHead>
  );
}

export function SitesTable({
  sites,
  sort,
  dir,
  openId,
  onSort,
  onOpen,
}: {
  sites: AdminSourceListItem[];
  sort: SiteSortKey;
  dir: "asc" | "desc";
  openId: number | null;
  onSort: (key: SiteSortKey) => void;
  onOpen: (id: number) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {COLUMNS.map((c) => (
            <SortableHead key={c.key} label={c.label} numeric={c.numeric} active={sort === c.key} dir={dir} onClick={() => onSort(c.key)} />
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sites.length === 0 && (
          <TableRow>
            <TableCell colSpan={COLUMNS.length} className="py-8 text-center text-muted-foreground">No sites match these filters.</TableCell>
          </TableRow>
        )}
        {sites.map((s) => (
          <TableRow
            key={s.dataSourceId}
            data-state={openId === s.dataSourceId ? "selected" : undefined}
            className="cursor-pointer"
            tabIndex={0}
            onClick={() => onOpen(s.dataSourceId)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(s.dataSourceId);
              }
            }}
          >
            <TableCell>
              <div className="font-medium">{s.displayName}</div>
              <div className="text-xs text-muted-foreground">{host(s.baseUrl)}</div>
            </TableCell>
            <TableCell>{s.kind === "brand" ? KIND_LABELS.brand : <Chip tone="blue">{KIND_LABELS[s.kind]}</Chip>}</TableCell>
            <TableCell>{CONNECTOR_LABELS[s.connector] ?? s.connector}</TableCell>
            <TableCell>{s.fetchable ? (s.enabled ? "✓" : "–") : <span className="text-muted-foreground">n/a</span>}</TableCell>
            <TableCell>
              <div className="flex flex-wrap items-center gap-1">
                <PermissionChip permission={s.permission} />
                {s.permission.status === "granted" && !s.imagesPermitted && <span className="text-xs text-muted-foreground">no images</span>}
                {s.onWithoutOk && (
                  <Chip tone="amber"><AlertTriangle aria-hidden />On, no OK recorded</Chip>
                )}
              </div>
            </TableCell>
            <TableCell><LastJob job={s.lastJob} /></TableCell>
            <TableCell className="text-right tabular-nums">{s.liveListings.toLocaleString()}</TableCell>
            <TableCell className="text-right tabular-nums">{s.shades.toLocaleString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
