import type { StoreFilterProduct } from "./types.js";

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Polish Pickup titles are `Vendor | Shade`, `<Type> by Vendor | Shade`, or (coats)
 * `<Type> by Vendor`. Returns the shade name, or null when the title has neither shape.
 * Splits on the first " | "; when the shade repeats the vendor, the type is the name.
 */
export function parsePolishPickupTitle(
  product: StoreFilterProduct & { vendor?: unknown }
): string | null {
  const title = asText(product.title);
  const vendor = asText(product.vendor);
  if (!title) {
    return null;
  }
  const vendorLower = vendor.toLowerCase();
  const typeBeforeVendor = (head: string): string | null => {
    if (!vendor) {
      return null;
    }
    const suffix = ` by ${vendorLower}`;
    if (head.toLowerCase().endsWith(suffix) && head.length > suffix.length) {
      return head.slice(0, head.length - suffix.length).trim() || null;
    }
    return null;
  };

  const pipe = title.indexOf(" | ");
  if (pipe >= 0) {
    const head = title.slice(0, pipe).trim();
    const shade = title.slice(pipe + 3).trim();
    if (!shade) {
      return null;
    }
    if (vendor && shade.toLowerCase() === vendorLower) {
      return typeBeforeVendor(head) ?? null;
    }
    return shade;
  }
  return typeBeforeVendor(title);
}
