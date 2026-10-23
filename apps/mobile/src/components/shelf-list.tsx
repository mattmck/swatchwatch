import { View } from "react-native";
import {
  formatShelfAge,
  SHELF_VERDICT_LABELS,
  shelfCounts,
  shelfQuickActions,
  type ShelfEntry,
  type ShelfQuickAction,
} from "@/lib/shelf";
import { useTheme } from "@/theme/theme";
import { ColorDot } from "./swatch";
import { AppText, Button, Card, Chip } from "./ui";

const ACTED_LABELS = { added: "Added", wishlisted: "Wishlisted", bought_another: "Bought another" } as const;
const ACTION_LABELS: Record<ShelfQuickAction, string> = { add: "Add", wishlist: "♡ Wishlist", bought_another: "I bought another" };

/**
 * The shelf under Rapid Add (web: `components/rapid-add/shelf-list.tsx`): every verdict of this
 * session, newest first, with the same quick actions as the verdict card. Nothing is added until
 * a tap.
 */
export function ShelfList({
  entries,
  repeatKey,
  busyKey,
  now,
  onAction,
  onOpen,
  onClear,
}: {
  entries: readonly ShelfEntry[];
  repeatKey: string | null;
  busyKey: string | null;
  now: number;
  onAction: (entry: ShelfEntry, action: ShelfQuickAction) => void;
  onOpen: (entry: ShelfEntry) => void;
  onClear: () => void;
}) {
  const theme = useTheme();
  const counts = shelfCounts(entries);
  const tone = (v: ShelfEntry["verdict"]) =>
    v === "owned" || v === "near_dupe" ? "warning" : v === "wishlist" ? "brand" : v === "new" ? "success" : "default";
  return (
    <Card testID="shelf">
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <AppText variant="heading" accessibilityRole="header">
          Shelf · {counts.total}
        </AppText>
        <Button title="Clear shelf" variant="ghost" compact onPress={onClear} />
      </View>
      <AppText variant="tiny" muted>
        {counts.owned} own · {counts.wishlist} wishlist · {counts.new} new · {counts.notFound} not found
      </AppText>
      {entries.map((entry) => {
        const actions = shelfQuickActions(entry);
        const busy = busyKey === entry.key;
        return (
          <View
            key={entry.key}
            testID={`shelf-entry-${entry.key}`}
            style={{ gap: theme.spacing(2), paddingTop: theme.spacing(3), borderTopWidth: 1, borderTopColor: theme.colors.border }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(3) }}>
              <ColorDot hex={entry.hex} size={28} />
              <View style={{ flex: 1 }}>
                <AppText style={{ fontWeight: "600" }} numberOfLines={2} onPress={entry.shadeId ? () => onOpen(entry) : undefined}>
                  {entry.display ?? (entry.gtin ? `Barcode ${entry.gtin}` : "Unknown bottle")}
                </AppText>
                <AppText variant="tiny" muted>
                  {repeatKey === entry.key
                    ? `Scanned already · ${formatShelfAge(entry.firstScannedAt, now)}`
                    : formatShelfAge(entry.lastScannedAt, now)}
                  {entry.quantity && entry.quantity > 1 ? ` · ${entry.quantity} bottles` : ""}
                </AppText>
                {entry.verdict === "near_dupe" && entry.dupeName ? (
                  <AppText variant="tiny" muted numberOfLines={1}>
                    Close to {entry.dupeName}
                  </AppText>
                ) : null}
              </View>
              <View style={{ gap: 4, alignItems: "flex-end" }}>
                <Chip label={SHELF_VERDICT_LABELS[entry.verdict]} tone={tone(entry.verdict)} />
                {entry.acted ? <Chip label={ACTED_LABELS[entry.acted]} tone="success" /> : null}
              </View>
            </View>
            {actions.length > 0 && (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(2) }}>
                {actions.map((action) => (
                  <Button
                    key={action}
                    title={ACTION_LABELS[action]}
                    variant="outline"
                    compact
                    loading={busy}
                    disabled={busyKey !== null}
                    onPress={() => onAction(entry, action)}
                  />
                ))}
              </View>
            )}
          </View>
        );
      })}
    </Card>
  );
}
