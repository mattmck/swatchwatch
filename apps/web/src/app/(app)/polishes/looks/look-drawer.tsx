"use client";

import { Repeat } from "lucide-react";
import type { Polish } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";
import { BuyFromBrandLink } from "@/components/buy-from-brand-link";
import { ColorDot } from "@/components/color-dot";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Look, LookStepRole, Vibe } from "@/lib/looks";
import { shopCandidatesForStep } from "@/lib/looks";
import { applicationOrder, finishNotes } from "@/lib/looks-detail";
import { ColorLabLink, LookSwatchStrip } from "./look-card";

interface LookDrawerProps {
  look: Look | null;
  vibe: Vibe;
  /** Catalog rows loaded so far, the pool for "to buy" substitutions. */
  catalogPool: readonly Polish[];
  /** True while catalog rows for this look's colors are still loading. */
  catalogLoading: boolean;
  onOpenChange: (open: boolean) => void;
  onSwap: (role: LookStepRole, polish: Polish) => void;
  /** `/polishes/search` seeded with the look's palette (#386). */
  colorLabHref: string | null;
  onColorLab: () => void;
}

function Candidate({ polish, action }: { polish: Polish; action?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
      <ColorDot hex={resolveDisplayHex(polish)} size="sm" />
      <span className="min-w-0 flex-1 truncate">
        {polish.name} <span className="text-muted-foreground">· {polish.brand}</span>
      </span>
      {action}
    </li>
  );
}

/**
 * A look in detail: application order, finish notes and, per step, substitutions (the next owned
 * polishes to swap in, and catalog shades to buy). Opens from a look card's Details button.
 */
export function LookDrawer({ look, vibe, catalogPool, catalogLoading, onOpenChange, onSwap, colorLabHref, onColorLab }: LookDrawerProps) {
  const order = look ? applicationOrder(look) : [];
  const notes = look ? finishNotes(look) : [];
  return (
    <Dialog open={look !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{look?.name ?? "Look"}</DialogTitle>
          <DialogDescription>{look ? `${look.description} · ${look.minutes} min` : ""}</DialogDescription>
        </DialogHeader>
        {look && (
          <div className="space-y-6">
            <div className="space-y-1">
              <LookSwatchStrip steps={look.steps} className="h-10" />
              {colorLabHref && (
                <div className="flex justify-end">
                  <ColorLabLink href={colorLabHref} onClick={onColorLab} lookName={look.name} />
                </div>
              )}
            </div>

            <section aria-labelledby="look-order">
              <h3 id="look-order" className="mb-2 text-sm font-semibold">
                How to apply it
              </h3>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                {order.map((step, index) => (
                  <li key={`${step.kind}-${index}`}>
                    <span className="font-medium">{step.title}.</span> {step.text}
                  </li>
                ))}
              </ol>
            </section>

            {notes.length > 0 && (
              <section aria-labelledby="look-finishes">
                <h3 id="look-finishes" className="mb-2 text-sm font-semibold">
                  Finish notes
                </h3>
                <ul className="space-y-1.5 text-sm">
                  {notes.map((note) => (
                    <li key={note.finish}>
                      <span className="font-medium capitalize">{note.finish}:</span> {note.note}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section aria-labelledby="look-subs" className="space-y-3">
              <h3 id="look-subs" className="text-sm font-semibold">
                Substitutions
              </h3>
              {look.steps.map((step) => {
                const shop = shopCandidatesForStep(look, step.role, catalogPool, vibe);
                return (
                  <div key={step.role}>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{step.label}</p>
                    {step.alternatives.length === 0 && shop.length === 0 ? (
                      <p className="px-2 py-1.5 text-sm text-muted-foreground">
                        {catalogLoading ? "Looking for substitutes…" : "No close substitutes found."}
                      </p>
                    ) : (
                      <ul>
                        {step.alternatives.map((alt) => (
                          <Candidate
                            key={`own-${alt.id}`}
                            polish={alt}
                            action={
                              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs pointer-coarse:h-9" onClick={() => onSwap(step.role, alt)}>
                                <Repeat className="size-3.5" aria-hidden />
                                Use (owned)
                              </Button>
                            }
                          />
                        ))}
                        {shop.map((row) => (
                          <Candidate
                            key={`shop-${row.id}`}
                            polish={row}
                            action={
                              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                To buy
                                <BuyFromBrandLink url={row.buyUrl} brand={row.brand} name={row.name} />
                              </span>
                            }
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
