"use client";

import { useState } from "react";
import { Download, FileJson, FileSpreadsheet, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { CollectionExportFormat } from "swatchwatch-shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { exportCollection } from "@/lib/api";
import { saveBlobAsFile } from "@/lib/collection-export";

/**
 * "Export" menu for `/polishes` (issue #264): downloads the caller's whole collection (every
 * inventory status) as CSV or JSON through the authenticated API, then saves the Blob.
 */
export function CollectionExportMenu() {
  const [pending, setPending] = useState<CollectionExportFormat | null>(null);

  async function handleExport(format: CollectionExportFormat) {
    if (pending) return;
    setPending(format);
    try {
      const { blob, filename } = await exportCollection(format);
      saveBlobAsFile(blob, filename);
      toast.success(`Exported your collection as ${format.toUpperCase()}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    } finally {
      setPending(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={pending !== null} aria-label="Export collection">
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Export collection</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handleExport("csv")}>
          <FileSpreadsheet className="size-4" />
          CSV (spreadsheet)
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void handleExport("json")}>
          <FileJson className="size-4" />
          JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
