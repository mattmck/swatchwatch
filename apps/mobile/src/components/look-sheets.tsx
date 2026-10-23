import type { ReactNode } from "react";
import { Linking, Modal, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  applicationOrder,
  finishNotes,
  formatShoppingSubtotals,
  resolveDisplayHex,
  safeOutboundUrl,
  shoppingItemsForLook,
  shoppingSubtotals,
  shopCandidatesForStep,
  type Look,
  type Polish,
  type PolishStatus,
  type ShoppingItem,
  type Vibe,
} from "swatchwatch-shared";
import { formatBuyPriceLine } from "@/lib/buy-price";
import { shoppingItemPriceLine } from "@/lib/looks";
import { useTheme } from "@/theme/theme";
import { ColorDot, Swatch } from "./swatch";
import { AppText, Button, Chip } from "./ui";

/** Open a brand page, only if it is a plain http/https link (the web renders these with `rel="nofollow"`). */
export function openBuyUrl(url: string | null | undefined): void {
  const safe = safeOutboundUrl(url);
  if (safe) void Linking.openURL(safe);
}

function SheetFrame({
  visible,
  title,
  subtitle,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      {visible && (
        <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing(4), gap: theme.spacing(2) }}>
            <View style={{ flex: 1 }}>
              <AppText variant="heading" accessibilityRole="header" numberOfLines={2}>
                {title}
              </AppText>
              {subtitle ? (
                <AppText variant="small" muted>
                  {subtitle}
                </AppText>
              ) : null}
            </View>
            <Button title="Done" variant="ghost" compact onPress={onClose} />
          </View>
          <ScrollView contentContainerStyle={{ padding: theme.spacing(4), paddingTop: 0, gap: theme.spacing(5) }}>{children}</ScrollView>
        </SafeAreaView>
      )}
    </Modal>
  );
}

/** "Buy" for a catalog candidate: the brand link with its list price underneath. */
function BuyAction({ polish }: { polish: Polish }) {
  const theme = useTheme();
  const safe = safeOutboundUrl(polish.buyUrl);
  const price = safe ? formatBuyPriceLine(polish) : null;
  return (
    <View style={{ alignItems: "flex-end", gap: 2, maxWidth: 150 }}>
      <AppText variant="tiny" muted>
        To buy
      </AppText>
      {safe ? (
        <Button title="Buy from brand" variant="outline" compact accessibilityLabel={`Buy ${polish.name} from ${polish.brand}`} onPress={() => openBuyUrl(safe)} />
      ) : null}
      {price ? (
        <AppText variant="tiny" muted style={{ textAlign: "right", marginTop: theme.spacing(0.5) }}>
          {price}
        </AppText>
      ) : null}
    </View>
  );
}

function CandidateRow({ polish, action }: { polish: Polish; action: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
      <ColorDot hex={resolveDisplayHex(polish)} size={22} />
      <View style={{ flex: 1 }}>
        <AppText variant="small" style={{ fontWeight: "600" }} numberOfLines={1}>
          {polish.name}
        </AppText>
        <AppText variant="tiny" muted numberOfLines={1}>
          {polish.brand}
        </AppText>
      </View>
      {action}
    </View>
  );
}

/**
 * Substitutions for one step: the next owned polishes to swap in (tap Use), then catalog shades
 * to buy (same rule as the web drawer; a catalog shade is never swapped in as if it were owned).
 */
