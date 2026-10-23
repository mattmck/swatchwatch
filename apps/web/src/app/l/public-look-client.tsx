"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { PublicLookResponse } from "swatchwatch-shared";
import { BrandSpinner } from "@/components/brand-spinner";
import { SwatchWatchIcon } from "@/components/brand/swatchwatch-brand";
import { ErrorState } from "@/components/error-state";
import { FinishBadges } from "@/components/finish-badges";
import { SwatchThumbnail } from "@/components/swatch-thumbnail";
import { Button } from "@/components/ui/button";
import { ApiError, getPublicLook } from "@/lib/api";
import {
  publicLookDescription,
  publicLookDetailSteps,
  publicLookName,
  publicLookOwnerLine,
  publicLookVibeLine,
  publicLookView,
  readShareToken,
} from "@/lib/look-share";
import { applicationOrder, finishNotes } from "@/lib/looks-detail";
import { LookSwatchStrip } from "../(app)/polishes/looks/look-card";

type LoadResult = { ok: true; look: PublicLookResponse } | { ok: false; status?: number };

export function PublicLookClient() {
  const searchParams = useSearchParams();
  const token = readShareToken(searchParams);
  const [result, setResult] = useState<{ token: string; value: LoadResult } | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    getPublicLook(token)
      .then((look) => {
        if (!cancelled) setResult({ token, value: { ok: true, look } });
      })
      .catch((error) => {
        if (!cancelled) setResult({ token, value: { ok: false, status: error instanceof ApiError ? error.status : undefined } });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const view = publicLookView(token, result?.token === token ? result.value : undefined);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <SwatchWatchIcon name="monogram" size={24} title="SwatchWatch" />
            SwatchWatch
          </Link>
          <span className="text-xs text-muted-foreground">Shared look · read-only</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        {view.kind === "loading" ? (
          <BrandSpinner label="Loading look…" className="min-h-[320px]" />
        ) : view.kind === "unavailable" ? (
          <ErrorState title={view.title} message={view.message} />
        ) : (
          <SharedLook look={view.look} />
        )}
      </main>
    </div>
  );
}

function SharedLook({ look }: { look: PublicLookResponse }) {
  const description = publicLookDescription(look.templateId);
  const detailSteps = publicLookDetailSteps(look);
  const order = applicationOrder({ steps: detailSteps });
  const notes = finishNotes({ steps: detailSteps });

  return (
    <article className="space-y-8">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{publicLookOwnerLine(look.displayName)}</p>
        <h1 className="heading-page">{publicLookName(look.templateId)}</h1>
        <p className="text-sm text-muted-foreground">{publicLookVibeLine(look.vibe)}</p>
        {description && <p>{description}</p>}
      </div>

      <LookSwatchStrip steps={look.steps} className="h-20" />

      <section aria-labelledby="shared-look-polishes" className="space-y-3">
        <h2 id="shared-look-polishes" className="heading-section">Polishes</h2>
        <ul className="divide-y divide-border rounded-xl border">
          {look.steps.map((step, index) => (
            <li key={`${step.role}-${index}`} className="flex items-center gap-3 p-3">
              <span
                aria-hidden
                className="size-12 shrink-0 rounded-lg border shadow-inner"
                style={{ backgroundColor: step.hex }}
              />
              {step.imageUrl && (
                <SwatchThumbnail
                  src={step.imageUrl}
                  displaySize={48}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="size-12 shrink-0 rounded-lg border object-cover"
                />
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {detailSteps[index].label}
                </p>
                {step.brand && step.name ? (
                  <p className="font-medium leading-tight">
                    {step.name} <span className="font-normal text-muted-foreground">· {step.brand}</span>
                  </p>
                ) : (
                  <p className="font-medium leading-tight">Any shade close to this color</p>
                )}
                <div className="flex items-center gap-2">
                  {step.finishes.length > 0 && <FinishBadges polish={{ finishes: step.finishes }} max={2} />}
                  <span className="font-mono text-[11px] text-muted-foreground">{step.hex}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="shared-look-order" className="space-y-3">
        <h2 id="shared-look-order" className="heading-section">How to apply</h2>
        <ol className="list-decimal space-y-2 pl-5">
          {order.map((step, index) => (
            <li key={`${step.kind}-${index}`}>
              <span className="font-medium">{step.title}:</span> {step.text}
            </li>
          ))}
        </ol>
        {notes.length > 0 && (
          <ul className="space-y-1 text-sm text-muted-foreground">
            {notes.map((note) => (
              <li key={note.finish}>
                <span className="font-medium capitalize text-foreground">{note.finish}:</span> {note.note}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="rounded-xl border bg-card p-5 text-center">
        <p className="font-medium">Build looks from your own collection</p>
        <p className="mt-1 text-sm text-muted-foreground">
          SwatchWatch keeps track of your nail polish and suggests looks from what you own.
        </p>
        <Button asChild className="mt-4">
          <Link href="/">Get SwatchWatch</Link>
        </Button>
      </div>
    </article>
  );
}
