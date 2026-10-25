import { ExternalLink } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { buyPriceAsOf, formatBuyPrice, type BuyPriceFields } from "@/lib/buy-price";
import { outboundLinkProps } from "@/lib/outbound-link";
import { cn } from "@/lib/utils";

interface BuyFromBrandLinkProps {
  /** `buyUrl` from the API; nothing renders when it is missing or unsafe. */
  url?: string | null;
  brand?: string;
  name?: string;
  /**
   * The brand's list price for the link (`buyPrice` / `buyCurrency` / `buyPriceSeenAt`, e.g. the
   * polish itself). Shown beside the link with an "as of <date>" hint; omit to show the link alone.
   */
  price?: BuyPriceFields | null;
  /** `inline` = small text link for table rows; `button` = outline button for detail pages. */
  variant?: "inline" | "button";
  className?: string;
}

/**
 * "Buy from brand" outbound link (#267). Opens the brand's product page in a new tab with
 * `rel="noopener noreferrer nofollow"`; renders nothing when the polish has no stored
 * (or no safe) product URL. With `price`, the brand's list price sits next to it.
 */
export function BuyFromBrandLink({ url, brand, name, price, variant = "inline", className }: BuyFromBrandLinkProps) {
  const link = outboundLinkProps(url);
  if (!link) return null;

  const label = [brand, name].filter(Boolean).join(" ");
  const ariaLabel = label
    ? `Buy ${label} from ${brand || "the brand"} (opens in a new tab)`
    : "Buy from brand (opens in a new tab)";
  const formattedPrice = formatBuyPrice(price);
  const asOf = formattedPrice ? buyPriceAsOf(price?.buyPriceSeenAt) : null;

  const anchor = (
    <a
      {...link}
      aria-label={ariaLabel}
      className={cn(
        variant === "button"
          ? buttonVariants({ variant: "outline", size: "sm" })
          : "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary hover:underline",
        !formattedPrice && className
      )}
    >
      Buy from brand
      <ExternalLink aria-hidden className={variant === "button" ? "size-3.5" : "size-3"} />
    </a>
  );
  if (!formattedPrice) return anchor;

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5", className)}>
      {anchor}
      <span
        className={cn("tabular-nums", variant === "button" ? "text-sm font-medium" : "text-xs font-medium text-foreground")}
        title="The brand's list price when SwatchWatch last checked its store. Not what you paid."
      >
        {formattedPrice}
        {asOf && <span className="ml-1 text-[10px] font-normal text-muted-foreground">{asOf}</span>}
      </span>
    </span>
  );
}
