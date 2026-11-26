import { View } from "react-native";
import { readPanelRows, type CaptureReadSummary } from "swatchwatch-shared";
import { useTheme } from "@/theme/theme";
import { ColorDot } from "./swatch";
import { AppText, Card } from "./ui";

/**
 * "What we've read" (web: `components/rapid-add/bottle-read-panel.tsx`): the barcode, brand,
 * shade name, color and finish the capture API has read from this bottle's photos so far, with
 * what the latest photo added marked New. Rows come from the shared `readPanelRows`.
 */
export function BottleReadPanel({
  summary,
  liveBarcode,
}: {
  /** The latest `readSoFar` (null before the first answer). */
  summary: CaptureReadSummary | null;
  /** A barcode decoded on this device, shown before the server answers. */
  liveBarcode: string | null;
}) {
  const theme = useTheme();
  const rows = readPanelRows(summary, liveBarcode);
  return (
    <Card testID="bottle-read-panel" style={{ paddingVertical: theme.spacing(3), gap: theme.spacing(1) }}>
      <AppText variant="label" muted accessibilityRole="header">
        What we&apos;ve read
      </AppText>
      <View accessibilityLiveRegion="polite" style={{ gap: theme.spacing(1) }}>
        {rows.map((row) => (
          <View
            key={row.field}
            testID={`read-row-${row.field}`}
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              gap: theme.spacing(3),
              paddingHorizontal: theme.spacing(2),
              paddingVertical: 2,
              borderRadius: theme.radius.md,
              backgroundColor: row.isNew ? theme.colors.successSurface : "transparent",
            }}
          >
            <AppText variant="small" muted style={{ width: 84 }}>
              {row.label}
            </AppText>
            <View style={{ flex: 1, minWidth: 0 }}>
              {row.value ? (
                <>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
                    {row.hex && <ColorDot hex={row.hex} size={12} />}
                    <AppText
                      variant="small"
                      numberOfLines={1}
                      style={{ fontWeight: "600", flexShrink: 1, fontVariant: row.field === "gtin" ? ["tabular-nums"] : undefined }}
                    >
                      {row.value}
                    </AppText>
                    {row.isNew && (
                      <AppText variant="tiny" style={{ fontWeight: "700", color: theme.colors.success }}>
                        New
                      </AppText>
                    )}
                  </View>
                  {row.detail && (
                    <AppText variant="tiny" muted={!row.needsCheck} style={row.needsCheck ? { color: theme.colors.warning } : undefined}>
                      {row.detail}
                    </AppText>
                  )}
                </>
              ) : (
                <AppText variant="small" muted>
                  Not read yet
                </AppText>
              )}
            </View>
          </View>
        ))}
      </View>
    </Card>
  );
}