function StepSubstitutes({
  look,
  stepIndex,
  pool,
  vibe,
  loading,
  onSwap,
}: {
  look: Look;
  stepIndex: number;
  pool: readonly Polish[];
  vibe: Vibe;
  loading: boolean;
  onSwap: (stepIndex: number, polish: Polish) => void;
}) {
  const theme = useTheme();
  const step = look.steps[stepIndex];
  const shop = shopCandidatesForStep(look, stepIndex, pool, vibe);
  if (step.alternatives.length === 0 && shop.length === 0) {
    return (
      <AppText variant="small" muted>
        {loading ? "Looking for substitutes…" : "No close substitutes found."}
      </AppText>
    );
  }
  return (
    <View style={{ gap: theme.spacing(2) }}>
      {step.alternatives.map((alt) => (
        <CandidateRow
          key={`own-${alt.id}`}
          polish={alt}
          action={<Button title="Use (owned)" variant="outline" compact accessibilityLabel={`Use ${alt.name} from your collection`} onPress={() => onSwap(stepIndex, alt)} />}
        />
      ))}
      {shop.map((row) => (
        <CandidateRow key={`shop-${row.id}`} polish={row} action={<BuyAction polish={row} />} />
      ))}
    </View>
  );
}

/** Swap one step (web: the card's inline Swap list). */
export function SwapSheet({
  look,
  stepIndex,
  pool,
  vibe,
  loading,
  onSwap,
  onClose,
}: {
  look: Look | null;
  /** The step to swap, by position (a look can have two accents). */
  stepIndex: number | null;
  pool: readonly Polish[];
  vibe: Vibe;
  loading: boolean;
  onSwap: (stepIndex: number, polish: Polish) => void;
  onClose: () => void;
}) {
  const step = look && stepIndex !== null ? look.steps[stepIndex] : undefined;
  return (
    <SheetFrame visible={Boolean(look && step)} title={step ? `Swap ${step.label}` : "Swap"} subtitle={look?.name} onClose={onClose}>
      {look && step ? (
        <StepSubstitutes
          look={look}
          stepIndex={stepIndex!}
          pool={pool}
          vibe={vibe}
          loading={loading}
          onSwap={(index, polish) => {
            onSwap(index, polish);
            onClose();
          }}
        />
      ) : null}
    </SheetFrame>
  );
}

