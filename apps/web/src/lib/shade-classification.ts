import {
  SHADE_FINISHES_MAX,
  type HexLabelQueueItem,
  type ShadeFinishesUpdateResponse,
  type ShadeProductCategoryUpdateResponse,
} from "swatchwatch-shared";

/**
 * Pure rules for the Hex Labeling tool's category and finish pills (`ShadeClassificationEditor`).
 * A finish list is ordered, primary first: a newly picked finish goes to the end, and "make
 * primary" moves one to the front.
 */

/** Toggle a finish: remove it when selected, else append it (up to `SHADE_FINISHES_MAX`). */
export function toggleFinish(selected: readonly string[], finish: string): string[] {
  if (selected.includes(finish)) return selected.filter((value) => value !== finish);
  if (selected.length >= SHADE_FINISHES_MAX) return [...selected];
  return [...selected, finish];
}

/** Move a selected finish to the front (the primary finish). Unselected finishes are ignored. */
export function makePrimaryFinish(selected: readonly string[], finish: string): string[] {
  if (!selected.includes(finish)) return [...selected];
  return [finish, ...selected.filter((value) => value !== finish)];
}

/** True when the draft differs from the saved list (order matters: the first is the primary). */
export function finishesChanged(saved: readonly string[], draft: readonly string[]): boolean {
  return saved.length !== draft.length || saved.some((value, index) => value !== draft[index]);
}

/** A queue item with a `PUT …/finishes` response applied. */
export function applyFinishesResponse(item: HexLabelQueueItem, response: ShadeFinishesUpdateResponse): HexLabelQueueItem {
  if (item.shadeId !== response.shadeId) return item;
  return { ...item, finishes: response.finishes, finishesSource: response.finishesSource };
}

/** A queue item with a `PUT …/product-category` response applied. */
export function applyCategoryResponse(
  item: HexLabelQueueItem,
  response: ShadeProductCategoryUpdateResponse
): HexLabelQueueItem {
  if (item.shadeId !== response.shadeId) return item;
  return { ...item, productCategory: response.productCategory, productCategorySource: response.productCategorySource };
}

/** The part of the Hex Labeling tab's queue state a changed item touches. */
export interface LabelQueueSlice {
  items: HexLabelQueueItem[];
  index: number;
  total: number;
  labeled: number;
}

/**
 * A queue with one changed item applied. The queue is colour-only, so an item whose type moved
 * away from `color` (topper, coat, treatment, accessory) leaves it and the next shade takes its
 * place; any other change replaces the item in place. An unknown item returns the queue as is.
 */
export function applyQueueItemChange<Q extends LabelQueueSlice>(queue: Q, next: HexLabelQueueItem): Q {
  const position = queue.items.findIndex((item) => item.shadeId === next.shadeId);
  if (position < 0) return queue;
  if (next.productCategory === "color") {
    return { ...queue, items: queue.items.map((item, i) => (i === position ? next : item)) };
  }
  const items = queue.items.filter((_, i) => i !== position);
  return {
    ...queue,
    items,
    index: Math.min(queue.index > position ? queue.index - 1 : queue.index, Math.max(0, items.length - 1)),
    total: Math.max(0, queue.total - 1),
    labeled: queue.items[position].label ? Math.max(0, queue.labeled - 1) : queue.labeled,
  };
}
