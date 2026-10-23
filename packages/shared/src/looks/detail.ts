import { safeOutboundUrl } from "../constants/outbound-links";
import { formatListAmount, listPriceOf, sumListPrices, type ListPriceSubtotal } from "../money/price-totals";
import { resolvePolishFinishes } from "../types/polish";
import type { LookStepRole } from "../types/looks";
import { LOOK_MOOD_LABELS, LOOK_OCCASION_LABELS, type Look, type LookStep, type Vibe } from "./recommend";

/**
 * Pure helpers behind the Looks cards' extras: the "Add missing items" shopping list, the detail
 * drawer (application order, finish notes), the share text and the skin-tone backdrop. No network,
 * no storage; the page wires them to the UI.
 */

// ── Shopping list ────────────────────────────────────────────

export interface ShoppingItem {
  role: LookStepRole;
  label: string;
  /** The template color for this step (what to look for when there is no specific polish). */
  targetHex: string;
  /** The color to show: the polish's display hex, or the target color. */
  hex: string;
  /** The catalog polish to buy, or null when only the target color is known. */
  polish: LookStep["polish"];
  shadeId: string | null;
  /** Validated "Buy from brand" link (http/https only), or null. */
  buyUrl: string | null;
  /** The brand's list price for that link (same product), or null when unknown. */
  price: { amount: number; currency: string } | null;
  /** When the price was last seen (ISO), or null. */
  priceSeenAt: string | null;
  /** A specific catalog shade exists, so it can be wishlisted. */
  canWishlist: boolean;
}

/** The steps of a look the user doesn't own yet. */
export function shoppingItemsForLook(look: Pick<Look, "steps">): ShoppingItem[] {
  return look.steps
    .filter((step) => step.source !== "owned")
    .map((step) => ({
      role: step.role,
      label: step.label,
      targetHex: step.targetHex,
      hex: step.hex,
      polish: step.polish,
      shadeId: step.polish?.id ?? null,
      buyUrl: safeOutboundUrl(step.polish?.buyUrl),
      price: safeOutboundUrl(step.polish?.buyUrl) ? listPriceOf(step.polish) : null,
      priceSeenAt: step.polish?.buyPriceSeenAt ?? null,
      canWishlist: Boolean(step.polish),
    }));
}

/** API-shaped price fields of a shopping item, for `formatBuyPrice` / `BuyFromBrandLink`. */
export function shoppingItemPriceFields(item: Pick<ShoppingItem, "price" | "priceSeenAt">) {
  return item.price
    ? { buyPrice: item.price.amount, buyCurrency: item.price.currency, buyPriceSeenAt: item.priceSeenAt }
    : null;
}

export interface ShoppingSubtotals {
  /** One subtotal per currency, never summed across currencies. */
  subtotals: ListPriceSubtotal[];
  /** Items with no known price (no polish, no buy link, or no price/currency). */
  unpricedCount: number;
}

/** Per-currency subtotal of a shopping list's priced items. */
export function shoppingSubtotals(items: ReadonlyArray<Pick<ShoppingItem, "price" | "priceSeenAt">>): ShoppingSubtotals {
  const { byCurrency, unpricedCount } = sumListPrices(items.map(shoppingItemPriceFields));
  return { subtotals: byCurrency, unpricedCount };
}

/** "$28.00 · €12.00" style text for the subtotals, or null when nothing is priced. */
export function formatShoppingSubtotals(subtotals: readonly ListPriceSubtotal[]): string | null {
  if (subtotals.length === 0) return null;
  return subtotals.map((group) => formatListAmount(group.total, group.currency)).join(" · ");
}

function polishLabel(step: { polish: { brand: string; name: string } | null }): string | null {
  return step.polish ? `${step.polish.name} — ${step.polish.brand}` : null;
}

/** Copyable plain-text shopping list for a look's missing steps. */
export function shoppingListText(look: Pick<Look, "name" | "steps">): string {
  const lines = [`Shopping list for ${look.name}`];
  const items = shoppingItemsForLook(look);
  for (const item of items) {
    const price = item.price ? formatListAmount(item.price.amount, item.price.currency) : null;
    const what = item.polish
      ? `${item.polish.name} — ${item.polish.brand}${price ? `, ${price}` : ""}${item.buyUrl ? ` (${item.buyUrl})` : ""}`
      : `any shade close to ${item.targetHex}`;
    lines.push(`${item.label}: ${what}`);
  }
  const subtotal = formatShoppingSubtotals(shoppingSubtotals(items).subtotals);
  if (subtotal) lines.push(`Subtotal (brand list prices): ${subtotal}`);
  return lines.join("\n");
}

// ── Share ────────────────────────────────────────────────────

