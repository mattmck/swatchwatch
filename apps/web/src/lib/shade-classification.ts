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
