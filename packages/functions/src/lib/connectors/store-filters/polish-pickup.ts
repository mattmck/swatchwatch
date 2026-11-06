import type { StoreFilterProduct } from "./types.js";

/**
 * Polish Pickup (polishpickup.com) product filter.
 *
 * Polish Pickup is a retailer: product types are its own sections, not finishes.
 * - `PPU` (Polish Pickup pre-order polishes, incl. their coats) are kept.
 * - `IPU` (in-stock items) mixes coats with stamping plates, scrubs and tools, so
 *   the generic gate decides (`null`).
 * - `Merchandise`, `Hand & Nail` and `Gift Cards` are never polish.
 */
export function isPolishPickupPolish(product: StoreFilterProduct): boolean | null {
  const productType = typeof product.product_type === "string" ? product.product_type.trim() : "";
  switch (productType) {
    case "PPU":
      return true;
    case "Merchandise":
    case "Hand & Nail":
    case "Gift Cards":
      return false;
    default:
      return null;
  }
}