/** Short text for sharing a look: title + vibe, each step, then the link (omitted when `url` is empty, as on the Expo app, which has no web origin). */
export function lookShareText(look: Pick<Look, "name" | "steps">, vibe: Vibe, url?: string): string {
  const lines = [`${look.name} — ${LOOK_OCCASION_LABELS[vibe.occasion]} · ${LOOK_MOOD_LABELS[vibe.mood]}`];
  for (const step of look.steps) {
    if (step.polish) {
      lines.push(`${step.label}: ${step.polish.name} (${step.polish.brand})${step.source === "owned" ? "" : " — to add"}`);
    } else {
      lines.push(`${step.label}: any shade close to ${step.targetHex} — to add`);
    }
  }
  if (url) lines.push(url);
  return lines.join("\n");
}

// ── Detail drawer ────────────────────────────────────────────

export type ApplicationKind = "base-coat" | "base" | "accent" | "topper" | "top-coat";

/**
 * What the drawer helpers read from a step: a recommended look's `LookStep`, or a step rebuilt from
 * a shared look's public payload (`/l/`, `lib/look-share.ts`).
 */
export type DetailStep = Pick<LookStep, "role" | "label" | "targetHex"> & {
  polish: { brand: string; name: string; finish?: string | null; finishes?: readonly string[] | null } | null;
};

export interface ApplicationStep {
  kind: ApplicationKind;
  title: string;
  text: string;
}

function finishesOf(step: Pick<DetailStep, "polish">): string[] {
  return step.polish ? resolvePolishFinishes(step.polish).map((f) => f.toLowerCase()) : [];
}

function nameOf(step: DetailStep): string {
  return polishLabel(step) ?? `any shade close to ${step.targetHex}`;
}

/** Order to apply a look: base coat, base color, accent/tip, topper, top coat. */
export function applicationOrder(look: { steps: readonly DetailStep[] }): ApplicationStep[] {
  const out: ApplicationStep[] = [{ kind: "base-coat", title: "Base coat", text: "One thin coat of clear base coat; let it dry." }];
  const byRole = (role: LookStepRole) => look.steps.filter((s) => s.role === role);
  for (const step of byRole("base")) {
    out.push({ kind: "base", title: step.label, text: `Two thin coats of ${nameOf(step)}; let each dry before the next.` });
  }
  for (const step of byRole("accent")) {
    out.push({ kind: "accent", title: step.label, text: `${nameOf(step)} on the accent nail or tip, after the base is fully dry.` });
  }
  for (const step of byRole("topper")) {
    out.push({ kind: "topper", title: step.label, text: `Dab or sponge ${nameOf(step)} over the dry color, where you want the sparkle.` });
  }
  const matte = look.steps.some((s) => finishesOf(s).includes("matte"));
  out.push({
    kind: "top-coat",
    title: "Top coat",
    text: matte
      ? "A matte top coat to seal it. A glossy one would undo the matte finish."
      : "A glossy top coat to seal it and smooth any texture.",
  });
  return out;
}

export interface FinishNote {
  finish: string;
  note: string;
}

const FINISH_NOTES: Record<string, string> = {
  matte: "Matte shows every bump, so smooth your nails first and finish with a matte top coat only.",
  holographic: "Holographic effects need bright light and a thin, even layer; a dark base underneath makes them pop.",
  glitter: "Glitter can feel gritty: use a smoothing top coat, and remove with the foil method.",
  flake: "Flakies float in the bottle: shake well, and press them on with a dabbing motion over a dry color.",
  topper: "Toppers are see-through: wear them over a dry color, one thin dab at a time.",
  metallic: "Metallics streak easily: apply thin coats and don't go back over a drying coat.",
  magnetic: "Magnetic polish needs its magnet held over each wet nail for a few seconds before it sets.",
  duochrome: "Duochromes shift color with light and look strongest over a dark base.",
  multichrome: "Multichromes shift through several colors and look strongest over a dark base.",
  chrome: "Chrome looks best over a smooth, fully dry base with a thin layer.",
  jelly: "Jellies are see-through and build up: add coats for depth, and expect nail lines to show.",
  sheer: "Sheer polish is buildable: two or three coats give a milky wash, one gives a hint.",
  thermal: "Thermal polish changes color with temperature; wear it a day before showing it off.",
  glow: "Glow polish needs a light charge to glow and looks strongest over white or a pale base.",
};

/** One practical note per distinct finish among the look's polishes (plain cremes get none). */
export function finishNotes(look: { steps: readonly DetailStep[] }): FinishNote[] {
  const seen = new Set<string>();
  const notes: FinishNote[] = [];
  for (const step of look.steps) {
    for (const finish of finishesOf(step)) {
      const note = FINISH_NOTES[finish];
      if (!note || seen.has(finish)) continue;
      seen.add(finish);
      notes.push({ finish, note });
    }
  }
  return notes;
}
