import type { StoreFilterProduct } from "./types.js";

/**
 * Starrily (starrily.com): shade-name parser for `StarrilyShopify` (no product filter: every
 * stored product is typed Nail Polish and the generic gate handles it).
 *
 * Measured on the first ingest (2026-11-10, 203 stored products): 183 under vendor "Starrily"
 * and 20 collaboration shades under vendor "Starrily Kelli Marissa" (aliased to Starrily in
 * `data_source.metadata.vendorAliases`) titled "<Shade> By Kelli Marissa". Other titles carry a
 * finish or edition note after a dash ("Catnip - Shimmer", "Frozen - Limited Edition", "Earth -
 * Galaxy Edition", "Pegasus - Purple Foil", "Magma - Magnetic Top Coat"), a description after
 * " | " (coats: "Antimatter™ | All Purpose Gloss") or a trademark sign ("Vantablack®").
 */

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const BRAND_PREFIX = "starrily ";
const PIPE_SEPARATOR = /\s+\|\s+/;
const TRADEMARK_REGEX = /[™®]/g;
const SEGMENT_SEPARATOR = /\s+[-–—]\s+/;
/** Trailing note segments seen on the store: finishes, editions, foils and coat types. */
const NOTE_SEGMENT_REGEX =
  /^(?:shimmer|linear holographic|holographic glitter|multichrome|color shifting|holodescent|limited edition|limited availability|galaxy edition|(?:silver|purple|blue) foil|(?:holographic|magnetic) top coat)$/i;
const BY_REGEX = /\s+by\s+(.+)$/i;

/**
 * Starrily: the shade name without a " | " description, trademark signs, trailing dash notes
 * (above; the first segment always stays), or a " By <collaborator>" suffix when the vendor is
 * "Starrily <collaborator>" ("Callisto By Kelli Marissa" → "Callisto"). Null when nothing changes.
 */
export function parseStarrilyTitle(product: StoreFilterProduct): string | null {
  const title = asText(product.title);
  let name = title;
  const pipe = PIPE_SEPARATOR.exec(name);
  if (pipe) {
    name = name.slice(0, pipe.index);
  }
  name = name.replace(TRADEMARK_REGEX, "").trim();

  const segments = name.split(SEGMENT_SEPARATOR).map((segment) => segment.trim());
  let end = segments.length;
  while (end > 1 && NOTE_SEGMENT_REGEX.test(segments[end - 1])) {
    end -= 1;
  }
  name = segments.slice(0, end).join(" - ");

  const vendor = asText(product.vendor).toLowerCase();
  const by = BY_REGEX.exec(name);
  if (by && vendor.startsWith(BRAND_PREFIX) && by[1].trim().toLowerCase() === vendor.slice(BRAND_PREFIX.length).trim()) {
    name = name.slice(0, by.index);
  }

  name = name.replace(/\s+/g, " ").trim();
  return name && name !== title ? name : null;
}
