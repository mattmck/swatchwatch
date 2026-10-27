/**
 * Page-number window for list pagination: first and last page always, the current page with one
 * neighbour on each side, and an ellipsis for each gap. At most 7 slots, so the row never wraps
 * (GOV.UK / Polaris pattern); a gap of a single page shows that page instead of an ellipsis.
 */
export type PageSlot = number | "ellipsis";

export function buildPageNumbers(current: number, total: number): PageSlot[] {
  if (total <= 0) return [];
  const page = Math.min(Math.max(1, current), total);
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  // Keep the window five wide near either end so the slot count stays at 7.
  let start = Math.max(2, page - 1);
  let end = Math.min(total - 1, page + 1);
  if (page <= 4) {
    start = 2;
    end = 5;
  } else if (page >= total - 3) {
    start = total - 4;
    end = total - 1;
  }

  const slots: PageSlot[] = [1];
  if (start > 2) slots.push("ellipsis");
  for (let i = start; i <= end; i++) slots.push(i);
  if (end < total - 1) slots.push("ellipsis");
  slots.push(total);
  return slots;
}

/** "301–325 of 1,580": the 1-based item range shown on a page. */
export function pageRange(page: number, pageSize: number, totalItems: number): { start: number; end: number } {
  if (totalItems <= 0) return { start: 0, end: 0 };
  const start = (page - 1) * pageSize + 1;
  return { start, end: Math.min(page * pageSize, totalItems) };
}
