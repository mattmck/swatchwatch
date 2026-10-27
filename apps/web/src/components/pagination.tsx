"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { buildPageNumbers, pageRange } from "@/lib/pagination";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}

const PAGE_SIZES = [10, 25, 50, 100];

/**
 * Previous / page numbers / Next, with the item range and rows-per-page as secondary controls.
 * Desktop shows at most 7 page slots (first, last, current ±1, ellipses). Phones get one line:
 * ‹ [Page 14 of 64 ▾] › where the middle is a jump-to-page picker, with 40px touch targets.
 */
export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  const { start, end } = pageRange(currentPage, pageSize, totalItems);
  const noun = totalItems === 1 ? "polish" : "polishes";
  const summary =
    totalPages <= 1 ? (
      <>
        {totalItems.toLocaleString()} {noun}
      </>
    ) : (
      <>
        {start.toLocaleString()}&ndash;{end.toLocaleString()} of {totalItems.toLocaleString()} {noun}
      </>
    );

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
    >
      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 sm:order-2 sm:justify-center">
          <Button
            variant="outline"
            className="size-10 px-0 sm:h-8 sm:w-auto sm:px-2.5"
            disabled={currentPage <= 1}
            onClick={() => onPageChange(currentPage - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft aria-hidden />
            <span className="hidden sm:inline">Previous</span>
          </Button>

          {/* Phones: one jump-to-page picker instead of a row of numbers. */}
          <div className="flex-1 sm:hidden">
            <Select value={currentPage.toString()} onValueChange={(v) => onPageChange(parseInt(v, 10))}>
              <SelectTrigger aria-label="Go to page" className="w-full justify-center gap-1 data-[size=default]:h-10">
                <SelectValue>
                  Page {currentPage} of {totalPages}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <SelectItem key={p} value={p.toString()}>
                    Page {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ol className="hidden items-center gap-1 sm:flex">
            {buildPageNumbers(currentPage, totalPages).map((slot, i) =>
              slot === "ellipsis" ? (
                <li key={`ellipsis-${i}`} aria-hidden className="w-6 text-center text-muted-foreground">
                  …
                </li>
              ) : (
                <li key={slot}>
                  <Button
                    variant={slot === currentPage ? "default" : "ghost"}
                    size="sm"
                    className="min-w-8 px-2 tabular-nums"
                    aria-label={`Page ${slot}`}
                    aria-current={slot === currentPage ? "page" : undefined}
                    onClick={() => onPageChange(slot)}
                  >
                    {slot}
                  </Button>
                </li>
              )
            )}
          </ol>

          <Button
            variant="outline"
            className="size-10 px-0 sm:h-8 sm:w-auto sm:px-2.5"
            disabled={currentPage >= totalPages}
            onClick={() => onPageChange(currentPage + 1)}
            aria-label="Next page"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight aria-hidden />
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 sm:contents">
        <span className="text-sm text-muted-foreground tabular-nums sm:order-1" aria-live="polite">
          {summary}
        </span>
        {onPageSizeChange && (
          <div className="flex items-center gap-2 sm:order-3">
            <label htmlFor="page-size" className="text-sm text-muted-foreground">
              Show
            </label>
            <Select value={pageSize.toString()} onValueChange={(v) => onPageSizeChange(parseInt(v, 10))}>
              <SelectTrigger id="page-size" size="sm" className="w-[4.5rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((size) => (
                  <SelectItem key={size} value={size.toString()}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
    </nav>
  );
}
