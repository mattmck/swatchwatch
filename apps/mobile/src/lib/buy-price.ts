import type { Polish } from "swatchwatch-shared";

/**
 * The brand's list price next to "Buy from <brand>" (`buyPrice` / `buyCurrency` /
 * `buyPriceSeenAt`, mirroring the web's `lib/buy-price.ts`): what the brand's store listed when
 * SwatchWatch last fetched the product, never what the user paid.
 */
type BuyPriceFields = Pick<Polish, "buyPrice" | "buyCurrency" | "buyPriceSeenAt">;

/** e.g. `$12.50 · as of Oct 21, 2026`; null without both a price and an ISO currency. */
export function formatBuyPriceLine(fields: BuyPriceFields | null | undefined, locale?: string): string | null {
  const amount = fields?.buyPrice;
  const currency = fields?.buyCurrency;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  let price: string;
  try {
    price = new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
  } catch {
    price = `${amount.toFixed(2)} ${currency}`;
  }
  const seen = fields?.buyPriceSeenAt ? new Date(fields.buyPriceSeenAt) : null;
  if (!seen || Number.isNaN(seen.getTime())) return price;
  return `${price} · as of ${seen.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" })}`;
}
