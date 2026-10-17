import { ExternalLink } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { outboundLinkProps } from "@/lib/outbound-link";
import { cn } from "@/lib/utils";

interface BuyFromBrandLinkProps {
  /** `buyUrl` from the API; nothing renders when it is missing or unsafe. */
  url?: string | null;
  brand?: string;
  name?: string;
  /** `inline` = small text link for table rows; `button` = outline button for detail pages. */
  variant?: "inline" | "button";
  className?: string;
}

/**
 * "Buy from brand" outbound link (#267). Opens the brand's product page in a new tab with
 * `rel="noopener noreferrer nofollow"`; renders nothing when the polish has no stored
 * (or no safe) product URL.
 */
export function BuyFromBrandLink({ url, brand, name, variant = "inline", className }: BuyFromBrandLinkProps) {
  const link = outboundLinkProps(url);
  if (!link) return null;

  const label = [brand, name].filter(Boolean).join(" ");
  const ariaLabel = label
    ? `Buy ${label} from ${brand || "the brand"} (opens in a new tab)`
    : "Buy from brand (opens in a new tab)";

  return (
    <a
      {...link}
      aria-label={ariaLabel}
      className={cn(
        variant === "button"
          ? buttonVariants({ variant: "outline", size: "sm" })
          : "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary hover:underline",
        className
      )}
    >
      Buy from brand
      <ExternalLink aria-hidden className={variant === "button" ? "size-3.5" : "size-3"} />
    </a>
  );
}
