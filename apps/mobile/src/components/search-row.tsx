import { router } from "expo-router";
import { useCallback, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { resolvePolishFinishes, type Polish, type PolishStatus } from "swatchwatch-shared";
import { errorMessage, updatePolish } from "@/api/client";
import { confirmAddWithDupes } from "@/lib/add-guard";
import { finishLabel } from "@/lib/finishes";
import { POLISH_STATUS_LABELS, statusChangePatch } from "@/lib/status";
import { useTheme } from "@/theme/theme";
import { Swatch } from "./swatch";
import { AppText, Button, Chip } from "./ui";

/**
 * One-tap Add / ♡ Wishlist for catalog rows, behind the add guard (#266). `replace` swaps a
 * row in the caller's list (optimistic update, then the server row, or the original on failure).
 */
export function useSetPolishStatus(replace: (id: string, next: Polish) => void, onError: (message: string) => void) {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const setStatus = useCallback(
    async (polish: Polish, status: PolishStatus) => {
      const choice =
        polish.status === "owned" ? "add" : await confirmAddWithDupes(polish.id, status === "owned" ? "owned" : "wishlist");
      if (choice === "cancel") return;
      const target: PolishStatus = choice === "wishlist" ? "wishlist" : status;
      setPending((p) => ({ ...p, [polish.id]: true }));
      replace(polish.id, { ...polish, status: target });
      try {
        replace(polish.id, await updatePolish(polish.id, statusChangePatch(polish, target)));
      } catch (err) {
        replace(polish.id, polish);
        onError(errorMessage(err, "Couldn't update that polish."));
      } finally {
        setPending((p) => ({ ...p, [polish.id]: false }));
      }
    },
    [replace, onError],
  );
  return { pending, setStatus };
}

/** A catalog / collection row: swatch, brand, name, finishes, status or Add / ♡ actions. */
export function SearchRow({
  polish,
  pending,
  onSetStatus,
  badge,
}: {
  polish: Polish;
  pending: boolean;
  onSetStatus: (status: PolishStatus) => void;
  /** Extra chip shown under the name (e.g. a color-match grade). */
  badge?: ReactNode;
}) {
  const theme = useTheme();
  const finishes = resolvePolishFinishes(polish);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(3), paddingHorizontal: theme.spacing(4), paddingVertical: theme.spacing(3) }}>
      <Pressable
        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: theme.spacing(3) }}
        accessibilityRole="button"
        accessibilityLabel={`${polish.brand} ${polish.name}`}
        onPress={() => router.push({ pathname: "/polishes/[id]", params: { id: polish.id } })}
      >
        <Swatch polish={polish} size={52} />
        <View style={{ flex: 1, gap: 2 }}>
          <AppText variant="tiny" muted numberOfLines={1}>
            {polish.brand}
          </AppText>
          <AppText style={{ fontWeight: "600" }} numberOfLines={1}>
            {polish.name}
          </AppText>
          {finishes.length > 0 && (
            <AppText variant="tiny" muted numberOfLines={1}>
              {finishes.map(finishLabel).join(" · ")}
            </AppText>
          )}
          {badge}
        </View>
      </Pressable>
      {polish.status === "owned" ? (
        <Chip label="Owned" tone="success" />
      ) : (
        <View style={{ flexDirection: "row", gap: theme.spacing(1.5), alignItems: "center" }}>
          {polish.status && polish.status !== "wishlist" && <Chip label={POLISH_STATUS_LABELS[polish.status]} />}
          {polish.status === "wishlist" ? (
            <Chip label="♡ Wishlist" tone="brand" />
          ) : (
            <Button title="♡" variant="outline" compact disabled={pending} accessibilityLabel={`Wishlist ${polish.name}`} onPress={() => onSetStatus("wishlist")} />
          )}
          <Button title="Add" compact loading={pending} accessibilityLabel={`Add ${polish.name} to collection`} onPress={() => onSetStatus("owned")} />
        </View>
      )}
    </View>
  );
}
