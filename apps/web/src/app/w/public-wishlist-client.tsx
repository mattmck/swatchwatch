"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { PublicWishlistResponse } from "swatchwatch-shared";
import { BrandSpinner } from "@/components/brand-spinner";
import { SwatchWatchIcon } from "@/components/brand/swatchwatch-brand";
import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/empty-state";
import { FinishBadges } from "@/components/finish-badges";
import { ApiError, getPublicWishlist } from "@/lib/api";
import { buildSwatchThumbnailUrl } from "@/lib/image-url";
import { publicWishlistErrorMessage, publicWishlistTitle, readShareToken } from "@/lib/wishlist-share";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; status?: number }
  | { kind: "ready"; data: PublicWishlistResponse };

export function PublicWishlistClient() {
  const searchParams = useSearchParams();
  const token = readShareToken(searchParams);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    getPublicWishlist(token)
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", data });
      })
      .catch((error) => {
        if (!cancelled) setState({ kind: "error", status: error instanceof ApiError ? error.status : undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <SwatchWatchIcon name="monogram" size={24} title="SwatchWatch" />
            SwatchWatch
          </Link>
          <span className="text-xs text-muted-foreground">Shared wishlist · read-only</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        {!token ? (
          <ErrorState title="Wishlist unavailable" message={publicWishlistErrorMessage(404)} />
        ) : state.kind === "loading" ? (
          <BrandSpinner label="Loading wishlist…" className="min-h-[320px]" />
        ) : state.kind === "error" ? (
          <ErrorState title="Wishlist unavailable" message={publicWishlistErrorMessage(state.status)} />
        ) : (
          <WishlistGrid data={state.data} />
        )}
      </main>
    </div>
  );
}

function WishlistGrid({ data }: { data: PublicWishlistResponse }) {
  const title = publicWishlistTitle(data.displayName);
  return (
    <section className="space-y-6">
      <div>
        <h1 className="heading-page">{title}</h1>
        <p className="text-muted-foreground">
          {data.items.length} {data.items.length === 1 ? "polish" : "polishes"}
        </p>
      </div>

      {data.items.length === 0 ? (
        <EmptyState title="Nothing here yet" description="This wishlist is empty right now. Check back later." />
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {data.items.map((item, index) => (
            <li
              key={`${item.brand}|${item.name}|${index}`}
              className="overflow-hidden rounded-xl border bg-card shadow-sm"
            >
              <div
                className="relative aspect-square w-full"
                style={{ backgroundColor: item.hex ?? undefined }}
              >
                {!item.hex && <div className="absolute inset-0 bg-muted" aria-hidden />}
                {item.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element -- public proxy URL, no optimizer in static export
                  <img
                    src={buildSwatchThumbnailUrl(item.imageUrl, 256)}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="absolute bottom-2 right-2 size-14 rounded-lg border-2 border-white/80 object-cover shadow"
                  />
                )}
              </div>
              <div className="space-y-1.5 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{item.brand}</p>
                <p className="font-medium leading-tight">{item.name}</p>
                <div className="flex items-center justify-between gap-2">
                  <FinishBadges polish={{ finishes: item.finishes }} max={2} />
                  {item.hex && <span className="font-mono text-[11px] text-muted-foreground">{item.hex}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