/** A look in detail (web: `LookDrawer`): application order, finish notes and per-step substitutions. */
export function LookDetailsSheet({
  look,
  pool,
  vibe,
  loading,
  onSwap,
  onClose,
}: {
  look: Look | null;
  pool: readonly Polish[];
  vibe: Vibe;
  loading: boolean;
  onSwap: (stepIndex: number, polish: Polish) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const order = look ? applicationOrder(look) : [];
  const notes = look ? finishNotes(look) : [];
  return (
    <SheetFrame visible={look !== null} title={look?.name ?? "Look"} subtitle={look ? `${look.description} · ${look.minutes} min` : undefined} onClose={onClose}>
      {look && (
        <>
          <View style={{ flexDirection: "row", gap: theme.spacing(1.5) }} accessibilityLabel={`${look.name} colors`}>
            {look.steps.map((step, i) => (
              <Swatch key={`${step.role}:${i}`} hex={step.hex} imageUrl={step.polish?.swatchImageUrl} size={44} />
            ))}
          </View>
          <View style={{ gap: theme.spacing(2) }}>
            <AppText variant="label" muted>
              How to apply it
            </AppText>
            {order.map((step, index) => (
              <AppText key={`${step.kind}-${index}`} variant="small">
                {index + 1}. <AppText variant="small" style={{ fontWeight: "600" }}>{step.title}.</AppText> {step.text}
              </AppText>
            ))}
          </View>
          {notes.length > 0 && (
            <View style={{ gap: theme.spacing(2) }}>
              <AppText variant="label" muted>
                Finish notes
              </AppText>
              {notes.map((note) => (
                <AppText key={note.finish} variant="small">
                  <AppText variant="small" style={{ fontWeight: "600", textTransform: "capitalize" }}>{note.finish}:</AppText> {note.note}
                </AppText>
              ))}
            </View>
          )}
          <View style={{ gap: theme.spacing(3) }}>
            <AppText variant="label" muted>
              Substitutions
            </AppText>
            {look.steps.map((step, index) => (
              <View key={`${step.role}:${index}`} style={{ gap: theme.spacing(1.5) }}>
                <AppText variant="tiny" muted>
                  {step.label}
                </AppText>
                <StepSubstitutes look={look} stepIndex={index} pool={pool} vibe={vibe} loading={loading} onSwap={onSwap} />
              </View>
            ))}
          </View>
        </>
      )}
    </SheetFrame>
  );
}

/**
 * "Add missing items" (web: `ShoppingListDialog`): the steps you don't own with a brand link and
 * list price, ♡ wishlist (through the add guard, done by the caller), per-currency subtotals and a
 * copyable text list.
 */
export function ShoppingListSheet({
  look,
  moved,
  busy,
  onWishlist,
  onCopy,
  onClose,
}: {
  look: Look | null;
  moved: Record<string, PolishStatus>;
  busy: ReadonlySet<string>;
  onWishlist: (polish: Polish) => void;
  onCopy: (look: Look) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const items = look ? shoppingItemsForLook(look) : [];
  const { subtotals, unpricedCount } = shoppingSubtotals(items);
  const subtotalText = formatShoppingSubtotals(subtotals);
  return (
    <SheetFrame visible={look !== null} title="Add missing items" subtitle={look?.name} onClose={onClose}>
      {items.length === 0 ? (
        <AppText variant="small" muted>
          You own everything in this look.
        </AppText>
      ) : (
        <View style={{ gap: theme.spacing(4) }}>
          {items.map((item) => (
            <ShoppingRow key={`${item.role}:${item.polish?.id ?? item.targetHex}`} item={item} moved={moved} busy={busy} onWishlist={onWishlist} />
          ))}
          {subtotalText ? (
            <View style={{ gap: 2 }}>
              <AppText variant="small" style={{ fontWeight: "600" }}>
                Subtotal (brand list prices): {subtotalText}
              </AppText>
              {unpricedCount > 0 ? (
                <AppText variant="tiny" muted>
                  {unpricedCount} item{unpricedCount === 1 ? "" : "s"} without a price. Currencies are never added together.
                </AppText>
              ) : null}
            </View>
          ) : null}
          {look ? <Button title="Copy list" variant="outline" onPress={() => onCopy(look)} /> : null}
        </View>
      )}
    </SheetFrame>
  );
}

function ShoppingRow({
  item,
  moved,
  busy,
  onWishlist,
}: {
  item: ShoppingItem;
  moved: Record<string, PolishStatus>;
  busy: ReadonlySet<string>;
  onWishlist: (polish: Polish) => void;
}) {
  const theme = useTheme();
  const polish = item.polish;
  const status = polish ? (moved[polish.id] ?? polish.status) : undefined;
  const priceLine = shoppingItemPriceLine(item);
  return (
    <View style={{ gap: theme.spacing(2) }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
        <Swatch hex={item.hex} imageUrl={polish?.swatchImageUrl} size={40} />
        <View style={{ flex: 1 }}>
          <AppText variant="tiny" muted numberOfLines={1}>
            {item.label}
          </AppText>
          <AppText variant="small" style={{ fontWeight: "600" }} numberOfLines={2}>
            {polish ? `${polish.brand} — ${polish.name}` : `Any shade close to ${item.targetHex}`}
          </AppText>
          {priceLine ? (
            <AppText variant="tiny" muted>
              Brand price {priceLine}
            </AppText>
          ) : null}
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: theme.spacing(2), flexWrap: "wrap" }}>
        {item.buyUrl ? (
          <Button title="Buy from brand" variant="outline" compact accessibilityLabel={`Buy ${polish?.name ?? item.label} from ${polish?.brand ?? "the brand"}`} onPress={() => openBuyUrl(item.buyUrl)} />
        ) : null}
        {polish && item.canWishlist ? (
          status === "wishlist" ? (
            <Chip label="♡ Wishlist" tone="brand" />
          ) : status === "owned" ? (
            <Chip label="Owned ✓" tone="success" />
          ) : (
            <Button
              title="♡ Wishlist"
              variant="outline"
              compact
              disabled={busy.has(polish.id)}
              accessibilityLabel={`Add ${polish.name} to wishlist`}
              onPress={() => onWishlist(polish)}
            />
          )
        ) : null}
      </View>
    </View>
  );
}
