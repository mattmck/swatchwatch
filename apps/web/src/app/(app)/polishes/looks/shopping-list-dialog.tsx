"use client";

import Link from "next/link";
import { Check, Copy, Heart, Search } from "lucide-react";
import { BuyFromBrandLink } from "@/components/buy-from-brand-link";
import { ColorDot } from "@/components/color-dot";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Look } from "@/lib/looks";
import { shoppingItemsForLook, type ShoppingItem } from "@/lib/looks-detail";

function searchHref(hex: string): string {
  return `/polishes/search?${new URLSearchParams({ color: hex.replace("#", ""), harmony: "similar" })}`;
}

interface ShoppingListDialogProps {
  look: Look | null;
  onOpenChange: (open: boolean) => void;
  /** Shade ids already put on the wishlist from this dialog or earlier. */
  wishlisted: ReadonlySet<string>;
  /** True while a shade's add-guard check or save is in flight. */
  isPending: (shadeId: string) => boolean;
  onWishlist: (item: ShoppingItem) => void;
  onCopy: (look: Look) => void;
}

/**
 * "Add missing items": every step of a look the user doesn't own, with the brand's "Buy from
 * brand" link, a one-tap ♡ wishlist (through the add guard, page side) and a copyable text list.
 */
export function ShoppingListDialog({ look, onOpenChange, wishlisted, isPending, onWishlist, onCopy }: ShoppingListDialogProps) {
  const items = look ? shoppingItemsForLook(look) : [];
  return (
    <Dialog open={look !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{look ? `Finish ${look.name}` : "Shopping list"}</DialogTitle>
          <DialogDescription>
            {items.length === 0
              ? "You own everything in this look."
              : `${items.length} polish${items.length === 1 ? "" : "es"} to add. Wishlist them or buy from the brand.`}
          </DialogDescription>
        </DialogHeader>
        <ul className="divide-y divide-border">
          {items.map((item) => {
            const onList = item.shadeId !== null && wishlisted.has(item.shadeId);
            const busy = item.shadeId !== null && isPending(item.shadeId);
            return (
              <li key={`${item.role}-${item.label}`} className="space-y-1.5 py-3">
                <div className="flex items-center gap-3">
                  <ColorDot hex={item.hex} size="lg" className="shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{item.label}</p>
                    {item.polish ? (
                      <>
                        <Link href={`/polishes/detail?id=${item.polish.id}`} className="block truncate text-sm font-medium hover:underline">
                          {item.polish.name}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">{item.polish.brand}</p>
                      </>
                    ) : (
                      <Link
                        href={searchHref(item.targetHex)}
                        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary hover:underline"
                      >
                        <Search className="size-3.5" aria-hidden />
                        Any shade close to {item.targetHex}
                      </Link>
                    )}
                  </div>
                  {item.canWishlist && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={onList || busy}
                      aria-pressed={onList}
                      onClick={() => onWishlist(item)}
                    >
                      {onList ? <Check className="size-4" aria-hidden /> : <Heart className="size-4" aria-hidden />}
                      {onList ? "On wishlist" : "Wishlist"}
                    </Button>
                  )}
                </div>
                {item.polish && item.buyUrl && (
                  <div className="pl-11">
                    <BuyFromBrandLink url={item.buyUrl} brand={item.polish.brand} name={item.polish.name} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={!look || items.length === 0} onClick={() => look && onCopy(look)}>
            <Copy className="size-4" aria-hidden />
            Copy list
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
