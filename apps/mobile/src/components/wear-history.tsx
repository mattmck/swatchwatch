import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { buildWearHistory, WEAR_HISTORY_PREVIEW_COUNT, wearHistoryTitle } from "swatchwatch-shared";
import type { Manicure } from "swatchwatch-shared";
import { listManicures } from "@/api/client";
import { PrivateImage } from "@/components/private-image";
import { ColorDot } from "@/components/swatch";
import { AppText, Button, Card, Chip } from "@/components/ui";
import { entryFromManicurePolish, formatWornOn, ROLE_LABELS } from "@/lib/mani";
import { useTheme } from "@/theme/theme";

/**
 * "Worn N times" on the polish detail screen: the newest manis this shade is in (read only).
 * Always fetched fresh; thumbnails go through the in-memory private image loader and nothing
 * here is written to AsyncStorage.
 */
export function WearHistory({ shadeId, wearCount }: { shadeId: string; wearCount: number }) {
  const theme = useTheme();
  const [state, setState] = useState<{ manicures: Manicure[]; total: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    listManicures({ shadeId, pageSize: WEAR_HISTORY_PREVIEW_COUNT })
      .then((res) => {
        if (!cancelled) setState({ manicures: res.manicures, total: res.total });
      })
      .catch(() => {
        // The panel is an extra; the detail screen stays usable without it.
      });
    return () => {
      cancelled = true;
    };
  }, [shadeId, wearCount]);

  if (!state) return null;
  const entries = buildWearHistory(state.manicures, shadeId);

  return (
    <Card testID="wear-history">
      <AppText variant="heading">{wearHistoryTitle(state.total)}</AppText>
      {entries.map((entry) => (
        <View key={entry.manicureId} style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing(2) }}>
          {entry.photoUrl ? (
            <PrivateImage url={entry.photoUrl} compact style={{ width: 48, height: 48 }} accessibilityLabel={`Your mani photo from ${entry.wornOn}`} />
          ) : null}
          <View style={{ flex: 1, gap: theme.spacing(1) }}>
            <AppText variant="small">{formatWornOn(entry.wornOn)}</AppText>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing(1) }}>
              {entry.others.map((other) => (
                <ColorDot key={`${other.shadeId}:${other.role}`} hex={entryFromManicurePolish(other).hex} size={16} />
              ))}
            </View>
          </View>
          {entry.role && entry.role !== "color" && <Chip label={ROLE_LABELS[entry.role]} />}
        </View>
      ))}
      {state.total > 0 && (
        <Button
          title={state.total > entries.length ? `See all ${state.total}` : "Open in Manis"}
          variant="outline"
          compact
          onPress={() => router.navigate({ pathname: "/manis", params: { shade: shadeId } })}
        />
      )}
    </Card>
  );
}
