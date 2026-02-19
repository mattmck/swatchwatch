"use client";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  if (totalPages <= 1) {
    return (
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {totalItems} {totalItems === 1 ? "polish" : "polishes"}
        </span>
        {onPageSizeChange && (
          <PageSizeSelector pageSize={pageSize} onPageSizeChange={onPageSizeChange} />
        )}
      </div>
    );
  }

  const pages = buildPageNumbers(currentPage, totalPages);
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);

  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-muted-foreground">
        {start}&ndash;{end} of {totalItems}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(1)}
          title="First page"
        >
          «
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(Math.max(1, currentPage - 5))}
          title="Back 5 pages"
        >
          ‹‹
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
        >
          Prev
        </Button>
        {pages.map((p, i) =>
          p === "..." ? (
            <span key={`ellipsis-${i}`} className="px-1 text-muted-foreground">
              ...
            </span>
          ) : (
            <Button
              key={p}
              variant={p === currentPage ? "default" : "outline"}
              size="sm"
              onClick={() => onPageChange(p as number)}
            >
              {p}
            </Button>
          )
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(currentPage + 1)}
        >
          Next
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 5))}
          title="Forward 5 pages"
        >
          ››
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(totalPages)}
          title="Last page"
        >
          »
        </Button>
      </div>
      {onPageSizeChange && (
        <PageSizeSelector pageSize={pageSize} onPageSizeChange={onPageSizeChange} />
      )}
    </div>
  );
}

function PageSizeSelector({
  pageSize,
  onPageSizeChange,
}: {
  pageSize: number;
  onPageSizeChange: (size: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="page-size" className="text-sm text-muted-foreground">
        Rows per page:
      </label>
      <Select value={pageSize.toString()} onValueChange={(v) => onPageSizeChange(parseInt(v, 10))}>
        <SelectTrigger id="page-size" className="w-20">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="10">10</SelectItem>
          <SelectItem value="25">25</SelectItem>
          <SelectItem value="50">50</SelectItem>
          <SelectItem value="100">100</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function buildPageNumbers(
  current: number,
  total: number
): (number | "...")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages: (number | "...")[] = [1];

  if (current > 3) pages.push("...");

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let i = start; i <= end; i++) pages.push(i);

  if (current < total - 2) pages.push("...");

  pages.push(total);
  return pages;
}
