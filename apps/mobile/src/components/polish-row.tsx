import { Pressable, View } from "react-native";
import { PRODUCT_CATEGORY_LABELS, resolvePolishFinishes, resolveProductCategory, type Polish } from "swatchwatch-shared";
import { finishLabel } from "@/lib/finishes";
import { POLISH_STATUS_LABELS } from "@/lib/status";
import { useTheme } from "@/theme/theme";
import { Swatch } from "./swatch";
import { AppText, Chip } from "./ui";

/** One collection row: swatch, brand + shade, finishes, status chip and the untried badge. */
export function PolishRow({ polish, onPress }: { polish: Polish; onPress: () => void }) {
  const theme = useTheme();
  const finishes = resolvePolishFinishes(polish);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${polish.brand} ${polish.name}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: theme.spacing(3),
        paddingHorizontal: theme.spacing(4),
        paddingVertical: theme.spacing(3),
        backgroundColor: pressed ? theme.colors.muted : "transparent",
      })}
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
      </View>
      <View style={{ alignItems: "flex-end", gap: 4 }}>
        {polish.status && polish.status !== "owned" && <Chip label={POLISH_STATUS_LABELS[polish.status]} />}
        {resolveProductCategory(polish.productCategory) !== "color" && (
          <Chip label={PRODUCT_CATEGORY_LABELS[resolveProductCategory(polish.productCategory)]} />
        )}
        {polish.isUntried && <Chip label="Untried" tone="brand" />}
        {polish.status === "owned" && (polish.quantity ?? 1) > 1 && <Chip label={`×${polish.quantity}`} />}
      </View>
    </Pressable>
  );
}
