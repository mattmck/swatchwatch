"use client";

import type { PolishStatus } from "swatchwatch-shared";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleChip } from "@/components/toggle-chip";
import { POLISH_STATUS_LABELS, POLISH_STATUS_OPTIONS } from "@/lib/inventory-status";
import {
  statusFilterSummary,
  statusPresetFor,
  statusesForPreset,
  toggleStatus,
  type StatusPreset,
} from "@/lib/polish-list-url";

const PRESETS: Array<{ value: Exclude<StatusPreset, "custom">; label: string }> = [
  { value: "all", label: "All" },
  { value: "collection", label: "My Collection" },
  { value: "wishlist", label: "Wishlist" },
];

interface StatusFilterProps {
  statuses: PolishStatus[];
  untried: boolean;
  onStatusesChange: (statuses: PolishStatus[]) => void;
  onUntriedChange: (untried: boolean) => void;
}

/**
 * Ownership filters for the `/polishes` table (issue #262): All / My Collection / Wishlist
 * presets, a multi-select status menu for any combination (e.g. Destash + Archived), and an
 * "Untried" toggle (owned, never tried). The presets are shortcuts for the status list, so
 * there is one source of truth (`status=` in the URL).
 */
export function StatusFilter({ statuses, untried, onStatusesChange, onUntriedChange }: StatusFilterProps) {
  const preset = statusPresetFor(statuses);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Show" className="flex rounded-lg border bg-muted p-1">
        {PRESETS.map((option) => (
          <Button
            key={option.value}
            type="button"
            variant={preset === option.value ? "default" : "ghost"}
            size="sm"
            aria-pressed={preset === option.value}
            onClick={() => onStatusesChange(statusesForPreset(option.value))}
          >
            {option.label}
          </Button>
        ))}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={preset === "custom" ? "secondary" : "outline"}
            size="sm"
            className="h-8"
            aria-label={`Filter by status: ${statusFilterSummary(statuses, POLISH_STATUS_LABELS)}`}
          >
            {statusFilterSummary(statuses, POLISH_STATUS_LABELS)}
            <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuLabel>Status</DropdownMenuLabel>
          {POLISH_STATUS_OPTIONS.map((status) => (
            <DropdownMenuCheckboxItem
              key={status}
              checked={statuses.includes(status)}
              // Keep the menu open so several statuses can be ticked in one go.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => onStatusesChange(toggleStatus(statuses, status, checked === true))}
            >
              {POLISH_STATUS_LABELS[status]}
            </DropdownMenuCheckboxItem>
          ))}
          {statuses.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onStatusesChange([])}>Any status</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ToggleChip
        pressed={untried}
        onPressedChange={onUntriedChange}
        className="h-8"
        title="Owned polishes you have never tried"
      >
        Untried
      </ToggleChip>
    </div>
  );
}
